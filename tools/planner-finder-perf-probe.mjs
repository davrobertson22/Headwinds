#!/usr/bin/env node
// planner-finder-perf-probe.mjs — @not-a-test: a measurement, not a pass/fail suite.
//
// What the Route Planner's aircraft ranking and the Route Finder's forecast pass
// cost, on a solo-shaped world and on Headwinds worlds of increasing size. Built
// for the lag report of 9/11-12/26 (@silv4013, LtFrosty, ASAS) and kept so the
// next "is this slow?" is answered with a number.
//
//   node --import ./tools/_register-loader.mjs tools/planner-finder-perf-probe.mjs
//
// Read it as SHAPE, not as milliseconds: this is Node on a dev machine, and a
// browser on a mid-range laptop runs several times slower. The figure that
// matters is how the totals move from the solo row to the busy row — that gap is
// the multiplayer cost ASAS pointed at.
import { performance } from 'node:perf_hooks';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType, AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { AIRPORTS, getAirport } from '../packages/engine/src/data/airports.js';
import { defaultConfig, defaultClassPrices, distanceKm, referencePrice, effectiveRangeKm } from '../packages/engine/src/utils/simulation.js';

import { projectRouteAddition, pairMarketShare, projectConnectingFeed, pairKeyOf } from '../packages/engine/src/models/pairShare.js';
import { rankAircraftForRoute } from '../packages/engine/src/models/aircraftRecommender.js';
import { findCandidates, scoreCandidates, DEFAULT_SCORE_LIMIT } from '../packages/engine/src/models/routeFinder.js';

