// Catering contracts — who cooks, what you agreed to pay, and for how long.
//
// catering.js answers "how good is the meal on this route?" (the per-route
// service LEVEL). This module answers the commercial question an airline
// actually signs for: which supplier provisions each airport, at what rate,
// how good they are able to be, and for how many years you are locked in.
//
// Design locked with Dave 2026-09-21 (CATERING_CONTRACTS_PLAN.md §4):
//
//   Coverage     A contract covers a REGION — one country, one continent
//                (airports.js getRegion), or the whole world. At an airport the
//                most SPECIFIC covering contract applies: country > continent >
//                global. One contract per coverage key.
//   Hub kitchen  Best-of, never stacked. At each endpoint the cheaper of the hub
//                flight kitchen and the contract rate is who COOKS — and the
//                cook's quality cap and quality delta come with them. A premium
//                caterer therefore buys nothing at a hub whose kitchen is
//                cheaper: you cook there yourself.
//   Quality cap  A route delivers the lower of its chosen level and the cap of
//                any caterer cooking for it. You pay for what is delivered; the
//                route screen says so.
//   Market       One book per world: prices drift ±8% on a fixed 26-week clock
//                keyed to the world calendar, so every airline in a Headwinds
//                world sees the same offers with no server state. Signing never
//                takes a supplier away from anyone.
//   Gating       None. Below a supplier's minimum volume (weekly seats departing
//                airports it covers) the rate carries a surcharge of up to 20%.
//   Exit         Break early for 35% of the remaining spend: weeks left × last
//                week's spend under the contract × 0.35.
//
// Cargo is ignored entirely: freighters carry no catering.
//
// State: cateringContracts: { [id]: { id, supplierId, coverage, termWeeks,
//          signedWeek, costFactor, qualityCap, qualityDelta, minVolume } }
// Spread CONDITIONALLY everywhere (freshState, write-back, load, report) so a
// world that never signs one is byte-identical — the golden-master contract the
// ground stations established.
//
// Shared by the reducer (enforcement), the tick (effects) and the UI (display):
// the UI never quotes a number the reducer will not charge.

import { getAirport, getRegion } from './airports.js';
import { getAircraftType } from './aircraft.js';
import { CATERING_LEVEL_ORDER, normalizeCateringLevel } from './catering.js';

// ─── Supplier catalogue ──────────────────────────────────────────────────────
//
// Invented names only. costFactor multiplies the route catering cost at the
// airports the supplier cooks for; qualityDelta is added to the catering quality
// points; qualityCap is the best level the supplier can actually deliver.

