// Valuation lag + dilution — the "someone bought 20% of my company and my stock
// dropped 17.3%" bug (Discord, 2026-07-29).
//
// Three defects met in one screenshot:
//
//   1. A share issue changed the DIVISOR instantly while the published market cap
//      is a smoothed series that could only move its weekly band, so floating 25%
//      of the company cost ~17% of the share price on the spot — and, because the
//      leaderboard ranks on value per share, cost the player rank for doing
//      something that should be value-neutral.
//   2. The weekly band was a flat ±8%, which is not smoothing but a governor: an
//      airline growing faster than 8%/wk could never catch its own fair value, so
//      its price carried no information about the business (the reporter's print
//      was ~0.6% of fair value after three game years).
//   3. Because a private airline's price was ALSO the lagged smoothed series, the
//      IPO priced off it — floating a quarter of a billion-dollar airline for a
//      rounding error, and handing a rival a 20% stake for the same.
//
//   node tools/valuation-dilution-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  VALUATION, TOTAL_SHARES, computeMarketCap, moveClampFor, repriceForShareChange,
  emptyEquity, migratedEquity, sharesOf, svpsOf,
} from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };

const M = 1_000_000;
const history = (weeks, profit, totalCost = 47_630_000) =>
  Array.from({ length: weeks }, () => ({ profit, totalCost, revenue: totalCost + profit }));

// ── 1. The reported case ─────────────────────────────────────────────────────
// Air Caldor as screenshotted: 100M shares, a $26.58M print, and the fixed-25%
// "Go public" button. Before the fix the next print was $0.2198 against $0.2658 —
// exactly −17.3%, which is 0.75 (dilution) × 1.103 (the cap's capped climb).

const caldor = (over = {}) => ({
  ...freshState(),
  multiplayer: true,
  week: 30, year: 3,
  cash: 8_930_000,
  marketCap: 26_580_000,
  sharePrice: 0.2658,
  equity: emptyEquity(),
  financialHistory: history(52, 23_570_000),
  worldMarket: { poolCash: 300 * M, seedCash: 300 * M, sharesAvailable: 0, selfSharesHeld: 0 },
  ...over,
});

test('the reported case: float 25%, tick, and the print no longer craters', () => {
  const base   = caldor();
  const listed = gameReducer(base, { type: 'GO_PUBLIC', shares: Math.round((TOTAL_SHARES * 0.25) / 0.75) });
  assert.ok(listed !== base, 'the listing went through');
  // The screenshot: $0.2658 -> $0.2198 on the tick after listing, which is
  // 0.75 (instant dilution) x 1.103 (all the cap was allowed to climb).
  const after = gameReducer(listed, { type: 'ADVANCE_WEEK' });
  const move  = (after.sharePrice - base.sharePrice) / base.sharePrice;
  assert.ok(move > -0.10,
    `share price moved ${(move * 100).toFixed(1)}% across the listing week (was -17.3%)`);
});

test('...and what it does cost is the IPO discount, nothing more', () => {
  const base = caldor();
  const n    = Math.round((TOTAL_SHARES * 0.25) / 0.75);
  const out  = gameReducer(base, { type: 'GO_PUBLIC', shares: n });
  // Selling n shares at price×(1−d) into a cap that gains exactly the proceeds:
  //   after = price × (S + n(1−d)) / (S + n)
  const d        = 1 - (out.lastEquityAction.pricePerShare / base.sharePrice);
  const expected = base.sharePrice * (TOTAL_SHARES + n * (1 - d)) / (TOTAL_SHARES + n);
  assert.ok(Math.abs(out.sharePrice - expected) / expected < 0.001,
    `expected ~$${expected.toFixed(4)}, got $${out.sharePrice.toFixed(4)}`);
});

