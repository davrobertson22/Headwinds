// A multi-stop route is not a private market.
//
// simulateTagRoute built its per-segment competitor bank from the
// COMPETITOR_AIRLINES module constant and took no `competitors` parameter at
// all. sampleAndInitializeCompetitors() does `{ ...c, routes: {} }` and
// populates the COPIES it hands to state.competitors, so every entry in that
// constant keeps an empty routes map forever and buildCompetitorOffer() returns
// null 70 times out of 70. Every segment of every tag route — in the weekly
// tick and in the TagRoutePlanner preview — was scored as an uncontested
// monopoly, and there was no path by which state.humanRivals could reach the
// function either.
//
// simulateRoute was fixed for exactly this in a 15-line comment at :1487 and
// this function was missed. Tailwinds fixed both, and its source comment names
// Headwinds: "Headwinds fixed simulateRoute and left this one reading the dead
// constant, so every multi-stop route there is still a monopoly."
//
// The player-visible consequence: rerouting a trunk through one intermediate
// stop made every competitor on it vanish, permanently and for free.
//
//   node tools/tag-route-rivals-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { simulateTagRoute, simulateRoute, routeSegmentKey } from '../packages/engine/src/utils/simulation.js';
import { COMPETITOR_AIRLINES } from '../packages/engine/src/models/demand.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;

const base = freshState();

// The pair the sampled bank actually contests hardest, so the fixture cannot
// quietly become uncontested when the data moves.
const busiest = (() => {
  const counts = new Map();
  for (const c of base.competitors ?? []) {
    for (const key of Object.keys(c.routes ?? {})) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  return key ? { key, rivals: n, from: key.split('-')[0], to: key.split('-')[1] } : null;
})();
assert.ok(busiest, 'no carrier in freshState() flies any pair');

const TYPE = 'b777300er';
const type = getAircraftType(TYPE);
assert.ok(type, `${TYPE} is no longer in the aircraft table`);
const aircraft = {
  id: 'ac0', typeId: TYPE, status: 'assigned', ageWeeks: 60, ownershipType: 'owned',
  config: { businessClass: 42, economy: 300, seatQuality: 'standard', serviceQuality: 'standard' },
};

const GD = { week: 20, month: 5 };

// ── 1. The constant really is dead ────────────────────────────────────────────

test('COMPETITOR_AIRLINES carries no routes and can contest nothing', () => {
  const withRoutes = COMPETITOR_AIRLINES.filter(c => Object.keys(c.routes ?? {}).length > 0);
  assert.equal(withRoutes.length, 0,
    `${withRoutes.length} of ${COMPETITOR_AIRLINES.length} entries have routes — this test's premise is stale`);
});

// ── 2. A tag segment is contested by the live bank ────────────────────────────

// The tag route is built so that its FIRST LEG is the contested pair: a
// multi-stop route is scored per segment, and a through-market like HKG–AMS–NRT
// sells zero passengers on the O&D itself (nobody flies the long way round), so
// hanging the rivals off the O&D would test nothing. Fares are set well above
// reference too — at reference the aeroplane fills either way and capacity, not
// competition, decides the answer.
let LEG_FARE = { economy: 800, businessClass: 2000 };

function tagVia(tail, competitors, specsFor = null, fare = LEG_FARE) {
  const stops = [busiest.from, busiest.to, tail];
  const segmentPrices = {};
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      segmentPrices[routeSegmentKey(stops[i], stops[j])] = { ...fare };
    }
  }
  const route = {
    id: 'tg', origin: busiest.from, destination: tail, stops,
    aircraftId: 'ac0', weeklyFrequency: 7, weeksOpen: 60, hub: busiest.from,
    segmentPrices,
  };
  return simulateTagRoute(route, aircraft, GD, null, 1.0, null, null, null, null, competitors, specsFor);
}

// Pick the extension airport AND the fare together, by sweeping.
//
// Two traps this avoids. The contested pair must be the FIRST LEG: a segment
// like HKG–NRT flown the long way round via AMS sells zero passengers, so
// hanging the rivals off the through-market tests nothing. And the fare must be
// high enough that the leg is not capacity-bound — at reference fare the rivals
// take 79% of the segment's DEMAND and the aeroplane still departs full, so the
// passenger count the test reads would not move at all.
const tail = (() => {
  const cands = [...new Set((base.competitors ?? [])
    .flatMap(c => Object.keys(c.routes ?? {}))
    .flatMap(k => k.split('-')))];
  for (const fare of [800, 1000, 600, 1200, 450]) {
    const f = { economy: fare, businessClass: fare * 2.5 };
    for (const cand of cands) {
      if (cand === busiest.from || cand === busiest.to) continue;
      // Selected on the UNCONTESTED run only, so the fixture is chosen the same
      // way whether or not the fix is present — otherwise this loop would fail
      // to find anything on unfixed code and the suite would die at import time
      // instead of failing its assertions.
      const alone = tagVia(cand, [], null, f);
      if (!alone) continue;
      if (alone.loadFactor > 0.95 || alone.passengers < 500) continue;
      LEG_FARE = f;
      return cand;
    }
  }
  return null;
})();
assert.ok(tail,
  'could not build a tag route whose contested first leg is both busy and not capacity-bound');

