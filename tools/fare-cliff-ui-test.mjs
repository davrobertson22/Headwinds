// The fare cliff must be visible where the player prices — SSR-rendered from
// the real components, in a restricted (NWR) world and a classic one.
//
// Regression for 2026-09-24 (Piston Age): a bulk +50% put every route past the
// NWR yield choke with no warning and no bulk way back. See models/fareCliff.js.
//
//   node --import ./tools/_register-loader.mjs tools/fare-cliff-ui-test.mjs
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
const { default: Routes } = await import('../src/components/Routes.jsx');
const { default: FareEditor } = await import('../src/components/FareEditor.jsx');

const JET = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body' && (t.range ?? 0) > 3000);
const CODES = ['SFO', 'LAX', 'SEA'];
const hike = (o, d, m) => Object.fromEntries(Object.entries(defaultClassPrices(referencePrice(o, d))).map(([k, v]) => [k, Math.round(v * m)]));

function save({ nwr, mult }) {
  return {
    ...freshState(),
    phase: 'playing', week: 20, year: 4, hub: 'SFO', cash: 400_000_000,
    newWorldRestrictions: nwr,
    gates: Object.fromEntries(CODES.map(c => [c, 40])),
    hubs: { SFO: { tier: 2 } },
    fleet: [
      { id: 'ac1', typeId: JET.id, name: 'A', status: 'assigned', ageWeeks: 50, ownershipType: 'owned', config: { economy: 150 } },
      { id: 'ac2', typeId: JET.id, name: 'B', status: 'assigned', ageWeeks: 50, ownershipType: 'owned', config: { economy: 150 } },
    ],
    routes: [
      { id: 'r1', origin: 'SFO', destination: 'LAX', stops: ['SFO', 'LAX'], aircraftId: 'ac1', weeklyFrequency: 7, weeksOpen: 30, hub: 'SFO', season: null, seasonState: 'active' },
      { id: 'r2', origin: 'SFO', destination: 'SEA', stops: ['SFO', 'SEA'], aircraftId: 'ac2', weeklyFrequency: 7, weeksOpen: 30, hub: 'SFO', season: null, seasonState: 'active' },
    ],
    routePricing: {
      [routePairKey('SFO', 'LAX')]: hike('SFO', 'LAX', mult),
      [routePairKey('SFO', 'SEA')]: hike('SFO', 'SEA', mult),
    },
    cargoRoutes: [],
  };
}
const renderRoutes = (s) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Routes)));
};
const renderEditor = (s, fares) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(FareEditor, { origin: 'SFO', dest: 'LAX', config: { economy: 150 }, fares, onCommit: () => {} })));
};
const strip = (h) => h.replace(/<!-- -->/g, '');

console.log('\n── Routes page banner ──────────────────');
test('NWR world, fares +50%: banner names both routes and offers the reset', () => {
  const html = strip(renderRoutes(save({ nwr: true, mult: 1.5 })));
  assert.match(html, /2 routes are priced past the demand cliff/);
  assert.match(html, /Reset all 2 to reference/);
});
test('NWR world, fares at reference: no banner', () => {
  const html = strip(renderRoutes(save({ nwr: true, mult: 1.0 })));
  assert.doesNotMatch(html, /past the demand cliff/);
});
test('classic world, fares +50%: no banner (no choke there)', () => {
  const html = strip(renderRoutes(save({ nwr: false, mult: 1.5 })));
  assert.doesNotMatch(html, /past the demand cliff/);
});

console.log('\n── Fare editor ─────────────────────────');
test('NWR world: a cabin +50% over reference is flagged', () => {
  const html = strip(renderEditor(save({ nwr: true, mult: 1 }), hike('SFO', 'LAX', 1.5)));
  assert.match(html, /past the demand cliff/);
});
test('NWR world: a cabin +5% is not', () => {
  const html = strip(renderEditor(save({ nwr: true, mult: 1 }), hike('SFO', 'LAX', 1.05)));
  assert.doesNotMatch(html, /past the demand cliff/);
});
test('classic world: never flagged', () => {
  const html = strip(renderEditor(save({ nwr: false, mult: 1 }), hike('SFO', 'LAX', 1.5)));
  assert.doesNotMatch(html, /past the demand cliff/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
