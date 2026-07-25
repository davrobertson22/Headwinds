/**
 * ancillaries.js — Airline-wide ancillary (à la carte) product model.
 *
 * The player sets ONE policy for the whole airline: for each ancillary product
 * they decide whether to OFFER it and what to CHARGE. That policy drives three
 * things on every passenger route:
 *   1. REVENUE  — buyers × fee, scaled by boarded pax and cabin mix
 *   2. COST     — provisioning cost for products that cost money to run
 *                 (Wi-Fi bandwidth, staffing a lounge) plus per-buyer unit cost
 *   3. QUALITY  — a net demand-quality delta folded into the route quality score:
 *                 generosity (free / low fees, or simply OFFERING an expected
 *                 amenity) lifts perceived quality and demand; nickel-and-diming
 *                 (fees at or above market) and NOT offering an expected amenity
 *                 (no Wi-Fi, no lounge) drags it down.
 *
 * Deliberately SEPARATE from per-route catering (food & drink), which has its own
 * model in catering.js. The two stack into the route quality score and revenue.
 *
 * ── Inactive by default ──────────────────────────────────────────────────────
 * `state.ancillaries` is `null` until the player configures a policy on the
 * Operations → Ancillaries tab. A null / undefined policy produces ZERO revenue,
 * ZERO cost and ZERO quality change — so existing games and the demand model are
 * unaffected until the airline opts in. Once active, the policy is a full object
 * keyed by product id: { [id]: { offered: boolean, price: number } }.
 *
 * ── Pricing math ─────────────────────────────────────────────────────────────
 * Every product has a REFERENCE price (a typical market fee). The player's fee is
 * read relative to it. At the reference fee, quality is ~neutral and the take-rate
 * is the product's base. Cheaper → more buyers + goodwill; pricier → fewer buyers
 * + resentment. A fee of $0 means "free / included": no revenue, maximum goodwill.
 */

import { CABIN_CLASSES } from './catering.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// How sharply the take-rate falls as the fee rises above reference (and rises as
// it falls below). take = baseTake × (1 − ELASTICITY × (fee/ref − 1)), bounded.
export const ANC_ELASTICITY = 0.7;

// The net airline-wide quality delta is clamped to this band so ancillaries stay
// a meaningful SECONDARY lever (cabin product + catering remain primary).
export const ANC_QUALITY_CAP = 15;

// ── Product catalogue ──────────────────────────────────────────────────────────
//
// provisioned   true  → an amenity you must install/run to offer (Wi-Fi, extra-
//                       legroom seating, lounges). Not offering it is a real
//                       choice with a quality consequence (absentQ), and offering
//                       it costs money to run (provisionCost) even when free.
//               false → always available; the only lever is the fee ($0 = free).
// refPrice      typical market fee ($)
// maxPrice      slider ceiling in the UI
// baseTake      fraction of ELIGIBLE passengers who buy at the reference fee
// elig          per-cabin eligibility weight (who is even a candidate to buy)
// unitCost      airline cost per BUYER ($) — consumables/handling
// provisionCost airline cost per ELIGIBLE pax ($) whenever a provisioned amenity
//               is offered, free or paid (bandwidth, lounge staffing)
// qFree         quality points when offered at $0 (free / included)
// qAtRef        quality points at the reference fee (usually slightly negative)
// absentQ       quality points when a provisioned amenity is NOT offered
// qFloor        lower clamp on this product's quality points at very high fees

