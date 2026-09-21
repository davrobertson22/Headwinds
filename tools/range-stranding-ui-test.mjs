// range-stranding-ui-test.mjs — the Out of range badge renders on the REAL
// Routes page and the REAL cargo routes list, not just in isolation.
//
// CLAUDE.md: SSR-render the real component. OutOfRangeBadge on its own can
// render perfectly while the list that is meant to show it never mounts it —
// wrong view, wrong row, a filter that hides it. So this renders the two
// production lists inside GameProvider from a seeded save, the way the other
// UI agreement tests do (add-flights-preview-test, cargo-add-freighter-test).
//
// Verified failing on HEAD 29e9be1: HEAD's Routes.jsx, rendered from the same
// seeded save, shows no Out of range marker anywhere.
//
//   node --import ./tools/_register-loader.mjs tools/range-stranding-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import { routeDistanceKm } from '../src/utils/simulation.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { default: Routes } = await import('../src/components/Routes.jsx');
const { default: CargoRoutesList } = await import('../src/components/CargoRoutesList.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const PAX = getAircraftType('a320neo'), FRT = getAircraftType('b767300f');
assert.ok(PAX && FRT, 'fixture types missing');
const flag = (from, to, reach) => ({
  from, to, sectorKm: routeDistanceKm(from, to), rangeKm: reach, since: 200,
});

function save({ pax = false, cargo = false } = {}) {
  return {
    ...freshState(),
    phase: 'playing', week: 20, year: 4, hub: 'JFK', cash: 400_000_000,
    gates: { JFK: 20, LAX: 20, LHR: 20 }, hubs: { JFK: { tier: 2 } },
    fleet: [
      { id: 'p1', typeId: PAX.id, name: 'A320neo #1', tailNumber: 'N320PX', status: 'assigned',
        ageWeeks: 100, ownershipType: 'owned' },
      { id: 'f1', typeId: FRT.id, name: '767-300F #1', tailNumber: 'N767FX', status: 'assigned',
        ageWeeks: 100, ownershipType: 'owned' },
    ],
    routes: [
      { id: 'r1', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'p1',
        weeklyFrequency: 7, weeksOpen: 40, hub: 'JFK', season: null, seasonState: 'active',
        ...(pax ? { rangeStranded: flag('JFK', 'LAX', 2900) } : {}) },
    ],
    cargoRoutes: [
      { id: 'c1', origin: 'JFK', destination: 'LHR', aircraftId: 'f1', weeklyFrequency: 3,
        yieldPrice: 0.4, weeksOpen: 30,
        ...(cargo ? { rangeStranded: flag('JFK', 'LHR', 5000) } : {}) },
    ],
  };
}

const render = (el, s) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
};

console.log('\nOut of range badge on the real route lists\n');

// The Routes page EMBEDS the cargo list, so a flagged cargo route would put an
// "Out of range" badge on this page by itself — the first cut of this test
// passed on HEAD for exactly that reason. Only the passenger route is flagged
// here, and the assertion is on text only the passenger group badge carries.
const PAX_GROUP_BADGE = /can no longer reach one of its legs/;

test('the Routes page marks a passenger route that is out of range', () => {
  const html = render(React.createElement(Routes), save({ pax: true }));
  assert.match(html, PAX_GROUP_BADGE, 'no Out of range marker on the passenger route');
});

test('the Routes page shows no marker when nothing is out of range', () => {
  const html = render(React.createElement(Routes), save());
  assert.doesNotMatch(html, PAX_GROUP_BADGE);
  assert.doesNotMatch(html, /Out of range/);
});

test('the cargo routes list marks a cargo route that is out of range, with the numbers', () => {
  const html = render(React.createElement(CargoRoutesList), save({ cargo: true }));
  assert.match(html, /Out of range/, 'no Out of range marker on the cargo list');
  assert.match(html, /5,000 km/, 'the tooltip should carry the reach, so the player knows the shortfall');
});

test('the cargo routes list shows no marker when nothing is out of range', () => {
  const html = render(React.createElement(CargoRoutesList), save());
  assert.doesNotMatch(html, /Out of range/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
