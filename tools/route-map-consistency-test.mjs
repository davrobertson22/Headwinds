// Network map ↔ Finance agreement.
//
// The Network tab's map + "ALL ROUTES" table used to run its OWN bare
// simulateRoute(route, aircraft, gameDate) — no labor, no fuel multiplier, no
// encroachment / human-rival challengers, no fleet utilisation, no satisfaction,
// no live events, and (cargo) no shared-lane demand pool. On a contested trunk
// route that means the map hands the player the ENTIRE demand pool: every busy
// route pins at a 100% load factor with an inflated profit, while Dashboard ▸ Top
// Routes and Finance ▸ By Route — which both read the canonical projectWeek pass
// — correctly show ~87%. Same airline, same week, three different numbers.
//
// This suite renders the REAL component (SSR, no mocks) and asserts every load
// factor and profit in its table matches the engine projection cell for cell.
//
//   node --import ./tools/_register-loader.mjs tools/route-map-consistency-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice, routePairKey, formatMoney } from '../src/utils/simulation.js';

// Minimal browser shims for SSR (effects don't run; init reads localStorage).
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
const { projectWeek } = await import('../src/utils/financeProjection.js');
const RouteMap = (await import('../src/components/RouteMap.jsx')).default;

// ── Fixture ───────────────────────────────────────────────────────────────────
// One hub, three spokes, a jet with enough range for all of them. Two of the
// three pairs are contested by a human rival (Headwinds) big enough to take a
// real bite of the pool, so the engine's load factor lands well under 100% —
// which is exactly the number the old map could not see.

const jet = AIRCRAFT_TYPES
  .filter(t => !t.freighter && t.seats >= 140 && t.seats <= 240)
  .sort((a, b) => b.range - a.range)[0];
assert.ok(jet, 'fixture needs a narrowbody');

const FREQ = 16;   // enough capacity that a contested pool cannot fill it
const HUB = 'SFO';
const SPOKES = ['ORD', 'JFK', 'DEN'].filter(c => getAirport(c));
assert.equal(SPOKES.length, 3, 'fixture airports exist in the engine data');
assert.ok(getAirport(HUB), 'hub exists');

const routes = SPOKES.map((dest, i) => ({
  id: `r${i}`,
  origin: HUB,
  destination: dest,
  aircraftId: `ac${i}`,
  weeklyFrequency: FREQ,
  weeksOpen: 40,
  hub: HUB,
  ticketPrice: Math.round(referencePrice(HUB, dest)),
  cateringLevel: 'full',
}));

const fleet = SPOKES.map((_, i) => ({
  id: `ac${i}`,
  typeId: jet.id,
  name: `Test ${i}`,
  tailNumber: `N${i}TEST`,
  status: 'assigned',
  ageWeeks: 52,
  ownershipType: 'owned',
  config: { economy: jet.seats },
}));

// Human rivals on the first TWO pairs only — the third stays a monopoly, so the
// suite also proves the fix doesn't move uncontested routes.
const humanRivals = {};
for (const dest of SPOKES.slice(0, 2)) {
  humanRivals[routePairKey(HUB, dest)] = [{
    competitorId: 'rival-1',
    name: 'Rival Air',
    tier: 'full',
    qualityScore: 72,
    economyFare: Math.round(referencePrice(HUB, dest) * 0.95),
    frequency: 21,
    seatsPerFlight: jet.seats,
    homeHub: dest,
  }];
}

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: HUB, cash: 20_000_000,
  gates: { [HUB]: 12, ...Object.fromEntries(SPOKES.map(c => [c, 8])) },
  fleet,
  routes,
  humanRivals,
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (el) => renderToString(React.createElement(GameProvider, null, el));

// ── Engine truth ──────────────────────────────────────────────────────────────
const proj = projectWeek(save);
const rr = {};
for (const r of proj.report?.routeResults ?? []) rr[r.routeId] = r;

console.log('\n── 0. Fixture sanity ────────────────────────────────────');

test('the engine simulates every fixture route', () => {
  for (const r of routes) assert.ok(rr[r.id], `engine has a result for ${r.id}`);
});

test('contested routes are NOT at a 100% load factor', () => {
  for (const r of routes.slice(0, 2)) {
    assert.ok(rr[r.id].loadFactor < 0.99,
      `${r.origin}-${r.destination} contested LF should be under 99%, got ${(rr[r.id].loadFactor * 100).toFixed(1)}%`);
  }
});

test('the uncontested route DOES still fill (the fixture isolates the rival)', () => {
  const solo = routes[2];
  assert.ok(rr[solo.id].loadFactor > 0.99,
    `${solo.origin}-${solo.destination} is a monopoly and should still run full, got ${(rr[solo.id].loadFactor * 100).toFixed(1)}%`);
});

console.log('\n── 1. The map table agrees with the engine ──────────────');

// The table renders one row per city pair: "<pct>%" for load and a formatted
// profit. Pull every load% the component printed, in row order.
function renderedLoadPercents() {
  // React SSR splits interpolated text with <!-- --> markers; strip them so the
  // cells read as plain "SFO → JFK" / "87%".
  const html = render(React.createElement(RouteMap)).replaceAll('<!-- -->', '');
  assert.ok(html.includes('ALL ROUTES') || html.includes('Load'), 'route table rendered');
  // One entry per data row: the "SFO → ORD" pair cell and that row's load
  // percentage (the only bare integer percent in the row).
  const rows = html.split('<tr').slice(1);
  const out = [];
  for (const row of rows) {
    const pair = row.match(/<strong>([A-Z]{3}) → ([A-Z]{3})<\/strong>/);
    const pct  = row.match(/>(\d{1,3})%</);
    if (pair && pct) out.push({ pair: [pair[1], pair[2]].sort().join('~'), pct: Number(pct[1]) });
  }
  return out;
}

test('every load factor in the map table matches the engine to the printed digit', () => {
  const shown = renderedLoadPercents();
  assert.ok(shown.length >= routes.length, `expected ${routes.length} data rows, saw ${shown.length}`);
  for (const r of routes) {
    const key = [r.origin, r.destination].sort().join('~');
    const row = shown.find(s => s.pair === key);
    assert.ok(row, `map table has a row for ${key}`);
    const expected = Math.round(rr[r.id].loadFactor * 100);
    assert.equal(row.pct, expected,
      `${key}: map shows ${row.pct}%, engine says ${expected}%`);
  }
});

test('no contested route is displayed at 100%', () => {
  const shown = renderedLoadPercents();
  for (const r of routes.slice(0, 2)) {
    const key = [r.origin, r.destination].sort().join('~');
    const row = shown.find(s => s.pair === key);
    assert.ok(row.pct < 100, `${key} rendered at ${row.pct}% — the map is ignoring the rival again`);
  }
});

test('and the uncontested route is still shown at 100% (no over-correction)', () => {
  const solo = routes[2];
  const key = [solo.origin, solo.destination].sort().join('~');
  const row = renderedLoadPercents().find(s => s.pair === key);
  assert.equal(row.pct, 100, `${key} should still read 100% on the map, got ${row.pct}%`);
});

console.log('\n── 2. Profit agrees too (same root cause) ───────────────');

test('the map does not overstate profit on contested routes', () => {
  const html = render(React.createElement(RouteMap)).replaceAll('<!-- -->', '');
  // Each route's engine profit, formatted the way the table formats it, must
  // appear in the rendered output.
  for (const r of routes) {
    const want = formatMoney(rr[r.id].profit);
    assert.ok(html.includes(want),
      `${r.origin}-${r.destination}: expected the engine's ${want} in the table`);
  }
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
