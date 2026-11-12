// Equity capital for everyone, not just whoever lists first.
//
// Kadicuss, Discord 2026-11-11: "only one airline gets to go public for their
// full valuation … for the other airlines they can only go public with the cash
// available on the market, which is not much." True as built: a world's float
// pool was seeded once at 5 x players x starting capital, a listing could take
// ALL of it, and it refilled 2% of the seed a year. The first big IPO in a
// 20-player world took ~$1B — the whole pool — and nobody after could raise.
//
// Three changes, all three applying to live worlds:
//   A. One offering (IPO or follow-on) may take at most POOL_OFFERING_SHARE_MAX
//      of the investor cash in the pool at the time.
//   B. The pool grows with the world: each week the seed moves toward
//      POOL_WORLD_VALUE_SHARE of the total value of the world's airlines (at most
//      POOL_SEED_GROWTH_MAX_WEEKLY a week, never shrinking), and the new
//      investors' money arrives in the pool with it.
//   C. A drained pool refills POOL_REFILL_PER_YEAR of the seed a game year
//      (was 2%).
//
//   node --import ./tools/_register-loader.mjs tools/float-pool-liquidity-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import * as M from '../packages/engine/src/utils/market.js';
import * as MS from '../apps/headwinds-server/src/lib/marketService.mjs';
import { CapitalActions } from '../src/components/StockMarket.jsx';
import { formatMoney } from '../src/utils/simulation.js';

const { STOCK_MARKET: S, emptyEquity, migratedEquity, ipoOffering, poolRefill, TOTAL_SHARES } = M;

let passed = 0, failed = 0;
const report = (n, e) => {
  if (!e) { console.log('  ✓ ' + n); passed++; return; }
  console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++;
};
const test = (n, fn) => { try { fn(); report(n); } catch (e) { report(n, e); } };
const testAsync = async (n, fn) => { try { await fn(); report(n); } catch (e) { report(n, e); } };

const B = 1_000_000_000;
const history = (weeks) => Array.from({ length: weeks }, () => ({ profit: 50_000_000, totalCost: 200_000_000, revenue: 250_000_000 }));
const pool = (poolCash, seedCash = B) => ({ poolCash, seedCash, sharesAvailable: 0, selfSharesHeld: 0 });

// A $5B airline, old enough to list, in front of a $1B pool.
const bigPrivate = (over = {}) => ({
  ...freshState(),
  cash: 500_000_000, week: 30, year: 1, multiplayer: true,
  marketCap: 5 * B, fairValue: 5 * B, sharePrice: 50,
  financialHistory: history(52),
  equity: emptyEquity(),
  worldMarket: pool(B),
  ...over,
});
const bigListed = (over = {}) => bigPrivate({ equity: migratedEquity(), ...over });
const float35 = () => ipoOffering(TOTAL_SHARES, 0.35, 0).newShares;

console.log('\n── A. One offering cannot empty the pool ────────────────');

test('a big IPO takes at most a quarter of the pool, not all of it', () => {
  const s = bigPrivate();
  const out = gameReducer(s, { type: 'GO_PUBLIC', shares: float35() });
  assert.ok(out !== s, 'the listing still happens (partially filled)');
  const gross = out.lastEquityAction.gross;
  assert.ok(gross <= B * 0.25 + 1, `raised ${formatMoney(gross)} from a ${formatMoney(B)} pool`);
  assert.ok(gross >= B * 0.24, `but close to the limit, got ${formatMoney(gross)}`);
});

test('a big follow-on offering is held to the same limit', () => {
  const s = bigListed();
  const out = gameReducer(s, { type: 'ISSUE_SHARES', shares: 14_000_000 });
  assert.ok(out !== s, 'the offering still happens');
  const gross = out.lastEquityAction.gross;
  assert.ok(gross <= B * 0.25 + 1, `raised ${formatMoney(gross)} from a ${formatMoney(B)} pool`);
});

test('the second airline to list still finds investors', () => {
  const first = gameReducer(bigPrivate(), { type: 'GO_PUBLIC', shares: float35() });
  const left = B - first.lastEquityAction.gross;
  const s2 = bigPrivate({ airlineName: 'Second', worldMarket: pool(left) });
  const second = gameReducer(s2, { type: 'GO_PUBLIC', shares: float35() });
  assert.ok(second !== s2, 'the second listing is not shut out');
  assert.ok(second.lastEquityAction.gross >= left * 0.24, `second raised ${formatMoney(second.lastEquityAction.gross ?? 0)} of ${formatMoney(left)} left`);
});

