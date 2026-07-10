/**
 * market.js — Pure market utility functions shared by simulation.js and demand.js.
 *
 * Extracted here to break the circular dependency that would arise if both
 * simulation.js and demand.js imported from each other.
 *
 * Import chain:
 *   market.js        ← airports.js only
 *   demand.js        ← market.js
 *   simulation.js    ← market.js, demand.js
 */

import { getAirport, getAirportScores, getAirportCargoScore } from '../data/airports.js';

// ─── Distance ─────────────────────────────────────────────────────────────────

/** Haversine distance between two lat/lon points, in km */
export function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const x = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function toRad(d) { return d * Math.PI / 180; }

// ─── Gravity model ────────────────────────────────────────────────────────────

/**
 * Demand attractiveness multiplier for one airport endpoint.
 * Combines business and leisure appeal so that corporate hubs and tourist
 * destinations generate more traffic than their raw population would suggest.
 *
 * Normalised so a neutral airport (businessScore=50, leisureScore=50) → 1.0.
 * Examples:
 *   JFK (biz 72, lei 65) → 1.37   LAS Vegas (biz 15, lei 90) → 1.05
 *   LHR (biz 82, lei 55) → 1.37   CUN Cancún (biz  8, lei 92) → 1.00
 *   DXB (biz 80, lei 65) → 1.45   IAD DC govt (biz 78, lei 28) → 1.06
 *
 * @param {string} code
 * @returns {number}
 */
function demandMultiplier(code) {
  const { businessScore, leisureScore } = getAirportScores(code);
  return (businessScore + leisureScore) / 100;
}

// ─── Demand mass ───────────────────────────────────────────────────────────────
// The gravity model keys off a "demand mass" (in millions). Historically this was
// just metro population (with `effectivePop` as a manual override for big connecting
// hubs). Two kinds of airport are badly under-rated by population alone:
//
//   • Tourism magnets   – e.g. Malé/Maldives: ~0.4M residents but millions of
//                          annual visitors. Demand comes from tourism, not population.
//   • National gateways  – e.g. Ulaanbaatar: traffic is driven by being the only
//                          international gateway for a whole country, not city size.
//
// So demand mass = population + tourism term + gateway term, with two optional,
// data-driven airport fields and two tunable coefficients below.

/** Each 1M annual inbound visitors contributes this much demand mass (in millions). */
export const TOURISM_VISITOR_WEIGHT = 1.5;
/** Fraction of an airport's declared national catchment that becomes demand mass. */
export const GATEWAY_WEIGHT = 1.0;

/**
 * Effective demand mass (millions) for one airport.
 *  - `effectivePop` (if set) stays authoritative — it already bakes in connecting/
 *    gateway traffic for the calibrated mega-hubs, so we don't double-count it.
 *  - otherwise: population + visitors*TOURISM_VISITOR_WEIGHT + gateway*GATEWAY_WEIGHT
 *
 * Airport fields (all optional, in millions):
 *   visitors – annual inbound visitors/tourists per year
 *   gateway  – extra national catchment that routes through this airport
 *              (rule of thumb: national pop − metro pop, for a country's primary
 *               international gateway)
 *
 * @param {object} ap  airport record
 * @returns {number} demand mass in millions
 */
export function getDemandMass(ap) {
  if (ap == null) return 0;
  if (ap.effectivePop != null) return ap.effectivePop;
  return (ap.population ?? 0)
    + (ap.visitors ?? 0) * TOURISM_VISITOR_WEIGHT
    + (ap.gateway ?? 0) * GATEWAY_WEIGHT;
}

/**
 * Base weekly one-way demand for a city pair at the reference price.
 * Airport populations are in millions (metro area).
 */
/**
 * Same-metro airport groups whose member airports DON'T share a city label
 * (so the city-string check below misses them) — chiefly satellite fields.
 * Most multi-airport metros (London LHR/LGW/LCY/STN/LTN, Chicago ORD/MDW,
 * Tokyo HND/NRT, etc.) are already caught by the shared "city" field; this table
 * only needs the exceptions. Each inner array lists IATA codes in one metro.
 */
