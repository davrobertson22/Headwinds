// Fleet renewal by type — from an order on the queue, have every order of
// that type replace the aircraft of another type, as many as it can.
//
// Discord (The Dragon Overlord, 2026-11-07): "select an aircraft of one type
// and have all aircraft of another replace all of the aircraft of the original
// type it can. As someone who orders hundreds of aircraft this would be
// helpful." Tagging was one order at a time (SET_ORDER_REPLACEMENT); this is
// the same tag applied across a type in one write.
//
// What this suite pins:
//   * planTypeReplacement pairs the type's UNTAGGED orders, soonest delivery
//     first, with the other type's UNCLAIMED tails, oldest first — each pair
//     passing the same replacementCompatibility the one-tail picker uses, so a
//     tail no order can fly is skipped, never forced.
//   * SET_TYPE_REPLACEMENT applies exactly that plan (the preview is the act),
//     with one disposal for all; fromTypeId null clears the type's tags.
//   * Orders already replacing something, and tails already claimed by an
//     order or a waiting delivery, are left exactly as they were.
//
//   node --import ./tools/_register-loader.mjs tools/type-replacement-test.mjs

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
const { gameReducer, freshState, planTypeReplacement } = engine;
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}
const needApi = () => assert.equal(typeof planTypeReplacement, 'function', 'planTypeReplacement is not exported');

function seedRandom(seed) {
  let x = seed >>> 0;
  Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

const OLD   = 'a320ceo';
const NEW   = 'a321neo';
const SHORT = 'atr72';      // cannot reach JFK–LAX

const tail = (id, typeId, ageWeeks, extra = {}) => ({
  id, typeId, name: id, tailNumber: id.toUpperCase(),
  status: 'assigned', ageWeeks, ownershipType: 'owned', config: { economy: 150 }, ...extra,
});
const paxRoute = (id, aircraftId, o, d, extra = {}) => ({
  id, origin: o, destination: d, aircraftId, weeklyFrequency: 3, weeksOpen: 40,
  hub: 'JFK', ticketPrice: 240, cateringLevel: 'full', stops: [o, d], ...extra,
});

function world(extra = {}) {
  seedRandom(11);
  const s = gameReducer(freshState(),
    { type: 'START_GAME', airlineName: 'Renewal Air', hub: 'JFK', enableObjectives: false });
  return {
    ...s, cash: 9_000_000_000, crewPipeline: false,
    gates: { ...(s.gates ?? {}), JFK: 40, BOS: 20, ORD: 20, LAX: 20 },
    fleet: [
      tail('mid',    OLD, 1400),
      tail('oldest', OLD, 1800),
      tail('lax',    OLD, 1600),          // flies JFK–LAX
      tail('young',  OLD, 900, { status: 'idle' }),
      tail('other',  'b737800', 2000),   // a different type: never touched
    ],
    routes: [
      paxRoute('r1', 'mid', 'JFK', 'BOS'),
      paxRoute('r2', 'oldest', 'JFK', 'ORD'),
      paxRoute('r3', 'lax', 'JFK', 'LAX'),
      paxRoute('r4', 'other', 'JFK', 'BOS'),
    ],
    cargoRoutes: [],
    ...extra,
  };
}
// Order `n` of a type, then spread their deliveries so "soonest" is defined:
// the LAST order placed is made the soonest, so the pairing cannot be riding
// on queue order.
function withOrders(s, typeId, n, firstWeek = 10) {
  const before = new Set((s.pendingOrders ?? []).map(o => o.id));
  s = gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId, quantity: n, ownershipType: 'owned' });
  const mine = s.pendingOrders.filter(o => !before.has(o.id));
  assert.equal(mine.length, n, `ordered ${n} ${typeId}`);
  const now = absoluteWeek(s.year, s.week);
  const wk = new Map(mine.map((o, i) => [o.id, now + firstWeek + (n - 1 - i)]));
  return { ...s, pendingOrders: s.pendingOrders.map(o => (wk.has(o.id) ? { ...o, deliverAbsWeek: wk.get(o.id) } : o)) };
}
const soonestFirst = (s, typeId) => s.pendingOrders
  .filter(o => o.typeId === typeId).sort((a, b) => a.deliverAbsWeek - b.deliverAbsWeek);
const tags = (s) => Object.fromEntries(s.pendingOrders.map(o => [o.id, o.replacesAircraftId ?? null]));

console.log('\nFleet renewal by type\n');

test('soonest delivery takes the oldest tail; a tail the type cannot fly is skipped', () => {
  needApi();
  const s = withOrders(world(), SHORT, 3);
  const plan = planTypeReplacement(s, SHORT, OLD);
  const [o1, o2, o3] = soonestFirst(s, SHORT);
  // ATRs cannot reach LAX, so 'lax' is passed over; the rest go oldest first.
  assert.deepEqual(plan.pairs, [
    { orderId: o1.id, aircraftId: 'oldest' },
    { orderId: o2.id, aircraftId: 'mid' },
    { orderId: o3.id, aircraftId: 'young' },
  ]);
  assert.equal(plan.orders, 3);
  assert.equal(plan.tails, 4);
  assert.equal(plan.unfit, 1, 'one tail no order of the type can take over');
});

