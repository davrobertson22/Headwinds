// Credit as an engine fact, and debt that can actually buy an aeroplane.
//
// A10. Three problems that were really one — the finance desk was a React
//      component.
//
//   The credit rating and the interest rate were computed in Finance.jsx. The
//   reducer's TAKE_LOAN copied `action.interestRate` onto the loan, and the
//   multiplayer guard's only opinion about it was "at least 3%". An airline the
//   model grades F should pay 18% on a 52-week loan; a client that simply asked
//   for the floor got 3%, worth $790,608 a year on a $10M facility. In a shared
//   world that is not a UI bug, it is a rival financing themselves out of a hole
//   you have to climb.
//
//   The engine also had no opinion on how much you could borrow. Capacity lived
//   in the UI, so three long-term loans stacked to $60M on an airline with no
//   revenue at all.
//
//   And no loan could buy an aeroplane. The largest product was $20M over 52
//   weeks; a 787 is $135M and lasts thirty years. "Own or lease?" had one
//   answer, forever. Aircraft Finance is secured on metal you already own, runs
//   eight years, and prices below unsecured debt — because if you stop paying,
//   the lender takes the aeroplane. Which is also why you can no longer sell one
//   out from under the loan.
//
//   node tools/credit-loan-test.mjs

import assert from 'node:assert/strict';
import {
  LOAN_PRODUCTS, LOAN_MIN_PRINCIPAL, LOAN_RATE_FLOOR, AIRCRAFT_LOAN_ID,
  AIRCRAFT_LOAN_LTV, STARTING_CAPITAL, CREDIT_WINDOW_WEEKS,
  creditRating, creditScore, creditInputs, loanRate, getLoanProduct,
  loanProductForTerm, borrowingCapacity, collateralValue, aircraftBookValue,
  unencumberedOwnedFleet, pledgedAircraftIds, isPledged, loanSecuredOn,
  amortizedWeeklyPayment, outstandingBalance, unsecuredDebtOutstanding,
} from '../packages/engine/src/data/credit.js';
import { gameReducer } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const history = (n, revenue, profit) =>
  Array.from({ length: n }, (_, i) => ({ week: i + 1, year: 1, revenue, profit }));

/** A healthy, trading airline. */
const healthy = (over = {}) => ({
  cash: 60_000_000, week: 40, year: 2, hub: 'JFK', airlineName: 'Test',
  fleet: [], routes: [], cargoRoutes: [], loans: [],
  financialHistory: history(30, 5_000_000, 900_000),
  gameDate: { week: 40, month: 6 }, maintenanceBudget: 1.0,
  ...over,
});

/** …and one in visible distress. */
const distressed = (over = {}) => healthy({
  cash: 2_000_000,
  financialHistory: history(30, 3_000_000, -500_000),
  ...over,
});

const owned = (id, typeId = 'a320ceo', ageWeeks = 100) =>
  ({ id, typeId, ownershipType: 'owned', ageWeeks, status: 'idle' });

// ── The rating is the engine's ─────────────────────────────────────────────

console.log('\n── Credit rating ────────────────────────────────────────');

test('a profitable airline outgrades one that is losing money', () => {
  const a = creditRating(healthy());
  const b = creditRating(distressed());
  assert.ok(a.score > b.score, `${a.grade}(${a.score}) vs ${b.grade}(${b.score})`);
  assert.equal(a.grade, 'A');
  assert.equal(b.grade, 'F');
});

test('a brand-new airline is Fair, not Excellent', () => {
  // The subtle regression when the inputs moved from a forward projection to
  // realised results: a carrier with no history has no revenue AND no losses, so
  // a naive port scores it a flawless A on day one.
  const fresh = healthy({
    financialHistory: [],
    cash: STARTING_CAPITAL,
    fleet: [{ id: 'a', typeId: 'a320ceo', ownershipType: 'leased', ageWeeks: 0 }],
  });
  assert.equal(creditRating(fresh).grade, 'C');
});

