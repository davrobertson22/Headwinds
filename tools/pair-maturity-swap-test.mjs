// Swapping the aircraft on a route must not re-ramp the market.
//
// Discord (Kat the Fox, 2026-11-12): "swapping aircraft craters route demand
// because it counts the route as closed and reopened". It did. A pair's
// maturity is the OLDEST open route on it (routeMaturityFactor, 0.55 at launch
// and 1.0 from week 16), and ADD_ROUTE always started the new route at week 0.
// Swapping by hand — open the pair on the new tail, close the old one, in
// either order — left only the week-0 route, so the whole market fell to 55%
// (6,090 → 3,350 a week on JFK–BTV in the probe). REASSIGN_ROUTE (the Move
// button) kept the route and was fine, which is why this hid.
//
// Now a route opened on a pair the airline already flies starts at the pair's
// maturity, and a pair closed recently remembers it for a few weeks
// (models/pairMaturity.js). The Route Planner's launch figure reads the same
// helper, so the preview agrees with the tick.
//
// Verified failing on HEAD (2026-11-12) through the actions alone: the new
// route came in at weeksOpen 0 and the swapped pair's market at ~55%.
//
//   node tools/pair-maturity-swap-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/index.mjs';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';
import { makeRng } from './golden-master/harness.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
function seeded(seed, fn) {
  const r = Math.random, n = Date.now; const rng = makeRng(seed); let c = 1.7e12;
  Math.random = rng; Date.now = () => (c += 1000);
  try { return fn(); } finally { Math.random = r; Date.now = n; }
}

const DEST = 'BTV';
const FREQ = 14;
const pk = (r) => [r.origin, r.destination].sort().join('-');
const PAIR = ['JFK', DEST].sort().join('-');

const base = seeded(42, () => {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Swap Air', hub: 'JFK' });
  s = { ...s, cash: 500_000_000 };
  for (const t of ['a320ceo', 'a320ceo', 'a321ceo']) s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: t });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: DEST });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[0].id, origin: 'JFK', destination: DEST, weeklyFrequency: FREQ });
  // A long-established route: 30 weeks open, well past the 16-week ramp.
  return { ...s, routes: s.routes.map(r => ({ ...r, weeksOpen: 30 })) };
});
const [A, , C] = base.fleet.map(a => a.id);
const oldId = base.routes[0].id;
assert.equal(base.routes.length, 1, 'fixture: one route on the pair');

const open  = (s, tail = C) => gameReducer(s, { type: 'ADD_ROUTE', aircraftId: tail, origin: 'JFK', destination: DEST, weeklyFrequency: FREQ });
const close = (s, id = oldId) => gameReducer(s, { type: 'CLOSE_ROUTE', routeId: id });
const tick  = (s) => gameReducer(s, { type: 'ADVANCE_WEEK' });
const pairRoutes = (s) => s.routes.filter(r => pk(r) === PAIR);
const marketOf = (s) => {
  const r = pairRoutes(s)[0];
  return (s.lastReport?.routeResults ?? []).find(x => x.routeId === r.id)?.marketDemand ?? 0;
};
const tickMarket = (s) => seeded(7, () => marketOf(tick(s)));
const ref = tickMarket(base);

console.log('\nSwapping by hand keeps the pair mature\n');

test('a tail added to a pair you already fly starts at the pair\'s maturity, not week 0', () => {
  const s = open(base);
  const added = pairRoutes(s).find(r => r.aircraftId === C);
  assert.ok(added, 'route opened');
  assert.equal(added.weeksOpen, 30);
});

test('open on the new tail, then close the old: next week\'s market is unchanged', () => {
  const m = tickMarket(close(open(base)));
  assert.ok(ref > 0, 'reference market');
  assert.ok(Math.abs(m / ref - 1) < 0.01, `market ${m} vs ${ref} without the swap (${(m / ref * 100).toFixed(0)}%)`);
});

test('close the old route first, then reopen on the new tail in the same week: unchanged', () => {
  const s = open(close(base));
  assert.equal(pairRoutes(s).length, 1);
  assert.ok(pairRoutes(s)[0].weeksOpen >= 16, `reopened at weeksOpen ${pairRoutes(s)[0].weeksOpen}`);
  const m = tickMarket(s);
  assert.ok(Math.abs(m / ref - 1) < 0.01, `market ${m} vs ${ref} (${(m / ref * 100).toFixed(0)}%)`);
});

