// ─────────────────────────────────────────────────────────────────────────────
// MARKET DEVELOPMENT (docs/market-development-design.md)
//
// A city pair's gravity pool (utils/market.js baseCityPairDemand) is a fact of
// geography: it describes a market SERVED the way a typical real market is
// served. Real markets are not fixed. A new nonstop grows its city pair over a
// year or two, sustained low fares grow it further, and when the service
// leaves the traffic drifts away over months rather than overnight.
//
// Each served metro pair carries a development level D, a multiplier on that
// pool. Every week D moves part of the way toward a TARGET set by the service
// the pair got that week from every carrier on it (the player, AI rivals and,
// in Headwinds, the other humans):
//
//   target = clamp(FLOOR, CEIL, freqTerm × fareTerm)
//   freqTerm = (effectiveFreq / 13) ^ 0.15           0 departures → FLOOR
//   fareTerm = clamp(0.85, 1.15, (ref / avgFare) ^ 0.30)
//
// It builds with a 20-week half-life and fades with a 30-week one.
//
// NEUTRAL START. D = 1.0 is ~13 one-way departures a week (about twice daily)
// at the reference fare. That reference is chosen, not assumed: it is the
// service level at which a fresh world's served markets average D = 1.0,
// demand-weighted (1.004 across eight hub starts, range 0.98–1.04, measured on
// the v2 demand model, 2026-10-29). The gravity model is fitted to real O&D,
// which already reflects real service, so the world must START at the
// calibration and grow or fade from there. Pinned by tools/market-dev-test.mjs.
// A daily nonstop therefore builds 0.91 and twice daily 1.01.
//
// WORLD FLAG. Everything here is inert unless the state carries
// `marketDevWorld: true`, which only a new game sets. Off → marketDevFor()
// returns exactly 1 for every pair, and every caller behaves as before.
//
// MODULE STATE. Like the era fare index (utils/market.js setFareIndex) the
// pairs table is published from state on every reducer action and at the top
// of weeklyTick, so buildRouteMarket and every preview read one value. D is
// FIXED for the week: the tick reads it, and the reducer writes next week's
// value after the tick from the service that flew.
//
// HEADWINDS. D is a WORLD fact, not an airline's: one table per world, in the
// WorldMarketDev row. The server tick advances it ONCE a week from every
// active airline's routes (collectWorldService + advanceMarketDevPairs), and
// the rival overlay injects it into every airline's state on each read and
// tick (humanRivals.mjs), so the tick, the decision path and the client's
// previews all read the same table. The engine never advances it itself.
// There are no AI airlines to pre-warm from, so a new world opens with every
// pair at the floor and the players build the markets (Dave, 2026-10-30).
//
// STORAGE. Only pairs with nonstop or through-service are stored, plus pairs
// still fading after their service left. A fading pair within PRUNE_EPS of the
// floor is dropped. Connecting-only O&D (network.js) is stateless: it takes the
// target its connecting frequency implies, with no memory.
// ─────────────────────────────────────────────────────────────────────────────

import { metroPairKeyOf } from '../data/metros.js';
import { referencePrice } from '../utils/market.js';

export const MARKET_DEV_VERSION        = 1;
export const MARKET_DEV_FLOOR          = 0.70;   // no service at all (locked 2026-10-29)
export const MARKET_DEV_CEIL           = 1.30;
export const MARKET_DEV_REF_FREQ       = 13;     // weekly departures at D = 1.0 (neutral start, see header)
export const MARKET_DEV_FREQ_EXP       = 0.15;
export const MARKET_DEV_FARE_EXP       = 0.30;
export const MARKET_DEV_FARE_MIN       = 0.85;
export const MARKET_DEV_FARE_MAX       = 1.15;
export const MARKET_DEV_BUILD_HALFLIFE = 20;     // weeks
export const MARKET_DEV_FADE_HALFLIFE  = 30;     // weeks
/** Weight of a tag/multistop route's through-service (A→B→C sells A–C). */
export const MARKET_DEV_THROUGH_WEIGHT = 0.5;
/** Weight of a connecting itinerary's frequency (stateless connecting level). */
export const MARKET_DEV_CONNECT_WEIGHT = 0.5;
/** A fading, unserved pair this close to the floor is dropped from storage. */
export const MARKET_DEV_PRUNE_EPS      = 0.005;

const BUILD_RATE = 1 - Math.pow(0.5, 1 / MARKET_DEV_BUILD_HALFLIFE);
const FADE_RATE  = 1 - Math.pow(0.5, 1 / MARKET_DEV_FADE_HALFLIFE);

const r4 = (v) => Math.round(v * 10000) / 10000;
const clamp = (lo, hi, v) => (v < lo ? lo : v > hi ? hi : v);

/** Is this world a market-development world? */
export function marketDevOn(state) {
  return state?.marketDevWorld === true;
}

