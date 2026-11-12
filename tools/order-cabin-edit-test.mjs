// Change the cabin of aircraft still on order (SET_ORDER_CABIN).
//
// Discord (Read2Much, 2026-11-11): about 40 frames ordered just before the
// cabin designer reached the order form, and every one of them "has to be
// reconfigured immediately after each delivery": a refit, and two weeks on the
// ground, per frame. The engine delivers an order with the cabin it carries,
// so the fix is to let the queue's cabins be changed before delivery: fitted
// on the line, the difference in line fitting paid, no refit, no shop time.
//
//   node --import ./tools/_register-loader.mjs tools/order-cabin-edit-test.mjs

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
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);
const spin = () => { const t = Date.now(); while (Date.now() === t) { /* unique ids */ } };

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const SIM = await import('../packages/engine/src/utils/simulation.js');
const { newAircraftConfig, SEAT_QUALITY_FITTING_FEE, cabinInstallFee } = SIM;
const { productFittingCost, defaultProducts } = await import('../packages/engine/src/data/seatProducts.js');
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');

const base = (over = {}) => ({ ...freshState(), phase: 'playing', hub: 'JFK', airlineName: 'Mine', cash: 5_000_000_000, ...over });
// A pre-designer order: seat counts and grades, no products.
const OLD = { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: 138, seatQuality: 'basic', serviceQuality: 'standard' };
const FLAT = { ...defaultProducts(), businessClass: { tier: 'flat', extras: [] }, economy: { tier: '32', extras: ['screens'] } };
const NEW = { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: 120, seatQuality: 'premium', serviceQuality: 'premium', products: FLAT };

function ordered(state, typeId = 'a320ceo', quantity = 3, config = OLD) {
  spin();
  return gameReducer(state, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: 'owned', config });
}
const setCabin = (s, orderIds, config) => gameReducer(s, { type: 'SET_ORDER_CABIN', orderIds, config });
const lineFit = (c) => (SEAT_QUALITY_FITTING_FEE[c?.seatQuality ?? 'basic'] ?? 0) + cabinInstallFee(c) + productFittingCost(null, c);

// ─────────────────────────────────────────────────────────────────────────────
section('the queue');

await test('an order on the queue takes a new cabin, and is delivered with it: no refit, no shop time', () => {
  let s = ordered(base());
  const [o1, o2, o3] = s.pendingOrders;
  s = setCabin(s, [o1.id], NEW);
  assert.deepEqual(s.pendingOrders.find(o => o.id === o1.id).config, NEW);
  assert.deepEqual(s.pendingOrders.find(o => o.id === o2.id).config, OLD, 'only the named order changes');
  for (let i = 0; i < 80 && s.pendingOrders.length; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.pendingOrders.length, 0, 'all delivered');
  const a1 = s.fleet.find(a => a.name === o1.name);
  assert.deepEqual(a1.config, NEW);
  assert.notEqual(a1.status, 'grounded');
  assert.ok(!(a1.groundedWeeksLeft > 0), 'no refit downtime');
  assert.deepEqual(s.fleet.find(a => a.name === o3.name).config, OLD);
});

await test('every order of a type in one action', () => {
  let s = ordered(base(), 'a320ceo', 4);
  s = ordered(s, 'b737800', 2, { ...OLD, businessClass: 0, economy: 160 });
  const a320s = s.pendingOrders.filter(o => o.typeId === 'a320ceo').map(o => o.id);
  s = setCabin(s, a320s, NEW);
  assert.equal(s.pendingOrders.filter(o => o.typeId === 'a320ceo' && o.config === NEW).length, 4);
  assert.equal(s.pendingOrders.filter(o => o.typeId === 'b737800' && o.config !== NEW).length, 2);
});

await test('pays the difference in line fitting: the same figure the order form charges', () => {
  const s0 = ordered(base(), 'a320ceo', 2);
  const cost = lineFit(NEW) - lineFit(OLD);
  assert.ok(cost > 0);
  assert.equal(SIM.orderCabinChangeCost(OLD, NEW), cost, 'engine helper');
  const s1 = setCabin(s0, s0.pendingOrders.map(o => o.id), NEW);
  assert.equal(s0.cash - s1.cash, 2 * cost);
});

await test('taking things out is free, and nothing is refunded', () => {
  let s = ordered(base(), 'a320ceo', 1, NEW);
  const before = s.cash;
  s = setCabin(s, [s.pendingOrders[0].id], OLD);
  assert.equal(s.cash, before);
  assert.deepEqual(s.pendingOrders[0].config, OLD);
});

await test('ORDER_AIRCRAFT charges exactly lineFitCost for its cabin (one definition)', () => {
  const s0 = base();
  const s1 = ordered(s0, 'a320ceo', 1, NEW);
  const o = s1.pendingOrders[0];
  assert.equal(SIM.lineFitCost(NEW), lineFit(NEW));
  assert.equal(s0.cash - s1.cash - o.totalPrice, SIM.lineFitCost(NEW));
});

await test('an order placed without a cabin is priced from the typical seating it would arrive with', () => {
  let s = ordered(base(), 'a320ceo', 1, null);
  assert.equal(s.pendingOrders[0].config, null);
  const before = s.cash;
  s = setCabin(s, [s.pendingOrders[0].id], NEW);
  assert.equal(before - s.cash, Math.max(0, lineFit(NEW) - lineFit(newAircraftConfig(getAircraftType('a320ceo')))));
  assert.deepEqual(s.pendingOrders[0].config, NEW);
});

