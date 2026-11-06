// Tails (2026-11-06): an airline's tail is the licensed template's tail crop
// — fin, stabiliser, rear fuselage — painted in its livery with its logo on
// the fin (TailFin.jsx, utils/liveryPaint.js paintTail), the same paint as
// the Fleet page. Drawn where a tail reads: your hubs on the maps (flat and
// globe), each rival's hubs on the Rivals map, the season podium, the player
// profile, and the logo maker's Tail section (tail colour, logo on the fin,
// on its tile). Small list rows keep the square logo. Dave rejected two
// rounds of hand-drawn fin shapes before this: the bar is type-accurate art.
//
// Painting needs a browser canvas, so this covers the pure parts (the crop,
// the sizes, the marker contract) and server-renders the real components;
// the paint itself is checked by eye in a browser.
//
//   node --import ./tools/_register-loader.mjs tools/tail-fin-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (h) => h.replaceAll('<!-- -->', '');
const store = new Map();
globalThis.window = globalThis.window ?? {};
window.dispatchEvent = () => true; window.addEventListener = () => {}; window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
window.localStorage = globalThis.localStorage;

const T = await import('../packages/engine/src/data/liveryTemplates.js');
const L = await import('../packages/engine/src/data/livery.js');
const TailFin = (await import('../src/components/TailFin.jsx')).default;
const { hubFinMarkup, hubFinSize, logoOf, tailAspect } = await import('../src/utils/hubFin.js');

console.log('\nTails\n');

await test('the template carries a tail crop inside its own space, fin and stabiliser included', () => {
  const spec = T.getLiveryTemplate(T.DEFAULT_LIVERY_TEMPLATE);
  const c = T.tailCropOf(spec);
  assert.ok(c.x0 >= 0 && c.x0 + c.w <= spec.size[0] && c.y0 >= 0 && c.y0 + c.h <= spec.size[1], 'inside the template');
  assert.ok(c.x0 <= spec.logo.cx - spec.logo.size / 2, 'the fin logo box is in the crop');
  // The fin part is a mask rectangle that starts well forward of the fin's
  // real root (the painter only recolours opaque pixels inside it), so the
  // crop need only reach the fin's logo box; the stabiliser polygon is tight.
  for (const poly of spec.parts.stab) for (const [x, y] of poly) assert.ok(x >= c.x0 && y <= c.y0 + c.h, 'the stabiliser is in the crop');
  assert.ok(c.aspect > 0.8 && c.aspect < 1.3, `a near-square crop (${c.aspect.toFixed(2)})`);
  // The fin-only crop (the maps' markers): the fin alone, cut above the stabiliser.
  const f = T.tailCropOf(spec, 'fin');
  assert.ok(f.x0 >= c.x0 && f.h < c.h, 'inside the tail crop');
  const stabTop = Math.min(...spec.parts.stab.flat().map(([, y]) => y));
  assert.ok(f.y0 + f.h <= stabTop, 'no stabiliser in the fin crop');
  assert.ok(f.x0 <= spec.logo.cx - spec.logo.size / 2, 'the fin logo box is in it');
  assert.equal(tailAspect(), f.aspect, 'hub markers use the fin crop');
  // A template with no crop falls back to its aft quarter.
  const fb = T.tailCropOf({ size: [1000, 300] });
  assert.deepEqual([fb.x0, fb.w, fb.h], [720, 280, 300]);
  const ff = T.tailCropOf({ size: [1000, 300], body: { crown: 180 } }, 'fin');
  assert.deepEqual([ff.x0, ff.w, ff.h], [780, 220, 180]);
});

await test('the livery carries no drawn-fin fields any more', () => {
  const l = L.normalizeLivery({ finShape: 'retro', finStyle: 'stripe' });
  assert.equal('finShape' in l, false);
  assert.equal('finStyle' in l, false);
  assert.doesNotMatch(read('../packages/engine/src/data/livery.js'), /FIN_SHAPES|finShape/);
});

await test('paintTail scales the airframe so the crop is the asked height, then cuts it out', () => {
  const src = read('../src/utils/liveryPaint.js');
  assert.match(src, /export function paintTail\(template, liveryIn, \{ height = 48, logo = null, crop: which = 'tail' \} = \{\}\)/);
  assert.match(src, /const s = height \/ crop\.h;/);
  assert.match(src, /paintLivery\(template, liveryIn, \{ width: template\.spec\.size\[0\] \* s, titles: '', logo, bodyLogo: null \}\)/);
  assert.match(src, /drawImage\(full, Math\.round\(crop\.x0 \* s\), Math\.round\(crop\.y0 \* s\), w, h, 0, 0, w, h\)/);
});

await test('TailFin (SSR): an empty canvas of the crop\'s aspect, painted on the client', () => {
  const html = strip(renderToString(React.createElement(TailFin, { livery: { tail: '#d71920' }, logo: { id: 'eagle', accentColor: '#d71920' }, height: 100, title: 'Southern Cross tail' })));
  assert.match(html, /<canvas[^>]*data-tail-template="b737-800"/);
  assert.match(html, /data-ready="0"/);
  assert.match(html, /data-tail-crop="tail"/);
  const fin = strip(renderToString(React.createElement(TailFin, { livery: { tail: '#d71920' }, height: 30, crop: 'fin' })));
  assert.match(fin, /data-tail-crop="fin"/);
  assert.equal(Number(fin.match(/width:(\d+)px/)[1]), Math.round(30 * T.tailCropOf(T.getLiveryTemplate('b737-800'), 'fin').aspect));
  assert.match(html, /aria-label="Southern Cross tail"/);
  const w = Number(html.match(/width:(\d+)px/)[1]);
  assert.equal(w, Math.round(100 * T.tailCropOf(T.getLiveryTemplate('b737-800'), 'tail').aspect));
});

