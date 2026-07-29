// Private-company valuation — the "+8383.2% on a company that isn't listed" bug
// (Discord, 2026-07-29).
//
// A rival airline, still marked PRIVATE, showed a $0.5793 share price, a +8383.2%
// weekly move and a $57.93M market cap next to listed carriers on the Markets tab.
// Two defects met in that screenshot:
//
//   1. The weekly tick passed `prevMarketCap: null` for any airline with
//      `equity.isPublic === false`, which takes computeMarketCap's COLD branch —
//      no convergence, no move clamp, no noise. A private airline republished its
//      raw fair value every week while every listed airline was held to a band.
//      The reason was real (an IPO priced off a lagging series floats a quarter of
//      the company for a rounding error) but the fix published an internal number.
//      The fair value now lives on `state.fairValue` and the LISTING is priced off
//      it; the published cap is smoothed for everyone.
//   2. `MIN_MARKET_CAP` was a flat $500k, which against the 100M founder share
//      count is a $0.0050 share price. A leveraged startup — debt exceeding its
//      credited assets, so a NEGATIVE net book — pinned there for its first weeks
//      and then teleported by two orders of magnitude the week the earnings term
//      switched on. The floor is now proportional to GROSS assets.
//
// The single assertion that would have caught this: no published weekly move may
// ever exceed MOVE_CLAMP_MAX + NOISE_PCT, for ANY airline, listed or not.
//
//   node tools/private-valuation-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState, reconcileState } from '../packages/engine/src/reducer.mjs';
import {
  VALUATION, TOTAL_SHARES, computeMarketCap,
  emptyEquity, migratedEquity, sharesOf,
} from '../packages/engine/src/utils/market.js';
import { toHumanCompetitor } from '../apps/headwinds-server/src/lib/humanRivals.mjs';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); console.log('  ✓ ' + n); passed++; }
  catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; }
};

const M = 1_000_000;
// The true ceiling on a single week's published move. The clamp bounds the cap
// BEFORE noise is applied and the noise is multiplicative, so the two compound:
// (1 + 0.35) x (1 + 0.035) - 1 = 39.7%, not 38.5%. Worth stating exactly — an
// additive approximation here would have made this whole file pass by accident.
const BAND = (1 + VALUATION.MOVE_CLAMP_MAX) * (1 + VALUATION.NOISE_PCT) - 1;

const history = (weeks, profit, totalCost = 4_140_000) =>
  Array.from({ length: weeks }, () => ({ profit, totalCost, revenue: totalCost + profit }));

// Air Chicago as screenshotted: a young, private, profitable startup.
const airChicago = (over = {}) => ({
  ...freshState(),
  multiplayer: true,
  week: 12, year: 1,
  cash: 22_820_000,
  marketCap: 12_750_000,
  fairValue: 12_750_000,
  sharePrice: 0.1275,
  equity: emptyEquity(),
  financialHistory: history(12, 1_530_000),
  worldMarket: { poolCash: 300 * M, seedCash: 300 * M, sharesAvailable: 0, selfSharesHeld: 0 },
  ...over,
});

// ── 1. The invariant that would have caught it ───────────────────────────────

test('a private airline can never print a weekly move outside the band', () => {
  let s = airChicago();
  const caps = [s.marketCap];
  // Slam the fundamentals around week to week — a cash pile appearing and
  // vanishing is the crudest possible re-rating, and the published print still
  // has to walk there rather than teleport.
  for (let i = 0; i < 24; i++) {
    s = { ...s, cash: i % 2 === 0 ? 4 * M : 800 * M };
    s = gameReducer(s, {
      type: 'ADVANCE_WEEK',
      valuationNoise: i % 2 ? VALUATION.NOISE_PCT : -VALUATION.NOISE_PCT,
    });
    assert.equal(s.equity.isPublic, false, 'still private throughout');
    caps.push(s.marketCap);
  }
  for (let i = 1; i < caps.length; i++) {
    const move = Math.abs(caps[i] - caps[i - 1]) / caps[i - 1];
    assert.ok(move <= BAND + 1e-9,
      `week ${i} printed ${(move * 100).toFixed(1)}% — outside the ±${(BAND * 100).toFixed(1)}% band`);
  }
});

