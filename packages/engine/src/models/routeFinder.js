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
  effectiveRangeKm, maxFrequency, defaultConfig, defaultClassPrices, freighterBodyClass,
  newAircraftConfig,
} from '../utils/simulation.js';
import { metroPairKeyOf, memberPairKeysOf, airportAppeal, regionOf, cargoCityPairDemand, cargoReferenceYield } from '../utils/market.js';
import { pairDemandNow } from './demand.js';
import {
  currentGameDate, simulateCargoRoute, cargoLaneAllocations, CARGO_YIELD_ELASTICITY,
} from '../utils/simulation.js';
import { projectRouteAddition, pairMarketShare } from './pairShare.js';
import { normalizeCateringLevel } from '../data/catering.js';
import { eventRouteDenial } from '../data/eventRules.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// RIVAL TOPOLOGY KEY — what the finder actually reads off the rival set
// ─────────────────────────────────────────────────────────────────────────────
//
//   ASAS  "it doesnt happen on tailwinds so maybe some problem is happening due
//          to it being in multi player"                              (9/12/26)
//
// He is right, and this is the multiplayer half of it. Headwinds polls a rival
// OVERLAY every few seconds and applies it with `{ ...cur, ...d.rivals }`, so
// `competitors`, `humanRivals` and `encroachments` get brand-new object
// identities whenever ANY player anywhere in the world moves — a fare nudge on a
// lane you will never fly is enough. A screen that lists those three as memo
// dependencies therefore rebuilds on a timer rather than on a change, and in the
// Route Finder that rebuild drags the whole bounded forecast pass behind it:
// ~2,000 markets re-walked and up to 150 of them re-priced, on the main thread,
// while the player is doing nothing but reading the list. Tailwinds has no poll,
// which is exactly why it never showed there.
//
// But the finder reads almost none of what moves. `rivalPairIndex` consumes WHO
// flies WHICH pairs and nothing else — not fares, not seats, not frequencies, not
// quality. So this is the real dependency: a string that changes when the
// competitive MAP changes and stays put when rivals merely re-price.
//
// Memoised per source object, so a screen may call it on every render for free;
// a genuinely new rival set is a new object and derives a new key.
const TOPOLOGY_CACHE = new WeakMap();

function cached(obj, derive) {
  if (!obj || typeof obj !== 'object') return '';
  const hit = TOPOLOGY_CACHE.get(obj);
  if (hit !== undefined) return hit;
  const key = derive(obj);
  TOPOLOGY_CACHE.set(obj, key);
  return key;
}

/**
 * A stable identity for "who flies what" in this world.
 *
 * Two states with the same key present the same competitive map to the finder,
 * whatever else has changed about the rivals in between. Use it as the memo
 * dependency in place of `state.competitors` / `state.humanRivals` /
 * `state.encroachments`, which in Headwinds change identity on a timer.
 *
 * @returns {string}
 */
