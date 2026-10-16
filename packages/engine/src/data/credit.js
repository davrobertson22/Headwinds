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
import { valueRemaining, capAtCostBasis } from './overhead.js';

/** Paid-in capital a new (classic-default) airline begins with. Prefer
 *  state.paidInCapital where a state is to hand — worlds set their own knob. */
export const STARTING_CAPITAL = 10_000_000;
/** What every airline started on before paidInCapital was stored (pre-Sept 2026). */
export const LEGACY_STARTING_CAPITAL = 15_000_000;

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
 * Debt service may take at most this fraction of operating cash flow (net
 * income before loan payments, averaged over CREDIT_WINDOW_WEEKS) once a new
 * loan is added. Real lenders phrase it the other way round as a coverage
 * ratio of ~1.25–2×; half is the middle of that range.
 *
 * Why: Aircraft Finance's only limit was metal — 70% of whatever you owned —
 * with no reference to whether the airline could pay. Heavy Landing, Oct 2026:
 * one airline drew $31B of secured loans in a year, each draw sized by the
 * planes the previous draw had bought. Together with the cost-basis cap on
 * collateral (overhead.js capAtCostBasis) this makes borrowing a function of
 * earnings and equity, not just of what the last loan purchased.
 */
export const DEBT_SERVICE_COVERAGE_MAX = 0.5;

/**
 * Total loan debt after a new loan may not exceed this multiple of book equity
 * (cash + owned fleet at the lower of book and cost basis − loans). D ≤ 4E is
 * the same statement as "debt no more than 80% of assets".
 */
export const MAX_DEBT_TO_EQUITY = 4;

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
export function creditFactors(state) {
  const { weeklyRevenue, weeklyNetIncome, weeksOps } = creditInputs(state);
  const leased = (state?.fleet ?? []).filter(a => a.ownershipType !== 'owned');
  const annualLease = leased.reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    return s + (a.weeklyLease ?? t?.weeklyLease ?? 0) * 52;
  }, 0);
  const loanDebt  = totalDebtOutstanding(state);
  const totalDebt = annualLease + loanDebt;
  const equity    = (state?.paidInCapital ?? LEGACY_STARTING_CAPITAL)
    + (state?.financialHistory ?? []).reduce((s, h) => s + (Number(h?.profit) || 0), 0);

  const debtToEquity = equity > 0 ? totalDebt / Math.max(equity, 1) : 99;
  const cash = state?.cash ?? 0;
  const runway = weeklyNetIncome < 0 && cash > 0
    ? cash / -weeklyNetIncome
    : Infinity;

  const factors = [];

  // ── Leverage ───────────────────────────────────────────────────────────────
  if (debtToEquity > 4) {
    factors.push({ id: 'leverage', label: 'Leverage', delta: -40,
      detail: 'Debt (loans + a year of lease rentals) is more than 4x equity.' });
  } else if (debtToEquity > 2) {
    factors.push({ id: 'leverage', label: 'Leverage', delta: -20,
      detail: 'Debt (loans + a year of lease rentals) is more than 2x equity.' });
  } else if (debtToEquity > 1) {
    factors.push({ id: 'leverage', label: 'Leverage', delta: -10,
      detail: 'Debt (loans + a year of lease rentals) exceeds equity.' });
  } else {
    factors.push({ id: 'leverage', label: 'Leverage', delta: 0,
      detail: 'Debt is comfortably covered by equity.' });
  }

  // ── Earnings ───────────────────────────────────────────────────────────────
  // The window is what a lender can actually read: realised results, averaged.
  // A single catastrophic week is diluted by three; four bad weeks are not.
  if (weeksOps === 0) {
    factors.push({ id: 'earnings', label: 'Earnings', delta: -25,
      detail: 'No trading week has closed yet, so there are no results to read.' });
  } else if (weeklyNetIncome < 0) {
    factors.push({ id: 'earnings', label: 'Earnings', delta: -25,
      detail: `Average net income over the last ${CREDIT_WINDOW_WEEKS} weeks is negative.` });
  } else if (weeklyNetIncome < weeklyRevenue * 0.05) {
    factors.push({ id: 'earnings', label: 'Earnings', delta: -10,
      detail: `Net margin over the last ${CREDIT_WINDOW_WEEKS} weeks is under 5%.` });
  } else {
    factors.push({ id: 'earnings', label: 'Earnings', delta: 0,
      detail: `Profitable across the last ${CREDIT_WINDOW_WEEKS} weeks at a healthy margin.` });
  }

  // ── Liquidity ──────────────────────────────────────────────────────────────
  if (Number.isFinite(runway) && runway < 4) {
    factors.push({ id: 'runway', label: 'Cash runway', delta: -30,
      detail: 'At the current burn rate, cash lasts under 4 weeks.' });
  } else if (Number.isFinite(runway) && runway < 12) {
    factors.push({ id: 'runway', label: 'Cash runway', delta: -15,
      detail: 'At the current burn rate, cash lasts under 12 weeks.' });
  } else {
    factors.push({ id: 'runway', label: 'Cash runway', delta: 0,
      detail: Number.isFinite(runway)
        ? 'Cash covers the current burn rate for more than 12 weeks.'
        : 'Not burning cash.' });
  }

  // ── Track record ───────────────────────────────────────────────────────────
  if (weeksOps < 4) {
    factors.push({ id: 'history', label: 'Track record', delta: -15,
      detail: 'Fewer than 4 weeks of trading history.' });
  } else if (weeksOps < 12) {
    factors.push({ id: 'history', label: 'Track record', delta: -5,
      detail: 'Fewer than 12 weeks of trading history.' });
  } else {
    factors.push({ id: 'history', label: 'Track record', delta: 0,
      detail: `${weeksOps} weeks of trading history.` });
  }

  const raw = factors.reduce((s, f) => s + f.delta, 100);

  return {
    score: Math.max(0, Math.min(100, raw)),
    factors,
    windowWeeks: CREDIT_WINDOW_WEEKS,
    inputs: {
      weeklyRevenue, weeklyNetIncome, weeksOps, cash,
      equity, loanDebt, annualLease, totalDebt, debtToEquity, runway,
    },
  };
}