test('the same invariant still holds for a listed airline', () => {
  let s = { ...airChicago(), equity: migratedEquity() };
  for (let i = 0; i < 12; i++) {
    const prev = s.marketCap;
    s = { ...s, cash: i % 2 === 0 ? 4 * M : 800 * M };
    s = gameReducer(s, { type: 'ADVANCE_WEEK', valuationNoise: VALUATION.NOISE_PCT });
    const move = Math.abs(s.marketCap - prev) / prev;
    assert.ok(move <= BAND + 1e-9, `week ${i} printed ${(move * 100).toFixed(1)}%`);
  }
});

test('...and the test discriminates: the OLD cold-branch call blows straight past it', () => {
  // This is what the tick used to do for a private airline. Kept as a live
  // demonstration that the assertion above is not vacuous.
  const profits = history(12, 1_530_000).map(h => h.profit);
  const extras  = { fleetNAV: 44 * M, debt: 62 * M, revenueHint: 5_670_000 };
  const pinned  = computeMarketCap([], 1_200_000, 62, { ...extras, prevMarketCap: null });
  const rerated = computeMarketCap(profits, 22_820_000, 62, { ...extras, prevMarketCap: null });
  const move = (rerated.marketCap - pinned.marketCap) / pinned.marketCap;
  assert.ok(move > 5, `the unsmoothed path moves ${(move * 100).toFixed(0)}% in one step`);
  // ...and the smoothed path, given the same jump, does not.
  const smoothed = computeMarketCap(profits, 22_820_000, 62, {
    ...extras, prevMarketCap: pinned.marketCap,
  });
  const smoothMove = (smoothed.marketCap - pinned.marketCap) / pinned.marketCap;
  assert.ok(smoothMove <= BAND + 1e-9,
    `the smoothed path moved ${(smoothMove * 100).toFixed(1)}%`);
});

// ── 2. The floor is proportional to what the airline owns ────────────────────

test('a leveraged startup with negative net book no longer pins at $0.0050', () => {
  // Debt exceeds credited assets, so both fair-value terms are negative and the
  // floor is the only thing holding the valuation up.
  const r = computeMarketCap([], 2 * M, 50, {
    fleetNAV: 120 * M, debt: 200 * M, revenueHint: 6 * M, shares: TOTAL_SHARES,
  });
  assert.ok(r.netBook < 0, 'the airline really is underwater on book');
  assert.equal(r.fairValue, r.valueFloor, 'so the floor is what it prints');
  assert.ok(r.valueFloor > VALUATION.MIN_MARKET_CAP,
    'and the floor is asset-aware, not the flat $500k');
  const oldFloorPrice = VALUATION.MIN_MARKET_CAP / TOTAL_SHARES;
  assert.equal(oldFloorPrice.toFixed(4), '0.0050', 'the old floor really was half a cent');
  assert.ok(r.sharePrice > oldFloorPrice * 5,
    `printed $${r.sharePrice.toFixed(4)} against the old $${oldFloorPrice.toFixed(4)}`);
});

test('the floor scales with gross assets, and ignores debt', () => {
  const small = computeMarketCap([], 1 * M, 50, { fleetNAV: 20 * M, debt: 500 * M, revenueHint: 2 * M });
  const big   = computeMarketCap([], 1 * M, 50, { fleetNAV: 200 * M, debt: 500 * M, revenueHint: 2 * M });
  assert.ok(big.valueFloor > small.valueFloor * 5, 'ten times the fleet, a much higher floor');
  assert.ok(Math.abs(big.valueFloor - VALUATION.ASSET_FLOOR_FRAC * big.grossAssets) < 1,
    'the floor is exactly ASSET_FLOOR_FRAC of gross assets');
});

test('a company that owns nothing still cannot print below the absolute floor', () => {
  const r = computeMarketCap([], 1000, 0, {});
  assert.equal(r.valueFloor, VALUATION.MIN_MARKET_CAP);
  assert.ok(r.marketCap >= VALUATION.MIN_MARKET_CAP);
});