export function rivalTopologyKey(state) {
  const comps = cached(state?.competitors, (list) => (list ?? [])
    .map((c) => `${c?.id ?? '?'}#${Object.keys(c?.routes ?? {}).sort().join(',')}`)
    .sort().join(';'));
  // Only the pair keys and who sits on them — a rival re-pricing an existing
  // offer leaves both untouched, which is the whole point.
  const humans = cached(state?.humanRivals, (byPair) => Object.entries(byPair ?? {})
    .map(([k, specs]) => `${k}#${(specs ?? []).map((s) => s?.competitorId ?? '?').sort().join(',')}`)
    .sort().join(';'));
  const enc = cached(state?.encroachments, (byPair) => Object.entries(byPair ?? {})
    .filter(([, spec]) => spec)
    .map(([k, spec]) => `${k}#${spec?.competitorId ?? '?'}`)
    .sort().join(';'));
  return `${comps}|${humans}|${enc}`;
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
  // Weekly frequency you already fly on this exact pair. findCandidates passes
  // it from one index of your network; left out, it is counted here — which is
  // a walk of every route for each of ~2,000 candidates, ~400 ms of a search on
  // a 450-route airline.
  existingFreq: knownFreq,
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
  const existingFreq = knownFreq ?? (routes ?? [])
    .filter((r) => pairKey(r.origin, r.destination) === key)
    .reduce((s, r) => s + (r.weeklyFrequency ?? 0), 0);
  // Body class the way the reducer's guards read it: a freighter's comes from its
  // payload (ADD_CARGO_ROUTE), anything else is its catalogue category — so the
  // cargo finder can ask this too. For passenger types this is type.category.
  const hit = checkRouteRestrictions(
    origin, destination, distKm, existingFreq + weeklyFrequency, freighterBodyClass(type),
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
  // Destination world region, as COUNTRY_REGION spells it ('EUR', 'SEA', ...).
  // '' is every region. "can we pls add regions to the route finder" (ASAS,
  // 9/11/26): with 2,100 airports in the table, a distance band is a poor proxy
  // for "show me Europe" — 5,000 km from JFK is most of western Europe AND most
  // of South America, and the player wanting one of those does not want the
  // other. The region comes from the engine's own table so the filter and the
  // border-friction term that prices these markets never disagree.
  region = '',
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
  // Your weekly frequency per exact pair, once — laneBlockFor's existingFreq.
  const freqByPair = new Map();
  for (const r of state.routes ?? []) {
    const k = pairKey(r.origin, r.destination);
    freqByPair.set(k, (freqByPair.get(k) ?? 0) + (r.weeklyFrequency ?? 0));
  }
  const rows = [];
  // The demand a row prints is the demand the Route Planner prints for the same
  // pair this week: the base pool × this month's seasonality × the world's demand
  // growth — buildRouteMarket's own formula, rounded the same way. The bare base
  // pool is TODAY's traffic; in a 1950 era world the market is ~5% of it, which
  // is how a row came to say 6,000 a week for a pair the planner then priced at
  // 300 (Dunno23, Discord 2026-09-29). Only a world event's transient demand
  // shock is left out — the finder is a market list, not this week's forecast.
  const gameDate = state?.week != null ? currentGameDate(state) : null;

  for (const a of airports) {
    if (a.code === origin) continue;
    const baseDemand = baseCityPairDemand(origin, a.code);
    if (baseDemand <= 0) continue;             // same metro, or an unpriced pair
    const demand = pairDemandNow(origin, a.code, gameDate, baseDemand);
    const distKm = Math.round(distanceKm(from, a));
    if (distKm < minDistKm || distKm > maxDistKm) continue;
    const destRegion = regionOf(a);
    if (region && destRegion !== region) continue;

    // Lancelotbronner's question, answered: sibling airports ARE linked. A lane
    // you already fly out of the other New York field is not a new market, and
    // listing it as one is what made "large demand, no profit" look like a bug in
    // the economics rather than a market you had already taken.
    // Event worlds: domestic-only / international-only lanes are never offered
    // (the same check addRouteBlockReason refuses them with).
    if (state.eventRules?.routes && eventRouteDenial(state, [origin, a.code])) continue;

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
                       weeklyFrequency, routes: state.routes ?? [],
                       existingFreq: freqByPair.get(pairKey(origin, a.code)) ?? 0 })
      : null;
    if (hideUnflyable && block) continue;

    rows.push({
      airport: a,
      origin,
      code: a.code,
      distKm,
      demand,
      baseDemand,
      // null when the destination's country is missing from COUNTRY_REGION —
      // rendered as "Unlisted" rather than guessed at. See regionOf().
      region: destRegion,
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
 * One launch forecast, the way a finder row prices it: the engine's
 * projectRouteAddition on `aircraft`, plus connecting feed, less the lease on
 * that airframe. Split out of scoreCandidates so the finder's shortlist
 * (models/routeBatch.js) prices each pick with the identical sum — a review
 * table that quoted a different number from the row it came from would be the
 * preview-vs-preview bug this module exists to avoid.
 *
 * `frameLease` is what the tick charges for this airframe each week; null
 * derives it (owned 0, leased at its signed rate). Returns null when the
 * projection has no mature figure.
 */
export function forecastLaunch(state, {
  origin, destination, aircraft, frameLease = null, weeklyFrequency,
  ticketPrice, classPrices, cateringLevel, gameDate,
}) {
  const type = getAircraftType(aircraft?.typeId);
  if (!type) return null;
  const lease = frameLease ?? (aircraft.ownershipType === 'owned'
    ? 0 : (aircraft.weeklyLease ?? type.weeklyLease ?? 0));
  const p = projectRouteAddition(state, {
    origin,
    destination,
    aircraft,
    weeklyFrequency,
    ticketPrice,
    classPrices,
    // The catering ADD_ROUTE will assign. Catering is a quality term in the
    // share fight, so a finder that left it at the engine default forecast a
    // different slice of a contested pair than the planner and the tick.
    cateringLevel: cateringLevel ?? normalizeCateringLevel(state.defaultCateringLevel),
    gameDate,
  });
  if (!p?.mature) return null;
  // Connecting feed. weeklyTick credits a route with its connecting revenue
  // (`routeRevenue = result.revenue + connecting.totalRevenue`), and the Route
  // Planner shows it — the finder omitting it ranked every hub spoke BELOW the
  // profit the planner then quoted for the very same row. The projection now
  // carries it, computed the tick's way (own-metal itineraries, departures as
  // slots, seat headroom); the bare computeConnectingDemand call this used to
  // make quoted 6% of the tick's figure on a fed hub.
  const connecting = p.connecting ?? { totalRevenue: 0, totalPax: 0 };
  return {
    weeklyFrequency,
    passengers:  p.mature.passengers,
    loadFactor:  p.mature.loadFactor,
    revenue:     p.mature.revenue,
    // The planner's headline number: what the route clears after operating
    // cost, landing fees and the lease on the aircraft flying it. A finder
    // that quoted revenue would rank the most expensive markets top.
    // profitAfterLandingFees is the tick's definition in BOTH repos
    // (Tailwinds keeps `profit` pre-fee; Headwinds nets it) — reading it
    // here is what keeps this file identical across them.
    netProfit:   Math.round((p.mature.profitAfterLandingFees ?? p.mature.profit)
                   + (connecting.totalRevenue ?? 0) - lease),
    connectingRevenue: Math.round(connecting.totalRevenue ?? 0),
    lanePooled:  !!p.lanePooled,
    siblingPairs: p.siblingPairs ?? [],
    rivalCount:  p.rivalCount ?? 0,
  };
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
  const ctx = finderForecastContext({ aircraftTypeId, aircraft, weeklyFrequency, gameDate, capHours });
  if (!ctx) return rows;

  const out = rows.map((r) => ({ ...r }));
  for (const i of rowsToScore(rows, { limit, order })) {
    const projection = forecastCandidate(state, rows[i], ctx);
    if (!projection) continue;
    out[i] = { ...out[i], scored: true, projection };
  }
  return out;
}

/**
 * Everything about the forecast that is the same for every row: the type, the
 * airframe it is priced on and what that airframe costs a week. Null when no
 * type is picked (nothing to forecast). Split out of scoreCandidates so the
 * Route Finder can price rows a few at a time (components/RouteFinder.jsx)
 * through the identical sum.
 */
export function finderForecastContext({ aircraftTypeId, aircraft = null, weeklyFrequency = 7, gameDate, capHours } = {}) {
  const type = aircraftTypeId ? getAircraftType(aircraftTypeId) : null;
  if (!type) return null;

  // A synthetic airframe when the player owns none of the type — the planner
  // previews a TYPE the same way, so an order can be sized against a real market.
  const frame = aircraft ?? {
    id: '__finder__', typeId: type.id, ageWeeks: 0,
    config: newAircraftConfig(type),
  };

  // What the aircraft flying it actually costs per week. An OWNED tail has no
  // lease (the tick charges 0), and a leased one pays the rate IT signed at, not
  // the catalogue rate. Only a type the player doesn't own yet is priced at list.
  const frameLease = aircraft
    ? (aircraft.ownershipType === 'owned' ? 0 : (aircraft.weeklyLease ?? type.weeklyLease ?? 0))
    : (type.weeklyLease ?? 0);
  return { type, frame, frameLease, weeklyFrequency, gameDate, capHours };
}

/** The frequency a row is forecast at: the requested one, inside what the block-hour cap allows. */
export function candidateFrequency(row, ctx) {
  return Math.max(1, Math.min(ctx.weeklyFrequency, maxFrequency(row.distKm, ctx.type, ctx.capHours)));
}

/** One row's launch forecast (null for a blocked row or no mature figure). */
export function forecastCandidate(state, r, ctx) {
  if (!ctx || r.block) return null;           // a route you cannot open has no forecast
  return forecastLaunch(state, {
    origin: r.origin, destination: r.code, aircraft: ctx.frame, frameLease: ctx.frameLease,
    weeklyFrequency: candidateFrequency(r, ctx), ticketPrice: r.refPrice, classPrices: defaultClassPrices(r.refPrice),
    gameDate: ctx.gameDate,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW MUCH OF A MARKET IS ALREADY FLOWN
// ─────────────────────────────────────────────────────────────────────────────
//
//   VodkaOnFire  "Simple; next to estimated load (or market), add a 0-x% digit
//                 to tell you how much of the demand is satisfied already. Saves
//                 you having to check every individual route and recalculate
//                 every time you do."  (Discord, 2026-10-21 — and the same ask
//                 for the freight finder)
//
// The Market column is the size of the pool, not what is left in it: a 9,000 a
// week lane that rivals already carry 8,500 of is a much worse lead than a 4,000
// one nobody flies, and the only way to tell them apart was to open each lane
// and add up who is on it. These answer it with the ENGINE's own figures, not a
// seat count: the same share fight weeklyTick runs (pairMarketShare), with
// everyone already on the lane — rivals' nonstops, their one-stops over their
// hubs, and your own services — and the passengers it hands out divided by the
// market's weekly size. A seat count would call a lane "full" that rivals fly
// half-empty at a fare nobody pays.
//
// Run at maturity, like the finder's Est. load: a lane you opened last month is
// not "half served" just because it is still ramping up.

/** Weeks of service the served figure assumes — past the 16-week ramp, so a lane reads at maturity. */
export const SERVED_MATURE_WEEKS = 52;

/**
 * The share of a passenger market already carried, by whom.
 *
 * `row` is a finder row (findCandidates). When you already fly the lane, the
 * fight is run from YOUR pair — pairMarketShare pools the metro lane from
 * there, so sibling-airport services and rivals at the other field are all in
 * it; run from an empty sibling pair it would miss your own.
 *
 * @returns {{ pool, pax, yourPax, rivalPax, share, yourShare, rivalShare }|null}
 *   pool = the market's weekly travellers; pax = everyone carried on it.
 *   `share` can pass 1: cheap fares and frequent service grow a market past
 *   its base size (the demand model's elasticity), and that is still "served".
 */
export function laneServed(state, row, { gameDate = null } = {}) {
  if (!row?.origin || !row?.code) return null;
  const mine = row.yourLanePairs?.[0];
  const [a, b] = mine ? mine.split('-') : [row.origin, row.code];
  const gd = gameDate ?? (state?.week != null ? currentGameDate(state) : { month: 6 });
  const ms = pairMarketShare(state, a, b, { gameDate: gd, weeksOpen: SERVED_MATURE_WEEKS });
  const pool = (ms.market?.leisureDemand ?? 0) + (ms.market?.businessDemand ?? 0);
  if (!(pool > 0)) return null;
  const pax = Math.max(0, Math.round(ms.totalPax ?? 0));
  const yourPax = Math.min(pax, Math.round(pax * (ms.playerLaneShare ?? 0)));
  const rivalPax = pax - yourPax;
  return {
    pool, pax, yourPax, rivalPax,
    share: pax / pool, yourShare: yourPax / pool, rivalShare: rivalPax / pool,
  };
}

/**
 * The freight sibling: tonnes a week already flown on `origin`–`destination`,
 * as a share of the lane's weekly pool.
 *
 * Your side is exactly the freight table's figure — cargoLaneAllocations plus
 * simulateCargoRoute, the tick's own pair — summed over your freighters on the
 * pair, at maturity. A rival's side (Headwinds players publish their freighter
 * capacity on `competitors[].cargoRoutes`; Tailwinds' AI carriers fly no
 * freight) is estimated the way the tick weighs it: its price-weighted capacity's
 * share of the lane, never more than it can lift.
 *
 * @returns {{ pool, tonnes, yourTonnes, rivalTonnes, share, yourShare, rivalShare }|null}
 */
export function cargoLaneServed(state, origin, destination, { gameDate = null } = {}) {
  const gd = gameDate ?? (state?.week != null ? currentGameDate(state) : { month: 6 });
  const pool = cargoCityPairDemand(origin, destination, gd.month);
  if (!(pool > 0)) return null;
  const key = pairKey(origin, destination);
  const fleet = state?.fleet ?? [];
  // Mature copies — `weeksOpen: null` is the cargo sim's "established lane".
  const mine = (state?.cargoRoutes ?? [])
    .filter((r) => pairKey(r.origin, r.destination) === key)
    .map((r) => ({ ...r, weeksOpen: null }));
  const alloc = cargoLaneAllocations(mine, fleet, 1.0, { gameDate: gd, competitors: state?.competitors ?? [] });
  let yourTonnes = 0, yourCap = 0;
  for (const r of mine) {
    const ac = fleet.find((a) => a.id === r.aircraftId);
    if (!ac) continue;
    const sim = simulateCargoRoute(r, ac, gd, null, 1.0, 1.0, alloc.get(r.id) ?? null);
    if (!sim) continue;
    yourTonnes += sim.tonnes ?? 0;
    yourCap    += sim.capacityTonnes ?? 0;
  }
  // Rivals, rolled up the way cargoLaneAllocations looks them up for this pair.
  let rivalCap = 0, rivalYieldCap = 0;
  for (const c of state?.competitors ?? []) {
    for (const [k, cr] of Object.entries(c?.cargoRoutes ?? {})) {
      const cap = cr?.tonnesPerWeek ?? 0;
      if (!(cap > 0)) continue;
      const [ra, rb] = String(k).split('-');
      if (!ra || !rb || metroPairKeyOf(ra, rb) !== key) continue;
      rivalCap += cap;
      rivalYieldCap += (cr.yieldPrice ?? 0) * cap;
    }
  }
  let rivalTonnes = 0;
  if (rivalCap > 0) {
    const refYield = cargoReferenceYield(origin, destination);
    const rivalYield = rivalYieldCap > 0 ? rivalYieldCap / rivalCap : 0;
    const elast = rivalYield > 0 ? Math.min(1.6, Math.pow(refYield / rivalYield, CARGO_YIELD_ELASTICITY)) : 1;
    const weighted = rivalCap * elast;
    rivalTonnes = Math.round(Math.min(rivalCap, pool * weighted / (yourCap + weighted)));
  }
  const tonnes = Math.round(yourTonnes + rivalTonnes);
  return {
    pool, tonnes, yourTonnes: Math.round(yourTonnes), rivalTonnes,
    share: tonnes / pool, yourShare: yourTonnes / pool, rivalShare: rivalTonnes / pool,
  };
}

/**
 * The part of a row's market nobody carries yet, in the Market column's own
 * units (`row.demand`, travellers or tonnes a week). Never more than the
 * market, never below zero — a lane flown past its base size has nothing left.
 */
export function demandLeftOf(row, served) {
  const share = Math.max(0, served?.share ?? 0);
  return Math.max(0, Math.round((row?.demand ?? 0) * (1 - Math.min(1, share))));
}

/**
 * Rows ranked by the demand still unflown ("Most demand left"), pricing only
 * as many as the ranking needs.
 *
 * A lane's demand left can never exceed its market, so walking the rows
 * biggest-market first, the walk can stop as soon as `limit` lanes have more
 * left than the next row's whole market — nothing further down can climb into
 * the page. On a typical search the top rows are unflown (left = market) and
 * it stops after `limit` share fights instead of ~2,000.
 *
 * `servedOf(row)` returns laneServed / cargoLaneServed (the caller caches it).
 * Priced rows come back ranked with `served` and `demandLeft` attached; the
 * rest follow in market order, which is what they would rank as anyway once
 * a bigger page asks for them.
 */
export function rankByDemandLeft(rows, servedOf, limit = 25) {
  const byDemand = [...rows].sort((x, y) => y.demand - x.demand);
  const priced = [];
  const lefts = [];            // best `limit` demand-left figures so far, descending
  let i = 0;
  for (; i < byDemand.length; i++) {
    const r = byDemand[i];
    if (lefts.length >= limit && lefts[limit - 1] >= r.demand) break;
    const served = servedOf(r);
    const demandLeft = demandLeftOf(r, served);
    priced.push({ ...r, served, demandLeft });
    let j = lefts.length;
    while (j > 0 && lefts[j - 1] < demandLeft) j--;
    lefts.splice(j, 0, demandLeft);
    if (lefts.length > limit) lefts.length = limit;
  }
  priced.sort((x, y) => y.demandLeft - x.demandLeft || y.demand - x.demand);
  return [...priced, ...byDemand.slice(i)];
}

/**
 * Indices (into `rows`) of the rows a scoring pass prices, in pricing order —
 * scoreCandidates' selection rule, exported so a progressive pass picks the
 * same rows. Blocked rows are included (they take a slot and get no forecast).
 */
export function rowsToScore(rows, { limit = DEFAULT_SCORE_LIMIT, order = 'demand' } = {}) {
  const indexed = rows.map((r, i) => ({ r, i }));
  const ranked = order === 'asGiven'
    ? indexed.slice(0, limit)
    : indexed.sort((x, y) => y.r.demand - x.r.demand).slice(0, limit);
  return ranked.map(({ i }) => i);
}

export const SORTS = {
  demand:      { label: 'Biggest market',        needsForecast: false },
  // Ranked by rankByDemandLeft (it needs the lane's share fight, priced as far
  // down as the page needs), so sortCandidates only sees it as a fallback.
  room:        { label: 'Most demand left',      needsForecast: false },
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
    room:       (x, y) => (y.demandLeft ?? y.demand) - (x.demandLeft ?? x.demand) || y.demand - x.demand,
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
