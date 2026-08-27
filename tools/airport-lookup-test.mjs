// The Airports tab can look up ANY airport in the world, not just the region
// you happen to be browsing.
//
//   node --import ./tools/_register-loader.mjs tools/airport-lookup-test.mjs
//
// Requested by Knightmare (Discord, 2026-08-26): "in airports tab, a search
// feature so you can look up any airport in the world and see its information,
// without having to go to the route finder or gates tab."
//
// There WAS a search box — buried in the "Expand to More Airports" section and
// filtered to the selected region, so finding HNL meant knowing it was in
// Oceania first. This covers the ranking (pure) and the fact that the box
// actually renders at the top of the tab (SSR, real component).

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRPORTS, getAirport } from '../src/data/airports.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AirportsMod = await import('../src/components/Airports.jsx');
const Airports = AirportsMod.default;
const { searchAirports } = AirportsMod;

console.log('\n── 1. Ranking ───────────────────────────────────────────');

test('an exact IATA code comes first', () => {
  const hits = searchAirports('hnl');
  assert.ok(hits.length > 0, 'no results for a real airport code');
  assert.equal(hits[0].code, 'HNL');
});

test('it reaches airports in every region, not just one', () => {
  for (const code of ['HNL', 'NRT', 'GRU', 'JNB', 'DXB', 'SYD']) {
    if (!getAirport(code)) continue;
    assert.equal(searchAirports(code)[0]?.code, code, `${code} not reachable by code`);
  }
});

test('city names match', () => {
  const hits = searchAirports('honolulu');
  assert.ok(hits.some(a => a.code === 'HNL'), 'searching the city did not find the airport');
});

test('country names match', () => {
  const jp = AIRPORTS.filter(a => a.country === 'JP');
  if (jp.length === 0) return;
  const hits = searchAirports('japan', { limit: 50 });
  assert.ok(hits.some(a => a.country === 'JP'), 'searching a country name found none of its airports');
});

test('a one-character query returns nothing (it would match half the world)', () => {
  assert.deepEqual(searchAirports('a'), []);
  assert.deepEqual(searchAirports(''), []);
  assert.deepEqual(searchAirports(null), []);
});

test('results are capped', () => {
  // Assert the cap BITES: an empty result set satisfies "<= 3" for free.
  const wide = searchAirports('an', { limit: 500 });
  assert.ok(wide.length > 3, `"an" should match plenty of airports, matched ${wide.length}`);
  assert.equal(searchAirports('an', { limit: 3 }).length, 3);
  assert.equal(searchAirports('an', { limit: 10 }).length, 10);
  assert.deepEqual(searchAirports('an', { limit: 3 }).map(a => a.code), wide.slice(0, 3).map(a => a.code),
    'the cap should take the top of the ranking, not an arbitrary slice');
});

test('an airport you hold outranks one you do not, at the same match quality', () => {
  const fake = [
    { code: 'AAA', city: 'Alpha', name: 'Alpha Intl', country: 'US', tier: 'major', population: 1_000_000 },
    { code: 'AAB', city: 'Alpha', name: 'Alpha North', country: 'US', tier: 'major', population: 9_000_000 },
  ];
  const held = searchAirports('alpha', { airports: fake, gates: { AAA: 2 } });
  assert.equal(held[0].code, 'AAA', 'the airport you hold a gate at should come first');
  const none = searchAirports('alpha', { airports: fake, gates: {} });
  assert.equal(none[0].code, 'AAB', 'with nothing held, the bigger airport should come first');
});

console.log('\n── 2. It renders at the top of the tab ──────────────────');

test('the Airports tab shows the lookup box before any region is chosen', () => {
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 1, hub: 'JFK', cash: 10_000_000,
    gates: { JFK: 2 }, fleet: [], routes: [], cargoRoutes: [],
  }));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(Airports)));
  assert.match(html, /Find any airport/,
    'no global lookup on the Airports tab — the only search is still the region-scoped one');
  // The region picker is still the browse entry point; the lookup sits above it.
  assert.ok(html.includes('Select a region to browse airports'), 'region browse should be unchanged');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
