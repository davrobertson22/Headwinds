// Route projection ↔ weekly tick agreement.
//
// The "Open New Route" form and RoutePlanner used to forecast a route with a
// bare simulateRoute(spec, aircraft, gameDate) — which asks the demand model
// "what would this aircraft carry if it were alone in this market?". On a pair
// the player ALREADY FLIES, the honest answer to that question is "the whole
// pool", so opening a fourth SFO-ATL frequency previewed at 100% load / 2,050
// pax and then got booked a fraction of it by the tick's multi-aircraft
// pre-pass. Four things were missing, all of which weeklyTick applies:
//
//   1. lane pooling      one combined offer per pair, split by seat share
//   2. the maturity ramp a new pair opens at 0.55 of mature demand (16 weeks)
//   3. the NWR ceiling   restricted worlds spill against an achievable ceiling,
//                        so 100% is unreachable — parity is ~87%, asymptote 95%
//   4. rivals            humans / encroachers contesting the pair
//
// Plus a fifth, found while wiring this up: simulateRoute built its AI rival
// offers from the COMPETITOR_AIRLINES module constant, whose `.routes` is `{}`
// for every entry and is never populated in place (sampleAndInitializeCompetitors
// fills COPIES). buildCompetitorOffer bailed 70 times out of 70. Headwinds is
// unaffected — it seeds `competitors: []` deliberately and competes humans-only
// — but the branch was dead, and a preview built on the live bank would have
// disagreed with a tick built on the dead one.
//
//   node tools/route-projection-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import {
  weeklyTick, simulateRoute, referencePrice,
} from '../packages/engine/src/utils/simulation.js';
import {
  projectRouteAddition, PREVIEW_ROUTE_ID,
} from '../packages/engine/src/models/pairShare.js';
import {
  buildRouteMarket, buildCompetitorOffer, sampleAndInitializeCompetitors,
  COMPETITOR_AIRLINES,
} from '../packages/engine/src/models/demand.js';
import { pairMarketShare } from '../packages/engine/src/models/pairShare.js';
import { NWR_LF_CEILING } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

// ── Fixture ───────────────────────────────────────────────────────────────────
// A trunk pair with plenty of demand, flown by a narrowbody. The pair is chosen
// so a single aircraft at this frequency is capacity-capped: that is exactly the
// case where a bare simulateRoute reports a flat 100% and cannot tell you what
// a SECOND aircraft on the same pair would actually get.

const jet = AIRCRAFT_TYPES
  .filter(t => !t.freighter && t.seats >= 150 && t.seats <= 240)
  .sort((a, b) => b.range - a.range)[0];
assert.ok(jet, 'fixture needs a narrowbody');

const O = 'SFO', D = 'ATL';
assert.ok(getAirport(O) && getAirport(D), 'fixture airports exist');
const FARE = Math.round(referencePrice(O, D));
const FREQ = 10;
// A pair this thick swallows 10 narrowbody frequencies whole: at FREQ the route
// is capacity-capped, so demand-side effects (maturity, rivals) move the POOL
// without moving a single carried passenger. That is a real property of the
// model — and exactly why the old form printed a flat 100.0% — but it makes a
// useless probe. Tests that need to SEE demand move fly enough seats to outrun
// the pool.
const FREQ_UNCAPPED = 45;

const mkAircraft = (id) => ({
  id, typeId: jet.id, status: 'active', ownershipType: 'owned',
  ageWeeks: 40, config: { economy: jet.seats },
});
const mkRoute = (id, aircraftId, weeksOpen = 40, freq = FREQ) => ({
  id, origin: O, destination: D, aircraftId,
  weeklyFrequency: freq, weeksOpen, hub: O,
  ticketPrice: FARE, classPrices: { economy: FARE },
});

/** A world with `n` aircraft already flying O-D, plus one spare to deploy. */
function fixture({ existing = 1, restricted = false } = {}) {
  const fleet  = [];
  const routes = [];
  for (let i = 0; i < existing; i++) {
    fleet.push(mkAircraft(`ac${i}`));
    routes.push(mkRoute(`r${i}`, `ac${i}`));
  }
  const spare = mkAircraft('spare');
  fleet.push(spare);
  return {
    state: {
      fleet, routes, cargoRoutes: [],
      gates: { [O]: 40, [D]: 40 }, hubs: {}, hub: O,
      competitors: [], humanRivals: {}, encroachments: {},
      routePricing: { [[O, D].sort().join('-')]: { economy: FARE } },
      gameDate: { month: 6 }, absWeek: 40,
      ...(restricted ? { newWorldRestrictions: true } : {}),
    },
    spare,
  };
}

/** What the tick ACTUALLY books for the newly-added route. */
function actualAfterOpening(state, spare) {
  const opened = mkRoute('new', spare.id, 40);
  const r = weeklyTick({ ...state, routes: [...state.routes, opened] });
  return r.routeResults.find(rr => rr.routeId === 'new');
}

// ── 1. Pooling: the headline bug ──────────────────────────────────────────────
console.log('\nLane pooling — a second tail does not get its own market');

