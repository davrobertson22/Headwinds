// World stage-label test (alpha / beta / live) — no database, no network, no browser.
//
// Covers the maturity label end to end:
//   · validateWorldConfig accepts the three stages and rejects anything else
//   · createWorld only writes tickConfig.stage when it differs from the default
//   · worldStageOf / serializeWorld default to beta, and still honour the
//     short-lived `alpha: true` boolean that stages replaced
//   · POST /worlds/:id/stage semantics — beta DELETES the key, and every write
//     clears the legacy `alpha` boolean so it can't resurrect itself
//   · the shared top-bar StageTag and the lobby StageChip render Beta / Alpha,
//     and render NOTHING at all for a live world
//
//   node --import ./tools/_register-loader.mjs tools/world-stage-tag-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

import {
  validateWorldConfig, serializeWorld, worldStageOf, WORLD_STAGES, DEFAULT_WORLD_STAGE,
} from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { createWorld } from '../apps/headwinds-server/src/lib/worldService.mjs';

// Browser shims — apps/headwinds-web/src/App.jsx reads window at import time.
globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});
globalThis.fetch = globalThis.fetch ?? (() => Promise.reject(new Error('no network in SSR')));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// Enough of prisma.world.create to capture the row the service builds.
const fakePrisma = () => {
  const calls = [];
  return {
    calls,
    world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } },
  };
};

const BASE = { lengthYears: 50, weeksPerDay: 24 };

console.log('\n── 1. stage validation ──────────────────────────────────');

await test('there are exactly three stages and beta is the default', () => {
  assert.deepEqual(WORLD_STAGES, ['alpha', 'beta', 'live']);
  assert.equal(DEFAULT_WORLD_STAGE, 'beta');
});

await test('stage may be omitted', () => {
  validateWorldConfig({ ...BASE });
});

await test('every declared stage is accepted', () => {
  for (const stage of WORLD_STAGES) validateWorldConfig({ ...BASE, stage });
});

