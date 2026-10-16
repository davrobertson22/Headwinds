// The bank has an opinion about how much debt an airline can carry.
//
// A11. Aircraft Finance's only limit was metal: 70% of whatever you owned
//      outright, with no reference to whether the airline could pay for it.
//      Heavy Landing, Oct 2026: one airline drew $31B of secured loans in a
//      year, each draw sized by the planes the previous draw had bought. The
//      cost-basis cap (used-cost-basis-test) took away the free aeroplane;
//      this adds the two tests any lender runs before the collateral one.
//
//   • Coverage. After the new loan, weekly debt service may take at most
//     DEBT_SERVICE_COVERAGE_MAX of operating cash flow (net income before
//     loan payments, 4-week average). No results yet = no coverage test; the
//     launch lifeline below still applies.
//   • Leverage. Total loan debt after the new loan may not exceed
//     MAX_DEBT_TO_EQUITY × book equity (cash + owned fleet at the lower of
//     book and cost basis − loans). D ≤ 4E is the same as debt ≤ 80% of assets.
//   • Lifeline. An unsecured product's baseMax ($5M / $10M / $20M) stays
//     available regardless, as it always was — a week-one airline with no
//     results and no equity can still borrow to start. The ceilings bite only
//     above that.
//
//   borrowingLimits() returns every ceiling and which one binds, so the
//   Finance screen can say "limited by earnings" rather than just a number;
//   borrowingCapacity() stays the single figure the guard and reducer use.
//
//   node tools/credit-ceiling-test.mjs

import assert from 'node:assert/strict';
import {
  LOAN_PRODUCTS, AIRCRAFT_LOAN_ID, AIRCRAFT_LOAN_LTV, LOAN_MIN_PRINCIPAL,
  DEBT_SERVICE_COVERAGE_MAX, MAX_DEBT_TO_EQUITY,
  borrowingCapacity, borrowingLimits, weeklyDebtService, operatingCashFlow, bookEquity,
  amortizedWeeklyPayment, loanRate, aircraftBookValue, collateralValue, totalDebtOutstanding,
} from '../packages/engine/src/data/credit.js';
import { gameReducer } from '../packages/engine/src/reducer.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const history = (n, revenue, profit) =>
  Array.from({ length: n }, (_, i) => ({ week: i + 1, year: 1, revenue, profit }));
const owned = (typeId, ageWeeks, over = {}) => ({ id: `t-${typeId}-${ageWeeks}-${Math.random().toString(36).slice(2, 6)}`, typeId, ownershipType: 'owned', ageWeeks, status: 'idle', ...over });
const loanOf = (principal, rate = 0.065, termWeeks = 416, over = {}) => ({
  id: `l-${principal}`, productId: AIRCRAFT_LOAN_ID, principal, interestRate: rate, termWeeks,
  weeklyPayment: amortizedWeeklyPayment(principal, rate, termWeeks), weeksRemaining: termWeeks, ...over,
});
const airline = (over = {}) => ({
  cash: 50_000_000, week: 20, year: 2, hub: 'JFK', airlineName: 'T', paidInCapital: 10_000_000,
  fleet: [], routes: [], cargoRoutes: [], loans: [],
  financialHistory: history(12, 20_000_000, 2_000_000),
  gameDate: { week: 20, month: 5 }, maintenanceBudget: 1.0, phase: 'playing',
  ...over,
});

// A fleet of ten big jets, unpledged: plenty of metal.
const BIG = Array.from({ length: 10 }, () => owned('b777300er', 104));

test('the constants are what the test describes', () => {
  assert.equal(DEBT_SERVICE_COVERAGE_MAX, 0.5);
  assert.equal(MAX_DEBT_TO_EQUITY, 4);
});

test('operating cash flow is net income with loan payments added back', () => {
  const l = loanOf(100_000_000);
  const s = airline({ loans: [l] });
  assert.equal(weeklyDebtService(s), l.weeklyPayment);
  assert.equal(operatingCashFlow(s), 2_000_000 + l.weeklyPayment);
  assert.equal(weeklyDebtService(airline({ loans: [loanOf(5_000_000, 0.065, 52, { weeksRemaining: 0 })] })), 0, 'a paid-off loan costs nothing');
});

