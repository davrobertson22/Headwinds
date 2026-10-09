// Fare cliff — "will this fare kill the route?", answered BEFORE the player commits.
//
// WHY: restricted (NWR) worlds put an exponential yield choke on any fare above
// ~1.10x reference (nwrYieldChokeFactor in utils/market.js: exp(-15·overage)).
// That is deliberate balance — it stands in for the rival who would undercut a
// monopoly — but nothing on the pricing screens said so. On 2026-09-24 a Piston
// Age player bulk-raised all 266 routes +50% from reference; the choke plus
// elasticity left each route ~0.1% of its passengers, and the airline missed
// three loan payments and went bankrupt. Undoing it meant resetting 161 pairs
// one at a time.
//
// These helpers let every pricing surface (bulk %, the selection bar, the fare
// editor, the Routes page banner) name the cliff, and mirror BULK_ADJUST_PRICING
// exactly so a preview cannot disagree with what the reducer will store.
//
// Classic worlds have no choke: every function here reports nothing there
// unless `force` is passed (tests).
import { referencePrice, getNwrYieldChoke, nwrChokeThreshold } from '../utils/market.js';
import {
  CLASS_FARE_MULTIPLIERS, routePairKey, defaultClassPrices, clampClassPrice,
  routeQualityBreakdown, isMultiStop,
} from '../utils/simulation.js';
import { getAircraftType } from '../data/aircraft.js';
import { COMPETITIVE_FARE_COMPRESSION_PER_RIVAL, COMPETITIVE_FARE_COMPRESSION_FLOOR } from './demand.js';

// ─── Where the cliff really is (Discord, 2026-09-24) ─────────────────────────
//
// "it warns when prices are over the cliff, but the projected load of routes
// stays the same" — the warning fired at a flat 1.10× for every cabin while the
// engine's cliff starts at 1.10–1.25× by quality, and (until the same fix) never
// reached premium cabins at all. The warning now asks the questions the engine
// asks:
//   - the route's own quality score (routeQualityBreakdown — the number Route
//     Details shows, built from the inputs the tick uses), averaged over the
//     aircraft on the pair exactly as the pooled tick averages it;
//   - for ECONOMY only, the pair's competitive fare compression: with rivals on
//     the pair the economy pool is priced against a reference 5% lower per extra
//     carrier (floor 90%), so the cliff arrives sooner there. Premium cabins meet
//     the cliff against their own uncompressed reference (utils/simulation.js).
// A fare is "over" only when it exceeds the threshold by more than rounding — a
// fare typed as exactly +10% is not a cliff.

/** Mean route quality per flown nonstop pair, as the tick's pooled offer sees it. */
export function pairQualities(state) {
  const fleetById = new Map((state?.fleet ?? []).map(a => [a.id, a]));
  const acc = new Map();
  for (const r of state?.routes ?? []) {
    if (isMultiStop(r)) continue;
    const a = fleetById.get(r.aircraftId);
    const q = a ? routeQualityBreakdown(r, a, state)?.total : null;
    if (q == null) continue;
    const key = routePairKey(r.origin, r.destination);
    const e = acc.get(key) ?? { sum: 0, n: 0 };
    e.sum += q; e.n += 1;
    acc.set(key, e);
  }
  return new Map([...acc].map(([k, e]) => [k, Math.round(e.sum / e.n)]));
}

/** Economy fare compression on a pair: 1 alone, −5% per extra nonstop carrier, floor 0.90. */
export function pairFareCompression(state, origin, destination) {
  const key = routePairKey(origin, destination);
  const ids = new Set();
  for (const c of state?.competitors ?? []) if (c?.routes?.[key]) ids.add(c.id ?? c.name);
  for (const spec of state?.humanRivals?.[key] ?? []) ids.add(spec?.competitorId ?? spec?.name);
  if (state?.encroachments?.[key]) ids.add(`enc:${state.encroachments[key].competitorId ?? key}`);
  return Math.max(COMPETITIVE_FARE_COMPRESSION_FLOOR, 1 - COMPETITIVE_FARE_COMPRESSION_PER_RIVAL * ids.size);
}

