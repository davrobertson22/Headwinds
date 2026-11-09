// Worker pass scheduling — which world-week runs next (runDueTicks).
//
// 2026-11-09, Discord: "Is the problem just for me, or is it happening to
// everyone?" / "I've noticed that in some worlds, but not others". Measured on
// the live lobby that afternoon: Heavy Landing 16 weeks behind, Old Metal 21,
// and Scarce Assets going overdue while the worker streamed those two back.
// The old pass walked worlds in row order, drained each backlog before moving
// on, froze `now` at the pass start, and could be killed mid-queue by the wedge
// watchdog — so the worlds at the back of the list were the ones left waiting.
//
// No database: a fake clock and a fake per-week tick with set durations.
//
//   node tools/tick-scheduler-test.mjs

import assert from 'node:assert/strict';
import { runDueTicks, tickPriority, ticksDue } from '../apps/headwinds-server/src/lib/tickService.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-09T21:00:00Z');

// An hourly (24 weeks/day) 100-year world that has flown `flown` weeks and
// whose week flown+1 came due `dueAgoMs` before T0 (negative = due later).
function world(id, { flown, dueAgoMs = 0, weeksPerDay = 24 }) {
  const interval = 86_400_000 / weeksPerDay;
  const idx = flown + 1;
  const startedAt = new Date(T0 - dueAgoMs - idx * interval); // nextTickAt = startedAt + index × interval
  return {
    id, name: id, status: 'RUNNING', lengthYears: 100, weeksPerDay, tickConfig: {},
    startedAt, currentYear: Math.floor((idx - 1) / 52) + 1, currentWeek: ((idx - 1) % 52) + 1,
  };
}

// The harness: a clock that only moves when a week runs, and a log of picks.
function harness(worlds, { cost = {}, fail = new Set(), lobby = [] } = {}) {
  let t = T0;
  const order = [];
  const db = new Map(worlds.map((w) => [w.id, { ...w }]));
  const prisma = {
    world: {
      findMany: async ({ where }) => where.status === 'LOBBY'
        ? lobby.map((w) => ({ ...w }))
        : [...db.values()].filter((w) => w.status === 'RUNNING').map((w) => ({ ...w })),
      updateMany: async () => ({ count: 0 }),
    },
  };
  const tickOne = async (_p, w) => {
    t += cost[w.id] ?? 20_000;
    order.push({ id: w.id, at: t });
    if (fail.has(w.id)) throw new Error('P2028 transaction expired');
    const idx = (w.currentYear - 1) * 52 + w.currentWeek + 1;
    const year = Math.floor((idx - 1) / 52) + 1, week = ((idx - 1) % 52) + 1;
    Object.assign(db.get(w.id), { currentYear: year, currentWeek: week });
    return { ok: true, year, week, ended: false };
  };
  const quiet = { info() {}, warn() {}, error() {} };
  return {
    order, db,
    now: () => new Date(t),
    run: (opts = {}) => runDueTicks(prisma, { log: quiet, clock: () => new Date(t), tickOne, maxCatchUp: 12, ...opts }),
  };
}

console.log('\n── who goes first ─────────────────────────────────────');

await test('an on-time world lands its week before another world\'s backlog', async () => {
  // Backlog first in row order, as Postgres happened to return it.
  const h = harness([
    world('Heavy Landing', { flown: 1805, dueAgoMs: 16 * HOUR }),
    world('Scarce Assets', { flown: 2631, dueAgoMs: 0 }),
  ]);
  await h.run();
  assert.equal(h.order[0].id, 'Scarce Assets', 'the week that is due right now goes first');
  assert.ok(h.order[0].at - T0 <= 20_000, 'and lands within one week\'s run time');
});

await test('a week that comes due DURING a long catch-up is picked up in the same pass, next', async () => {
  const h = harness([
    world('Old Metal', { flown: 2467, dueAgoMs: 21 * HOUR }),
    world('Scarce Assets', { flown: 2631, dueAgoMs: -90_000 }), // due 90 s into the pass
  ], { cost: { 'Old Metal': 30_000 } });
  await h.run();
  const sa = h.order.findIndex((o) => o.id === 'Scarce Assets');
  assert.ok(sa >= 0, 'Scarce Assets ticked in this pass (the old pass froze `now` at its start)');
  const oldMetalBefore = h.order.slice(0, sa).length;
  assert.ok(oldMetalBefore <= 3, `ran right after coming due, not after the whole backlog (${oldMetalBefore} Old Metal weeks first)`);
  assert.ok(h.order[sa].at - (T0 + 90_000) <= 60_000, 'landed within one backlog week of its due time');
});

