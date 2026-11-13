// ─────────────────────────────────────────────────────────────────────────────
// PAIR MATURITY ACROSS AN AIRCRAFT SWAP
//
// A route ramps up over its first 16 weeks (routeMaturityFactor: 55% of the
// market at launch, 100% from week 16), and a pair flown by several tails ramps
// with the OLDEST of them: the tick takes the max weeksOpen across the pair's
// open routes, and so does pairShare. ADD_ROUTE used to start every new route
// at week 0. So swapping the aircraft on a route by hand — open the pair on the
// new tail, close the old one, in either order — left only the week-0 route,
// and the whole market dropped to 55% the next week: "it counts the route as
// closed and reopened" (Kat the Fox, Discord, 2026-11-12). Only REASSIGN_ROUTE,
// which keeps the route itself, got it right.
//
// Two rules, one helper (inheritedWeeksOpen), used by ADD_ROUTE,
// ADD_CARGO_ROUTE and the planners' launch figures, so preview and tick agree:
//
//   1. A route opened on a pair the airline already flies starts at the pair's
//      maturity. Travellers already know the service; another tail on it is not
//      a launch. (The Route Planner already previewed it this way.)
//   2. A pair the airline stopped flying is remembered for a few weeks, so
//      closing first and reopening a moment later is the same swap. The memory
//      is capped at the ramp length and fades two weeks of maturity per week
//      off the pair: a mature pair is forgotten after 8 weeks. That keeps a
//      genuine relaunch a relaunch.
//
// STATE. `closedPairMaturity: { 'pax:JFK-LHR' | 'cargo:…': { weeksOpen, absWeek } }`
// on the airline. Written only by rememberClosedPairs (rootReducer, after any
// action that leaves a pair unserved — a close, a sale, a lease running out),
// cleared when the pair is served again or the memory has faded. Absent on any
// airline that has never left a pair, so such a state is byte-for-byte as
// before (golden masters PARITY OK).
// ─────────────────────────────────────────────────────────────────────────────

import { routePairKey, isMultiStop } from '../utils/simulation.js';
import { absoluteWeek } from '../utils/fuel.js';

export const PAIR_MEMORY_RAMP_WEEKS    = 16;   // routeMaturityFactor reaches 1.0 here
export const PAIR_MEMORY_FADE_PER_WEEK = 2;    // weeks of maturity lost per week off the pair

const listOf = (state, kind) => (kind === 'cargo' ? state?.cargoRoutes : state?.routes) ?? [];
const memoKey = (kind, pairKey) => `${kind}:${pairKey}`;
const nowAbs = (state) => absoluteWeek(state?.year ?? 1, state?.week ?? 1);

// Single-leg routes only: a tag route sells its O&D through its own segments
// and never joins the pair's offer (pairShare's filter), so it neither lends
// nor inherits a pair's maturity here.
const pairOf = (r) => (isMultiStop(r) ? null : routePairKey(r.origin, r.destination));

/** What a remembered pair is worth now, in weeks of maturity (0 = forgotten). */
export function rememberedWeeks(entry, absWeek) {
  if (!entry) return 0;
  const off = Math.max(0, absWeek - (entry.absWeek ?? absWeek));
  return Math.max(0, Math.min(PAIR_MEMORY_RAMP_WEEKS, entry.weeksOpen ?? 0) - PAIR_MEMORY_FADE_PER_WEEK * off);
}

/**
 * The weeksOpen a route opened now on origin–destination should start at:
 * the oldest of the airline's open routes on the pair, else what a recently
 * closed pair still remembers, else 0.
 *
 * @param {object} state
 * @param {string} origin
 * @param {string} destination
 * @param {{ kind?: 'pax'|'cargo', excludeRouteId?: string|null }} [opts]
 */
export function inheritedWeeksOpen(state, origin, destination, { kind = 'pax', excludeRouteId = null } = {}) {
  const key = routePairKey(origin, destination);
  let open = -1;
  for (const r of listOf(state, kind)) {
    if (r.id === excludeRouteId || pairOf(r) !== key) continue;
    open = Math.max(open, r.weeksOpen ?? 0);
  }
  if (open >= 0) return open;
  return rememberedWeeks(state?.closedPairMaturity?.[memoKey(kind, key)], nowAbs(state));
}

function oldestByPair(list) {
  const m = new Map();
  for (const r of list) {
    const k = pairOf(r);
    if (k) m.set(k, Math.max(m.get(k) ?? 0, r.weeksOpen ?? 0));
  }
  return m;
}

/**
 * After an action: remember every pair `prev` flew that `next` no longer does,
 * forget pairs flown again, drop memories that have faded. Returns `next`
 * itself when nothing changes, so the reducer's identity contract holds.
 */
export function rememberClosedPairs(prev, next) {
  if (!prev || !next || prev === next) return next;
  if (prev.routes === next.routes && prev.cargoRoutes === next.cargoRoutes) return next;
  const had = prev.closedPairMaturity ?? null;
  const absWeek = nowAbs(next);
  let memo = null;
  const edit = () => (memo ??= { ...(had ?? {}) });

  for (const kind of ['pax', 'cargo']) {
    if (listOf(prev, kind) === listOf(next, kind)) continue;
    const before = oldestByPair(listOf(prev, kind));
    const after  = oldestByPair(listOf(next, kind));
    for (const [pairKey, weeksOpen] of before) {
      if (!after.has(pairKey)) edit()[memoKey(kind, pairKey)] = { weeksOpen: Math.min(PAIR_MEMORY_RAMP_WEEKS, weeksOpen), absWeek };
    }
    if (had) {
      for (const pairKey of after.keys()) {
        if (memoKey(kind, pairKey) in (memo ?? had)) delete edit()[memoKey(kind, pairKey)];
      }
    }
  }
  if (had) {
    for (const [k, e] of Object.entries(memo ?? had)) {
      if (rememberedWeeks(e, absWeek) <= 0) delete edit()[k];
    }
  }
  if (!memo) return next;
  if (Object.keys(memo).length === 0) {
    const { closedPairMaturity: _gone, ...rest } = next;
    return rest;
  }
  return { ...next, closedPairMaturity: memo };
}
