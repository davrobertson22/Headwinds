// Multi-stop routes get the same in-place controls a single-leg pair has:
// a weekly-frequency stepper and a way to put a second aircraft on the rotation.
//
//   node --import ./tools/_register-loader.mjs tools/multileg-controls-test.mjs
//
// Reported by Knightmare (Discord, 2026-08-26): "I have several other multi leg
// routes, and they are all full. On a single leg route, you can add more weekly
// round trips and more aircraft to that route from the routes page, but not for
// multi leg routes."
//
// TagRouteCard rendered the frequency as a static purple chip and offered
// nothing but Remove, so a full rotation was a dead end — the only way to grow
// it was to close it and rebuild it in the planner.
//
// SSR-renders the REAL components (per CLAUDE.md): a helper that returns the
// right markup while the component that mounts it does not is exactly the class
// of bug this repo has been bitten by.

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { routeSegments, routeSegmentKey, referencePrice } from '../src/utils/simulation.js';

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

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const [P, Q, R] = ['JFK', 'ORD', 'LAX'];
for (const c of [P, Q, R]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const sp = {};
for (const g of routeSegments({ stops: [P, Q, R], origin: P, destination: R })) {
  const e = Math.round(referencePrice(g.from, g.to));
  sp[routeSegmentKey(g.from, g.to)] = { economy: e, businessClass: Math.round(e * 2.5) };
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Routes          = (await import('../src/components/Routes.jsx')).default;
const TagRoutePlanner = (await import('../src/components/TagRoutePlanner.jsx')).default;

const tail = (id, name, extra = {}) => ({
  id, typeId: jet.id, name, tailNumber: `N${id}`, status: 'assigned',
  ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats }, ...extra,
});

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: P, cash: 500_000_000,
  gates: { [P]: 8, [Q]: 8, [R]: 8 },
  fleet: [tail('ac1', 'Rotation One'), tail('ac2', 'Spare Metal', { status: 'idle' })],
  routes: [
    { id: 'tg', origin: P, destination: R, stops: [P, Q, R], aircraftId: 'ac1',
      weeklyFrequency: 5, weeksOpen: 20, hub: P, segmentPrices: sp, cateringLevel: 'full' },
  ],
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');

console.log('\n── 1. The rotation card carries both controls ────────────');

let html;
test('the multi-stop card renders (otherwise everything below is vacuous)', () => {
  html = render(React.createElement(Routes));
  assert.ok(html.includes('Multi-stop'), 'multi-stop section header present');
  assert.ok(html.includes(P) && html.includes(Q) && html.includes(R), 'the whole chain is shown');
});

test('it offers a way to add an aircraft to the rotation', () => {
  assert.match(html, /Add Aircraft/,
    'no add-aircraft affordance on a multi-stop route — a full rotation is a dead end again');
});

test('weekly frequency is a stepper, not a read-only chip', () => {
  // The stepper's title text is the tell: the static chip had none.
  assert.match(html, /One more flight per week|One fewer flight per week/,
    'frequency is still static on a multi-stop route');
});

console.log('\n── 2. The prefilled planner locks the chain ──────────────');

test('initialStops renders the rotation and hides the stops builder', () => {
  const h = render(React.createElement(TagRoutePlanner, {
    embedded: true, initialStops: [P, Q, R], onOpened: () => {},
  }));
  assert.ok(h.includes('Add an aircraft to this rotation'), 'locked-chain heading missing');
  assert.ok(!h.includes('Add stop'), 'stops builder should be hidden when the chain is fixed');
  assert.ok(!h.includes('Multi-stop route'), 'free-form planner heading should not render');
  for (const c of [P, Q, R]) assert.ok(h.includes(c), `${c} missing from the locked chain`);
});

test('the free-form planner is untouched', () => {
  const h = render(React.createElement(TagRoutePlanner, { mode: 'tag', setMode: () => {} }));
  assert.ok(h.includes('Multi-stop route'), 'stops builder heading present');
  assert.ok(h.includes('Add stop'), 'add-stop control present');
});

test('initialFares seed the segment fare inputs', () => {
  const segKey = routeSegmentKey(P, R);
  const h = render(React.createElement(TagRoutePlanner, {
    embedded: true, initialStops: [P, Q, R], initialFares: { [segKey]: 999 }, onOpened: () => {},
  }));
  assert.ok(h.includes('999'),
    'the fares the rotation already sells did not reach the planner — a second tail would undercut the first');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