/** The pair key D is stored under: the two metro primaries, sorted ("JFK-LHR"). */
export function marketDevKey(a, b) {
  return metroPairKeyOf(a, b);
}

// ── Module state ─────────────────────────────────────────────────────────────
let _pairs = null;   // null = flag off; otherwise the stored pairs table

/**
 * Publish a state's market development (or clear it). Cheap and idempotent:
 * called on every reducer action and at the top of weeklyTick.
 */
export function setMarketDev(state) {
  _pairs = marketDevOn(state) ? (state.marketDev?.pairs ?? {}) : null;
}

/** True while a market-development world is published. */
export function marketDevActive() {
  return _pairs != null;
}

/**
 * D for a pair: 1 when the flag is off, the stored level when the pair is
 * served (or fading), the floor otherwise.
 */
export function marketDevFor(a, b) {
  if (_pairs == null) return 1;
  const e = _pairs[marketDevKey(a, b)];
  return e ? e.d : MARKET_DEV_FLOOR;
}

/** The stored entry for a pair ({ d, t }) or null. */
export function marketDevEntry(a, b) {
  if (_pairs == null) return null;
  return _pairs[marketDevKey(a, b)] ?? null;
}

/**
 * Level for an O&D market sold through CONNECTIONS (network.js). A pair with
 * its own stored D (a nonstop market, or one still fading) uses it; a pair
 * flown only through connections takes the target its connecting frequency
 * implies, statelessly.
 */
export function marketDevForOD(a, b, connectingFreq = 0) {
  if (_pairs == null) return 1;
  const e = _pairs[marketDevKey(a, b)];
  if (e) return e.d;
  return marketDevTarget(MARKET_DEV_CONNECT_WEIGHT * (Number(connectingFreq) || 0), 1);
}

// ── The target and the step ──────────────────────────────────────────────────

/** The frequency half of the target. 0 departures → the floor. */
export function marketDevFreqTerm(effectiveFreq) {
  const f = Number(effectiveFreq) || 0;
  if (!(f > 0)) return MARKET_DEV_FLOOR;
  return Math.pow(f / MARKET_DEV_REF_FREQ, MARKET_DEV_FREQ_EXP);
}

/**
 * The fare half: the sold economy fare as a multiple of the reference fare
 * (1 = at reference, 0.7 = an LCC-style 30% under). Unknown → 1.
 */
export function marketDevFareTerm(fareRatio = 1) {
  const r = Number(fareRatio);
  if (!(r > 0) || !Number.isFinite(r)) return 1;
  return clamp(MARKET_DEV_FARE_MIN, MARKET_DEV_FARE_MAX, Math.pow(1 / r, MARKET_DEV_FARE_EXP));
}

/** Where a pair's D is heading under this service. */
export function marketDevTarget(effectiveFreq, fareRatio = 1) {
  if (!((Number(effectiveFreq) || 0) > 0)) return MARKET_DEV_FLOOR;
  return clamp(MARKET_DEV_FLOOR, MARKET_DEV_CEIL,
    marketDevFreqTerm(effectiveFreq) * marketDevFareTerm(fareRatio));
}

/** One week's move of D toward a target: 20-week half-life up, 30 down. */
export function stepMarketDev(d, target) {
  const cur = Number.isFinite(d) ? d : MARKET_DEV_FLOOR;
  const rate = target > cur ? BUILD_RATE : FADE_RATE;
  return cur + (target - cur) * rate;
}

// ── Service collection ───────────────────────────────────────────────────────

function stopsOf(route) {
  if (Array.isArray(route?.stops) && route.stops.length >= 2) return route.stops;
  return [route?.origin, route?.destination];
}

function activeIn(route, month) {
  const m = route?.season?.months;
  if (!Array.isArray(m) || m.length === 0 || month == null) return true;
  return m.includes(month);
}

/**
 * Weekly service per pair: Map key → { freq, fareW, fareSum }. `freq` is the
 * effective one-way weekly departures (nonstop 1.0, through-service 0.5);
 * fareSum / fareW is the frequency-weighted fare ratio sold on the pair.
 *
 * @param {object} args
 * @param {Array}  args.routes       the player's routes (one per aircraft)
 * @param {object} [args.routePricing] state.routePricing (pair-level fares)
 * @param {Array}  [args.competitors]  AI carriers ({ routes: { 'A-B': { frequency, priceMultiplier } } })
 * @param {number} [args.month]        1–12, for seasonal routes (null = all active)
 */