export const CATERING_SUPPLIERS = [
  // Global
  { id: 'meridian',   name: 'Meridian Skychefs',       coverage: { kind: 'global' },
    costFactor: 1.30, qualityDelta: 4,  qualityCap: 'full',    minVolume: 6000,
    blurb: 'Five-continent premium caterer. Chef-designed menus; priced like it.' },
  { id: 'orbital',    name: 'Orbital Inflight',        coverage: { kind: 'global' },
    costFactor: 1.05, qualityDelta: 0,  qualityCap: 'full',    minVolume: 4000,
    blurb: 'The industry default. Everywhere, reliable, unremarkable.' },
  { id: 'traytrolley',name: 'Tray & Trolley Co.',      coverage: { kind: 'global' },
    costFactor: 0.82, qualityDelta: -3, qualityCap: 'hybrid',  minVolume: 2500,
    blurb: 'Global budget provisioning. Cheap, but no silver service.' },

  // Continental
  { id: 'prairie',    name: 'Prairie Provisions',      coverage: { kind: 'continent', region: 'North America' },
    costFactor: 0.88, qualityDelta: 0,  qualityCap: 'full',    minVolume: 1500,
    blurb: 'North American regional caterer with kitchens at every major field.' },
  { id: 'galley',     name: 'Continental Galley',      coverage: { kind: 'continent', region: 'Europe' },
    costFactor: 0.88, qualityDelta: 1,  qualityCap: 'full',    minVolume: 1500,
    blurb: 'European network caterer. Good bread.' },
  { id: 'jade',       name: 'Jade Kitchen Group',      coverage: { kind: 'continent', region: 'Asia' },
    costFactor: 0.85, qualityDelta: 1,  qualityCap: 'full',    minVolume: 1500,
    blurb: 'Pan-Asian caterer with a strong premium-cabin reputation.' },
  { id: 'falcon',     name: 'Falcon Air Catering',     coverage: { kind: 'continent', region: 'Middle East' },
    costFactor: 0.95, qualityDelta: 3,  qualityCap: 'full',    minVolume: 800,
    blurb: 'Gulf-based luxury caterer. Regional, but premium throughout.' },
  { id: 'southern',   name: 'Southern Cross Caterers', coverage: { kind: 'continent', region: 'Oceania' },
    costFactor: 0.90, qualityDelta: 0,  qualityCap: 'full',    minVolume: 600,
    blurb: 'Australasian caterer; long-haul experience, small network.' },
  { id: 'andes',      name: 'Andes Inflight',          coverage: { kind: 'continent', region: 'South America' },
    costFactor: 0.84, qualityDelta: -1, qualityCap: 'hybrid',  minVolume: 600,
    blurb: 'South American caterer. Solid economy service, limited premium.' },
  { id: 'savanna',    name: 'Savanna Skyfare',         coverage: { kind: 'continent', region: 'Africa' },
    costFactor: 0.86, qualityDelta: -2, qualityCap: 'hybrid',  minVolume: 500,
    blurb: 'Pan-African caterer growing into long-haul.' },

  // Country budget
  { id: 'bigsky',     name: 'Big Sky Snacks',          coverage: { kind: 'country', country: 'US' },
    costFactor: 0.72, qualityDelta: -4, qualityCap: 'partial', minVolume: 800,
    blurb: 'US domestic snack-box specialist. Very cheap; premium cabins notice.' },
  { id: 'lunchbox',   name: 'Lunchbox Aviation',       coverage: { kind: 'country', country: 'GB' },
    costFactor: 0.75, qualityDelta: -3, qualityCap: 'partial', minVolume: 500,
    blurb: 'UK sandwich-and-crisps supplier to the low-cost end of the market.' },
  { id: 'lantern',    name: 'Red Lantern Catering',    coverage: { kind: 'country', country: 'CN' },
    costFactor: 0.74, qualityDelta: -2, qualityCap: 'hybrid',  minVolume: 800,
    blurb: 'Chinese domestic caterer, hot meals at a low price.' },
  { id: 'monsoon',    name: 'Monsoon Meals',           coverage: { kind: 'country', country: 'IN' },
    costFactor: 0.70, qualityDelta: -3, qualityCap: 'partial', minVolume: 600,
    blurb: 'Indian domestic caterer. Cheapest in the book.' },
];

export const CATERING_SUPPLIER_MAP = Object.fromEntries(CATERING_SUPPLIERS.map(s => [s.id, s]));

// ─── Terms, market, surcharge, exit ──────────────────────────────────────────

/** Contract lengths on offer, in years, and the rate multiplier each locks in. */
export const CATERING_TERMS = [
  { years: 1, weeks: 52,  rateMult: 1.00 },
  { years: 3, weeks: 156, rateMult: 0.94 },
  { years: 5, weeks: 260, rateMult: 0.88 },
];
export const CATERING_TERM_MAP = Object.fromEntries(CATERING_TERMS.map(t => [t.years, t]));

/** The book re-prices every this many weeks, on the world calendar. */
export const CATERING_BOOK_WINDOW_WEEKS = 26;
/** Maximum drift either side of a supplier's list rate in any window. */
export const CATERING_BOOK_DRIFT = 0.08;
/** Maximum surcharge when an airline is far below a supplier's minimum volume. */
export const CATERING_VOLUME_SURCHARGE = 0.20;
/** Fraction of remaining spend charged to break a contract early. */
export const CATERING_BREAK_FRACTION = 0.35;
/** Weeks before expiry the player is warned. */
export const CATERING_EXPIRY_WARNING_WEEKS = 8;

// Specificity: a country deal beats a continent deal beats a global deal.
const SPECIFICITY = { country: 3, continent: 2, global: 1 };

