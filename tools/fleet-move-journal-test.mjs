// Fleet moves are journalled — and reported — as what EXECUTED, not what was
// asked for. No database, no network.
//
// Time Flies, week 1 (Discord, 2026-10-18: "How did someone just order 12
// planes? Isn't there a 5 plane limit"). Air Canada asked for 5 + 2 + 5 lease
// frames against a 5-slot lease order book and cancelled two. The reducer
// clamped every order, but the decision journal stored the REQUEST, an order
// refused with a toast still counted as "changed", and cancellations were never
// netted — so every player's news feed read "Air Canada ordered 12× 777-200ER".
// The rival profiles had the opposite bug: they ignored the count entirely.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-move-journal-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { gameReducer } = await import('../packages/engine/src/reducer.mjs');
const {
  journalledPayload, isPublicDecision, publicPayload, withFleetFacts, PUBLIC_DECISIONS,
} = await import('../apps/headwinds-server/src/lib/publicDecisions.mjs');
const { buildNews } = await import('../apps/headwinds-server/src/lib/newsService.mjs');
const { fleetHeadline, describeFleetMove } = await import('../src/utils/fleetNews.js');
const { compose } = await import('../src/components/News.jsx');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const L = { typeId: 'b737800', ownershipType: 'lease', leaseTermWeeks: 104 };
const NAMES = { b737800: 'Boeing 737-800', a320: 'Airbus A320' };
const typeName = (id) => NAMES[id] ?? id;

function airline(over = {}) {
  const s = gameReducer(undefined, { type: 'START_GAME', airlineName: 'Air Canada', hub: 'YYZ', enableObjectives: false });
  // A New World Restrictions multiplayer airline: 5-slot lease order book, and
  // the first two frames it ever takes deliver instantly (the starter rule).
  return { ...s, cash: 5e9, multiplayer: true, newWorldRestrictions: true, fleet: [], pendingOrders: [], ...over };
}

// A journal that does exactly what routes/decisions.mjs does with a decision:
// run the reducer, measure the fleet move, journal it (no-op if nothing moved).
// The source check at the bottom pins decisions.mjs to these same lines.
function journal() {
  const rows = [];
  let n = 0;
  return {
    rows,
    decide(state, type, payload, { week = 72, airlineId = 'a1' } = {}) {
      const next = gameReducer(state, { type, ...payload });
      const changed = next !== state;
      const fleetFacts = withFleetFacts(type, payload, state, next);
      const isMove = changed && fleetFacts.moved;
      rows.push({
        id: `d${n}`, worldId: 'w1', airlineId, week, type,
        payload: journalledPayload(fleetFacts.journalled, { changed: isMove }),
        createdAt: new Date(Date.now() - (1000 - n++) * 1000),
      });
      return next;
    },
  };
}

const framesHeld = (s, typeId = 'b737800') =>
  (s.fleet ?? []).filter((a) => a.typeId === typeId && a.status !== 'retired').length
  + (s.pendingOrders ?? []).filter((o) => o.typeId === typeId).reduce((t, o) => t + (o.quantity ?? 1), 0);

const table = (rows) => ({
  findMany: async ({ where = {} } = {}) => rows.filter((r) => !where.type?.in || where.type.in.includes(r.type)),
});
const WORLD = { id: 'w1', currentWeek: 20, currentYear: 2, weeksPerDay: 6, endedAt: null };
async function feed(rows) {
  const prisma = {
    decision: table(rows),
    airline: table([{ id: 'a1', name: 'Air Canada', hub: 'YYZ', createdAt: new Date(0), joinedWeek: 1, account: {} }]),
    alliance: table([]), allianceMember: table([]), gateAuction: table([]), gateListing: table([]),
    usedAircraftListing: table([]), worldNews: table([]),
  };
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['fleet'] });
  return items;
}

console.log('\nFleet moves: journal and report what executed\n');

