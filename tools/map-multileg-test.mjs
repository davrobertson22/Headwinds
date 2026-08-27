// The map draws a multi-stop rotation through the airports it actually serves.
//
//   node --import ./tools/_register-loader.mjs tools/map-multileg-test.mjs
//
// Reported by Knightmare (Discord, 2026-08-26): "I fly a multi-leg route,
// MCI-JFK-ORY. On the map, it shows a line from MCI to ORY. Can that be adjusted
// to show a line from MCI-JFK-ORY, maybe in purple like the multi leg routes are
// on the routes page?"
//
// Two bugs behind one symptom:
//   1. the geometry was one great circle between the ENDPOINTS, so the line
//      missed the stop by hundreds of kilometres, and
//   2. the grouping key was the sorted endpoint pair, so a rotation and a plain
//      direct service on the same two cities merged into ONE line and ONE row —
//      their profit summed, their aircraft counted together.
//
// Geometry is asserted on the pure helper; grouping, colour and the airport
// filter are asserted against the SSR-rendered component.

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice, routeSegments, routeSegmentKey } from '../src/utils/simulation.js';

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

const { segmentsForChain, segmentsForRoute, TAG_COLOR } = await import('../src/components/mapCore.js');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteMapMod = await import('../src/components/RouteMap.jsx');
const RouteMap = RouteMapMod.default;
const { chainKey } = RouteMapMod;

// Great-circle distance, for asserting the drawn line passes THROUGH a stop.
function haversineKm(a, b) {
  const R = 6371, D = Math.PI / 180;
  const dLat = (b[0] - a[0]) * D;
  const dLon = (((b[1] - a[1] + 540) % 360) - 180) * D;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a[0] * D) * Math.cos(b[0] * D) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const nearestKm = (path, pt) => Math.min(...path.map(p => haversineKm(p, pt)));

console.log('\n── 1. Geometry: the line bends at the stop ──────────────');

const MCI = getAirport('MCI'), JFK = getAirport('JFK'), ORY = getAirport('ORY') ?? getAirport('CDG');
assert.ok(MCI && JFK && ORY, 'MCI / JFK / Paris missing from the airport data');
const chainPts = [MCI, JFK, ORY].map(a => [a.lat, a.lon]);

test('the direct arc misses the intermediate stop (the bug)', () => {
  const [direct] = segmentsForRoute(MCI.lat, MCI.lon, ORY.lat, ORY.lon);
  assert.ok(nearestKm(direct, [JFK.lat, JFK.lon]) > 100,
    'MCI→ORY apparently passes over JFK — pick a different fixture, this assertion is vacuous');
});

test('the chain passes through every stop', () => {
  const [path] = segmentsForChain(chainPts);
  for (const a of [MCI, JFK, ORY]) {
    assert.ok(nearestKm(path, [a.lat, a.lon]) < 25, `the drawn line does not reach ${a.code}`);
  }
});

test('the chain is one continuous polyline, no jumps', () => {
  const [path] = segmentsForChain(chainPts);
  assert.ok(path.length > 100, 'expected a smooth interpolated path');
  for (let i = 1; i < path.length; i++) {
    // Adjacent points on an interpolated great circle are close together. A
    // ±360 unwrap error shows up here as a step of thousands of km.
    assert.ok(Math.abs(path[i][1] - path[i - 1][1]) < 20,
      `longitude jumps ${path[i - 1][1].toFixed(1)}° → ${path[i][1].toFixed(1)}° at point ${i}`);
  }
});

test('a chain crossing the antimeridian stays continuous', () => {
  const NRT = getAirport('NRT') ?? getAirport('HND');
  const HNL = getAirport('HNL');
  const LAX = getAirport('LAX');
  if (!NRT || !HNL || !LAX) return;
  const [path] = segmentsForChain([NRT, HNL, LAX].map(a => [a.lat, a.lon]));
  for (let i = 1; i < path.length; i++) {
    assert.ok(Math.abs(path[i][1] - path[i - 1][1]) < 20,
      'the Pacific chain snaps back across the world at a stop');
  }
  for (const a of [NRT, HNL, LAX]) {
    assert.ok(nearestKm(path, [a.lat, a.lon]) < 25, `the drawn line does not reach ${a.code}`);
  }
});

test('degenerate input is handled', () => {
  assert.deepEqual(segmentsForChain([]), [[]]);
  assert.deepEqual(segmentsForChain([[1, 2]]), [[[1, 2]]]);
});

console.log('\n── 2. A rotation is its own line, not the endpoint pair ──');

test('chainKey is direction-agnostic but chain-specific', () => {
  assert.equal(chainKey(['MCI', 'JFK', 'ORY']), chainKey(['ORY', 'JFK', 'MCI']));
  assert.notEqual(chainKey(['MCI', 'JFK', 'ORY']), chainKey(['MCI', 'BOS', 'ORY']));
  assert.notEqual(chainKey(['MCI', 'JFK', 'ORY']), chainKey(['MCI', 'ORY']));
});

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const [P, Q, R] = ['MCI', 'JFK', ORY.code];
const sp = {};
for (const g of routeSegments({ stops: [P, Q, R], origin: P, destination: R })) {
  const e = Math.round(referencePrice(g.from, g.to));
  sp[routeSegmentKey(g.from, g.to)] = { economy: e, businessClass: Math.round(e * 2.5) };
}
const tail = (id, name) => ({
  id, typeId: jet.id, name, tailNumber: `N${id}`, status: 'assigned',
  ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats },
});
store.set('bbae_save_v2', JSON.stringify({
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: P, cash: 500_000_000,
  gates: { [P]: 8, [Q]: 8, [R]: 8 },
  fleet: [tail('ac1', 'Rotation'), tail('ac2', 'Direct')],
  routes: [
    { id: 'tg', origin: P, destination: R, stops: [P, Q, R], aircraftId: 'ac1',
      weeklyFrequency: 5, weeksOpen: 20, hub: P, segmentPrices: sp, cateringLevel: 'full' },
    { id: 'dir', origin: P, destination: R, stops: [P, R], aircraftId: 'ac2',
      weeklyFrequency: 4, weeksOpen: 20, hub: P, ticketPrice: 480, cateringLevel: 'full' },
  ],
  cargoRoutes: [],
}));

const html = renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap)))
  .replace(/<!-- -->/g, '');

test('the rotation and the direct service are two separate rows', () => {
  assert.ok(html.includes(`${P} → ${Q} → ${R}`),
    'the map table does not show the rotation\'s chain');
  assert.ok(html.includes(`${P} → ${R}`),
    'the direct service lost its own row');
  assert.match(html, /2 routes/, 'the two products merged into one map route');
});

test('the rotation is drawn in the multi-stop purple', () => {
  assert.ok(html.includes(TAG_COLOR),
    'no purple on the map — the rotation is indistinguishable from a direct line');
  assert.ok(html.includes('Multi-stop'), 'the legend does not explain the purple');
});

test('the intermediate stop is offered as an airport filter', () => {
  // The filter <select> is built from the airports the network touches; JFK is
  // only reachable as a mid-rotation stop here.
  assert.ok(html.includes(`>${Q} —`), `${Q} missing from the airport filter — a stop is not "touching" it?`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
