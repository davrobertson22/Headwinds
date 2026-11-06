// Custom tails (2026-11-06): anyone can upload their own tail image in the
// logo maker's Tail section. It is shrunk in the browser to the fin's
// proportions (utils/logoImage.js), drawn clipped to the fin silhouette
// everywhere tails show (TailFin.jsx) in place of the design and logo, and
// stored exactly like the uploaded logo: its own Airline column
// (`customTail`, migration 20261106000000), split out of every persisted
// blob and injected on owner reads (lib/logoColumn.mjs), never in a rival
// projection (RIVAL_DROPPED_KEYS + rival_state_of), and served to rivals as
// a /tails/<id>?v=<hash> URL (routes/logos.mjs). Restart and the admin
// "Clear logo" clear it with the logo.
//
// On HEAD before this change every behavioural check here fails on the
// existing call paths: splitLogo leaves the tail bytes in the blob, the
// guard drops the key, rivals never see a tail, TailFin ignores the prop.
//
//   node --import ./tools/_register-loader.mjs tools/custom-tail-test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => readFileSync(at(rel), 'utf8');
const strip = (h) => h.replaceAll('<!-- -->', '');
const store = new Map();
globalThis.window = globalThis.window ?? {};
window.dispatchEvent = () => true; window.addEventListener = () => {}; window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
window.localStorage = globalThis.localStorage;

const TAIL = `data:image/webp;base64,${Buffer.from('RIFF....WEBPVP8 ').toString('base64')}`;
const LOGO = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')}`;
const md5_12 = (s) => createHash('md5').update(s, 'utf8').digest('hex').slice(0, 12);

const col = await import('../apps/headwinds-server/src/lib/logoColumn.mjs');
const rivals = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const { guardDecision, GuardError } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { gameReducer } = await import('@tailwinds/engine/reducer');
const TF = await import('../src/components/TailFin.jsx');
const TailFin = TF.default;
const { hubFinMarkup } = await import('../src/utils/hubFin.js');
const { setLogoOrigin } = await import('../src/components/AirlineLogo.jsx');
const img = await import('../src/utils/logoImage.js');
const { freshState } = await import('../src/store/GameContext.jsx');

console.log('\nCustom tails\n');

console.log('── the column contract ──');

await test('splitLogo takes the tail out of every persisted blob, alongside the logo', () => {
  const out = col.splitLogo({ a: 1, customLogo: LOGO, customTail: TAIL });
  assert.deepEqual(out.state, { a: 1 }, 'neither image rides the blob');
  assert.equal(out.logo, LOGO);
  assert.equal(out.tail, TAIL);
  const tailOnly = col.splitLogo({ a: 1, customTail: null });
  assert.equal(tailOnly.logo, undefined, 'an untouched logo column is left alone');
  assert.equal(tailOnly.tail, null, 'null means the player cleared it: null the column');
  assert.equal(col.splitLogo({ a: 1 }).tail, undefined, 'no key → leave the column alone');
});

await test('injectLogo puts both columns back for the owner; a state already carrying one wins', () => {
  assert.deepEqual(col.injectLogo({ a: 1 }, LOGO, TAIL), { a: 1, customLogo: LOGO, customTail: TAIL });
  assert.deepEqual(col.injectLogo({ a: 1 }, null, TAIL), { a: 1, customTail: TAIL });
  assert.deepEqual(col.injectLogo({ a: 1, customTail: null }, LOGO, TAIL), { a: 1, customLogo: LOGO, customTail: null },
    'the SET_BRANDING response (just cleared) beats the row read before it ran');
  assert.deepEqual(col.injectLogo({ a: 1 }, LOGO), { a: 1, customLogo: LOGO }, 'two-argument callers still work');
});

await test('the tail URL mirrors the logo URL under /tails, same hash', () => {
  assert.equal(typeof col.tailPathOf, 'function');
  assert.equal(col.tailPathOf('air_1', md5_12(TAIL)), `/tails/air_1?v=${md5_12(TAIL)}`);
  assert.equal(col.tailPathOf('air_1', null), null);
  assert.equal(col.logoHashOf(TAIL), md5_12(TAIL));
});

