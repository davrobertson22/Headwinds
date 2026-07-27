// Capital markets Phase 4 — capital actions and the dividend ledger.
//
// The theme: under the SVPS leaderboard every capital-allocation move is a real
// trade-off. Issuing shares brings cash but splits the pie, buybacks shrink the pie,
// and a dividend converts retained cash into per-share value the board credits. The
// last section covers the settlement trap that makes cross-player dividends safe.
//
//   node tools/capital-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  CAPITAL, STOCK_MARKET, TOTAL_SHARES, emptyEquity, sharesOf, svpsOf, freeFloatOf,
  ipoDiscount, offeringDiscount, dividendPerShare,
} from '../packages/engine/src/utils/market.js';
import { splitDividend, holdersOf } from '../apps/headwinds-server/src/lib/marketService.mjs';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };

const realRandom = Math.random;
Math.random = () => 0.5;

const history = (weeks, profit = 2_000_000, totalCost = 5_000_000) =>
  Array.from({ length: weeks }, () => ({ profit, totalCost, revenue: totalCost + profit }));

// A listed carrier with a year of profitable trading and a healthy pool behind it.
const listed = (over = {}) => {
  const s = {
    ...freshState(),
    cash: 500_000_000, week: 30, year: 1,
    marketCap: 100_000_000, sharePrice: 1, multiplayer: true,
    financialHistory: history(52),
    worldMarket: { poolCash: 750_000_000, seedCash: 750_000_000, sharesAvailable: 30_000_000, selfSharesHeld: 30_000_000 },
  };
  s.equity = { ...emptyEquity(), isPublic: true };
  return { ...s, ...over };
};

// A private carrier eligible to list.
const priv = (over = {}) => {
  const s = listed();
  s.equity = { ...emptyEquity(), isPublic: false, founderShares: TOTAL_SHARES };
  return { ...s, ...over };
};

// ── IPO ─────────────────────────────────────────────────────────────────────

test('a private airline can list, and the proceeds land in its treasury', () => {
  const base = priv();
  const n = 20_000_000;
  const out = gameReducer(base, { type: 'GO_PUBLIC', shares: n });
  assert.ok(out !== base, 'listing accepted');
  assert.equal(out.equity.isPublic, true);
  assert.equal(sharesOf(out), TOTAL_SHARES + n, 'new shares were created');
  assert.ok(out.cash > base.cash, 'cash raised');
  assert.equal(out.lastEquityAction.kind, 'ipo');
  assert.equal(out.lastEquityAction.shares, n);
  assert.ok(out.equity.ipoWeek > 0, 'listing week recorded');
});

test('listing creates a free float where there was none', () => {
  const base = priv();
  assert.equal(freeFloatOf(base), 0, 'a private airline has no tradable float');
  const out = gameReducer(base, { type: 'GO_PUBLIC', shares: 20_000_000 });
  assert.equal(freeFloatOf(out), 20_000_000, 'exactly the shares sold are now public');
});

test('an IPO is priced at a discount to the market', () => {
  const base = priv();
  const out = gameReducer(base, { type: 'GO_PUBLIC', shares: 20_000_000 });
  assert.ok(out.lastEquityAction.pricePerShare < base.sharePrice, 'underpriced, as real IPOs are');
  const impliedDiscount = 1 - out.lastEquityAction.pricePerShare / base.sharePrice;
  assert.ok(impliedDiscount >= CAPITAL.IPO_DISCOUNT_MIN - 1e-9
         && impliedDiscount <= CAPITAL.IPO_DISCOUNT_MAX + 1e-9, 'within the discount band');
});

test('a longer, more profitable record earns a better IPO price', () => {
  assert.ok(ipoDiscount(52, 1) < ipoDiscount(12, 0), 'track record is rewarded');
  assert.ok(ipoDiscount(52, 1) >= CAPITAL.IPO_DISCOUNT_MIN);
  assert.ok(ipoDiscount(0, 0) <= CAPITAL.IPO_DISCOUNT_MAX);
});

test('you cannot list twice', () => {
  const once = gameReducer(priv(), { type: 'GO_PUBLIC', shares: 20_000_000 });
  assert.equal(once.equity.isPublic, true, 'guard: the first listing must actually succeed');
  const twice = gameReducer(once, { type: 'GO_PUBLIC', shares: 20_000_000 });
  assert.equal(twice, once, 'already public');
});

test('you cannot list too young or without a track record', () => {
  const tooYoung = priv({ week: 4, year: 1 });
  assert.equal(gameReducer(tooYoung, { type: 'GO_PUBLIC', shares: 20_000_000 }), tooYoung);
  const noRecord = priv({ financialHistory: history(3) });
  assert.equal(gameReducer(noRecord, { type: 'GO_PUBLIC', shares: 20_000_000 }), noRecord);
});

