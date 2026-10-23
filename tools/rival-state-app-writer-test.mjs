// rival-state-app-writer-test.mjs — the weekly tick writes Airline."rivalState"
// itself and the trigger stands aside for it (outage 2026-10-22).
//
// The trigger from 20261022000000_airline_rival_state ran rival_state_of() on
// every `state` write: ~3 s for Scarce Assets' 20 MB airline, ~10 s per weekly
// commit, which pushed the commit past its 30 s budget and crash-looped the
// worker. Migration 20261023000000_rival_state_app_writer lets a transaction
// that set headwinds.rival_state_writer = 'app' (SET LOCAL) write the column
// from JS instead (lib/rivalStateWrite.mjs, used by tickService).
//
// Runs the REAL migrations in PGlite. What this proves:
//   1. without the mark the trigger works exactly as before
//   2. under the mark a `state` write leaves "rivalState" alone, and
//      writeRivalStates fills it with exactly what the trigger would have
//   3. the mark is transaction-local: after COMMIT or ROLLBACK the next write
//      on the same connection fires the trigger again
//   4. loadRivalRows reads the app-written column
//   5. the tick wires it: marks before its airline writes, writes the column
//      after the recompute pass, from the same persisted state it stored
//
// RIVAL_APP_WRITER_HEAD=1 applies only the 2026-10-22 migration (HEAD) — the
// section 2 and 3 checks fail there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { loadRivalRows, projectRivalState } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import {
  beginAppRivalStates, writeRivalStates, rivalStateFor, RIVAL_STATE_WRITER_SETTING,
} from '../apps/headwinds-server/src/lib/rivalStateWrite.mjs';

