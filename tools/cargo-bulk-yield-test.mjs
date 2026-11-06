// Freight mass pricing: BULK_SET_CARGO_YIELD reprices many freighters at once.
//
//   node tools/cargo-bulk-yield-test.mjs
//
// Barca, Discord 2026-11-05: "there are a lot of features that are in passenger
// not freight. Most importantly mass pricing." Freight had a per-freighter
// stepper and a lane-wide +/- that sent one UPDATE_CARGO_YIELD per freighter.
// This checks the one action that replaces both, the preview it shares with the
// UI (models/cargoYieldBulk.js), and the multiplayer server's guard and
// allow-list for it.

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { cargoReferenceYield } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const opt = async (spec) => { try { return await import(spec); } catch (e) { return { __err: e }; } };

const FREIGHTER = AIRCRAFT_TYPES.find(t => t.freighter);
const tail = (id) => ({ id, typeId: FREIGHTER.id, tailNumber: `N${id}`, status: 'assigned', ageWeeks: 10, ownershipType: 'owned' });
function base() {
  return {
    ...freshState(),
    phase: 'playing', week: 10, year: 1, hub: 'AMS', cash: 50_000_000,
    gates: { AMS: 10, LHR: 10, FRA: 10 },
    fleet: [tail('f1'), tail('f2'), tail('f3')],
    routes: [],
    cargoRoutes: [
      { id: 'c1', origin: 'AMS', destination: 'LHR', aircraftId: 'f1', weeklyFrequency: 3, yieldPrice: 1.000, weeksOpen: 10 },
      { id: 'c2', origin: 'AMS', destination: 'FRA', aircraftId: 'f2', weeklyFrequency: 3, yieldPrice: 0.500, weeksOpen: 10 },
      { id: 'c3', origin: 'LHR', destination: 'FRA', aircraftId: 'f3', weeklyFrequency: 3, yieldPrice: 0.800, weeksOpen: 10 },
    ],
  };
}
const yieldOf = (s, id) => s.cargoRoutes.find(r => r.id === id).yieldPrice;
const bulk = (s, routeIds, mode, value) => gameReducer(s, { type: 'BULK_SET_CARGO_YIELD', routeIds, mode, value });

console.log('\n── 1. The reducer ───────────────────────────────────────');

await test('+10% raises only the selected freighters', () => {
  const n = bulk(base(), ['c1', 'c2'], 'pct', 10);
  assert.equal(yieldOf(n, 'c1'), 1.1);
  assert.equal(yieldOf(n, 'c2'), 0.55);
  assert.equal(yieldOf(n, 'c3'), 0.8, 'an unselected freighter moved');
});

await test('-15% cuts, rounded to the stepper\'s 3 decimals', () => {
  const n = bulk(base(), ['c1', 'c2', 'c3'], 'pct', -15);
  assert.equal(yieldOf(n, 'c1'), 0.85);
  assert.equal(yieldOf(n, 'c2'), 0.425);
  assert.equal(yieldOf(n, 'c3'), 0.68);
});

await test('reference puts each freighter on its own lane\'s going rate', () => {
  const n = bulk(base(), ['c1', 'c3'], 'reference');
  assert.equal(yieldOf(n, 'c1'), cargoReferenceYield('AMS', 'LHR'));
  assert.equal(yieldOf(n, 'c3'), cargoReferenceYield('LHR', 'FRA'));
  assert.equal(yieldOf(n, 'c2'), 0.5);
});

await test('set writes one rate to every selected freighter (lane align)', () => {
  const n = bulk(base(), ['c1', 'c2'], 'set', 0.733);
  assert.equal(yieldOf(n, 'c1'), 0.733);
  assert.equal(yieldOf(n, 'c2'), 0.733);
});

await test('delta moves each freighter by the same $/t-km (lane +/-)', () => {
  const n = bulk(base(), ['c1', 'c2'], 'delta', -0.02);
  assert.equal(yieldOf(n, 'c1'), 0.98);
  assert.equal(yieldOf(n, 'c2'), 0.48);
  const floor = bulk(base(), ['c2'], 'delta', -3);
  assert.equal(yieldOf(floor, 'c2'), 0.01, 'a big cut stops at the $0.01 floor');
});

