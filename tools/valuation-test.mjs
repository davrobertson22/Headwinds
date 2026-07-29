import assert from 'node:assert/strict';
import {
  computeMarketCap, VALUATION, TOTAL_SHARES, moveClampFor,
  tickMarketIndex, marketValuationFactor, marketIndexStatus,
  MARKET_BASE_INDEX, MARKET_MIN_INDEX, MARKET_MAX_INDEX,
  MARKET_FACTOR_MIN, MARKET_FACTOR_MAX, MARKET_FUEL_BETA,
} from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); failed++; } };

const M = 1e6;
// 12 weeks of profit averaging `avg`, mildly ramping so growth is positive.
const hist = (avg, n = 12, ramp = 1.6) =>
  Array.from({ length: n }, (_, i) => avg * (ramp ** ((i - n / 2) / n)));

// ── Valuation v3: multiple band ───────────────────────────────────────────────

test('P/E stays inside the real-airline band 5..13', () => {
  const lo = VALUATION.PE_BASE - VALUATION.PE_GROWTH_SPAN;
  const hi = VALUATION.PE_BASE + VALUATION.PE_GROWTH_SPAN + VALUATION.PE_REP_SPAN;
  assert.equal(lo, 5, 'floor of the band');
  assert.equal(hi, 13, 'ceiling of the band');
  // Sweep growth and reputation extremes; every printed multiple must be in band.
  for (const ramp of [0.2, 0.8, 1, 1.5, 40]) {
    for (const q of [0, 50, 100]) {
      const r = computeMarketCap(hist(1 * M, 12, ramp), 20 * M, q, { revenueHint: 8 * M });
      assert.ok(r.peMultiple >= lo - 1e-9 && r.peMultiple <= hi + 1e-9,
        `P/E ${r.peMultiple} out of band (ramp ${ramp}, quality ${q})`);
    }
  }
});

// ── Valuation v3: the sales backstop (the money-printer fix) ──────────────────

test('earnings term is capped at EARNINGS_SALES_CAP x annualized revenue', () => {
  // Implausible 53% net margin: $8M/wk profit on $15M/wk revenue.
  const rev = 15 * M;
  const r = computeMarketCap(hist(8 * M), 60 * M, 80, {
    fleetNAV: 200 * M, debt: 50 * M, revenueHint: rev,
  });
  const annualRev  = rev * 52;
  // Reconstruct the earnings term from the reported fair value and net book.
  const bookTerm   = VALUATION.BOOK_WEIGHT * r.netBook;
  const earnings   = r.fairValue - bookTerm;
  assert.ok(earnings <= VALUATION.EARNINGS_SALES_CAP * annualRev + 1,
    `earnings term ${(earnings / M).toFixed(0)}M exceeds cap ${(VALUATION.EARNINGS_SALES_CAP * annualRev / M).toFixed(0)}M`);
});

test('the cap only bites on absurd margins, not on healthy ones', () => {
  // 9% net margin — a good airline. Should be nowhere near the cap.
  const rev = 9 * M;
  const r = computeMarketCap(hist(0.8 * M), 30 * M, 55, {
    fleetNAV: 180 * M, debt: 90 * M, revenueHint: rev,
  });
  const earnings = r.fairValue - VALUATION.BOOK_WEIGHT * r.netBook;
  assert.ok(earnings < VALUATION.EARNINGS_SALES_CAP * rev * 52 * 0.95,
    'a healthy carrier should not be sitting on the cap');
  assert.ok(earnings > 0, 'and should still get credit for its earnings');
});

test('a loss-making carrier keeps its full negative earnings term', () => {
  const rev = 4 * M;
  const loss = computeMarketCap(hist(-0.5 * M, 12, 1), 20 * M, 40, { revenueHint: rev });
  const earnings = loss.fairValue - VALUATION.BOOK_WEIGHT * loss.netBook;
  assert.ok(earnings <= 0, 'losses must not be clipped upward by the sales cap');
});

// ── Valuation v3: idle-cash haircut ──────────────────────────────────────────

test('cash below the idle threshold is credited at face value', () => {
  const rev = 30 * M;                       // threshold = 20% x 1.56B = 312M
  const cash = 100 * M;
  const r = computeMarketCap(hist(3 * M), cash, 65, { revenueHint: rev });
  // netBook has no fleet/debt/portfolio here, so it IS the credited cash.
  assert.ok(Math.abs(r.netBook - cash) < 1, `netBook ${r.netBook} should equal cash ${cash}`);
});

test('cash above the idle threshold is haircut', () => {
  const rev = 30 * M;
  const threshold = Math.max(VALUATION.IDLE_CASH_REV_FRAC * rev * 52, VALUATION.IDLE_CASH_FLOOR);
  const cash = threshold + 400 * M;
  const r = computeMarketCap(hist(3 * M), cash, 65, { revenueHint: rev });
  const expected = threshold + VALUATION.IDLE_CASH_WEIGHT * 400 * M;
  assert.ok(Math.abs(r.netBook - expected) < 1,
    `netBook ${(r.netBook / M).toFixed(1)}M should be ${(expected / M).toFixed(1)}M`);
  assert.ok(r.netBook < cash, 'hoarding must cost you something');
});

