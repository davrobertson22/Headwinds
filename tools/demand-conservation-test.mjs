// One city pair, one demand pool — however many ways you fly it.
//
// Three defects, one family: demand that is destroyed or duplicated at the
// seams of the model.
//
//   H9  A contested market DELETED its business pool when no carrier sold a J
//       cabin (`businessShares = anyBiz ? softmax : zeros`), while the monopoly
//       path folds the same travellers into economy. Two identical all-economy
//       carriers made ~38% of the market vanish.
//   H10 `directionalLoadMultiplier` and `nwrDemandScale` both apply
//       min(demand, capacity) internally, but were handed demand ALREADY capped
//       by computeMarketShare — so both were stuck in the D<=C regime. A route
//       9x oversubscribed in a skewed month was docked 13.5% it could not lose,
//       and the NWR 95% ceiling was unreachable (a 13x-oversubscribed route
//       landed at 88%, same as one at parity).
//   H2  A tag route's segment and a nonstop on the same pair each drew the FULL
//       pool: the pooling pre-pass skipped multi-stop routes ("tag routes
//       self-contain their O&D split" — true within one rotation, no help
//       against your own nonstop). Measured 1.74x the whole market, all real
//       revenue.
//
//   node tools/demand-conservation-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  simulateRoute, routeSegmentKey,
} from '../packages/engine/src/utils/simulation.js';
import {
  buildRouteMarket, computeMarketShare, directionalSeasonalSkew,
} from '../packages/engine/src/models/demand.js';
import { getAircraftType, AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { distanceKm } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;

const GD = { week: 20, month: 5 };

// ── H9: no carrier sells J → business travellers downgrade, not disappear ────

function allEcoOffer(id, seats, freq, fare) {
  return {
    airlineId: id, origin: 'JFK', destination: 'LAX',
    economyPrice: fare, businessPrice: null,
    weeklyFrequency: freq, seatsPerFlight: seats,
    economySeats: seats * freq, businessSeats: 0, totalSeats: seats * freq,
    qualityScore: 60, connectivityBonus: 0,
  };
}

test('H9: an all-economy duopoly serves the business pool as economy demand', () => {
  const market = buildRouteMarket('JFK', 'LAX', GD);
  assert.ok(market.businessDemand > 1000, `fixture pair has no business pool (${market.businessDemand})`);

  // The same two carriers, in a market whose business pool has been zeroed by
  // hand. If the engine folds business into economy when nobody sells J, these
  // two runs MUST differ by roughly the folded pool; on HEAD they were equal,
  // which is the deletion.
  // Priced ABOVE reference so the duopoly is demand-bound — at reference both
  // scenarios cap at the seat count and the deletion hides behind the cap.
  const fare = Math.round(market.referencePrice * 1.5);
  const offers = [allEcoOffer('a', 180, 21, fare), allEcoOffer('b', 180, 21, fare)];
  const withBiz = computeMarketShare(market, offers).reduce((s, r) => s + r.totalPax, 0);
  const noBiz   = computeMarketShare({ ...market, businessDemand: 0 }, offers)
    .reduce((s, r) => s + r.totalPax, 0);

  assert.ok(withBiz > noBiz * 1.05,
    `the business pool changed nothing: ${withBiz} pax with a ${market.businessDemand}-pax business pool, `
    + `${noBiz} without it — the contested path is deleting business demand`);

  // And the pre-cap demand must show the fold at ANY fare.
  const wU = computeMarketShare(market, offers).reduce((s, r) => s + (r.leisurePaxUncapped ?? r.leisurePax), 0);
  const nU = computeMarketShare({ ...market, businessDemand: 0 }, offers)
    .reduce((s, r) => s + (r.leisurePaxUncapped ?? r.leisurePax), 0);
  assert.ok(wU > nU * 1.1,
    `pre-cap economy demand ignores the business pool: ${wU} vs ${nU}`);
});

test('H9: the contested fold agrees with the monopoly fold', () => {
  const market = buildRouteMarket('JFK', 'LAX', GD);
  const fare = Math.round(market.referencePrice);
  // A duopoly of identical carriers should carry ROUGHLY what one carrier with
  // both fleets carries — not 38% less. Compare against a single offer with the
  // combined capacity (the monopoly path, which has always folded correctly).
  const duo = computeMarketShare(market,
    [allEcoOffer('a', 180, 21, fare), allEcoOffer('b', 180, 21, fare)])
    .reduce((s, r) => s + r.totalPax, 0);
  const mono = computeMarketShare(market, [allEcoOffer('a', 180, 42, fare)])
    .reduce((s, r) => s + r.totalPax, 0);
  // Fare compression and split-market elasticity legitimately cost a few
  // percent; deleting the J pool cost ~38%.
  assert.ok(duo > mono * 0.8,
    `a second identical carrier shrank the market ${(100 * (1 - duo / mono)).toFixed(1)}%: ${mono} → ${duo}`);
});

test('H9: carriers that DO sell J still exclude economy-only carriers from the J fight', () => {
  const market = buildRouteMarket('JFK', 'LAX', GD);
  const fare = Math.round(market.referencePrice);
  const withJ = {
    ...allEcoOffer('full', 180, 21, fare),
    businessPrice: fare * 2.5, businessSeats: 21 * 24, economySeats: 21 * 156,
  };
  const results = computeMarketShare(market, [withJ, allEcoOffer('lcc', 180, 21, fare)]);
  const lcc = results.find(r => r.airlineId === 'lcc');
  assert.equal(lcc.businessPax, 0,
    `an all-economy carrier captured ${lcc.businessPax} business pax it cannot seat`);
});

// ── H10: the load models see the demand the market generated, not the seats ──

// A deliberately tiny aircraft on a huge pair: demand is many multiples of
// capacity, so the correct directional haircut is exactly zero (both directions
// stay full) and the correct NWR landing point is the ceiling.
// NOT `find(...range > 4000)` — that used to pick the CONCORDE, whose 2.75x
// ticketPremium chokes the solo path while the pooled path (which drops the
// premium) sells happily, poisoning every shape comparison in this file.
const smallType = AIRCRAFT_TYPES.find(t => !t.freighter && t.seats >= 100 && t.seats <= 200
  && t.range > 4000 && (t.ticketPremium ?? 1) === 1
  && !checkRouteRestrictions('JFK', 'BTV', 430, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(smallType, 'no suitable narrowbody in the table');

function saturatedRoute(o, d, extra = {}) {
  const aircraft = {
    id: 'ac0', typeId: smallType.id, status: 'assigned', ageWeeks: 60,
    ownershipType: 'owned',
    config: { economy: smallType.seats, seatQuality: 'standard', serviceQuality: 'standard' },
  };
  const market = buildRouteMarket(o, d, GD);
  const route = {
    id: 'r0', origin: o, destination: d, aircraftId: 'ac0', weeklyFrequency: 7,
    weeksOpen: 60, ticketPrice: Math.round(market.referencePrice * 0.6),
    classPrices: { economy: Math.round(market.referencePrice * 0.6) },
    ...extra,
  };
  return { route, aircraft, market };
}

// A pair that is deeply oversubscribed for one 7x/wk narrowbody.
const FAT = (() => {
  for (const [o, d] of [['JFK', 'LAX'], ['JFK', 'ORD'], ['LHR', 'JFK'], ['HND', 'CTS']]) {
    if (!getAirport(o) || !getAirport(d)) continue;
    const m = buildRouteMarket(o, d, GD);
    if (m.leisureDemand + m.businessDemand > smallType.seats * 7 * 8) return [o, d];
  }
  return null;
})();
assert.ok(FAT, 'no deeply oversubscribed fixture pair found');

test('H10: a route drowning in demand is not docked for seasonal skew', () => {
  // Find a month with a real skew for some seasonal pair, deeply oversubscribed.
  let found = null;
  outer:
  for (const [o, d] of [['JFK', 'CUN'], ['ORD', 'CUN'], ['JFK', 'MIA'], ['LHR', 'PMI'], ['FRA', 'PMI']]) {
    if (!getAirport(o) || !getAirport(d)) continue;
    for (let month = 1; month <= 12; month++) {
      const skew = directionalSeasonalSkew(o, d, month);
      if (Math.abs(skew) < 0.1) continue;
      const m = buildRouteMarket(o, d, { week: 20, month });
      if (m.leisureDemand + m.businessDemand > smallType.seats * 7 * 10) { found = { o, d, month, skew }; break outer; }
    }
  }
  assert.ok(found, 'no skewed oversubscribed fixture found');

  const { route, aircraft } = saturatedRoute(found.o, found.d);
  const res = simulateRoute(route, aircraft, { week: 20, month: found.month },
    null, 1.0, null, [], null, null, 1.0, null, []);
  assert.ok(res, 'fixture did not simulate');
  // With demand many times capacity, BOTH directions saturate: the correct
  // multiplier is 1.0 and the aeroplane departs full. On HEAD this read ~0.86.
  assert.ok(res.loadFactor > 0.99,
    `${found.o}-${found.d} month ${found.month} (skew ${found.skew.toFixed(2)}): `
    + `LF ${(res.loadFactor * 100).toFixed(1)}% on a pair with many times the capacity in demand`);
});

test('H10: a balanced undersubscribed route is untouched by the skew model', () => {
  // Control: skew fires only when the peak direction runs out of seats.
  const { route, aircraft, market } = saturatedRoute(FAT[0], FAT[1]);
  const dear = { ...route, ticketPrice: market.referencePrice * 3, classPrices: { economy: market.referencePrice * 3 } };
  const res = simulateRoute(dear, aircraft, GD, null, 1.0, null, [], null, null, 1.0, null, []);
  assert.ok(res, 'control did not simulate');
  assert.ok(res.loadFactor < 0.9, `control should be undersubscribed, LF ${(res.loadFactor * 100).toFixed(1)}%`);
});

test('H10: the NWR ceiling is reachable when demand is deep', () => {
  const { route, aircraft } = saturatedRoute(FAT[0], FAT[1], { nwrLoadJitter: 1 });
  const res = simulateRoute(route, aircraft, GD, null, 1.0, null, [], null, null, 1.0, null, []);
  assert.ok(res, 'fixture did not simulate');
  // Deep oversubscription asymptotes to NWR_LF_CEILING (0.95) x jitter (1).
  // On HEAD it landed at ~0.88 — indistinguishable from a route at parity.
  assert.ok(res.loadFactor > 0.93,
    `13x-oversubscribed NWR route landed at ${(res.loadFactor * 100).toFixed(1)}%, ceiling unreachable`);
});

test('H10: an NWR route at rough parity still lands well below the ceiling', () => {
  // The other half of the model's promise: parity lands ~0.87, NOT at the
  // ceiling — the two cases must be distinguishable (they were identical on HEAD).
  const { route, aircraft, market } = saturatedRoute(FAT[0], FAT[1], { nwrLoadJitter: 1 });
  // Price up until demand ~ capacity.
  let res = null;
  for (const mult of [1.0, 1.3, 1.6, 2.0, 2.5, 3.0]) {
    const fare = Math.round(market.referencePrice * mult);
    const r = simulateRoute({ ...route, ticketPrice: fare, classPrices: { economy: fare } },
      aircraft, GD, null, 1.0, null, [], null, null, 1.0, null, []);
    if (r && r.loadFactor < 0.93) { res = r; break; }
  }
  assert.ok(res, 'could not price the fixture down to parity');
  assert.ok(res.loadFactor < 0.93, 'parity case reads at the ceiling');
});

// ── H2: a tag segment and a nonstop share one pool ───────────────────────────

const tick = () => { const ms = Date.now(); while (Date.now() === ms) { /* next uid */ } };

function paxOnPair(state, o, d) {
  const key = [o, d].sort().join('-');
  const next = gameReducer(state, { type: 'ADVANCE_WEEK' });
  let pax = 0;
  for (const rr of next.lastReport?.routeResults ?? []) {
    const r = (next.routes ?? []).find(x => x.id === rr.routeId);
    if (!r) continue;
    const isTag = (r.stops?.length ?? 2) > 2;   // hydration gives nonstops stops:[o,d]
    if (!isTag && [r.origin, r.destination].sort().join('-') === key) pax += rr.passengers ?? 0;
    if (isTag) {
      // Tag route: count only the contested segment's boarded pax. Post-
      // allocation segments carry `pax` (one direction), matching the
      // nonstop's one-way `passengers`.
      const seg = (rr.segments ?? []).find(s => [s.from, s.to].sort().join('-') === key);
      if (seg) pax += seg.pax ?? 0;
    }
  }
  return pax;
}

function buildAirline(shape, fare) {
  // shape: 'two-nonstops' | 'nonstop+tag'
  // A THIN pair, or both shapes are capacity-bound at any sane fare and the
  // duplication is invisible.
  const O = 'JFK', D = 'BTV', TAIL = 'PWM';
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Pool Air', hub: O, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {}, cash: 400_000_000 };
  for (const code of [D, TAIL]) s = gameReducer(s, { type: 'ADD_GATE', airportCode: code });
  for (let i = 0; i < 2; i++) { s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: smallType.id }); tick(); }
  const ids = [...new Set(s.fleet.map(a => a.id))];
  assert.equal(ids.length, 2, 'fixture leases collided');

  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ids[0], origin: O, destination: D, weeklyFrequency: 7 });
  tick();
  assert.equal(s.routes.length, 1, `nonstop not created (${s.error ?? 'no error'})`);
  if (shape === 'two-nonstops') {
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ids[1], origin: O, destination: D, weeklyFrequency: 7 });
    tick();
    assert.equal(s.routes.length, 2, `second nonstop not created (${s.error ?? 'no error'})`);
  } else {
    s = gameReducer(s, {
      type: 'ADD_TAG_ROUTE', aircraftId: ids[1],
      stops: [O, D, TAIL], weeklyFrequency: 7,
      segmentPrices: Object.fromEntries(
        [[O, D], [D, TAIL], [O, TAIL]].map(([a, b]) => [routeSegmentKey(a, b), { economy: fare }])),
    });
    tick();
    assert.equal(s.routes.length, 2, `tag route not created (${s.error ?? 'no error'})`);
  }
  for (const r of s.routes.filter(r => !(r.stops?.length > 2))) {
    s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: r.id, ticketPrice: fare });
  }
  return { ...s, routes: s.routes.map(r => ({ ...r, weeksOpen: 30 })) };
}

