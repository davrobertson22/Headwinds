// Decision durability — a player's edit must never be silently discarded.
//
// Community reports (Discord, 2026-07-30):
//   Mariaklinga: "Price and other route settings reset in headwinds I don't know
//                 why or so but my routes randomly reset and then I only notice
//                 it when I make minus"
//   Kat the Fox: "for me it only happens while I change it sometimes"
//   A Ferg:      "yeah lots of times edits dont save/newroutes/etc"
//
// Two independent defects, both triggered by the SAME event — a decision landing
// while the weekly tick is committing, which holds row locks on every airline in
// the world for up to 30s. Both are locked here.
//
//   1. CLIENT. dispatch() applies every action optimistically, then POSTs it. A
//      write that lost its compare-and-set came back 409 and was simply dropped:
//      no retry, and the failure path called load(), which REFUSES to replace
//      local state unless the server's week is strictly newer. So the edit stayed
//      on screen looking saved, the server never had it, and the next tick
//      reverted it a week later — "I only notice it when I make minus".
//
//   2. SERVER. When the tick lost the CAS instead, it logged the airline and
//      moved on, on the theory that it "catches up next pass". It does not: the
//      world clock advances in the same transaction, so that airline does not
//      trade the week at all. The player punished is exactly the active one.
//
//   node tools/decision-recovery-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { tickWorldOnce } from '../apps/headwinds-server/src/lib/tickService.mjs';
import { api, NetworkError } from '../apps/headwinds-web/src/api.js';
import {
  isVersionConflict, shouldRetryDecision, shouldRollback, freshDecisionError,
  runDecisionWrite, VERSION_CONFLICT, MAX_DECISION_RETRIES,
} from '../apps/headwinds-web/src/decisionPolicy.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const err = (status, code = null) => Object.assign(new Error('nope'), { status, code });

console.log('\n── retry policy: only a lost CAS may be re-submitted ─────');

await test('the tagged version conflict is retryable', () => {
  assert.equal(isVersionConflict(err(409, VERSION_CONFLICT)), true);
  assert.equal(shouldRetryDecision(err(409, VERSION_CONFLICT), 0), true);
});

await test('a BARE 409 is NOT retryable', () => {
  // Same status, different meaning: "your airline is BANKRUPT", "this world is
  // ENDED", "only N shares available". Retrying those just repeats the refusal
  // and spams the player with a second identical toast.
  assert.equal(isVersionConflict(err(409)), false);
  assert.equal(shouldRetryDecision(err(409), 0), false);
  assert.equal(shouldRetryDecision(err(409, 'insufficient_float'), 0), false);
});

await test('a TIMEOUT is never retried — its outcome is unknown', () => {
  // This is the dangerous one. A decision that timed out may well have been
  // applied, with only the response lost; re-sending ADD_ROUTE or BUY_AIRCRAFT
  // would open the route twice and buy the aircraft twice. Only the CAS failure
  // tells us for certain that NOTHING was written.
  assert.equal(shouldRetryDecision(new NetworkError('The server did not respond — retrying…'), 0), false);
  assert.equal(shouldRetryDecision(err(0), 0), false);
  assert.equal(shouldRetryDecision(err(503), 0), false);
  assert.equal(shouldRetryDecision(err(500), 0), false);
});

await test('the retry budget is finite', () => {
  assert.equal(shouldRetryDecision(err(409, VERSION_CONFLICT), MAX_DECISION_RETRIES), false);
});

console.log('\n── rollback: a failed write must not stay on screen ──────');

await test('rollback fires once the write chain has drained', () => {
  assert.equal(shouldRollback(0), true);
});

await test('rollback waits while later writes are still in flight', () => {
  // Writes are serialized. Adopting the server blob while a later decision is on
  // the wire would discard THAT decision's optimistic edit — the same bug in
  // reverse. The tail of the chain settles for everyone.
  assert.equal(shouldRollback(1), false);
  assert.equal(shouldRollback(3), false);
});

console.log('\n── engine rejections reach the player ───────────────────');

await test('a newly set engine error is reported', () => {
  assert.equal(freshDecisionError('Not enough cash to start this check.', null),
    'Not enough cash to start this check.');
});

