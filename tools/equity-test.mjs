// Capital markets Phase 2 — per-airline share counts and the SVPS leaderboard.
//
// The point of this suite is the keystone property: while every airline shares one
// founder share count, ranking on SVPS is arithmetically IDENTICAL to ranking on
// market cap — which is what makes switching the win condition safe mid-world. It
// also proves the pieces that let the two orderings diverge later (per-airline
// share counts) actually read per-airline instead of a global constant.
//
//   node tools/equity-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState, reconcileState } from '../packages/engine/src/reducer.mjs';
import {
  computeMarketCap, emptyEquity, migratedEquity, sharesOf, svpsOf, svpsScore, freeFloatOf,
  TOTAL_SHARES, SVPS_SCALE, STOCK_MARKET,
} from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };

const realRandom = Math.random;
Math.random = () => 0.5;

// ── The equity block ─────────────────────────────────────────────────────────

test('a new airline is incorporated PRIVATE and entirely closely held', () => {
  const e = emptyEquity();
  assert.equal(e.shares, TOTAL_SHARES);
  assert.equal(e.founderShares, TOTAL_SHARES, 'every share is in the founder block');
  assert.equal(freeFloatOf({ equity: e }), 0, 'nothing to trade until it lists');
  assert.equal(e.isPublic, false);
  assert.equal(e.cumDividendsPerShare, 0);
  assert.equal(e.ipoWeek, null);
});

test('an airline predating the rework migrates as LISTED, with a float', () => {
  const g = migratedEquity();
  assert.equal(g.isPublic, true, 'live worlds keep trading through the deploy');
  assert.equal(g.shares, TOTAL_SHARES, 'same share count it was implicitly on');
  const float = freeFloatOf({ equity: g });
  assert.ok(float > 0, 'it already had a tradable float');
  assert.equal(float, Math.round(TOTAL_SHARES * STOCK_MARKET.DEFAULT_FREE_FLOAT_PCT));
  assert.ok(float / g.shares > STOCK_MARKET.MAX_OWNERSHIP_PCT,
    'float must exceed one player\'s max stake, or a single buyer corners it');
});

test('freshState carries an equity block and a starting SVPS', () => {
  const s = freshState();
  assert.ok(s.equity, 'state.equity exists');
  assert.equal(s.equity.isPublic, false, 'a brand-new airline is private');
  assert.equal(sharesOf(s), TOTAL_SHARES);
  assert.ok(Math.abs(s.svps - s.sharePrice) < 1e-12, 'no dividends yet, so SVPS === share price');
  assert.ok(s.svps > 0, 'a new airline has a positive per-share value');
});

test('sharesOf reads state.equity, a rival payload, or falls back safely', () => {
  assert.equal(sharesOf({ equity: { shares: 42_000_000 } }), 42_000_000, 'own state');
  assert.equal(sharesOf({ shares: 7_000_000 }), 7_000_000, 'flat rival payload');
  assert.equal(sharesOf({}), TOTAL_SHARES, 'missing → founder count');
  assert.equal(sharesOf(null), TOTAL_SHARES, 'null → founder count');
  assert.equal(sharesOf({ shares: 0 }), TOTAL_SHARES, 'zero is not a valid float');
  assert.equal(sharesOf({ shares: -5 }), TOTAL_SHARES, 'negative is not a valid float');
  assert.equal(sharesOf({ shares: NaN }), TOTAL_SHARES, 'NaN → founder count');
  // The equity block wins over a stale flat field.
  assert.equal(sharesOf({ equity: { shares: 5 }, shares: 999 }), 5);
});

// ── SVPS ─────────────────────────────────────────────────────────────────────

test('SVPS is share price plus lifetime dividends per share', () => {
  assert.equal(svpsOf({ sharePrice: 0.15, equity: { cumDividendsPerShare: 0.02 } }).toFixed(4), '0.1700');
  assert.equal(svpsOf({ sharePrice: 0.15 }).toFixed(4), '0.1500', 'no dividend history → just the price');
  assert.equal(svpsOf({ sharePrice: 2, cumDividendsPerShare: 0.5 }), 2.5, 'flat payload shape');
  assert.equal(svpsOf({}), 0, 'nothing known → 0');
  assert.equal(svpsOf({ sharePrice: NaN, equity: { cumDividendsPerShare: NaN } }), 0);
});

test('dividends are rank-neutral by construction, not rank-negative', () => {
  // Two identical airlines. One paid $0.03/share out; its price is lower by
  // exactly that, because the cash left the company. Under market cap the payer
  // loses. Under SVPS the add-back makes them equal — which is the whole point.
  const hoarder = { sharePrice: 0.20, equity: { cumDividendsPerShare: 0 } };
  const payer   = { sharePrice: 0.17, equity: { cumDividendsPerShare: 0.03 } };
  assert.ok(svpsOf(payer) > svpsOf(hoarder) - 1e-12, 'the payer is not punished');
  assert.ok(Math.abs(svpsOf(payer) - svpsOf(hoarder)) < 1e-12, 'and is exactly level');
});

