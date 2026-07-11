// ─────────────────────────────────────────────────────────────────────────────
// ROUTE ENCROACHMENT
//
// AI competitors enter the player's most lucrative routes — the ones run
// near-full at fat fares — splitting the demand pool with them. Fat targets are
// attackable from week 1 (entry probability scales up with the player's market
// cap), and once the airline is on the radar even fairly-priced routes carry a
// small baseline entry chance. An entrant undercuts modestly and ramps up
// frequency over several weeks (moderate pressure), so over-pricing a monopoly
// route invites a rival rather than printing money forever.
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

import { BUSINESS_PRICE_MULTIPLIER, competitorBusinessFraction } from './demand.js';
import { referencePrice, routePairKey } from '../utils/simulation.js';

// ── Tunable knobs ────────────────────────────────────────────────────────────

/** Player market cap ($) at which encroachment pressure reaches FULL strength.
 *  There is no longer a hard grace-period gate: fat routes can be contested from
 *  week 1 (real markets punish gouging regardless of who flies the route), with
 *  entry probability scaled down for small airlines via ENCROACH_SIZE_PROB_FLOOR. */
export const ENCROACH_ACTIVATION_MARKETCAP = 250_000_000;

/** Entry-probability multiplier for a brand-new airline (market cap ≈ 0),
 *  ramping linearly to 1.0 at ENCROACH_ACTIVATION_MARKETCAP. */
export const ENCROACH_SIZE_PROB_FLOOR = 0.30;

/** Market cap above which even fairly-priced routes carry the small baseline
 *  entry chance (ordinary competitive entry, not gouging punishment). */
export const ENCROACH_RANDOM_ENTRY_MARKETCAP = 50_000_000;

/** A route is a "fat target" worth attacking when it runs at/above this load factor … */
export const ENCROACH_TARGET_MIN_LF = 0.78;
/** … AND the player prices it at/above this multiple of the reference fare. */
export const ENCROACH_TARGET_MIN_FARE_RATIO = 1.10;

/** Saturation entry: a route running essentially FULL is an underserved market and
 *  attracts entrants even at fair fares — full planes are visible to the whole industry. */
export const ENCROACH_SATURATION_LF = 0.93;
/** Weekly entry probability for a saturated (near-100% LF) route at a fair fare. */
export const ENCROACH_SATURATION_PROB = 0.06;

/** Base weekly probability that a fat route draws a new entrant (scaled by how fat it is). */
export const ENCROACH_BASE_ENTRY_PROB = 0.075;
/** Cap on weekly entry probability for any single route. */
export const ENCROACH_MAX_ENTRY_PROB = 0.28;

/** Baseline weekly entry probability on ANY of the player's routes — even fairly
 *  priced ones — once the airline is on the radar. Models ordinary competitive entry,
 *  not just punishment for gouging. Kept low so it's occasional, not constant. */
export const ENCROACH_RANDOM_ENTRY_PROB = 0.015;

/** How far below the player's fare ratio an entrant prices (moderate undercut). */
export const ENCROACH_UNDERCUT = 0.15;
/** Per-tier fare-ratio floors (entrants won't price below these). */
export const ENCROACH_TIER_FLOOR = { budget: 0.70, legacy: 0.90, premium: 1.20 };
/** Per-tier seat counts for the entrant's aircraft. */
export const ENCROACH_TIER_SEATS = { budget: 186, legacy: 220, premium: 260 };

/** Entrant starts at this fraction of the player's frequency on the pair … */
export const ENCROACH_START_FREQ_FRAC = 0.40;
/** … and ramps toward this fraction (the share-split ceiling). */
export const ENCROACH_CAP_FREQ_FRAC = 0.80;
/** Weekly frequency ramp (additive share of freqCap). */
export const ENCROACH_RAMP_PER_WEEK = 0.18;

/** If the player keeps the route un-fat for this many weeks, the entrant stops actively
 *  contesting it — but it does NOT abandon the route. Instead it goes DORMANT: it keeps a
 *  reduced, persistent presence and eases off on price (see dormant knobs below). */
