// Tail logos (2026-11-06): an airline's tail is the flat fin silhouette the
// airline-tail charts use — measured off the chart Dave sent (a trapezoid,
// nose to the right, 1.291 wide for 1 tall; TailFin.jsx FIN_PATH) — in the
// livery's tail colour, with the logo big on the fin and one of TAIL_DESIGNS
// in the accent colour. Designed in the logo maker's Tail section; shown over
// your hubs on the maps, each rival's hubs on the Rivals map, the season
// podium and the player profile. Small list rows keep the square logo.
//
// Dave rejected four earlier versions (two hand-drawn fin shapes, a shaded
// crop of the template, the template's traced fin cut at the crown) and sent
// the chart: flat, big logo, no shading, that silhouette. The bar is that chart.
//
//   node --import ./tools/_register-loader.mjs tools/tail-fin-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';

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

const L = await import('../packages/engine/src/data/livery.js');
const TailFin = (await import('../src/components/TailFin.jsx')).default;
const { hubFinMarkup, hubFinSize, logoOf, tailAspect } = await import('../src/utils/hubFin.js');
const { markColorOn } = await import('../src/utils/logoBranding.js');
const TF = await import('../src/components/TailFin.jsx');
const await_ = () => TF;

console.log('\nTail logos\n');

await test('the silhouette is the chart\'s: a 1.291:1 trapezoid, nose right, straight leading edge, short tip', () => {
  const { FIN_W, FIN_H, FIN_ASPECT, FIN_PATH } = await_(import('../src/components/TailFin.jsx'));
  assert.equal(FIN_ASPECT, FIN_W / FIN_H);
  assert.ok(Math.abs(FIN_ASPECT - 1.291) < 0.001);
  assert.match(FIN_PATH, /^M405 1000 /, 'the trailing edge leans aft 0.405 from base to tip');
  assert.match(FIN_PATH, / L1291 1000 Z$/, 'one straight leading edge from the tip to the base\'s right corner');
  assert.equal(tailAspect(), FIN_ASPECT);
  assert.doesNotMatch(read('../packages/engine/src/data/liveryTemplates.js'), /outline|finOutlineOf|tailCropOf/, 'no per-template fin: one chart shape');
});

await test('the livery carries tailDesign (and no drawn-fin fields)', () => {
  assert.deepEqual(L.TAIL_DESIGNS, ['solid', 'stripe', 'stripes', 'swoosh', 'split']);
  assert.equal(L.normalizeLivery({}).tailDesign, 'solid');
  assert.equal(L.normalizeLivery({ tailDesign: 'swoosh' }).tailDesign, 'swoosh');
  assert.equal(L.normalizeLivery({ tailDesign: '<x>' }).tailDesign, 'solid');
  assert.notEqual(L.liveryKey({ tailDesign: 'swoosh' }), L.liveryKey({ tailDesign: 'solid' }), 'a new design is a new look');
  assert.doesNotMatch(read('../packages/engine/src/data/livery.js'), /finShape|FIN_SHAPES/);
});

await test('SET_BRANDING keeps the design on the saved livery (no reducer change needed)', async () => {
  const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Fin Air', hub: 'SYD', enableObjectives: false });
  s = gameReducer(s, { type: 'SET_BRANDING', airlineName: 'Fin Air', logoId: 'eagle', logoColor: '#d71920', livery: { tail: '#d71920', tailDesign: 'stripes' } });
  assert.equal(s.livery.tailDesign, 'stripes');
});

const fin = (livery, logo = { id: 'eagle', accentColor: '#d71920' }, extra = {}) =>
  strip(renderToStaticMarkup(React.createElement(TailFin, { livery, logo, height: 60, idPrefix: 'x', ...extra })));

