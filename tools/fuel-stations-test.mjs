// Fuel operations Phase 4 (FUEL_OPERATIONS_PLAN.md §7): station fuel pricing
// and tankering — where you buy the fuel matters.
//
// Verified failing on HEAD (2026-09-20) via a probe on HEAD's own APIs: fuel
// per km per flight is identical on JFK–LAX and JFK–NAN whatever the
// stations, ADD_ROUTE writes no tankering mode under fuelOpsV 2, and
// SET_ROUTE_TANKERING returns state unchanged.
//
//   node tools/fuel-stations-test.mjs

import assert from 'node:assert/strict';
import {
  stationFuelBasis, stationFuelDriver, stationFuelBand, routeFuelStations, tankerFraction,
  setFuelStationsEnabled, getFuelStationsEnabled, fuelStationsOn, fuelByStationOf, sumFuelByStation,
  FUEL_STATION_OVERRIDES, FUEL_STATION_MIN, FUEL_STATION_MAX, FUEL_OPS_VERSION, TANKER_PENALTY_PER_HOUR,
} from '../packages/engine/src/data/fuelStations.js';
import { AIRPORTS, getAirport } from '../packages/engine/src/data/airports.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  simulateRoute, simulateCargoRoute, weeklyTick, blockTimeHours, effectiveRangeKm, routeDistanceKm,
  defaultConfig,
} from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { gameReducer } from '../packages/engine/index.mjs';
import { runScenario, makeRng } from './golden-master/harness.mjs';
import { fuelOpsVOf } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

console.log('\nThe table\n');

test('the basis orders the world the way jet fuel actually prices', () => {
  const b = (c) => stationFuelBasis(c);
  assert.ok(b('DXB') < b('JFK'), 'the Gulf is cheapest');
  assert.ok(b('JFK') < b('LHR'), 'US mega hub below Europe');
  assert.ok(b('LHR') < b('NAN'), 'Europe below a Pacific island');
  assert.ok(b('NAN') < b('PPT'));
  assert.ok(b('JFK') <= 0.95 && b('JFK') >= 0.88, `JFK ${b('JFK')}`);
  assert.ok(b('NAN') >= 1.15, `NAN ${b('NAN')}`);
});

test('a stated override IS the stated value', () => {
  for (const [code, v] of Object.entries(FUEL_STATION_OVERRIDES)) {
    if (!getAirport(code)) continue;
    assert.equal(stationFuelBasis(code), v, code);
  }
});

test('every station sits inside the band, to three decimals', () => {
  for (const a of AIRPORTS) {
    const v = stationFuelBasis(a);
    assert.ok(v >= FUEL_STATION_MIN && v <= FUEL_STATION_MAX, `${a.code} ${v}`);
    assert.equal(v, +v.toFixed(3));
  }
});

test('mean-preserving: the population-weighted mean of the final table is 1.00 ± 0.01', () => {
  let num = 0, den = 0;
  for (const a of AIRPORTS) {
    const w = Math.max(0.01, Number(a.population) || 0.01);
    num += stationFuelBasis(a) * w; den += w;
  }
  const mean = num / den;
  assert.ok(near(mean, 1.0, 0.01), `weighted mean ${mean.toFixed(4)}`);
});

test('the spread between typical stations is a hub decision, not a dice roll', () => {
  const vals = AIRPORTS.map(a => stationFuelBasis(a)).sort((x, y) => x - y);
  const p5 = vals[Math.floor(vals.length * 0.05)], p95 = vals[Math.floor(vals.length * 0.95)];
  assert.ok(p95 - p5 >= 0.15 && p95 - p5 <= 0.35, `p5 ${p5} p95 ${p95}`);
});

test('the driver names the dominant factor and the signed percentage', () => {
  const nan = stationFuelDriver('NAN');
  assert.match(nan.text, /stated/);
  assert.ok(nan.pct > 0);
  const jfk = stationFuelDriver('JFK');
  assert.ok(jfk.pct < 0 && /mega|North America/.test(jfk.text), jfk.text);
  const kgs = stationFuelDriver('KGS');
  assert.ok(kgs.pct > 0, kgs.text);
  assert.equal(stationFuelBand(0.9), 'cheap');
  assert.equal(stationFuelBand(1.0), 'normal');
  assert.equal(stationFuelBand(1.1), 'dear');
  assert.equal(stationFuelBand(1.3), 'very dear');
});