test('the floor never lifts a healthy airline — it only catches a falling one', () => {
  const r = computeMarketCap(history(12, 3 * M).map(h => h.profit), 80 * M, 70, {
    fleetNAV: 150 * M, debt: 40 * M, revenueHint: 12 * M,
  });
  assert.ok(r.fairValue > r.valueFloor * 2, 'a solvent airline prices well clear of its floor');
});

// ── 3. The fair value is kept, not published ─────────────────────────────────

test('the tick records a fair value that is genuinely separate from the print', () => {
  // Deliberately stronger than "the field exists": pre-fix, a private airline's
  // published cap WAS its fair value, so any assertion the two can diverge is the
  // one that discriminates. A fast-growing airline must outrun its own print.
  let s = airChicago({ financialHistory: history(24, 6 * M), week: 30, year: 2 });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(Number.isFinite(s.fairValue) && Number.isFinite(s.marketCap), 'both are written');
  assert.ok(s.fairValue > s.marketCap * 1.5,
    `fair value $${(s.fairValue / M).toFixed(0)}M vs a print of $${(s.marketCap / M).toFixed(0)}M`);
});

test('a private airline writes no share price into its history', () => {
  const out  = gameReducer(airChicago(), { type: 'ADVANCE_WEEK' });
  const last = out.statsHistory[out.statsHistory.length - 1];
  assert.equal(last.sharePrice, null,
    'no quote while private — there is no market in it to quote');
});

test('the rival payload therefore carries no private price series', () => {
  const priced = gameReducer(airChicago(), { type: 'ADVANCE_WEEK' });
  const view = toHumanCompetitor({
    id: 'a1', name: 'Air Chicago', hub: 'ORD', account: {}, state: priced,
  });
  assert.equal(view.isPublic, false, 'rivals are told it is private');
  assert.ok((view.sharePriceHistory ?? []).every((v) => v === null),
    'and there is no numeric price history for a client to chart or diff');
});

// ── 4. The IPO stays honest — the reason the null was there in the first place ──

test('a listing is priced off fair value, not off the smoothed print', () => {
  // Let the airline grow well past its print, the way a real startup does.
  let s = airChicago({ financialHistory: history(24, 6 * M), week: 30, year: 2 });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(s.fairValue > s.marketCap * 1.5, 'fair value has outrun the smoothed print');
  const fairPrice = s.fairValue / sharesOf(s);
  const out   = gameReducer(s, { type: 'GO_PUBLIC', shares: 20 * M });
  assert.ok(out !== s, 'the listing went through');
  const offer = out.lastEquityAction.pricePerShare;
  assert.ok(offer <= fairPrice + 1e-9, 'never above fair value');
  assert.ok(offer > fairPrice * 0.5, `offered $${offer.toFixed(4)} against a fair $${fairPrice.toFixed(4)}`);
  assert.ok(offer > s.marketCap / sharesOf(s),
    'and comfortably above what the lagging print alone would have raised');
});

test('the first print after listing does not gap away from the offer', () => {
  let s = airChicago({ financialHistory: history(24, 6 * M), week: 30, year: 2 });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const out   = gameReducer(s, { type: 'GO_PUBLIC', shares: 20 * M });
  const offer = out.lastEquityAction.pricePerShare;
  assert.ok(Math.abs(out.sharePrice - offer) / offer < 0.15,
    `first print $${out.sharePrice.toFixed(4)} vs offer $${offer.toFixed(4)}`);
  assert.equal(out.equity.isPublic, true);
});

// ── 5. Old saves ─────────────────────────────────────────────────────────────

test('a save written before fairValue existed gets one from its own print', () => {
  const blob = { ...freshState(), marketCap: 41_000_000, sharePrice: 0.41 };
  delete blob.fairValue;
  const loaded = reconcileState(JSON.parse(JSON.stringify(blob)));
  assert.equal(loaded.fairValue, 41_000_000,
    'starts at the published cap, so nothing moves at the migration');
});

test('a save that already has one keeps it', () => {
  const blob = { ...freshState(), marketCap: 41_000_000, fairValue: 96_000_000 };
  const loaded = reconcileState(JSON.parse(JSON.stringify(blob)));
  assert.equal(loaded.fairValue, 96_000_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