const HEAD = process.env.RIVAL_APP_WRITER_HEAD === '1';
const mig = (name) => readFileSync(new URL(`../apps/headwinds-server/prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const db = new PGlite();
await db.exec(`
  CREATE TYPE "AirlineStatus" AS ENUM ('ACTIVE', 'BANKRUPT', 'ABANDONED');
  CREATE TABLE "Account" (
    id text PRIMARY KEY, "isOG" boolean NOT NULL DEFAULT false,
    "isSupporter" boolean NOT NULL DEFAULT false, email text);
  CREATE TABLE "Airline" (
    id text PRIMARY KEY, "worldId" text NOT NULL, "accountId" text NOT NULL REFERENCES "Account"(id),
    name text NOT NULL, hub text NOT NULL, state jsonb NOT NULL, "customLogo" text,
    cash bigint NOT NULL DEFAULT 0,
    "rankScore" bigint, "weeklyProfit" bigint, "netAssets" bigint,
    "paxWeek" integer, "flightsWeek" integer, "fleetSize" integer,
    version integer NOT NULL DEFAULT 0, status "AirlineStatus" NOT NULL DEFAULT 'ACTIVE',
    restarts integer NOT NULL DEFAULT 0);
`);
await db.exec(mig('20261022000000_airline_rival_state'));
if (!HEAD) await db.exec(mig('20261023000000_rival_state_app_writer'));

// Prisma-shaped $queryRaw over a PGlite connection or transaction.
const rawOver = (conn) => ({
  $queryRaw: async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + '$' + i + s);
    return (await conn.query(text, values)).rows;
  },
});
const prisma = rawOver(db);

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const blob = (seed, n = 40) => ({
  week: seed, cash: 1e6 * seed, airlineName: `Air ${seed}`, hubs: ['LHR'],
  routes: range(n, (i) => ({ id: `r${seed}-${i}`, origin: 'LHR', destination: `X${i}`, fare: 100.25 + i })),
  fleet: range(n, (i) => ({ id: `a${seed}-${i}`, typeId: 'B738', config: { y: 189 }, ageWeeks: i + seed, status: 'active', value: 4.5e7 - i })),
  financialHistory: range(n, (i) => ({ week: i, profit: 1e5 * (i - 20) + seed, revenue: 3e6 + i, passengers: 5e4 + i, fuelIndex: 0.1 + 0.2 + i / 100, detail: { x: [1, 2, 3] } })),
  statsHistory: range(n, (i) => ({ sharePrice: 10 + i / 7, other: i })),
  lastReport: { reputation: 'good', reputationScore: 71.5, totalPassengers: 12345 + seed, routeResults: range(n, (i) => ({ id: i })) },
});
const sqlProjection = async (conn, id) =>
  (await conn.query(`SELECT public.rival_state_of(state) AS p FROM "Airline" WHERE id = $1`, [id])).rows[0].p;
const rivalCol = async (conn, id) =>
  (await conn.query(`SELECT "rivalState" AS r FROM "Airline" WHERE id = $1`, [id])).rows[0].r;

await db.query(`INSERT INTO "Account" (id, email) VALUES ('acc', 'a@example.com')`);
for (const [id, seed] of [['al1', 1], ['al2', 2], ['al3', 3]]) {
  await db.query(`INSERT INTO "Airline" (id, "worldId", "accountId", name, hub, state) VALUES ($1, 'w1', 'acc', $1, 'LHR', $2::jsonb)`,
    [id, JSON.stringify(blob(seed))]);
}

console.log('\n── 1. Without the mark, the trigger is unchanged ──────────────');

await test('a plain state write still fills "rivalState" via rival_state_of()', async () => {
  await db.query(`UPDATE "Airline" SET state = $1::jsonb WHERE id = 'al1'`, [JSON.stringify(blob(11))]);
  assert.deepStrictEqual(await rivalCol(db, 'al1'), await sqlProjection(db, 'al1'));
  assert.equal((await rivalCol(db, 'al1')).week, 11);
});

console.log('\n── 2. Under the mark, the app writes the column ───────────────');

await test('the mark makes the trigger leave "rivalState" alone', async () => {
  await db.transaction(async (tx) => {
    const before = await rivalCol(tx, 'al2');
    assert.equal(await beginAppRivalStates(rawOver(tx)), true);
    assert.equal((await tx.query(`SELECT current_setting('${RIVAL_STATE_WRITER_SETTING}', true) AS v`)).rows[0].v, 'app');
    await tx.query(`UPDATE "Airline" SET state = $1::jsonb WHERE id = 'al2'`, [JSON.stringify(blob(22))]);
    assert.deepStrictEqual(await rivalCol(tx, 'al2'), before, 'trigger stood aside');
    await tx.rollback();
  });
});

await test('writeRivalStates stores exactly what the trigger would have (one statement, listed rows only)', async () => {
  await db.transaction(async (tx) => {
    const t = rawOver(tx);
    await beginAppRivalStates(t);
    const byId = new Map();
    for (const [id, seed] of [['al2', 22], ['al3', 33]]) {
      const persisted = blob(seed, 60);
      await tx.query(`UPDATE "Airline" SET state = $1::jsonb WHERE id = $2`, [JSON.stringify(persisted), id]);
      byId.set(id, rivalStateFor(persisted));
    }
    const untouched = await rivalCol(tx, 'al1');
    assert.equal(await writeRivalStates(t, byId), 2);
    for (const id of ['al2', 'al3']) assert.deepStrictEqual(await rivalCol(tx, id), await sqlProjection(tx, id), id);
    assert.deepStrictEqual(await rivalCol(tx, 'al1'), untouched, 'al1 not in the map, not touched');
  });
  assert.equal((await rivalCol(db, 'al3')).week, 33, 'committed');
});

console.log('\n── 3. The mark is transaction-local ───────────────────────────');

await test('after COMMIT the next write on the same connection fires the trigger', async () => {
  await db.transaction(async (tx) => { await beginAppRivalStates(rawOver(tx)); });
  assert.equal((await db.query(`SELECT current_setting('${RIVAL_STATE_WRITER_SETTING}', true) AS v`)).rows[0].v ?? '', '');
  await db.query(`UPDATE "Airline" SET state = $1::jsonb WHERE id = 'al3'`, [JSON.stringify(blob(44))]);
  assert.equal((await rivalCol(db, 'al3')).week, 44);
  assert.deepStrictEqual(await rivalCol(db, 'al3'), await sqlProjection(db, 'al3'));
});

await test('after ROLLBACK as well', async () => {
  await db.transaction(async (tx) => { await beginAppRivalStates(rawOver(tx)); await tx.rollback(); });
  await db.query(`UPDATE "Airline" SET state = $1::jsonb WHERE id = 'al3'`, [JSON.stringify(blob(55))]);
  assert.equal((await rivalCol(db, 'al3')).week, 55);
});

console.log('\n── 4. Readers see the app-written column ──────────────────────');

await test('loadRivalRows returns the app-written projection', async () => {
  await db.transaction(async (tx) => {
    const t = rawOver(tx);
    await beginAppRivalStates(t);
    const persisted = blob(66, 30);
    await tx.query(`UPDATE "Airline" SET state = $1::jsonb WHERE id = 'al1'`, [JSON.stringify(persisted)]);
    await writeRivalStates(t, new Map([['al1', rivalStateFor(persisted)]]));
  });
  const row = (await loadRivalRows(prisma, 'w1')).find((r) => r.id === 'al1');
  assert.equal(row.state.week, 66);
  assert.deepStrictEqual(row.state, projectRivalState((await db.query(`SELECT state FROM "Airline" WHERE id = 'al1'`)).rows[0].state));
});

await test('doubles without $queryRaw skip both steps', async () => {
  assert.equal(await beginAppRivalStates({}), false);
  assert.equal(await writeRivalStates({}, new Map([['x', {}]])), 0);
  assert.equal(await writeRivalStates(prisma, new Map()), 0);
});

console.log('\n── 5. The tick wires it ───────────────────────────────────────');

await test('tickService: mark before the writes, column after the recompute pass, from the persisted state', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  const begin = src.indexOf('const appRivalStates = await beginAppRivalStates(tx);');
  const firstWrite = src.indexOf('if (await writeAirline(c)) written.push(writtenRow(c));');
  const recompute = src.indexOf('for (const stale of conflicted)');
  const flush = src.indexOf('if (appRivalStates) await writeRivalStates(tx, rivalStates);');
  const renewals = src.indexOf('// ── Fleet renewal sales');
  assert.ok(begin > 0 && firstWrite > begin, 'marked before the first airline write');
  assert.ok(flush > recompute && flush < renewals, 'flushed after the recompute pass');
  const wa = src.slice(src.indexOf('const writeAirline = async (c) => {'), firstWrite);
  assert.match(wa, /const persisted = splitLogo\(stripRivals\(c\.next\)\)\.state;/);
  assert.match(wa, /state: persisted,/);
  assert.match(wa, /rivalStates\.set\(c\.airline\.id, rivalStateFor\(persisted\)\)/);
});

await db.close();
console.log(`\n${failed ? '✗' : '✓'} rival-state-app-writer: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
