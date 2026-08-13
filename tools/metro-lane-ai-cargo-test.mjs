// Metro-lane AI economics + cargo pooling — design point 5 of the 2026-08-13
// metro demand rework (docs/METRO_DEMAND_REWORK.md):
//
//   "buildPairIncumbents counts distinct carriers per lane; competitor P&L
//    applies the pair's appeal cap. Cargo lanes pool by metro pair too,
//    anchored on the strongest served member pair (freight masses are
//    airport-specific)."
//
// Points 1–3 and 6 landed first: baseCityPairDemand prices a metro pair ONCE at
// the registry primaries, and weeklyTick's passenger pre-pass runs ONE share
// fight per metro lane with per-airport appeal. Two holes were left behind, and
// this file guards both:
//
//  A. AI COMPETITOR P&L was still per AIRPORT PAIR. Two AI carriers at sibling
//     airports on one metro lane (JFK–ADB and EWR–ADB) did not see each other
//     as incumbents, so each booked a monopoly slice of the SAME pooled market;
//     and a carrier flying out of a weak secondary field (SWF) booked exactly
//     what it would have booked from the primary — the appeal cap the player's
//     monopoly path applies never reached competitor economics.
//
//  B. CARGO LANES pooled by airport pair only. A freighter on EWR–LHR and one
//     on JFK–LHR each drew a full New York↔London cargo lane. Freight masses
//     ARE airport-specific (cargo scores differ per field), so the metro lane
//     anchors on the strongest SERVED member pair rather than the metro
//     primary — and cargo gets no passenger appeal (documented follow-up: its
//     per-airport cargo scores partly cover that).
//
//   node tools/metro-lane-ai-cargo-test.mjs      (npm run test:metro-lanes)
//
// VERIFIED FAILING ON HEAD (pre-change tree): A1, A3, A4, B1, B2, B3, B6, B7 —
// sibling carriers counted 1 incumbent each (5,484 pax with or without a rival
// at Newark), Newburgh and Newark booked the full New York pool (ratio 1.000 vs
// JFK), and two freighters on sibling member pairs drew 2,554 t against a lane
// of 1,415 (1.805× duplication; three member pairs 2.618×).

import assert from 'node:assert/strict';
import {
  buildPairIncumbents, computeCompetitorRoutePnL, computeCompetitorWeeklyStats,
  getSeasonalProfile,
} from '../packages/engine/src/models/demand.js';
import {
  cargoLaneAllocations, simulateCargoRoute, weeklyTick,
} from '../packages/engine/src/utils/simulation.js';
import {
  baseCityPairDemand, cargoCityPairDemand, cargoReferenceYield,
  metroPairKeyOf, pairAppeal,
} from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
// Tonnage/pax comparator: percentage tolerance plus one unit of rounding slack.
const approx = (a, b, tolPct = 1) => Math.abs(a - b) <= Math.abs(b) * tolPct / 100 + 1;
// RATIO comparator: no absolute slack — a ±1 window swallows every ratio in the
// unit interval and would let the pre-fix numbers pass.
const ratioIs = (a, b, tolPct = 1) => Math.abs(a - b) <= Math.abs(b) * tolPct / 100;

// ═════════════════════════════════════════════════════════════════════════════
// A. AI COMPETITOR ECONOMICS ON A METRO LANE
// ═════════════════════════════════════════════════════════════════════════════
// Lane: New York ↔ Izmir (ADB). ADB is in no metro group, so every effect below
// is the NEW YORK side alone — JFK (primary, appeal 1.0), EWR (0.85 intl) and
// SWF/Newburgh (0.05 intl). Deliberately over-frequencied (14/wk of a 250-seat
// tier aircraft = 3,080 sellable one-way seats against ~2,742 of demand) so the
// binding constraint is DEMAND, not capacity — a capacity-bound route would
// hide every demand-side change this file is about.

const MONTH = 6;
const FREQ  = 14;
const cfg   = { frequency: FREQ, priceMultiplier: 1.0, tails: 2 };
const carrier = (id, ...pairKeys) => ({
  id, name: id, tier: 'legacy', baseQualityScore: 70,
  routes: Object.fromEntries(pairKeys.map(k => [k, { ...cfg }])),
});
const pk = (a, b) => [a, b].sort().join('-');

console.log('\nA. AI competitor P&L on a metro lane (New York ↔ Izmir)\n');

