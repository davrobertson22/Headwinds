// Float-pool ledger + availability visibility.
//
// Regression suite for the "someone already bought those shares" bug class:
//
//   • the pool ledger was keyed by `human:<id>` for trades but the raw DB id
//     for capital actions, splitting one airline's inventory across two entries
//   • dividends looked holders up under the raw id while portfolios key by the
//     competitor id, so rival shareholders never received a cent
//   • the CLIENT had no view of pool inventory at all, so its optimistic buy
//     "succeeded", then reversed when the server 409'd — with the reason
//     flashing too fast to read
//
//   node tools/market-pool-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { emptyPortfolio } from '../packages/engine/src/utils/market.js';
import {
  poolKeyOf, poolSharesFor, marketViewFor, applyTradeToPoolTx,
  applyCapitalActionToPoolTx, holdersOf, MarketError,
} from '../apps/headwinds-server/src/lib/marketService.mjs';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };
const testAsync = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };

const realRandom = Math.random;
Math.random = () => 0.5;

const rival = (over = {}) => ({
  id: 'human:abc', name: 'Target Air', marketCap: 100_000_000,
  shares: 100_000_000, founderShares: 70_000_000, sharePrice: 1, ...over,
});
const marketRow = (over = {}) => ({
  id: 'm1', worldId: 'w1', poolCash: 500_000_000, seedCash: 500_000_000,
  holdings: {}, version: 3, ...over,
});

// A mock transaction that records the updateMany and reports `count` matches.
const mockTx = (count = 1) => {
  const calls = [];
  return {
    calls,
    worldMarket: { updateMany: async (args) => { calls.push(args); return { count }; } },
  };
};

console.log('\npool ledger keys');

test('poolKeyOf strips the competitor prefix and leaves raw ids alone', () => {
  assert.equal(poolKeyOf('human:abc'), 'abc');
  assert.equal(poolKeyOf('abc'), 'abc');
  assert.equal(poolKeyOf(null), '');
});

test('poolSharesFor reads canonical, legacy-prefixed, and fallback in that order', () => {
  const target = rival();
  assert.equal(poolSharesFor(marketRow({ holdings: { abc: 5 } }), 'human:abc', target), 5, 'canonical');
  assert.equal(poolSharesFor(marketRow({ holdings: { 'human:abc': 7 } }), 'human:abc', target), 7, 'legacy');
  assert.equal(poolSharesFor(marketRow({ holdings: { abc: 5, 'human:abc': 7 } }), 'human:abc', target), 5, 'canonical wins');
  assert.equal(poolSharesFor(marketRow(), 'human:abc', target), 30_000_000, 'untouched → free float');
  assert.equal(poolSharesFor(marketRow(), 'abc', target), 30_000_000, 'raw id, same answer');
});

test('a PRIVATE airline (full founder block) has no pool inventory to fall back to', () => {
  const priv = rival({ founderShares: 100_000_000, isPublic: false });
  assert.equal(poolSharesFor(marketRow(), 'human:abc', priv), 0);
  assert.equal(marketViewFor(marketRow(), priv).sharesAvailable, 0);
});

await testAsync('a trade write lands under the canonical key and migrates the legacy one', async () => {
  const tx = mockTx();
  await applyTradeToPoolTx(tx, {
    market: marketRow({ holdings: { 'human:abc': 10_000_000 } }),
    trade: { targetId: 'human:abc', side: 'buy', shares: 1_000_000, gross: 1_000_000 },
    targetState: rival(),
  });
  const { data, where } = tx.calls[0];
  assert.equal(data.holdings.abc, 9_000_000, 'canonical key written');
  assert.ok(!('human:abc' in data.holdings), 'legacy key removed');
  assert.equal(where.version, 3, 'compare-and-set on the version read');
});

await testAsync('a buy larger than the pool inventory throws 409, never oversells', async () => {
  await assert.rejects(
    () => applyTradeToPoolTx(mockTx(), {
      market: marketRow({ holdings: { abc: 100 } }),
      trade: { targetId: 'human:abc', side: 'buy', shares: 101, gross: 101 },
      targetState: rival(),
    }),
    (e) => e instanceof MarketError && e.status === 409,
  );
});

