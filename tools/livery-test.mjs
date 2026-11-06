// Airline liveries: the paint scheme (engine data/livery.js) through the
// reducer, the server guard, the rival projection and the screens.
//
//   node --import ./tools/_register-loader.mjs tools/livery-test.mjs
//
// Written failing on HEAD: before this change SET_BRANDING dropped `livery`
// on the floor in both the reducer and the guard, and no screen knew the word.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});
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

const L = await import('../packages/engine/src/data/livery.js');
const T = await import('../packages/engine/src/data/liveryTemplates.js');
const awaitedAircraft = await import('../packages/engine/src/data/aircraft.js');
const { AIRCRAFT_TYPES } = awaitedAircraft;
const { gameReducer, freshState, GameProvider } = await import('../src/store/GameContext.jsx');
const guard = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const rivals = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const BrandingModal = (await import('../src/components/BrandingModal.jsx')).default;
const LiveryPlane = (await import('../src/components/LiveryPlane.jsx')).default;
const Fleet = (await import('../src/components/Fleet.jsx')).default;

const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

console.log('\n── 1. Normalisation: every livery that leaves here is valid ─────────');

await test('a full livery passes through lowercased', () => {
  const l = L.normalizeLivery({ fuselage: '#F5F7FA', tail: '#C8102E', engines: '#f5f7fa', cheatline: '#c8102e', style: 'swoosh', titles: '#15202f', logoOnTail: false, logoOnFuselage: true, titlesOn: true });
  assert.deepEqual(l, { fuselage: '#f5f7fa', tail: '#c8102e', engines: '#f5f7fa', cheatline: '#c8102e', style: 'swoosh', titles: '#15202f', logoOnTail: false, logoOnFuselage: true, logoTile: false, titlesOn: true });
});
await test('bad colours fall back; the tail and stripe fall back to the accent', () => {
  const l = L.normalizeLivery({ fuselage: 'red', tail: 'url(javascript:1)', style: 'graffiti', engines: 12 }, '#ff8c00');
  assert.equal(l.fuselage, L.LIVERY_WHITE);
  assert.equal(l.tail, '#ff8c00');
  assert.equal(l.cheatline, '#ff8c00');
  assert.equal(l.style, 'none');
  assert.equal(l.engines, L.LIVERY_WHITE);
});
await test('short hex and missing # are accepted', () => {
  assert.equal(L.normalizeHex('#abc'), '#aabbcc');
  assert.equal(L.normalizeHex('C8102E'), '#c8102e');
  assert.equal(L.normalizeHex('#abcd'), null);
  assert.equal(L.normalizeHex(null), null);
});
await test('non-objects are not livery-shaped', () => {
  for (const v of [null, undefined, 'x', 3, [], true]) assert.equal(L.isLiveryShaped(v), false);
  assert.equal(L.isLiveryShaped({}), true);
});
await test('liveryFor derives the default from the logo colour when nothing is saved', () => {
  const l = L.liveryFor({ logoColor: '#1fbf6b' });
  assert.equal(l.tail, '#1fbf6b');
  assert.equal(l.fuselage, L.LIVERY_WHITE);
  assert.equal(l.style, 'none');
  assert.equal(L.liveryFor({ logoColor: 'nope' }).tail, L.DEFAULT_LIVERY.tail);
  assert.equal(L.liveryFor({ livery: { tail: '#000000' }, logoColor: '#1fbf6b' }).tail, '#000000');
});
await test('liveryKey is stable and complete', () => {
  const a = L.liveryKey({ tail: '#c8102e', style: 'belly' });
  const b = L.liveryKey({ style: 'belly', tail: '#C8102E' });
  assert.equal(a, b);
  assert.notEqual(a, L.liveryKey({ tail: '#c8102e', style: 'belly', titlesOn: false }));
});
await test('isDarkColor', () => {
  assert.equal(L.isDarkColor('#15202f'), true);
  assert.equal(L.isDarkColor('#f5f7fa'), false);
});

console.log('\n── 2. Reducer: SET_BRANDING carries the livery ──────────────────────');

