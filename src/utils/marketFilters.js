// Fleet → Market "Show only" filters (ported from Tailwinds).
//
// Discord, 2026-10-12 (VodkaOnFire): "in fleet -> market, I'd like to be able
// to filter out any aircraft that are no longer in production and/or
// separately any aircraft that is now aging. The list gets a bit wild when you
// get 20 years in to a save. ... some people might appreciate being able to
// filter based on whether aircraft can be leased or not?"
//
// Every filter asks a question the market already answers elsewhere, through
// the same function, so a chip can never disagree with the card it hides:
//
//   * out of production — the line-closed year (`oop`) that makes a type
//     arrive second-hand (aircraftAvailability 'used').
//   * dated design      — designAgeQualityPts() < 0, the score behind the
//     "Dated design" badge and the quality penalty. Era worlds only.
//   * leasable          — the caller's own lease-block check for the TYPE
//     (Marketplace's typeLeaseBlockReason: era lock, vintage, and the NWR
//     lessor rules). The per-airline lease order-book cap is deliberately left
//     out: a full order book would otherwise hide every aircraft in the game.
//
// Pure (no React, no state) so the rules can be tested without a renderer.

import { designAgeQualityPts } from '../models/demand.js';

// Classic worlds are frozen at 2026 (see isVintage in data/aircraft.js).
const CLASSIC_YEAR = 2026;

/** The production line has closed: any frame bought now is second-hand. */
export function isOutOfProduction(type, calYear) {
  const year = calYear ?? CLASSIC_YEAR;
  return type?.oop != null && year > type.oop;
}

/** Passengers already mark this design down (era worlds only — classic never dates). */
export function isDatedDesign(type, calYear) {
  if (calYear == null) return false;
  return designAgeQualityPts(type, calYear) < 0;
}

export const DEFAULT_MARKET_FILTERS = Object.freeze({
  inProduction: false,   // hide types whose line has closed
  hideDated:    false,   // hide designs passengers already mark down (era only)
  leasable:     false,   // hide types no lessor will lease you
});

/**
 * Does `type` survive the active "show only" filters?
 * @param {(type) => string|null} [leaseBlockReason] why the TYPE can't be leased, or null
 */
export function passesMarketFilters(type, calYear, filters = DEFAULT_MARKET_FILTERS, leaseBlockReason = () => null) {
  if (filters.inProduction && isOutOfProduction(type, calYear)) return false;
  if (filters.hideDated && isDatedDesign(type, calYear)) return false;
  if (filters.leasable && leaseBlockReason(type)) return false;
  return true;
}
