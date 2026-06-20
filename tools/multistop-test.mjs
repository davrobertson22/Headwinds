// Multi-stop (tag) flight test suite — Phase 1: route geometry data model.
//
// Pure-logic, no bundler required:  node tools/multistop-test.mjs
// Exercises the routeStops/routeLegs/routeSegments helpers, distance/range
// derivation, and normalizeRouteStops migration — covering both legacy
// single-leg routes and A→B→C tag routes.

import assert from 'node:assert/strict';
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { expandRoutesToLegs, buildAllConnections, runNetworkTick } from '../src/models/network.js';
import {
  routeStops, routeLegs, routeSegments, isMultiStop,
  routeTotalDistanceKm, routeMaxLegKm, routeSegmentKey,
  normalizeRouteStops, routeDistanceKm, simulateTagRoute,
  distanceKm, routeBlockHours, routeLandingFee, weeklyBlockHours,
  weeklyTick, referencePrice,
} from '../src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

// Pick three distinct, valid airports with non-zero pairwise distances so the
// test is independent of which specific codes exist in the dataset.
const codes = AIRPORTS.slice(0, 40).map(a => a.code);
const A = codes[0], B = codes[15], C = codes[30];
assert.ok(getAirport(A) && getAirport(B) && getAirport(C), 'need 3 valid airports');

const legacy = { id: 'r1', origin: A, destination: C, aircraftId: 'ac1', weeklyFrequency: 7 };
const tag    = { id: 'r2', origin: A, destination: C, stops: [A, B, C], aircraftId: 'ac1', weeklyFrequency: 7 };

console.log('\n── 1. routeStops / legs / segments ──────────────────────');
test('legacy route derives stops = [origin, destination]', () => {
  assert.deepEqual(routeStops(legacy), [A, C]);
});
test('tag route returns its explicit stops', () => {
  assert.deepEqual(routeStops(tag), [A, B, C]);
});
test('legacy route has exactly one leg', () => {
  assert.deepEqual(routeLegs(legacy), [{ from: A, to: C }]);
});
test('tag route has two legs A-B, B-C', () => {
  assert.deepEqual(routeLegs(tag), [{ from: A, to: B }, { from: B, to: C }]);
});
test('isMultiStop: false for legacy, true for tag', () => {
  assert.equal(isMultiStop(legacy), false);
  assert.equal(isMultiStop(tag), true);
});
test('legacy route serves one segment (A-C)', () => {
  const segs = routeSegments(legacy);
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].from, segs[0].to, segs[0].legSpan], [A, C, 1]);
});
test('tag route serves three segments: A-B, A-C(through), B-C', () => {
  const segs = routeSegments(tag);
  assert.equal(segs.length, 3);
  const keys = segs.map(s => `${s.from}-${s.to}:${s.legSpan}`);
  assert.deepEqual(keys, [`${A}-${B}:1`, `${A}-${C}:2`, `${B}-${C}:1`]);
});
test('through segment A-C is flagged legSpan=2', () => {
  const through = routeSegments(tag).find(s => s.from === A && s.to === C);
  assert.equal(through.legSpan, 2);
});

console.log('\n── 2. distance & range derivation ───────────────────────');
test('total distance = sum of legs (≥ direct, by triangle inequality)', () => {
  const total  = routeTotalDistanceKm(tag);
  const direct = routeDistanceKm(A, C);
  assert.ok(total >= direct - 1, `total ${total} < direct ${direct}`);
  const expected = routeDistanceKm(A, B) + routeDistanceKm(B, C);
  assert.equal(total, expected);
});
test('max leg ≤ total, and is the larger of the two legs', () => {
  const max = routeMaxLegKm(tag);
  assert.equal(max, Math.max(routeDistanceKm(A, B), routeDistanceKm(B, C)));
  assert.ok(max <= routeTotalDistanceKm(tag));
});
test('legacy route: total = max = direct distance', () => {
  assert.equal(routeTotalDistanceKm(legacy), routeDistanceKm(A, C));
  assert.equal(routeMaxLegKm(legacy), routeDistanceKm(A, C));
});

console.log('\n── 3. segment keys ──────────────────────────────────────');
test('routeSegmentKey is directional (A>C ≠ C>A)', () => {
  assert.notEqual(routeSegmentKey(A, C), routeSegmentKey(C, A));
  assert.equal(routeSegmentKey(A, C), `${A}>${C}`);
});