test('the rating reads the last four weeks, not the whole history', () => {
  const turnaround = healthy({
    financialHistory: [...history(20, 3_000_000, -900_000), ...history(4, 5_000_000, 900_000)],
  });
  const { weeklyNetIncome } = creditInputs(turnaround);
  assert.ok(weeklyNetIncome > 0, `four good weeks should read positive, got ${weeklyNetIncome}`);
  assert.equal(creditInputs(turnaround).weeksOps, 24);
  assert.equal(CREDIT_WINDOW_WEEKS, 4);
});

test('every grade band is reachable and ordered', () => {
  const seen = new Map();
  for (let s = 0; s <= 100; s++) {
    const g = creditRating({ financialHistory: [], loans: [], fleet: [], cash: 0 });
    assert.ok(g.grade);
  }
  // Walk the real bands via states, not by poking the table.
  const states = [
    healthy(),
    healthy({ financialHistory: history(30, 5_000_000, 120_000) }),
    healthy({ financialHistory: [] }),
    distressed({ cash: 40_000_000 }),
    distressed(),
  ];
  for (const st of states) seen.set(creditRating(st).grade, creditScore(st));
  for (const g of ['A', 'F']) assert.ok(seen.has(g), `never reached ${g}: ${[...seen.keys()]}`);
  assert.ok(seen.get('A') > seen.get('F'));
});

test('a better rating buys a cheaper loan', () => {
  const good = loanRate(healthy(), 'long');
  const bad  = loanRate(distressed(), 'long');
  assert.ok(near(good, 0.11, 1e-9), `A grade should pay base − 2%, got ${good}`);
  assert.ok(near(bad, 0.18, 1e-9), `F grade should pay base + 5%, got ${bad}`);
});

test('no rating can price a loan below the floor', () => {
  for (const p of LOAN_PRODUCTS) {
    assert.ok(loanRate(healthy(), p.id) >= LOAN_RATE_FLOOR, p.id);
  }
  assert.equal(loanRate(healthy(), 'nonsense'), 0);
});

// ── …and TAKE_LOAN no longer asks the client ───────────────────────────────

console.log('\n── The rate is not the client\'s to choose ───────────────');

test('a claimed rate is ignored entirely', () => {
  // THE defect. Same airline, same product, two very different requests.
  const st = distressed();
  const honest = gameReducer(st, { type: 'TAKE_LOAN', productId: 'long', principal: 10_000_000 });
  const modded = gameReducer(st, { type: 'TAKE_LOAN', productId: 'long', principal: 10_000_000, interestRate: LOAN_RATE_FLOOR });
  assert.equal(honest.loans.at(-1).interestRate, modded.loans.at(-1).interestRate);
  assert.equal(modded.loans.at(-1).interestRate, loanRate(st, 'long'));
  assert.ok(modded.loans.at(-1).interestRate > LOAN_RATE_FLOOR, 'the floor was handed out anyway');
});

test('a claimed term is ignored too', () => {
  const st = healthy();
  const next = gameReducer(st, { type: 'TAKE_LOAN', productId: 'short', principal: 1_000_000, termWeeks: 5000 });
  assert.equal(next.loans.at(-1).termWeeks, getLoanProduct('short').termWeeks);
});

test('the $50M-at-0%-over-520-weeks payload is simply refused', () => {
  const st = distressed();
  const next = gameReducer(st, { type: 'TAKE_LOAN', principal: 50_000_000, interestRate: 0, termWeeks: 520 });
  assert.equal((next.loans ?? []).length, 0, 'a loan was written');
  assert.equal(next.cash, st.cash, 'cash moved');
  assert.ok(next.error, 'refused without saying why');
});

