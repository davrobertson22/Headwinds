// Network map — the opening frame must contain the LINES, not just the airports.
//
// Player report (Discord, 2 Oct 2026, Matthijs / TheCookiesGuy): a Gulf hub's
// West Coast routes "ran off the map". The viewport was fitted to the airport
// set, but a long-haul arc bulges far past its ends — DXB–SEA peaks near 77°N
// even after polar softening — so the default view clipped them at the top.
//
// Probe on HEAD before the fix (airport-only frame, 1400×520 map, 50px pad):
// fitBounds landed on zoom 2, whose top edge sits below 77°N.
//
//   node --import ./tools/_register-loader.mjs tools/map-frame-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { segmentsForRoute, frameLatLngs, MERCATOR_MAX_LAT } from '../src/components/mapCore.js';

const AP = {
  DXB: { code: 'DXB', lat: 25.25, lon: 55.36 },
  SEA: { code: 'SEA', lat: 47.45, lon: -122.31 },
  LAX: { code: 'LAX', lat: 33.94, lon: -118.4 },
  SYD: { code: 'SYD', lat: -33.95, lon: 151.18 },
  LHR: { code: 'LHR', lat: 51.47, lon: -0.45 },
  JNB: { code: 'JNB', lat: -26.14, lon: 28.25 },
};
const airports = Object.values(AP);
const paths = ['SEA', 'LAX', 'SYD', 'LHR', 'JNB']
  .map((c) => segmentsForRoute(AP.DXB.lat, AP.DXB.lon, AP[c].lat, AP[c].lon)[0]);

const bbox = (pts) => pts.reduce((b, [la, lo]) => ({
  s: Math.min(b.s, la), n: Math.max(b.n, la), w: Math.min(b.w, lo), e: Math.max(b.e, lo),
}), { s: 90, n: -90, w: Infinity, e: -Infinity });

// 1. Every drawn point is inside the frame.
const frame = bbox(frameLatLngs(airports, paths));
for (const p of paths) for (const [la, lo] of p) {
  assert.ok(la <= frame.n + 1e-9 && la >= frame.s - 1e-9 && lo >= frame.w - 1e-9 && lo <= frame.e + 1e-9,
    `arc point ${la.toFixed(1)},${lo.toFixed(1)} outside frame`);
}

// 2. The regression itself: the polar arc peaks well above every airport, so an
//    airport-only frame cannot contain it.
const peak = Math.max(...paths.flat().map(([la]) => la));
const airportTop = Math.max(...airports.map((a) => a.lat));
assert.ok(peak > airportTop + 10, `expected a polar bulge (peak ${peak.toFixed(1)}, airports top ${airportTop})`);
assert.ok(frame.n >= peak - 1e-9, `frame top ${frame.n} below arc peak ${peak}`);

// 3. Latitudes are clamped to the Mercator limit.
const polar = bbox(frameLatLngs([], [[[89.9, 0], [-89.9, 10]]]));
assert.equal(polar.n, MERCATOR_MAX_LAT);
assert.equal(polar.s, -MERCATOR_MAX_LAT);

// 4. Missing paths / airports don't throw.
assert.deepEqual(frameLatLngs([null], [undefined]), []);

// 5. Both maps frame through the helper — an airport-only fitBounds is the bug.
for (const f of ['RouteMap.jsx', 'RivalRouteMap.jsx']) {
  const src = readFileSync(fileURLToPath(new URL(`../src/components/${f}`, import.meta.url)), 'utf8');
  const fits = src.match(/fitBounds\([^;]*/g) ?? [];
  assert.ok(fits.length > 0, `${f}: no fitBounds found`);
  for (const call of fits) {
    const prior = src.slice(Math.max(0, src.indexOf(call) - 300), src.indexOf(call) + call.length);
    assert.ok(/frameLatLngs\(/.test(prior), `${f}: fitBounds not framed via frameLatLngs:\n${call}`);
  }
}

console.log('map-frame-test: OK');