await test('hub markup: sized by tier, keyed on the look, nothing until load() has painted', async () => {
  const a = hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#ff0000' });
  const b = hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#00ff00' });
  assert.notEqual(a.key, b.key, 'a new colour is a new look');
  assert.equal(a.key, hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#ff0000' }).key);
  assert.equal(a.html(1), '', 'no paint yet → no markup (the pin alone)');
  assert.equal(await a.load([1]), false, 'no document here → nothing painted, no throw');
  assert.match(read('../src/utils/hubFin.js'), /crop: 'fin'/, 'markers paint the fin alone');
  assert.ok(hubFinSize(3) > hubFinSize(0));
  assert.deepEqual(logoOf({ customLogo: '/logos/x?v=1', logoId: 'star' }).id, null);
});

await test('the maps paint tails in their own effects, after load(), never inside the pin sync', () => {
  const flat = read('../src/components/RouteMap.jsx');
  assert.match(flat, /const hubFin = useMemo\(\(\) => hubFinMarkup\(state\)/);
  assert.match(flat, /await hubFin\.load\(/);
  assert.match(flat, /const html = hubFin\.html\(tier\);\s*if \(!html\) continue;/);
  assert.doesNotMatch(flat, /#fin:/, 'the pin draw key no longer waits on the tail');
  const globe = read('../src/components/GlobeMap.jsx');
  assert.match(globe, /if \(hubFin\) await hubFin\.load\(/);
  assert.match(globe, /if \(cancelled \|\| mapRef\.current !== map\) return;/);
  const rival = read('../src/components/RivalRouteMap.jsx');
  assert.match(rival, /await hubFin\.load\(\[1\]\);/);
  assert.equal((read('../src/components/Competition.jsx').match(/hubFin=\{hubFinMarkup\(carrier\)\}/g) ?? []).length, 2);
});

await test('RouteMap still server-renders with the tail wired in', async () => {
  const RouteMap = (await import('../src/components/RouteMap.jsx')).default;
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', hub: 'SYD', hubs: { SYD: { tier: 2 } } }));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap)));
  assert.ok(html.length > 0);
});

await test('logo maker: a Tail section with the live tail, tail colours, logo-on-fin and tile toggles', async () => {
  const BrandingModal = (await import('../src/components/BrandingModal.jsx')).default;
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  const { LIVERY_PALETTE } = await import('../src/components/LiveryEditor.jsx');
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', airlineName: 'Fin Air', logoId: 'eagle', logoColor: '#d71920', livery: { tail: LIVERY_PALETTE[4].hex, logoTile: true } }));
  const html = strip(renderToString(React.createElement(GameProvider, null, React.createElement(BrandingModal, { onClose() {} }))));
  assert.match(html, /<label class="form-label">Tail<\/label>/);
  assert.match(html, /aria-label="Fin Air tail"/);
  for (const c of LIVERY_PALETTE) assert.match(html, new RegExp(`data-tail-colour="${c.hex}"`));
  assert.match(html, new RegExp(`aria-checked="true" title="[^"]+" data-tail-colour="${LIVERY_PALETTE[4].hex}"`), 'the saved tail colour is selected');
  assert.match(html, /aria-pressed="true" data-tail-logo/);
  assert.match(html, /aria-pressed="true" data-tail-tile/);
  assert.match(html, /Aircraft artwork by Norebbo/);
});

await test('season podium and player profile show each airline\'s tail; the payloads carry the livery', async () => {
  const SeasonResults = (await import('../apps/headwinds-web/src/SeasonResults.jsx')).default;
  const html = strip(renderToString(React.createElement(SeasonResults, {
    worldId: 'w', token: null, myAirlineId: null, me: null,
    preloaded: { ranking: { metric: 'avgProfit' }, seasonAwards: null, standings: [
      { rank: 1, id: 'a1', name: 'Gold Air', logoId: 'eagle', logoColor: '#d71920', livery: { tail: '#d71920' } },
      { rank: 2, id: 'a2', name: 'Silver Air', logoId: 'star', logoColor: '#1e9bff', livery: null },
    ] },
  })));
  assert.match(html, /aria-label="Gold Air tail"/);
  assert.match(html, /aria-label="Silver Air tail"/);
  assert.match(read('../apps/headwinds-server/src/routes/worlds.mjs'), /COALESCE\(a\."rivalState", a\.state\)->'livery'\s+AS livery/);
  assert.match(read('../apps/headwinds-server/src/routes/worlds.mjs'), /livery: a\.livery \?\? null,/);
  assert.match(read('../apps/headwinds-server/src/routes/players.mjs'), /customLogo: logoPathOf\(a\.id, b\.logoHash\), livery: b\.livery \?\? null/);
  assert.match(read('../apps/headwinds-web/src/PlayerProfile.jsx'), /<TailFin livery=\{c\.livery\} logo=\{logoOf\(c\)\} height=\{40\}/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