console.log('\n── 4. normalizeRouteStops (migration) ───────────────────');
test('legacy route gains explicit stops without changing ends', () => {
  const n = normalizeRouteStops(legacy);
  assert.deepEqual(n.stops, [A, C]);
  assert.equal(n.origin, A);
  assert.equal(n.destination, C);
});
test('normalize is idempotent on an already-normalized tag route', () => {
  const once  = normalizeRouteStops(tag);
  const twice = normalizeRouteStops(once);
  assert.deepEqual(once, twice);
});
test('normalize re-syncs origin/destination to stops ends', () => {
  const drifted = { origin: 'XXX', destination: 'YYY', stops: [A, B, C] };
  const n = normalizeRouteStops(drifted);
  assert.equal(n.origin, A);
  assert.equal(n.destination, C);
  assert.deepEqual(n.stops, [A, B, C]);
});
test('normalize drops empty/holey stop entries', () => {
  const holey = { origin: A, destination: C, stops: [A, null, undefined, C] };
  const n = normalizeRouteStops(holey);
  assert.deepEqual(n.stops, [A, C]);
});
test('normalize preserves other route fields', () => {
  const n = normalizeRouteStops(tag);
  assert.equal(n.id, 'r2');
  assert.equal(n.aircraftId, 'ac1');
  assert.equal(n.weeklyFrequency, 7);
});

console.log('\n── 5. simulateTagRoute: shared-inventory allocation ─────');

// Three major airports with real demand, forming a sensible tag A→B→C, plus the
// longest-range passenger type so both legs are comfortably within range.
const wanted = ['JFK', 'ORD', 'LAX', 'DFW', 'ATL', 'MIA', 'LHR', 'AMS', 'FRA'];
const major  = wanted.filter(c => getAirport(c));
assert.ok(major.length >= 3, 'need 3 known major airports');
const P = major[0], Q = major[1], R = major[2];              // A→B→C = P→Q→R
const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];

const mkRoute = (extra = {}) => ({
  id: 't1', origin: P, destination: R, stops: [P, Q, R],
  weeklyFrequency: extra.freq ?? 7, weeksOpen: 40, hub: P, ...extra,
});
const mkAc = (config) => ({ id: 'ac', typeId: jet.id, ageWeeks: 52, ...(config ? { config } : {}) });
const seg = (sim, from, to) => sim.segments.find(s => s.from === from && s.to === to);
const thKey = routeSegmentKey(P, R);   // through segment fare key

test('valid tag route returns a sane result', () => {
  const sim = simulateTagRoute(mkRoute(), mkAc(), { month: 6 });
  assert.ok(sim, 'expected non-null');
  assert.equal(sim.tag, true);
  assert.equal(sim.legs.length, 2);
  assert.equal(sim.segments.length, 3);
  assert.ok(sim.passengers > 0, 'some pax');
  assert.ok(Number.isFinite(sim.profit), 'finite profit');
});

test('distance = sum of legs; maxLegKm = larger leg', () => {
  const sim = simulateTagRoute(mkRoute(), mkAc(), { month: 6 });
  // ±1 km: sim rounds the summed leg distances; helper sums rounded legs.
  assert.ok(Math.abs(sim.distance - routeTotalDistanceKm(mkRoute())) <= 1, `${sim.distance} vs ${routeTotalDistanceKm(mkRoute())}`);
  assert.equal(sim.maxLegKm, Math.round(routeMaxLegKm(mkRoute())));
});

test('a leg beyond aircraft range → null', () => {
  const grounded = { ...mkAc(), rangeMod: 0.0001 };  // effective range ≈ 0
  assert.equal(simulateTagRoute(mkRoute(), grounded, { month: 6 }), null);
});

test('per-leg capacity never exceeded (incl. through double-booking)', () => {
  const ac = mkAc({ economy: 5, businessClass: 2, premiumEconomy: 0, firstClass: 0, seatQuality: 'standard', serviceQuality: 'standard' });
  const sim = simulateTagRoute(mkRoute({ freq: 1 }), ac, { month: 6 });
  for (const leg of sim.legs) {
    assert.ok(leg.ecoUsed <= 5, `eco ${leg.ecoUsed} > 5 on ${leg.from}-${leg.to}`);
    assert.ok(leg.bizUsed <= 2, `biz ${leg.bizUsed} > 2 on ${leg.from}-${leg.to}`);
    assert.ok(leg.loadFactor <= 1 + 1e-9, 'LF ≤ 1');
  }
});

