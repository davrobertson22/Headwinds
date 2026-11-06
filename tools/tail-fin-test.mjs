// Tail fins (2026-11-05): an airline's mark on a fin in its livery colours,
// designed in the logo maker (Edit Branding → Name & logo → Tail Fin: shape and
// paint style, saved on the livery as finShape / finStyle) and drawn where a
// shape reads — your hubs on the network map (flat and globe), each rival's
// hubs on the Rivals map, the season podium and the player profile. Small
// list rows keep the square logo.
//
//   · engine data/livery.js — finShape / finStyle normalise like every other
//     livery field (unknown → default), so the decision guard and SET_BRANDING
//     carry them with no change of their own
//   · TailFin (SSR) — one outline per shape, the stripe / two-tone paint, the
//     mark recoloured to read on the tail, an upload drawn on its tile
//   · utils/hubFin.js — lazy markup (never rendered during a render), unique
//     clip ids per map, a key that changes with the look
//   · BrandingModal, SeasonResults, PlayerProfile (SSR); the maps' wiring
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
const { hubFinMarkup, hubFinSize, logoOf } = await import('../src/utils/hubFin.js');
const { markColorOn } = await import('../src/utils/logoBranding.js');

console.log('\nTail fins\n');

await test('livery: fin shape and paint normalise, unknown → the defaults', () => {
  assert.deepEqual(L.FIN_SHAPES, ['swept', 'tall', 'retro', 't-tail']);
  assert.deepEqual(L.FIN_STYLES, ['solid', 'stripe', 'split']);
  const d = L.normalizeLivery({});
  assert.equal(d.finShape, 'swept');
  assert.equal(d.finStyle, 'solid');
  const l = L.normalizeLivery({ finShape: 't-tail', finStyle: 'split' });
  assert.equal(l.finShape, 't-tail');
  assert.equal(l.finStyle, 'split');
  const bad = L.normalizeLivery({ finShape: '<script>', finStyle: 42 });
  assert.equal(bad.finShape, 'swept');
  assert.equal(bad.finStyle, 'solid');
});

await test('SET_BRANDING keeps the fin on the saved livery (no reducer change needed)', async () => {
  const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Fin Air', hub: 'SYD', enableObjectives: false });
  s = gameReducer(s, { type: 'SET_BRANDING', airlineName: 'Fin Air', logoId: 'eagle', logoColor: '#d71920',
    livery: { tail: '#d71920', finShape: 'retro', finStyle: 'stripe' } });
  assert.equal(s.livery.finShape, 'retro');
  assert.equal(s.livery.finStyle, 'stripe');
});

const fin = (livery, logo = { id: 'eagle', accentColor: '#d71920' }) =>
  strip(renderToStaticMarkup(React.createElement(TailFin, { livery, logo, size: 44, idPrefix: 'x' })));

await test('every shape draws its own outline; the T-tail adds its stabiliser', () => {
  const outlines = new Set();
  for (const finShape of L.FIN_SHAPES) {
    const html = fin({ tail: '#1e9bff', finShape });
    const d = html.match(/<clipPath id="fin-x"><path d="([^"]+)"/)[1];
    outlines.add(d);
  }
  assert.equal(outlines.size, 4);
  const t = fin({ tail: '#1e9bff', finShape: 't-tail' });
  assert.equal((t.match(/fill="#1e9bff"/g) ?? []).length >= 2, true, 'fin + stabiliser in the tail colour');
});

await test('paint styles: solid, a stripe and a two-tone in the second colour', () => {
  assert.doesNotMatch(fin({ tail: '#1e9bff', cheatline: '#ffcc00', finStyle: 'solid' }), /<polygon/);
  assert.match(fin({ tail: '#1e9bff', cheatline: '#ffcc00', finStyle: 'stripe' }), /<polygon points="0,38 40,26 40,31 0,43" fill="#ffcc00"/);
  assert.match(fin({ tail: '#1e9bff', cheatline: '#ffcc00', finStyle: 'split' }), /<polygon points="0,41 40,28 40,44 0,44" fill="#ffcc00"/);
  // Default livery paints tail and cheatline alike: the style falls back to
  // the fuselage colour so it still shows.
  assert.match(fin({ tail: '#1e9bff', cheatline: '#1e9bff', fuselage: '#f5f7fa', finStyle: 'stripe' }), /fill="#f5f7fa"/);
});

await test('the mark is recoloured to read on the tail; an upload sits on its tile', () => {
  const red = fin({ tail: '#d71920' }, { id: 'eagle', accentColor: '#d71920' });
  const expected = markColorOn('#d71920', '#d71920');
  assert.notEqual(expected, '#d71920', 'fixture: a red mark on a red tail must change');
  assert.match(red, new RegExp(`stroke="${expected}"`));
  const up = fin({ tail: '#0a2a66' }, { id: null, customSrc: 'data:image/png;base64,AAAA' });
  assert.match(up, /<image[^>]+href="data:image\/png;base64,AAAA"/);
  const off = fin({ tail: '#0a2a66', logoOnTail: false }, { id: 'eagle', accentColor: '#fff' });
  assert.doesNotMatch(off, /<svg[^>]*><svg/, 'no logo on the tail → no mark');
});

