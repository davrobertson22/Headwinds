// Fleet renewal — replace ageing aircraft on delivery, one at a time or in bulk.
//
// Discord (VodkaOnFire / Dave, 2026-10-16): opening routes is the game;
// re-equipping the same old feeder routes with newer metal, eighty times over,
// is not. Every swap was already possible by hand — order, wait, TRANSFER_ROUTES,
// then sell or return the old tail — so this automates that exact sequence and
// nothing more. No new rules: the swap is the TRANSFER_ROUTES fold, the disposal
// is the SELL_AIRCRAFT / RETIRE_AIRCRAFT fold.
//
// What this suite pins:
//   * An order can name ONE tail it replaces, chosen at signing (ORDER_AIRCRAFT
//     `replaces`, one id per frame) or later from the order queue
//     (SET_ORDER_REPLACEMENT). Compatibility is checked against the ordered
//     spec — range with its wingtips and cabin, freighter vs passenger, airport
//     rules, block hours — the same checks TRANSFER_ROUTES runs.
//   * On delivery the new tail takes over every route. Routes keep their id and
//     maturity ramp, exactly as a manual transfer does.
//   * The old tail is then sold (owned), handed back (leased, with the normal
//     early-return terms), or kept as a spare.
//   * The world moved on while the order was building: if the old tail is in
//     the shop or on a charter, the new one WAITS; if it is gone, or picked up a
//     route the new type cannot fly, the new one arrives idle and says why.
//   * An order with no replacement is byte-for-byte today's delivery.
//
//   * Headwinds: a tail the renewal sold is reported on `renewalSales` so the
//     tick service can list it in the world's used market, like any other sale.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-renewal-test.mjs

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

const engine = await import('../packages/engine/src/reducer.mjs');
const { gameReducer, freshState } = engine;
const { replacementCompatibility } = engine;
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');
const { AIRCRAFT_LOAN_ID } = await import('../packages/engine/src/data/credit.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }
const needApi = () => assert.equal(typeof replacementCompatibility, 'function', 'replacementCompatibility is not exported');

function seedRandom(seed) {
  let x = seed >>> 0;
  Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
function spin() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

const OLD   = 'a320ceo';
const NEW   = 'a321neo';
const SHORT = 'atr72';      // cannot reach JFK–LAX

const tail = (id, typeId, extra = {}) => ({
  id, typeId, name: id, tailNumber: id.toUpperCase(),
  status: 'assigned', ageWeeks: 1400, ownershipType: 'owned',
  config: { economy: 150 },
  ...extra,
});
const paxRoute = (id, aircraftId, o, d, extra = {}) => ({
  id, origin: o, destination: d, aircraftId, weeklyFrequency: 7, weeksOpen: 40,
  hub: 'JFK', ticketPrice: 240, cateringLevel: 'full', stops: [o, d], ...extra,
});

function world(extra = {}) {
  seedRandom(11);
  const s = gameReducer(freshState(),
    { type: 'START_GAME', airlineName: 'Renewal Air', hub: 'JFK', enableObjectives: false });
  return {
    ...s, cash: 900_000_000, crewPipeline: false,
    gates: { ...(s.gates ?? {}), JFK: 40, BOS: 20, ORD: 20, LAX: 20 },
    fleet: [
      tail('old1', OLD),
      tail('old2', OLD),
      tail('old3', OLD, { status: 'idle' }),
    ],
    routes: [
      paxRoute('r1', 'old1', 'JFK', 'BOS'),
      paxRoute('r2', 'old1', 'JFK', 'ORD', { weeklyFrequency: 5 }),
      paxRoute('r3', 'old2', 'JFK', 'LAX', { weeklyFrequency: 3 }),
    ],
    cargoRoutes: [],
    ...extra,
  };
}
const nowAbs = (s) => absoluteWeek(s.year, s.week);
const advance = (s) => { spin(); return gameReducer(s, { type: 'ADVANCE_WEEK' }); };
const order = (s, extra = {}) => {
  spin();
  return gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: NEW, quantity: 1, ownershipType: 'owned', ...extra });
};
// Pull the order's delivery to next week so one tick lands it.
const dueNextWeek = (s) => ({
  ...s, pendingOrders: s.pendingOrders.map(o => ({ ...o, deliverAbsWeek: nowAbs(s) + 1 })),
});
const fleetIds = (s) => s.fleet.map(a => a.id).sort();
const deliveredOf = (before, after) => after.fleet.filter(a => !before.fleet.some(b => b.id === a.id));

