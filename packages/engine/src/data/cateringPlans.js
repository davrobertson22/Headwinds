// Custom catering — service plans built from an item menu.
//
// catering.js keeps the five CLASSIC levels and their maths, untouched: a route
// on a classic level is costed and scored exactly as before, so a save that
// never builds a plan is byte-identical (the golden-master contract).
//
// This module is the other path. A SERVICE PLAN is a named menu for the four
// cabins. Per cabin, each item is off, free, or sold at a price the player
// types; six items also come in three quality tiers. A route (an O&D pair)
// points at a plan with the ref `plan:<id>` in the same slot that holds a
// classic level id.
//
// Design locked with Dave 2026-11-11 (project doc claude/custom-catering-design.md):
//
//   Menu      Ten items. Standard-tier costs are chosen so each cabin's EXPECTED
//             set adds up to the classic Full Service cost exactly.
//   Tiers     Basic 60% of the cost for 70% of the value; Premium 150% for 125%.
//   Sold      Only buyers are served and paid for. Buyers fall as the price
//             rises against a hidden reference of twice cost. The reference is
//             never shown: the player sees cost, buyers, revenue and quality.
//   Quality   Each item is worth a share of what the cabin expects. Free counts
//             in full, sold counts for less the dearer it is. −12 with nothing,
//             +11 at the expected set (the classic None and Full), up to +17.
//   Distance  On short flights the meal counts for half and drinks and the
//             snack make up the difference; cost and the overall stakes scale
//             with distance by the classic factors.
//   Kitchens  A caterer's level cap becomes a kitchen type: what it cannot make
//             is not loaded at the end it cooks for.
//
// All per-passenger figures are averaged over everyone on board in that cabin.

import {
  CABIN_CLASSES, cateringDistanceFactor, cateringQualityAmplifier,
  routeCatering, cateringQualityBonus, normalizeCateringLevel,
  CATERING_LEVELS, CATERING_LEVEL_ORDER,
} from './catering.js';

const C = (economy, premiumEconomy, businessClass, firstClass) =>
  ({ economy, premiumEconomy, businessClass, firstClass });

// ─── The menu ────────────────────────────────────────────────────────────────
//
// cost   per passenger, Standard tier, at the 2,000 km reference distance
// value  share of what that cabin expects on a long flight (expected set = 1.0)
// take   share of ECONOMY passengers who buy at the reference price
// meal   counts for less on short flights (see itemValue)
// slot   items sharing a slot do not stack: only the best one counts

export const CATERING_ITEMS = [
  { id: 'water',      name: 'Water',                        group: 'Drinks',
    cost: C(0.5, 0.5, 1, 2),      value: C(0.08, 0.06, 0.04, 0.03), take: 0.35 },
  { id: 'softDrinks', name: 'Soft drinks, tea and coffee',  group: 'Drinks',
    cost: C(1.5, 2, 3, 4),        value: C(0.17, 0.12, 0.07, 0.05), take: 0.30 },
  { id: 'beerWine',   name: 'Beer and wine',                group: 'Drinks', tiered: true,
    cost: C(3, 4, 8, 12),         value: C(0.20, 0.16, 0.12, 0.09), take: 0.15 },
  { id: 'spirits',    name: 'Spirits and cocktails',        group: 'Drinks',
    cost: C(3, 4, 7, 10),         value: C(0.06, 0.06, 0.07, 0.06), take: 0.08 },
  { id: 'champagne',  name: 'Champagne and fine wine',      group: 'Drinks', tiered: true,
    cost: C(10, 10, 10, 30),      value: C(0.08, 0.08, 0.12, 0.14), take: 0.03 },
  { id: 'snack',      name: 'Packaged snack',               group: 'Food',   tiered: true,
    cost: C(1, 1.5, 3, 4),        value: C(0.12, 0.08, 0.04, 0.03), take: 0.20 },
  { id: 'coldMeal',   name: 'Cold meal',                    group: 'Food',   tiered: true, meal: true, slot: 'main',
    cost: C(4, 6, 14, 20),        value: C(0.34, 0.26, 0.20, 0.16), take: 0.22 },
  { id: 'hotMeal',    name: 'Hot meal',                     group: 'Food',   tiered: true, meal: true, slot: 'main',
    cost: C(7, 14, 30, 40),       value: C(0.55, 0.42, 0.34, 0.26), take: 0.167 },
  { id: 'courses',    name: 'Extra courses',                group: 'Food',   tiered: true, meal: true,
    cost: C(4, 6, 18, 28),        value: C(0.08, 0.16, 0.20, 0.18), take: 0.08 },
  { id: 'fineDining', name: 'Fine dining',                  group: 'Food',   meal: true,
    cost: C(null, null, 20, 30),  value: C(0, 0, 0.10, 0.16),       take: 0.05 },
];
export const CATERING_ITEM_MAP = Object.fromEntries(CATERING_ITEMS.map(i => [i.id, i]));

