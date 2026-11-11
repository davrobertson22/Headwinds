// The cabin designer on the order form (AircraftCheckout).
//
// Discord (VF84, 2026-11-08): "great new feature, but can it be implemented
// when first buying or leasing? rather than waiting for delivery then having
// to wait another 2 weeks for the reconfig."
//
// The floor plan, the brushes, the per-cabin seat products and the service
// grade are on the order form, the quote includes the product fitting the
// reducer charges, and the aircraft is delivered with the cabin it was ordered
// with — no refit, no shop time.
//
//   node --import ./tools/_register-loader.mjs tools/checkout-cabin-designer-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

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
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;
const { gameReducer } = await import('../packages/engine/src/reducer.mjs');
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { formatMoney, configSeatUnits } = await import('../src/utils/simulation.js');
const { SEAT_PRODUCTS, productFittingCost, defaultProducts } = await import('../src/data/seatProducts.js');

const base = (over = {}) => ({ ...freshState(), phase: 'playing', hub: 'JFK', airlineName: 'Mine', cash: 5_000_000_000, ...over });
const render = (save, props) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(AircraftCheckout, { onClose() {}, ...props }))).replace(/<!-- -->/g, '');
};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const tag = (html, attr, val) => (html.match(new RegExp(`<(?:input|button)[^>]*${attr}="${val}"[^>]*>`)) ?? [''])[0];
const row = (html, cls) => {
  const i = html.indexOf(`data-product-row="${cls}"`);
  if (i < 0) return '';
  const j = html.indexOf('data-product-row="', i + 20);
  return html.slice(i, j > 0 ? j : i + 6000);
};

const FLAT = { ...defaultProducts(), businessClass: { tier: 'flat', extras: ['aisle'] }, economy: { tier: '28', extras: ['screens'] } };
const CABIN = { firstClass: 8, businessClass: 42, premiumEconomy: 28, economy: 200, seatQuality: 'basic', serviceQuality: 'premium', products: FLAT };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── The designer is on the order form ─────────────────────');

test('buying: the plan of the aircraft being ordered, paintable, with the five brushes', () => {
  const html = render(base(), { typeId: 'b7879', mode: 'buy' });
  assert.match(html, /data-checkout-plan="inline"/);
  assert.match(html, /data-plane="b7879"/);
  assert.match(html, /data-editable="true"/);
  assert.match(html, /data-paint-layer="main"/);
  for (const k of ['firstClass', 'businessClass', 'premiumEconomy', 'economy', 'empty']) assert.match(html, new RegExp(`data-brush="${k}"`));
  const t = getAircraftType('b7879');
  assert.match(html, new RegExp(`data-cabin="economy" data-seats="${t.typicalSeats ?? t.seats}"`), 'the typical cabin is drawn, seat for seat');
});

test('leasing gets the same designer', () => {
  const html = render(base(), { typeId: 'a320neo', mode: 'lease' });
  assert.match(html, /data-plane="a320neo"/);
  assert.match(html, /data-product-row="economy"/);
});

test('a product row per cabin with seats, every tier and extra offered', () => {
  const html = render(base(), { typeId: 'b7879', mode: 'buy', initialConfig: CABIN });
  for (const cls of ['firstClass', 'businessClass', 'premiumEconomy', 'economy']) {
    const r = row(html, cls);
    assert.ok(r, `no row for ${cls}`);
    for (const t of SEAT_PRODUCTS[cls].tiers) assert.match(r, new RegExp(`data-tier="${t.key}"`), `${cls} lacks ${t.key}`);
    for (const e of SEAT_PRODUCTS[cls].extras) assert.match(r, new RegExp(`data-extra="${e.key}"`), `${cls} lacks ${e.key}`);
  }
  assert.match(tag(row(html, 'businessClass'), 'data-tier', 'flat'), /aria-checked="true"/);
  assert.match(tag(row(html, 'businessClass'), 'data-extra', 'aisle'), /checked/);
  assert.doesNotMatch(html, /CHANGED/, 'nothing is "changed" on an aircraft that does not exist yet');
  assert.match(text(html), /delivered with this cabin, with no refit and no time in the shop/);
});

test('only economy has a row on the default all-economy cabin', () => {
  const html = render(base(), { typeId: 'a320neo', mode: 'buy' });
  assert.ok(row(html, 'economy'));
  assert.ok(!row(html, 'businessClass'));
});

test('the service grade is offered and remembered', () => {
  const html = render(base(), { typeId: 'b7879', mode: 'buy', initialConfig: CABIN });
  assert.match(html, /data-service-quality/);
  assert.match(html, /<option value="premium" selected="">Premium — Better crew ratio/);
});

test('era and airframe gates: no lie-flats in 1985, no shower on a 787', () => {
  const old = render(base({ startYear: 1985, year: 1 }), { typeId: 'b747200', mode: 'buy', initialConfig: { firstClass: 8, businessClass: 40, premiumEconomy: 0, economy: 300 } });
  for (const k of ['angled', 'flat', 'suite']) assert.match(tag(row(old, 'businessClass'), 'data-tier', k), /disabled/, `${k} should be disabled in 1985`);
  assert.doesNotMatch(tag(row(old, 'businessClass'), 'data-tier', 'recliner'), /disabled/);
  const now = render(base(), { typeId: 'b7879', mode: 'buy', initialConfig: CABIN });
  assert.match(tag(row(now, 'firstClass'), 'data-extra', 'shower'), /disabled/);
});