/** Context for one pair — what faresOverCliff needs to place the cliff. */
function pairContext(state, key, origin, destination, qualities) {
  return { quality: qualities.get(key) ?? 50, economyCompression: pairFareCompression(state, origin, destination) };
}

/** True when the world has a fare cliff at all (restricted worlds). */
export function fareCliffActive() { return getNwrYieldChoke(); }

/**
 * The price/reference ratio where demand starts collapsing for a route of the
 * given quality: 1.10x at quality ≤ 50, rising to 1.25x at 100. Called without
 * a quality it returns the 1.10x floor — the "anywhere from" figure for copy.
 * Warnings pass the route's real quality: a flat 1.10x fired on fares the
 * engine never punished (Discord, 2026-09-24).
 */
export function fareCliffRatio(quality = 50) { return nwrChokeThreshold(quality); }

/** Reference fare per cabin for a pair (economy ref × the engine's multipliers). */
export function referenceFaresFor(origin, destination) {
  return defaultClassPrices(referencePrice(origin, destination));
}

/**
 * Cabins of `fares` priced past the cliff on this pair.
 * @param {object} fares   { economy, premiumEconomy, businessClass, firstClass }
 * @param {object} [opts]  { classes: cabins to consider (default all priced),
 *                           quality, force: ignore the world flag }
 * @returns {Array<{cls, ratio, fare, ref}>}
 */
export function faresOverCliff(fares, origin, destination, opts = {}) {
  if (!(opts.force ?? getNwrYieldChoke())) return [];
  const refP = referencePrice(origin, destination);
  const thr  = fareCliffRatio(opts.quality ?? 50);
  const out  = [];
  for (const cls of opts.classes ?? Object.keys(CLASS_FARE_MULTIPLIERS)) {
    const fare = Number(fares?.[cls]);
    if (!(fare > 0)) continue;
    const ref = refP * (CLASS_FARE_MULTIPLIERS[cls] ?? 1);
    const ratio = fare / Math.max(1, ref);
    // The fare at which the cliff starts, for this cabin on this pair.
    const cliffFare = ref * thr * (cls === 'economy' ? (opts.economyCompression ?? 1) : 1);
    // +1: fares and the reference shown beside them are whole dollars, so a fare
    // typed as exactly +10% of the displayed reference can land up to ~$0.55
    // over the unrounded threshold. That is not a cliff (a $1 overage cuts
    // demand by well under 1% on any cabin worth warning about).
    if (fare > cliffFare + 1) out.push({ cls, ratio, fare, ref: Math.round(ref), cliffFare: Math.floor(cliffFare) });
  }
  return out;
}

/**
 * The fare per cabin at which the cliff starts on this pair, for the fare
 * editor: { economy: 412, businessClass: 1100, … }. Empty in classic worlds.
 */
export function cliffFaresFor(state, origin, destination, opts = {}) {
  if (!(opts.force ?? getNwrYieldChoke())) return {};
  const key = routePairKey(origin, destination);
  const ctx = pairContext(state, key, origin, destination, pairQualities(state));
  const quality = opts.quality ?? ctx.quality;
  const refP = referencePrice(origin, destination);
  const out = {};
  for (const cls of Object.keys(CLASS_FARE_MULTIPLIERS)) {
    out[cls] = Math.floor(refP * CLASS_FARE_MULTIPLIERS[cls] * fareCliffRatio(quality)
      * (cls === 'economy' ? ctx.economyCompression : 1));
  }
  return out;
}

