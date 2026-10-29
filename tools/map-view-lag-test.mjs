// Map view lag (Discord, Fonnesx, 2026-10-29: "the lag was crazy").
//
//   node --import ./tools/_register-loader.mjs tools/map-view-lag-test.mjs
//
// Map view keeps the world map mounted under every page, so three things that
// were harmless on the classic Map tab became constant costs:
//   1. the page panel was frosted glass — a 10px backdrop blur over a full-
//      screen map, recomputed every frame anything under or inside it moved.
//      Measured in headless Chromium on a 250-route airline: 28 fps with the
//      Dashboard open, 20 fps scrolling it; 60 / 59 fps without the blur;
//   2. every new state (a week, a rival poll, a click in the page) re-projected
//      the week and tore down and re-added every Leaflet layer behind the
//      panel — the map is now `paused` while a page covers it;
//   3. on the open map, a tick that moved no line still rebuilt ~1,000 SVG
//      paths — it now recolours and re-labels them in place (networkDrawKey).
// The browser numbers came from a Playwright probe; this suite pins the parts
// that can be checked without a GPU.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

const { networkDrawKey, routeGroupColor } = await import('../src/components/RouteMap.jsx');
const { getAirport } = await import('../packages/engine/src/data/airports.js');

const root = new URL('..', import.meta.url);
const css = readFileSync(new URL('src/index.css', root), 'utf8');
const shellSrc = readFileSync(new URL('src/components/MapShell.jsx', root), 'utf8');

console.log('\nMap view lag\n');

// ── 1. The panel is not glass ────────────────────────────────────────────────
// Every CSS rule (selector list + body), comments stripped.
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ sel: m[1].trim(), body: m[2] }));
const selects = (r, cls) => r.sel.split(',').some(s => s.trim() === cls);

await test('the page panel has no backdrop blur, and is opaque instead', () => {
  const panelRules = rules.filter(r => selects(r, '.ms-panel'));
  assert.ok(panelRules.length >= 2, 'found the .ms-panel rules');
  for (const r of panelRules) assert.ok(!/backdrop-filter/.test(r.body), `.ms-panel blurred by "${r.sel}"`);
  const bg = panelRules.map(r => r.body.match(/background:\s*([^;]+);/)?.[1]).filter(Boolean).pop();
  assert.ok(bg && !/rgba\([^)]*,\s*0?\.\d+\s*\)/.test(bg), `panel background should be opaque, got ${bg}`);
});

// Superseded 2026-10-29 (Barca's flat-map lag): the small controls lost their
// glass too. Measured on a 250-route airline panning the flat map, blurring the
// map under the floating controls cost about as much as the route glows' blur
// filter; tools/map-view-feedback-test.mjs has the measurement. They are now a
// near-opaque fill.
await test('the floating controls are a solid fill, not a blur of the moving map', () => {
  for (const cls of ['.ms-dock', '.ms-status', '.ms-alert', '.ms-home']) {
    assert.ok(rules.some(r => selects(r, cls) && /background:\s*rgba\(8, 10, 16/.test(r.body)), `${cls} has its fill`);
    assert.ok(!rules.some(r => selects(r, cls) && /backdrop-filter:\s*blur/.test(r.body)), `${cls} blurs the map`);
  }
});

await test('the map\'s CSS animations pause while a page covers it', () => {
  const r = rules.find(x => x.sel === '.ms-panel-open .ms-map *');
  assert.ok(r && /animation-play-state:\s*paused/.test(r.body));
});

// ── 2. The map holds still under a page ──────────────────────────────────────
await test('map view pauses the background map whenever a page is open', () => {
  assert.match(shellSrc, /<RouteMap fullBleed paused=\{!*panelOpen\} \/>/);
});

// ── 3. A tick that moves no line redraws nothing ─────────────────────────────
const ap = (c) => getAirport(c);
const group = (a, b, profit) => ({ key: [a, b].sort().join('~'), origin: ap(a), dest: ap(b), multi: false, hasResult: true, profit });
const hubs = { JFK: { tier: 2, name: 'Hub' } };
const pins = (...codes) => codes.map(ap);

await test('the draw key ignores route order and profit (colour is restyled in place)', () => {
  const a = [group('JFK', 'LHR', 5e5), group('JFK', 'ORD', -2e4)];
  const b = [group('JFK', 'ORD', 3e4), group('JFK', 'LHR', 4e5)];
  assert.notEqual(routeGroupColor(a[1]), routeGroupColor(b[0]), 'JFK–ORD crossed break-even');
  assert.equal(networkDrawKey(a, pins('JFK', 'LHR', 'ORD'), hubs), networkDrawKey(b, pins('ORD', 'JFK', 'LHR'), hubs));
});

await test('the draw key changes when a line, a pin or a hub badge changes', () => {
  const base = networkDrawKey([group('JFK', 'LHR', 1)], pins('JFK', 'LHR'), hubs);
  assert.notEqual(base, networkDrawKey([group('JFK', 'LHR', 1), group('JFK', 'CDG', 1)], pins('JFK', 'LHR', 'CDG'), hubs), 'new route');
  assert.notEqual(base, networkDrawKey([], pins('JFK'), hubs), 'route closed');
  assert.notEqual(base, networkDrawKey([group('JFK', 'LHR', 1)], pins('JFK', 'LHR'), { JFK: { tier: 3, name: 'Hub' } }), 'hub tier');
  assert.notEqual(base, networkDrawKey([group('JFK', 'LHR', 1)], pins('JFK', 'LHR'), { ...hubs, LHR: { tier: 1, name: 'Focus city' } }), 'new hub');
});

console.log(`\nmap-view-lag-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
