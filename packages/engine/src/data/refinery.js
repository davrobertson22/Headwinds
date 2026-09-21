/**
 * refinery.js — buying the refinery (FUEL_OPERATIONS_PLAN.md §9).
 *
 * The endgame tier of the fuel ladder, and the one that is NOT a discount.
 * Delta bought the Trainer refinery in 2012 for ~$150M plus upgrades: it saved
 * on the jet crack spread in good years and lost $100M+ in the years the spread
 * collapsed. That is the model. A refinery here swaps your exposure on a slice
 * of your fuel from the JET index to CRUDE plus a fixed refining cost:
 *
 *   crude          = jetIndex / crackIndex
 *   refinery price = crude + REFINING_COST
 *
 * The crack index is its own seeded mean-reverting walk (μ 1.12, θ 0.03,
 * σ 0.03, clamped [0.95, 1.45]) living beside the jet walk — the jet walk is
 * untouched, so no live world's fuel history is rewritten and nobody who does
 * not own a refinery ever sees crude. At the mean crack of 1.12 the refinery
 * runs ~6.7% under market on the litres it covers; at a crack of 1.00 it runs
 * 4% OVER (you lose), and at 1.45 it runs 27% under. That swing is the whole
 * point: this is a different risk, not less risk.
 *
 * ── Why it does not print money ──────────────────────────────────────────────
 *  • Capacity is fixed in litres at purchase (REFINERY_CAPACITY_SHARE of the
 *    airline's need that week) and never grows, so the share it covers FALLS
 *    as the airline grows.
 *  • Hedges cover only the share the refinery does NOT: you cannot hedge the
 *    crack away, which is exactly the exposure you bought.
 *  • It takes REFINERY_BUILD_WEEKS to commission, costs opex every week
 *    whether the spread is with you or against you, and sells for a fraction.
 *  • Outages happen: a shutdown reverts the covered litres to market for weeks.
 *
 * On a $250M/wk fuel bill, 40% covered at ~6.7% is ~$7M/wk gross — roughly a
 * 10% return on a $2.5B ticket, with real variance. On a $60M/wk bill it is
 * ~$1.6M/wk against $2M/wk of opex, i.e. a loss. It is an endgame purchase for
 * the largest airlines in a world, and it is meant to read that way.
 *
 * Needs station pricing (state.fuelOpsV >= 2) like the farms, because the same
 * price plumbing carries it.
 */

import { FUEL_PRICE_PER_LITRE } from '../utils/fuel.js';

// ── The crack walk ───────────────────────────────────────────────────────────

export const CRACK_BASE_INDEX     = 1.12;   // long-run jet-over-crude spread
export const CRACK_MIN_INDEX      = 0.95;   // spread collapsed — a refinery loses here
export const CRACK_MAX_INDEX      = 1.45;   // spread wide — a refinery prints
export const CRACK_MEAN_REVERSION = 0.03;   // θ: slower than the jet walk; regimes last
// σ: the half-width of the weekly uniform shock. NOT the jet walk's σ — that
// one multiplies by 2.5 and reverts at θ = 0.06. At θ = 0.03 the same shock
// gives a stationary sd of ~0.18, wider than this walk's whole band, so the
// index sat on both clamps and the band's asymmetry (0.17 below the mean,
// 0.33 above) dragged the realised long-run mean to 1.171 instead of 1.12.
// 0.035 gives a stationary sd of ~0.08: the floor is a genuine ~2σ event and
// the mean is the mean.
export const CRACK_VOLATILITY     = 0.035;

/**
 * Advance the crack index by one week. Same Ornstein-Uhlenbeck shape as
 * tickFuelPrice, its own parameters, its own random stream — the jet walk is
 * never touched by this, which is what keeps every existing world's fuel
 * history byte-identical.
 */
export function tickCrackIndex(current, rand = Math.random()) {
  const drift = CRACK_MEAN_REVERSION * (CRACK_BASE_INDEX - current);
  const shock = (rand * 2 - 1) * CRACK_VOLATILITY;
  return clampCrackIndex(current + drift + shock);
}