await test('the schema and migration add the column; the rival SQL projection drops the key', () => {
  assert.match(read('../apps/headwinds-server/prisma/schema.prisma'), /\n\s+customTail\s+String\?/);
  const mig = '../apps/headwinds-server/prisma/migrations/20261106000000_airline_custom_tail/migration.sql';
  assert.ok(existsSync(at(mig)), 'migration present');
  const sql = read(mig);
  assert.match(sql, /ALTER TABLE "Airline" ADD COLUMN "customTail" TEXT;/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rival_state_of/);
  assert.match(sql, /- 'customLogo' - 'customTail'\)/);
  assert.deepEqual(rivals.RIVAL_DROPPED_KEYS, ['customLogo', 'customTail']);
  assert.equal('customTail' in rivals.projectRivalState({ customTail: TAIL, x: 1 }), false);
});

console.log('\n── the server paths ──');

await test('guard: a raster tail passes, null clears, SVG and oversize are refused, a rename never touches it', () => {
  assert.equal(guardDecision('SET_BRANDING', { airlineName: 'Neo', customTail: TAIL }, {}).customTail, TAIL);
  assert.equal(guardDecision('SET_BRANDING', { airlineName: 'Neo', customTail: null }, {}).customTail, null);
  assert.equal('customTail' in guardDecision('SET_BRANDING', { airlineName: 'Neo' }, {}), false);
  assert.throws(() => guardDecision('SET_BRANDING', { customTail: 'data:image/svg+xml;base64,PHN2Zz4=' }, {}), GuardError);
  assert.throws(() => guardDecision('SET_BRANDING', { customTail: `data:image/png;base64,${'A'.repeat(200_000)}` }, {}), GuardError);
  assert.throws(() => guardDecision('SET_BRANDING', { customTail: 42 }, {}), GuardError);
});

await test('reducer: SET_BRANDING stores the tail and null clears it; other decisions leave it alone', () => {
  const s0 = { ...freshState(), phase: 'playing' };
  const s1 = gameReducer(s0, { type: 'SET_BRANDING', airlineName: 'Neo', customTail: TAIL });
  assert.equal(s1.customTail, TAIL);
  const s2 = gameReducer(s1, { type: 'SET_BRANDING', airlineName: 'Neo Air' });
  assert.equal(s2.customTail, TAIL, 'a rename keeps the tail');
  assert.equal(gameReducer(s2, { type: 'SET_BRANDING', customTail: null }).customTail, null);
});

await test('the decision route writes the tail column with the logo column and injects both back', () => {
  const src = read('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(src, /const \{ state: blob, logo, tail \} = splitLogo\(stripRivals\(next\)\);/);
  assert.match(src, /\.\.\.\(tail !== undefined \? \{ customTail: tail \} : \{\}\),/);
  assert.equal((src.match(/airline\.customLogo, airline\.customTail\)/g) ?? []).length, 3, 'every owner serve injects the tail');
  for (const f of ['codeshares', 'gates', 'aircraftMarket']) {
    assert.match(read(`../apps/headwinds-server/src/routes/${f}.mjs`), /customLogo, \w+\.customTail\)/, `${f} injects the tail`);
  }
  assert.match(read('../apps/headwinds-server/src/lib/restartService.mjs'), /customLogo: null,\s*customTail: null,/, 'a restart clears it');
  assert.match(read('../apps/headwinds-server/src/routes/admin.mjs'), /data: \{ customLogo: null, customTail: null \}/, 'admin Clear logo clears it');
});