test('projection of an added tail matches what the tick books it', () => {
  const { state, spare } = fixture({ existing: 1 });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ,
    ticketPrice: FARE, classPrices: { economy: FARE },
  });
  assert.ok(proj, 'projection produced');
  const actual = actualAfterOpening(state, spare);
  assert.ok(actual, 'tick booked the new route');
  const drift = Math.abs(proj.mature.passengers - actual.passengers)
    / Math.max(1, actual.passengers);
  assert.ok(drift <= 0.02,
    `projected ${proj.mature.passengers} pax vs tick's ${actual.passengers} (${(drift * 100).toFixed(1)}% drift)`);
});

test("the projected weekly profit means what the tick means by it", () => {
  const { state, spare } = fixture({ existing: 2 });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ,
    ticketPrice: FARE, classPrices: { economy: FARE },
  });
  const actual = actualAfterOpening(state, spare);
  const gap = Math.abs(proj.mature.profit - actual.profit);
  assert.ok(gap <= Math.max(500, Math.abs(actual.profit) * 0.02),
    `projected $${Math.round(proj.mature.profit)}/wk vs tick's $${Math.round(actual.profit)}/wk`);
});

test('landing fees are in the projection at all', () => {
  const { state, spare } = fixture({ existing: 0 });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  assert.ok(proj.mature.landingFee > 0, 'a 10x/week trunk route is not landed for free');
  assert.equal(
    proj.mature.profit,
    Math.round(proj.mature.opProfitBeforeLandingFees - proj.mature.landingFee));
});

test('the projection flags the pair as shared', () => {
  const { state, spare } = fixture({ existing: 1 });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  assert.equal(proj.shared, true);
  assert.equal(proj.pairRouteCount, 2);
});

test('joining a busy pair projects strictly less than flying it alone', () => {
  const solo = projectRouteAddition(fixture({ existing: 0 }).state, {
    origin: O, destination: D, aircraft: mkAircraft('spare'), weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  const { state, spare } = fixture({ existing: 2 });
  const joined = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  assert.ok(joined.mature.passengers < solo.mature.passengers,
    `joining 2 existing tails projected ${joined.mature.passengers} pax, alone projects ${solo.mature.passengers} — a third tail cannot carry as much as the first`);
});

// ── 2. Maturity ───────────────────────────────────────────────────────────────
console.log('\nMaturity ramp');

test('a brand-new pair projects a launch figure below its mature one', () => {
  const { state, spare } = fixture({ existing: 0 });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ_UNCAPPED, ticketPrice: FARE,
  });
  assert.ok(proj.launch.passengers < proj.mature.passengers,
    `launch ${proj.launch.passengers} should trail mature ${proj.mature.passengers}`);
});

test('adding a tail to an established pair does NOT re-ramp the market', () => {
  const { state, spare } = fixture({ existing: 1 });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  assert.equal(proj.launch.passengers, proj.mature.passengers,
    'a mature lane is already mature — the newcomer inherits it');
});

// ── 3. Restricted-world load ceiling ──────────────────────────────────────────
console.log('\nNWR load ceiling');

test('a restricted world never projects a 100% load factor', () => {
  const { state, spare } = fixture({ existing: 0, restricted: true });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  assert.ok(proj.mature.loadFactor <= NWR_LF_CEILING + 1e-9,
    `projected ${(proj.mature.loadFactor * 100).toFixed(1)}% load, ceiling is ${(NWR_LF_CEILING * 100).toFixed(0)}%`);
  assert.ok(proj.mature.loadFactor < 1,
    'the form showed exactly 100.0% on a world where that is unreachable');
});

test('a classic world is left alone by the ceiling', () => {
  const { state, spare } = fixture({ existing: 0, restricted: false });
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  assert.ok(proj.ceilingApplies === false);
});

// ── 4. Rivals ─────────────────────────────────────────────────────────────────
console.log('\nRivals on the pair');

test('a human rival on the pair reduces the projection', () => {
  const { state, spare } = fixture({ existing: 0 });
  const key = [O, D].sort().join('-');
  const uncontested = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ_UNCAPPED, ticketPrice: FARE,
  });
  const contested = projectRouteAddition({
    ...state,
    humanRivals: { [key]: [{
      airlineId: 'rival', name: 'Rival Air', frequency: 14,
      seatsPerWeek: 14 * jet.seats, economyFare: Math.round(FARE * 0.9),
      qualityScore: 65,
    }] },
  }, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ_UNCAPPED, ticketPrice: FARE,
  });
  assert.ok(contested.rivalCount >= 1, 'the rival was resolved into an offer');
  assert.ok(contested.mature.passengers < uncontested.mature.passengers,
    `contested ${contested.mature.passengers} pax should trail uncontested ${uncontested.mature.passengers}`);
});

// ── 5. The dead competitor branch ─────────────────────────────────────────────
console.log('\nAI carrier bank');

test('the COMPETITOR_AIRLINES constant is not a usable rival source', () => {
  const populated = COMPETITOR_AIRLINES.filter(c => Object.keys(c.routes ?? {}).length > 0);
  assert.equal(populated.length, 0,
    'the module constant carries no routes — anything reading it sees zero rivals');
});