export function clampCrackIndex(v) {
  return parseFloat(Math.max(CRACK_MIN_INDEX, Math.min(CRACK_MAX_INDEX, v)).toFixed(3));
}

// ── The refinery ─────────────────────────────────────────────────────────────

export const REFINERY_CAPEX           = 2_500_000_000;
export const REFINERY_BUILD_WEEKS     = 52;      // a year to commission
export const REFINERY_WEEKLY_OPEX     = 2_000_000;
export const REFINERY_SALE_FRACTION   = 0.40;    // what you get back if you sell
export const REFINING_COST            = 0.04;    // added to crude, in index points
export const REFINERY_CAPACITY_SHARE  = 0.40;    // of the airline's need AT PURCHASE
// The desk won't sell one to an airline it cannot pay for itself. At the
// long-run crack a refinery saves bill × REFINERY_CAPACITY_SHARE × ~6.7%, so
// it only clears REFINERY_WEEKLY_OPEX above a bill of about $75M/wk — and a
// gate at the break-even point would be selling a coin toss. $150M/wk puts it
// where the plan says it belongs: the two or three largest airlines in a
// world, clearing ~$2M/wk net in a good crack year and losing in a bad one.
export const REFINERY_MIN_WEEKLY_BILL = 150_000_000;
export const REFINERY_OUTAGE_PROB     = 0.010;   // per week once online (~once every 2 years)
export const REFINERY_OUTAGE_WEEKS    = [3, 6];

/**
 * The airline's weekly fuel VOLUME, in litres, estimated from the last week it
 * flew. `totalFuel` is litres × base price × the blended price multiplier ×
 * the per-route station factors, so dividing the multiplier and the base price
 * back out leaves litres (carrying a station-weighted bias of a few percent,
 * which cancels: capacity is measured the same way at purchase, so the SHARE
 * this returns is self-consistent).
 */
export function weeklyLitresOf(state) {
  const rep = state?.lastReport;
  const bill = Number(rep?.totalFuel) || 0;
  const mult = Number(rep?.fuelMultiplier) || 0;
  if (!(bill > 0) || !(mult > 0)) return 0;
  return (bill / mult) / FUEL_PRICE_PER_LITRE;
}

/** What that volume costs at a 1.0× market — the yardstick the desk sells against. */
export function weeklyBaseBillOf(state) {
  return Math.round(weeklyLitresOf(state) * FUEL_PRICE_PER_LITRE);
}

export function isCommissioned(refinery, absWeek) {
  return !!refinery && (absWeek ?? 0) >= (refinery.onlineAbsWeek ?? Infinity);
}

export function weeksToOnline(refinery, absWeek) {
  if (!refinery) return null;
  return Math.max(0, (refinery.onlineAbsWeek ?? 0) - (absWeek ?? 0));
}

export function isOnOutage(refinery, absWeek) {
  return !!refinery && (refinery.outageUntilAbsWeek ?? 0) > (absWeek ?? 0);
}

/** The price index the refinery charges on the litres it covers. */
export function refineryPriceIndex(jetIndex, crackIndex) {
  const crack = Number(crackIndex) > 0 ? Number(crackIndex) : CRACK_BASE_INDEX;
  return parseFloat(((Number(jetIndex) || 1) / crack + REFINING_COST).toFixed(4));
}

/**
 * What the refinery is doing for the airline this week.
 *
 *   share  the fraction of this week's litres it covers (0 while building,
 *          on outage, or with nothing flown yet)
 *   price  the index those litres are charged at
 *   edge   market − refinery price, in index points: positive = the spread is
 *          with you this week
 *
 * @returns {{ owned, online, building, outage, weeksLeft, share, price, edge, capacityLitres, needLitres }}
 */