await test('a STICKY engine error is not re-reported', () => {
  // state.error is written by the reducer (MRO certification, heavy-check
  // funding) and never cleared, so it lives in the save blob indefinitely.
  // Reporting it unconditionally would re-raise a week-old message on every
  // later action the player takes.
  const sticky = 'Not enough cash to start this check.';
  assert.equal(freshDecisionError(sticky, sticky), null);
  assert.equal(freshDecisionError(null, sticky), null);
});

console.log('\n── the wire carries the failure kind ────────────────────');

async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = prev; }
}

await test('api() surfaces the server code on a rejection', async () => {
  await withFetch(async () => ({
    ok: false, status: 409, statusText: 'Conflict',
    json: async () => ({ error: 'The world ticked while you were saving — retrying.', code: VERSION_CONFLICT }),
  }), async () => {
    await assert.rejects(api('/worlds/w1/decisions', { method: 'POST' }), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, VERSION_CONFLICT, 'the code must survive the wire — without it the client cannot tell a retryable conflict from a refusal');
      assert.equal(shouldRetryDecision(e, 0), true);
      return true;
    });
  });
});

await test('a coded response still shows the human message', async () => {
  await withFetch(async () => ({
    ok: false, status: 409, statusText: 'Conflict',
    json: async () => ({ error: 'Your airline is BANKRUPT' }),
  }), async () => {
    await assert.rejects(api('/x', { method: 'POST' }), (e) => {
      assert.equal(e.message, 'Your airline is BANKRUPT');
      assert.equal(e.code, null);
      return true;
    });
  });
});

console.log('\n── the write itself: retry, give up, report ─────────────');

// A post() that fails the first N calls with `failWith`, then succeeds.
const flaky = (failures, failWith, res = { ok: true, state: { week: 3 }, stamp: '7:9.2' }) => {
  let calls = 0;
  const post = async () => { calls += 1; if (calls <= failures) throw failWith; return res; };
  post.calls = () => calls;
  return post;
};

await test('a lost CAS is re-submitted and the retry lands', async () => {
  // The reported bug in one test: the tick was mid-commit, the write lost its
  // version check, and the player's fare was dropped on the floor. Now it goes
  // out again against the post-tick state.
  const post = flaky(1, err(409, VERSION_CONFLICT));
  const outcome = await runDecisionWrite({ post });
  assert.equal(outcome.ok, true, 'the retry must land');
  assert.equal(post.calls(), 2, 'exactly one re-submission');
});

await test('two lost CASes give up rather than looping', async () => {
  const post = flaky(99, err(409, VERSION_CONFLICT));
  const outcome = await runDecisionWrite({ post });
  assert.equal(outcome.ok, false);
  assert.equal(post.calls(), 2, 'one retry, then report the failure');
});

await test('a timeout is submitted exactly ONCE', async () => {
  // The safety property. A timed-out ADD_ROUTE may already have opened the
  // route; re-sending it would open a second one and buy a second aircraft.
  const post = flaky(99, new NetworkError('The server did not respond — retrying…'));
  const outcome = await runDecisionWrite({ post });
  assert.equal(outcome.ok, false);
  assert.equal(post.calls(), 1, 'a write with an unknown outcome must never be repeated');
});

await test('a semantic refusal is submitted exactly ONCE', async () => {
  const post = flaky(99, err(409));
  const outcome = await runDecisionWrite({ post });
  assert.equal(outcome.ok, false);
  assert.equal(post.calls(), 1);
});

await test('the failure is handed back intact for the caller to classify', async () => {
  const boom = err(409);
  const outcome = await runDecisionWrite({ post: flaky(99, boom) });
  assert.equal(outcome.error, boom, 'GamePlayScreen still needs the original error (SessionExpiredError, transient, refusal)');
});

await test('an engine refusal on an accepted write is reported', async () => {
  const post = async () => ({ ok: true, state: { week: 3 }, error: 'Not enough cash to start this check.' });
  const outcome = await runDecisionWrite({ post, errorBefore: null });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.rejection, 'Not enough cash to start this check.');
});

await test('a sticky engine error already in the blob is NOT re-reported', async () => {
  const sticky = 'Not enough cash to start this check.';
  const post = async () => ({ ok: true, state: { week: 3 }, error: sticky });
  const outcome = await runDecisionWrite({ post, errorBefore: sticky });
  assert.equal(outcome.rejection, null, 'a week-old message must not fire on every later action');
});

console.log('\n── tick: a decision under the tick must not cost a week ──');