test('hoarding is strictly worse than the same cash at a bigger airline', () => {
  const cash = 800 * M;
  const small = computeMarketCap(hist(3 * M), cash, 65, { revenueHint: 10 * M });
  const big   = computeMarketCap(hist(3 * M), cash, 65, { revenueHint: 60 * M });
  assert.ok(big.netBook > small.netBook,
    'the same pile is less idle at an airline with more revenue to deploy it against');
});

test('startup capital is never treated as idle', () => {
  // A brand-new airline with $15M and barely any revenue must not be haircut.
  const r = computeMarketCap(hist(-0.1 * M, 5, 1), 15 * M, 40, { revenueHint: 0.5 * M });
  assert.ok(Math.abs(r.netBook - 15 * M) < 1, 'the $25M floor protects starting cash');
});

test('cold valuations (no revenue hint) skip the haircut entirely', () => {
  const r = computeMarketCap([], 900 * M, 50);
  assert.ok(Math.abs(r.netBook - 900 * M) < 1, 'no revenue signal -> no idle judgement');
  assert.ok(Math.abs(r.fairValue - VALUATION.BOOK_WEIGHT * 900 * M) < 1,
    'and fair value stays 0.85 x book, as the 3-arg contract promises');
});

test('negative cash is not "idle"', () => {
  const r = computeMarketCap(hist(-1 * M, 12, 1), -5 * M, 30, { revenueHint: 3 * M });
  assert.ok(r.netBook <= -5 * M + 1, 'an overdraft must still subtract in full');
});

// ── Valuation v3: path (converge / clamp / noise) ─────────────────────────────

test('weekly move never exceeds the band for the gap, plus noise', () => {
  const prev = 100 * M;
  // Fair value miles above and miles below, at both noise extremes.
  for (const profit of [50 * M, -50 * M]) {
    for (const noise of [-VALUATION.NOISE_PCT, 0, VALUATION.NOISE_PCT]) {
      const r = computeMarketCap(hist(profit), 500 * M, 70, {
        prevMarketCap: prev, noise, revenueHint: 80 * M,
      });
      const move = Math.abs(r.marketCap - prev) / prev;
      // The band is no longer flat: it widens with the distance to fair value,
      // so a print sitting two orders of magnitude below the business it
      // represents can actually catch up (see moveClampFor). It is still a
      // band — nothing teleports.
      const band = moveClampFor(prev, r.fairValue);
      const ceiling = band + VALUATION.NOISE_PCT + band * VALUATION.NOISE_PCT + 1e-9;
      assert.ok(move <= ceiling,
        `moved ${(move * 100).toFixed(2)}% in one week (ceiling ${(ceiling * 100).toFixed(2)}%)`);
    }
  }
});

test('the resting band is 8% — the old 20% made the approach to fair value an annuity', () => {
  assert.equal(VALUATION.WEEKLY_MOVE_CLAMP, 0.08);
  assert.equal(VALUATION.NOISE_PCT, 0.035);
  // ...and the widest catch-up band, for a print far from fair value.
  assert.equal(VALUATION.MOVE_CLAMP_MAX, 0.35);
  assert.equal(moveClampFor(100 * M, 100 * M), VALUATION.WEEKLY_MOVE_CLAMP);
});

test('share price is market cap over the share count', () => {
  const r = computeMarketCap(hist(1 * M), 40 * M, 50, { revenueHint: 6 * M });
  assert.ok(Math.abs(r.sharePrice - r.marketCap / TOTAL_SHARES) < 1e-12);
});

// ── World market index ───────────────────────────────────────────────────────

test('market index stays inside its band over a 100-year walk', () => {
  let mkt = MARKET_BASE_INDEX, lo = Infinity, hi = -Infinity, sum = 0;
  let x = 987654321;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const weeks = 5200;
  for (let w = 1; w <= weeks; w++) {
    mkt = tickMarketIndex(mkt, rnd());
    lo = Math.min(lo, mkt); hi = Math.max(hi, mkt); sum += mkt;
  }
  assert.ok(lo >= MARKET_MIN_INDEX - 1e-9, `dipped to ${lo}`);
  assert.ok(hi <= MARKET_MAX_INDEX + 1e-9, `spiked to ${hi}`);
  // Zero drift by construction: the mean over a century must sit near base.
  assert.ok(Math.abs(sum / weeks - MARKET_BASE_INDEX) < 0.05,
    `mean ${(sum / weeks).toFixed(4)} drifted away from ${MARKET_BASE_INDEX}`);
});

test('market index is deterministic for a given seed sequence', () => {
  const walk = (seed) => {
    let x = seed, mkt = MARKET_BASE_INDEX;
    const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let w = 1; w <= 200; w++) mkt = tickMarketIndex(mkt, rnd());
    return mkt;
  };
  assert.equal(walk(42), walk(42), 'same seed -> same market (retried ticks must replay)');
  assert.notEqual(walk(42), walk(43), 'different seed -> different market');
});