/** What each cabin expects. Free at Standard this is the classic Full Service. */
export const CATERING_EXPECTED = {
  economy:        ['water', 'softDrinks', 'beerWine', 'hotMeal'],
  premiumEconomy: ['water', 'softDrinks', 'beerWine', 'snack', 'hotMeal', 'courses'],
  businessClass:  ['water', 'softDrinks', 'beerWine', 'spirits', 'champagne', 'snack', 'hotMeal', 'courses'],
  firstClass:     ['water', 'softDrinks', 'beerWine', 'spirits', 'champagne', 'snack', 'hotMeal', 'courses', 'fineDining'],
};

export const CATERING_TIERS = {
  basic:    { id: 'basic',    name: 'Basic',    cost: 0.6, value: 0.70 },
  standard: { id: 'standard', name: 'Standard', cost: 1.0, value: 1.00 },
  premium:  { id: 'premium',  name: 'Premium',  cost: 1.5, value: 1.25 },
};
export const CATERING_TIER_ORDER = ['basic', 'standard', 'premium'];

export const CABIN_LABELS = {
  economy: 'Economy', premiumEconomy: 'Premium economy', businessClass: 'Business', firstClass: 'First',
};

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Hidden reference price as a multiple of cost (the classic buy-on-board margin). */
export const CATERING_REF_MARKUP = 2;
/** How fast buyers fall as the price rises past the reference. */
export const CATERING_PRICE_EXPONENT = 1.6;
/** Share of an item's value it keeps when sold at the reference price. */
export const CATERING_SOLD_VALUE_AT_REF = 0.38;
/** Highest price accepted, as a multiple of the reference. */
export const CATERING_MAX_PRICE_MULT = 5;
/** Premium cabins buy more often than economy at the reference price. */
const CABIN_TAKE_MULT = { economy: 1, premiumEconomy: 1.173, businessClass: 1.112, firstClass: 1.310 };
/** Extra buyers per unit of distance factor above 1 (classic: more on long flights). */
const TAKE_DISTANCE_SLOPE = 0.178;

export const CATERING_SCORE_NONE    = -12;  // classic None
export const CATERING_SCORE_FULL    = 11;   // classic Full
export const CATERING_SCORE_CEILING = 17;
const SCORE_SPAN = CATERING_SCORE_FULL - CATERING_SCORE_NONE;   // 23

/** Meals count for this much of their long-haul value on a short flight. */
const SHORT_MEAL_FACTOR = 0.5;
const SHORT_KM = 1000, LONG_KM = 4000;

export const MAX_CATERING_PLANS = 12;
export const CATERING_PLAN_NAME_MAX = 32;

// Per cabin: how much the non-meal items scale up on a short flight so the
// expected set still sums to 1.0 with the meal items at half value.
const SHORT_OTHER_FACTOR = Object.fromEntries(CABIN_CLASSES.map(cabin => {
  let meal = 0, other = 0;
  for (const id of CATERING_EXPECTED[cabin]) {
    const it = CATERING_ITEM_MAP[id];
    if (it.meal) meal += it.value[cabin]; else other += it.value[cabin];
  }
  return [cabin, other > 0 ? 1 + (meal * (1 - SHORT_MEAL_FACTOR)) / other : 1];
}));

