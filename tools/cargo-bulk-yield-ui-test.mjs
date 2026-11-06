// Freight mass pricing and inline yield, rendered on the REAL routes list.
//
//   node --import ./tools/_register-loader.mjs tools/cargo-bulk-yield-ui-test.mjs
//
// Discord 2026-11-05: Barca asked for mass pricing on freight; Dunno23 said
// editing a freight route's price after opening it was missing (it lived behind
// a row you had to expand). This SSR-renders CargoRoutesList and checks the
// tick boxes, the Bulk Pricing button, and that the yield column holds the
// editors themselves, not just a number. The pricing rule itself is covered by
// tools/cargo-bulk-yield-test.mjs.

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
let phone = false;
globalThis.window.matchMedia = () => ({ matches: phone, addListener() {}, removeListener() {} });
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
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const listMod = await import('../src/components/CargoRoutesList.jsx');
const CargoRoutesList = listMod.default;
const { groupCargoRows, CargoSelectionBar, CargoBulkPricingModal } = listMod;

const tail = (id) => ({ id, typeId: freighter.id, name: `Heavy ${id}`, tailNumber: `N${id.toUpperCase()}`, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' });
store.set('bbae_save_v2', JSON.stringify({
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: 'NRT', cash: 500_000_000,
  gates: { NRT: 20, SZX: 20, KIX: 20 },
  fleet: [tail('f1'), tail('f2'), tail('f3')],
  routes: [],
  cargoRoutes: [
    { id: 'c1', origin: 'NRT', destination: 'SZX', aircraftId: 'f1', weeklyFrequency: 3, yieldPrice: 0.95, weeksOpen: 20 },
    { id: 'c2', origin: 'NRT', destination: 'SZX', aircraftId: 'f2', weeklyFrequency: 3, yieldPrice: 0.95, weeksOpen: 20 },
    { id: 'c3', origin: 'NRT', destination: 'KIX', aircraftId: 'f3', weeklyFrequency: 5, yieldPrice: 1.10, weeksOpen: 20 },
  ],
}));

const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
const count = (h, s) => h.split(s).length - 1;

test('table: a select-all box and one tick box per lane', () => {
  phone = false;
  const h = render(React.createElement(CargoRoutesList, { onAddFreighter: () => {} }));
  assert.equal(count(h, 'data-cargo-select-all'), 1, 'no select-all box in the table header');
  assert.equal(count(h, 'data-cargo-select="'), 2, 'expected one tick box per lane (two lanes)');
});

test('the summary bar has a Bulk Pricing button', () => {
  phone = false;
  const h = render(React.createElement(CargoRoutesList, {}));
  assert.match(h, /Bulk Pricing/);
});

test('a solo lane\'s yield is a stepper in the row, without opening it', () => {
  phone = false;
  const h = render(React.createElement(CargoRoutesList, {}));
  const cell = h.split('data-cargo-yield-cell=""')[1] ?? '';
  assert.ok(cell, 'the yield column has no editor');
  assert.match(cell.slice(0, 1500), /aria-label="yield, NRT to KIX"/, 'the solo lane row has no yield stepper');
});

test('a shared lane\'s yield has lane-wide −/+ in the row', () => {
  phone = false;
  const h = render(React.createElement(CargoRoutesList, {}));
  assert.equal(count(h, 'data-cargo-lane-yield'), 1, 'the two-freighter lane row has no lane yield controls');
});

test('cards: every lane card carries a tick box', () => {
  phone = true;
  const h = render(React.createElement(CargoRoutesList, {}));
  assert.equal(count(h, 'data-cargo-select="'), 2);
  assert.match(h, /Select all 2 lanes/);
});

// The bar and the modal only open on a click, so render them directly with the
// lanes the list would hand them.
const save = JSON.parse(store.get('bbae_save_v2'));
const groups = groupCargoRows(save.cargoRoutes.map(route => ({ route, sim: { capacityTonnes: 100, tonnes: 50, loadFactor: 0.5, distance: 1000, revenue: 0, profit: 0 } })));

test('the selection bar names lanes and freighters, with % / reset / flights / close', () => {
  const h = render(React.createElement(CargoSelectionBar, { groups, onApplyYield() {}, onCloseGroups() {}, onClear() {} }));
  assert.match(h, /2 lanes selected/);
  assert.match(h, /3 freighters/);
  assert.match(h, /data-cargo-bulk-pct/);
  assert.match(h, /Reset to ref/);
  assert.match(h, /Flights\/wk/, 'no bulk frequency control for freight');
  assert.match(h, />Close</);
});

test('the Bulk Pricing modal filters by load factor and rate, and counts the match', () => {
  const h = render(React.createElement(CargoBulkPricingModal, { allGroups: groups, onApply() {}, onClose() {} }));
  assert.match(h, /Freight Bulk Pricing/);
  assert.match(h, /Load factor between/);
  assert.match(h, /Above the going rate/);
  assert.match(h, /<b[^>]*>2<\/b> of 2 lanes match/);
  assert.match(h, /3 freighters/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
