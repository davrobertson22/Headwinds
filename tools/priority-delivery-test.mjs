// Priority delivery on production-line worlds (Discord: Barca, 2026-11-05 —
// "the slot fee only affects the first plane's arrival").
//
// The old early-slot fee priced how SOON a week was, not how scarce the line
// was: on a busy line the near weeks were already full (paying could not get
// you past them), and on a quiet line your own delivery gap meant only one
// frame could ever sit in the paid window. Priority delivery replaces it:
//
//   • each line holds back a share of every week's frames (priorityReserve) —
//     standard (list) orders cannot book it until the week is within the
//     standard window; priority orders can;
//   • priority frames start from the build time and come one week tighter
//     than the class gap (priorityGapWeeks);
//   • each priority frame pays per week it arrives ahead of where a list order
//     would have put it (25% of list ÷ lead, per week), capped at 50% of list.
//
//   node --import ./tools/_register-loader.mjs tools/priority-delivery-test.mjs

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

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { getAircraftType, eraPurchasePrice } = await import('../packages/engine/src/data/aircraft.js');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');
const L = await import('../packages/engine/src/data/productionLines.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }
function spin() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }
const has = (name) => assert.equal(typeof L[name], 'function', `productionLines.${name} does not exist`);

const lines = (extra = {}) => ({ ...freshState(), hub: 'JFK', cash: 50_000_000_000, productionLinesWorld: true, productionLineScale: 1, ...extra });
const nowAbs = (s) => absoluteWeek(s.year, s.week);
function order(st, typeId, quantity = 1, extra = {}) {
  spin();
  return gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: 'owned', ...extra });
}
const added = (before, after) => after.pendingOrders.slice(before.pendingOrders.length);
const weeks = (orders) => orders.map(o => o.deliverAbsWeek);
const list737 = () => eraPurchasePrice(getAircraftType('b737800'));
const pctOf = (o) => Math.round(o.slotPremium / list737() * 10000) / 10000;
/** Fill weeks [from, to] on a line with `n` rival frames each. */
const busy = (s, line, from, to, n, over = {}) => {
  const b = {};
  for (let w = from; w <= to; w++) b[w] = n;
  return { ...s, lineBook: { scale: 1, bookings: { [line]: { ...b, ...over } } } };
};

section('the held-back share');

test('a line holds back a fifth of its weekly frames (none on a 1–2 frame line)', () => {
  has('priorityReserve');
  assert.equal(L.priorityReserve(8), 2);
  assert.equal(L.priorityReserve(5), 1);
  assert.equal(L.priorityReserve(3), 1);
  assert.equal(L.priorityReserve(2), 0);
  assert.equal(L.priorityReserve(1), 0);
  assert.equal(L.priorityReserve(16), 3);
});

test('a standard order cannot book the held-back frames past the standard week', () => {
  const s = lines();
  const std = nowAbs(s) + 6;
  const s0 = { ...s, lineBook: { scale: 1, bookings: { b737ng: { [std + 1]: 6 } } } };
  const s1 = order(s0, 'b737800', 1, { slotFromWeek: std + 1 });
  assert.equal(added(s0, s1)[0].deliverAbsWeek, std + 2, '6 of 8 booked = the list share is full');
});

test('inside the standard window the held-back frames open to everyone', () => {
  const s = lines();
  const std = nowAbs(s) + 6;
  const s0 = { ...s, lineBook: { scale: 1, bookings: { b737ng: { [std]: 7 } } } };
  assert.equal(added(s0, order(s0, 'b737800', 1))[0].deliverAbsWeek, std);
});

test('a standard order no longer buys an early week: it starts at the standard week, at list', () => {
  const s0 = lines();
  const o = added(s0, order(s0, 'b737800', 1, { slotFromWeek: nowAbs(s0) + 3 }))[0];
  assert.equal(o.deliverAbsWeek, nowAbs(s0) + 6);
  assert.equal(o.slotPremium, 0);
  assert.equal(o.priority, undefined);
});

section('priority on a quiet line');

test('priority frames start at the build time and come one week tighter than the gap', () => {
  has('priorityGapWeeks');
  assert.equal(L.priorityGapWeeks('b737ng'), 2);
  assert.equal(L.priorityGapWeeks('a380'), 4, 'still no four A380s in a month');
  assert.equal(L.priorityGapWeeks('atr'), 1);
  const s0 = lines();
  const n = nowAbs(s0);
  const placed = added(s0, order(s0, 'b737800', 6, { priority: true }));
  assert.deepEqual(weeks(placed), [n + 3, n + 5, n + 7, n + 9, n + 11, n + 13]);
  assert.ok(placed.every(o => o.priority === true && o.lineId === 'b737ng'));
});

test('the first frame pays today\'s +25%; each later one pays for its one week saved', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 3, { priority: true });
  const placed = added(s0, s1);
  assert.deepEqual(placed.map(pctOf), [0.25, 0.0833, 0.0833]);
  const list = list737();
  assert.equal(placed[0].slotPremium, Math.round(list * 0.25));
  assert.equal(s0.cash - s1.cash, placed.reduce((a, o) => a + o.totalPrice, 0), 'the fee is in the price you pay');
});

test('a turboprop line (1-week gap) charges only for the first frame', () => {
  const s0 = lines();
  const placed = added(s0, order(s0, 'atr72', 3, { priority: true }));
  const n = nowAbs(s0);
  assert.deepEqual(weeks(placed), [n + 1, n + 2, n + 3]);
  assert.ok(placed[0].slotPremium > 0);
  assert.equal(placed[1].slotPremium, 0);
  assert.equal(placed[2].slotPremium, 0);
});