await test('rivals get the tail as a /tails URL — hashed in SQL, or from the row — never the bytes', async () => {
  const rowOf = (over = {}) => ({
    id: 'air_diva', worldId: 'w1', name: 'Diva', hub: 'LAX', status: 'ACTIVE', restarts: 0, version: 3,
    state: { ...freshState(), airlineName: 'Diva', hub: 'LAX', logoId: 'horizon' },
    account: { isOG: false, isSupporter: false, email: null }, ...over,
  });
  const c = rivals.toHumanCompetitor(rowOf({ customTail: TAIL }));
  assert.equal(c.customTail, `/tails/air_diva?v=${md5_12(TAIL)}`);
  assert.equal(rivals.toHumanCompetitor(rowOf({ tailHash: 'abcdef012345' })).customTail, '/tails/air_diva?v=abcdef012345', 'the SQL hash wins');
  assert.equal('customTail' in rivals.toHumanCompetitor(rowOf({ customTail: null })), false);
  const prisma = { airline: { findMany: async () => [rowOf({ customTail: TAIL })] } };
  const [row] = await rivals.loadRivalRows(prisma, 'w1');
  assert.equal(row.tailHash, md5_12(TAIL));
  assert.equal(row.customTail, undefined, 'the bytes never ride the rival row');
  const hr = read('../apps/headwinds-server/src/lib/humanRivals.mjs');
  assert.match(hr, /left\(md5\(a\."customTail"\), 12\) AS "tailHash"/);
  for (const f of ['routes/worlds.mjs', 'routes/players.mjs']) {
    assert.match(read(`../apps/headwinds-server/src/${f}`), /left\(md5\(a\."customTail"\), 12\) AS "tailHash"/, `${f} hashes the tail`);
    assert.match(read(`../apps/headwinds-server/src/${f}`), /customTail: tailPathOf\(a\.id, \w+\.tailHash\)/, `${f} carries the URL`);
  }
  const route = read('../apps/headwinds-server/src/routes/logos.mjs');
  assert.match(route, /imageRoute\(fastify, '\/logos\/:airlineId', 'customLogo'/);
  assert.match(route, /imageRoute\(fastify, '\/tails\/:airlineId', 'customTail'/);
});

console.log('\n── drawing it ──');

const fin = (props) => strip(renderToStaticMarkup(React.createElement(TailFin, { livery: { tail: '#0a2a66', tailDesign: 'swoosh' }, logo: { id: 'eagle', accentColor: '#fff' }, height: 48, idPrefix: 'x', ...props })));

await test('TailFin draws the upload clipped to the fin, over the tail colour, with no design and no logo', () => {
  const html = fin({ tail: TAIL });
  assert.match(html, /data-tail-design="custom"/);
  assert.match(html, new RegExp(`<image href="${TAIL.replace(/[+/]/g, (m) => `\\${m}`)}" x="0" y="0" width="1291" height="1000" preserveAspectRatio="xMidYMid slice"`));
  assert.match(html, /<rect x="0" y="0" width="1291" height="1000" fill="#0a2a66">/, 'the tail colour shows through clear areas');
  assert.doesNotMatch(html, /<g transform="translate[^>]*><svg/, 'no logo on an uploaded tail');
  assert.equal((html.match(/<path d="M405 1000/g) ?? []).length, 2, 'clip path + outline, no swoosh');
  assert.match(fin({}), /<path d="M0 720 C/, 'without an upload the design still draws');
});

await test('a rival\'s /tails path resolves against the API origin, like /logos', () => {
  setLogoOrigin('https://api.example.test/');
  try {
    assert.match(fin({ tail: '/tails/air_1?v=abc' }), /<image href="https:\/\/api\.example\.test\/tails\/air_1\?v=abc"/);
  } finally { setLogoOrigin(''); }
});

await test('hub markers carry the tail and redraw when it changes', async () => {
  assert.match(read('../src/components/RouteMap.jsx'), /state\.customLogo, state\.customTail, state\.airlineName\]\);/, 'the map memo re-keys on a new upload');
  const who = { airlineName: 'A', logoId: 'star', livery: { tailDesign: 'solid' } };
  const a = hubFinMarkup(who), b = hubFinMarkup({ ...who, customTail: '/tails/a?v=1' });
  assert.notEqual(a.key, b.key);
  await b.load([1]);
  assert.match(b.html(2), /<image href="\/tails\/a\?v=1"/);
  assert.doesNotMatch(a.html(2), /<image/);
});

await test('the upload is shrunk to the fin\'s proportions, under the server\'s size budget', () => {
  assert.equal(typeof img.fileToTailDataURL, 'function');
  assert.ok(Math.abs(img.TAIL_W / img.TAIL_H - TF.FIN_ASPECT) * img.TAIL_H < 1, 'within a pixel of the fin aspect');
  const guard = read('../apps/headwinds-server/src/lib/decisionGuard.mjs').match(/LOGO_DATAURL_MAX_CHARS = ([\d_]+)/)[1];
  assert.equal(img.TAIL_DATAURL_MAX_CHARS, Number(guard.replaceAll('_', '')));
  assert.match(img.TAIL_UPLOAD_HINT, /nose to the right/);
  const src = read('../src/utils/logoImage.js');
  assert.match(src, /\['image\/webp', 0\.9\], \['image\/png'\], \['image\/jpeg'/, 'webp first (alpha, small), png, then jpeg');
});

await test('the template is the fin outline at the upload size', () => {
  const svg = TF.tailTemplateSVG(img.TAIL_W, img.TAIL_H);
  assert.match(svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${img.TAIL_W}" height="${img.TAIL_H}" viewBox="0 0 1291 1000">`));
  assert.ok(svg.includes(`d="${TF.FIN_PATH}"`));
  assert.match(svg, /nose →/);
});

console.log('\n── the logo maker and the screens ──');

await test('logo maker: an Upload tile with the template link; with an upload, it is selected and can be removed', async () => {
  const BrandingModal = (await import('../src/components/BrandingModal.jsx')).default;
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  const render = () => strip(renderToString(React.createElement(GameProvider, null, React.createElement(BrandingModal, { onClose() {} }))));
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', airlineName: 'Fin Air', logoId: 'eagle', livery: { tailDesign: 'swoosh' } }));
  const plain = render();
  assert.match(plain, /aria-checked="false" data-tail-design="upload"/);
  assert.match(plain, /aria-checked="true" data-tail-design="swoosh"/);
  assert.match(plain, /<input type="file" accept="image\/\*" data-tail-file/);
  assert.match(plain, /download="tail-template\.svg" data-tail-template/);
  assert.match(plain, /data-tail-swatch="cheatline"/, 'design colour offered for a designed tail');
  assert.doesNotMatch(plain, /data-tail-remove/);
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', airlineName: 'Fin Air', logoId: 'eagle', livery: { tailDesign: 'swoosh' }, customTail: TAIL }));
  const up = render();
  assert.match(up, /aria-checked="true" data-tail-design="upload"/);
  assert.match(up, /aria-checked="false" data-tail-design="swoosh"/, 'the design tiles step aside');
  assert.match(up, /aria-label="Fin Air tail"[^>]*data-tail-design="custom"/, 'the big preview shows the upload');
  assert.match(up, /data-tail-remove/);
  assert.doesNotMatch(up, /data-tail-swatch="cheatline"/, 'no design colour for an upload');
  assert.doesNotMatch(up, /data-tail-logo/, 'no logo toggles for an upload');
  assert.match(up, /data-tail-swatch="tail"/, 'the tail colour still shows through clear areas');
});

await test('the branding modal sends the tail only when it changed', () => {
  const src = read('../src/components/BrandingModal.jsx');
  assert.match(src, /useState\(state\.customTail \?\? null\)/);
  assert.match(src, /\.\.\.\(customTail !== \(state\.customTail \?\? null\) \? \{ customTail \} : \{\}\),/);
  assert.match(src, /tail=\{customTail\}\s+onTail=\{setCustomTail\}/);
});

await test('season podium and player profile draw an uploaded tail from the payload URL', async () => {
  const SeasonResults = (await import('../apps/headwinds-web/src/SeasonResults.jsx')).default;
  const html = strip(renderToString(React.createElement(SeasonResults, {
    worldId: 'w', token: null, myAirlineId: null, me: null,
    preloaded: { ranking: { metric: 'avgProfit' }, seasonAwards: null, standings: [
      { rank: 1, id: 'a1', name: 'Gold Air', logoId: 'eagle', livery: { tailDesign: 'split' }, customTail: '/tails/a1?v=abc' },
      { rank: 2, id: 'a2', name: 'Silver Air', logoId: 'star', livery: null },
    ] },
  })));
  assert.match(html, /aria-label="Gold Air tail"[^>]*data-tail-design="custom"/);
  assert.match(html, /<image href="\/tails\/a1\?v=abc"/);
  assert.match(html, /aria-label="Silver Air tail"[^>]*data-tail-design="solid"/);
  assert.match(read('../apps/headwinds-web/src/PlayerProfile.jsx'), /<TailFin livery=\{c\.livery\} logo=\{logoOf\(c\)\} tail=\{tailOf\(c\)\} height=\{40\}/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
