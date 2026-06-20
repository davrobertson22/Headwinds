// Cargo system test suite.
//
// Pure-logic, no bundler required:  node tools/cargo-test.mjs   (or: npm run test:cargo)
// Exercises the cargo demand model, freighter data, simulateCargoRoute, the weeklyTick
// integration, and the canonical projectWeek() the Dashboard/Finance read from.

import assert from 'node:assert/strict';
import {
  AIRCRAFT_TYPES, AIRCRAFT_CATEGORIES, getAircraftType,
  seatEfficiency, efficiencyScore, EFFICIENCY_BEST, EFFICIENCY_WORST,
} from '../src/data/aircraft.js';
import { getAirportCargoScore, getAirportScores, CARGO_SCORES } from '../src/data/airports.js';
import {
  cargoCityPairDemand, cargoReferenceYield, routeDistance,
  CARGO_YIELD_FLOOR, CARGO_YIELD_CAP,
} from '../src/utils/market.js';
import {
  simulateCargoRoute, weeklyTick, referencePrice,
  CARGO_BACKHAUL_FACTOR, FREIGHTER_CAPTURE_RATE,
} from '../src/utils/simulation.js';
import { cargoReferenceYield as cy } from '../src/utils/market.js';
import { projectWeek } from '../src/utils/financeProjection.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
const approx = (a, b, tolPct = 1) => Math.abs(a - b) <= Math.abs(b) * tolPct / 100 + 1;

const freighter = (typeId, opts = {}) => ({ id: opts.id ?? 'f', typeId, status: opts.status ?? 'assigned', ageWeeks: opts.ageWeeks ?? 52, ownershipType: opts.own ?? 'owned', ...opts });
const cRoute = (o, d, ac, freq = 7, opts = {}) => ({ id: opts.id ?? `c-${o}${d}`, origin: o, destination: d, aircraftId: ac, yieldPrice: opts.yieldPrice ?? cy(o, d), weeklyFrequency: freq, weeksOpen: opts.weeksOpen ?? 30, cargo: true });

console.log('\n── 1. Freighter fleet data ──────────────────────────────');
const freighters = AIRCRAFT_TYPES.filter(t => t.freighter);
test('at least 9 freighter types exist', () => assert.ok(freighters.length >= 9, `got ${freighters.length}`));
test('every freighter has positive payloadTonnes and range, zero seats', () => {
  for (const t of freighters) {
    assert.ok(t.payloadTonnes > 0, `${t.id} payload`);
    assert.ok(t.range > 0, `${t.id} range`);
    assert.equal(t.seats, 0, `${t.id} seats`);
  }
});
test('"Freighter" is a market category', () => assert.ok(AIRCRAFT_CATEGORIES.includes('Freighter')));
test('seatEfficiency is null for freighters (no seats)', () => assert.equal(seatEfficiency(getAircraftType('b777f')), null));
test('efficiencyScore is null for freighters', () => assert.equal(efficiencyScore(getAircraftType('b777f')), null));
test('fleet efficiency bounds stay finite (freighters excluded)', () => {
  assert.ok(Number.isFinite(EFFICIENCY_BEST) && Number.isFinite(EFFICIENCY_WORST));
});
test('headline freighters present (777F, 747-8F, An-225)', () => {
  for (const id of ['b777f', 'b7478f', 'an225']) assert.ok(getAircraftType(id)?.freighter, id);
});

console.log('\n── 2. Cargo scores ──────────────────────────────────────');
test('major freight hubs have explicit high scores', () => {
  assert.equal(getAirportCargoScore('HKG'), CARGO_SCORES.HKG);
  assert.ok(getAirportCargoScore('HKG') >= 90);
  assert.ok(getAirportCargoScore('MEM') >= 90);   // FedEx superhub, tiny pax
});
test('unlisted airport derives a positive score from businessScore', () => {
  const s = getAirportCargoScore('AUS');
  assert.ok(s > 0 && s <= 100, `got ${s}`);
});
test('pure-leisure airport scores low on cargo', () => {
  assert.ok(getAirportCargoScore('CUN') < 20, `got ${getAirportCargoScore('CUN')}`);
});

