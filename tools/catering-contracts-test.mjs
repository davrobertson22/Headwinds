// Catering contracts — who cooks, at what rate, and for how long.
//
// A contract is a COMMITMENT mechanic, not a building: no capex, no construction.
// It changes what catering costs at the airports a supplier covers, what quality
// it can deliver there, and what it costs to walk away. The tests guard the
// decisions locked with Dave on 2026-09-21 (CATERING_CONTRACTS_PLAN.md §4) and
// the invariants the ground stations established:
//
//   1. Coverage is a REGION; the most specific covering contract cooks.
//   2. Best-of with the hub kitchen, never stacked — and the cook's cap and
//      quality delta come with the cook, so a premium caterer buys nothing at a
//      hub whose own kitchen is cheaper.
//   3. The cap bites: a route delivers the lower of its chosen level and the
//      caterer's cap, and is charged for what it delivers.
//   4. One book per world, deterministic from the calendar; signing locks the rate.
//   5. Volume surcharge only — nobody is refused.
//   6. Break early for 35% of the remaining spend.
//   7. A world that never signs is byte-identical (golden master).
//   8. Previews agree with the tick.
//
//   node tools/catering-contracts-test.mjs

import assert from 'node:assert/strict';
import {
  weeklyTick, defaultClassPrices, stateCateringFields, routeDistanceKm,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { HUB_TIERS } from '../packages/engine/src/models/demand.js';
import { defaultAncillaries } from '../packages/engine/src/data/ancillaries.js';
import { routeCatering, CATERING_LEVEL_ORDER, CATERING_LEVELS } from '../packages/engine/src/data/catering.js';
import { costBridge, bridgeInputsFromReport } from '../packages/engine/src/utils/pnlBridge.js';
import {
  CATERING_SUPPLIERS, CATERING_SUPPLIER_MAP, CATERING_TERMS, CATERING_TERM_MAP,
  CATERING_BOOK_WINDOW_WEEKS, CATERING_BOOK_DRIFT, CATERING_VOLUME_SURCHARGE,
  CATERING_BREAK_FRACTION, CATERING_EXPIRY_WARNING_WEEKS,
  coverageKey, coversAirport, supplierRateAt, cateringOfferBook, weeksToNextReprice,
  airportSeatsMap, coverageVolume, volumeSurchargeMult,
  makeCateringContract, canSignCatering, cateringBreakCost, contractWeeksLeft,
  tickCateringContracts, contractForAirport, resolveCateringContracts, applyCateringContractFields,
} from '../packages/engine/src/data/cateringContracts.js';
import { routeStops } from '../packages/engine/src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nCatering contracts — who cooks, at what rate, for how long\n');

const TYPE = getAircraftType('a320neo');
const O = 'JFK', D = 'LAX', E = 'LHR';
const PAIR = [O, D].sort().join('-');
const REF = Math.round(referencePrice(O, D));
const WEEK = 100;

function tail(id) {
  return {
    id, typeId: TYPE.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
    config: { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: TYPE.seats - 12,
              seatQuality: 'standard', serviceQuality: 'standard' },
  };
}
const route = (id, aircraftId, freq = 14, origin = O, destination = D) => ({
  id, origin, destination, stops: [origin, destination], aircraftId, weeklyFrequency: freq, weeksOpen: 60,
});

function baseState({ fleet, routes, cateringContracts, hubs = {}, routeCatering: rc = {} }) {
  return {
    fleet, routes, cargoRoutes: [],
    gameDate: { week: 1, month: 6 },
    gates: { [O]: 10, [D]: 10, [E]: 10 },
    hubs,
    ...(cateringContracts ? { cateringContracts } : {}),
    lounges: {}, loungePolicy: null,
    routePricing: { [PAIR]: defaultClassPrices(REF) },
    routeCatering: rc,
    competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null,
    campaignStrength: {}, targetedMarketing: {},
    awareness: 65,
    ancillaries: defaultAncillaries(),
    labor: undefined,
    absWeek: WEEK,
  };
}
const contractMap = (...cs) => Object.fromEntries(cs.map(c => [c.id, c]));
const idx = (lvl) => CATERING_LEVEL_ORDER.indexOf(lvl);

// ═══════════════════════════════════════════════════════════════════════════
// The catalogue and the book
// ═══════════════════════════════════════════════════════════════════════════

