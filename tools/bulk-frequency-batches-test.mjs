// Routes ▸ Bulk Frequency on a network bigger than one server write.
//
// Discord, Barca 2026-10-17: "The newly added bulk update feature shows up a
// 'too many added in one batch' when I try to use it. Maybe it could execute
// as many as possible at once." The header's Bulk Frequency matches every
// route by default, the server guard caps one BULK_ADJUST_FREQUENCY at 500
// route ids (the reducer folds a guard pass per id inside the write
// transaction), and the client sent the whole selection as one action — so any
// airline past 500 aircraft-routes got nothing but the guard's refusal.
//
// The fix splits the selection into batches of at most BULK_FREQUENCY_BATCH
// and sends one action per batch (the client's write chain serializes them).
// planBulkFrequencyBatched is the same fold, so the preview is still exactly
// what Apply lands. This suite pins:
//
//   · every batch a 1,200-route selection goes out as is one the guard accepts
//   · the guard's own cap is the engine's batch size (one number, not two)
//   · folding the reducer over the batches lands exactly the previewed state
//   · up to one batch, the batched plan IS planBulkFrequency (no behaviour
//     change for anyone under the cap)
//   · a tail's routes never straddle two batches (its spare hours are shared
//     round-robin inside one plan, as before)
//   · the Routes screen previews through the batched plan and applies per batch
//
// Verified failing on HEAD: there the client sent the selection as ONE action
// (reproduced below as the fallback `[ids]` when bulkFrequencyBatches is not
// exported), and the guard refuses it with "Too many routes in one batch."
//
//   node --import ./tools/_register-loader.mjs tools/bulk-frequency-batches-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const engine = await import('../packages/engine/src/reducer.mjs');
const { gameReducer, freshState, planBulkFrequency } = engine;
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

// HEAD's client: the whole selection in one action.
const batchesOf = (s, ids) => (engine.bulkFrequencyBatches ? engine.bulkFrequencyBatches(s, ids) : [ids]);
const planBatched = engine.planBulkFrequencyBatched
  ?? ((s, ids, spec) => ({ ...planBulkFrequency(s, ids, spec), batches: [ids] }));

// ── Fixture: 1,200 routes on 600 tails, two routes per tail ─────────────────
const ORIGINS = ['JFK', 'LAX', 'ORD', 'DFW', 'ATL', 'SFO', 'SEA', 'MIA', 'BOS', 'DEN'];
const DESTS = ['LAS', 'PHX', 'IAH', 'MSP', 'DTW', 'PHL', 'CLT', 'EWR', 'SAN', 'TPA', 'MCO', 'SLC', 'PDX', 'STL', 'BWI', 'IAD', 'AUS', 'MSY', 'RDU', 'MCI'];
const AC = (id) => ({ id, typeId: 'a320neo', name: `AC ${id}`, tailNumber: `N${id}`, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' });
function bigFixture(n = 1200) {
  const fleet = [], routes = [];
  for (let t = 0; t < n / 2; t++) fleet.push(AC(`a${t}`));
  // Interleaved so a tail's two routes are 600 positions apart in the list —
  // a naive slice(0, 500) would split every one of them.
  for (let i = 0; i < n; i++) {
    const o = ORIGINS[i % ORIGINS.length], d = DESTS[(i * 7) % DESTS.length];
    routes.push({ id: `r${i}`, origin: o, destination: d, stops: [o, d], aircraftId: `a${i % (n / 2)}`, weeklyFrequency: 2, weeksOpen: 30, ticketPrice: 250 });
  }
  const gates = Object.fromEntries([...ORIGINS, ...DESTS].map(c => [c, 400]));
  return { ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 5e8, fleet, routes, gates };
}
const freqs = (s) => Object.fromEntries(s.routes.map(r => [r.id, r.weeklyFrequency]));

const S = bigFixture();
const ALL = S.routes.map(r => r.id);

console.log('\n── bulk frequency batches: the server write ──────────────────');

test('a 1,200-route selection goes out as writes the guard accepts', () => {
  const batches = batchesOf(S, ALL);
  for (const ids of batches) {
    const g = guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: ids, mode: 'delta', value: 1 }, S);
    assert.equal(g.routeIds.length, ids.length);
  }
  assert.equal(batches.flat().length, ALL.length, 'every route is in exactly one batch');
  assert.equal(new Set(batches.flat()).size, ALL.length);
});