/**
 * cliffFaresFor, for a route that is not open yet — the new-route form's fare
 * editor.
 *
 * The planner used to pass nothing, so its warning fell back to the 1.10x floor
 * — the cliff of a quality-50 route — while the same route, once open, was
 * warned at its real quality (up to 1.25x) on the Routes page. "When creating a
 * new route it says the prices are past the demand cliff at more than 10% above
 * reference, but when you edit an existing route you can raise it by up to 25%"
 * (Dunno23, Discord 2026-10-05). The engine prices the cliff on the pair's pooled
 * offer: the mean routeQualityBreakdown total over every tail on the pair
 * (buildPlayerPairOffer). So this scores the planned route the same way, pooled
 * with the tails already flying the pair, in a state that already contains it.
 *
 * @param {object} planned   { origin, destination, weeklyFrequency, cateringLevel? }
 * @param {object} aircraft  the airframe the forecast runs on ({ typeId, ageWeeks,
 *                           config, ... }). When its id is a tail you own, that
 *                           tail is the one put on the route — it is NOT counted
 *                           twice: a duplicate idle copy halves fleet utilisation,
 *                           lifts on-time and so the quality, and moved the cliff
 *                           ~$10 above the one the Routes page shows after opening.
 * @returns {{ quality:number, fares:object }} fares is {} in classic worlds.
 */
export function plannedCliffFares(state, planned, aircraft, opts = {}) {
  const PLAN_ID = '__planned__';
  const fleet = state?.fleet ?? [];
  const owned = aircraft?.id != null && fleet.some(a => a.id === aircraft.id);
  const acId  = owned ? aircraft.id : PLAN_ID;
  const ac    = { ...aircraft, status: 'assigned', id: acId };
  const route = { id: PLAN_ID, season: null, seasonState: 'active', ...planned, aircraftId: acId };
  const withPlan = {
    ...state,
    routes: [...(state?.routes ?? []), route],
    fleet:  owned ? fleet.map(a => (a.id === acId ? ac : a)) : [...fleet, ac],
  };
  const key = routePairKey(route.origin, route.destination);
  const fleetById = new Map(withPlan.fleet.map(a => [a.id, a]));
  let sum = 0, n = 0;
  for (const r of withPlan.routes) {
    if (isMultiStop(r) || routePairKey(r.origin, r.destination) !== key) continue;
    const a = fleetById.get(r.aircraftId);
    const q = a ? routeQualityBreakdown(r, a, withPlan)?.total : null;
    if (q == null) continue;
    sum += q; n += 1;
  }
  const quality = n > 0 ? Math.round(sum / n) : 50;
  return { quality, fares: cliffFaresFor(state, route.origin, route.destination, { ...opts, quality }) };
}

// Cabins that actually carry seats on at least one aircraft flying the pair —
// an unsold cabin priced high is not a problem worth warning about.
function seatedClassesByPair(state) {
  const fleetById = new Map((state?.fleet ?? []).map(a => [a.id, a]));
  const byKey = new Map();
  for (const r of state?.routes ?? []) {
    const key = routePairKey(r.origin, r.destination);
    const a = fleetById.get(r.aircraftId);
    const cfg = a?.config ?? (a ? { economy: getAircraftType(a.typeId)?.seats ?? 1 } : null);
    const set = byKey.get(key) ?? new Set();
    if (cfg) { for (const [cls, n] of Object.entries(cfg)) if (CLASS_FARE_MULTIPLIERS[cls] && n > 0) set.add(cls); }
    else set.add('economy');
    byKey.set(key, set);
  }
  return byKey;
}

// The distinct single-leg O&D pairs behind a list of route ids — the same
// resolution BULK_ADJUST_PRICING and RESET_ROUTE_PRICING use.
function pairsFor(state, routeIds) {
  const ids = routeIds == null ? null : new Set(routeIds);
  const pairs = new Map();
  for (const r of state?.routes ?? []) {
    if (ids && !ids.has(r.id)) continue;
    const key = routePairKey(r.origin, r.destination);
    if (!pairs.has(key)) pairs.set(key, { key, origin: r.origin, destination: r.destination });
  }
  return [...pairs.values()];
}

/**
 * Exactly what BULK_ADJUST_PRICING would store for one pair.
 * Kept in lock-step with the reducer (asserted by tools/fare-cliff-test.mjs).
 */
export function bulkAdjustedFares(prevFares, origin, destination, pct) {
  const refP = referencePrice(origin, destination);
  const prev = prevFares ?? defaultClassPrices(refP);
  const next = { ...prev };
  for (const [cls, raw] of Object.entries(pct ?? {})) {
    const delta = Number(raw);
    if (isNaN(delta) || delta === 0) continue;
    const base = prev[cls] ?? defaultClassPrices(refP)[cls];
    if (base == null) continue;
    next[cls] = clampClassPrice(Math.round(base * (1 + delta / 100)), refP, cls);
  }
  return next;
}