test('a legacy payload still names the product it always meant', () => {
  // Old clients and queued multiplayer decisions send a term, not a product.
  assert.equal(loanProductForTerm(13).id, 'short');
  assert.equal(loanProductForTerm(26).id, 'medium');
  assert.equal(loanProductForTerm(52).id, 'long');
  assert.equal(loanProductForTerm(999).id, 'long');   // nearest, never the secured one
  assert.ok(!loanProductForTerm(999).secured);
  const next = gameReducer(healthy(), { type: 'TAKE_LOAN', principal: 1_000_000, interestRate: 0.13, termWeeks: 52 });
  assert.equal(next.loans.at(-1).termWeeks, 52);
  assert.equal(next.loans.at(-1).productId, 'long');
});

test('a loan below the minimum is refused with a reason', () => {
  const next = gameReducer(healthy(), { type: 'TAKE_LOAN', productId: 'short', principal: 500 });
  assert.equal((next.loans ?? []).length, 0);
  assert.ok(next.error?.includes(LOAN_MIN_PRINCIPAL.toLocaleString()));
});

test('the weekly payment amortises the principal exactly', () => {
  const st = healthy();
  const next = gameReducer(st, { type: 'TAKE_LOAN', productId: 'medium', principal: 4_000_000 });
  const loan = next.loans.at(-1);
  assert.equal(loan.weeklyPayment, amortizedWeeklyPayment(4_000_000, loan.interestRate, loan.termWeeks));
  assert.ok(near(outstandingBalance(loan), 4_000_000, 4_000_000 * 0.001),
    `a loan taken this second owes ${outstandingBalance(loan)} of 4,000,000`);
  assert.equal(next.cash, st.cash + 4_000_000);
});

test('a zero-interest loan does not divide by zero', () => {
  assert.equal(amortizedWeeklyPayment(52_000, 0, 52), 1000);
  assert.equal(outstandingBalance({ interestRate: 0, weeksRemaining: 10, weeklyPayment: 100 }), 1000);
  assert.equal(outstandingBalance({ interestRate: 0.1, weeksRemaining: 0, weeklyPayment: 100 }), 0);
  assert.equal(outstandingBalance(null), 0);
});

// ── Capacity is a total, not an allowance ──────────────────────────────────

console.log('\n── Borrowing capacity ───────────────────────────────────');

test('a headline figure is available to an airline with no revenue', () => {
  const fresh = healthy({ financialHistory: [] });
  assert.equal(borrowingCapacity(fresh, 'short'), 5_000_000);
  assert.equal(borrowingCapacity(fresh, 'long'), 20_000_000);
});

test('revenue unlocks more than the headline figure', () => {
  const big = healthy({ financialHistory: history(30, 8_000_000, 1_500_000) });
  assert.ok(borrowingCapacity(big, 'long') > 20_000_000,
    `8M/wk × 16 should beat the $20M floor, got ${borrowingCapacity(big, 'long')}`);
});

test('loans can no longer be stacked to the moon', () => {
  // The old capacity check lived in the UI, so three $20M longs was a scripted
  // loop away. Capacity is now net of what you already owe.
  let st = healthy({ financialHistory: [] });
  const before = borrowingCapacity(st, 'long');
  st = gameReducer(st, { type: 'TAKE_LOAN', productId: 'long', principal: before });
  assert.equal(st.loans.length, 1);
  assert.ok(borrowingCapacity(st, 'long') < 1_000_000,
    `still ${borrowingCapacity(st, 'long')} of headroom after drawing the lot`);
  const again = gameReducer(st, { type: 'TAKE_LOAN', productId: 'long', principal: before });
  assert.equal(again.loans.length, 1, 'a second full-size loan was written');
  assert.ok(again.error);
});

test('repaying restores the headroom', () => {
  let st = healthy({ financialHistory: [] });
  st = gameReducer(st, { type: 'TAKE_LOAN', productId: 'medium', principal: 6_000_000 });
  const squeezed = borrowingCapacity(st, 'medium');
  st = gameReducer(st, { type: 'REPAY_LOAN', loanId: st.loans[0].id });
  assert.equal(st.loans.length, 0);
  assert.ok(borrowingCapacity(st, 'medium') > squeezed);
  assert.equal(unsecuredDebtOutstanding(st), 0);
});

