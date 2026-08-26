// ─────────────────────────────────────────────────────────────────────────────
// ROUTE FINDER — "where should I fly next, with the aircraft I actually own?"
//
// WHY THIS EXISTS
// ---------------
// The finder used to be a demand table with a distance filter on it. Three
// things players kept asking for, all from the same Discord thread:
//
//   ASAS            "there arent enough to sort by"
//   ASAS            "it will give you routes that the plane you selected cannot
//                    fly to as the runway length is too short"
//   ASAS            "you always have to find the aircraft you own for its max
//                    range etc — it would be nice if there was a section like in
//                    the route planner thats like the aircraft you own"
//   Lancelotbronner "multiple airports in the same city still show a large
//                    demand but none of the routes are profitable, are they
//                    linked? Should they disappear from the list as the
//                    (remaining) demand is reduced?"
//
// They are one feature. A market is only a lead if the metal you have can land
// there, nobody has already taken the traffic, and the sums come out positive —
// and the finder knew none of those three things. This module answers them with
// the ENGINE's own verdicts rather than a second opinion:
//
//   flyable?     effectiveRangeKm + checkRouteRestrictions — the same guard
//                addRouteBlockReason runs, so a row the finder offers is a route
//                the reducer will actually accept (runway length included).
//   taken?       metroPairKeyOf — Lancelotbronner is right, they ARE linked.
//                JFK–LHR and EWR–LHR are one New York↔London market, so a lane
//                you already fly is not an unserved route however you spell the
//                airport codes.
//   worth it?    projectRouteAddition — the same forecast the Route Planner
//                shows, so "Plan →" cannot contradict the row you clicked it on.
//
// The forecast is the expensive part (~1ms per market on a busy save), so it is
// bounded: `scoreCandidates` prices the top `limit` leads and says plainly which
// rows it skipped. A silent cap would read as "nothing else is worth flying".
// ─────────────────────────────────────────────────────────────────────────────

import { AIRPORTS } from '../data/airports.js';
import { getAircraftType } from '../data/aircraft.js';
import { checkRouteRestrictions } from '../data/airportRestrictions.js';
import {
  baseCityPairDemand, distanceKm, referencePrice,
  effectiveRangeKm, maxFrequency, defaultConfig, defaultClassPrices,
} from '../utils/simulation.js';
import { metroPairKeyOf, memberPairKeysOf, airportAppeal } from '../utils/market.js';
import { projectRouteAddition } from './pairShare.js';
import { computeConnectingDemand } from './demand.js';

/** How many leads get a full engine forecast before the finder stops paying for it. */
export const DEFAULT_SCORE_LIMIT = 150;

const pairKey = (a, b) => [a, b].sort().join('-');

/**
 * Every airport pair anyone is flying, as a Set of sorted pair keys. Built once
 * per search: the alternative is re-walking every competitor's route map for
 * each of ~2,000 candidate airports, which on a metro lane means 2,000 × 36
 * member pairs × 25 carriers.
 */
export function rivalPairIndex(state) {
  const counts = new Map();
  const bump = (key, id) => {
    if (!counts.has(key)) counts.set(key, new Set());
    counts.get(key).add(id);
  };
  for (const [key, specs] of Object.entries(state.humanRivals ?? {})) {
    for (const s of specs ?? []) bump(key, `h:${s?.competitorId ?? 'anon'}`);
  }
  for (const [key, spec] of Object.entries(state.encroachments ?? {})) {
    if (spec) bump(key, `e:${spec.competitorId ?? 'anon'}`);
  }
  for (const c of state.competitors ?? []) {
    for (const key of Object.keys(c.routes ?? {})) bump(key, `c:${c.id}`);
  }
  return counts;
}

/** Metro lanes the player already serves, as a Set of lane keys. */
export function servedLaneIndex(state) {
  const lanes = new Map();
  for (const r of state.routes ?? []) {
    const lane = metroPairKeyOf(r.origin, r.destination);
    if (!lanes.has(lane)) lanes.set(lane, new Set());
    lanes.get(lane).add(pairKey(r.origin, r.destination));
  }
  return lanes;
}

