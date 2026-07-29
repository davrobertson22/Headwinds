/**
 * ancillaries.js — Airline-wide ancillary (à la carte) product model.
 *
 * The player sets ONE policy for the whole airline: for each ancillary product
 * they decide whether to OFFER it and what to CHARGE. That policy drives three
 * things on every passenger route:
 *   1. REVENUE  — buyers × fee, scaled by boarded pax, cabin mix and route length
 *   2. COST     — provisioning cost for products that cost money to run
 *                 (Wi-Fi bandwidth, staffing a lounge) plus per-buyer unit cost
 *   3. QUALITY  — a net demand-quality delta folded into the route quality score:
 *                 generosity (free / low fees, or simply OFFERING an expected
 *                 amenity) lifts perceived quality and demand; nickel-and-diming
 *                 (fees well above market) and NOT offering an expected amenity
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
 * read relative to it. At the reference fee, quality is ~neutral (market pricing
 * is what passengers expect) and the take-rate is the product's base. Cheaper →
 * more buyers + goodwill; pricier → fewer buyers + resentment. A fee of $0 means
 * "free / included": no revenue, maximum goodwill.
 *
 * Elasticity is PER PRODUCT: checked bags are famously inelastic (airlines have
 * repeatedly raised bag fees and grown revenue), while paid Wi-Fi and lounge
 * passes are discretionary and highly elastic. That makes pricing a real choice:
 * inelastic products can be pushed above reference for more revenue at a quality
 * cost; elastic ones simply lose buyers.
 *
 * ── Route length (haul) ──────────────────────────────────────────────────────
 * Take-rates scale with route distance: long-haul passengers check far more bags
 * and buy much more Wi-Fi / extra legroom, while almost nobody pays for Wi-Fi on
 * a 45-minute hop. Provisioning costs for provisioned amenities scale the same
 * way (satellite bandwidth is bought by the flight-hour; lounge usage tracks the
 * long-haul journeys). Bag and flex FEES also sting quality more on long-haul,
 * where the international norm is an included bag and a changeable ticket.
 * Callers that have no route in hand (airline-wide reputation, the policy UI)
 * simply omit the distance and get neutral medium-haul behaviour.
 */

import { CABIN_CLASSES } from './catering.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Fallback take-rate elasticity for products that don't declare their own.
// take = baseTake × (1 − elasticity × (fee/ref − 1)), bounded.
export const ANC_ELASTICITY = 0.9;

// The net airline-wide quality delta is clamped to this band so ancillaries stay
// a meaningful SECONDARY lever (cabin product + catering remain primary).
export const ANC_QUALITY_CAP = 15;

// Haul anchors: take-rate haul multipliers are interpolated from `haul.s` at
// SHORT_KM through 1.0 at MID_KM to `haul.l` at LONG_KM (clamped outside).
export const ANC_HAUL_SHORT_KM = 500;
export const ANC_HAUL_MID_KM   = 2500;
export const ANC_HAUL_LONG_KM  = 7000;

// How much MORE a charged bag/flex fee hurts quality on a full long-haul route
// (international norm: bag + changes included). 0.5 → penalty ×1.5 at LONG_KM.
export const ANC_HAUL_STING = 0.5;

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
// elasticity    how sharply take falls as fee rises above ref (low = inelastic)
// elig          per-cabin eligibility weight (who is even a candidate to buy).
//               Premium cabins get bags / seats / priority / flexibility / lounge
//               BUNDLED into the fare, so their weights are ~zero there.
// haul          { s, l } take-rate multipliers at short / long haul (1.0 = mid)
// haulQ         true → fee's quality PENALTY deepens with distance (bags, flex)
// unitCost      airline cost per BUYER ($) — consumables/handling
// provisionCost airline cost per ELIGIBLE pax ($) whenever a provisioned amenity
//               is offered, free or paid (bandwidth, lounge staffing); scales
//               with haul like the take-rate does
// qFree         quality points when offered at $0 (free / included)
// qAtRef        quality points at the reference fee (~neutral: mild dent at most)
// absentQ       quality points when a provisioned amenity is NOT offered
// qFloor        lower clamp on this product's quality points at very high fees

