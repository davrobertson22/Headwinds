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

import { weeklyTick, weekToGameDate, isRouteActive, routeDistanceKm } from './simulation.js';
import { getAircraftType } from '../data/aircraft.js';
import { effectiveFuelMultiplier, absoluteWeek } from './fuel.js';
import { DEPRECIATION_YEARS, routeLaunchCost } from '../data/overhead.js';

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
      return t?.purchasePrice ? s + Math.round(t.purchasePrice / (DEPRECIATION_YEARS * 52)) : s;
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

  // Match the reducer's gameDate so seasonality agrees with the actual tick.
  const gameMonth = weekToGameDate(state.week).monthIndex;
  const gameDate  = { week: state.week, month: gameMonth };

  // Event effects from CURRENTLY active events (deterministic — we don't roll new ones).
  let eventFuelMult     = 1.0;
  let globalDemandMult  = 1.0;
  for (const ev of state.activeEvents ?? []) {
    const fx = ev.effects ?? {};
    if (fx.fuelMult)         eventFuelMult    *= fx.fuelMult;
    if (fx.globalDemandMult) globalDemandMult *= fx.globalDemandMult;
  }

  // Fuel multiplier: hedged/unhedged blend × event fuel shock (mirrors reducer).
  const currentFuelIndex = state.fuelPrice?.index ?? state.fuelMultiplier ?? 1.0;
  const nowAbsWeek       = absoluteWeek(state.year ?? 1, state.week ?? 1);
  const activeHedges     = (state.hedgeContracts ?? []).filter(h => h.expiryAbsWeek > nowAbsWeek);
  const fuelMultiplier   = state.fuelPrice
    ? effectiveFuelMultiplier(currentFuelIndex, activeHedges) * eventFuelMult
    : (state.fuelMultiplier ?? 1.0) * eventFuelMult;

  // ── Canonical engine pass ──────────────────────────────────────────────────
  // Event demand shocks are applied INSIDE weeklyTick (state.activeEvents flows
  // through in the spread): each route's passenger pool is scaled, so per-route
  // revenue, pax and load factors already reflect active events.
  const report = weeklyTick({ ...state, fuelMultiplier, loyalty: state.loyalty, gameDate });

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
  // Mirrors the reducer — a dormant seasonal route flipping active in this month
  // pays 1/3 of its launch cost. Deductible, like lease redelivery.
  let seasonalReactivation = 0;
  for (const r of state.routes ?? []) {
    if (!r.season) continue;
    const shouldBeActive = isRouteActive(r, gameMonth);
    const prevState = r.seasonState ?? (shouldBeActive ? 'active' : 'dormant');
    if (shouldBeActive && prevState === 'dormant') {
      seasonalReactivation += Math.round(routeLaunchCost(routeDistanceKm(r.origin, r.destination)) / 3);
    }
  }

  // ── Tax & bottom line ────────────────────────────────────────────────────────
  // Tax base is EBT = EBITDA − depreciation − interest − reactivation (loan
  // PRINCIPAL is not an expense and is NOT deductible). This matches the reducer.
  // Lease redelivery: a lease whose FINAL week is this projected week pays 4x rent
  // on return — mirrors the reducer's leaseRedeliveryCost (deductible, like the
  // seasonal reactivation fee) so the projection matches what advancing actually books.
  let leaseRedelivery = 0;
  for (const a of fleet) {
    const rem = a.leaseRemainingWeeks ?? 0;
    if (a.ownershipType === 'lease' && rem > 0 && rem - 1 <= 0) {
      leaseRedelivery += (getAircraftType(a.typeId)?.weeklyLease ?? 0) * 4;
    }
  }
  const taxableIncome = ebit - interest - seasonalReactivation - leaseRedelivery;
  const corporateTax  = Math.round(Math.max(0, taxableIncome) * CORPORATE_TAX_RATE);
  // Cash bottom line: operating cash − loan payments − reactivation − tax (matches
  // the `profit` stored in history). Depreciation is non-cash so it doesn't affect cash.
  const preTaxProfit  = ebitda - loanPayments - seasonalReactivation - leaseRedelivery;   // pre-tax CASH
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
    preTaxProfit,
    corporateTax,
    netCash,
    netIncomeAccrual,
    taxRate: CORPORATE_TAX_RATE,
  };
}
