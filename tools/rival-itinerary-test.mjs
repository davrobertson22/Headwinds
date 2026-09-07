// Rival one-stop itineraries — HUB_CONNECTIVITY_PLAN.md Phase 1b.
//
// Until now the only airline in the game that sold a connection was the player.
// Every rival flew point-to-point as far as the demand model knew; rival hubs
// were three fudges (a connectivity bump on their nonstops, a contest factor on
// the player's pool, a bump to the outside option). Now a rival with a declared
// hub H flying A–H and H–C puts a real A→H→C offer into the A–C market — the
// player's nonstop market, their own-metal markets and their partner markets —
// through the same logit that books everyone else.
//
//   node --import ./tools/_register-loader.mjs tools/rival-itinerary-test.mjs

import assert from 'node:assert/strict';
import {
  buildRivalHubIndex, rivalIndexFor, rivalOneStopOffersFor, rivalHubTierForSpokes,
  MAX_CIRCUITY, computeOwnMetalODRevenue, buildOwnMetalConnections,
  throughFare, connectionPenaltyFor,
} from '../packages/engine/src/models/network.js';
import { buildRouteMarket, computeMarketShare, HUB_TIERS } from '../packages/engine/src/models/demand.js';
import { rivalOffersFor, simulateRoute, defaultConfig } from '../packages/engine/src/utils/simulation.js';
import { pairMarketShare } from '../packages/engine/src/models/pairShare.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const GD = { week: 20, month: 5 };
const rival = (id, homeHub, pairs, over = {}) => ({
  id, name: id, homeHub, tier: 'legacy', baseQualityScore: 70, cash: 1e8,
  routes: Object.fromEntries(pairs.map(k => [k.split('-').sort().join('-'), { frequency: 14, priceMultiplier: 1.0, ...over }])),
});
// "Rhine Air" hubbed at FRA with 6 spokes — a T1 hub by the player's own rule.
const RHINE = rival('rhine', 'FRA', ['FRA-JFK', 'FRA-AMS', 'FRA-MAD', 'FRA-FCO', 'FRA-LHR', 'FRA-CDG']);

console.log('\n── rival hub index ──────────────────────');

test('tier from spoke count uses the player\'s own thresholds', () => {
  assert.equal(rivalHubTierForSpokes(3), null);
  assert.equal(rivalHubTierForSpokes(HUB_TIERS[1].routesRequired), 1);
  assert.equal(rivalHubTierForSpokes(HUB_TIERS[2].routesRequired), 2);
  assert.equal(rivalHubTierForSpokes(HUB_TIERS[3].routesRequired), 3);
});

test('a declared hub with enough spokes is a connection point; a busy non-hub is not', () => {
  const idx = buildRivalHubIndex([RHINE]);
  const e = idx.get('rhine');
  assert.equal(e.tierAt.get('FRA'), 1);
  assert.equal(e.legs.get('FRA').size, 6);
  assert.ok(!e.tierAt.has('JFK'), 'JFK is a spoke, not a rival hub');
  const thin = rival('thin', 'FRA', ['FRA-JFK', 'FRA-AMS', 'FRA-MAD']);
  assert.ok(!buildRivalHubIndex([thin]).get('thin').tierAt.has('FRA'), '3 spokes is below the T1 bar');
});

test('the index is off unless state.rivalItineraries is true', () => {
  assert.equal(rivalIndexFor({ competitors: [RHINE] }), null);
  assert.equal(rivalIndexFor({ competitors: [RHINE], rivalItineraries: false }), null);
  assert.ok(rivalIndexFor({ competitors: [RHINE], rivalItineraries: true }) instanceof Map);
});

console.log('\n── one-stop offers ──────────────────────');
const idx = buildRivalHubIndex([RHINE]);
const mkt = (a, b) => buildRouteMarket(a, b, GD, 1, 1);

test('a rival hub between the endpoints yields exactly one offer, with the §3.3 shape', () => {
  const m = mkt('JFK', 'AMS');
  const offers = rivalOneStopOffersFor(idx, m);
  assert.equal(offers.length, 1);
  const o = offers[0];
  assert.ok(o.airlineId.startsWith('__rival_conn__rhine__FRA'));
  assert.equal(o.via.hub, 'FRA'); assert.equal(o.via.competitorId, 'rhine'); assert.equal(o.via.tier, 1);
  // Phase 3: priced against the nonstop market — the sum of legs capped at the through-fare.
  assert.equal(o.economyPrice, throughFare(Math.round(referencePrice('JFK', 'FRA')) + Math.round(referencePrice('FRA', 'AMS')), 'JFK', 'AMS'));
  assert.equal(o.weeklyFrequency, 14, 'min of the two legs');
  assert.ok(o.economySeats > 0 && o.economySeats < 14 * 250, 'a fraction of the thinner leg');
  // Phase 3: the tier penalty scaled by what the stop costs the traveller.
  assert.ok(Math.abs(o.connectivityBonus + connectionPenaltyFor(HUB_TIERS[1].connPenalty, o.via.timeRatio)) < 1e-9, 'tier-1 connection penalty × time ratio');
  assert.equal(o.qualityScore, 70 + Math.round(HUB_TIERS[1].qualityBonus / 2));
  assert.ok(o.via.circuity > 1 && o.via.circuity <= MAX_CIRCUITY);
});

