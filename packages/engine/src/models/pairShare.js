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
  stateSensReduction,
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
 * @param {object} [opts.gameDate]  defaults to state.gameDate
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

  const pairRoutes = (state.routes ?? []).filter(
    (r) => pairKeyOf(r.origin, r.destination) === key && !r.stops?.length
  );
  // Route maturity is per-route; a pair flown by several tails ramps with the
  // OLDEST of them (the market has known the service that long).
  const weeksOpen = pairRoutes.reduce(
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