// ─── Refs ────────────────────────────────────────────────────────────────────

export const PLAN_PREFIX = 'plan:';
export const isPlanRef = (ref) => typeof ref === 'string' && ref.startsWith(PLAN_PREFIX);
export const planRef   = (id) => `${PLAN_PREFIX}${id}`;
export const planIdOf  = (ref) => (isPlanRef(ref) ? ref.slice(PLAN_PREFIX.length) : null);

/** The plan a ref points at, or null (classic level, or a plan that is gone). */
export function planForRef(ref, plans) {
  const id = planIdOf(ref);
  return id && plans ? (plans[id] ?? null) : null;
}

/** A valid catering ref: a live plan ref stays, anything else becomes a classic level. */
export function normalizeCateringRef(ref, plans) {
  if (planForRef(ref, plans)) return ref;
  return normalizeCateringLevel(ref);
}

/** Display name for a ref. */
export function cateringRefName(ref, plans) {
  const p = planForRef(ref, plans);
  return p ? p.name : CATERING_LEVELS[normalizeCateringLevel(ref)].name;
}

/** Attach the resolved plan to a route copy. No plan ref → the same object back. */
export function withCateringPlan(route, plans) {
  if (!route || !plans) return route;
  const plan = planForRef(route.cateringLevel, plans);
  if (!plan || route.cateringPlan === plan) return route;
  return { ...route, cateringPlan: plan };
}

// ─── Kitchens ────────────────────────────────────────────────────────────────
//
// Kitchen types reuse the contract cap ids: 'full' makes everything, 'hybrid'
// (a standard kitchen) cannot make fine dining or the Premium tier, 'partial'
// (a snack-box kitchen) also cannot make hot meals or extra courses.

export const KITCHEN_NAMES = { full: 'Full kitchen', hybrid: 'Standard kitchen', partial: 'Snack-box kitchen' };
const KITCHEN_CANNOT = {
  full:    new Set(),
  hybrid:  new Set(['fineDining']),
  partial: new Set(['fineDining', 'hotMeal', 'courses']),
};
export function kitchenCanMake(kitchen, itemId) {
  return !(KITCHEN_CANNOT[kitchen] ?? KITCHEN_CANNOT.full).has(itemId);
}
export function kitchenTier(kitchen, tier) {
  return (kitchen && kitchen !== 'full' && tier === 'premium') ? 'standard' : tier;
}

// ─── Item maths ──────────────────────────────────────────────────────────────

const tierOf = (item, entry) => (item.tiered && CATERING_TIERS[entry?.tier] ? entry.tier : 'standard');

/** Cost per serving at the reference distance, or null when the cabin has no such item. */
export function itemCost(itemId, cabin, tier = 'standard') {
  const base = CATERING_ITEM_MAP[itemId]?.cost?.[cabin];
  if (base == null) return null;
  return base * (CATERING_TIERS[tier]?.cost ?? 1);
}

/** The hidden reference price. Not for display. */
export function itemReferencePrice(itemId, cabin, tier = 'standard') {
  const c = itemCost(itemId, cabin, tier);
  return c == null ? null : c * CATERING_REF_MARKUP;
}

export function itemMaxPrice(itemId, cabin, tier = 'standard') {
  const r = itemReferencePrice(itemId, cabin, tier);
  return r == null ? 0 : Math.round(r * CATERING_MAX_PRICE_MULT * 100) / 100;
}

/** Long/short blend position: 0 on a short hop, 1 from LONG_KM up. */
function haul(distKm) {
  return Math.max(0, Math.min(1, ((distKm ?? LONG_KM) - SHORT_KM) / (LONG_KM - SHORT_KM)));
}

