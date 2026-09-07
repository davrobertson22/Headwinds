// Rival-itineraries rollout rule — no database, no network.
//
// Dave, 2026-09-07: "The alpha worlds should get the change and then all future
// worlds." Not the betas — the standard ruleset players are mid-game in. So:
//   · a world with an explicit tickConfig.rivalItineraries uses it
//   · a world WITHOUT the key predates the feature: on for alpha, OFF for beta/live
//   · createWorld always writes the key (ON unless the creator unticks it), so
//     every future world is on whatever its stage
//   · the admin toggle writes an explicit true/false either way
//   · serializeWorld's `rivalItineraries` (what the lobby chip reads) follows
//     the same rule, so a beta world does not wear the ⇄ HUBS chip
//
//   node --import ./tools/_register-loader.mjs tools/rival-itineraries-rollout-test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rivalItinerariesOf, serializeWorld } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { createWorld } from '../apps/headwinds-server/src/lib/worldService.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}
const fakePrisma = () => {
  const calls = [];
  return { calls, world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } };
};
const BASE = { lengthYears: 50, weeksPerDay: 24 };
const worldWith = (tickConfig) => ({
  id: 'w1', name: 'W', joinCode: 'ABCDEF', seed: 1, status: 'running', visibility: 'public',
  maxPlayers: 50, lengthYears: 50, weeksPerDay: 24, currentWeek: 1, createdAt: new Date(), tickConfig,
});

console.log('\n── rollout rule ─────────────────────────────────────────');

await test('an explicit flag wins whatever the stage', () => {
  assert.equal(rivalItinerariesOf({ stage: 'beta', rivalItineraries: true }), true);
  assert.equal(rivalItinerariesOf({ stage: 'alpha', rivalItineraries: false }), false);
});

await test('worlds that predate the feature: alpha ON, beta and live OFF', () => {
  assert.equal(rivalItinerariesOf({ stage: 'alpha' }), true);
  assert.equal(rivalItinerariesOf({ alpha: true }), true, 'the legacy alpha boolean counts');
  assert.equal(rivalItinerariesOf({ stage: 'beta' }), false);
  assert.equal(rivalItinerariesOf({}), false, 'no stage key means beta');
  assert.equal(rivalItinerariesOf(undefined), false);
  assert.equal(rivalItinerariesOf({ stage: 'live' }), false);
});

await test('every future world stores the key — ON by default, OFF if unticked', async () => {
  for (const stage of ['alpha', 'beta', 'live']) {
    const p = fakePrisma();
    await createWorld(p, { ...BASE, stage });
    assert.equal(p.calls[0].tickConfig.rivalItineraries, true, `${stage} world created today is on`);
  }
  const off = fakePrisma();
  await createWorld(off, { ...BASE, stage: 'beta', rivalItineraries: false });
  assert.equal(off.calls[0].tickConfig.rivalItineraries, false);
});

await test('the lobby chip follows the same rule', () => {
  assert.equal(serializeWorld(worldWith({ stage: 'alpha' }), {}).rivalItineraries, true);
  assert.equal(serializeWorld(worldWith({ stage: 'beta' }), {}).rivalItineraries, false, 'a beta world wears no ⇄ HUBS chip');
  assert.equal(serializeWorld(worldWith({ stage: 'beta', rivalItineraries: true }), {}).rivalItineraries, true);
});

await test('tick and join resolve through the helper, not a bare !== false', async () => {
  const tick = await readFile(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  const svc  = await readFile(new URL('../apps/headwinds-server/src/lib/worldService.mjs', import.meta.url), 'utf8');
  const route = await readFile(new URL('../apps/headwinds-server/src/routes/worlds.mjs', import.meta.url), 'utf8');
  assert.match(tick, /rivalItineraries: rivalItinerariesOf\(world\.tickConfig\)/);
  assert.match(svc, /rivalItineraries: rivalItinerariesOf\(tc\)/);
  assert.doesNotMatch(tick + svc, /(tickConfig\?\.|tc\.)rivalItineraries !== false/, 'the old absent-key-means-on rule is gone');
  assert.match(route, /tc\.rivalItineraries = request\.body\.enabled === true/, 'admin toggle writes an explicit value');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