export const ANCILLARY_PRODUCTS = [
  {
    id: 'bags', name: 'Checked Bags', short: 'Bags', icon: '🧳',
    provisioned: false,
    blurb: 'Fee for checked baggage. Bags-fly-free is a powerful loyalty draw; steep bag fees are the classic nickel-and-dime that travellers resent.',
    refPrice: 35, maxPrice: 90, presets: [0, 25, 35, 50, 75],
    baseTake: 0.55, elig: { economy: 1.0, premiumEconomy: 0.85, businessClass: 0.45, firstClass: 0.35 },
    unitCost: 4, provisionCost: 0,
    qFree: 3.0, qAtRef: -0.8, absentQ: 0, qFloor: -6,
  },
  {
    id: 'seat', name: 'Seat Selection', short: 'Seats', icon: '💺',
    provisioned: false,
    blurb: 'Fee to choose a seat in advance. Free seat selection feels generous; charging for it is common but mildly disliked.',
    refPrice: 16, maxPrice: 45, presets: [0, 8, 16, 25, 35],
    baseTake: 0.40, elig: { economy: 1.0, premiumEconomy: 0.7, businessClass: 0.3, firstClass: 0.2 },
    unitCost: 0, provisionCost: 0,
    qFree: 2.0, qAtRef: -0.6, absentQ: 0, qFloor: -5,
  },
  {
    id: 'priority', name: 'Priority Boarding', short: 'Priority', icon: '🎫',
    provisioned: false,
    blurb: 'Fee to board early with overhead-bin certainty. A minor upsell — modest revenue, modest goodwill effect.',
    refPrice: 12, maxPrice: 35, presets: [0, 6, 12, 20, 30],
    baseTake: 0.28, elig: { economy: 0.8, premiumEconomy: 0.6, businessClass: 0.2, firstClass: 0.1 },
    unitCost: 0, provisionCost: 0,
    qFree: 0.8, qAtRef: -0.2, absentQ: 0, qFloor: -3,
  },
  {
    id: 'wifi', name: 'Wi-Fi & Streaming', short: 'Wi-Fi', icon: '📶',
    provisioned: true,
    blurb: 'Onboard connectivity & entertainment. Increasingly expected — free Wi-Fi is a real draw, and having none at all is noticed. Costs bandwidth to run whether free or paid.',
    refPrice: 10, maxPrice: 30, presets: [0, 5, 10, 15, 25],
    baseTake: 0.30, elig: { economy: 1.0, premiumEconomy: 1.0, businessClass: 1.0, firstClass: 1.0 },
    unitCost: 1.0, provisionCost: 1.4,
    qFree: 3.0, qAtRef: -0.3, absentQ: -3.0, qFloor: -5,
  },
  {
    id: 'legroom', name: 'Extra-Legroom Seats', short: 'Legroom', icon: '📏',
    provisioned: true,
    blurb: 'A block of extra-pitch economy seats sold at a premium. Offering the choice is a plus even at a fee; not offering it costs you a little differentiation.',
    refPrice: 45, maxPrice: 120, presets: [0, 25, 45, 70, 100],
    baseTake: 0.16, elig: { economy: 1.0, premiumEconomy: 0.5, businessClass: 0.1, firstClass: 0.05 },
    unitCost: 0, provisionCost: 0,
    qFree: 1.2, qAtRef: 0.2, absentQ: -0.5, qFloor: -3,
  },
  {
    id: 'lounge', name: 'Lounge Passes', short: 'Lounge', icon: '🛋️',
    provisioned: true,
    blurb: 'Day passes to an airport lounge. A premium signal that lifts brand perception; running lounges costs money per guest.',
    refPrice: 50, maxPrice: 120, presets: [0, 30, 50, 75, 100],
    baseTake: 0.10, elig: { economy: 0.35, premiumEconomy: 0.5, businessClass: 0.3, firstClass: 0.2 },
    unitCost: 18, provisionCost: 3,
    qFree: 2.0, qAtRef: 0.3, absentQ: -1.0, qFloor: -3,
  },
  {
    id: 'flex', name: 'Flexible Tickets', short: 'Flex', icon: '🔄',
    provisioned: false,
    blurb: 'The price of change/cancel flexibility. Cheap or free changes build enormous goodwill; punishing change fees are among the most-hated airline practices.',
    refPrice: 40, maxPrice: 120, presets: [0, 20, 40, 75, 100],
    baseTake: 0.16, elig: { economy: 0.5, premiumEconomy: 0.7, businessClass: 1.0, firstClass: 1.0 },
    unitCost: 0, provisionCost: 0,
    qFree: 2.5, qAtRef: -0.5, absentQ: 0, qFloor: -6,
  },
];

export const ANCILLARY_MAP = Object.fromEntries(ANCILLARY_PRODUCTS.map(p => [p.id, p]));
export const ANCILLARY_ORDER = ANCILLARY_PRODUCTS.map(p => p.id);

/** The recommended "standard carrier" baseline the UI seeds when a player activates. */
export const DEFAULT_ANCILLARIES = Object.fromEntries(
  ANCILLARY_PRODUCTS.map(p => [p.id, { offered: true, price: p.refPrice }]),
);

/** Deep clone of the default baseline (never share the exported object). */
export function defaultAncillaries() {
  return Object.fromEntries(
    ANCILLARY_PRODUCTS.map(p => [p.id, { offered: true, price: p.refPrice }]),
  );
}

