// Cruise-speed corrections (2026-11-16) and the schedule trim that makes them
// safe for saves already in progress.
//
// ── The bug this file exists to prevent ─────────────────────────────────────
// Until 2026-11-16 every passenger type without its own `cruiseKmh` flew at
// its category's speed: a DC-3 and a Q400 both at 500 km/h, a Yak-40 at 800.
// The corrections made about 30 types slower. A tail's block time is
// distance / speed + turnaround, so a schedule that filled a DC-3's week at
// 500 km/h overruns the 140 h cap at 333 km/h. Nothing in the weekly tick
// re-checks the cap, so without a migration those saves would keep flying a
// week the aircraft cannot fly. SCHEDULE_TRIM_VERSION 2 re-runs the one-off
// trim on load. This file pins that, and pins the corrected speeds so they
// cannot drift back to the category table.
//
//   node --import ./tools/_register-loader.mjs tools/speed-trim-migration-test.mjs

import assert from 'node:assert/strict';
import {
  SCHEDULE_TRIM_VERSION, MAX_WEEKLY_BLOCK_HOURS, NWR_MAX_WEEKLY_BLOCK_HOURS, applyScheduleTrimMigration,
  blockTimeHours, routeDistanceKm, cruiseSpeedKmh, routeBlockHours,
} from '../src/utils/simulation.js';
import { getAircraftType, AIRCRAFT_TYPES } from '../src/data/aircraft.js';

