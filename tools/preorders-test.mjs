// Preorders for aircraft still in development (Discord: Kat the Fox,
// "Preorders for progressing times", 2026-11-12).
//
// Era worlds, live ones included: a type is announced two years before it
// enters service, and from then until its first delivery anyone may preorder
// it — bought outright, any quantity, 20% deposit now and the balance as each
// frame arrives. An early-bird discount (up to 8%) slides to nothing at entry
// into service. A programme can slip 26–52 weeks; the slip is revealed half a
// year before entry into service, pushes every frame back, and lets customers
// walk away with a full refund. Production-line worlds keep the strict launch
// window for the first 26 weeks; preorders open to everyone after it.
//
// On HEAD every case below fails on its own terms: HEAD refuses every
// not-yet-flying type outside a production-line world's launch window, charges
// the full price at order, and has no programme delays.
//
//   node --import ./tools/_register-loader.mjs tools/preorders-test.mjs

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

const { gameReducer, freshState, orderDenial, orderCancelRefund } = await import('../packages/engine/src/reducer.mjs');
const { getAircraftType, orderDiscount } = await import('../packages/engine/src/data/aircraft.js');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');
const P = await import('../packages/engine/src/data/preorders.js').catch(() => null);
const needP = () => assert.ok(P, 'packages/engine/src/data/preorders.js does not exist');
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }
function spin() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

const T = (id) => { const t = getAircraftType(id); assert.ok(t, `no type ${id}`); return t; };
// A Timely Takeoff-like world: era calendar from 1970, classic private queues.
// The TriStar enters service in 1972 → announced 1970 W1 (abs 1), EIS abs 105.
const era = (extra = {}) => ({ ...freshState(), phase: 'playing', hub: 'JFK', cash: 5_000_000_000,
  startYear: 1970, year: 1, week: 5, starterDeliveriesUsed: 2, ...extra });
const linesEra = (extra = {}) => era({ productionLinesWorld: true, productionLineScale: 1, ...extra });
const EIS = absoluteWeek(3, 1);
function order(st, typeId, quantity = 1, extra = {}) {
  spin();
  return gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: 'owned', ...extra });
}
const added = (before, after) => after.pendingOrders.slice(before.pendingOrders.length);
const weeks = (orders) => orders.map(o => o.deliverAbsWeek);
const tick = (s, extra = {}) => gameReducer(s, { type: 'ADVANCE_WEEK', ...extra });

section('who can preorder what');

test('an announced type in an era world without production lines is open to preorders', () => {
  const d = orderDenial(era(), 'l1011');
  assert.equal(d?.code, 'preorder');
  assert.equal(d.firstDeliveryAbs, EIS);
});

test('a type more than two years out is still locked; classic worlds are untouched', () => {
  assert.equal(orderDenial(era(), 'dc950')?.code, 'not_yet_flying', 'DC-9-50 enters service 1975');
  assert.equal(orderDenial({ ...freshState(), cash: 1e9 }, 'l1011'), null, 'classic catalogue is timeless');
});

test('production-line worlds: launch customers first, then preorders for everyone', () => {
  assert.equal(orderDenial(linesEra(), 'l1011')?.code, 'launch_only', 'launch window (26 weeks) still comes first');
  const d = orderDenial(linesEra({ week: 27 }), 'l1011');
  assert.equal(d?.code, 'preorder', 'window closed: preorders open');
});

section('placing a preorder');

test('a preorder takes a 20% deposit, owes the rest, and delivers from January of the EIS year', () => {
  needP();
  const s0 = era();
  const s1 = order(s0, 'l1011', 3);
  const placed = added(s0, s1);
  assert.equal(placed.length, 3);
  assert.deepEqual(weeks(placed), [EIS, EIS + 4, EIS + 8], 'wide-body lead of 4 weeks between frames');
  for (const o of placed) {
    assert.equal(o.preorder, true);
    const full = o.totalPrice + o.balanceDue;
    assert.ok(Math.abs(o.totalPrice - Math.round(full * P.PREORDER_DEPOSIT)) <= 1, `deposit ${o.totalPrice} of ${full}`);
  }
  const paid = s0.cash - s1.cash;
  assert.equal(paid, placed.reduce((s, o) => s + o.totalPrice, 0), 'only the deposits leave the bank');
});

test('the early-bird discount stacks with bulk, slides to nothing at entry into service', () => {
  needP();
  const t = T('l1011');
  const atAnnounce = P.preorderWindow(era({ week: 1 }), t);
  assert.ok(Math.abs(atAnnounce.discount - P.PREORDER_EARLY_MAX) < 1e-9, `${atAnnounce.discount}`);
  const late = P.preorderWindow(era({ year: 2, week: 52 }), t);
  assert.ok(late.discount > 0 && late.discount < 0.01, `last week ${late.discount}`);
  const mid = P.preorderWindow(era({ year: 2, week: 1 }), t);
  assert.ok(Math.abs(mid.discount - P.PREORDER_EARLY_MAX / 2) < 0.002, `halfway ${mid.discount}`);
  assert.ok(Math.abs(P.preorderOrderDiscount(era({ week: 1 }), t, 20) - (orderDiscount(20) + P.PREORDER_EARLY_MAX)) < 1e-9);
  assert.equal(P.preorderOrderDiscount(era({ week: 1 }), t, 100), 0.25, 'capped like launch orders');
  const s0 = era({ week: 1 });
  const early = added(s0, order(s0, 'l1011', 1))[0];
  const s9 = era({ year: 2, week: 52 });
  const lateO = added(s9, order(s9, 'l1011', 1))[0];
  assert.ok(early.totalPrice + early.balanceDue < lateO.totalPrice + lateO.balanceDue, 'earlier is cheaper');
});