export function collectPairService({ routes = [], routePricing = {}, competitors = [], month = null } = {}) {
  const out = new Map();
  const add = (a, b, freq, fareRatio) => {
    if (!a || !b || a === b || !(freq > 0)) return;
    const k = marketDevKey(a, b);
    let e = out.get(k);
    if (!e) { e = { freq: 0, fareW: 0, fareSum: 0 }; out.set(k, e); }
    e.freq += freq;
    if (fareRatio > 0 && Number.isFinite(fareRatio)) { e.fareW += freq; e.fareSum += freq * fareRatio; }
  };

  for (const r of routes ?? []) {
    if (!r || !activeIn(r, month)) continue;
    if (r.rangeStranded || r.outOfRange === true) continue;
    const f = Number(r.weeklyFrequency ?? r.frequency) || 0;
    if (!(f > 0)) continue;
    const pairKey = [r.origin, r.destination].sort().join('-');
    const priced = routePricing?.[pairKey]?.economy ?? r.classPrices?.economy ?? r.ticketPrice;
    const ref = referencePrice(r.origin, r.destination);
    const ratio = priced > 0 && ref > 0 ? priced / ref : null;
    const s = stopsOf(r);
    for (let i = 0; i < s.length - 1; i++) add(s[i], s[i + 1], f, ratio);
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 2; j < s.length; j++) add(s[i], s[j], f * MARKET_DEV_THROUGH_WEIGHT, ratio);
    }
  }

  for (const c of competitors ?? []) {
    for (const [key, cfg] of Object.entries(c?.routes ?? {})) {
      const f = Number(cfg?.frequency) || 0;
      if (!(f > 0)) continue;
      const [a, b] = key.split('-');
      add(a, b, f, Number(cfg?.priceMultiplier) || null);
    }
  }
  return out;
}

/** The target a collected service entry implies. */
function targetOf(svc) {
  if (!svc) return MARKET_DEV_FLOOR;
  const ratio = svc.fareW > 0 ? svc.fareSum / svc.fareW : 1;
  return marketDevTarget(svc.freq, ratio);
}

/**
 * Every carrier's service on one map: each state's own routes and fares,
 * summed per pair. The Headwinds world tick passes every active airline's
 * (pre-tick) state, so D answers to everyone who flew the pair that week.
 */
export function collectWorldService(states, { month = null } = {}) {
  const out = new Map();
  for (const s of states ?? []) {
    if (!s) continue;
    const m = collectPairService({ routes: s.routes, routePricing: s.routePricing, month });
    for (const [k, e] of m) {
      const o = out.get(k);
      if (!o) out.set(k, { ...e });
      else { o.freq += e.freq; o.fareW += e.fareW; o.fareSum += e.fareSum; }
    }
  }
  return out;
}

/**
 * One week's step for a whole pairs table: every stored or newly served pair
 * moves toward the target its service implies; a fading, unserved pair that
 * reaches the floor is dropped. Pure: (previous pairs, service) → new pairs.
 */
export function advanceMarketDevPairs(prevPairs, service) {
  const prev = prevPairs ?? {};
  const pairs = {};
  const keys = new Set([...Object.keys(prev), ...service.keys()]);
  for (const k of keys) {
    const svc = service.get(k);
    const t = targetOf(svc);
    const d = stepMarketDev(prev[k]?.d ?? MARKET_DEV_FLOOR, t);
    if (!svc && Math.abs(d - MARKET_DEV_FLOOR) < MARKET_DEV_PRUNE_EPS) continue;
    pairs[k] = { d: r4(d), t: r4(t) };
  }
  return pairs;
}

/**
 * Next week's market development, from the service that flew this week, for a
 * single state that carries its own competitors (the single-player shape).
 * Returns the previous object unchanged when the world is not a
 * market-development world. Headwinds advances D on the server instead.
 */
export function advanceMarketDev(state, { month = null } = {}) {
  if (!marketDevOn(state)) return state?.marketDev ?? null;
  const service = collectPairService({
    routes: state.routes, routePricing: state.routePricing,
    competitors: state.competitors, month,
  });
  return { v: MARKET_DEV_VERSION, pairs: advanceMarketDevPairs(state.marketDev?.pairs, service) };
}

/**
 * A new world's starting table: every pair the starting field serves begins
 * at its equilibrium (D = target), so a new game does not open in a world-wide
 * slump. Unserved pairs are not stored (the floor).
 */
export function prewarmMarketDev({ competitors = [], routes = [], routePricing = {} } = {}) {
  const service = collectPairService({ competitors, routes, routePricing });
  const pairs = {};
  for (const [k, svc] of service) {
    const t = r4(targetOf(svc));
    pairs[k] = { d: t, t };
  }
  return { v: MARKET_DEV_VERSION, pairs };
}

/** Sanitise a loaded table (bad entries dropped; missing → empty). */
export function cleanMarketDev(md) {
  const pairs = {};
  for (const [k, e] of Object.entries(md?.pairs ?? {})) {
    const d = Number(e?.d), t = Number(e?.t);
    if (!Number.isFinite(d)) continue;
    const dc = clamp(MARKET_DEV_FLOOR, MARKET_DEV_CEIL, d);
    pairs[k] = { d: dc, t: Number.isFinite(t) ? clamp(MARKET_DEV_FLOOR, MARKET_DEV_CEIL, t) : dc };
  }
  return { v: MARKET_DEV_VERSION, pairs };
}