test('the offered slice must sit inside the allowed band', () => {
  const base = priv();
  // 1% is below IPO_MIN_FRACTION, 90% is above IPO_MAX_FRACTION.
  assert.equal(gameReducer(base, { type: 'GO_PUBLIC', shares: 1_000_000 }), base, 'too small');
  assert.equal(gameReducer(base, { type: 'GO_PUBLIC', shares: 900_000_000 }), base, 'too large');
});

test('a shut equity window blocks listing entirely', () => {
  const base = priv({ worldMarket: { poolCash: 1000, seedCash: 750_000_000, sharesAvailable: 0, selfSharesHeld: 0 } });
  assert.equal(gameReducer(base, { type: 'GO_PUBLIC', shares: 20_000_000 }), base,
    'no investor capital, no listing');
});

// ── Secondary offerings ─────────────────────────────────────────────────────

test('a listed airline can raise more, and holders are diluted', () => {
  const base = listed();
  const before = sharesOf(base);
  const out = gameReducer(base, { type: 'ISSUE_SHARES', shares: 10_000_000 });
  assert.ok(out !== base, 'offering accepted');
  assert.equal(sharesOf(out), before + 10_000_000);
  assert.ok(out.cash > base.cash);
  assert.equal(out.equity.offeringsThisYear, 10_000_000, 'counts against the annual allowance');
});

test('the annual offering allowance is enforced', () => {
  const base = listed();
  const cap = CAPITAL.OFFERING_MAX_PCT_PER_YEAR * sharesOf(base);
  const ok = gameReducer(base, { type: 'ISSUE_SHARES', shares: Math.floor(cap) });
  assert.ok(ok !== base, 'exactly the allowance is fine');
  const over = gameReducer(base, { type: 'ISSUE_SHARES', shares: Math.floor(cap) + 1 });
  assert.equal(over, base, 'one share over is rejected');
});

test('going back to the market repeatedly costs more each time', () => {
  assert.ok(offeringDiscount(0.12, 0) > offeringDiscount(0.02, 0), 'a bigger tap is priced worse');
  const base = listed();
  const first = gameReducer(base, { type: 'ISSUE_SHARES', shares: 5_000_000 });
  const second = gameReducer(first, { type: 'ISSUE_SHARES', shares: 5_000_000 });
  assert.ok(second.lastEquityAction.pricePerShare < first.lastEquityAction.pricePerShare,
    'the second tranche prices below the first');
});

test('a record of returning capital earns a cheaper offering', () => {
  assert.ok(offeringDiscount(0.10, 1) < offeringDiscount(0.10, 0),
    'dividends and buybacks buy cheaper equity later');
});

test('a private airline cannot run a secondary offering', () => {
  const base = priv();
  assert.equal(gameReducer(base, { type: 'ISSUE_SHARES', shares: 1_000_000 }), base, 'list first');
});

// ── Buybacks ────────────────────────────────────────────────────────────────

test('a buyback retires shares and spends cash', () => {
  const base = listed();
  const before = sharesOf(base);
  const out = gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 5_000_000 });
  assert.ok(out !== base, 'buyback accepted');
  assert.equal(sharesOf(out), before - 5_000_000, 'shares retired');
  assert.ok(out.cash < base.cash, 'cash left the company');
  assert.equal(out.lastEquityAction.kind, 'buyback');
  assert.ok(out.equity.buybacksEver > 0, 'recorded, for future offering pricing');
});

test('a buyback cannot eat into the founder block', () => {
  const base = listed();
  // Float is 30M; trying to retire more than that would reach founder shares.
  const over = gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 40_000_000 });
  assert.equal(over, base, 'only publicly held stock can be retired');
});

test('a buyback cannot exceed what the pool actually holds', () => {
  const base = listed({
    worldMarket: { poolCash: 750_000_000, seedCash: 750_000_000, sharesAvailable: 30_000_000, selfSharesHeld: 1_000_000 },
  });
  const over = gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 2_000_000 });
  assert.equal(over, base, 'other players hold the rest — you cannot retire theirs');
  const ok = gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 1_000_000 });
  assert.ok(ok !== base, 'what the pool holds is retirable');
});

test('a buyback never spends into insolvency', () => {
  // Four weeks of cover at $5M/wk is $20M; leave only a little above that.
  const base = listed({ cash: 25_000_000 });
  const out = gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 20_000_000 });
  assert.equal(out, base, 'blocked — cover must survive the buyback');
});