await test('Time Flies replay: the feed reports the frames Air Canada actually holds, not 12', async () => {
  const j = journal();
  let s = airline();
  s = j.decide(s, 'ORDER_AIRCRAFT', { ...L, quantity: 5 });
  s = j.decide(s, 'ORDER_AIRCRAFT', { ...L, quantity: 2 });
  for (const o of s.pendingOrders.slice(-2)) s = j.decide(s, 'CANCEL_ORDER', { orderId: o.id });
  s = j.decide(s, 'ORDER_AIRCRAFT', { ...L, quantity: 5 });

  const held = framesHeld(s);
  assert.ok(held < 12, `fixture: expected the order book to clamp, held ${held}`);
  const items = await feed(j.rows);
  assert.equal(items.length, 1, 'one rolled fleet item for the week');
  assert.equal(items[0].data.total, held, `feed says ${items[0].data.total}, airline holds ${held}`);
  assert.deepEqual(items[0].data.byType, { b737800: held });
  assert.equal(items[0].data.cancelled, undefined, 'same-week cancellations net out of the order, not shown twice');
});

await test('a clamped lease order journals the frames placed — the starter deliveries included', () => {
  const j = journal();
  const s = j.decide(airline(), 'ORDER_AIRCRAFT', { ...L, quantity: 12 });
  // 2 instant starter deliveries + 3 on the book (the 5-slot book counts only
  // frames ON ORDER; the two delivered ones left it).
  assert.equal(s.fleet.length, 2);
  assert.equal(framesHeld(s), 5);
  assert.equal(j.rows[0].payload.quantity, 5);
  assert.equal(publicPayload(j.rows[0]).quantity, 5);
});

await test('an order refused against a full book is NOT a move, even though it raised a toast', () => {
  const j = journal();
  let s = j.decide(airline({ starterDeliveriesUsed: 2 }), 'ORDER_AIRCRAFT', { ...L, quantity: 5 });
  assert.equal(s.pendingOrders.length > 0, true);
  const before = s;
  s = j.decide(s, 'ORDER_AIRCRAFT', { ...L, quantity: 5 });
  assert.notEqual(s, before, 'fixture: the refusal changes state (toast) — that is the trap');
  assert.equal(framesHeld(s), framesHeld(before), 'fixture: nothing was ordered');
  assert.deepEqual(j.rows[1].payload, { noop: true });
  assert.equal(isPublicDecision(j.rows[1]), false);
});

await test('an unaffordable buy is not a move', () => {
  const j = journal();
  j.decide(airline({ cash: 1 }), 'BUY_AIRCRAFT', { typeId: 'b737800' });
  assert.equal(isPublicDecision(j.rows[0]), false);
});

await test('cancelling an EARLIER week\'s order is reported as a cancellation', async () => {
  const j = journal();
  let s = j.decide(airline({ starterDeliveriesUsed: 2 }), 'ORDER_AIRCRAFT', { ...L, quantity: 3 }, { week: 71 });
  s = j.decide(s, 'CANCEL_ORDER', { orderId: s.pendingOrders[0].id }, { week: 72 });
  const cancel = j.rows[1];
  assert.equal(cancel.payload.cancelled, 1);
  assert.equal(cancel.payload.typeId, 'b737800');
  const items = await feed(j.rows);
  const wk72 = items.find((i) => i.linearWeek === 72);
  assert.equal(wk72.data.total, 0);
  assert.equal(wk72.data.cancelled, 1);
  assert.equal(fleetHeadline('fleet_in', wk72.data, typeName), 'cancelled orders for a Boeing 737-800');
  assert.equal(items.find((i) => i.linearWeek === 71).data.total, 3);
});

await test('a week whose orders were all cancelled again is not news', async () => {
  const j = journal();
  let s = j.decide(airline({ starterDeliveriesUsed: 2 }), 'ORDER_AIRCRAFT', { ...L, quantity: 2 });
  for (const o of [...s.pendingOrders]) s = j.decide(s, 'CANCEL_ORDER', { orderId: o.id });
  assert.equal(framesHeld(s), 0);
  assert.equal((await feed(j.rows)).length, 0);
});

await test('bulk disposals are reported with their executed count and types', async () => {
  const fleet = [
    { id: 't1', typeId: 'b737800', status: 'idle', ownershipType: 'owned', ageWeeks: 10 },
    { id: 't2', typeId: 'b737800', status: 'idle', ownershipType: 'owned', ageWeeks: 10 },
    { id: 't3', typeId: 'a320',    status: 'idle', ownershipType: 'owned', ageWeeks: 10 },
  ];
  const j = journal();
  j.decide(airline({ fleet }), 'RETIRE_AIRCRAFT_BULK', { aircraftIds: ['t1', 't2', 't3', 'not-mine'] });
  const row = j.rows[0];
  assert.ok(PUBLIC_DECISIONS.has('RETIRE_AIRCRAFT_BULK'));
  assert.equal(isPublicDecision(row), true);
  assert.equal(row.payload.quantity, 3);
  assert.deepEqual(publicPayload(row).byType, { b737800: 2, a320: 1 });
  const [item] = await feed(j.rows);
  assert.equal(item.kind, 'fleet_out');
  assert.equal(item.data.total, 3);
  assert.equal(item.data.retired, true);
  assert.equal(fleetHeadline('fleet_out', item.data, typeName), 'retired 2× Boeing 737-800 and a Airbus A320');
});

