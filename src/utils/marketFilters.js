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
//   * your families     — aircraftFamily(), the grouping the MRO base cost
//     and the fleet-complexity surcharge charge by. Discord, 2026-10-21
//     (VodkaOnFire): "Add 'Owned by you' filter to airliner market — easier
//     than to scroll through everything when looking to order more of your
//     aircraft families." Family rather than exact type, because that is how
//     he put it and how the game charges it. Ported from Tailwinds.
//   * max age           — Headwinds only. Discord, 2026-10-21 (VodkaOnFire):
//     "Add slider/box/similar to filter out aircraft older than X years in
//     market." The age the market already shows: on the new-aircraft list the
//     Age column, how old the airframe is on delivery (deliveredAgeYears —
//     out-of-production types arrive second-hand, everything else new); on the
//     Used Market the airframe's own age (usedListingPasses).
//
// Pure (no React, no state) so the rules can be tested without a renderer.

import { designAgeQualityPts } from '../models/demand.js';
import { aircraftFamily } from '../data/families.js';
import { eraDeliveredAgeWeeks } from '../data/aircraft.js';

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
  yourFamilies: false,   // show only families you fly or have on order
  maxAge:       null,    // hide aircraft that arrive older than this many years (null = any)
});

/** A type's family key — the type itself for the (invariant-violating) unmapped one. */
function familyKeyOf(typeId) {
  return aircraftFamily(typeId) ?? `type:${typeId}`;
}

/**
 * The families your airline flies or has on order, as a Set of family keys.
 * Retired tails do not count; aircraft still on order do — "order more of your
 * aircraft families" includes the ones you have just started.
 */
export function ownedFamilyIds(fleet = [], pendingOrders = []) {
  const s = new Set();
  for (const a of fleet ?? []) if (a?.typeId && a.status !== 'retired') s.add(familyKeyOf(a.typeId));
  for (const o of pendingOrders ?? []) if (o?.typeId) s.add(familyKeyOf(o.typeId));
  return s;
}

/** Is `type` in one of the families in `owned` (a Set from ownedFamilyIds)? */
export function isInYourFamilies(type, owned) {
  return !!type && !!owned && owned.has(familyKeyOf(type.id));
}

/**
 * Whole years old a frame of this type arrives at — the market's Age column, the
 * age the reducer stamps on delivery (eraDeliveredAgeWeeks). 0 while the type
 * is in production; an out-of-production type arrives second-hand.
 */
export function deliveredAgeYears(type, calYear = null) {
  return Math.round(eraDeliveredAgeWeeks(type, calYear) / 52);
}

/** A whole number of years ≥ 0, or null for "no limit" (blank, junk, negative). */
export function normalizeMaxAge(v) {
  if (v === '' || v == null) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Does a Used Market listing survive its filters? `ageWeeks` is the airframe's
 * own age; `typeId` resolves its family.
 */
export function usedListingPasses(listing, { maxAge = null, yourFamilies = false } = {}, ownedFamilies = null) {
  const max = normalizeMaxAge(maxAge);
  if (max != null && (listing?.ageWeeks ?? 0) / 52 > max) return false;
  if (yourFamilies && ownedFamilies?.size > 0 && !ownedFamilies.has(familyKeyOf(listing?.typeId))) return false;
  return true;
}

/**
 * Does `type` survive the active "show only" filters?
 * @param {(type) => string|null} [leaseBlockReason] why the TYPE can't be leased, or null
 */
export function passesMarketFilters(type, calYear, filters = DEFAULT_MARKET_FILTERS, leaseBlockReason = () => null, { ownedFamilies = null } = {}) {
  // An airline with nothing yet has no families to narrow to — the chip is not
  // offered then, and a remembered "on" must not empty the market.
  if (filters.yourFamilies && ownedFamilies?.size > 0 && !isInYourFamilies(type, ownedFamilies)) return false;
  const maxAge = normalizeMaxAge(filters.maxAge);
  if (maxAge != null && deliveredAgeYears(type, calYear) > maxAge) return false;
  if (filters.inProduction && isOutOfProduction(type, calYear)) return false;
  if (filters.hideDated && isDatedDesign(type, calYear)) return false;
  if (filters.leasable && leaseBlockReason(type)) return false;
  return true;
}
