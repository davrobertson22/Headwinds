// Cabin presets in the buy / refit dialogs, and saving templates from the
// Route Planner, SSR-rendered for real.
//
// From Discord: a player set up the Route Planner's "Premium-heavy" cabin and
// found no way to get it in the buy-aircraft dialog — the dialog's Templates
// list only held cabins saved there by hand. The planner's standard layouts now
// come from one module (utils/cabinPresets.js) and are listed in the picker the
// buy and refit dialogs share, sized to the aircraft; and the planner can save
// its cabin as a template, which that same picker then offers.
//
//   node --import ./tools/_register-loader.mjs tools/cabin-presets-ui-test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
window.dispatchEvent = () => true;
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia = window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
window.localStorage = globalThis.localStorage;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const reducerPath = existsSync(new URL('../packages/engine/src/reducer.mjs', import.meta.url))
  ? '../packages/engine/src/reducer.mjs' : '../src/store/GameContext.jsx';
const { gameReducer, freshState } = await import(reducerPath);
const { GameProvider } = await import('../src/store/GameContext.jsx');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { typicalSeatsOf } = await import('../src/utils/simulation.js');
const { makePreset, PRESET_OPTIONS } = await import('../src/utils/cabinPresets.js');
const planner = await import('../src/components/RoutePlanner.jsx');
const CabinTemplatePicker = (await import('../src/components/CabinTemplatePicker.jsx')).default;

const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<!-- -->/g, '');
const render = (state, props) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return unescape(renderToString(React.createElement(GameProvider, null,
    React.createElement(CabinTemplatePicker, { onApply: () => {}, currentConfig: null, ...props }))));
};
const seats = (c) => [c.firstClass > 0 && `${c.firstClass}F`, c.businessClass > 0 && `${c.businessClass}J`,
  c.premiumEconomy > 0 && `${c.premiumEconomy}W`, `${c.economy ?? 0}Y`].filter(Boolean).join('/');

const base = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
const TYPE = 'b7879';
const type = getAircraftType(TYPE);

console.log('\nCabin presets in the buy / refit picker (SSR)\n');

await test('the planner and the picker read one set of presets', async () => {
  assert.equal(planner.makePreset, makePreset, 'RoutePlanner re-exports the shared makePreset');
  assert.deepEqual(PRESET_OPTIONS.map(p => p.id), ['economy', 'dense', 'twoClass', 'threeClass', 'premiumHeavy']);
});

await test('with no saved templates, the picker still offers every standard layout, sized to the type', async () => {
  const html = render(base, { typeId: TYPE });
  assert.ok(html.includes('Standard layouts'), 'a Standard layouts group');
  assert.ok(!html.includes('No saved templates'), 'no empty-state message when presets exist');
  for (const p of PRESET_OPTIONS) {
    const cfg = makePreset(p.id, type.seats, typicalSeatsOf(type));
    assert.ok(html.includes(`${p.label} — ${seats(cfg)}`), `${p.id} listed as ${seats(cfg)}`);
  }
  const ph = makePreset('premiumHeavy', type.seats, typicalSeatsOf(type));
  assert.ok(ph.firstClass > 0 && ph.businessClass > 0 && ph.premiumEconomy > 0, 'premium-heavy has F, J and W');
});

await test('a template saved from the planner is listed in the buy picker for that type only', async () => {
  const cfg = makePreset('premiumHeavy', type.seats, typicalSeatsOf(type));
  const s = gameReducer(base, { type: 'SAVE_CABIN_TEMPLATE', name: 'Long-haul premium', typeId: TYPE, config: cfg });
  const html = render(s, { typeId: TYPE });
  assert.ok(html.includes('Your templates'));
  assert.ok(html.includes('Long-haul premium — '), 'the saved template');
  const other = render(s, { typeId: 'a320neo' });
  assert.ok(!other.includes('Long-haul premium'), 'not offered on another type');
  assert.ok(other.includes('Standard layouts'), 'the other type still gets its own presets');
});

await test('an unknown type falls back to the empty-state message', async () => {
  const html = render(base, { typeId: 'no-such-type' });
  assert.ok(!html.includes('Standard layouts'));
  assert.ok(html.includes('No saved templates'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
