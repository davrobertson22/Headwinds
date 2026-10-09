// Delivery lead times: one table, and the quote is the delivery.
//
// "747-400 delivers in 2 weeks rather than 4 ... Same for 400D. Perhaps the
// same for the whole 747 class." — Discord, 2026-10-03.
//
// The ORDER_AIRCRAFT reducer carried its own four-entry lead table, so every
// Double Deck, Supersonic and Freighter type fell through to the 2-week
// regional-jet default. The market card had a different table (Double Deck 5)
// and skipped the 2x first-frame rule, so it quoted neither number the order
// actually used. These tests pin the shared module and the reducer to it.
//
// Headwinds: the multiplayer Starter Fleet perk (first 2 aircraft instant)
// must still skip the queue, and a frame after it queues on the same schedule.
//
//   node --import ./tools/_register-loader.mjs tools/delivery-lead-test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
const { AIRCRAFT_TYPES, AIRCRAFT_CATEGORIES, getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');
// Soft-loaded so the reducer assertions below run, and fail on their own
// terms, against HEAD where the module does not exist yet.
const D = await import('../packages/engine/src/data/delivery.js').catch(() => null);
const needD = () => assert.ok(D, 'packages/engine/src/data/delivery.js does not exist');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }
function spin() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

const T = (id) => { const t = getAircraftType(id); assert.ok(t, `no type ${id}`); return t; };
const base = () => ({ ...freshState(), hub: 'JFK', cash: 50_000_000_000 });
const nowAbs = (s) => absoluteWeek(s.year, s.week);
function order(st, typeId, quantity = 1) {
  spin();
  return gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: 'owned' });
}
const delivered = (before, after) => after.pendingOrders.slice(before.pendingOrders.length);

section('every type has a real lead');

test('no catalogue type falls through to a fallback class', () => {
  needD();
  const known = new Set(Object.keys(D.DELIVERY_LEAD));
  for (const t of AIRCRAFT_TYPES) {
    const cls = D.deliveryClass(t);
    assert.ok(known.has(cls), `${t.id} -> ${cls}`);
    if (!t.freighter && t.category !== 'Supersonic') {
      assert.equal(cls, t.category, `${t.id} (${t.category}) delivers as ${cls}`);
    }
  }
});

test('the whole 747 passenger family and the A380 deliver as Double Deck, slower than a widebody', () => {
  needD();
  for (const t of AIRCRAFT_TYPES.filter(t => t.category === 'Double Deck')) {
    assert.equal(D.deliveryLead(t), 5, t.id);
  }
  assert.ok(D.deliveryLead(T('b747400')) > D.deliveryLead(T('b777300er')));
});

test('Concorde is not on the regional-jet clock', () => {
  needD();
  assert.equal(D.deliveryLead(T('concorde')), 4);
});

test('freighters are sized by payload, smallest to outsize', () => {
  needD();
  assert.equal(D.deliveryLead(T('atr72f')), 1);
  assert.equal(D.deliveryLead(T('e190f')), 2);
  assert.equal(D.deliveryLead(T('b757200pf')), 3);
  assert.equal(D.deliveryLead(T('b777f')), 4);
  assert.equal(D.deliveryLead(T('an225')), 5);
  for (const t of AIRCRAFT_TYPES.filter(t => t.freighter)) {
    const small = (t.payloadTonnes ?? 0) < 10, big = (t.payloadTonnes ?? 0) >= 150;
    if (small) assert.equal(D.deliveryLead(t), 1, t.id);
    if (big) assert.equal(D.deliveryLead(t), 5, t.id);
  }
});

section('schedule');

test('first frame waits 2x lead, the rest stack +lead', () => {
  needD();
  const t = T('b747400');
  assert.deepEqual(D.deliverySchedule(t, [], 100, 3), [110, 115, 120]);
  assert.deepEqual(D.deliverySchedule(t, [{ typeId: 'b747400', deliverAbsWeek: 130 }], 100, 2), [135, 140]);
  assert.deepEqual(D.deliverySchedule(t, [{ typeId: 'a380', deliverAbsWeek: 130 }], 100, 1), [110]);
  assert.equal(D.nextDeliveryWeeks(t, [], 100), 10);
});

