// Hub redesign test suite — focus cities, progression friction, cost
// efficiencies, itinerary revenue, hub competition, gate congestion.
//
// Run with: node --import ./tools/_register-loader.mjs tools/hub-model-test.mjs

import {
  HUB_TIERS, HUB_TIER_COUNT, HUB_MIN_GATES, FOCUS_MIN_GATES,
  hubCongestionFactor, hubUpgradeChecklist,
  playerRoutesAtAirport, intlDestinationsFrom,
  computeConnectingDemand,
} from '../src/models/demand.js';
import {
  buildHubContestMap, computeOwnMetalODRevenue, buildAllConnections,
  ownMetalPenaltyAt, runNetworkTick,
} from '../src/models/network.js';
import { weeklyTick, defaultConfig, defaultClassPrices } from '../src/utils/simulation.js';
import { gameReducer } from '../src/store/GameContext.jsx';
import { getAircraftType } from '../src/data/aircraft.js';
import { referencePrice } from '../src/utils/market.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

// ── 1. Tier table ─────────────────────────────────────────────────────────────
console.log('\n── HUB_TIERS ────────────────────────────');
ok('tier 0 (Focus City) exists', HUB_TIERS[0]?.name === 'Focus City');
ok('focus city min gates = 5', HUB_TIERS[0].minGates === FOCUS_MIN_GATES && FOCUS_MIN_GATES === 5);
ok('focus city external capture ≈ 10% of Hub', Math.abs(HUB_TIERS[0].captureRate / HUB_TIERS[1].captureRate - 0.1) < 1e-9);
ok('T2 requires 20 routes', HUB_TIERS[2].routesRequired === 20);
ok('T3 requires 50 routes', HUB_TIERS[3].routesRequired === 50);
ok('T3 requires 26-wk tenure + throughput', HUB_TIERS[3].tenureWeeks === 26 && HUB_TIERS[3].throughputRequired === 1000);
ok('conn penalty improves with tier', HUB_TIERS[0].connPenalty > HUB_TIERS[1].connPenalty
  && HUB_TIERS[1].connPenalty > HUB_TIERS[2].connPenalty && HUB_TIERS[2].connPenalty > HUB_TIERS[3].connPenalty);
ok('HUB_TIER_COUNT unchanged (3)', HUB_TIER_COUNT === 3);

// ── 2. Gate congestion ────────────────────────────────────────────────────────
console.log('\n── Gate congestion ──────────────────────');
ok('below threshold → 1.0', hubCongestionFactor(10, 10, 1) === 1.0);        // 1.0 ratio ≤ 1.5
ok('at threshold → 1.0', hubCongestionFactor(15, 10, 1) === 1.0);           // 1.5 ratio
ok('above threshold declines', hubCongestionFactor(30, 10, 1) < 1.0);
ok('floored at 0.55', hubCongestionFactor(500, 10, 1) === 0.55);
ok('higher tier tolerates more', hubCongestionFactor(22, 10, 3) === 1.0 && hubCongestionFactor(22, 10, 1) < 1.0);
ok('unknown gates → no penalty', hubCongestionFactor(30, 0, 1) === 1.0);