await test('a single retirement names its type instead of "a unknown"', async () => {
  const j = journal();
  j.decide(airline({ fleet: [{ id: 't1', typeId: 'a320', status: 'idle', ownershipType: 'owned', ageWeeks: 10 }] }),
    'RETIRE_AIRCRAFT', { aircraftId: 't1' });
  const [item] = await feed(j.rows);
  assert.deepEqual(item.data.byType, { a320: 1 });
  assert.equal(fleetHeadline('fleet_out', item.data, typeName), 'retired a Airbus A320');
});

await test('journal rows written before this fix: newly-public types without counts stay out', async () => {
  const legacy = [
    { id: 'x1', worldId: 'w1', airlineId: 'a1', week: 72, type: 'CANCEL_ORDER', payload: { orderId: 'o1' }, createdAt: new Date() },
    { id: 'x2', worldId: 'w1', airlineId: 'a1', week: 72, type: 'SELL_AIRCRAFT_BULK', payload: { aircraftIds: ['a', 'b'] }, createdAt: new Date() },
  ];
  for (const r of legacy) assert.equal(isPublicDecision(r), false, r.type);
  assert.equal((await feed(legacy)).length, 0);
});

console.log('\nWording (one module, every screen)\n');

await test('rival-profile lines carry the count', () => {
  const say = (type, payload) => describeFleetMove({ type, payload }, typeName);
  assert.equal(say('ORDER_AIRCRAFT', { typeId: 'b737800', quantity: 5 }), 'Ordered 5× Boeing 737-800');
  assert.equal(say('ORDER_AIRCRAFT', { typeId: 'b737800' }), 'Ordered a Boeing 737-800');
  assert.equal(say('SELL_AIRCRAFT_BULK', { quantity: 4, byType: { a320: 3, b737800: 1 } }), 'Sold 3× Airbus A320 and a Boeing 737-800');
  assert.equal(say('RETIRE_AIRCRAFT', {}), 'Retired an aircraft');
  assert.equal(say('CANCEL_ORDER', { typeId: 'a320', cancelled: 2 }), 'Cancelled an order for 2× Airbus A320');
  assert.equal(say('ADD_ROUTE', { origin: 'JFK' }), null, 'non-fleet moves are left to the caller');
});

await test('the in-game News tab uses the shared wording, including net cancellations', () => {
  const c = compose({
    kind: 'fleet_in', airline: 'Air Canada', category: 'fleet', year: 1, week: 2,
    data: { total: 3, byType: { b777200er: 3 }, cancelled: 1, cancelledByType: { a330300: 1 }, ordered: true },
  });
  assert.match(c.headline, /^ordered 3× .+, cancelled a .+/);
  assert.ok(!c.headline.includes('b777200er'), `raw typeId leaked: ${c.headline}`);
});

await test('every screen that words a fleet move goes through utils/fleetNews.js', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const decisions = read('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(decisions, /const fleetFacts = withFleetFacts\(type, journalled, injected, next\);/);
  assert.match(decisions, /const isMove = changed && fleetFacts\.moved;/);
  assert.match(decisions, /journalledPayload\(journalled, \{ changed: isMove \}\)/);
  for (const [file, call] of [
    ['../src/components/News.jsx', /fleetHeadline\('fleet_in'/],
    ['../apps/headwinds-web/src/Feed.jsx', /fleetHeadline\('fleet_in'/],
    ['../apps/headwinds-web/src/App.jsx', /describeFleetMove\(m, acName\)/],
    ['../src/components/Competition.jsx', /describeFleetMove\(m, aircraftName\)/],
  ]) {
    const src = read(file);
    assert.match(src, call, `${file} does not use the shared wording`);
    assert.ok(!/ORDER_AIRCRAFT:\s*\(/.test(src), `${file} still has its own ORDER_AIRCRAFT label`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
