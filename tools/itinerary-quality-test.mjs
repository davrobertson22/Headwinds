// Itinerary quality — HUB_CONNECTIVITY_PLAN.md Phase 3.
//
// A connection's penalty was a flat per-tier constant, blind to what the stop
// costs the traveller: a one-stop over MCO on a 90-minute MIA–ATL sector
// doubles the trip and was penalised exactly like a stop on a nine-hour
// transatlantic. And every connecting offer was priced as the SUM of its two
// leg fares, which on a triangle is structurally above the nonstop reference —
// real carriers price connections against the nonstop market.
//
//   1. connectionTimeRatio(A,H,C) = (block A→H + connect time + block H→C) / block A→C.
//      The tier penalty is calibrated for a typical long-haul stop (ratio
//      CONNECTION_TIME_BASE) and scales with the ratio, clamped. Circuity is
//      inside this (a longer path is a longer trip); the hard 1.5× cap stays.
//   2. throughFare(sumOfLegs, A, C) = min(sumOfLegs, ref(A,C) × THROUGH_FARE_INDEX).
//   Both apply to EVERY connecting offer — your own-metal, partner-fed and
//   rival one-stops alike — so no carrier's connection is scored by a
//   different rule.
//
//   node --import ./tools/_register-loader.mjs tools/itinerary-quality-test.mjs

import assert from 'node:assert/strict';
import {
  connectionTimeRatio, connectionPenaltyFor, CONNECTION_PENALTY_SCALE, throughFare,
  CONNECTION_TIME_BASE, THROUGH_FARE_INDEX, CONNECTION_PENALTY,
  buildRivalHubIndex, rivalOneStopOffersFor, buildOwnMetalConnections, computeOwnMetalODRevenue,
} from '../packages/engine/src/models/network.js';
import { buildRouteMarket, computeMarketShare, HUB_TIERS } from '../packages/engine/src/models/demand.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const GD = { week: 20, month: 5 };
const rival = (id, homeHub, pairs) => ({ id, name: id, homeHub, tier: 'legacy', baseQualityScore: 70, cash: 1e8,
  routes: Object.fromEntries(pairs.map(k => [k.split('-').sort().join('-'), { frequency: 14, priceMultiplier: 1.0 }])) });

console.log('\n── the time ratio ───────────────────────');

test('a stop on a short sector costs far more, relatively, than a stop on a long one', () => {
  const shortHop = connectionTimeRatio('MIA', 'MCO', 'ATL');   // 970 km nonstop
  const longHaul = connectionTimeRatio('JFK', 'FRA', 'AMS');   // 5,900 km nonstop
  assert.ok(shortHop > 1.8, `MIA–ATL via MCO should roughly double the trip, got ${shortHop.toFixed(2)}`);
  assert.ok(longHaul < 1.6, `JFK–AMS via FRA is a modest detour, got ${longHaul.toFixed(2)}`);
  assert.ok(shortHop > longHaul);
});

test('the penalty scales with the ratio around the long-haul calibration point, clamped, ×CONNECTION_PENALTY_SCALE', () => {
  // The tier bases date from when the only connections were the player's own;
  // CONNECTION_PENALTY_SCALE (2) brings a one-stop's preference into line with
  // airline QSI practice. The scale applies to every modern connection alike.
  const base = CONNECTION_PENALTY.ownMetal * CONNECTION_PENALTY_SCALE;
  assert.equal(CONNECTION_PENALTY_SCALE, 2);
  assert.ok(Math.abs(connectionPenaltyFor(CONNECTION_PENALTY.ownMetal, CONNECTION_TIME_BASE) - base) < 1e-9, 'at the calibration ratio the tier penalty is the scaled base');
  assert.ok(connectionPenaltyFor(CONNECTION_PENALTY.ownMetal, 2.2) > base * 1.3, 'a doubling stop is penalised harder');
  assert.ok(connectionPenaltyFor(CONNECTION_PENALTY.ownMetal, 1.05) < base, 'an on-the-way stop is penalised a little less');
  assert.ok(connectionPenaltyFor(CONNECTION_PENALTY.ownMetal, 9) <= base * 2.5 + 1e-9, 'clamped above');
  assert.ok(connectionPenaltyFor(CONNECTION_PENALTY.ownMetal, 0.5) >= base * 0.8 - 1e-9, 'clamped below');
  // At equal fare a Major-Hub one-stop takes about a third of a pair against a
  // nonstop — not the ~42% the unscaled base allowed.
  const w = Math.exp(-connectionPenaltyFor(HUB_TIERS[2].connPenalty, CONNECTION_TIME_BASE));
  assert.ok(w / (1 + w) < 0.37 && w / (1 + w) > 0.30, `equal-fare share ${(w / (1 + w)).toFixed(3)}`);
});

