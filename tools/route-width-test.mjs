// Network map: route width by passengers (visual & engagement plan, 2026-11-05).
//
// A "Width" toggle on the flat map and the globe draws each passenger line
// thicker the more people it carried last week — off by default, remembered
// per browser. Width scales with the square root of passengers against the
// busiest line, and multiplies the line's weight in every hover / focus
// state, so those still read the same.
//
//   · utils/routeWidth.js — the factor: bounds, monotonic, square root, a
//     line with no result yet at the thinnest width, off = no factors at all
//   · globeCore.buildGlobeData carries the factor as `w`; GlobeMap's line
//     widths multiply by it; the flat map's applyStyles multiplies by it
//   · RouteMap (SSR) offers the toggle in both views, off by default, and
//     reads the remembered setting
//
//   node --import ./tools/_register-loader.mjs tools/route-width-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const W = await import('../src/utils/routeWidth.js');
const { buildGlobeData } = await import('../src/components/globeCore.js');

console.log('\nRoute width by passengers\n');

await test('the factor runs from the thinnest to the thickest width', () => {
  assert.equal(W.paxWidthFactor(0, 10_000), W.WIDTH_MIN);
  assert.equal(W.paxWidthFactor(10_000, 10_000), W.WIDTH_MAX);
  assert.equal(W.paxWidthFactor(50_000, 10_000), W.WIDTH_MAX, 'never past the busiest line');
  assert.equal(W.paxWidthFactor(500, 0), W.WIDTH_MIN, 'an empty network draws thin, not NaN');
});
await test('more passengers is never thinner, and it grows by the square root', () => {
  let prev = 0;
  for (const p of [0, 10, 100, 1_000, 2_500, 5_000, 10_000]) {
    const f = W.paxWidthFactor(p, 10_000);
    assert.ok(f >= prev, `${p} pax`);
    prev = f;
  }
  // A quarter of the busiest line's passengers sits halfway up the range.
  const mid = W.WIDTH_MIN + (W.WIDTH_MAX - W.WIDTH_MIN) / 2;
  assert.ok(Math.abs(W.paxWidthFactor(2_500, 10_000) - mid) <= 0.01);
});
await test('off → no factors (every line draws at 1); on → one per group', () => {
  const groups = [
    { key: 'JFK~LHR', passengers: 9_000, hasResult: true },
    { key: 'JFK~ORD', passengers: 900, hasResult: true },
    { key: 'JFK~MIA', passengers: 0, hasResult: false },
  ];
  assert.equal(W.routeWidthFactors(groups, false).size, 0);
  const f = W.routeWidthFactors(groups, true);
  assert.equal(f.get('JFK~LHR'), W.WIDTH_MAX);
  assert.ok(f.get('JFK~ORD') > W.WIDTH_MIN && f.get('JFK~ORD') < W.WIDTH_MAX);
  assert.equal(f.get('JFK~MIA'), W.WIDTH_MIN, 'opened this week: has carried no one yet');
});
await test('factors are rounded, so float noise never re-sends the globe source', () => {
  const f = W.paxWidthFactor(1234, 9876);
  assert.equal(f, Math.round(f * 100) / 100);
});

await test('the globe data carries the factor as w (1 when absent)', () => {
  const a = { code: 'JFK', lat: 40.6, lon: -73.8 }, b = { code: 'LHR', lat: 51.5, lon: -0.5 };
  const d = buildGlobeData({ routes: [
    { id: 'x', chain: [a, b], color: '#fff', tip: '', w: 1.8 },
    { id: 'y', chain: [b, a], color: '#fff', tip: '' },
  ] });
  assert.equal(d.routes.features[0].properties.w, 1.8);
  assert.equal(d.routes.features[1].properties.w, 1);
});
await test('both maps multiply their line widths by it', () => {
  const globe = src('../src/components/GlobeMap.jsx');
  assert.match(globe, /const widthByState = \(spec, anySel\) => \['\*', \['coalesce', \['get', 'w'\], 1\], byState\(spec, 0, anySel\)\]/);
  assert.equal((globe.match(/'line-width':\s+widthByState\(ROUTE\.(main|halo)/g) ?? []).length, 2, 'both route layers at creation');
  assert.equal((globe.match(/'line-width',\s+widthByState\(ROUTE\.(main|halo), anySel\)/g) ?? []).length, 2, 'and on every restyle');
  const flat = src('../src/components/RouteMap.jsx');
  assert.match(flat, /const w = widthRef\.current\.get\(id\) \?\? 1;\s+mainW \*= w; haloW \*= w;/);
  assert.match(flat, /w: widthFactors\.get\(g\.key\) \?\? 1,/);
});

// ── RouteMap, server-rendered ───────────────────────────────────────────────
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { default: RouteMap, MAP_VIEW_KEY } = await import('../src/components/RouteMap.jsx');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const jet = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body');
store.set('bbae_save_v2', JSON.stringify({
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: 'DXB', cash: 20_000_000, scheduleTrimVersion: 1,
  hubs: { DXB: { tier: 2, tierSince: 0 } },
  gates: { DXB: 16, LHR: 6 },
  fleet: [{ id: 'ac0', typeId: jet.id, name: 'Test 0', tailNumber: 'A6TEST', status: 'assigned',
            ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
  routes: [{ id: 'r0', origin: 'DXB', destination: 'LHR', stops: ['DXB', 'LHR'], aircraftId: 'ac0',
             weeklyFrequency: 14, weeksOpen: 40, hub: 'DXB', cateringLevel: 'full' }],
}));
const strip = (h) => h.replaceAll('<!-- -->', '');
const render = (props = {}) => strip(renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap, props))));
const toggleTag = (html) => (html.match(/<button[^>]*data-map-width-toggle[^>]*>/) ?? [null])[0];

for (const view of ['flat', 'globe']) {
  await test(`${view}: the Width toggle is offered, off by default`, () => {
    store.set(MAP_VIEW_KEY, view);
    store.delete(W.ROUTE_WIDTH_KEY);
    const tag = toggleTag(render());
    assert.ok(tag, 'toggle rendered');
    assert.match(tag, /aria-pressed="false"/);
  });
  await test(`${view}: a remembered "on" comes back on`, () => {
    store.set(MAP_VIEW_KEY, view);
    store.set(W.ROUTE_WIDTH_KEY, 'on');
    assert.match(toggleTag(render()), /aria-pressed="true"/);
  });
}
await test('the map-first layout offers it too', () => {
  store.set(MAP_VIEW_KEY, 'globe');
  store.delete(W.ROUTE_WIDTH_KEY);
  const html = render({ fullBleed: true });
  assert.match(toggleTag(html) ?? '', /map-bleed-chip/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
