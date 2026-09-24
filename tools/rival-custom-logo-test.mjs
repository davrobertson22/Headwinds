// Custom logos must be visible to OTHER players, not just their owner.
//
// Discord (TheCookiesGuy, 2026-09-22): "Custom logos don't appear to other
// people or anywhere else? They only appear for me". Two causes:
//
//   1. The rival view never carried the logo. The upload lives in its own
//      Airline column (lib/logoColumn.mjs) and RIVAL_DROPPED_KEYS / the SQL
//      projection stripped it, deliberately, because shipping a ~30 kB data URL
//      per rival per rebuild is an egress bill. Rivals got `logoId` — which a
//      custom upload sets to 'horizon' — so everyone else saw a Horizon mark.
//      logoColor was never exported either, so even presets rendered blue.
//   2. The owner's OWN rows (leaderboard, markets, alliances) passed only
//      `state.logoId`, so "anywhere else" in their own game fell back too.
//
// The fix ships a URL, not the bytes: competitors carry
// `customLogo: '/logos/<airlineId>?v=<hash>'`, served by routes/logos.mjs with
// an immutable cache header, and AirlineLogo resolves a root-relative src
// against the API origin the web client registers.
//
//   node --import ./tools/_register-loader.mjs tools/rival-custom-logo-test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false }));
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const LOGO = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const md5_12 = (s) => createHash('md5').update(s, 'utf8').digest('hex').slice(0, 12);

const rivals = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const logoCol = await import('../apps/headwinds-server/src/lib/logoColumn.mjs');
const { freshState, RemoteGameProvider } = await import('../src/store/GameContext.jsx');
const Competition = (await import('../src/components/Competition.jsx')).default;
const LogoMod = await import('../src/components/AirlineLogo.jsx');
const AirlineLogo = LogoMod.default;

const rowOf = (over = {}) => ({
  id: 'air_diva', worldId: 'w1', name: 'Diva Down Airlines', hub: 'LAX', status: 'ACTIVE',
  restarts: 0, version: 3,
  state: { ...freshState(), airlineName: 'Diva Down Airlines', hub: 'LAX', logoId: 'horizon', logoColor: '#e0457b' },
  account: { isOG: false, isSupporter: false, email: null },
  ...over,
});

console.log('\n── 1. The rival view carries the logo (as a URL) and colour ─────────');

await test('a rival with an uploaded logo exports a cache-busted URL to it', () => {
  const c = rivals.toHumanCompetitor(rowOf({ customLogo: LOGO }));
  assert.equal(c.customLogo, `/logos/air_diva?v=${md5_12(LOGO)}`);
});

await test('the URL is a path, never the data URL itself (egress)', () => {
  const c = rivals.toHumanCompetitor(rowOf({ customLogo: LOGO }));
  assert.ok(!String(c.customLogo ?? '').startsWith('data:'));
});

await test('a projected row (SQL logoHash, no column) exports the SAME URL', () => {
  const full = rivals.toHumanCompetitor(rowOf({ customLogo: LOGO }));
  const projected = rivals.toHumanCompetitor(rowOf({ logoHash: md5_12(LOGO) }));
  assert.equal(projected.customLogo, full.customLogo);
});

await test('the JS projection twin (test-double prisma) carries the hash through', async () => {
  const prisma = { airline: { findMany: async () => [rowOf({ customLogo: LOGO })] } };
  const [row] = await rivals.loadRivalRows(prisma, 'w1');
  assert.equal(row.state.customLogo, undefined, 'the bytes still never ride the rival row state');
  assert.equal(rivals.toHumanCompetitor(row).customLogo, `/logos/air_diva?v=${md5_12(LOGO)}`);
});

await test('no upload → no customLogo key (rivals keep rendering their preset)', () => {
  const c = rivals.toHumanCompetitor(rowOf({ customLogo: null }));
  assert.equal('customLogo' in c, false);
});

await test('a changed upload changes the URL (clients refetch, caches never go stale)', () => {
  const a = rivals.toHumanCompetitor(rowOf({ customLogo: LOGO })).customLogo;
  const b = rivals.toHumanCompetitor(rowOf({ customLogo: LOGO + 'AA' })).customLogo;
  assert.notEqual(a, b);
});

await test('a rival exports its logo colour (presets were all rendering default blue)', () => {
  assert.equal(rivals.toHumanCompetitor(rowOf()).logoColor, '#e0457b');
});

console.log('\n── 2. Serving the image ───────────────────────────────────────────');

await test('a PNG data URL decodes to its bytes and content type', () => {
  const d = logoCol.decodeLogoDataUrl?.(LOGO);
  assert.ok(d, 'decodeLogoDataUrl exists and accepts a PNG');
  assert.equal(d.contentType, 'image/png');
  assert.deepEqual(Buffer.from(d.bytes), PNG_BYTES);
});

await test('SVG is refused — it would be script on the API origin', () => {
  assert.equal(typeof logoCol.decodeLogoDataUrl, 'function');
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
  assert.equal(logoCol.decodeLogoDataUrl(svg), null);
});

await test('junk and non-base64 data URLs are refused', () => {
  assert.equal(typeof logoCol.decodeLogoDataUrl, 'function');
  assert.equal(logoCol.decodeLogoDataUrl(null), null);
  assert.equal(logoCol.decodeLogoDataUrl('https://evil/x.png'), null);
  assert.equal(logoCol.decodeLogoDataUrl('data:image/png,rawtext'), null);
  assert.equal(logoCol.decodeLogoDataUrl('data:image/png;base64,'), null);
});

console.log('\n── 3. The UI renders it (SSR of the real components) ────────────────');

const API = 'https://api.headwinds.test';
LogoMod.setLogoOrigin?.(API);

await test('AirlineLogo resolves a root-relative logo path against the API origin', () => {
  const html = renderToString(React.createElement(AirlineLogo, { customSrc: '/logos/air_diva?v=abc', size: 32 }));
  assert.ok(html.includes(`${API}/logos/air_diva?v=abc`), html);
});

await test('a data URL is used untouched', () => {
  const html = renderToString(React.createElement(AirlineLogo, { customSrc: LOGO, size: 32 }));
  assert.ok(html.includes(LOGO));
});

const rivalComp = rivals.toHumanCompetitor(rowOf({ customLogo: LOGO }));
const myState = {
  ...freshState(), phase: 'playing', week: 20, year: 1, hub: 'JFK', cash: 10_000_000,
  airlineName: 'Me Air', logoId: 'horizon', logoColor: '#22aa55',
  customLogo: 'data:image/png;base64,TUVNRQ==',
  multiplayer: true,
  competitors: [rivalComp],
};
const renderCompetition = (state) => renderToString(React.createElement(
  RemoteGameProvider, { state, dispatch: () => {} }, React.createElement(Competition)));

await test('the leaderboard shows a rival\'s uploaded logo', () => {
  const html = renderCompetition(myState);
  assert.ok(html.includes(`${API}/logos/air_diva?v=${md5_12(LOGO)}`), 'rival logo URL not rendered');
});

await test('the leaderboard shows MY uploaded logo on my own row', () => {
  const html = renderCompetition(myState);
  assert.ok(html.includes('data:image/png;base64,TUVNRQ=='), 'own custom logo not rendered');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