test('a rival one-stop over an on-the-way hub scores better than the same rival over a detour hub', () => {
  // Both hubs tier 1; MSP is roughly on the way for ORD–SEA, DFW is a detour.
  const viaMSP = rival('a', 'MSP', ['MSP-ORD', 'MSP-SEA', 'MSP-DEN', 'MSP-LAX']);
  const viaDFW = rival('b', 'DFW', ['DFW-ORD', 'DFW-SEA', 'DFW-DEN', 'DFW-LAX']);
  const m = buildRouteMarket('ORD', 'SEA', GD, 1, 1);
  const [oMSP] = rivalOneStopOffersFor(buildRivalHubIndex([viaMSP]), m);
  const [oDFW] = rivalOneStopOffersFor(buildRivalHubIndex([viaDFW]), m);
  assert.ok(oMSP && oDFW, 'both routings exist (DFW is under the 1.5× cap)');
  assert.ok(oMSP.connectivityBonus > oDFW.connectivityBonus,
    `MSP ${oMSP.connectivityBonus.toFixed(3)} should beat DFW ${oDFW.connectivityBonus.toFixed(3)}`);
  assert.ok(oMSP.via.timeRatio < oDFW.via.timeRatio);
});

test('the MIA–ATL problem: a T1 one-stop over MCO no longer takes ~42% of a 90-minute sector', () => {
  const sun = rival('sun', 'MCO', ['MCO-MIA', 'MCO-ATL', 'MCO-JFK', 'MCO-BOS']);
  const m = buildRouteMarket('MIA', 'ATL', GD, 1, 1);
  const player = { airlineId: 'player', origin: 'MIA', destination: 'ATL', economyPrice: m.referencePrice,
    businessPrice: Math.round(m.referencePrice * 3.5), weeklyFrequency: 21, seatsPerFlight: 180,
    economySeats: 1e6, businessSeats: 1e5, totalSeats: 1.1e6, qualityScore: 70, connectivityBonus: 0 };
  const offers = [player, ...rivalOneStopOffersFor(buildRivalHubIndex([sun]), m)];
  assert.equal(offers.length, 2);
  const res = computeMarketShare(m, offers);
  const share = res[1].totalPax / (res[0].totalPax + res[1].totalPax);
  assert.ok(share < 0.25, `MCO one-stop share on MIA–ATL should be well under 25%, got ${(share * 100).toFixed(0)}%`);
});

console.log('\n── through-fares ────────────────────────');

test('a connection is priced against the nonstop market, never above the sum of its legs', () => {
  const sum = referencePrice('JFK', 'FRA') + referencePrice('FRA', 'AMS');
  const ref = referencePrice('JFK', 'AMS');
  assert.ok(sum > ref * THROUGH_FARE_INDEX, 'fixture: the triangle is above the through-fare cap');
  assert.equal(throughFare(sum, 'JFK', 'AMS'), Math.round(ref * THROUGH_FARE_INDEX));
  assert.equal(throughFare(100, 'JFK', 'AMS'), 100, 'a cheap pair of legs stays cheap');
});

test('every connecting offer kind uses it — rival one-stop, own-metal', () => {
  const rh = rival('rhine', 'FRA', ['FRA-JFK', 'FRA-AMS', 'FRA-MAD', 'FRA-FCO']);
  const m = buildRouteMarket('JFK', 'AMS', GD, 1, 1);
  const [o] = rivalOneStopOffersFor(buildRivalHubIndex([rh]), m);
  assert.equal(o.economyPrice, throughFare(o.via.legInPrice + o.via.legOutPrice, 'JFK', 'AMS'));
  assert.ok(o.economyPrice < o.via.legInPrice + o.via.legOutPrice, 'the cap binds on this triangle');
  // Own-metal: the same rule on your own itineraries.
  const routes = [{ id: 'a', origin: 'LHR', destination: 'JFK', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'JFK') },
                  { id: 'b', origin: 'LHR', destination: 'AMS', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'AMS') }];
  const conns = buildOwnMetalConnections(routes);
  const rev = computeOwnMetalODRevenue(conns, { hubs: { LHR: { tier: 2 } }, gates: { LHR: 20 }, routeCountByAirport: { LHR: 2 } });
  const e = rev.entries.find(x => x.od === 'AMS→JFK' || x.od === 'JFK→AMS');
  assert.ok(e, 'own-metal AMS–JFK market exists');
  assert.ok(e.fare <= Math.round(referencePrice('AMS', 'JFK') * THROUGH_FARE_INDEX) + 1, `own-metal fare ${e.fare} should be capped at the through-fare`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