console.log('\n── 3. Cargo demand & yield ──────────────────────────────');
test('trade lanes generate positive tonnage', () => assert.ok(cargoCityPairDemand('HKG', 'FRA') > 200));
test('demand is symmetric (o,d order ignored in v1)', () => {
  assert.equal(cargoCityPairDemand('HKG', 'FRA'), cargoCityPairDemand('FRA', 'HKG'));
});
test('leisure pair generates little cargo', () => assert.ok(cargoCityPairDemand('LAS', 'MCO') < 150));
test('reference yield within [floor, cap]', () => {
  for (const [o, d] of [['HKG', 'FRA'], ['HKG', 'SIN'], ['FRA', 'LHR']]) {
    const y = cargoReferenceYield(o, d);
    assert.ok(y >= CARGO_YIELD_FLOOR - 1e-9 && y <= CARGO_YIELD_CAP + 1e-9, `${o}-${d} yield ${y}`);
  }
});
test('yield is higher on short lanes than long lanes', () => {
  assert.ok(cargoReferenceYield('FRA', 'LHR') > cargoReferenceYield('HKG', 'LAX'));
});

console.log('\n── 4. simulateCargoRoute ────────────────────────────────');
test('returns null for a non-freighter aircraft', () => {
  assert.equal(simulateCargoRoute(cRoute('HKG', 'FRA', 'x'), { id: 'x', typeId: 'a350900' }, { month: 6 }), null);
});
test('returns null when route exceeds freighter range', () => {
  // HKG-JFK ~12,980 km > 777F range 9,200 km
  assert.equal(simulateCargoRoute(cRoute('HKG', 'JFK', 'f'), freighter('b777f'), { month: 6 }), null);
});
test('tonnes carried never exceed capacity (payload × freq)', () => {
  const ac = freighter('b777f');
  const r = simulateCargoRoute(cRoute('HKG', 'FRA', 'f'), ac, { month: 6 });
  assert.ok(r.tonnes <= getAircraftType('b777f').payloadTonnes * 7 + 1);
  assert.ok(r.loadFactor <= 1.0001);
});
test('capacity-bound marquee lane runs at ~100% load', () => {
  const r = simulateCargoRoute(cRoute('HKG', 'FRA', 'f'), freighter('b777f'), { month: 6 });
  assert.ok(r.loadFactor > 0.99);
});
test('revenue applies backhaul factor (1+f), not double headhaul', () => {
  const r = simulateCargoRoute(cRoute('HKG', 'FRA', 'f'), freighter('b777f'), { month: 6 });
  const expectBackhaul = r.tonnes * (1 + CARGO_BACKHAUL_FACTOR) * r.distance * r.yieldPrice;
  const expectDouble   = r.tonnes * 2 * r.distance * r.yieldPrice;
  assert.ok(approx(r.revenue, expectBackhaul, 1), `rev ${r.revenue} vs backhaul ${Math.round(expectBackhaul)}`);
  assert.ok(!approx(r.revenue, expectDouble, 1), 'revenue should NOT equal full double-direction');
});
test('higher yield reduces tonnage on an uncapped lane (elasticity)', () => {
  // 747-8F (137t × 7 = 959 cap) on NBO-AMS (~837 t demand) → not capacity-bound
  const ac = freighter('b7478f');
  const base = simulateCargoRoute(cRoute('NBO', 'AMS', 'f', 7), ac, { month: 6 });
  const hi   = simulateCargoRoute({ ...cRoute('NBO', 'AMS', 'f', 7), yieldPrice: cy('NBO', 'AMS') * 2 }, ac, { month: 6 });
  assert.ok(base.loadFactor < 0.999, `expected uncapped, LF ${base.loadFactor}`);
  assert.ok(hi.tonnes < base.tonnes, `hi ${hi.tonnes} should be < base ${base.tonnes}`);
});
test('awareness multiplier reduces demand on an uncapped lane', () => {
  const ac = freighter('b7478f');
  const full = simulateCargoRoute(cRoute('NBO', 'AMS', 'f', 7), ac, { month: 6 }, null, 1.0, 1.0);
  const low  = simulateCargoRoute(cRoute('NBO', 'AMS', 'f', 7), ac, { month: 6 }, null, 1.0, 0.45);
  assert.ok(low.tonnes < full.tonnes, `low ${low.tonnes} should be < full ${full.tonnes}`);
});
test('profit = revenue − operating cost; all fields finite', () => {
  const r = simulateCargoRoute(cRoute('ANC', 'LAX', 'f'), freighter('b777f'), { month: 6 });
  assert.equal(r.profit, r.revenue - r.totalOpCost);
  for (const k of ['revenue', 'fuelCost', 'crewCost', 'groundHandlingCost', 'tonnes', 'loadFactor']) {
    assert.ok(Number.isFinite(r[k]), `${k} not finite`);
  }
});
test('FREIGHTER_CAPTURE_RATE is 1.0 (belly out of scope for v1)', () => assert.equal(FREIGHTER_CAPTURE_RATE, 1.0));

