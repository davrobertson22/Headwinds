// Fare cliff on the Routes page: trim back under it, find the routes past it,
// and see every cabin the cliff can name — SSR-rendered from the real components.
//
// Dunno23 (Discord 2026-10-19, Old Metal):
//   1. "I always price under the fare cliff, but when I come back several routes
//      are above it" — the cliff moves with quality and rivals (models/fareCliff.js
//      faresTrimmedUnderCliff). The banner's only fix was Reset to reference.
//   2. "It tells me my route is priced past the fare cliff even though it's priced
//      at reference" — the banner named IST-LHR (First), but the expanded row was
//      an A321 with no First seats, so its fare editor showed only the cabins
//      that WERE at reference. Fares are per pair; the panel now shows the pair's
//      other cabins.
//   3. VodkaOnFire: "a filter similar to losing / low load / profit".
//
//   node --import ./tools/_register-loader.mjs tools/fare-cliff-trim-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { routePairKey, defaultClassPrices } from '../src/utils/simulation.js';
import { referencePrice } from '../src/utils/market.js';

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
const { default: Routes, PricingPanel } = await import('../src/components/Routes.jsx');

const NARROW = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body' && (t.range ?? 0) > 3000);
const WIDE   = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Wide Body' && (t.range ?? 0) > 8000);
const CODES = ['IST', 'LHR', 'FRA'];
const scaled = (o, d, m) => Object.fromEntries(Object.entries(defaultClassPrices(referencePrice(o, d))).map(([k, v]) => [k, Math.round(v * m)]));

// IST-LHR flown by a narrow-body (no First) and a wide-body with First; the
// pair's First fare is past the cliff, everything else at reference.
function save({ nwr = true, firstMult = 1.5, fraMult = 1.0 } = {}) {
  const ist = scaled('IST', 'LHR', 1);
  return {
    ...freshState(),
    phase: 'playing', week: 20, year: 4, hub: 'IST', cash: 400_000_000,
    newWorldRestrictions: nwr,
    gates: Object.fromEntries(CODES.map(c => [c, 40])),
    hubs: { IST: { tier: 2 } },
    fleet: [
      { id: 'nb', typeId: NARROW.id, name: 'Narrow', status: 'assigned', ageWeeks: 50, ownershipType: 'owned',
        config: { businessClass: 12, premiumEconomy: 24, economy: 90 } },
      { id: 'wb', typeId: WIDE.id, name: 'Wide', status: 'assigned', ageWeeks: 50, ownershipType: 'owned',
        config: { firstClass: 8, businessClass: 30, economy: 200 } },
      { id: 'nb2', typeId: NARROW.id, name: 'Narrow 2', status: 'assigned', ageWeeks: 50, ownershipType: 'owned',
        config: { economy: 150 } },
    ],
    routes: [
      { id: 'r1', origin: 'IST', destination: 'LHR', stops: ['IST', 'LHR'], aircraftId: 'nb', weeklyFrequency: 7, weeksOpen: 30, hub: 'IST', season: null, seasonState: 'active' },
      { id: 'r2', origin: 'IST', destination: 'LHR', stops: ['IST', 'LHR'], aircraftId: 'wb', weeklyFrequency: 3, weeksOpen: 30, hub: 'IST', season: null, seasonState: 'active' },
      { id: 'r3', origin: 'IST', destination: 'FRA', stops: ['IST', 'FRA'], aircraftId: 'nb2', weeklyFrequency: 7, weeksOpen: 30, hub: 'IST', season: null, seasonState: 'active' },
    ],
    routePricing: {
      [routePairKey('IST', 'LHR')]: { ...ist, firstClass: Math.round(ist.firstClass * firstMult) },
      [routePairKey('IST', 'FRA')]: scaled('IST', 'FRA', fraMult),
    },
    cargoRoutes: [],
  };
}
const strip = (h) => h.replace(/<!-- -->/g, '');
const renderIn = (s, el) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return strip(renderToString(React.createElement(GameProvider, null, el)));
};
const renderRoutes = (s) => renderIn(s, React.createElement(Routes));
const renderPanel = (s, routeId) => {
  const route = { ...s.routes.find(r => r.id === routeId) };
  route.classPrices = s.routePricing[routePairKey(route.origin, route.destination)];
  const aircraft = s.fleet.find(a => a.id === route.aircraftId);
  return renderIn(s, React.createElement(PricingPanel, { route, aircraft, type: AIRCRAFT_TYPES.find(t => t.id === aircraft.typeId) }));
};

console.log('\n── Banner: trim, not just reset ────────');
test('over-cliff pair: banner offers the trim, the filter and the reset', () => {
  const html = renderRoutes(save());
  // Losing-passengers (red) or still-full (amber) banner: which one depends on
  // the projection's load read, which is not deterministic run to run. Both
  // name the cabin and offer trim, filter and reset.
  assert.match(html, /fare cliff/);
  assert.match(html, /IST–LHR \(First\)/);
  assert.match(html, /Trim (it|all \d+) under the cliff|Trim (it|these)/);
  assert.match(html, /Reset (to reference|it|these)/);
  assert.match(html, /Show them/);
});

console.log('\n── "Past cliff" filter tab ─────────────');
test('shown, with its count, when a pair is past the cliff', () => {
  const html = renderRoutes(save({ fraMult: 1.5 }));
  assert.match(html, /Past cliff<\/span><span[^>]*>2<\/span>/);
});
test('hidden when nothing is past the cliff', () => {
  const html = renderRoutes(save({ firstMult: 1 }));
  assert.doesNotMatch(html, /Past cliff/);
});
test('hidden in a classic world (no cliff there)', () => {
  const html = renderRoutes(save({ nwr: false }));
  assert.doesNotMatch(html, /Past cliff/);
});

console.log('\n── Pricing panel shows the pair\'s cabins ─');
test('the narrow-body row shows First (other aircraft) and flags it past the cliff', () => {
  const html = renderPanel(save(), 'r1');
  assert.match(html, /First/);
  assert.match(html, /\(other aircraft\)/);
  assert.match(html, /past the cliff \(\$\d+\)/);
});
test('its own cabins keep their seat counts', () => {
  const html = renderPanel(save(), 'r1');
  assert.match(html, /\(12 seats\)/);
  assert.match(html, /\(90 seats\)/);
});
test('the wide-body row shows Prem Eco from the narrow-body, and its own First with seats', () => {
  const html = renderPanel(save(), 'r2');
  assert.match(html, /\(8 seats\)/);
  assert.match(html, /Premium Eco[\s\S]{0,400}\(other aircraft\)/);
});
test('a pair flown by one aircraft shows only its own cabins', () => {
  const html = renderPanel(save(), 'r3');
  assert.doesNotMatch(html, /other aircraft/);
  assert.doesNotMatch(html, />First</);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