/** Stable key for a coverage — one contract per key. */
export function coverageKey(coverage) {
  if (!coverage) return '';
  if (coverage.kind === 'country')   return `country:${coverage.country}`;
  if (coverage.kind === 'continent') return `continent:${coverage.region}`;
  return 'global';
}

/** Human label for a coverage. */
export function coverageLabel(coverage) {
  if (!coverage) return '—';
  if (coverage.kind === 'country')   return coverage.country;
  if (coverage.kind === 'continent') return coverage.region;
  return 'Worldwide';
}

/** Does this coverage include the airport? */
export function coversAirport(coverage, code) {
  if (!coverage || !code) return false;
  if (coverage.kind === 'global') return true;
  const ap = getAirport(code);
  if (!ap) return false;
  if (coverage.kind === 'country')   return ap.country === coverage.country;
  if (coverage.kind === 'continent') return getRegion(ap.country) === coverage.region;
  return false;
}

// Deterministic 0..1 from a string — the same book for every airline and every
// preview in a world, because the only inputs are the supplier and the window.
function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 100000) / 100000;
}

/** The book window an absolute week falls in. */
export function cateringBookWindow(absWeek) {
  return Math.floor(Math.max(0, absWeek ?? 0) / CATERING_BOOK_WINDOW_WEEKS);
}

/** Weeks until the book next re-prices. */
export function weeksToNextReprice(absWeek) {
  const w = Math.max(0, absWeek ?? 0);
  return CATERING_BOOK_WINDOW_WEEKS - (w % CATERING_BOOK_WINDOW_WEEKS);
}

/**
 * This window's list rate for a supplier (before term discount and surcharge).
 * Drifts within ±CATERING_BOOK_DRIFT of the catalogue rate.
 */
export function supplierRateAt(supplierId, absWeek) {
  const s = CATERING_SUPPLIER_MAP[supplierId];
  if (!s) return null;
  const drift = (hash01(`${supplierId}|${cateringBookWindow(absWeek)}`) * 2 - 1) * CATERING_BOOK_DRIFT;
  return +(s.costFactor * (1 + drift)).toFixed(4);
}

/** The whole book for a week: every supplier with this window's rate per term. */
export function cateringOfferBook(absWeek) {
  return CATERING_SUPPLIERS.map(s => {
    const rate = supplierRateAt(s.id, absWeek);
    return {
      ...s,
      rate,
      terms: CATERING_TERMS.map(t => ({ ...t, costFactor: +(rate * t.rateMult).toFixed(4) })),
    };
  });
}

// ─── Volume ──────────────────────────────────────────────────────────────────

/**
 * Weekly seats departing each airport on the passenger schedule. A round trip
 * departs once from each end per frequency, a tag rotation from every stop;
 * dormant seasonal routes count nothing. Seats rather than passengers because
 * the surcharge must be knowable BEFORE the week is simulated — a previewed
 * route and the tick then quote the same rate.
 */
export function airportSeatsMap(routes = [], fleet = [], stopsOf) {
  const seatsOf = new Map();
  for (const a of fleet ?? []) seatsOf.set(a.id, getAircraftType(a.typeId)?.seats ?? 0);
  const out = {};
  for (const r of routes ?? []) {
    if (!r || r.seasonState === 'dormant') continue;
    const freq = Math.max(0, Number(r.weeklyFrequency) || 0);
    if (!freq) continue;
    const seats = seatsOf.get(r.aircraftId) ?? 0;
    if (!seats) continue;
    const stops = typeof stopsOf === 'function' ? stopsOf(r) : [r.origin, r.destination];
    for (const code of new Set(stops.filter(Boolean))) out[code] = (out[code] ?? 0) + freq * seats;
  }
  return out;
}

/** Weekly seats departing airports this coverage includes. */
export function coverageVolume(coverage, seatsMap = {}) {
  let n = 0;
  for (const [code, seats] of Object.entries(seatsMap ?? {})) if (coversAirport(coverage, code)) n += seats;
  return n;
}