console.log('\nRoutes and tankering\n');

test('with the knob off every route reads 1 and carries no station fields', () => {
  setFuelStationsEnabled(false);
  const r = routeFuelStations({ origin: 'JFK', destination: 'NAN', tankering: 'auto' }, { sectorKm: 1000, rangeKm: 6000, blockHours: 2 });
  assert.equal(r.factor, 1);
  assert.equal(r.enabled, false);
  assert.equal(r.stations, null);
});

test('a round trip buys half at each end', () => {
  setFuelStationsEnabled(true);
  const r = routeFuelStations({ origin: 'JFK', destination: 'LHR', tankering: 'off' });
  const expect = (stationFuelBasis('JFK') + stationFuelBasis('LHR')) / 2;
  assert.ok(near(r.factor, expect, 1e-4));
  assert.ok(near(r.stations.JFK + r.stations.LHR, r.factor, 1e-4), 'shares sum to the factor (4-decimal factor)');
  assert.equal(r.tankering, null);
});

test('the tank rule: full at 45% of range, half at 60%, none at 90%', () => {
  assert.ok(near(tankerFraction(4500, 10000), 1, 1e-9));
  assert.ok(near(tankerFraction(6000, 10000), 0.5, 1e-9));
  assert.equal(tankerFraction(9000, 10000), 0);
  assert.equal(tankerFraction(9500, 10000), 0);
  assert.equal(tankerFraction(0, 10000), 0);
});

test('a short sector out of a cheap station tankers the return fuel and saves', () => {
  setFuelStationsEnabled(true);
  const route = { origin: 'DFW', destination: 'KGS', tankering: 'auto' };
  const r = routeFuelStations(route, { sectorKm: 900, rangeKm: 6000, blockHours: 1.8 });
  assert.ok(r.tankering && r.tankering.saved > 0, JSON.stringify(r.tankering));
  assert.equal(r.tankering.from, 'DFW');
  assert.equal(r.tankering.frac, 1);
  assert.ok(near(r.tankering.penalty, TANKER_PENALTY_PER_HOUR * 1.8, 1e-9));
  assert.ok(r.factor < r.basis, 'the factor beats the plain average');
  assert.equal(r.stations.KGS, 0, 'nothing bought at the dear end when fully tankered');
  // Off: the plain average.
  const off = routeFuelStations({ ...route, tankering: 'off' }, { sectorKm: 900, rangeKm: 6000, blockHours: 1.8 });
  assert.ok(near(off.factor, off.basis, 1e-9));
});

test('a long sector does not tanker: the carrying penalty outruns the spread', () => {
  setFuelStationsEnabled(true);
  const r = routeFuelStations({ origin: 'DXB', destination: 'LHR', tankering: 'auto' }, { sectorKm: 5500, rangeKm: 14000, blockHours: 7.5 });
  assert.ok(r.tankering && r.tankering.saved === 0, JSON.stringify(r.tankering));
  assert.match(r.tankering.reason, /penalty/);
  assert.ok(near(r.factor, r.basis, 1e-9));
});

test('a sector past the tanks does not tanker either', () => {
  setFuelStationsEnabled(true);
  const r = routeFuelStations({ origin: 'ANC', destination: 'NAN', tankering: 'auto' }, { sectorKm: 9500, rangeKm: 10000, blockHours: 11 });
  assert.ok(r.tankering && r.tankering.saved === 0);
  assert.match(r.tankering.reason, /tanks/);
});