test('book equity is cash plus fleet at the lower of book and basis, less loans', () => {
  const cheap = owned('b777300er', 104, { costBasis: 1_000_000 });
  const s = airline({ cash: 10, fleet: [cheap], loans: [loanOf(2_000_000)] });
  // Loans count at their outstanding balance (present value of the remaining
  // payments), which differs from the principal by the payment's rounding.
  assert.equal(bookEquity(s), 10 + 1_000_000 - totalDebtOutstanding(s));
  assert.ok(near(totalDebtOutstanding(s), 2_000_000, 2_000));
  const plain = owned('b777300er', 104);
  assert.equal(bookEquity(airline({ cash: 0, fleet: [plain] })), aircraftBookValue(plain));
});

test('coverage: a loan whose payment would push debt service past half of cash flow is cut down', () => {
  const s = airline({ fleet: BIG, cash: 500_000_000, financialHistory: history(12, 20_000_000, 1_000_000) });
  const lim = borrowingLimits(s, AIRCRAFT_LOAN_ID);
  const ltv = Math.floor(collateralValue(s) * AIRCRAFT_LOAN_LTV / 1000) * 1000;
  assert.ok(lim.coverage < ltv, `coverage (${lim.coverage}) must bind below LTV (${ltv}) for this fixture`);
  assert.equal(lim.binding, 'coverage');
  assert.equal(borrowingCapacity(s, AIRCRAFT_LOAN_ID), lim.capacity);
  // At the cap, the new payment plus existing service is half of OCF (to the $1k floor).
  const pay = amortizedWeeklyPayment(lim.capacity, loanRate(s, AIRCRAFT_LOAN_ID), 416);
  assert.ok(pay <= operatingCashFlow(s) * DEBT_SERVICE_COVERAGE_MAX + 5, 'payment at capacity exceeds the coverage ceiling');
  const payMore = amortizedWeeklyPayment(lim.capacity + 1_000_000, loanRate(s, AIRCRAFT_LOAN_ID), 416);
  assert.ok(payMore > operatingCashFlow(s) * DEBT_SERVICE_COVERAGE_MAX, 'a bigger loan should have breached it');
});

test('coverage: an airline losing money gets no secured credit beyond its metal... which is to say none', () => {
  const s = airline({ fleet: BIG, financialHistory: history(12, 20_000_000, -500_000) });
  assert.equal(borrowingCapacity(s, AIRCRAFT_LOAN_ID), 0);
  assert.equal(borrowingLimits(s, AIRCRAFT_LOAN_ID).binding, 'coverage');
});

test('coverage: existing debt service eats the headroom', () => {
  const fresh = airline({ fleet: BIG, cash: 2_000_000_000, financialHistory: history(12, 40_000_000, 4_000_000) });
  const before = borrowingCapacity(fresh, AIRCRAFT_LOAN_ID);
  const l = loanOf(before / 2, loanRate(fresh, AIRCRAFT_LOAN_ID));
  // Taking half the capacity: net income falls by the payment, OCF is unchanged, headroom halves.
  const after = airline({ ...fresh, loans: [l], financialHistory: history(12, 40_000_000, 4_000_000 - l.weeklyPayment) });
  const capAfter = borrowingCapacity(after, AIRCRAFT_LOAN_ID);
  // Compare payments, not principals: the second airline is more geared and
  // less profitable, so its rating and therefore its rate have moved.
  const payBefore = amortizedWeeklyPayment(before, loanRate(fresh, AIRCRAFT_LOAN_ID), 416);
  const payAfter  = amortizedWeeklyPayment(capAfter, loanRate(after, AIRCRAFT_LOAN_ID), 416);
  assert.ok(near(payAfter, payBefore / 2, payBefore * 0.01), `expected a payment of ~${payBefore / 2}, got ${payAfter}`);
  assert.ok(capAfter < before);
});