test('a rival that flies the pair nonstop does not also offer a one-stop', () => {
  const both = rival('both', 'FRA', ['FRA-JFK', 'FRA-AMS', 'FRA-MAD', 'FRA-FCO', 'JFK-AMS']);
  assert.equal(rivalOneStopOffersFor(buildRivalHubIndex([both]), mkt('JFK', 'AMS')).length, 0);
});

test('a hub that IS an endpoint is not a connection', () => {
  assert.equal(rivalOneStopOffersFor(idx, mkt('JFK', 'FRA')).length, 0);
});

test('a backtracking routing above MAX_CIRCUITY is excluded', () => {
  // DOH between JFK and CDG: 2.1× the nonstop distance.
  const gulf = rival('gulf', 'DOH', ['DOH-JFK', 'DOH-CDG', 'DOH-LHR', 'DOH-BOM', 'DOH-SIN']);
  assert.equal(rivalOneStopOffersFor(buildRivalHubIndex([gulf]), mkt('JFK', 'CDG')).length, 0);
  assert.ok(MAX_CIRCUITY <= 1.5);
});

test('a human rival prices its legs at the fare it actually charges', () => {
  const human = { ...rival('bob', 'FRA', ['FRA-JFK', 'FRA-AMS', 'FRA-MAD', 'FRA-FCO'], { economyFare: 100 }), human: true };
  const [o] = rivalOneStopOffersFor(buildRivalHubIndex([human]), mkt('JFK', 'AMS'));
  assert.equal(o.economyPrice, 200);
});

test('a human rival connects over its DESIGNATED hubs at their real tier — not over its home base', () => {
  // Phase 5: the Headwinds rival view exports `hubs` (code → { tier }). A focus
  // city (tier 0) is a connection point with the tier-0 penalty; an
  // undesignated home base is not a connection point at all.
  const legs = ['FRA-JFK', 'FRA-AMS', 'FRA-MAD', 'FRA-FCO', 'LHR-JFK', 'LHR-AMS', 'LHR-MAD', 'LHR-FCO'];
  const focus = { ...rival('carol', 'FRA', legs, { economyFare: 300 }), human: true, hubs: { FRA: { tier: 0 } } };
  const offers = rivalOneStopOffersFor(buildRivalHubIndex([focus]), mkt('JFK', 'AMS'));
  assert.equal(offers.length, 1, 'FRA (designated focus city) sells the connection; LHR (undesignated) does not');
  assert.equal(offers[0].via.hub, 'FRA');
  assert.equal(offers[0].via.tier, 0);
  assert.ok(Math.abs(offers[0].connectivityBonus + connectionPenaltyFor(HUB_TIERS[0].connPenalty, offers[0].via.timeRatio)) < 1e-9, 'tier-0 penalty × time ratio');
  // Designated at a tier the spoke count would not earn: the designation wins.
  const major = { ...focus, hubs: { FRA: { tier: 2 } } };
  assert.equal(rivalOneStopOffersFor(buildRivalHubIndex([major]), mkt('JFK', 'AMS'))[0].via.tier, 2);
  // A human with an EMPTY hubs map connects nowhere, home base included.
  const none = { ...focus, hubs: {} };
  assert.equal(rivalOneStopOffersFor(buildRivalHubIndex([none]), mkt('JFK', 'AMS')).length, 0);
});

console.log('\n── where the offers enter ───────────────');

test('rivalOffersFor appends one-stops when handed an index, and nothing without one', () => {
  const m = mkt('JFK', 'AMS');
  assert.equal(rivalOffersFor([RHINE], [], m).length, 0, 'no nonstop rival on JFK–AMS');
  const withIdx = rivalOffersFor([RHINE], [], m, idx);
  assert.equal(withIdx.length, 1);
  assert.ok(withIdx[0].airlineId.startsWith('__rival_conn__'));
});