test('a preorder is never leased and never handed over as a starter frame', () => {
  const s0 = era();
  assert.equal(order(s0, 'l1011', 1, { ownershipType: 'lease' }).pendingOrders.length, 0, 'no lessor carries an unflown type');
  const s1 = era({ starterDeliveriesUsed: 0 });
  const s2 = order(s1, 'l1011', 1);
  assert.equal(s2.fleet.length, s1.fleet.length, 'nothing arrives before it exists');
  assert.equal(added(s1, s2)[0].deliverAbsWeek, EIS);
});

test('a preorder trims to the deposits you can afford', () => {
  const s0 = era({ cash: 20_000_000 });   // TriStar ≈ $45M, deposit ≈ $9M
  const s1 = order(s0, 'l1011', 5);
  assert.equal(added(s0, s1).length, 2, 'two deposits fit in $20M');
});

test('production-line worlds: a preorder queues behind launch frames and never before first delivery', () => {
  const launch = order(linesEra(), 'l1011', 30);
  assert.equal(added(linesEra(), launch).length > 0, true, 'launch order placed');
  const later = { ...launch, week: 30 };
  const pre = order(later, 'l1011', 2);
  const mine = added(later, pre);
  assert.equal(mine.length, 2);
  assert.ok(mine.every(o => o.preorder === true && !o.launch && !o.priority));
  assert.ok(mine.every(o => o.deliverAbsWeek >= EIS));
  assert.ok(mine[0].deliverAbsWeek > Math.max(...weeks(added(linesEra(), launch))) - 1, 'behind own launch frames (gap rule)');
});

section('delivery: the balance falls due');

function dueNextWeek() {
  // Ordered in year 2 week 40 (the lead time clears EIS); the clock then
  // reaches year 2 week 52, and the tick to abs 105 (EIS) lands the frame.
  const s0 = era({ year: 2, week: 40 });
  const s1 = { ...order(s0, 'l1011', 1), week: 52 };
  const o = added(s0, s1)[0];
  assert.equal(o.deliverAbsWeek, EIS);
  return { s1, o };
}

test('the balance is paid when the frame arrives, and the tail carries the full price as its basis', () => {
  const { s1, o } = dueNextWeek();
  const twin = { ...s1, pendingOrders: s1.pendingOrders.map(x => x.id === o.id ? { ...x, balanceDue: 0 } : x) };
  const a = tick(s1), b = tick(twin);
  assert.equal(b.cash - a.cash, o.balanceDue, 'cash differs by exactly the balance');
  const tail = a.fleet.find(x => x.name === o.name);
  assert.ok(tail, 'delivered');
  assert.equal(tail.costBasis, o.totalPrice + o.balanceDue);
});

test('a balance the airline cannot pay cancels the frame and the deposit is lost', () => {
  const { s1, o } = dueNextWeek();
  const broke = { ...s1, cash: Math.round(o.balanceDue / 10) };
  const a = tick(broke);
  assert.ok(!a.fleet.some(x => x.name === o.name), 'no aircraft');
  assert.ok(!a.pendingOrders.some(x => x.id === o.id), 'order gone');
  assert.ok((a.pendingToasts ?? []).some(t => /balance/i.test(`${t.title} ${t.message}`)), 'the player is told why');
});

section('cancelling');

test('cancelling a preorder forfeits the deposit', () => {
  const s0 = era();
  const s1 = order(s0, 'l1011', 2);
  const [o1] = added(s0, s1);
  const s2 = gameReducer(s1, { type: 'CANCEL_ORDER', orderId: o1.id });
  assert.equal(s2.pendingOrders.length, s1.pendingOrders.length - 1);
  assert.equal(s2.cash, s1.cash, 'no refund');
  assert.equal(orderCancelRefund(s1, o1).refund, 0);
});

test('a delayed programme lets preorder and launch customers walk away with a full refund', () => {
  const s0 = era();
  const s1 = order(s0, 'l1011', 2);
  const [o1, o2] = added(s0, s1);
  const delayed = { ...s1, pendingOrders: s1.pendingOrders.map(x => ({ ...x, delayedWeeks: 30 })) };
  const s2 = gameReducer(delayed, { type: 'CANCEL_ORDER', orderIds: [o1.id, o2.id] });
  assert.equal(s2.cash, s1.cash + o1.totalPrice + o2.totalPrice);
  const launchBook = order(linesEra(), 'l1011', 30);
  const lo = added(linesEra(), launchBook)[0];
  assert.equal(orderCancelRefund(launchBook, lo).allowed, false, 'launch frames are firm…');
  const t = orderCancelRefund(launchBook, { ...lo, delayedWeeks: 30 });
  assert.equal(t.allowed, true, '…unless the programme slips');
  assert.equal(t.refund, lo.totalPrice);
});

