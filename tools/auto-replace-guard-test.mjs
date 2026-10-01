// "Replace leavers automatically" reaches the engine in multiplayer.
//
// The toggle is a new action (SET_AUTO_REPLACE). Without an allow-list entry it
// is refused as "Action not allowed"; without a guard a forged group id or a
// truthy string rides into the save. The rehiring itself runs in the engine
// after each tick (withAutoReplace), through HIRE_CREW's own cost checks.
//
//   node --import ./tools/_register-loader.mjs tools/auto-replace-guard-test.mjs
import assert from 'node:assert/strict';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');

t('SET_AUTO_REPLACE is a player action', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_AUTO_REPLACE'));
});
t('a real group and a boolean pass through', () => {
  assert.deepEqual(guardDecision('SET_AUTO_REPLACE', { group: 'pilots', enabled: true }, {}), { group: 'pilots', enabled: true });
  assert.deepEqual(guardDecision('SET_AUTO_REPLACE', { group: 'cabinCrew', enabled: false }, {}), { group: 'cabinCrew', enabled: false });
});
t('anything but literal true is off', () => {
  assert.equal(guardDecision('SET_AUTO_REPLACE', { group: 'pilots', enabled: 'yes' }, {}).enabled, false);
});
t('an unknown group is refused', () => {
  assert.throws(() => guardDecision('SET_AUTO_REPLACE', { group: 'wizards', enabled: true }, {}), GuardError);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