const base = { ...freshState(), airlineName: 'Test Air', logoColor: '#ff8c00' };
await test('a livery is stored, normalised', () => {
  const next = gameReducer(base, { type: 'SET_BRANDING', livery: { fuselage: '#F5F7FA', tail: '#C8102E', style: 'swoosh', cheatline: 'junk' } });
  assert.deepEqual(next.livery, L.normalizeLivery({ fuselage: '#f5f7fa', tail: '#c8102e', style: 'swoosh' }, '#ff8c00'));
  assert.equal(next.livery.cheatline, '#ff8c00', 'bad stripe colour falls back to the (new) accent');
});
await test('a name-only rebrand leaves the livery alone', () => {
  const withL = gameReducer(base, { type: 'SET_BRANDING', livery: { tail: '#000000' } });
  const next = gameReducer(withL, { type: 'SET_BRANDING', airlineName: 'Renamed' });
  assert.equal(next.airlineName, 'Renamed');
  assert.deepEqual(next.livery, withL.livery);
});
await test('livery: null clears a saved scheme back to the derived default', () => {
  const withL = gameReducer(base, { type: 'SET_BRANDING', livery: { tail: '#000000' } });
  const next = gameReducer(withL, { type: 'SET_BRANDING', livery: null });
  assert.equal('livery' in next, false);
  assert.equal(L.liveryFor(next).tail, '#ff8c00');
});
await test('a non-object livery is ignored by the reducer (the guard refuses it upstream)', () => {
  const next = gameReducer(base, { type: 'SET_BRANDING', livery: 'swoosh' });
  assert.equal('livery' in next, false);
});
await test('freshState has no livery key (saves and the golden master unchanged)', () => {
  assert.equal('livery' in freshState(), false);
});

console.log('\n── 3. Server guard: forwards a valid livery, refuses junk ───────────');

await test('a livery object is forwarded normalised', () => {
  const out = guard.guardDecision('SET_BRANDING', { airlineName: 'Test Air', livery: { tail: '#C8102E', style: 'retro', fuselage: '<script>' } }, {});
  assert.equal(out.livery.tail, '#c8102e');
  assert.equal(out.livery.style, 'retro');
  assert.equal(out.livery.fuselage, L.LIVERY_WHITE);
  assert.deepEqual(Object.keys(out.livery).sort(), Object.keys(L.DEFAULT_LIVERY).sort(), 'exactly the known fields, nothing smuggled');
});
await test('the bad-colour fallback uses the logoColor in the same payload', () => {
  const out = guard.guardDecision('SET_BRANDING', { logoColor: '#1fbf6b', livery: { tail: 'nope' } }, {});
  assert.equal(out.livery.tail, '#1fbf6b');
});
await test('extra keys inside the livery are dropped', () => {
  const out = guard.guardDecision('SET_BRANDING', { livery: { tail: '#c8102e', image: 'data:image/png;base64,AAAA' } }, {});
  assert.equal('image' in out.livery, false);
});
await test('livery: null is forwarded (clear), absent stays absent', () => {
  assert.equal(guard.guardDecision('SET_BRANDING', { livery: null }, {}).livery, null);
  assert.equal('livery' in guard.guardDecision('SET_BRANDING', { airlineName: 'x' }, {}), false);
});
await test('a string / array / number livery is refused', () => {
  for (const v of ['swoosh', ['#c8102e'], 7, true]) {
    assert.throws(() => guard.guardDecision('SET_BRANDING', { livery: v }, {}), guard.GuardError);
  }
});

console.log('\n── 4. Rivals see it ───────────────────────────────────────────────');

const rowOf = (stateOver = {}) => ({
  id: 'air_diva', worldId: 'w1', name: 'Diva Down Airlines', hub: 'LAX', status: 'ACTIVE', restarts: 0, version: 3,
  state: { ...freshState(), airlineName: 'Diva Down Airlines', hub: 'LAX', logoId: 'horizon', logoColor: '#e0457b', ...stateOver },
  account: { isOG: false, isSupporter: false, email: null },
});
await test('a saved livery rides in the rival view; none → none (client derives from logoColor)', () => {
  const l = L.normalizeLivery({ tail: '#000000', style: 'belly' }, '#e0457b');
  assert.deepEqual(rivals.toHumanCompetitor(rowOf({ livery: l })).livery, l);
  assert.equal('livery' in rivals.toHumanCompetitor(rowOf()), false);
  assert.equal(L.liveryFor(rivals.toHumanCompetitor(rowOf())).tail, '#e0457b');
});
await test('the SQL twin projection keeps the livery', () => {
  const l = L.normalizeLivery({ tail: '#000000' });
  assert.deepEqual(rivals.projectRivalState({ ...freshState(), livery: l }).livery, l);
});

console.log('\n── 5. Templates: the licensed artwork specs are sane ────────────────');

