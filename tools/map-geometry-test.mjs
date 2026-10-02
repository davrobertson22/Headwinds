// Route lines reach the airports they serve, at the world view.
//
//   node --import ./tools/_register-loader.mjs tools/map-geometry-test.mjs
//
// Reported on Discord 2026-10-02 (Matthijs, Gulf hub, 500+ routes): "visual
// thing but these lines" — a fan of arcs leaving the top of the map. Two bugs:
//   1. Gulf → US West Coast great circles peak at 85–89°N, which Web Mercator
//      cannot draw; Leaflet clamps at 85.05° so the lines ran off the frame.
//   2. Paths are unwrapped, so one crossing the antimeridian ends in the next
//      world copy (DXB→HNL at 202°E). Markers sit in [−180, 180], so the line
//      stopped in empty space and the far airport had no line touching it.

import assert from 'node:assert/strict';
import { getAirport } from '../src/data/airports.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const { segmentsForRoute, segmentsForChain } = await import('../src/components/mapCore.js');
const ap = (c) => { const a = getAirport(c); assert.ok(a, `${c} missing from airport data`); return a; };
const MERCATOR_MAX = 85.0511;

// Does SOME drawn segment put a point within 0.01° of the airport as drawn?
const touches = (segments, a) =>
  segments.some(seg => seg.some(([lat, lon]) => Math.abs(lat - a.lat) < 0.01 && Math.abs(lon - a.lon) < 0.01));

console.log('\n── 1. Polar routes stay on the map ──────────────────────');

for (const [o, d] of [['DXB', 'SFO'], ['DOH', 'SEA'], ['DXB', 'YVR'], ['DXB', 'LAX']]) {
  test(`${o}–${d} stays well inside the Mercator limit`, () => {
    const segs = segmentsForRoute(ap(o).lat, ap(o).lon, ap(d).lat, ap(d).lon);
    const maxLat = Math.max(...segs.flat().map(p => p[0]));
    assert.ok(maxLat < 80, `peaks at ${maxLat.toFixed(1)}°N (Mercator clamps at ${MERCATOR_MAX})`);
  });
}

test('a high-Arctic airport still meets its line', () => {
  const lyr = getAirport('LYR');
  if (!lyr) return;
  const osl = ap('OSL');
  const segs = segmentsForRoute(osl.lat, osl.lon, lyr.lat, lyr.lon);
  assert.ok(touches(segs, lyr), 'the line was squashed away from Longyearbyen');
});

test('ordinary routes are untouched', () => {
  const [path] = segmentsForRoute(ap('JFK').lat, ap('JFK').lon, ap('LHR').lat, ap('LHR').lon);
  assert.ok(Math.max(...path.map(p => p[0])) > 50, 'JFK–LHR lost its northward bow');
});

console.log('\n── 2. Date-line crossings reach both markers ────────────');

for (const [o, d] of [['DXB', 'HNL'], ['HNL', 'DXB'], ['NRT', 'LAX'], ['SYD', 'SFO'], ['AKL', 'LAX']]) {
  test(`${o}→${d} touches both airports where their markers are drawn`, () => {
    const A = ap(o), B = ap(d);
    const segs = segmentsForRoute(A.lat, A.lon, B.lat, B.lon);
    assert.ok(touches(segs, A), `no line reaches ${o} at ${A.lon}°`);
    assert.ok(touches(segs, B), `no line reaches ${d} at ${B.lon}°`);
  });
}

test('a Pacific rotation reaches every stop where it is drawn', () => {
  const chain = ['NRT', 'HNL', 'LAX'].map(ap);
  const segs = segmentsForChain(chain.map(a => [a.lat, a.lon]));
  for (const a of chain) assert.ok(touches(segs, a), `no line reaches ${a.code}`);
});

test('routes that never cross the date line are drawn once', () => {
  assert.equal(segmentsForRoute(ap('JFK').lat, ap('JFK').lon, ap('LHR').lat, ap('LHR').lon).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
