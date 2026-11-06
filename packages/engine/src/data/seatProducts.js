// seatProducts.js — what is bolted into each cabin.
//
// Classes decide the layout (how many seats of each kind); seat QUALITY (the
// basic→luxury grade in simulation.js) decides the hardware finish throughout;
// these products decide what KIND of seat each cabin has: economy pitch,
// business lie-flats, first-class suites, a bar on the upper deck. Each
// product trades floor, cost and quality points:
//
//   space   floor per seat, relative to the class's own multiplier
//           (CLASS_SPACE_MULTIPLIERS): a lie-flat at 1.75 takes 1.5 × 1.75
//           economy seats of floor. Pitch is the one that gives floor BACK.
//   pts     quality points the cabin's passengers see. Economy's points reach
//           the LEISURE segment; the premium cabins' points reach the BUSINESS
//           segment (cabinProductPoints) — suites do not sell cheap seats.
//   fee     one-off fitting fee per seat (perAircraft: true → per airframe)
//   weekly  upkeep per seat per route-week (perAircraft → per route-week flat)
//   from    the calendar year the product exists (era worlds; null = always)
//   needs   airframe rule: 'wide' (Wide Body or Double Deck), 'deck2'
//
// A config with no `products` is the legacy cabin: every tier at its default,
// no extras, zero points, zero cost, legacy floor — byte-identical to before
// this file existed. That is the parity invariant and the test enforces it.

export const CABIN_KEYS = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];

const T = (key, label, o = {}) => ({ key, label, space: 1, pts: 0, fee: 0, weekly: 0, from: null, needs: null, ...o });

export const SEAT_PRODUCTS = {
  economy: {
    label: 'Economy',
    tierLabel: 'Seat pitch',
    tiers: [
      T('28', '28" pitch', { space: 0.93, pts: -5, desc: 'Knees in the seat ahead. Seven per cent more seats on the same floor.' }),
      T('30', '30" pitch', { desc: 'The standard economy row.' }),
      T('32', '32" pitch', { space: 1.07, pts: 4,  desc: 'Room to open a laptop. Seven per cent fewer seats.' }),
      T('34', '34" pitch', { space: 1.14, pts: 8,  desc: 'Legroom you notice. A seventh of the floor goes to it.' }),
    ],
    extras: [
      T('screens', 'Seatback screens', { pts: 3, fee: 1_500, weekly: 4, from: 1992, desc: 'A screen in every seatback.' }),
      T('power',   'Seat power',       { pts: 2, fee: 400,   weekly: 1, from: 2005, desc: 'USB and a socket at every seat.' }),
    ],
  },
  premiumEconomy: {
    label: 'Premium Economy',
    tierLabel: 'Seat pitch',
    tiers: [
      T('36', '36" pitch', { space: 0.95, pts: -3, desc: 'A wider seat, little more legroom.' }),
      T('38', '38" pitch', { desc: 'The usual premium-economy row.' }),
      T('40', '40" pitch', { space: 1.06, pts: 4,  desc: 'Stretch out. Six per cent fewer seats.' }),
    ],
    extras: [
      T('legrest', 'Leg rests',       { pts: 2, fee: 800,   weekly: 2, desc: 'A leg rest and deeper recline.' }),
      T('screens', 'Seatback screens', { pts: 3, fee: 1_800, weekly: 4, from: 1992, desc: 'A bigger screen than economy gets.' }),
    ],
  },
  businessClass: {
    label: 'Business',
    tierLabel: 'Seat type',
    tiers: [
      T('recliner', 'Recliner',        { desc: 'A wide seat that leans back. The business class of the jet age.' }),
      T('cradle',   'Cradle seat',     { space: 1.05, pts: 4,  fee: 8_000,  weekly: 10, from: 1990, desc: 'Leg rest, deep recline, a cradle to doze in.' }),
      T('angled',   'Angled lie-flat', { space: 1.12, pts: 9,  fee: 20_000, weekly: 20, from: 1996, desc: 'Flat, but on a slope. Sleep with a slide.' }),
      T('flat',     'Fully flat bed',  { space: 1.18, pts: 15, fee: 40_000, weekly: 35, from: 2000, desc: 'A proper bed. The modern long-haul standard.' }),
      T('suite',    'Suite with door', { space: 1.3,  pts: 22, fee: 80_000, weekly: 60, from: 2014, desc: 'A flat bed behind a sliding door.' }),
    ],
    extras: [
      T('aisle',   'Direct aisle access', { space: 1.12, pts: 6, fee: 5_000, from: 2006, desc: '1-2-1: nobody climbs over anybody. Costs floor.' }),
      T('screens', 'Personal screens',    { pts: 3, fee: 2_500, weekly: 5, from: 1992, desc: 'A large screen at every seat.' }),
    ],
  },
  firstClass: {
    label: 'First',
    tierLabel: 'Seat type',
    tiers: [
      T('recliner',  'Recliner',  { desc: 'The widest seat on the aircraft, and an ottoman.' }),
      T('sleeper',   'Sleeper seat', { space: 1.1,  pts: 6,  fee: 15_000,  weekly: 20,  from: 1980, desc: 'Reclines flat. Linen and a duvet.' }),
      T('suite',     'Suite',        { space: 1.3,  pts: 14, fee: 90_000,  weekly: 80,  from: 1998, desc: 'A private cabin with a bed and a seat.' }),
      T('apartment', 'Apartment',    { space: 1.7,  pts: 24, fee: 250_000, weekly: 200, from: 2014, needs: 'wide', desc: 'A room: bed, armchair, wardrobe. Widebodies only.' }),
    ],
    extras: [
      T('bar',    'Onboard bar',    { pts: 5, fee: 400_000,   weekly: 2_000, from: 1970, needs: 'wide',  perAircraft: true, desc: 'A lounge with a bartender. Widebodies only.' }),
      T('shower', 'Shower suite',   { pts: 8, fee: 1_200_000, weekly: 3_000, from: 2008, needs: 'deck2', perAircraft: true, desc: 'A shower in the sky. Double-deckers only.' }),
    ],
  },
};

