// Beta / Alpha stage-tag test — no database, no network, no browser.
//
// Covers the maturity label end to end:
//   · validateWorldConfig accepts/rejects `alpha`
//   · createWorld only writes tickConfig.alpha when it's actually on
//   · serializeWorld exposes it (and defaults to false for old worlds)
//   · POST /worlds/:id/alpha semantics — set writes the key, clear DELETES it
//   · the shared top-bar StageTag renders Beta by default, Alpha when flagged
//   · the lobby AlphaTag renders at both sizes
//
//   node --import ./tools/_register-loader.mjs tools/world-stage-tag-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { validateWorldConfig, serializeWorld } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
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

console.log('\n── 1. alpha validation ──────────────────────────────────');

await test('alpha may be omitted', () => {
  validateWorldConfig({ ...BASE });
});

await test('alpha accepts true and false', () => {
  validateWorldConfig({ ...BASE, alpha: true });
  validateWorldConfig({ ...BASE, alpha: false });
});

await test('a non-boolean alpha is a 400, not a silently-truthy world', () => {
  for (const bad of ['true', 1, {}, []]) {
    assert.throws(
      () => validateWorldConfig({ ...BASE, alpha: bad }),
      (e) => e.statusCode === 400 && /alpha must be true or false/.test(e.message),
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

console.log('\n── 2. createWorld → tickConfig ──────────────────────────');

await test('alpha: true writes tickConfig.alpha', async () => {
  const p = fakePrisma();
  await createWorld(p, { ...BASE, alpha: true });
  assert.equal(p.calls[0].tickConfig.alpha, true);
});

await test('alpha off leaves the key absent entirely (not false)', async () => {
  for (const opts of [{ ...BASE }, { ...BASE, alpha: false }]) {
    const p = fakePrisma();
    await createWorld(p, opts);
    assert.ok(!('alpha' in p.calls[0].tickConfig),
      `expected no alpha key for ${JSON.stringify(opts)}`);
  }
});

await test('alpha is independent of the two rule flags', async () => {
  const p = fakePrisma();
  await createWorld(p, { ...BASE, alpha: true });
  const tc = p.calls[0].tickConfig;
  assert.ok(!('gateScarcity' in tc), 'alpha must not imply gate scarcity');
  assert.ok(!('newWorldRestrictions' in tc), 'alpha must not imply new-world restrictions');
});

console.log('\n── 3. serializeWorld ────────────────────────────────────');

const worldRow = (tickConfig) => ({
  id: 'w1', name: 'Old Metal World', status: 'RUNNING', visibility: 'PUBLIC',
  lengthYears: 50, weeksPerDay: 24, currentYear: 3, currentWeek: 7,
  maxPlayers: 20, tickConfig, joinCode: null,
  startedAt: null, endsAt: null, createdAt: new Date(0),
});

await test('a flagged world serializes alpha: true', () => {
  assert.equal(serializeWorld(worldRow({ alpha: true })).alpha, true);
});

await test('worlds created before the flag existed serialize alpha: false', () => {
  assert.equal(serializeWorld(worldRow({})).alpha, false);
  assert.equal(serializeWorld(worldRow(null)).alpha, false);
});

await test('a truthy-but-not-true value does not count as alpha', () => {
  assert.equal(serializeWorld(worldRow({ alpha: 'yes' })).alpha, false);
});

console.log('\n── 4. admin toggle semantics ────────────────────────────');

// Mirrors the body of POST /worlds/:id/alpha. Kept in step by the assertion
// below that the route file still contains this exact shape.
const applyAlpha = (tickConfig, alpha) => {
  const tc = { ...(tickConfig ?? {}) };
  if (alpha === true) tc.alpha = true; else delete tc.alpha;
  return tc;
};

await test('turning alpha on preserves every other tickConfig knob', () => {
  const before = { startingCapital: 15e6, demandMultiplier: 1, newWorldRestrictions: true };
  const after = applyAlpha(before, true);
  assert.equal(after.alpha, true);
  assert.equal(after.startingCapital, 15e6);
  assert.equal(after.newWorldRestrictions, true);
  assert.ok(!('alpha' in before), 'must not mutate the row we read');
});

await test('turning alpha off removes the key rather than storing false', () => {
  const after = applyAlpha({ alpha: true, gateScarcity: true }, false);
  assert.ok(!('alpha' in after), 'expected the key to be deleted');
  assert.equal(after.gateScarcity, true);
  assert.equal(serializeWorld(worldRow(after)).alpha, false);
});

console.log('\n── 5. rendering ─────────────────────────────────────────');

const { StageTag } = await import('../src/App.jsx');
const { AlphaTag } = await import('../apps/headwinds-web/src/App.jsx');

await test('the top-bar tag says Beta by default', () => {
  const html = renderToString(React.createElement(StageTag));
  assert.match(html, />Beta</);
  assert.ok(!/Alpha/.test(html), 'default must not be alpha');
});

await test("stage='alpha' swaps Beta for Alpha — never both", () => {
  const html = renderToString(React.createElement(StageTag, { stage: 'alpha' }));
  assert.match(html, />Alpha</);
  assert.ok(!/>Beta</.test(html), 'alpha replaces beta, it does not stack');
});

await test('an unknown stage falls back to Beta', () => {
  const html = renderToString(React.createElement(StageTag, { stage: 'gamma' }));
  assert.match(html, />Beta</);
});

await test('the lobby ALPHA chip renders at both sizes', () => {
  for (const size of ['sm', 'md']) {
    const html = renderToString(React.createElement(AlphaTag, { size }));
    assert.match(html, /ALPHA/, `size=${size}`);
    assert.match(html, /Alpha world/, `size=${size} needs the explanatory title`);
  }
});

console.log('\n── 6. wiring ────────────────────────────────────────────');

const read = async (p) => (await import('node:fs')).readFileSync(new URL(p, import.meta.url), 'utf8');

await test('the admin route is registered and admin-gated', async () => {
  const src = await read('../apps/headwinds-server/src/routes/worlds.mjs');
  assert.match(src, /'\/worlds\/:id\/alpha'/, 'route path');
  const body = src.slice(src.indexOf("'/worlds/:id/alpha'"));
  assert.match(body.slice(0, 400), /requireAdmin/, 'must be admin-only');
  assert.match(body.slice(0, 800), /if \(request\.body\.alpha === true\) tc\.alpha = true; else delete tc\.alpha;/,
    'applyAlpha above must mirror the route');
});

await test('the state endpoint ships worldAlpha so the top bar can read it', async () => {
  const src = await read('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(src, /worldAlpha: world\.tickConfig\?\.alpha === true/);
});

await test('the admin world list exposes alpha for the toggle button', async () => {
  const src = await read('../apps/headwinds-server/src/routes/admin.mjs');
  assert.match(src, /alpha: w\.tickConfig\?\.alpha === true/);
});

await test('GamePlayScreen maps worldAlpha onto remoteChrome.stage', async () => {
  const src = await read('../apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(src, /stage: meta\?\.worldAlpha \? 'alpha' : 'beta'/);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