test('A1: sibling carriers on one metro lane count as 2 incumbents, not 1 each', () => {
  const counts = buildPairIncumbents([carrier('a', pk('JFK', 'ADB')), carrier('b', pk('EWR', 'ADB'))], []);
  const lane = metroPairKeyOf('JFK', 'ADB');
  assert.equal(counts.get(lane), 2,
    `the New York↔Izmir lane carries 2 carriers; got ${counts.get(lane)}`);
  // Both member pairs must resolve to that lane count, however they are looked up.
  assert.equal(counts.get(pk('EWR', 'ADB')), 2, 'the sibling pair reports the lane count too');
});

test('A2: the player is ONE carrier on a lane it serves from two member airports', () => {
  const counts = buildPairIncumbents(
    [carrier('a', pk('JFK', 'ADB'))],
    [{ origin: 'JFK', destination: 'ADB' }, { origin: 'EWR', destination: 'ADB' }],
  );
  assert.equal(counts.get(metroPairKeyOf('JFK', 'ADB')), 2,
    'player (once, across both of its member pairs) + one AI carrier = 2');
});

test('A3: an AI carrier\'s weekly stats respond to a SIBLING-lane incumbent', () => {
  const a = carrier('a', pk('JFK', 'ADB'));
  const b = carrier('b', pk('EWR', 'ADB'));
  const alone   = computeCompetitorWeeklyStats(a, MONTH, buildPairIncumbents([a], []));
  const shared  = computeCompetitorWeeklyStats(a, MONTH, buildPairIncumbents([a, b], []));
  // n=2 → pool share n^0.15/n = 0.5547.
  assert.ok(shared.weeklyPax < alone.weeklyPax * 0.7,
    `a rival at Newark must cost the JFK carrier passengers: ${shared.weeklyPax} vs ${alone.weeklyPax} alone`);
  assert.ok(ratioIs(shared.weeklyPax / alone.weeklyPax, Math.pow(2, 0.15) / 2, 3),
    `two carriers on the lane split it like two carriers on a pair `
    + `(${(shared.weeklyPax / alone.weeklyPax).toFixed(3)} vs ${(Math.pow(2, 0.15) / 2).toFixed(3)})`);
  assert.ok(shared.weeklyRevenue < alone.weeklyRevenue, 'and it costs revenue, not just pax');
});

test('A4: an AI carrier\'s weekly stats respond to a WEAK-APPEAL home field', () => {
  const jfk = computeCompetitorWeeklyStats(carrier('a', pk('JFK', 'ADB')), MONTH, null);
  const ewr = computeCompetitorWeeklyStats(carrier('a', pk('EWR', 'ADB')), MONTH, null);
  const swf = computeCompetitorWeeklyStats(carrier('a', pk('SWF', 'ADB')), MONTH, null);
  const dist = 8129;
  assert.ok(ratioIs(ewr.weeklyPax / jfk.weeklyPax, pairAppeal('EWR', 'ADB', false, dist), 3),
    `Newark books its appeal share: ${(ewr.weeklyPax / jfk.weeklyPax).toFixed(3)} vs `
    + `${pairAppeal('EWR', 'ADB', false, dist)}`);
  assert.ok(ratioIs(swf.weeklyPax / jfk.weeklyPax, pairAppeal('SWF', 'ADB', false, dist), 5),
    `Newburgh cannot book New York: ${(swf.weeklyPax / jfk.weeklyPax).toFixed(3)} vs `
    + `${pairAppeal('SWF', 'ADB', false, dist)}`);
  assert.ok(swf.weeklyProfit < 0,
    'a transatlantic widebody schedule out of Newburgh must lose money, not print it');
});

test('A5: the primary airport still books the whole metro pool (appeal never adds)', () => {
  const c = carrier('a', pk('JFK', 'ADB'));
  const p = computeCompetitorRoutePnL(c, pk('JFK', 'ADB'), c.routes[pk('JFK', 'ADB')], MONTH, null);
  assert.ok(p.loadFactor < 0.879, 'fixture must stay demand-bound, not capacity-bound');
  const expected = baseCityPairDemand('JFK', 'ADB') * (getSeasonalProfile('JFK', 'ADB')[MONTH] ?? 1);
  assert.ok(approx(p.pax / 2, expected, 1),
    `JFK is a registry primary: ${p.pax / 2} one-way pax vs the full pool ${Math.round(expected)}`);
});