test('a multi-stop route averages its legs by length and never tankers', () => {
  setFuelStationsEnabled(true);
  const r = routeFuelStations({ origin: 'JFK', destination: 'NAN', stops: ['JFK', 'LAX', 'NAN'], tankering: 'auto' }, { legKm: [4000, 9000] });
  const bJ = stationFuelBasis('JFK'), bL = stationFuelBasis('LAX'), bN = stationFuelBasis('NAN');
  const expect = ((bJ + bL) / 2) * (4000 / 13000) + ((bL + bN) / 2) * (9000 / 13000);
  assert.ok(near(r.factor, expect, 1e-3), `${r.factor} vs ${expect}`);
  assert.equal(r.tankering, null);
  assert.ok(near(Object.values(r.stations).reduce((s, v) => s + v, 0), r.factor, 1e-4));
});

test('fuel dollars by station split the route bill by the plan and sum back exactly', () => {
  setFuelStationsEnabled(true);
  const plan = routeFuelStations({ origin: 'JFK', destination: 'LHR', tankering: 'off' });
  const by = fuelByStationOf(plan, 1_000_000);
  assert.ok(near(by.JFK + by.LHR, 1_000_000, 1));
  assert.ok(by.LHR > by.JFK, 'the dear end takes the bigger share');
  assert.deepEqual(sumFuelByStation([{ fuelByStation: by }, { fuelByStation: { LHR: 10 } }]), { JFK: by.JFK, LHR: by.LHR + 10 });
  assert.equal(sumFuelByStation([{}, { fuelByStation: null }]), null);
});

console.log('\nThrough the sims and the tick\n');

// START_GAME now stamps fuelOpsV on every new game, so the golden scenario is
// a v2 airline; the classic fixture is the same airline with the key removed,
// which is exactly what a save that predates the feature looks like.
const { fuelOpsV: _stamped, ...s60 } = runScenario({ weeks: 60 });
assert.equal(_stamped, FUEL_OPS_VERSION, 'START_GAME stamps the fuel-ops version');
const V2 = { ...s60, fuelOpsV: FUEL_OPS_VERSION };

function tickWith(state, seed) {
  const orig = Math.random;
  Math.random = makeRng(seed);
  try { return gameReducer(state, { type: 'ADVANCE_WEEK' }); } finally { Math.random = orig; }
}

test('the reducer sets the knob from state: classic saves are untouched, v2 saves are charged', () => {
  const classic = tickWith(s60, 0x5EED);
  assert.equal(getFuelStationsEnabled(), false, 'a classic tick leaves the knob off');
  assert.ok(!('fuelByStation' in classic.lastReport), 'classic report carries no station fields');
  assert.ok(!('fuelStationFactor' in classic.lastReport.routeResults[0]));
  const v2 = tickWith(V2, 0x5EED);
  assert.equal(getFuelStationsEnabled(), true);
  assert.ok(v2.lastReport.fuelByStation, 'v2 report has fuel by station');
  const r0 = v2.lastReport.routeResults[0];
  assert.equal(r0.fuelStationFactor, (stationFuelBasis('JFK') + stationFuelBasis('LAX')) / 2);
  const ratio = v2.lastReport.totalFuel / classic.lastReport.totalFuel;
  assert.ok(near(ratio, r0.fuelStationFactor, 0.002), `fuel ratio ${ratio} vs factor ${r0.fuelStationFactor}`);
  assert.equal(v2.lastReport.fuelMultiplier, classic.lastReport.fuelMultiplier, 'the PRICE multiplier is untouched');
  const summed = Object.values(v2.lastReport.fuelByStation).reduce((s, x) => s + x, 0);
  assert.ok(near(summed, v2.lastReport.totalFuel, 2), `by-station ${summed} vs total ${v2.lastReport.totalFuel}`);
});

test('previews agree: a route sim at the projected multiplier equals the tick, station factor included', () => {
  const proj = projectWeek(V2);
  const rr = proj.report.routeResults[0];
  const route = V2.routes.find(r => r.id === rr.routeId);
  const ac = V2.fleet.find(a => a.id === route.aircraftId);
  const sim = simulateRoute(route, ac, proj.gameDate, V2.labor ?? null, proj.fuelMultiplier);
  assert.equal(sim.fuelCost, rr.fuelCost);
  assert.equal(sim.fuelStationFactor, rr.fuelStationFactor);
  // And the classic state, projected afterwards, is back to world-flat fuel.
  const classic = projectWeek(s60);
  assert.ok(!('fuelStationFactor' in classic.report.routeResults[0]));
});

