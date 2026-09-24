// A database that did not answer is not our bug, and /health must say so.
//
// 2026-09-16: Supavisor's transaction-mode pool wedged for ~18 hours. Every
// query died with ECHECKOUTTIMEOUT (a PrismaClientUnknownRequestError with no
// code); after the pool was reconfigured, each stale socket threw P1017 once.
// The API mapped both to 500 "Something went wrong on our end", which the
// client renders as a dead red line and does not retry — while /health, which
// never touched Postgres, kept Railway's status green throughout.
//
// Verified failing on HEAD: isTransientTxError() returned false for all three
// error shapes below, and /health had no database probe to fail.
//
//   node tools/transient-db-error-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  transientKind, isTransientTxError, TRANSIENT_MESSAGE,
} from '../apps/headwinds-server/src/lib/tx.mjs';
import {
  probeDatabase, healthReport, HEALTH_DB_TIMEOUT_MS,
} from '../apps/headwinds-server/src/lib/health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}

// The three shapes from the Railway log, verbatim.
const p1017 = Object.assign(
  new Error('Invalid `prisma.account.findUnique()` invocation: Server has closed the connection.'),
  { code: 'P1017', name: 'PrismaClientKnownRequestError' },
);
const checkoutTimeout = Object.assign(
  new Error('Invalid `prisma.world.findMany()` invocation: Error in connector: Error querying the database: FATAL: (ECHECKOUTTIMEOUT) unable to check out connection from the pool after 60000ms in Transaction mode'),
  { name: 'PrismaClientUnknownRequestError' },
);
const p1001 = Object.assign(
  new Error("Can't reach database server at `aws-1-us-east-2.pooler.supabase.com:6543`"),
  { code: 'P1001' },
);

// ── Classification ───────────────────────────────────────────────────────────

await t('P1017 "Server has closed the connection" is a connection failure', () => {
  assert.equal(transientKind(p1017), 'connection');
  assert.equal(isTransientTxError(p1017), true);
});

await t('ECHECKOUTTIMEOUT with no Prisma code is a connection failure (matched on text)', () => {
  assert.equal(transientKind(checkoutTimeout), 'connection');
});

await t('P1001 "Can\'t reach database server" is a connection failure', () => {
  assert.equal(transientKind(p1001), 'connection');
});

await t('the pre-existing transaction cases still classify as tx, not connection', () => {
  assert.equal(transientKind(Object.assign(new Error('x'), { code: 'P2028' })), 'tx');
  assert.equal(transientKind(Object.assign(new Error('x'), { code: 'P2034' })), 'tx');
  assert.equal(transientKind(new Error('Transaction API error: Transaction already closed')), 'tx');
  assert.equal(transientKind(new Error('deadlock detected')), 'tx');
});

// node-postgres shapes, since the move to the Rust-free client (lib/pgPool.mjs).
// Captured 2026-09-23 against the real database: a pool of 1 held by a
// transaction, a second query, connectionTimeoutMillis 2000 → the first; the
// others are node-postgres's own wording for a dropped / never-opened socket.
// Verified failing on HEAD: transientKind() returned null for all three.
await t('pg pool wait expiry ("timeout exceeded when trying to connect", no code) is transient', () => {
  assert.equal(transientKind(new Error('timeout exceeded when trying to connect')), 'tx');
});

await t('pg dropped / never-opened sockets are connection failures', () => {
  assert.equal(transientKind(new Error('Connection terminated unexpectedly')), 'connection');
  assert.equal(transientKind(new Error('Connection terminated due to connection timeout')), 'connection');
});

await t('a real error is still a real error', () => {
  assert.equal(transientKind(null), null);
  assert.equal(transientKind(new Error('Unique constraint failed on the fields: (`code`)')), null);
  assert.equal(transientKind(Object.assign(new Error('x'), { code: 'P2002' })), null);
  assert.equal(transientKind(Object.assign(new Error('Validation failed'), { code: 'FST_ERR_VALIDATION' })), null);
});

await t('each kind has a player-readable message that says to try again', () => {
  for (const kind of ['tx', 'connection']) {
    assert.match(TRANSIENT_MESSAGE[kind], /try again/i);
    assert.ok(!/something went wrong on our end/i.test(TRANSIENT_MESSAGE[kind]),
      `${kind} must not be blamed on us`);
  }
  assert.notEqual(TRANSIENT_MESSAGE.tx, TRANSIENT_MESSAGE.connection);
});

// ── /health probe ────────────────────────────────────────────────────────────

const answers = { $queryRaw: async () => [{ '?column?': 1 }] };
const dead = { $queryRaw: async () => { throw checkoutTimeout; } };
const hangs = { $queryRaw: () => new Promise(() => {}) };

await t('a database that answers reports ok with a timing', async () => {
  const db = await probeDatabase(answers);
  assert.equal(db.ok, true);
  assert.ok(Number.isInteger(db.ms) && db.ms >= 0);
  assert.equal(healthReport({ db, service: 's', commit: 'c' }).status, 200);
});

await t('a database that throws reports not-ok and a 503', async () => {
  const db = await probeDatabase(dead);
  assert.equal(db.ok, false);
  assert.match(db.error, /ECHECKOUTTIMEOUT/);
  const r = healthReport({ db, service: 'headwinds-api', commit: 'abc1234' });
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.commit, 'abc1234');
  assert.equal(r.body.db.ok, false);
});

await t('a database that never answers is cut off at the ceiling, not at 60s', async () => {
  const t0 = Date.now();
  const db = await probeDatabase(hangs, 80);
  const took = Date.now() - t0;
  assert.equal(db.ok, false);
  assert.equal(db.error, 'HEALTH_TIMEOUT');
  assert.ok(took >= 70 && took < 1_000, `took ${took}ms`);
});

await t('the default ceiling is well inside the client\'s 15s request budget', () => {
  assert.ok(HEALTH_DB_TIMEOUT_MS <= 5_000, `${HEALTH_DB_TIMEOUT_MS}ms`);
});

// ── The server actually uses both ────────────────────────────────────────────
// Importing server.mjs instantiates Prisma and reads env; server-boot-test.mjs
// explains why that is off the table. So, like it, check the wiring statically.

await t('server.mjs routes /health through probeDatabase and errors through transientKind', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/headwinds-server/src/server.mjs'), 'utf8');
  assert.match(src, /probeDatabase\(prisma\)/, '/health must probe the database');
  assert.match(src, /healthReport\(/, '/health must map the probe to a status');
  assert.match(src, /transientKind\(err\)/, 'error handler must classify by kind');
  assert.match(src, /TRANSIENT_MESSAGE\[kind\]/, 'error handler must use the per-kind message');
  assert.ok(!/isTransientTxError/.test(src), 'server.mjs should use transientKind directly');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
