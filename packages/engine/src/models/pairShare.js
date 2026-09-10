// ─────────────────────────────────────────────────────────────────────────────
// PAIR MARKET SHARE — one place that answers "what slice of this city pair am I
// actually carrying?"
//
// WHY THIS EXISTS
// ---------------
// Three screens used to answer that question three different ways, and only one
// of them asked the demand model:
//
//   RouteDetail / RoutePlanner  built their own player offer inline and ran
//                               computeMarketShare — close to the tick, but
//                               drifting (they granted human rivals a hub
//                               connectivity bonus the tick did not).
//   AirportDetail               divided departures by total departures. A player
//                               with 35 weekly flights against a rival's 31 was
//                               shown "53% market share" no matter how much
//                               cheaper, larger, better or better-advertised
//                               their service was — because none of those inputs
//                               were in the arithmetic. The demand model put the
//                               same player at ~68%.
//
// So this module builds the offers the SAME way weeklyTick does — the player's
// aircraft on a pair combined into one offer, rivals resolved through the very
// same humanRivals → buildEncroachmentOffer path the tick consumes — and hands
// back computeMarketShare's answer. A preview that disagrees with the tick is a
// bug in one of them; routing both through here makes that bug impossible to
// reintroduce quietly.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildRouteMarket,
  computeMarketShare,
  buildCompetitorOffer,
  routeMaturityFactor,
  computeConnectingDemand,
  HUB_TIERS,
} from './demand.js';
import { buildEncroachmentOffer } from './encroachment.js';
import { rivalIndexFor, rivalOneStopOffersFor, rivalsOn, isLegacy, runNetworkTick } from './network.js';
import { getAlliance, allianceMembers } from '../data/alliances.js';
import { memberPairKeysOf } from '../utils/market.js';
import { campaignDemandBoostPct } from '../data/overhead.js';
import { getAircraftType } from '../data/aircraft.js';
import {
  configBodies,
  defaultConfig,
  routeQualityBreakdown,
  isMultiStop,
  isRouteActive,
  hubSpokeCounts,
  pairConnectivityBonus,
  stateSensReduction,
  stateBrandReach,
  currentGameDate,
  buildEventDemandModel,
  simulateRoute,
  fleetAvgUtilization,
  routeLandingFee,
  hubCostFactorsAt,
  CLASS_FARE_MULTIPLIERS,
  stateLoungeFields,
} from '../utils/simulation.js';


export const pairKeyOf = (a, b) => [a, b].sort().join('-');

/**
 * The demand multiplier weeklyTick applies to one O&D — world events × the
 * per-world multiplier — resolved from state alone.
 *
 * weeklyTick builds exactly this (`eventDemandMultFor0(a,b) * worldDemandMult`,
 * utils/simulation.js) and hands it to BOTH buildRouteMarket and simulateRoute.
 * Previews used to compose only half of it in each place: pairMarketShare passed
 * `state.worldDemandMult` and no event multiplier, while projectRouteAddition
 * defaulted the event multiplier to 1.0 and never saw the world one. A world
 * event therefore never reached a launch forecast at all, and in a doubled world
 * a solo route previewed at half the traffic the following week booked.
 *
 * `eventOnly` is the caller's event-only multiplier when it has one (RoutePlanner
 * and Routes both pass `eventDemand.multFor(o, d)`); the world multiplier is
 * composed on top here so no call site has to know about it.
 */
export function stateDemandMult(state, origin, destination, eventOnly) {
  const ev = eventOnly ?? buildEventDemandModel(state.activeEvents).multFor(origin, destination);
  return ev * (state.worldDemandMult ?? 1);
}

/**
 * Combine every player aircraft on one city pair into the single AirlineOffer
 * the demand model expects. Mirrors weeklyTick's multi-aircraft pre-pass: one
 * carrier competes for the pair, not one offer per tail.
 *
 * @param {object}   state       full game state
 * @param {object[]} pairRoutes  the player's routes on this pair (≥1)
 * @returns {object|null}
 */