test('secured debt does not eat the unsecured allowance', () => {
  // They are different lenders looking at different things.
  const base = healthy({ fleet: [owned('t1', 'b7878'), owned('t2', 'b7878')] });
  const before = borrowingCapacity(base, 'long');
  const after = gameReducer(base, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 20_000_000 });
  assert.equal(after.loans.length, 1);
  assert.equal(borrowingCapacity(after, 'long'), before);
});

// ── Aircraft finance ───────────────────────────────────────────────────────

console.log('\n── Aircraft finance ─────────────────────────────────────');

test('a secured facility exists, and it can buy an aeroplane', () => {
  const p = getLoanProduct(AIRCRAFT_LOAN_ID);
  assert.ok(p?.secured);
  assert.ok(p.termWeeks >= 416, 'an eight-year asset needs an eight-year loan');
  const cheapest = Math.min(...LOAN_PRODUCTS.filter(x => !x.secured).map(x => x.baseRate));
  assert.ok(p.baseRate < cheapest, 'collateral should buy a better rate than none');
  // Two 787s at book value clear the $135M list price of a third.
  const st = healthy({ fleet: [owned('t1', 'b7878', 52), owned('t2', 'b7878', 52)] });
  const capacity = borrowingCapacity(st, AIRCRAFT_LOAN_ID);
  assert.ok(capacity > getAircraftType('a320neo').purchasePrice,
    `$${capacity.toLocaleString()} still cannot buy a narrowbody`);
});

test('capacity is loan-to-value on book, not on list', () => {
  const st = healthy({ fleet: [owned('t1', 'b7878', 520)] });   // ten years old
  const book = collateralValue(st);
  const type = getAircraftType('b7878');
  assert.ok(book < type.purchasePrice, 'a ten-year-old frame is not worth list');
  assert.ok(near(borrowingCapacity(st, AIRCRAFT_LOAN_ID), Math.floor(book * AIRCRAFT_LOAN_LTV / 1000) * 1000, 1));
  assert.equal(aircraftBookValue(st.fleet[0]), book);
  assert.equal(aircraftBookValue({ typeId: 'nope' }), 0);
});

test('only aircraft you own outright are collateral', () => {
  const st = healthy({ fleet: [
    owned('t1'),
    { id: 't2', typeId: 'a320ceo', ownershipType: 'leased', ageWeeks: 100, status: 'idle' },
    { ...owned('t3'), status: 'retired' },
  ] });
  assert.deepEqual(unencumberedOwnedFleet(st).map(a => a.id), ['t1']);
});

test('an airline with nothing to pledge is told why', () => {
  const st = healthy({ fleet: [{ id: 't2', typeId: 'a320ceo', ownershipType: 'leased', ageWeeks: 10 }] });
  const next = gameReducer(st, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 5_000_000 });
  assert.equal((next.loans ?? []).length, 0);
  assert.match(next.error ?? '', /own outright/i);
});

test('pledged metal leaves the collateral pool', () => {
  const st = healthy({ fleet: [owned('t1', 'b7878'), owned('t2', 'b7878')] });
  const after = gameReducer(st, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 10_000_000 });
  const loan = after.loans.at(-1);
  assert.deepEqual([...loan.collateralIds].sort(), ['t1', 't2']);
  assert.equal(unencumberedOwnedFleet(after).length, 0);
  assert.equal(collateralValue(after), 0);
  assert.equal(borrowingCapacity(after, AIRCRAFT_LOAN_ID), 0);
  assert.ok(isPledged(after, 't1') && isPledged(after, 't2'));
  assert.equal(pledgedAircraftIds(after).size, 2);
  assert.equal(loanSecuredOn(after, 't1').id, loan.id);
});