test('market index mean-reverts from both extremes', () => {
  // With the shock pinned at its midpoint, drift alone must pull toward base.
  const up   = tickMarketIndex(MARKET_MAX_INDEX, 0.5);
  const down = tickMarketIndex(MARKET_MIN_INDEX, 0.5);
  assert.ok(up < MARKET_MAX_INDEX, 'a frothy market cools');
  assert.ok(down > MARKET_MIN_INDEX, 'a crashed market recovers');
});

test('non-finite market index falls back to base', () => {
  assert.equal(tickMarketIndex(undefined, 0.5), tickMarketIndex(MARKET_BASE_INDEX, 0.5));
  assert.equal(tickMarketIndex(NaN, 0.5), tickMarketIndex(MARKET_BASE_INDEX, 0.5));
});

// ── Fuel leverage ────────────────────────────────────────────────────────────

test('neutral market and baseline fuel is exactly 1.0', () => {
  assert.equal(marketValuationFactor(MARKET_BASE_INDEX, 1), 1);
});

test('expensive fuel drags valuations down, cheap fuel lifts them', () => {
  const dear  = marketValuationFactor(1, 1.5);
  const cheap = marketValuationFactor(1, 0.8);
  assert.ok(dear < 1, 'a fuel spike should hit share prices, not just the P&L');
  assert.ok(cheap > 1, 'cheap fuel re-rates the sector upward');
  // 10% above baseline fuel should cost roughly MARKET_FUEL_BETA x 10%.
  const ten = marketValuationFactor(1, 1.1);
  assert.ok(Math.abs((1 - ten) - MARKET_FUEL_BETA * 0.1) < 1e-6,
    `10% fuel move gave ${(1 - ten).toFixed(4)}, expected ${(MARKET_FUEL_BETA * 0.1).toFixed(4)}`);
});

test('the combined overlay is clamped in every scenario', () => {
  for (const m of [MARKET_MIN_INDEX, 1, MARKET_MAX_INDEX]) {
    for (const f of [0.55, 1, 1.9]) {
      const factor = marketValuationFactor(m, f);
      assert.ok(factor >= MARKET_FACTOR_MIN - 1e-9 && factor <= MARKET_FACTOR_MAX + 1e-9,
        `factor ${factor} out of band at market ${m} / fuel ${f}`);
    }
  }
  // Worst case (bear market + fuel crisis) must not zero a company out.
  assert.ok(marketValuationFactor(MARKET_MIN_INDEX, 1.9) >= MARKET_FACTOR_MIN);
});

test('non-finite inputs fall back to neutral', () => {
  assert.equal(marketValuationFactor(undefined, undefined), 1);
  assert.equal(marketValuationFactor(NaN, NaN), 1);
});

// ── Market factor applied to valuation ───────────────────────────────────────

test('the market overlay scales fair value for every airline alike', () => {
  const args = [hist(2 * M), 60 * M, 60, { revenueHint: 20 * M }];
  const neutral = computeMarketCap(args[0], args[1], args[2], { ...args[3], marketFactor: 1 });
  const bear    = computeMarketCap(args[0], args[1], args[2], { ...args[3], marketFactor: 0.75 });
  const bull    = computeMarketCap(args[0], args[1], args[2], { ...args[3], marketFactor: 1.25 });
  assert.ok(bear.fairValue < neutral.fairValue, 'bear market marks everyone down');
  assert.ok(bull.fairValue > neutral.fairValue, 'bull market marks everyone up');
  assert.ok(Math.abs(bear.fairValue / neutral.fairValue - 0.75) < 1e-6, 'scaling is proportional');
  assert.ok(Math.abs(bull.fairValue / neutral.fairValue - 1.25) < 1e-6, 'scaling is proportional');
});

test('the overlay defaults to neutral so old call sites are unaffected', () => {
  const withOut = computeMarketCap(hist(2 * M), 60 * M, 60, { revenueHint: 20 * M });
  const withOne = computeMarketCap(hist(2 * M), 60 * M, 60, { revenueHint: 20 * M, marketFactor: 1 });
  assert.equal(withOut.fairValue, withOne.fairValue);
});

test('the overlay can never drive a valuation below the absolute floor', () => {
  const r = computeMarketCap([], 1000, 0, { marketFactor: MARKET_FACTOR_MIN });
  assert.ok(r.marketCap >= VALUATION.MIN_MARKET_CAP);
});

test('marketIndexStatus labels the whole range', () => {
  assert.equal(marketIndexStatus(1.25).label, 'Bull market');
  assert.equal(marketIndexStatus(1.00).label, 'Steady');
  assert.equal(marketIndexStatus(0.75).label, 'Bear market');
  for (const i of [0.7, 0.85, 0.95, 1.1, 1.2, 1.3]) {
    assert.ok(marketIndexStatus(i).label, `a label exists at ${i}`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
