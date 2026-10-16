// Production lines: shared delivery slots, early-slot pricing, cancel forfeits,
// launch customers, and the world order board.
//
// Design: claude/aircraft-production-lines.md (Discord: VodkaOnFire, 2026-10-16).
// Every reducer case below runs through gameReducer, so on HEAD (no production
// lines) they fail on their own terms: HEAD stacks a private +lead per type,
// ignores rivals' bookings and slotFromWeek, refunds 95% / full deposit, and
// refuses every not-yet-flying type.
//
//   node --import ./tools/_register-loader.mjs tools/production-lines-test.mjs

import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const { gameReducer, freshState, orderDenial } = await import('../packages/engine/src/reducer.mjs');
const { getAircraftType, eraPurchasePrice, orderDiscount, AIRCRAFT_TYPES } = await import('../packages/engine/src/data/aircraft.js');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');
const L = await import('../packages/engine/src/data/productionLines.js').catch(() => null);
const needL = () => assert.ok(L, 'packages/engine/src/data/productionLines.js does not exist');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }
function spin() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

const T = (id) => { const t = getAircraftType(id); assert.ok(t, `no type ${id}`); return t; };
const classic = () => ({ ...freshState(), hub: 'JFK', cash: 50_000_000_000 });
const lines = (extra = {}) => ({ ...classic(), productionLinesWorld: true, productionLineScale: 1, ...extra });
const nowAbs = (s) => absoluteWeek(s.year, s.week);
function order(st, typeId, quantity = 1, extra = {}) {
  spin();
  return gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: 'owned', ...extra });
}
const added = (before, after) => after.pendingOrders.slice(before.pendingOrders.length);
const weeks = (orders) => orders.map(o => o.deliverAbsWeek);

section('line table');

test('every catalogue type is on a production line', () => {
  needL();
  assert.deepEqual(L.unmappedTypes(), []);
  const seen = new Map();
  for (const [id, line] of Object.entries(L.PRODUCTION_LINES)) {
    for (const t of line.types) {
      assert.ok(getAircraftType(t), `${id} lists unknown type ${t}`);
      assert.ok(!seen.has(t), `${t} is on ${seen.get(t)} and ${id}`);
      seen.set(t, id);
    }
  }
  assert.equal(seen.size, AIRCRAFT_TYPES.length);
});

test('variants share a line; generations do not', () => {
  needL();
  assert.equal(L.lineOf('b737700'), L.lineOf('b737900er'));
  assert.notEqual(L.lineOf('b737800'), L.lineOf('b737max8'));
  assert.notEqual(L.lineOf('a320ceo'), L.lineOf('a320neo'));
});

test('factory freighters ride the parent line; conversions get their own', () => {
  needL();
  assert.equal(L.lineOf('b777f'), L.lineOf('b777300er'));
  assert.equal(L.lineOf('b7478f'), L.lineOf('b7478i'));
  for (const id of ['b737800bcf', 'a321p2f', 'b767200sf', 'e190f', 'dc873f', 'b737400f']) {
    assert.equal(L.lineInfo(L.lineOf(id)).cls, 'Conversion', id);
  }
});

test('capacity: bigger aircraft, fewer slots; scaled by world size; ramps on backlog', () => {
  needL();
  const cap = (t, o) => L.lineCapacity(L.lineOf(t), o);
  assert.equal(cap('atr72'), 10);
  assert.equal(cap('b737800'), 8);
  assert.equal(cap('b7879'), 5);
  assert.equal(cap('a380'), 3);
  assert.equal(cap('b767200sf'), 2);
  assert.equal(cap('b7879', { scale: 0.6 }), 3);
  assert.equal(cap('b7879', { scale: 1.5 }), 8);
  assert.equal(cap('b7879', { backlogFrames: 5 * 26 }), 5, 'exactly 26 weeks of backlog: no ramp yet');
  assert.equal(cap('b7879', { backlogFrames: 5 * 27 }), 6);
  assert.equal(cap('b7879', { backlogFrames: 5 * 200 }), 8, 'never past the ceiling');
  assert.equal(L.capacityScale(10), 0.6);
  assert.equal(L.capacityScale(500), 1.5);
});

section('your deliveries off a line are spaced by the class gap');

test('a 5-frame narrow-body order arrives every 3 weeks from the standard week', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 5);
  const w = weeks(added(s0, s1));
  const std = nowAbs(s0) + 6;
  assert.deepEqual(w, [std, std + 3, std + 6, std + 9, std + 12]);
  assert.ok(added(s0, s1).every(o => o.lineId === 'b737ng'), 'orders carry their line');
});

