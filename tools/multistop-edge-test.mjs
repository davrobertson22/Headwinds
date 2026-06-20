// Adversarial / edge-case suite for the multi-stop feature.
// Targets cases the happy-path tests don't cover:
//   • 4-stop tag routes (through pax spanning 3 legs)
//   • business-cabin allocation + revenue identity
//   • partial segment pricing
//   • mixed single-leg + tag fleet through weeklyTick
//   • network self-connection skipping on a 4-stop route
//
//   node tools/multistop-edge-test.mjs

import assert from 'node:assert/strict';
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import {
  simulateTagRoute, routeSegments, routeSegmentKey, distanceKm,
  weeklyTick, referencePrice, routeLandingFee,
} from '../src/utils/simulation.js';
import { buildAllConnections, runNetworkTick } from '../src/models/network.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const major = ['JFK', 'ORD', 'LAX', 'DFW', 'ATL', 'MIA'].filter(c => getAirport(c));
const [P, Q, R, D] = major;
const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const mkAc = (config) => ({ id: 'ac', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned', ...(config ? { config } : {}) });
const proto = (s) => ({ stops: s, origin: s[0], destination: s[s.length - 1] });
const segPricesAllRef = (s, overrides = {}) => {
  const sp = {};
  for (const g of routeSegments(proto(s))) {
    const key = routeSegmentKey(g.from, g.to);
    const eco = Math.max(1, Math.round(overrides[key] ?? referencePrice(g.from, g.to)));
    sp[key] = { economy: eco, businessClass: Math.round(eco * 2.5) };
  }
  return sp;
};
const tag4 = (extra = {}) => ({
  id: 't4', origin: P, destination: D, stops: [P, Q, R, D],
  weeklyFrequency: extra.freq ?? 7, weeksOpen: 40, hub: P,
  segmentPrices: extra.segmentPrices ?? segPricesAllRef([P, Q, R, D]),
  cateringLevel: 'full', ...extra,
});

console.log('\n── 1. 4-stop tag route (3 legs, 6 segments) ─────────────');

test('serves 6 segments and 3 legs', () => {
  const sim = simulateTagRoute(tag4(), mkAc(), { month: 6 });
  assert.ok(sim, 'non-null');
  assert.equal(sim.legs.length, 3);
  assert.equal(sim.segments.length, 6);
});

test('per-leg capacity never exceeded on any of the 3 legs', () => {
  const sim = simulateTagRoute(tag4({ freq: 1 }), mkAc({ economy: 6, businessClass: 2, premiumEconomy: 0, firstClass: 0 }), { month: 6 });
  for (const l of sim.legs) {
    assert.ok(l.ecoUsed <= 6, `eco ${l.ecoUsed} on ${l.from}-${l.to}`);
    assert.ok(l.bizUsed <= 2, `biz ${l.bizUsed} on ${l.from}-${l.to}`);
    assert.ok(l.loadFactor <= 1 + 1e-9);
  }
});

test('a 3-leg through passenger consumes a seat on ALL three legs', () => {
  // Price every market except the full-length through P→D out of the market.
  const overrides = {};
  for (const g of routeSegments(proto([P, Q, R, D]))) {
    if (!(g.from === P && g.to === D)) overrides[routeSegmentKey(g.from, g.to)] = 1e7;
  }
  const sim = simulateTagRoute(tag4({ segmentPrices: segPricesAllRef([P, Q, R, D], overrides) }), mkAc(), { month: 6 });
  const through = sim.segments.find(s => s.from === P && s.to === D);
  assert.ok(through.pax > 0, 'through P→D books');
  // All three legs carry exactly the through passengers.
  assert.equal(sim.legs[0].ecoUsed, through.ecoPax);
  assert.equal(sim.legs[1].ecoUsed, through.ecoPax);
  assert.equal(sim.legs[2].ecoUsed, through.ecoPax);
});

console.log('\n── 2. business cabin + revenue identity ─────────────────');

test('revenue identity holds with a business cabin', () => {
  const sim = simulateTagRoute(tag4(), mkAc({ economy: 120, businessClass: 24, premiumEconomy: 0, firstClass: 0 }), { month: 6 });
  const paxRev = sim.segments.reduce((s, g) => s + g.ecoPax * 2 * g.ecoFare + g.bizPax * 2 * g.bizFare, 0);
  assert.equal(sim.revenue - sim.cateringRevenue, Math.round(paxRev));
  assert.ok(sim.segments.some(g => g.bizPax > 0), 'some business pax booked');
});

console.log('\n── 3. partial / missing segment pricing ─────────────────');

test('missing segment fares fall back to reference price (no NaN)', () => {
  // Only price the through P→D; leave the rest undefined.
  const key = routeSegmentKey(P, D);
  const sim = simulateTagRoute(tag4({ segmentPrices: { [key]: { economy: 500 } } }), mkAc(), { month: 6 });
  assert.ok(sim && Number.isFinite(sim.revenue) && Number.isFinite(sim.profit));
  for (const g of sim.segments) assert.ok(g.ecoFare >= 1, `fare ${g.ecoFare} on ${g.from}-${g.to}`);
});

test('route with no segmentPrices at all still simulates', () => {
  const sim = simulateTagRoute({ stops: [P, Q, R], origin: P, destination: R, weeklyFrequency: 7, weeksOpen: 40 }, mkAc(), { month: 6 });
  assert.ok(sim && sim.passengers >= 0 && Number.isFinite(sim.revenue));
});

console.log('\n── 4. weeklyTick: mixed single-leg + tag fleet ──────────');

const gatesAll = Object.fromEntries(major.map(c => [c, 8]));
const baseState = (over) => ({
  week: 30, year: 1, cash: 5e6, fleet: [], routes: [], cargoRoutes: [],
  gates: gatesAll, gameDate: { week: 30, month: 6 }, hub: P, hubs: {}, competitors: [],
  financialHistory: [], awareness: 60, loans: [], activeEvents: [], fuelPrice: { index: 1, history: [] },
  ...over,
});

test('tick runs a tag + a single-leg route together; totals are finite & positive', () => {
  const tag = tag4();
  const single = { id: 's1', origin: R, destination: D, stops: [R, D], aircraftId: 'ac2', weeklyFrequency: 7, weeksOpen: 40, hub: P };
  const singleKey = [R, D].sort().join('-');
  const rep = weeklyTick(baseState({
    fleet: [{ ...mkAc(), id: 'ac' }, { id: 'ac2', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' }],
    routes: [{ ...tag, aircraftId: 'ac' }, single],
    routePricing: { [singleKey]: { economy: Math.round(referencePrice(R, D)) } },  // as the real game stores it
  }));
  const tagR = rep.routeResults.find(r => r.routeId === 't4');
  const sglR = rep.routeResults.find(r => r.routeId === 's1');
  assert.ok(tagR?.tag === true, 'tag result present');
  assert.ok(sglR && !sglR.tag, 'single-leg result present');
  for (const v of [rep.cashDelta, rep.totalRevenue, rep.totalCost, rep.totalPassengers, rep.totalLandingFees, rep.totalConnecting]) {
    assert.ok(Number.isFinite(v), 'finite ' + v);
  }
  assert.ok(rep.totalRevenue > 0 && rep.totalPassengers > 0 && rep.totalLandingFees > 0);
});

test('tick stays finite even if a single-leg route is missing its pair pricing', () => {
  // Hardening guard: a malformed/legacy route without routePricing must not NaN.
  const single = { id: 's2', origin: R, destination: D, stops: [R, D], aircraftId: 'ac2', weeklyFrequency: 7, weeksOpen: 40, hub: P };
  const rep = weeklyTick(baseState({
    fleet: [{ id: 'ac2', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' }],
    routes: [single],   // deliberately NO routePricing
  }));
  for (const v of [rep.cashDelta, rep.totalRevenue, rep.totalConnecting]) assert.ok(Number.isFinite(v), 'finite ' + v);
});

test('grounded aircraft on a tag route earns nothing that week', () => {
  const tag = { ...tag4(), aircraftId: 'ac' };
  const rep = weeklyTick(baseState({
    fleet: [{ ...mkAc(), id: 'ac', status: 'grounded' }],
    routes: [tag],
  }));
  assert.ok(!rep.routeResults.find(r => r.routeId === 't4'), 'grounded tag route skipped');
});

console.log('\n── 5. network: 4-stop self-connections skipped ──────────');

test('a lone 4-stop tag forms NO connections (all internal, same parent)', () => {
  const conns = buildAllConnections([tag4()], [], new Map());
  assert.equal(conns.length, 0, `expected 0, got ${conns.length}`);
});

test('4-stop tag + external spoke forms a connection over the shared stop', () => {
  const spoke = { id: 'sp', origin: R, destination: major[4] ?? P, weeklyFrequency: 7 };
  const dest  = spoke.destination;
  const conns = buildAllConnections([tag4(), spoke], [], new Map());
  assert.ok(conns.some(c => c.hub === R && c.legTwoDest === dest), 'connection over R to spoke dest');
});

test('runNetworkTick with a 4-stop tag does not throw and yields finite revenue', () => {
  const out = runNetworkTick({ routes: [tag4()], competitors: [], gameDate: { month: 6 } });
  assert.ok(Number.isFinite(out.partnerODRevenue.totalRevenue));
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