export const ENCROACH_EXIT_IDLE_WEEKS = 20;
/** Fare ratio below which the route is no longer worth actively contesting (player fought back). */
export const ENCROACH_EXIT_FARE_RATIO = 0.98;

// ── Dormancy (entrenched-but-passive) ────────────────────────────────────────
// A dormant entrant has decided the route isn't worth a price war, but it has sunk costs
// (aircraft, slots, brand presence) and stays on as a minor competitor. It shrinks to a
// token frequency and prices only mildly below the player rather than deeply undercutting,
// so it keeps splitting some traffic without crushing the player's margins. If the player
// lets the route get fat again, the entrant re-awakens and resumes aggressive contesting.

/** Dormant entrant maintains this fraction of the player's frequency on the pair. */
export const ENCROACH_DORMANT_FREQ_FRAC = 0.50;
/** Dormant entrant eases its fare up to only this mild undercut of the player
 *  (vs. the aggressive ENCROACH_UNDERCUT while actively contesting). */
export const ENCROACH_DORMANT_UNDERCUT = 0.04;
/** Per-week glide rate by which a dormant entrant eases frequency down and price up
 *  toward the dormant targets (so the transition is gradual, not instant). */
export const ENCROACH_DORMANT_EASE_PER_WEEK = 0.12;
/** If a dormant route's fare ratio climbs back to/above this, the entrant re-awakens
 *  and resumes aggressive contesting (defaults to the same bar as a fresh fat target). */