const { freshState } = await import('../src/store/GameContext.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const OLD_DC3_KMH = 500;   // the Turboprop category figure the DC-3 used to inherit
const A = 'SFO', B = 'LAX';

function saveWithDc3(freq, version) {
  return {
    ...freshState(),
    phase: 'playing', airlineName: 'Speed Test Air', hub: A, homeCountry: 'US',
    cash: 10_000_000, week: 30, year: 1, gameDate: { month: 7 },
    scheduleTrimVersion: version,
    fleet: [{ id: 'ac1', typeId: 'dc3', name: 'Tail One', tailNumber: 'N1ST',
              status: 'idle', ageWeeks: 60, ownershipType: 'owned', fuelMod: 1.0, config: null }],
    routes: [{ id: 'r1', origin: A, destination: B, aircraftId: 'ac1', stops: [A, B],
               weeklyFrequency: freq }],
    cargoRoutes: [], charters: [],
  };
}

// The busiest schedule a DC-3 could legally fly at the OLD speed.
const dc3 = getAircraftType('dc3');
const km = routeDistanceKm(A, B);
const oldRotation = 2 * (km / OLD_DC3_KMH + (blockTimeHours(km, dc3) - km / cruiseSpeedKmh(dc3)));
const oldMaxFreq = Math.floor(MAX_WEEKLY_BLOCK_HOURS / oldRotation);

test('the migration version was bumped for the speed change', () => {
  assert.ok(SCHEDULE_TRIM_VERSION >= 2, `SCHEDULE_TRIM_VERSION is ${SCHEDULE_TRIM_VERSION}`);
});

test('a schedule that fitted at the old DC-3 speed is over the cap at the new one', () => {
  const hours = routeBlockHours({ origin: A, destination: B, stops: [A, B] }, dc3, oldMaxFreq);
  assert.ok(hours > MAX_WEEKLY_BLOCK_HOURS,
    `${oldMaxFreq} flights a week is ${hours.toFixed(1)} h, inside the ${MAX_WEEKLY_BLOCK_HOURS} h cap — the fixture proves nothing`);
});

test('a save from before the change is trimmed back inside the cap on load, with a notice', () => {
  const out = applyScheduleTrimMigration(saveWithDc3(oldMaxFreq, 1));
  assert.equal(out.scheduleTrimVersion, SCHEDULE_TRIM_VERSION);
  const r = out.routes.find(x => x.id === 'r1');
  assert.ok(r, 'the route was deleted rather than trimmed');
  assert.ok(r.weeklyFrequency < oldMaxFreq, 'the over-cap schedule was not trimmed');
  assert.ok(routeBlockHours(r, dc3, r.weeklyFrequency) <= MAX_WEEKLY_BLOCK_HOURS + 1e-6,
    'the trimmed schedule is still over the cap');
  assert.ok((out.scheduleTrimNotices ?? []).length >= 1, 'the player was not told');
});

test('a new-world-restrictions airline is trimmed to its own 100 h cap, not to 140', () => {
  // New-world restrictions: the tail may fly 100 h a week. A schedule that filled
  // 100 h at the old DC-3 speed is now over 100 h but under 140 h, so a trim
  // against the fixed 140 h would leave it over its cap. The server tick runs this migration on
  // every airline blob (tickService), so live worlds get it without a client load.
  const oldMax100 = Math.floor(NWR_MAX_WEEKLY_BLOCK_HOURS / oldRotation);
  const route = { origin: A, destination: B, stops: [A, B] };
  const hours = routeBlockHours(route, dc3, oldMax100);
  assert.ok(hours > NWR_MAX_WEEKLY_BLOCK_HOURS && hours <= MAX_WEEKLY_BLOCK_HOURS,
    `fixture: ${oldMax100} flights is ${hours.toFixed(1)} h — not between the two caps`);
  const st = { ...saveWithDc3(oldMax100, 1), newWorldRestrictions: true };
  const r = applyScheduleTrimMigration(st).routes.find(x => x.id === 'r1');
  assert.ok(routeBlockHours(r, dc3, r.weeklyFrequency) <= NWR_MAX_WEEKLY_BLOCK_HOURS + 1e-6,
    `trimmed to ${routeBlockHours(r, dc3, r.weeklyFrequency).toFixed(1)} h, over the 100 h cap`);
});

test('a save already on the new version is left alone', () => {
  const st = saveWithDc3(oldMaxFreq, SCHEDULE_TRIM_VERSION);
  assert.equal(applyScheduleTrimMigration(st), st);
});

test('a schedule inside the cap is not touched', () => {
  const out = applyScheduleTrimMigration(saveWithDc3(2, 1));
  assert.equal(out.routes[0].weeklyFrequency, 2);
  assert.equal((out.scheduleTrimNotices ?? []).length, 0);
});

// ── The corrected speeds stay corrected ─────────────────────────────────────
// Published cruise figures (manufacturer max cruise for turboprops, normal
// cruise Mach for jets). If one of these falls back to its category's speed,
// someone has deleted its `cruiseKmh`.
const PINNED = {
  q400: 667, saab2000: 665, do328: 620, dc3: 333, c47: 260, dhc6: 337,
  bn2islander: 270, c208b: 344, yak40: 550, l410: 365, cv990: 895, l188: 600,
  vc10: 889, b737200: 780, a380: 900, b747400: 900,
};

test('the corrected cruise speeds are in the catalogue', () => {
  for (const [id, kmh] of Object.entries(PINNED)) {
    assert.equal(cruiseSpeedKmh(getAircraftType(id)), kmh, `${id}`);
  }
});

test('no piston or utility type outruns a modern turboprop airliner', () => {
  // The category table put a 1936 DC-3 at the same 500 km/h as an ATR 72.
  const atr72 = cruiseSpeedKmh(getAircraftType('atr72'));
  for (const id of ['dc3', 'c47', 'dhc6', 'bn2islander', 'c208b', 'l410', 'c408', 'emb110', 'do228', 'short360']) {
    assert.ok(cruiseSpeedKmh(getAircraftType(id)) < atr72, `${id} cruises at or above an ATR 72`);
  }
});

test('a passenger type and its freighter conversion cruise at the same speed', () => {
  const pairs = [['l188', 'l188f'], ['atr72', 'atr72f'], ['atr72200', 'atr72200f'], ['atr72500', 'atr72500f'], ['atr42300', 'atr42300f']];
  for (const [p, f] of pairs) {
    if (!AIRCRAFT_TYPES.some(t => t.id === f)) continue;
    assert.equal(cruiseSpeedKmh(getAircraftType(p)), cruiseSpeedKmh(getAircraftType(f)), `${p} vs ${f}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