/** Surcharge multiplier (≥ 1) for this volume against a minimum. */
export function volumeSurchargeMult(volume, minVolume) {
  if (!minVolume || minVolume <= 0) return 1;
  const short = Math.max(0, 1 - (volume ?? 0) / minVolume);
  return +(1 + CATERING_VOLUME_SURCHARGE * short).toFixed(4);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function contractEndWeek(contract) {
  return (contract?.signedWeek ?? 0) + (contract?.termWeeks ?? 0);
}

export function contractWeeksLeft(contract, absWeek) {
  return Math.max(0, contractEndWeek(contract) - (absWeek ?? 0));
}

/** Any contract at all? Cheap gate for the tick's per-route work. */
export function hasCateringContracts(contracts) {
  return !!contracts && Object.keys(contracts).length > 0;
}

/**
 * Build a contract record from this week's book. Returns null for an unknown
 * supplier or term. The rate is LOCKED here — the book moving later does not
 * reprice a signed contract (the surcharge, which depends on your own volume,
 * is the only thing that still moves).
 */
export function makeCateringContract(supplierId, years, absWeek) {
  const s = CATERING_SUPPLIER_MAP[supplierId];
  const t = CATERING_TERM_MAP[years];
  if (!s || !t) return null;
  const rate = supplierRateAt(supplierId, absWeek);
  return {
    id:           `cat-${supplierId}-${absWeek}`,
    supplierId,
    coverage:     { ...s.coverage },
    termWeeks:    t.weeks,
    signedWeek:   absWeek,
    costFactor:   +(rate * t.rateMult).toFixed(4),
    qualityCap:   s.qualityCap,
    qualityDelta: s.qualityDelta,
    minVolume:    s.minVolume,
  };
}

/**
 * Can this supplier be signed for this term now? Shared by the reducer and the
 * card. The only refusal is a coverage clash: one contract per coverage key.
 */
export function canSignCatering(supplierId, years, contracts = {}) {
  const s = CATERING_SUPPLIER_MAP[supplierId];
  const reasons = [];
  if (!s) return { ok: false, reasons: ['Unknown supplier.'] };
  if (!CATERING_TERM_MAP[years]) return { ok: false, reasons: ['Pick a 1, 3 or 5 year term.'] };
  const key = coverageKey(s.coverage);
  const clash = Object.values(contracts ?? {}).find(c => coverageKey(c.coverage) === key);
  if (clash) {
    const other = CATERING_SUPPLIER_MAP[clash.supplierId]?.name ?? 'another supplier';
    reasons.push(`You already have a ${coverageLabel(s.coverage)} contract with ${other}.`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** One-off penalty to break a contract early. */
export function cateringBreakCost(contract, absWeek, weeklySpend) {
  if (!contract) return 0;
  return Math.round(contractWeeksLeft(contract, absWeek) * Math.max(0, weeklySpend ?? 0) * CATERING_BREAK_FRACTION);
}

/**
 * Expire contracts whose term has run out as of `absWeek`, and report which
 * ones cross the warning line this week. Pure.
 */
export function tickCateringContracts(contracts = {}, absWeek = 0) {
  const out = {};
  const expired = [];
  const expiringSoon = [];
  for (const [id, c] of Object.entries(contracts ?? {})) {
    const left = contractWeeksLeft(c, absWeek);
    if (left <= 0) { expired.push(c); continue; }
    if (left === CATERING_EXPIRY_WARNING_WEEKS) expiringSoon.push(c);
    out[id] = c;
  }
  return { contracts: out, expired, expiringSoon };
}

// ─── Resolution: who cooks at an airport, and what a route gets ──────────────

/** The contract that caters this airport, or null: most specific coverage wins. */
export function contractForAirport(contracts = {}, code) {
  let best = null, bestSpec = 0;
  for (const c of Object.values(contracts ?? {})) {
    if (!coversAirport(c.coverage, code)) continue;
    const spec = SPECIFICITY[c.coverage?.kind] ?? 0;
    if (spec > bestSpec) { best = c; bestSpec = spec; }
  }
  return best;
}

function levelIndex(level) {
  return CATERING_LEVEL_ORDER.indexOf(normalizeCateringLevel(level));
}

/**
 * Resolve the catering contract effect for a route that touches `codes`.
 *
 * Per endpoint the cook is the cheaper of the hub kitchen (1 − stationDiscount
 * at a hub, 1 otherwise, quality-neutral) and the covering contract (its locked
 * rate × volume surcharge, with its cap and delta). Ties go to the hub.
 *
 * Returns null when no contract covers any endpoint, so the tick attaches
 * nothing and the route copy is byte-identical to before. Otherwise:
 *   cateringCostFactor    mean endpoint cost factor — replaces the hub stationF
 *                         on the catering line only
 *   cateringQualityDelta  mean endpoint quality delta
 *   cateringCap           lowest cap among contract-cooked endpoints (or null)
 *   cateringCooks         contract id (or null) per endpoint, for spend attribution
 */
export function resolveCateringContracts(hubTiers, hubs, contracts, codes, seatsMap) {
  if (!hasCateringContracts(contracts) || !codes?.length) return null;
  let any = false, costSum = 0, qualSum = 0, cap = null;
  const cooks = [];
  for (const code of codes) {
    const t = hubs?.[code]?.tier;
    const hubRate = 1 - (t != null ? (hubTiers?.[t]?.stationDiscount ?? 0) : 0);
    const c = contractForAirport(contracts, code);
    if (!c) { costSum += hubRate; cooks.push(null); continue; }
    any = true;
    const rate = +(c.costFactor * volumeSurchargeMult(coverageVolume(c.coverage, seatsMap), c.minVolume)).toFixed(4);
    if (t != null && hubRate <= rate) { costSum += hubRate; cooks.push(null); continue; }
    costSum += rate;
    qualSum += c.qualityDelta ?? 0;
    cooks.push(c.id);
    if (c.qualityCap && (cap == null || levelIndex(c.qualityCap) < levelIndex(cap))) cap = c.qualityCap;
  }
  if (!any) return null;
  return {
    cateringCostFactor:   +(costSum / codes.length).toFixed(4),
    cateringQualityDelta: +(qualSum / codes.length).toFixed(2),
    cateringCap:          cap,
    cateringCooks:        cooks,
  };
}

/**
 * Apply a resolved effect to a hydrated route: cap the delivered level and
 * attach the factors. The route object in STATE keeps the player's choice; only
 * the copy handed to the simulators carries the delivered level, with the
 * choice preserved as `cateringLevelChosen` so screens can say what happened.
 */
export function applyCateringContractFields(route, resolved) {
  if (!route || !resolved) return route;
  const chosen = normalizeCateringLevel(route.cateringLevel);
  const capped = resolved.cateringCap && levelIndex(chosen) > levelIndex(resolved.cateringCap);
  return {
    ...route,
    cateringCostFactor:   resolved.cateringCostFactor,
    cateringQualityDelta: resolved.cateringQualityDelta,
    cateringCooks:        resolved.cateringCooks,
    ...(capped ? { cateringLevel: resolved.cateringCap, cateringLevelChosen: chosen, cateringCapped: true } : {}),
  };
}

/**
 * Why is this route capped, and by whom? For the route screens' warning. Uses
 * the same resolution as the tick (best-of with the hub kitchen, most specific
 * contract), so the warning names exactly the caterer the tick will apply.
 * Returns null when nothing caps `chosenLevel` on this route.
 *   { cap, chosen, suppliers: [{ name, codes: [airport, ...] }] }
 */
export function cateringCapReport(hubTiers, hubs, contracts, codes, seatsMap, chosenLevel) {
  const resolved = resolveCateringContracts(hubTiers, hubs, contracts, codes, seatsMap);
  if (!resolved?.cateringCap) return null;
  const chosen = normalizeCateringLevel(chosenLevel);
  if (levelIndex(chosen) <= levelIndex(resolved.cateringCap)) return null;
  const byId = {};
  resolved.cateringCooks.forEach((id, i) => {
    if (!id) return;
    const c = contracts[id];
    if (!c || levelIndex(c.qualityCap) >= levelIndex(chosen)) return;
    (byId[id] = byId[id] ?? { name: CATERING_SUPPLIER_MAP[c.supplierId]?.name ?? 'Your caterer', codes: [] }).codes.push(codes[i]);
  });
  return { cap: resolved.cateringCap, chosen, suppliers: Object.values(byId) };
}