export const ENCROACH_REACTIVATE_FARE_RATIO = ENCROACH_TARGET_MIN_FARE_RATIO;

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
  const businessPerFlight = hasBusiness
    ? Math.round(seats * competitorBusinessFraction(spec.tier, market.distanceKm))
    : 0;
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

  // Size-scaled pressure: small airlines draw entrants more slowly, but no one
  // is invisible. 0.30× at launch → 1.0× at full activation market cap.
  const sizeFactor = Math.min(1,
    ENCROACH_SIZE_PROB_FLOOR + (1 - ENCROACH_SIZE_PROB_FLOOR) * (marketCap / ENCROACH_ACTIVATION_MARKETCAP));
  // Ordinary (non-gouging) baseline entry only applies once the airline is big
  // enough to be on the industry's radar.
  const randomEntryActive = marketCap >= ENCROACH_RANDOM_ENTRY_MARKETCAP;

  // 1. Update existing entrants. While the route stays fat they ramp up; if the player
  //    fights price down for long enough they go DORMANT (token presence, mild pricing)
  //    rather than fully retreating; and a dormant entrant re-awakens if the lane turns
  //    fat again. Only a player abandoning the route entirely removes the entrant.
  for (const key of Object.keys(next)) {
    const info = pairInfo[key];
    const e = next[key];
    if (!info) { delete next[key]; continue; }                       // player no longer flies it → gone

    const fatAgain   = info.fareRatio >= ENCROACH_REACTIVATE_FARE_RATIO;
    const attractive = info.fareRatio >= ENCROACH_EXIT_FARE_RATIO;
    const tierFloor  = ENCROACH_TIER_FLOOR[e.tier] ?? 0.9;

    // ── Dormant entrants: glide to a token footprint; re-awaken if the route turns fat. ──
    if (e.dormant) {
      if (fatAgain) {
        const priceMultiplier = Math.max(tierFloor, info.fareRatio - ENCROACH_UNDERCUT);
        next[key] = { ...e, dormant: false, idleWeeks: 0, priceMultiplier: +priceMultiplier.toFixed(4), weeksActive: (e.weeksActive ?? 0) + 1 };
        events.push({ type: 'reawaken', pairKey: key, competitorId: e.competitorId, name: e.name, origin: info.origin, destination: info.destination });
        continue;
      }
      const freqTarget  = Math.max(2, Math.round(info.totalFreq * ENCROACH_DORMANT_FREQ_FRAC));
      const priceTarget = Math.max(tierFloor, info.fareRatio - ENCROACH_DORMANT_UNDERCUT);
      // Shrink frequency toward the dormant floor (never below it).
      const frequency = e.frequency > freqTarget
        ? Math.max(freqTarget, e.frequency - Math.max(1, Math.round((e.frequency - freqTarget) * ENCROACH_DORMANT_EASE_PER_WEEK)))
        : e.frequency;
      // Ease fare UP toward a mild undercut — i.e. stop pricing aggressively. Never cut further while dormant.
      const priceMultiplier = e.priceMultiplier < priceTarget
        ? Math.min(priceTarget, +(e.priceMultiplier + Math.max(0.01, (priceTarget - e.priceMultiplier) * ENCROACH_DORMANT_EASE_PER_WEEK)).toFixed(4))
        : e.priceMultiplier;
      next[key] = { ...e, frequency, priceMultiplier, weeksActive: (e.weeksActive ?? 0) + 1 };
      continue;
    }

    // ── Active entrants: ramp while attractive; fall dormant after the idle timeout. ──
    const idleWeeks = attractive ? 0 : (e.idleWeeks ?? 0) + 1;
    if (idleWeeks >= ENCROACH_EXIT_IDLE_WEEKS) {
      next[key] = { ...e, dormant: true, idleWeeks, weeksActive: (e.weeksActive ?? 0) + 1 };
      events.push({ type: 'dormant', pairKey: key, competitorId: e.competitorId, name: e.name, origin: info.origin, destination: info.destination });
      continue;
    }
    const target = e.freqCap;
    const step   = Math.max(1, Math.round(target * ENCROACH_RAMP_PER_WEEK));
    const frequency = attractive ? Math.min(target, e.frequency + step) : e.frequency;
    next[key] = { ...e, frequency, weeksActive: (e.weeksActive ?? 0) + 1, idleWeeks };
  }

  // 2. Consider new entrants on fat, uncontested routes. Fat targets are
  //    attackable from week 1 (scaled by airline size); the ordinary baseline
  //    entry chance additionally requires being on the radar.
  if (competitors.length > 0) {
    for (const key of Object.keys(pairInfo)) {
      if (next[key]) continue; // already contested
      const info = pairInfo[key];
      const lf = info.lfN > 0 ? info.lfSum / info.lfN : 0;

      // Radar-visible routes carry a small baseline entry chance (ordinary competition).
      // Fat routes — run near-full at gouging fares — attract entrants far faster.
      let prob = randomEntryActive ? ENCROACH_RANDOM_ENTRY_PROB : 0;
      if (lf >= ENCROACH_TARGET_MIN_LF && info.fareRatio >= ENCROACH_TARGET_MIN_FARE_RATIO) {
        const fatness = Math.min(2.0, info.fareRatio - 1.0);
        prob = Math.max(prob, Math.min(ENCROACH_MAX_ENTRY_PROB, ENCROACH_BASE_ENTRY_PROB * (1 + fatness * 2)));
      }
      // Saturated routes (near-100% LF) attract entry even at fair fares — an
      // always-full market is visibly underserved, and rivals want a slice.
      if (lf >= ENCROACH_SATURATION_LF) {
        prob = Math.max(prob, ENCROACH_SATURATION_PROB);
      }
      prob *= sizeFactor;
      if (prob <= 0 || Math.random() >= prob) continue;

      // Pick a challenger. Growth-hungry personalities (aggressive/expansionist/
      // copycat) jump on fat routes first; otherwise prefer a budget carrier
      // (sharper undercut) ~half the time.
      const pool   = competitors.filter(Boolean);
      const hungry = pool.filter(c =>
        c._archetype === 'aggressive' || c._archetype === 'expansionist' || c._archetype === 'copycat');
      const budgets = pool.filter(c => c.tier === 'budget');
      const pickFrom = (hungry.length && Math.random() < 0.45) ? hungry
        : (budgets.length && Math.random() < 0.5) ? budgets
        : pool;
      const chosen = pickFrom[Math.floor(Math.random() * pickFrom.length)];
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
