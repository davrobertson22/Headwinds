// A12 — New World Restrictions are the DEFAULT rule set for new worlds.
//
// NWR is the balanced model (restricted lessor stock + a lease order book
// capped against the operating fleet, trimmed reference fares, load-factor
// ceiling). Classic is the old arcade model that let a mid-table airline lease
// 196 A380s in two clicks. New worlds now get NWR unless the creator opts out.
//
// Three things have to hold together, and the third is the sharp edge:
//   1. createWorld with NO flag  → restrictions ON
//   2. createWorld with `false`  → classic, explicitly
//   3. the create-world form sends an EXPLICIT boolean — under the new default
//      the old "omit the key when unchecked" shorthand would silently mean ON
//   4. worlds created BEFORE the flip keep their stored config (no retro-change)
//
//   node tools/nwr-default-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { serializeWorld } from '../apps/headwinds-server/src/lib/worldConfig.mjs';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Enough of prisma.world.create to capture the row the service builds.
const fakePrisma = () => {
  const calls = [];
  return { calls, world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } };
};
const BASE = { name: 'T', lengthYears: 50, weeksPerDay: 24, maxPlayers: 20 };
const tcOf = async (opts) => { const p = fakePrisma(); await createWorld(p, opts); return p.calls[0].tickConfig; };

await test('a new world defaults to New World Restrictions ON', async () => {
  const tc = await tcOf({ ...BASE });
  assert.equal(tc.newWorldRestrictions, true, 'omitting the flag must now mean ON');
});

await test('passing true is still ON', async () => {
  const tc = await tcOf({ ...BASE, newWorldRestrictions: true });
  assert.equal(tc.newWorldRestrictions, true);
});

await test('passing false opts out to a classic world', async () => {
  const tc = await tcOf({ ...BASE, newWorldRestrictions: false });
  assert.notEqual(tc.newWorldRestrictions, true, 'explicit false must produce a classic world');
});

await test('the create-world form sends an explicit boolean, not omit-when-false', () => {
  const src = read('../apps/headwinds-web/src/App.jsx');
  assert.ok(!/\.\.\.\(newWorldRestrictions \? \{ newWorldRestrictions: true \} : \{\}\)/.test(src),
    'form still omits the key when unchecked — the server would read that as ON');
  assert.ok(/\n\s+newWorldRestrictions,\n/.test(src), 'form does not send the explicit boolean');
  assert.ok(/const \[newWorldRestrictions, setNewWorldRestrictions\] = useState\(true\)/.test(src),
    'the checkbox no longer defaults to on');
});

await test('worlds created before the flip are not retro-changed', () => {
  // An old classic world stored no key at all; it must still read as classic.
  const oldRow = {
    id: 'w0', name: 'Old Classic', status: 'RUNNING', visibility: 'PUBLIC',
    lengthYears: 50, weeksPerDay: 24, currentYear: 3, currentWeek: 7,
    maxPlayers: 20, joinCode: null, tickConfig: { startingCapital: 15e6, demandMultiplier: 1 },
  };
  assert.equal(serializeWorld(oldRow).newWorldRestrictions, false,
    'an existing classic world must stay classic');
  const oldNwr = { ...oldRow, tickConfig: { ...oldRow.tickConfig, newWorldRestrictions: true } };
  assert.equal(serializeWorld(oldNwr).newWorldRestrictions, true);
});

console.log(`\nnwr-default: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
