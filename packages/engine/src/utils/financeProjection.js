// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the Finance page projections.
//
// Every Finance tab (P&L, Cash Flow, Unit Economics, Forecast, Loans, Balance
// Sheet) must show the SAME numbers for "this week". Previously each tab
// re-derived revenue and net income independently — with different multiplier
// treatment — so the same week could show four different revenue figures and
// four different "net income" figures.
//
// projectWeek(state) calls the real engine (weeklyTick) and then replays the
// exact loan / tax / event finalisation the reducer applies in GameContext, so
// the projected figures equal what advancing the week will actually produce
// (modulo randomness: newly-rolled events and the next fuel tick are not
// predicted, by design — a projection should be deterministic).
// ─────────────────────────────────────────────────────────────────────────────

import { weeklyTick } from './simulation.js';
import { prepareWeek } from './tickPrep.js';
import { getAircraftType, eraPurchasePrice } from '../data/aircraft.js';
import { DEPRECIATION_YEARS } from '../data/overhead.js';

const CORPORATE_TAX_RATE = 0.21;

/** Outstanding principal balance on a loan (present-value of remaining payments). */
export function outstandingLoanBalance(loan) {
  const r = (loan.interestRate ?? 0) / 52;
  const n = loan.weeksRemaining ?? 0;
  if (n <= 0) return 0;
  return r > 0
    ? Math.round(loan.weeklyPayment * (1 - Math.pow(1 + r, -n)) / r)
    : loan.weeklyPayment * n;
}

/** This-week interest portion of a loan payment. */
export function loanInterestThisWeek(loan) {
  const r = (loan.interestRate ?? 0) / 52;
  return Math.round(outstandingLoanBalance(loan) * r);
}

/** Weekly straight-line depreciation for the owned fleet (non-cash). */
export function fleetWeeklyDepreciation(fleet = []) {
  return fleet
    .filter(a => a.ownershipType === 'owned')
    .reduce((s, a) => {
      const t = getAircraftType(a.typeId);
      return t?.purchasePrice ? s + Math.round(eraPurchasePrice(t) / (DEPRECIATION_YEARS * 52)) : s;
    }, 0);
}

/**
 * Compute the canonical projected financials for the current week of `state`.
 *
 * Returns:
 *   report          — the raw weeklyTick output (all cost buckets, routeResults,
 *                      totalRevenue incl. connecting + partner + all demand
 *                      multipliers, totalCost, cashDelta, totalPassengers …)
 *   revById         — { [routeId]: boosted weekly revenue }  (incl. connecting +
 *                      multipliers — the number that actually hits the books)
 *   effectiveRevenue— totalRevenue after the active-event demand adjustment
 *   ebitda          — effectiveRevenue − operating+fixed cost (pre interest/tax/D&A)
 *   depreciation    — non-cash, owned fleet
 *   ebit            — ebitda − depreciation
 *   interest        — loan interest this week
 *   principal       — loan principal repaid this week
 *   loanPayments    — interest + principal
 *   preTaxProfit    — ebitda − loanPayments      (the engine's tax base, cash-based)
 *   corporateTax    — 21% of positive preTaxProfit
 *   netCash         — preTaxProfit − tax  →  EQUALS the `profit` stored in history
 *   netIncomeAccrual— accrual view: ebit − interest − tax (excludes principal)
 *
 * Result caching: a projection is a pure function of the (immutable) `state`
 * snapshot, and the Dashboard, Finance, Routes and Fleet screens each call
 * projectWeek(state) with the SAME state object. Running the full weeklyTick
 * four times over is wasteful and — because weeklyTick has some internal
 * randomness — could even yield slightly different numbers on different
 * screens, defeating this module's "one source of truth" purpose. We therefore
 * memoise the result against the state object identity in a WeakMap: same
 * snapshot → the exact same result, computed once; a new snapshot (after any
 * edit or a server tick) is a fresh key, so nothing goes stale. The returned
 * object is shared — treat it as read-only, never mutate it in place.
 */
const _projectionCache = new WeakMap();
export function projectWeek(state) {
  if (state && typeof state === 'object') {
    const cached = _projectionCache.get(state);
    if (cached !== undefined) return cached;
    const result = computeProjectWeek(state);
    _projectionCache.set(state, result);
    return result;
  }
  return computeProjectWeek(state);
}