test('parallel variants do not dodge the gap', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 2);
  const s2 = order(s1, 'b737700', 2);
  const s3 = order(s2, 'b737900er', 2);
  const all = weeks(s3.pendingOrders).sort((a, b) => a - b);
  for (let i = 1; i < all.length; i++) assert.ok(all[i] - all[i - 1] >= 3, `frames ${all[i - 1]} and ${all[i]} closer than 3 weeks`);
});

test('no four A380s in a month: double-deck frames come at least 5 weeks apart', () => {
  needL();
  assert.equal(L.lineGapWeeks('a380'), 5);
  assert.equal(L.lineGapWeeks('b747'), 5, 'the 747-400F on the same line keeps the jumbo gap');
  assert.equal(L.lineGapWeeks('atr'), 1);
  const s0 = lines();
  const s1 = order(s0, 'a380', 4);
  const w = weeks(added(s0, s1));
  const std = nowAbs(s0) + 10;
  assert.deepEqual(w, [std, std + 5, std + 10, std + 15]);
});

test('an early slot still respects the gap to a frame you already hold', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1);
  const s2 = order(s1, 'b737800', 1, { slotFromWeek: nowAbs(s0) + 3 });
  assert.equal(added(s1, s2)[0].deliverAbsWeek, nowAbs(s0) + 3, '3 weeks before the held frame is allowed');
  const s3 = order(s2, 'b737800', 1, { slotFromWeek: nowAbs(s0) + 4 });
  assert.equal(added(s2, s3)[0].deliverAbsWeek, nowAbs(s0) + 9, 'squeezed out until 3 weeks past the last one');
});

test('a different line is independent', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1);
  const s2 = order(s1, 'a320neo', 1);
  assert.equal(s2.pendingOrders[0].deliverAbsWeek, s2.pendingOrders[1].deliverAbsWeek);
});

test("rivals' bookings fill the line: a full week is skipped", () => {
  const s = lines();
  const std = nowAbs(s) + 6;
  const s0 = { ...s, lineBook: { scale: 1, bookings: { b737ng: { [std]: 8, [std + 1]: 7 } } } };
  const s1 = order(s0, 'b737800', 2);
  assert.deepEqual(weeks(added(s0, s1)), [std + 1, std + 4]);
});

test('classic worlds keep the private per-type stagger', () => {
  const s0 = classic();
  const s1 = order(s0, 'b737800', 3);
  const n = nowAbs(s0);
  assert.deepEqual(weeks(added(s0, s1)), [n + 6, n + 9, n + 12]);
  assert.equal(added(s0, s1)[0].lineId, undefined);
});

test('a requested start more than 26 weeks past the standard week is pulled in', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1, { ownershipType: 'lease', slotFromWeek: nowAbs(s0) + 200 });
  assert.equal(added(s0, s1)[0].deliverAbsWeek, nowAbs(s0) + 6 + 26);
});

section('early slots cost extra');

test('the earliest slot is +25% of list, the standard week is list', () => {
  const s0 = lines();
  const t = T('b737800');
  const list = eraPurchasePrice(t);
  const early = order(s0, 'b737800', 1, { slotFromWeek: nowAbs(s0) + 3 });
  const o = added(s0, early)[0];
  assert.equal(o.deliverAbsWeek, nowAbs(s0) + 3);
  assert.equal(o.slotPremium, Math.round(list * 0.25));
  assert.equal(o.totalPrice, list + Math.round(list * 0.25), 'premium is in the price (and so the cost basis)');
  assert.equal(s0.cash - early.cash, o.totalPrice);
  const std = order(s0, 'b737800', 1);
  assert.equal(added(s0, std)[0].slotPremium, 0);
  assert.equal(added(s0, std)[0].totalPrice, list);
});

test('the premium falls linearly to zero at the standard week', () => {
  needL();
  const t = T('b737800');
  const n = 100;
  assert.equal(L.slotPremiumPct(t, n + 3, n), 0.25);
  assert.equal(L.slotPremiumPct(t, n + 4, n), Math.round(0.25 * 2 / 3 * 10000) / 10000);
  assert.equal(L.slotPremiumPct(t, n + 5, n), Math.round(0.25 * 1 / 3 * 10000) / 10000);
  assert.equal(L.slotPremiumPct(t, n + 6, n), 0);
  assert.equal(L.slotPremiumPct(t, n + 1, n), 0.25, 'before the build time clamps to the earliest week');
});