test('a listing smaller than the limit fills in full, as before', () => {
  const s = bigPrivate({ marketCap: 100_000_000, fairValue: 100_000_000, sharePrice: 1, worldMarket: pool(750_000_000) });
  const out = gameReducer(s, { type: 'GO_PUBLIC', shares: 20_000_000 });
  assert.equal(out.lastEquityAction.shares, 20_000_000);
});

test('the IPO card quotes the per-offering limit, not the whole pool', () => {
  const s = bigPrivate({ stockPool: { poolCash: B, seedCash: B } });
  delete s.worldMarket;
  const html = renderToString(React.createElement(CapitalActions, { state: s, dispatch: () => {} }));
  assert.ok(html.includes(formatMoney(B * 0.25)), `card should name the ${formatMoney(B * 0.25)} limit`);
});

console.log('\n── B. The pool grows with the world ─────────────────────');

const fakePrisma = (row) => {
  const db = { market: { id: 'm1', worldId: 'w1', version: 0, holdings: {}, ...row } };
  return {
    db,
    worldMarket: {
      findUnique: async () => ({ ...db.market }),
      update: async ({ data }) => { Object.assign(db.market, data); return { ...db.market }; },
    },
  };
};
const n = (v) => Number(v);

await testAsync('a full pool in a world worth $20B takes on new investors, a step at a time', async () => {
  const p = fakePrisma({ poolCash: BigInt(B), seedCash: BigInt(B) });
  await MS.refillWorldMarket(p, 'w1', { log: console, worldValue: 20 * B });
  assert.ok(n(p.db.market.seedCash) > B, `seed grew (${formatMoney(n(p.db.market.seedCash))})`);
  assert.ok(n(p.db.market.seedCash) <= B * 1.1 + 1, 'by at most 10% in a week');
  assert.ok(n(p.db.market.poolCash) > B, 'and the new money is in the pool');
});

await testAsync('it settles at 15% of world value and never overfills', async () => {
  const p = fakePrisma({ poolCash: BigInt(B), seedCash: BigInt(B) });
  for (let w = 0; w < 60; w++) await MS.refillWorldMarket(p, 'w1', { log: console, worldValue: 20 * B });
  assert.ok(Math.abs(n(p.db.market.seedCash) - 3 * B) <= 1000, `seed ${formatMoney(n(p.db.market.seedCash))}, expected $3B`);
  assert.ok(n(p.db.market.poolCash) <= n(p.db.market.seedCash), 'pool cash never exceeds the seed');
});

await testAsync('a small world keeps its starting pool: the seed never shrinks', async () => {
  const p = fakePrisma({ poolCash: BigInt(B), seedCash: BigInt(B) });
  await MS.refillWorldMarket(p, 'w1', { log: console, worldValue: 2 * B });
  assert.equal(n(p.db.market.seedCash), B);
  assert.equal(n(p.db.market.poolCash), B);
});

test('world value is the sum of the living airlines\' valuations', () => {
  assert.equal(typeof MS.worldEquityValue, 'function', 'marketService exports worldEquityValue');
  assert.equal(MS.worldEquityValue([
    { marketCap: 3 * B }, { marketCap: 2 * B }, { marketCap: 9 * B, bankrupt: true }, { marketCap: NaN }, { marketCap: -5 },
  ]), 5 * B);
});

test('the tick hands the world value to the weekly pool update', () => {
  const src = fs.readFileSync(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  assert.match(src, /refillWorldMarket\(prisma, world\.id, \{[^}]*worldValue/);
});

console.log('\n── C. A drained pool comes back within a few years ──────');

test('a drained pool refills a third or more of its seed in a game year', () => {
  const yearly = poolRefill(0, B) * 52;
  assert.ok(yearly >= B / 3, `refilled ${formatMoney(yearly)} of ${formatMoney(B)} in a year`);
  assert.equal(poolRefill(B, B), 0, 'a full pool does not refill');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