test('svpsScore packs dollars into an integer without losing cents', () => {
  assert.equal(svpsScore(0.1275), Math.round(0.1275 * SVPS_SCALE));
  assert.equal(svpsScore(0.1275), 1275);
  assert.equal(svpsScore(27.5), 275_000);
  assert.equal(svpsScore(0), 0);
  assert.equal(svpsScore(NaN), 0, 'never emit NaN into a BigInt column');
  assert.equal(svpsScore(undefined), 0);
  assert.ok(Number.isInteger(svpsScore(1 / 3)), 'always an integer');
});

// ── The keystone: rank neutrality at a uniform share count ───────────────────

test('with a uniform share count, SVPS order IS market-cap order', () => {
  const caps = [5_000_000, 912_000_000, 2_744_000_000, 41_000_000, 500_000];
  const rows = caps.map((cap, i) => ({
    id: `a${i}`,
    cap,
    svps: svpsOf({ sharePrice: cap / TOTAL_SHARES, equity: emptyEquity() }),
  }));
  const byCap  = [...rows].sort((a, b) => b.cap - a.cap).map((r) => r.id).join(',');
  const bySvps = [...rows].sort((a, b) => b.svps - a.svps).map((r) => r.id).join(',');
  assert.equal(bySvps, byCap, 'nobody may move rank on the day the metric changes');
});

test('once share counts differ, the two orderings are allowed to disagree', () => {
  // A: a $1B airline that issued its way to 400M shares → $2.50/share.
  // B: a $600M airline still on the founder 100M count → $6.00/share.
  // Market cap says A wins. Per-share value says B does — correctly, because A's
  // shareholders own a quarter as much of each dollar of business.
  const a = { id: 'A', cap: 1_000_000_000, shares: 400_000_000 };
  const b = { id: 'B', cap:   600_000_000, shares: TOTAL_SHARES };
  const svpsA = svpsOf({ sharePrice: a.cap / a.shares });
  const svpsB = svpsOf({ sharePrice: b.cap / b.shares });
  assert.ok(a.cap > b.cap, 'A is the bigger airline');
  assert.ok(svpsB > svpsA, 'B is the better airline per share');
});

// ── computeMarketCap divides by the airline's own share count ────────────────

test('share price uses the supplied share count, defaulting to the founder count', () => {
  const cap = (shares) => computeMarketCap([], 15_000_000, 50, shares ? { shares } : {});
  assert.ok(Math.abs(cap().sharePrice - 12_750_000 / TOTAL_SHARES) < 1e-12, 'default');
  assert.ok(Math.abs(cap(5_000_000).sharePrice - 12_750_000 / 5_000_000) < 1e-9, 'per-airline');
  // Halving the float doubles the price for the same business.
  assert.ok(Math.abs(cap(50_000_000).sharePrice / cap(TOTAL_SHARES).sharePrice - 2) < 1e-9);
});

test('a degenerate share count cannot produce Infinity or NaN', () => {
  for (const shares of [0, -1, NaN, undefined, null]) {
    const r = computeMarketCap([], 15_000_000, 50, { shares });
    assert.ok(Number.isFinite(r.sharePrice), `sharePrice finite for shares=${shares}`);
    assert.ok(r.sharePrice > 0, `sharePrice positive for shares=${shares}`);
  }
});

// ── Old saves migrate transparently ─────────────────────────────────────────

test('reconcileState seeds equity + svps for a pre-rework save', () => {
  const old = { ...freshState(), marketCap: 20_000_000, sharePrice: 0.2 };
  delete old.equity;
  delete old.svps;
  const fixed = reconcileState(JSON.parse(JSON.stringify(old)));
  assert.ok(fixed.equity, 'equity block created');
  assert.equal(sharesOf(fixed), TOTAL_SHARES, 'incorporated at the founder count');
  assert.equal(fixed.equity.isPublic, true, 'a pre-rework save was already trading');
  assert.ok(Math.abs(fixed.svps - 0.2) < 1e-12, 'SVPS reproduces the pre-rework share price exactly');
});

test('reconcileState preserves an equity block that already moved', () => {
  const s = { ...freshState(), sharePrice: 0.5 };
  s.equity = { ...emptyEquity(), shares: 120_000_000, cumDividendsPerShare: 0.04, isPublic: false };
  delete s.svps;
  const fixed = reconcileState(JSON.parse(JSON.stringify(s)));
  assert.equal(sharesOf(fixed), 120_000_000, 'a real share count is never clobbered');
  assert.equal(fixed.equity.cumDividendsPerShare, 0.04, 'dividend history survives');
  assert.equal(fixed.equity.isPublic, false, 'listing status survives');
  assert.ok(Math.abs(fixed.svps - 0.54) < 1e-12, 'SVPS includes the dividends already paid');
});