test('a tag route loses traffic to the rivals on its segments', () => {
  const alone = tagVia(tail, []);
  const contested = tagVia(tail, base.competitors);
  assert.ok(alone && contested, 'the fixture tag route did not simulate');
  assert.ok(contested.passengers < alone.passengers * 0.97,
    `the live bank changed nothing: ${alone.passengers} pax alone vs ${contested.passengers} contested, `
    + `on a route whose first leg ${busiest.rivals} carrier(s) fly`);
});

test('routing a trunk through a stop does not make its rivals disappear', () => {
  // The same O&D, flown nonstop and flown as a tag leg, against the same bank.
  const nonstopRoute = {
    id: 'r0', origin: busiest.from, destination: busiest.to, aircraftId: 'ac0',
    // The SAME fare the tag fixture swept to, not a hardcoded 400: at 400 this
    // pair is capacity-capped with or without rivals, so the control measured a
    // 0% bite and the comparison below proved nothing.
    weeklyFrequency: 7, weeksOpen: 60, hub: busiest.from,
    ticketPrice: LEG_FARE.economy,
    classPrices: { economy: LEG_FARE.economy, businessClass: LEG_FARE.businessClass },
  };
  const nsAlone = simulateRoute(nonstopRoute, aircraft, GD, null, 1.0, null, [], null, null, 1.0, null, []);
  const nsContested = simulateRoute(nonstopRoute, aircraft, GD, null, 1.0, null, [], null, null, 1.0, null, base.competitors);
  assert.ok(nsAlone && nsContested, 'the nonstop control did not simulate');
  const nonstopBite = 1 - nsContested.passengers / nsAlone.passengers;

  const tAlone = tagVia(tail, []).passengers;
  const tContested = tagVia(tail, base.competitors).passengers;
  const tagBite = 1 - tContested / tAlone;

  assert.ok(nonstopBite > 0.02,
    `the nonstop control is not contested either (${(nonstopBite * 100).toFixed(1)}%) — bad fixture`);
  assert.ok(tagBite > nonstopBite * 0.25,
    `rivals take ${(nonstopBite * 100).toFixed(1)}% of the nonstop but only `
    + `${(tagBite * 100).toFixed(1)}% of the same O&D flown as a tag leg`);
});

// ── 3. Human rivals reach a tag segment too ───────────────────────────────────

test('a humanRivals spec on a segment contests that segment', () => {
  const key = [busiest.from, busiest.to].sort().join('-');
  const spec = {
    competitorId: 'human:x', name: 'Rival Air', tier: 'legacy', qualityScore: 70,
    frequency: 42, priceMultiplier: 0.85, seatsPerFlight: 300, seatsPerWeek: 12600,
    economyFare: null, businessFare: null, businessSeatsPerWeek: 0,
  };
  const alone = tagVia(tail, []).passengers;
  const contested = tagVia(tail, [], (k) => (k === key ? [spec] : [])).passengers;
  assert.ok(contested < alone * 0.97,
    `a human rival on the segment changed nothing: ${alone} → ${contested}`);
});

// ── 4. The weekly tick feeds it the live bank ─────────────────────────────────

test('weeklyTick contests a tag route against the world', () => {
  const mk = (competitors) => {
    let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Tag Air', hub: busiest.from, enableObjectives: false });
    s = { ...s, multiplayer: true, competitors, humanRivals: {}, encroachments: {}, cash: 300_000_000 };
    // Tag routes live in state.routes with a `stops` array — there is no
    // separate collection; isMultiStop(r) is what routes them to simulateTagRoute.
    s = { ...s, fleet: [aircraft], week: 20, year: 2,
      gates: { [busiest.from]: 20, [busiest.to]: 10, [tail]: 10 },
      routes: [{
        id: 'tg', origin: busiest.from, destination: tail, stops: [busiest.from, busiest.to, tail],
        aircraftId: 'ac0', weeklyFrequency: 7, weeksOpen: 60, hub: busiest.from,
        segmentPrices: Object.fromEntries(
          [[busiest.from, busiest.to], [busiest.to, tail], [busiest.from, tail]]
            .map(([a, b]) => [routeSegmentKey(a, b), { ...LEG_FARE }])),
      }] };
    const n = gameReducer(s, { type: 'ADVANCE_WEEK' });
    const row = (n.lastReport?.routeResults ?? []).find(r => r.routeId === 'tg');
    return row?.passengers ?? null;
  };
  const alone = mk([]);
  const contested = mk(base.competitors);
  if (alone == null || contested == null) {
    // The reducer stores tag routes elsewhere in some builds; the direct-call
    // assertions above are the load-bearing ones, so say so rather than fake a pass.
    assert.fail('the tick produced no result row for the fixture tag route');
  }
  assert.ok(contested < alone * 0.97,
    `the tick scored the tag route as a monopoly: ${alone} pax alone vs ${contested} contested`);
});

Math.random = realRandom;
console.log(`\ntag route rivals: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