console.log('\nFleet renewal — replace on delivery\n');

// ── 1. Choosing what an order replaces ──────────────────────────────────────
section('1. Tagging an order');

test('ORDER_AIRCRAFT `replaces` tags one tail per frame, in the order given', () => {
  const s = order(world(), { quantity: 2, replaces: ['old2', 'old1'], replaceDisposal: 'dispose' });
  const added = s.pendingOrders;
  assert.equal(added.length, 2);
  assert.deepEqual(added.map(o => o.replacesAircraftId), ['old2', 'old1']);
  assert.ok(added.every(o => o.replaceDisposal === 'dispose'));
});

test('an order without `replaces` carries no replacement fields at all', () => {
  const s = order(world());
  const o = s.pendingOrders[0];
  assert.ok(!('replacesAircraftId' in o) && !('replaceDisposal' in o), Object.keys(o).join(','));
});

test('SET_ORDER_REPLACEMENT tags, changes and clears from the order queue', () => {
  let s = order(world());
  const id = s.pendingOrders[0].id;
  s = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: id, aircraftId: 'old1', disposal: 'keep' });
  assert.equal(s.pendingOrders[0].replacesAircraftId, 'old1');
  assert.equal(s.pendingOrders[0].replaceDisposal, 'keep');
  s = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: id, aircraftId: null });
  assert.ok(!('replacesAircraftId' in s.pendingOrders[0]), 'clearing removes the field');
});

test('a type that cannot reach one of the routes is refused, with the reason', () => {
  needApi();
  let s = world();
  spin();
  s = gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: SHORT, quantity: 1, ownershipType: 'owned' });
  const o = s.pendingOrders[0];
  const c = replacementCompatibility(s, o, 'old2');
  assert.equal(c.ok, false);
  assert.match(c.reason, /range/i);
  const s2 = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: o.id, aircraftId: 'old2', disposal: 'dispose' });
  assert.equal(s2, s, 'the reducer refuses the same tag the picker greys out');
});

test('one tail can only be replaced by one order', () => {
  needApi();
  let s = order(world(), { quantity: 2 });
  const [a, b] = s.pendingOrders;
  s = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: a.id, aircraftId: 'old1', disposal: 'dispose' });
  const c = replacementCompatibility(s, b, 'old1');
  assert.equal(c.ok, false);
  assert.match(c.reason, /already/i);
  const s2 = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: b.id, aircraftId: 'old1', disposal: 'dispose' });
  assert.equal(s2, s);
  // Re-tagging the SAME order to the same tail is fine (e.g. changing disposal).
  const s3 = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: a.id, aircraftId: 'old1', disposal: 'keep' });
  assert.equal(s3.pendingOrders.find(o => o.id === a.id).replaceDisposal, 'keep');
});

test('an idle tail with no routes can be replaced — it is simply disposed of', () => {
  needApi();
  const s = order(world());
  assert.equal(replacementCompatibility(s, s.pendingOrders[0], 'old3').ok, true);
});

test('a bulk order skips the tails it cannot fly and tags the rest', () => {
  let s = world();
  spin();
  s = gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: SHORT, quantity: 2, ownershipType: 'owned',
    replaces: ['old2', 'old1'], replaceDisposal: 'dispose' });
  assert.equal(s.pendingOrders.length, 2, 'the aircraft are still ordered');
  // old2 flies JFK–LAX (out of an ATR's reach) so the first frame takes old1.
  assert.deepEqual(s.pendingOrders.map(o => o.replacesAircraftId ?? null), ['old1', null]);
});

// ── 2. The swap on delivery ─────────────────────────────────────────────────
section('2. Delivery');

test('the new tail takes over every route; routes keep their id and maturity', () => {
  let s = dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'keep' }));
  const before = s;
  s = advance(s);
  const [nu] = deliveredOf(before, s);
  assert.ok(nu, 'the aircraft was delivered');
  const r1 = s.routes.find(r => r.id === 'r1');
  const r2 = s.routes.find(r => r.id === 'r2');
  assert.equal(r1.aircraftId, nu.id);
  assert.equal(r2.aircraftId, nu.id);
  assert.equal(r1.weeksOpen, 41, 'the maturity ramp carried on — no relaunch');
  assert.equal(nu.status, 'assigned');
  assert.ok(!nu.replacing, 'the tag is spent once the swap is done');
  const old = s.fleet.find(a => a.id === 'old1');
  assert.ok(old, 'keep: the old tail stays in the fleet');
  assert.equal(old.status, 'idle');
  assert.equal(s.routes.filter(r => r.aircraftId === 'old1').length, 0);
});

