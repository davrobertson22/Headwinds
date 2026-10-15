// Game clock, day/night and the planes on the globe.
//
// The clock spreads a world's week across its real tick interval (Mon 00:00 →
// Sun 23:59); the globe shades night from it and flies each tail's rotations.
// Pure modules — no DOM, no WebGL, no network.
//
//   node --import ./tools/_register-loader.mjs tools/game-clock-test.mjs

import assert from 'node:assert/strict';
import {
  gameClockAt, clockStepMinutes, formatGameClock, tickIntervalMs, gameRate,
  sunPosition, sunElevationDeg, nightAlpha, nightOverlayPixels, mercRowLat,
  nightRefreshMs, NIGHT_MAX_ALPHA, WEEK_HOURS,
} from '../src/components/gameClock.js';
import {
  PLANE_MAX_RATE, planeRate, planeWeekHours, slerp, bearingDeg, buildFlightPlan,
  planePosition, planesGeoJSON, planeRefreshMs, hash01,
} from '../src/components/flightsCore.js';
import { globeChainPath } from '../src/components/globeCore.js';
import { getAirport } from '../src/data/airports.js';
import { getAircraftType, AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import {
  routeDistanceKm, cruiseSpeedKmh, turnaroundHours, routeBlockHours,
} from '../src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

// ── Clock ─────────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const at = (wpd, msToTick, extra = {}) =>
  gameClockAt(NOW, { weeksPerDay: wpd, nextTickAt: new Date(NOW + msToTick).toISOString(), ...extra });

test('a week that just landed reads Monday 00:00', () => {
  const c = at(4, tickIntervalMs(4));
  assert.equal(c.fraction, 0);
  assert.equal(formatGameClock(c), 'Mon 00:00');
});

test('halfway through the interval is Thursday noon', () => {
  const c = at(1, tickIntervalMs(1) / 2);
  near(c.weekHours, 84, 1e-9);
  assert.equal(formatGameClock(c), 'Thu 12:00');
});

test('the clock never passes Sunday 23:59, even when the tick is late', () => {
  const justBefore = at(1, 1);
  assert.equal(formatGameClock(justBefore), 'Sun 23:59');
  const late = at(1, -60_000);
  assert.equal(late.overdue, true);
  assert.equal(formatGameClock(late), 'Sun 23:59');
  assert.ok(late.weekHours < WEEK_HOURS);
});

test('rawHours keeps moving through a late tick (planes must not freeze)', () => {
  const late = at(24, -60_000);
  const later = gameClockAt(NOW + 1000, { weeksPerDay: 24, nextTickAt: new Date(NOW - 60_000).toISOString() });
  assert.ok(later.rawHours > late.rawHours);
  near(later.rawHours - late.rawHours, gameRate(24) / 3600, 1e-6, 'one real second of game time');
});

test('a scheduled world that has not started is parked at Monday 00:00', () => {
  const c = at(4, 5 * 86_400_000, { preStart: true });
  assert.equal(c.frozen, true);
  assert.equal(formatGameClock(c), 'Mon 00:00');
});

test('client clock running behind the server: clock and planes both hold at Monday 00:00', () => {
  const c = at(4, tickIntervalMs(4) + 30_000);
  assert.equal(c.fraction, 0);
  assert.equal(c.rawHours, 0, 'planes must not jump to late in the week');
});

test('no pace or no next tick → no clock (ended worlds, the solo game)', () => {
  assert.equal(gameClockAt(NOW, null), null);
  assert.equal(gameClockAt(NOW, { weeksPerDay: 4 }), null);
  assert.equal(gameClockAt(NOW, { nextTickAt: new Date(NOW).toISOString() }), null);
  assert.equal(formatGameClock(null), '');
});

test('the readout steps coarser as the world speeds up', () => {
  const step = (wpd) => clockStepMinutes(gameRate(wpd));
  assert.deepEqual([1, 2, 4, 6, 12, 24, 48, 96].map(step), [1, 1, 1, 1, 5, 5, 10, 15]);
  // …and the shown minutes are a multiple of the step.
  const c = at(96, tickIntervalMs(96) * 0.4321);
  const mins = Number(formatGameClock(c).slice(-2));
  assert.equal(mins % 15, 0, formatGameClock(c));
});

// ── Sun ───────────────────────────────────────────────────────────────────────
test('the sun is over the Tropic of Cancer in late June and Capricorn in late December', () => {
  assert.ok(sunPosition(26, 0).lat > 23, `June ${sunPosition(26, 0).lat}`);
  assert.ok(sunPosition(51, 84).lat < -23, `December ${sunPosition(51, 84).lat}`);
  assert.ok(Math.abs(sunPosition(12, 84).lat) < 4, `March equinox ${sunPosition(12, 84).lat}`);
});

test('noon UTC puts the sun over Greenwich; midnight over the date line; 18:00 over 90°W', () => {
  near(sunPosition(10, 12).lon, 0, 1e-9);
  near(Math.abs(sunPosition(10, 24).lon), 180, 1e-9);
  near(sunPosition(10, 18).lon, -90, 1e-9);
  near(sunPosition(10, 6).lon, 90, 1e-9);
});

test('elevation is +90° under the sun and −90° opposite it', () => {
  const sun = sunPosition(20, 40);
  near(sunElevationDeg(sun.lat, sun.lon, sun), 90, 1e-6);
  near(sunElevationDeg(-sun.lat, sun.lon + 180, sun), -90, 1e-6);
});

test('night fades in through twilight, clear by day and capped at full night', () => {
  assert.equal(nightAlpha(30), 0);
  assert.equal(nightAlpha(2), 0);
  assert.ok(nightAlpha(-5) > 0 && nightAlpha(-5) < NIGHT_MAX_ALPHA);
  near(nightAlpha(-12), NIGHT_MAX_ALPHA, 1e-12);
  near(nightAlpha(-60), NIGHT_MAX_ALPHA, 1e-12);
});

test('overlay pixels: clear under the sun, dark opposite it', () => {
  const W = 128, H = 128;
  const sun = { lat: 0, lon: 0 };
  const px = nightOverlayPixels(sun, W, H);
  assert.equal(px.length, W * H * 4);
  const alphaAt = (lat, lon) => {
    let best = 0, bestD = Infinity;
    for (let j = 0; j < H; j++) { const d = Math.abs(mercRowLat(j, H) - lat); if (d < bestD) { bestD = d; best = j; } }
    const i = Math.min(W - 1, Math.floor(((lon + 180) / 360) * W));
    return px[(best * W + i) * 4 + 3];
  };
  assert.equal(alphaAt(0, 0), 0, 'noon at Greenwich');
  assert.equal(alphaAt(0, 179), Math.round(255 * NIGHT_MAX_ALPHA), 'midnight on the date line');
});

test('overlay rows follow Web Mercator (85°N at the top, equator in the middle)', () => {
  assert.ok(mercRowLat(0, 256) > 84.5);
  near(mercRowLat(127.5, 256), 0, 1e-9);
  assert.ok(mercRowLat(255, 256) < -84.5);
});

test('night redraw cadence scales with pace, within 0.2–30 s', () => {
  assert.equal(nightRefreshMs(gameRate(96)), 200);
  assert.ok(nightRefreshMs(gameRate(1)) > 10_000);
  assert.equal(nightRefreshMs(0), 30_000);
});

// ── Planes ────────────────────────────────────────────────────────────────────
const narrow = AIRCRAFT_TYPES.find(t => t.category === 'Narrow Body' && !t.freighter);
const planFor = (id, codes, f, type = narrow) => {
  const stops = codes.map(getAirport);
  return buildFlightPlan({
    id, group: id, color: '#fff', tip: id, stops,
    legKm: stops.slice(1).map((s, i) => routeDistanceKm(codes[i], codes[i + 1])),
    weeklyFrequency: f, cruiseKmh: cruiseSpeedKmh(type), turnaroundH: turnaroundHours(type),
  });
};

test('plane speed: game clock up to 24 weeks/day, capped above', () => {
  assert.equal(PLANE_MAX_RATE, gameRate(24));
  assert.equal(planeRate(gameRate(4)), gameRate(4));
  assert.equal(planeRate(gameRate(96)), PLANE_MAX_RATE);
  assert.equal(planeRate(undefined), PLANE_MAX_RATE);
});

test('slow worlds fly on the game clock; fast worlds on a capped clock that still moves', () => {
  const slow = at(6, tickIntervalMs(6) * 0.3);
  assert.equal(planeWeekHours(NOW, slow), slow.rawHours);
  const fast = at(96, tickIntervalMs(96) * 0.3);
  const a = planeWeekHours(NOW, fast), b = planeWeekHours(NOW + 1000, fast);
  near(((b - a) + WEEK_HOURS) % WEEK_HOURS, PLANE_MAX_RATE / 3600, 1e-9, 'one real second at the cap');
  assert.equal(planeWeekHours(NOW, at(6, 1e9, { preStart: true })), 0);
  const free = planeWeekHours(NOW, null);
  assert.ok(free >= 0 && free < WEEK_HOURS);
});

test('a rotation is every leg out then every leg back, timed like the engine block hours', () => {
  const p = planFor('r1', ['SYD', 'MEL'], 7);
  assert.equal(p.legs.length, 2);
  assert.deepEqual(p.legs.map(l => `${l.from.code}-${l.to.code}`), ['SYD-MEL', 'MEL-SYD']);
  const tag = planFor('r2', ['MCI', 'JFK', 'ORY'], 3);
  assert.deepEqual(tag.legs.map(l => `${l.from.code}-${l.to.code}`), ['MCI-JFK', 'JFK-ORY', 'ORY-JFK', 'JFK-MCI']);
  // Per rotation, block time = the engine's routeBlockHours for one frequency.
  const engineH = routeBlockHours({ origin: 'MCI', destination: 'ORY', stops: ['MCI', 'JFK', 'ORY'] }, narrow, 1);
  near(tag.rotationH, engineH, 0.01, 'rotation hours');
  near(tag.slotH, WEEK_HOURS / 3, 1e-9);
});

test('a tail is airborne for exactly its flying hours each week', () => {
  const p = planFor('r3', ['DXB', 'LHR'], 5);
  let airborne = 0;
  const N = 168 * 60;
  for (let k = 0; k < N; k++) if (planePosition(p, (k + 0.5) / 60)) airborne++;
  const flyingH = p.legs.reduce((s, l) => s + l.flightH, 0) * 5;
  near(airborne / 60, flyingH, 0.1, 'airborne hours');
});

test('it leaves from the origin and arrives at the destination, pointing the right way', () => {
  const p = planFor('r4', ['SYD', 'PER'], 7);
  const l = p.legs[0];
  const start = planePosition(p, p.phase + 1e-6);
  near(start.lat, getAirport('SYD').lat, 0.01); near(start.lon, getAirport('SYD').lon, 0.01);
  near(start.heading, bearingDeg(getAirport('SYD'), getAirport('PER')), 0.5, 'initial heading');
  const end = planePosition(p, p.phase + l.flightH - 1e-6);
  near(end.lat, getAirport('PER').lat, 0.01); near(end.lon, getAirport('PER').lon, 0.01);
  assert.equal(planePosition(p, p.phase + l.flightH + l.turnH / 2), null, 'on the ground at PER');
  const home = planePosition(p, p.phase + l.flightH + l.turnH + 1e-6);
  near(home.lat, getAirport('PER').lat, 0.01);
  assert.ok(home.heading > 45 && home.heading < 135, `heading home east, got ${home.heading}`);
});

test('a plane sits on its route line, including across the date line', () => {
  const p = planFor('r5', ['NRT', 'HNL'], 7);
  const line = globeChainPath([[getAirport('NRT').lat, getAirport('NRT').lon], [getAirport('HNL').lat, getAirport('HNL').lon]], 256);
  for (const f of [0.1, 0.37, 0.5, 0.8]) {
    const pos = planePosition(p, p.phase + p.legs[0].flightH * f);
    assert.ok(pos.lon >= -180 && pos.lon <= 180, `lon ${pos.lon}`);
    const off = Math.min(...line.map(([la, lo]) => Math.hypot(la - pos.lat, ((lo - pos.lon + 540) % 360) - 180)));
    assert.ok(off < 0.2, `off the line by ${off.toFixed(3)}° at ${f}`);
  }
});

test('no jump at the week wrap (Sunday night → Monday morning)', () => {
  const p = planFor('r6', ['LHR', 'JFK'], 7);
  // Find a rotation airborne across the boundary by shifting the phase.
  const q = { ...p, phase: WEEK_HOURS - 2 };
  const a = planePosition(q, WEEK_HOURS - 1e-4), b = planePosition(q, 1e-4);
  assert.ok(a && b);
  near(a.lat, b.lat, 0.01); near(a.lon, b.lon, 0.01);
});

test('tails on the same pair spread out; bad data flies nothing', () => {
  assert.notEqual(hash01('r7a'), hash01('r7b'));
  assert.notEqual(planFor('r7a', ['SYD', 'MEL'], 7).phase, planFor('r7b', ['SYD', 'MEL'], 7).phase);
  assert.equal(planFor('r8', ['SYD', 'MEL'], 0), null);
  assert.equal(buildFlightPlan({ id: 'x', stops: [getAirport('SYD')], legKm: [], weeklyFrequency: 3, cruiseKmh: 800 }), null);
});

test('a turboprop takes longer than a jet over the same leg', () => {
  const tp = AIRCRAFT_TYPES.find(t => t.category === 'Turboprop' && !t.freighter);
  const slow = planFor('r9', ['SYD', 'MEL'], 7, tp), fast = planFor('r9', ['SYD', 'MEL'], 7);
  assert.ok(slow.legs[0].flightH > fast.legs[0].flightH * 1.5);
});

test('GeoJSON carries heading, group and colour for every airborne plane', () => {
  const plans = [planFor('a', ['SYD', 'MEL'], 21), planFor('b', ['DXB', 'LHR'], 7), null];
  const p = plans[1];
  const fc = planesGeoJSON(plans, p.phase + 1);
  const f = fc.features.find(x => x.properties.id === 'b');
  assert.ok(f, 'DXB–LHR airborne an hour after departure');
  assert.equal(f.properties.group, 'b');
  assert.equal(typeof f.properties.heading, 'number');
  assert.ok(f.properties.tip.includes('DXB → LHR'));
});

test('redraw cadence: about half a pixel of movement, 30 fps at most', () => {
  assert.equal(planeRefreshMs(PLANE_MAX_RATE, 10), 33);
  assert.equal(planeRefreshMs(gameRate(1), 0), 2000);
  const z3 = planeRefreshMs(PLANE_MAX_RATE, 3);
  assert.ok(z3 > 33 && z3 < 2000, `${z3}`);
});

console.log(`\ngame-clock-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