export function buildPlayerPairOffer(state, pairRoutes) {
  if (!pairRoutes || pairRoutes.length === 0) return null;
  const r0 = pairRoutes[0];
  const fleet = state.fleet ?? [];

  let totalFreq = 0, totalEcoSeats = 0, totalBizSeats = 0, totalSeatsAll = 0;
  let qualitySum = 0, qualityN = 0;
  for (const route of pairRoutes) {
    const aircraft = fleet.find((a) => a.id === route.aircraftId);
    if (!aircraft) continue;
    const type = getAircraftType(aircraft.typeId);
    if (!type) continue;
    const cfg  = aircraft.config ?? defaultConfig(type.seats);
    const freq = route.weeklyFrequency ?? 7;
    totalFreq     += freq;
    totalEcoSeats += (cfg.economy ?? type.seats) * freq;
    totalBizSeats += (cfg.businessClass ?? 0) * freq;
    totalSeatsAll += configBodies(cfg) * freq;
    // Engine-accurate per-route quality (morale, utilization, cabin product,
    // catering, hub bonus) — the same figure the tick scores the offer with.
    const q = routeQualityBreakdown(route, aircraft, state)?.total;
    if (q != null) { qualitySum += q; qualityN += 1; }
  }
  if (totalFreq <= 0 || qualityN === 0) return null;

  const key = pairKeyOf(r0.origin, r0.destination);
  const cp  = state.routePricing?.[key] ?? r0.classPrices ?? {};
  const ecoPrice = Math.max(1, cp.economy ?? r0.ticketPrice ?? 1);
  // A business FARE with no business SEATS is not a cabin — leaving it non-null
  // would let the model sell premium demand this pair cannot carry.
  const bizPrice = totalBizSeats > 0
    ? Math.max(1, cp.businessClass ?? ecoPrice * CLASS_FARE_MULTIPLIERS.businessClass)
    : null;

  // Hub quality bonus from the better endpoint. Tier 0 (Focus City) is a valid
  // designation, so test against null rather than truthiness.
  const hubs = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const hubTierQ = (code) => {
    const t = hubs[code]?.tier;
    return t != null ? (HUB_TIERS[t]?.qualityBonus ?? 0) : 0;
  };
  const hubQ = Math.max(hubTierQ(r0.origin), hubTierQ(r0.destination));
  const isHubPair = hubs[r0.origin] != null || hubs[r0.destination] != null
    || r0.origin === state.hub || r0.destination === state.hub;

  return {
    airlineId:        'player',
    origin:           r0.origin,
    destination:      r0.destination,
    economyPrice:     ecoPrice,
    businessPrice:    bizPrice,
    weeklyFrequency:  totalFreq,
    seatsPerFlight:   Math.round((totalEcoSeats + totalBizSeats) / totalFreq),
    economySeats:     totalEcoSeats,
    businessSeats:    totalBizSeats,
    totalSeats:       totalSeatsAll,
    qualityScore:     Math.round(qualitySum / qualityN),
    // Scaled by the spokes the player actually connects — the same helper and
    // the same route list the weekly tick uses, so this preview cannot drift.
    connectivityBonus: isHubPair
      ? pairConnectivityBonus(hubSpokeCounts(state.routes ?? []),
          [...Object.keys(hubs), state.hub], r0.origin, r0.destination)
      : 0,
    priceSensitivityReduction: stateSensReduction(state, hubQ),
    marketingBoost:   playerCampaignBoost(state, r0.origin, r0.destination),
    // Brand reach, resolved through the same helper the tick uses. Without it a
    // week-one carrier would preview the market share of an established one —
    // the exact class of preview/tick divergence this module exists to prevent.
    brandReach:       stateBrandReach(state, hubQ, false, [r0.origin, r0.destination]),
    // Lounges at this pair's endpoints. Same reason as brandReach: leaving it
    // off would preview the business share of a carrier with a lounge network
    // for one that has none (or vice versa), which is exactly the preview/tick
    // divergence this module exists to prevent.
    loungeAppeal:     stateLoungeFields(state, r0.origin, r0.destination).loungeAppeal,
  };
}



/** Targeted-campaign lift on a pair — strongest campaign at either endpoint. */
export function playerCampaignBoost(state, origin, destination) {
  const cs = state.campaignStrength ?? {};
  return campaignDemandBoostPct(Math.max(cs[origin] ?? 0, cs[destination] ?? 0));
}

/**
 * Every rival offer on a pair, resolved through the SAME channels the weekly
 * tick uses so a preview cannot silently disagree with it:
 *   state.humanRivals[pair]   real people (Headwinds) → buildEncroachmentOffer
 *   state.encroachments[pair] AI challengers (solo)   → buildEncroachmentOffer
 *   state.competitors         AI carriers (solo)      → buildCompetitorOffer
 * Human competitors are skipped in the last group: they already came through as
 * specs, and counting them twice would halve the player's apparent share.
 */
export function buildRivalPairOffers(state, market) {
  const key = pairKeyOf(market.origin, market.destination);
  const offers = [];
  const spokenFor = new Set();

  for (const spec of state.humanRivals?.[key] ?? []) {
    if (spec?.competitorId != null) spokenFor.add(spec.competitorId);
    const offer = buildEncroachmentOffer(spec, market);
    if (offer) offers.push(offer);
  }
  const enc = state.encroachments?.[key];
  if (enc) {
    const offer = buildEncroachmentOffer(enc, market);
    if (offer) offers.push(offer);
  }
  for (const c of state.competitors ?? []) {
    if (!c.routes?.[key]) continue;
    // Already counted via humanRivals. Keyed on the id rather than on the
    // `human` flag alone: a human rival with no spec on THIS pair still has to
    // be counted, or a gap in state.humanRivals silently exempts them from the
    // share fight instead of merely thinning their offer. Same rule as
    // rivalOffersFor() in the tick, so the preview and the tick agree.
    if (c.human && spokenFor.has(c.id)) continue;
    const offer = buildCompetitorOffer(c, market);
    if (offer) offers.push(offer);
  }
  // Rival one-stops over their hubs — same index, same offers as the tick.
  const rivalIndex = rivalIndexFor(state);
  if (rivalsOn(rivalIndex)) offers.push(...rivalOneStopOffersFor(rivalIndex, market));
  return offers;
}

// ─────────────────────────────────────────────────────────────────────────────
// METRO LANE — the preview's half of weeklyTick's one-fight-per-metro-pair rule
// ─────────────────────────────────────────────────────────────────────────────

/** The player's nonstop routes on one airport pair. */
function routesOnPair(state, key) {
  return (state.routes ?? []).filter(
    (r) => pairKeyOf(r.origin, r.destination) === key && !isMultiStop(r));
}

/** Does anyone other than the player fly this exact airport pair? */
function pairHasRival(state, key) {
  if ((state.humanRivals?.[key] ?? []).length > 0) return true;
  if (state.encroachments?.[key]) return true;
  return (state.competitors ?? []).some((c) => c?.routes?.[key]);
}