await test('hub markup is lazy, sized by tier, keyed on the look, unique per map', () => {
  const a = hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#ff0000' }, 'own');
  const b = hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#00ff00' }, 'own');
  assert.notEqual(a.key, b.key, 'a new colour redraws the pins');
  assert.equal(a.key, hubFinMarkup({ airlineName: 'A', logoId: 'star', logoColor: '#ff0000' }, 'own').key);
  assert.equal(typeof a.html, 'function', 'nothing rendered until a map effect asks');
  assert.match(a.html(3), new RegExp(`height="${hubFinSize(3)}"`));
  assert.ok(hubFinSize(3) > hubFinSize(0));
  const r = hubFinMarkup({ name: 'R', logoId: 'jade' }, 'rival-human:r1~g2');
  assert.match(r.html(1), /clipPath id="fin-rival-humanr1g2-t1"/, 'ids safe and distinct from your own');
  assert.match(a.html(1), /clipPath id="fin-own-t1"/);
  assert.deepEqual(logoOf({ customLogo: '/logos/x?v=1', logoId: 'star' }).id, null);
});

await test('the maps call html() only inside effects, never while rendering', () => {
  const flat = read('../src/components/RouteMap.jsx');
  assert.match(flat, /const hubFin = useMemo\(\(\) => hubFinMarkup\(state, 'own'\)/);
  assert.match(flat, /html: hubFin\.html\(hubInfo\.tier \?\? 1\)/);
  assert.match(flat, /#fin:\$\{hubFin\.key\}/, 'a new fin look redraws the pins');
  assert.match(read('../src/components/GlobeMap.jsx'), /el\.innerHTML = hubFin\.html\(tier\);/);
  assert.match(read('../src/components/RivalRouteMap.jsx'), /html: hubFin\.html\(1\)/);
  assert.equal((read('../src/components/Competition.jsx').match(/hubFin=\{hubFinMarkup\(carrier, `rival-\$\{carrier\.id\}`\)\}/g) ?? []).length, 2);
});

await test('RouteMap still server-renders with your fin wired in', async () => {
  const RouteMap = (await import('../src/components/RouteMap.jsx')).default;
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', hub: 'SYD', hubs: { SYD: { tier: 2 } }, livery: { finShape: 'retro' } }));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap)));
  assert.ok(html.length > 0);
});

await test('logo maker: a Tail Fin section with every shape and paint, previewed live', async () => {
  const BrandingModal = (await import('../src/components/BrandingModal.jsx')).default;
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', airlineName: 'Fin Air', logoId: 'eagle', logoColor: '#d71920', livery: { finShape: 'tall', finStyle: 'split' } }));
  const html = strip(renderToString(React.createElement(GameProvider, null, React.createElement(BrandingModal, { onClose() {} }))));
  assert.match(html, />Tail Fin</);
  for (const s of L.FIN_SHAPES) assert.match(html, new RegExp(`data-fin-shape="${s}"`));
  for (const s of L.FIN_STYLES) assert.match(html, new RegExp(`data-fin-style="${s}"`));
  assert.match(html, /aria-checked="true" data-fin-shape="tall"/, 'the saved shape is selected');
  assert.match(html, /aria-checked="true" data-fin-style="split"/);
  assert.match(html, /aria-label="Your tail fin"/);
});

await test('season podium: each finisher on their fin; the standings payload carries the livery', async () => {
  const SeasonResults = (await import('../apps/headwinds-web/src/SeasonResults.jsx')).default;
  const html = strip(renderToString(React.createElement(SeasonResults, {
    worldId: 'w', token: null, myAirlineId: null, me: null,
    preloaded: { ranking: { metric: 'avgProfit' }, seasonAwards: null, standings: [
      { rank: 1, id: 'a1', name: 'Gold Air', logoId: 'eagle', logoColor: '#d71920', livery: { tail: '#d71920', finShape: 't-tail' } },
      { rank: 2, id: 'a2', name: 'Silver Air', logoId: 'star', logoColor: '#1e9bff', livery: null },
    ] },
  })));
  assert.match(html, /aria-label="Gold Air tail fin"/);
  assert.match(html, /aria-label="Silver Air tail fin"/);
  const worlds = read('../apps/headwinds-server/src/routes/worlds.mjs');
  assert.match(worlds, /COALESCE\(a\."rivalState", a\.state\)->'livery'\s+AS livery/);
  assert.match(worlds, /livery: a\.livery \?\? null,/);
});

await test('player profile: each airline flying now shows its fin', async () => {
  const players = read('../apps/headwinds-server/src/routes/players.mjs');
  assert.match(players, /COALESCE\(a\."rivalState", a\.state\)->'livery'\s+AS livery/);
  assert.match(players, /customLogo: logoPathOf\(a\.id, b\.logoHash\), livery: b\.livery \?\? null/);
  assert.match(read('../apps/headwinds-web/src/PlayerProfile.jsx'), /<TailFin livery=\{c\.livery\} logo=\{logoOf\(c\)\} size=\{36\}/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
