// Buybacks against a pool other players have bought into.
//
// Discord, Kat the Fox 2026-11-12 ("Stock buyback appears broken"): Caldoren on
// Timely Takeoff has a 1.47M public float, a rival holds 1,458,596 of it, and
// the pool holds the last 10,000. The engine refused every buyback above 10,000
// (correctly) but the Stocks card offered up to the whole float, the client's
// optimistic run accepted it, and the server explained only an EMPTY pool — so
// the cash came off and silently came back. The rules now live in one place
// (buybackLimits / buybackRefusal) for the reducer, the 409 and the card.
//
//   node --import ./tools/_register-loader.mjs tools/buyback-limits-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import * as market from '../packages/engine/src/utils/market.js';
import { CapitalActions } from '../src/components/StockMarket.jsx';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };

const history = (weeks) => Array.from({ length: weeks }, () => ({ profit: 2_000_000, totalCost: 5_000_000 }));

// Caldoren's shape: 100M founder block, 1,468,596 public, 10,000 left in the pool.
const caldoren = (pool = { poolCash: 900_000_000, seedCash: 900_000_000, selfShares: 10_000 }) => ({
  ...freshState(),
  multiplayer: true,
  cash: 500_000_000, week: 30, year: 1,
  marketCap: 101_468_596 * 5, fairValue: 101_468_596 * 5, sharePrice: 5,
  financialHistory: history(52),
  equity: { ...market.migratedEquity(), isPublic: true, shares: 101_468_596, founderShares: 100_000_000,
            buybacksThisYear: 0, buybacksEver: 0 },
  stockPool: pool,
});

console.log('\n── Buybacks against a bought-up pool ───────────────────');

test('the client\'s optimistic run refuses what the pool does not hold', () => {
  // Before the fix the client had no pool inventory, so this "succeeded" and the
  // server's authoritative state reverted it with no message.
  const base = caldoren();
  assert.equal(gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 50_000 }), base,
    'a 50,000-share buyback against a 10,000-share pool is refused locally');
  assert.notEqual(gameReducer(base, { type: 'BUY_BACK_SHARES', shares: 10_000 }), base,
    'the 10,000 the pool does hold can be retired');
});

test('the refusal names the shortfall', () => {
  const why = market.buybackRefusal(caldoren(), 50_000);
  assert.equal(why?.code, 'pool');
  assert.match(why.message, /Only 10,000 of your shares are on the market/);
  assert.match(why.message, /other investors hold the other 1,458,596/);
  assert.equal(market.buybackRefusal(caldoren(), 10_000), null);
});

test('the server-side view (worldMarket) wins over the overlay', () => {
  const s = { ...caldoren(), worldMarket: { poolCash: 1, seedCash: 1, sharesAvailable: 0, selfSharesHeld: 0 } };
  assert.match(market.buybackRefusal(s, 1)?.message ?? '', /None of your shares are on the market/);
});

test('every reducer refusal has a reason, and every reason is a reducer refusal', () => {
  const cases = [
    [{ ...caldoren(), equity: { ...caldoren().equity, isPublic: false } }, 5, 'private'],
    [caldoren({ poolCash: 1, seedCash: 1, selfShares: 5_000_000 }), 2_000_000, 'founder'],
    [{ ...caldoren({ poolCash: 1, seedCash: 1, selfShares: 5_000_000 }), equity: { ...caldoren().equity, buybacksThisYear: 15_219_000 } }, 2_000, 'allowance'],
    [caldoren(), 10_001, 'pool'],
    [{ ...caldoren(), cash: 20_030_000 }, 10_000, 'cover'],
  ];
  for (const [s, n, code] of cases) {
    assert.equal(market.buybackRefusal(s, n)?.code, code, `${code}: reason`);
    assert.equal(gameReducer(s, { type: 'BUY_BACK_SHARES', shares: n }), s, `${code}: refused`);
  }
});

test('the largest buyback the card offers is one the reducer executes', () => {
  for (const s of [caldoren(), { ...caldoren(), cash: 20_030_000 }, caldoren({ poolCash: 1, seedCash: 1, selfShares: 5_000_000 })]) {
    const { max } = market.buybackLimits(s);
    assert.ok(max > 0);
    assert.notEqual(gameReducer(s, { type: 'BUY_BACK_SHARES', shares: max }), s, `max ${max} executes`);
    assert.equal(gameReducer(s, { type: 'BUY_BACK_SHARES', shares: max + 1 }), s, `max+1 is refused`);
  }
});

test('single-player (no pool at all) is unchanged', () => {
  const s = { ...caldoren(), stockPool: null, multiplayer: false };
  assert.equal(market.buybackLimits(s).pool, null);
  assert.notEqual(gameReducer(s, { type: 'BUY_BACK_SHARES', shares: 50_000 }), s);
});

test('the Stocks card shows what is on the market and caps at it', () => {
  const html = renderToString(React.createElement(CapitalActions, { state: caldoren(), dispatch: () => {} }));
  assert.ok(html.includes('On the market'), 'the pool inventory row renders');
  assert.ok(html.includes('Most you can retire now'), 'the cap row renders');
  assert.match(html, /Most you can retire now.*?10,000/s, 'capped at the 10,000 the pool holds, not the 15.2M allowance');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
