// The airport detail page on a phone: one column, nothing off-screen.
//
// The page is a grid of 320px-minimum cards, and Passenger Flows asked for
// `gridColumn: span 2`. On a phone there is room for ONE column, so that span
// invented a second, implicit one: the page went two columns wide and every
// card in column two (Lounge, Ground Handling, …) sat off the right edge of the
// screen. Found in Tailwinds in a 390px headless browser while adding gate
// leasing to the map's airport page (Discord, Oct 2026); same grid here.
//
//   node --import ./tools/_register-loader.mjs tools/airport-detail-phone-layout-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
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
const AirportDetail = (await import('../src/components/AirportDetail.jsx')).default;

const SAVE = {
  ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'MAD', cash: 5e7,
  gates: { MAD: 3 }, fleet: [], routes: [], cargoRoutes: [],
};
const render = (phone) => {
  globalThis.window.matchMedia = (q) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  try {
    store.set('bbae_save_v2', JSON.stringify(SAVE));
    return renderToString(React.createElement(GameProvider, null,
      React.createElement(AirportDetail, { code: 'LIS', onBack: () => {} }))).replace(/<!-- -->/g, '');
  } finally { delete globalThis.window.matchMedia; }
};

console.log('\nAirport detail, phone layout\n');

test('phone: no card spans two columns, and a column never outgrows the screen', () => {
  const html = render(true);
  assert.ok(html.includes('Passenger Flows'), 'the spanning card renders');
  assert.ok(!html.includes('grid-column:span 2'), 'span 2 adds an implicit column on a phone');
  assert.ok(html.includes('grid-column:1 / -1'), 'Passenger Flows spans the row it has');
  assert.ok(html.includes('minmax(min(320px, 100%), 1fr)'), 'a 308px-wide screen gets a 308px column, not 320');
});

test('desktop: Passenger Flows still spans two cards', () => {
  assert.ok(render(false).includes('grid-column:span 2'));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