test('A6: lanes with no registry members are untouched (no over-merging)', () => {
  // Two carriers on the same non-metro pair still count 2 under their own key…
  const same = buildPairIncumbents([carrier('a', 'CAI-DXB'), carrier('b', 'CAI-DXB')], []);
  assert.equal(same.get('CAI-DXB'), 2);
  // …and a carrier on a DIFFERENT pair sharing an endpoint is not an incumbent.
  const other = buildPairIncumbents([carrier('a', 'CAI-DXB'), carrier('b', 'AUH-CAI')], []);
  assert.equal(other.get('CAI-DXB'), 1, 'CAI–AUH is a different market from CAI–DXB');
  assert.equal(other.get('AUH-CAI'), 1);
  // …and appeal is parity there, so its P&L is the pre-rework number.
  const c = carrier('a', 'CAI-DXB');
  const p = computeCompetitorRoutePnL(c, 'CAI-DXB', c.routes['CAI-DXB'], MONTH, null);
  const q = computeCompetitorRoutePnL(c, 'CAI-DXB', c.routes['CAI-DXB'], MONTH, other);
  assert.deepEqual(p, q, 'a solo carrier on a non-metro pair is unaffected by lane counting');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. CARGO LANES POOL BY METRO PAIR
// ═════════════════════════════════════════════════════════════════════════════
// Lane: New York ↔ London. Freight masses are airport-specific, so the member
// pairs are NOT equal the way passenger pairs now are:
//   JFK–LHR 1,483 t/wk · LGA–LHR 1,207 · EWR–LHR 1,194 · EWR–LGW 632 · EWR–STN 532
// The lane therefore anchors on the strongest SERVED member pair — not on the
// registry primary (which may not be flown at all).

console.log('\nB. Cargo lanes pool by metro pair (New York ↔ London)\n');

const F_TYPE = 'b7478f';
const CFREQ  = 14;              // 137 t × 14 = 1,918 t of capacity vs ≤1,483 of demand
const freighter = (id) => ({ id, typeId: F_TYPE, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' });
const cRoute = (o, d, ac, opts = {}) => ({
  id: opts.id ?? `c-${o}${d}`, origin: o, destination: d, aircraftId: ac,
  yieldPrice: opts.yieldPrice ?? cargoReferenceYield(o, d),
  weeklyFrequency: opts.freq ?? CFREQ, weeksOpen: opts.weeksOpen ?? 30, cargo: true,
});
const cargoState = (fleet, cargoRoutes) => ({
  week: 30, year: 1, cash: 5e6,
  fleet, routes: [], cargoRoutes,
  gates: { JFK: 8, EWR: 8, LGA: 8, SWF: 8, LHR: 8, LGW: 8, STN: 8 },
  gameDate: { week: 30, month: MONTH }, hub: 'JFK', hubs: {}, competitors: [],
  financialHistory: [], awareness: 60, loans: [], activeEvents: [],
  fuelPrice: { index: 1, history: [] },
});
const laneTonnes = (fleet, routes) =>
  weeklyTick(cargoState(fleet, routes)).cargoRouteResults.reduce((s, r) => s + r.tonnes, 0);

const JFK_LHR = cargoCityPairDemand('JFK', 'LHR', MONTH);
const EWR_LHR = cargoCityPairDemand('EWR', 'LHR', MONTH);

test('B1: two freighters on SIBLING member pairs draw ONE lane, not two', () => {
  const fleet  = [freighter('f1'), freighter('f2')];
  const routes = [cRoute('JFK', 'LHR', 'f1', { id: 'jfk' }), cRoute('EWR', 'LHR', 'f2', { id: 'ewr' })];
  const alloc  = cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: MONTH } });
  assert.ok(alloc.has('jfk') && alloc.has('ewr'),
    'both sibling routes must be allocated out of one pooled lane');
  const total = alloc.get('jfk').demandTonnes + alloc.get('ewr').demandTonnes;
  assert.ok(approx(total, JFK_LHR, 1),
    `the lane holds ${JFK_LHR} t/wk; the two routes were handed ${Math.round(total)} t`);
  assert.equal(alloc.get('jfk').laneRoutes, 2);
});

test('B2: the lane anchors on the strongest SERVED member pair, not the primary', () => {
  // Nobody flies JFK or LHR here: Newark↔Gatwick + Newark↔Stansted. The lane must
  // price at EWR–LGW (632 t), NOT at the JFK–LHR primary pair (1,483 t).
  const fleet  = [freighter('f1'), freighter('f2')];
  const routes = [cRoute('EWR', 'LGW', 'f1', { id: 'lgw' }), cRoute('EWR', 'STN', 'f2', { id: 'stn' })];
  const alloc  = cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: MONTH } });
  const total  = alloc.get('lgw').demandTonnes + alloc.get('stn').demandTonnes;
  const strongestServed = cargoCityPairDemand('EWR', 'LGW', MONTH);
  assert.ok(approx(total, strongestServed, 1),
    `secondary-field freight anchors at ${strongestServed} t, not `
    + `${cargoCityPairDemand('JFK', 'LHR', MONTH)} t: got ${Math.round(total)}`);
});

