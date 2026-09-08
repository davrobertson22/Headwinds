// Hiring crew in multiplayer was impossible: every number was "invalid".
//
// The Operations staffing card dispatches HIRE_CREW in PEOPLE:
//   { type: 'HIRE_CREW', group, bodies: n }
// `bodies` was added to the reducer when the screen switched from the engine's
// narrowbody-equivalent units to people, and the reducer honours it. The server
// guard was never taught about it: guardHireCrew read only `payload.count`, so
// Number(undefined) -> NaN failed the finite check and EVERY hire — presets and
// custom box alike — came back "Invalid number of crew to hire."
//
// Even had it not thrown, the guard returns a rebuilt object, so `bodies` would
// have been dropped on the way to the reducer and the hire silently ignored.
//
//   node tools/crew-hire-bodies-guard-test.mjs

import assert from 'node:assert/strict';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { CREW_PER_UNIT } from '../packages/engine/src/data/labor.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nHIRE_CREW guard — bodies (the payload the screen actually sends)');

test('a bodies-only hire survives the guard', () => {
  const out = guardDecision('HIRE_CREW', { group: 'pilots', bodies: 9 }, {});
  assert.equal(out.group, 'pilots');
  assert.equal(out.bodies, 9, 'bodies must reach the reducer');
});

test('every group accepts a one-aircraft hire', () => {
  for (const group of Object.keys(CREW_PER_UNIT)) {
    const out = guardDecision('HIRE_CREW', { group, bodies: CREW_PER_UNIT[group] }, {});
    assert.equal(out.bodies, CREW_PER_UNIT[group], group);
  }
});

test('count still means UNITS for older clients and the playbot', () => {
  const out = guardDecision('HIRE_CREW', { group: 'cabinCrew', count: 3 }, {});
  assert.equal(out.count, 3);
  assert.equal(out.bodies, undefined, 'a count payload must not grow a bodies field');
});

test('bodies is bounded at the 500-unit ceiling count uses', () => {
  const out = guardDecision('HIRE_CREW', { group: 'pilots', bodies: 10_000_000 }, {});
  assert.equal(out.bodies, 500 * CREW_PER_UNIT.pilots);
});

test('junk is still rejected', () => {
  for (const payload of [
    { group: 'pilots', bodies: 'lots' },
    { group: 'pilots', bodies: 0 },
    { group: 'pilots', bodies: -5 },
    { group: 'pilots', bodies: Infinity },
    { group: 'pilots' },
    { group: 'nobody', bodies: 9 },
  ]) {
    assert.throws(() => guardDecision('HIRE_CREW', payload, {}), GuardError, JSON.stringify(payload));
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