const DEFAULT_TIER = { economy: '30', premiumEconomy: '38', businessClass: 'recliner', firstClass: 'recliner' };

/** The product definitions for one cabin: { tier, extras[] }, defaults filled. */
export function productOf(config, cls) {
  const def = SEAT_PRODUCTS[cls];
  const raw = config?.products?.[cls];
  const tier = def.tiers.find(t => t.key === (raw?.tier ?? DEFAULT_TIER[cls])) ?? def.tiers.find(t => t.key === DEFAULT_TIER[cls]);
  const want = Array.isArray(raw?.extras) ? raw.extras : [];
  const extras = def.extras.filter(e => want.includes(e.key));
  return { tier, extras };
}

/** True when the config carries any product above the legacy defaults. */
export function hasProducts(config) {
  const p = config?.products;
  if (!p || typeof p !== 'object') return false;
  return CABIN_KEYS.some(cls => {
    const { tier, extras } = productOf(config, cls);
    return tier.key !== DEFAULT_TIER[cls] || extras.length > 0;
  });
}

/** Floor per seat in this cabin, relative to the class multiplier. 1 for legacy. */
export function productSpaceMul(config, cls) {
  if (!config?.products) return 1;
  const { tier, extras } = productOf(config, cls);
  return extras.reduce((m, e) => m * e.space, tier.space);
}

/** Quality points this cabin's passengers see from its products. 0 for legacy. */
export function productQualityPts(config, cls) {
  if (!config?.products) return 0;
  const { tier, extras } = productOf(config, cls);
  return extras.reduce((s, e) => s + e.pts, tier.pts);
}

/**
 * Product quality points by audience.
 *   blended   seat-weighted across every cabin — the figure that goes into the
 *             single quality score everything else reads
 *   leisure   what an economy passenger sees (the economy cabin's products)
 *   business  what a premium passenger sees (seat-weighted over the premium
 *             cabins; the economy cabin's when the aircraft has none)
 * All three are 0 for a legacy config.
 */