test('B3: adding the strong member pair grows the lane to that pair\'s mass', () => {
  const fleet = [freighter('f1'), freighter('f2')];
  const weak  = cargoLaneAllocations(
    [cRoute('EWR', 'LHR', 'f1', { id: 'a' }), cRoute('EWR', 'LGW', 'f2', { id: 'b' })],
    fleet, 1.0, { gameDate: { month: MONTH } });
  const strong = cargoLaneAllocations(
    [cRoute('EWR', 'LHR', 'f1', { id: 'a' }), cRoute('JFK', 'LHR', 'f2', { id: 'b' })],
    fleet, 1.0, { gameDate: { month: MONTH } });
  const sum = (m) => m.get('a').demandTonnes + m.get('b').demandTonnes;
  assert.ok(approx(sum(weak), EWR_LHR, 1), `EWR-anchored lane = ${EWR_LHR} t, got ${Math.round(sum(weak))}`);
  assert.ok(approx(sum(strong), JFK_LHR, 1), `JFK-anchored lane = ${JFK_LHR} t, got ${Math.round(sum(strong))}`);
  assert.ok(sum(strong) > sum(weak), 'serving the stronger freight field is worth something');
});

test('B4: a solo route keeps its OWN airport-specific mass (solo path untouched)', () => {
  const fleet  = [freighter('f1')];
  const routes = [cRoute('EWR', 'LHR', 'f1', { id: 'ewr' })];
  assert.equal(cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: MONTH } }).size, 0,
    'a lane with one eligible route is never entered — simulateCargoRoute handles it');
  const solo = simulateCargoRoute(routes[0], fleet[0], { month: MONTH });
  assert.ok(approx(solo.demandTonnes, EWR_LHR, 1),
    `a lone Newark freighter draws Newark's freight (${EWR_LHR} t), not JFK's (${JFK_LHR} t): `
    + `got ${solo.demandTonnes}`);
});

test('B5: same-pair lanes are unchanged (one pool, split by capacity)', () => {
  const fleet  = [freighter('f1'), freighter('f2')];
  const routes = [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('JFK', 'LHR', 'f2', { id: 'b' })];
  const alloc  = cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: MONTH } });
  const total  = alloc.get('a').demandTonnes + alloc.get('b').demandTonnes;
  assert.ok(approx(total, JFK_LHR, 1), `${Math.round(total)} vs ${JFK_LHR}`);
  assert.ok(Math.abs(alloc.get('a').demandTonnes - alloc.get('b').demandTonnes) < 1e-9,
    'identical freighters split evenly');
});

test('B6: metro-lane tonnage no longer scales with the number of member pairs', () => {
  const one  = laneTonnes([freighter('f1')], [cRoute('JFK', 'LHR', 'f1', { id: 'a' })]);
  const sib  = laneTonnes([freighter('f1'), freighter('f2')],
    [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('EWR', 'LHR', 'f2', { id: 'b' })]);
  const same = laneTonnes([freighter('f1'), freighter('f2')],
    [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('JFK', 'LHR', 'f2', { id: 'b' })]);
  assert.ok(approx(same, one, 1), `same-pair duo ${same} t vs solo ${one} t (already pooled)`);
  assert.ok(approx(sib, one, 1),
    `sibling-pair duo booked ${sib} t against a lane of ${one} t `
    + `(${(sib / one).toFixed(3)}× — pre-fix this was ~1.8×)`);
});

test('B7: lane maturity is the MAX weeksOpen across the metro lane', () => {
  const fleet = [freighter('f1'), freighter('f2')];
  const alloc = cargoLaneAllocations([
    cRoute('JFK', 'LHR', 'f1', { id: 'old', weeksOpen: 40 }),
    cRoute('EWR', 'LHR', 'f2', { id: 'new', weeksOpen: 0 }),
  ], fleet, 1.0, { gameDate: { month: MONTH } });
  const total = alloc.get('old').demandTonnes + alloc.get('new').demandTonnes;
  assert.ok(approx(total, JFK_LHR, 1),
    `joining an established metro lane inherits its maturity: ${Math.round(total)} vs ${JFK_LHR}`);
  assert.ok(Math.abs(alloc.get('old').demandTonnes - alloc.get('new').demandTonnes) < 1e-9,
    'same capacity + yield → same slice regardless of route age');
});

