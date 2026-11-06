// Freight mass pricing — many cargo routes repriced in one write.
//
// The passenger page has had bulk pricing for months (BULK_ADJUST_PRICING,
// RESET_ROUTE_PRICING); freight had a $0.02 stepper per freighter and nothing
// else ("Most importantly mass pricing", Barca, Discord 2026-11-05). A fuel
// spike on a sixty-lane freight network meant sixty rows opened one by one.
//
// One rule, used twice: the Freight selection bar and the Bulk Pricing modal
// preview with planCargoYields, and the BULK_SET_CARGO_YIELD reducer case
// stores exactly what it returns — so the line that says "12 routes, $0.412 to
// $0.455" is the line the engine writes.
//
// Yield is per freighter (each one prices ITS slice of the lane's pool), so the
// unit here is the route id, not the city pair the passenger actions resolve to.
// One action rather than an UPDATE_CARGO_YIELD per route: in multiplayer each
// dispatch is a separate, version-checked server write, and the lane +/- used
// to send one per freighter.

import { cargoReferenceYield } from '../utils/market.js';

// pct: +/- a percentage · delta: +/- $/t-km (the lane stepper's $0.02)
// reference: each lane's going rate · set: one rate for all (Align).
export const CARGO_BULK_YIELD_MODES = ['pct', 'delta', 'reference', 'set'];

// The most routes one BULK_SET_CARGO_YIELD carries; the server guard refuses
// more. Matches BULK_FREQUENCY_BATCH, and the UI splits a bigger selection.
export const CARGO_BULK_YIELD_BATCH = 500;

// Same floor UPDATE_CARGO_YIELD stores; the ceiling is the server guard's.
export const CARGO_YIELD_MIN = 0.01;
export const CARGO_YIELD_MAX = 1_000;
// A % move is clamped to this band: -90% keeps every rate positive and
// meaningful, +300% is past where cargo demand reaches zero (3x reference).
export const CARGO_BULK_PCT_MIN = -90;
export const CARGO_BULK_PCT_MAX = 300;
// A $/t-km step is clamped to this (reference yields sit well under $2).
export const CARGO_BULK_DELTA_MAX = 10;

const round3 = (y) => Math.round(y * 1000) / 1000;
const clampYield = (y) => Math.min(CARGO_YIELD_MAX, Math.max(CARGO_YIELD_MIN, round3(y)));

/** Normalise a { mode, value } change; null when it cannot change anything. */
export function normaliseCargoYieldChange({ mode, value } = {}) {
  const m = CARGO_BULK_YIELD_MODES.includes(mode) ? mode : null;
  if (!m) return null;
  if (m === 'reference') return { mode: m, value: 0 };
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (m === 'pct') {
    const pct = Math.max(CARGO_BULK_PCT_MIN, Math.min(CARGO_BULK_PCT_MAX, n));
    return pct === 0 ? null : { mode: m, value: pct };
  }
  if (m === 'delta') {
    const d = round3(Math.max(-CARGO_BULK_DELTA_MAX, Math.min(CARGO_BULK_DELTA_MAX, n)));
    return d === 0 ? null : { mode: m, value: d };
  }
  if (n <= 0) return null;
  return { mode: m, value: clampYield(n) };
}

/** The yield one route ends at under a change (unclamped input, clamped output). */
export function nextCargoYield(route, change) {
  const c = normaliseCargoYieldChange(change);
  const cur = Number(route?.yieldPrice) || CARGO_YIELD_MIN;
  if (!c) return cur;
  if (c.mode === 'reference') return clampYield(cargoReferenceYield(route.origin, route.destination));
  if (c.mode === 'set') return c.value;
  if (c.mode === 'delta') return clampYield(cur + c.value);
  return clampYield(cur * (1 + c.value / 100));
}

/**
 * Plan a bulk yield change over the player's own cargo routes.
 *
 * @param {object}   state     game state (reads state.cargoRoutes)
 * @param {string[]} routeIds  any ids; unknown and duplicate ones are dropped
 * @param {object}   change    { mode: 'pct' | 'delta' | 'reference' | 'set', value }
 * @returns {{ yields: Map<string, number>, rows: Array<{ route, from, to, ref }>,
 *             changed: number, considered: number }}
 *   `yields` holds only routes whose yield actually moves; `rows` every route
 *   considered, for a preview that names the range.
 */
export function planCargoYields(state, routeIds, change) {
  const want = new Set((routeIds ?? []).map(String));
  const c = normaliseCargoYieldChange(change);
  const yields = new Map();
  const rows = [];
  for (const route of state?.cargoRoutes ?? []) {
    if (!want.has(route.id)) continue;
    const from = Number(route.yieldPrice) || CARGO_YIELD_MIN;
    const to = c ? nextCargoYield(route, c) : from;
    const ref = cargoReferenceYield(route.origin, route.destination);
    rows.push({ route, from, to, ref });
    if (Math.abs(to - from) >= 0.0005) yields.set(route.id, to);
  }
  return { yields, rows, changed: yields.size, considered: rows.length };
}

/** The state BULK_SET_CARGO_YIELD stores (same object back when nothing moves). */
export function applyCargoYields(state, routeIds, change) {
  const { yields } = planCargoYields(state, routeIds, change);
  if (yields.size === 0) return state;
  return {
    ...state,
    cargoRoutes: state.cargoRoutes.map(r => (yields.has(r.id) ? { ...r, yieldPrice: yields.get(r.id) } : r)),
  };
}

/** The selection split into CARGO_BULK_YIELD_BATCH-sized id lists. */
export function cargoYieldBatches(routeIds, size = CARGO_BULK_YIELD_BATCH) {
  const ids = [...new Set((routeIds ?? []).map(String))];
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