await test('a world that fails its week does not hold up the worlds after it', async () => {
  const h = harness([
    world('Broken', { flown: 100, dueAgoMs: 0 }),
    world('Fine A', { flown: 200, dueAgoMs: 0 }),
    world('Fine B', { flown: 300, dueAgoMs: 0 }),
  ], { fail: new Set(['Broken']), cost: { Broken: 60_000 } });
  const res = await h.run();
  assert.equal(h.order.filter((o) => o.id === 'Broken').length, 1, 'tried once, then sits out the pass');
  assert.equal(ticksDue(h.db.get('Fine A'), h.now()), 0, 'Fine A advanced');
  assert.equal(ticksDue(h.db.get('Fine B'), h.now()), 0, 'Fine B advanced');
  assert.equal(res.owedSkipped, 1, 'the failed world is reported as still owing');
});

await test('next pass: the failed world (now owing more) goes behind the healthy ones', async () => {
  const fresh = world('Fresh', { flown: 50, dueAgoMs: 0 });
  const lagging = world('Lagging', { flown: 80, dueAgoMs: HOUR + 1 }); // owes 2
  const p = tickPriority(lagging, { now: new Date(T0) });
  const q = tickPriority(fresh, { now: new Date(T0) });
  assert.deepEqual([p[0], q[0]], [2, 1]);
  const h = harness([lagging, fresh]);
  await h.run();
  assert.equal(h.order[0].id, 'Fresh');
});

await test('of two backlogs, the smaller is brought back on time first', async () => {
  // Shortest debt first: A is on time after 2 weeks of work instead of 4
  // (round-robin), and B finishes at the same moment either way.
  const h = harness([
    world('B', { flown: 10, dueAgoMs: 3 * HOUR + 1 }), // owes 4
    world('A', { flown: 10, dueAgoMs: 1 * HOUR + 1 }), // owes 2
  ]);
  await h.run();
  assert.deepEqual(h.order.map((o) => o.id), ['A', 'A', 'B', 'B', 'B', 'B']);
});

await test('a full tie keeps row order, then the smaller debt leads', async () => {
  const h = harness([
    world('A', { flown: 10, dueAgoMs: 1 * HOUR + 1 }),
    world('B', { flown: 10, dueAgoMs: 1 * HOUR + 1 }),
  ]);
  await h.run();
  assert.deepEqual(h.order.map((o) => o.id), ['A', 'A', 'B', 'B'], 'A first by row order on a full tie, then the smaller debt');
});

console.log('\n── pass limits ────────────────────────────────────────');

await test('maxCatchUp still caps one world per pass', async () => {
  const h = harness([world('Deep', { flown: 10, dueAgoMs: 40 * HOUR })]);
  const res = await h.run({ maxCatchUp: 12 });
  assert.equal(res.ticked, 12);
  assert.equal(res.owedSkipped, 1);
});

await test('the pass stops picking once its budget is spent, and says so', async () => {
  const h = harness([
    world('A', { flown: 10, dueAgoMs: 10 * HOUR }),
    world('B', { flown: 10, dueAgoMs: 10 * HOUR }),
  ], { cost: { A: 60_000, B: 60_000 } });
  const res = await h.run({ budgetMs: 5 * 60_000 });
  assert.equal(res.budgetExhausted, true);
  assert.equal(res.ticked, 5, 'five 60 s weeks in a 5 min budget');
  assert.ok(h.now().getTime() - T0 <= 5 * 60_000);
});

await test('nextDueAt is the earliest future week across worlds (and scheduled starts)', async () => {
  const lobby = [{ id: 'L', name: 'L', status: 'LOBBY', tickConfig: { scheduledStartAt: new Date(T0 + 10 * 60_000).toISOString() } }];
  const h = harness([
    world('Soon', { flown: 10, dueAgoMs: -5 * 60_000 }),
    world('Later', { flown: 10, dueAgoMs: -40 * 60_000 }),
  ], { lobby });
  const res = await h.run();
  assert.equal(res.ticked, 0);
  assert.equal(res.nextDueAt.getTime(), T0 + 5 * 60_000);
  const h2 = harness([world('Later', { flown: 10, dueAgoMs: -40 * 60_000 })], { lobby });
  assert.equal((await h2.run()).nextDueAt.getTime(), T0 + 10 * 60_000, 'a scheduled start counts');
});

await test('after ticking, nextDueAt is the world\'s following week', async () => {
  const h = harness([world('W', { flown: 10, dueAgoMs: 0 })]);
  const res = await h.run();
  assert.equal(res.ticked, 1);
  assert.equal(res.nextDueAt.getTime(), T0 + HOUR);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
