/**
 * fuelStations.js — where you buy the fuel matters (FUEL_OPERATIONS_PLAN.md §7).
 *
 * Real into-plane prices vary ±15–30% by airport: taxes, remoteness, local
 * refining and how many trucks compete on the ramp. Until now the world had
 * one price. This module gives every airport a BASIS — a fixed multiple of
 * the world index — and every route the station factor that follows from it,
 * so hub choice matters for fuel and a network that lives at dear stations
 * pays for it.
 *
 *   price paid per litre at station S = FUEL_PRICE_PER_LITRE × worldIndex × basis(S)
 *
 * The basis is DERIVED, never hand-curated per airport: region × country ×
 * tier × island, with a short override list for the famous outliers. It is
 * then normalised so the population-weighted mean across the whole catalogue
 * is exactly 1.000 — the world's total fuel bill does not move, only its
 * distribution across airlines. Static in v1: when the index goes 1.0 → 1.38
 * every station rises 38% together (regional drift is §7.6, later).
 *
 * ── Round trips and tankering ──────────────────────────────────────────────
 * A round trip uplifts half its fuel at each end, so a route's basis is the
 * average of its two stations. When the two differ, a dispatcher can TANKER:
 * carry the return fuel out of the cheap end. That costs burn (carrying
 * weight) at TANKER_PENALTY_PER_HOUR per block hour, and the tanks must hold
 * outbound + return + reserves, so the share of return fuel that can be
 * carried is
 *
 *   tankerFrac = clamp((0.9 × range − sector) / sector, 0, 1)
 *
 * full at 45% of range, half at 60%, none at 90%. The engine decides per
 * route per week (`route.tankering === 'auto'`), and only when it saves money;
 * the Stations table shows the verdict. Multi-stop routes average over their
 * legs and do not tanker in v1.
 *
 * ── Versioning ─────────────────────────────────────────────────────────────
 * This changes the cost of routes people already fly, so it is gated:
 * `state.fuelOpsV >= 2` (new games and new worlds; live worlds by an admin
 * flip of tickConfig.fuelOpsV). The gate is a module-level knob set from
 * state the way setNwrYieldChoke is, so the sims — which see a route and an
 * aircraft, not the state — apply the same factor in the tick and in every
 * preview. With the knob off every function here returns 1.
 */

import { AIRPORTS, getAirport, getRegion } from './airports.js';

// ── The table ─────────────────────────────────────────────────────────────────

export const FUEL_STATION_REGION_BASIS = {
  'North America': 1.00,
  'South America': 1.05,
  'Europe':        1.06,
  'Middle East':   0.92,
  'Africa':        1.15,
  'Asia':          1.03,
  'Oceania':       1.06,
  'Other':         1.05,
};

// Country nudges on top of the region: producers and refining hubs cheaper,
// tax-heavy and import-dependent markets dearer.
export const FUEL_STATION_COUNTRY_ADJ = {
  US: 1.00, CA: 1.02, MX: 1.03,
  JP: 1.06, KR: 1.05, SG: 0.97, HK: 1.02, IN: 1.02, CN: 1.00, TH: 1.01, ID: 1.03, PH: 1.04,
  AU: 1.00, NZ: 1.04,
  BR: 1.02, AR: 1.03, CL: 1.02, CO: 1.03, PE: 1.03,
  GB: 1.01, DE: 1.00, FR: 1.01, NL: 0.98, NO: 0.98, IT: 1.03, ES: 1.01, GR: 1.03, CH: 1.03, IE: 1.01,
  AE: 0.96, QA: 0.95, SA: 0.95, KW: 0.95, BH: 0.96, OM: 0.97, TR: 1.02,
  ZA: 1.00, EG: 1.01, NG: 1.04, KE: 1.02, ET: 1.02, MA: 1.00,
};

export const FUEL_STATION_TIER_ADJ = { mega: 0.98, major: 1.00, regional: 1.04 };