section('programme delays');

test('delays are deterministic per world, revealed half a year before entry into service', () => {
  needP();
  const startYear = 1970;
  const reveal = EIS - P.DELAY_REVEAL_WEEKS;
  let delayedSeed = null;
  for (let i = 0; i < 400 && !delayedSeed; i++) {
    const tbl = P.revealProgrammeDelays({ seed: `w${i}`, startYear, absWeek: reveal, prev: {} });
    if (tbl.l1011) delayedSeed = `w${i}`;
  }
  assert.ok(delayedSeed, 'some world delays the TriStar');
  const before = P.revealProgrammeDelays({ seed: delayedSeed, startYear, absWeek: reveal - 1, prev: {} });
  assert.equal(before.l1011, undefined, 'not known before the reveal week');
  const a = P.revealProgrammeDelays({ seed: delayedSeed, startYear, absWeek: reveal, prev: {} });
  const b = P.revealProgrammeDelays({ seed: delayedSeed, startYear, absWeek: reveal, prev: {} });
  assert.deepEqual(a, b);
  const w = a.l1011.weeks;
  assert.ok(w >= P.DELAY_MIN_WEEKS && w <= P.DELAY_MAX_WEEKS, `${w} weeks`);
});

test('a type already flying when delays are first stamped is never delayed after the fact', () => {
  needP();
  // Stamp for the first time a week after the TriStar entered service.
  for (let i = 0; i < 200; i++) {
    const tbl = P.revealProgrammeDelays({ seed: `w${i}`, startYear: 1970, absWeek: EIS + 1, prev: {} });
    assert.equal(tbl.l1011, undefined, `seed w${i}`);
  }
});

test('stamped delays are kept until well after first delivery, then dropped', () => {
  needP();
  const prev = { l1011: { weeks: 30 } };
  const kept = P.revealProgrammeDelays({ seed: 'x', startYear: 1970, absWeek: EIS + 40, prev });
  assert.equal(kept.l1011?.weeks, 30);
  const gone = P.revealProgrammeDelays({ seed: 'x', startYear: 1970, absWeek: EIS + 30 + 53, prev });
  assert.equal(gone.l1011, undefined);
});

test('about one programme in five slips', () => {
  needP();
  let n = 0, d = 0;
  for (let i = 0; i < 2000; i++) { n++; if (P.programmeDelayRoll(`s${i}`, 'l1011') > 0) d++; }
  assert.ok(d / n > 0.15 && d / n < 0.25, `${d}/${n}`);
});

test('a newly revealed delay pushes every frame of that type back and tells the player', () => {
  const s0 = era({ year: 2, week: 20 });
  const s1 = order(s0, 'l1011', 2);
  const before = added(s0, s1);
  const s2 = tick(s1, { programmeDelays: { l1011: { weeks: 30 } } });
  const after = s2.pendingOrders.filter(o => before.some(b => b.id === o.id));
  assert.deepEqual(weeks(after), weeks(before).map(w => w + 30));
  assert.ok(after.every(o => o.delayedWeeks === 30));
  assert.deepEqual(s2.programmeDelays, { l1011: { weeks: 30 } });
  assert.ok((s2.pendingToasts ?? []).some(t => /TriStar/.test(`${t.title} ${t.message}`) && /refund/i.test(t.message)));
  const s3 = tick(s2, { programmeDelays: { l1011: { weeks: 30 } } });
  assert.deepEqual(weeks(s3.pendingOrders.filter(o => before.some(b => b.id === o.id))), weeks(after), 'shifted once only');
});

test('a delayed type stays a preorder after its entry-into-service year begins, until first delivery', () => {
  const s = era({ year: 3, week: 10, programmeDelays: { l1011: { weeks: 30 } } });
  const d = orderDenial(s, 'l1011');
  assert.equal(d?.code, 'preorder');
  assert.equal(d.firstDeliveryAbs, EIS + 30);
  const placed = added(s, order(s, 'l1011', 1));
  assert.equal(placed[0].deliverAbsWeek, EIS + 30);
  assert.equal(orderDenial({ ...s, week: 31 }, 'l1011'), null, 'flying: an ordinary order again');
});

test('without a delay table on the tick, nothing new is written to the blob', () => {
  const s = era({ year: 1, week: 10 });
  assert.equal('programmeDelays' in tick(s), false);
});

section('server guard');

test('the client cannot set preorder terms', () => {
  const st = era();
  const p = guardDecision('ORDER_AIRCRAFT', { typeId: 'l1011', quantity: 1, ownershipType: 'owned',
    preorder: true, balanceDue: 0, delayedWeeks: 99, totalPrice: 1 }, st);
  for (const k of ['preorder', 'balanceDue', 'delayedWeeks', 'totalPrice']) assert.equal(k in p, false, k);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
