// Globe background work (Discord, Fonnesx, 2026-11-04: "I really need some
// performance related updates … reducing background processing").
//
//   node --import ./tools/_register-loader.mjs tools/globe-background-work-test.mjs
//
// A big hub on the 3D globe (hundreds of routes and tails out of SIN, Lunar
// Gateway) kept the browser busy with nobody touching it:
//   1. planes were redrawn every half pixel of movement, down to 1/30 s when
//      zoomed in — each redraw rebuilds the planes GeoJSON, re-tiles it in
//      MapLibre's worker and repaints every line, glow and pin. The floor now
//      grows with the fleet: ~1 s for 600 tails, still 1/30 s for a small one;
//   2. the night overlay (256×256 sun angles + a texture upload + a repaint)
//      was redrawn every 0.2–0.7 s in fast worlds. Now one overlay pixel of sun
//      movement, never more often than every 5 s;
//   3. every rival poll re-sent all six GeoJSON sources and tore down and
//      re-added an HTML label per airport (600 DOM markers), although a rival
//      re-pricing elsewhere moves no line. Sources now go only when what they
//      draw changed; labels only when the set of airports did; tooltips (the
//      part that does change) are read from an index.
// Measured in headless Chromium on a 600-route SIN airline: five rival polls
// re-sent 36 sources and added 3,606 label markers before, 0 and 0 after.
// The browser loop's hidden-tab pause is checked in the source (no DOM here).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

const { nightRefreshMs, gameRate, NIGHT_MIN_REFRESH_MS } = await import('../src/components/gameClock.js');
const { planeRefreshMs, PLANE_MAX_RATE } = await import('../src/components/flightsCore.js');
const { buildGlobeData } = await import('../src/components/globeCore.js');
const {
  syncGlobeSources, globeSourceKey, globeTipIndex, globeLabelKey, GLOBE_SOURCES,
} = await import('../src/components/GlobeMap.jsx');

console.log('\nGlobe background work\n');

// ── 1. Planes ────────────────────────────────────────────────────────────────
await test('a 600-tail fleet redraws its planes about once a second, however far you zoom in', () => {
  for (const zoom of [1, 4, 6, 10]) {
    const ms = planeRefreshMs(PLANE_MAX_RATE, zoom, 840, 600);
    assert.ok(ms >= 900, `zoom ${zoom}: ${ms} ms between redraws`);
  }
});

await test('a small fleet keeps smooth planes (1/30 s when zoomed in)', () => {
  assert.equal(planeRefreshMs(PLANE_MAX_RATE, 10, 840, 12), 33);
  assert.equal(planeRefreshMs(PLANE_MAX_RATE, 10), 33);   // no count → the old floor
});

await test('the floor never passes 1 s, and slow movement still waits up to 2 s', () => {
  assert.equal(planeRefreshMs(PLANE_MAX_RATE, 10, 840, 50_000), 1000);
  assert.equal(planeRefreshMs(gameRate(1), 0, 840, 600), 2000);
});

// ── 2. Night ─────────────────────────────────────────────────────────────────
await test('night is redrawn at most every 5 s, even in the fastest world', () => {
  assert.equal(NIGHT_MIN_REFRESH_MS, 5000);
  for (const wpd of [24, 48, 96]) assert.ok(nightRefreshMs(gameRate(wpd)) >= 5000, `${wpd} weeks/day`);
});