/**
 * Preview a bulk % change: which pairs end up past the cliff, and how many of
 * them are pushed there by THIS change (vs. already over).
 * @returns {{ pairs: number, over: Array<{key, origin, destination, cabins}>, newlyOver: number }}
 */
export function bulkFareCliffPreview(state, routeIds, pct, opts = {}) {
  const seated = seatedClassesByPair(state);
  const pairs  = pairsFor(state, routeIds);
  const qualities = pairQualities(state);
  const over = [];
  let newlyOver = 0;
  for (const p of pairs) {
    const prev    = state.routePricing?.[p.key];
    const next    = bulkAdjustedFares(prev, p.origin, p.destination, pct);
    const classes = [...(seated.get(p.key) ?? [])];
    const ctx     = { ...pairContext(state, p.key, p.origin, p.destination, qualities), ...opts, classes };
    const cabins  = faresOverCliff(next, p.origin, p.destination, ctx);
    if (cabins.length === 0) continue;
    over.push({ ...p, cabins });
    const before = faresOverCliff(prev ?? referenceFaresFor(p.origin, p.destination), p.origin, p.destination, ctx);
    if (before.length < cabins.length) newlyOver++;
  }
  return { pairs: pairs.length, over, newlyOver };
}

/**
 * Is being past the cliff actually COSTING this pair passengers this week?
 *
 * A cliff cuts demand exponentially, but a route whose demand is many times its
 * seats can lose most of its market and still fill every seat — so "past the
 * cliff" and "losing passengers" are different statements, and only the second
 * is worth a red banner ("all my routes are above the fare cliff but still have
 * a 90%+ projected load", Discord 2026-09-24). Read off the projection:
 *   economy  — the pair's demand no longer covers its seats (capacityCapped false)
 *   premium  — the cabin's own cliffLostPax from the route sim
 * Returns null per cabin when no results are supplied (unknown, not "fine").
 */
function cabinCosting(cls, results) {
  if (!results || results.length === 0) return null;
  if (cls === 'economy') return results.some(r => r && r.capacityCapped === false);
  return results.some(r => (r?.classSummary?.[cls]?.cliffLostPax ?? 0) > 0);
}

/**
 * Every flown pair currently priced past the cliff (seated cabins only).
 * Drives the Routes-page banner that offers the one-click reset.
 *
 * Pass `opts.routeResults` (projectWeek's report.routeResults) to have each
 * cabin — and the pair — marked `costing`: whether the cliff is actually
 * costing it passengers this week. Without them `costing` is null.
 * @returns {Array<{key, origin, destination, cabins, routeIds, costing}>}
 */
export function networkFareCliff(state, opts = {}) {
  const seated = seatedClassesByPair(state);
  const routeIdsByKey = new Map();
  for (const r of state?.routes ?? []) {
    const key = routePairKey(r.origin, r.destination);
    routeIdsByKey.set(key, [...(routeIdsByKey.get(key) ?? []), r.id]);
  }
  const out = [];
  const qualities = pairQualities(state);
  for (const p of pairsFor(state, null)) {
    const fares  = state.routePricing?.[p.key];
    if (!fares) continue;
    const { routeResults, ...cliffOpts } = opts;
    const cabins = faresOverCliff(fares, p.origin, p.destination,
      { ...pairContext(state, p.key, p.origin, p.destination, qualities), ...cliffOpts, classes: [...(seated.get(p.key) ?? [])] });
    if (!cabins.length) continue;
    const routeIds = routeIdsByKey.get(p.key) ?? [];
    const results = routeResults
      ? routeResults.filter(rr => routeIds.includes(rr.routeId))
      : null;
    for (const c of cabins) c.costing = cabinCosting(c.cls, results);
    const costing = results ? cabins.some(c => c.costing) : null;
    out.push({ ...p, cabins, routeIds, costing });
  }
  return out;
}