// Island and remote stations: everything arrives by ship.
export const FUEL_STATION_ISLAND_ADJ = 1.15;
export const FUEL_STATION_ISLAND_COUNTRIES = new Set([
  'FJ', 'PF', 'NC', 'PG', 'SB', 'VU', 'GU', 'CK', 'WS', 'TO', 'KI', 'MP',
  'MV', 'SC', 'MU', 'RE', 'CV', 'ST',
  'BB', 'BS', 'AG', 'GD', 'KN', 'TC', 'VG', 'GP', 'MQ', 'LC', 'VC', 'DM', 'AW', 'CW', 'KY', 'BM', 'JM',
  'JE', 'IM', 'MT', 'CY', 'IS', 'FO', 'GL',
]);

// The famous outliers, stated (applied last, before normalisation).
export const FUEL_STATION_OVERRIDES = {
  ANC: 0.90,   // Alaska: refinery on the doorstep, a tankering hub for the Pacific
  HNL: 1.10, OGG: 1.14, KOA: 1.14, LIH: 1.16,   // Hawaii: shipped in
  NAN: 1.20, PPT: 1.25, GUM: 1.12, RAR: 1.28,   // Pacific islands
  KEF: 1.10, FNC: 1.10, LPA: 1.06, TFS: 1.06,   // Atlantic islands
  DXB: 0.86, DOH: 0.86, AUH: 0.87, RUH: 0.87,   // Gulf: cheapest jet fuel on earth
  IAH: 0.88, DFW: 0.89, HOU: 0.89,              // US Gulf Coast refining
  LOS: 1.18, ADD: 1.12, NBO: 1.12, JNB: 1.06,   // African stations
  EZE: 1.06, GIG: 1.05, LIM: 1.04,              // South American imports
};

export const FUEL_STATION_MIN = 0.85;
export const FUEL_STATION_MAX = 1.35;

// ── Derivation ────────────────────────────────────────────────────────────────

function isIslandStation(airport) {
  return FUEL_STATION_ISLAND_COUNTRIES.has(airport?.country);
}

/** The un-normalised basis and the factors that built it. */
function rawBasis(airport) {
  if (!airport) return { raw: 1, parts: [] };
  const parts = [];
  const region = getRegion(airport.country);
  let raw = FUEL_STATION_REGION_BASIS[region] ?? FUEL_STATION_REGION_BASIS.Other;
  parts.push({ what: region, mult: raw });
  const country = FUEL_STATION_COUNTRY_ADJ[airport.country];
  if (country != null && country !== 1) { raw *= country; parts.push({ what: `${airport.country} market`, mult: country }); }
  const tier = FUEL_STATION_TIER_ADJ[airport.tier] ?? 1;
  if (tier !== 1) { raw *= tier; parts.push({ what: `${airport.tier} airport`, mult: tier }); }
  if (isIslandStation(airport)) { raw *= FUEL_STATION_ISLAND_ADJ; parts.push({ what: 'island station', mult: FUEL_STATION_ISLAND_ADJ }); }
  return { raw, parts };
}

// Normalise the DERIVED table so its population-weighted mean over the
// catalogue is 1.000: the world's fuel bill is unchanged in aggregate, only
// redistributed. Population (metro millions) stands in for departures. The
// stated overrides are applied after normalisation, so a stated 1.10 IS
// 1.10; they are few and roughly balanced, and the test holds the weighted
// mean of the final table within ±1%.
export const FUEL_STATION_NORMALISER = (() => {
  let num = 0, den = 0;
  for (const a of AIRPORTS) {
    const w = Math.max(0.01, Number(a.population) || 0.01);
    num += rawBasis(a).raw * w;
    den += w;
  }
  return den > 0 ? num / den : 1;
})();

const _cache = new Map();

/**
 * The station's basis: a fixed multiple of the world fuel index, 3 decimals,
 * clamped to [FUEL_STATION_MIN, FUEL_STATION_MAX]. Independent of the
 * enable knob — this is the table; whether it is CHARGED is
 * getFuelStationsEnabled().
 */
export function stationFuelBasis(codeOrAirport) {
  const airport = typeof codeOrAirport === 'string' ? getAirport(codeOrAirport) : codeOrAirport;
  if (!airport) return 1;
  const hit = _cache.get(airport.code);
  if (hit != null) return hit;
  const derived = rawBasis(airport).raw / FUEL_STATION_NORMALISER;
  const stated  = FUEL_STATION_OVERRIDES[airport.code];
  const v = parseFloat(Math.max(FUEL_STATION_MIN, Math.min(FUEL_STATION_MAX, stated ?? derived)).toFixed(3));
  _cache.set(airport.code, v);
  return v;
}