test('a slot can never be earlier than the build time', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1, { slotFromWeek: nowAbs(s0) - 50 });
  assert.equal(added(s0, s1)[0].deliverAbsWeek, nowAbs(s0) + 3);
});

test('a lease can buy an early slot: the premium is a one-off fee on top of the deposit', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1, { ownershipType: 'lease', slotFromWeek: nowAbs(s0) + 3 });
  const o = added(s0, s1)[0];
  assert.equal(o.slotPremium, Math.round(eraPurchasePrice(T('b737800')) * 0.25));
  assert.equal(s0.cash - s1.cash, o.leaseDeposit + o.slotPremium);
});

section('cancelling');

function cancelAt(weeksOut, ownershipType = 'owned') {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1, { ownershipType, slotFromWeek: nowAbs(s0) + weeksOut });
  const o = added(s0, s1)[0];
  assert.equal(o.deliverAbsWeek - nowAbs(s0), weeksOut);
  const s2 = gameReducer(s1, { type: 'CANCEL_ORDER', orderId: o.id });
  return { o, refund: s2.cash - s1.cash, after: s2 };
}

test('owned: 5% forfeit beyond a year, 10% / 20% / 30% as the slot nears', () => {
  // Beyond a year out is only reachable by a long order spilling forward (a
  // requested start is capped), so that tier is checked on the terms directly.
  needL();
  const far = L.cancelTerms({ ownershipType: 'owned', totalPrice: 1_000_000, deliverAbsWeek: 160 }, 100);
  assert.equal(far.refund, 950_000);
  for (const [w, pct] of [[32, 0.10], [26, 0.10], [25, 0.20], [13, 0.20], [12, 0.30], [6, 0.30]]) {
    const { o, refund, after } = cancelAt(w);
    assert.equal(refund, o.totalPrice - Math.round(o.totalPrice * pct), `${w} weeks out`);
    assert.equal(after.pendingOrders.length, 0);
  }
});

test('lease: deposit back 26+ weeks out, forfeit inside that', () => {
  const far = cancelAt(26, 'lease');
  assert.equal(far.refund, far.o.leaseDeposit);
  const near = cancelAt(25, 'lease');
  assert.equal(near.refund, 0);
});

test('classic worlds keep 95% / full lease refund', () => {
  const s0 = classic();
  const s1 = order(s0, 'b737800', 1);
  const o = added(s0, s1)[0];
  const s2 = gameReducer(s1, { type: 'CANCEL_ORDER', orderId: o.id });
  assert.equal(s2.cash - s1.cash, Math.round(o.totalPrice * 0.95));
});

test('a cancelled slot is free again for the next order', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1);
  const first = added(s0, s1)[0];
  const s2 = gameReducer(s1, { type: 'CANCEL_ORDER', orderId: first.id });
  const s3 = order(s2, 'b737800', 1);
  assert.equal(added(s2, s3)[0].deliverAbsWeek, first.deliverAbsWeek);
});

section('launch customers (era worlds)');

// 777-9 enters service in 2027 → announced January 2025, window 26 weeks.
const era = (extra = {}) => lines({ startYear: 2025, year: 1, week: 5, ...extra });

test('an announced type is open to launch customers only', () => {
  const d = orderDenial(era(), 'b7779x');
  assert.equal(d?.code, 'launch_only');
  assert.equal(d.minQty, 20);
  assert.equal(orderDenial(era({ week: 27 }), 'b7779x')?.code, 'not_yet_flying', 'window closed');
  assert.equal(orderDenial(era({ productionLinesWorld: undefined }), 'b7779x')?.code, 'not_yet_flying', 'no lines, no launch');
});

test('below the minimum, or leased, the launch order is refused', () => {
  const s0 = era();
  assert.equal(order(s0, 'b7779x', 19).pendingOrders.length, 0);
  assert.equal(order(s0, 'b7779x', 20, { ownershipType: 'lease' }).pendingOrders.length, 0);
});

test('a launch order delivers from January of the EIS year, wide-body gap apart, discounted and firm', () => {
  const s0 = era();
  const s1 = order(s0, 'b7779x', 20);
  const placed = added(s0, s1);
  assert.equal(placed.length, 20);
  const eisAbs = absoluteWeek(3, 1);
  assert.deepEqual(weeks(placed), Array.from({ length: 20 }, (_, i) => eisAbs + 4 * i));
  const disc = orderDiscount(20) + 0.08;
  const list = eraPurchasePrice(T('b7779x'), 2025);
  assert.ok(Math.abs(placed[0].totalPrice - Math.round(list * (1 - disc))) <= 1, `price ${placed[0].totalPrice} vs ${Math.round(list * (1 - disc))}`);
  assert.ok(placed.every(o => o.launch === true && o.slotPremium === 0));
  assert.equal(s1.launchPrograms?.b7779x?.manufacturer, 'Boeing');
  const s2 = gameReducer(s1, { type: 'CANCEL_ORDER', orderId: placed[0].id });
  assert.equal(s2.pendingOrders.length, 20, 'launch frames cannot be cancelled');
  assert.equal(s2.cash, s1.cash);
});

