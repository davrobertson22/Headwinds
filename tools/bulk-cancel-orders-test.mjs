// Bulk cancel of aircraft orders (CANCEL_ORDER with orderIds).
//
// Discord (lkfht, 2026-11-12): "If possible, bulk cancel aircraft orders."
// An airline with forty frames on order had to open forty confirm dialogs.
// CANCEL_ORDER now takes a list: every order goes on its own terms (classic
// 95% / lease deposit back; production-line forfeits by nearness), firm
// launch-customer frames stay on the book, and the airline gets one refund
// and one toast. The Fleet ▸ On Order panel ticks orders; Market ▸ Orders
// cancels every order its filter shows.
//
//   node --import ./tools/_register-loader.mjs tools/bulk-cancel-orders-test.mjs

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
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { withFleetFacts, journalledPayload, publicPayload } = await import('../apps/headwinds-server/src/lib/publicDecisions.mjs');
const { buildNews } = await import('../apps/headwinds-server/src/lib/newsService.mjs');
const { fleetHeadline, describeFleetMove } = await import('../src/utils/fleetNews.js');
const COPY = await import('../src/utils/cancelOrderCopy.js');

const classic = () => ({ ...freshState(), hub: 'JFK', cash: 50_000_000_000 });
const lines = () => ({ ...classic(), productionLinesWorld: true, productionLineScale: 1 });
const nowAbs = (s) => absoluteWeek(s.year, s.week);
function order(st, typeId, quantity = 1, extra = {}) {
  spin();
  return gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: 'owned', ...extra });
}
// Cancel one at a time, the way a player had to: the yardstick for the bulk.
function oneByOne(s, ids) {
  for (const id of ids) s = gameReducer(s, { type: 'CANCEL_ORDER', orderId: id });
  return s;
}
const ids = (s) => s.pendingOrders.map(o => o.id);
const lastToast = (s) => (s.pendingToasts ?? []).at(-1);

// A book of mixed orders: purchases and leases of two types.
function classicBook() {
  let s = classic();
  s = order(s, 'b737800', 3);
  s = order(s, 'a320ceo', 2, { ownershipType: 'lease' });
  return s;
}
// Production lines: slots at different distances, so the forfeits differ.
function linesBook() {
  let s = lines();
  const now = nowAbs(s);
  s = order(s, 'b737800', 1, { slotFromWeek: now + 30 });
  s = order(s, 'b737800', 1, { slotFromWeek: now + 14 });
  s = order(s, 'a320ceo', 1, { slotFromWeek: now + 7 });
  s = order(s, 'a320ceo', 1, { ownershipType: 'lease', slotFromWeek: now + 28 });
  return s;
}

console.log('\nBulk cancel of aircraft orders\n');

section('the engine');

await test('classic world: cancelling the whole book at once refunds what one-by-one would', () => {
  const s = classicBook();
  assert.equal(s.pendingOrders.length, 5, 'fixture: five orders');
  const bulk = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: ids(s) });
  const single = oneByOne(s, ids(s));
  assert.equal(bulk.pendingOrders.length, 0, 'every order is off the book');
  assert.equal(bulk.cash, single.cash, 'same refund as cancelling each');
  assert.ok(bulk.cash > s.cash);
});

await test('production lines: each order keeps its own forfeit; the total matches one-by-one', () => {
  const s = linesBook();
  assert.equal(s.pendingOrders.length, 4, 'fixture: four orders');
  const bulk = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: ids(s) });
  const single = oneByOne(s, ids(s));
  assert.equal(bulk.pendingOrders.length, 0);
  assert.equal(bulk.cash, single.cash);
  const paid = s.pendingOrders.reduce((t, o) => t + (o.ownershipType === 'owned' ? o.totalPrice : o.leaseDeposit + (o.slotPremium ?? 0)), 0);
  assert.ok(bulk.cash - s.cash < paid, 'the near slots forfeited something');
});

await test('one toast for the batch, naming the count and the money', () => {
  const s = linesBook();
  const bulk = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: ids(s) });
  assert.equal((bulk.pendingToasts ?? []).length - (s.pendingToasts ?? []).length, 1);
  assert.equal(lastToast(bulk).title, 'Orders cancelled');
  assert.match(lastToast(bulk).message, /^4 orders off the book/);
  assert.match(lastToast(bulk).message, /Refunded .*forfeited/);
});

