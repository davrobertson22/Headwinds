// Airport code labels on the network map can be switched off (Discord: Barca —
// a big network buries the globe under codes).
//
//   · RouteMap (SSR) offers a Labels toggle on the flat map AND the globe,
//     on by default, remembered per browser
//   · switched off, the map card carries .map-labels-off, and the stylesheet
//     hides every .airport-label inside it — the flat map's Leaflet labels and
//     the globe's MapLibre markers both carry that class
//
//   node --import ./tools/_register-loader.mjs tools/airport-labels-test.mjs

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
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const RouteMapModule = await import('../src/components/RouteMap.jsx');
const { default: RouteMap, MAP_VIEW_KEY } = RouteMapModule;
const AIRPORT_LABELS_KEY = RouteMapModule.AIRPORT_LABELS_KEY ?? 'headwinds.airportLabels';
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
const render = () => strip(renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap))));
const toggle = (pressed) => new RegExp(`aria-pressed="${pressed}"[^>]*>(<[^>]+>)*[^<]*(</[^>]+>)*\\s*Labels`);

await test('the key is exported for the view to remember', () => {
  assert.equal(RouteMapModule.AIRPORT_LABELS_KEY, 'headwinds.airportLabels');
});

for (const view of ['flat', 'globe']) {
  await test(`${view}: Labels toggle is offered, on by default, nothing hidden`, () => {
    store.set(MAP_VIEW_KEY, view);
    const html = render();
    assert.match(html, toggle('true'));
    assert.doesNotMatch(html, /map-labels-off/);
    store.delete(MAP_VIEW_KEY);
  });

  await test(`${view}: remembered "off" un-presses the toggle and marks the map card`, () => {
    store.set(MAP_VIEW_KEY, view);
    store.set(AIRPORT_LABELS_KEY, 'off');
    const html = render();
    assert.match(html, toggle('false'));
    assert.match(html, /class="card map-labels-off"/);
    store.delete(AIRPORT_LABELS_KEY);
    store.delete(MAP_VIEW_KEY);
  });
}

await test('the stylesheet hides every airport label inside a labels-off map', () => {
  assert.match(src('../src/index.css'), /\.map-labels-off \.airport-label\s*\{[^}]*display:\s*none/);
});

await test('both renderers draw their codes as .airport-label', () => {
  assert.match(src('../src/components/GlobeMap.jsx'), /className = 'airport-label globe-label/);
  assert.match(src('../src/components/RouteMap.jsx'), /className: 'airport-label[ ']/);
});

console.log(`\nairport-labels-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
