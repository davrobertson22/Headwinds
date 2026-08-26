// Tombstones — dead airlines keep their row, lose their weight.
//
// Three claims under test, matching the 2026-08-25 change:
//   1. tombstoneState cuts exactly the heavy keys (lastReport, histories,
//      newsLog) to their SEED-STATE shapes, touches nothing else, and is
//      idempotent — a settled estate is never rewritten again.
//   2. tombstoneAirline refuses to strip a living airline, whatever it's told.
//   3. The wiring exists: standings and player counts exclude the dead, join
//      capacity counts only ACTIVE seats, and both death paths (tick
//      bankruptcy, /leave) actually settle the estate.
//
//   node --import ./tools/_register-loader.mjs tools/tombstone-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  tombstoneState, tombstoneAirline, TOMBSTONE_CUTS, TOMBSTONE_KEY,
} from '../apps/headwinds-server/src/lib/tombstone.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; });
}

const deadState = () => ({
  airlineName: 'Icarus Air', hub: 'JFK', cash: -1_250_000, phase: 'bankrupt',
  week: 30, year: 3,
  fleet: [{ id: 'f1', typeId: 'b737800' }],
  routes: [{ from: 'JFK', to: 'ORD' }],
  cargoRoutes: [],
  lastReport: { revenue: 1, routeResults: new Array(50).fill({ pax: 9 }) },
  financialHistory: new Array(200).fill({ week: 1, cash: 5 }),
  statsHistory: new Array(150).fill({ week: 1, pax: 2 }),
  newsLog: new Array(80).fill({ kind: 'company', week: 1 }),
});

console.log('\nTombstones\n');

await test('cuts the heavy keys to seed shapes and marks the grave', () => {
  const { state, changed } = tombstoneState(deadState(), { weekIndex: 142 });
  assert.equal(changed, true);
  assert.equal(state.lastReport, null);
  assert.deepEqual(state.financialHistory, []);
  assert.deepEqual(state.statsHistory, []);
  assert.deepEqual(state.newsLog, []);
  assert.equal(state[TOMBSTONE_KEY], 142);
});

await test('touches nothing but the cut keys', () => {
  const before = deadState();
  const { state } = tombstoneState(before, { weekIndex: 142 });
  const cutKeys = new Set([...Object.keys(TOMBSTONE_CUTS), TOMBSTONE_KEY]);
  for (const k of Object.keys(before)) {
    if (cutKeys.has(k)) continue;
    assert.deepEqual(state[k], before[k], `key ${k} must survive untouched`);
  }
  // And the input object itself is never mutated.
  assert.equal(before.lastReport.routeResults.length, 50);
});

await test('idempotent: a settled estate reports changed:false', () => {
  const first = tombstoneState(deadState(), { weekIndex: 142 });
  const second = tombstoneState(first.state, { weekIndex: 999 });
  assert.equal(second.changed, false);
  assert.equal(second.state, first.state); // same reference — no rewrite
});

await test('a freshly-joined shape (nothing heavy yet) is not worth a rewrite', () => {
  const seedish = { airlineName: 'New Co', lastReport: null, financialHistory: [], statsHistory: [], newsLog: [] };
  assert.equal(tombstoneState(seedish).changed, false);
});

await test('garbage in, no throw out', () => {
  assert.equal(tombstoneState(null).changed, false);
  assert.equal(tombstoneState('corrupt').changed, false);
  assert.equal(tombstoneState([1, 2]).changed, false);
});

await test('tombstoneAirline refuses to strip a LIVING airline', async () => {
  let updated = false;
  const prisma = {
    airline: {
      findUnique: async () => ({ id: 'a1', status: 'ACTIVE', state: deadState() }),
      update: async () => { updated = true; },
    },
  };
  const res = await tombstoneAirline(prisma, { airlineId: 'a1', log: { info: () => {} } });
  assert.equal(res.changed, false);
  assert.equal(updated, false, 'must never write an ACTIVE blob');
});

await test('tombstoneAirline settles a dead one and reports the shed weight', async () => {
  let written = null;
  const prisma = {
    airline: {
      findUnique: async () => ({ id: 'a2', status: 'BANKRUPT', state: deadState() }),
      update: async ({ data }) => { written = data.state; },
    },
  };
  const res = await tombstoneAirline(prisma, { airlineId: 'a2', weekIndex: 77, log: { info: () => {} } });
  assert.equal(res.changed, true);
  assert.ok(res.after < res.before, 'blob must shrink');
  assert.equal(written.lastReport, null);
  assert.equal(written[TOMBSTONE_KEY], 77);
});

// ── Wiring guards — the change survives in the files that matter ─────────────

const src = (p) => fs.readFileSync(p, 'utf8');

await test('standings query excludes the dead and the response counts them', () => {
  const worlds = src('apps/headwinds-server/src/routes/worlds.mjs');
  assert.match(worlds, /AND a\.status = 'ACTIVE'/, 'standings must filter to ACTIVE');
  assert.match(worlds, /\bfallen\b/, 'response must carry the fallen count');
});

await test('player counts only count the living (both lobby sites)', () => {
  const worlds = src('apps/headwinds-server/src/routes/worlds.mjs');
  const filtered = worlds.match(/airlines: \{ where: \{ status: 'ACTIVE' \} \}/g) ?? [];
  assert.ok(filtered.length >= 2, `expected both _count sites filtered, found ${filtered.length}`);
  assert.ok(!/airlines: true/.test(worlds), 'no unfiltered airline _count may remain');
});

await test('join capacity counts ACTIVE seats only', () => {
  const svc = src('apps/headwinds-server/src/lib/worldService.mjs');
  assert.match(svc, /airline\.count\(\{ where: \{ worldId: world\.id, status: 'ACTIVE' \} \}\)/);
});

await test('both death paths settle the estate', () => {
  assert.match(src('apps/headwinds-server/src/lib/tickService.mjs'), /tombstoneAirline\(/, 'tick bankruptcy must tombstone');
  assert.match(src('apps/headwinds-server/src/routes/worlds.mjs'), /tombstoneAirline\(/, '/leave must tombstone');
});

console.log(`\n${failed ? '❌' : '✅'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
