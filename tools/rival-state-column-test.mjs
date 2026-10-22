// Rival state column test — runs the REAL migration in PGlite (Postgres in
// WASM, in-process: no server, no network).
//
// Context (outage 2026-10-21): loadRivalRows trimmed every ACTIVE airline's
// whole `state` blob inside Postgres on every rival rebuild. Detoasting those
// blobs (~70 MB for Scarce Assets) kept pushing Postgres over its commit limit;
// it crashed on 2026-10-03, 10-18 and 10-21. Migration
// 20261022000000_airline_rival_state keeps the trimmed copy in its own column,
// written by a trigger on every `state` write, and loadRivalRows reads that.
//
// What this proves:
//   1. rival_state_of(state) (SQL) deep-equals projectRivalState(state) (JS)
//      on deep, short, missing and wrong-typed inputs — the twins cannot drift
//   2. the trigger fills "rivalState" on INSERT and on every write of `state`,
//      and leaves it alone when other columns change
//   3. loadRivalRows READS the column (a sentinel in "rivalState" comes back,
//      not a projection of `state`), falls back to rival_state_of(state) for a
//      row the backfill has not reached, and still returns only ACTIVE rows
//   4. the Prisma client never selects the column (@ignore)
//
//   node tools/rival-state-column-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  loadRivalRows,
  projectRivalState,
  RIVAL_FIN_KEEP,
  RIVAL_STATS_KEEP,
} from '../apps/headwinds-server/src/lib/humanRivals.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const MIGRATION = fileURLToPath(new URL(
  '../apps/headwinds-server/prisma/migrations/20261022000000_airline_rival_state/migration.sql', import.meta.url));
const SCHEMA = fileURLToPath(new URL('../apps/headwinds-server/prisma/schema.prisma', import.meta.url));

// ── Database: the columns the rival query touches, then the real migration ───
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
await db.exec(readFileSync(MIGRATION, 'utf8'));

// Prisma's $queryRaw tagged template, over PGlite: interpolations become $n.
const prisma = {
  $queryRaw: async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + '$' + i + s);
    return (await db.query(text, values)).rows;
  },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const deep = {
  week: 61, cash: 123456789, name: 'Air Diva', hubs: ['LHR', 'JFK'],
  routes: range(40, (i) => ({ id: `r${i}`, origin: 'LHR', destination: `X${i}`, stops: ['LHR', `X${i}`], fare: 100.5 + i, aircraftIds: [`a${i}`] })),
  fleet: range(30, (i) => ({ id: `a${i}`, typeId: 'B738', config: { y: 189 }, ageWeeks: i * 3, status: i % 7 ? 'active' : 'maintenance',
    maintenance: { hours: 1234 + i }, mods: ['wifi'], value: 4.5e7 - i })),
  financialHistory: range(52, (i) => ({ week: i + 10, profit: 1e5 * (i - 20), revenue: 3e6 + i, passengers: 50000 + i,
    fuelIndex: 0.1 + 0.2 + i / 100, fuelMultiplier: i % 3 ? undefined : 0.92, depreciation: 1000, loanPayments: 0,
    loanInterest: 12.34, leaseDepositReturned: i, detail: { perRoute: range(5, (j) => j) } })),
  statsHistory: range(260, (i) => ({ week: i, sharePrice: 10 + i / 7, marketCap: 1e9 + i, rank: i % 9 })),
  lastReport: { reputation: { overall: 71.5, service: 60 }, reputationScore: 72, totalPassengers: 812345,
    perRoute: range(40, (i) => ({ id: `r${i}`, pax: i * 100 })), notes: 'naïve café ✈' },
  customLogo: 'data:image/png;base64,AAAA',
  nested: { deeper: { arr: [1, 'two', null, true, { x: 1 }] } },
  negativeZeroish: -0.0001, big: 9007199254740991,
};
// JSON round-trip: what Prisma would actually have stored (no undefined).
const stored = (s) => JSON.parse(JSON.stringify(s));