export const METRO_GROUPS = [
  ['JFK', 'EWR', 'LGA', 'HPN', 'SWF', 'ISP'],   // New York (incl. White Plains, Newburgh/Stewart, Islip)
  ['LHR', 'LGW', 'LCY', 'STN', 'LTN', 'SEN'],   // London (incl. Southend)
  ['MIA', 'FLL', 'PBI'],                         // South Florida (Miami / Fort Lauderdale / West Palm)
  ['EZE', 'AEP'],                                // Buenos Aires (Ezeiza / Aeroparque)
  ['SFO', 'OAK', 'SJC'],                         // San Francisco Bay Area
  ['LAX', 'BUR', 'SNA', 'ONT', 'LGB'],           // Greater Los Angeles
  ['WAS', 'IAD', 'DCA', 'BWI'],                  // Washington–Baltimore
];
const METRO_OF = {};
for (let i = 0; i < METRO_GROUPS.length; i++) {
  for (const code of METRO_GROUPS[i]) METRO_OF[code] = i;
}

/**
 * Two airports serve the same metro area when they belong to the same explicit metro
 * group, share a city (same country), or sit within a few km of each other. Same-metro
 * pairs carry no real origin–destination air demand — nobody flies across town — so
 * their demand is suppressed entirely. Examples: JFK–EWR–LGA, LHR–LGW–LCY, SYD–WSI.
 * The distance backstop is deliberately small so genuine short water/island hops
 * (which have no road alternative) keep their demand.
 */
export const SAME_METRO_MAX_KM = 35;
export function isSameMetro(o, d, dist) {
  if (!o || !d) return false;
  if (o.code && d.code && METRO_OF[o.code] != null && METRO_OF[o.code] === METRO_OF[d.code]) return true;
  if (o.country === d.country && o.city && d.city &&
      o.city.trim().toLowerCase() === d.city.trim().toLowerCase()) return true;
  const km = dist != null ? dist : distanceKm(o, d);
  return km < SAME_METRO_MAX_KM;
}

export function baseCityPairDemand(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  if (!o || !d) return 0;
  const dist = distanceKm(o, d);
  // No real O&D demand between two airports serving the same metro area.
  if (isSameMetro(o, d, dist)) return 0;

  // Demand mass generalises population: it adds tourism + national-gateway pull for
  // airports that population alone under-rates. `effectivePop` overrides stay intact,
  // and any airport without the new fields keeps mass === population (no change).
  const popO = getDemandMass(o);
  const popD = getDemandMass(d);

  // Business/leisure attractiveness multiplier — cities that are strong corporate
  // or tourism destinations generate more demand than population alone implies.
  const multO = demandMultiplier(originCode);
  const multD = demandMultiplier(destCode);

  // Gravity model with softened distance decay (exponent 1.1 vs. the classic 1.5).
  // The gentler exponent reflects that above ~5,000 km there are no alternatives to
  // flying, so demand doesn't decay as steeply as in short-haul markets where trains
  // and driving compete.
  //
  // Multiplier 1,054 calibrated so JFK-LAX stays at ~9,200 pax/week one-way.
  // Calibration reference points (all one-way, total market across all carriers):
  //   JFK-LAX  (3,975 km, pop 20.1/13.2, mult 1.37/1.34) → ~9,200 pax/wk  ✓
  //   JFK-LHR  (5,540 km, pop 20.1/22eff, mult 1.37/1.37) → ~9,600 pax/wk
  //   DXB-LHR  (5,500 km, pop 18eff/22eff, mult 1.45/1.37) → ~9,400 pax/wk
  //   SIN-LHR  (10,880 km, pop 22eff/22eff, mult 1.40/1.37) → ~6,200 pax/wk
  //   HND-SFO  (8,286 km, pop 37.4/10eff, mult 1.33/1.30) → ~6,200 pax/wk
  //   SFO-DXB  (13,400 km, pop 10eff/18eff, mult 1.30/1.45) → ~3,100 pax/wk
  //   SYD-LAX  (12,060 km, pop 5.3/13.2, mult 1.28/1.34)  → ~2,000 pax/wk
  return Math.round(
    (Math.sqrt(popO * multO * popD * multD) * 1054) / Math.pow(1 + dist / 3000, 1.1)
  );
}