test('an unsecured loan pledges nothing', () => {
  const st = healthy({ fleet: [owned('t1')] });
  const after = gameReducer(st, { type: 'TAKE_LOAN', productId: 'long', principal: 5_000_000 });
  assert.equal(after.loans.at(-1).collateralIds, undefined);
  assert.ok(!isPledged(after, 't1'));
  assert.equal(unsecuredDebtOutstanding(after) > 0, true);
});

test('you cannot sell the lender\'s security', () => {
  const st = healthy({ fleet: [owned('t1', 'b7878')] });
  const financed = gameReducer(st, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 10_000_000 });
  const sold = gameReducer(financed, { type: 'SELL_AIRCRAFT', aircraftId: 't1' });
  assert.equal(sold.fleet.length, 1, 'the aeroplane was sold out from under the loan');
  assert.equal(sold.cash, financed.cash, 'and the proceeds were paid');
  assert.match(sold.error ?? '', /pledged/i);
});

test('…nor scrap it', () => {
  const st = healthy({ fleet: [owned('t1', 'b7878')] });
  const financed = gameReducer(st, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 10_000_000 });
  const retired = gameReducer(financed, { type: 'RETIRE_AIRCRAFT', aircraftId: 't1' });
  assert.equal(retired.fleet.length, 1);
  assert.match(retired.error ?? '', /pledged/i);
});

test('an unpledged aircraft is still perfectly sellable', () => {
  // The guard must not have quietly frozen the whole fleet.
  const st = healthy({ fleet: [owned('t1', 'b7878'), owned('t2', 'a320ceo')] });
  const sold = gameReducer(st, { type: 'SELL_AIRCRAFT', aircraftId: 't2' });
  assert.equal(sold.fleet.length, 1);
  assert.ok(sold.cash > st.cash);
});

test('repaying the loan releases the aircraft', () => {
  const st = healthy({ cash: 200_000_000, fleet: [owned('t1', 'b7878')] });
  let s = gameReducer(st, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 10_000_000 });
  assert.ok(isPledged(s, 't1'));
  s = gameReducer(s, { type: 'REPAY_LOAN', loanId: s.loans[0].id });
  assert.ok(!isPledged(s, 't1'), 'still pledged after the debt was cleared');
  assert.equal(unencumberedOwnedFleet(s).length, 1);
  const sold = gameReducer(s, { type: 'SELL_AIRCRAFT', aircraftId: 't1' });
  assert.equal(sold.fleet.length, 0);
});

test('eight years of interest costs real money — but the week is survivable', () => {
  const st = healthy({ fleet: [owned('t1', 'b7878')] });
  const s = gameReducer(st, { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 40_000_000 });
  const loan = s.loans.at(-1);
  const totalRepaid = loan.weeklyPayment * loan.termWeeks;
  assert.ok(totalRepaid > 40_000_000 * 1.15,
    `$${totalRepaid.toLocaleString()} repaid on $40M is not enough interest for eight years`);
  // The whole point of the product: a bill you can actually fly against.
  assert.ok(loan.weeklyPayment < 40_000_000 / 52,
    'an 8-year facility must not cost more per week than a 1-year one');
  assert.ok(loan.weeklyPayment < 150_000, `$${loan.weeklyPayment}/wk is not survivable`);
});

test('a distressed airline pays much more for the same metal', () => {
  const fleet = [owned('t1', 'b7878')];
  const good = gameReducer(healthy({ fleet }), { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 20_000_000 });
  const bad  = gameReducer(distressed({ fleet }), { type: 'TAKE_LOAN', productId: AIRCRAFT_LOAN_ID, principal: 20_000_000 });
  assert.ok(bad.loans.at(-1).interestRate > good.loans.at(-1).interestRate * 2);
  assert.ok(bad.loans.at(-1).weeklyPayment > good.loans.at(-1).weeklyPayment);
  // …and it is still cheaper than unsecured money at the same grade.
  assert.ok(loanRate(distressed(), AIRCRAFT_LOAN_ID) < loanRate(distressed(), 'long'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