/**
 * Why `type` cannot fly `origin → destination`, or null if it can.
 *
 * Range first (the cheap test), then the engine's regulatory guard with the
 * aircraft attached — which is what catches a runway too short for the type, a
 * perimeter rule, and a body class an airport refuses. Passing no aircraftType
 * is exactly the hole the old finder had: checkRouteRestrictions skips its whole
 * runway pass without one.
 *
 * @returns {{kind: 'range'|'runway'|'restriction', short: string, reason: string}|null}
 */
export function laneBlockFor({
  origin, destination, distKm, type, aircraft = null, weeklyFrequency = 7, routes = [],
}) {
  if (!type) return null;
  const range = effectiveRangeKm(aircraft ?? { typeId: type.id }, type);
  if (distKm > range) {
    return {
      kind: 'range',
      short: 'out of range',
      reason: `${type.name} reaches ${Math.round(range).toLocaleString()} km; this lane is `
        + `${Math.round(distKm).toLocaleString()} km`,
    };
  }
  const key = pairKey(origin, destination);
  const existingFreq = (routes ?? [])
    .filter((r) => pairKey(r.origin, r.destination) === key)
    .reduce((s, r) => s + (r.weeklyFrequency ?? 0), 0);
  const hit = checkRouteRestrictions(
    origin, destination, distKm, existingFreq + weeklyFrequency, type.category ?? null,
    { routes, excludeKey: key, aircraftType: type });
  if (!hit) return null;
  return {
    kind: hit.restriction?.type === 'runway_length' ? 'runway' : 'restriction',
    short: hit.restriction?.type === 'runway_length'
      ? 'runway too short'
      : (hit.restriction?.shortLabel ?? 'restricted'),
    reason: hit.reason,
  };
}

/**
 * Every destination reachable from `origin`, with the cheap facts: distance, the
 * metro lane's demand, who else is on the lane, and whether the chosen aircraft
 * is allowed to land there.
 *
 * Nothing here runs the demand model — this is the part that has to stay fast
 * enough to re-run on every keystroke in the distance boxes.
 */
