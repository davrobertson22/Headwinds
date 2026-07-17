/**
 * catering.js — Per-route in-flight catering service model.
 *
 * Each route chooses ONE catering level. The level drives three things, all of
 * which scale with route distance:
 *   1. COST    — what the airline spends provisioning food & drink (per pax)
 *   2. REVENUE — ancillary income on the levels where passengers pay (per pax)
 *   3. QUALITY — a bonus/penalty folded into the route's demand quality score
 *
 * Catering is deliberately SEPARATE from the per-aircraft "service quality"
 * (flight attendants, amenity kits, the rest of the service) — the two stack.
 *
 * The five levels:
 *   none     No catering at all. Zero cost, zero revenue, quality penalty
 *            (worse on long flights where passengers expect food).
 *   paid     Buy-on-board for everyone (low-cost carrier model). Modest cost,
 *            ancillary revenue, slight quality penalty (food costs extra).
 *   partial  Complimentary meals for premium economy and above; economy buys
 *            on board. Premium cabins cost money; economy earns ancillary revenue.
 *   hybrid   Everyone gets a complimentary basic meal; economy can pay to upgrade
 *            food/drink. Some economy ancillary revenue on top of base cost.
 *   full     Everyone fed, full meal service, no ancillary revenue. Highest cost,
 *            highest quality (and it matters most on long-haul).
 */

import { CATERING_COST_PER_PAX } from './overhead.js';

// All cabin classes, premium → economy.
export const CABIN_CLASSES = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];

// ─── Distance scaling ─────────────────────────────────────────────────────────
//
// Longer flights need more, bigger meals (more service rounds, hot meals vs a
// snack) so catering cost rises with distance. On the paid levels, passengers
// also buy more and pay more on a long flight, so ancillary revenue scales too.
//
// Reference point: factor = 1.0 at ~2,000 km (short/medium haul), where the
// base per-pax rates below are calibrated. Clamped to a sane band.
//   500 km   → 0.70    (quick hop: drink + light snack)
//   2,000 km → 1.00    (reference)
//   6,000 km → 1.80
//   12,000 km→ 3.00    (cap — ultra long-haul, multiple full services)

export function cateringDistanceFactor(distKm) {
  const f = 0.6 + (distKm ?? 0) / 5000;
  return Math.max(0.6, Math.min(3.0, f));
}

// ─── Base per-passenger economics (at distance factor = 1.0) ───────────────────

// Complimentary FULL meal provisioning cost the airline pays, per pax per leg.
// Reuses the existing full-service rates so "full" matches today's behaviour at
// reference distance.
const FULL_MEAL_COST = { ...CATERING_COST_PER_PAX };

// Complimentary BASIC meal (hybrid economy base offering) — cheaper than full.
const BASIC_MEAL_COST = {
  economy:        6,
  premiumEconomy: 12,
  businessClass:  30,
  firstClass:     55,
};

// Buy-on-board: a paying passenger's purchase. `take` = fraction of the cabin
// that buys something. price = what they pay; cost = what it costs the airline.
const BUY_ON_BOARD = {
  economy:        { price: 14, cost: 7,  take: 0.45 },
  premiumEconomy: { price: 22, cost: 11, take: 0.55 },
  businessClass:  { price: 40, cost: 20, take: 0.60 },
  firstClass:     { price: 60, cost: 30, take: 0.65 },
};

// Hybrid upgrade: economy already has a basic meal but can pay for better
// food/drink. Fewer buy (they're already fed) but it's pure upside.
const UPGRADE = { economy: { price: 13, cost: 5, take: 0.30 } };

// Take-rate rises modestly on longer flights (captive audience, more meal
// occasions). Capped so it never becomes unrealistic.
function adjustedTake(baseTake, distFactor) {
  return Math.max(0.1, Math.min(0.9, baseTake + (distFactor - 1) * 0.08));
}

// ─── Level → per-class treatment mapping ───────────────────────────────────────
//
// Treatments:
//   none        nothing served
//   bob         buy-on-board only (nothing complimentary)
//   comp_basic  complimentary basic meal
//   comp_full   complimentary full meal
//   comp_basic_bob  complimentary basic meal + optional paid upgrade

const LEVEL_TREATMENTS = {
  none: {
    economy: 'none', premiumEconomy: 'none', businessClass: 'none', firstClass: 'none',
  },
  paid: {
    economy: 'bob', premiumEconomy: 'bob', businessClass: 'bob', firstClass: 'bob',
  },
  partial: {
    economy: 'bob', premiumEconomy: 'comp_full', businessClass: 'comp_full', firstClass: 'comp_full',
  },
  hybrid: {
    economy: 'comp_basic_bob', premiumEconomy: 'comp_full', businessClass: 'comp_full', firstClass: 'comp_full',
  },
  full: {
    economy: 'comp_full', premiumEconomy: 'comp_full', businessClass: 'comp_full', firstClass: 'comp_full',
  },
};

// ─── Level metadata (for UI) ───────────────────────────────────────────────────