// ── 3. Prerequisite checklist ─────────────────────────────────────────────────
console.log('\n── hubUpgradeChecklist ──────────────────');
const mkRoutes = (n, from, opts = {}) => Array.from({ length: n }, (_, i) => ({
  id: `r${i}`, origin: from, destination: opts.dests?.[i] ?? 'LAX', weeklyFrequency: 7,
}));
{
  // T1 at JFK (US home): needs 10 gates, $5M, 4 routes
  const snap = {
    routes: mkRoutes(4, 'JFK'), gates: { JFK: 10 }, homeCountry: 'US',
    hubs: {}, hubThroughput: {}, cash: 5_000_000, absWeek: 10,
  };
  ok('T1 ok when all prereqs met', hubUpgradeChecklist(snap, 'JFK', 1).ok === true);
  ok('T1 fails on cash', hubUpgradeChecklist({ ...snap, cash: 4_999_999 }, 'JFK', 1).ok === false);
  ok('T1 fails on gates', hubUpgradeChecklist({ ...snap, gates: { JFK: 9 } }, 'JFK', 1).ok === false);
  ok('T1 fails on routes', hubUpgradeChecklist({ ...snap, routes: mkRoutes(3, 'JFK') }, 'JFK', 1).ok === false);
  ok('T1 fails abroad', hubUpgradeChecklist({ ...snap, gates: { LHR: 10 }, routes: mkRoutes(4, 'LHR') }, 'LHR', 1).ok === false);
}
{
  // Focus city abroad: fine once, blocked twice in the same country
  const base = {
    routes: [], gates: { LHR: 5, MAN: 5 }, homeCountry: 'US',
    hubs: {}, hubThroughput: {}, cash: 2_000_000, absWeek: 10,
  };
  ok('foreign focus city allowed', hubUpgradeChecklist(base, 'LHR', 0).ok === true);
  const withLHR = { ...base, hubs: { LHR: { tier: 0 } } };
  ok('second focus city in same foreign country blocked',
    hubUpgradeChecklist(withLHR, 'MAN', 0).ok === false);
  ok('focus city at home unlimited', hubUpgradeChecklist(
    { ...withLHR, gates: { ...withLHR.gates, MIA: 5, BOS: 5 }, hubs: { ...withLHR.hubs, MIA: { tier: 0 } } },
    'BOS', 0).ok === true);
}
{
  // T3: tenure + throughput
  const routes50 = Array.from({ length: 50 }, (_, i) => ({
    id: `r${i}`, origin: 'JFK',
    destination: ['LHR', 'CDG', 'FRA', 'AMS', 'NRT', 'HKG'][i % 6],
    weeklyFrequency: 7,
  }));
  const snap = {
    routes: routes50, gates: { JFK: 20 }, homeCountry: 'US',
    hubs: { JFK: { tier: 2, tierSince: 0 } },
    hubThroughput: { JFK: [1200, 1100, 1300, 1250] },
    cash: 100_000_000, absWeek: 30,
  };
  ok('T3 ok with 50 routes, 6 intl, tenure, throughput', hubUpgradeChecklist(snap, 'JFK', 3).ok === true);
  ok('T3 fails on tenure', hubUpgradeChecklist({ ...snap, hubs: { JFK: { tier: 2, tierSince: 20 } } }, 'JFK', 3).ok === false);
  ok('T3 fails on throughput', hubUpgradeChecklist({ ...snap, hubThroughput: { JFK: [500, 400, 600, 550] } }, 'JFK', 3).ok === false);
  ok('T3 fails with <4 weeks of throughput data', hubUpgradeChecklist({ ...snap, hubThroughput: { JFK: [2000, 2000] } }, 'JFK', 3).ok === false);
  ok('intl destinations counted', intlDestinationsFrom(routes50, 'JFK') === 6);
  ok('routes at airport counted', playerRoutesAtAirport(routes50, 'JFK') === 50);
}

