// Peak hours in Headwinds: the world option, the flag on every airline, and the
// hold decision (engine: tools/peak-hours-test.mjs; rivals scored on their own
// timetables: tools/rival-share-symmetry-test.mjs).
//
// New worlds only (Dave, 2026-11-16): ON unless the creator unticks it, baked
// into tickConfig at creation, stamped on each airline at join and re-stamped
// every tick like the other rule flags. Older worlds never gain it.
//
//   node --import ./tools/_register-loader.mjs tools/peak-hours-server-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWorldConfig, serializeWorld } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const base = { lengthYears: 5, weeksPerDay: 24, visibility: 'PUBLIC', maxPlayers: 20, startingCapital: 10_000_000, demandMultiplier: 1 };

console.log('\n── Peak hours on the server ─────────────────────────────────────');

test('the world option is a boolean or absent', () => {
  validateWorldConfig({ ...base });
  validateWorldConfig({ ...base, peakHours: true });
  validateWorldConfig({ ...base, peakHours: false });
  assert.throws(() => validateWorldConfig({ ...base, peakHours: 'yes' }), /peakHours must be true or false/);
});

test('a world reports peak hours only when its tickConfig has them', () => {
  const w = (tc) => ({ id: 'w', name: 'W', tickConfig: tc, status: 'OPEN', currentWeek: 1, currentYear: 1, lengthYears: 5, weeksPerDay: 24, visibility: 'public', maxPlayers: 20, createdAt: new Date(0) });
  assert.equal(serializeWorld(w({ peakHours: true }), { playerCount: 0 }).peakHours, true);
  assert.equal(serializeWorld(w({}), { playerCount: 0 }).peakHours, false);
});

test('new worlds get it unless unticked; join and every tick stamp it on the airline', () => {
  const ws = src('../apps/headwinds-server/src/lib/worldService.mjs');
  assert.match(ws, /\.\.\.\(peakHours !== false \? \{ peakHours: true \} : \{\}\)/);
  assert.match(ws, /\.\.\.\(tc\.peakHours === true \? \{ peakHours: true \} : \{\}\)/);
  assert.match(src('../apps/headwinds-server/src/lib/tickService.mjs'), /world\.tickConfig\?\.peakHours === true \? \{ peakHours: true \} : \{\}/);
  assert.match(src('../apps/headwinds-server/src/routes/worlds.mjs'), /peakHours: \{ type: 'boolean' \}/);
});

test('SET_ROUTE_HOLDS is allowed, and its guard keeps to peak worlds and the airline\'s own routes', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_ROUTE_HOLDS'));
  const st = { peakHours: true, routes: [{ id: 'r1' }], cargoRoutes: [{ id: 'c1' }] };
  assert.deepEqual(guardDecision('SET_ROUTE_HOLDS', { holds: { r1: 1203, c1: null, zz: 600 } }, st),
    { holds: { r1: 1205, c1: null } });
  assert.throws(() => guardDecision('SET_ROUTE_HOLDS', { holds: { r1: 600 } }, { ...st, peakHours: undefined }), /not part of this world/);
  assert.throws(() => guardDecision('SET_ROUTE_HOLDS', { holds: { zz: 600 } }, st), /Unknown route/);
  assert.throws(() => guardDecision('SET_ROUTE_HOLDS', { holds: { r1: '7pm' } }, st), /time of day/);
  assert.throws(() => guardDecision('SET_ROUTE_HOLDS', { holds: [] }, st), /No holds/);
});

console.log(`\npeak-hours-server-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
