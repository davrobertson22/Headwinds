// The Loyalty layer on the Network map (src/components/loyaltyMapCore.js):
// the points both renderers draw, the globe's GeoJSON, and the toggle on the
// real map component (SSR). City-loyalty worlds only.
//
//   node --import ./tools/_register-loader.mjs tools/loyalty-map-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  loyaltyMapPoints, loyaltyRadius, loyaltyFillOpacity, loyaltyTrend, loyaltyTipHtml,
  LOYALTY_UP, LOYALTY_DOWN, LOYALTY_FILL, LOYALTY_EMPTY,
} from '../src/components/loyaltyMapCore.js';
import { buildGlobeData } from '../src/components/globeCore.js';
import { loyaltyPoolOf, loyaltyPoolSize } from '../src/models/loyaltyPools.js';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { referencePrice } from '../src/utils/simulation.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
console.log('\nLoyalty map layer\n');

const nyc = loyaltyPoolOf('JFK');
const row = (extra = {}) => ({
  pool: 'DEN', name: 'Denver', poolSize: loyaltyPoolSize('DEN'), seats: 4_000, members: 20_000, elites: 1_500,
  share: 20_000 / loyaltyPoolSize('DEN'), target: 30_000, value: 0.4, parts: [], rivals: [], shopping: false, ...extra,
});

test('bigger cities draw bigger circles; fuller ones hold more of your card', () => {
  assert.ok(loyaltyRadius(loyaltyPoolSize(nyc)) > loyaltyRadius(loyaltyPoolSize('DEN')));
  assert.ok(loyaltyRadius(loyaltyPoolSize('DEN')) > loyaltyRadius(loyaltyPoolSize('BOI')));
  assert.ok(loyaltyRadius(0) >= 8 && loyaltyRadius(1e9) <= 34);
  assert.ok(loyaltyFillOpacity(0.15) > loyaltyFillOpacity(0.02));
  assert.equal(loyaltyFillOpacity(0.9), loyaltyFillOpacity(0.15), 'solid from 15%');
});

test('rings: green when heading up, red when draining, red when the program is closed', () => {
  assert.equal(loyaltyTrend(row(), true), 'up');
  assert.equal(loyaltyTrend(row({ target: 10_000 }), true), 'down');
  assert.equal(loyaltyTrend(row(), false), 'down');
  assert.equal(loyaltyTrend(row({ seats: 0 }), true), 'down', 'a city you stopped flying drains');
  const [up] = loyaltyMapPoints([row()], true);
  const [down] = loyaltyMapPoints([row({ target: 5_000, shopping: true })], true);
  assert.equal(up.stroke, LOYALTY_UP);
  assert.equal(down.stroke, LOYALTY_DOWN);
  assert.equal(down.dashed, true);
});

test('a metro is drawn once at its primary airport; empty cities are grey; nothing to say, no circle', () => {
  const pts = loyaltyMapPoints([
    row(), row({ pool: nyc, name: 'New York', poolSize: loyaltyPoolSize(nyc), members: 0, elites: 0, share: 0 }),
    row({ pool: 'BOI', name: 'Boise', seats: 0, members: 0, elites: 0, share: 0 }),
  ], true);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].pool, nyc, 'biggest first');
  assert.equal(pts[0].fill, LOYALTY_EMPTY);
  assert.equal(pts[1].fill, LOYALTY_FILL);
  assert.ok(Math.abs(pts[0].lat - 40.64) < 0.01, 'at JFK');
});

test('tooltips name rivals, escaped', () => {
  const html = loyaltyTipHtml(row({ rivals: [{ name: '<b>Evil</b> Air', members: 12_000 }] }), true);
  assert.match(html, /Denver/);
  assert.match(html, /heading for 30,000/);
  assert.ok(html.includes('&lt;b&gt;Evil&lt;/b&gt; Air') && !html.includes('<b>Evil'));
});

test('the globe gets a loyalty FeatureCollection (empty by default)', () => {
  assert.deepEqual(buildGlobeData({}).loyalty.features, []);
  const g = buildGlobeData({ loyalty: loyaltyMapPoints([row()], true) });
  assert.equal(g.loyalty.features.length, 1);
  const f = g.loyalty.features[0];
  assert.deepEqual(f.geometry.coordinates.length, 2);
  for (const k of ['radius', 'fill', 'fillOpacity', 'stroke', 'dashed', 'tip']) assert.ok(k in f.properties, k);
});

// ── The real map, server-rendered ─────────────────────────────────────────────
const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 150 && t.seats <= 200)[0];
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteMap = (await import('../src/components/RouteMap.jsx')).default;
const seed = (extra = {}) => {
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 10, year: 2, hub: 'DEN', cash: 1e8, gates: { DEN: 4, ORD: 4 },
    fleet: [{ id: 'ac1', typeId: jet.id, name: 'One', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
    routes: [{ id: 'r1', origin: 'DEN', destination: 'ORD', stops: ['DEN', 'ORD'], aircraftId: 'ac1', weeklyFrequency: 14, weeksOpen: 40, hub: 'DEN',
      ticketPrice: Math.round(referencePrice('DEN', 'ORD')) }],
    ...extra,
  }));
};
const render = (props = {}) => renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap, props)));

test('the Loyalty toggle shows only in city-loyalty worlds, on both layouts', () => {
  seed();
  assert.ok(!render().includes('data-map-loyalty-toggle'));
  seed({ loyaltyPoolsWorld: true });
  assert.ok(render().includes('data-map-loyalty-toggle'));
  assert.ok(render({ fullBleed: true }).includes('data-map-loyalty-toggle'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
