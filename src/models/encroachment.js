// ─────────────────────────────────────────────────────────────────────────────
// ROUTE ENCROACHMENT
//
// Until the player is small, they fly uncontested (the early monopoly grace period).
// Once the airline is big enough to be "on the radar", AI competitors start entering
// the player's most lucrative routes — the ones run near-full at fat fares — splitting
// the demand pool with them. An entrant undercuts modestly and ramps up frequency over
// several weeks (moderate pressure), so over-pricing a monopoly route now invites a
// rival rather than printing money forever.
//
// The whole system is driven by a few tunable constants below.
//
// State shape:  state.encroachments = {
//   [pairKey]: {
//     competitorId, name, tier, qualityScore,
//     priceMultiplier,   // fare vs. route reference price (they undercut the player)
//     frequency,         // current weekly frequency (ramps toward freqCap)
//     freqCap,           // ceiling for this entrant on this route
//     seatsPerFlight,
//     weeksActive,       // weeks since entry
//     idleWeeks,         // consecutive weeks the route stopped being attractive
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────

import { BUSINESS_PRICE_MULTIPLIER } from './demand.js';
import { referencePrice, routePairKey } from '../utils/simulation.js';

// ── Tunable knobs ────────────────────────────────────────────────────────────

/** Player market cap ($) above which the airline is "on the radar" and routes can be contested. */
export const ENCROACH_ACTIVATION_MARKETCAP = 400_000_000;

/** A route is a "fat target" worth attacking when it runs at/above this load factor … */
export const ENCROACH_TARGET_MIN_LF = 0.80;
/** … AND the player prices it at/above this multiple of the reference fare. */
export const ENCROACH_TARGET_MIN_FARE_RATIO = 1.35;

/** Base weekly probability that a fat route draws a new entrant (scaled by how fat it is). */
export const ENCROACH_BASE_ENTRY_PROB = 0.045;
/** Cap on weekly entry probability for any single route. */
export const ENCROACH_MAX_ENTRY_PROB = 0.18;

/** Baseline weekly entry probability on ANY of the player's routes — even fairly
 *  priced ones — once the airline is on the radar. Models ordinary competitive entry,
 *  not just punishment for gouging. Kept low so it's occasional, not constant. */
export const ENCROACH_RANDOM_ENTRY_PROB = 0.008;

/** How far below the player's fare ratio an entrant prices (moderate undercut). */
export const ENCROACH_UNDERCUT = 0.15;
/** Per-tier fare-ratio floors (entrants won't price below these). */
export const ENCROACH_TIER_FLOOR = { budget: 0.70, legacy: 0.90, premium: 1.20 };
/** Per-tier seat counts for the entrant's aircraft. */
export const ENCROACH_TIER_SEATS = { budget: 186, legacy: 220, premium: 260 };

/** Entrant starts at this fraction of the player's frequency on the pair … */
export const ENCROACH_START_FREQ_FRAC = 0.30;
/** … and ramps toward this fraction (the share-split ceiling). */
export const ENCROACH_CAP_FREQ_FRAC = 0.65;
/** Weekly frequency ramp (additive share of freqCap). */
export const ENCROACH_RAMP_PER_WEEK = 0.12;

/** If the player stops making the route attractive (drops fare/leaves), the entrant
 *  retreats after this many idle weeks. */
export const ENCROACH_EXIT_IDLE_WEEKS = 12;
/** Fare ratio below which the route is no longer worth contesting (player fought back). */
export const ENCROACH_EXIT_FARE_RATIO = 1.05;

// ── Offer builder (consumed by simulateRoute / weeklyTick) ───────────────────

/**
 * Build a demand-model AirlineOffer for an encroachment entry on a given market.
 * Mirrors buildCompetitorOffer so computeMarketShare treats it identically.
 */
export function buildEncroachmentOffer(spec, market) {
  if (!spec || !spec.frequency) return null;
  const economyPrice = Math.max(1, Math.round(market.referencePrice * spec.priceMultiplier));
  const hasBusiness  = spec.tier !== 'budget';
  const businessPrice = hasBusiness ? Math.round(economyPrice * BUSINESS_PRICE_MULTIPLIER) : null;
  const seats = spec.seatsPerFlight ?? 186;
  const businessPerFlight = hasBusiness ? Math.round(seats * 0.13) : 0;
  return {
    airlineId:         `encroach:${spec.competitorId}`,
    origin:            market.origin,
    destination:       market.destination,
    economyPrice,
    businessPrice,
    weeklyFrequency:   spec.frequency,
    seatsPerFlight:    seats,
    economySeats:      seats * spec.frequency,
    businessSeats:     businessPerFlight * spec.frequency,
    qualityScore:      spec.qualityScore ?? 60,
    connectivityBonus: 0,
  };
}

// ── Weekly tick ──────────────────────────────────────────────────────────────