/** A policy is "active" once it's a non-null object with at least one product entry. */
export function isAncillariesActive(policy) {
  return !!policy && typeof policy === 'object' && ANCILLARY_ORDER.some(id => policy[id]);
}

/** The resolved { offered, price } for one product, filling defaults for a partial policy. */
export function resolveItem(product, policy) {
  const raw = policy?.[product.id];
  const offered = raw?.offered ?? true;
  const price = Math.max(0, Number.isFinite(raw?.price) ? raw.price : product.refPrice);
  return { offered, price };
}

/**
 * Fraction of ELIGIBLE passengers who buy this product at a given fee.
 * $0 (free) → nobody "pays" so revenue is 0; expressed here as take 0.
 */
export function ancillaryTakeRate(product, price) {
  if (!(price > 0)) return 0;
  const ratio = price / product.refPrice;
  const t = product.baseTake * clamp(1 - ANC_ELASTICITY * (ratio - 1), 0.05, 1.6);
  return clamp(t, 0, 1);
}

/** Quality points contributed by ONE product under the current policy. */
export function ancillaryItemQuality(product, policy) {
  const { offered, price } = resolveItem(product, policy);
  if (product.provisioned && !offered) return product.absentQ ?? 0;
  const ratio = product.refPrice > 0 ? price / product.refPrice : 0;
  const q = product.qFree + (product.qAtRef - product.qFree) * ratio;
  return clamp(q, product.qFloor ?? -6, product.qFree);
}

/**
 * Net airline-wide ancillary quality delta (points added to every route's quality
 * score). 0 when the policy is inactive. Clamped to ±ANC_QUALITY_CAP.
 */
export function ancillaryQualityBonus(policy) {
  if (!isAncillariesActive(policy)) return 0;
  let sum = 0;
  for (const p of ANCILLARY_PRODUCTS) sum += ancillaryItemQuality(p, policy);
  return clamp(Math.round(sum), -ANC_QUALITY_CAP, ANC_QUALITY_CAP);
}

/** Eligible passengers (BOTH directions) for a product, from a one-way class summary. */
function eligiblePaxBoth(product, classSummary) {
  let n = 0;
  for (const cls of CABIN_CLASSES) {
    const paxBoth = (classSummary[cls]?.passengers ?? 0) * 2;
    n += paxBoth * (product.elig[cls] ?? 0);
  }
  return n;
}

/**
 * Weekly ancillary revenue & cost for ONE route.
 *
 * @param {object|null} policy       state.ancillaries (null → inactive → zeros)
 * @param {object} classSummary      { [cls]: { passengers } } — ONE-WAY pax per direction
 * @param {number} distKm            route distance (reserved; not currently scaled)
 * @returns {{ revenue, cost, net, byItem }}
 */
export function routeAncillaries(policy, classSummary = {}, distKm = 0) {
  if (!isAncillariesActive(policy)) return { revenue: 0, cost: 0, net: 0, byItem: {} };

  let revenue = 0, cost = 0;
  const byItem = {};
  for (const p of ANCILLARY_PRODUCTS) {
    const { offered, price } = resolveItem(p, policy);
    if (p.provisioned && !offered) { byItem[p.id] = { offered: false, revenue: 0, cost: 0, buyers: 0, price }; continue; }

    const eligPax = eligiblePaxBoth(p, classSummary);
    const take    = ancillaryTakeRate(p, price);
    const buyers  = eligPax * take;
    const rev     = buyers * price;
    const cst     = buyers * (p.unitCost ?? 0) + (p.provisioned ? eligPax * (p.provisionCost ?? 0) : 0);

    revenue += rev;
    cost    += cst;
    byItem[p.id] = {
      offered: true,
      revenue: Math.round(rev),
      cost:    Math.round(cst),
      buyers:  Math.round(buyers),
      price,
    };
  }

  return {
    revenue: Math.round(revenue),
    cost:    Math.round(cost),
    net:     Math.round(revenue - cost),
    byItem,
  };
}

/**
 * Validate/normalise a policy coming from a save or a client action. Returns null
 * (inactive) for anything that isn't a real policy object; otherwise a clean
 * object with every product present and sane { offered, price }.
 */
export function normalizeAncillaries(policy) {
  if (!isAncillariesActive(policy)) return null;
  const out = {};
  for (const p of ANCILLARY_PRODUCTS) {
    const { offered, price } = resolveItem(p, policy);
    out[p.id] = { offered: !!offered, price: clamp(Math.round(price), 0, p.maxPrice) };
  }
  return out;
}
