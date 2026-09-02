// ─────────────────────────────────────────────────────────────────────────────
// CREDIT & DEBT
//
// WHY THIS EXISTS
// ---------------
// The credit rating used to live in `src/components/Finance.jsx`. The reducer's
// TAKE_LOAN took `action.interestRate` verbatim and the multiplayer guard only
// checked that it cleared a 3% floor — so an airline the model grades F, which
// should be paying 18%, could dispatch `interestRate: 0.03` and borrow at the
// floor. On a $10M 52-week loan that is $790,608 a year of interest that simply
// does not happen, in a game where rivals share one economy.
//
// The rating is now an engine fact: the client asks for a PRODUCT, and the
// engine decides what that costs and how much of it you may have. A modded
// client cannot lie about its own creditworthiness because it is no longer
// asked.
//
// The second thing this module adds is a way to BUY an aeroplane. The largest
// loan on offer was $20M over 52 weeks against a $135M 787 — one year to repay
// a thirty-year asset — so "own or lease?" had exactly one answer after the
// starter fleet. Aircraft finance is secured on metal you already own, runs
// eight years, and prices below unsecured debt because the bank can take the
// aeroplane. That is what makes ownership a decision instead of a formality.
// ─────────────────────────────────────────────────────────────────────────────

import { getAircraftType, eraPurchasePrice } from './aircraft.js';
import { valueRemaining } from './overhead.js';

/** Paid-in capital every airline starts with. */
export const STARTING_CAPITAL = 15_000_000;

/** No airline borrows below this, however good its books. */
export const LOAN_RATE_FLOOR = 0.03;

/** Smallest loan the desk will write. */
export const LOAN_MIN_PRINCIPAL = 10_000;

/**
 * Weeks of realised results the rating looks at. Rating agencies do not
 * re-grade an airline because it had one bad week, and neither does this: the
 * inputs are a four-week average of what actually happened, not a projection of
 * what the client hopes will.
 */
export const CREDIT_WINDOW_WEEKS = 4;

/** Product id of the secured aircraft facility. */
export const AIRCRAFT_LOAN_ID = 'aircraft';

/**
 * Loan-to-value on pledged metal. A lender advances against the aeroplane's
 * book value, not all of it — the gap is its margin if it ever has to
 * repossess and sell into a soft market.
 */
export const AIRCRAFT_LOAN_LTV = 0.70;

/**
 * Ceiling on TOTAL unsecured borrowing, as a multiple of weekly revenue. The
 * per-product headline figure is a total, not a per-loan allowance: without
 * this, three long-term loans stacked to $60M on an airline with no revenue,
 * which was the whole reason unsecured debt outclassed every other financing
 * route in the game.
 */
export const UNSECURED_DEBT_MULTIPLE = 16;

export const LOAN_PRODUCTS = [
  {
    id: 'short',
    name: 'Short-term Loan',
    termWeeks: 13,
    baseRate: 0.08,
    maxMultiple: 4,            // ceiling = 4× weekly revenue …
    baseMax: 5_000_000,        // … or $5M, whichever is higher (available from launch)
    secured: false,
    description: '13-week term · up to $5M · lowest total interest',
    color: '#38d39f',
  },
  {
    id: 'medium',
    name: 'Medium-term Loan',
    termWeeks: 26,
    baseRate: 0.10,
    maxMultiple: 8,
    baseMax: 10_000_000,
    secured: false,
    description: '26-week term · up to $10M · balanced payments',
    color: '#3ea6ff',
  },
  {
    id: 'long',
    name: 'Long-term Loan',
    termWeeks: 52,
    baseRate: 0.13,
    maxMultiple: 16,
    baseMax: 20_000_000,
    secured: false,
    description: '52-week term · up to $20M · largest unsecured amount',
    color: '#ffb43d',
  },
  {
    id: AIRCRAFT_LOAN_ID,
    name: 'Aircraft Finance',
    termWeeks: 416,            // 8 years
    baseRate: 0.065,           // cheapest money in the game — it is collateralised
    maxMultiple: 0,            // capacity comes from metal, not from revenue
    baseMax: 0,
    secured: true,
    ltv: AIRCRAFT_LOAN_LTV,
    description: '8-year term · secured on aircraft you own · lowest rate, largest amounts',
    color: '#a371f7',
  },
];

/** @returns {object|null} */
export function getLoanProduct(id) {
  return LOAN_PRODUCTS.find(p => p.id === id) ?? null;
}

/**
 * Which product a legacy `{ principal, interestRate, termWeeks }` decision meant.
 * Old clients (and old queued multiplayer decisions) name a term, not a product;
 * they must keep working, and they must get the same product they always got.
 */
