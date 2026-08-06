/**
 * reserve.js — Reserve aircraft (hub-based standby covers).
 *
 * A player can STATION an idle aircraft as a reserve at one of their hubs or
 * focus cities. When another aircraft of the SAME TYPE goes out of service
 * (mechanical grounding or a C/D check), the weekly tick automatically
 * dispatches the reserve onto that aircraft's routes — but only routes that
 * touch the reserve's base airport — and hands them back when the original
 * returns to service.
 *
 * Design doc: docs/reserve-aircraft-design.md. Key agreed rules:
 *   - Identical-type coverage only (a 737 cannot cover an A320).
 *   - Hub-based: a reserve covers only routes touching its base airport.
 *   - Standing by costs money: a line-maintenance readiness premium plus a
 *     weekly hub parking fee (suspended in weeks the reserve is out covering).
 *   - Strikes are NOT covered (crew problem, not an airframe problem).
 *
 * Every value here is a tuning constant — this is the single place to
 * rebalance the system. All functions are PURE (no Date.now / Math.random)
 * so the reducer and the multiplayer tick stay deterministic and replayable.
 */

import { LANDING_FEE_PER_DEPARTURE } from './overhead.js';

// ─── Standby costs (agreed with Dave 2026-07-27) ─────────────────────────────
/** Line-maintenance surcharge while stationed (crew on standby, systems warm). */
export const RESERVE_READINESS_MULT = 1.15;

/**
 * Weekly hub parking fee multiplier: fee = per-departure landing fee for the
 * aircraft's category at the base airport's tier × this. Scales with both
 * aircraft size and airport size for free. Suspended while out covering.
 */
export const RESERVE_PARKING_FEE_MULT = 3;

// ─── Dispatch rules ───────────────────────────────────────────────────────────
/** Don't dispatch a reserve whose own booked check starts within this window. */
export const RESERVE_NO_DISPATCH_IF_CHECK_WITHIN_WEEKS = 2;

/**
 * Match rule for covers. 'type' (v1, agreed): the reserve must share typeId
 * with the broken aircraft. 'family' is the designed pressure valve if strict
 * typing proves too expensive for mixed fleets — see design doc §11.
 */
export const RESERVE_MATCH = 'type';

/** Fallback per-departure fee when a category/tier is missing from the table. */
const PARKING_FEE_DEFAULT = 1_400;

/**
 * Weekly parking fee ($) for a stationed reserve.
 * @param {string} feeCategory - landing-fee category ('Narrow Body', ... —
 *   freighters pass their freighterLandingCategory equivalent).
 * @param {string} airportTier - 'mega' | 'major' | 'regional'
 */
export function reserveParkingFee(feeCategory, airportTier) {
  const perDeparture = LANDING_FEE_PER_DEPARTURE[feeCategory]?.[airportTier] ?? PARKING_FEE_DEFAULT;
  return Math.round(perDeparture * RESERVE_PARKING_FEE_MULT);
}

/** True if this aircraft is currently stationed as a reserve. */
export function isReserve(a) {
  return !!a?.reserveBase && a?.status !== 'retired';
}

/** True if this route record is currently a temporary cover for another tail. */
export function isCoverRoute(r) {
  return !!r?.coverForAircraftId;
}

/**
 * What a stationed reserve is currently standing by to cover.
 *
 * Deploying a reserve onto a route is allowed — the reducer just nulls
 * `reserveBase` — but from the player's side that is an invisible trade: the
 * plane starts earning, and the cover it was holding quietly disappears. The
 * route pickers use this to spell out what is being given up ("stops covering
 * your 3 other A320s at DFW") instead of only saying the standby ends.
 *
 * Same rules as the tick's dispatcher: identical type only, and only routes
 * that touch the reserve's own base.
 *
 * @param {object} aircraft - candidate tail (returns null unless it is a reserve)
 * @param {array}  fleet    - state.fleet
 * @param {array}  ops      - passenger + cargo routes
 * @returns {{ base: string, tails: number, routes: number } | null}
 */
export function reserveCoverageSummary(aircraft, fleet = [], ops = []) {
  if (!isReserve(aircraft)) return null;
  const base = aircraft.reserveBase;
  const sameType = new Set((fleet ?? [])
    .filter(a => a.id !== aircraft.id && a.typeId === aircraft.typeId && a.status !== 'retired')
    .map(a => a.id));
  const tails = new Set();
  let routes = 0;
  for (const r of (ops ?? [])) {
    // A route currently flown as a cover still belongs to the tail it covers for.
    const owner = r.coverForAircraftId ?? r.aircraftId;
    if (!sameType.has(owner)) continue;
    if (r.origin === base || r.destination === base || (r.stops ?? []).includes(base)) {
      routes++;
      tails.add(owner);
    }
  }
  return { base, tails: tails.size, routes };
}