// In-memory Prisma, plus one hook the real thing has and the existing tick test
// does not need: `onWrite`, fired before each airline CAS, so a test can commit a
// "player decision" in exactly the window the tick is racing.
function fakePrisma({ world, airlines, onWrite = null }) {
  const db = {
    world: { ...world },
    airlines: airlines.map((a) => ({ ...a })),
    tickLogs: [], standings: [], news: [], market: null, credits: [],
  };
  let logId = 0;
  const p = {
    _db: db,
    world: {
      findMany: async () => [{ ...db.world }],
      updateMany: async ({ where, data }) => {
        const w = db.world;
        const match = w.id === where.id && w.currentWeek === where.currentWeek
          && w.currentYear === where.currentYear && w.status === where.status;
        if (!match) return { count: 0 };
        Object.assign(w, data);
        return { count: 1 };
      },
    },
    airline: {
      findMany: async ({ where }) => db.airlines
        .filter((a) => a.worldId === where.worldId && a.status === where.status)
        .map((a) => ({ ...a })),
      findUnique: async ({ where }) => {
        const a = db.airlines.find((x) => x.id === where.id);
        return a ? { ...a } : null;
      },
      update: async ({ where, data }) => {
        const a = db.airlines.find((x) => x.id === where.id);
        Object.assign(a, data);
        return { ...a };
      },
      updateMany: async ({ where, data }) => {
        if (onWrite) await onWrite(where, db);
        let count = 0;
        for (const a of db.airlines) {
          if (a.id !== where.id) continue;
          if (where.version !== undefined && (a.version ?? 0) !== where.version) continue;
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in v) a[k] = (a[k] ?? 0) + v.increment;
            else a[k] = v;
          }
          count++;
        }
        return { count };
      },
    },
    tickLog: {
      create: async ({ data }) => { const r = { id: `t${++logId}`, ...data }; db.tickLogs.push(r); return { ...r }; },
      update: async ({ where, data }) => { Object.assign(db.tickLogs.find((t) => t.id === where.id), data); },
    },
    standing: {
      createMany: async ({ data }) => { db.standings.push(...data); return { count: data.length }; },
      findMany: async ({ where = {} }) => db.standings
        .filter((r) => r.week === where.week && (where.rank?.lte == null || r.rank <= where.rank.lte))
        .sort((x, y) => x.rank - y.rank),
    },
    worldMarket: {
      findUnique: async ({ where }) => (db.market && db.market.worldId === where.worldId) ? { ...db.market } : null,
      update: async ({ where, data }) => {
        if (!db.market || db.market.id !== where.id) return null;
        for (const [k, v] of Object.entries(data)) db.market[k] = v;
        return { ...db.market };
      },
      updateMany: async ({ where, data }) => {
        if (!db.market || db.market.id !== where.id) return { count: 0 };
        if (where.version !== undefined && db.market.version !== where.version) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in v) db.market[k] = (db.market[k] ?? 0) + v.increment;
          else db.market[k] = v;
        }
        return { count: 1 };
      },
      create: async ({ data }) => { db.market = { id: 'mkt1', version: 0, ...data }; return { ...db.market }; },
      upsert: async ({ create }) => { if (!db.market) db.market = { id: 'mkt1', version: 0, ...create }; return { ...db.market }; },
    },
    dividendCredit: {
      findMany: async ({ where = {} }) => db.credits.filter((c) =>
        (where.worldId == null || c.worldId === where.worldId)
        && (where.consumed == null || c.consumed === where.consumed)).map((c) => ({ ...c })),
      createMany: async ({ data }) => { for (const d of data) db.credits.push({ id: `dc${db.credits.length + 1}`, consumed: false, ...d }); return { count: data.length }; },
      updateMany: async ({ where = {}, data }) => {
        let count = 0;
        const ids = where.id?.in ?? null;
        for (const c of db.credits) { if (ids && !ids.includes(c.id)) continue; Object.assign(c, data); count++; }
        return { count };
      },
    },
    worldNews: {
      createMany: async ({ data }) => { db.news.push(...data); return { count: data.length }; },
      deleteMany: async ({ where = {} }) => {
        const before = db.news.length;
        const lt = where.week?.lt;
        if (lt != null) db.news = db.news.filter((n) => !(n.week < lt));
        return { count: before - db.news.length };
      },
    },
    alliance: { findMany: async () => [] },
  };
  p.$transaction = async (fn) => fn(p);
  return p;
}

const quiet = { info: () => {}, error: () => {}, warn: () => {} };