// ─────────────────────────────────────────────────────────────────────────────
section('what is refused');

await test('a cabin bigger than the floor, a negative count, or orders of two types', () => {
  let s = ordered(base(), 'a320ceo', 1);
  s = ordered(s, 'b737800', 1);
  const [a, b] = s.pendingOrders;
  const big = setCabin(s, [a.id], { ...OLD, economy: 400 });
  assert.deepEqual(big.pendingOrders, s.pendingOrders);
  assert.equal(big.cash, s.cash);
  const neg = setCabin(s, [a.id], { ...OLD, businessClass: 60, economy: -20 });
  assert.deepEqual(neg.pendingOrders, s.pendingOrders);
  assert.equal(setCabin(s, [a.id, b.id], OLD), s, 'mixed types');
});

await test('a seat not yet invented in this world is refused with the era toast', () => {
  let s = ordered(base({ startYear: 1985, year: 1, week: 1 }), 'b727200', 1);
  assert.equal(SIM.calendarYear(s), 1985);
  assert.equal(s.pendingOrders.length, 1, 'a 727 can be ordered in 1985');
  const r = setCabin(s, [s.pendingOrders[0].id], NEW);
  assert.deepEqual(r.pendingOrders, s.pendingOrders);
  assert.ok((r.pendingToasts ?? []).some(t => /era/i.test(t.title)));
});

await test('not enough cash: nothing changes', () => {
  let s = ordered(base(), 'a320ceo', 1);
  s = { ...s, cash: 1 };
  const r = setCabin(s, [s.pendingOrders[0].id], NEW);
  assert.deepEqual(r.pendingOrders, s.pendingOrders);
  assert.equal(r.cash, 1);
  assert.match(r.error ?? '', /cash/i);
});

await test('used-market orders and freighters keep what they have', () => {
  let s = ordered(base(), 'a320ceo', 1);
  const used = { ...s.pendingOrders[0], id: 'used-1', used: true, usedSnapshot: { typeId: 'a320ceo', config: OLD } };
  s = { ...s, pendingOrders: [used] };
  assert.equal(setCabin(s, ['used-1'], NEW), s);
  const fType = ['b747400f', 'b777f', 'md11f', 'a330200f'].find(id => getAircraftType(id)?.freighter);
  assert.ok(fType, 'a freighter type');
  let f = base();
  spin();
  f = gameReducer(f, { type: 'ORDER_AIRCRAFT', typeId: fType, quantity: 1, ownershipType: 'owned' });
  if (f.pendingOrders.length) assert.equal(setCabin(f, [f.pendingOrders[0].id], OLD), f);
});

// ─────────────────────────────────────────────────────────────────────────────
section('the server');

await test('SET_ORDER_CABIN is a player action', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_ORDER_CABIN'));
});

await test('the guard keeps only own, factory-new orders of one type, and the floor', () => {
  let s = ordered(base(), 'a320ceo', 2);
  s = ordered(s, 'b737800', 1);
  const [a, b, c] = s.pendingOrders;
  const p = guardDecision('SET_ORDER_CABIN', { type: 'SET_ORDER_CABIN', orderIds: [a.id, b.id, 'not-mine'], config: NEW, cost: 0 }, s);
  assert.deepEqual(p, { orderIds: [a.id, b.id], config: NEW });
  assert.throws(() => guardDecision('SET_ORDER_CABIN', { orderIds: [a.id, c.id], config: NEW }, s), /one aircraft type/);
  assert.throws(() => guardDecision('SET_ORDER_CABIN', { orderIds: [a.id], config: { ...OLD, economy: 400 } }, s), /capacity/);
  assert.throws(() => guardDecision('SET_ORDER_CABIN', { orderIds: ['x'], config: NEW }, s), /Unknown order/);
  assert.throws(() => guardDecision('SET_ORDER_CABIN', { orderIds: [a.id] }, s), /Invalid cabin/);
});

// ─────────────────────────────────────────────────────────────────────────────
section('the screens');

const { GameProvider } = await import('../src/store/GameContext.jsx');
const FleetConfig = (await import('../src/components/FleetConfig.jsx')).default;
const { OrderCard } = await import('../src/components/Marketplace.jsx');
const text = (html) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const renderWith = (save, el) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null, el));
};

await test('the designer opens for an order: no downtime promised, apply-to-all offered', () => {
  const s = ordered(base(), 'a320ceo', 5);
  const html = renderWith(s, React.createElement(FleetConfig, { orderIds: [s.pendingOrders[0].id], onClose() {} }));
  const t = text(html);
  assert.match(t, /Cabin for .* \(on order\)/);
  assert.match(html, /data-apply-all/);
  assert.match(t, /Apply to all 5 .* orders still to be delivered/);
  assert.match(t, /production line/);
  assert.doesNotMatch(t, /out of service for/);
  assert.match(html, /<svg/, 'the floor plan is drawn');
});

await test('an order card has the cabin button; a used order does not', () => {
  const s = ordered(base(), 'a320ceo', 1);
  const o = s.pendingOrders[0];
  const card = (order) => renderWith(s, React.createElement(OrderCard, { order, currentAbsWeek: 1, onCancel() {}, onRename() {}, onEditCabin() {} }));
  assert.match(card(o), new RegExp(`data-order-cabin="${o.id}"`));
  assert.match(text(card(o)), /Edit cabin/);
  assert.doesNotMatch(card({ ...o, used: true }), /data-order-cabin/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