section('the reducer delivers what the market quotes');

test('747-400 and 747-400D: first at +10w, then every 5w (was +4w, then every 2w)', () => {
  for (const id of ['b747400', 'b747400d']) {
    const s0 = base();
    const s1 = order(s0, id, 2);
    const got = delivered(s0, s1).map(o => o.deliverAbsWeek - nowAbs(s0));
    assert.deepEqual(got, [10, 15], id);
  }
});

test('for one type per class, ORDER_AIRCRAFT lands on the quoted weeks', () => {
  needD();
  const byClass = new Map();
  for (const t of AIRCRAFT_TYPES) if (!byClass.has(D.deliveryClass(t))) byClass.set(D.deliveryClass(t), t);
  for (const [cls, t] of byClass) {
    const s0 = base();
    const quote = D.deliverySchedule(t, s0.pendingOrders, nowAbs(s0), 3);
    const s1 = order(s0, t.id, 3);
    const got = delivered(s0, s1).map(o => o.deliverAbsWeek);
    if (got.length === 0) continue;   // era-gated in the default world: nothing to compare
    assert.deepEqual(got, quote, `${cls} (${t.id})`);
  }
  assert.ok(byClass.size >= Object.keys(D.DELIVERY_LEAD).length, 'every class exercised');
});

test('a second order of the same type queues behind the first', () => {
  const s0 = base();
  const s1 = order(s0, 'b747400', 1);
  const s2 = order(s1, 'b747400', 1);
  const [a, b] = s2.pendingOrders.map(o => o.deliverAbsWeek - nowAbs(s0));
  assert.deepEqual([a, b], [10, 15]);
});

section('multiplayer Starter Fleet');

test('the first two aircraft still arrive instantly; the third queues at the jumbo lead', () => {
  const s0 = { ...base(), multiplayer: true, starterDeliveriesUsed: 0, airlineName: 'Test Air' };
  const s1 = order(s0, 'b747400', 3);
  assert.equal(s1.fleet.length - (s0.fleet?.length ?? 0), 2, 'two straight into the fleet');
  const queued = delivered(s0, s1).map(o => o.deliverAbsWeek - nowAbs(s0));
  assert.deepEqual(queued, [10], 'third frame is the first in the queue: 2x the 5-week lead');
});

section('progress bar');

test('measured against the order\'s own wait, not one lead', () => {
  needD();
  const t = T('b747400');
  const o = { typeId: t.id, orderedYear: 1, orderedWeek: 1, deliverAbsWeek: absoluteWeek(1, 1) + 10 };
  const at = (w) => D.orderProgress(o, t, absoluteWeek(1, 1) + w, absoluteWeek);
  assert.equal(at(0), 0);
  assert.equal(at(5), 0.5);
  assert.equal(at(10), 1);
  assert.equal(D.orderProgress({ deliverAbsWeek: 20 }, t, 15, absoluteWeek), 0, 'legacy order without ordered week falls back to lead');
});

section('one table');

function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : (/\.(js|jsx)$/.test(f) && !/\.(bak|pre)/.test(f) ? [p] : []);
  });
}

test('no source file but data/delivery.js defines a lead table', () => {
  const offenders = [...walk('src'), ...walk('packages/engine/src'), ...walk('apps/headwinds-server/src')]
    .filter(p => !p.endsWith('data/delivery.js'))
    .filter(p => /DELIVERY_LEAD\s*=|'Wide Body':\s*4,\s*'Narrow Body':\s*3/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('Fleet\'s category list covers the whole catalogue', () => {
  const src = readFileSync('src/components/Fleet.jsx', 'utf8');
  assert.match(src, /const CATEGORY_ORDER = AIRCRAFT_CATEGORIES;/);
  for (const c of AIRCRAFT_CATEGORIES) {
    if (c === 'Freighter' || AIRCRAFT_TYPES.some(t => t.category === c)) {
      assert.match(src, new RegExp(`'${c}':\\s*'#`), `CAT_COLORS missing ${c}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