test('catalogue: unique ids, valid caps and coverages, invented names only', () => {
  const ids = new Set();
  for (const s of CATERING_SUPPLIERS) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`); ids.add(s.id);
    assert.ok(CATERING_LEVELS[s.qualityCap], `${s.id} cap ${s.qualityCap} is a real level`);
    assert.ok(['global', 'continent', 'country'].includes(s.coverage.kind), `${s.id} coverage kind`);
    assert.ok(s.costFactor > 0 && s.minVolume > 0);
    assert.doesNotMatch(s.name, /gate gourmet|lsg|sky ?chefs? group|dnata|newrest|do ?& ?co|flying food/i,
      `${s.name} must not be a real caterer`);
  }
  assert.ok(CATERING_SUPPLIERS.some(s => s.costFactor > 1), 'the book has a premium option');
  assert.ok(CATERING_SUPPLIERS.some(s => idx(s.qualityCap) < idx('full')), 'and a capped budget option');
});

test('the book is deterministic per window, within ±drift, and re-prices across windows', () => {
  for (const s of CATERING_SUPPLIERS) {
    const a = supplierRateAt(s.id, WEEK), b = supplierRateAt(s.id, WEEK + 1);
    assert.equal(a, b, 'same window → same rate, whoever asks');
    assert.ok(Math.abs(a / s.costFactor - 1) <= CATERING_BOOK_DRIFT + 1e-9, `${s.id} within drift`);
  }
  const moved = CATERING_SUPPLIERS.some(s =>
    supplierRateAt(s.id, 0) !== supplierRateAt(s.id, CATERING_BOOK_WINDOW_WEEKS));
  assert.ok(moved, 'at least one supplier re-prices when the window turns');
  assert.equal(weeksToNextReprice(0), CATERING_BOOK_WINDOW_WEEKS);
  assert.equal(weeksToNextReprice(CATERING_BOOK_WINDOW_WEEKS - 1), 1);
  const book = cateringOfferBook(WEEK);
  assert.equal(book.length, CATERING_SUPPLIERS.length);
});

test('longer terms are cheaper; signing locks this window\'s rate', () => {
  const [one, three, five] = [1, 3, 5].map(y => CATERING_TERM_MAP[y].rateMult);
  assert.ok(five < three && three < one, 'a 5-year deal is cheaper per meal than a 1-year deal');
  const c = makeCateringContract('galley', 3, WEEK);
  assert.equal(c.costFactor, +(supplierRateAt('galley', WEEK) * CATERING_TERM_MAP[3].rateMult).toFixed(4));
  assert.equal(c.termWeeks, 156);
  assert.equal(c.signedWeek, WEEK);
  assert.equal(makeCateringContract('nope', 3, WEEK), null);
  assert.equal(makeCateringContract('galley', 2, WEEK), null, 'only 1/3/5 year terms');
});

test('one contract per coverage; a different coverage signs fine', () => {
  const g = makeCateringContract('galley', 1, WEEK);   // continent: Europe
  const have = contractMap(g);
  assert.ok(!canSignCatering('galley', 1, have).ok, 'no second Europe deal');
  assert.match(canSignCatering('galley', 3, have).reasons[0], /Europe/);
  assert.ok(canSignCatering('orbital', 1, have).ok, 'a global deal alongside is fine');
  assert.ok(canSignCatering('lunchbox', 1, have).ok, 'so is a UK country deal');
  assert.ok(!canSignCatering('galley', 4, {}).ok, 'bad term refused');
});

// ═══════════════════════════════════════════════════════════════════════════
// Coverage, specificity, volume
// ═══════════════════════════════════════════════════════════════════════════

test('coverage: country, continent, global', () => {
  const us = CATERING_SUPPLIER_MAP.bigsky.coverage, eu = CATERING_SUPPLIER_MAP.galley.coverage;
  assert.ok(coversAirport(us, 'JFK') && !coversAirport(us, 'LHR'));
  assert.ok(coversAirport(eu, 'LHR') && !coversAirport(eu, 'JFK'));
  assert.ok(coversAirport({ kind: 'global' }, 'SYD'));
  assert.equal(coverageKey(us), 'country:US');
});

test('the most specific covering contract cooks: country > continent > global', () => {
  const glob = makeCateringContract('orbital', 1, WEEK);
  const na   = makeCateringContract('prairie', 1, WEEK);
  const us   = makeCateringContract('bigsky', 1, WEEK);
  assert.equal(contractForAirport(contractMap(glob), 'JFK').id, glob.id);
  assert.equal(contractForAirport(contractMap(glob, na), 'JFK').id, na.id);
  assert.equal(contractForAirport(contractMap(glob, na, us), 'JFK').id, us.id);
  assert.equal(contractForAirport(contractMap(glob, na, us), 'LHR').id, glob.id, 'outside the narrower deals, global cooks');
  assert.equal(contractForAirport(contractMap(na), 'LHR'), null);
});

test('volume surcharge: nobody refused, small carriers pay up to 20% more', () => {
  assert.equal(volumeSurchargeMult(0, 1000), 1 + CATERING_VOLUME_SURCHARGE);
  assert.equal(volumeSurchargeMult(500, 1000), 1 + CATERING_VOLUME_SURCHARGE / 2);
  assert.equal(volumeSurchargeMult(1000, 1000), 1);
  assert.equal(volumeSurchargeMult(5000, 1000), 1, 'no discount for exceeding it');
  const fleet = [tail('a1')];
  const seats = airportSeatsMap([route('r1', 'a1', 14)], fleet, routeStops);
  assert.equal(seats[O], 14 * TYPE.seats);
  assert.equal(seats[D], 14 * TYPE.seats);
  assert.equal(coverageVolume(CATERING_SUPPLIER_MAP.bigsky.coverage, seats), 28 * TYPE.seats);
  assert.equal(airportSeatsMap([{ ...route('r1', 'a1'), seasonState: 'dormant' }], fleet, routeStops)[O], undefined,
    'a dormant seasonal route departs nothing');
});

// ═══════════════════════════════════════════════════════════════════════════
// Resolution: best-of with the hub, the cook brings the cap
// ═══════════════════════════════════════════════════════════════════════════

test('resolve: no covering contract → null, so nothing is attached', () => {
  assert.equal(resolveCateringContracts(HUB_TIERS, {}, {}, [O, D], {}), null);
  assert.equal(resolveCateringContracts(HUB_TIERS, {}, contractMap(makeCateringContract('galley', 1, WEEK)), [O, D], {}), null);
});

test('resolve: the contract cooks where it is cheaper; the hub cooks where IT is cheaper', () => {
  const cheap = makeCateringContract('bigsky', 5, WEEK);   // ~0.63, capped partial, −4
  const seats = { [O]: 1e6 };                               // no surcharge
  const r = resolveCateringContracts(HUB_TIERS, {}, contractMap(cheap), [O, D], seats);
  assert.equal(r.cateringCostFactor, +cheap.costFactor.toFixed(4), 'both ends contract-cooked → the contract rate');
  assert.equal(r.cateringCap, 'partial');
  assert.deepEqual(r.cateringCooks, [cheap.id, cheap.id]);

  const premium = makeCateringContract('meridian', 1, WEEK);  // > 1
  const hubs = { [O]: { tier: 3 } };
  const p = resolveCateringContracts(HUB_TIERS, hubs, contractMap(premium), [O, D], seats);
  assert.deepEqual(p.cateringCooks, [null, premium.id], 'at the T3 hub the own kitchen is cheaper and cooks');
  const hubRate = 1 - HUB_TIERS[3].stationDiscount;
  assert.equal(p.cateringCostFactor, +((hubRate + premium.costFactor) / 2).toFixed(4), 'best-of, never stacked');
  assert.equal(p.cateringQualityDelta, +(premium.qualityDelta / 2).toFixed(2), 'the premium delta only where the premium caterer cooks');
});

test('apply: the cap bites only when the chosen level is above it', () => {
  const r = { cateringCostFactor: 0.7, cateringQualityDelta: -4, cateringCap: 'partial', cateringCooks: ['x'] };
  const full = applyCateringContractFields({ cateringLevel: 'full' }, r);
  assert.equal(full.cateringLevel, 'partial');
  assert.equal(full.cateringLevelChosen, 'full');
  assert.equal(full.cateringCapped, true);
  const paid = applyCateringContractFields({ cateringLevel: 'paid' }, r);
  assert.equal(paid.cateringLevel, 'paid', 'below the cap nothing changes');
  assert.ok(!('cateringCapped' in paid));
  assert.equal(applyCateringContractFields({ cateringLevel: 'full' }, null).cateringLevel, 'full');
});

// ═══════════════════════════════════════════════════════════════════════════
// The tick
// ═══════════════════════════════════════════════════════════════════════════

test('a world with no contract is byte-identical: no route fields, no report key', () => {
  const rep = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] }));
  assert.ok(!('cateringContractSpend' in rep), 'no spend key on a contract-less report');
  const rr = rep.routeResults.find(r => r.routeId === 'r1');
  assert.equal(rr.cateringLevel, 'full');
});

test('a contract at both ends charges catering at its rate, and attributes the spend to it', () => {
  const c = makeCateringContract('orbital', 1, WEEK);   // global, delta 0, cap full → demand unaffected
  const st = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], cateringContracts: contractMap(c) });
  const rep = weeklyTick(st);
  const rr = rep.routeResults.find(r => r.routeId === 'r1');
  // Orbital has no quality delta and no cap, so demand — and the uncontracted
  // catering bill — is identical with and without it; the ratio IS the factor.
  // (Measured as a ratio: result.classSummary carries rounded pax while the sim
  // costs on unrounded pax, so rebuilding the bill from it is off by a few $.)
  const none = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] }))
    .routeResults.find(r => r.routeId === 'r1');
  assert.equal(rr.passengers, none.passengers, 'fixture: a delta-0, uncapped caterer moves no passengers');
  const seats = airportSeatsMap(st.routes, st.fleet, routeStops);
  const factor = +(c.costFactor * volumeSurchargeMult(coverageVolume(c.coverage, seats), c.minVolume)).toFixed(4);
  assert.ok(Math.abs(rr.cateringCost / none.cateringCost - factor) < 1e-4,
    `charged at ${(rr.cateringCost / none.cateringCost).toFixed(5)} of the contract-free bill, expected ${factor}`);
  assert.equal(rep.cateringContractSpend[c.id], rr.cateringCost, 'every catering dollar on the route is this contract\'s');
  const bridge = costBridge(bridgeInputsFromReport(rep), st);
  assert.equal(bridge.residual, 0, 'contract catering flows through the existing catering line — nothing unnamed');
});

test('the cap bites in the tick: a Full route under a partial-capped caterer is charged — and scored — as Partial', () => {
  const c = makeCateringContract('bigsky', 1, WEEK);
  const none = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] })).routeResults[0];
  const capped = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], cateringContracts: contractMap(c) })).routeResults[0];
  assert.equal(capped.cateringLevel, 'partial', 'the simulator ran the delivered level');
  assert.ok(capped.qualityScore < none.qualityScore, 'a capped, lower-quality caterer costs quality');
  const dist = routeDistanceKm(O, D);
  assert.ok(capped.cateringCost < routeCatering('full', capped.classSummary, dist).cost, 'and you pay for partial, not full');
});

test('the state route keeps the player\'s choice; only the simulated copy is capped', () => {
  const c = makeCateringContract('bigsky', 1, WEEK);
  const st = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], cateringContracts: contractMap(c),
    routeCatering: { [PAIR]: 'full' } });
  weeklyTick(st);
  assert.equal(st.routeCatering[PAIR], 'full');
  assert.equal(st.routes[0].cateringLevel, undefined, 'the tick never writes back to state');
});

test('at a hub whose kitchen is cheaper, a premium contract changes nothing there', () => {
  const hubs = { [O]: { tier: 3 }, [D]: { tier: 3 } };
  const premium = makeCateringContract('meridian', 1, WEEK);
  const hubOnly = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], hubs })).routeResults[0];
  const withP   = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], hubs, cateringContracts: contractMap(premium) })).routeResults[0];
  assert.equal(withP.cateringCost, hubOnly.cateringCost, 'both ends hub-cooked → hub rate, contract unused');
  assert.equal(withP.qualityScore, hubOnly.qualityScore, 'and no premium quality either');
});

test('previews agree with the tick: stateCateringFields resolves what weeklyTick applied', () => {
  const c = makeCateringContract('bigsky', 3, WEEK);
  const st = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], cateringContracts: contractMap(c) });
  const f = stateCateringFields(st, st.routes[0]);
  assert.equal(f.cateringLevel, 'partial');
  assert.equal(f.cateringCapped, true);
  const rr = weeklyTick(st).routeResults[0];
  assert.equal(rr.cateringLevel, f.cateringLevel, 'the preview and the tick deliver the same level');
  const base = routeCatering('partial', rr.classSummary, routeDistanceKm(O, D)).cost;
  assert.ok(Math.abs(rr.cateringCost / base - f.cateringCostFactor) < 5e-4,
    `the preview factor ${f.cateringCostFactor} is the one the tick charged (${(rr.cateringCost / base).toFixed(5)})`);
  assert.deepEqual(stateCateringFields({ ...st, cateringContracts: undefined }, st.routes[0]), {});
});

// ═══════════════════════════════════════════════════════════════════════════
// Term, expiry, exit
// ═══════════════════════════════════════════════════════════════════════════

test('expiry: lapses at the end week, warns exactly 8 weeks before', () => {
  const c = makeCateringContract('galley', 1, WEEK);
  const end = WEEK + 52;
  assert.equal(contractWeeksLeft(c, WEEK), 52);
  const warn = tickCateringContracts(contractMap(c), end - CATERING_EXPIRY_WARNING_WEEKS);
  assert.equal(warn.expiringSoon.length, 1);
  assert.equal(tickCateringContracts(contractMap(c), end - CATERING_EXPIRY_WARNING_WEEKS - 1).expiringSoon.length, 0);
  const gone = tickCateringContracts(contractMap(c), end);
  assert.equal(Object.keys(gone.contracts).length, 0);
  assert.equal(gone.expired[0].id, c.id);
});

test('break cost = weeks left × weekly spend × 35%', () => {
  const c = makeCateringContract('galley', 5, WEEK);
  assert.equal(cateringBreakCost(c, WEEK, 10_000), Math.round(260 * 10_000 * CATERING_BREAK_FRACTION));
  assert.equal(cateringBreakCost(c, WEEK + 259, 10_000), Math.round(1 * 10_000 * CATERING_BREAK_FRACTION), 'nearly over → nearly free');
  assert.equal(cateringBreakCost(c, WEEK, 0), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Reducer
// ═══════════════════════════════════════════════════════════════════════════

const { gameReducer, freshState, reconcileState } = await import('../packages/engine/src/reducer.mjs');
const playing = (extra = {}) => ({ ...freshState(), phase: 'playing', week: 10, year: 3, cash: 500_000_000, ...extra });

test('freshState carries no contracts key (golden parity)', () => {
  assert.ok(!('cateringContracts' in freshState()));
});

test('SIGN locks a contract at no cash cost; a clash is refused with the reason', () => {
  const s0 = playing();
  const s1 = gameReducer(s0, { type: 'SIGN_CATERING_CONTRACT', supplierId: 'galley', years: 3 });
  const [c] = Object.values(s1.cateringContracts);
  assert.equal(c.supplierId, 'galley');
  assert.equal(s1.cash, s0.cash, 'a contract is a commitment, not capex');
  const s2 = gameReducer(s1, { type: 'SIGN_CATERING_CONTRACT', supplierId: 'galley', years: 1 });
  assert.match(s2.error, /Europe/);
  assert.equal(Object.keys(s2.cateringContracts).length, 1);
});

test('BREAK charges 35% of remaining spend from the last report, and clears the key when it was the last', () => {
  const s1 = gameReducer(playing(), { type: 'SIGN_CATERING_CONTRACT', supplierId: 'galley', years: 1 });
  const [c] = Object.values(s1.cateringContracts);
  const withSpend = { ...s1, lastReport: { cateringContractSpend: { [c.id]: 20_000 } } };
  const s2 = gameReducer(withSpend, { type: 'BREAK_CATERING_CONTRACT', id: c.id });
  const abs = (3 - 1) * 52 + 10;
  assert.equal(s2.cash, withSpend.cash - cateringBreakCost(c, abs, 20_000));
  assert.ok(!('cateringContracts' in s2), 'no empty container left behind');
});

test('ADVANCE_WEEK expires a contract at the end of its term and clears the key', () => {
  let s = gameReducer(playing({ fleet: [], routes: [] }), { type: 'SIGN_CATERING_CONTRACT', supplierId: 'orbital', years: 1 });
  const [c] = Object.values(s.cateringContracts);
  // Backdate it a full term: the week now being simulated is its end week.
  s = { ...s, cateringContracts: { [c.id]: { ...c, signedWeek: c.signedWeek - 52 } } };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.cateringContracts, undefined, 'lapsed and cleared');
  assert.ok((s.pendingToasts ?? []).some(t => /contract ended/.test(t.title)), 'and the player is told');
});

test('a save with contracts loads them; a save without stays keyless', () => {
  const c = makeCateringContract('galley', 1, WEEK);
  const withC = reconcileState({ ...playing(), cateringContracts: contractMap(c) });
  assert.equal(Object.keys(withC.cateringContracts).length, 1);
  assert.ok(!('cateringContracts' in reconcileState(playing())));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