/**
 * Demand-model market share for one city pair.
 *
 * @param {object} state
 * @param {string} origin
 * @param {string} destination
 * @param {object} [opts]
 * @param {object}   [opts.gameDate]   defaults to state.gameDate
 * @param {object[]} [opts.pairRoutes] override the routes on this pair — used by
 *                                     projectRouteAddition() to price a pair that
 *                                     includes a route the player has not opened yet
 * @param {number}   [opts.weeksOpen]  override lane maturity (0 = launch week)
 * @param {number}   [opts.demandMult] the FULL demand multiplier for this O&D
 *                                     (world events × state.worldDemandMult).
 *                                     Defaults to stateDemandMult(); pass it only
 *                                     to keep a caller's own figure authoritative.
 * @returns {{
 *   market: object,
 *   offers: object[],
 *   results: object[],
 *   playerResult: object|null,
 *   playerShare: number|null,   // 0–1 share of passengers actually carried
 *   totalPax: number,
 *   contested: boolean,
 * }}
 */
/**
 * A caller-built `{ week, month }` gameDate is completed with the world's
 * absWeek. Three screens built that literal for themselves and every one of
 * them quoted year-one demand while the tick compounded growth — 1% in week 20,
 * 6.7% in year four. Only the absent field is filled; a caller's own absWeek wins.
 */
function withAbsWeek(state, gameDate) {
  if (!gameDate || gameDate.absWeek != null) return gameDate;
  // Fixtures that carry no calendar at all keep the bare date (no growth), as before.
  if (typeof state?.week !== 'number') return gameDate;
  const cur = currentGameDate(state);
  return cur.absWeek != null ? { ...gameDate, absWeek: cur.absWeek } : gameDate;
}