/** What an item is worth to this cabin at this distance (Standard tier, free). */
export function itemValue(itemId, cabin, distKm) {
  const it = CATERING_ITEM_MAP[itemId];
  const long = it?.value?.[cabin] ?? 0;
  if (!long) return 0;
  const short = long * (it.meal ? SHORT_MEAL_FACTOR : SHORT_OTHER_FACTOR[cabin]);
  const t = haul(distKm);
  return short + (long - short) * t;
}

/** Share of the cabin that buys at this price. */
export function itemTakeRate(itemId, cabin, tier, price, distKm) {
  const it = CATERING_ITEM_MAP[itemId];
  const ref = itemReferencePrice(itemId, cabin, tier);
  if (!it || ref == null) return 0;
  if (!(price > 0)) return 1;
  const f = cateringDistanceFactor(distKm);
  const base = it.take * CABIN_TAKE_MULT[cabin] * (1 + TAKE_DISTANCE_SLOPE * (f - 1));
  return Math.max(0, Math.min(1, base * Math.pow(ref / price, CATERING_PRICE_EXPONENT)));
}

/** Share of its free value a sold item keeps at this price. */
export function soldValueFactor(itemId, cabin, tier, price) {
  const ref = itemReferencePrice(itemId, cabin, tier);
  if (ref == null) return 0;
  if (!(price > 0)) return 1;
  return Math.max(0, 1 - (1 - CATERING_SOLD_VALUE_AT_REF) * price / ref);
}

/** Cabin value (1.0 = the expected set) → quality score. */
export function cabinScoreFromValue(v) {
  if (v <= 1) return CATERING_SCORE_NONE + SCORE_SPAN * Math.max(0, v);
  return CATERING_SCORE_FULL
    + (CATERING_SCORE_CEILING - CATERING_SCORE_FULL) * (1 - Math.exp(-2 * (v - 1)));
}

/** Is this entry actually serving something? A sold item with no price is not. */
function entryActive(entry) {
  if (!entry) return false;
  if (entry.mode === 'free') return true;
  return entry.mode === 'sold' && entry.price > 0;
}

/**
 * One cabin's menu, cooked by one kitchen, at one distance.
 * Money is per passenger on board, already scaled for distance.
 *
 *   { costPerPax, revenuePerPax, netPerPax, value, score,
 *     rows: { [itemId]: { mode, tier, servedTier, made, take, costPerPax,
 *                         revenuePerPax, netPerPax, points, pointsIfFree, shadowed } } }
 *
 * `points` is what the item adds to the cabin score on the straight part of the
 * scale; `pointsIfFree` is what it would add free at the tier served — the
 * marker on the editor's quality bar.
 */
export function cabinMenuEconomics(menu, cabin, distKm, kitchen = 'full') {
  const f = cateringDistanceFactor(distKm);
  const rows = {};
  let cost = 0, revenue = 0, value = 0;
  const slotBest = {};
  for (const it of CATERING_ITEMS) {
    const entry = menu?.[it.id];
    if (!entryActive(entry) || it.cost[cabin] == null) continue;
    const tier = tierOf(it, entry);
    const made = kitchenCanMake(kitchen, it.id);
    const servedTier = kitchenTier(kitchen, tier);
    const row = { mode: entry.mode, tier, servedTier, made, take: 0, costPerPax: 0,
      revenuePerPax: 0, netPerPax: 0, points: 0, pointsIfFree: 0, shadowed: false };
    rows[it.id] = row;
    if (!made) continue;
    const unit = itemCost(it.id, cabin, servedTier);
    const free = itemValue(it.id, cabin, distKm) * CATERING_TIERS[servedTier].value;
    let take = 1, keep = 1;
    if (entry.mode === 'sold') {
      // Charged the price typed; the passenger judges it against the tier served.
      take = itemTakeRate(it.id, cabin, servedTier, entry.price, distKm);
      keep = soldValueFactor(it.id, cabin, servedTier, entry.price);
      row.revenuePerPax = take * entry.price * f;
    }
    row.take = take;
    row.costPerPax = take * unit * f;
    row.netPerPax = row.revenuePerPax - row.costPerPax;
    row.pointsIfFree = free * SCORE_SPAN;
    const v = free * keep;
    row.points = v * SCORE_SPAN;
    cost += row.costPerPax;
    revenue += row.revenuePerPax;
    if (it.slot) {
      const best = slotBest[it.slot];
      if (!best || v > best.v) { if (best) best.row.shadowed = true; slotBest[it.slot] = { v, row }; }
      else row.shadowed = true;
    } else {
      value += v;
    }
  }
  for (const b of Object.values(slotBest)) value += b.v;
  for (const r of Object.values(rows)) if (r.shadowed) r.points = 0;
  return {
    costPerPax: cost, revenuePerPax: revenue, netPerPax: revenue - cost,
    value, score: cabinScoreFromValue(value), rows,
  };
}