/**
 * Evolve the encroachment map based on the PRIOR week's outcome.
 * Pure (apart from Math.random, which the sim harness seeds for reproducibility).
 *
 * @param {object} args
 *   routes        player passenger routes
 *   routePricing  state.routePricing (pairKey → class prices)
 *   lastReport    previous weekly report (for per-route load factor)
 *   marketCap     player market cap (activation gate)
 *   competitors   state.competitors (pool of carriers that can enter)
 *   encroachments current encroachment map
 * @returns {{ encroachments: object, events: Array }}
 */
export function tickEncroachment({ routes = [], routePricing = {}, lastReport = null, marketCap = 0, competitors = [], encroachments = {} }) {
  const events = [];
  const next = { ...encroachments };

  // Map pairKey → { totalFreq, lf, fareRatio, origin, destination } from current routes + last report
  const lfByRouteId = {};
  for (const rr of lastReport?.routeResults ?? []) lfByRouteId[rr.routeId] = rr.loadFactor ?? 0;

  const pairInfo = {};
  for (const r of routes) {
    const key = routePairKey(r.origin, r.destination);
    const refP = referencePrice(r.origin, r.destination) || 1;
    const price = routePricing?.[key]?.economy ?? r.ticketPrice ?? refP;
    if (!pairInfo[key]) {
      pairInfo[key] = { origin: r.origin, destination: r.destination, totalFreq: 0, lfSum: 0, lfN: 0, fareRatio: price / refP };
    }
    pairInfo[key].totalFreq += r.weeklyFrequency ?? 0;
    const lf = lfByRouteId[r.id];
    if (lf != null) { pairInfo[key].lfSum += lf; pairInfo[key].lfN += 1; }
  }

  const activated = marketCap >= ENCROACH_ACTIVATION_MARKETCAP;

  // 1. Update existing entrants (ramp / retreat); drop those whose route the player left.
  for (const key of Object.keys(next)) {
    const info = pairInfo[key];
    const e = next[key];
    if (!info) { delete next[key]; continue; }                       // player no longer flies it
    const attractive = info.fareRatio >= ENCROACH_EXIT_FARE_RATIO;
    const idleWeeks = attractive ? 0 : (e.idleWeeks ?? 0) + 1;
    if (idleWeeks >= ENCROACH_EXIT_IDLE_WEEKS) { delete next[key]; events.push({ type: 'exit', pairKey: key, competitorId: e.competitorId }); continue; }
    // ramp frequency toward cap while attractive
    const target = e.freqCap;
    const step   = Math.max(1, Math.round(target * ENCROACH_RAMP_PER_WEEK));
    const frequency = attractive ? Math.min(target, e.frequency + step) : e.frequency;
    next[key] = { ...e, frequency, weeksActive: (e.weeksActive ?? 0) + 1, idleWeeks };
  }

  // 2. Consider new entrants on fat, uncontested routes (only once activated).
  if (activated && competitors.length > 0) {
    for (const key of Object.keys(pairInfo)) {
      if (next[key]) continue; // already contested
      const info = pairInfo[key];
      const lf = info.lfN > 0 ? info.lfSum / info.lfN : 0;

      // Every route carries a small baseline entry chance (ordinary competition).
      // Fat routes — run near-full at gouging fares — attract entrants far faster.
      let prob = ENCROACH_RANDOM_ENTRY_PROB;
      if (lf >= ENCROACH_TARGET_MIN_LF && info.fareRatio >= ENCROACH_TARGET_MIN_FARE_RATIO) {
        const fatness = Math.min(2.0, info.fareRatio - 1.0);
        prob = Math.max(prob, Math.min(ENCROACH_MAX_ENTRY_PROB, ENCROACH_BASE_ENTRY_PROB * (1 + fatness * 2)));
      }
      if (Math.random() >= prob) continue;

      // Pick a challenger. Prefer a budget carrier (sharper undercut) ~half the time.
      const pool = competitors.filter(Boolean);
      const budgets = pool.filter(c => c.tier === 'budget');
      const chosen = (budgets.length && Math.random() < 0.5)
        ? budgets[Math.floor(Math.random() * budgets.length)]
        : pool[Math.floor(Math.random() * pool.length)];
      if (!chosen) continue;

      const tier  = chosen.tier ?? 'legacy';
      const floor = ENCROACH_TIER_FLOOR[tier] ?? 0.9;
      const priceMultiplier = Math.max(floor, info.fareRatio - ENCROACH_UNDERCUT);
      const startFreq = Math.max(3, Math.round(info.totalFreq * ENCROACH_START_FREQ_FRAC));
      const freqCap   = Math.max(startFreq, Math.round(info.totalFreq * ENCROACH_CAP_FREQ_FRAC));

      next[key] = {
        competitorId:   chosen.id,
        name:           chosen.name,
        tier,
        qualityScore:   chosen.baseQualityScore ?? 60,
        priceMultiplier,
        frequency:      startFreq,
        freqCap,
        seatsPerFlight: ENCROACH_TIER_SEATS[tier] ?? 200,
        weeksActive:    0,
        idleWeeks:      0,
      };
      events.push({ type: 'enter', pairKey: key, competitorId: chosen.id, name: chosen.name, origin: info.origin, destination: info.destination });
    }
  }

  return { encroachments: next, events };
}