export function loanProductForTerm(termWeeks) {
  const t = Number(termWeeks) || 0;
  let best = LOAN_PRODUCTS[0];
  let bestGap = Infinity;
  for (const p of LOAN_PRODUCTS) {
    if (p.secured) continue;   // never reachable by a legacy payload
    const gap = Math.abs(p.termWeeks - t);
    if (gap < bestGap) { best = p; bestGap = gap; }
  }
  return best;
}

// ─── Amortisation ────────────────────────────────────────────────────────────

/** Level weekly payment on an amortising loan: P·r·(1+r)ⁿ / ((1+r)ⁿ − 1). */
export function amortizedWeeklyPayment(principal, annualRate, termWeeks) {
  const p = Number(principal) || 0;
  const n = Math.max(1, Math.round(Number(termWeeks) || 0));
  const r = (Number(annualRate) || 0) / 52;
  if (r <= 0) return Math.round(p / n);
  return Math.round(p * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
}

/** Present value of the payments still to come — the principal still owed. */
export function outstandingBalance(loan) {
  if (!loan) return 0;
  const r = (Number(loan.interestRate) || 0) / 52;
  const n = Math.max(0, Number(loan.weeksRemaining) || 0);
  if (n <= 0) return 0;
  return r > 0
    ? Math.round(loan.weeklyPayment * (1 - Math.pow(1 + r, -n)) / r)
    : Math.round(loan.weeklyPayment * n);
}

// ─── The rating ──────────────────────────────────────────────────────────────

/**
 * Realised weekly revenue and net income over the rating window, plus how long
 * the airline has been trading.
 */
export function creditInputs(state) {
  const history = state?.financialHistory ?? [];
  const window  = history.slice(-CREDIT_WINDOW_WEEKS);
  const n = window.length;
  return {
    weeklyRevenue:   n ? window.reduce((s, h) => s + (Number(h?.revenue) || 0), 0) / n : 0,
    weeklyNetIncome: n ? window.reduce((s, h) => s + (Number(h?.profit)  || 0), 0) / n : 0,
    weeksOps:        history.length,
  };
}

/** Total book value of every loan still outstanding. */
export function totalDebtOutstanding(state) {
  return (state?.loans ?? []).reduce((s, l) => s + outstandingBalance(l), 0);
}

/** …and the unsecured slice of it, which is what the borrowing ceiling counts. */
export function unsecuredDebtOutstanding(state) {
  return (state?.loans ?? [])
    .filter(l => !(l.collateralIds?.length))
    .reduce((s, l) => s + outstandingBalance(l), 0);
}

/**
 * 0–100 creditworthiness. Thresholds are carried over unchanged from the old
 * client-side function so nobody's grade moves for a reason they can't see;
 * what changed is where the revenue and net-income figures come from (realised
 * results rather than a forward projection the server never had).
 */
export function creditScore(state) {
  const { weeklyRevenue, weeklyNetIncome, weeksOps } = creditInputs(state);
  const leased = (state?.fleet ?? []).filter(a => a.ownershipType !== 'owned');
  const annualLease = leased.reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    return s + (a.weeklyLease ?? t?.weeklyLease ?? 0) * 52;
  }, 0);
  const totalDebt = annualLease + totalDebtOutstanding(state);
  const equity    = STARTING_CAPITAL
    + (state?.financialHistory ?? []).reduce((s, h) => s + (Number(h?.profit) || 0), 0);

  const debtToEquity = equity > 0 ? totalDebt / Math.max(equity, 1) : 99;
  const runway = weeklyNetIncome < 0 && (state?.cash ?? 0) > 0
    ? state.cash / -weeklyNetIncome
    : Infinity;

  let score = 100;
  if (debtToEquity > 4)      score -= 40;
  else if (debtToEquity > 2) score -= 20;
  else if (debtToEquity > 1) score -= 10;

  // An airline that has not yet traded a week gives a lender nothing to read,
  // and an unread book is priced like a bad one. Without this a brand-new
  // carrier — no revenue, no costs, no history — scores a flawless A on its
  // first day, which is where a four-week average of realised results differs
  // from the forward projection this rating used to be built on.
  if (weeksOps === 0)                              score -= 25;
  else if (weeklyNetIncome < 0)                    score -= 25;
  else if (weeklyNetIncome < weeklyRevenue * 0.05) score -= 10;

  if (Number.isFinite(runway) && runway < 4)       score -= 30;
  else if (Number.isFinite(runway) && runway < 12) score -= 15;

  if (weeksOps < 4)       score -= 15;
  else if (weeksOps < 12) score -= 5;

  return Math.max(0, Math.min(100, score));
}