export function refineryStatus(state, { absWeek, jetIndex, crackIndex }) {
  const r = state?.refinery ?? null;
  const base = {
    owned: !!r, online: false, building: false, outage: false, weeksLeft: null,
    share: 0, price: null, edge: 0,
    capacityLitres: r?.capacityLitres ?? 0, needLitres: 0,
  };
  if (!r) return base;
  const need = weeklyLitresOf(state);
  const building = !isCommissioned(r, absWeek);
  const outage   = isOnOutage(r, absWeek);
  const online   = !building && !outage;
  const share    = online && need > 0 ? Math.min(1, (r.capacityLitres ?? 0) / need) : 0;
  const price    = refineryPriceIndex(jetIndex, crackIndex);
  return {
    ...base,
    online, building, outage,
    weeksLeft: building ? weeksToOnline(r, absWeek) : (outage ? (r.outageUntilAbsWeek - absWeek) : null),
    share: parseFloat(share.toFixed(4)),
    price,
    edge: parseFloat(((Number(jetIndex) || 1) - price).toFixed(4)),
    needLitres: Math.round(need),
  };
}

/**
 * Whether the airline can order a refinery, and what it would cost. Mirrors
 * what BUY_REFINERY checks, so the button says what the reducer does.
 */
export function canBuyRefinery(state) {
  const reasons = [];
  const capex = REFINERY_CAPEX;
  const bill  = weeklyBaseBillOf(state);
  if ((Number(state?.fuelOpsV) || 0) < 2) reasons.push('Station fuel pricing is not on in this world.');
  if (state?.refinery) reasons.push('You already own a refinery — one per airline.');
  if (bill < REFINERY_MIN_WEEKLY_BILL) {
    reasons.push(`A refinery is only sold to airlines burning $${Math.round(REFINERY_MIN_WEEKLY_BILL / 1e6)}M+ of fuel a week — below that its ${Math.round(REFINERY_WEEKLY_OPEX / 1e6)}M/wk of running costs eat the spread. You burn $${Math.round(bill / 1e6)}M.`);
  }
  if ((Number(state?.cash) || 0) < capex) reasons.push(`Not enough cash — a refinery costs ${Math.round(capex / 1e9 * 10) / 10}B.`);
  return {
    ok: reasons.length === 0, reasons, capex,
    weeklyBill: bill,
    capacityLitres: Math.round(weeklyLitresOf(state) * REFINERY_CAPACITY_SHARE),
  };
}

export function makeRefinery(absWeek, capacityLitres) {
  return {
    orderedAbsWeek: absWeek,
    onlineAbsWeek:  absWeek + REFINERY_BUILD_WEEKS,
    capacityLitres: Math.max(0, Math.round(capacityLitres)),
    capex:          REFINERY_CAPEX,
  };
}

export function refinerySaleValue(refinery) {
  return Math.round((refinery?.capex ?? REFINERY_CAPEX) * REFINERY_SALE_FRACTION);
}

/** Weekly opex — charged from the day it is ordered, outage or not. */
export function refineryWeeklyOpex(state) {
  return state?.refinery ? REFINERY_WEEKLY_OPEX : 0;
}

/**
 * Roll for an unplanned shutdown. Only called when a refinery is online, so a
 * save without one draws no random number and the RNG stream — and the golden
 * master — is untouched.
 *
 * @returns {number} weeks of outage (0 = none)
 */
export function rollRefineryOutage(rand = Math.random(), durRand = Math.random()) {
  if (rand > REFINERY_OUTAGE_PROB) return 0;
  const [lo, hi] = REFINERY_OUTAGE_WEEKS;
  return lo + Math.floor(durRand * (hi - lo + 1));
}

/** What the refinery made or lost this week, in dollars, from a tick report. */
export function refinerySavingsFromReport(report) {
  const share = Number(report?.refineryShare) || 0;
  const edge  = Number(report?.refineryEdge);
  const mult  = Number(report?.fuelMultiplier) || 0;
  if (!(share > 0) || !Number.isFinite(edge) || !(mult > 0)) return 0;
  // The covered litres at 1.0×, times the index points the refinery beat the
  // market by. Positive = the spread paid this week.
  const baseBill = (Number(report?.totalFuel) || 0) / mult;
  return Math.round(baseBill * share * edge);
}