const FULL_KITCHENS = ['full'];
function kitchenList(kitchens) {
  return Array.isArray(kitchens) && kitchens.length ? kitchens : FULL_KITCHENS;
}

/**
 * One cabin of a plan on a route: the mean over the kitchens cooking at each
 * end, because each end caters its own departures. Same shape as
 * cabinMenuEconomics, with `missing` listing items some kitchen could not make
 * and `downgraded` those served a tier down.
 */
export function planCabinEconomics(plan, cabin, distKm, kitchens = null) {
  const list = kitchenList(kitchens);
  const menu = plan?.cabins?.[cabin];
  if (list.every(k => k === list[0])) {
    const one = cabinMenuEconomics(menu, cabin, distKm, list[0]);
    return { ...one, ...kitchenGaps([one]) };
  }
  const parts = list.map(k => cabinMenuEconomics(menu, cabin, distKm, k));
  const n = parts.length;
  const avg = (pick) => parts.reduce((s, p) => s + pick(p), 0) / n;
  const rows = {};
  for (const id of Object.keys(parts[0].rows)) {
    const rs = parts.map(p => p.rows[id]);
    const mean = (k) => rs.reduce((s, r) => s + r[k], 0) / n;
    rows[id] = {
      mode: rs[0].mode, tier: rs[0].tier, servedTier: rs[0].servedTier,
      made: rs.every(r => r.made), shadowed: rs.every(r => r.shadowed),
      take: mean('take'), costPerPax: mean('costPerPax'), revenuePerPax: mean('revenuePerPax'),
      netPerPax: mean('netPerPax'), points: mean('points'), pointsIfFree: mean('pointsIfFree'),
    };
  }
  return {
    costPerPax: avg(p => p.costPerPax), revenuePerPax: avg(p => p.revenuePerPax),
    netPerPax: avg(p => p.netPerPax), value: avg(p => p.value), score: avg(p => p.score),
    rows, ...kitchenGaps(parts),
  };
}

function kitchenGaps(parts) {
  const missing = new Set(), downgraded = new Set();
  for (const p of parts) for (const [id, r] of Object.entries(p.rows)) {
    if (!r.made) missing.add(id);
    else if (r.servedTier !== r.tier) downgraded.add(id);
  }
  return { missing: [...missing], downgraded: [...downgraded] };
}

// ─── Route level ─────────────────────────────────────────────────────────────

/**
 * How much each cabin counts toward the route's catering quality: economy half,
 * the premium cabins the other half split by seats. A cabin with no seats counts
 * nothing; a one-cabin aircraft is that cabin alone. With no layout to read,
 * economy and business share it equally.
 */
