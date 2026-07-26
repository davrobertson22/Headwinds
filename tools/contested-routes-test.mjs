// Regression test for contested-route aggregation.
//
// Reported bug (Discord, 2026-07-25): "Contested routes dont count multiple
// aircraft being on route" — a player flying LAX–SFO with an A220 at 47×/wk AND
// an ATR 72 at 18×/wk was shown as 18×/wk, 1,404 seats/wk in the head-to-head
// card, because the routeKey→route map overwrote instead of aggregating.
//
// The reducer only merges route rows that share the SAME aircraft and the SAME
// season window, so one city pair legitimately holds several route objects.
// buildPlayerPairMap() folds them back together.
//
//   node --import ./tools/_register-loader.mjs tools/contested-routes-test.mjs

import assert from 'node:assert/strict';
import { getAircraftType } from '../src/data/aircraft.js';

const { buildPlayerPairMap } = await import('../src/components/Competition.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const A220 = getAircraftType('a220100') ?? getAircraftType('a220300');
const ATR  = getAircraftType('atr72');
assert.ok(A220 && ATR, 'sample aircraft types resolve');

const fleet = [
  { id: 't1', typeId: A220.id, config: null, ageWeeks: 0 },
  { id: 't2', typeId: ATR.id,  config: null, ageWeeks: 0 },
];
const route = (over) => ({
  origin: 'LAX', destination: 'SFO', ticketPrice: 105, weeklyFrequency: 0, ...over,
});

console.log('\n── multiple aircraft on one city pair ───────────────────');

test('frequency sums across every aircraft on the pair', () => {
  const m = buildPlayerPairMap([
    route({ aircraftId: 't1', weeklyFrequency: 47 }),
    route({ aircraftId: 't2', weeklyFrequency: 18 }),
  ], fleet, 7);
  assert.equal(m['LAX-SFO'].weeklyFrequency, 65);
});

test('seats/week weights each aircraft by its own frequency', () => {
  const m = buildPlayerPairMap([
    route({ aircraftId: 't1', weeklyFrequency: 47 }),
    route({ aircraftId: 't2', weeklyFrequency: 18 }),
  ], fleet, 7);
  assert.equal(m['LAX-SFO'].seatsPerWeek, A220.seats * 47 + ATR.seats * 18);
});

test('every route row on the pair is retained as a leg', () => {
  const m = buildPlayerPairMap([
    route({ aircraftId: 't1', weeklyFrequency: 47 }),
    route({ aircraftId: 't2', weeklyFrequency: 18 }),
  ], fleet, 7);
  assert.equal(m['LAX-SFO'].legs.length, 2);
});

test('route order does not change the answer (no last-write-wins)', () => {
  const rows = [
    route({ aircraftId: 't1', weeklyFrequency: 47 }),
    route({ aircraftId: 't2', weeklyFrequency: 18 }),
  ];
  const a = buildPlayerPairMap(rows, fleet, 7)['LAX-SFO'];
  const b = buildPlayerPairMap([...rows].reverse(), fleet, 7)['LAX-SFO'];
  assert.equal(a.weeklyFrequency, b.weeklyFrequency);
  assert.equal(a.seatsPerWeek, b.seatsPerWeek);
  assert.equal(a.ticketPrice, b.ticketPrice);
});

test('reversed origin/destination lands on the same pair key', () => {
  const m = buildPlayerPairMap([
    route({ aircraftId: 't1', weeklyFrequency: 10 }),
    route({ origin: 'SFO', destination: 'LAX', aircraftId: 't2', weeklyFrequency: 4, ticketPrice: 105 }),
  ], fleet, 7);
  assert.deepEqual(Object.keys(m), ['LAX-SFO']);
  assert.equal(m['LAX-SFO'].weeklyFrequency, 14);
});

test('fare blends by frequency, not by row count', () => {
  const m = buildPlayerPairMap([
    route({ aircraftId: 't1', weeklyFrequency: 10, ticketPrice: 100 }),
    route({ aircraftId: 't2', weeklyFrequency: 30, ticketPrice: 200 }),
  ], fleet, 7);
  assert.equal(m['LAX-SFO'].ticketPrice, 175);
});

console.log('\n── single aircraft: unchanged behaviour ─────────────────');

test('one route on a pair reads exactly as before', () => {
  const m = buildPlayerPairMap([route({ aircraftId: 't2', weeklyFrequency: 21, ticketPrice: 90 })], fleet, 7);
  const agg = m['LAX-SFO'];
  assert.equal(agg.weeklyFrequency, 21);
  assert.equal(agg.seatsPerWeek, ATR.seats * 21);
  assert.equal(agg.ticketPrice, 90);
  assert.equal(agg.aircraftId, 't2');
});

test('an unassigned route reports null seats rather than zero', () => {
  const m = buildPlayerPairMap([route({ aircraftId: 'gone', weeklyFrequency: 7 })], fleet, 7);
  assert.equal(m['LAX-SFO'].seatsPerWeek, null);
  assert.equal(m['LAX-SFO'].weeklyFrequency, 7);
});

console.log('\n── seasonal schedules ───────────────────────────────────');

test('dormant rows are excluded — a winter schedule is not added to summer', () => {
  const rows = [
    route({ aircraftId: 't1', weeklyFrequency: 14, season: { months: [6, 7, 8] } }),
    route({ aircraftId: 't1', weeklyFrequency: 7,  season: { months: [12, 1, 2] } }),
  ];
  assert.equal(buildPlayerPairMap(rows, fleet, 7)['LAX-SFO'].weeklyFrequency, 14);
  assert.equal(buildPlayerPairMap(rows, fleet, 1)['LAX-SFO'].weeklyFrequency, 7);
});

test('a pair whose every row is dormant still appears (contested list intact)', () => {
  const m = buildPlayerPairMap([
    route({ aircraftId: 't1', weeklyFrequency: 10, season: { months: [6, 7] } }),
  ], fleet, 1);
  assert.ok('LAX-SFO' in m);
});

test('no month given → nothing is filtered out', () => {
  const m = buildPlayerPairMap([
    route({ aircraftId: 't1', weeklyFrequency: 14, season: { months: [6, 7, 8] } }),
    route({ aircraftId: 't1', weeklyFrequency: 7,  season: { months: [12, 1, 2] } }),
  ], fleet, null);
  assert.equal(m['LAX-SFO'].weeklyFrequency, 21);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