export const CREDIT_GRADES = [
  { min: 85, grade: 'A', label: 'Excellent', color: '#38d39f', rateBonus: -0.02 },
  { min: 70, grade: 'B', label: 'Good',      color: '#4fc3f7', rateBonus: -0.01 },
  { min: 55, grade: 'C', label: 'Fair',      color: '#ffb43d', rateBonus:  0.00 },
  { min: 40, grade: 'D', label: 'Poor',      color: '#f0883e', rateBonus:  0.02 },
  { min: -1, grade: 'F', label: 'High Risk', color: '#ff5d6c', rateBonus:  0.05 },
];

/** @returns {{score:number, grade:string, label:string, color:string, rateBonus:number}} */
export function creditRating(state) {
  const score = creditScore(state);
  const band  = CREDIT_GRADES.find(b => score >= b.min) ?? CREDIT_GRADES[CREDIT_GRADES.length - 1];
  return { score, grade: band.grade, label: band.label, color: band.color, rateBonus: band.rateBonus };
}

/** What this airline actually pays for this product, today. */
export function loanRate(state, productId) {
  const product = getLoanProduct(productId);
  if (!product) return 0;
  return Math.max(LOAN_RATE_FLOOR,
    Math.round((product.baseRate + creditRating(state).rateBonus) * 10000) / 10000);
}

// ─── Collateral ──────────────────────────────────────────────────────────────

/** Book value of one airframe: delivered price written down by age. */
export function aircraftBookValue(aircraft) {
  const type = getAircraftType(aircraft?.typeId);
  if (!type) return 0;
  return Math.round(eraPurchasePrice(type) * valueRemaining(aircraft?.ageWeeks, type));
}

/** Every tail currently pledged against a live secured loan. */
export function pledgedAircraftIds(state) {
  const ids = new Set();
  for (const loan of state?.loans ?? []) {
    for (const id of loan.collateralIds ?? []) ids.add(id);
  }
  return ids;
}

export function isPledged(state, aircraftId) {
  if (!aircraftId) return false;
  return pledgedAircraftIds(state).has(aircraftId);
}

/** Which loan a pledged tail is tied to — for an error message worth reading. */
export function loanSecuredOn(state, aircraftId) {
  return (state?.loans ?? []).find(l => (l.collateralIds ?? []).includes(aircraftId)) ?? null;
}

/**
 * Owned aircraft not already pledged and not retired. A leased tail is the
 * lessor's, not yours, and cannot be offered to anyone.
 */
export function unencumberedOwnedFleet(state) {
  const pledged = pledgedAircraftIds(state);
  return (state?.fleet ?? []).filter(a =>
    a?.ownershipType === 'owned' && a?.status !== 'retired' && !pledged.has(a.id));
}

/** Book value of everything you could still pledge. */
export function collateralValue(state) {
  return unencumberedOwnedFleet(state).reduce((s, a) => s + aircraftBookValue(a), 0);
}

// ─── Capacity ────────────────────────────────────────────────────────────────

/**
 * The most this airline may draw on a product right now.
 *
 * Unsecured: the product's headline ceiling (max of its base figure and a
 * multiple of realised weekly revenue) LESS unsecured debt already outstanding —
 * so the figure is a total exposure, not a per-loan allowance.
 *
 * Secured: loan-to-value against unpledged metal. It self-limits, because
 * anything already pledged has left the pool.
 *
 * @returns {number} dollars, rounded down to the nearest $1,000
 */
export function borrowingCapacity(state, productId) {
  const product = getLoanProduct(productId);
  if (!product) return 0;
  const floorTo1k = (v) => Math.max(0, Math.floor(v / 1000) * 1000);

  if (product.secured) {
    return floorTo1k(collateralValue(state) * (product.ltv ?? AIRCRAFT_LOAN_LTV));
  }

  const { weeklyRevenue } = creditInputs(state);
  const revenueMax = weeklyRevenue > 0 ? weeklyRevenue * product.maxMultiple : 0;
  const ceiling    = Math.max(product.baseMax ?? 0, revenueMax);
  return floorTo1k(ceiling - unsecuredDebtOutstanding(state));
}

/** Absolute unsecured ceiling across every product — for UI copy and guards. */
export function unsecuredDebtCeiling(state) {
  const { weeklyRevenue } = creditInputs(state);
  const base = Math.max(...LOAN_PRODUCTS.filter(p => !p.secured).map(p => p.baseMax ?? 0));
  return Math.max(base, weeklyRevenue * UNSECURED_DEBT_MULTIPLE);
}