const seedAirline = (id, name, hub) => {
  const state = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  state.equity = { ...state.equity, isPublic: true };
  return { id, worldId: 'w1', accountId: `acct_${id}`, name, hub, state, status: 'ACTIVE', week: 1, version: 0 };
};

const makeWorld = (over = {}) => ({
  id: 'w1', name: 'Test World', status: 'RUNNING',
  lengthYears: 50, weeksPerDay: 12,
  currentWeek: 1, currentYear: 1,
  startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
  ...over,
});

// The player's decision, committed in the race window: rename the airline. A
// rename is the cleanest possible marker — it is a plain blob field the tick
// neither reads nor derives, so if it survives the week we know the recompute
// built on the player's state rather than clobbering it with the stale read.
const PLAYER_EDIT = 'Edited Mid-Tick Airways';

function racingPrisma(targetId) {
  let fired = false;
  return fakePrisma({
    world: makeWorld(),
    airlines: [seedAirline('a1', 'Alpha', 'JFK'), seedAirline('a2', 'Beta', 'LAX')],
    onWrite: async (where, db) => {
      if (fired || where.id !== targetId) return;
      fired = true;
      const a = db.airlines.find((x) => x.id === targetId);
      a.state = { ...a.state, airlineName: PLAYER_EDIT };
      a.version = (a.version ?? 0) + 1; // the decision's own CAS bump
    },
  });
}

await test('an airline whose decision beat the tick still trades the week', async () => {
  // PRE-FIX: the tick logged "changed under the tick — skipped, catches up next
  // pass" and moved on. The world clock had already advanced in the same
  // transaction, so this airline silently lost a whole week: no revenue, no
  // costs, no financialHistory row, no standings entry.
  const prisma = racingPrisma('a1');
  const res = await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  assert.equal(res.ok, true);

  const a1 = prisma._db.airlines.find((a) => a.id === 'a1');
  assert.equal(a1.week, 2, 'the racing airline must be advanced to the new week, not skipped');
  assert.equal(res.airlines, 2, 'both airlines must be counted as written');
});

await test('the recompute builds on the decision, it does not clobber it', async () => {
  // The whole point of losing the CAS is that the player's write got there
  // first. Recomputing from the STALE read would overwrite it — trading one
  // silent data loss for another.
  const prisma = racingPrisma('a1');
  await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  const a1 = prisma._db.airlines.find((a) => a.id === 'a1');
  assert.equal(a1.state.airlineName, PLAYER_EDIT,
    'the player decision that won the race must survive the tick');
});

await test('the racing airline is ranked in the standings', async () => {
  // A skipped airline never reached `written`, so it dropped out of the
  // leaderboard for that week too.
  const prisma = racingPrisma('a1');
  await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  const week2 = prisma._db.standings.filter((s) => s.week === 2);
  assert.equal(week2.length, 2);
  assert.ok(week2.some((s) => s.airlineId === 'a1'), 'the racing airline must appear in the standings');
});

await test('an airline that loses the race TWICE is skipped, not looped on', async () => {
  // One retry only: the recompute runs inside the tick transaction, which holds
  // locks on every airline in the world. An unbounded loop there would be far
  // worse than one player losing one week.
  let hits = 0;
  const prisma = fakePrisma({
    world: makeWorld(),
    airlines: [seedAirline('a1', 'Alpha', 'JFK')],
    onWrite: async (where, db) => {
      if (where.id !== 'a1' || hits >= 2) return;
      hits += 1;
      const a = db.airlines.find((x) => x.id === 'a1');
      a.version = (a.version ?? 0) + 1;
    },
  });
  const res = await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  assert.equal(res.ok, true, 'the week must still commit for everyone else');
  assert.equal(hits, 2, 'exactly one recompute attempt, no retry loop');
});

await test('an unaffected world is untouched by the recompute path', async () => {
  const prisma = fakePrisma({
    world: makeWorld(),
    airlines: [seedAirline('a1', 'Alpha', 'JFK'), seedAirline('a2', 'Beta', 'LAX')],
  });
  const res = await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  assert.equal(res.ok, true);
  assert.equal(res.airlines, 2);
  for (const a of prisma._db.airlines) assert.equal(a.week, 2);
  assert.equal(prisma._db.airlines.find((a) => a.id === 'a1').state.airlineName, 'Alpha');
});

console.log(`\ndecision-recovery-test: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
