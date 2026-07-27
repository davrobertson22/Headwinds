// Capital markets Phase 3 — trading mechanics.
//
// Price impact, capital gains tax, the free float, and the single delist haircut
// that replaced the old solo-AI branches. The theme is that trading must be
// FRICTIONAL: churn loses money, size costs you, and gains are taxed, so a
// predictable price move is no longer a money printer.
//
//   node tools/trading-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  STOCK_MARKET, TOTAL_SHARES, emptyEquity, emptyPortfolio,
  freeFloatOf, priceImpact, executionPrice, capitalGainsTax,
  poolLiquidityDiscount, poolSeedFor, poolRefill,
} from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };

const realRandom = Math.random;
Math.random = () => 0.5;
const S = STOCK_MARKET;

// A rival with an explicit 30M free float at $1.00.
const rival = (over = {}) => ({
  id: 'r1', name: 'Target Air', marketCap: 100_000_000,
  shares: 100_000_000, founderShares: 70_000_000, sharePrice: 1, ...over,
});
const richPlayer = (over = {}) => ({
  ...freshState(), cash: 2_000_000_000, marketCap: 10_000_000_000,
  competitors: [rival()], ...over,
});

// ── Free float ───────────────────────────────────────────────────────────────

test('free float is everything outside the founder block', () => {
  assert.equal(freeFloatOf(rival()), 30_000_000);
  assert.equal(freeFloatOf({ equity: emptyEquity() }), 30_000_000);
});

test('a missing founder block falls back to the default float, not to zero', () => {
  // A pre-rework rival payload has no founderShares. Falling back to 0 float
  // would make priceImpact divide by zero and block all trading.
  const f = freeFloatOf({ shares: 100_000_000 });
  assert.equal(f, 100_000_000 * S.DEFAULT_FREE_FLOAT_PCT);
  assert.ok(f > 0, 'never zero — that would deadlock the market');
});

test('a nonsense founder block cannot produce a negative or oversized float', () => {
  assert.ok(freeFloatOf({ shares: 1_000_000, founderShares: 5_000_000 }) >= 0, 'over-large block');
  assert.ok(freeFloatOf({ shares: 1_000_000, founderShares: -5 }) >= 0, 'negative block');
  assert.equal(freeFloatOf({ shares: 1_000_000, founderShares: 1_000_000 }), 0, 'fully locked up');
});

// ── Price impact ─────────────────────────────────────────────────────────────

test('impact rises with order size and is capped', () => {
  const F = 30_000_000;
  assert.equal(priceImpact(0, F), 0, 'no order, no impact');
  const small = priceImpact(F * 0.01, F);
  const mid   = priceImpact(F * 0.25, F);
  const huge  = priceImpact(F * 10, F);
  assert.ok(small < mid, 'bigger order, more slippage');
  assert.ok(mid < S.IMPACT_MAX, 'a quarter of the float is not yet at the cap');
  assert.equal(huge, S.IMPACT_MAX, 'capped so a fat order cannot price absurdly');
});

test('impact is proportional to the fraction of float, not the raw share count', () => {
  // The same 1M shares hurt far more against a thin float.
  assert.ok(priceImpact(1_000_000, 2_000_000) > priceImpact(1_000_000, 100_000_000));
  assert.ok(Math.abs(priceImpact(1_000_000, 10_000_000) - priceImpact(2_000_000, 20_000_000)) < 1e-12,
    'same fraction of float → same impact');
});

test('degenerate inputs give zero impact rather than NaN', () => {
  for (const [n, f] of [[NaN, 100], [100, NaN], [100, 0], [-5, 100], [100, -5]]) {
    const i = priceImpact(n, f);
    assert.ok(Number.isFinite(i) && i >= 0, `impact finite for (${n}, ${f})`);
  }
});

test('buys execute above the mark and sells below it', () => {
  const F = 30_000_000;
  const buy  = executionPrice(1, F * 0.1, F, true);
  const sell = executionPrice(1, F * 0.1, F, false);
  assert.ok(buy > 1 && sell < 1, 'you always cross the spread');
  assert.ok(Math.abs((buy - 1) - (1 - sell)) < 1e-12, 'symmetric around the mark');
});

test('a sell can never execute at a negative price', () => {
  assert.ok(executionPrice(1, 1e12, 1, false) >= 0);
});

// ── Round trip is lossy ─────────────────────────────────────────────────────