test('a freighter has no cabin to design', () => {
  const html = render(base(), { typeId: 'b777f', mode: 'buy' });
  assert.doesNotMatch(html, /data-checkout-plan|data-product-row|data-brush/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── The quote is what the reducer charges ─────────────────');

const order = (save, typeId, mode, config, quantity = 1) => {
  const payload = guardDecision('ORDER_AIRCRAFT', { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: mode === 'buy' ? 'owned' : 'lease', config }, save);
  const after = gameReducer(save, { ...payload, type: 'ORDER_AIRCRAFT' });
  return { after, paid: save.cash - after.cash, placed: (after.pendingOrders ?? []).slice((save.pendingOrders ?? []).length) };
};

test('buy: the products line is productFittingCost and the total is the cash the order takes', () => {
  const save = base();
  const html = text(render(save, { typeId: 'b7879', mode: 'buy', initialConfig: CABIN }));
  const fit = productFittingCost(null, CABIN);
  assert.equal(fit, 42 * 40_000 + 42 * 5_000 + 200 * 1_500);
  assert.ok(html.includes(`Cabin products — one-off +${formatMoney(fit)}`), 'no products line at the right price');
  const { paid, placed } = order(save, 'b7879', 'buy', CABIN);
  assert.equal(placed.length, 1, 'the order was placed');
  assert.ok(html.includes(`Total ${formatMoney(paid)}`), `the form does not total ${formatMoney(paid)}, which is what the reducer charged`);
});

test('the products add exactly their fitting to a plain order of the same cabin', () => {
  const save = base();
  const html = text(render(save, { typeId: 'a320neo', mode: 'buy', initialConfig: { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: 150, products: { businessClass: { tier: 'flat', extras: [] } } } }));
  assert.ok(html.includes(`Cabin products — one-off +${formatMoney(12 * 40_000)}`));
  const one = order(save, 'a320neo', 'buy', { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: 150, products: { businessClass: { tier: 'flat', extras: [] } } }).paid;
  const plain = order(save, 'a320neo', 'buy', { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: 150 }).paid;
  assert.equal(one - plain, 12 * 40_000);
});

test('lease: the products are due now alongside the deposit, and the reducer takes exactly that', () => {
  const save = base();
  const html = text(render(save, { typeId: 'b7879', mode: 'lease', initialConfig: CABIN }));
  const fit = productFittingCost(null, CABIN);
  assert.ok(html.includes(`Cabin products, one-off (due now) ${formatMoney(fit)}`));
  const withP = order(save, 'b7879', 'lease', CABIN).paid;
  const without = order(save, 'b7879', 'lease', { ...CABIN, products: undefined }).paid;
  assert.equal(withP - without, fit);
});

test('an untouched order is the same action it always was (no products key)', () => {
  // The form only carries `products` when something is above the defaults; the
  // reducer charges nothing for a cabin without them.
  assert.equal(productFittingCost(null, { economy: 180 }), 0);
  assert.equal(productFittingCost(null, { economy: 180, products: defaultProducts() }), 0);
  const html = text(render(base(), { typeId: 'a320neo', mode: 'buy' }));
  assert.ok(!html.includes('Cabin products — one-off'));
});

test('the floor on the form is product-aware: lie-flats that overflow are flagged and refused', () => {
  const over = { firstClass: 0, businessClass: 100, premiumEconomy: 0, economy: 100, products: { businessClass: { tier: 'suite', extras: ['aisle'] } } };
  assert.ok(configSeatUnits(over) > getAircraftType('a320neo').seats);
  const html = text(render(base(), { typeId: 'a320neo', mode: 'buy', initialConfig: over }));
  assert.match(html, /Over-allocated by/);
  assert.match(html, /Fix cabin layout/);
  assert.throws(() => guardDecision('ORDER_AIRCRAFT', { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', quantity: 1, ownershipType: 'owned', config: over }, base()), /capacity/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Delivered as ordered ──────────────────────────────────');

test('the order carries the cabin, and the aircraft arrives with it and flies', () => {
  let s = base();
  const { after, placed } = order(s, 'a320neo', 'buy', { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: 150, seatQuality: 'standard', serviceQuality: 'premium', products: { businessClass: { tier: 'flat', extras: ['aisle'] } } });
  assert.equal(placed[0].config.products.businessClass.tier, 'flat');
  s = after;
  for (let i = 0; i < 60 && s.fleet.length === 0; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.fleet.length, 1, 'never delivered');
  const t = s.fleet[0];
  assert.deepEqual(t.config.products, { businessClass: { tier: 'flat', extras: ['aisle'] } });
  assert.equal(t.config.businessClass, 12);
  assert.equal(t.config.serviceQuality, 'premium');
  assert.notEqual(t.groundedReason, 'refit', 'it must not arrive in the shop');
  assert.ok(!(t.groundedWeeksLeft > 0), 'it must not arrive grounded');
});

test('an order with a product this world refuses places nothing and takes nothing', () => {
  const s = base({ startYear: 1985, year: 1, week: 1 });
  const { after, paid } = order(s, 'b747200', 'buy', { firstClass: 8, businessClass: 40, premiumEconomy: 0, economy: 300, products: { businessClass: { tier: 'flat', extras: [] } } });
  assert.match(after.error ?? '', /does not exist yet/);
  assert.equal(paid, 0);
  assert.equal((after.pendingOrders ?? []).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
