// A freight lane you already fly can take a SECOND freighter from the routes page.
//
//   node --import ./tools/_register-loader.mjs tools/cargo-add-freighter-test.mjs
//
// Reported by Knightmare (Discord, 2026-08-26): "Same request for cargo routes,
// to edit route information, prices, aircraft trips, and add more aircraft from
// the routes page — currently cannot add additional aircraft."
//
// Flights/wk and yield were already editable inline; adding metal was not. Once
// the one freighter on the lane hits its block-hour ceiling the stepper stops,
// and the lane is full with no way forward that does not involve leaving the
// screen. This renders the REAL list and the REAL planner: the control has to
// exist on the row AND the planner it opens has to land on that lane.

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
// Cards view — the table renders its controls only in an expanded row, and SSR
// cannot click. Same controls component either way (CargoRouteControls).
globalThis.window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
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

const freighter = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => b.range - a.range)[0];
assert.ok(freighter, 'no freighter in the aircraft data');
const [O, D] = ['JFK', 'LAX'];
for (const c of [O, D]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const CargoRoutesList   = (await import('../src/components/CargoRoutesList.jsx')).default;
const CargoRoutePlanner = (await import('../src/components/CargoRoutePlanner.jsx')).default;

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: O, cash: 500_000_000,
  gates: { [O]: 8, [D]: 8 },
  fleet: [
    { id: 'f1', typeId: freighter.id, name: 'Heavy One', tailNumber: 'NF1', status: 'assigned', ageWeeks: 52, ownershipType: 'owned' },
    { id: 'f2', typeId: freighter.id, name: 'Heavy Two', tailNumber: 'NF2', status: 'idle', ageWeeks: 52, ownershipType: 'owned' },
  ],
  routes: [],
  cargoRoutes: [
    { id: 'c1', origin: O, destination: D, aircraftId: 'f1', weeklyFrequency: 4, yieldPrice: 0.42, weeksOpen: 20 },
  ],
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');

console.log('\n── 1. The lane offers a second freighter ─────────────────');

test('the freight list renders its inline controls', () => {
  const html = render(React.createElement(CargoRoutesList, { onAddFreighter: () => {} }));
  assert.ok(html.includes('Flights/wk'), 'frequency control missing — the fixture is not reaching the card');
  assert.ok(html.includes('Yield'), 'yield control missing');
  assert.match(html, /Add Freighter/, 'no way to add a second freighter to a lane you already fly');
});

test('an embedder with no planner to open gets no dead button', () => {
  const html = render(React.createElement(CargoRoutesList));
  assert.ok(!/Add Freighter/.test(html),
    'the control renders without a handler — clicking it would do nothing');
});

console.log('\n── 2. The planner lands on that lane ─────────────────────');

test('initialOrigin / initialDest preload the freight planner', () => {
  const html = render(React.createElement(CargoRoutePlanner, {
    embedded: true, initialOrigin: O, initialDest: D, onOpened: () => {},
  }));
  assert.ok(html.includes(O) && html.includes(D), 'the lane did not reach the planner');
  // With both airports set the planner is past its empty state and quoting the lane.
  assert.ok(!/Select two airports/i.test(html), 'planner still on its empty state — prefill did not take');
});

test('a blank freight planner is unchanged', () => {
  const html = render(React.createElement(CargoRoutePlanner, { embedded: true }));
  // Not "it rendered something" — it has to render the EMPTY state, with no
  // lane picked, or the prefill default has leaked into the normal planner.
  assert.match(html, /Select two airports/i,
    'the blank planner is no longer on its empty state — a default lane leaked in');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