const fixtures = {
  deep: stored(deep),
  short: { financialHistory: [{ profit: 1 }], statsHistory: [{ sharePrice: 2 }], fleet: [], lastReport: { reputationScore: 50 } },
  empty: {},
  missingAll: { a: 1 },
  nullHistories: { financialHistory: null, statsHistory: null, fleet: null, lastReport: null },
  wrongTypes: { financialHistory: 'nope', statsHistory: { x: 1 }, fleet: 7, lastReport: [1] },
  scalarElements: { financialHistory: [7, 'x', null, [1]], fleet: ['x', null], statsHistory: [false] },
  lastReportScalar: { lastReport: 'x' },
  exactlyKeep: { financialHistory: range(RIVAL_FIN_KEEP, (i) => ({ profit: i })), statsHistory: range(RIVAL_STATS_KEEP, (i) => ({ sharePrice: i })) },
  keepPlusOne: { financialHistory: range(RIVAL_FIN_KEEP + 1, (i) => ({ profit: i })), statsHistory: range(RIVAL_STATS_KEEP + 1, (i) => ({ sharePrice: i })) },
};

const sqlProject = async (state) =>
  (await db.query('SELECT public.rival_state_of($1::jsonb) AS p', [JSON.stringify(state)])).rows[0].p;

console.log('\n── 1. SQL rival_state_of() and JS projectRivalState() agree ─────');

for (const [name, state] of Object.entries(fixtures)) {
  await test(`fixture "${name}"`, async () => {
    assert.deepStrictEqual(await sqlProject(state), projectRivalState(state));
  });
}

await test('the deep fixture is actually trimmed (the comparison has teeth)', async () => {
  const p = await sqlProject(fixtures.deep);
  assert.equal(p.financialHistory.length, RIVAL_FIN_KEEP);
  assert.equal(p.statsHistory.length, RIVAL_STATS_KEEP);
  assert.equal(p.customLogo, undefined);
  assert.equal(p.lastReport.perRoute, undefined);
  assert.equal(p.fleet[0].maintenance, undefined);
  assert.deepStrictEqual(p.financialHistory.at(-1).profit, fixtures.deep.financialHistory.at(-1).profit);
  assert.deepStrictEqual(p.routes, fixtures.deep.routes, 'untrimmed keys pass through whole');
  assert.ok(JSON.stringify(p).length < JSON.stringify(fixtures.deep).length / 2);
});

console.log('\n── 2. The trigger keeps "rivalState" in step with `state` ────────');

const rivalStateOf = async (id) =>
  (await db.query('SELECT "rivalState" AS r FROM "Airline" WHERE id = $1', [id])).rows[0].r;

await db.query(`INSERT INTO "Account"(id, "isOG", "isSupporter", email) VALUES
  ('acc1', true, false, 'one@example.com'), ('acc2', false, true, 'two@example.com'),
  ('acc3', false, false, 'three@example.com'), ('acc4', false, false, 'four@example.com')`);

await test('INSERT fills rivalState with the projection', async () => {
  await db.query(`INSERT INTO "Airline"(id, "worldId", "accountId", name, hub, state, "customLogo", "fleetSize")
                  VALUES ('al1', 'w1', 'acc1', 'Air Diva', 'LHR', $1::jsonb, 'data:image/png;base64,QUJD', 30)`,
    [JSON.stringify(fixtures.deep)]);
  assert.deepStrictEqual(await rivalStateOf('al1'), projectRivalState(fixtures.deep));
});

await test('a Prisma-style UPDATE of state refreshes it', async () => {
  const next = stored({ ...deep, week: 62, financialHistory: [...deep.financialHistory.slice(1), { profit: 42 }] });
  await db.query(`UPDATE "Airline" SET state = $1::jsonb, cash = 5, version = version + 1 WHERE id = 'al1'`, [JSON.stringify(next)]);
  const r = await rivalStateOf('al1');
  assert.deepStrictEqual(r, projectRivalState(next));
  assert.equal(r.financialHistory.at(-1).profit, 42);
});