test('the memory fades: 3 weeks off loses 6 weeks of maturity, 8+ weeks off is a new launch', () => {
  let s = close(base);
  for (let w = 0; w < 3; w++) s = tick(s);
  assert.equal(pairRoutes(open(s)).at(0).weeksOpen, 10);
  for (let w = 0; w < 5; w++) s = tick(s);
  assert.equal(pairRoutes(open(s)).at(0).weeksOpen, 0);
});

test('a pair you have never flown still launches at week 0', () => {
  const s = gameReducer(gameReducer(base, { type: 'ADD_GATE', airportCode: 'BOS' }),
    { type: 'ADD_ROUTE', aircraftId: C, origin: 'JFK', destination: 'BOS', weeklyFrequency: 7 });
  const r = s.routes.find(x => x.destination === 'BOS');
  assert.ok(r, 'BOS opened');
  assert.equal(r.weeksOpen, 0);
});

test('a young pair passes on its own age, not the full ramp', () => {
  const young = { ...base, routes: base.routes.map(r => ({ ...r, weeksOpen: 5 })) };
  assert.equal(pairRoutes(open(close(young))).at(0).weeksOpen, 5);
  assert.equal(pairRoutes(close(open(young))).at(0).weeksOpen, 5);
});

test('serving the pair again clears its memory, and nothing is written when no pair is left unserved', () => {
  assert.equal(open(base).closedPairMaturity, undefined);
  assert.equal(tick(base).closedPairMaturity, undefined);
  const s = open(close(base));
  assert.ok(!s.closedPairMaturity || Object.keys(s.closedPairMaturity).length === 0,
    JSON.stringify(s.closedPairMaturity));
});

console.log('\nFreighters too\n');

test('a freighter swapped onto a lane by hand keeps the lane\'s maturity, in either order', () => {
  const ft = AIRCRAFT_TYPES.find(t => t.freighter && !t.eraOnly && (t.range ?? 0) > 2000 && (t.introYear ?? 0) < 2010);
  assert.ok(ft, 'a freighter type');
  let s = base;
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: ft.id });
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: ft.id });
  const [f1, f2] = s.fleet.filter(a => a.typeId === ft.id).map(a => a.id);
  assert.ok(f1 && f2, 'two freighters leased');
  s = gameReducer(s, { type: 'ADD_CARGO_ROUTE', aircraftId: f1, origin: 'JFK', destination: DEST, weeklyFrequency: 3 });
  assert.equal(s.cargoRoutes.length, 1, 'cargo route opened');
  s = { ...s, cargoRoutes: s.cargoRoutes.map(r => ({ ...r, weeksOpen: 40 })) };
  const cid = s.cargoRoutes[0].id;
  const add  = (x) => gameReducer(x, { type: 'ADD_CARGO_ROUTE', aircraftId: f2, origin: DEST, destination: 'JFK', weeklyFrequency: 3 });
  const shut = (x) => gameReducer(x, { type: 'CLOSE_CARGO_ROUTE', routeId: cid });
  assert.equal(shut(add(s)).cargoRoutes.at(0)?.weeksOpen, 40);
  assert.equal(add(shut(s)).cargoRoutes.at(0)?.weeksOpen, 16);
  // Lanes and pax pairs are remembered apart: closing the freighter says
  // nothing about the passenger pair, which is still flown.
  assert.deepEqual(Object.keys(shut(s).closedPairMaturity ?? {}), [`cargo:${PAIR}`]);
});

console.log('\nThe planner agrees with the tick\n');

test('reopening a just-closed mature pair previews its launch week at full maturity', () => {
  const s = close(base);
  const aircraft = s.fleet.find(a => a.id === C);
  const p = projectRouteAddition(s, { origin: 'JFK', destination: DEST, aircraft, weeklyFrequency: FREQ });
  assert.ok(p?.launch && p?.mature, 'projection');
  assert.equal(p.launch.marketDemand, p.mature.marketDemand);
});

test('a never-flown pair still previews a ramped launch week', () => {
  const s = gameReducer(base, { type: 'ADD_GATE', airportCode: 'BOS' });
  const aircraft = s.fleet.find(a => a.id === C);
  const p = projectRouteAddition(s, { origin: 'JFK', destination: 'BOS', aircraft, weeklyFrequency: 7 });
  assert.ok(p?.launch && p?.mature, 'projection');
  assert.ok(p.launch.marketDemand < p.mature.marketDemand * 0.7, `${p.launch.marketDemand} vs ${p.mature.marketDemand}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
