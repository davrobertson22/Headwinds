// React render smoke test for the multi-stop UI.
//
// Server-renders the REAL components (no mocks) via a JSX loader, with a seeded
// save that already contains a tag route — so TagRouteCard runs simulateTagRoute
// end-to-end inside React. Catches render-time crashes the node suites can't:
// bad hook usage, undefined refs, prop/JSX mistakes, integration breaks.
//
//   node --import ./tools/_register-loader.mjs tools/ui-smoke-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { transformJsx } from './_jsx-loader.mjs';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { routeSegments, routeSegmentKey, referencePrice } from '../src/utils/simulation.js';

// Minimal browser shims for SSR (effects don't run, but init reads localStorage).
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
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

console.log('\n── 0. JSX transform self-check ──────────────────────────');
test('transformJsx emits React.createElement', () => {
  const out = transformJsx('const x = <div className="a">{y}<b/>hi</div>;', 'x.jsx');
  assert.ok(out.includes('React.createElement'), 'expected createElement calls');
  assert.ok(out.includes('"a"') && out.includes('hi'), 'props + text preserved');
});

const jet   = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const major = ['JFK', 'ORD', 'LAX'].filter(c => getAirport(c));
const [P, Q, R] = major;

const sp = {};
for (const g of routeSegments({ stops: [P, Q, R], origin: P, destination: R })) {
  const e = Math.round(referencePrice(g.from, g.to));
  sp[routeSegmentKey(g.from, g.to)] = { economy: e, businessClass: Math.round(e * 2.5) };
}

// Dynamic imports so the loader (registered via --import) is active first.
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Routes        = (await import('../src/components/Routes.jsx')).default;
const RoutePlanner  = (await import('../src/components/RoutePlanner.jsx')).default;
const TagRoutePlanner = (await import('../src/components/TagRoutePlanner.jsx')).default;
const RouteDetail   = (await import('../src/components/RouteDetail.jsx')).default;
const Wiki          = (await import('../src/components/Wiki.jsx')).default;

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: P, cash: 5_000_000,
  gates: { [P]: 8, [Q]: 8, [R]: 8 },
  fleet: [
    { id: 'ac1', typeId: jet.id, name: 'Spirit of Test', tailNumber: 'N1TEST', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
    { id: 'ac2', typeId: jet.id, name: 'Seasonal Flyer', tailNumber: 'N2TEST', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
  ],
  routes: [
    { id: 'tg', origin: P, destination: R, stops: [P, Q, R], aircraftId: 'ac1', weeklyFrequency: 5, weeksOpen: 20, hub: P, segmentPrices: sp, cateringLevel: 'full' },
    // Summer-only route; the save is at week 20 (May) so it is DORMANT now.
    { id: 'seas', origin: P, destination: Q, stops: [P, Q], aircraftId: 'ac2', weeklyFrequency: 5, weeksOpen: 20, hub: P, ticketPrice: 320, cateringLevel: 'full', season: { months: [6, 7, 8, 9] }, seasonState: 'dormant' },
  ],
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (el) => renderToString(React.createElement(GameProvider, null, el));

console.log('\n── 1. Routes list renders a tag route (TagRouteCard) ─────');
test('Routes page renders the Multi-stop section with the tag route', () => {
  const html = render(React.createElement(Routes));
  assert.ok(html.includes('Multi-stop'), 'multi-stop section header present');
  assert.ok(html.includes(P) && html.includes(Q) && html.includes(R), 'all three stops shown');
});

console.log('\n── 2. Planner renders, incl. the Multi-stop mode toggle ──');
test('RoutePlanner (passenger) renders with the Multi-stop toggle option', () => {
  const html = render(React.createElement(RoutePlanner));
  assert.ok(html.includes('Multi-stop'), 'mode toggle shows Multi-stop');
});

test('TagRoutePlanner renders in tag mode without throwing', () => {
  const html = render(React.createElement(TagRoutePlanner, { mode: 'tag', setMode: () => {} }));
  assert.ok(html.includes('Multi-stop route'), 'stops builder heading present');
  assert.ok(html.includes('Add stop'), 'add-stop control present');
});

console.log('\n── 3. Wiki documents multi-stop routing ─────────────────');
test('Wiki renders and registers the Multi-stop Routes help section', () => {
  // The Wiki renders only the active section's body; the table of contents lists
  // every section title, so the new entry shows there once it's wired in.
  const html = renderToString(React.createElement(Wiki));
  assert.ok(html.includes('Multi-stop Routes'), 'multi-stop help section listed');
});

console.log('\n── 4. Seasonal flights surface in the UI ────────────────');
test('Routes list shows a Dormant badge for an out-of-season route', () => {
  const html = render(React.createElement(Routes));
  assert.ok(html.includes('Dormant'), 'dormant badge rendered for the summer route in May');
});

test('RouteDetail renders a dormancy notice for an out-of-season route', () => {
  const html = render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} }));
  assert.ok(html.includes('Dormant') || html.includes('Out of season'), 'dormancy notice present');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