export function findCandidates(state, {
  origin,
  aircraftTypeId = '',
  aircraft = null,
  weeklyFrequency = 7,
  minDistKm = 0,
  maxDistKm = Infinity,
  hideUnflyable = true,
  hideServedLanes = true,
  soloOnly = false,
  // One row per MARKET, not per airport. Washington is IAD, DCA, BWI and HGR; all
  // four print the same metro total, so an ungrouped list shows the same 35,967
  // travellers a week four times over and reads as four separate opportunities.
  // That is the other half of "multiple airports in the same city still show a
  // large demand" — the demand figure was right, the row COUNT was the lie.
  groupMetros = true,
  airports = AIRPORTS,
} = {}) {
  const from = airports.find((a) => a.code === origin);
  if (!from) return [];
  const type      = aircraftTypeId ? getAircraftType(aircraftTypeId) : null;
  const rivals    = rivalPairIndex(state);
  const servedLanes = servedLaneIndex(state);
  const rows = [];

  for (const a of airports) {
    if (a.code === origin) continue;
    const demand = baseCityPairDemand(origin, a.code);
    if (demand <= 0) continue;                 // same metro, or an unpriced pair
    const distKm = Math.round(distanceKm(from, a));
    if (distKm < minDistKm || distKm > maxDistKm) continue;

    // Lancelotbronner's question, answered: sibling airports ARE linked. A lane
    // you already fly out of the other New York field is not a new market, and
    // listing it as one is what made "large demand, no profit" look like a bug in
    // the economics rather than a market you had already taken.
    const lane      = metroPairKeyOf(origin, a.code);
    const yourPairs = [...(servedLanes.get(lane) ?? [])];
    const serves    = yourPairs.length > 0;
    if (hideServedLanes && serves) continue;

    const memberKeys = memberPairKeysOf(origin, a.code);
    const laneRivals = new Set();
    for (const k of memberKeys) {
      for (const id of rivals.get(k) ?? []) laneRivals.add(id);
    }
    if (soloOnly && laneRivals.size > 0) continue;

    const block = type
      ? laneBlockFor({ origin, destination: a.code, distKm, type, aircraft,
                       weeklyFrequency, routes: state.routes ?? [] })
      : null;
    if (hideUnflyable && block) continue;

    rows.push({
      airport: a,
      origin,
      code: a.code,
      distKm,
      demand,
      refPrice: referencePrice(origin, a.code),
      lane,
      laneRivalCount: laneRivals.size,
      // Member pairs of this lane you already fly, e.g. ['JFK-LHR'] when the row
      // is EWR. Shown, not hidden, when the player asks to see served lanes.
      yourLanePairs: yourPairs,
      servesLane: serves,
      block,
      // Other airports serving the same market, best-appeal first. Populated by
      // the grouping pass below.
      altCodes: [],
      // Filled in by scoreCandidates(); null means "not priced", NOT "worthless".
      projection: null,
      scored: false,
    });
  }
  if (!groupMetros) return rows;

  // Collapse each metro lane to the field the market itself prefers.
  //
  // `airportAppeal` is the registry's own measure of how attractive a member
  // airport is to that metro's travellers for this mission — the same term the
  // demand model scores offers with — so "the best airport for this route" is the
  // engine's opinion, not a guess. A flyable field always beats an unflyable one
  // first, though: recommending Heathrow to an aircraft Heathrow will not take,
  // when Gatwick would, is worse than recommending Gatwick.
  const best = new Map();
  for (const r of rows) {
    const domestic = r.airport.country === from.country;
    r._appeal = airportAppeal(r.code, domestic, r.distKm);
    const cur = best.get(r.lane);
    if (!cur) { best.set(r.lane, r); continue; }
    const better = (!r.block && cur.block)
      || ((!r.block === !cur.block) && r._appeal > cur._appeal);
    if (better) best.set(r.lane, r);
  }
  const out = [];
  for (const r of best.values()) {
    r.altCodes = rows
      .filter((o) => o.lane === r.lane && o.code !== r.code)
      .sort((x, y) => y._appeal - x._appeal)
      .map((o) => o.code);
    delete r._appeal;
    out.push(r);
  }
  return out;
}

/**
 * Price the best `limit` leads with the engine's own launch forecast — the very
 * same projectRouteAddition the Route Planner draws its economics from, so the
 * number on the row and the number on the next screen agree.
 *
 * Mutates nothing: returns a new array. Rows past the limit keep `scored: false`
 * and the caller is expected to SAY so rather than render a blank cell.
 */