test('through pax consume a seat on BOTH legs (locals priced out)', () => {
  // Make the two LOCAL segments absurdly expensive → ~0 local demand. Only the
  // through P–R books, so both legs must carry exactly the through pax.
  const route = mkRoute({ segmentPrices: {
    [routeSegmentKey(P, Q)]: { economy: 1e7, businessClass: 1e7 },
    [routeSegmentKey(Q, R)]: { economy: 1e7, businessClass: 1e7 },
  }});
  const sim = simulateTagRoute(route, mkAc(), { month: 6 });
  const through = seg(sim, P, R);
  assert.ok(through.pax > 0, 'through should book');
  assert.ok(seg(sim, P, Q).pax <= 2, 'local P-Q ~0');
  assert.ok(seg(sim, Q, R).pax <= 2, 'local Q-R ~0');
  // Both legs carry the same load — the through passengers, on each leg.
  assert.equal(sim.legs[0].ecoUsed, sim.legs[1].ecoUsed);
  assert.equal(sim.legs[0].ecoUsed, through.ecoPax);
});

test('through priced out → legs carry locals independently', () => {
  const route = mkRoute({ segmentPrices: {
    [thKey]: { economy: 1e7, businessClass: 1e7 },
  }});
  const sim = simulateTagRoute(route, mkAc(), { month: 6 });
  assert.ok(seg(sim, P, R).pax <= 2, 'through ~0');
  assert.ok(seg(sim, P, Q).pax > 0, 'local P-Q books');
  assert.ok(seg(sim, Q, R).pax > 0, 'local Q-R books');
});

test('passenger revenue identity (revenue − catering = Σ pax×2×fare)', () => {
  const sim = simulateTagRoute(mkRoute(), mkAc(), { month: 6 });
  const paxRev = sim.segments.reduce(
    (s, g) => s + g.ecoPax * 2 * g.ecoFare + g.bizPax * 2 * g.bizFare, 0);
  assert.equal(sim.revenue - sim.cateringRevenue, Math.round(paxRev));
});

test('more frequency → at least as many boarded (capacity-bound)', () => {
  const cfg = { economy: 20, businessClass: 0, premiumEconomy: 0, firstClass: 0 };
  const lo = simulateTagRoute(mkRoute({ freq: 1 }), mkAc(cfg), { month: 6 });
  const hi = simulateTagRoute(mkRoute({ freq: 6 }), mkAc(cfg), { month: 6 });
  assert.ok(hi.passengers >= lo.passengers, `${hi.passengers} < ${lo.passengers}`);
});

test('operating costs are positive and profit is finite', () => {
  const sim = simulateTagRoute(mkRoute(), mkAc(), { month: 6 });
  assert.ok(sim.fuelCost > 0 && sim.crewCost > 0, 'fuel & crew > 0');
  assert.ok(sim.totalOpCost > 0, 'opcost > 0');
  assert.ok(Number.isFinite(sim.profit), 'finite profit');
});

console.log('\n── 6. Phase 3: legs-aware fees, block hours, weeklyTick ─');

const protoOf = (s) => ({ stops: s, origin: s[0], destination: s[s.length - 1] });
const buildSegPrices = (s) => {
  const sp = {};
  for (const g of routeSegments(protoOf(s))) {
    const eco = Math.max(1, Math.round(referencePrice(g.from, g.to)));
    sp[routeSegmentKey(g.from, g.to)] = { economy: eco, businessClass: Math.round(eco * 2.5) };
  }
  return sp;
};

test('routeBlockHours sums both legs (tag > single-leg P–R)', () => {
  const tag    = protoOf([P, Q, R]);
  const single = protoOf([P, R]);
  const bhTag  = routeBlockHours(tag, jet, 7);
  const bhSum  = weeklyBlockHours(routeDistanceKm(P, Q), 7, jet) + weeklyBlockHours(routeDistanceKm(Q, R), 7, jet);
  assert.ok(Math.abs(bhTag - bhSum) < 1e-6, `${bhTag} vs ${bhSum}`);
  assert.ok(bhTag > routeBlockHours(single, jet, 7), 'tag has more block hours than the direct');
});

test('routeLandingFee charges interior stop (tag > direct P–R)', () => {
  const feeTag    = routeLandingFee(protoOf([P, Q, R]), jet, 7);
  const feeDirect = routeLandingFee(protoOf([P, R]), jet, 7);
  assert.ok(feeTag > feeDirect, `${feeTag} ≤ ${feeDirect}`);
  assert.ok(feeTag > 0);
});