await test('every template has the parts and landmarks the painter needs', () => {
  for (const tpl of Object.values(T.LIVERY_TEMPLATES)) {
    assert.ok(tpl.url.startsWith('/livery-'), `${tpl.id}: served from the brand overlay`);
    assert.ok(tpl.credit.includes('Norebbo'), `${tpl.id}: attribution`);
    const [W, H] = tpl.size;
    for (const name of ['fin', 'wing', 'engine']) assert.ok(tpl.parts[name]?.length, `${tpl.id}: ${name} polygon`);
    for (const [name, polys] of Object.entries(tpl.parts)) {
      for (const poly of polys) {
        assert.ok(poly.length >= 3, `${tpl.id}: ${name} polygon has ≥3 points`);
        for (const [x, y] of poly) assert.ok(x >= -10 && x <= W + 300 && y >= -10 && y <= H + 100, `${tpl.id}: ${name} point in range`);
      }
    }
    const b = tpl.body;
    assert.ok(b.crown < b.windowTop && b.windowTop < b.windowBottom && b.windowBottom < b.belly, `${tpl.id}: crown < windows < belly`);
    assert.ok(b.noseX < b.tailX && b.tailX <= W, `${tpl.id}: nose before tail`);
    assert.ok(tpl.titles.x0 < tpl.titles.x1, `${tpl.id}: titles span`);
    assert.ok(tpl.logo.size > 0 && tpl.logo.cx < W && tpl.logo.cy < H, `${tpl.id}: logo box`);
  }
});
await test('every aircraft category maps to a template', () => {
  const cats = new Set(AIRCRAFT_TYPES.map(t => t.category));
  for (const c of cats) assert.ok(T.liveryTemplateFor(c)?.id, `category ${c}`);
  assert.equal(T.liveryTemplateFor('Not a category').id, T.DEFAULT_LIVERY_TEMPLATE);
});

console.log('\n── 6. Screens (SSR) ───────────────────────────────────────────────');

await test('LiveryPlane renders a sized placeholder canvas on the server', () => {
  const html = renderToString(React.createElement(LiveryPlane, { livery: { tail: '#c8102e' }, titles: 'Test Air', width: 200 }));
  assert.match(html, /<canvas/);
  assert.match(html, /data-livery-template="b737-800"/);
  assert.match(html, /data-ready="0"/);
  assert.match(html, /width:200px/);
});
await test('the Branding modal opens on the Livery tab with the editor', () => {
  const html = render(React.createElement(BrandingModal, { onClose: () => {}, initialTab: 'livery' }));
  assert.match(html, /Livery<\/button>/);
  assert.match(html, /Surprise me/);
  for (const label of Object.values(L.LIVERY_STYLE_LABELS)) assert.ok(html.includes(label), `style tile ${label}`);
  assert.match(html, /Logo on the tail/);
  assert.match(html, /Norebbo/);
  assert.ok(!html.includes('Airline Logo'), 'identity tab content is not shown on the livery tab');
});
await test('the Branding modal still opens on Name & logo by default', () => {
  const html = render(React.createElement(BrandingModal, { onClose: () => {} }));
  assert.match(html, /Airline Logo/);
  assert.ok(!html.includes('Surprise me'));
});
await test('the Fleet page shows the livery card with the way into the editor', () => {
  // Seeded save: the page shows its empty state (no card) until there is a fleet.
  const { getAircraftType } = awaitedAircraft;
  const NB = getAircraftType('b737800');
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000, airlineName: 'Test Air',
    gates: { JFK: 8 }, routes: [],
    fleet: [{ id: 'ac0', typeId: NB.id, name: 'Tail 0', tailNumber: 'N0TEST', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats } }],
  }));
  const html = render(React.createElement(Fleet));
  store.clear();
  assert.match(html, /fleet-livery-card/);
  assert.match(html, /Design your livery|Edit livery/);
  assert.match(html, /data-livery-template="b737-800"/);
});

console.log('\n── 7. Logo on the tail ─────────────────────────────────────────────');
// The fin logo is the preset AirlineLogo rendered to static markup and loaded
// as an SVG data URL. Browsers refuse an SVG image whose root has no xmlns —
// React never emits one — so the logo silently never appeared (reported on
// Discord the day the editor shipped). The loader must add the namespace.
const { svgImageUrl } = await import('../src/utils/liveryPaint.js');
const AirlineLogo = (await import('../src/components/AirlineLogo.jsx')).default;
const { renderToStaticMarkup } = await import('react-dom/server');