test('the annual buyback allowance is enforced', () => {
  const base = listed();
  const cap = CAPITAL.BUYBACK_MAX_PCT_PER_YEAR * sharesOf(base);
  const over = gameReducer(base, { type: 'BUY_BACK_SHARES', shares: Math.floor(cap) + 1 });
  assert.equal(over, base);
});

// ── Dividends ───────────────────────────────────────────────────────────────

test('dividend per share ignores losses and clamps the payout ratio', () => {
  assert.equal(dividendPerShare(-1, 0.3, TOTAL_SHARES), 0, 'no dividend from a loss');
  assert.equal(dividendPerShare(26_000_000, 0, TOTAL_SHARES), 0, 'no policy, no dividend');
  const maxed = dividendPerShare(26_000_000, 5, TOTAL_SHARES);
  const atCap = dividendPerShare(26_000_000, CAPITAL.DIVIDEND_MAX_PAYOUT, TOTAL_SHARES);
  assert.equal(maxed, atCap, 'ratio is clamped to the maximum payout');
});

test('setting a policy is clamped and requires being listed', () => {
  const base = listed();
  const set = gameReducer(base, { type: 'SET_DIVIDEND_POLICY', payoutRatio: 0.3 });
  assert.equal(set.equity.dividendPolicy, 0.3);
  const clamped = gameReducer(base, { type: 'SET_DIVIDEND_POLICY', payoutRatio: 0.99 });
  assert.equal(clamped.equity.dividendPolicy, CAPITAL.DIVIDEND_MAX_PAYOUT);
  const privateTry = gameReducer(priv(), { type: 'SET_DIVIDEND_POLICY', payoutRatio: 0.3 });
  assert.equal(privateTry.equity.dividendPolicy, 0, 'a private airline has nobody to pay');
});

// A payer positioned so the NEXT tick lands on a dividend week.
const payer = (over = {}) => {
  const s = listed({ week: CAPITAL.DIVIDEND_PERIOD_WEEKS - 1, year: 1 });
  s.equity = { ...s.equity, dividendPolicy: 0.3 };
  s.financialHistory = history(CAPITAL.DIVIDEND_TRAILING_WEEKS);
  return { ...s, ...over };
};

test('a dividend pays on the quarter, debits cash, and lifts SVPS', () => {
  const base = payer();
  const out = gameReducer(base, { type: 'ADVANCE_WEEK' });
  const div = out.lastReport.dividend;
  assert.ok(div && div.total > 0, 'a dividend was paid');
  assert.ok(out.equity.cumDividendsPerShare > 0, 'accrued per share');
  assert.ok(out.svps > out.sharePrice, 'SVPS exceeds the bare share price — the add-back');
  assert.ok(Math.abs(out.svps - (out.sharePrice + out.equity.cumDividendsPerShare)) < 1e-12);
});

test('only the publicly held shares are paid — never the founder block', () => {
  const base = payer();
  const out = gameReducer(base, { type: 'ADVANCE_WEEK' });
  const div = out.lastReport.dividend;
  assert.equal(div.payableShares, freeFloatOf(base),
    'the founder block is excluded, so the cost scales with how much you sold');
  assert.ok(div.payableShares < sharesOf(base));
  assert.ok(Math.abs(div.total - div.perShare * div.payableShares) < 2, 'total matches the rate');
});

test('a dividend is suspended after a losing quarter, and says so', () => {
  const base = payer({ financialHistory: history(CAPITAL.DIVIDEND_TRAILING_WEEKS, -1_000_000) });
  const out = gameReducer(base, { type: 'ADVANCE_WEEK' });
  assert.equal(out.lastReport.dividend, null, 'nothing paid');
  assert.ok(out.pendingToasts.some((t) => /suspended/i.test(t.title)), 'and it is public');
});

test('a dividend is suspended rather than paid into insolvency', () => {
  // A high-cost carrier needs a big cash cover (MIN_CASH_WEEKS_COVER weeks of it),
  // so this balance cannot support the payout even though the quarter was profitable.
  const base = payer({
    cash: 100_000_000,
    financialHistory: history(CAPITAL.DIVIDEND_TRAILING_WEEKS, 2_000_000, 40_000_000),
  });
  const out = gameReducer(base, { type: 'ADVANCE_WEEK' });
  assert.equal(out.lastReport.dividend, null, 'not paid');
  assert.ok(out.pendingToasts.some((t) => /suspended/i.test(t.title)), 'and the cut is public');
});

test('nothing is paid in a non-dividend week', () => {
  const base = payer({ week: 3 });
  const out = gameReducer(base, { type: 'ADVANCE_WEEK' });
  assert.equal(out.lastReport.dividend, null);
});