const gatesAll = Object.fromEntries(major.map(c => [c, 8]));
const baseState = (extra = {}) => ({
  week: 30, year: 1, cash: 5e6,
  fleet: [], routes: [], cargoRoutes: [],
  gates: gatesAll,
  gameDate: { week: 30, month: 6 }, hub: P, hubs: {}, competitors: [],
  financialHistory: [], awareness: 60, loans: [], activeEvents: [], fuelPrice: { index: 1, history: [] },
  ...extra,
});
const tagRouteState = {
  id: 'tg1', origin: P, destination: R, stops: [P, Q, R],
  aircraftId: 'ac1', weeklyFrequency: 7, weeksOpen: 40, hub: P,
  segmentPrices: buildSegPrices([P, Q, R]), cateringLevel: 'full',
};
const paxAc = { id: 'ac1', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' };

test('weeklyTick runs a tag route into the report (no NaN)', () => {
  const rep = weeklyTick(baseState({ fleet: [paxAc], routes: [tagRouteState] }));
  const rr  = rep.routeResults.find(r => r.routeId === 'tg1');
  assert.ok(rr, 'tag route result present');
  assert.equal(rr.tag, true);
  assert.ok(rr.passengers > 0, 'carried pax');
  assert.ok(rr.landingFee > 0, 'landing fee charged');
  assert.equal(rr.legs.length, 2);
  assert.ok(rep.totalPassengers > 0 && rep.totalRevenue > 0 && rep.totalLandingFees > 0);
  for (const v of [rep.cashDelta, rep.totalRevenue, rep.totalCost]) assert.ok(Number.isFinite(v), 'finite totals');
});

test('tag route is excluded from the single-leg demand pre-pass (self-contained)', () => {
  // A second aircraft flying the same P–R O&D as a plain route must not be
  // distorted by the tag route sharing endpoints — the tag self-contains its split.
  const direct = { id: 'd1', origin: P, destination: R, stops: [P, R], aircraftId: 'ac2', weeklyFrequency: 7, weeksOpen: 40, hub: P };
  const ac2 = { id: 'ac2', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' };
  const rep = weeklyTick(baseState({
    fleet: [paxAc, ac2],
    routes: [tagRouteState, direct],
    routePricing: { [routeSegmentKey(P, R).replace('>', '-')]: undefined },
  }));
  const tagR    = rep.routeResults.find(r => r.routeId === 'tg1');
  const directR = rep.routeResults.find(r => r.routeId === 'd1');
  assert.ok(tagR && directR, 'both routes simulated');
  assert.equal(tagR.tag, true);
  assert.ok(!directR.tag, 'direct route uses single-leg path');
  assert.ok(directR.passengers > 0 && tagR.passengers > 0);
});

console.log('\n── 7. Phase 5: tag legs in the network model ────────────');

const D = major[3];   // a fourth airport for cross-route connections
const tagRoute    = { id: 'tg', origin: P, destination: R, stops: [P, Q, R], weeklyFrequency: 7 };
const spokeRoute  = { id: 'sp', origin: R, destination: D, weeklyFrequency: 7 };
const EMPTY_PMAP  = new Map();

test('expandRoutesToLegs splits a tag into legs, leaves single-leg routes intact', () => {
  const legs = expandRoutesToLegs([tagRoute, spokeRoute]);
  const tagLegs = legs.filter(l => l._tagParentId === 'tg');
  assert.equal(tagLegs.length, 2);
  assert.deepEqual(tagLegs.map(l => `${l.origin}-${l.to ?? l.destination}`), [`${P}-${Q}`, `${Q}-${R}`]);
  const spoke = legs.find(l => l.origin === R && l.destination === D);
  assert.ok(spoke && spoke._tagParentId === undefined, 'single-leg route passes through unchanged');
});

test('a lone tag route forms NO connections (its own through is skipped)', () => {
  // Otherwise A→B→C over hub B would double-book the through market.
  const conns = buildAllConnections([tagRoute], [], EMPTY_PMAP);
  assert.equal(conns.length, 0, `expected 0, got ${conns.length}`);
});

test('a tag leg feeds a connection with a separate spoke route', () => {
  // Tag P→Q→R plus a spoke R→D: passengers can connect Q→D (and P→D) over hub R.
  const conns = buildAllConnections([tagRoute, spokeRoute], [], EMPTY_PMAP);
  const overR = conns.filter(c => c.hub === R && c.legTwoDest === D);
  assert.ok(overR.length > 0, 'expected a connection over hub R to D');
  // None of the returned connections should be a tag flight feeding its own metal
  // over its own intermediate stop Q.
  assert.ok(!conns.some(c => c.hub === Q), 'no self-connection over the tag’s own stop');
});

test('runNetworkTick handles a state containing tag routes without throwing', () => {
  const out = runNetworkTick({
    routes: [tagRoute, spokeRoute], competitors: [], gameDate: { month: 6 },
  });
  assert.ok(out.connections.length > 0, 'connections enumerated');
  assert.ok(out.cannibalizationMap && typeof out.cannibalizationMap === 'object');
  assert.ok(Number.isFinite(out.partnerODRevenue.totalRevenue));
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
