// design-age-quality-test.mjs — era worlds mark down an old DESIGN.
//
// Airframe age (fleetAgeYears) bottoms out at ~13 years and knows nothing
// about the type, so in an era world a 1950s design kept flying into the 2000s
// scored like any other 13-year-old frame, and a used 707 delivered young in
// 2000 scored nearly like a new A320. designAgeQualityPts adds a type-vintage
// term: 0 for 15 years after EIS, then −1/yr to −20 at 35 years. Classic
// worlds (calendar year null) must be untouched — the era parity invariant.
//
//   node --import ./tools/_register-loader.mjs tools/design-age-quality-test.mjs

import assert from 'node:assert/strict';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  designAgeQualityPts, computeQualityScore,
  DESIGN_AGE_GRACE_YEARS, DESIGN_AGE_CAP_YEARS, DESIGN_AGE_MAX_PENALTY,
} from '../packages/engine/src/models/demand.js';
import { routeQualityBreakdown, simulateRoute, hydrateRoute } from '../packages/engine/src/utils/simulation.js';
import { setEraCalendarYear } from '../packages/engine/src/utils/market.js';

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
  finally { setEraCalendarYear(null); }
}

const B707 = getAircraftType('b707120');
const NEO  = getAircraftType('a320neo');
assert.ok(B707?.eis === 1958, 'fixture needs the 707-120 (EIS 1958)');
assert.ok(NEO?.eis != null, 'fixture needs the A320neo');

console.log('\nDesign age marks down old types in era worlds\n');

test('the curve: grace, then a point a year, capped', () => {
  assert.equal(DESIGN_AGE_GRACE_YEARS, 15);
  assert.equal(DESIGN_AGE_CAP_YEARS, 35);
  assert.equal(DESIGN_AGE_MAX_PENALTY, 20);
  const at = (y) => designAgeQualityPts(B707, y) + 0;   // normalise -0
  assert.equal(at(1958), 0);
  assert.equal(at(1973), 0, 'still inside the grace period at 15 years');
  assert.equal(at(1974), -1);
  assert.equal(at(1983), -10);
  assert.equal(at(1993), -20, 'full penalty at 35 years');
  assert.equal(at(2010), -20, 'capped');
});

test('classic worlds and types without an EIS are untouched', () => {
  assert.equal(designAgeQualityPts(B707, null), 0);
  setEraCalendarYear(null);
  assert.equal(designAgeQualityPts(B707), 0, 'default reads the era calendar — null in classic');
  assert.equal(designAgeQualityPts({ id: 'x' }, 2000), 0);
  assert.equal(designAgeQualityPts(null, 2000), 0);
  const base = { onTimeRate: 0.85, cabinPoints: 0, fleetAgeYears: 5, customerRating: 3.5 };
  assert.equal(computeQualityScore(base), computeQualityScore({ ...base, designAgePts: 0 }));
});

test('supersonic is exempt (Concorde has nothing newer to move to)', () => {
  const concorde = getAircraftType('concorde');
  assert.ok(concorde?.category === 'Supersonic', 'fixture needs Concorde');
  assert.equal(designAgeQualityPts(concorde, 2003), 0);
});

test('a current design pays nothing', () => {
  assert.equal(designAgeQualityPts(NEO, 2026) + 0, 0);
  assert.equal(designAgeQualityPts(NEO, NEO.eis + DESIGN_AGE_GRACE_YEARS) + 0, 0);
});

test('the default argument follows the published era calendar', () => {
  setEraCalendarYear(1983);
  assert.equal(designAgeQualityPts(B707), -10);
});

// ── Engine wiring: the same 707 on the same route, classic vs a 2000 world ──
const ORIGIN = 'JFK', DEST = 'ORD';
function flying707() {
  let s = {
    ...freshState(), cash: 500_000_000, hub: ORIGIN,
    hubs: { [ORIGIN]: { tier: 1 } },
    gates: { [ORIGIN]: 4, [DEST]: 4 },
    fleet: [{ id: 'a1', typeId: B707.id, tailNumber: 'N707A', name: 'Test', status: 'idle',
              ageWeeks: 0, ownershipType: 'owned', reserveBase: null }],
    routes: [], cargoRoutes: [], newsLog: [], pendingToasts: [],
  };
  s = gameReducer(s, {
    type: 'ADD_ROUTE', origin: ORIGIN, destination: DEST, aircraftId: 'a1',
    weeklyFrequency: 7, ticketPrice: 250, cateringLevel: 'standard', season: null,
  });
  assert.equal(s.routes.length, 1, 'fixture: ADD_ROUTE did not open the route');
  return s;
}

test('the route quality breakdown carries the design-age row', () => {
  const s = flying707();
  const route = s.routes[0], ac = s.fleet[0];
  setEraCalendarYear(null);
  const classic = routeQualityBreakdown(route, ac, s);
  assert.equal(classic.designAgePts + 0, 0);
  setEraCalendarYear(2000);
  const era = routeQualityBreakdown(route, ac, s);
  assert.equal(era.designAgePts, -20);
  assert.equal(era.designEis, 1958);
  assert.ok(era.total < classic.total, `quality ${era.total} should be below classic ${classic.total}`);
  assert.equal(classic.raw - era.raw, 20, 'raw score drops by exactly the penalty (unclamped here)');
});

// Quality moves share in a CONTESTED market (on a monopoly it only reaches the
// business pool), so put a rival on the pair.
const RIVAL = [{
  id: 'rival', name: 'Rival', tier: 'legacy', baseQualityScore: 65,
  routes: { [[ORIGIN, DEST].sort().join('-')]: { frequency: 200, priceMultiplier: 1.0, seats: 400 } },
}];

test('simulateRoute: an obsolete design loses share to a rival', () => {
  const s = flying707();
  // Priced as the tick sees it (fares live in state.routePricing), mature, and
  // flown often enough that the player's share — not its seats — is the limit.
  const route = { ...hydrateRoute(s.routes[0], s.routePricing ?? {}, s.routeCatering ?? {}),
                  weeksOpen: 52, weeklyFrequency: 28 };
  const ac = s.fleet[0];
  const run = () => simulateRoute(route, ac, { month: 6 }, null, 1.0, null, [], null, null, 1.0, null, RIVAL);
  setEraCalendarYear(null);
  const classic = run();
  setEraCalendarYear(2000);
  const era = run();
  assert.ok(classic && era, 'route must simulate');
  assert.equal(classic.competitorCount, 1, 'fixture: the rival must be on the pair');
  assert.equal(classic.qualityScore - era.qualityScore, 20, 'the tick scores the route 20 points lower');
  assert.ok(classic.passengers > 0, 'fixture: the classic route must carry passengers');
  assert.ok(classic.passengers < classic.configuredSeatsOneWay * 0.8, 'fixture: route must be share-bound, not seat-bound');
  assert.ok(era.passengers < classic.passengers, `pax ${era.passengers} should be below classic ${classic.passengers}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