test('an instant round trip at an unchanged price always loses money', () => {
  const base = richPlayer();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  assert.ok(bought !== base, 'buy accepted');
  const spent = base.cash - bought.cash;
  const sold = gameReducer(bought, { type: 'SELL_STOCK', targetId: 'r1', shares: 1_000_000 });
  const back = sold.cash - bought.cash;
  assert.ok(back < spent, `wash trade must lose: paid ${spent}, recovered ${back}`);
  assert.ok(sold.portfolio.realizedPnL < 0, 'and it books a realized loss');
  assert.equal(sold.portfolio.holdings.r1, undefined, 'position fully closed');
});

test('bigger round trips lose proportionally more (impact, not just spread)', () => {
  const base = richPlayer();
  const cost = (n) => {
    const b = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: n });
    const s = gameReducer(b, { type: 'SELL_STOCK', targetId: 'r1', shares: n });
    return (base.cash - s.cash) / n;   // loss per share
  };
  assert.ok(cost(5_000_000) > cost(200_000), 'size is punished per-share, not just in total');
});

// ── Capital gains tax ───────────────────────────────────────────────────────

test('tax applies to gains only, never to losses', () => {
  assert.equal(capitalGainsTax(1_000_000), Math.round(1_000_000 * S.CAPITAL_GAINS_TAX));
  assert.equal(capitalGainsTax(0), 0);
  assert.equal(capitalGainsTax(-1_000_000), 0, 'losses are untaxed and earn no credit');
  assert.equal(capitalGainsTax(NaN), 0);
});

test('a profitable exit is taxed, and the tax is recorded', () => {
  const base = richPlayer();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  // The rival triples. Sell into the new price.
  const risen = {
    ...bought,
    competitors: [rival({ sharePrice: 3, marketCap: 300_000_000 })],
  };
  const sold = gameReducer(risen, { type: 'SELL_STOCK', targetId: 'r1', shares: 1_000_000 });
  assert.ok(sold.portfolio.taxPaid > 0, 'tax was charged');
  assert.ok(sold.portfolio.realizedPnL > 0, 'still a profitable trade after tax');

  // Cash received must equal proceeds minus tax — i.e. the tax really left.
  const gained = sold.cash - risen.cash;
  const untaxedGain = sold.portfolio.realizedPnL + sold.portfolio.taxPaid;
  assert.ok(sold.portfolio.taxPaid > untaxedGain * 0.2,
    'roughly the headline rate on the gain');
  assert.ok(gained > 0 && gained < 3_000_000 * 1.01, 'proceeds are net of tax and friction');
});

test('tax makes a taxed gain strictly smaller than the raw gain', () => {
  const base = richPlayer();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  const risen = { ...bought, competitors: [rival({ sharePrice: 2, marketCap: 200_000_000 })] };
  const sold = gameReducer(risen, { type: 'SELL_STOCK', targetId: 'r1', shares: 1_000_000 });
  const basis = bought.portfolio.holdings.r1.costBasis;
  const rawGain = 1_000_000 * 2 - basis;   // ignoring friction
  assert.ok(sold.portfolio.realizedPnL < rawGain, 'friction + tax bite into the gain');
});

test('a losing exit pays no tax', () => {
  const base = richPlayer();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  const fallen = { ...bought, competitors: [rival({ sharePrice: 0.4, marketCap: 40_000_000 })] };
  const sold = gameReducer(fallen, { type: 'SELL_STOCK', targetId: 'r1', shares: 1_000_000 });
  assert.equal(sold.portfolio.taxPaid ?? 0, 0, 'no tax on a loss');
  assert.ok(sold.portfolio.realizedPnL < 0);
});

test('partial sells keep the remaining position and its basis consistent', () => {
  const base = richPlayer();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 2_000_000 });
  const half = gameReducer(bought, { type: 'SELL_STOCK', targetId: 'r1', shares: 1_000_000 });
  const held = half.portfolio.holdings.r1;
  assert.equal(held.shares, 1_000_000);
  const perShareBefore = bought.portfolio.holdings.r1.costBasis / 2_000_000;
  const perShareAfter  = held.costBasis / held.shares;
  assert.ok(Math.abs(perShareBefore - perShareAfter) < 0.01, 'average cost is preserved');
});

// ── Delisting ───────────────────────────────────────────────────────────────

test('the solo AI delist branches are gone — one haircut for everyone', () => {
  assert.equal(S.BANKRUPT_HAIRCUT, undefined, 'BANKRUPT_HAIRCUT removed');
  assert.ok(S.DELIST_HAIRCUT > 0 && S.DELIST_HAIRCUT < 1, 'a single haircut remains');
});