test('simulateRoute contests a pair when handed the LIVE bank', () => {
  const live = sampleAndInitializeCompetitors(25);
  // Find a pair the sampled carriers actually fly — and one where the monopoly
  // run does NOT fill the aircraft. On a pair whose demand exceeds the cabin,
  // every seat sells with or without a rival, so "fewer passengers with rivals"
  // is not a property of the demand model there: the cap is doing the work, and
  // the assertion below would fail on an honest engine. Which pairs the sample
  // throws up is random, so without this the suite failed roughly one run in
  // five — a flake that predates this change and had nothing to do with rivals.
  const key = [...new Set(live.flatMap(c => Object.keys(c.routes)))]
    .find(k => {
      const [o, d] = k.split('-');
      const m = buildRouteMarket(o, d, { month: 6 }, 1, 1);
      if (!m || !live.some(c => buildCompetitorOffer(c, m))) return false;
      const f = Math.round(referencePrice(o, d));
      const probe = simulateRoute(
        { id: 'probe', origin: o, destination: d, aircraftId: 'x', weeklyFrequency: FREQ_UNCAPPED,
          weeksOpen: 40, ticketPrice: f, classPrices: { economy: f } },
        mkAircraft('x'), { month: 6 }, null, 1.0, null, [], null, null, 1.0, null, []);
      return probe && probe.loadFactor < 0.98;
    });
  assert.ok(key, 'sampled carriers fly a pair that is not capacity-capped');
  const [o, d] = key.split('-');
  const fare = Math.round(referencePrice(o, d));
  const ac = mkAircraft('x');
  const route = {
    id: 'x', origin: o, destination: d, aircraftId: 'x', weeklyFrequency: FREQ_UNCAPPED,
    weeksOpen: 40, ticketPrice: fare, classPrices: { economy: fare },
  };
  const args = [ac, { month: 6 }, null, 1.0, null, [], null, null, 1.0, null];
  const blind = simulateRoute(route, ...args, []);
  const seeing = simulateRoute(route, ...args, live);
  assert.ok(blind && seeing, `both sims produced a result on ${key}`);
  assert.ok(seeing.passengers < blind.passengers,
    `${key}: with rivals ${seeing.passengers} pax should trail the monopoly's ${blind.passengers}`);
});

// ── 6. Editing an existing route ──────────────────────────────────────────────
console.log('\nEditing rather than adding');

test('re-projecting an existing route does not make it compete with itself', () => {
  const { state } = fixture({ existing: 1 });
  const ac = state.fleet.find(a => a.id === 'ac0');
  const asEdit = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: ac, weeklyFrequency: FREQ,
    ticketPrice: FARE, classPrices: { economy: FARE },
    replacesRouteId: 'r0',
  });
  assert.equal(asEdit.shared, false, 'the route being edited is replaced, not joined');
  assert.equal(asEdit.pairRouteCount, 1);
});

test('the preview route never leaks into the pair as a real route', () => {
  const { state, spare } = fixture({ existing: 1 });
  projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE,
  });
  assert.ok(!state.routes.some(r => r.id === PREVIEW_ROUTE_ID),
    'projection must not mutate the caller state');
});

// ── 7. Hydrated routes ────────────────────────────────────────────────────────
// The reducer hands every route a `stops` array — `[origin, destination]` for an
// ordinary single-leg route. Any "is this a tag route?" test written as
// `!r.stops?.length` is therefore false for EVERY route on a real save, and
// silently empties the pair.
console.log('\nHydrated routes (stops always present)');

const hydrate = (r) => ({ ...r, stops: [r.origin, r.destination] });

test('a hydrated pair still counts as shared', () => {
  const { state, spare } = fixture({ existing: 2 });
  const proj = projectRouteAddition(
    { ...state, routes: state.routes.map(hydrate) },
    { origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE });
  assert.equal(proj.shared, true, 'stops:[o,d] is a single leg, not a tag route');
  assert.equal(proj.pairRouteCount, 3);
});

test('a hydrated pair projects the same as an unhydrated one', () => {
  const { state, spare } = fixture({ existing: 2 });
  const bare = projectRouteAddition(state,
    { origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE });
  const hyd = projectRouteAddition({ ...state, routes: state.routes.map(hydrate) },
    { origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE });
  assert.equal(hyd.mature.passengers, bare.mature.passengers);
});

test('pairMarketShare still finds the player on a hydrated save', () => {
  const { state } = fixture({ existing: 2 });
  const hyd = { ...state, routes: state.routes.map(hydrate) };
  const share = pairMarketShare(hyd, O, D);
  assert.ok(share.playerResult,
    'the player flies this pair twice — a null player offer means the filter dropped them');
  assert.ok(share.playerShare > 0);
});

test('a genuine tag route is still excluded from the pair', () => {
  const { state, spare } = fixture({ existing: 1 });
  const tag = { ...state.routes[0], id: 'tag', stops: [O, 'DEN', D] };
  const proj = projectRouteAddition({ ...state, routes: [...state.routes, tag] },
    { origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ, ticketPrice: FARE });
  assert.equal(proj.pairRouteCount, 2, 'the 3-stop route self-contains its O&D split');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