test('the same tail on a dear pair costs more per km than on a cheap pair', () => {
  setFuelStationsEnabled(true);
  const ac = V2.fleet[0];
  const type = getAircraftType(ac.typeId);
  const gd = { week: 1, month: 6 };
  const cheap = simulateRoute({ origin: 'JFK', destination: 'LAX', weeklyFrequency: 7, tankering: 'off' }, ac, gd, null, 1.0);
  const dear = simulateRoute({ origin: 'BOS', destination: 'JFK', weeklyFrequency: 7, tankering: 'off' }, ac, gd, null, 1.0);
  assert.ok(cheap && dear, 'sims ran');
  const perKm = (r, o, d) => r.fuelCost / routeDistanceKm(o, d) / 14;
  assert.ok(near(perKm(cheap, 'JFK', 'LAX') / perKm(dear, 'BOS', 'JFK'), cheap.fuelStationFactor / dear.fuelStationFactor, 0.01));
  setFuelStationsEnabled(false);
});

console.log('\nReducer: routes and the version flag\n');

test('ADD_ROUTE tankers by default only in a v2 save; SET_ROUTE_TANKERING flips it', () => {
  const orig = Math.random; Math.random = makeRng(1);
  try {
    const ac = s60.fleet[0].id;
    const classic = gameReducer({ ...s60, cash: 1e9, gates: { ...s60.gates, BOS: 4 } }, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: 'BOS', weeklyFrequency: 3 });
    const cr = classic.routes.at(-1);
    assert.equal(cr.destination, 'BOS');
    assert.ok(!('tankering' in cr), 'classic route has no tankering key');
    const v2 = gameReducer({ ...V2, cash: 1e9, gates: { ...V2.gates, BOS: 4 } }, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: 'BOS', weeklyFrequency: 3 });
    const vr = v2.routes.at(-1);
    assert.equal(vr.tankering, 'auto');
    const off = gameReducer(v2, { type: 'SET_ROUTE_TANKERING', routeId: vr.id, mode: 'off' });
    assert.equal(off.routes.at(-1).tankering, 'off');
    const on = gameReducer(off, { type: 'SET_ROUTE_TANKERING', routeId: vr.id, mode: 'auto' });
    assert.equal(on.routes.at(-1).tankering, 'auto');
    assert.equal(gameReducer(on, { type: 'SET_ROUTE_TANKERING', routeId: 'nope', mode: 'off' }), on);
  } finally { Math.random = orig; }
});

test('fuelStationsOn reads the version flag', () => {
  assert.equal(fuelStationsOn({ fuelOpsV: 2 }), true);
  assert.equal(fuelStationsOn({ fuelOpsV: 1 }), false);
  assert.equal(fuelStationsOn({}), false);
  assert.equal(fuelStationsOn(null), false);
});

console.log('\nServer\n');

test('worldConfig resolves the version and the guard polices the action', () => {
  assert.equal(fuelOpsVOf({ fuelOpsV: 2 }), 2);
  assert.equal(fuelOpsVOf({}), 1);
  assert.equal(fuelOpsVOf(null), 1);
  const state = { routes: [{ id: 'r1' }], cargoRoutes: [{ id: 'c1' }] };
  assert.deepEqual(guardDecision('SET_ROUTE_TANKERING', { routeId: 'r1', mode: 'auto' }, state), { routeId: 'r1', mode: 'auto' });
  assert.deepEqual(guardDecision('SET_ROUTE_TANKERING', { routeId: 'c1', mode: 'off' }, state), { routeId: 'c1', mode: 'off' });
  assert.throws(() => guardDecision('SET_ROUTE_TANKERING', { routeId: 'zz', mode: 'auto' }, state), GuardError);
  assert.throws(() => guardDecision('SET_ROUTE_TANKERING', { routeId: 'r1', mode: 'yes' }, state), GuardError);
});

setFuelStationsEnabled(false);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
