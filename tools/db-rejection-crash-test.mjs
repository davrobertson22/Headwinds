// One dead database socket must not take the whole API down.
//
// Incident 2026-10-23: the API crashed 11 times in a day and then stayed down
// for 3 hours (Railway's ON_FAILURE policy gives up after 10 restarts). Every
// crash was the same: an interactive transaction outlived its timeout, Prisma's
// own timer tried to ROLLBACK on a connection that had died (ETIMEDOUT, or pg's
// "Connection terminated unexpectedly"), and that rejection — from an async
// setTimeout callback inside @prisma/client — was unhandled, so Node exited.
// Discord (Matthijs, Time Flies): "half of the actions i do dont get picked up".
//
// This drives the REAL @prisma/client + @prisma/adapter-pg transaction path in a
// child process, over a pg.Pool whose ROLLBACK fails the way production's did,
// and checks the process survives once the server's guard is installed. The
// unguarded run is the control: it shows the repro still reproduces, i.e. what
// HEAD did before the guard existed.
//
//   node tools/db-rejection-crash-test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDatabaseLayerFault } from '../apps/headwinds-server/src/lib/processGuard.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = new URL('../apps/headwinds-server/src/lib/processGuard.mjs', import.meta.url).href;
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// A child that opens a Prisma interactive transaction with a 100 ms timeout,
// holds it for 400 ms, and runs on a pool whose ROLLBACK fails like the dead
// sockets on 2026-10-23. `failure` picks the production error shape.
function child({ guard, failure = 'etimedout', alsoThrow = null }) {
  const code = `
    import pg from 'pg';
    import { PrismaClient } from '@prisma/client';
    import { PrismaPg } from '@prisma/adapter-pg';
    ${guard ? `const { installProcessGuards } = await import(${JSON.stringify(GUARD)});
    installProcessGuards({ label: 'test' });` : ''}
    const dead = () => {
      if (${JSON.stringify(failure)} === 'terminated') return new Error('Connection terminated unexpectedly');
      const e = new Error('read ETIMEDOUT'); e.code = 'ETIMEDOUT'; return e;
    };
    class DyingPool extends pg.Pool {
      async connect() {
        return {
          on() {}, removeListener() {}, release() {},
          async query(q) {
            const sql = typeof q === 'string' ? q : q.text;
            if (/^ROLLBACK/i.test(sql)) throw dead();
            return { rows: [], fields: [], rowCount: 0, command: sql.split(' ')[0] };
          },
        };
      }
    }
    const prisma = new PrismaClient({ adapter: new PrismaPg(new DyingPool({ connectionString: 'postgres://x@127.0.0.1:1/x' })) });
    let txOutcome = 'pending';
    prisma.$transaction(async () => { await new Promise((r) => setTimeout(r, 400)); }, { timeout: 100, maxWait: 1000 })
      .then(() => { txOutcome = 'resolved'; }, () => { txOutcome = 'rejected'; });
    ${alsoThrow ? `setTimeout(() => { Promise.reject(new TypeError(${JSON.stringify(alsoThrow)})); }, 900);` : ''}
    setTimeout(() => { console.log('SURVIVED tx=' + txOutcome); process.exit(0); }, 1500);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 });
}

console.log('\nUnhandled database-layer rejections\n');

test('control: without the guard, a timed-out tx on a dead socket kills the process (HEAD behaviour)', () => {
  const r = child({ guard: false });
  assert.notEqual(r.status, 0, `expected a crash, got exit ${r.status}\n${r.stdout}`);
  assert.ok(!r.stdout.includes('SURVIVED'), r.stdout);
  assert.match(r.stderr, /ETIMEDOUT/);
  assert.match(r.stderr, /@prisma[\\/]client[\\/]runtime/, 'the rejection comes out of Prisma\'s tx timer');
});

test('with the guard, the same rejection is logged and the process lives', () => {
  const r = child({ guard: true });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /SURVIVED tx=rejected/, 'the request that owned the tx still gets its own error');
  assert.match(r.stderr, /\[test\] unhandled database-layer rejection — logged, NOT crashing: read ETIMEDOUT/);
});

test('with the guard, pg\'s "Connection terminated unexpectedly" (crash at 14:26:37) is survived too', () => {
  const r = child({ guard: true, failure: 'terminated' });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /NOT crashing: Connection terminated unexpectedly/);
});

test('a rejection from OUR code still crashes the process — only the DB layer is excused', () => {
  const r = child({ guard: true, alsoThrow: 'boom from app code' });
  assert.notEqual(r.status, 0, `expected a crash, got exit ${r.status}\n${r.stdout}`);
  assert.match(r.stderr, /TypeError: boom from app code/);
  assert.ok(!r.stdout.includes('SURVIVED'));
});

test('classifier: production shapes are DB faults, app errors and non-errors are not', () => {
  const dae = new Error('SocketTimeout'); dae.name = 'DriverAdapterError';
  assert.equal(isDatabaseLayerFault(dae), true);
  class PrismaClientKnownRequestError extends Error {}
  assert.equal(isDatabaseLayerFault(new PrismaClientKnownRequestError('x')), true);
  const pgErr = new Error('Connection terminated unexpectedly');
  pgErr.stack = 'Error: Connection terminated unexpectedly\n    at /app/node_modules/pg/lib/client.js:694:17';
  assert.equal(isDatabaseLayerFault(pgErr), true);
  assert.equal(isDatabaseLayerFault(new TypeError('x is undefined')), false);
  assert.equal(isDatabaseLayerFault('a string'), false);
  assert.equal(isDatabaseLayerFault(undefined), false);
});

test('the API and the worker both install the guard at start-up', () => {
  const server = read('../apps/headwinds-server/src/server.mjs');
  const worker = read('../apps/headwinds-server/worker/index.mjs');
  assert.match(server, /installProcessGuards\(\{[^}]*label: 'api'/);
  assert.match(worker, /installProcessGuards\(\{[^}]*label: 'worker'/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