await test('only the orders asked for go; the rest stay', () => {
  const s = classicBook();
  const pick = ids(s).slice(0, 2);
  const bulk = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: pick });
  assert.deepEqual(ids(bulk), ids(s).slice(2));
  assert.equal(bulk.cash, oneByOne(s, pick).cash);
});

await test('firm launch-customer orders stay on the book and the toast says so', () => {
  let s = linesBook();
  const firmId = s.pendingOrders[0].id;
  s = { ...s, pendingOrders: s.pendingOrders.map(o => (o.id === firmId ? { ...o, launch: true } : o)) };
  const bulk = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: ids(s) });
  assert.deepEqual(ids(bulk), [firmId]);
  assert.equal(bulk.cash, oneByOne(s, ids(s).slice(1)).cash);
  assert.match(lastToast(bulk).message, /1 launch-customer order is firm/);
});

await test('a batch of only firm orders changes nothing but a warning', () => {
  let s = linesBook();
  s = { ...s, pendingOrders: s.pendingOrders.map(o => ({ ...o, launch: true })) };
  const bulk = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: ids(s) });
  assert.equal(bulk.cash, s.cash);
  assert.deepEqual(ids(bulk), ids(s));
  assert.equal(lastToast(bulk).type, 'warning');
});

await test('a list of one is the single cancel, toast and all', () => {
  const s = linesBook();
  const id = ids(s)[1];
  const a = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: [id] });
  const b = gameReducer(s, { type: 'CANCEL_ORDER', orderId: id });
  assert.equal(a.cash, b.cash);
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(a.pendingToasts, b.pendingToasts);
});

await test('unknown or duplicate ids are harmless', () => {
  const s = classicBook();
  assert.equal(gameReducer(s, { type: 'CANCEL_ORDER', orderIds: ['nope', 'nada'] }), s);
  assert.equal(gameReducer(s, { type: 'CANCEL_ORDER', orderIds: [] }), s);
  const id = ids(s)[0];
  const dup = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: [id, id, 'nope'] });
  assert.equal(dup.cash, gameReducer(s, { type: 'CANCEL_ORDER', orderId: id }).cash, 'refunded once');
});

section('the dialog quotes what the engine pays');

await test('cancelOrdersDialog: refund and firm count match the reducer', () => {
  assert.equal(typeof COPY.cancelOrdersDialog, 'function', 'cancelOrdersDialog is missing');
  for (const book of [classicBook(), linesBook()]) {
    let s = book;
    const firmId = s.pendingOrders[0].id;
    if (s.productionLinesWorld) s = { ...s, pendingOrders: s.pendingOrders.map(o => (o.id === firmId ? { ...o, launch: true } : o)) };
    const d = COPY.cancelOrdersDialog(s, s.pendingOrders);
    const after = gameReducer(s, { type: 'CANCEL_ORDER', orderIds: ids(s) });
    assert.equal(d.refund, after.cash - s.cash, s.productionLinesWorld ? 'lines' : 'classic');
    assert.equal(d.count, s.pendingOrders.length - after.pendingOrders.length);
    assert.equal(d.firm, s.productionLinesWorld ? 1 : 0);
    if (d.firm) assert.match(d.body, /firm/);
  }
});

section('multiplayer: guard, journal, news');

await test('the guard passes ids only, deduped, and bounds the batch', () => {
  const s = classicBook();
  const [a, b] = ids(s);
  assert.deepEqual(guardDecision('CANCEL_ORDER', { orderIds: [a, b, a, 7, ''], refund: 1e12 }, s), { orderIds: [a, b] });
  assert.deepEqual(guardDecision('CANCEL_ORDER', { orderId: a, refund: 1e12 }, s), { orderId: a });
  assert.throws(() => guardDecision('CANCEL_ORDER', { orderIds: [] }, s), /No orders/);
  assert.throws(() => guardDecision('CANCEL_ORDER', { orderIds: Array.from({ length: 501 }, (_, i) => `o${i}`) }, s), /Too many/);
});

const NAMES = { b737800: 'Boeing 737-800', a320ceo: 'Airbus A320' };
const typeName = (id) => NAMES[id] ?? id;