test('a lease pays the priority fee as a one-off on top of the deposit', () => {
  const s0 = lines();
  const s1 = order(s0, 'b737800', 1, { ownershipType: 'lease', priority: true });
  const o = added(s0, s1)[0];
  assert.equal(o.deliverAbsWeek, nowAbs(s0) + 3);
  assert.equal(o.slotPremium, Math.round(list737() * 0.25));
  assert.equal(s0.cash - s1.cash, o.leaseDeposit + o.slotPremium);
});

section('priority on a busy line');

test('priority jumps a backlog the standard queue cannot, at the 50% cap', () => {
  const s = lines();
  const n = nowAbs(s);
  const s0 = busy(s, 'b737ng', n + 1, n + 30, 6, { [n + 6]: 8 });
  const std = added(s0, order(s0, 'b737800', 1))[0];
  assert.equal(std.deliverAbsWeek, n + 31, 'list waits for the backlog to clear');
  const pri = added(s0, order(s0, 'b737800', 2, { priority: true }));
  assert.deepEqual(weeks(pri), [n + 3, n + 5]);
  assert.deepEqual(pri.map(pctOf), [0.5, 0.5]);
});

test('the fee scales with the weeks skipped: a short backlog costs less', () => {
  has('priorityFeePct');
  const t = getAircraftType('b737800');
  assert.equal(L.priorityFeePct(t, 0), 0);
  assert.equal(L.priorityFeePct(t, 3), 0.25);
  assert.equal(L.priorityFeePct(t, 5), 0.4167);
  assert.equal(L.priorityFeePct(t, 40), 0.5);
  assert.equal(L.priorityFeePct(getAircraftType('b7879'), 4), 0.25, 'wide body: 25% buys 4 weeks');
});

test('priority still cannot take a week the line has filled', () => {
  const s = lines();
  const n = nowAbs(s);
  const s0 = busy(s, 'b737ng', n + 3, n + 4, 8);
  assert.equal(added(s0, order(s0, 'b737800', 1, { priority: true }))[0].deliverAbsWeek, n + 5);
});

section('mixing with frames you already hold');

test('priority frames keep the tighter gap to your held frames; list frames keep the full gap', () => {
  const s0 = lines();
  const n = nowAbs(s0);
  const s1 = order(s0, 'b737800', 1);
  assert.equal(added(s0, s1)[0].deliverAbsWeek, n + 6);
  const s2 = order(s1, 'b737800', 2, { priority: true });
  assert.deepEqual(weeks(added(s1, s2)), [n + 3, n + 8]);
  const s3 = order(s2, 'b737800', 1);
  assert.equal(added(s2, s3)[0].deliverAbsWeek, n + 11);
});

section('server race check');

test('a new list frame in the held-back share is a conflict; a priority frame there is not', () => {
  const list = [{ id: 'n1', typeId: 'b737800', deliverAbsWeek: 50, lineId: 'b737ng' }];
  const args = { othersBookings: { b737ng: { 50: 6 } }, newOrderIds: ['n1'], absWeek: 10 };
  assert.equal(L.lineConflicts({ ...args, pendingOrders: list }).length, 1, '7 of 8 with only 6 open to list');
  assert.equal(L.lineConflicts({ ...args, pendingOrders: [{ ...list[0], priority: true }] }).length, 0);
  assert.equal(L.lineConflicts({ ...args, othersBookings: { b737ng: { 50: 7 } }, pendingOrders: [{ ...list[0], priority: true }] }).length, 0);
  assert.equal(L.lineConflicts({ ...args, othersBookings: { b737ng: { 50: 8 } }, pendingOrders: [{ ...list[0], priority: true }] }).length, 1);
});

test('the race check opens the held-back share inside the standard window', () => {
  const pending = [{ id: 'n1', typeId: 'b737800', deliverAbsWeek: 16, lineId: 'b737ng' }];
  assert.equal(L.lineConflicts({ othersBookings: { b737ng: { 16: 7 } }, pendingOrders: pending, newOrderIds: ['n1'], absWeek: 10 }).length, 0);
});

test('priority frames two weeks apart pass the race check; list frames two apart do not', () => {
  const mk = (priority) => [
    { id: 'a', typeId: 'b737800', deliverAbsWeek: 50, lineId: 'b737ng', ...(priority ? { priority } : {}) },
    { id: 'b', typeId: 'b737800', deliverAbsWeek: 52, lineId: 'b737ng', ...(priority ? { priority } : {}) },
  ];
  assert.equal(L.lineConflicts({ pendingOrders: mk(true), newOrderIds: ['a', 'b'], absWeek: 10 }).length, 0);
  assert.equal(L.lineConflicts({ pendingOrders: mk(false), newOrderIds: ['a', 'b'], absWeek: 10 }).length, 2);
});

section('server guard');

const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
test('the guard passes priority through only as a real boolean', () => {
  assert.equal(guardDecision('ORDER_AIRCRAFT', { typeId: 'b737800', priority: true }, {}).priority, true);
  assert.equal(guardDecision('ORDER_AIRCRAFT', { typeId: 'b737800', priority: 'yes' }, {}).priority, false);
  assert.equal('priority' in guardDecision('ORDER_AIRCRAFT', { typeId: 'b737800' }, {}), false);
});

section('market summary');

test('lineStatus reports the priority slot and its fee next to the list slot', () => {
  const s = lines();
  const n = nowAbs(s);
  const st = L.lineStatus(busy(s, 'b737ng', n + 1, n + 10, 6, { [n + 6]: 8 }), 'b737800', n);
  assert.equal(st.nextStandard, n + 11);
  assert.equal(st.nextPriority, n + 3);
  assert.equal(st.priorityPct, 0.5);
  assert.equal(st.reserve, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