await test('a cut is clamped at -90%, never to zero or below', () => {
  const n = bulk(base(), ['c2'], 'pct', -500);
  assert.equal(yieldOf(n, 'c2'), 0.05);
});

await test('no-ops return the same state: 0%, unknown ids, unknown mode, NaN', () => {
  const s = base();
  assert.equal(bulk(s, ['c1'], 'pct', 0), s);
  assert.equal(bulk(s, ['nope'], 'pct', 10), s);
  assert.equal(bulk(s, ['c1'], 'double', 10), s);
  assert.equal(bulk(s, ['c1'], 'pct', NaN), s);
  assert.equal(bulk(s, ['c1'], 'set', -1), s);
});

console.log('\n── 2. The preview the UI shows ──────────────────────────');

const mod = await opt('../packages/engine/src/models/cargoYieldBulk.js');

await test('planCargoYields returns exactly what the reducer stores', () => {
  assert.ok(!mod.__err, `models/cargoYieldBulk.js failed to load: ${mod.__err?.message}`);
  const s = base();
  for (const [mode, value] of [['pct', 12.5], ['pct', -33], ['delta', 0.04], ['reference'], ['set', 0.61]]) {
    const plan = mod.planCargoYields(s, ['c1', 'c2', 'c3'], { mode, value });
    const n = bulk(s, ['c1', 'c2', 'c3'], mode, value);
    for (const r of s.cargoRoutes) {
      assert.equal(plan.yields.get(r.id) ?? r.yieldPrice, yieldOf(n, r.id), `${mode} ${value}: ${r.id}`);
    }
  }
});

await test('cargoYieldBatches splits a big selection and drops duplicates', () => {
  assert.ok(!mod.__err);
  const ids = Array.from({ length: 1203 }, (_, i) => `r${i}`);
  const b = mod.cargoYieldBatches([...ids, 'r0', 'r1'], 500);
  assert.deepEqual(b.map(x => x.length), [500, 500, 203]);
});

console.log('\n── 3. The multiplayer server ────────────────────────────');

const guard = await opt('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const world = await opt('../apps/headwinds-server/src/world.mjs');

await test('the action is on the server allow-list', () => {
  assert.ok(!world.__err, `world.mjs failed to load: ${world.__err?.message}`);
  assert.ok(world.ALLOWED_PLAYER_ACTIONS.has('BULK_SET_CARGO_YIELD'), 'players cannot send BULK_SET_CARGO_YIELD');
});

await test('the guard keeps only the airline\'s own freight routes', () => {
  assert.ok(!guard.__err, `decisionGuard.mjs failed to load: ${guard.__err?.message}`);
  const out = guard.guardDecision('BULK_SET_CARGO_YIELD', { routeIds: ['c1', 'c1', 'someone-else', 'c2'], mode: 'pct', value: '10' }, base());
  assert.deepEqual(out, { routeIds: ['c1', 'c2'], mode: 'pct', value: 10 });
  assert.deepEqual(guard.guardDecision('BULK_SET_CARGO_YIELD', { routeIds: ['c3'], mode: 'delta', value: 99 }, base()),
    { routeIds: ['c3'], mode: 'delta', value: 10 }, 'a $/t-km step is clamped');
  assert.deepEqual(guard.guardDecision('BULK_SET_CARGO_YIELD', { routeIds: ['c3'], mode: 'reference', value: 'ignored' }, base()),
    { routeIds: ['c3'], mode: 'reference', value: 0 });
});

await test('the guard refuses malformed changes', () => {
  assert.ok(!guard.__err);
  const bad = [
    { routeIds: [], mode: 'pct', value: 10 },
    { routeIds: ['zzz'], mode: 'pct', value: 10 },
    { routeIds: ['c1'], mode: 'double', value: 10 },
    { routeIds: ['c1'], mode: 'pct', value: 'abc' },
    { routeIds: ['c1'], mode: 'set', value: 0 },
    { routeIds: ['c1'], mode: 'set', value: 5000 },
    { routeIds: ['c1'], mode: 'delta', value: 'x' },
    { routeIds: Array.from({ length: 501 }, () => 'c1'), mode: 'pct', value: 1 },
  ];
  for (const p of bad) {
    assert.throws(() => guard.guardDecision('BULK_SET_CARGO_YIELD', p, base()), guard.GuardError, JSON.stringify(p).slice(0, 80));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