test('H2: a tag segment and a nonstop on one pair do not both drain the full pool', () => {
  // Priced so the pair is demand-bound for the combined fleet but the solo
  // claim still clears the choke.
  const market = buildRouteMarket('JFK', 'BTV', GD);
  const fare = Math.round(market.referencePrice * 1.25);
  const twoNonstops = paxOnPair(buildAirline('two-nonstops', fare), 'JFK', 'BTV');
  const nonstopPlusTag = paxOnPair(buildAirline('nonstop+tag', fare), 'JFK', 'BTV');
  assert.ok(twoNonstops > 100, `two-nonstop control carried almost nobody (${twoNonstops})`);
  // Identical capacity, identical fares — the two shapes must carry roughly the
  // same pair traffic. On HEAD the tag shape carried 1.74x the market's pool.
  assert.ok(nonstopPlusTag < twoNonstops * 1.25,
    `flying half the capacity as a tag leg conjured demand: ${nonstopPlusTag} pax vs `
    + `${twoNonstops} for the same seats as nonstops`);
});

test('H2: replacing a nonstop with a tag leg does not raise total pair traffic above the pool', () => {
  const market = buildRouteMarket('JFK', 'BTV', GD);
  const fare = Math.round(market.referencePrice * 1.25);
  // One nonstop alone claims the whole (elastic) pool at this fare.
  const O = 'JFK', D = 'BTV';
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Solo Air', hub: O, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {}, cash: 400_000_000 };
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: D });
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: smallType.id }); tick();
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[0].id, origin: O, destination: D, weeklyFrequency: 7 });
  s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: s.routes[0].id, ticketPrice: fare });
  const solo = paxOnPair({ ...s, routes: s.routes.map(r => ({ ...r, weeksOpen: 30 })) }, O, D);

  const both = paxOnPair(buildAirline('nonstop+tag', fare), O, D);
  // Adding capacity can serve spill the solo tail turned away, but it cannot
  // MULTIPLY the pool. On HEAD both-shapes carried ~1.7x the solo pool.
  assert.ok(both < solo * 1.45,
    `nonstop+tag carried ${both} pax where the whole pool (solo claim) is ${solo}`);
});

Math.random = realRandom;
console.log(`\ndemand conservation: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