/**
 * Why the station prices as it does, for a tooltip: the dominant factor and
 * the signed percentage. "island station, +22%" / "Gulf supply, −9%".
 */
export function stationFuelDriver(codeOrAirport) {
  const airport = typeof codeOrAirport === 'string' ? getAirport(codeOrAirport) : codeOrAirport;
  if (!airport) return null;
  const basis = stationFuelBasis(airport);
  const pct = Math.round((basis - 1) * 100);
  const sign = pct > 0 ? '+' : '';
  const { parts } = rawBasis(airport);
  if (FUEL_STATION_OVERRIDES[airport.code] != null) return { text: `${sign}${pct}% (stated for ${airport.code})`, pct, basis };
  // The part furthest from 1 is the story.
  const lead = parts.reduce((b, p) => (b == null || Math.abs(Math.log(p.mult)) > Math.abs(Math.log(b.mult)) ? p : b), null);
  const what = lead ? lead.what : 'typical station';
  return { text: `${what}, ${sign}${pct}%`, pct, basis };
}

export function stationFuelBand(basis) {
  if (basis <= 0.95) return 'cheap';
  if (basis <= 1.05) return 'normal';
  if (basis <= 1.15) return 'dear';
  return 'very dear';
}

// ── The enable knob ───────────────────────────────────────────────────────────

/** The fuel-ops rule version new games and worlds get. 1 (absent) = world-flat fuel. */
export const FUEL_OPS_VERSION = 2;

let _enabled = false;
let _discounts = null;   // { [code]: fraction } — the airline's fuel-farm discounts (data/fuelFarm.js)
/** Set from state (`state.fuelOpsV >= 2`) by the reducer, the tick, the client provider and the server. */
export function setFuelStationsEnabled(on) { _enabled = on === true; }
export function getFuelStationsEnabled() { return _enabled; }
export function fuelStationsOn(state) { return (Number(state?.fuelOpsV) || 0) >= 2; }
/**
 * The airline's per-station discounts (its fuel farms and stakes), set from
 * state alongside the knob. Null / empty means none. Like the knob it is
 * per-airline state living at module level, so every site that sets the
 * knob sets this too and a preview built on a foreign state cannot inherit
 * another airline's farms.
 */
