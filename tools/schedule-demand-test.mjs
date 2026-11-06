// Demand model v4 — schedule demand and earned pricing headroom
// (docs/game-audit-2026-11-06.md R1 + R2).
//
//   node tools/schedule-demand-test.mjs
//
// Before v4 frequency only entered the share fight: a route flown alone sold
// the same seats at two flights a week as at three a day, three times a rival's
// frequency won only ~70% of business travellers, and the yield choke was a wall
// that a protected market or a hub could not move. These checks pin the v4
// rules AND that every older world is untouched (the golden master covers the
// tick byte-for-byte; the v3 checks here cover the functions directly).
import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { computeMarketShare, buildRouteMarket } from '../packages/engine/src/models/demand.js';
import { setDemandModel, setNwrYieldChoke, nwrYieldChokeFactor, referencePrice } from '../packages/engine/src/utils/market.js';
import { defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';
import { cliffFaresFor } from '../packages/engine/src/models/fareCliff.js';
import { buildRivalViews } from '../apps/headwinds-server/src/lib/humanRivals.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const realRandom = Math.random;

const GAME_DATE = { week: 20, month: 5, monthIndex: 4, absWeek: 20 };
const offer = (f, extra = {}) => ({
  airlineId: 'player', origin: 'BOI', destination: 'SLC',
  economyPrice: 0, businessPrice: null, weeklyFrequency: f,
  economySeats: 1e6, businessSeats: 0, totalSeats: 1e6, qualityScore: 60, ...extra,
});
function paxAt(model, f, extra = {}) {
  setDemandModel(model);
  const m = buildRouteMarket('BOI', 'SLC', GAME_DATE);
  const o = offer(f, { economyPrice: m.referencePrice, ...extra });
  return computeMarketShare(m, [o])[0].totalPax;
}
function businessShare(model, fA, fB) {
  setDemandModel(model);
  const m = buildRouteMarket('JFK', 'BOS', GAME_DATE);
  const mk = (id, f) => ({
    airlineId: id, origin: 'JFK', destination: 'BOS',
    economyPrice: m.referencePrice, businessPrice: Math.round(m.referencePrice * 3),
    weeklyFrequency: f, economySeats: 1e6, businessSeats: 1e6, totalSeats: 2e6, qualityScore: 60,
  });
  const r = computeMarketShare(m, [mk('a', fA), mk('b', fB)]);
  return r[0].businessShare;
}

console.log('\nSchedule demand (v4)\n');

await test('a route flown alone sells more seats the more often it flies (v4)', () => {
  const p2 = paxAt(4, 2), p7 = paxAt(4, 7), p21 = paxAt(4, 21);
  assert.ok(p2 < p7 && p7 < p21, `expected 2/wk < 7/wk < 21/wk, got ${p2} / ${p7} / ${p21}`);
  assert.ok(p2 < p7 * 0.9, `twice a week should lose real travellers vs daily, got ${p2} vs ${p7}`);
});

await test('…and v3 is unchanged: frequency does not move a monopoly pool there', () => {
  assert.equal(paxAt(3, 2), paxAt(3, 21));
  assert.equal(paxAt(3, 7), paxAt(4, 7), 'daily service is the anchor: v4 at 7/wk must equal v3');
});

await test('frequency share wins business travellers super-proportionally (the S-curve)', () => {
  const v4 = businessShare(4, 21, 7), v3 = businessShare(3, 21, 7);
  assert.ok(v4 > 0.78, `3x the frequency should take >78% of business on v4, got ${(v4 * 100).toFixed(1)}%`);
  assert.ok(v3 < 0.75, `v3 reference point moved: ${(v3 * 100).toFixed(1)}%`);
});

await test('the monopoly and contested paths agree where they meet', () => {
  // One offer through computeMarketShare IS the monopoly path; a second carrier
  // adds its timetable to the pair's. Two 3/wk carriers give the market a 6/wk
  // schedule, so v4 lifts their combined pool by more than it lifts one 3/wk
  // carrier alone (the fare-compression and share rules are v3's and cancel).
  const run = (model, offers) => {
    setDemandModel(model);
    const m = buildRouteMarket('BOI', 'SLC', GAME_DATE);
    return computeMarketShare(m, offers.map(o => ({ ...o, economyPrice: m.referencePrice })))
      .reduce((s, r) => s + r.totalPax, 0);
  };
  const solo = [offer(3)];
  const pair = [offer(3, { airlineId: 'a' }), offer(3, { airlineId: 'b' })];
  const liftSolo = run(4, solo) / run(3, solo);
  const liftPair = run(4, pair) / run(3, pair);
  assert.ok(liftSolo < 1, `a 3/wk monopoly is below daily: lift ${liftSolo.toFixed(3)}`);
  assert.ok(liftPair > liftSolo, `the combined 6/wk timetable serves more of the pair: ${liftPair.toFixed(3)} vs ${liftSolo.toFixed(3)}`);
});

console.log('\nEarned pricing headroom (v4)\n');

await test('the yield choke starts later with headroom and falls off more gently — v4 only', () => {
  setNwrYieldChoke(true);
  setDemandModel(3);
  const v3 = nwrYieldChokeFactor(1.30, 50, 0.10);
  setDemandModel(4);
  const v4none = nwrYieldChokeFactor(1.30, 50, 0);
  const v4head = nwrYieldChokeFactor(1.30, 50, 0.10);
  assert.ok(v4none > v3, `a softer fall-off: ${v4none} vs ${v3}`);
  assert.ok(v4head > v4none, `headroom moves the threshold: ${v4head} vs ${v4none}`);
  assert.equal(nwrYieldChokeFactor(1.15, 50, 0.10), 1, 'below the earned threshold: no choke');
  setNwrYieldChoke(false);
  setDemandModel(3);
});

// A v4 restricted-world airline at BOI with two routes; a rival (through the
// real server overlay) at SLC and BOS, so BOI–SLC has a credible entrant and
// BOI–GEG does not.
function v4Airline({ name, hub, dests, fare = 1.0, freq = 7 }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, cash: 5e8, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {},
    demandModel: 4, newWorldRestrictions: true };
  for (const d of dests) {
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'e175' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: hub, destination: d, weeklyFrequency: freq });
  }
  const routePricing = { ...s.routePricing };
  for (const d of dests) routePricing[[hub, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(hub, d) * fare));
  return { ...s, routePricing };
}