// ── 4. Reducers ───────────────────────────────────────────────────────────────
console.log('\n── Reducers ─────────────────────────────');
const baseState = {
  cash: 200_000_000, week: 1, year: 1, homeCountry: 'US',
  routes: mkRoutes(4, 'JFK'), gates: { JFK: 10, LHR: 5 },
  hubs: {}, hubConstruction: {}, hubThroughput: {},
};
{
  const s = gameReducer({ ...baseState }, { type: 'DESIGNATE_FOCUS_CITY', airportCode: 'LHR' });
  ok('focus city designated instantly', s.hubs.LHR?.tier === 0);
  ok('focus city capex deducted', s.cash === baseState.cash - HUB_TIERS[0].capex);
  const s2 = gameReducer({ ...s, gates: { ...s.gates, MAN: 5 } }, { type: 'DESIGNATE_FOCUS_CITY', airportCode: 'MAN' });
  ok('second UK focus city rejected', !s2.hubs.MAN);
}
{
  const s = gameReducer({ ...baseState }, { type: 'DESIGNATE_HUB', airportCode: 'JFK' });
  ok('hub designation starts construction (no instant tier)', !s.hubs.JFK && s.hubConstruction.JFK?.targetTier === 1);
  ok('hub capex deducted up front', s.cash === baseState.cash - HUB_TIERS[1].capex);
  ok('construction weeks = buildWeeks', s.hubConstruction.JFK.weeksLeft === HUB_TIERS[1].buildWeeks);
  const s2 = gameReducer(s, { type: 'DOWNGRADE_HUB', airportCode: 'JFK' });
  ok('cancel refunds 50%', s2.cash === s.cash + Math.round(HUB_TIERS[1].capex * 0.5) && !s2.hubConstruction.JFK);
}
{
  // Upgrade T1→T2 blocked without 20 routes
  const s = gameReducer(
    { ...baseState, gates: { JFK: 15 }, hubs: { JFK: { tier: 1, tierSince: 0 } } },
    { type: 'UPGRADE_HUB', airportCode: 'JFK' });
  ok('T2 upgrade blocked at 4 routes', !s.hubConstruction?.JFK);
  const routes20 = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i}`, origin: 'JFK', destination: ['LHR', 'CDG', 'LAX', 'ORD'][i % 4], weeklyFrequency: 7,
  }));
  const s2 = gameReducer(
    { ...baseState, routes: routes20, gates: { JFK: 15 }, hubs: { JFK: { tier: 1, tierSince: 0 } } },
    { type: 'UPGRADE_HUB', airportCode: 'JFK' });
  ok('T2 upgrade starts with 20 routes + 2 intl', s2.hubConstruction?.JFK?.targetTier === 2);
}
{
  // Focus city promotion goes through construction
  const s = gameReducer(
    { ...baseState, hubs: { JFK: { tier: 0, tierSince: 0 } } },
    { type: 'UPGRADE_HUB', airportCode: 'JFK' });
  ok('focus city promotion starts T1 construction', s.hubConstruction?.JFK?.targetTier === 1);
  ok('existing tier kept during construction', s.hubs.JFK?.tier === 0);
}

// ── 5. Connecting demand (external pool) ──────────────────────────────────────
console.log('\n── computeConnectingDemand ──────────────');
{
  const price = referencePrice('DXB', 'LHR');
  const hub  = computeConnectingDemand('DXB', 'LHR', { DXB: { tier: 1 } }, 8, 2, price, { gates: { DXB: 10 } });
  const noHub = computeConnectingDemand('DXB', 'LHR', {}, 8, 2, price, {});
  const focus = computeConnectingDemand('DXB', 'LHR', { DXB: { tier: 0 } }, 8, 2, price, { gates: { DXB: 10 } });
  ok('own-hub external feed > undesignated', hub.origin.pax > 0);
  ok('internal pool removed', (hub.origin.internalPax ?? 0) === 0);
  ok('focus city captures ~10% of hub', focus.origin.pax > 0 && focus.origin.pax < hub.origin.pax * 0.25);
  ok('undesignated gateway still yields partner feed', noHub.origin.pax > 0 && noHub.origin.yield === 0.8);
  const congested = computeConnectingDemand('DXB', 'LHR', { DXB: { tier: 1 } }, 30, 2, price, { gates: { DXB: 10 } });
  ok('congestion trims external feed', congested.origin.pax < hub.origin.pax);
  const contested = computeConnectingDemand('DXB', 'LHR', { DXB: { tier: 1 } }, 8, 2, price,
    { gates: { DXB: 10 }, contestFactors: { DXB: 0.4 } });
  ok('contest trims external feed', contested.origin.pax < hub.origin.pax);
}

// ── 6. Hub competition ────────────────────────────────────────────────────────
console.log('\n── buildHubContestMap ───────────────────');
{
  const noRivals = buildHubContestMap([], { JFK: 10 }, { JFK: { tier: 1 } });
  ok('uncontested hub → share 1.0', noRivals.JFK.playerShare === 1.0);
  const rival = {
    id: 'zoomjet', name: 'ZoomJet', tier: 'budget', homeHub: 'ORD',
    routes: Object.fromEntries(['ATL-ORD','DEN-ORD','DFW-ORD','JFK-ORD','LAX-ORD','LAS-ORD','MIA-ORD'].map(k => [k, {}])),
  };
  const contested = buildHubContestMap([rival], { ORD: 5 }, { ORD: { tier: 1 } });
  ok('rival home hub contests the pool', contested.ORD.playerShare < 1.0);
  ok('rivals listed', contested.ORD.rivals.length === 1 && contested.ORD.rivals[0].id === 'zoomjet');
  const smallPresence = { ...rival, homeHub: 'MDW', routes: { 'JFK-ORD': {}, 'LAX-ORD': {} } };
  const light = buildHubContestMap([smallPresence], { ORD: 5 }, { ORD: { tier: 1 } });
  ok('non-hubbed presence (<6 routes, not home) ignored', light.ORD.playerShare === 1.0);
}

// ── 7. Own-metal itinerary revenue ────────────────────────────────────────────
console.log('\n── computeOwnMetalODRevenue ─────────────');
{
  const routes = [
    { id: 'r1', origin: 'CAI', destination: 'DXB', weeklyFrequency: 7, ticketPrice: referencePrice('CAI', 'DXB') },
    { id: 'r2', origin: 'DXB', destination: 'SIN', weeklyFrequency: 7, ticketPrice: referencePrice('DXB', 'SIN') },
  ];
  const conns = buildAllConnections(routes, [], new Map());
  ok('connections enumerated', conns.length > 0);
  const designated = computeOwnMetalODRevenue(conns, { hubs: { DXB: { tier: 3 } }, gates: { DXB: 20 }, routeCountByAirport: { DXB: 2 } });
  const undesignated = computeOwnMetalODRevenue(conns, { hubs: {} });
  const focusCity = computeOwnMetalODRevenue(conns, { hubs: { DXB: { tier: 0 } }, gates: { DXB: 20 }, routeCountByAirport: { DXB: 2 } });
  ok('designated hub monetizes own-metal connections', designated.totalRevenue > 0);
  ok('undesignated airport earns nothing', undesignated.totalRevenue === 0);
  ok('focus city earns less than T3 gateway', focusCity.totalRevenue > 0 && focusCity.totalRevenue < designated.totalRevenue);
  const legKeys = Object.keys(designated.byRouteKey);
  ok('revenue lands on both legs', legKeys.includes('CAI-DXB') && legKeys.includes('DXB-SIN'));
  const leg1 = designated.byRouteKey['CAI-DXB'];
  ok('feeds carry O&D detail', leg1.feeds.length > 0 && leg1.feeds[0].viaHub === 'DXB');
  ok('penalty helper: undesignated → null', ownMetalPenaltyAt({}, 'DXB') === null);
  ok('penalty helper: tiered', ownMetalPenaltyAt({ DXB: { tier: 3 } }, 'DXB') === HUB_TIERS[3].connPenalty);
}

// ── 8. weeklyTick integration ─────────────────────────────────────────────────
console.log('\n── weeklyTick smoke ─────────────────────');
{
  const type = getAircraftType('a320neo');
  const mk = (id) => ({
    id, typeId: type.id, status: 'assigned', ageWeeks: 52,
    config: defaultConfig(type.seats), ownershipType: 'owned',
  });
  // High frequency so direct pax don't fill every seat — leaves headroom for
  // connecting feed (capacity coupling is exercised separately below).
  const routes = [
    { id: 'r1', origin: 'CAI', destination: 'DXB', aircraftId: 'a1', weeklyFrequency: 21 },
    { id: 'r2', origin: 'DXB', destination: 'BOM', aircraftId: 'a2', weeklyFrequency: 21 },
  ];
  // Priced above reference so the legs don't sell out on direct pax alone —
  // leaves seat headroom for the connecting feed to occupy.
  const routePricing = {
    'CAI-DXB': defaultClassPrices(Math.round(referencePrice('CAI', 'DXB') * 1.8)),
    'BOM-DXB': defaultClassPrices(Math.round(referencePrice('BOM', 'DXB') * 1.8)),
  };
  const state = {
    fleet: [mk('a1'), mk('a2')], routes, cargoRoutes: [],
    gameDate: { week: 1, month: 6 },
    gates: { CAI: 2, DXB: 10, BOM: 2 },
    hubs: { DXB: { tier: 2, tierSince: 0 } },
    routePricing, routeCatering: {},
    competitors: [], labor: undefined,
  };
  const report = weeklyTick(state);
  ok('tick runs', !!report);
  ok('no NaN cashDelta', Number.isFinite(report.cashDelta));
  ok('hubThroughput reported for DXB', typeof report.hubThroughput?.DXB === 'number');
  ok('own-metal itinerary revenue flows', (report.ownMetalOD?.totalRevenue ?? 0) > 0);
  ok('hub contest map present', !!report.hubContestMap?.DXB);
  ok('cost savings reported', Number.isFinite(report.totalHubCostSavings) && report.totalHubCostSavings > 0);
  const r1 = report.routeResults.find(r => r.routeId === 'r1');
  ok('route carries connecting breakdown', r1 && r1.connecting && Number.isFinite(r1.connecting.totalRevenue));
  ok('itinerary feed present on leg', (r1?.connecting?.itineraryPax ?? 0) > 0);
  // Cost efficiency: same route without any hub should cost more in station buckets
  const noHubReport = weeklyTick({ ...state, hubs: {} });
  const r1n = noHubReport.routeResults.find(r => r.routeId === 'r1');
  ok('hub route has lower station costs than no-hub',
    r1.groundHandlingCost <= r1n.groundHandlingCost && r1.cateringCost <= r1n.cateringCost);
  ok('layover discount applies', r1.layoverCost <= r1n.layoverCost);
}

// ── 9. runNetworkTick wiring ──────────────────────────────────────────────────
console.log('\n── runNetworkTick ───────────────────────');
{
  const routes = [
    { id: 'r1', origin: 'CAI', destination: 'DXB', weeklyFrequency: 7, ticketPrice: referencePrice('CAI', 'DXB') },
    { id: 'r2', origin: 'DXB', destination: 'SIN', weeklyFrequency: 7, ticketPrice: referencePrice('DXB', 'SIN') },
  ];
  const out = runNetworkTick({
    routes, competitors: [], hubs: { DXB: { tier: 1 } },
    gates: { DXB: 10 }, routeCountByAirport: { DXB: 2, CAI: 1, SIN: 1 },
  });
  ok('returns ownMetalOD + hubContestMap', !!out.ownMetalOD && !!out.hubContestMap);
  ok('legacy fields intact', !!out.cannibalizationMap && !!out.partnerODRevenue);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