export function setFuelStationDiscounts(map) {
  _discounts = map && Object.keys(map).length ? map : null;
}
export function getFuelStationDiscounts() { return _discounts; }
/** The basis THIS airline pays at the station: the table's basis less its farm discount there. */
export function effectiveStationBasis(code) {
  const b = stationFuelBasis(code);
  const d = _discounts?.[code];
  return d > 0 ? parseFloat((b * (1 - d)).toFixed(4)) : b;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const TANKER_PENALTY_PER_HOUR = 0.035;   // burn cost of carrying the extra fuel, per block hour
export const TANKER_RESERVE_FRACTION = 0.10;    // 10% of range kept as reserves

/** Share of the return fuel the tanks can carry on top of the outbound load. */
export function tankerFraction(sectorKm, rangeKm) {
  if (!(sectorKm > 0) || !(rangeKm > 0)) return 0;
  return Math.max(0, Math.min(1, ((1 - TANKER_RESERVE_FRACTION) * rangeKm - sectorKm) / sectorKm));
}

const NEUTRAL = Object.freeze({ enabled: false, factor: 1, basis: 1, stations: null, tankering: null });

/**
 * The station factor for a route this week, and where its fuel is bought.
 *
 * @param {object} route            { origin, destination, stops?, tankering? }
 * @param {object} [opts]
 * @param {number} [opts.sectorKm]   one-way distance (simple routes; for tankering)
 * @param {number} [opts.rangeKm]    the aircraft's effective range (for tankering)
 * @param {number} [opts.blockHours] one sector's block time (for the penalty)
 * @param {number[]} [opts.legKm]    per-leg distances for multi-stop routes
 * @returns {{ enabled, factor, basis, stations: Object<string, number>|null, tankering: object|null }}
 *   `factor` multiplies the route's fuel cost; `stations` gives each station's
 *   share of that factor (they sum to `factor`), so fuel $ by station is
 *   fuelCost × share / factor.
 */
export function routeFuelStations(route, { sectorKm = 0, rangeKm = 0, blockHours = 0, legKm = null } = {}) {
  if (!_enabled || !route) return NEUTRAL;
  const stops = Array.isArray(route.stops) && route.stops.length >= 2
    ? route.stops : [route.origin, route.destination];
  if (stops.length > 2) {
    // Multi-stop: each leg buys half at each end, weighted by leg length.
    const kms = Array.isArray(legKm) && legKm.length === stops.length - 1 ? legKm : stops.slice(1).map(() => 1);
    const total = kms.reduce((s, k) => s + k, 0) || 1;
    const stations = {};
    let factor = 0;
    stops.slice(0, -1).forEach((from, i) => {
      const to = stops[i + 1];
      const w = kms[i] / total;
      const bf = effectiveStationBasis(from), bt = effectiveStationBasis(to);
      stations[from] = (stations[from] ?? 0) + (bf / 2) * w;
      stations[to]   = (stations[to]   ?? 0) + (bt / 2) * w;
      factor += ((bf + bt) / 2) * w;
    });
    const f = parseFloat(factor.toFixed(4));
    return { enabled: true, factor: f, basis: f, stations, tankering: null };
  }

  const [o, d] = stops;
  const bO = effectiveStationBasis(o), bD = effectiveStationBasis(d);
  const basis = parseFloat(((bO + bD) / 2).toFixed(4));
  let stations = { [o]: bO / 2, [d]: bD / 2 };
  let factor = basis;
  let tankering = null;

  if (route.tankering === 'auto' && bO !== bD) {
    const cheap = bO < bD ? o : d, dear = cheap === o ? d : o;
    const bC = Math.min(bO, bD), bE = Math.max(bO, bD);
    const penalty = TANKER_PENALTY_PER_HOUR * Math.max(0, blockHours);
    const frac = tankerFraction(sectorKm, rangeKm);
    const carriedPrice = bC * (1 + penalty);
    if (frac > 0 && carriedPrice < bE) {
      // The dear end's half: `frac` of it now bought cheap and carried.
      const dearHalfBefore = bE / 2;
      const dearHalfAfter  = (frac * carriedPrice + (1 - frac) * bE) / 2;
      stations = {
        [cheap]: bC / 2 + (frac * carriedPrice) / 2,
        [dear]:  ((1 - frac) * bE) / 2,
      };
      factor = parseFloat((bC / 2 + dearHalfAfter).toFixed(4));
      tankering = {
        from: cheap, to: dear, frac: parseFloat(frac.toFixed(3)),
        penalty: parseFloat(penalty.toFixed(4)),
        spread: parseFloat(((bE - bC) / bC).toFixed(4)),
        // Fraction of the factor-1 fuel saved by tankering this week.
        saved: parseFloat((dearHalfBefore - dearHalfAfter).toFixed(4)),
      };
    } else {
      tankering = {
        from: cheap, to: dear, frac: parseFloat(frac.toFixed(3)),
        penalty: parseFloat(penalty.toFixed(4)),
        spread: parseFloat(((bE - bC) / bC).toFixed(4)),
        saved: 0,
        reason: frac <= 0 ? 'sector too long for the tanks' : 'spread smaller than the carrying penalty',
      };
    }
  }
  return { enabled: true, factor, basis, stations, tankering };
}

/** Dollars by station for a route result: fuelCost split by the plan's shares. */
export function fuelByStationOf(plan, fuelCost) {
  if (!plan?.enabled || !plan.stations || !(plan.factor > 0)) return null;
  const out = {};
  for (const [code, share] of Object.entries(plan.stations)) {
    out[code] = Math.round((fuelCost * share) / plan.factor);
  }
  return out;
}

/** Sum per-route fuelByStation maps into one. */
export function sumFuelByStation(results = []) {
  const out = {};
  let any = false;
  for (const r of results) {
    const m = r?.fuelByStation;
    if (!m) continue;
    any = true;
    for (const [code, v] of Object.entries(m)) out[code] = (out[code] ?? 0) + v;
  }
  return any ? out : null;
}