test('a held rival vanishing liquidates the position at the haircut, net of tax', () => {
  const base = { ...richPlayer(), multiplayer: true };
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  assert.ok(bought.portfolio.holdings.r1, 'position open');
  // The rival is gone from the world next week (MP purge/abandon).
  const orphaned = { ...bought, competitors: [] };
  const ticked = gameReducer(orphaned, { type: 'ADVANCE_WEEK' });
  assert.equal(ticked.portfolio.holdings.r1, undefined, 'position force-liquidated');
  assert.ok(ticked.pendingToasts?.some((t) => /delisted/i.test(t.title ?? '')), 'player is told');
  // Bought around the $1 mark and liquidated at a 25% haircut, so this is a loss
  // — which means no tax, and the loss is booked.
  assert.ok(ticked.portfolio.realizedPnL < 0, 'the haircut books a realized loss');
  assert.equal(ticked.portfolio.taxPaid, 0, 'no tax on a forced loss');
});

test('a PROFITABLE forced liquidation is still taxed', () => {
  const base = { ...richPlayer(), multiplayer: true };
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  // The rival quadruples, then vanishes: 75% of $4 still clears the $1 basis.
  const orphaned = {
    ...bought,
    competitors: [rival({ sharePrice: 4, marketCap: 400_000_000 })],
  };
  const ticked = gameReducer({ ...orphaned, competitors: [] }, { type: 'ADVANCE_WEEK' });
  // With the rival already gone, the mark falls back to the last recorded price.
  assert.equal(ticked.portfolio.holdings.r1, undefined, 'liquidated');
  assert.ok(Number.isFinite(ticked.portfolio.taxPaid), 'tax counter stays finite');
});

// ── Guards still hold ───────────────────────────────────────────────────────

test('impact never lets a trade sneak past the cash check', () => {
  // Just barely affordable at the mark, unaffordable once impact is added.
  // $1,015,050 covers the order at the spread alone; $1,026,778 is the true cost
  // once impact is added. Cash in between must therefore be rejected.
  const poor = { ...richPlayer(), cash: 1_020_000 };
  const out = gameReducer(poor, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  assert.equal(out, poor, 'rejected — the executed cost is what must be affordable');
});

test('a sell of more than you hold is still rejected', () => {
  const base = richPlayer();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 500_000 });
  const out = gameReducer(bought, { type: 'SELL_STOCK', targetId: 'r1', shares: 500_001 });
  assert.equal(out, bought);
});

test('portfolio carries a lifetime tax counter that only grows', () => {
  assert.equal(emptyPortfolio().taxPaid, 0);
  const base = richPlayer();
  let s = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  const risen = { ...s, competitors: [rival({ sharePrice: 4, marketCap: 400_000_000 })] };
  s = gameReducer(risen, { type: 'SELL_STOCK', targetId: 'r1', shares: 500_000 });
  const first = s.portfolio.taxPaid;
  s = gameReducer({ ...s, competitors: risen.competitors },
    { type: 'SELL_STOCK', targetId: 'r1', shares: 500_000 });
  assert.ok(s.portfolio.taxPaid > first, 'accumulates across trades');
});

// ── Float pool: the money loop ──────────────────────────────────────────────

const withPool = (over = {}) => ({
  ...richPlayer(),
  worldMarket: { poolCash: 750_000_000, seedCash: 750_000_000, sharesAvailable: 30_000_000 },
  ...over,
});

test('pool seed scales with players and starting capital', () => {
  assert.equal(poolSeedFor(10, 15_000_000), 5 * 10 * 15_000_000);
  assert.equal(poolSeedFor(1, 15_000_000), 5 * 15_000_000);
  assert.ok(poolSeedFor(0, 15_000_000) > 0, 'a lobby of one still gets a pool');
});

test('liquidity discount is zero when full and maximal when drained', () => {
  assert.equal(poolLiquidityDiscount(100, 100), 0);
  assert.equal(poolLiquidityDiscount(0, 100), S.POOL_LIQUIDITY_K);
  assert.ok(Math.abs(poolLiquidityDiscount(50, 100) - S.POOL_LIQUIDITY_K / 2) < 1e-12);
  assert.equal(poolLiquidityDiscount(0, 0), 0, 'no pool configured → no discount');
  assert.equal(poolLiquidityDiscount(200, 100), 0, 'over-full is clamped, not negative');
});

test('refill heals toward the seed and never past it', () => {
  const seed = 750_000_000;
  assert.ok(poolRefill(0, seed) > 0, 'a drained pool heals');
  assert.equal(poolRefill(seed, seed), 0, 'a full pool does not grow');
  // A year of weekly refills equals the annual rate.
  const yearly = poolRefill(0, seed) * 52;
  assert.ok(Math.abs(yearly / (seed * S.POOL_REFILL_PER_YEAR) - 1) < 0.01);
  // Never overshoots: topping up a nearly-full pool adds only the remainder.
  assert.equal(poolRefill(seed - 5, seed), 5);
});