test("the guard's cap is the engine's batch size", () => {
  assert.equal(engine.BULK_FREQUENCY_BATCH, 500);
  const n = engine.BULK_FREQUENCY_BATCH;
  guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: ALL.slice(0, n), mode: 'delta', value: 1 }, S);
  assert.throws(() => guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: ALL.slice(0, n + 1), mode: 'delta', value: 1 }, S),
    /Too many routes/, 'a forged oversize payload is still refused');
});

test("a tail's routes never straddle two batches", () => {
  const where = new Map();
  batchesOf(S, ALL).forEach((ids, b) => ids.forEach(id => where.set(id, b)));
  const tailBatches = new Map();
  for (const r of S.routes) {
    const set = tailBatches.get(r.aircraftId) ?? new Set();
    set.add(where.get(r.id));
    tailBatches.set(r.aircraftId, set);
  }
  const split = [...tailBatches].filter(([, b]) => b.size > 1).map(([t]) => t);
  assert.deepEqual(split.slice(0, 5), [], `${split.length} tails split across batches`);
});

console.log('\n── bulk frequency batches: preview = apply ───────────────────');

test('folding the reducer over the batches lands exactly the previewed state', () => {
  for (const spec of [{ mode: 'delta', value: 2 }, { mode: 'set', value: 5 }, { mode: 'max', value: 0 }]) {
    const plan = planBatched(S, ALL, spec);
    let s = S;
    for (const ids of plan.batches) s = gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ids, ...spec });
    assert.deepEqual(freqs(s), freqs(plan.state), `${spec.mode}: reducer fold and preview disagree`);
    assert.equal(plan.plan.length, ALL.length, `${spec.mode}: one plan line per route`);
    assert.ok(plan.changed > 0, `${spec.mode}: fixture moved nothing`);
  }
});

test('up to one batch, the batched plan is planBulkFrequency exactly', () => {
  const ids = ALL.slice(0, 300);
  for (const spec of [{ mode: 'delta', value: 3 }, { mode: 'max', value: 0 }]) {
    const one = planBulkFrequency(S, ids, spec);
    const b = planBatched(S, ids, spec);
    assert.equal(b.batches.length, 1);
    assert.deepEqual(b.batches[0], ids, 'order kept');
    assert.deepEqual(b.plan, one.plan);
    assert.deepEqual(freqs(b.state), freqs(one.state));
    for (const k of ['changed', 'added', 'removed', 'capped']) assert.equal(b[k], one[k], k);
  }
});

test('stale and duplicate ids are dropped before batching', () => {
  const b = batchesOf(S, ['r1', 'r1', 'ghost', 'r2']);
  assert.deepEqual(b, [['r1', 'r2']]);
  assert.deepEqual(batchesOf(S, []), []);
});

console.log('\n── bulk frequency batches: the Routes screen ─────────────────');

const src = readFileSync(new URL('../src/components/Routes.jsx', import.meta.url), 'utf8');

// The selection bar's row moved to components/FrequencyControls.jsx (shared with
// Fleet's "Flights/wk"); the modal's preview is still in Routes.jsx.
const controlsSrc = readFileSync(new URL('../src/components/FrequencyControls.jsx', import.meta.url), 'utf8');

test('both previews plan through planBulkFrequencyBatched', () => {
  const calls = [
    ...(src.match(/planBulkFrequency(Batched)?\(state, routeIds/g) ?? []),
    ...(controlsSrc.match(/planBulkFrequency(Batched)?\(state, ids/g) ?? []),
  ];
  assert.equal(calls.length, 2, 'expected the selection-bar and modal previews');
  assert.ok(calls.every(c => c.startsWith('planBulkFrequencyBatched')), `a preview still plans unbatched: ${calls.join(', ')}`);
});

test('Apply dispatches one action per planned batch', () => {
  const fn = src.slice(src.indexOf('function applyFrequencyPlan'), src.indexOf('function bulkSetCatering'));
  assert.match(fn, /plan\.batches/, 'applyFrequencyPlan does not use the plan\'s batches');
  assert.doesNotMatch(fn, /routeIds, mode, value \}\);/, 'still one dispatch carrying the whole selection');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} bulk-frequency-batches: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
