// Preorders, UI side (Discord: Kat the Fox, 2026-11-12): the market card, the
// checkout and the Orders tab say what ORDER_AIRCRAFT, the tick and
// CANCEL_ORDER actually do — SSR-rendering the real components.
//
//   node --import ./tools/_register-loader.mjs tools/preorders-ui-test.mjs
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
Math.random = () => 0.5;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const MarketMod = await import('../src/components/Marketplace.jsx');
const Marketplace = MarketMod.default;
const { OrdersTab } = MarketMod;
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;
const { cancelOrderDialog } = await import('../src/utils/cancelOrderCopy.js');
const { gameReducer, orderCancelRefund } = await import('../packages/engine/src/reducer.mjs');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');

const seedSave = (save) => store.set('bbae_save_v2', JSON.stringify(save));
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const cardOf = (html, name) => {
  const i = html.indexOf(`>${name}<`);
  assert.ok(i > 0, `${name} card rendered`);
  const end = html.indexOf('aircraft-market-card', i);
  return text(html.slice(i, end > i ? end : undefined));
};
const money = (m) => Number(m[1].replace(/,/g, '')) * { K: 1e3, M: 1e6, B: 1e9 }[m[2]];
const close = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b)) < 0.01;

// Timely Takeoff-like: era calendar from 1970, no production lines.
const era = (over = {}) => ({ ...freshState(), phase: 'playing', hub: 'JFK', airlineName: 'Mine',
  cash: 5_000_000_000, startYear: 1970, year: 1, week: 5, starterDeliveriesUsed: 2, ...over });

console.log('\n── market');

test('an announced type shows preorder terms and a Preorder button, buy only', () => {
  seedSave(era());
  const html = render(React.createElement(Marketplace));
  assert.match(text(html), /Preorders · from January 1972/, 'badge');
  const card = cardOf(html, 'Lockheed L-1011 TriStar');
  assert.match(card, /each frame arrives, from January 1972/);
  assert.match(card, /In development\./);
  assert.match(card, /20% deposit now/);
  assert.match(card, /Early-bird 8% off/);
  assert.match(card, /Cancelling forfeits the deposit/);
  assert.match(card, /Preorder →/);
  assert.match(card, /Preorders are bought outright/);
  assert.doesNotMatch(card, /Not yet in service/);
});

test('a slipped programme says so on the card, with the refund', () => {
  seedSave(era({ year: 2, week: 40, programmeDelays: { l1011: { weeks: 30 } } }));
  const html = render(React.createElement(Marketplace));
  assert.match(text(html), /Preorders · from July 1972 · delayed/, 'badge');
  const card = cardOf(html, 'Lockheed L-1011 TriStar');
  assert.match(card, /running late/);
  assert.match(card, /cancelled for a full refund/);
});

test('a type more than two years out stays locked', () => {
  seedSave(era());
  assert.match(text(render(React.createElement(Marketplace))), /Not yet in service · 1973/, 'the 1973 Bandeirante is shown locked');
});

console.log('\n── checkout agrees with the reducer');

test('preorder checkout: deposit due now, balance later, delivery weeks — all as the reducer books them', () => {
  const s = era();
  seedSave(s);
  const html = text(render(React.createElement(AircraftCheckout, { typeId: 'l1011', mode: 'buy', onClose: () => {} })));
  const after = gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: 'l1011', quantity: 1, ownershipType: 'owned' });
  const placed = after.pendingOrders.slice(s.pendingOrders.length);
  const paid = s.cash - after.cash;
  assert.match(html, /Preorder\. The Lockheed L-1011 TriStar is still in development/);
  assert.match(html, /cancels that frame, and its deposit is lost/);
  const due = html.match(/Due now \$([\d.,]+)([KMB])/);
  assert.ok(due, 'due-now line shown');
  assert.ok(close(money(due), paid), `checkout says ${money(due)}, reducer charged ${paid}`);
  const bal = html.match(/20% deposit now · \$([\d.,]+)([KMB]) more as the frames arrive/);
  assert.ok(bal, 'balance line shown');
  assert.ok(close(money(bal), placed[0].balanceDue), `balance ${money(bal)} vs ${placed[0].balanceDue}`);
  const weeks = placed[0].deliverAbsWeek - absoluteWeek(s.year, s.week);
  assert.match(html, new RegExp(`${weeks}w`));
  assert.match(html, /📝 Preorder Lockheed L-1011 TriStar/);
});

console.log('\n── orders tab and cancel copy');

function preordered(over = {}) {
  const s0 = era(over);
  const s1 = gameReducer(s0, { type: 'ORDER_AIRCRAFT', typeId: 'l1011', quantity: 2, ownershipType: 'owned' });
  return { s1, mine: s1.pendingOrders.slice(s0.pendingOrders.length) };
}

test('the Orders tab shows deposit paid, the balance due, and the deposit-forfeit cancel', () => {
  const { s1, mine } = preordered();
  const html = text(renderToString(React.createElement(OrdersTab, {
    pendingOrders: s1.pendingOrders, year: s1.year, week: s1.week,
    onCancel: () => {}, onRename: () => {}, onBrowse: () => {} })));
  assert.match(html, /Deposit Paid/);
  assert.match(html, /Due on Delivery/);
  assert.match(html, /📝 Preorder/);
  assert.match(html, /Preorder Balances/);
  assert.match(html, /deposit forfeit\)/);
  const d = cancelOrderDialog(s1, mine[0]);
  assert.equal(d.refund, orderCancelRefund(s1, mine[0]).refund);
  assert.match(d.body, /not refundable/);
});

test('a slipped preorder shows the delay and the full refund, in the dialog too', () => {
  const { s1, mine } = preordered();
  const late = s1.pendingOrders.map(o => mine.some(m => m.id === o.id) ? { ...o, delayedWeeks: 30 } : o);
  const html = text(renderToString(React.createElement(OrdersTab, {
    pendingOrders: late, year: s1.year, week: s1.week,
    onCancel: () => {}, onRename: () => {}, onBrowse: () => {} })));
  assert.match(html, /Delayed 7 mo/);
  assert.match(html, /full refund — programme slipped/);
  const o = late.find(x => x.id === mine[0].id);
  const d = cancelOrderDialog({ ...s1, pendingOrders: late }, o);
  assert.equal(d.refund, orderCancelRefund(s1, o).refund);
  assert.equal(d.refund, o.totalPrice);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