await test('a preset logo rasterises to an SVG data URL carrying the SVG namespace', () => {
  const markup = renderToStaticMarkup(React.createElement(AirlineLogo, { id: 'horizon', accentColor: '#2563eb', size: 128, radius: 26 }));
  assert.match(markup, /^<svg/, 'AirlineLogo renders a bare <svg>');
  assert.doesNotMatch(markup, /xmlns=/, 'React emits no xmlns — the loader has to add it');
  const url = svgImageUrl(markup);
  assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/);
  const decoded = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.match(decoded, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s>]/);
  assert.ok(decoded.includes('viewBox="0 0 40 40"'), 'the rest of the markup is intact');
});

await test('markup that already has the namespace is left alone', () => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
  const decoded = decodeURIComponent(svgImageUrl(src).split(',').slice(1).join(','));
  assert.equal(decoded, src);
  assert.equal((decoded.match(/xmlns=/g) || []).length, 1);
});

console.log('\n── 8. Logo on the fuselage ─────────────────────────────────────────');
// Players asked for the logo on the body as well as the fin, as most real
// liveries carry it. Off by default so every saved livery looks the same as
// before; when on, the logo sits forward on the fuselage in the titles band
// and the airline name moves aft to make room.
const { titlesLayout } = await import('../src/utils/liveryPaint.js');

await test('logoOnFuselage is a strict, off-by-default boolean', () => {
  assert.equal(L.DEFAULT_LIVERY.logoOnFuselage, false);
  assert.equal(L.normalizeLivery({}).logoOnFuselage, false);
  assert.equal(L.normalizeLivery({ logoOnFuselage: true }).logoOnFuselage, true);
  for (const v of ['yes', 1, 'true', {}]) assert.equal(L.normalizeLivery({ logoOnFuselage: v }).logoOnFuselage, false);
  assert.equal(L.liveryFor({ logoColor: '#1fbf6b' }).logoOnFuselage, false, 'a derived default has no body logo');
});
await test('liveryKey changes with it, and a logo is needed for either placement', () => {
  assert.notEqual(L.liveryKey({ tail: '#c8102e' }), L.liveryKey({ tail: '#c8102e', logoOnFuselage: true }));
  assert.equal(L.liveryNeedsLogo({ logoOnTail: false, logoOnFuselage: true }), true);
  assert.equal(L.liveryNeedsLogo({ logoOnTail: true }), true);
  assert.equal(L.liveryNeedsLogo({ logoOnTail: false }), false);
});
await test('the guard forwards it', () => {
  const out = guard.guardDecision('SET_BRANDING', { livery: { tail: '#c8102e', logoOnFuselage: true } }, {});
  assert.equal(out.livery.logoOnFuselage, true);
});
await test('every template has a body logo box inside the titles band', () => {
  for (const tpl of Object.values(T.LIVERY_TEMPLATES)) {
    const f = tpl.fuselageLogo;
    assert.ok(f && f.size > 0, `${tpl.id}: fuselageLogo spec`);
    const b = tpl.body;
    assert.ok(f.cy - f.size / 2 > b.crown && f.cy + f.size / 2 < b.windowTop, `${tpl.id}: between crown and windows`);
  }
});
await test('layout: the logo goes forward, the name moves aft past it', () => {
  const tpl = T.LIVERY_TEMPLATES['b737-800'];
  const off = titlesLayout(tpl, { logoOnFuselage: false });
  assert.equal(off.logo, null);
  assert.equal(off.x0, tpl.titles.x0);
  assert.equal(off.x1, tpl.titles.x1);
  const on = titlesLayout(tpl, { logoOnFuselage: true });
  assert.ok(on.logo, 'a logo box');
  assert.equal(on.logo.x, tpl.titles.x0, 'the logo starts where the name used to');
  assert.equal(on.logo.size, tpl.fuselageLogo.size);
  assert.ok(on.x0 > on.logo.x + on.logo.size, 'the name starts after the logo');
  assert.equal(on.x1, tpl.titles.x1, 'and still ends in the same place');
  assert.ok(on.x1 - on.x0 > 0.6 * (tpl.titles.x1 - tpl.titles.x0), 'leaving most of the span for the name');
});
await test('the editor has the toggle beside the tail one', () => {
  const html = render(React.createElement(BrandingModal, { onClose: () => {}, initialTab: 'livery' }));
  assert.match(html, /Logo on the tail/);
  assert.match(html, /Logo on the fuselage/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