export function scoreCandidates(state, rows, {
  aircraftTypeId, aircraft = null, weeklyFrequency = 7, gameDate,
  limit = DEFAULT_SCORE_LIMIT, capHours,
  // 'demand'  price the biggest markets — what a forecast SORT needs, since it
  //           has to see the field before it can rank it.
  // 'asGiven' price the first `limit` rows in the order handed in — what an
  //           already-sorted PAGE needs, and ~6x cheaper: 25 forecasts instead of
  //           150 on every keystroke in the distance boxes.
  order = 'demand',
} = {}) {
  const type = aircraftTypeId ? getAircraftType(aircraftTypeId) : null;
  if (!type) return rows;

  // A synthetic airframe when the player owns none of the type — the planner
  // previews a TYPE the same way, so an order can be sized against a real market.
  const frame = aircraft ?? {
    id: '__finder__', typeId: type.id, ageWeeks: 0,
    config: defaultConfig(type.seats),
  };

  // Routes the player already flies through each airport — the connecting model
  // reads this as "slots", and the planner passes the same count (+1 for the
  // route being considered). Built once; the finder scores up to 150 rows.
  const routesAt = new Map();
  for (const rt of [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]) {
    for (const code of [rt.origin, rt.destination]) {
      if (code) routesAt.set(code, (routesAt.get(code) ?? 0) + 1);
    }
  }
  // What the aircraft flying it actually costs per week. An OWNED tail has no
  // lease (the tick charges 0), and a leased one pays the rate IT signed at, not
  // the catalogue rate. Only a type the player doesn't own yet is priced at list.
  const frameLease = aircraft
    ? (aircraft.ownershipType === 'owned' ? 0 : (aircraft.weeklyLease ?? type.weeklyLease ?? 0))
    : (type.weeklyLease ?? 0);

  const indexed = rows.map((r, i) => ({ r, i }));
  const ranked = order === 'asGiven'
    ? indexed.slice(0, limit)
    : indexed.sort((x, y) => y.r.demand - x.r.demand).slice(0, limit);

  const out = rows.map((r) => ({ ...r }));
  for (const { r, i } of ranked) {
    if (r.block) continue;                    // a route you cannot open has no forecast
    const freq = Math.max(1, Math.min(weeklyFrequency,
      maxFrequency(r.distKm, type, capHours)));
    const fares = defaultClassPrices(r.refPrice);
    const p = projectRouteAddition(state, {
      origin: r.origin,
      destination: r.code,
      aircraft: frame,
      weeklyFrequency: freq,
      ticketPrice: r.refPrice,
      classPrices: fares,
      gameDate,
    });
    if (!p?.mature) continue;
    // Connecting feed. weeklyTick credits a route with its connecting revenue
    // (`routeRevenue = result.revenue + connecting.totalRevenue`), and the Route
    // Planner shows it — the finder omitting it ranked every hub spoke BELOW the
    // profit the planner then quoted for the very same row.
    const connecting = computeConnectingDemand(
      r.origin, r.code, state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {}),
      (routesAt.get(r.origin) ?? 0) + 1,
      (routesAt.get(r.code)   ?? 0) + 1,
      r.refPrice,
    );
    out[i] = {
      ...out[i],
      scored: true,
      projection: {
        weeklyFrequency: freq,
        passengers:  p.mature.passengers,
        loadFactor:  p.mature.loadFactor,
        revenue:     p.mature.revenue,
        // The planner's headline number: what the route clears after operating
        // cost, landing fees and the lease on the aircraft flying it. A finder
        // that quoted revenue would rank the most expensive markets top.
        netProfit:   Math.round(p.mature.profit + (connecting.totalRevenue ?? 0) - frameLease),
        connectingRevenue: Math.round(connecting.totalRevenue ?? 0),
        lanePooled:  !!p.lanePooled,
        siblingPairs: p.siblingPairs ?? [],
        rivalCount:  p.rivalCount ?? 0,
      },
    };
  }
  return out;
}

export const SORTS = {
  demand:      { label: 'Biggest market',        needsForecast: false },
  profit:      { label: 'Best est. profit',      needsForecast: true  },
  loadFactor:  { label: 'Best est. load factor', needsForecast: true  },
  fare:        { label: 'Highest fare',          needsForecast: false },
  quiet:       { label: 'Fewest competitors',    needsForecast: false },
  shortest:    { label: 'Shortest distance',     needsForecast: false },
  longest:     { label: 'Longest distance',      needsForecast: false },
};

/** Sort in place-ish (returns a new array). Unscored rows sink under a forecast sort. */
export function sortCandidates(rows, sortBy) {
  const p = (r) => r.projection;
  const cmp = {
    demand:     (x, y) => y.demand - x.demand,
    shortest:   (x, y) => x.distKm - y.distKm,
    longest:    (x, y) => y.distKm - x.distKm,
    fare:       (x, y) => y.refPrice - x.refPrice,
    quiet:      (x, y) => x.laneRivalCount - y.laneRivalCount || y.demand - x.demand,
    profit:     (x, y) => (p(y)?.netProfit ?? -Infinity) - (p(x)?.netProfit ?? -Infinity)
                          || y.demand - x.demand,
    loadFactor: (x, y) => (p(y)?.loadFactor ?? -Infinity) - (p(x)?.loadFactor ?? -Infinity)
                          || y.demand - x.demand,
  }[sortBy] ?? ((x, y) => y.demand - x.demand);
  return [...rows].sort(cmp);
}