test('leverage: total loans may not exceed four times book equity', () => {
  // Rich on paper, hugely profitable (so coverage does not bind), but already geared.
  const fleet = Array.from({ length: 40 }, () => owned('b777300er', 104));
  const assets = fleet.reduce((s, a) => s + aircraftBookValue(a), 0) + 1_000_000;
  const debt = Math.round(assets * 0.7);
  const s = airline({ fleet, cash: 1_000_000, loans: [loanOf(debt)], financialHistory: history(12, 2_000_000_000, 1_000_000_000) });
  const lim = borrowingLimits(s, AIRCRAFT_LOAN_ID);
  const equity = bookEquity(s);
  const owed   = totalDebtOutstanding(s);
  assert.ok(near(equity, assets - owed, 2), 'equity fixture');
  assert.equal(lim.leverage, Math.max(0, Math.floor((MAX_DEBT_TO_EQUITY * equity - owed) / 1000) * 1000));
  assert.equal(lim.binding, 'leverage');
  assert.equal(borrowingCapacity(s, AIRCRAFT_LOAN_ID), lim.leverage);
  // At the ceiling, debt is 80% of assets; a thousand more and it is over.
  assert.ok((owed + lim.leverage + 1000) / assets > 0.8 - 1e-6);
});

test('leverage: a distressed frame counts at what was paid, not at book', () => {
  const full = airline({ cash: 0, fleet: [owned('b777300er', 104)], financialHistory: history(12, 2_000_000_000, 1_000_000_000) });
  const cheap = airline({ cash: 0, fleet: [owned('b777300er', 104, { costBasis: 10_000_000 })], financialHistory: history(12, 2_000_000_000, 1_000_000_000) });
  assert.ok(borrowingLimits(cheap, AIRCRAFT_LOAN_ID).leverage < borrowingLimits(full, AIRCRAFT_LOAN_ID).leverage);
  assert.equal(borrowingLimits(cheap, AIRCRAFT_LOAN_ID).leverage, MAX_DEBT_TO_EQUITY * 10_000_000);
});

test('lifeline: the unsecured base amounts survive no results and no equity', () => {
  const s = airline({ cash: 1_000, fleet: [], financialHistory: [], loans: [] });
  for (const p of LOAN_PRODUCTS.filter((x) => !x.secured)) {
    assert.equal(borrowingCapacity(s, p.id), p.baseMax, p.id);
    assert.equal(borrowingLimits(s, p.id).binding, 'lifeline');
  }
  assert.equal(borrowingCapacity(s, AIRCRAFT_LOAN_ID), 0, 'but nothing secured without metal');
});

test('lifeline: an unsecured loan already drawn reduces what the lifeline will add', () => {
  const l = loanOf(3_000_000, 0.08, 13, { productId: 'short' });
  const s = airline({ cash: 1_000, fleet: [], financialHistory: [], loans: [l] });
  assert.ok(near(borrowingCapacity(s, 'short'), 5_000_000 - 3_000_000, 1000));
});

test('no results yet: the secured facility is metal and leverage only, no coverage test', () => {
  const s = airline({ fleet: BIG, cash: 100_000_000, financialHistory: [], loans: [] });
  const lim = borrowingLimits(s, AIRCRAFT_LOAN_ID);
  assert.equal(lim.coverage, Infinity);
  assert.ok(lim.capacity > 0);
});

test('a healthy, lightly geared airline is bound by its metal exactly as before', () => {
  const s = airline({ fleet: BIG, cash: 1_000_000_000, financialHistory: history(12, 300_000_000, 60_000_000) });
  const lim = borrowingLimits(s, AIRCRAFT_LOAN_ID);
  assert.equal(lim.binding, 'collateral');
  assert.equal(lim.capacity, Math.floor(collateralValue(s) * AIRCRAFT_LOAN_LTV / 1000) * 1000);
});

test('the reducer refuses a loan over the ceiling, and the guard would too (same function)', () => {
  const s = airline({ fleet: BIG, cash: 500_000_000, financialHistory: history(12, 20_000_000, 1_000_000) });
  const cap = borrowingCapacity(s, AIRCRAFT_LOAN_ID);
  assert.ok(cap >= LOAN_MIN_PRINCIPAL);
  const ok = gameReducer(s, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: cap });
  assert.equal(ok.loans.length, 1, 'a loan at the ceiling is written');
  const no = gameReducer(s, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: cap + 1_000_000 });
  assert.equal((no.loans ?? []).length, 0, 'a loan over the ceiling is not');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