test('dispose on an OWNED tail sells it at the normal sale price', () => {
  // Each world() reseeds the sim, so build-and-tick one scenario at a time.
  const sold = advance(dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'dispose' })));
  const kept = advance(dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'keep' })));
  assert.ok(!sold.fleet.some(a => a.id === 'old1'), 'the old tail is gone');
  // The sale is the SELL_AIRCRAFT fold, so the proceeds are what selling it by
  // hand right after the tick would pay.
  const byHand = gameReducer(kept, { type: 'SELL_AIRCRAFT', aircraftId: 'old1' });
  assert.equal(sold.cash, byHand.cash);
  assert.ok(sold.cash > kept.cash);
});

test('dispose on a LEASED tail hands it back on the normal early-return terms', () => {
  const leased = (s) => ({ ...s, fleet: s.fleet.map(a => a.id === 'old1'
    ? { ...a, ownershipType: 'lease', weeklyLease: 60_000, leaseRemainingWeeks: 30, leaseDeposit: 720_000 } : a) });
  const ret  = advance(leased(dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'dispose' }))));
  const kept = advance(leased(dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'keep' }))));
  assert.ok(!ret.fleet.some(a => a.id === 'old1'));
  const byHand = gameReducer(kept, { type: 'RETIRE_AIRCRAFT', aircraftId: 'old1' });
  assert.equal(ret.cash, byHand.cash, 'same penalty and deposit refund as returning it by hand');
});

test('the swap is announced', () => {
  const s = advance(dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'dispose' })));
  const t = (s.pendingToasts ?? []).find(x => /takes over|replac/i.test(`${x.title} ${x.message}`));
  assert.ok(t, (s.pendingToasts ?? []).map(x => x.title).join(' | '));
  assert.match(t.message, /old1/);
  assert.match(t.message, /sold/i);
});

test('an order with no replacement delivers exactly as before', () => {
  const s = advance(dueNextWeek(order(world())));
  const [nu] = deliveredOf(dueNextWeek(order(world())), s);
  assert.ok(nu);
  assert.equal(nu.status, 'idle');
  assert.ok(!('replacing' in nu));
  assert.deepEqual(s.routes.map(r => r.aircraftId).sort(), ['old1', 'old1', 'old2']);
});

test('a bulk replace swaps each frame onto its own tail', () => {
  let s = dueNextWeek(order(world(), { quantity: 2, replaces: ['old1', 'old2'], replaceDisposal: 'dispose' }));
  const before = s;
  s = advance(s);
  const nu = deliveredOf(before, s);
  assert.equal(nu.length, 2);
  assert.deepEqual(fleetIds(s).filter(id => id.startsWith('old')), ['old3']);
  const owners = new Set(s.routes.map(r => r.aircraftId));
  assert.equal(owners.size, 2, 'old1 and old2 went to DIFFERENT new tails');
  for (const id of owners) assert.ok(nu.some(a => a.id === id));
});

// ── 3. The world moved on ───────────────────────────────────────────────────
section('3. When the old tail changed while the order was building');

test('old tail sold before delivery: the new one arrives idle and says so', () => {
  let s = order(world(), { replaces: ['old3'], replaceDisposal: 'dispose' });
  s = gameReducer(s, { type: 'SELL_AIRCRAFT', aircraftId: 'old3' });
  const before = dueNextWeek(s);
  s = advance(before);
  const [nu] = deliveredOf(before, s);
  assert.equal(nu.status, 'idle');
  assert.ok(!nu.replacing);
  assert.ok((s.pendingToasts ?? []).some(x => /old3/.test(x.message ?? '')));
});

test('old tail picked up a route the new type cannot reach: no swap, reason given', () => {
  let s = world();
  spin();
  s = gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: SHORT, quantity: 1, ownershipType: 'owned',
    replaces: ['old3'], replaceDisposal: 'dispose' });
  assert.equal(s.pendingOrders[0].replacesAircraftId, 'old3');
  // ...then the player put old3 on JFK–LAX.
  s = { ...s, routes: [...s.routes, paxRoute('r9', 'old3', 'JFK', 'LAX', { weeklyFrequency: 2 })],
        fleet: s.fleet.map(a => a.id === 'old3' ? { ...a, status: 'assigned' } : a) };
  const before = dueNextWeek(s);
  s = advance(before);
  const [nu] = deliveredOf(before, s);
  assert.equal(nu.status, 'idle');
  assert.ok(!nu.replacing);
  assert.equal(s.routes.find(r => r.id === 'r9').aircraftId, 'old3', 'nothing moved');
  assert.ok(s.fleet.some(a => a.id === 'old3'), 'nothing was sold');
  assert.ok((s.pendingToasts ?? []).some(x => /range/i.test(x.message ?? '')));
});