export const ANCILLARY_PRODUCTS = [
  {
    id: 'bags', name: 'Checked Bags', short: 'Bags', icon: '🧳',
    provisioned: false,
    blurb: 'Fee for checked baggage — the industry\'s biggest ancillary earner, and famously inelastic: fees can be pushed well above market before buyers balk, at a growing cost to goodwill. Bags-fly-free remains a powerful loyalty draw, and bag fees sting most on long-haul, where an included bag is the norm.',
    refPrice: 40, maxPrice: 90, presets: [0, 30, 40, 55, 75],
    baseTake: 0.34, elasticity: 0.55,
    elig: { economy: 1.0, premiumEconomy: 0.85, businessClass: 0.05, firstClass: 0 },
    haul: { s: 0.85, l: 1.35 }, haulQ: true,
    unitCost: 4, provisionCost: 0,
    qFree: 2.5, qAtRef: -0.6, absentQ: 0, qFloor: -8,
  },
  {
    id: 'seat', name: 'Seat Selection', short: 'Seats', icon: '💺',
    provisioned: false,
    blurb: 'Fee to choose a seat in advance. Free seat selection feels generous; charging for it is standard practice and barely noticed at market rates. Premium cabins choose seats free of charge.',
    refPrice: 16, maxPrice: 45, presets: [0, 8, 16, 25, 35],
    baseTake: 0.24, elasticity: 0.9,
    elig: { economy: 1.0, premiumEconomy: 0.7, businessClass: 0.05, firstClass: 0 },
    haul: { s: 0.95, l: 1.15 },
    unitCost: 0, provisionCost: 0,
    qFree: 1.8, qAtRef: -0.4, absentQ: 0, qFloor: -7,
  },
  {
    id: 'priority', name: 'Priority Boarding', short: 'Priority', icon: '🎫',
    provisioned: false,
    blurb: 'Fee to board early with overhead-bin certainty. A minor, short-haul-flavoured upsell — modest revenue, modest goodwill effect. Premium cabins already board first.',
    refPrice: 12, maxPrice: 35, presets: [0, 6, 12, 20, 30],
    baseTake: 0.16, elasticity: 1.1,
    elig: { economy: 0.8, premiumEconomy: 0.6, businessClass: 0, firstClass: 0 },
    haul: { s: 1.0, l: 0.9 },
    unitCost: 0, provisionCost: 0,
    qFree: 0.7, qAtRef: -0.2, absentQ: 0, qFloor: -4,
  },
  {
    id: 'wifi', name: 'Wi-Fi & Streaming', short: 'Wi-Fi', icon: '📶',
    provisioned: true,
    blurb: 'Onboard connectivity & entertainment. Increasingly expected — the industry trend is toward free Wi-Fi, and having none at all is noticed. Paid Wi-Fi is highly elastic: raise the price and buyers vanish. Bandwidth costs scale with hours aloft, and take-up is far higher on long-haul.',
    refPrice: 10, maxPrice: 30, presets: [0, 5, 10, 15, 25],
    baseTake: 0.10, elasticity: 1.35,
    elig: { economy: 1.0, premiumEconomy: 1.0, businessClass: 1.0, firstClass: 1.0 },
    haul: { s: 0.35, l: 1.6 },
    unitCost: 1.0, provisionCost: 1.4,
    qFree: 2.5, qAtRef: -0.3, absentQ: -3.5, qFloor: -6,
  },
  {
    id: 'legroom', name: 'Extra-Legroom Seats', short: 'Legroom', icon: '📏',
    provisioned: true,
    blurb: 'A block of extra-pitch economy seats sold at a premium — an upsell that really earns on long-haul, where legroom is worth paying for. Offering the choice is a plus even at a fee; not offering it costs a little differentiation.',
    refPrice: 45, maxPrice: 120, presets: [0, 25, 45, 70, 100],
    baseTake: 0.10, elasticity: 0.75,
    elig: { economy: 1.0, premiumEconomy: 0.15, businessClass: 0, firstClass: 0 },
    haul: { s: 0.55, l: 1.7 },
    unitCost: 0, provisionCost: 0,
    qFree: 1.0, qAtRef: -0.1, absentQ: -0.8, qFloor: -4,
  },
  {
    id: 'lounge', name: 'Lounge Passes', short: 'Lounge', icon: '🛋️',
    provisioned: true,
    blurb: 'Day passes to an airport lounge for economy travellers — a premium signal that lifts brand perception. Business and first get lounge access with the fare; running lounges costs real money per guest, and pass sales skew to long-haul journeys.',
    refPrice: 60, maxPrice: 120, presets: [0, 40, 60, 80, 100],
    baseTake: 0.06, elasticity: 1.2,
    elig: { economy: 0.15, premiumEconomy: 0.3, businessClass: 0, firstClass: 0 },
    haul: { s: 0.6, l: 1.5 },
    unitCost: 25, provisionCost: 3,
    qFree: 1.6, qAtRef: -0.1, absentQ: -1.5, qFloor: -4,
  },
  {
    id: 'flex', name: 'Flexible Tickets', short: 'Flex', icon: '🔄',
    provisioned: false,
    blurb: 'The price of change/cancel flexibility for economy fares — business and first are already flexible. Cheap or free changes build enormous goodwill; punishing change fees are among the most-hated airline practices, doubly so on long-haul.',
    refPrice: 40, maxPrice: 120, presets: [0, 20, 40, 75, 100],
    baseTake: 0.10, elasticity: 0.7,
    elig: { economy: 0.5, premiumEconomy: 0.7, businessClass: 0.15, firstClass: 0.1 },
    haulQ: true,
    unitCost: 0, provisionCost: 0,
    qFree: 2.2, qAtRef: -0.5, absentQ: 0, qFloor: -8,
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
 * 0 → fully short-haul, 1 → fully long-haul, interpolated between the anchors.
 * No/unknown distance (0, negative, non-finite) → mid-haul neutral behaviour.
 */
export function haulBlend(distKm) {
  if (!(distKm > 0)) return null; // caller treats null as neutral (mult 1, no sting)
  if (distKm <= ANC_HAUL_MID_KM) {
    // SHORT..MID: blend from the short anchor up to neutral.
    const t = clamp((distKm - ANC_HAUL_SHORT_KM) / (ANC_HAUL_MID_KM - ANC_HAUL_SHORT_KM), 0, 1);
    return { zone: 'short', t };
  }
  // MID..LONG: blend from neutral out to the long anchor.
  const t = clamp((distKm - ANC_HAUL_MID_KM) / (ANC_HAUL_LONG_KM - ANC_HAUL_MID_KM), 0, 1);
  return { zone: 'long', t };
}

/** Take-rate (and provisioning-cost) multiplier for one product at a route length. */
export function ancillaryHaulMult(product, distKm) {
  const blend = haulBlend(distKm);
  if (!blend || !product.haul) return 1;
  const { s = 1, l = 1 } = product.haul;
  return blend.zone === 'short' ? s + (1 - s) * blend.t : 1 + (l - 1) * blend.t;
}

/**
 * Fraction of ELIGIBLE passengers who buy this product at a given fee.
 * $0 (free) → nobody "pays" so revenue is 0; expressed here as take 0.
 * Pass distKm to include the route-length effect (omit for mid-haul neutral).
 */
export function ancillaryTakeRate(product, price, distKm = 0) {
  if (!(price > 0)) return 0;
  const ratio = price / product.refPrice;
  const elasticity = product.elasticity ?? ANC_ELASTICITY;
  const t = product.baseTake * clamp(1 - elasticity * (ratio - 1), 0.05, 1.6);
  return clamp(t * ancillaryHaulMult(product, distKm), 0, 1);
}

/**
 * Quality points contributed by ONE product under the current policy. On haulQ
 * products (bags, flex) a NEGATIVE contribution deepens with route length —
 * charging for what long-haul norms include stings more.
 */
export function ancillaryItemQuality(product, policy, distKm = 0) {
  const { offered, price } = resolveItem(product, policy);
  if (product.provisioned && !offered) return product.absentQ ?? 0;
  const ratio = product.refPrice > 0 ? price / product.refPrice : 0;
  let q = product.qFree + (product.qAtRef - product.qFree) * ratio;
  if (q < 0 && product.haulQ) {
    const blend = haulBlend(distKm);
    if (blend && blend.zone === 'long') q *= 1 + ANC_HAUL_STING * blend.t;
  }
  return clamp(q, product.qFloor ?? -6, product.qFree);
}

/**
 * Net airline-wide ancillary quality delta (points added to every route's quality
 * score). 0 when the policy is inactive. Clamped to ±ANC_QUALITY_CAP. Pass the
 * route's distance to include the long-haul fee sting; omit it for the airline-
 * wide (reputation / delivered-experience) figure.
 */
export function ancillaryQualityBonus(policy, distKm = 0) {
  if (!isAncillariesActive(policy)) return 0;
  let sum = 0;
  for (const p of ANCILLARY_PRODUCTS) sum += ancillaryItemQuality(p, policy, distKm);
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
 * @param {number} distKm            route distance — scales take-rates & provisioning
 * @returns {{ revenue, cost, net, byItem }}
 */
export function routeAncillaries(policy, classSummary = {}, distKm = 0) {
  if (!isAncillariesActive(policy)) return { revenue: 0, cost: 0, net: 0, byItem: {} };

  let revenue = 0, cost = 0;
  const byItem = {};
  for (const p of ANCILLARY_PRODUCTS) {
    const { offered, price } = resolveItem(p, policy);
    if (p.provisioned && !offered) { byItem[p.id] = { offered: false, revenue: 0, cost: 0, buyers: 0, price }; continue; }

    const eligPax  = eligiblePaxBoth(p, classSummary);
    const take     = ancillaryTakeRate(p, price, distKm);
    const buyers   = eligPax * take;
    const haulMult = ancillaryHaulMult(p, distKm);
    const rev      = buyers * price;
    const cst      = buyers * (p.unitCost ?? 0) + (p.provisioned ? eligPax * (p.provisionCost ?? 0) * haulMult : 0);

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