test('reconcileState fills gaps in a partial equity block', () => {
  const s = { ...freshState() };
  s.equity = { shares: 80_000_000 };   // nothing else set
  const fixed = reconcileState(JSON.parse(JSON.stringify(s)));
  assert.equal(sharesOf(fixed), 80_000_000);
  assert.equal(fixed.equity.cumDividendsPerShare, 0, 'missing keys default');
  assert.equal(fixed.equity.founderShares,
    Math.round(TOTAL_SHARES * (1 - STOCK_MARKET.DEFAULT_FREE_FLOAT_PCT)));
});

// ── A tick keeps everything consistent ──────────────────────────────────────

test('ADVANCE_WEEK republishes svps alongside marketCap and sharePrice', () => {
  const next = gameReducer(freshState(), { type: 'ADVANCE_WEEK' });
  assert.ok(Number.isFinite(next.marketCap) && next.marketCap > 0);
  assert.ok(Number.isFinite(next.sharePrice) && next.sharePrice > 0);
  assert.ok(Number.isFinite(next.svps), 'svps is published every week');
  assert.ok(Math.abs(next.svps - next.sharePrice) < 1e-12, 'no dividends yet → equal');
  assert.ok(Math.abs(next.sharePrice - next.marketCap / sharesOf(next)) < 1e-9,
    'share price is consistent with the airline\'s own share count');
});

test('the weekly stats series records svps and the share count', () => {
  const next = gameReducer(freshState(), { type: 'ADVANCE_WEEK' });
  const last = next.statsHistory[next.statsHistory.length - 1];
  assert.ok(last, 'a stats row was written');
  assert.ok(Number.isFinite(last.svps), 'svps charted');
  assert.equal(last.shares, TOTAL_SHARES, 'share count charted');
  assert.ok(Number.isFinite(last.marketIndex), 'market index charted (Phase 1)');
});

test('a tick never emits a non-finite svps even from a broken blob', () => {
  const s = { ...freshState(), marketCap: NaN, sharePrice: NaN };
  const next = gameReducer(reconcileState(JSON.parse(JSON.stringify({ ...s, marketCap: 0, sharePrice: 0 }))),
    { type: 'ADVANCE_WEEK' });
  assert.ok(Number.isFinite(next.svps), 'svps stays finite');
});

// ── Ownership caps read the TARGET's float ─────────────────────────────────

test('the 20% ownership cap is a share of the rival\'s own float', () => {
  const S = STOCK_MARKET;
  // A rival that has bought back down to 10M shares: 20% is 2M shares, not 20M.
  const thin = { id: 'r1', name: 'Thin Float Air', shares: 10_000_000, sharePrice: 5, marketCap: 50_000_000 };
  const base = { ...freshState(), cash: 500_000_000, marketCap: 1_000_000_000, competitors: [thin] };

  const justUnder = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 2_000_000 });
  assert.equal(justUnder.portfolio.holdings.r1?.shares, 2_000_000, '20% of a 10M float is allowed');

  const justOver = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 2_000_001 });
  assert.equal(justOver, base, 'one share over the rival\'s own 20% is rejected');

  // The same order against a founder-count rival is fine — proving the cap is
  // not a global constant.
  const fat = { ...thin, id: 'r2', shares: TOTAL_SHARES, sharePrice: 0.5, marketCap: 50_000_000 };
  const okOnFat = gameReducer({ ...base, competitors: [fat] },
    { type: 'BUY_STOCK', targetId: 'r2', shares: 2_000_001 });
  assert.ok(okOnFat.portfolio.holdings.r2?.shares > 0, 'same size order clears a 100M float');
  assert.ok(Math.round(S.MAX_OWNERSHIP_PCT * TOTAL_SHARES) === 20_000_000, 'sanity: 20% of 100M');
});

test('mark-to-market prices a rival off its own share count', () => {
  // A rival with no explicit sharePrice must be valued at marketCap / ITS shares.
  const thin = { id: 'r1', name: 'Thin', shares: 10_000_000, marketCap: 50_000_000 };
  const base = { ...freshState(), cash: 500_000_000, marketCap: 1_000_000_000, competitors: [thin] };
  const bought = gameReducer(base, { type: 'BUY_STOCK', targetId: 'r1', shares: 100_000 });
  const held = bought.portfolio.holdings.r1;
  assert.ok(held, 'position opened');
  // $50M / 10M shares = $5.00, not $50M / 100M = $0.50.
  assert.ok(Math.abs(held.lastPrice - 5) < 1e-9, `priced at ${held.lastPrice}, expected 5`);
});

Math.random = realRandom;
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
