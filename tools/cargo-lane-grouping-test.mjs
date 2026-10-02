// Freighters on the same city pair group into ONE lane on the routes page,
// the way passenger aircraft on a pair group into one card.
//
//   node --import ./tools/_register-loader.mjs tools/cargo-lane-grouping-test.mjs
//
// Reported by Matthijs (Discord, 2026-10-02): fourteen NRT→SZX freighters showed
// as fourteen identical rows, each tagged "Shared lane". The tick already pools
// them into one demand pool (cargoLaneAllocations); only the list was flat.
// This renders the REAL list, and checks that the lane's totals are the sum of
// the same pooled per-freighter sims the tick books — not a fresh solo sim.

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';

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
assert.ok(freighter, 'no freighter in the aircraft data');
const [A, B, C] = ['NRT', 'SZX', 'KIX'];
for (const c of [A, B, C]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const mod = await import('../src/components/CargoRoutesList.jsx');
const CargoRoutesList = mod.default;
const { groupCargoRows } = mod;
const { simulateCargoRoute, cargoLaneAllocations } = await import('../src/utils/simulation.js');

const tail = (id) => ({ id, typeId: freighter.id, name: `Heavy ${id}`, tailNumber: `N${id.toUpperCase()}`, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' });
const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: A, cash: 500_000_000,
  gates: { [A]: 20, [B]: 20, [C]: 20 },
  fleet: [tail('f1'), tail('f2'), tail('f3'), tail('f4')],
  routes: [],
  cargoRoutes: [
    { id: 'c1', origin: A, destination: B, aircraftId: 'f1', weeklyFrequency: 3, yieldPrice: 0.95, weeksOpen: 20 },
    { id: 'c2', origin: A, destination: B, aircraftId: 'f2', weeklyFrequency: 3, yieldPrice: 0.95, weeksOpen: 20 },
    // Flown the other way round — still the same city pair.
    { id: 'c3', origin: B, destination: A, aircraftId: 'f3', weeklyFrequency: 2, yieldPrice: 0.80, weeksOpen: 20 },
    { id: 'c4', origin: A, destination: C, aircraftId: 'f4', weeklyFrequency: 5, yieldPrice: 1.10, weeksOpen: 20 },
  ],
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
const count = (h, s) => h.split(s).length - 1;

console.log('\n── 1. One row per city pair ──────────────────────────────');

test('table: three freighters on NRT–SZX render as one lane row', () => {
  phone = false;
  const h = render(React.createElement(CargoRoutesList, { onAddFreighter: () => {} }));
  assert.equal(count(h, `${A} → ${B}`) + count(h, `${B} → ${A}`), 1,
    'expected one NRT–SZX row; the lane is still listed once per freighter');
  assert.match(h, /3 freighters/, 'the lane row should say how many freighters fly it');
  assert.equal(count(h, `${A} → ${C}`), 1, 'the solo lane should still render once');
});

test('a solo lane is unchanged: no freighter count, no lane controls', () => {
  phone = true;
  const h = render(React.createElement(CargoRoutesList, { onAddFreighter: () => {} }));
  assert.ok(h.includes('Flights/wk'), 'solo card lost its inline controls');
  assert.equal(count(h, 'Lane yield'), 1, 'only the shared lane should get lane-wide controls');
});

test('summary counts lanes, not freighters', () => {
  phone = false;
  const h = render(React.createElement(CargoRoutesList));
  assert.match(h, /Freight lanes/);
  assert.match(h, /4 freighter routes/);
});

test('uneven yields on a lane are shown as a range with an align control', () => {
  phone = true;
  const h = render(React.createElement(CargoRoutesList));
  assert.match(h, /\$0\.800–0\.950/, 'expected the lane yield range');
  assert.match(h, /Align all to/, 'expected the align control when yields differ');
});

console.log('\n── 2. Lane totals are the tick’s pooled numbers ──────────');

test('lane revenue/profit/tonnes = sum of pooled per-freighter sims', () => {
  const gd = { month: 6 };
  const alloc = cargoLaneAllocations(save.cargoRoutes, save.fleet, 1.0, { gameDate: gd, competitors: [] });
  const rows = save.cargoRoutes.map(route => {
    const aircraft = save.fleet.find(a => a.id === route.aircraftId);
    return { route, aircraft, sim: simulateCargoRoute(route, aircraft, gd, null, 1, 1, alloc.get(route.id) ?? null), pooled: alloc.has(route.id) };
  });
  const groups = groupCargoRows(rows);
  assert.equal(groups.length, 2);
  const lane = groups.find(g => g.rows.length === 3);
  const parts = rows.filter(r => r.route.id !== 'c4').map(r => r.sim);
  for (const f of ['revenue', 'profit', 'tonnes']) {
    const want = parts.reduce((s, x) => s + x[f], 0);
    assert.ok(Math.abs(lane.sim[f] - want) < 1e-6, `${f}: lane ${lane.sim[f]} vs sum ${want}`);
  }
  // Pooled, not N copies: the lane carries no more than one solo freighter would see as demand.
  const solo = simulateCargoRoute(save.cargoRoutes[0], save.fleet[0], gd);
  assert.ok(lane.sim.tonnes <= Math.max(solo.demandTonnes, solo.tonnes) * 1.0001 + 1,
    `lane tonnage ${lane.sim.tonnes} exceeds the single demand pool ${solo.demandTonnes}`);
  assert.equal(lane.route.weeklyFrequency, 8);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
