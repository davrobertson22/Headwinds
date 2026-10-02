// The route planners no longer cap a new route at 14 flights/week.
//
//   node --import ./tools/_register-loader.mjs tools/planner-frequency-cap-test.mjs
//
// Reported by Barca (Discord, 2026-09-30): "freight won't let you add more than
// 14 departures when creating a route, you have to add more afterwards." Both
// planners clamped their slider to min(14, block-hour max). The engine has no
// 14 limit — only block hours and gate slots — so the frequency stepper let you
// walk straight past the number the launch form refused. Renders the REAL
// planners and runs the REAL reducer.

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
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

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { maxFrequency, maxWeeklyBlockHoursFor, distanceKm } = await import('../src/utils/simulation.js');
const { getAirport } = await import('../src/data/airports.js');
const { frequencySliderWidth } = await import('../src/utils/frequencySlider.js');
const CargoRoutePlanner = (await import('../src/components/CargoRoutePlanner.jsx')).default;

// A short lane: well over 14 round trips fit in one freighter's week.
const [O, D] = ['NRT', 'KIX'];
const freighter = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => a.range - b.range)[0];
const base = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: O, cash: 500_000_000,
  gates: { [O]: 20, [D]: 20 },
  fleet: [{ id: 'f1', typeId: freighter.id, name: 'Short One', tailNumber: 'NS1', status: 'idle', ageWeeks: 52, ownershipType: 'owned' }],
  routes: [], cargoRoutes: [],
};
const cap = maxFrequency(distanceKm(getAirport(O), getAirport(D)), freighter, maxWeeklyBlockHoursFor(base));
store.set('bbae_save_v2', JSON.stringify(base));
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');

test('fixture: a short freight lane fits more than 14 flights on one airframe', () => {
  assert.ok(cap > 14, `fixture too long — block-hour max is only ${cap}`);
});

test('the freight planner slider goes past 14 on a short lane', () => {
  const h = render(React.createElement(CargoRoutePlanner, { embedded: true, initialOrigin: O, initialDest: D, onOpened: () => {} }));
  const m = h.match(/type="range"[^>]*max="(\d+)"/) ?? h.match(/max="(\d+)"[^>]*type="range"/);
  assert.ok(m, 'no frequency slider rendered');
  assert.ok(Number(m[1]) > 14, `slider max is ${m[1]} — still capped at 14`);
});

test('the freight slider widens with a long range (VodkaOnFire, Discord 2026-10-02)', () => {
  const h = render(React.createElement(CargoRoutePlanner, { embedded: true, initialOrigin: O, initialDest: D, onOpened: () => {} }));
  const tag = (h.match(/<input[^>]*type="range"[^>]*>/) ?? [''])[0];
  const w = Number((tag.match(/width:(\d+)px/) ?? [])[1]);
  assert.ok(w > 110, `slider is ${w}px for ${cap} steps — still the fixed 110px`);
});

test('slider width: short ranges stay compact, long ones are capped', () => {
  assert.equal(frequencySliderWidth(7), 110);
  assert.equal(frequencySliderWidth(14), 110);
  assert.ok(frequencySliderWidth(40) > 180);
  assert.equal(frequencySliderWidth(200), 280);
});

test('the engine accepts a freight launch above 14/wk (so the planner may offer it)', () => {
  const next = gameReducer(base, { type: 'ADD_CARGO_ROUTE', origin: O, destination: D, aircraftId: 'f1', weeklyFrequency: 18, yieldPrice: 1.0 });
  const r = (next.cargoRoutes ?? []).find(x => x.aircraftId === 'f1');
  assert.ok(r, 'launch at 18/wk was rejected');
  assert.equal(r.weeklyFrequency, 18);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
