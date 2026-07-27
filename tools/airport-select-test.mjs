// Airport dropdown grouping: hubs/focus cities pinned on top, then real regions.
//
// The old pickers carried a hand-written 20-country REGION_MAP, so ~195 of the
// countries in the airport data (Colombia, Costa Rica, Peru, Chile, …) fell
// through to a giant "Other" bucket. These tests lock in that (a) every country
// in the data resolves to a real region, and (b) the grouping puts the player's
// own bases first and sorts alphabetically inside every group.
//
//   node tools/airport-select-test.mjs

import assert from 'node:assert/strict';
import { AIRPORTS, getRegion, REGIONS } from '../src/data/airports.js';
import { groupAirports, airportOptionLabel } from '../src/utils/airportGroups.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nAirport select grouping\n');

// ── 1. No airport falls off the map ──────────────────────────────────────────

test('every airport in the data resolves to a real region', () => {
  const orphans = [...new Set(
    AIRPORTS.filter(a => !REGIONS.includes(getRegion(a.country))).map(a => a.country),
  )];
  assert.deepEqual(orphans, [], `unmapped countries: ${orphans.join(', ')}`);
});

test('the airports from the bug report land in the Americas, not "Other"', () => {
  assert.equal(getRegion('CO'), 'South America');   // BOG — Bogotá
  assert.equal(getRegion('PE'), 'South America');   // LIM — Lima
  assert.equal(getRegion('CL'), 'South America');   // SCL — Santiago
  assert.equal(getRegion('CR'), 'North America');   // SJO / LIR — Costa Rica
});

// ── 2. Grouping ──────────────────────────────────────────────────────────────

const gates = {
  JFK: 12, LAX: 4, ORD: 6,          // North America
  BOG: 1, LIM: 1, SCL: 1, GRU: 2,   // South America
  SJO: 1, LIR: 1,                   // North America (Central America)
  LHR: 3, CDG: 2,                   // Europe
  NRT: 2,                           // Asia
};
const hubs = {
  JFK: { tier: 3 },   // full hub
  ORD: { tier: 1 },   // full hub
  LAX: { tier: 0 },   // focus city
};
const labels = (gs) => gs.map(g => g.label);
const codes  = (gs, label) => (gs.find(g => g.label === label)?.airports ?? []).map(a => a.code);

test('hubs come first, then focus cities, then regions', () => {
  const g = groupAirports({ gates, hubs });
  assert.deepEqual(labels(g).slice(0, 2), ['Your Hubs', 'Your Focus City']);
  assert.deepEqual(codes(g, 'Your Hubs'), ['ORD', 'JFK']);   // Chicago, New York
  assert.deepEqual(codes(g, 'Your Focus City'), ['LAX']);
});

test('pinned airports are not repeated in their region group', () => {
  const g = groupAirports({ gates, hubs });
  assert.deepEqual(codes(g, 'North America'), ['LIR', 'SJO']);  // Liberia, San Jose
  const all = g.flatMap(x => x.airports.map(a => a.code));
  assert.equal(all.length, new Set(all).size, 'an airport appeared twice');
});

test('regions follow the shared REGIONS order', () => {
  const g = groupAirports({ gates, hubs });
  const regionLabels = labels(g).filter(l => REGIONS.includes(l));
  assert.deepEqual(regionLabels, ['North America', 'South America', 'Europe', 'Asia']);
});

test('airports are alphabetical by city inside a group', () => {
  const g = groupAirports({ gates, hubs });
  const sa = (g.find(x => x.label === 'South America')?.airports ?? []).map(a => a.city);
  assert.deepEqual(sa, [...sa].sort((x, y) => x.localeCompare(y)));
  assert.deepEqual(codes(g, 'South America'), ['BOG', 'LIM', 'SCL', 'GRU']); // Bogotá, Lima, Santiago, São Paulo
});

test('no "Other" group survives', () => {
  const g = groupAirports({ gates, hubs });
  assert.ok(!labels(g).includes('Other'), `got: ${labels(g).join(' | ')}`);
});

test('with no hubs designated it is regions only', () => {
  const g = groupAirports({ gates, hubs: {} });
  assert.deepEqual(labels(g), ['North America', 'South America', 'Europe', 'Asia']);
});

test('a single hub gets the singular label', () => {
  const g = groupAirports({ gates, hubs: { JFK: { tier: 2 } } });
  assert.equal(labels(g)[0], 'Your Hub');
});

test('exclude drops the other end of the route', () => {
  const g = groupAirports({ gates, hubs, exclude: 'JFK' });
  assert.deepEqual(codes(g, 'Your Hub'), ['ORD']);
  assert.ok(!g.flatMap(x => x.airports.map(a => a.code)).includes('JFK'));
});

test('only airports the player holds a gate at are offered', () => {
  const g = groupAirports({ gates: { BOG: 1 }, hubs: {} });
  assert.deepEqual(g.flatMap(x => x.airports.map(a => a.code)), ['BOG']);
});

test('requireGate:false offers the whole world', () => {
  const g = groupAirports({ gates: {}, hubs: {}, requireGate: false });
  assert.equal(g.flatMap(x => x.airports).length, AIRPORTS.length);
});

test('an empty network produces no groups at all', () => {
  assert.deepEqual(groupAirports({ gates: {}, hubs: {} }), []);
});

// ── 3. Option labels ─────────────────────────────────────────────────────────

test('option labels pluralise gates', () => {
  const bog = AIRPORTS.find(a => a.code === 'BOG');
  assert.equal(airportOptionLabel(bog, { BOG: 1 }), 'BOG — Bogotá (1 gate)');
  assert.equal(airportOptionLabel(bog, { BOG: 3 }), 'BOG — Bogotá (3 gates)');
  assert.equal(airportOptionLabel(bog, { BOG: 3 }, false), 'BOG — Bogotá');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
