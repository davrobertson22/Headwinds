// Network map, globe view — geometry and data shaping.
//
// The 3D globe (2 Oct 2026) draws the same routes as the flat map through
// MapLibre. These checks run with no DOM, no WebGL and no network.
//
//   node --import ./tools/_register-loader.mjs tools/globe-core-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  globeChainPath, splitAntimeridian, chainGeometry, chainBounds, buildGlobeData,
  globeTileUrls, globeStyle, globeZoomFor,
} from '../src/components/globeCore.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const AP = {
  DXB: { code: 'DXB', lat: 25.25, lon: 55.36 },
  SEA: { code: 'SEA', lat: 47.45, lon: -122.31 },
  NRT: { code: 'NRT', lat: 35.77, lon: 140.39 },
  HNL: { code: 'HNL', lat: 21.32, lon: -157.92 },
  LAX: { code: 'LAX', lat: 33.94, lon: -118.4 },
  LHR: { code: 'LHR', lat: 51.47, lon: -0.45 },
};
const ll = (c) => [AP[c].lat, AP[c].lon];

test('the globe draws the TRUE great circle — no polar softening', () => {
  const peak = Math.max(...globeChainPath([ll('DXB'), ll('SEA')]).map(([la]) => la));
  // The flat map squashes this to ~77°N; on a sphere it must not be squashed.
  assert.ok(peak > 80, `DXB–SEA should cross the high Arctic, peaked at ${peak.toFixed(1)}°`);
});

test('unwrapped path never jumps more than 180° between points', () => {
  const path = globeChainPath([ll('NRT'), ll('HNL'), ll('LAX')]);
  for (let i = 1; i < path.length; i++) assert.ok(Math.abs(path[i][1] - path[i - 1][1]) < 180);
});

test('a date-line crossing splits into pieces that stay in [−180, 180] and meet at the edge', () => {
  const pieces = splitAntimeridian(globeChainPath([ll('NRT'), ll('HNL')]));
  assert.equal(pieces.length, 2);
  for (const piece of pieces) for (const [, lon] of piece) assert.ok(lon >= -180 && lon <= 180, `lon ${lon}`);
  const end = pieces[0].at(-1), start = pieces[1][0];
  assert.equal(Math.abs(end[1]), 180);
  assert.equal(end[1], -start[1]);
  assert.ok(Math.abs(end[0] - start[0]) < 1e-9, 'both halves cross at the same latitude');
  assert.ok(Math.abs(pieces[0][0][1] - AP.NRT.lon) < 1e-9 && Math.abs(pieces[0][0][0] - AP.NRT.lat) < 1e-9, 'first half starts at NRT');
  assert.ok(Math.abs(pieces[1].at(-1)[1] - AP.HNL.lon) < 1e-9, 'second half ends at HNL');
});

test('a route that never nears the date line stays one piece', () => {
  assert.equal(chainGeometry([ll('DXB'), ll('LHR')]).coordinates.length, 1);
});

test('GeoJSON is [lon, lat]', () => {
  const [[first]] = chainGeometry([ll('DXB'), ll('LHR')]).coordinates;
  assert.ok(Math.abs(first[0] - AP.DXB.lon) < 1e-9 && Math.abs(first[1] - AP.DXB.lat) < 1e-9, `first point ${first}`);
});

test('focus bounds for a trans-Pacific rotation span the Pacific, not the long way round', () => {
  const [[w], [e]] = chainBounds([ll('NRT'), ll('HNL'), ll('LAX')]);
  assert.ok(e - w < 140, `width ${(e - w).toFixed(0)}°`);
  assert.ok(Math.abs((w + e) / 2) <= 180);
});

test('buildGlobeData: one feature per line, ids promoted, airports flagged', () => {
  const d = buildGlobeData({
    routes: [{ id: 'DXB~LHR', chain: [AP.DXB, AP.LHR], color: '#0f0', tip: '<b>x</b>' },
             { id: 'bad', chain: [AP.DXB], color: '#0f0' }],
    cargo: [], partners: [{ id: 'partner:0', chain: [AP.NRT, AP.HNL, AP.LAX], color: '#a0f' }],
    airports: [{ code: 'DXB', lat: AP.DXB.lat, lon: AP.DXB.lon, hub: true, core: 13 }],
  });
  assert.equal(d.routes.features.length, 1, 'a one-airport chain is not a line');
  assert.equal(d.routes.features[0].properties.id, 'DXB~LHR');
  assert.equal(d.routes.features[0].properties.tip, '<b>x</b>');
  assert.equal(d.partnerStops.features.length, 3);
  assert.equal(d.airports.features[0].properties.hub, true);
});

test('tiles: the CARTO key reaches every host, no {s}/{r} left for MapLibre', () => {
  const urls = globeTileUrls('k3y', true);
  assert.equal(urls.length, 4);
  for (const u of urls) {
    assert.ok(u.includes('key=k3y'));
    assert.ok(!/\{s\}|\{r\}/.test(u));
    assert.ok(u.includes('@2x'));
  }
});

test('style asks for the globe projection', () => {
  assert.equal(globeStyle().projection.type, 'globe');
});

test('opening zoom fits the sphere to the map height', () => {
  const z = globeZoomFor(520);
  const diameter = 512 * 2 ** z / Math.PI;
  assert.ok(diameter > 380 && diameter < 440, `diameter ${diameter.toFixed(0)}px`);
  assert.ok(globeZoomFor(380) < z);
});

test('flat map and globe share one tooltip builder per line kind', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/RouteMap.jsx', import.meta.url)), 'utf8');
  for (const fn of ['routeTipHtml', 'cargoTipHtml', 'partnerTipHtml', 'airportTipHtml']) {
    const uses = src.split(`${fn}(`).length - 1;
    assert.ok(uses >= 3, `${fn}: defined once and used by both views (found ${uses})`);
  }
});

// ── The real component, server-rendered in each view ─────────────────────────
// Effects don't run under SSR, so this proves the toggle, the remembered
// choice and the globe's data build (a hook that only runs in globe view)
// without WebGL.
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { default: RouteMap, MAP_VIEW_KEY } = await import('../src/components/RouteMap.jsx');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 140).sort((a, b) => b.range - a.range)[0];
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
const render = () => renderToString(React.createElement(GameProvider, null,
  React.createElement(RouteMap))).replaceAll('<!-- -->', '');

test('flat map is the default view', () => {
  const html = render();
  assert.ok(/aria-pressed="true"[^>]*>Map</.test(html), 'Map button pressed');
  assert.ok(!html.includes('Loading globe'));
});

test('a remembered globe choice opens on the globe', () => {
  store.set(MAP_VIEW_KEY, 'globe');
  const html = render();
  assert.ok(/aria-pressed="true"[^>]*>Globe</.test(html), 'Globe button pressed');
  assert.ok(html.includes('Loading globe'), 'globe container rendered');
  assert.ok(/display:none/.test(html), 'flat map stays mounted but hidden');
  store.delete(MAP_VIEW_KEY);
});

console.log(`\nglobe-core-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