test('the cap absorbs the cash in the same step as the shares', () => {
  const base = caldor();
  const out  = gameReducer(base, { type: 'GO_PUBLIC', shares: 20 * M });
  const raised = out.cash - base.cash;
  assert.ok(raised > 0, 'cash was raised');
  assert.ok(Math.abs(out.marketCap - (base.marketCap + raised)) < 1,
    'market cap moved by exactly the proceeds');
  assert.ok(Math.abs(out.sharePrice - out.marketCap / sharesOf(out)) < 1e-12,
    'and the price is the rebased cap over the new share count');
});

test('a secondary offering costs its discount, not its dilution', () => {
  // Measured against the counterfactual: the same airline that DIDN'T raise.
  const base    = { ...caldor(), equity: migratedEquity() };
  const control = gameReducer(base, { type: 'ADVANCE_WEEK' });
  const raised  = gameReducer(
    gameReducer(base, { type: 'ISSUE_SHARES', shares: 10 * M }), { type: 'ADVANCE_WEEK' });
  const ratio = raised.sharePrice / control.sharePrice;
  assert.ok(ratio > 0.95,
    `raising 10% of the share count cost ${((1 - ratio) * 100).toFixed(1)}% of the price`);
});

test('a buyback does not crater the price either', () => {
  const base = {
    ...caldor(), cash: 400 * M, equity: migratedEquity(),
    worldMarket: { poolCash: 300 * M, seedCash: 300 * M, sharesAvailable: 0, selfSharesHeld: 30 * M },
  };
  const out  = gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 5 * M });
  assert.ok(out !== base, 'the buyback went through');
  const spent = base.cash - out.cash;
  assert.ok(Math.abs(out.marketCap - (base.marketCap - spent)) < 1, 'cap fell by the cash paid');
  const move = (out.sharePrice - base.sharePrice) / base.sharePrice;
  assert.ok(Math.abs(move) < 0.02,
    `retiring 5% of the count moved the price ${(move * 100).toFixed(2)}% — the premium, no more`);
});

test('SVPS — the leaderboard metric — survives a capital raise', () => {
  const base = { ...caldor(), equity: migratedEquity() };
  const before = svpsOf(base);
  const out    = gameReducer(base, { type: 'ISSUE_SHARES', shares: 10 * M });
  const after  = svpsOf(out);
  assert.ok(after / before > 0.97,
    `raising capital cost ${((1 - after / before) * 100).toFixed(1)}% of SVPS — rank punishment for a neutral act`);
});

// ── 2. The clamp is a band, not a governor ───────────────────────────────────

test('an ordinary week still moves at most 8%', () => {
  assert.equal(VALUATION.WEEKLY_MOVE_CLAMP, 0.08);
  assert.equal(moveClampFor(100 * M, 100 * M), 0.08);
  assert.ok(moveClampFor(100 * M, 105 * M) < 0.083, 'a 5% gap barely widens the band');
});

test('a real re-rating widens the band, symmetrically', () => {
  assert.ok(moveClampFor(100 * M, 400 * M) > 0.15, 'fair value 4x the print → a wider band');
  assert.equal(moveClampFor(100 * M, 400 * M).toFixed(6), moveClampFor(400 * M, 100 * M).toFixed(6),
    'a collapse reprices as fast as a re-rating');
  assert.equal(moveClampFor(1 * M, 10_000 * M), VALUATION.MOVE_CLAMP_MAX, 'and it is capped');
});

test('a growing airline can actually catch its fair value', () => {
  // The reported case: a $29M print against a fair value the earnings model puts
  // in the billions. At a flat 8% that is ~68 weeks — longer than the gap took to
  // open, so the print never converges while the airline keeps growing.
  const fair = 5_200 * M;
  let cap = 29 * M, weeks = 0;
  while (cap < fair * 0.9 && weeks < 500) {
    cap = Math.min(cap * (1 + moveClampFor(cap, fair)), cap + VALUATION.CONVERGENCE * (fair - cap));
    weeks++;
  }
  assert.ok(weeks <= 30, `took ${weeks} weeks to converge (a flat 8% band takes 68)`);
});