export function pairMarketShare(state, origin, destination, opts = {}) {
  const gameDate = withAbsWeek(state, opts.gameDate ?? state.gameDate) ?? { month: 6 };
  const key = pairKeyOf(origin, destination);

  // Tag (multi-stop) routes self-contain their O&D split and must not join a
  // pair offer. The test for that is isMultiStop() — NOT `!r.stops?.length`,
  // which was the original guard and was wrong the moment a route was hydrated:
  // hydration gives every single-leg route `stops: [origin, destination]`, so
  // the old filter matched only UN-hydrated routes and returned an empty pair on
  // any real save. buildPlayerPairOffer then returned null and AirportDetail
  // showed the player as absent from their own market.
  const pairRoutes = opts.pairRoutes ?? (state.routes ?? []).filter(
    (r) => pairKeyOf(r.origin, r.destination) === key && !isMultiStop(r)
  );
  // Route maturity is per-route; a pair flown by several tails ramps with the
  // OLDEST of them (the market has known the service that long).
  const weeksOpen = opts.weeksOpen ?? pairRoutes.reduce(
    (m, r) => Math.max(m, r.weeksOpen ?? 0), 0);
  // The pool the tick will fight over: seasonality × maturity × world events ×
  // the per-world multiplier. Passing only `state.worldDemandMult` here left the
  // event shock out of the POOL while simulateRoute applied it to the route — two
  // halves of one multiplier, applied in different places.
  const market = buildRouteMarket(origin, destination, gameDate,
    pairRoutes.length ? routeMaturityFactor(weeksOpen) : 1,
    opts.demandMult ?? stateDemandMult(state, origin, destination));

  const playerOffer = buildPlayerPairOffer(state, pairRoutes);
  const rivalOffers = buildRivalPairOffers(state, market);

  // ── Metro lane: ONE share fight per metro pair, exactly as weeklyTick runs it
  //
  // data/metros.js prices every member pair of a metro pair at the same metro
  // total — New York↔London is one market however you fly it — and the tick's
  // pre-pass fights over it once: one player offer PER MEMBER PAIR SERVED (your
  // JFK and your EWR services are genuinely different products chasing the same
  // travellers), with rivals scanned across EVERY member pair.
  //
  // This preview scanned the queried airport pair and nothing else. On a lane
  // where the competition sits at the sibling field it therefore reported an
  // empty market. Measured on a fixture with a rival flying JFK–LHR and the
  // player pricing up EWR–LHR:
  //
  //     preview  6,160 pax  100.0% load  +$3,131,886/wk   "no competitors"
  //     tick     4,633 pax   75.2% load  +$1,642,215/wk
  //
  // — a 33% passenger and $1.49M/wk overstatement, on a screen that also told
  // the player the lane was uncontested. Reported in Discord by Lancelotbronner:
  // "multiple airports in the same city still show a large demand but none of
  // the routes are profitable, are they linked?". They are, and now the preview
  // says so.
  //
  // The engagement guard mirrors the tick's exactly: a lane carrying fewer than
  // two player presences and no rival at an UNSERVED sibling field keeps the
  // historical exact-pair path, so nothing off a real metro lane moves.
  const laneKeys = memberPairKeysOf(origin, destination).filter((k) => k !== key);
  const siblingPlayerOffers = [];
  const siblingRivalOffers  = [];
  const siblingPairs = [];
  let   siblingRouteCount = 0;
  let   unservedSiblingRival = false;
  for (const k of laneKeys) {
    const rs    = routesOnPair(state, k);
    const rival = pairHasRival(state, k);
    if (rs.length === 0 && !rival) continue;
    if (rs.length === 0) unservedSiblingRival = true;
    if (rs.length > 0) {
      const o = buildPlayerPairOffer(state, rs);
      if (o) {
        siblingPlayerOffers.push(o);
        siblingPairs.push(k);
        siblingRouteCount += rs.length;
      }
    }
    if (rival) {
      // Every member pair prices at the metro total by construction, and the
      // tick gives the whole lane ONE maturity — the queried pair's. Rebuilding
      // the sibling's market rather than reusing this one keeps its own event
      // multiplier, which is what the tick's per-key buildRouteMarket does.
      const [ka, kb] = k.split('-');
      siblingRivalOffers.push(...buildRivalPairOffers(state,
        buildRouteMarket(ka, kb, gameDate, market.maturityFactor ?? 1,
          stateDemandMult(state, ka, kb))));
    }
  }
  const lanePooled =
    (pairRoutes.length + siblingRouteCount) >= 2 || unservedSiblingRival;

  // The queried pair's offer goes FIRST and stays first: on a pooled lane your
  // own sibling services are `airlineId: 'player'` too (the tick names them the
  // same way), so POSITION, not id, is what identifies this pair's result.
  const laneSiblings = lanePooled ? siblingPlayerOffers : [];
  const laneRivals   = lanePooled
    ? [...rivalOffers, ...siblingRivalOffers]
    : rivalOffers;
  const offers = [...(playerOffer ? [playerOffer] : []), ...laneSiblings, ...laneRivals];
  if (offers.length === 0) {
    return { market, offers, results: [], playerResult: null,
             playerShare: null, playerLaneShare: null, totalPax: 0, contested: false,
             lanePooled: false, laneRivalCount: 0, siblingPairs: [] };
  }

  // Same rules as the tick: an OFF world (the betas) previews with the old allocation.
  const results = computeMarketShare(market, offers, { legacy: isLegacy(rivalIndexFor(state)) });
  const playerResult = playerOffer ? (results[0] ?? null) : null;
  const totalPax = results.reduce((s, r) => s + (r.totalPax ?? 0), 0);
  // Everything YOUR airline carries in the lane — this pair plus your sibling
  // fields. Indexed off the same offer order the array was built in.
  const siblingBase = playerOffer ? 1 : 0;
  const playerLanePax = (playerResult?.totalPax ?? 0)
    + laneSiblings.reduce((s, _o, i) => s + (results[siblingBase + i]?.totalPax ?? 0), 0);

  return {
    market,
    offers,
    results,
    playerResult,
    // Share of passengers ACTUALLY CARRIED, capacity caps included — if you only
    // have seats for half the people who'd pick you, you don't hold their share.
    playerShare: playerResult && totalPax > 0
      ? playerResult.totalPax / totalPax
      : playerResult ? 1 : null,
    // Your WHOLE airline's slice of the metro lane, sibling airports included.
    playerLaneShare: totalPax > 0 ? playerLanePax / totalPax : null,
    totalPax,
    contested: laneRivals.length > 0,
    // True when the tick's metro pre-pass would engage on this lane. A caller
    // building a route forecast must then take a pooled SLICE rather than let
    // simulateRoute run its own whole-pool fight — that second fight is what
    // handed a sibling-airport launch the entire metro market a second time.
    lanePooled,
    laneRivalCount: laneRivals.length,
    // Member pairs of this lane you already serve, e.g. ['JFK-LHR'] when pricing
    // up EWR–LHR. The planner names them so "why is my demand lower than the
    // market figure?" has a visible answer.
    siblingPairs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE PROJECTION — "what will this route ACTUALLY carry once I open it?"
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel id for the not-yet-real route a projection is built around. */
export const PREVIEW_ROUTE_ID = '__preview__';

/**
 * Split one pair's pooled demand into a single route's slice, exactly the way
 * weeklyTick's multi-aircraft pre-pass does: proportionally by that route's
 * share of the pair's economy and business seats.
 */
function sliceForRoute(pooled, route, aircraft, pairRoutes, fleet) {
  let totalEco = 0, totalBiz = 0;
  let myEco = 0, myBiz = 0;
  for (const r of pairRoutes) {
    const ac = r.id === route.id ? aircraft : fleet.find((a) => a.id === r.aircraftId);
    if (!ac) continue;
    const type = getAircraftType(ac.typeId);
    if (!type) continue;
    const cfg  = ac.config ?? defaultConfig(type.seats);
    const freq = r.weeklyFrequency ?? 7;
    const eco  = (cfg.economy ?? type.seats) * freq;
    const biz  = (cfg.businessClass ?? 0) * freq;
    totalEco += eco; totalBiz += biz;
    if (r.id === route.id) { myEco = eco; myBiz = biz; }
  }
  const ecoFrac = totalEco > 0 ? myEco / totalEco : 1 / Math.max(1, pairRoutes.length);
  const bizFrac = totalBiz > 0 ? myBiz / totalBiz : 1 / Math.max(1, pairRoutes.length);
  return {
    leisurePax:      Math.round((pooled.leisurePax      ?? 0) * ecoFrac),
    businessPax:     Math.round((pooled.businessPax     ?? 0) * bizFrac),
    // PRE-CAP demand rides along, exactly as weeklyTick's demandAllocations do.
    // simulateRoute's load model spills against the demand the MARKET generated,
    // not against the seat count: hand it only the capped figures and a
    // capacity-capped lane looks like a lane with demand equal to its seats, so
    // the spill model trims a route the tick does not. Measured on a two-airport
    // New York↔London lane: preview 5,379 pax against the tick's 5,789 (-7.1%),
    // purely from the missing uncapped fields. The tick has always passed them;
    // this slice simply never did, which stayed invisible while the only pooled
    // previews were same-pair ones sitting at 100% load.
    leisurePaxUncapped:  Math.round((pooled.leisurePaxUncapped  ?? pooled.leisurePax  ?? 0) * ecoFrac),
    businessPaxUncapped: Math.round((pooled.businessPaxUncapped ?? pooled.businessPax ?? 0) * bizFrac),
    economyRevenue:  Math.round((pooled.economyRevenue  ?? 0) * ecoFrac),
    businessRevenue: Math.round((pooled.businessRevenue ?? 0) * bizFrac),
    leisureShare:    pooled.leisureShare,
    businessShare:   pooled.businessShare,
    capacityCapped:  pooled.capacityCapped,
  };
}

/**
 * The connecting feed weeklyTick will credit a route, computed the way the tick
 * computes it — for a route that may not exist yet.
 *
 * Three surfaces used to call computeConnectingDemand() bare and disagree with
 * the tick by an order of magnitude on any real hub: the tick's figure is
 *
 *   external gateway pool   computeConnectingDemand with the airport's weekly
 *                           DEPARTURES as slots (the previews passed route
 *                           COUNTS), gate congestion and hub-contest factors,
 *                           then × cannibalisation × world-event multiplier;
 *   + own-metal itineraries the A→hub→C markets runNetworkTick enumerates over
 *                           designated hubs (network.js), this tail's share of
 *                           the pair's seats;
 *   capped by seat headroom connecting passengers occupy real seats, so a full
 *                           aircraft carries none (partner feed competes for
 *                           the same headroom but is booked separately).
 *
 * Measured on a six-spoke JFK hub: previews $1,751/wk, tick $29,000/wk; on a
 * capacity-capped 7x JFK–DEN: previews $6,302/wk, tick $0.
 *
 * Mirrors weeklyTick from "Connecting passengers" to "const connecting = {…}".
 * A change to either side must be made in both — tools/route-quote-
 * reconciliation-test.mjs pins them together.
 *
 * @param {object} state
 * @param {object} spec
 *   origin, destination, aircraft, weeklyFrequency, ticketPrice, gameDate,
 *   eventDemandMult (event-only, as projectRouteAddition receives it),
 *   odPassengers + configuredSeatsOneWay (from the projected simulateRoute
 *   result — the headroom cap needs them), replacesRouteId (a route being
 *   edited is swapped for the probe rather than counted twice).
 * @returns {object} same shape as weeklyTick's per-route `connecting`.
 */
export function projectConnectingFeed(state, spec) {
  const {
    origin, destination, aircraft, weeklyFrequency = 7, ticketPrice,
    gameDate, eventDemandMult = 1, odPassengers = 0, configuredSeatsOneWay = 0,
    replacesRouteId = null,
  } = spec;
  const empty = { totalPax: 0, totalRevenue: 0, externalPax: 0, externalRevenue: 0,
                  itineraryPax: 0, itineraryRevenue: 0, feeds: [],
                  origin: null, destination: null, priceFactor: 1,
                  cannibalizationFactor: 1, capacityScale: 1 };
  if (!origin || !destination || origin === destination) return empty;

  const month = gameDate?.month ?? 6;
  const fleet = state.fleet ?? [];
  const probe = {
    id: replacesRouteId ?? PREVIEW_ROUTE_ID, origin, destination, stops: [origin, destination],
    aircraftId: aircraft?.id, weeklyFrequency, ticketPrice, hub: state.hub,
  };
  // The tick's `routes` view: the network as it will be with this route in it.
  const routes = [
    ...(state.routes ?? []).filter(r => r.id !== replacesRouteId && isRouteActive(r, month)),
    probe,
  ];
  const routeCountByAirport = {}, slotsByAirport = {};
  for (const r of routes) {
    const f = r.weeklyFrequency ?? 7;
    routeCountByAirport[r.origin]      = (routeCountByAirport[r.origin]      ?? 0) + 1;
    routeCountByAirport[r.destination] = (routeCountByAirport[r.destination] ?? 0) + 1;
    slotsByAirport[r.origin]      = (slotsByAirport[r.origin]      ?? 0) + f;
    slotsByAirport[r.destination] = (slotsByAirport[r.destination] ?? 0) + f;
  }

  const hubs        = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const gates       = state.gates ?? {};
  const competitors = state.competitors ?? [];
  const allianceMembership  = state.allianceMembership ?? null;
  const codeshareAgreements = state.codeshareAgreements ?? [];
  const allianceDef = state.allianceDef
    ?? (allianceMembership ? getAlliance(allianceMembership.allianceId) : null);
  const alliancePartnerIds  = allianceDef ? allianceMembers(allianceDef.id, competitors).map(c => c.id) : [];
  const allPartnerIds = new Set([...alliancePartnerIds, ...codeshareAgreements.map(a => a.competitorId)]);
  const partnerHubCodes = [];
  for (const id of allPartnerIds) {
    const comp = competitors.find(c => c.id === id);
    if (comp?.homeHub) partnerHubCodes.push(comp.homeHub);
  }

  const worldMult  = state.worldDemandMult ?? 1;
  const eventModel = buildEventDemandModel(state.activeEvents);
  const demandMultFor = (a, b) => eventModel.multFor(a, b) * worldMult;
  const rivalIndex = rivalIndexFor(state);
  const legacy     = isLegacy(rivalIndex);

  const net = runNetworkTick({
    routes, competitors, allianceMembership, codeshareAgreements, allianceDef,
    gameDate, hubs, gates, routeCountByAirport, slotsByAirport, demandMultFor, rivalIndex,
  });
  const contestFactors = {};
  for (const [code, c] of Object.entries(net.hubContestMap ?? {})) contestFactors[code] = c.contestFactor;

  const key = pairKeyOf(origin, destination);
  const raw = computeConnectingDemand(
    origin, destination, hubs,
    slotsByAirport[origin] ?? 0, slotsByAirport[destination] ?? 0,
    ticketPrice,
    { weeklyFrequency, partnerHubCodes, gates, contestFactors },
  );
  const cannib = Math.min(1.0, net.cannibalizationMap?.[key] ?? 1.0);
  const evConn = eventDemandMult * worldMult;
  let extPax     = Math.round(raw.totalPax     * cannib * evConn);
  let extRevenue = Math.round(raw.totalRevenue * cannib * evConn);

  // This tail's share of the pair's one-way seats (the tick's legFeedShare).
  let pairSeats = 0;
  for (const r of routes) {
    if (isMultiStop(r) || pairKeyOf(r.origin, r.destination) !== key) continue;
    const ac = r.id === probe.id ? aircraft : fleet.find(a => a.id === r.aircraftId);
    if (!ac) continue;
    pairSeats += configBodies(ac.config ?? {}) * (r.weeklyFrequency ?? 7);
  }
  const feedShare = legacy ? 1 : (pairSeats > 0 ? Math.min(1, (configuredSeatsOneWay ?? 0) / pairSeats) : 1);
  const ownLeg    = net.ownMetalOD?.byRouteKey?.[key] ?? null;
  let itinPax     = Math.round((ownLeg?.pax     ?? 0) * feedShare);
  let itinRevenue = Math.round((ownLeg?.revenue ?? 0) * feedShare);

  // Partner-fed passengers seated on this leg compete for the same headroom.
  let partnerPaxRaw = 0;
  if (!legacy) {
    for (const e of net.partnerODRevenue?.entries ?? []) {
      if (!e.origin || !e.dest || !e.hub) continue;
      const legKey = e.partnerLeg === 'leg2' ? pairKeyOf(e.origin, e.hub) : pairKeyOf(e.hub, e.dest);
      if (legKey === key) partnerPaxRaw += e.pax;
    }
    partnerPaxRaw = Math.round(partnerPaxRaw * feedShare);
  }

  const seatHeadroom = Math.max(0, Math.round((configuredSeatsOneWay ?? 0) * 0.95) - (odPassengers ?? 0));
  const wantPax  = extPax + itinPax + partnerPaxRaw;
  const capScale = wantPax > seatHeadroom && wantPax > 0 ? seatHeadroom / wantPax : 1;
  if (capScale < 1) {
    extPax      = Math.round(extPax      * capScale);
    extRevenue  = Math.round(extRevenue  * capScale);
    itinPax     = Math.round(itinPax     * capScale);
    itinRevenue = Math.round(itinRevenue * capScale);
  }
  return {
    totalPax:         extPax + itinPax,
    totalRevenue:     extRevenue + itinRevenue,
    externalPax:      extPax,
    externalRevenue:  extRevenue,
    itineraryPax:     itinPax,
    itineraryRevenue: itinRevenue,
    feeds:            ownLeg?.feeds ?? [],
    origin:           raw.origin,
    destination:      raw.destination,
    priceFactor:      raw.priceFactor,
    cannibalizationFactor: +cannib.toFixed(3),
    capacityScale:         +capScale.toFixed(3),
  };
}

/**
 * Project what a route the player has NOT opened yet would actually carry.
 *
 * WHY THIS EXISTS
 * ---------------
 * The route forms used to answer this with a bare `simulateRoute(spec, ac, gd)`,
 * which asks the demand model "what would this aircraft carry if it were the
 * only thing in this market?" — and on a pair the player already flies, the
 * answer is the WHOLE pool. Opening a fourth SFO–ATL frequency was previewed at
 * 100% load and then booked at whatever slice of one shared pool the tick handed
 * it. Four things were missing, all of which the tick applies:
 *
 *   1. Lane pooling  — every player tail on a pair competes as ONE offer and
 *                      splits the result by seat share (weeklyTick's pre-pass).
 *   2. Maturity ramp — a brand-new pair opens at 0.55 of its mature demand and
 *                      takes 16 weeks to get there (routeMaturityFactor).
 *   3. NWR load ceiling — in restricted worlds, demand is spilled against an
 *                      achievable ceiling, so 100% is not merely unlikely, it is
 *                      unreachable: parity lands near 87% and the asymptote is 95%.
 *   4. Rivals        — AI carriers and (in Headwinds) other humans contest the
 *                      pair through buildRivalPairOffers.
 *
 * Joining a pair you already fly deliberately returns launch === mature: the
 * market already knows the service, so an added tail gets a mature slice on day
 * one. The ramp only shows up on a genuinely new pair.
 *
 * @param {object} state
 * @param {object} spec
 * @param {string} spec.origin
 * @param {string} spec.destination
 * @param {object} spec.aircraft          the airframe to fly it (may be synthetic)
 * @param {number} spec.weeklyFrequency
 * @param {object} [spec.classPrices]     per-cabin fares; falls back to pair pricing
 * @param {number} [spec.ticketPrice]
 * @param {string} [spec.cateringLevel]
 * @param {object} [spec.season]
 * @param {string} [spec.replacesRouteId] editing an existing route rather than adding
 * @param {object} [spec.gameDate]
 * @param {number} [spec.fuelMultiplier]
 * @param {number} [spec.eventDemandMult]  EVENT-only demand multiplier for this
 *                                         O&D. state.worldDemandMult is composed
 *                                         on top internally — do not pre-multiply
 *                                         it in, or it lands twice.
 * @returns {{
 *   mature: object|null,      // simulateRoute result at full maturity
 *   connecting: object|null,  // projectConnectingFeed(): the tick's connecting shape, mature week
 *   launch: object|null,      // simulateRoute result in week 0
 *   shared: boolean,          // pair already flown by another of your tails
 *   pairRouteCount: number,   // your routes on the pair INCLUDING this one
 *   pairPassengers: number|null,  // what the whole pair carries, this tail included
 *   lanePassengers: number,       // what the whole metro lane carries, everyone
 *   laneDemand: number,           // the lane's pooled weekly demand
 *   rivalCount: number,        // rivals in the whole METRO lane, not just the pair
 *   lanePooled: boolean,       // the tick's metro pre-pass engages on this lane
 *   siblingPairs: string[],    // member pairs of the lane you already serve
 *   ceilingApplies: boolean,  // NWR load model is scaling this route down
 * }|null}
 */
export function projectRouteAddition(state, spec) {
  const {
    origin, destination, aircraft, weeklyFrequency,
    classPrices, ticketPrice, cateringLevel, season,
    replacesRouteId = null,
    // The week the tick will actually run, not a hardcoded June.
    //
    // `state.gameDate` is a value prepareWeek() DERIVES (tickPrep.js:141-142);
    // it is not a field a saved state carries, so this default was always the
    // literal — every projection in the game forecast a peak-summer week no
    // matter what month the airline was in. On a JFK–LAX fixture sitting in
    // week 1 that alone was a 42% overstatement of passengers (784 previewed
    // against 551 booked); previewing the real month brings it to 1.6%.
    gameDate: gameDateIn = state.gameDate ?? currentGameDate(state),
    // The world's CURRENT fuel price, not a hardcoded 1.0 — the forms used to
    // forecast every route at par no matter what fuel was doing.
    fuelMultiplier = state.fuelMultiplier ?? 1.0,
    // EVENT-ONLY multiplier for this O&D. The per-world multiplier
    // (state.worldDemandMult) is composed on top below, so a caller that already
    // has `eventDemand.multFor(o, d)` in hand — RoutePlanner and Routes both do —
    // passes it unchanged and gets the full figure; a caller that passes nothing
    // gets the event model resolved from state.activeEvents. Either way this
    // projection now applies exactly what weeklyTick applies.
    eventDemandMult = buildEventDemandModel(state.activeEvents).multFor(origin, destination),
  } = spec;
  if (!origin || !destination || !aircraft || origin === destination) return null;
  const gameDate = withAbsWeek(state, gameDateIn);

  const key   = pairKeyOf(origin, destination);
  const fleet = state.fleet ?? [];
  // The airframe may be synthetic (RoutePlanner previews a TYPE, not a tail), so
  // make sure the offer builder can find it.
  const fleetPlus = fleet.some((a) => a.id === aircraft.id) ? fleet : [...fleet, aircraft];
  // The one figure the tick uses in both places, built once here so the pooled
  // market and the route simulation cannot disagree about it.
  const demandMult = stateDemandMult(state, origin, destination, eventDemandMult);

  const previewRoute = {
    id: PREVIEW_ROUTE_ID,
    origin, destination,
    aircraftId: aircraft.id,
    weeklyFrequency,
    ticketPrice,
    classPrices,
    cateringLevel,
    season,
    hub: state.hub,
  };

  // Your OTHER routes on this pair. A route being edited is replaced, not joined —
  // otherwise the edit previews as if it were competing with its own old self.
  const others = (state.routes ?? []).filter(
    (r) => pairKeyOf(r.origin, r.destination) === key
      && !isMultiStop(r)
      && r.id !== replacesRouteId
      && r.id !== PREVIEW_ROUTE_ID
  );
  const pairRoutes = [...others, previewRoute];
  // Preview the DRAFT fare as the pair's fare.
  //
  // Fares belong to the pair, not the route: ADD_ROUTE writes
  // routePricing[pairKey] and every tail on the lane flies that price, so
  // repricing one route reprices all of them. buildPlayerPairOffer reads
  // routePricing first (correctly — that is the single source of truth), which
  // meant a draft fare never reached the POOLED offer. On a pair with two or
  // more tails the projection slices its demandOverride out of that pooled
  // result, so the passenger count was frozen at the fare the pair is flying
  // today and simulateRoute merely multiplied it by the draft one: dragging
  // economy from $120 to $700 held pax at 1475 while revenue rose exactly 4x.
  // The fare editor answered a question nobody asked.
  const draftPricing = (classPrices || ticketPrice != null)
    ? {
        ...(state.routePricing ?? {}),
        [key]: {
          ...(state.routePricing?.[key] ?? {}),
          ...(ticketPrice != null ? { economy: ticketPrice } : {}),
          ...(classPrices ?? {}),
        },
      }
    : state.routePricing;
  const routesPlus = [...(state.routes ?? []).filter(r => r.id !== replacesRouteId), previewRoute];
  const stateForOffer = {
    ...state,
    fleet: fleetPlus,
    routes: routesPlus,
    routePricing: draftPricing,
  };

  // Lane maturity. An established pair is already mature and does NOT re-ramp
  // when you add a tail; only a pair you have never flown starts at week 0.
  const existingWeeks = others.reduce((m, r) => Math.max(m, r.weeksOpen ?? 0), 0);
  const matureWeeks   = Math.max(existingWeeks, 16);
  const launchWeeks   = others.length > 0 ? existingWeeks : 0;

  // In a restricted world the tick scales demand against an achievable ceiling
  // with a deterministic per-week wobble. A route that does not exist yet has no
  // week to key that wobble on, so project the EXPECTED value (jitter = 1) —
  // honest central estimate rather than one arbitrary week's roll.
  const nwrFields = state.newWorldRestrictions ? { nwrLoadJitter: 1 } : {};

  const hcf = hubCostFactorsAt(
    state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {}), [origin, destination]);
  // Fleet utilisation as the tick will measure it — WITH this route flying.
  // Reputation (and so brand reach and price sensitivity) reads it.
  const utilWithProbe = fleetAvgUtilization(fleetPlus, [...routesPlus, ...(state.cargoRoutes ?? [])]);
  const runAt = (weeksOpen) => {
    const share = pairMarketShare(stateForOffer, origin, destination, {
      gameDate,
      demandMult,
      pairRoutes: pairRoutes.map((r) =>
        r.id === PREVIEW_ROUTE_ID ? { ...r, weeksOpen } : r),
      weeksOpen,
    });
    if (!share.playerResult) return { result: null, share };
    // Mirror the tick: a pair flown by a single tail with nothing else in its
    // metro lane runs simulateRoute's own demand path; a shared pair — or ANY
    // pooled lane — needs the pooled split instead.
    //
    // `share.lanePooled` is the half that was missing. The tick hands every
    // member group of a pooled lane a demandOverride even when that member pair
    // flies a single tail, because the metro pair has already been fought over.
    // Without it, a launch at a sibling airport fell through to simulateRoute's
    // own whole-pool fight and was quoted the entire metro market a second time.
    const override = (pairRoutes.length >= 2 || share.lanePooled)
      ? sliceForRoute(share.playerResult, previewRoute, aircraft, pairRoutes, fleetPlus)
      : null;
    const hubQ = hubQualityFor(state, origin, destination);
    const route = {
      ...previewRoute,
      weeksOpen,
      ...(hubQ > 0 ? { hubQualityBonus: hubQ } : {}),
      priceSensitivityReduction: stateSensReduction(state, hubQ, utilWithProbe),
      marketingBoost: playerCampaignBoost(state, origin, destination),
      brandReach: stateBrandReach(state, hubQ, false, [origin, destination], utilWithProbe),
      // The same three lounge fields weeklyTick attaches. Without loungeCoverage
      // the projection would sell day passes at an airport with no lounge, and
      // without loungeContractFactor it would quote the full third-party premium
      // ground rate on a route the tick discounts — a launch forecast that is
      // wrong in both directions at once.
      ...stateLoungeFields(state, origin, destination),
      // Hub station / layover / maintenance discounts, exactly as the tick
      // attaches them (hubCostFactorsAt). Spread conditionally like the tick.
      ...(hcf ? { hubCostFactors: hcf } : {}),
      ...nwrFields,
    };
    const result = simulateRoute(
      route, aircraft, gameDate,
      state.labor ?? null,
      fuelMultiplier,
      override,
      rivalSpecsFor(state, key),
      utilWithProbe,
      state.satisfaction ?? null,
      demandMult,
      state.ancillaries ?? null,
      state.competitors ?? [],
      rivalIndexFor(state),
    );
    if (!result) return { result, share };
    // Landing fees are charged per departure by weeklyTick and were simply absent
    // from the forms' arithmetic, because simulateRoute's `profit` excludes them.
    // On a 10x/week narrowbody trunk that is $62k/wk — enough to flip the sign:
    // the old form advertised +$64k/wk on a route the tick books at -$3k/wk.
    const type = getAircraftType(aircraft.typeId);
    const landingFee = routeLandingFee(route, type, weeklyFrequency);
    return {
      result: {
        ...result,
        landingFee,
        // `profit` now means what the tick means by it, so the two can be
        // compared directly. The pre-landing-fee figure stays available.
        opProfitBeforeLandingFees: result.profit,
        profit: Math.round(result.profit - landingFee),
        // Same figure under the name Tailwinds' projection uses (there `profit`
        // stays pre-fee) so shared callers — the Route Finder — read one field.
        profitAfterLandingFees: Math.round(result.profit - landingFee),
      },
      share,
    };
  };

  const mature = runAt(matureWeeks);
  const connecting = mature.result ? projectConnectingFeed(state, {
    origin, destination, aircraft, weeklyFrequency, ticketPrice, gameDate,
    eventDemandMult, replacesRouteId,
    odPassengers: mature.result.passengers,
    configuredSeatsOneWay: mature.result.configuredSeatsOneWay,
  }) : null;
  const launch = runAt(launchWeeks);
  if (!mature.result) return null;

  return {
    mature: mature.result,
    // The connecting feed the tick will credit this route (mature week), in the
    // tick's own shape. mature.profit + connecting.totalRevenue is the route's
    // operating profit — the figure every screen should call profit.
    connecting,
    launch: launch.result,
    shared: others.length > 0,
    pairRouteCount: pairRoutes.length,
    // What the WHOLE pair carries once this tail joins it, and what the whole
    // metro lane carries between everyone on it. The per-route figures above are
    // a slice of the first; without them on hand a planner can show a second
    // aircraft's profit falling and have no way to say why. "how come net profit
    // comes down if i add more aircraft to the same route" — ASAS, Discord.
    pairPassengers: mature.share.playerResult?.totalPax ?? null,
    pairRevenue: mature.share.playerResult
      ? Math.round((mature.share.playerResult.economyRevenue ?? 0)
                 + (mature.share.playerResult.businessRevenue ?? 0))
      : null,
    lanePassengers: mature.share.totalPax,
    laneDemand: Math.round((mature.share.market?.leisureDemand ?? 0)
                         + (mature.share.market?.businessDemand ?? 0)),
    rivalCount: mature.share.laneRivalCount,
    lanePooled: mature.share.lanePooled,
    siblingPairs: mature.share.siblingPairs,
    ceilingApplies: !!state.newWorldRestrictions,
  };
}

/** Best hub quality bonus across a pair's endpoints (tier 0 is a real tier). */
function hubQualityFor(state, origin, destination) {
  const hubs = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const q = (code) => {
    const t = hubs[code]?.tier;
    return t != null ? (HUB_TIERS[t]?.qualityBonus ?? 0) : 0;
  };
  return Math.max(q(origin), q(destination));
}

/**
 * Encroachment-shaped rivals on a pair — the same specs weeklyTick feeds
 * simulateRoute via encroachByPair(), so a solo-route projection contests the
 * identical set. AI carriers do NOT belong here: they reach simulateRoute
 * through the competitors bank instead.
 *
 * Exported because the UI needs it too: a screen that falls back to its own
 * simulateRoute call has to contest the same rivals the tick does, and passing
 * a bare `[]` there is what made a contested route preview as a monopoly.
 * Takes either (state, origin, destination) or (state, pairKey).
 */
export function rivalSpecsFor(state, originOrKey, destination) {
  const key = destination != null ? pairKeyOf(originOrKey, destination) : originOrKey;
  const enc    = state.encroachments?.[key];
  const humans = state.humanRivals?.[key] ?? [];
  return enc ? [enc, ...humans] : humans;
}