await test('a protected market earns headroom; a rival at both ends takes it away', async () => {
  const { pricingHeadroomFor, PRICING_HEADROOM } = await import('../packages/engine/src/models/pricingPower.js');
  const me = v4Airline({ name: 'Me', hub: 'BOI', dests: ['SLC', 'GEG'] });
  const rival = v4Airline({ name: 'Rival', hub: 'SLC', dests: ['BOI', 'BOS'] });
  // The rival flies SLC–BOI itself in this fixture → contested. Rebuild it to
  // fly SLC–BOS and DEN–BOI instead: present at both BOI and SLC, not on the pair.
  let r = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Rival', hub: 'SLC', enableObjectives: false });
  r = { ...r, cash: 5e8, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {}, demandModel: 4, newWorldRestrictions: true };
  for (const [o, d] of [['SLC', 'BOS'], ['SLC', 'DEN'], ['DEN', 'BOI']]) {
    r = gameReducer(r, { type: 'LEASE_AIRCRAFT', typeId: 'e175' });
    const ac = r.fleet[r.fleet.length - 1].id;
    r = gameReducer(r, { type: 'ADD_GATE', airportCode: o });
    r = gameReducer(r, { type: 'ADD_GATE', airportCode: d });
    r = gameReducer(r, { type: 'ADD_ROUTE', aircraftId: ac, origin: o, destination: d, weeklyFrequency: 7 });
  }
  assert.equal(r.routes.length, 3, `rival fixture routes: ${r.error ?? ''}`);
  const views = buildRivalViews([
    { id: 'm', worldId: 'w', name: 'Me', hub: 'BOI', status: 'ACTIVE', state: me },
    { id: 'r', worldId: 'w', name: 'Rival', hub: 'SLC', status: 'ACTIVE', state: r },
  ]);
  const mine = { ...me, competitors: views.get('m').competitors, humanRivals: views.get('m').humanRivals };
  const hubTerm = PRICING_HEADROOM.hubByTier[mine.hubs?.BOI?.tier ?? 1] ?? 0;
  assert.equal(pricingHeadroomFor(mine, 'BOI', 'GEG'), +(hubTerm + PRICING_HEADROOM.protectedMarket).toFixed(4),
    'BOI–GEG: nobody at GEG → protected');
  assert.equal(pricingHeadroomFor(mine, 'BOI', 'SLC'), hubTerm, 'BOI–SLC: the rival is at both ends → hub term only');
  assert.equal(pricingHeadroomFor({ ...mine, demandModel: 3 }, 'BOI', 'GEG'), 0, 'v3: no headroom');
  assert.ok(rival, 'fixture');
});