test('the band never lets a single windfall teleport the price', () => {
  const prev = 100 * M;
  const r = computeMarketCap(history(12, 500 * M).map(h => h.profit), 50 * M, 70, {
    prevMarketCap: prev, revenueHint: 2 * M, noise: VALUATION.NOISE_PCT,
  });
  const move = (r.marketCap - prev) / prev;
  assert.ok(move <= VALUATION.MOVE_CLAMP_MAX + VALUATION.NOISE_PCT + 0.02,
    `moved ${(move * 100).toFixed(1)}% — still bounded`);
});

// ── 3. A private airline has no market to smooth ─────────────────────────────

test('a private airline publishes fair value, so its IPO prices honestly', () => {
  const base = caldor();
  const out  = gameReducer(base, { type: 'ADVANCE_WEEK' });
  const fair = computeMarketCap(
    base.financialHistory.slice(-12).map(h => h.profit), out.cash, base.awareness ?? 5,
    { revenueHint: 71_200_000 },
  ).fairValue;
  assert.ok(out.marketCap > base.marketCap * 1.12,
    `a private print jumped to ${(out.marketCap / M).toFixed(0)}M — past the smoothed band`);
  assert.ok(out.marketCap > fair * 0.5, 'and lands in the region of fair value, not 0.6% of it');
});

test('a listed airline keeps its smoothed series', () => {
  const base = { ...caldor(), equity: migratedEquity() };
  const out  = gameReducer(base, { type: 'ADVANCE_WEEK' });
  const move = Math.abs(out.marketCap - base.marketCap) / base.marketCap;
  assert.ok(move <= VALUATION.MOVE_CLAMP_MAX + VALUATION.NOISE_PCT + 1e-9,
    `a listed print moved ${(move * 100).toFixed(1)}% — must stay inside the band`);
});

// ── 4. Partial subscription instead of a dead button ─────────────────────────

test('an offering the pool can only part-fund is partially subscribed', () => {
  const base = caldor({
    worldMarket: { poolCash: 3 * M, seedCash: 300 * M, sharesAvailable: 0, selfSharesHeld: 0 },
  });
  const want = Math.round((TOTAL_SHARES * 0.25) / 0.75);
  const out  = gameReducer(base, { type: 'GO_PUBLIC', shares: want });
  assert.ok(out !== base, 'a short pool no longer kills the whole listing');
  assert.ok(out.lastEquityAction.shares < want, 'filled short');
  assert.ok(out.lastEquityAction.gross <= 3 * M, 'and never spends more than the pool holds');
  assert.equal(sharesOf(out), TOTAL_SHARES + out.lastEquityAction.shares,
    'the share count matches what actually sold');
  assert.ok(Math.abs((out.cash - base.cash) - out.lastEquityAction.gross) < 1,
    'the treasury receives exactly the settled proceeds');
});

test('an empty pool still refuses, rather than issuing shares for nothing', () => {
  const base = caldor({
    worldMarket: { poolCash: 0, seedCash: 300 * M, sharesAvailable: 0, selfSharesHeld: 0 },
  });
  const out = gameReducer(base, { type: 'GO_PUBLIC', shares: 20 * M });
  assert.equal(out, base, 'no listing, no dilution');
});

test('solo worlds (no pool) are unaffected', () => {
  const base = caldor({ worldMarket: undefined, multiplayer: false });
  const out  = gameReducer(base, { type: 'GO_PUBLIC', shares: 20 * M });
  assert.equal(out.lastEquityAction.shares, 20 * M, 'the full offering clears');
});

// ── 5. The helper itself ─────────────────────────────────────────────────────

test('repriceForShareChange is exact and floored', () => {
  const r = repriceForShareChange({ marketCap: 100 * M }, { shares: 125 * M, cashDelta: 25 * M });
  assert.equal(r.marketCap, 125 * M);
  assert.equal(r.sharePrice, 1);
  const floored = repriceForShareChange({ marketCap: 1000 }, { shares: 100, cashDelta: -1e9 });
  assert.equal(floored.marketCap, VALUATION.MIN_MARKET_CAP, 'never prices a company below the floor');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