export const CATERING_LEVELS = {
  none: {
    id: 'none', name: 'No Service', short: 'None', color: 'var(--text-muted)',
    desc: 'Nothing served. No catering cost, no revenue. Passengers notice, especially on longer flights.',
  },
  paid: {
    id: 'paid', name: 'Paid Service', short: 'Paid', color: 'var(--yellow)',
    desc: 'Buy-on-board for everyone, low-cost-carrier style. Low cost and a healthy ancillary margin; food-for-purchase dents quality slightly.',
  },
  partial: {
    id: 'partial', name: 'Partial Service', short: 'Partial', color: 'var(--accent)',
    desc: 'Complimentary meals for premium economy and above. Economy buys on board, earning ancillary revenue.',
  },
  hybrid: {
    id: 'hybrid', name: 'Hybrid Service', short: 'Hybrid', color: 'var(--purple)',
    desc: 'Everyone gets a complimentary meal; economy can pay to upgrade food & drink. Solid quality with a little upside revenue.',
  },
  full: {
    id: 'full', name: 'Full Service', short: 'Full', color: 'var(--green)',
    desc: 'Everyone fed with full meal service, no charge. Highest cost, highest quality, a big draw on long-haul.',
  },
};

export const CATERING_LEVEL_ORDER = ['none', 'paid', 'partial', 'hybrid', 'full'];
export const DEFAULT_CATERING_LEVEL = 'full';

/** Normalise/validate a level id, falling back to full (today's behaviour). */
export function normalizeCateringLevel(level) {
  return CATERING_LEVELS[level] ? level : DEFAULT_CATERING_LEVEL;
}

// ─── Quality effect ─────────────────────────────────────────────────────────────
//
// Base quality points by level, amplified by distance: good food matters more
// (and missing food hurts more) the longer the flight.
//   amp ≈ 0.7 (short hop) → ~2.2 (ultra long-haul)

const CATERING_QUALITY_BASE = { none: -12, paid: -3, partial: 4, hybrid: 7, full: 11 };

export function cateringQualityAmplifier(distKm) {
  const amp = 0.6 + (distKm ?? 0) / 6000;
  return Math.max(0.6, Math.min(2.2, amp));
}

/** Quality-score delta (points) for a catering level on a route of given distance. */
export function cateringQualityBonus(level, distKm) {
  const base = CATERING_QUALITY_BASE[normalizeCateringLevel(level)] ?? 0;
  return Math.round(base * cateringQualityAmplifier(distKm));
}

// ─── Cost & revenue ──────────────────────────────────────────────────────────────

/**
 * Cost & revenue for a single cabin class.
 * @param {string} treatment  one of the treatment keys above
 * @param {string} cls        cabin class
 * @param {number} pax        boarded passengers in this class (BOTH directions)
 * @param {number} f          distance factor
 * @returns {{ cost: number, revenue: number }}
 */
function classCatering(treatment, cls, pax, f) {
  if (pax <= 0) return { cost: 0, revenue: 0 };
  switch (treatment) {
    case 'none':
      return { cost: 0, revenue: 0 };
    case 'comp_basic':
      return { cost: pax * (BASIC_MEAL_COST[cls] ?? 0) * f, revenue: 0 };
    case 'comp_full':
      return { cost: pax * (FULL_MEAL_COST[cls] ?? 0) * f, revenue: 0 };
    case 'bob': {
      const b = BUY_ON_BOARD[cls];
      if (!b) return { cost: 0, revenue: 0 };
      const buyers = pax * adjustedTake(b.take, f);
      return { cost: buyers * b.cost * f, revenue: buyers * b.price * f };
    }
    case 'comp_basic_bob': {
      const base = pax * (BASIC_MEAL_COST[cls] ?? 0) * f;
      const u = UPGRADE[cls];
      if (!u) return { cost: base, revenue: 0 };
      const buyers = pax * adjustedTake(u.take, f);
      return { cost: base + buyers * u.cost * f, revenue: buyers * u.price * f };
    }
    default:
      return { cost: 0, revenue: 0 };
  }
}

/**
 * Total weekly catering cost & revenue for one route.
 *
 * @param {string} level        catering level id
 * @param {object} classSummary { [cls]: { passengers } } — ONE-WAY pax per direction
 * @param {number} distKm       route distance
 * @returns {{ cost, revenue, net, level, distanceFactor, byClass }}
 *
 * classSummary passengers are one-way (per direction); both directions are
 * catered, so we multiply by 2 — matching weeklyCateringCost's convention.
 */
export function routeCatering(level, classSummary = {}, distKm = 0) {
  const lvl = normalizeCateringLevel(level);
  const treatments = LEVEL_TREATMENTS[lvl];
  const f = cateringDistanceFactor(distKm);

  let cost = 0, revenue = 0;
  const byClass = {};
  for (const cls of CABIN_CLASSES) {
    const paxBoth = (classSummary[cls]?.passengers ?? 0) * 2;
    const r = classCatering(treatments[cls], cls, paxBoth, f);
    cost += r.cost;
    revenue += r.revenue;
    byClass[cls] = {
      treatment: treatments[cls],
      pax: paxBoth,
      cost: Math.round(r.cost),
      revenue: Math.round(r.revenue),
    };
  }

  return {
    level: lvl,
    distanceFactor: f,
    cost: Math.round(cost),
    revenue: Math.round(revenue),
    net: Math.round(revenue - cost),
    byClass,
  };
}