await test('anything else is a 400, not a silently-mislabelled world', () => {
  for (const bad of ['production', 'ALPHA', '', true, 1, {}]) {
    assert.throws(
      () => validateWorldConfig({ ...BASE, stage: bad }),
      (e) => e.statusCode === 400 && /stage must be one of/.test(e.message),
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

console.log('\n── 2. createWorld → tickConfig ──────────────────────────');

await test('a non-default stage is written', async () => {
  for (const stage of ['alpha', 'live']) {
    const p = fakePrisma();
    await createWorld(p, { ...BASE, stage });
    assert.equal(p.calls[0].tickConfig.stage, stage);
  }
});

await test('the default leaves the key absent entirely', async () => {
  for (const opts of [{ ...BASE }, { ...BASE, stage: 'beta' }]) {
    const p = fakePrisma();
    await createWorld(p, opts);
    assert.ok(!('stage' in p.calls[0].tickConfig),
      `expected no stage key for ${JSON.stringify(opts)}`);
  }
});

await test('stage is independent of the two rule flags', async () => {
  const p = fakePrisma();
  await createWorld(p, { ...BASE, stage: 'alpha' });
  const tc = p.calls[0].tickConfig;
  assert.ok(!('gateScarcity' in tc), 'stage must not imply gate scarcity');
  assert.ok(!('newWorldRestrictions' in tc), 'stage must not imply new-world restrictions');
});

console.log('\n── 3. worldStageOf / serializeWorld ─────────────────────');

const worldRow = (tickConfig) => ({
  id: 'w1', name: 'Old Metal', status: 'RUNNING', visibility: 'PUBLIC',
  lengthYears: 50, weeksPerDay: 24, currentYear: 3, currentWeek: 7,
  maxPlayers: 20, tickConfig, joinCode: null,
  startedAt: null, endsAt: null, createdAt: new Date(0),
});

await test('each stage round-trips through the serializer', () => {
  for (const stage of WORLD_STAGES) {
    assert.equal(serializeWorld(worldRow({ stage })).stage, stage);
  }
});

await test('worlds created before stages existed read as beta', () => {
  for (const tc of [{}, null, { gateScarcity: true }]) {
    assert.equal(worldStageOf(tc), 'beta');
    assert.equal(serializeWorld(worldRow(tc)).stage, 'beta');
  }
});

await test('a junk stage value falls back to beta rather than leaking through', () => {
  assert.equal(worldStageOf({ stage: 'production' }), 'beta');
  assert.equal(serializeWorld(worldRow({ stage: 'production' })).stage, 'beta');
});

await test('the legacy `alpha: true` boolean still reads as alpha', () => {
  assert.equal(worldStageOf({ alpha: true }), 'alpha');
  assert.equal(serializeWorld(worldRow({ alpha: true })).stage, 'alpha');
});

await test('an explicit stage beats the legacy boolean', () => {
  assert.equal(worldStageOf({ alpha: true, stage: 'live' }), 'live');
});

await test('the compat `alpha` field is still emitted for stale browser tabs', () => {
  assert.equal(serializeWorld(worldRow({ stage: 'alpha' })).alpha, true);
  assert.equal(serializeWorld(worldRow({ stage: 'live' })).alpha, false);
  assert.equal(serializeWorld(worldRow({})).alpha, false);
});

console.log('\n── 4. admin stage-change semantics ──────────────────────');

// Mirrors the body of POST /worlds/:id/stage. Kept in step by the assertion
// below that the route file still contains this exact shape.
const applyStage = (tickConfig, stage) => {
  const tc = { ...(tickConfig ?? {}) };
  if (stage === DEFAULT_WORLD_STAGE) delete tc.stage; else tc.stage = stage;
  delete tc.alpha;
  return tc;
};

await test('setting a stage preserves every other tickConfig knob', () => {
  const before = { startingCapital: 15e6, demandMultiplier: 1, newWorldRestrictions: true };
  const after = applyStage(before, 'live');
  assert.equal(after.stage, 'live');
  assert.equal(after.startingCapital, 15e6);
  assert.equal(after.newWorldRestrictions, true);
  assert.ok(!('stage' in before), 'must not mutate the row we read');
});

await test('setting beta removes the key rather than storing the default', () => {
  const after = applyStage({ stage: 'alpha', gateScarcity: true }, 'beta');
  assert.ok(!('stage' in after), 'expected the key to be deleted');
  assert.equal(after.gateScarcity, true);
  assert.equal(worldStageOf(after), 'beta');
});

await test('moving a legacy alpha world to beta actually sticks', () => {
  // The trap: leave `alpha: true` behind and worldStageOf() falls back to it,
  // silently undoing the admin's change on the very next read.
  const after = applyStage({ alpha: true }, 'beta');
  assert.ok(!('alpha' in after), 'the legacy boolean must be cleared');
  assert.equal(worldStageOf(after), 'beta');
});

await test('every stage survives a round trip through the handler', () => {
  for (const stage of WORLD_STAGES) {
    assert.equal(worldStageOf(applyStage({ alpha: true }, stage)), stage);
  }
});

console.log('\n── 5. rendering ─────────────────────────────────────────');

const { StageTag } = await import('../src/App.jsx');
const { StageChip, STAGE_LABELS } = await import('../apps/headwinds-web/src/App.jsx');

const render = (C, props) => renderToString(React.createElement(C, props));

await test('the top-bar tag says Beta by default', () => {
  const html = render(StageTag);
  assert.match(html, />Beta</);
  assert.ok(!/Alpha/.test(html), 'default must not be alpha');
});

await test("stage='alpha' swaps Beta for Alpha — never both", () => {
  const html = render(StageTag, { stage: 'alpha' });
  assert.match(html, />Alpha</);
  assert.ok(!/>Beta</.test(html), 'alpha replaces beta, it does not stack');
});

await test('a live world wears no top-bar label at all', () => {
  assert.equal(render(StageTag, { stage: 'live' }), '');
});

await test('an unknown stage falls back to Beta', () => {
  assert.match(render(StageTag, { stage: 'gamma' }), />Beta</);
});

await test('the lobby chip renders BETA and ALPHA at both sizes', () => {
  for (const size of ['sm', 'md']) {
    assert.match(render(StageChip, { size }), /BETA/, `beta size=${size}`);
    assert.match(render(StageChip, { stage: 'alpha', size }), /ALPHA/, `alpha size=${size}`);
  }
});

await test('the lobby chip renders nothing for a live world', () => {
  for (const size of ['sm', 'md']) {
    assert.equal(render(StageChip, { stage: 'live', size }), '', `size=${size}`);
  }
});

await test('every stage has an admin-facing label', () => {
  for (const stage of WORLD_STAGES) {
    assert.equal(typeof STAGE_LABELS[stage], 'string', stage);
  }
});

console.log('\n── 6. wiring ────────────────────────────────────────────');

const read = async (p) => (await import('node:fs')).readFileSync(new URL(p, import.meta.url), 'utf8');

await test('the admin route is registered and admin-gated', async () => {
  const src = await read('../apps/headwinds-server/src/routes/worlds.mjs');
  assert.match(src, /'\/worlds\/:id\/stage'/, 'route path');
  const body = src.slice(src.indexOf("'/worlds/:id/stage'"));
  assert.match(body.slice(0, 400), /requireAdmin/, 'must be admin-only');
  assert.match(body.slice(0, 900),
    /if \(stage === DEFAULT_WORLD_STAGE\) delete tc\.stage; else tc\.stage = stage;\s*\n\s*delete tc\.alpha;/,
    'applyStage above must mirror the route');
});

await test('the state endpoint ships worldStage so the top bar can read it', async () => {
  const src = await read('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(src, /worldStage: worldStageOf\(world\.tickConfig\)/);
});

await test('the admin world list exposes stage for the picker', async () => {
  const src = await read('../apps/headwinds-server/src/routes/admin.mjs');
  assert.match(src, /stage: worldStageOf\(w\.tickConfig\)/);
});

await test('GamePlayScreen maps worldStage onto remoteChrome.stage', async () => {
  const src = await read('../apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(src, /stage: meta\?\.worldStage \?\? 'beta'/);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
