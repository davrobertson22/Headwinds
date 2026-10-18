// Rival-ROW cache — the decision path reuses rivals' trimmed blobs for up to
// RIVAL_ROWS_MAX_STALE_MS instead of re-running loadRivalRows on every move.
//
// 2026-10-18: the strict view-cache check made the API rebuild rival rows on
// almost every decision (153 runs in 13 minutes, ~950 ms / ~40 MB each inside
// Postgres) and Postgres, already over its commit limit, was killed at 4:04 PM.
//
// What this pins:
//   • opting in serves rows from cache across a stamp change (one blob read)
//   • the alliance graph is re-read on EVERY build, cached rows or not
//   • a view built from cached rows reports the stamp its rows reflect and is
//     marked fromCachedRows — and is never written into the view cache
//   • a caller whose own airline is missing from the cached rows gets a reload
//   • callers that do not opt in behave exactly as before
//   • rows expire after RIVAL_ROWS_MAX_STALE_MS
//
//   node tools/rival-row-cache-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import * as rivals from '../apps/headwinds-server/src/lib/humanRivals.mjs';

const { buildWorldRivalViews } = rivals;
const MAX = rivals.RIVAL_ROWS_MAX_STALE_MS ?? 60_000;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;
function airline(id, name, hub) {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  return { id, worldId: 'w', name, hub, status: 'ACTIVE', restarts: 0, version: 1,
           account: { isOG: false, isSupporter: false, email: null },
           state: { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} } };
}
const alice = airline('a1', 'Alice Air', 'JFK');
const bob = airline('a2', 'Bob Airways', 'BOS');
const carol = airline('a3', 'Carol Connect', 'ORD');

function fakeDb(worldId, roster) {
  const db = {
    reads: 0, allianceReads: 0, alliances: [],
    airline: { findMany: async () => { db.reads++; return roster(); } },
    alliance: { findMany: async () => { db.allianceReads++; return db.alliances; } },
    world: { findUnique: async () => ({ id: worldId, tickConfig: {} }) },
    worldMarket: { findUnique: async () => null },
  };
  return db;
}
const optIn = (stamp, id = 'a1') => ({ stamp, rowsMaxStaleMs: MAX, forAirlineId: id });

console.log('\n── rival-row cache ──────────────────────────────────────');

await test('a decision after another player moved reuses the rows (one blob read, not two)', async () => {
  const db = fakeDb('wRows1', () => [alice, bob]);
  await buildWorldRivalViews(db, 'wRows1', optIn('7.2'));
  const second = await buildWorldRivalViews(db, 'wRows1', optIn('8.2'));
  assert.equal(db.reads, 1, 'the stamp moved but the rows are inside the window — must not re-run loadRivalRows');
  assert.equal(second.get('a1').competitors[0].name, 'Bob Airways');
});

await test('alliance graph is fresh on every build even when the rows are cached', async () => {
  const db = fakeDb('wRows2', () => [alice, bob]);
  const before = await buildWorldRivalViews(db, 'wRows2', optIn('7.2'));
  assert.equal(before.get('a1').alliance, null);
  db.alliances = [{ id: 'al1', name: 'Skyband', members: [
    { airlineId: 'a1', status: 'ACTIVE', role: 'FOUNDER' },
    { airlineId: 'a2', status: 'ACTIVE', role: 'MEMBER' },
  ] }];
  const after = await buildWorldRivalViews(db, 'wRows2', optIn('8.2'));
  assert.equal(db.reads, 1);
  assert.equal(db.allianceReads, 2, 'alliance graph must be re-read on the cached-rows path');
  assert.equal(after.get('a1').alliance?.def?.name, 'Skyband');
});

await test('a cached-rows view reports the stamp its rows reflect and never enters the view cache', async () => {
  const db = fakeDb('wRows3', () => [alice, bob]);
  await buildWorldRivalViews(db, 'wRows3', optIn('7.2'));
  const served = await buildWorldRivalViews(db, 'wRows3', optIn('8.2'));
  assert.equal(served.fromCachedRows, true);
  assert.equal(served.builtFromStamp, '7.2', 'must echo the rows’ stamp, not the one requested');
  assert.equal(Object.keys(served).length, 0, 'flags must stay non-enumerable');
  await buildWorldRivalViews(db, 'wRows3', { stamp: '8.2' });
  assert.equal(db.reads, 2, 'a strict poll at 8.2 must not be served the cached-rows build');
});

await test('rows loaded without a stamp report ROWS_STAMP_UNKNOWN', async () => {
  const db = fakeDb('wRows4', () => [alice, bob]);
  await buildWorldRivalViews(db, 'wRows4', { rowsMaxStaleMs: MAX, forAirlineId: 'a1' });
  const served = await buildWorldRivalViews(db, 'wRows4', optIn('9.2'));
  assert.equal(served.builtFromStamp, rivals.ROWS_STAMP_UNKNOWN ?? 'cached');
  assert.ok(!/:/.test(served.builtFromStamp), 'must not contain a colon (stamp.mjs splits on the first one)');
});

await test('a player missing from the cached rows (just joined) forces a reload', async () => {
  let roster = [alice, bob];
  const db = fakeDb('wRows5', () => roster);
  await buildWorldRivalViews(db, 'wRows5', optIn('7.2'));
  roster = [alice, bob, carol];
  const v = await buildWorldRivalViews(db, 'wRows5', optIn('8.3', 'a3'));
  assert.equal(db.reads, 2);
  assert.equal(v.get('a3').competitors.length, 2);
  assert.notEqual(v.fromCachedRows, true);
});

await test('callers that do not opt in rebuild on a stamp change, as before', async () => {
  const db = fakeDb('wRows6', () => [alice, bob]);
  await buildWorldRivalViews(db, 'wRows6', { stamp: '7.2' });
  await buildWorldRivalViews(db, 'wRows6', { stamp: '8.2' });
  assert.equal(db.reads, 2);
});

await test('rows expire after RIVAL_ROWS_MAX_STALE_MS', async () => {
  const db = fakeDb('wRows7', () => [alice, bob]);
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0;
    await buildWorldRivalViews(db, 'wRows7', optIn('7.2'));
    Date.now = () => t0 + MAX - 1;
    await buildWorldRivalViews(db, 'wRows7', optIn('8.2'));
    assert.equal(db.reads, 1);
    Date.now = () => t0 + MAX;
    await buildWorldRivalViews(db, 'wRows7', optIn('9.2'));
    assert.equal(db.reads, 2, 'past the window the rows must be reloaded');
  } finally { Date.now = realNow; }
});

Math.random = realRandom;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