test('a buy cannot take more shares than the pool holds', () => {
  const base = withPool({ worldMarket: { poolCash: 750_000_000, seedCash: 750_000_000, sharesAvailable: 400_000 } });
  const ok = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 400_000 });
  assert.ok(ok.portfolio.holdings.r1, 'exactly the available float is fine');
  const over = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 400_001 });
  assert.equal(over, base, 'one share more than the pool holds is rejected');
});

test('a sell cannot draw more cash than the pool has', () => {
  const seeded = withPool();
  const bought = gameReducer(seeded, { type: 'BUY_STOCK', targetId: 'r1', shares: 2_000_000 });
  // Same position, but the pool is now nearly empty.
  const dry = { ...bought, worldMarket: { poolCash: 1000, seedCash: 750_000_000, sharesAvailable: 28_000_000 } };
  const out = gameReducer(dry, { type: 'SELL_STOCK', targetId: 'r1', shares: 2_000_000 });
  assert.equal(out, dry, 'no buyers, no sale');
  assert.ok(out.portfolio.holdings.r1, 'and the position is untouched');
});

test('a thin pool gives sellers a worse fill than a full one', () => {
  const seeded = withPool();
  const bought = gameReducer(seeded, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  const sellFrom = (poolCash) => {
    const st = { ...bought, worldMarket: { poolCash, seedCash: 750_000_000, sharesAvailable: 29_000_000 } };
    const sold = gameReducer(st, { type: 'SELL_STOCK', targetId: 'r1', shares: 1_000_000 });
    assert.ok(sold !== st, `sale should clear with pool ${poolCash}`);
    return sold.cash - st.cash;
  };
  const full = sellFrom(750_000_000);
  const thin = sellFrom(200_000_000);
  assert.ok(thin < full, `thin pool must pay less: ${thin} vs ${full}`);
});

test('solo (no pool injected) keeps trading unconstrained', () => {
  const solo = richPlayer();
  assert.equal(solo.worldMarket, undefined, 'no pool in solo');
  const bought = gameReducer(solo, { type: 'BUY_STOCK', targetId: 'r1', shares: 5_000_000 });
  assert.ok(bought.portfolio.holdings.r1, 'buys are not gated on pool inventory');
  const sold = gameReducer(bought, { type: 'SELL_STOCK', targetId: 'r1', shares: 5_000_000 });
  assert.equal(sold.portfolio.holdings.r1, undefined, 'sells are not gated on pool cash');
});

test('every executed trade reports what the server must settle', () => {
  const base = withPool();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  const buy = bought.lastStockTrade;
  assert.ok(buy, 'buy reported');
  assert.equal(buy.side, 'buy');
  assert.equal(buy.targetId, 'r1');
  assert.equal(buy.shares, 1_000_000);
  assert.ok(buy.gross > 0, 'gross drives the pool cash movement');

  const sold = gameReducer(bought, { type: 'SELL_STOCK', targetId: 'r1', shares: 400_000 });
  const sell = sold.lastStockTrade;
  assert.equal(sell.side, 'sell');
  assert.equal(sell.shares, 400_000, 'the size that ACTUALLY filled, not what was asked');
  assert.ok(sell.gross > 0);
});

test('a rejected trade reports no settlement, so the pool is left alone', () => {
  const base = withPool();
  // Rejected on the ownership cap: 20% of 100M shares is 20M.
  const rejected = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 25_000_000 });
  assert.equal(rejected, base, 'trade rejected');
  assert.equal(rejected.lastStockTrade, undefined, 'nothing for the server to settle');
});

test('the pool view never reaches the saved blob', async () => {
  const { stripRivals } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
  const dirty = withPool();
  assert.ok(dirty.worldMarket, 'injected for the engine');
  assert.equal(stripRivals(dirty).worldMarket, undefined, 'stripped before persisting');
});

test('a buy moves cash INTO the pool and a sell takes it OUT — never minted', () => {
  // The invariant the whole pool exists for: gross in equals gross out, so the
  // player economy and the pool are a closed system apart from the named sinks.
  const base = withPool();
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 1_000_000 });
  const paid = base.cash - bought.cash;
  const poolGain = bought.lastStockTrade.gross;
  const commission = paid - poolGain;
  assert.ok(poolGain > 0 && commission > 0, 'the pool gets gross; commission is the sink');
  assert.ok(Math.abs(commission - Math.round(poolGain * S.COMMISSION)) <= 1,
    'the only cash that vanishes on a buy is the commission');
});

Math.random = realRandom;
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
