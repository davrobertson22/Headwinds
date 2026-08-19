/**
 * Buying a leased aircraft out of its lease.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * The price used to be a standalone helper in data/aircraft.js that computed
 * its own net asset value:
 *
 *     const remaining = Math.max(0.1, 1 - ageYears / depreciationYears);
 *     const nav       = Math.round(type.purchasePrice * remaining);
 *
 * Every OTHER valuation in the engine — SELL_AIRCRAFT, the AOG write-off,
 * loan collateral, the used-aircraft market — goes through valueRemaining()
 * or airframeNAV(), which normalize for `type.deliveredAgeWeeks`. 109 types in
 * the table arrive already used (the An-225 at 10 years, the DC-10-30 at 16);
 * their purchase price IS a used price, so discounting it again by total
 * airframe age charges the discount twice. airframeNAV states the rule in its
 * own docstring — "Mirrors the SELL_AIRCRAFT valuation exactly ... so a
 * write-off can never be worth more than a sale" — and the buyout was the one
 * valuation site in the engine that did not mirror it.
 *
 * The result was two prices for one airframe, and the cheap one was the one
 * the player bought at. Lease → buy out → sell in the same week netted up to
 * $36.8M on an An-225, and 108 of 164 leasable types turned a profit. In
 * multiplayer the loop runs through ORDER_AIRCRAFT → BUY_OUT_LEASE →
 * SELL_AIRCRAFT, all three of which are on ALLOWED_PLAYER_ACTIONS.
 *
 * So the quote lives here, next to pairShare.js, for the same reason that one
 * does: three callers (the reducer, the Fleet detail panel, the lease-expiry
 * prompt) need the same answer, and three hand-rolled copies of "what is this
 * jet worth" is exactly how the engine got into this state. Both the price the
 * dialog quotes and the price the reducer charges come from this function, so
 * they cannot drift apart.
 *
 * ── What the player pays ────────────────────────────────────────────────────
 *
 *     price = NAV + premium − deposit already on file
 *
 * NAV is airframeNAV — straight-line depreciation on total airframe age,
 * normalized for the age it was delivered at, floored at 10%, times the
 * maintenance modifier. A jet with a check overdue is worth less, and is
 * correspondingly cheaper to buy out; a jet fresh out of a D check is worth
 * more and costs more. That is the same number SELL_AIRCRAFT pays out on.
 *
 * The premium is what makes an early buyout an early buyout: the lessor loses
 * the rest of the rent stream and prices the option accordingly. It is also
 * what guarantees the round trip is a loss — buy out at 1.10 × NAV, sell at
 * 0.95 × NAV, and you are down 15% of the airframe for the privilege.
 *
 * The deposit is credited in full and is NOT a discount: it is the player's own
 * money, already handed to the lessor at order time and refundable either way
 * (see tools/lease-deposit-test.mjs). It cancels out across the round trip,
 * which is why the no-profit invariant is asserted on net cash across the whole
 * trip rather than on the quoted price.
 */

import { getAircraftType, LEASE_BUYOUT_PREMIUM, LEASE_DEPOSIT_WEEKS } from '../data/aircraft.js';
import { airframeNAV } from '../data/maintenance.js';
import { absoluteWeek } from '../utils/fuel.js';

/**
 * Full breakdown of a buyout, so the confirm dialog can show its working.
 *
 * Takes `state` rather than a bare absolute week because the maintenance
 * modifier needs one and an omitted week silently values every airframe as if
 * its checks were current — a preview that disagrees with the tick, which is
 * the bug class this module exists to end.
 *
 * Returns { nav, premium, depositCredit, price }. `price` is what the reducer
 * charges and what the dialog must quote.
 */
export function leaseBuyoutQuote(state, aircraft) {
  const type    = getAircraftType(aircraft?.typeId);
  const absWeek = absoluteWeek(state?.year ?? 1, state?.week ?? 1);
  const nav     = airframeNAV(aircraft, type, absWeek);
  const premium = Math.round(nav * LEASE_BUYOUT_PREMIUM);
  // An absent leaseDeposit means an old save from before deposits existed, not
  // a tail that paid nothing — the instant-lease path writes an explicit 0.
  const depositCredit = aircraft?.leaseDeposit
    ?? Math.round((aircraft?.weeklyLease ?? type?.weeklyLease ?? 0) * LEASE_DEPOSIT_WEEKS);
  return {
    nav,
    premium,
    depositCredit,
    price: Math.max(0, nav + premium - depositCredit),
  };
}

/** The number the player pays. */
export function leaseBuyoutPrice(state, aircraft) {
  return leaseBuyoutQuote(state, aircraft).price;
}