export function cabinProductPoints(config) {
  if (!config?.products) return { blended: 0, leisure: 0, business: 0 };
  let seatsAll = 0, ptsAll = 0, seatsPrem = 0, ptsPrem = 0;
  for (const cls of CABIN_KEYS) {
    const n = Math.max(0, config[cls] ?? 0);
    if (n === 0) continue;
    const p = productQualityPts(config, cls);
    seatsAll += n; ptsAll += n * p;
    if (cls !== 'economy') { seatsPrem += n; ptsPrem += n * p; }
  }
  const blended  = seatsAll > 0 ? ptsAll / seatsAll : 0;
  const economy  = (config.economy ?? 0) > 0 ? productQualityPts(config, 'economy') : blended;
  const business = seatsPrem > 0 ? ptsPrem / seatsPrem : economy;
  return { blended, leisure: economy, business };
}

/** Weekly upkeep for the products aboard, per route-week. 0 for legacy. */
export function productWeeklyCost(config) {
  if (!config?.products) return 0;
  let total = 0;
  for (const cls of CABIN_KEYS) {
    const n = Math.max(0, config[cls] ?? 0);
    const { tier, extras } = productOf(config, cls);
    if (n > 0) total += n * tier.weekly;
    for (const e of extras) total += e.perAircraft ? (n > 0 ? e.weekly : 0) : n * e.weekly;
  }
  return Math.round(total);
}

/**
 * One-off fitting for the products a refit (or order) introduces. Removals and
 * downgrades are free, as with every other cabin charge; seats ADDED to a cabin
 * with a paid product pay for their own hardware.
 */
export function productFittingCost(current, next) {
  if (!next?.products) return 0;
  let total = 0;
  for (const cls of CABIN_KEYS) {
    const nNow = Math.max(0, current?.[cls] ?? 0), nNext = Math.max(0, next?.[cls] ?? 0);
    if (nNext === 0) continue;
    const cur = productOf(current ?? {}, cls), nxt = productOf(next, cls);
    // Tier: a change pays for every seat; the same tier pays for the new seats.
    if (nxt.tier.key !== cur.tier.key) total += nxt.tier.fee * nNext;
    else total += nxt.tier.fee * Math.max(0, nNext - nNow);
    for (const e of nxt.extras) {
      const had = cur.extras.some(x => x.key === e.key);
      if (e.perAircraft) { if (!had) total += e.fee; continue; }
      total += e.fee * (had ? Math.max(0, nNext - nNow) : nNext);
    }
  }
  return Math.round(total);
}

const isWide  = (type) => type?.category === 'Wide Body' || type?.category === 'Double Deck';
const isDeck2 = (type) => type?.category === 'Double Deck';

/** Why this product can't go on this aircraft in this year, or null. */
export function productAvailability(item, { calYear = null, type = null } = {}) {
  if (item.from != null && calYear != null && calYear < item.from) {
    return { code: 'not_yet_invented', message: `${item.label} does not exist yet — it arrives around ${item.from}.` };
  }
  if (item.needs === 'wide' && type && !isWide(type)) return { code: 'airframe', message: `${item.label} needs a widebody.` };
  if (item.needs === 'deck2' && type && !isDeck2(type)) return { code: 'airframe', message: `${item.label} needs a double-decker.` };
  return null;
}

/** The first product in a config that this world and airframe refuse, or null. */
export function productDenial(config, ctx) {
  if (!config?.products) return null;
  for (const cls of CABIN_KEYS) {
    if ((config[cls] ?? 0) <= 0 && !config.products[cls]) continue;
    const { tier, extras } = productOf(config, cls);
    for (const item of [tier, ...extras]) {
      const why = productAvailability(item, ctx);
      if (why) return { cls, item: item.key, ...why };
    }
  }
  return null;
}

/** A products object with every cabin at its default (for the editors). */
export function defaultProducts() {
  const out = {};
  for (const cls of CABIN_KEYS) out[cls] = { tier: DEFAULT_TIER[cls], extras: [] };
  return out;
}

/** Drop a products object back to `undefined` when it is all defaults. */
export function compactProducts(products) {
  if (!products) return undefined;
  const cfg = { products };
  return hasProducts(cfg) ? products : undefined;
}
