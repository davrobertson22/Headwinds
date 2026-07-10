// Phase 2 tick + decisions test — no database, no network.
//
// Runs the REAL tick service and the REAL engine against an in-memory fake
// Prisma, proving: schedule math, the compare-and-set idempotency guard,
// airline state advancing through ADVANCE_WEEK, standings/tick-log writes,
// world completion, and the action allow-list staying in sync with the reducer.
//
//   node tools/headwinds-tick-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  ticksDue, weekIndex, tickWorldOnce, runDueTicks,
} from '../apps/headwinds-server/src/lib/tickService.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// ── In-memory fake Prisma (just the surface the tick service touches) ─────────
function fakePrisma({ world, airlines }) {
  const db = {
    world: { ...world },
    airlines: airlines.map((a) => ({ ...a })),
    tickLogs: [],
    standings: [],
  };
  let logId = 0;
  return {
    _db: db,
    world: {
      findMany: async () => [{ ...db.world }],
      updateMany: async ({ where, data }) => {
        const w = db.world;
        const match = w.id === where.id
          && w.currentWeek === where.currentWeek
          && w.currentYear === where.currentYear
          && w.status === where.status;
        if (!match) return { count: 0 };
        Object.assign(w, data);
        return { count: 1 };
      },
    },
    airline: {
      findMany: async ({ where }) =>
        db.airlines.filter((a) => a.worldId === where.worldId && a.status === where.status).map((a) => ({ ...a })),
      update: async ({ where, data }) => {
        const a = db.airlines.find((x) => x.id === where.id);
        Object.assign(a, data);
        return { ...a };
      },
    },
    tickLog: {
      create: async ({ data }) => {
        const row = { id: `t${++logId}`, ...data };
        db.tickLogs.push(row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = db.tickLogs.find((t) => t.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
    },
    standing: {
      createMany: async ({ data }) => { db.standings.push(...data); return { count: data.length }; },
    },
    // Player alliances: the tick's rival-view builder queries these; an empty
    // world simply has none.
    alliance: {
      findMany: async () => [],
    },
  };
}

const quiet = { info: () => {}, error: () => {} };

const seedAirline = (id, name, hub) => {
  const state = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  return { id, worldId: 'w1', accountId: `acct_${id}`, name, hub, state, status: 'ACTIVE', week: 1 };
};

const makeWorld = (over = {}) => ({
  id: 'w1', name: 'Test World', status: 'RUNNING',
  lengthYears: 50, weeksPerDay: 12,           // 1 week / 2 hr
  currentWeek: 1, currentYear: 1,
  startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // started 5h ago
  ...over,
});

console.log('\n── schedule math ────────────────────────────────────────');

await test('ticksDue derives owed weeks from startedAt + pace', () => {
  // 5h at 1wk/2h → target week 3; clock at week 1 → 2 due.
  assert.equal(ticksDue(makeWorld()), 2);
  // Caught-up world owes nothing.
  assert.equal(ticksDue(makeWorld({ currentWeek: 3 })), 0);
  // Non-running worlds never tick.
  assert.equal(ticksDue(makeWorld({ status: 'ENDED' })), 0);
});

await test('ticksDue never exceeds world length', () => {
  const w = makeWorld({ lengthYears: 50, startedAt: new Date(Date.now() - 100 * 365 * 24 * 3600 * 1000) });
  assert.equal(ticksDue(w), 50 * 52 - 1); // target capped at totalWeeks
});

console.log('\n── tickWorldOnce ────────────────────────────────────────');

await test('advances every airline through the real engine', async () => {
  const prisma = fakePrisma({ world: makeWorld(), airlines: [seedAirline('a1', 'Alpha', 'JFK'), seedAirline('a2', 'Beta', 'LAX')] });
  const res = await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  assert.equal(res.ok, true);
  assert.equal(res.week, 2);
  assert.equal(res.airlines, 2);
  const a1 = prisma._db.airlines[0];
  assert.equal(a1.state.week, 2, 'engine state advanced');
  assert.equal(a1.week, 2, 'promoted week column updated');
  assert.equal(typeof a1.cash, 'bigint', 'promoted cash column updated');
  assert.equal(prisma._db.tickLogs[0].status, 'ok');
  assert.equal(prisma._db.standings.length, 2, 'standings snapshot written');
  assert.ok([1, 2].includes(prisma._db.standings[0].rank));
});

await test('compare-and-set: a stale clock loses the race, state untouched', async () => {
  const prisma = fakePrisma({ world: makeWorld({ currentWeek: 5 }), airlines: [seedAirline('a1', 'Alpha', 'JFK')] });
  const res = await tickWorldOnce(prisma, makeWorld({ currentWeek: 1 }), { log: quiet }); // stale caller
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'lost-race');
  assert.equal(prisma._db.airlines[0].state.week, 1, 'airline state untouched');
});

await test('year rollover: week 52 → year 2 week 1', async () => {
  const w = makeWorld({ currentWeek: 52, currentYear: 1 });
  const prisma = fakePrisma({ world: w, airlines: [] });
  const res = await tickWorldOnce(prisma, w, { log: quiet });
  assert.equal(res.ok, true);
  assert.equal(res.year, 2);
  assert.equal(res.week, 1);
});

await test('final week ends the world', async () => {
  const w = makeWorld({ currentYear: 50, currentWeek: 51 });
  const prisma = fakePrisma({ world: w, airlines: [] });
  const res = await tickWorldOnce(prisma, w, { log: quiet });
  assert.equal(res.ended, true);
  assert.equal(prisma._db.world.status, 'ENDED');
});

console.log('\n── runDueTicks (the worker loop) ────────────────────────');

await test('catches a world up and respects the cap', async () => {
  const prisma = fakePrisma({ world: makeWorld(), airlines: [seedAirline('a1', 'Alpha', 'JFK')] });
  const { ticked } = await runDueTicks(prisma, { maxCatchUp: 12, log: quiet });
  assert.equal(ticked, 2, 'both owed weeks ticked');
  assert.equal(prisma._db.world.currentWeek, 3);
  assert.equal(prisma._db.airlines[0].state.week, 3);
  // Nothing due on the immediate next run.
  const again = await runDueTicks(prisma, { maxCatchUp: 12, log: quiet });
  assert.equal(again.ticked, 0);
});

await test('bankruptcy flips the airline status and stops future ticks for it', async () => {
  const a = seedAirline('a1', 'Doomed', 'JFK');
  a.state = { ...a.state, cash: -100e6, phase: 'bankrupt' }; // simulate a dead airline
  const prisma = fakePrisma({ world: makeWorld(), airlines: [a] });
  await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  // Engine keeps phase 'bankrupt'; service must mark the row BANKRUPT.
  assert.equal(prisma._db.airlines[0].status, 'BANKRUPT');
  // Next tick skips it (findMany filters ACTIVE): count of ticked airlines is 0.
  const res2 = await tickWorldOnce(prisma, { ...makeWorld(), currentWeek: 2 }, { log: quiet });
  assert.equal(res2.airlines, 0);
});

console.log('\n── decisions allow-list ─────────────────────────────────');

await test('server-reserved actions are excluded', () => {
  for (const t of ['ADVANCE_WEEK', 'START_GAME', 'LOAD_STATE', 'RESET']) {
    assert.ok(!ALLOWED_PLAYER_ACTIONS.has(t), `${t} must not be allowed`);
  }
});

await test('every allowed action exists in the reducer (sync guard)', () => {
  const src = readFileSync(new URL('../packages/engine/src/reducer.mjs', import.meta.url), 'utf8');
  const inReducer = new Set([...src.matchAll(/case '([A-Z_]+)'/g)].map((m) => m[1]));
  for (const t of ALLOWED_PLAYER_ACTIONS) {
    assert.ok(inReducer.has(t), `allow-list action ${t} missing from reducer — stale list?`);
  }
});

await test('allowed decision flows through the reducer (lease → route → tick earns revenue)', () => {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'T', hub: 'JFK', enableObjectives: false });
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('LEASE_AIRCRAFT'));
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'a320neo' });
  const ac = s.fleet[s.fleet.length - 1];
  assert.ok(ac, 'aircraft leased');
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' }); // routes need a gate at both ends
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac.id, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  assert.equal(s.routes.length, 1, 'route added');
  const cashBefore = s.cash;
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const report = s.financialHistory?.[s.financialHistory.length - 1];
  assert.ok(report && report.revenue > 0, 'week produced revenue');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