await test('TailFin: a flat silhouette clipped to the chart shape, in the tail colour, at the fin\'s aspect', () => {
  const html = fin({ tail: '#0a2a66' });
  assert.match(html, /<clipPath id="fin-x"><path d="M405 1000 /);
  assert.match(html, /<rect x="0" y="0" width="\d+" height="\d+" fill="#0a2a66"/);
  assert.match(html, new RegExp(`width="${Math.round(60 * TF.FIN_ASPECT)}" height="60"`));
  assert.doesNotMatch(html, /<image|<canvas|Gradient|filter=/, 'flat: no artwork, no shading');
  assert.match(html, /data-tail-design="solid"/);
});

await test('designs draw in the accent colour (the fuselage colour when the accent IS the tail colour)', () => {
  assert.doesNotMatch(fin({ tail: '#0a2a66', cheatline: '#ffcc00', tailDesign: 'solid' }), /#ffcc00/);
  assert.match(fin({ tail: '#0a2a66', cheatline: '#ffcc00', tailDesign: 'stripe' }), /<polygon points="[^"]+" fill="#ffcc00"/);
  assert.match(fin({ tail: '#0a2a66', cheatline: '#ffcc00', tailDesign: 'swoosh' }), /<path d="M0 [^"]+" fill="#ffcc00"/);
  assert.match(fin({ tail: '#0a2a66', cheatline: '#ffcc00', tailDesign: 'split' }), /<polygon points="[^"]+" fill="#ffcc00"/);
  const three = fin({ tail: '#0a2a66', cheatline: '#ffcc00', fuselage: '#ffffff', tailDesign: 'stripes' });
  assert.equal((three.match(/fill="#ffcc00"/g) ?? []).length, 2);
  assert.equal((three.match(/fill="#ffffff"/g) ?? []).length, 1);
  assert.match(fin({ tail: '#1e9bff', cheatline: '#1e9bff', fuselage: '#f5f7fa', tailDesign: 'swoosh' }), /fill="#f5f7fa"/, 'default livery: the design still shows');
});

await test('the striped designs carry no logo (a band the length of the fin leaves no clear paint), the others do', () => {
  assert.deepEqual([...TF.LOGO_FREE_DESIGNS].sort(), ['stripe', 'stripes']);
  for (const d of ['solid', 'swoosh', 'split']) assert.match(fin({ tail: '#0a2a66', tailDesign: d }), /<g transform="translate[^>]*><svg/, d);
  for (const d of ['stripe', 'stripes']) assert.doesNotMatch(fin({ tail: '#0a2a66', tailDesign: d }), /<g transform="translate[^>]*><svg/, d);
});

await test('the logo is recoloured to read on the tail; an upload sits on its tile; off when the livery says so', () => {
  const red = fin({ tail: '#d71920' }, { id: 'eagle', accentColor: '#d71920' });
  const expected = markColorOn('#d71920', '#d71920');
  assert.notEqual(expected, '#d71920');
  assert.match(red, new RegExp(`stroke="${expected}"`));
  assert.match(fin({ tail: '#0a2a66' }, { id: null, customSrc: 'data:image/png;base64,AAAA' }), /<image[^>]+href="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(fin({ tail: '#0a2a66', logoOnTail: false }), /<g transform="translate[^>]*><svg/, 'no logo on the tail → no mark');
});

await test('hub markup: sized by tier, keyed on the look, unique clip ids, rendered on demand', async () => {
  const a = hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#ff0000', livery: { tailDesign: 'swoosh' } });
  const b = hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#ff0000', livery: { tailDesign: 'solid' } });
  assert.notEqual(a.key, b.key);
  assert.equal(await a.load([1]), true, 'nothing to decode: ready at once');
  assert.match(a.html(3), new RegExp(`height="${hubFinSize(3)}"`));
  assert.match(a.html(3), new RegExp(`clipPath id="fin-hub-${a.key}-t3"`));
  assert.ok(hubFinSize(3) > hubFinSize(0));
  assert.deepEqual(logoOf({ customLogo: '/logos/x?v=1', logoId: 'star' }).id, null);
});

await test('the maps render tails in their own effects after load(), never during a render', () => {
  const flat = read('../src/components/RouteMap.jsx');
  assert.match(flat, /const hubFin = useMemo\(\(\) => hubFinMarkup\(state\)/);
  assert.match(flat, /await hubFin\.load\(/);
  assert.match(flat, /const html = hubFin\.html\(tier\);\s*if \(!html\) continue;/);
  assert.match(read('../src/components/GlobeMap.jsx'), /if \(hubFin\) await hubFin\.load\(/);
  assert.match(read('../src/components/RivalRouteMap.jsx'), /await hubFin\.load\(\[1\]\);/);
  assert.equal((read('../src/components/Competition.jsx').match(/hubFin=\{hubFinMarkup\(carrier\)\}/g) ?? []).length, 2);
});

await test('RouteMap still server-renders with the tail wired in', async () => {
  const RouteMap = (await import('../src/components/RouteMap.jsx')).default;
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', hub: 'SYD', hubs: { SYD: { tier: 2 } } }));
  assert.ok(renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap))).length > 0);
});

await test('logo maker: a Tail section with every design as a live tile, tail + design colours, logo toggles', async () => {
  const BrandingModal = (await import('../src/components/BrandingModal.jsx')).default;
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  const { LIVERY_PALETTE } = await import('../src/components/LiveryEditor.jsx');
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', airlineName: 'Fin Air', logoId: 'eagle', logoColor: '#d71920',
    livery: { tail: LIVERY_PALETTE[4].hex, cheatline: LIVERY_PALETTE[6].hex, tailDesign: 'swoosh', logoTile: true } }));
  const html = strip(renderToString(React.createElement(GameProvider, null, React.createElement(BrandingModal, { onClose() {} }))));
  assert.match(html, /<label class="form-label">Tail<\/label>/);
  assert.match(html, /aria-label="Fin Air tail"/);
  for (const d of L.TAIL_DESIGNS) assert.match(html, new RegExp(`data-tail-design="${d}"`));
  assert.match(html, /aria-checked="true" data-tail-design="swoosh"/, 'the saved design is selected');
  assert.match(html, new RegExp(`aria-checked="true" title="[^"]+" data-tail-swatch="tail" data-tail-colour="${LIVERY_PALETTE[4].hex}"`));
  assert.match(html, new RegExp(`aria-checked="true" title="[^"]+" data-tail-swatch="cheatline" data-tail-colour="${LIVERY_PALETTE[6].hex}"`));
  assert.match(html, /aria-pressed="true" data-tail-logo/);
  assert.match(html, /aria-pressed="true" data-tail-tile/);
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', airlineName: 'Fin Air', logoId: 'eagle', livery: { tailDesign: 'stripe' } }));
  const striped = strip(renderToString(React.createElement(GameProvider, null, React.createElement(BrandingModal, { onClose() {} }))));
  assert.match(striped, /data-tail-logo="true" disabled=""/, 'no logo on a striped tail');
  assert.match(striped, /the stripes carry this tail/);
});

await test('season podium and player profile show each airline\'s tail; the payloads carry the livery', async () => {
  const SeasonResults = (await import('../apps/headwinds-web/src/SeasonResults.jsx')).default;
  const html = strip(renderToString(React.createElement(SeasonResults, {
    worldId: 'w', token: null, myAirlineId: null, me: null,
    preloaded: { ranking: { metric: 'avgProfit' }, seasonAwards: null, standings: [
      { rank: 1, id: 'a1', name: 'Gold Air', logoId: 'eagle', logoColor: '#d71920', livery: { tail: '#d71920', tailDesign: 'split' } },
      { rank: 2, id: 'a2', name: 'Silver Air', logoId: 'star', logoColor: '#1e9bff', livery: null },
    ] },
  })));
  assert.match(html, /aria-label="Gold Air tail"[^>]*data-tail-design="split"/);
  assert.match(html, /aria-label="Silver Air tail"/);
  assert.match(read('../apps/headwinds-server/src/routes/worlds.mjs'), /COALESCE\(a\."rivalState", a\.state\)->'livery'\s+AS livery/);
  assert.match(read('../apps/headwinds-server/src/routes/players.mjs'), /customLogo: logoPathOf\(a\.id, b\.logoHash\), livery: b\.livery \?\? null/);
  assert.match(read('../apps/headwinds-web/src/PlayerProfile.jsx'), /<TailFin livery=\{c\.livery\} logo=\{logoOf\(c\)\} tail=\{tailOf\(c\)\} height=\{40\}/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
