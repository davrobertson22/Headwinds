// A save must never land after the player's screen has been told it didn't.
//
// Incident 2026-09-21 (Discord, TheCookiesGuy): "the server disconnected me and
// keeps disconnecting. But yet the money that I spend keeps going down. It's
// like the progress doesn't save but the money does". Supavisor's pool was
// wedging (the 2026-09-16 outage again). Two defects turned a slow database
// into lost-looking, double-paid progress:
//
//   1. SERVER. POST /decisions could spend 20s per pre-transaction read waiting
//      for a pool connection and still COMMIT after the browser had aborted at
//      25s. The client treats a timeout as unknown, rolls back to server state
//      fetched before the late commit — so the purchase "vanished" while the
//      cash was really gone, and redoing it paid twice. Now the transaction
//      checks a commit cutoff (measured from request arrival) first and last,
//      and rolls itself back past it: 503 retryable, nothing written.
//
//   2. CLIENT. The rollback's own full load usually failed for the same reason
//      the write did, and nothing remembered it was owed: later polls were
//      shallow, came back unchanged, and the phantom edit stayed on screen.
//      A rollback is now a debt that upgrades every load to a full one until
//      one succeeds.
//
//   node tools/late-commit-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  withTx, assertWithinDeadline, DeadlineError, transientKind,
} from '../apps/headwinds-server/src/lib/tx.mjs';
import {
  wantsFullResync, DECISION_TIMEOUT_MS,
} from '../apps/headwinds-web/src/decisionPolicy.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// A $transaction that behaves like Postgres: writes are staged and only become
// visible if the body returns; a throw discards them.
function fakePrisma() {
  const committed = [];
  let calls = 0;
  return {
    committed,
    get calls() { return calls; },
    async $transaction(fn) {
      calls++;
      const staged = [];
      const tx = { airline: { updateMany: async (a) => { staged.push(a); return { count: 1 }; } } };
      const out = await fn(tx);
      committed.push(...staged);
      return out;
    },
  };
}

const decisionsSrc = read('../apps/headwinds-server/src/routes/decisions.mjs');
const cutoff = Number((decisionsSrc.match(/export const DECISION_COMMIT_CUTOFF_MS = ([\d_]+);/) ?? [])[1]?.replace(/_/g, ''));

console.log('\nServer: no commit after the client has given up');

await test('assertWithinDeadline passes inside the cutoff and throws DeadlineError at it', () => {
  assertWithinDeadline(19_999, 20_000);
  assert.throws(() => assertWithinDeadline(20_000, 20_000), DeadlineError);
  assert.throws(() => assertWithinDeadline(31_000, 20_000), DeadlineError);
});

await test('a DeadlineError is answered as 503 retryable — the guarantee that nothing was written', () => {
  assert.equal(transientKind(new DeadlineError(21_000, 20_000)), 'connection');
});

await test('a transaction whose request is past the cutoff writes NOTHING (checked last, after its writes)', async () => {
  const prisma = fakePrisma();
  let elapsed = 19_000;
  await assert.rejects(withTx(prisma, async (tx) => {
    assertWithinDeadline(elapsed, 20_000);
    await tx.airline.updateMany({ where: { id: 'a' }, data: { cash: 1 } });
    elapsed = 24_000; // the write sat on a row lock
    assertWithinDeadline(elapsed, 20_000);
  }, { deadlineMs: null }), DeadlineError);
  assert.equal(prisma.committed.length, 0);
});

await test('withTx does not retry a DeadlineError (the deadline is the request\'s, not the attempt\'s)', async () => {
  const prisma = fakePrisma();
  await assert.rejects(withTx(prisma, async () => assertWithinDeadline(25_000, 20_000), { retries: 3, deadlineMs: null }), DeadlineError);
  assert.equal(prisma.calls, 1);
});

await test('POST /decisions checks the cutoff as the first AND last statement of its transaction', () => {
  const start = decisionsSrc.indexOf('await withTx(prisma, async (tx) => {');
  assert.ok(start > 0, 'decision transaction not found');
  const optsAt = decisionsSrc.indexOf('\n      }, {\n        timeout: 20_000', start);
  assert.ok(optsAt > start, 'decision transaction options not found');
  const body = decisionsSrc.slice(start, optsAt)
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
  const check = 'assertWithinDeadline(reply.elapsedTime, DECISION_COMMIT_CUTOFF_MS);';
  assert.equal(body[1], check, 'first statement');
  assert.equal(body[body.length - 1], check, 'last statement');
});

await test('the server cutoff leaves at least 4s for COMMIT before the browser aborts', () => {
  assert.ok(Number.isFinite(cutoff), 'DECISION_COMMIT_CUTOFF_MS not found');
  assert.ok(cutoff + 4_000 <= DECISION_TIMEOUT_MS, `${cutoff} vs ${DECISION_TIMEOUT_MS}`);
});

await test('the game screen aborts decisions at DECISION_TIMEOUT_MS, not a private number', () => {
  const src = read('../apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(src, /\/decisions`,\s*\{ method: 'POST', token, body: \{ type, payload \}, timeoutMs: DECISION_TIMEOUT_MS \}/);
});

console.log('\nClient: a rollback that could not load keeps trying');

// The poll loop's view of one failed write during an outage:
//   write fails → rollback load (full) FAILS → later polls must still be full.
function simulate({ owedAfterFailure }) {
  let owed = false;
  const loads = [];
  const load = ({ full = false } = {}, ok) => {
    const f = wantsFullResync({ requested: full, pending: owed, writesInFlight: 0 });
    loads.push(f);
    if (ok && f) owed = false;
  };
  owed = owedAfterFailure;       // the write failed
  load({ full: true }, false);   // rollback load — database still down
  load({}, true);                // next ordinary poll, database back
  return { loads, owed };
}

await test('after a failed rollback load, the next ordinary poll is FULL and settles the debt', () => {
  const r = simulate({ owedAfterFailure: true });
  assert.deepEqual(r.loads, [true, true]);
  assert.equal(r.owed, false);
});

await test('a pending rollback waits while writes are still in flight', () => {
  assert.equal(wantsFullResync({ pending: true, writesInFlight: 1 }), false);
  assert.equal(wantsFullResync({ pending: true, writesInFlight: 0 }), true);
  assert.equal(wantsFullResync({ requested: true, writesInFlight: 0 }), true);
  assert.equal(wantsFullResync({}), false);
});

await test('GamePlayScreen owes a rollback on every failed write and upgrades loads through wantsFullResync', () => {
  const src = read('../apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(src, /resyncOwed\.current = true;\s*\n\s*if \(shouldRollback\(writesInFlight\.current\)\) load\(\{ full: true \}\);/);
  assert.match(src, /const full = wantsFullResync\(\{\s*requested: fullRequested, pending: resyncOwed\.current, writesInFlight: writesInFlight\.current,/);
  assert.match(src, /setState\(withStatsBackfill\(incoming\)\);\s*\n\s*if \(full\) resyncOwed\.current = false;/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
