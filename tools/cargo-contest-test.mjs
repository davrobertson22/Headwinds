// Contested cargo — freighters compete across airlines for a lane's freight,
// the way passengers already do. Before this, every carrier on a lane drew the
// whole gravity pool independently (two on FRA–JFK each banked full tonnage).
//
//   node tools/cargo-contest-test.mjs
import assert from 'node:assert/strict';
import { getAircraftType } from '../src/data/aircraft.js';
import { cargoReferenceYield } from '../src/utils/market.js';
import { cargoLaneAllocations, simulateCargoRoute } from '../src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const cy = (o, d) => cargoReferenceYield(o, d);
const freighter = (typeId, id) => ({ id, typeId, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' });
const cRoute = (o, d, ac, id, opts = {}) =>
  ({ id, origin: o, destination: d, aircraftId: ac,
     yieldPrice: opts.yieldPrice ?? cy(o, d), weeklyFrequency: opts.freq ?? 7,
     weeksOpen: opts.weeksOpen ?? 30, cargo: true });

// A lane a b777F can fly (HKG–FRA is within range; HKG–JFK is not — see cargo-test).
const O = 'HKG', D = 'FRA';
const GD = { month: 6 };
const capOf = (typeId, freq = 7) => getAircraftType(typeId).payloadTonnes * freq;
const pairKey = [O, D].sort().join('-');
const rivalWith = (tonnesPerWeek, yieldPrice) =>
  ({ cargoRoutes: { [pairKey]: { tonnesPerWeek, yieldPrice } } });

console.log('\nContested cargo\n');

const own   = cRoute(O, D, 'f1', 'own');
const fleet = [freighter('b777f', 'f1')];

test('a lone freighter with no rival is uncontested — no override, full pool as before', () => {
  const alloc = cargoLaneAllocations([own], fleet, 1.0, { gameDate: GD });
  assert.equal(alloc.get('own'), undefined, 'a solo route must fall through to the full-pool path');
});

test('passing an empty competitor list changes nothing', () => {
  const alloc = cargoLaneAllocations([own], fleet, 1.0, { gameDate: GD, competitors: [] });
  assert.equal(alloc.get('own'), undefined);
});

test('a rival freighter on the lane cuts the player’s tonnage roughly in half at equal capacity+yield', () => {
  const cap = capOf('b777f');
  const alloc = cargoLaneAllocations([own], fleet, 1.0,
    { gameDate: GD, competitors: [rivalWith(cap, cy(O, D))] });
  const a = alloc.get('own');
  assert.ok(a, 'a route a rival contests must now get an allocation (it did not on HEAD)');
  assert.equal(a.contested, true);
  assert.equal(a.rivalCapacityTonnes, cap);

  const solo = simulateCargoRoute(own, freighter('b777f', 'f1'), GD); // full-pool demand
  assert.ok(a.demandTonnes < solo.demandTonnes, 'a rival must dilute the player’s demand');
  const share = a.demandTonnes / solo.demandTonnes;
  assert.ok(Math.abs(share - 0.5) < 0.02, `equal capacity + yield should split ~50/50, got ${share.toFixed(3)}`);
});

test('a premium-priced rival steals less freight than a cut-rate one', () => {
  const cap = capOf('b777f');
  const premium = cargoLaneAllocations([own], fleet, 1.0,
    { gameDate: GD, competitors: [rivalWith(cap, cy(O, D) * 1.5)] }).get('own');
  const cheap   = cargoLaneAllocations([own], fleet, 1.0,
    { gameDate: GD, competitors: [rivalWith(cap, cy(O, D) * 0.6)] }).get('own');
  assert.ok(premium.demandTonnes > cheap.demandTonnes,
    'a rival charging a premium wins less, leaving the player more; a cut-rate rival takes more');
});

test('more rival capacity dilutes more', () => {
  const one  = cargoLaneAllocations([own], fleet, 1.0,
    { gameDate: GD, competitors: [rivalWith(capOf('b777f'), cy(O, D))] }).get('own');
  const four = cargoLaneAllocations([own], fleet, 1.0,
    { gameDate: GD, competitors: [rivalWith(capOf('b777f') * 4, cy(O, D))] }).get('own');
  assert.ok(four.demandTonnes < one.demandTonnes);
});

test('own-only multi-route pooling is byte-identical with or without an empty competitor list (regression)', () => {
  const r1 = cRoute(O, D, 'f1', 'r1'), r2 = cRoute(O, D, 'f2', 'r2');
  const fl = [freighter('b777f', 'f1'), freighter('b777f', 'f2')];
  const base  = cargoLaneAllocations([r1, r2], fl, 1.0, { gameDate: GD });
  const empty = cargoLaneAllocations([r1, r2], fl, 1.0, { gameDate: GD, competitors: [] });
  assert.equal(base.get('r1').demandTonnes, empty.get('r1').demandTonnes);
  assert.equal(base.get('r2').demandTonnes, empty.get('r2').demandTonnes);
  // and each own route's own-pool share is unchanged from the pre-contest math:
  // two equal freighters at reference split the pool 50/50.
  const solo = simulateCargoRoute(r1, freighter('b777f', 'f1'), GD);
  assert.ok(Math.abs(base.get('r1').demandTonnes / solo.demandTonnes - 0.5) < 0.02);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