/**
 * 0-100 creditworthiness. Thresholds are carried over unchanged from the old
 * client-side function so nobody's grade moves for a reason they can't see;
 * what changed is where the revenue and net-income figures come from (realised
 * results rather than a forward projection the server never had).
 *
 * The arithmetic now lives in `creditFactors`, which returns the same number
 * along with the line items that produced it - because a grade a player cannot
 * account for reads as a bug even when it is right.
 */
export function creditScore(state) {
  return creditFactors(state).score;
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

/**
 * What the bank will lend against: everything you could still pledge, each tail
 * at book value capped at what you paid for it (capAtCostBasis). Lending on full
 * book against a frame bought at 65% of it was how a loan came to exceed the
 * purchase price — the aeroplane was free, and the surplus bought the next one.
 */
export function collateralValue(state) {
  return unencumberedOwnedFleet(state).reduce((s, a) => s + capAtCostBasis(a, aircraftBookValue(a)), 0);
}

// ─── Capacity ────────────────────────────────────────────────────────────────

/** Weekly payments on every loan still running. */
export function weeklyDebtService(state) {
  return (state?.loans ?? [])
    .filter(l => (Number(l?.weeksRemaining) || 0) > 0)
    .reduce((s, l) => s + (Number(l.weeklyPayment) || 0), 0);
}

/**
 * Net income before loan payments, averaged over the credit window — what the
 * airline has available to service debt. financialHistory.profit is AFTER
 * loan payments, so they are added back.
 */
export function operatingCashFlow(state) {
  return creditInputs(state).weeklyNetIncome + weeklyDebtService(state);
}

/**
 * Book equity as the lender sees it: cash, plus every owned airframe at the
 * lower of book value and what was paid for it, less loans outstanding. The
 * cost-basis cap is what keeps a fleet bought from estates at 65% of book from
 * reading as equity it never paid for. Stock holdings are ignored (illiquid
 * to a lender, and a rival's share price is not this airline's balance sheet).
 */
export function bookEquity(state) {
  const fleetValue = (state?.fleet ?? [])
    .filter(a => a?.ownershipType === 'owned' && a?.status !== 'retired')
    .reduce((s, a) => s + capAtCostBasis(a, aircraftBookValue(a)), 0);
  return (Number(state?.cash) || 0) + fleetValue - totalDebtOutstanding(state);
}

const floorTo1k = (v) => Math.max(0, Math.floor(v / 1000) * 1000);

/**
 * Every ceiling on a new loan of this product, and which one binds.
 *
 *   base       — the product's own limit: LTV on unpledged metal (secured), or
 *                the headline ceiling less unsecured debt outstanding.
 *   coverage   — the largest principal whose payment keeps total debt service
 *                within DEBT_SERVICE_COVERAGE_MAX of operating cash flow.
 *                Infinity when no trading week has closed (nothing to read).
 *   leverage   — MAX_DEBT_TO_EQUITY × book equity, less debt outstanding.
 *   lifeline   — unsecured products only: the base figure ($5M/$10M/$20M) less
 *                unsecured debt outstanding, available whatever the ceilings
 *                say, as it always was — a week-one airline has no results and
 *                no equity and still has to be able to start.
 *   capacity   — max(lifeline, min(base, coverage, leverage)), to the $1k.
 *   binding    — 'collateral' | 'revenue' | 'coverage' | 'leverage' | 'lifeline'
 *
 * @returns {{base:number, coverage:number, leverage:number, lifeline:number, capacity:number, binding:string}}
 */
export function borrowingLimits(state, productId) {
  const product = getLoanProduct(productId);
  if (!product) return { base: 0, coverage: 0, leverage: 0, lifeline: 0, capacity: 0, binding: 'collateral' };

  let base, baseKind, lifeline = 0;
  if (product.secured) {
    base     = collateralValue(state) * (product.ltv ?? AIRCRAFT_LOAN_LTV);
    baseKind = 'collateral';
  } else {
    const { weeklyRevenue } = creditInputs(state);
    const unsecured  = unsecuredDebtOutstanding(state);
    const revenueMax = weeklyRevenue > 0 ? weeklyRevenue * product.maxMultiple : 0;
    base     = Math.max(product.baseMax ?? 0, revenueMax) - unsecured;
    baseKind = 'revenue';
    lifeline = floorTo1k((product.baseMax ?? 0) - unsecured);
  }

  // Coverage: solve pay(P) ≤ headroom for P. The payment is linear in the
  // principal, so price a reference $1B (large enough that the payment's
  // rounding to the dollar is noise) and scale.
  const { weeksOps } = creditInputs(state);
  let coverage = Infinity;
  if (weeksOps > 0) {
    const REF       = 1_000_000_000;
    const headroom  = operatingCashFlow(state) * DEBT_SERVICE_COVERAGE_MAX - weeklyDebtService(state);
    const payOnRef  = amortizedWeeklyPayment(REF, loanRate(state, product.id), product.termWeeks);
    coverage = headroom > 0 && payOnRef > 0 ? (headroom / payOnRef) * REF : 0;
  }

  const leverage = Math.max(0, MAX_DEBT_TO_EQUITY * bookEquity(state) - totalDebtOutstanding(state));

  const ceilings = [[baseKind, base], ['coverage', coverage], ['leverage', leverage]];
  let binding = baseKind, tightest = base;
  for (const [kind, v] of ceilings) if (v < tightest) { tightest = v; binding = kind; }
  let capacity = floorTo1k(tightest);
  if (lifeline > capacity) { capacity = lifeline; binding = 'lifeline'; }

  return { base: floorTo1k(base), coverage: Number.isFinite(coverage) ? floorTo1k(coverage) : Infinity,
           leverage: floorTo1k(leverage), lifeline, capacity, binding };
}

/**
 * The most this airline may draw on a product right now — the one figure the
 * server guard, the reducer and the Finance screen all use. See
 * borrowingLimits for the ceilings behind it.
 *
 * @returns {number} dollars, rounded down to the nearest $1,000
 */
export function borrowingCapacity(state, productId) {
  return borrowingLimits(state, productId).capacity;
}

/** Absolute unsecured ceiling across every product — for UI copy and guards. */
export function unsecuredDebtCeiling(state) {
  const { weeklyRevenue } = creditInputs(state);
  const base = Math.max(...LOAN_PRODUCTS.filter(p => !p.secured).map(p => p.baseMax ?? 0));
  return Math.max(base, weeklyRevenue * UNSECURED_DEBT_MULTIPLE);
}