await testAsync('a lost compare-and-set throws 409 instead of double-spending the pool', async () => {
  await assert.rejects(
    () => applyTradeToPoolTx(mockTx(0), {
      market: marketRow(),
      trade: { targetId: 'human:abc', side: 'buy', shares: 1_000_000, gross: 1_000_000 },
      targetState: rival(),
    }),
    (e) => e instanceof MarketError && e.status === 409,
  );
});

await testAsync('capital actions settle into the SAME ledger entry trades read', async () => {
  const tx = mockTx();
  await applyCapitalActionToPoolTx(tx, {
    market: marketRow({ holdings: { 'human:abc': 2_000_000 } }),
    action: { kind: 'buyback', shares: 500_000, gross: 500_000 },
    airlineId: 'abc',
    selfBefore: { shares: 100_000_000, founderShares: 70_000_000 },
  });
  const { data } = tx.calls[0];
  assert.equal(data.holdings.abc, 1_500_000, 'buyback retired out of the trade-facing inventory');
  assert.ok(!('human:abc' in data.holdings), 'legacy key removed');
});

console.log('\ndividend holders');

test('holdersOf finds portfolios keyed by the competitor id', () => {
  const airlines = [
    { id: 'abc', state: {} },   // the payer
    { id: 'def', state: { portfolio: { holdings: { 'human:abc': { shares: 3_000_000 } } } } },
    { id: 'ghi', state: { portfolio: { holdings: { abc: { shares: 1_000_000 } } } } },
    { id: 'jkl', state: { portfolio: { holdings: { 'human:zzz': { shares: 9 } } } } },
  ];
  const out = holdersOf(airlines, 'abc');
  assert.deepEqual(
    out.map((h) => [h.airlineId, h.shares]).sort(),
    [['def', 3_000_000], ['ghi', 1_000_000]],
  );
});

console.log('\nengine availability caps (the optimistic client path)');

const richPlayer = (over = {}) => ({
  ...freshState(), cash: 2_000_000_000, marketCap: 10_000_000_000,
  competitors: [rival()], ...over,
});

test('a buy over the rival view poolShares is rejected locally, matching the server', () => {
  const s = richPlayer({ competitors: [rival({ poolShares: 5_000_000 })] });
  const over = gameReducer(s, { type: 'BUY_STOCK', targetId: 'human:abc', shares: 6_000_000 });
  assert.equal(over, s, 'over the pool inventory → no-op');
  const ok = gameReducer(s, { type: 'BUY_STOCK', targetId: 'human:abc', shares: 4_000_000 });
  assert.equal(ok.portfolio.holdings['human:abc'].shares, 4_000_000, 'within inventory → fills');
});

test('a sold-out rival (poolShares 0) cannot be bought at all', () => {
  const s = richPlayer({ competitors: [rival({ poolShares: 0 })] });
  assert.equal(gameReducer(s, { type: 'BUY_STOCK', targetId: 'human:abc', shares: 1_000_000 }), s);
});

test('a privately held rival cannot be bought', () => {
  const s = richPlayer({ competitors: [rival({ isPublic: false })] });
  assert.equal(gameReducer(s, { type: 'BUY_STOCK', targetId: 'human:abc', shares: 1_000_000 }), s);
});

test('solo (no poolShares on the payload) keeps the legacy unbounded counterparty', () => {
  const s = richPlayer();
  const next = gameReducer(s, { type: 'BUY_STOCK', targetId: 'human:abc', shares: 1_000_000 });
  assert.equal(next.portfolio.holdings['human:abc'].shares, 1_000_000);
});

test('a sale the pool cannot fund is rejected via the injected stockPool summary', () => {
  const base = richPlayer({
    portfolio: {
      ...emptyPortfolio(),
      holdings: { 'human:abc': { shares: 10_000_000, costBasis: 10_000_000, name: 'Target Air', lastPrice: 1 } },
    },
  });
  const dry = { ...base, stockPool: { poolCash: 1_000, seedCash: 500_000_000 } };
  assert.equal(gameReducer(dry, { type: 'SELL_STOCK', targetId: 'human:abc', shares: 5_000_000 }), dry, 'pool cash short → no-op');
  const wet = { ...base, stockPool: { poolCash: 500_000_000, seedCash: 500_000_000 } };
  const next = gameReducer(wet, { type: 'SELL_STOCK', targetId: 'human:abc', shares: 5_000_000 });
  assert.equal(next.portfolio.holdings['human:abc'].shares, 5_000_000, 'funded → fills');
});

Math.random = realRandom;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