await test('the forecast agrees with the tick on a v4 airline (frequency + premium fares)', () => {
  // Built with real randomness (ids are drawn from Math.random), then flown
  // with every probability gate held shut: no events, failures or AI dice —
  // the deterministic prep the forecast is meant to reproduce.
  let s = v4Airline({ name: 'Agree', hub: 'BOI', dests: ['SLC', 'GEG', 'PDX', 'SEA'], fare: 1.3 });
  assert.equal(s.routes.length, 4, `fixture routes: ${s.error ?? ''}`);
  s = gameReducer(s, { type: 'UPDATE_FREQUENCY', routeId: s.routes[0].id, weeklyFrequency: 2 });
  s = gameReducer(s, { type: 'UPDATE_FREQUENCY', routeId: s.routes[1].id, weeklyFrequency: 14 });
  Math.random = () => 0.9999999;
  try {
    for (let i = 0; i < 3; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    const proj = projectWeek(s);
    const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
    const byId = (rep) => new Map((rep?.routeResults ?? []).map(x => [x.routeId, x]));
    const P = byId(proj.report), A = byId(next.lastReport);
    assert.ok(A.size >= 4, `expected 4 flown routes, got ${A.size}`);
    for (const [id, a] of A) {
      const p = P.get(id);
      assert.ok(p, `route ${id} missing from the projection`);
      assert.equal(p.passengers, a.passengers, `route ${id}: projected ${p.passengers} pax, flew ${a.passengers}`);
    }
  } finally { Math.random = realRandom; }
});


await test('the Route Planner forecasts a new v4 route the way the tick flies it', () => {
  let s = v4Airline({ name: 'Plan', hub: 'BOI', dests: ['SLC'], fare: 1.0 });
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'e175' });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'PDX' });
  const tail = s.fleet[s.fleet.length - 1];
  const classPrices = defaultClassPrices(Math.round(referencePrice('BOI', 'PDX') * 1.3));
  Math.random = () => 0.9999999;
  try {
    for (let i = 0; i < 2; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    const planned = projectRouteAddition(s, { origin: 'BOI', destination: 'PDX', aircraft: tail, weeklyFrequency: 3, classPrices });
    assert.ok(planned?.mature, 'planner returned nothing');
    Math.random = realRandom;
    let t = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: tail.id, origin: 'BOI', destination: 'PDX', weeklyFrequency: 3 });
    const r = t.routes.find(x => x.destination === 'PDX');
    assert.ok(r, `route did not open: ${t.error ?? ''}`);
    t = { ...t, routes: t.routes.map(x => (x.id === r.id ? { ...x, weeksOpen: 40 } : x)),
      routePricing: { ...t.routePricing, [['BOI', 'PDX'].sort().join('-')]: classPrices } };
    Math.random = () => 0.9999999;
    const next = gameReducer(t, { type: 'ADVANCE_WEEK' });
    const flown = next.lastReport.routeResults.find(x => x.routeId === r.id);
    const want = flown.passengers, got = planned.mature.passengers;
    assert.ok(Math.abs(got - want) <= Math.max(2, want * 0.02),
      `planner ${got} pax vs tick ${want} (a 1.3x fare on a protected 3/wk route — both rules in play)`);
  } finally { Math.random = realRandom; }
});

await test('the fare-cliff warning sits where the v4 tick puts the cliff', () => {
  let s = v4Airline({ name: 'Cliff', hub: 'BOI', dests: ['GEG'] });
  setNwrYieldChoke(true); setDemandModel(4);
  const { economy } = cliffFaresFor(s, 'BOI', 'GEG');
  const ref = referencePrice('BOI', 'GEG');
  setDemandModel(3);
  const v3 = cliffFaresFor({ ...s, demandModel: 3 }, 'BOI', 'GEG').economy;
  assert.ok(economy > v3, `protected v4 pair warns later than v3: ${economy} vs ${v3}`);
  assert.ok(economy / ref > 1.2, `cliff ratio ${(economy / ref).toFixed(3)} should include the protected-market headroom`);
  setNwrYieldChoke(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
Math.random = realRandom;
setDemandModel(1);
if (failed > 0) process.exit(1);
