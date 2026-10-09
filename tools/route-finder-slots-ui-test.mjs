// Gate slots on the Route Finder (Discord, Barca 2026-10-03: "It would be really
// really handy if we could add airport slots from the route finder screen").
//
// SSR-renders the real finder screens. Each passenger and freight row says how
// many weekly slots you have free at the destination, the origin gets one line
// above the table, and anywhere short of a 7/wk route offers "+ Gate".
//
//   node --import ./tools/_register-loader.mjs tools/route-finder-slots-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; } };

const { GameProvider, RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteFinder = (await import('../src/components/RouteFinder.jsx')).default;
const CargoRouteFinder = (await import('../src/components/CargoRouteFinder.jsx')).default;
const { getAircraftType } = await import('../src/data/aircraft.js');
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const plane = { id: 'a1', typeId: NB.id, status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats } };
function seed(over = {}) {
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 4e8,
    gates: { JFK: 1, BOS: 1 }, fleet: [plane], routes: [], cargoRoutes: [], ...over,
  }));
}
// A route burning 46 of JFK's 50 weekly slots.
const busy = { id: 'r1', origin: 'JFK', destination: 'BOS', aircraftId: 'a1', weeklyFrequency: 46, ticketPrice: 200, stops: ['JFK', 'BOS'] };

console.log('\n── Route Finder: slots + add gate ──────────────────────');

test('passenger finder: a "Your slots" column with free slots and + Gate where short', () => {
  seed();
  const html = render(React.createElement(RouteFinder, { standalone: true }));
  assert.ok(html.includes('Your slots'), 'column header');
  assert.ok(html.includes('No gate'), 'destinations without a gate say so');
  assert.ok(/\+ Gate \$[\d.,]+[KM]?\/mo/.test(html), 'compact add-gate button on short rows');
});

test('the origin line shows free slots, and offers a gate when the hub is nearly full', () => {
  seed();
  let html = render(React.createElement(RouteFinder, { standalone: true }));
  assert.ok(html.includes('Slots at JFK: <strong>50</strong> of 50 free each week'), 'free origin line');
  seed({ routes: [busy] });
  html = render(React.createElement(RouteFinder, { standalone: true }));
  assert.ok(html.includes('Slots at JFK: <strong>4</strong> of 50 free each week'), 'busy origin line');
  assert.ok(html.includes('not enough for another 7/wk route'));
  assert.ok(html.includes('+ Add gate ('), 'full-size add-gate button at the origin');
});

test('freight finder gets the same column and origin line', () => {
  seed({ routes: [busy] });
  const html = render(React.createElement(CargoRouteFinder, { standalone: true }));
  assert.ok(html.includes('Your slots'));
  assert.ok(html.includes('Slots at JFK: <strong>4</strong> of 50 free each week'));
});

test('in a scarcity world a refused lease says so in the cell', () => {
  // Headwinds-only state, so mount it the way the multiplayer client does.
  const lockouts = Object.fromEntries(['LAX', 'ORD', 'ATL', 'LHR', 'SFO', 'MIA', 'DFW', 'MCO', 'LAS', 'DEN'].map(c => [c, 9999]));
  const state = { ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 4e8,
    gates: { JFK: 1 }, fleet: [plane], routes: [], cargoRoutes: [], gateScarcityWorld: true, gateLockouts: lockouts };
  const html = renderToString(React.createElement(RemoteGameProvider, { state, dispatch: () => {} },
    React.createElement(RouteFinder, { standalone: true }))).replaceAll('<!-- -->', '');
  assert.ok(html.includes('⛔ can&#x27;t lease here'), 'a locked-out destination explains the disabled button');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