await test('a bulk cancel across types is journalled by type, as executed', () => {
  const s = classicBook();
  const payload = { orderIds: ids(s) };
  const next = gameReducer(s, { type: 'CANCEL_ORDER', ...payload });
  const f = withFleetFacts('CANCEL_ORDER', payload, s, next);
  assert.equal(f.moved, true);
  assert.deepEqual(f.journalled.byType, { b737800: 3, a320ceo: 2 });
  assert.equal(f.journalled.cancelled, 5);
  const pub = publicPayload({ type: 'CANCEL_ORDER', payload: f.journalled });
  assert.deepEqual(pub.byType, { b737800: 3, a320ceo: 2 });
  assert.equal(pub.orderIds, undefined, 'order ids are never published');
  assert.match(describeFleetMove({ type: 'CANCEL_ORDER', payload: pub }, typeName), /Cancelled orders for .*737-800.*A320|Cancelled orders for .*A320.*737-800/);
});

await test('one type keeps the single-cancel shape; firm orders are not counted', () => {
  let s = linesBook();
  const firmId = s.pendingOrders[0].id;
  s = { ...s, pendingOrders: s.pendingOrders.map(o => (o.id === firmId ? { ...o, launch: true } : o)) };
  const payload = { orderIds: ids(s).slice(0, 2) };
  const next = gameReducer(s, { type: 'CANCEL_ORDER', ...payload });
  const f = withFleetFacts('CANCEL_ORDER', payload, s, next);
  assert.equal(f.journalled.typeId, 'b737800');
  assert.equal(f.journalled.cancelled, 1, 'the firm frame stayed');
});

await test('the news feed nets a bulk cancel against the week\'s orders', async () => {
  const s0 = classic();
  const s1 = order(s0, 'b737800', 3);
  const s2 = order(s1, 'a320ceo', 2);
  const rows = [];
  let n = 0;
  const decide = (before, type, payload) => {
    const next = gameReducer(before, { type, ...payload });
    const facts = withFleetFacts(type, payload, before, next);
    rows.push({ id: `d${n}`, worldId: 'w1', airlineId: 'a1', week: 72, type,
      payload: journalledPayload(facts.journalled, { changed: next !== before && facts.moved }),
      createdAt: new Date(Date.now() - (1000 - n++) * 1000) });
    return next;
  };
  let s = decide(s0, 'ORDER_AIRCRAFT', { typeId: 'b737800', quantity: 3, ownershipType: 'owned' });
  spin();
  s = decide(s, 'ORDER_AIRCRAFT', { typeId: 'a320ceo', quantity: 2, ownershipType: 'owned' });
  s = decide(s, 'CANCEL_ORDER', { orderIds: [...s.pendingOrders.filter(o => o.typeId === 'a320ceo').map(o => o.id), s.pendingOrders[0].id] });
  const table = (r) => ({ findMany: async ({ where = {} } = {}) => r.filter((x) => !where.type?.in || where.type.in.includes(x.type)) });
  const prisma = {
    decision: table(rows),
    airline: table([{ id: 'a1', name: 'Air Canada', hub: 'YYZ', createdAt: new Date(0), joinedWeek: 1, account: {} }]),
    alliance: table([]), allianceMember: table([]), gateAuction: table([]), gateListing: table([]),
    usedAircraftListing: table([]), worldNews: table([]),
  };
  const { items } = await buildNews(prisma, { world: { id: 'w1', currentWeek: 20, currentYear: 2, weeksPerDay: 6, endedAt: null }, categories: ['fleet'] });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].data.byType, { b737800: 2 }, 'three ordered, one cancelled; both A320s gone');
  assert.match(fleetHeadline(items[0].kind, items[0].data, typeName), /ordered 2× Boeing 737-800/);
});

section('the screens');

await test('Market ▸ Orders offers to cancel every order shown', async () => {
  const { OrdersTab } = await import('../src/components/Marketplace.jsx');
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  assert.ok(OrdersTab, 'OrdersTab is not exported');
  const s = classicBook();
  store.set('bbae_save_v2', JSON.stringify(s));
  const render = (extra) => renderToString(React.createElement(GameProvider, null,
    React.createElement(OrdersTab, { pendingOrders: s.pendingOrders, year: s.year, week: s.week,
      onCancel() {}, onRename() {}, onBrowse() {}, ...extra })));
  const html = render({ onCancelMany() {} });
  assert.match(html, /data-order-cancel-shown/);
  assert.match(html.replace(/<!-- -->/g, ''), /Cancel all 5 shown/);
  assert.doesNotMatch(render({}), /data-order-cancel-shown/, 'no handler, no button');
});

await test('Fleet renders with orders on the book (bulk bar wired in)', async () => {
  const Fleet = (await import('../src/components/Fleet.jsx')).default;
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  const s = classicBook();
  store.set('bbae_save_v2', JSON.stringify(s));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(Fleet)));
  assert.match(html, /On Order/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