test('B8: dead routes are excluded BEFORE grouping (no phantom metro lane)', () => {
  // An ATR-72F (1,500 km) cannot fly Newark–Heathrow: its entry must not pool
  // with the JFK freighter, which stays on the solo path.
  const fleet  = [freighter('f1'), { id: 'f2', typeId: 'atr72f', status: 'assigned', ageWeeks: 52, ownershipType: 'owned' }];
  const routes = [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('EWR', 'LHR', 'f2', { id: 'dead' })];
  assert.equal(cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: MONTH } }).size, 0,
    'an unflyable sibling neither carries nor dilutes the lane');
  // Same for an out-of-service aircraft.
  const grounded = [freighter('f1'), { ...freighter('f2'), status: 'maintenance', maintenanceWeeksLeft: 4 }];
  assert.equal(cargoLaneAllocations(
    [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('EWR', 'LHR', 'f2', { id: 'aog' })],
    grounded, 1.0, { gameDate: { month: MONTH } }).size, 0);
});

test('B9: cargo carries NO passenger airport appeal (documented: cargo scores cover it)', () => {
  // A lone Newburgh freighter is thin because SWF ships little freight — not
  // because a 0.05 passenger-appeal multiplier was applied to it.
  const solo = simulateCargoRoute(cRoute('SWF', 'LHR', 'f1', { id: 's' }), freighter('f1'), { month: MONTH });
  assert.ok(approx(solo.demandTonnes, cargoCityPairDemand('SWF', 'LHR', MONTH), 1),
    `cargo demand is the pair's own freight mass: ${solo.demandTonnes} vs `
    + `${cargoCityPairDemand('SWF', 'LHR', MONTH)}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// MEASUREMENTS (printed, not asserted) — the duplication this file removes.
// ═════════════════════════════════════════════════════════════════════════════
console.log('\nMeasured — cargo lane duplication (New York ↔ London, month 6, 747-8F ×14/wk)\n');
{
  const one  = laneTonnes([freighter('f1')], [cRoute('JFK', 'LHR', 'f1', { id: 'a' })]);
  const same = laneTonnes([freighter('f1'), freighter('f2')],
    [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('JFK', 'LHR', 'f2', { id: 'b' })]);
  const sib  = laneTonnes([freighter('f1'), freighter('f2')],
    [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('EWR', 'LHR', 'f2', { id: 'b' })]);
  const three = laneTonnes([freighter('f1'), freighter('f2'), freighter('f3')],
    [cRoute('JFK', 'LHR', 'f1', { id: 'a' }), cRoute('EWR', 'LHR', 'f2', { id: 'b' }),
      cRoute('LGA', 'LHR', 'f3', { id: 'c' })]);
  const fmt = (n) => `${String(n).padStart(5)} t  (${(n / one).toFixed(3)}× the lane)`;
  console.log(`  one freighter, JFK–LHR              ${fmt(one)}`);
  console.log(`  two freighters, both JFK–LHR        ${fmt(same)}`);
  console.log(`  two freighters, JFK–LHR + EWR–LHR   ${fmt(sib)}`);
  console.log(`  three, JFK + EWR + LGA – LHR        ${fmt(three)}`);
}
console.log('\nMeasured — AI weekly pax on New York↔Izmir (250 seats ×14/wk)\n');
{
  const alone = computeCompetitorWeeklyStats(carrier('a', pk('JFK', 'ADB')), MONTH,
    buildPairIncumbents([carrier('a', pk('JFK', 'ADB'))], []));
  const withSibling = computeCompetitorWeeklyStats(carrier('a', pk('JFK', 'ADB')), MONTH,
    buildPairIncumbents([carrier('a', pk('JFK', 'ADB')), carrier('b', pk('EWR', 'ADB'))], []));
  const ewr = computeCompetitorWeeklyStats(carrier('a', pk('EWR', 'ADB')), MONTH, null);
  const swf = computeCompetitorWeeklyStats(carrier('a', pk('SWF', 'ADB')), MONTH, null);
  const base = alone.weeklyPax;
  const row = (label, n) => console.log(`  ${label.padEnd(34)}${String(n).padStart(6)} pax  (${(n / base).toFixed(3)}×)`);
  row('JFK, no rival', alone.weeklyPax);
  row('JFK, rival at EWR (sibling lane)', withSibling.weeklyPax);
  row('EWR monopoly (appeal 0.85)', ewr.weeklyPax);
  row('SWF monopoly (appeal 0.05)', swf.weeklyPax);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