test('a player nonstop loses passengers to a rival one-stop in a market with room', () => {
  const type = getAircraftType('a320neo');
  const ac = { id: 'p', typeId: type.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(type.seats), ownershipType: 'owned' };
  // Priced above reference so the aircraft is demand-limited, not full.
  const route = { id: 'r', origin: 'JFK', destination: 'AMS', aircraftId: 'p', weeklyFrequency: 14, weeksOpen: 40, ticketPrice: Math.round(referencePrice('JFK', 'AMS') * 1.8) };
  const alone = simulateRoute(route, ac, GD, null, 1.0, null, [], null, null, 1.0, null, [RHINE]);
  const vsHub = simulateRoute(route, ac, GD, null, 1.0, null, [], null, null, 1.0, null, [RHINE], idx);
  assert.ok(alone.loadFactor < 0.95, `fixture must not be capacity-bound (LF ${alone.loadFactor})`);
  assert.ok(vsHub.passengers < alone.passengers * 0.97,
    `Rhine Air via FRA should take passengers: ${alone.passengers} → ${vsHub.passengers}`);
});

test('the preview agrees with the tick — pairMarketShare sees the same one-stop', () => {
  const state = { competitors: [RHINE], rivalItineraries: true, gameDate: GD, routes: [], fleet: [] };
  const share = pairMarketShare(state, 'JFK', 'AMS');
  assert.ok(share.offers.some(o => String(o.airlineId).startsWith('__rival_conn__rhine__FRA')));
  const off = pairMarketShare({ ...state, rivalItineraries: false }, 'JFK', 'AMS');
  assert.ok(!off.offers.some(o => String(o.airlineId).startsWith('__rival_conn__')));
});

test('the player\'s own-metal market is contested by the rival one-stop too', () => {
  // Player hubbed at LHR flying AMS and JFK: sells AMS→LHR→JFK. Rhine sells
  // AMS→FRA→JFK. 28×/wk so the player's connecting seats are not the binding
  // constraint (at 14× both routings are full and the split cannot show).
  const routes = [
    { id: 'a', origin: 'LHR', destination: 'AMS', weeklyFrequency: 28 },
    { id: 'b', origin: 'LHR', destination: 'JFK', weeklyFrequency: 28 },
  ];
  const conns = buildOwnMetalConnections(routes);
  const opts = { hubs: { LHR: { tier: 2 } }, gates: { LHR: 20 }, routeCountByAirport: { LHR: 2 } };
  const solo = computeOwnMetalODRevenue(conns, opts);
  const contested = computeOwnMetalODRevenue(conns, { ...opts, rivalIndex: idx });
  assert.ok(solo.totalPax > 0);
  assert.ok(contested.totalPax < solo.totalPax * 0.97,
    `own-metal AMS–JFK should lose to Rhine via FRA: ${solo.totalPax} → ${contested.totalPax}`);
});

console.log('\n── the battle card names the routing ────');

// SSR the REAL contested-route card: a player on JFK–AMS with no nonstop rival,
// only Rhine Air's connection over FRA. The pair must be listed as contested,
// carry a "via FRA" column with a share, and say so in a hint.
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; },
  };
  globalThis.window ??= { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  const { buildPlayerPairMap, ContestedRouteRow } = await import('../src/components/Competition.jsx');
  const type = getAircraftType('a320neo');
  const fleet = [{ id: 't1', typeId: type.id, config: { economy: type.seats, businessClass: 0 }, ageWeeks: 52 }];
  const routes = [{ origin: 'JFK', destination: 'AMS', aircraftId: 't1', weeklyFrequency: 14, ticketPrice: Math.round(referencePrice('JFK', 'AMS') * 1.8), weeksOpen: 30 }];
  const state = { ...freshState(), phase: 'playing', week: 30, year: 1, hub: 'JFK', cash: 1e7, awareness: 60,
    fleet, routes, cargoRoutes: [], competitors: [RHINE], rivalItineraries: true };
  store.set('bbae_save_v2', JSON.stringify(state));
  const map = buildPlayerPairMap(state.routes, state.fleet, 6);
  const render = () => renderToString(React.createElement(GameProvider, null,
    React.createElement(ContestedRouteRow, { routeKey: 'AMS-JFK', playerRoute: map['AMS-JFK'], competitors: [], fleet })))
    .replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
  test('the card renders a "via FRA" column for the rival one-stop', () => {
    const html = render();
    assert.ok(html.includes('via FRA'), 'column header names the hub');
    assert.ok(html.includes('rhine'), 'column header names the rival');
    assert.ok(/data-share="\d+" data-carrier="rival"/.test(html), 'the routing has a share cell');
  });
  test('…and a hint that names the hub as what the player is competing with', () => {
    assert.ok(render().includes('connection over FRA'), 'hint text');
  });
  test('with rival itineraries off, the same card shows no routing', () => {
    store.set('bbae_save_v2', JSON.stringify({ ...state, rivalItineraries: false }));
    assert.ok(!render().includes('via FRA'));
  });
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
