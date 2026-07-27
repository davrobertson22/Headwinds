/**
 * valuation-v3-check.mjs — compare the LIVE valuation against the proposed
 * valuation v3 constants from STOCK_MARKET_PLAN_V2.md (Part A).
 *
 * Not a test — a calibration harness. Run it, read the table, tune V3 below.
 *   node tools/valuation-v3-check.mjs
 */

import { computeMarketCap } from '../packages/engine/src/utils/market.js';

// ── Proposed valuation v3 (candidate constants — tune these) ──────────────────
const V3 = {
  BOOK_WEIGHT:        0.85,
  FLEET_NAV_WEIGHT:   0.90,
  BOOK_FLOOR:         0.40,
  PE_BASE:            8,        // was 12
  PE_GROWTH_SPAN:     3,        // was -5..+15
  PE_REP_SPAN:        2,        // was 0..+5    → band 5..13 (real airline range)
  EARNINGS_SALES_CAP: 1.2,      // NEW: earnings term ≤ 1.2 × annualized revenue
  IDLE_CASH_REV_FRAC: 0.20,     // NEW: cash above 20% of annual revenue is idle
  IDLE_CASH_WEIGHT:   0.25,     // NEW: idle cash credited at 25c on the dollar
  LOSS_MULTIPLE:      4,
  MIN_EARNINGS_WEEKS: 4,
  EARNINGS_CONF_POW:  2,
};

function v3(profitHistory, cash, quality, { fleetNAV = 0, debt = 0, revenueHint = 0 }) {
  const annualRev      = revenueHint * 52;
  const idleThreshold  = V3.IDLE_CASH_REV_FRAC * annualRev;
  const productiveCash = Math.min(cash, idleThreshold);
  const idleCash       = Math.max(0, cash - idleThreshold);
  const creditedCash   = productiveCash + V3.IDLE_CASH_WEIGHT * idleCash;
  const netBook = creditedCash
                + V3.FLEET_NAV_WEIGHT * Math.max(0, fleetNAV)
                - Math.max(0, debt);

  const weeks = (profitHistory ?? []).slice(-12);
  let earningsValue = 0, pe = null, annualized = null;
  if (weeks.length >= V3.MIN_EARNINGS_WEEKS) {
    const avg  = weeks.reduce((s, p) => s + p, 0) / weeks.length;
    annualized = avg * 52;
    const conf = Math.pow(weeks.length / 12, V3.EARNINGS_CONF_POW);

    const recent = weeks.slice(-6);
    const prior  = weeks.slice(0, Math.max(0, weeks.length - 6));
    const rAvg   = recent.reduce((s, p) => s + p, 0) / recent.length;
    const pAvg   = prior.length ? prior.reduce((s, p) => s + p, 0) / prior.length : 0;
    const denom  = Math.max(Math.abs(pAvg), 0.05 * revenueHint, 50_000);
    const growth = Math.max(-1, Math.min(1, (rAvg - pAvg) / denom));

    pe = V3.PE_BASE + growth * V3.PE_GROWTH_SPAN + (quality / 100) * V3.PE_REP_SPAN;

    // Same profit↔loss cliff smoothing as v2.
    const band = Math.max(4 * revenueHint, 1_000_000);
    const t    = Math.max(0, Math.min(1, (annualized + band) / (2 * band)));
    const mult = V3.LOSS_MULTIPLE + (pe - V3.LOSS_MULTIPLE) * t;

    earningsValue = annualized * mult * conf;
    // The backstop: valuation can never run away from the actual business.
    if (earningsValue > 0) {
      earningsValue = Math.min(earningsValue, V3.EARNINGS_SALES_CAP * annualRev);
    }
  }

  const fair = Math.max(
    V3.BOOK_WEIGHT * netBook + earningsValue,
    V3.BOOK_FLOOR * netBook,
    500_000,
  );
  return { fair, netBook, pe, annualized, earningsValue };
}

// ── Profiles ──────────────────────────────────────────────────────────────────
const M = 1e6;
const hist = (avg, n = 12, growth = 1.0) =>
  Array.from({ length: n }, (_, i) => avg * (growth ** ((i - n / 2) / n)));

const profiles = [
  { name: 'Week 6 startup (losing)',     cash: 8 * M,   fleet: 30 * M,  debt: 20 * M,  wk: -0.2 * M, rev: 2 * M,  n: 6,  q: 40 },
  { name: 'Week 40 growing',             cash: 30 * M,  fleet: 180 * M, debt: 90 * M,  wk: 0.8 * M,  rev: 9 * M,  n: 12, q: 55 },
  { name: 'Week 150 mature',             cash: 250 * M, fleet: 900 * M, debt: 300 * M, wk: 4 * M,    rev: 40 * M, n: 12, q: 70 },
  { name: 'Week 200 cash hoarder',       cash: 900 * M, fleet: 600 * M, debt: 0,       wk: 3 * M,    rev: 30 * M, n: 12, q: 65 },
  { name: 'Absurd-margin outlier (53%)', cash: 60 * M,  fleet: 200 * M, debt: 50 * M,  wk: 8 * M,    rev: 15 * M, n: 12, q: 80 },
];

const fmt = (n) => (n / M).toFixed(0).padStart(7) + 'M';

console.log(
  'profile'.padEnd(30), 'CURRENT fair'.padStart(12), 'PROPOSED'.padStart(12),
  'ratio'.padStart(8), '  P/E now → new',
);
console.log('-'.repeat(88));
for (const p of profiles) {
  const h   = hist(p.wk, p.n, 1.6);
  const cur = computeMarketCap(h, p.cash, p.q, { fleetNAV: p.fleet, debt: p.debt, revenueHint: p.rev });
  const nu  = v3(h, p.cash, p.q, { fleetNAV: p.fleet, debt: p.debt, revenueHint: p.rev });
  console.log(
    p.name.padEnd(30), fmt(cur.fairValue), fmt(nu.fair),
    (nu.fair / cur.fairValue).toFixed(2).padStart(8) + 'x',
    '  ', String(cur.peMultiple ?? '—').padStart(5), '→', (nu.pe ?? 0).toFixed(1),
  );
}

// ── The predictable-ramp problem (Part A2) ────────────────────────────────────
console.log('\nPredictable ramp: weeks to double if fair value sits 3x above price');
for (const [label, clamp, conv] of [['current ', 0.20, 0.30], ['proposed', 0.08, 0.30]]) {
  let price = 1, w = 0;
  while (price < 2 && w < 200) {
    const target = price + conv * (3 - price);
    price = Math.min(price * (1 + clamp), target);
    w++;
  }
  console.log(
    ` ${label} clamp ±${(clamp * 100).toFixed(0)}%/wk → ${w} weeks to double` +
    ` (${((2 ** (1 / w) - 1) * 100).toFixed(1)}%/wk compounding)`,
  );
}