test('more orders than tails: the soonest orders get them, the rest stay untagged', () => {
  needApi();
  const s = withOrders(world(), NEW, 6);
  const plan = planTypeReplacement(s, NEW, OLD);
  const ords = soonestFirst(s, NEW);
  assert.deepEqual(plan.pairs.map(p => p.aircraftId), ['oldest', 'lax', 'mid', 'young']);
  assert.deepEqual(plan.pairs.map(p => p.orderId), ords.slice(0, 4).map(o => o.id));
  assert.equal(plan.unfit, 0);
});

test('SET_TYPE_REPLACEMENT applies exactly the previewed plan, one disposal for all', () => {
  needApi();
  const s = withOrders(world(), SHORT, 3);
  const plan = planTypeReplacement(s, SHORT, OLD);
  const next = gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: SHORT, fromTypeId: OLD, disposal: 'keep' });
  for (const p of plan.pairs) {
    const o = next.pendingOrders.find(x => x.id === p.orderId);
    assert.equal(o.replacesAircraftId, p.aircraftId);
    assert.equal(o.replacesName, p.aircraftId);
    assert.equal(o.replaceDisposal, 'keep');
  }
  assert.equal(next.pendingOrders.filter(o => o.replacesAircraftId).length, plan.pairs.length);
  assert.equal(next.fleet, s.fleet, 'nothing in the fleet changes until delivery');
});

test('tagged orders and claimed tails are left alone', () => {
  needApi();
  let s = withOrders(world(), NEW, 3);
  const [first, second] = soonestFirst(s, NEW);
  s = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: second.id, aircraftId: 'oldest', disposal: 'keep' });
  s = { ...s, fleet: [...s.fleet, tail('fresh', NEW, 0, { status: 'idle',
    replacing: { aircraftId: 'mid', name: 'mid', disposal: 'dispose' } })] };
  const next = gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: NEW, fromTypeId: OLD, disposal: 'dispose' });
  const o2 = next.pendingOrders.find(o => o.id === second.id);
  assert.equal(o2.replacesAircraftId, 'oldest', 'an order already replacing a tail keeps it');
  assert.equal(o2.replaceDisposal, 'keep', '…and its own disposal');
  const claimed = next.pendingOrders.map(o => o.replacesAircraftId).filter(Boolean);
  assert.ok(!claimed.includes('mid'), 'a tail a delivered aircraft is waiting on is not offered again');
  assert.equal(new Set(claimed).size, claimed.length, 'no tail is claimed twice');
  assert.equal(next.pendingOrders.find(o => o.id === first.id).replacesAircraftId, 'lax');
});

test('only the chosen types move: other orders and other fleet types are untouched', () => {
  needApi();
  let s = withOrders(world(), NEW, 2);
  s = withOrders(s, SHORT, 2);
  const next = gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: NEW, fromTypeId: OLD, disposal: 'dispose' });
  for (const o of next.pendingOrders.filter(x => x.typeId === SHORT)) assert.ok(!('replacesAircraftId' in o));
  assert.ok(!Object.values(tags(next)).includes('other'));
});

test('fromTypeId null clears every tag on the type, and only that type', () => {
  needApi();
  let s = withOrders(world(), NEW, 2);
  s = withOrders(s, SHORT, 1);
  s = gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: NEW, fromTypeId: OLD, disposal: 'dispose' });
  const atr = s.pendingOrders.find(o => o.typeId === SHORT);
  s = gameReducer(s, { type: 'SET_ORDER_REPLACEMENT', orderId: atr.id, aircraftId: 'young', disposal: 'dispose' });
  const cleared = gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: NEW, fromTypeId: null });
  for (const o of cleared.pendingOrders.filter(x => x.typeId === NEW)) {
    assert.ok(!('replacesAircraftId' in o) && !('replaceDisposal' in o) && !('replacesName' in o));
  }
  assert.equal(cleared.pendingOrders.find(o => o.id === atr.id).replacesAircraftId, 'young');
});

test('nothing to do returns the same state object', () => {
  needApi();
  const s = withOrders(world(), NEW, 2);
  assert.equal(gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: NEW, fromTypeId: 'b777300er', disposal: 'dispose' }), s);
  assert.equal(gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: NEW, fromTypeId: null }), s);
  assert.equal(gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: 'b777300er', fromTypeId: OLD }), s);
});

test('hundreds at once: 300 orders against 300 tails, every pair valid', () => {
  needApi();
  const fleet = Array.from({ length: 300 }, (_, i) => tail(`t${i}`, OLD, 600 + i, { status: 'idle' }));
  // One real order, cloned: the ordering caps are not what is under test here.
  let s = withOrders(world({ fleet, routes: [] }), NEW, 1);
  const [proto] = s.pendingOrders;
  s = { ...s, pendingOrders: Array.from({ length: 300 }, (_, i) => ({
    ...proto, id: `bulk${i}`, name: `A321neo #${i}`, deliverAbsWeek: proto.deliverAbsWeek + (299 - i) })) };
  const t0 = Date.now();
  const next = gameReducer(s, { type: 'SET_TYPE_REPLACEMENT', orderTypeId: NEW, fromTypeId: OLD, disposal: 'dispose' });
  const ms = Date.now() - t0;
  const ords = soonestFirst(next, NEW);
  assert.equal(ords.filter(o => o.replacesAircraftId).length, 300);
  assert.equal(ords[0].replacesAircraftId, 't299', 'the soonest delivery replaces the oldest tail');
  assert.equal(ords[299].replacesAircraftId, 't0');
  assert.ok(ms < 3000, `took ${ms} ms`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