/** Distance in km between two airport codes. Returns 0 if either unknown. */
export function routeDistance(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  return o && d ? Math.round(distanceKm(o, d)) : 0;
}

/**
 * Market reference price for a route ($ one-way, economy).
 * Players can price above or below this — demand adjusts via elasticity.
 */
export function referencePrice(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  if (!o || !d) return 200;
  const dist = distanceKm(o, d);
  // Reference fares trimmed 5% below baseline to tighten yields and make
  // sustained profitability harder (was boosted +10%).
  return Math.round((80 + dist * 0.09) * 0.95);
}

// ─── Market capitalisation ─────────────────────────────────────────────────────

/** Fixed share count used for all airlines (player + competitors). */
export const TOTAL_SHARES = 100_000_000;

/**
 * Compute market capitalisation and share price for an airline.
 *
 * @param {number[]} profitHistory  Weekly profit figures, most-recent last (up to last 12 used).
 * @param {number}   cash           Current cash balance.
 * @param {number}   [qualityScore] 0–100 quality/reputation score; defaults to 50.
 * @returns {{ marketCap: number, sharePrice: number, peMultiple: number|null,
 *             annualizedProfit: number|null, growthRate: number|null }}
 */
export function computeMarketCap(profitHistory, cash, qualityScore = 50) {
  const weeks = (profitHistory ?? []).slice(-12);

  // Not enough history — value purely on cash
  if (weeks.length < 2) {
    const marketCap = Math.max(cash * 1.5, 500_000);
    return { marketCap, sharePrice: marketCap / TOTAL_SHARES, peMultiple: null, annualizedProfit: null, growthRate: null };
  }

  const trailing12Profit  = weeks.reduce((s, p) => s + p, 0);
  const annualizedProfit  = Math.round(trailing12Profit * (52 / weeks.length));

  // Growth: compare avg of most-recent 6 weeks vs avg of the prior window
  const recentSlice = weeks.slice(-6);
  const priorSlice  = weeks.slice(0, Math.max(0, weeks.length - 6));
  const recentAvg   = recentSlice.reduce((s, p) => s + p, 0) / recentSlice.length;
  const priorAvg    = priorSlice.length > 0
    ? priorSlice.reduce((s, p) => s + p, 0) / priorSlice.length
    : 0;
  const growthRate  = priorAvg !== 0
    ? (recentAvg - priorAvg) / Math.abs(priorAvg)
    : (recentAvg > 0 ? 0.5 : 0);

  // P/E multiple: base 12, ±growth bonus (−5 to +15), +quality bonus (0–5)
  const growthBonus     = Math.max(-5, Math.min(15, growthRate * 20));
  const reputationBonus = (Math.max(0, Math.min(100, qualityScore)) / 100) * 5;
  const peMultiple      = 12 + growthBonus + reputationBonus;

  // Profitable companies get full P/E; loss-making ones get 5× (distressed)
  const profitComponent = annualizedProfit >= 0
    ? annualizedProfit * peMultiple
    : annualizedProfit * 5;

  const marketCap  = Math.max(profitComponent + cash * 0.8, 500_000);
  const sharePrice = marketCap / TOTAL_SHARES;

  return {
    marketCap,
    sharePrice,
    peMultiple:       Math.round(peMultiple * 10) / 10,
    annualizedProfit,
    growthRate,
  };
}

// ─── Cargo demand ───────────────────────────────────────────────────────────────
//
// A parallel gravity model for air freight, deliberately structured like the
// passenger model above but with three differences (see docs/cargo-design.md):
//
//   1. Mass driver is TRADE, not population/tourism — keyed off cargoScore.
//   2. Distance behaves differently: short-haul air freight is SUPPRESSED (trucks
//      compete under ~1,500 km), while long-haul decays only gently (a box doesn't
//      care about a 14-hour flight). So demand peaks in the medium-to-long range.
//   3. Output unit is tonnes/week, not passengers.
//
// Demand is computed symmetrically for v1 but the function is DIRECTIONAL by
// signature (o,d are not sorted) so headhaul/backhaul imbalance can be layered in
// later without changing call sites or storage.