test('repeat launch programmes with the same maker earn +2%, capped at 25% in total', () => {
  needL();
  const s1 = order(era(), 'b7779x', 20);
  const t = T('b737max10');
  assert.equal(L.launchDiscount(s1, t), 0.10);
  assert.equal(L.launchOrderDiscount(s1, t, 30), orderDiscount(30) + 0.10);
  assert.equal(L.launchOrderDiscount(s1, t, 100), 0.25);
  assert.equal(L.launchDiscount(s1, T('a350f')), 0.08, 'another maker starts over');
});

test('a launch order that cannot be paid in full is not trimmed below the minimum', () => {
  const s0 = era({ cash: eraPurchasePrice(T('b7779x'), 2025) * 5 });
  const s1 = order(s0, 'b7779x', 20);
  assert.equal(s1.pendingOrders.length, 0);
  assert.equal(s1.cash, s0.cash);
});

section('server race check');

test('a new order landing on a week the rivals have filled is a conflict', () => {
  needL();
  const pending = [{ id: 'n1', typeId: 'b7879', deliverAbsWeek: 50, lineId: 'b787' }];
  assert.deepEqual(L.lineConflicts({ othersBookings: { b787: { 50: 5 } }, pendingOrders: pending, newOrderIds: ['n1'], absWeek: 10 }),
    [{ lineId: 'b787', week: 50 }]);
  assert.deepEqual(L.lineConflicts({ othersBookings: { b787: { 50: 4 } }, pendingOrders: pending, newOrderIds: ['n1'], absWeek: 10 }), []);
});

test('a new frame inside the gap to one of your own is a conflict', () => {
  needL();
  const pending = [
    { id: 'old', typeId: 'b7878', deliverAbsWeek: 50, lineId: 'b787' },
    { id: 'n1', typeId: 'b7879', deliverAbsWeek: 53, lineId: 'b787' },
  ];
  assert.equal(L.lineConflicts({ pendingOrders: pending, newOrderIds: ['n1'], absWeek: 10 }).length, 1, '3 weeks < the 4-week wide-body gap');
  pending[1].deliverAbsWeek = 54;
  assert.equal(L.lineConflicts({ pendingOrders: pending, newOrderIds: ['n1'], absWeek: 10 }).length, 0);
});

test('two of your own frames in one week on one line is a conflict', () => {
  needL();
  const pending = [
    { id: 'old', typeId: 'b7878', deliverAbsWeek: 50, lineId: 'b787' },
    { id: 'n1', typeId: 'b7879', deliverAbsWeek: 50, lineId: 'b787' },
  ];
  assert.equal(L.lineConflicts({ pendingOrders: pending, newOrderIds: ['n1'], absWeek: 10 }).length, 1);
});

test('used-market deliveries never occupy a line', () => {
  needL();
  const b = L.bookingsFromStates([{ pendingOrders: [
    { typeId: 'b7879', deliverAbsWeek: 40, used: true },
    { typeId: 'b7879', deliverAbsWeek: 40 },
  ] }], 0);
  assert.deepEqual(b, { b787: { 40: 1 } });
});

section('order board');

test('world totals merge rivals with your own fleet and orders', () => {
  needL();
  const s = {
    ...classic(),
    airlineName: 'Mine',
    fleet: [{ id: 'a', typeId: 'a380', status: 'active' }, { id: 'b', typeId: 'a380', status: 'retired' }],
    pendingOrders: [{ id: 'p', typeId: 'a380', deliverAbsWeek: 20 }, { id: 'u', typeId: 'a380', used: true, deliverAbsWeek: 3 }],
    competitors: [{ id: 'human:x', name: 'Rival X', fleetMix: { a380: [10, 4], b7879: [2, 0] } }],
  };
  const board = L.worldFleetBoard(s);
  assert.equal(board.a380.inService, 11);
  assert.equal(board.a380.onOrder, 5);
  assert.deepEqual(board.a380.customers.map(c => c.name), ['Rival X', 'Mine']);
  assert.equal(board.b7879.inService, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
