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
  HUB_TIERS,
} from './demand.js';
import { buildEncroachmentOffer } from './encroachment.js';
import { campaignDemandBoostPct } from '../data/overhead.js';
import { getAircraftType } from '../data/aircraft.js';
import {
  configBodies,
  defaultConfig,
  routeQualityBreakdown,
  isMultiStop,
  stateSensReduction,
  stateBrandReach,
  simulateRoute,
  fleetAvgUtilization,
  routeLandingFee,
  CLASS_FARE_MULTIPLIERS,
} from '../utils/simulation.js';

export const pairKeyOf = (a, b) => [a, b].sort().join('-');

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
    connectivityBonus: isHubPair ? 0.20 : 0,
    priceSensitivityReduction: stateSensReduction(state, hubQ),
    marketingBoost:   playerCampaignBoost(state, r0.origin, r0.destination),
    // Brand reach, resolved through the same helper the tick uses. Without it a
    // week-one carrier would preview the market share of an established one —
    // the exact class of preview/tick divergence this module exists to prevent.
    brandReach:       stateBrandReach(state, hubQ, false),
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

  for (const spec of state.humanRivals?.[key] ?? []) {
    const offer = buildEncroachmentOffer(spec, market);
    if (offer) offers.push(offer);
  }
  const enc = state.encroachments?.[key];
  if (enc) {
    const offer = buildEncroachmentOffer(enc, market);
    if (offer) offers.push(offer);
  }
  for (const c of state.competitors ?? []) {
    if (c.human) continue;                 // already counted via humanRivals
    if (!c.routes?.[key]) continue;
    const offer = buildCompetitorOffer(c, market);
    if (offer) offers.push(offer);
  }
  return offers;
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
export function pairMarketShare(state, origin, destination, opts = {}) {
  const gameDate = opts.gameDate ?? state.gameDate ?? { month: 6 };
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
  const market = buildRouteMarket(origin, destination, gameDate,
    pairRoutes.length ? routeMaturityFactor(weeksOpen) : 1,
    state.worldDemandMult ?? 1);

  const playerOffer = buildPlayerPairOffer(state, pairRoutes);
  const rivalOffers = buildRivalPairOffers(state, market);
  const offers = [...(playerOffer ? [playerOffer] : []), ...rivalOffers];
  if (offers.length === 0) {
    return { market, offers, results: [], playerResult: null,
             playerShare: null, totalPax: 0, contested: false };
  }

  const results = computeMarketShare(market, offers);
  const playerResult = playerOffer
    ? results.find((r) => r.airlineId === 'player') ?? null
    : null;
  const totalPax = results.reduce((s, r) => s + (r.totalPax ?? 0), 0);

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
    totalPax,
    contested: rivalOffers.length > 0,
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
    economyRevenue:  Math.round((pooled.economyRevenue  ?? 0) * ecoFrac),
    businessRevenue: Math.round((pooled.businessRevenue ?? 0) * bizFrac),
    leisureShare:    pooled.leisureShare,
    businessShare:   pooled.businessShare,
    capacityCapped:  pooled.capacityCapped,
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
 * @param {number} [spec.eventDemandMult]
 * @returns {{
 *   mature: object|null,      // simulateRoute result at full maturity
 *   launch: object|null,      // simulateRoute result in week 0
 *   shared: boolean,          // pair already flown by another of your tails
 *   pairRouteCount: number,   // your routes on the pair INCLUDING this one
 *   rivalCount: number,
 *   ceilingApplies: boolean,  // NWR load model is scaling this route down
 * }|null}
 */
export function projectRouteAddition(state, spec) {
  const {
    origin, destination, aircraft, weeklyFrequency,
    classPrices, ticketPrice, cateringLevel, season,
    replacesRouteId = null,
    gameDate = state.gameDate ?? { month: 6 },
    // The world's CURRENT fuel price, not a hardcoded 1.0 — the forms used to
    // forecast every route at par no matter what fuel was doing.
    fuelMultiplier = state.fuelMultiplier ?? 1.0,
    eventDemandMult = 1.0,
  } = spec;
  if (!origin || !destination || !aircraft || origin === destination) return null;

  const key   = pairKeyOf(origin, destination);
  const fleet = state.fleet ?? [];
  // The airframe may be synthetic (RoutePlanner previews a TYPE, not a tail), so
  // make sure the offer builder can find it.
  const fleetPlus = fleet.some((a) => a.id === aircraft.id) ? fleet : [...fleet, aircraft];

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
  const stateForOffer = { ...state, fleet: fleetPlus, routes: [...(state.routes ?? []).filter(r => r.id !== replacesRouteId), previewRoute] };

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

  const runAt = (weeksOpen) => {
    const share = pairMarketShare(stateForOffer, origin, destination, {
      gameDate,
      pairRoutes: pairRoutes.map((r) =>
        r.id === PREVIEW_ROUTE_ID ? { ...r, weeksOpen } : r),
      weeksOpen,
    });
    if (!share.playerResult) return { result: null, share };
    // Mirror the tick: a pair flown by a single tail runs simulateRoute's own
    // demand path; only a genuinely shared pair needs the pooled split.
    const override = pairRoutes.length >= 2
      ? sliceForRoute(share.playerResult, previewRoute, aircraft, pairRoutes, fleetPlus)
      : null;
    const hubQ = hubQualityFor(state, origin, destination);
    const route = {
      ...previewRoute,
      weeksOpen,
      ...(hubQ > 0 ? { hubQualityBonus: hubQ } : {}),
      priceSensitivityReduction: stateSensReduction(state, hubQ),
      marketingBoost: playerCampaignBoost(state, origin, destination),
      brandReach: stateBrandReach(state, hubQ, false),
      ...nwrFields,
    };
    const result = simulateRoute(
      route, aircraft, gameDate,
      state.labor ?? null,
      fuelMultiplier,
      override,
      rivalSpecsFor(state, key),
      fleetAvgUtilization(fleetPlus, [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]),
      state.satisfaction ?? null,
      eventDemandMult,
      state.ancillaries ?? null,
      state.competitors ?? [],
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
      },
      share,
    };
  };

  const mature = runAt(matureWeeks);
  const launch = runAt(launchWeeks);
  if (!mature.result) return null;

  return {
    mature: mature.result,
    launch: launch.result,
    shared: others.length > 0,
    pairRouteCount: pairRoutes.length,
    rivalCount: mature.share.offers.length - 1,
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
 */
function rivalSpecsFor(state, key) {
  const enc    = state.encroachments?.[key];
  const humans = state.humanRivals?.[key] ?? [];
  return enc ? [enc, ...humans] : humans;
}