test('old tail in the shop: the new one waits, then swaps when it is back', () => {
  let s = order(world(), { replaces: ['old1'], replaceDisposal: 'dispose' });
  s = dueNextWeek(s);
  s = { ...s, fleet: s.fleet.map(a => a.id === 'old1'
    ? { ...a, status: 'grounded', groundedWeeksLeft: 3, groundedReason: 'aog' } : a) };
  const before = s;
  s = advance(s);
  const [nu] = deliveredOf(before, s);
  assert.ok(nu.replacing, 'still waiting to take over');
  assert.equal(nu.replacing.aircraftId, 'old1');
  assert.ok(nu.replacing.waiting, 'and it says why');
  assert.ok(s.fleet.some(a => a.id === 'old1'), 'the old tail was not sold out of the shop');
  // Back in service → the next tick completes the swap.
  s = { ...s, fleet: s.fleet.map(a => a.id === 'old1' ? { ...a, status: 'assigned', groundedWeeksLeft: 0, groundedReason: null } : a),
        routes: s.routes.map(r => r.coverForAircraftId ? { ...r, aircraftId: r.coverForAircraftId, coverForAircraftId: null } : r) };
  s = advance(s);
  assert.ok(!s.fleet.some(a => a.id === 'old1'), 'sold once it was back');
  assert.equal(s.routes.find(r => r.id === 'r1').aircraftId, nu.id);
  assert.ok(!s.fleet.find(a => a.id === nu.id).replacing);
});

test('a waiting tail can be released by the player', () => {
  let s = order(world(), { replaces: ['old1'], replaceDisposal: 'dispose' });
  s = dueNextWeek(s);
  s = { ...s, fleet: s.fleet.map(a => a.id === 'old1' ? { ...a, status: 'grounded', groundedWeeksLeft: 3, groundedReason: 'aog' } : a) };
  const before = s;
  s = advance(s);
  const [nu] = deliveredOf(before, s);
  assert.ok(nu.replacing, 'waiting');
  s = gameReducer(s, { type: 'CLEAR_FLEET_REPLACEMENT', aircraftId: nu.id });
  assert.ok(!s.fleet.find(a => a.id === nu.id).replacing);
});

test('a tail pledged against a loan is not sold: routes move, it stays as a spare', () => {
  let s = order(world(), { replaces: ['old1'], replaceDisposal: 'dispose' });
  s = dueNextWeek({ ...s, loans: [...(s.loans ?? []), {
    id: 'L1', productId: AIRCRAFT_LOAN_ID, principal: 10_000_000, interestRate: 0.065, termWeeks: 416,
    weeklyPayment: 30_000, weeksRemaining: 400, totalInterestPaid: 0, takenWeek: 1, takenYear: 1,
    collateralIds: ['old1'],
  }] });
  const before = s;
  s = advance(s);
  const [nu] = deliveredOf(before, s);
  assert.equal(s.routes.find(r => r.id === 'r1').aircraftId, nu.id, 'the routes still moved');
  const old = s.fleet.find(a => a.id === 'old1');
  assert.ok(old, 'the lender\'s security was not sold');
  assert.equal(old.status, 'idle');
  assert.ok(!s.error, 'no sticky error banner from the refused sale');
  assert.ok((s.pendingToasts ?? []).some(x => /pledged/i.test(x.message ?? '')));
});

test('a renewal sale is reported for the used market, and nothing else leaks', () => {
  const s = advance(dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'dispose' })));
  assert.ok(Array.isArray(s.renewalSales) && s.renewalSales.length === 1, 'one sale reported');
  const [sale] = s.renewalSales;
  assert.equal(sale.aircraftId, 'old1');
  assert.ok(sale.nav > 0);
  assert.equal(sale.aircraft?.typeId, OLD, 'carries the airframe so it can be listed');
  assert.ok(!('lastSale' in s) || s.lastSale?.aircraftId !== 'old1', 'lastSale is a player-decision channel; the tick does not set it');
  const kept = advance(dueNextWeek(order(world(), { replaces: ['old1'], replaceDisposal: 'keep' })));
  assert.ok(!('renewalSales' in kept), 'no key at all when nothing was sold');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