export function cabinQualityWeights(config) {
  const seats = (c) => Math.max(0, Number(config?.[c]) || 0);
  const premium = CABIN_CLASSES.filter(c => c !== 'economy' && seats(c) > 0);
  const premiumSeats = premium.reduce((s, c) => s + seats(c), 0);
  const w = {};
  if (!config || (seats('economy') === 0 && premiumSeats === 0)) return { economy: 0.5, businessClass: 0.5 };
  if (seats('economy') > 0 && premiumSeats > 0) {
    w.economy = 0.5;
    for (const c of premium) w[c] = 0.5 * seats(c) / premiumSeats;
  } else if (seats('economy') > 0) {
    w.economy = 1;
  } else {
    for (const c of premium) w[c] = seats(c) / premiumSeats;
  }
  return w;
}

/** A plan's blended cabin score before the distance amplifier (unrounded). */
export function planBlendedScore(plan, distKm, config = null, kitchens = null) {
  const w = cabinQualityWeights(config);
  let s = 0;
  for (const [cabin, weight] of Object.entries(w)) s += weight * planCabinEconomics(plan, cabin, distKm, kitchens).score;
  return s;
}

/** Quality-score delta (whole points) for a plan on a route — the plan twin of cateringQualityBonus. */
export function planQualityBonus(plan, distKm, config = null, kitchens = null) {
  return Math.round(planBlendedScore(plan, distKm, config, kitchens) * cateringQualityAmplifier(distKm));
}

/**
 * Weekly catering cost and revenue for a route on a plan — the plan twin of
 * routeCatering, same shape. classSummary passengers are one-way per direction.
 */
export function planRouteCatering(plan, classSummary = {}, distKm = 0, kitchens = null) {
  let cost = 0, revenue = 0;
  const byClass = {};
  for (const cls of CABIN_CLASSES) {
    const paxBoth = (classSummary[cls]?.passengers ?? 0) * 2;
    const e = paxBoth > 0 ? planCabinEconomics(plan, cls, distKm, kitchens) : null;
    const c = e ? e.costPerPax * paxBoth : 0, r = e ? e.revenuePerPax * paxBoth : 0;
    cost += c; revenue += r;
    byClass[cls] = { treatment: 'plan', pax: paxBoth, cost: Math.round(c), revenue: Math.round(r) };
  }
  return {
    level: planRef(plan.id), planId: plan.id, planName: plan.name,
    distanceFactor: cateringDistanceFactor(distKm),
    cost: Math.round(cost), revenue: Math.round(revenue), net: Math.round(revenue - cost),
    byClass,
  };
}

// ─── What the simulators call ────────────────────────────────────────────────
//
// A route copy carries `cateringPlan` (attached at hydration) when its pair is
// on a plan, and `cateringKitchens` when a contract cooks for it. Without a plan
// these are the classic functions, argument for argument.

export function routeCateringEconomics(route, classSummary, distKm) {
  if (route?.cateringPlan) return planRouteCatering(route.cateringPlan, classSummary, distKm, route.cateringKitchens);
  return routeCatering(normalizeCateringLevel(route?.cateringLevel), classSummary, distKm);
}

/** Catering quality points for a route, before any contract quality delta. */
export function routeCateringQuality(route, distKm, config = null) {
  if (route?.cateringPlan) return planQualityBonus(route.cateringPlan, distKm, config, route.cateringKitchens);
  return cateringQualityBonus(normalizeCateringLevel(route?.cateringLevel), distKm);
}

// ─── Plans: templates, sanitising, summaries ─────────────────────────────────

const free = (ids) => Object.fromEntries(ids.map(id => [id, { mode: 'free', tier: 'standard' }]));
const sold = (cabin, ids) => Object.fromEntries(ids.map(id =>
  [id, { mode: 'sold', tier: 'standard', price: itemReferencePrice(id, cabin, 'standard') }]));
const SALE_SET = ['softDrinks', 'beerWine', 'snack', 'coldMeal', 'hotMeal'];

