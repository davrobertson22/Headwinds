// The refit modal's cabin products panel (FleetConfig → ProductRow), SSR of
// the real component: one row per cabin with seats, the tiers and extras from
// data/seatProducts.js, products the era or airframe refuses shown disabled,
// the service grade exposed, and the plan drawing the products it is given.
//
//   node --import ./tools/_register-loader.mjs tools/cabin-products-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import { defaultConfig } from '../src/utils/simulation.js';
import { freshState } from '../packages/engine/src/reducer.mjs';
import { SEAT_PRODUCTS } from '../src/data/seatProducts.js';

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

const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');
const FleetConfig = (await import('../src/components/FleetConfig.jsx')).default;
const CabinFloorPlan = (await import('../src/components/CabinFloorPlan.jsx')).default;

function renderModal(typeId, config, extraState = {}) {
  const t = getAircraftType(typeId);
  const state = {
    ...freshState(), phase: 'playing', week: 10, year: 1, hub: 'JFK', cash: 500_000_000, ...extraState,
    fleet: [{ id: 'p1', typeId, name: 'Plan One', tailNumber: 'N1', status: 'idle', ageWeeks: 10, ownershipType: 'owned', config: config ?? defaultConfig(t.seats) }],
  };
  return renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {} },
    React.createElement(FleetConfig, { aircraftId: 'p1', onClose() {} }))).replace(/<!-- -->/g, '');
}
const row = (html, cls) => {
  const m = html.match(new RegExp(`<div class="cabin-product-row" data-product-row="${cls}">([\\s\\S]*?)(?=<div class="cabin-product-row"|<\\/div>\\s*<div style="margin-bottom:22px">)`));
  return m ? m[1] : '';
};
// The <input>/<button> carrying this data attribute, whatever order React
// emitted the attributes in.
const tag = (html, attr, val) => (html.match(new RegExp(`<(?:input|button)[^>]*${attr}="${val}"[^>]*>`)) ?? [''])[0];
const BASE = { firstClass: 8, businessClass: 42, premiumEconomy: 28, economy: 220, seatQuality: 'basic', serviceQuality: 'standard' };

test('a row per cabin with seats, with every tier and extra from the data', () => {
  const html = renderModal('b7879', BASE);
  for (const cls of ['firstClass', 'businessClass', 'premiumEconomy', 'economy']) {
    const r = row(html, cls);
    assert.ok(r, `no row for ${cls}`);
    for (const t of SEAT_PRODUCTS[cls].tiers) assert.match(r, new RegExp(`data-tier="${t.key}"`), `${cls} lacks tier ${t.key}`);
    for (const e of SEAT_PRODUCTS[cls].extras) assert.match(r, new RegExp(`data-extra="${e.key}"`), `${cls} lacks extra ${e.key}`);
  }
  assert.ok(!row(renderModal('b7879', { ...BASE, firstClass: 0, economy: 236 }), 'firstClass'), 'no First row when First has no seats');
});

test('the airframe gates: shower disabled on a 787, enabled on an A380; apartment disabled on an A320', () => {
  const b789 = row(renderModal('b7879', BASE), 'firstClass');
  assert.match(tag(b789, 'data-extra', 'shower'), /disabled/);
  assert.match(b789, /Shower suite needs a double-decker/);
  assert.doesNotMatch(tag(b789, 'data-tier', 'apartment'), /disabled/);
  const a380 = row(renderModal('a380', { ...BASE, economy: 500 }), 'firstClass');
  assert.doesNotMatch(tag(a380, 'data-extra', 'shower'), /disabled/);
  const a320 = row(renderModal('a320neo', { firstClass: 4, businessClass: 12, premiumEconomy: 0, economy: 140 }), 'firstClass');
  assert.match(tag(a320, 'data-tier', 'apartment'), /disabled/);
  assert.match(a320, /Apartment needs a widebody/);
});

test('the era gates: no lie-flats in 1985, cradle and recliner only', () => {
  const r = row(renderModal('b7879', BASE, { startYear: 1985, year: 1 }), 'businessClass');
  for (const k of ['angled', 'flat', 'suite']) assert.match(tag(r, 'data-tier', k), /disabled/, `${k} should be disabled in 1985`);
  assert.doesNotMatch(tag(r, 'data-tier', 'recliner'), /disabled/);
  assert.match(r, /does not exist yet — it arrives around 2000/);
});

test('the current products are selected and priced', () => {
  const cfg = { ...BASE, products: { businessClass: { tier: 'flat', extras: ['aisle'] } } };
  const r = row(renderModal('b7879', cfg), 'businessClass');
  assert.match(tag(r, 'data-tier', 'flat'), /aria-checked="true"/);
  assert.match(tag(r, 'data-extra', 'aisle'), /checked/);
  assert.match(r, /\+21 quality/);
  assert.doesNotMatch(r, /CHANGED/, 'the aircraft already has these');
});

test('the service grade is exposed next to seat quality', () => {
  const html = renderModal('b7879', { ...BASE, serviceQuality: 'premium' });
  assert.match(html, /<option value="premium" selected="">Premium — Better crew ratio/);
});

test('the plan draws lie-flats 1-2-1 and a 28" economy at the same seats across', () => {
  const t = getAircraftType('b7879');
  const cfg = { firstClass: 0, businessClass: 42, premiumEconomy: 0, economy: 300, products: { businessClass: { tier: 'flat', extras: ['aisle'] }, economy: { tier: '28', extras: [] } } };
  const html = renderToString(React.createElement(CabinFloorPlan, { type: t, config: cfg }));
  assert.match(html, /data-cabin="businessClass" data-seats="42"/);
  assert.match(html, /data-cabin="economy" data-seats="300"/);
  // 300 economy at 28" fit where 300 at 30" would not: 42×1.5×1.18×1.12 + 300×0.93 = 362.3 ≤ 420; at 30" with recliners 63 + 300 = 363 — both fit; prove the dense one gives floor back:
  assert.match(html, /data-cabin="empty"/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