test('a dividend received arrives below the operating line', () => {
  // Crucial: dividend income must NOT feed operating profit, or it would loop back
  // through the x52 x P/E valuation the whole rework exists to close.
  const base = listed();
  const out = gameReducer(base, { type: 'ADVANCE_WEEK', incomingDividends: 5_000_000 });
  const week = out.financialHistory[out.financialHistory.length - 1];
  assert.equal(week.investmentIncome, 5_000_000, 'recorded as investment income');
  assert.ok(!String(week.profit).includes('NaN'));
  const without = gameReducer(base, { type: 'ADVANCE_WEEK' });
  const weekNo = without.financialHistory[without.financialHistory.length - 1];
  assert.equal(week.profit, weekNo.profit, 'operating profit is untouched by dividend income');
  assert.ok(out.cash > without.cash, 'but the cash really did arrive');
});

test('the annual allowances reset at the year boundary', () => {
  const base = listed({ week: 52, year: 1 });
  const used = gameReducer(base, { type: 'ISSUE_SHARES', shares: 5_000_000 });
  assert.ok(used.equity.offeringsThisYear > 0);
  const rolled = gameReducer(used, { type: 'ADVANCE_WEEK' });
  assert.equal(rolled.year, 2);
  assert.equal(rolled.equity.offeringsThisYear, 0, 'a new year, a new allowance');
  assert.equal(rolled.equity.buybacksThisYear, 0);
});

// ── Cross-player settlement (the CAS trap) ─────────────────────────────────

test('a dividend is split between rival holders, with the rest leaving the world', () => {
  const holders = [{ airlineId: 'b', shares: 5_000_000 }, { airlineId: 'c', shares: 2_000_000 }];
  const { credits, toOutside } = splitDividend({
    perShare: 0.072, totalPaid: 2_160_000, payerId: 'a', holders,
  });
  assert.equal(credits.length, 2);
  assert.equal(credits[0].amount, 360_000, '5M shares x $0.072');
  assert.equal(credits[1].amount, 144_000);
  const distributed = credits.reduce((s, c) => s + c.amount, 0);
  assert.equal(distributed + toOutside, 2_160_000, 'every cent is accounted for');
  assert.ok(toOutside > 0, 'the outside-investor slice leaves the world — the sink');
});

test('a dividend can never distribute more than was actually paid', () => {
  // Deliberately inconsistent inputs: a huge per-share rate against a tiny debit.
  const holders = [{ airlineId: 'b', shares: 50_000_000 }];
  const { credits, toOutside } = splitDividend({
    perShare: 10, totalPaid: 1000, payerId: 'a', holders,
  });
  const total = credits.reduce((s, c) => s + c.amount, 0) + toOutside;
  assert.equal(total, 1000, 'the debit is the hard ceiling — money is never minted');
});

test('the payer never pays itself', () => {
  const holders = [{ airlineId: 'a', shares: 9_000_000 }, { airlineId: 'b', shares: 1_000_000 }];
  const { credits } = splitDividend({ perShare: 0.1, totalPaid: 1_000_000, payerId: 'a', holders });
  assert.ok(credits.every((c) => c.airlineId !== 'a'), 'self-payment is a wash and is skipped');
});

test('holders are read out of the other airlines\' portfolios', () => {
  const airlines = [
    { id: 'a', state: { portfolio: { holdings: {} } } },
    { id: 'b', state: { portfolio: { holdings: { a: { shares: 5_000_000 } } } } },
    { id: 'c', state: { portfolio: { holdings: { d: { shares: 1_000_000 } } } } },
    { id: 'e', state: null },
  ];
  const h = holdersOf(airlines, 'a');
  assert.deepEqual(h, [{ airlineId: 'b', shares: 5_000_000 }]);
  assert.equal(holdersOf(airlines, 'zzz').length, 0, 'nobody holds an unknown airline');
  assert.equal(holdersOf(null, 'a').length, 0, 'no airlines, no holders');
});

test('an empty or zero-rate dividend produces no credits at all', () => {
  assert.equal(splitDividend({ perShare: 0, totalPaid: 0, payerId: 'a', holders: [] }).credits.length, 0);
  assert.equal(splitDividend({ perShare: 0.1, totalPaid: 100, payerId: 'a', holders: [] }).credits.length, 0);
  const zeroShares = splitDividend({
    perShare: 0.1, totalPaid: 100, payerId: 'a', holders: [{ airlineId: 'b', shares: 0 }],
  });
  assert.equal(zeroShares.credits.length, 0);
  assert.equal(zeroShares.toOutside, 100, 'undistributed money leaves rather than disappearing silently');
});

Math.random = realRandom;
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
