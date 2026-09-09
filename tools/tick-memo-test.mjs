// The weekly tick's three caches must be invisible.
//
// A player's 1991 save (Discord, 2026-09-08: 279 routes, 160 aircraft) took
// over a second a week to tick. Profiling put 82% of that in two pure
// functions being asked the same questions over and over:
//
//   * getAirport() was a linear find over ~2,400 records, and
//     baseCityPairDemand() calls it four times per pair;
//   * baseCityPairDemand() re-derived the same gravity model per pair, and
//     buildOwnMetalConnections() asks about EVERY pair of spokes at every hub —
//     ~38,000 calls a week for one 279-spoke hub;
//   * scaleBySeats() rebuilt and re-sorted its knot array on every airframe,
//     from both HQ overhead and crew pay.
//
// All three now cache. Caching a function that is not actually pure is how you
// freeze a growing market or serve a stale airport, so this file asserts the
// only thing that matters: the cached answer is the answer.
//
//   node --import ./tools/_register-loader.mjs tools/tick-memo-test.mjs

import assert from 'node:assert/strict';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }

const { AIRPORTS, getAirport } = await import('../packages/engine/src/data/airports.js');
const { baseCityPairDemand, clearPairDemandMemo } = await import('../packages/engine/src/utils/market.js');
const { scaleBySeats, CATEGORY_MEDIAN_SEATS } = await import('../packages/engine/src/data/overhead.js');

section('getAirport index === linear find');

test('every code in the catalogue resolves to the same record object', () => {
  for (const a of AIRPORTS) {
    assert.equal(getAirport(a.code), AIRPORTS.find(x => x.code === a.code),
      `getAirport('${a.code}') did not return the record find() returns`);
  }
});

test('an unknown code is undefined, as find() returns', () => {
  assert.equal(getAirport('ZZZZ'), undefined);
  assert.equal(getAirport(''), undefined);
  assert.equal(getAirport(undefined), undefined);
});

section('baseCityPairDemand memo === fresh computation');

// A spread wide enough to cover the branches: same-metro, surface-linked,
// domestic, international, island-captive, regional, and unknown codes.
const PAIRS = [
  ['JFK', 'LAX'], ['JFK', 'LHR'], ['LGW', 'LHR'], ['EWR', 'LGW'],
  ['GMP', 'CJU'], ['HND', 'CTS'], ['JED', 'RUH'], ['SGN', 'HAN'],
  ['ORD', 'LGA'], ['SIN', 'LHR'], ['DAC', 'DEL'], ['SFO', 'OAK'],
  ['CDG', 'ORY'], ['YYG', 'YQI'], ['JFK', 'ZZZZ'], ['ZZZZ', 'YYYY'],
];

test('cold and warm reads agree on every pair', () => {
  clearPairDemandMemo();
  const cold = PAIRS.map(([o, d]) => baseCityPairDemand(o, d));
  const warm = PAIRS.map(([o, d]) => baseCityPairDemand(o, d));
  assert.deepEqual(warm, cold);
  // And again after a wipe: the cache is not the source of truth.
  clearPairDemandMemo();
  assert.deepEqual(PAIRS.map(([o, d]) => baseCityPairDemand(o, d)), cold);
});

test('the memo is symmetric, and was symmetric before it existed', () => {
  for (const [o, d] of PAIRS) {
    clearPairDemandMemo();
    const forward = baseCityPairDemand(o, d);
    clearPairDemandMemo();
    const reverse = baseCityPairDemand(d, o);
    assert.equal(reverse, forward, `${o}-${d} is not symmetric — one memo key cannot serve both`);
    // Warm, through the shared key.
    assert.equal(baseCityPairDemand(o, d), forward);
  }
});

test('a broad sweep of real pairs survives a round trip through the cache', () => {
  const codes = AIRPORTS.slice(0, 120).map(a => a.code);
  clearPairDemandMemo();
  const fresh = [];
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      fresh.push(baseCityPairDemand(codes[i], codes[j]));
      clearPairDemandMemo();     // every reading above is a cold one
    }
  }
  let k = 0;
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      assert.equal(baseCityPairDemand(codes[i], codes[j]), fresh[k++],
        `${codes[i]}-${codes[j]} changed once cached`);
    }
  }
});

section('scaleBySeats curve === the array it used to rebuild');

// The pre-cache body, verbatim, as the oracle.
function scaleBySeatsOriginal(byCategory, seats) {
  const n = Number(seats);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pts = Object.entries(CATEGORY_MEDIAN_SEATS)
    .map(([cat, s]) => [s, byCategory?.[cat]])
    .filter(([, v]) => typeof v === 'number')
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  if (n <= pts[0][0]) return pts[0][1];
  if (n >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [s0, v0] = pts[i - 1], [s1, v1] = pts[i];
    if (n <= s1) return v0 + (v1 - v0) * ((n - s0) / (s1 - s0));
  }
  return pts[pts.length - 1][1];
}

const TABLES = [
  { 'Turboprop': 1, 'Regional Jet': 2, 'Narrow Body': 3, 'Wide Body': 5, 'Double Deck': 7 },
  { 'Air Taxi': 0.2, 'Commuter': 0.5, 'Turboprop': 1, 'Narrow Body': 3, 'Double Deck': 8 },
  { 'Narrow Body': 3 },                      // single knot — clamps both ways
  { 'Regional Jet': 'not a number' },        // filtered out entirely
  {},                                        // no knots at all
];
const SEATS = [-5, 0, 1, 9, 19, 20, 39, 92, 100, 186, 300, 420, 605, 853, 5000, NaN, undefined, '186'];

test('every table x every seat count matches the original, cold and warm', () => {
  for (const table of TABLES) {
    for (const s of SEATS) {
      const want = scaleBySeatsOriginal(table, s);
      assert.deepEqual(scaleBySeats(table, s), want, `first read: ${JSON.stringify(table)} @ ${s}`);
      assert.deepEqual(scaleBySeats(table, s), want, `cached read: ${JSON.stringify(table)} @ ${s}`);
    }
  }
});

test('a null table still returns null rather than throwing', () => {
  assert.equal(scaleBySeats(null, 186), null);
  assert.equal(scaleBySeats(undefined, 186), null);
});

test('two tables do not share a cache entry', () => {
  const a = { 'Narrow Body': 3 };
  const b = { 'Narrow Body': 99 };
  assert.equal(scaleBySeats(a, 186), 3);
  assert.equal(scaleBySeats(b, 186), 99);
  assert.equal(scaleBySeats(a, 186), 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
