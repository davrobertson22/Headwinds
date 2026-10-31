// The weekly report lives in its own Airline column, not in `state`.
//
// 2026-10-23: Postgres was killed ~12 times in a day while Time Flies' biggest
// airlines played. Each decision rewrote the WHOLE `state` jsonb — Ajax Air's
// was 15 MB, 10.9 MB of it `lastReport` — and the rivalState trigger ran
// rival_state_of() over all of it. Only the weekly tick produces a report, so it
// now lives in "report" (apps/headwinds-server/src/lib/reportColumn.mjs):
//   * the tick writes it; a decision writes `state` WITHOUT it;
//   * every state the engine runs on or the owner is served gets it back
//     (joinReport), so the engine and the client see what they always saw;
//   * rivalState keeps its three report fields, from the column, via the
//     triggers in migration 20261024000000_airline_report_column (run here, for
//     real, in PGlite) and via the tick's JS writer.
//
//   node --import ./tools/_register-loader.mjs tools/report-column-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { joinReport, splitReport, isLegacyRow, reportWriteFor } from '../apps/headwinds-server/src/lib/reportColumn.mjs';
import { projectRivalState } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { tickWorldOnce, loadTickAirlines } from '../apps/headwinds-server/src/lib/tickService.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const MIG = (name) => fileURLToPath(new URL(`../apps/headwinds-server/prisma/migrations/${name}/migration.sql`, import.meta.url));
const stored = (s) => JSON.parse(JSON.stringify(s));

// ── 1. The contract ───────────────────────────────────────────────────────────
console.log('\n── 1. joinReport / splitReport / reportWriteFor ─────────────────');

const report = { reputationScore: 72, reputation: { overall: 71.5 }, totalPassengers: 812345, routeResults: [{ routeId: 'r1', pax: 9 }] };
const blob = { cash: 5, routes: [{ id: 'r1' }] };