await test('an in-SQL jsonb_set of state refreshes it too', async () => {
  await db.query(`UPDATE "Airline" SET state = jsonb_set(state, '{lastReport,reputationScore}', '99') WHERE id = 'al1'`);
  assert.equal((await rivalStateOf('al1')).lastReport.reputationScore, 99);
});

await test('an UPDATE that does not touch state leaves rivalState alone', async () => {
  await db.query(`UPDATE "Airline" SET "rivalState" = '{"sentinel": 1}' WHERE id = 'al1'`);
  await db.query(`UPDATE "Airline" SET cash = 77, version = version + 1 WHERE id = 'al1'`);
  assert.deepStrictEqual(await rivalStateOf('al1'), { sentinel: 1 });
  await db.query(`UPDATE "Airline" SET state = state WHERE id = 'al1'`);
  assert.equal((await rivalStateOf('al1')).sentinel, undefined, 'a state write recomputes it');
});

console.log('\n── 3. loadRivalRows reads the column ───────────────────────────');

await db.query(`INSERT INTO "Airline"(id, "worldId", "accountId", name, hub, state)
                VALUES ('al2', 'w1', 'acc2', 'Backlog Air', 'JFK', $1::jsonb),
                       ('al3', 'w1', 'acc3', 'Gone Air', 'SYD', '{}'::jsonb),
                       ('al4', 'w2', 'acc4', 'Elsewhere', 'NRT', '{}'::jsonb)`,
  [JSON.stringify(fixtures.short)]);
await db.query(`UPDATE "Airline" SET status = 'BANKRUPT' WHERE id = 'al3'`);

await test('a filled row comes from "rivalState", not from state', async () => {
  await db.query(`UPDATE "Airline" SET "rivalState" = '{"fromColumn": true}' WHERE id = 'al1'`);
  const rows = await loadRivalRows(prisma, 'w1');
  const al1 = rows.find((r) => r.id === 'al1');
  assert.deepStrictEqual(al1.state, { fromColumn: true },
    'loadRivalRows re-derived the blob from state instead of reading the precomputed column');
  await db.query(`UPDATE "Airline" SET state = state WHERE id = 'al1'`);
});

await test('a row the backfill has not reached falls back to rival_state_of(state)', async () => {
  await db.query(`UPDATE "Airline" SET "rivalState" = NULL WHERE id = 'al2'`);
  const al2 = (await loadRivalRows(prisma, 'w1')).find((r) => r.id === 'al2');
  assert.deepStrictEqual(al2.state, projectRivalState(fixtures.short));
});

await test('rows: ACTIVE only, this world only, row columns and account flags intact', async () => {
  const rows = await loadRivalRows(prisma, 'w1');
  assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['al1', 'al2']);
  const al1 = rows.find((r) => r.id === 'al1');
  assert.equal(al1.name, 'Air Diva');
  assert.equal(al1.fleetSize, 30);
  assert.deepStrictEqual(al1.account, { isOG: true, isSupporter: false, email: 'one@example.com' });
  assert.equal(al1.logoHash, createHash('md5').update('data:image/png;base64,QUJD').digest('hex').slice(0, 12));
  assert.equal(al1.state.customLogo, undefined);
  assert.deepStrictEqual(al1.state, projectRivalState((await db.query(`SELECT state FROM "Airline" WHERE id = 'al1'`)).rows[0].state));
});

console.log('\n── 4. The ORM never pays for the column ─────────────────────────');

await test('schema.prisma declares rivalState with @ignore', () => {
  const schema = readFileSync(SCHEMA, 'utf8');
  assert.match(schema, /^\s*rivalState\s+Json\?\s+@ignore\s*$/m);
});

await db.close();
console.log(`\n${failed ? '✗' : '✓'} rival-state-column: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