function computeProjectWeek(state) {
  const fleet = state.fleet ?? [];

  // ── The week the reducer would actually run ────────────────────────────────
  // NOT the raw state. ADVANCE_WEEK stands up the aircraft whose last week of
  // grounding or heavy check is this one, dispatches reserve covers over the
  // tails still down, expires spent events, folds the fuel shock into the index
  // so hedges cover it, and opens finished bases and lounges — all before the
  // tick. Projecting the raw state forecast a week that could not happen: a
  // recovering aircraft's routes read as dead, so the card showed an eight-figure
  // cliff the player had no way to explain, and then the week came in higher than
  // the forecast every single time. See utils/tickPrep.js.
  //
  // rollNewEvents: false is the line between "the projection was wrong" and "the
  // projection is deterministic by design". Newly-rolled events, this week's
  // mechanical failures, AI encroachment and next week's fuel walk are all dice
  // that have not been thrown; the projection does not pretend to know them, and
  // that residual — not the prep — is the honest gap between forecast and result.
  const prep = prepareWeek(state, { rollNewEvents: false });
  const { gameDate, fuelMultiplier } = prep;

  // Demand shock from the events that will still be live this week, for callers
  // that want to show the multiplier. The shock itself is applied INSIDE
  // weeklyTick, which scales each route's passenger pool.
  let globalDemandMult = 1.0;
  for (const ev of prep.allEvents) {
    const fx = ev.effects ?? {};
    if (fx.globalDemandMult) globalDemandMult *= fx.globalDemandMult;
  }

  // ── Canonical engine pass ──────────────────────────────────────────────────
  const report = weeklyTick(prep.tickInput);

  // Per-route boosted revenue (what actually books) keyed by routeId.
  const revById = {};
  for (const r of report.routeResults ?? []) revById[r.routeId] = r.revenue;

  // Retired flat adjustment — kept at 0 so Finance UI rows keyed off it hide.
  const eventDemandAdj   = 0;
  const effectiveRevenue = Math.round(report.totalRevenue);

  // EBITDA = effective revenue − all operating+fixed cost (report.totalCost has no
  // interest, tax, or depreciation in it). This equals the adjusted cashDelta.
  const ebitda       = Math.round(report.totalRevenue - report.totalCost);
  const depreciation = fleetWeeklyDepreciation(fleet);
  const ebit         = ebitda - depreciation;

  // ── Financing ───────────────────────────────────────────────────────────────
  const loans = (state.loans ?? []).filter(l => (l.weeksRemaining ?? 0) > 0);
  let loanPayments = 0;
  let interest     = 0;
  for (const loan of loans) {
    loanPayments += loan.weeklyPayment;
    interest     += loanInterestThisWeek(loan);
  }
  const principal = loanPayments - interest;

  // ── Seasonal reactivation: routes that resume service this projected week ──────
  // A dormant seasonal route flipping active this month pays 1/3 of its launch
  // cost. Deductible, like lease redelivery. Charged by the same pass that flips
  // the route, so the fee and the flying can never disagree about which routes
  // resumed.
  const seasonalReactivation = prep.seasonalReactivationCost;

  // ── Tax & bottom line ────────────────────────────────────────────────────────
  // Tax base is EBT = EBITDA − depreciation − interest − reactivation (loan
  // PRINCIPAL is not an expense and is NOT deductible). This matches the reducer.
  // Lease redelivery: a lease whose FINAL week is this projected week pays 4x rent
  // on return — mirrors the reducer's leaseRedeliveryCost (deductible, like the
  // seasonal reactivation fee) so the projection matches what advancing actually books.
  //
  // The rate is the one THIS TAIL SIGNED AT, not the one in the type table. Lease
  // term multipliers (1.15 / 1.00 / 0.90 / 0.83) stamp `a.weeklyLease` at signing,
  // so on almost every lease the two differ — and the reducer bills
  // `a.weeklyLease ?? type?.weeklyLease`. Reading the list rate here made the
  // projection of a lease's final week wrong in whichever direction the term
  // discount ran (measured: $1,852,000 projected against $1,537,160 booked).
  //
  // The SAME final week also RETURNS the security deposit the tail put down at
  // signing (`a.leaseDeposit` = signing rent × LEASE_DEPOSIT_WEEKS). The reducer
  // books it as a non-taxed cash inflow (`leaseDepositRefund`), so the real
  // final-week cash movement is `+deposit − 4×rent`, not the `−4×rent` this
  // projection used to show. Omitting it understated the final week by ~8×rent
  // (an A380 lease by ~$4.4M), always in the same direction — the exact
  // "week always comes in higher than forecast" pattern this module rails against.
  let leaseRedelivery    = 0;
  let leaseDepositRefund = 0;
  for (const a of fleet) {
    const rem = a.leaseRemainingWeeks ?? 0;
    if (a.ownershipType === 'lease' && rem > 0 && rem - 1 <= 0) {
      leaseRedelivery    += (a.weeklyLease ?? getAircraftType(a.typeId)?.weeklyLease ?? 0) * 4;
      leaseDepositRefund += a.leaseDeposit ?? 0;
    }
  }
  // Deposit refund is a return of capital, not income — excluded from taxable
  // income (the reducer taxes it the same way: not at all).
  const taxableIncome = ebit - interest - seasonalReactivation - leaseRedelivery;
  const corporateTax  = Math.round(Math.max(0, taxableIncome) * CORPORATE_TAX_RATE);
  // Cash bottom line: operating cash − loan payments − reactivation − tax (matches
  // the `profit` stored in history). Depreciation is non-cash so it doesn't affect cash.
  const preTaxProfit  = ebitda - loanPayments - seasonalReactivation - leaseRedelivery + leaseDepositRefund;   // pre-tax CASH
  const netCash       = preTaxProfit - corporateTax;
  // Accrual view (proper P&L): EBIT − interest − tax. Principal excluded.
  const netIncomeAccrual = ebit - interest - corporateTax;

  return {
    report,
    revById,
    gameDate,
    fuelMultiplier,
    globalDemandMult,
    eventDemandAdj,
    effectiveRevenue,
    ebitda,
    depreciation,
    ebit,
    interest,
    principal,
    loanPayments,
    seasonalReactivation,
    leaseRedelivery,
    leaseDepositRefund,
    preTaxProfit,
    corporateTax,
    netCash,
    netIncomeAccrual,
    taxRate: CORPORATE_TAX_RATE,
  };
}