/** The item menu that stands in for a classic level when the player customises it. */
export function classicTemplateCabins(level) {
  const lvl = normalizeCateringLevel(level);
  const cabins = {};
  for (const cabin of CABIN_CLASSES) {
    if (lvl === 'none') cabins[cabin] = {};
    else if (lvl === 'paid') cabins[cabin] = sold(cabin, SALE_SET);
    else if (cabin !== 'economy' || lvl === 'full') cabins[cabin] = free(CATERING_EXPECTED[cabin]);
    else if (lvl === 'partial') cabins[cabin] = sold(cabin, SALE_SET);
    else cabins[cabin] = { ...free(['water', 'softDrinks', 'coldMeal']), ...sold(cabin, ['beerWine', 'spirits', 'hotMeal']) };
  }
  return cabins;
}

/** A clean plan record from anything: unknown items dropped, prices clamped. */
export function sanitizeCateringPlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  if (!id) return null;
  const name = String(raw.name ?? '').trim().slice(0, CATERING_PLAN_NAME_MAX) || 'Service plan';
  const cabins = {};
  for (const cabin of CABIN_CLASSES) {
    const out = {};
    for (const it of CATERING_ITEMS) {
      const e = raw.cabins?.[cabin]?.[it.id];
      if (!e || it.cost[cabin] == null) continue;
      if (e.mode !== 'free' && e.mode !== 'sold') continue;
      const tier = tierOf(it, e);
      const entry = { mode: e.mode, tier };
      if (e.mode === 'sold') {
        const p = Number(e.price);
        entry.price = Number.isFinite(p) && p > 0
          ? Math.min(itemMaxPrice(it.id, cabin, tier), Math.round(p * 100) / 100) : null;
      }
      out[it.id] = entry;
    }
    cabins[cabin] = out;
  }
  const basedOn = CATERING_LEVELS[raw.basedOn] ? raw.basedOn : null;
  return { id, name, ...(basedOn ? { basedOn } : {}), cabins };
}

/** Why a plan cannot be saved, or null. */
export function cateringPlanSaveError(plan, plans = {}) {
  if (!plan) return 'That plan is not valid.';
  const others = Object.values(plans ?? {}).filter(p => p.id !== plan.id);
  if (!plans?.[plan.id] && others.length >= MAX_CATERING_PLANS) return `You can keep up to ${MAX_CATERING_PLANS} service plans.`;
  if (others.some(p => p.name.toLowerCase() === plan.name.toLowerCase())) return `You already have a plan called ${plan.name}.`;
  return null;
}

/** Pair keys and multi-stop route ids using a plan, for "in use" checks and counts. */
export function cateringPlanUsage(planId, state) {
  const ref = planRef(planId);
  const pairs = Object.entries(state?.routeCatering ?? {}).filter(([, v]) => v === ref).map(([k]) => k);
  const routes = (state?.routes ?? []).filter(r => r.cateringLevel === ref && r.segmentPrices).map(r => r.id);
  return { pairs, routes, isDefault: state?.defaultCateringLevel === ref, count: pairs.length + routes.length };
}

/**
 * What a ref costs, earns and scores per passenger at a distance on a layout —
 * the figure every picker and the plan list show. Works for classic levels too
 * (their per-passenger figures come from the classic maths on the layout).
 */
export function cateringRefSummary(ref, plans, distKm, config = null, kitchens = null) {
  const plan = planForRef(ref, plans);
  const cfg = config ?? { economy: 150, businessClass: 12 };
  const summary = Object.fromEntries(CABIN_CLASSES.map(c => [c, { passengers: (Number(cfg[c]) || 0) / 2 }]));
  const pax = CABIN_CLASSES.reduce((s, c) => s + (Number(cfg[c]) || 0), 0) || 1;
  const fakeRoute = plan ? { cateringPlan: plan, cateringKitchens: kitchens } : { cateringLevel: ref };
  const econ = routeCateringEconomics(fakeRoute, summary, distKm);
  return {
    isPlan: !!plan,
    name: cateringRefName(ref, plans),
    costPerPax: econ.cost / pax, revenuePerPax: econ.revenue / pax, netPerPax: econ.net / pax,
    quality: routeCateringQuality(fakeRoute, distKm, cfg),
  };
}

export { CATERING_LEVEL_ORDER };
