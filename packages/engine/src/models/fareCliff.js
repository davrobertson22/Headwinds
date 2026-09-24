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
} from '../utils/simulation.js';
import { getAircraftType } from '../data/aircraft.js';

/** True when the world has a fare cliff at all (restricted worlds). */
export function fareCliffActive() { return getNwrYieldChoke(); }

/**
 * The price/reference ratio where demand starts collapsing. Warnings use the
 * quality-50 floor (1.10x): a premium product earns headroom to 1.25x, but a
 * warning that fires a little early is cheap and one that fires late is not.
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
    if (ratio > thr + 1e-9) out.push({ cls, ratio, fare, ref: Math.round(ref) });
  }
  return out;
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
  const over = [];
  let newlyOver = 0;
  for (const p of pairs) {
    const prev    = state.routePricing?.[p.key];
    const next    = bulkAdjustedFares(prev, p.origin, p.destination, pct);
    const classes = [...(seated.get(p.key) ?? [])];
    const cabins  = faresOverCliff(next, p.origin, p.destination, { ...opts, classes });
    if (cabins.length === 0) continue;
    over.push({ ...p, cabins });
    const before = faresOverCliff(prev ?? referenceFaresFor(p.origin, p.destination), p.origin, p.destination, { ...opts, classes });
    if (before.length < cabins.length) newlyOver++;
  }
  return { pairs: pairs.length, over, newlyOver };
}

/**
 * Every flown pair currently priced past the cliff (seated cabins only).
 * Drives the Routes-page banner that offers the one-click reset.
 * @returns {Array<{key, origin, destination, cabins, routeIds}>}
 */
export function networkFareCliff(state, opts = {}) {
  const seated = seatedClassesByPair(state);
  const routeIdsByKey = new Map();
  for (const r of state?.routes ?? []) {
    const key = routePairKey(r.origin, r.destination);
    routeIdsByKey.set(key, [...(routeIdsByKey.get(key) ?? []), r.id]);
  }
  const out = [];
  for (const p of pairsFor(state, null)) {
    const fares  = state.routePricing?.[p.key];
    if (!fares) continue;
    const cabins = faresOverCliff(fares, p.origin, p.destination, { ...opts, classes: [...(seated.get(p.key) ?? [])] });
    if (cabins.length) out.push({ ...p, cabins, routeIds: routeIdsByKey.get(p.key) ?? [] });
  }
  return out;
}