/** Gravity constant — calibrated so HKG–LAX ≈ 1,500 tonnes/week one-way. */
export const CARGO_GRAVITY_K = 23;

/** Short-haul half-saturation (km): trucking competition halves air demand here. */
export const CARGO_TRUCK_HALF_KM = 1500;

/** Long-haul decay scale (km) and exponent — gentle, freight is time-insensitive. */
export const CARGO_DECAY_KM  = 6000;
export const CARGO_DECAY_EXP = 0.5;

/**
 * Cargo "mass" for one airport: how much air freight it generates/attracts.
 * Primarily its cargoScore (0–100), modestly scaled by the size of the surrounding
 * economy (a high-score airport in a huge metro ships more than the same score in a
 * small one). Pure-freight hubs with tiny populations (ANC, MEM) keep most of their
 * weight via the 0.5 floor.
 *
 * @param {string} code
 * @returns {number}
 */
export function getCargoMass(code) {
  const ap    = getAirport(code);
  if (!ap) return 0;
  const score = getAirportCargoScore(code);
  const econ  = Math.max(0.5, Math.min(1.8, Math.sqrt(getDemandMass(ap) / 8)));
  return score * econ;
}

/**
 * Base weekly one-way cargo demand for a city pair, in tonnes, at reference yield.
 * Symmetric in v1 (o,d order does not change the result).
 *
 * @param {string} originCode
 * @param {string} destCode
 * @returns {number} tonnes/week (one-way)
 */
export function cargoCityPairDemand(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  if (!o || !d) return 0;

  const dist = distanceKm(o, d);
  // No air-cargo demand within a single metro area (trucked, not flown).
  if (isSameMetro(o, d, dist)) return 0;
  const massO = getCargoMass(originCode);
  const massD = getCargoMass(destCode);

  // Short-haul suppression (trucks compete) × gentle long-haul gravity decay.
  const truckFactor = dist / (dist + CARGO_TRUCK_HALF_KM);
  const decay       = Math.pow(1 + dist / CARGO_DECAY_KM, CARGO_DECAY_EXP);
  const distFactor  = truckFactor / decay;

  return Math.round(Math.sqrt(massO * massD) * CARGO_GRAVITY_K * distFactor);
}

// ─── Cargo pricing ──────────────────────────────────────────────────────────────

/** Reference yield bounds and curve ($ per tonne-km). */
export const CARGO_YIELD_BASE  = 1.19;     // intercept of the linear curve
export const CARGO_YIELD_SLOPE = 6.8e-5;   // $/tonne-km lost per km of stage length
export const CARGO_YIELD_CAP   = 1.10;     // short-haul ceiling
export const CARGO_YIELD_FLOOR = 0.40;     // long-haul floor

/**
 * Market reference yield for a route, in $ per tonne-km (one-way).
 * Yield is HIGHER on short routes (fixed handling cost amortised over fewer km) and
 * lower on long-haul — the inverse of the passenger fare curve. Total reference
 * revenue per tonne = cargoReferenceYield(o,d) × distanceKm.
 *
 *   e.g.  ~1,300 km → ~$1.10/tonne-km → ~$1,430/tonne (~$1.43/kg)
 *        ~11,640 km → ~$0.40/tonne-km → ~$4,656/tonne (~$4.66/kg)
 *
 * @param {string} originCode
 * @param {string} destCode
 * @returns {number} $/tonne-km
 */
export function cargoReferenceYield(originCode, destCode) {
  const dist = routeDistance(originCode, destCode);
  const raw  = CARGO_YIELD_BASE - CARGO_YIELD_SLOPE * dist;
  return Math.round(Math.max(CARGO_YIELD_FLOOR, Math.min(CARGO_YIELD_CAP, raw)) * 1000) / 1000;
}

/** Convenience: reference revenue per tonne ($, one-way) on a route. */
export function cargoReferenceRevenuePerTonne(originCode, destCode) {
  return Math.round(cargoReferenceYield(originCode, destCode) * routeDistance(originCode, destCode));
}