Math.random = (() => { let s = 987654; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

const wide = getAircraftType('b7879'), narrow = getAircraftType('a320neo');
let n = 0;
const mkAc = (t) => ({ id: `p${n++}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `N${n}P`, name: t.name });
const fleet = [], routes = [], routePricing = {}, gates = {};
const addRoute = (o, d, freq) => {
  const t = distanceKm(getAirport(o), getAirport(d)) > 4000 ? wide : narrow;
  const ac = mkAc(t); fleet.push(ac);
  routes.push({ id: `r${routes.length}`, origin: o, destination: d, stops: [o, d], aircraftId: ac.id, weeklyFrequency: freq, weeksOpen: 30 });
  routePricing[pairKeyOf(o, d)] = defaultClassPrices(Math.round(referencePrice(o, d)));
  gates[o] = (gates[o] ?? 0) + 1; gates[d] = (gates[d] ?? 0) + 1;
};
const JFK_SPOKES = ['LHR','CDG','FRA','LAX','SFO','MIA','ORD','BOS','ATL','DFW','DEN','SEA','YYZ','MEX','GRU','MAD','FCO','DUB','AMS','LAS'];
for (const s of JFK_SPOKES) addRoute('JFK', s, 14);
for (const s of ['DEN','MSP','DTW','STL','MCI','LAS','PHX','SEA','SFO','IAH']) addRoute('ORD', s, 14);
for (const [o, d] of [['LAX','SFO'],['MIA','ATL'],['BOS','DCA'],['SEA','PDX'],['DEN','SLC'],['LAX','LAS']]) addRoute(o, d, 21);
gates.JFK = 24; gates.ORD = 14;

let base = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe', hub: 'JFK', enableObjectives: false });
base = { ...base, cash: 500_000_000, fleet, routes, routePricing, gates,
  hubs: { JFK: { tier: 2, tierSince: 0 }, ORD: { tier: 1, tierSince: 0 } } };

// ── Synthetic human rivals, server-shaped ───────────────────────────────────
const BIG = AIRPORTS.filter(a => a.size === 'large' || a.size === 'major' || (a.passengers ?? 0) > 8e6).slice(0, 200);
const pool = BIG.length >= 60 ? BIG : AIRPORTS.slice(0, 200);
function buildRivals(playerCount, routesEach) {
  const competitors = [], humanRivals = {};
  for (let p = 0; p < playerCount; p++) {
    const hub = pool[(p * 7) % pool.length].code;
    const rroutes = {};
    for (let k = 0; k < routesEach; k++) {
      const dst = pool[(p * 13 + k * 3 + 1) % pool.length].code;
      if (dst === hub) continue;
      const key = pairKeyOf(hub, dst);
      const ref = referencePrice(hub, dst) || 200;
      rroutes[key] = { frequency: 14, priceMultiplier: 1, economyFare: Math.round(ref),
        seatsPerWeek: 180 * 14, seats: 180, businessSeatsPerWeek: 20 * 14,
        businessFare: Math.round(ref * 2.5), aircraftTypes: ['a320neo'], aircraftType: 'a320neo' };
      (humanRivals[key] ??= []).push({
        competitorId: `human:${p}`, name: `Rival ${p}`, origin: hub, destination: dst,
        frequency: 14, weeklyFrequency: 14, economyFare: Math.round(ref), businessFare: Math.round(ref * 2.5),
        seatsPerWeek: 180 * 14, seats: 180, businessSeatsPerWeek: 20 * 14,
        qualityScore: 62, priceMultiplier: 1, aircraftType: 'a320neo',
      });
    }
    competitors.push({ id: `human:${p}`, human: true, name: `Rival ${p}`, homeHub: hub,
      hubs: { [hub]: { tier: 1 } }, tier: 'legacy', routes: rroutes,
      baseQualityScore: 62, marketShare: 0.02, cash: 5e8 });
  }
  return { competitors, humanRivals };
}

function mkState({ players, routesEach, itineraries }) {
  const { competitors, humanRivals } = buildRivals(players, routesEach);
  return { ...base, multiplayer: true, competitors, humanRivals, encroachments: {},
           rivalItineraries: itineraries };
}

const gameDate = { week: 30, month: 6, absWeek: 30 };
const reachable = AIRCRAFT_TYPES.filter(t => !t.freighter);
function timeIt(label, fn, iters = 1) {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  console.log(`  ${label.padEnd(52)} ${ms.toFixed(1)} ms`);
  return ms;
}

const scenarios = [
  ['solo-shaped  (0 rivals, itineraries off)', { players: 0,  routesEach: 0,  itineraries: false }],
  ['MP small     (8 players x 20 routes)',     { players: 8,  routesEach: 20, itineraries: true  }],
  ['MP typical   (25 players x 30 routes)',    { players: 25, routesEach: 30, itineraries: true  }],
  ['MP busy      (40 players x 45 routes)',    { players: 40, routesEach: 45, itineraries: true  }],
];

for (const [label, cfg] of scenarios) {
  const st = mkState(cfg);
  const nKeys = Object.keys(st.humanRivals).length;
  console.log(`\n=== ${label}  | humanRivals pairs: ${nKeys} | competitors: ${st.competitors.length} ===`);

  const dist = Math.round(distanceKm(getAirport('JFK'), getAirport('LHR')));
  const types = reachable.filter(t => effectiveRangeKm({ typeId: t.id }, t) >= dist);

  timeIt('1x projectRouteAddition (JFK-LHR, contested)', () => projectRouteAddition(st, {
    origin: 'JFK', destination: 'LHR', aircraft: mkAc(wide), weeklyFrequency: 7,
    ticketPrice: referencePrice('JFK','LHR'), classPrices: defaultClassPrices(referencePrice('JFK','LHR')), gameDate }), 5);

  timeIt('  └ pairMarketShare only', () => pairMarketShare(st, 'JFK', 'LHR', { gameDate }), 5);
  timeIt('  └ projectConnectingFeed only', () => projectConnectingFeed(st, {
    origin: 'JFK', destination: 'LHR', aircraft: mkAc(wide), weeklyFrequency: 7,
    ticketPrice: referencePrice('JFK','LHR'), gameDate, configuredSeatsOneWay: 250 }), 5);

  timeIt(`PLANNER rankAircraftForRoute (${types.length} types)`, () => rankAircraftForRoute(st, {
    origin: 'JFK', destination: 'LHR', distKm: dist, types, weeklyFrequency: 7,
    ticketPrice: referencePrice('JFK','LHR'), gameDate }), 1);

  const rows = timeIt('FINDER findCandidates (no forecast)', () => findCandidates(st, {
    origin: 'JFK', aircraftTypeId: 'a320neo', hideUnflyable: true, hideServedLanes: true }), 2) &&
    findCandidates(st, { origin: 'JFK', aircraftTypeId: 'a320neo', hideUnflyable: true, hideServedLanes: true });
  console.log(`     (rows: ${rows.length})`);
  timeIt(`FINDER scoreCandidates limit ${DEFAULT_SCORE_LIMIT}`, () => scoreCandidates(st, rows, {
    aircraftTypeId: 'a320neo', weeklyFrequency: 7, gameDate, limit: DEFAULT_SCORE_LIMIT }), 1);
  timeIt('FINDER scoreCandidates limit 25 (asGiven)', () => scoreCandidates(st, rows, {
    aircraftTypeId: 'a320neo', weeklyFrequency: 7, gameDate, limit: 25, order: 'asGiven' }), 1);
}