await test('night cadence is one overlay pixel of sun movement (360° / 256 px at 15°/game hour)', () => {
  // 1.40625° per px → 5.625 game minutes → 337.5 real s at real time; capped at 30 s.
  assert.equal(nightRefreshMs(1), 30_000);
  near(nightRefreshMs(30), 337.5 / 30 * 1000, 1);
});
function near(a, b, tol) { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

// ── 3. Rival polls ───────────────────────────────────────────────────────────
const AP = {
  SIN: { code: 'SIN', lat: 1.36, lon: 103.99 },
  GNB: { code: 'GNB', lat: 45.36, lon: 5.33 },
  SYD: { code: 'SYD', lat: -33.95, lon: 151.18 },
  NRT: { code: 'NRT', lat: 35.77, lon: 140.39 },
};
function dataWith({ profit = 1, color = '#3ddc97', extra = false } = {}) {
  const dests = extra ? ['GNB', 'SYD', 'NRT'] : ['GNB', 'SYD'];
  return buildGlobeData({
    routes: dests.map(d => ({ id: `SIN~${d}`, chain: [AP.SIN, AP[d]], color, tip: `<b>SIN–${d}</b> profit ${profit}` })),
    airports: ['SIN', ...dests].map(c => ({ ...AP[c], hub: c === 'SIN', core: 5, tip: `${c} · ${profit}` })),
  });
}
function fakeMap() {
  const sent = [];
  return { sent, getSource: (id) => ({ setData: () => sent.push(id) }) };
}

await test('the first draw sends every source and builds the labels', () => {
  const map = fakeMap(), memo = { drawn: {}, labelKey: null };
  const r = syncGlobeSources(map, dataWith(), memo);
  assert.deepEqual(map.sent.sort(), [...GLOBE_SOURCES].sort());
  assert.equal(r.routesSent, true);
  assert.equal(r.labelsChanged, true);
});

await test('a rival poll that only moves the numbers re-sends nothing and keeps the labels', () => {
  const map = fakeMap(), memo = { drawn: {}, labelKey: null };
  syncGlobeSources(map, dataWith({ profit: 1 }), memo);
  map.sent.length = 0;
  const r = syncGlobeSources(map, dataWith({ profit: 2 }), memo);
  assert.deepEqual(map.sent, []);
  assert.equal(r.routesSent, false);
  assert.equal(r.labelsChanged, false);
  // …but the tooltips are the new ones.
  assert.match(r.tips.routes.get('SIN~GNB'), /profit 2/);
  assert.match(r.tips.airports.get('SIN'), /· 2/);
});

await test('a line that changes colour re-sends the routes source only', () => {
  const map = fakeMap(), memo = { drawn: {}, labelKey: null };
  syncGlobeSources(map, dataWith(), memo);
  map.sent.length = 0;
  const r = syncGlobeSources(map, dataWith({ color: '#ff5d5d' }), memo);
  assert.deepEqual(map.sent, ['routes']);
  assert.equal(r.routesSent, true);
  assert.equal(r.labelsChanged, false);
});

await test('a new route re-sends its lines and airports and rebuilds the labels', () => {
  const map = fakeMap(), memo = { drawn: {}, labelKey: null };
  syncGlobeSources(map, dataWith(), memo);
  map.sent.length = 0;
  const r = syncGlobeSources(map, dataWith({ extra: true }), memo);
  assert.deepEqual(map.sent.sort(), ['airports', 'routes']);
  assert.equal(r.labelsChanged, true);
});

await test('the source key ignores tooltips and nothing else', () => {
  const a = dataWith({ profit: 1 }).routes, b = dataWith({ profit: 9 }).routes;
  assert.equal(globeSourceKey(a), globeSourceKey(b));
  assert.notEqual(globeSourceKey(a), globeSourceKey(dataWith({ color: '#fff' }).routes));
  assert.equal(globeTipIndex(a).size, 2);
  assert.notEqual(globeLabelKey(dataWith().airports), globeLabelKey(dataWith({ extra: true }).airports));
});

await test('the key costs little next to the re-tile it saves (600 lines)', () => {
  const dests = Array.from({ length: 600 }, (_, i) => ({ code: `X${i}`, lat: -60 + (i % 120), lon: -170 + (i * 7) % 340 }));
  const data = buildGlobeData({
    routes: dests.map(d => ({ id: `SIN~${d.code}`, chain: [AP.SIN, d], color: '#3ddc97', tip: 'x'.repeat(400) })),
    airports: [AP.SIN, ...dests].map(a => ({ ...a, hub: a.code === 'SIN', tip: 'y'.repeat(200) })),
  });
  const memo = { drawn: {}, labelKey: null };
  syncGlobeSources(fakeMap(), data, memo);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) syncGlobeSources(fakeMap(), data, memo);
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 100, `${ms.toFixed(1)} ms per poll`);
  console.log(`      (${ms.toFixed(1)} ms per poll for 600 lines)`);
});

// ── 4. The loop itself ───────────────────────────────────────────────────────
const globeSrc = readFileSync(new URL('../src/components/GlobeMap.jsx', import.meta.url), 'utf8');
await test('the animation loop draws nothing in a hidden tab and resumes when shown', () => {
  assert.match(globeSrc, /if \(typeof document !== 'undefined' && document\.hidden\) \{ timer = 0; return; \}/);
  assert.match(globeSrc, /addEventListener\('visibilitychange', onVisible\)/);
  assert.match(globeSrc, /removeEventListener\('visibilitychange', onVisible\)/);
});

await test('the loop passes the fleet size to the plane cadence', () => {
  assert.match(globeSrc, /planeRefreshMs\(planeRate\(c\?\.rate\), map\.getZoom\(\), undefined, planeCount\)/);
});

console.log(`\nglobe-background-work-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