await test('a blob without the key gets the column back; with no column, an explicit null', () => {
  assert.equal(joinReport(blob, report).lastReport, report);
  assert.equal(joinReport(blob, null).lastReport, null);
  assert.equal(blob.lastReport, undefined, 'input not mutated');
});
await test('a lastReport key inside the blob wins (legacy rows, fresh templates)', () => {
  const legacy = { ...blob, lastReport: { reputationScore: 1 } };
  assert.equal(joinReport(legacy, report), legacy);
  const template = { ...blob, lastReport: null };
  assert.equal(joinReport(template, report).lastReport, null, 'a restarted airline never shows its old report');
});
await test('splitReport takes the key out and says when there was none', () => {
  const { state, report: r } = splitReport({ ...blob, lastReport: report });
  assert.equal('lastReport' in state, false);
  assert.equal(r, report);
  assert.equal(splitReport(blob).report, undefined);
});
await test('a decision that leaves the report alone does not write the column', () => {
  const row = { state: blob, report };
  const injected = joinReport(row.state, row.report);
  const next = gameReducer(injected, { type: 'CLEAR_TOASTS' });
  const w = reportWriteFor(row, injected.lastReport, next);
  assert.equal(w.writeReport, false);
  assert.equal('lastReport' in w.state, false, 'the blob is written without the report');
});
await test('a decision that replaces the report writes it', () => {
  const row = { state: blob, report };
  const injected = joinReport(row.state, row.report);
  const w = reportWriteFor(row, injected.lastReport, { ...injected, lastReport: { ...report, x: 1 } });
  assert.equal(w.writeReport, true);
  assert.equal(w.report.x, 1);
});
await test('a legacy row moves its report into the column on its first decision', () => {
  const row = { state: { ...blob, lastReport: report }, report: null };
  assert.equal(isLegacyRow(row), true);
  const injected = joinReport(row.state, row.report);
  const w = reportWriteFor(row, injected.lastReport, injected);
  assert.equal(w.writeReport, true);
  assert.equal(w.report, report);
  assert.equal('lastReport' in w.state, false);
  assert.equal(isLegacyRow({ state: blob, report }), false);
});
await test('no reducer action other than the weekly tick replaces lastReport', () => {
  // reportWriteFor's identity test relies on it: a case that rebuilt the report
  // object without the tick would be written every time (correct, just slower).
  const src = read('../packages/engine/src/reducer.mjs');
  const writes = [...src.matchAll(/^\s*lastReport:\s+(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(writes, ['null,', 'state.lastReport,', 'report,',
    '{ ...report, cashDelta: preTaxProfit - corporateTax,', 'parsed.lastReport       ?? null,']);
});

// ── 2. The migration, for real ────────────────────────────────────────────────
console.log('\n── 2. Triggers keep rivalState\'s report fields (PGlite) ──────────');

async function freshDb(migrations) {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "AirlineStatus" AS ENUM ('ACTIVE', 'BANKRUPT', 'ABANDONED');
    CREATE TABLE "Airline" (id text PRIMARY KEY, state jsonb NOT NULL, version integer NOT NULL DEFAULT 0,
      status "AirlineStatus" NOT NULL DEFAULT 'ACTIVE');`);
  for (const m of migrations) await db.exec(readFileSync(MIG(m), 'utf8'));
  return db;
}
const ALL = ['20261022000000_airline_rival_state', '20261023000000_rival_state_app_writer', '20261024000000_airline_report_column'];
const HEAD = ALL.slice(0, 2);
const rivalOf = async (db, id) => (await db.query('SELECT "rivalState" r FROM "Airline" WHERE id=$1', [id])).rows[0].r;
const legacyState = stored({ ...blob, fleet: [{ id: 'a1', typeId: 'B738' }], lastReport: report });
const { state: splitBlob } = splitReport(legacyState);

const db = await freshDb(ALL);
await test('a legacy row (report inside state) projects exactly as before', async () => {
  await db.query('INSERT INTO "Airline"(id, state) VALUES ($1, $2::jsonb)', ['L', JSON.stringify(legacyState)]);
  assert.deepStrictEqual(await rivalOf(db, 'L'), projectRivalState(legacyState));
  await db.query('UPDATE "Airline" SET state = $2::jsonb WHERE id=$1', ['L', JSON.stringify({ ...legacyState, cash: 6 })]);
  assert.deepStrictEqual(await rivalOf(db, 'L'), projectRivalState({ ...legacyState, cash: 6 }));
});
await test('moving the report out (state + report in one UPDATE) keeps the same projection', async () => {
  await db.query('UPDATE "Airline" SET state = $2::jsonb, report = $3::jsonb WHERE id=$1',
    ['L', JSON.stringify(splitBlob), JSON.stringify(report)]);
  assert.deepStrictEqual(await rivalOf(db, 'L'), projectRivalState(joinReport(splitBlob, report)));
});
await test('a decision (state only, no report) keeps the report fields — without reading the column', async () => {
  await db.query('UPDATE "Airline" SET state = $2::jsonb WHERE id=$1', ['L', JSON.stringify({ ...splitBlob, cash: 99 })]);
  const r = await rivalOf(db, 'L');
  assert.equal(r.cash, 99);
  assert.deepStrictEqual(r.lastReport, projectRivalState(legacyState).lastReport);
  assert.deepStrictEqual(r, projectRivalState(joinReport({ ...splitBlob, cash: 99 }, report)));
});
await test('a report-only write updates the report fields', async () => {
  const next = { ...report, reputationScore: 80, totalPassengers: 1 };
  await db.query('UPDATE "Airline" SET report = $2::jsonb WHERE id=$1', ['L', JSON.stringify(next)]);
  assert.deepStrictEqual(await rivalOf(db, 'L'), projectRivalState(joinReport({ ...splitBlob, cash: 99 }, next)));
});
await test('the tick\'s mark makes both triggers stand aside', async () => {
  await db.exec('BEGIN');
  await db.query(`SELECT set_config('headwinds.rival_state_writer', 'app', true)`);
  await db.query('UPDATE "Airline" SET state = $2::jsonb, report = $3::jsonb WHERE id=$1',
    ['L', JSON.stringify({ ...splitBlob, cash: 1 }), JSON.stringify({ reputationScore: 1 })]);
  await db.exec('COMMIT');
  const r = await rivalOf(db, 'L');
  assert.equal(r.cash, 99, 'untouched under the mark');
  assert.equal(r.lastReport.reputationScore, 80);
});
await test('a restart (fresh template, lastReport: null in state) clears the rival report fields', async () => {
  await db.query('UPDATE "Airline" SET state = $2::jsonb, report = NULL WHERE id=$1', ['L', JSON.stringify({ ...splitBlob, lastReport: null })]);
  assert.equal((await rivalOf(db, 'L')).lastReport, null);
});
await test('control: on HEAD\'s migrations a report-less decision write blanks the rival report fields', async () => {
  const head = await freshDb(HEAD);
  await head.query('INSERT INTO "Airline"(id, state) VALUES ($1, $2::jsonb)', ['L', JSON.stringify(legacyState)]);
  await head.query('UPDATE "Airline" SET state = $2::jsonb WHERE id=$1', ['L', JSON.stringify(splitBlob)]);
  assert.equal((await rivalOf(head, 'L')).lastReport, null, 'why the migration has to replace the trigger');
});

// ── 3. The tick, end to end (real tick service + real engine, fake Prisma) ───
console.log('\n── 3. The tick writes the column and still sees last week ───────');

function fakePrisma({ world, airlines }) {
  const d = { world: { ...world }, airlines: airlines.map((a) => ({ ...a })) };
  const p = {
    _db: d,
    world: {
      findMany: async () => [{ ...d.world }],
      updateMany: async ({ where, data }) => {
        const w = d.world;
        if (!(w.id === where.id && w.currentWeek === where.currentWeek && w.currentYear === where.currentYear && w.status === where.status)) return { count: 0 };
        Object.assign(w, data); return { count: 1 };
      },
    },
    airline: {
      findMany: async ({ where }) => d.airlines.filter((a) => a.worldId === where.worldId && a.status === where.status).map((a) => ({ ...a })),
      findUnique: async ({ where }) => { const a = d.airlines.find((x) => x.id === where.id); return a ? { ...a } : null; },
      update: async ({ where, data }) => { const a = d.airlines.find((x) => x.id === where.id); Object.assign(a, data); return { ...a }; },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const a of d.airlines) {
          if (a.id !== where.id || (where.version !== undefined && (a.version ?? 0) !== where.version)) continue;
          for (const [k, v] of Object.entries(data)) a[k] = (v && typeof v === 'object' && 'increment' in v) ? (a[k] ?? 0) + v.increment : v;
          count++;
        }
        return { count };
      },
    },
    tickLog: { create: async ({ data }) => ({ id: 't', ...data }), update: async () => ({}) },
    standing: { createMany: async ({ data }) => ({ count: data.length }), findMany: async () => [] },
    worldMarket: { findUnique: async () => null, update: async () => null, updateMany: async () => ({ count: 0 }),
      create: async ({ data }) => ({ id: 'm', version: 0, ...data }), upsert: async ({ create }) => ({ id: 'm', version: 0, ...create }) },
    dividendCredit: { findMany: async () => [], createMany: async ({ data }) => ({ count: data.length }), updateMany: async () => ({ count: 0 }) },
    worldNews: { createMany: async ({ data }) => ({ count: data.length }), deleteMany: async () => ({ count: 0 }) },
    alliance: { findMany: async () => [] },
  };
  p.$transaction = async (fn) => fn(p);
  return p;
}
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const makeWorld = (over = {}) => ({ id: 'w1', name: 'T', status: 'RUNNING', lengthYears: 50, weeksPerDay: 12,
  currentWeek: 1, currentYear: 1, startedAt: new Date(Date.now() - 5 * 3600e3), ...over });
const seed = (id, hub) => {
  const state = gameReducer(freshState(), { type: 'START_GAME', airlineName: id, hub, enableObjectives: false });
  state.equity = { ...state.equity, isPublic: true };
  return { id, worldId: 'w1', accountId: `acc_${id}`, name: id, hub, state: stored(state), status: 'ACTIVE', week: 1, version: 0 };
};

const prisma = fakePrisma({ world: makeWorld(), airlines: [seed('a1', 'JFK'), seed('a2', 'LAX')] });
await test('after a tick the blob has no lastReport and the column holds this week\'s report', async () => {
  const res = await tickWorldOnce(prisma, makeWorld(), { log: quiet });
  assert.equal(res.ok, true);
  for (const a of prisma._db.airlines) {
    assert.equal('lastReport' in a.state, false, `${a.id}: blob still carries the report`);
    assert.equal(typeof a.report, 'object');
    assert.ok(a.report && Number.isFinite(a.report.totalRevenue ?? a.report.revenue ?? 0), `${a.id}: report written`);
  }
});
await test('the tick hands the engine last week\'s report: split and legacy rows load identically', async () => {
  const split = await loadTickAirlines(prisma, 'w1');
  const legacy = await loadTickAirlines(fakePrisma({ world: makeWorld(), airlines: prisma._db.airlines.map((a) => ({
    ...a, state: { ...a.state, lastReport: a.report }, report: null })) }), 'w1');
  for (const a of split) {
    assert.ok(a.state.lastReport && a.state.lastReport === a.report, `${a.id}: engine input carries the column's report`);
    assert.deepStrictEqual(a.state, legacy.find((b) => b.id === a.id).state);
  }
});
await test('the next tick reads last week\'s report back (same engine input as a legacy blob)', async () => {
  // A twin world whose rows carry the SAME data the legacy way (report inside
  // state) must tick to the same airline as the split one.
  const twin = fakePrisma({ world: { ...prisma._db.world }, airlines: prisma._db.airlines.map((a) => ({
    ...a, state: { ...a.state, lastReport: a.report }, report: null })) });
  const w = { ...prisma._db.world };
  await tickWorldOnce(prisma, w, { log: quiet });
  await tickWorldOnce(twin, { ...w }, { log: quiet });
  for (const a of prisma._db.airlines) {
    const b = twin._db.airlines.find((x) => x.id === a.id);
    const pick = (s) => ({ cash: s.cash, week: s.week, year: s.year, rev: s.lastReport?.totalRevenue, pax: s.lastReport?.totalPassengers,
      rep: s.lastReport?.reputationScore, fin: (s.financialHistory ?? []).length });
    assert.deepStrictEqual(pick(joinReport(a.state, a.report)), pick(joinReport(b.state, b.report)));
    assert.equal('lastReport' in b.state, false, 'the legacy twin moved its report out too');
  }
});

// ── 4. Wiring ─────────────────────────────────────────────────────────────────
console.log('\n── 4. Every owner-facing read joins it, every write splits it ───');

await test('schema and migration add the column', () => {
  assert.match(read('../apps/headwinds-server/prisma/schema.prisma'), /^\s*report\s+Json\?\s*$/m);
  assert.match(readFileSync(MIG(ALL[2]), 'utf8'), /ALTER TABLE "Airline" ADD COLUMN "report" JSONB;/);
});
await test('decisions: the reducer runs on the joined state; the write splits it', () => {
  const src = read('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(src, /const injected = withRivals\(joinReport\(airline\.state, airline\.report\), view\);/);
  assert.match(src, /reportWriteFor\(airline, readReport, blob\)/);
  assert.match(src, /\.\.\.\(writeReport \? \{ report: report \?\? Prisma\.DbNull \} : \{\}\)/);
  assert.equal((src.match(/injectLogo\(joinReport\(airline\.state, airline\.report\), airline\.customLogo\)/g) ?? []).length, 2, 'both GET paths');
});
await test('the tick joins at read (first pass and recompute) and splits at write', () => {
  const src = read('../apps/headwinds-server/src/lib/tickService.mjs');
  assert.match(src, /const airlines = await loadTickAirlines\(prisma, world\.id\);/);
  assert.match(src, /state: joinReport\(freshRow\.state, freshRow\.report\)/);
  assert.match(src, /report: report \?\? Prisma\.DbNull,/);
  assert.match(src, /rivalStateFor\(joinReport\(persisted, report\)\)/);
});
await test('gates, used market and codeshare responses hand the owner the report too', () => {
  for (const f of ['gates', 'aircraftMarket', 'codeshares']) {
    const src = read(`../apps/headwinds-server/src/routes/${f}.mjs`);
    const logos = (src.match(/injectLogo\(/g) ?? []).length;
    const joined = (src.match(/injectLogo\(joinReport\(/g) ?? []).length;
    assert.ok(logos > 0 && joined === logos, `${f}: ${joined} of ${logos} owner-facing states carry the report`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