console.log('\n── 5. weeklyTick integration ────────────────────────────');
const baseState = (extra = {}) => ({
  week: 30, year: 1, cash: 5e6,
  fleet: [], routes: [], cargoRoutes: [],
  gates: { HKG: 8, FRA: 6, ANC: 6, LAX: 6, SIN: 6, SYD: 6, LHR: 6 },
  gameDate: { week: 30, month: 6 }, hub: 'HKG', hubs: {}, competitors: [],
  financialHistory: [], awareness: 60, loans: [], activeEvents: [], fuelPrice: { index: 1, history: [] },
  ...extra,
});
test('cargo revenue & costs fold into report totals (no NaN)', () => {
  const ac = freighter('b777f', { id: 'f1' });
  const rep = weeklyTick(baseState({ fleet: [ac], cargoRoutes: [cRoute('HKG', 'FRA', 'f1')] }));
  assert.equal(rep.cargoRouteResults.length, 1);
  assert.ok(rep.totalCargoRevenue > 0 && rep.totalCargoTonnes > 0);
  assert.ok(rep.totalRevenue >= rep.totalCargoRevenue, 'cargo rev is part of total rev');
  assert.ok(rep.totalFuel > 0 && rep.totalCrew > 0 && rep.totalGroundHandling > 0 && rep.totalLandingFees > 0);
  for (const v of [rep.cashDelta, rep.totalRevenue, rep.totalCost, rep.totalCargoProfit]) assert.ok(Number.isFinite(v));
});
test('adding a cargo route raises total revenue by the cargo revenue', () => {
  const ac = freighter('b777f', { id: 'f1' });
  const without = weeklyTick(baseState({ fleet: [ac] }));
  const withCargo = weeklyTick(baseState({ fleet: [ac], cargoRoutes: [cRoute('HKG', 'FRA', 'f1')] }));
  const delta = withCargo.totalRevenue - without.totalRevenue;
  assert.ok(approx(delta, withCargo.totalCargoRevenue, 1), `rev delta ${delta} vs cargo ${withCargo.totalCargoRevenue}`);
});
test('grounded freighter and out-of-range cargo route are skipped', () => {
  const grounded = freighter('atr72f', { id: 'g1', status: 'grounded' });
  const ok = freighter('b777f', { id: 'f1' });
  const rep = weeklyTick(baseState({
    fleet: [grounded, ok],
    cargoRoutes: [
      cRoute('HKG', 'FRA', 'f1'),          // ok
      cRoute('HKG', 'JFK', 'f1'),          // out of range -> skipped
      cRoute('SIN', 'SYD', 'g1'),          // grounded aircraft -> skipped
    ],
  }));
  assert.equal(rep.cargoRouteResults.length, 1);
  assert.equal(rep.cargoRouteResults[0].routeId, 'c-HKGFRA');
});

console.log('\n── 6. projectWeek (Dashboard/Finance source of truth) ───');
test('projectWeek includes cargo and returns finite netCash', () => {
  const ac = freighter('b777f', { id: 'f1' });
  const p = projectWeek(baseState({ fleet: [ac], cargoRoutes: [cRoute('HKG', 'FRA', 'f1')] }));
  assert.ok(Number.isFinite(p.netCash) && Number.isFinite(p.effectiveRevenue));
  assert.ok(p.report.totalCargoRevenue > 0);
  assert.ok(p.effectiveRevenue >= p.report.totalCargoRevenue);
});
test('projected revenue rises when a cargo route is added', () => {
  const ac = freighter('b777f', { id: 'f1' });
  const a = projectWeek(baseState({ fleet: [ac] }));
  const b = projectWeek(baseState({ fleet: [ac], cargoRoutes: [cRoute('HKG', 'FRA', 'f1')] }));
  assert.ok(b.effectiveRevenue > a.effectiveRevenue);
});

console.log(`\n──────────────────────────────────────────────\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
