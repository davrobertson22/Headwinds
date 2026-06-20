import { getAirport, gateMonthlyFee, totalGateMonthlyFee } from '../data/airports.js';
import { getAircraftType, fuelCostPerKm } from '../data/aircraft.js';
export { baseCityPairDemand } from './market.js';
import { cargoCityPairDemand, cargoReferenceYield } from './market.js';
import { LABOR_GROUPS, laborEffects } from '../data/labor.js';
import { weeklyFamilyBaseCost, activeFamilies, FAMILY_INFO } from '../data/families.js';
import {
  calcHQCost,
  weeklyInsuranceCost,
  weeklyLandingFee,
  marketingDemandMultiplier,
  weeklyLayoverCost,
  weeklyPassengerCompensation,
  weeklyGroundHandlingCost,
  weeklyLoungeCost,
  DISTRIBUTION_COST_PCT,
} from '../data/overhead.js';
import { routeCatering, cateringQualityBonus, normalizeCateringLevel } from '../data/catering.js';
import {
  buildRouteMarket,
  computeMarketShare,
  computeQualityScore,
  buildCompetitorOffer,
  routeMaturityFactor,
  COMPETITOR_AIRLINES,
  computeConnectingDemand,
  HUB_TIERS,
  PRICE_CAP_MULTIPLE,
} from '../models/demand.js';
import {
  ALLIANCES,
  getAlliance,
  partnerInterlineRevenue,
} from '../data/alliances.js';
import { runNetworkTick } from '../models/network.js';
import { buildEncroachmentOffer } from '../models/encroachment.js';

// ─────────────────────────────────────────────
// DISTANCE
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// DEMAND MODEL
// ─────────────────────────────────────────────

/**
 * Market reference price for a route ($ one-way, economy).
 * Players can price above or below this — demand adjusts via elasticity.
 */
export function referencePrice(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  if (!o || !d) return 200;
  const dist = distanceKm(o, d);
  // Reference fares boosted 10% across the board to lift baseline yields.
  return Math.round((80 + dist * 0.09) * 1.1);
}

// ─────────────────────────────────────────────
// CABIN CLASS CONSTANTS
// ─────────────────────────────────────────────

/**
 * How each passenger segment distributes across cabin classes, varying by route distance.
 *
 * Short-haul  (<1,500 km): first class barely exists; economy dominates even for business.
 * Medium-haul (1,500–5,000 km): moderate premium mix; some first class for business.
 * Long-haul   (>5,000 km): full premium mix; first class meaningful for business travelers.
 *
 * Each row sums to 1.0.
 */
export const SEGMENT_CABIN_PREFS = {
  short: {
    business: { firstClass: 0.02, businessClass: 0.40, premiumEconomy: 0.30, economy: 0.28 },
    leisure:  { firstClass: 0.00, businessClass: 0.03, premiumEconomy: 0.15, economy: 0.82 },
  },
  medium: {
    business: { firstClass: 0.08, businessClass: 0.50, premiumEconomy: 0.25, economy: 0.17 },
    leisure:  { firstClass: 0.01, businessClass: 0.05, premiumEconomy: 0.20, economy: 0.74 },
  },
  long: {
    business: { firstClass: 0.20, businessClass: 0.50, premiumEconomy: 0.20, economy: 0.10 },
    leisure:  { firstClass: 0.02, businessClass: 0.10, premiumEconomy: 0.28, economy: 0.60 },
  },
};

/**
 * Return the correct SEGMENT_CABIN_PREFS tier for a given route distance.
 * @param {number} distKm
 * @returns {{ business: object, leisure: object }}
 */
export function getSegmentCabinPrefs(distKm) {
  if (distKm < 1500) return SEGMENT_CABIN_PREFS.short;
  if (distKm < 5000) return SEGMENT_CABIN_PREFS.medium;
  return SEGMENT_CABIN_PREFS.long;
}

// Fare multiplier relative to the economy (base) ticket price.
// These represent the DEFAULT prices set when a route is created and the
// market equilibrium the demand model uses as a reference.
// Real-world benchmarks (short/medium haul):
//   First:    ~5× (lie-flat suite — long-haul only, modest yield on short routes)
//   Business: ~2.5× (lie-flat or angled flat — realistic for short/medium haul)
//   Prem Eco: ~1.4× (extra legroom, separate cabin)
export const CLASS_FARE_MULTIPLIERS = {
  firstClass:     5.0,
  businessClass:  2.5,
  premiumEconomy: 1.4,
  economy:        1.0,
};

// ─────────────────────────────────────────────
// ROUTE PRICING (single source of truth: state.routePricing, keyed by O&D pair)
// ─────────────────────────────────────────────
// Price belongs to the ROUTE (an origin–destination pair), not to an individual
// aircraft. The store keeps one price set per pair in state.routePricing; route
// objects carry only aircraft + frequency. hydrateRoute() projects the pair's
// price onto a route object for the engine and UI to read.

/** Canonical, direction-agnostic key for an O&D pair. */
export function routePairKey(origin, destination) {
  return [origin, destination].sort().join('-');
}

// ─────────────────────────────────────────────
// ROUTE GEOMETRY (multi-stop / "tag" flights)
// ─────────────────────────────────────────────
// A route is normally a single leg, origin → destination. A *tag* flight is one
// aircraft flying through one or more intermediate stops (e.g. A → B → C). Such a
// route carries an explicit ordered `stops` array; single-leg routes derive their
// stops from origin/destination. These helpers are the single source of truth for
// "what airports does this route touch, in what order" so the reducer, the
// simulation, and the UI never re-derive it inconsistently.
//
// INVARIANTS
//   - stops[0]              === origin
//   - stops[stops.length-1] === destination
//   - stops.length          >= 2  (a leg needs two ends)
//   - every consecutive pair (stops[i], stops[i+1]) is one flown LEG
//   - every ordered pair  (stops[i], stops[j]) with i<j is a sellable O&D SEGMENT
//     → for A→B→C: legs are A-B, B-C; segments are A-B, B-C, AND through A-C.

/**
 * Maximum airports on one tag flight = 2 intermediate stops (3 legs). The sim,
 * fees, and network model are all N-stop-capable; this is the *gameplay* cap, set
 * here so the reducer and UI agree. Raise it in one place to allow longer chains.
 */
export const MAX_ROUTE_STOPS = 4;

/** Ordered airport codes a route visits. Falls back to [origin, destination]. */
export function routeStops(route) {
  if (route && Array.isArray(route.stops) && route.stops.length >= 2) return route.stops;
  return [route?.origin, route?.destination];
}

/** Flown legs as {from, to} pairs. Length = stops.length - 1. */
export function routeLegs(route) {
  const s = routeStops(route);
  const legs = [];
  for (let i = 0; i < s.length - 1; i++) legs.push({ from: s[i], to: s[i + 1] });
  return legs;
}

/** True when the route has at least one intermediate stop (i.e. is a tag flight). */
export function isMultiStop(route) {
  return routeStops(route).length > 2;
}

// ── Seasonal flights ─────────────────────────────────────────────────────────
// A route may carry a `season: { months: [1..12] }` window. When set, the route
// only operates in those (1-indexed) months — it is "dormant" the rest of the
// year, earning nothing and freeing its aircraft/slots for a counter-seasonal
// route. Absent/null season = operates year-round (default, backward-compatible).
export const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Active months for a route (1-indexed). Year-round routes return all 12. */
export function routeActiveMonths(route) {
  const m = route?.season?.months;
  return Array.isArray(m) && m.length > 0 ? m : ALL_MONTHS;
}

/** Is the route operating in the given 1-indexed month? */
export function isRouteActive(route, month) {
  const m = route?.season?.months;
  if (!Array.isArray(m) || m.length === 0) return true;   // year-round
  return m.includes(month);
}

/** Do two routes' active windows share at least one month? Year-round overlaps all. */
export function seasonsOverlap(a, b) {
  const mb = new Set(routeActiveMonths(b));
  return routeActiveMonths(a).some(m => mb.has(m));
}

/** Sum of leg distances (km) — total ground covered; drives fuel & crew cost. */
export function routeTotalDistanceKm(route) {
  return routeLegs(route).reduce((s, l) => s + routeDistanceKm(l.from, l.to), 0);
}

/** Longest single leg (km) — the binding constraint for aircraft range. */
export function routeMaxLegKm(route) {
  return routeLegs(route).reduce((m, l) => Math.max(m, routeDistanceKm(l.from, l.to)), 0);
}

/**
 * Every sellable O&D market the route serves: all ordered (from, to) pairs.
 * `legSpan` = how many legs the segment spans (1 = a local leg, >1 = through).
 * For A→B→C: [{A,B,1}, {A,C,2}, {B,C,1}].
 */
export function routeSegments(route) {
  const s = routeStops(route);
  const segs = [];
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      segs.push({ from: s[i], to: s[j], legSpan: j - i, fromIdx: i, toIdx: j });
    }
  }
  return segs;
}

/**
 * Directional fare key for a tag-route segment (A→C is priced separately from
 * C→A). Single-leg routes keep using routePairKey (sorted, direction-agnostic)
 * so all existing pricing is untouched; only tag segments use this.
 */
export function routeSegmentKey(from, to) {
  return `${from}>${to}`;
}

/**
 * Ensure a route object carries an explicit, well-formed `stops` array and that
 * origin/destination agree with its ends. Idempotent — safe to call on already
 * normalized routes and on legacy single-leg routes. Used by save migration and
 * when constructing new routes so downstream code can rely on `route.stops`.
 */
export function normalizeRouteStops(route) {
  if (!route) return route;
  const clean = routeStops(route).filter(Boolean);
  if (clean.length < 2) return route;
  return {
    ...route,
    stops:       clean,
    origin:      clean[0],
    destination: clean[clean.length - 1],
  };
}

/** Build a full class-price set from an economy fare using the standard multipliers. */
export function defaultClassPrices(economyFare) {
  const eco = Math.max(1, Math.round(Number(economyFare) || 1));
  return {
    economy:        eco,
    premiumEconomy: Math.round(eco * CLASS_FARE_MULTIPLIERS.premiumEconomy),
    businessClass:  Math.round(eco * CLASS_FARE_MULTIPLIERS.businessClass),
    firstClass:     Math.round(eco * CLASS_FARE_MULTIPLIERS.firstClass),
  };
}

/**
 * Highest fare allowed for a class on a route, in dollars.
 * Each class's ceiling is PRICE_CAP_MULTIPLE × its own reference fare
 * (reference = economy reference price × that class's fare multiplier).
 * Beyond this, demand is choked to zero anyway, so we forbid the input.
 *
 * @param {number} economyRefPrice  the route's economy reference price ($)
 * @param {keyof typeof CLASS_FARE_MULTIPLIERS} className
 * @returns {number} max fare ($)
 */
export function maxClassPrice(economyRefPrice, className) {
  const ref  = Math.max(1, Number(economyRefPrice) || 1);
  const mult = CLASS_FARE_MULTIPLIERS[className] ?? 1;
  return Math.round(ref * mult * PRICE_CAP_MULTIPLE);
}

/**
 * Clamp a class fare to the route's [1, maxClassPrice] range.
 *
 * @param {number} value            requested fare ($)
 * @param {number} economyRefPrice  the route's economy reference price ($)
 * @param {keyof typeof CLASS_FARE_MULTIPLIERS} className
 * @returns {number} clamped fare ($)
 */
export function clampClassPrice(value, economyRefPrice, className) {
  const v = Math.max(1, Math.round(Number(value) || 0));
  return Math.min(v, maxClassPrice(economyRefPrice, className));
}

/**
 * Project a route's pair-level settings (price + catering) onto the route object so
 * existing readers can keep using route.classPrices / route.ticketPrice /
 * route.cateringLevel unchanged. Both price and catering belong to the O&D pair, not
 * the aircraft. Prospective/preview routes that already carry their own settings (and
 * aren't in the maps) pass through untouched.
 */
export function hydrateRoute(route, routePricing, routeCatering) {
  if (!route) return route;
  const key      = routePairKey(route.origin, route.destination);
  const pricing  = (routePricing  ?? {})[key];
  const catering = (routeCatering ?? {})[key];
  if (!pricing && !catering) return route;
  const out = { ...route };
  if (pricing)  { out.classPrices = pricing; out.ticketPrice = pricing.economy; }
  if (catering) { out.cateringLevel = catering; }
  return out;
}

// How many economy-equivalent seat units each class occupies.
// A 737 has 162 "seat units" — premium classes take more floor space.
//   First class (lie-flat + suite) = 2.0 units
//   Business class (angled/full-flat) = 1.5 units
//   Premium economy (extra pitch/width) = 1.25 units
//   Economy = 1.0 units (baseline)
export const CLASS_SPACE_MULTIPLIERS = {
  firstClass:     2.00,
  businessClass:  1.50,
  premiumEconomy: 1.25,
  economy:        1.00,
};

// ─── Cabin density dynamics ───────────────────────────────────────────────────
//
// Two real effects flow from how densely a cabin is configured:
//   1. PAYLOAD → RANGE. Fewer/heavier-spaced passengers mean less payload weight,
//      so the aircraft can trade that weight for fuel and fly further. A densest
//      all-economy cabin is the baseline (no bonus); a light cabin gains range.
//   2. EMPTY FLOOR → COMFORT. Floor space you deliberately leave unfilled becomes
//      extra room per passenger, raising perceived quality (but you sell fewer seats).

/** Max range bonus when the cabin carries (almost) no payload.
 *  Passengers are only ~12–15% of a jet's max takeoff weight, so trading payload
 *  for fuel on a fixed airframe realistically buys ~10–15% range — not more. (The
 *  real A350 ULR's bigger gain comes from added fuel tankage, which we don't model.) */
export const CONFIG_RANGE_GAIN_MAX = 0.15;     // up to +15% range
/** Max quality points awarded for an entirely empty (impossibly spacious) floor. */
export const CONFIG_SPACE_QUALITY_MAX = 14;

/** Economy-equivalent seat units consumed by a cabin config. */
export function configSeatUnits(config) {
  return (config.firstClass     ?? 0) * CLASS_SPACE_MULTIPLIERS.firstClass
       + (config.businessClass  ?? 0) * CLASS_SPACE_MULTIPLIERS.businessClass
       + (config.premiumEconomy ?? 0) * CLASS_SPACE_MULTIPLIERS.premiumEconomy
       + (config.economy        ?? 0) * CLASS_SPACE_MULTIPLIERS.economy;
}

/** Total physical passengers (bodies) a cabin config seats. */
export function configBodies(config) {
  return (config.firstClass ?? 0) + (config.businessClass ?? 0)
       + (config.premiumEconomy ?? 0) + (config.economy ?? 0);
}

/**
 * Range multiplier from cabin payload. Densest all-economy = 1.0 (baseline);
 * lighter cabins (premium-heavy or partly empty) extend range up to +CONFIG_RANGE_GAIN_MAX.
 */
export function configRangeMod(config, type) {
  const maxBodies = type?.seats ?? 0;
  if (!maxBodies) return 1;
  const frac = Math.max(0, Math.min(1, configBodies(config) / maxBodies));
  return 1 + CONFIG_RANGE_GAIN_MAX * (1 - frac);
}

/** Quality points from floor space left deliberately empty (extra room per pax). */
export function configSpaceQualityBonus(config, type) {
  const maxUnits = type?.seats ?? 0;
  if (!maxUnits) return 0;
  const emptyFrac = Math.max(0, 1 - configSeatUnits(config) / maxUnits);
  return Math.round(emptyFrac * CONFIG_SPACE_QUALITY_MAX);
}

/** Full effective range (km): manufacturer range × engine/wingtip mod × cabin-payload mod. */
export function effectiveRangeKm(aircraft, type) {
  const config = aircraft.config ?? defaultConfig(type.seats);
  return Math.round(type.range * (aircraft.rangeMod ?? 1.0) * configRangeMod(config, type));
}

// ─────────────────────────────────────────────
// QUALITY CONSTANTS
// ─────────────────────────────────────────────

// Demand boost from seat quality
export const SEAT_QUALITY_DEMAND = {
  basic:    0.85,
  standard: 1.00,
  premium:  1.20,
  luxury:   1.40,
};

// Demand boost from service quality
export const SERVICE_QUALITY_DEMAND = {
  basic:    0.90,
  standard: 1.00,
  premium:  1.15,
  luxury:   1.30,
};

// Extra weekly operating cost per route from quality settings
export const SEAT_QUALITY_COST_PER_ROUTE = {
  basic:    0,
  standard: 0,
  premium:  500,
  luxury:   2_000,
};
export const SERVICE_QUALITY_COST_PER_ROUTE = {
  basic:    0,
  standard: 0,
  premium:  1_000,
  luxury:   3_500,
};

// ─────────────────────────────────────────────
// AIRCRAFT UTILIZATION & GATE LIMITS
// ─────────────────────────────────────────────

/** Hard cap: an aircraft cannot fly more than this many block-hours per week. */
export const MAX_WEEKLY_BLOCK_HOURS = 140;

/** Slot capacity of a single gate per week (departures from that airport). */
export const SLOTS_PER_GATE = 50;

// Average cruise speed by aircraft category (km/h)
const CRUISE_SPEED_KMH = {
  'Turboprop':    500,
  'Regional Jet': 800,
  'Narrow Body':  840,
  'Wide Body':    870,
  'Double Deck':  870,
  'Supersonic':   2180,  // Concorde cruise ~Mach 2.02
};

// Ground turnaround time by category (hours)
const TURNAROUND_HOURS = {
  'Turboprop':    0.50,   // 30 min
  'Regional Jet': 0.67,   // 40 min
  'Narrow Body':  0.83,   // 50 min
  'Wide Body':    1.50,   // 90 min
  'Double Deck':  2.00,   // 120 min — two boarding doors, complex deplaning
  'Supersonic':   2.00,   // 120 min — complex servicing
};

/**
 * Block time for one sector (hours).
 * = flight time in the air + turnaround on the ground.
 *
 * @param {number} distKm
 * @param {object} type  - aircraft type from AIRCRAFT_TYPES
 */
export function blockTimeHours(distKm, type) {
  const speed      = CRUISE_SPEED_KMH[type.category] ?? 840;
  const turnaround = TURNAROUND_HOURS[type.category] ?? 0.75;
  return distKm / speed + turnaround;
}

/**
 * Total weekly block-hours consumed by an aircraft on a route (both directions).
 * Must be ≤ MAX_WEEKLY_BLOCK_HOURS.
 */
export function weeklyBlockHours(distKm, weeklyFrequency, type) {
  return blockTimeHours(distKm, type) * weeklyFrequency * 2;
}

/**
 * Maximum weekly frequency that keeps block-hours within the 140h cap.
 */
export function maxFrequency(distKm, type) {
  const bt = blockTimeHours(distKm, type);
  return bt > 0 ? Math.floor(MAX_WEEKLY_BLOCK_HOURS / (bt * 2)) : 0;
}

/**
 * Legs-aware weekly block hours for a route (single-leg OR multi-stop).
 * Sums each leg's block time (flight + turnaround) × frequency × 2 directions,
 * so a tag flight correctly costs the block time of every sector it flies.
 */
export function routeBlockHours(route, type, weeklyFrequency) {
  const f = weeklyFrequency ?? route.weeklyFrequency ?? 7;
  return routeLegs(route).reduce(
    (s, l) => s + blockTimeHours(routeDistanceKm(l.from, l.to), type) * f * 2, 0);
}

/**
 * Legs-aware weekly landing + nav fees for a route. A round trip lands at every
 * stop — interior stops twice (once each direction) — which summing the existing
 * per-leg fee reproduces exactly: Σ legs (feeFrom + feeTo) × freq.
 */
export function routeLandingFee(route, type, weeklyFrequency) {
  const f   = weeklyFrequency ?? route.weeklyFrequency ?? 7;
  const cat = type?.category ?? 'Narrow Body';
  return routeLegs(route).reduce((s, l) => {
    const ft = getAirport(l.from)?.tier ?? 'major';
    const tt = getAirport(l.to)?.tier   ?? 'major';
    return s + weeklyLandingFee(cat, f, ft, tt);
  }, 0);
}

/**
 * Distance in km between two airport IATA codes.
 * Returns 0 if either code is unknown.
 */
export function routeDistanceKm(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  return o && d ? Math.round(distanceKm(o, d)) : 0;
}

// ─────────────────────────────────────────────
// AIRCRAFT AGING
// ─────────────────────────────────────────────

/**
 * Maintenance cost multiplier based on aircraft age.
 * At 0 weeks: 1.0×  |  10 years: ~1.5×  |  20 years: ~3.0×
 */
export function maintenanceMultiplier(ageWeeks) {
  const ageYears = (ageWeeks ?? 0) / 52;
  return 1 + Math.pow(ageYears / 20, 2) * 2;
}

/**
 * Game calendar: 52 weeks/year.
 * Jan/Mar/Jul/Oct = 5 weeks; all others = 4 weeks.
 *   Jan  1-5   Feb  6-9   Mar 10-14  Apr 15-18
 *   May 19-22  Jun 23-26  Jul 27-31  Aug 32-35
 *   Sep 36-39  Oct 40-44  Nov 45-48  Dec 49-52
 */
const MONTH_STARTS = [1, 6, 10, 15, 19, 23, 27, 32, 36, 40, 45, 49];
const MONTH_NAMES  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Map game week (1-52) to { monthIndex (1-12), monthName, weekInMonth }.
 */
export function weekToGameDate(week) {
  const w = Math.max(1, Math.min(52, week));
  let mi = 11; // 0-indexed month
  for (let i = 0; i < 12; i++) {
    if (w < (MONTH_STARTS[i + 1] ?? 53)) { mi = i; break; }
  }
  return {
    monthIndex:   mi + 1,
    monthName:    MONTH_NAMES[mi],
    weekInMonth:  w - MONTH_STARTS[mi] + 1,
  };
}

/**
 * Format game state as "Week N Mon Year Y".
 */
export function formatGameDate(state) {
  const { monthName, weekInMonth } = weekToGameDate(state.week);
  return `Week ${weekInMonth} ${monthName} Year ${state.year}`;
}

/**
 * Derive the current game date object from game state.
 * month is 1-indexed (1 = Jan, 12 = Dec).
 */
export function currentGameDate(state) {
  const { monthIndex } = weekToGameDate(state.week);
  return { week: state.week, month: monthIndex };
}

export function ageLabel(ageWeeks) {
  const y = Math.floor((ageWeeks ?? 0) / 52);
  const w = Math.floor((ageWeeks ?? 0) % 52);
  return y > 0 ? `${y}y ${w}w` : `${w}w`;
}

// ─────────────────────────────────────────────
// ROUTE SIMULATION
// ─────────────────────────────────────────────

/**
 * Default cabin configuration for an aircraft type.
 * All seats in economy by default.
 */
export function defaultConfig(totalSeats) {
  return {
    firstClass:     0,
    businessClass:  0,
    premiumEconomy: 0,
    economy:        totalSeats,
    seatQuality:    'standard',
    serviceQuality: 'standard',
  };
}

/**
 * Simulate one week of a route.
 *
 * Demand is computed via the rich demand model in demand.js:
 *   buildRouteMarket → AirlineOffer → computeMarketShare
 * Competitors array is empty for now; the player is always a monopolist.
 *
 * @param {object} route    - { origin, destination, aircraftId, weeklyFrequency,
 *                             ticketPrice, hub?, weeksOpen?, qualityScore? }
 * @param {object} aircraft - fleet aircraft (has .typeId, .ageWeeks, .config)
 * @param {object} [gameDate={ month: 6 }] - { week, month } — month is 1-indexed
 * @returns {object|null}
 */
export function simulateRoute(route, aircraft, gameDate = { month: 6 }, labor = null, fuelMultiplier = 1.0, demandOverride = null, encroachmentSpecs = []) {
  const origin = getAirport(route.origin);
  const dest   = getAirport(route.destination);
  const type   = getAircraftType(aircraft.typeId);
  if (!origin || !dest || !type) return null;

  // Cabin config (fall back to all-economy if not configured)
  const config = aircraft.config ?? defaultConfig(type.seats);

  const dist = distanceKm(origin, dest);
  // Effective range includes the cabin-payload bonus: a lighter cabin flies further.
  const effectiveRange = effectiveRangeKm(aircraft, type);
  if (dist > effectiveRange) return null;

  // Derive a qualityScore for the demand model from the route's service settings.
  // serviceLevel maps seat quality → demand.js tier names.
  const serviceLevelMap = { basic: 'economy', standard: 'economy', premium: 'premium', luxury: 'business' };

  // Labor morale feeds into quality inputs — pilots → on-time rate, cabin crew → customer rating,
  // ground staff → small quality bonus/penalty applied after scoring.
  const { onTimeRate, customerRating, groundQualityBonus } = laborEffects(labor);

  const rawQualityScore = route.qualityScore ?? computeQualityScore({
    onTimeRate,
    serviceLevel:   serviceLevelMap[config.seatQuality ?? 'standard'] ?? 'economy',
    fleetAgeYears:  (aircraft.ageWeeks ?? 0) / 52,
    customerRating,
  });
  // Space bonus: floor left empty (lower density) gives passengers more room.
  const spaceQualityBonus = configSpaceQualityBonus(config, type);
  // Catering quality: the route's catering level moves perceived quality up or
  // down, amplified by distance (food matters more on long flights). Stacks with
  // the per-aircraft service quality already baked into rawQualityScore.
  const cateringLevel    = normalizeCateringLevel(route.cateringLevel);
  const cateringQuality  = cateringQualityBonus(cateringLevel, dist);
  // Hub quality bonus: routes through a player-designated hub get a quality boost from hub investment
  const qualityScore = Math.max(0, Math.min(100, rawQualityScore + groundQualityBonus + spaceQualityBonus + cateringQuality + (route.hubQualityBonus ?? 0)));

  // Hub connectivity bonus (mirrors old hubBonus but expressed as 0–0.25 for the utility model)
  const connectivityBonus = (route.origin === route.hub || route.destination === route.hub) ? 0.20 : 0;

  // Build market and player offer, then run through demand model
  const maturity     = route.weeksOpen != null ? routeMaturityFactor(route.weeksOpen) : 1;
  const market       = buildRouteMarket(route.origin, route.destination, gameDate, maturity);
  // Resolve per-class prices: use route.classPrices when set, fall back to ticketPrice × multiplier
  const cp = route.classPrices ?? {};
  // Supersonic aircraft (e.g. Concorde) command a ticket premium.
  // Applying it here — before the demand model — means higher prices feed through
  // elasticity to reduce demand, while revenue per passenger is also higher.
  const ticketPremium  = type.ticketPremium ?? 1;
  // Clamp to a positive fare: a 0/negative/NaN price would feed Math.pow(ref/price,…)
  // in the elasticity model and yield Infinity/NaN, which cascades into NaN cash and
  // permanently corrupts the save. Reducer actions also clamp, but guard here too.
  const economyPrice   = Math.max(1, (cp.economy ?? route.ticketPrice ?? 1) * ticketPremium);
  const businessPrice  = cp.businessClass  != null ? Math.max(1, cp.businessClass * ticketPremium) : null;

  // Economy capacity = economy-only seats × frequency (not total seats, which includes premium cabins)
  const economySeats = (config.economy ?? type.seats) * route.weeklyFrequency;

  const playerOffer = {
    airlineId:         'player',
    origin:            route.origin,
    destination:       route.destination,
    economyPrice,
    businessPrice,
    weeklyFrequency:   route.weeklyFrequency,
    seatsPerFlight:    type.seats,
    economySeats,
    businessSeats:     (config.businessClass ?? 0) * route.weeklyFrequency,
    qualityScore,
    connectivityBonus,
  };

  // Gather any AI competitors serving this route and compute market share.
  // When multiple player aircraft share the same O&D, weeklyTick pre-computes
  // aggregated demand and passes a demandOverride so we don't double-count.
  let demandResult;
  let competitorOffersCount = 0;
  if (demandOverride) {
    demandResult = demandOverride;
  } else {
    const competitorOffers = COMPETITOR_AIRLINES
      .map(c => buildCompetitorOffer(c, market))
      .filter(Boolean);
    // Injected challengers (e.g. route encroachment) contest this O&D directly.
    if (encroachmentSpecs && encroachmentSpecs.length) {
      for (const spec of encroachmentSpecs) {
        const offer = buildEncroachmentOffer(spec, market);
        if (offer) competitorOffers.push(offer);
      }
    }
    competitorOffersCount = competitorOffers.length;
    const allOffers = [playerOffer, ...competitorOffers];
    const shareResults = computeMarketShare(market, allOffers);
    [demandResult] = shareResults; // player is always first
  }

  // Fan leisure/business pax across cabin classes using segment preferences.
  // Premium classes are filled first; any demand that can't find a premium seat
  // spills down into economy (passengers downgrade rather than not fly).
  const { leisurePax, businessPax } = demandResult; // one-way totals
  // Capacity reflects the REAL configured seat count (premium cabins + any empty
  // floor reduce it below the aircraft's max economy-equivalent units).
  const totalCapOneWay = configBodies(config) * route.weeklyFrequency;
  let totalRevenue     = 0;
  let totalPaxOneWay   = 0;
  const classSummary   = {};
  let spilledToEconomy = 0; // unserved premium demand that falls through to economy

  const cabinPrefs  = getSegmentCabinPrefs(market.distanceKm);
  const CABIN_ORDER = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];
  for (const cls of CABIN_ORDER) {
    const seatsThisClass = config[cls] ?? 0;
    const capOneWay      = seatsThisClass * route.weeklyFrequency;

    const preferredDemand = Math.round(
      businessPax * (cabinPrefs.business[cls] ?? 0) +
      leisurePax  * (cabinPrefs.leisure[cls]  ?? 0)
    );

    // Economy also absorbs spill from premium classes that had no seats
    const effectiveDemand = cls === 'economy'
      ? preferredDemand + spilledToEconomy
      : preferredDemand;

    const paxOneWay  = Math.min(effectiveDemand, capOneWay);
    const unsatisfied = effectiveDemand - paxOneWay;

    // Demand that couldn't be served in this premium class spills to economy
    if (cls !== 'economy') spilledToEconomy += unsatisfied;

    // Use per-class price if explicitly set by the player, scaled by any supersonic
    // ticket premium.  Without explicit pricing, premium cabin passengers pay the
    // economy fare (already premium-adjusted above).
    const fare = cp[cls] != null ? cp[cls] * ticketPremium : economyPrice;
    // Revenue = both directions (paxOneWay × 2 × fare); passengers stored one-way.
    const clsRevenue = paxOneWay * 2 * fare;

    totalPaxOneWay += paxOneWay;
    totalRevenue   += clsRevenue;
    classSummary[cls] = {
      seats:      seatsThisClass,
      passengers: paxOneWay,   // one-way pax (per direction); multiply ×2 for total boarded
      revenue:    Math.round(clsRevenue),
      loadFactor: capOneWay > 0 ? paxOneWay / capOneWay : 0,
    };
  }

  // Upward spill: economy-overflow passengers fill empty premium seats at economy fare.
  // This happens when premium preference demand is less than premium capacity but
  // economy demand exceeds economy seats — passengers get involuntary upgrades.
  // Without this, LF is artificially capped below 100% even when demand > capacity.
  const maxFillable = Math.min(leisurePax + businessPax, totalCapOneWay);
  if (totalPaxOneWay < maxFillable) {
    let upgradeRemaining = maxFillable - totalPaxOneWay;
    for (const cls of ['premiumEconomy', 'businessClass', 'firstClass']) {
      if (upgradeRemaining <= 0) break;
      const seatsThisClass = config[cls] ?? 0;
      const capOneWay      = seatsThisClass * route.weeklyFrequency;
      const usedOneWay     = classSummary[cls]?.passengers ?? 0;  // already one-way
      const emptyOneWay    = capOneWay - usedOneWay;
      if (emptyOneWay <= 0) continue;
      const upgrades = Math.min(upgradeRemaining, emptyOneWay);
      const upgradeRev = Math.round(upgrades * 2 * economyPrice);
      classSummary[cls].passengers += upgrades;  // store one-way
      classSummary[cls].revenue    += upgradeRev;
      classSummary[cls].loadFactor  = capOneWay > 0 ? (usedOneWay + upgrades) / capOneWay : 0;
      totalPaxOneWay += upgrades;
      totalRevenue   += upgradeRev;
      upgradeRemaining -= upgrades;
    }
  }

  const loadFactor = totalCapOneWay > 0 ? totalPaxOneWay / totalCapOneWay : 0;

  // Operating costs
  const flights     = route.weeklyFrequency * 2;
  const aircraftFuelMod = aircraft.fuelMod ?? 1.0;  // from engine/wingtip config at order time
  const fuelCost    = Math.round(dist * fuelCostPerKm(type) * flights * fuelMultiplier * aircraftFuelMod);
  const crewCost    = Math.round(dist * type.crewCostPerKm * flights);
  const qualityCost =
    (SEAT_QUALITY_COST_PER_ROUTE[config.seatQuality ?? 'standard'] ?? 0) +
    (SERVICE_QUALITY_COST_PER_ROUTE[config.serviceQuality ?? 'standard'] ?? 0);

  // Catering — driven by the route's chosen service level. Cost AND ancillary
  // revenue both scale with distance; revenue only on the paid/hybrid levels.
  const catering        = routeCatering(cateringLevel, classSummary, dist);
  const cateringCost    = catering.cost;
  const cateringRevenue = catering.revenue;
  // Ancillary catering income folds straight into route revenue.
  totalRevenue += cateringRevenue;

  // Ground handling — ramp, baggage, gate agents, pushback; per boarded passenger
  const groundHandlingCost = weeklyGroundHandlingCost(classSummary);

  // Crew layover — when one-way block time > 4 hours
  const blockTimeOneWay = blockTimeHours(dist, type);
  const layoverCost = weeklyLayoverCost(blockTimeOneWay, type.seats, type.category, route.weeklyFrequency);

  // Passenger compensation — tied to pilot on-time rate (from morale)
  // Compensation applies to all boarded passengers (both directions = ×2).
  const compensationCost = weeklyPassengerCompensation(totalPaxOneWay * 2, onTimeRate, dist);

  // Lounge & premium ground service — airport lounge access, fast-track security,
  // dedicated check-in for business/first pax. Per-passenger, both directions.
  const loungeCost = weeklyLoungeCost(classSummary);

  const totalOpCost = fuelCost + crewCost + qualityCost + cateringCost + groundHandlingCost + layoverCost + compensationCost + loungeCost;

  return {
    revenue:      Math.round(totalRevenue),
    fuelCost,
    crewCost,
    qualityCost,
    cateringCost,
    cateringRevenue,
    cateringLevel,
    cateringQuality,
    cateringByClass: catering.byClass,
    groundHandlingCost,
    loungeCost,
    layoverCost,
    compensationCost,
    totalOpCost,
    profit:       Math.round(totalRevenue - totalOpCost),
    passengers:        totalPaxOneWay,  // one-way pax (per direction); revenue already covers both directions
    configuredSeatsOneWay: totalCapOneWay, // configured cabin seats × frequency (excludes unassigned physical seats)
    loadFactor,
    distance:     Math.round(dist),
    classSummary,
    // Demand model context (for UI / debugging)
    marketDemand:    market.leisureDemand + market.businessDemand,
    seasonality:     market.seasonalityFactor,
    competitorCount: competitorOffersCount,
    capacityCapped:  demandResult.capacityCapped,
    ticketPremium,   // >1 for supersonic aircraft (e.g. Concorde = 2.5)
  };
}

// ─────────────────────────────────────────────
// TAG (MULTI-STOP) ROUTE SIMULATION
// ─────────────────────────────────────────────
//
// One aircraft flying A → B → C (and back). It sells THREE O&D markets:
//   • local  A–B   (leg 1 only)
//   • local  B–C   (leg 2 only)
//   • through A–C  (BOTH legs — a through passenger occupies a seat on each)
//
// The hard part is the shared seat inventory: leg-1 seats are split between A–B
// and A–C; leg-2 seats between B–C and A–C. We resolve it with a greedy
// allocation by REVENUE PER SEAT-LEG (fare ÷ legs spanned). Dividing a through
// fare by its leg span is exactly the right comparison — a through booking only
// wins a scarce seat when its per-leg yield beats the locals it would displace,
// which is optimal for two legs and near-optimal with integer rounding.
//
// Fidelity notes (intentional simplifications vs simulateRoute):
//   • Two cabins (economy + premium); first/business/premiumEconomy seats are
//     pooled into one "premium" bucket fed by the business demand segment.
//   • No cross-cabin upsell/spill (kept separate so the leg constraint is clean).
//   • Catering/handling/compensation use the whole-route distance and boarded
//     pax rather than per-segment journeys.
// These keep the allocation correct and testable; refine later if needed.

/**
 * Simulate one week of a multi-stop (tag) route.
 *
 * @param {object} route    - must carry stops:[A,B,C,...]; optional segmentPrices
 *                            keyed by routeSegmentKey(from,to) → { economy, businessClass }
 * @param {object} aircraft - fleet aircraft (.typeId, .ageWeeks, .config, .fuelMod)
 * @param {object} [gameDate={month:6}]
 * @returns {object|null}   null if an aircraft/airport is invalid or a leg exceeds range
 */
export function simulateTagRoute(route, aircraft, gameDate = { month: 6 }, labor = null, fuelMultiplier = 1.0) {
  const type  = getAircraftType(aircraft.typeId);
  if (!type) return null;
  const stops = routeStops(route);
  if (stops.length < 2) return null;
  if (stops.some(c => !getAirport(c))) return null;

  const config = aircraft.config ?? defaultConfig(type.seats);
  const legs   = routeLegs(route);
  const legDistKm = legs.map(l => distanceKm(getAirport(l.from), getAirport(l.to)));

  // Range is bound by the LONGEST leg, not the total — that's why a stop extends reach.
  const effectiveRange = effectiveRangeKm(aircraft, type);
  if (Math.max(...legDistKm) > effectiveRange) return null;

  const f = Math.max(1, route.weeklyFrequency ?? 7);

  // ── Quality inputs (shared across segments; catering bonus is per-distance) ──
  const { onTimeRate, customerRating, groundQualityBonus } = laborEffects(labor);
  const serviceLevelMap = { basic: 'economy', standard: 'economy', premium: 'premium', luxury: 'business' };
  const baseQuality = route.qualityScore ?? computeQualityScore({
    onTimeRate,
    serviceLevel:  serviceLevelMap[config.seatQuality ?? 'standard'] ?? 'economy',
    fleetAgeYears: (aircraft.ageWeeks ?? 0) / 52,
    customerRating,
  });
  const spaceBonus    = configSpaceQualityBonus(config, type);
  const cateringLevel = normalizeCateringLevel(route.cateringLevel);

  // ── Per-leg seat capacity (one-way seats/week), economy vs pooled premium ──
  const ecoSeatsPerFlight = config.economy ?? type.seats;
  const bizSeatsPerFlight = (config.firstClass ?? 0) + (config.businessClass ?? 0) + (config.premiumEconomy ?? 0);
  const ecoCap = legs.map(() => ecoSeatsPerFlight * f);   // remaining economy seats per leg
  const bizCap = legs.map(() => bizSeatsPerFlight * f);   // remaining premium seats per leg

  // ── Uncapped demand per sellable segment ──────────────────────────────────
  const maturity = route.weeksOpen != null ? routeMaturityFactor(route.weeksOpen) : 1;
  const segData = routeSegments(route).map(seg => {
    const dist   = distanceKm(getAirport(seg.from), getAirport(seg.to));
    const market = buildRouteMarket(seg.from, seg.to, gameDate, maturity);
    const sp     = route.segmentPrices?.[routeSegmentKey(seg.from, seg.to)];
    const eco    = Math.max(1, sp?.economy ?? market.referencePrice);
    const biz    = Math.max(1, sp?.businessClass ?? eco * CLASS_FARE_MULTIPLIERS.businessClass);
    const quality = Math.max(0, Math.min(100,
      baseQuality + groundQualityBonus + spaceBonus
      + cateringQualityBonus(cateringLevel, dist) + (route.hubQualityBonus ?? 0)));
    const connectivityBonus = (seg.from === route.hub || seg.to === route.hub) ? 0.20 : 0;
    const offer = {
      airlineId: 'player', origin: seg.from, destination: seg.to,
      economyPrice: eco, businessPrice: biz, weeklyFrequency: f,
      seatsPerFlight: type.seats,
      economySeats: 1e12, businessSeats: 1e12,   // huge → demand returns uncapped
      qualityScore: quality, connectivityBonus,
    };
    const competitorOffers = COMPETITOR_AIRLINES
      .map(c => buildCompetitorOffer(c, market)).filter(Boolean);
    const [res] = computeMarketShare(market, [offer, ...competitorOffers]);
    const legIdxs = [];
    for (let k = seg.fromIdx; k < seg.toIdx; k++) legIdxs.push(k);
    return {
      from: seg.from, to: seg.to, dist, eco, biz, legIdxs, legSpan: seg.legSpan,
      ecoDemand: res.leisurePax, bizDemand: res.businessPax,
    };
  });

  // ── Greedy allocation of a shared cabin pool, by revenue per seat-leg ──────
  const allocate = (cap, demandKey, fareKey) => {
    const cands = segData
      .map((d, i) => ({ i, qty: d[demandKey], fare: d[fareKey], legIdxs: d.legIdxs, legSpan: d.legSpan }))
      .filter(c => c.qty > 0)
      .sort((a, b) => (b.fare / b.legSpan) - (a.fare / a.legSpan));
    const paxBySeg = new Array(segData.length).fill(0);
    let totalPax = 0, totalRev = 0;
    for (const c of cands) {
      const avail = Math.min(...c.legIdxs.map(li => cap[li]));
      const alloc = Math.max(0, Math.min(c.qty, avail));
      if (alloc <= 0) continue;
      for (const li of c.legIdxs) cap[li] -= alloc;
      paxBySeg[c.i] = alloc;
      totalPax += alloc;
      totalRev += alloc * 2 * c.fare;   // ×2 = both directions (pax stored one-way)
    }
    return { paxBySeg, totalPax, totalRev };
  };
  const ecoAlloc = allocate(ecoCap.slice(), 'ecoDemand', 'eco');
  const bizAlloc = allocate(bizCap.slice(), 'bizDemand', 'biz');

  // ── Per-leg utilisation ───────────────────────────────────────────────────
  const perLeg = legs.map((l, li) => {
    const ecoUsed = segData.reduce((s, d, i) => s + (d.legIdxs.includes(li) ? ecoAlloc.paxBySeg[i] : 0), 0);
    const bizUsed = segData.reduce((s, d, i) => s + (d.legIdxs.includes(li) ? bizAlloc.paxBySeg[i] : 0), 0);
    const capOneWay = (ecoSeatsPerFlight + bizSeatsPerFlight) * f;
    return {
      from: l.from, to: l.to, distance: Math.round(legDistKm[li]),
      ecoUsed, bizUsed, seats: capOneWay,
      loadFactor: capOneWay > 0 ? (ecoUsed + bizUsed) / capOneWay : 0,
    };
  });

  const totalDist      = legDistKm.reduce((s, d) => s + d, 0);
  const totalPaxOneWay = ecoAlloc.totalPax + bizAlloc.totalPax;
  let   totalRevenue   = ecoAlloc.totalRev + bizAlloc.totalRev;

  // Two-class summary for the shared cost helpers (passengers are one-way).
  const classSummary = {
    economy:       { seats: ecoSeatsPerFlight * f, passengers: ecoAlloc.totalPax, revenue: ecoAlloc.totalRev },
    businessClass: { seats: bizSeatsPerFlight * f, passengers: bizAlloc.totalPax, revenue: bizAlloc.totalRev },
  };

  // ── Operating costs ───────────────────────────────────────────────────────
  // Each leg is flown f×2 sectors/week; total ground covered = Σ leg distances.
  const sectorFactor    = f * 2;
  const aircraftFuelMod = aircraft.fuelMod ?? 1.0;
  const fuelCost = Math.round(totalDist * fuelCostPerKm(type) * sectorFactor * fuelMultiplier * aircraftFuelMod);
  const crewCost = Math.round(totalDist * type.crewCostPerKm * sectorFactor);
  const qualityCost =
    (SEAT_QUALITY_COST_PER_ROUTE[config.seatQuality ?? 'standard'] ?? 0) +
    (SERVICE_QUALITY_COST_PER_ROUTE[config.serviceQuality ?? 'standard'] ?? 0);

  const catering        = routeCatering(cateringLevel, classSummary, totalDist);
  const cateringCost    = catering.cost;
  const cateringRevenue = catering.revenue;
  totalRevenue += cateringRevenue;

  const groundHandlingCost = weeklyGroundHandlingCost(classSummary);
  const loungeCost         = weeklyLoungeCost(classSummary);
  // Layover cost accrues per leg whose one-way block time clears the threshold.
  const layoverCost = legDistKm.reduce(
    (s, d) => s + weeklyLayoverCost(blockTimeHours(d, type), type.seats, type.category, f), 0);
  const compensationCost = weeklyPassengerCompensation(totalPaxOneWay * 2, onTimeRate, totalDist);

  const totalOpCost = fuelCost + crewCost + qualityCost + cateringCost
    + groundHandlingCost + loungeCost + layoverCost + compensationCost;

  const totalSeatLegsAvail = legs.length * (ecoSeatsPerFlight + bizSeatsPerFlight) * f;
  const totalSeatLegsUsed  = perLeg.reduce((s, l) => s + l.ecoUsed + l.bizUsed, 0);

  return {
    tag:          true,
    revenue:      Math.round(totalRevenue),
    fuelCost,
    crewCost,
    qualityCost,
    cateringCost,
    cateringRevenue,
    cateringLevel,
    groundHandlingCost,
    loungeCost,
    layoverCost,
    compensationCost,
    totalOpCost,
    profit:       Math.round(totalRevenue - totalOpCost),
    passengers:   totalPaxOneWay,                       // one-way boarded pax (all segments)
    loadFactor:   totalSeatLegsAvail > 0 ? totalSeatLegsUsed / totalSeatLegsAvail : 0,
    distance:     Math.round(totalDist),                // total ground covered
    maxLegKm:     Math.round(Math.max(...legDistKm)),
    stops:        [...stops],
    legs:         perLeg,
    segments:     segData.map((d, i) => ({
      from: d.from, to: d.to, legSpan: d.legSpan,
      pax:      ecoAlloc.paxBySeg[i] + bizAlloc.paxBySeg[i],
      ecoPax:   ecoAlloc.paxBySeg[i],
      bizPax:   bizAlloc.paxBySeg[i],
      ecoFare:  d.eco,
      bizFare:  d.biz,
    })),
    classSummary,
  };
}

// ─────────────────────────────────────────────
// CARGO SIMULATION
// ─────────────────────────────────────────────

/**
 * Yield (price) elasticity of cargo demand. Forwarders shop on rate, but freight is
 * less elastic than leisure pax — there's no "drive instead" option on a 9,000 km lane.
 */
export const CARGO_YIELD_ELASTICITY = 1.1;

/**
 * Fraction of the total cargo pool that dedicated freighters can capture. Belly cargo
 * (freight under passenger flights) is out of scope for v1, so this is 1.0 — freighters
 * see the whole market. When belly cargo is added later, drop this below 1.0 to reserve
 * the belly share, with NO other rebalancing needed.
 */
export const FREIGHTER_CAPTURE_RATE = 1.0;

/** Cargo terminal handling cost ($ per tonne, charged each way). */
export const CARGO_HANDLING_PER_TONNE = 85;

/**
 * Backhaul imbalance: air freight is directional (loaded out of manufacturing hubs,
 * lighter on the return). Instead of charging both directions at full headhaul, the
 * return leg earns this fraction. 1.0 = perfectly balanced; lower = more imbalance.
 * Applied as the revenue multiplier (1 + CARGO_BACKHAUL_FACTOR) on one-way tonnage.
 */
export const CARGO_BACKHAUL_FACTOR = 0.65;

/**
 * Map a freighter's payload to the landing-fee category used by weeklyLandingFee
 * (the fee table is keyed by passenger body class; freighters pay the equivalent for
 * their size/weight).
 */
export function freighterLandingCategory(payloadTonnes = 0) {
  if (payloadTonnes >= 50) return 'Wide Body';
  if (payloadTonnes >= 20) return 'Narrow Body';
  if (payloadTonnes >= 10) return 'Regional Jet';
  return 'Turboprop';
}

/**
 * Simulate one cargo route for a week. The freighter analogue of simulateRoute():
 * fills tonnes against the cargo demand pool at the player's chosen yield, applies
 * yield elasticity, and returns revenue and variable operating costs.
 *
 * Cargo route shape: { origin, destination, weeklyFrequency, yieldPrice ($/tonne-km),
 *                      weeksOpen?, hub? }
 * Revenue and costs cover BOTH directions (×2), mirroring simulateRoute.
 * Landing fees are added by the weekly tick (which knows airport tiers).
 *
 * @returns {object|null} null if the aircraft isn't a freighter or can't reach the route.
 */
export function simulateCargoRoute(route, aircraft, gameDate = { month: 6 }, labor = null, fuelMultiplier = 1.0, demandMultiplier = 1.0) {
  const origin = getAirport(route.origin);
  const dest   = getAirport(route.destination);
  const type   = getAircraftType(aircraft.typeId);
  if (!origin || !dest || !type || !type.freighter) return null;

  const dist = distanceKm(origin, dest);
  const effectiveRange = effectiveRangeKm(aircraft, type);
  if (dist > effectiveRange) return null;

  // ── Demand (tonnes/week, one-way) ────────────────────────────────────────────
  // demandMultiplier carries brand awareness from the weekly tick: a new carrier
  // isn't yet on forwarders' books, so it wins less of the pool until it grows.
  const maturity   = route.weeksOpen != null ? routeMaturityFactor(route.weeksOpen) : 1;
  const basePool   = cargoCityPairDemand(route.origin, route.destination) * maturity * FREIGHTER_CAPTURE_RATE * demandMultiplier;

  // Yield elasticity: pricing above the reference rate shrinks the tonnage you win.
  const refYield   = cargoReferenceYield(route.origin, route.destination);
  const yieldPrice = Math.max(0.01, route.yieldPrice ?? refYield);
  const elasticity = Math.min(1.6, Math.pow(refYield / yieldPrice, CARGO_YIELD_ELASTICITY));
  const demandTonnes = basePool * elasticity;

  // ── Capacity & load ──────────────────────────────────────────────────────────
  const capacityTonnes = type.payloadTonnes * route.weeklyFrequency;   // one-way
  const tonnesOneWay   = Math.min(demandTonnes, capacityTonnes);
  const loadFactor     = capacityTonnes > 0 ? tonnesOneWay / capacityTonnes : 0;

  // Revenue covers both directions, with backhaul imbalance (return leg lighter).
  // Yield is $/tonne-km; tonnes are one-way (headhaul).
  const revenue = Math.round(tonnesOneWay * (1 + CARGO_BACKHAUL_FACTOR) * dist * yieldPrice);

  // ── Operating costs ──────────────────────────────────────────────────────────
  const flights         = route.weeklyFrequency * 2;
  const aircraftFuelMod = aircraft.fuelMod ?? 1.0;
  const fuelCost  = Math.round(dist * fuelCostPerKm(type) * flights * fuelMultiplier * aircraftFuelMod);
  const crewCost  = Math.round(dist * type.crewCostPerKm * flights);
  const groundHandlingCost = Math.round(tonnesOneWay * 2 * CARGO_HANDLING_PER_TONNE);

  const totalOpCost = fuelCost + crewCost + groundHandlingCost;

  return {
    cargo:        true,
    revenue,
    fuelCost,
    crewCost,
    groundHandlingCost,
    totalOpCost,
    profit:       revenue - totalOpCost,   // before landing fees (added by weeklyTick)
    tonnes:       Math.round(tonnesOneWay),         // one-way tonnes/week
    capacityTonnes,
    loadFactor,
    distance:     Math.round(dist),
    yieldPrice,
    refYield,
    demandTonnes: Math.round(demandTonnes),
  };
}

// ─────────────────────────────────────────────
// LOYALTY PROGRAM MODEL
// ─────────────────────────────────────────────
// Every loyalty effect scales with MEMBER PENETRATION — the share of your own
// flyers who are members — rather than an absolute member count. This keeps the
// milestones meaningful at any airline size (a 100k-member program is elite for
// a small carrier and trivial for a giant one) and makes the program a slow,
// expensive asset to mature rather than a week-one freebie.
//
// Penetration is members / (4 weeks of passengers) — i.e. roughly the fraction
// of a month's travellers carrying your card. It saturates at 1.0.

export function loyaltyPenetration(members, weeklyPassengers) {
  if (!weeklyPassengers || weeklyPassengers <= 0) return 0;
  return Math.min(1, (members ?? 0) / (weeklyPassengers * 4));
}

// Investment tier → program quality. Higher tiers unlock a higher achievable
// penetration CEILING (how deep into your base you can sign people up) and pay
// richer rewards (generosity drives the points-redemption cost). The tier sets
// where the program can go; the weekly budget sets how fast it gets there.
export function loyaltyTier(weeklyInvestment) {
  const inv = weeklyInvestment ?? 0;
  if (inv <= 0)        return { label: 'None',   maxPenetration: 0,    generosity: 0    };
  if (inv < 100_000)   return { label: 'Basic',  maxPenetration: 0.15, generosity: 0.85 };
  if (inv < 250_000)   return { label: 'Silver', maxPenetration: 0.30, generosity: 1.00 };
  if (inv < 500_000)   return { label: 'Gold',   maxPenetration: 0.45, generosity: 1.15 };
  return                      { label: 'Elite',  maxPenetration: 0.60, generosity: 1.30 };
}

// Per-week enrollment pull as a fraction of passengers flown, driven by budget.
// Continuous in spend so the slider still matters; the S-curve ceiling (above)
// is what ultimately bounds the program.
export function loyaltyEnrollPull(weeklyInvestment) {
  return Math.min(0.25, (weeklyInvestment ?? 0) / 2_000_000);
}

// Demand stability boost (retained price-defectors). Concentrated on hub routes
// by the caller; this is the full hub-route figure. Cap +10%, reached near 40%
// penetration.
export function loyaltyDemandBoostPct(penetration) {
  return Math.min(0.10, 0.25 * (penetration ?? 0));
}

// Effective price-sensitivity reduction members confer. Cap 15%, near maturity.
export function loyaltyPriceSensitivityReduction(penetration) {
  return Math.min(0.15, 0.35 * (penetration ?? 0));
}

// Brand/reputation bonus: only a deep, mature program earns the full +8. Linear
// in penetration, full value at ~45% penetration (a Gold+ program at scale).
export function loyaltyReputationBonus(penetration) {
  return Math.min(8, Math.round(8 * ((penetration ?? 0) / 0.45)));
}

// Points-redemption cost as a share of revenue. Scales with penetration AND tier
// generosity (richer programs give more away). Real programs run ~2–4%; cap 4%.
export function loyaltyPointsCostPct(penetration, generosity) {
  return Math.min(0.04, 0.06 * (penetration ?? 0) * (generosity || 1));
}

// ─────────────────────────────────────────────
// WEEKLY TICK
// ─────────────────────────────────────────────

/**
 * Advances the game one week. Returns a full financial report.
 *
 * @param {object} state - { fleet, routes, gameDate? }
 *   gameDate: { week, month } — month 1-indexed. Defaults to { month: 6 } if absent.
 */
export function weeklyTick(state) {
  const {
    fleet, routes: rawRoutes = [], cargoRoutes = [], gameDate = { month: 6 }, gates = {}, labor,
    maintenanceBudget = 1.0, fuelMultiplier = 1.0,
    marketingBudget = 0,
    loyalty = { weeklyInvestment: 0, members: 0 },
    awareness = 5,
    encroachments = {},
  } = state;

  // Encroachment challengers, keyed by O&D pair, injected into the demand model so
  // they split the route's passenger pool with the player.
  const encroachByPair = (pairKey) => {
    const e = encroachments?.[pairKey];
    return e ? [e] : [];
  };

  // Price and catering live on the route (O&D pair) in state.routePricing /
  // state.routeCatering — hydrate each route object so the engine reads
  // route.classPrices / route.cateringLevel as before.
  const routePricing  = state.routePricing  ?? {};
  const routeCatering = state.routeCatering ?? {};
  const routes = rawRoutes.map(r => hydrateRoute(r, routePricing, routeCatering));
  // Routes operating THIS month. Dormant seasonal routes must not provide network
  // feed, interline adjacency, or cannibalization while they're out of season.
  const activeRoutes = routes.filter(r => isRouteActive(r, gameDate.month));

  // Awareness multiplier: new/unknown airlines attract only a fraction of potential demand.
  // Range 0.4 (awareness=0, brand unknown) → 1.0 (awareness=100, household name).
  const awarenessMultiplier = 0.4 + (awareness / 100) * 0.6;

  // ── Alliance / codeshare setup ────────────────────────────────────────────
  const allianceMembership  = state.allianceMembership  ?? null;
  const codeshareAgreements = state.codeshareAgreements ?? [];
  const competitors         = state.competitors         ?? [];

  // Build set of airports the player serves (for interline adjacency).
  // Only routes operating this month count — a dormant route serves no one.
  const servedAirports = new Set();
  for (const r of activeRoutes) {
    servedAirports.add(r.origin);
    servedAirports.add(r.destination);
  }

  // IDs of alliance and codeshare partners
  const allianceDef         = allianceMembership ? getAlliance(allianceMembership.allianceId) : null;
  const alliancePartnerIds  = allianceDef?.memberIds ?? [];
  const codesharePartnerIds = codeshareAgreements.map(a => a.competitorId);
  const allPartnerIds       = new Set([...alliancePartnerIds, ...codesharePartnerIds]);

  // One entry per partner (duplicates allowed when multiple partners share a hub airport)
  // — used to boost external connecting feed at airports where partners operate
  const partnerHubCodes = [];
  for (const partnerId of allPartnerIds) {
    const comp = competitors.find(c => c.id === partnerId);
    if (comp?.homeHub) partnerHubCodes.push(comp.homeHub);
  }

  // ── Network O&D cannibalization ───────────────────────────────────────────
  // Run the full network tick: enumerates 1-stop connections, applies logit
  // diversion when a direct route competes, computes O&D-based partner revenue.
  const networkTick = runNetworkTick({
    routes: activeRoutes,
    competitors,
    allianceMembership,
    codeshareAgreements,
    allianceDef,
    gameDate,
  });
  const { cannibalizationMap, partnerODRevenue, partnerHealthDecay } = networkTick;

  // Pre-build set of route-keys where an alliance/codeshare partner also operates
  const partnerContestedKeys = new Set();
  for (const comp of competitors) {
    if (!allPartnerIds.has(comp.id)) continue;
    for (const key of Object.keys(comp.routes ?? {})) {
      partnerContestedKeys.add(key);
    }
  }

  // Demand boost on routes where an alliance partner competes (codeshare partners don't stack)
  const allianceDemandBoostPct = allianceDef?.demandBoostPct ?? 0;

  // Loyalty demand effect: members are less price-sensitive, so the player
  // retains more of them even when competitors undercut. The size of the effect
  // scales with member PENETRATION (share of our own flyers enrolled), using
  // last week's passenger count as the base. It is CONCENTRATED on hub routes —
  // where frequent flyers actually have a captive relationship — and diluted on
  // off-hub leisure routes where people buy on price regardless.
  const loyaltyMembers      = loyalty?.members ?? 0;
  const loyaltyPaxBase      = state.lastReport?.totalPassengers ?? 0;
  const loyaltyPenet        = loyaltyPenetration(loyaltyMembers, loyaltyPaxBase);
  const loyaltyBoostHub     = loyaltyDemandBoostPct(loyaltyPenet);   // full, hub routes
  const loyaltyBoostOffHub  = loyaltyBoostHub * 0.4;                 // diluted, off-hub
  // Headline multiplier reported to the UI is the hub-route ("up to") figure,
  // consistent with how marketing/awareness lifts are surfaced.
  const loyaltyMultiplier   = 1 + loyaltyBoostHub;

  // Pre-compute marketing multiplier (needs an initial revenue pass — use last week's revenue
  // if available, otherwise estimate from current routes without multiplier applied yet)
  const lastRevenue = state.financialHistory?.length
    ? state.financialHistory[state.financialHistory.length - 1]?.revenue ?? 0
    : 0;
  const mktMultiplier = marketingDemandMultiplier(marketingBudget, Math.max(lastRevenue, 1));

  // 1. Route revenue + operating costs
  let totalRevenue        = 0;
  let totalConnecting     = 0;
  let totalFuel           = 0;
  let totalCrew           = 0;
  let totalQuality        = 0;
  let totalCatering       = 0;   // catering COST
  let totalCateringRevenue = 0;  // ancillary catering REVENUE
  let totalGroundHandling = 0;
  let totalLounge         = 0;
  let totalLayover        = 0;
  let totalCompensation   = 0;
  let totalLandingFees    = 0;
  let totalPassengers     = 0;
  const routeResults    = [];

  // Pre-count how many routes the player has at each airport (for hub feed bonus).
  // Dormant seasonal routes don't operate this month, so they don't feed the hub.
  const routeCountByAirport = {};
  for (const r of routes) {
    if (!isRouteActive(r, gameDate.month)) continue;
    routeCountByAirport[r.origin]      = (routeCountByAirport[r.origin]      ?? 0) + 1;
    routeCountByAirport[r.destination] = (routeCountByAirport[r.destination] ?? 0) + 1;
  }

  // Build the hubs map, with backward-compat for saves that only have state.hub (a string)
  const hubs = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});

  // ── Pre-pass: aggregate player demand per O&D pair ───────────────────────────
  // When multiple aircraft share the same origin–destination pair each
  // simulateRoute call would independently claim the full market share,
  // overcounting passengers by N×.  Instead, build ONE combined player offer
  // per route group, compute market share once, then split pax proportionally
  // by each aircraft's seat contribution.
  const demandAllocations = new Map(); // aircraftId → demandResult override

  {
    // Group active routes by sorted routeKey
    const routeGroups = new Map(); // routeKey → [{ route, aircraft }]
    for (const route of routes) {
      const aircraft = fleet.find(a => a.id === route.aircraftId);
      if (!aircraft || aircraft.status === 'grounded') continue;
      if (!isRouteActive(route, gameDate.month)) continue;   // dormant this month
      if (isMultiStop(route)) continue;   // tag routes self-contain their O&D split
      const rk = [route.origin, route.destination].sort().join('-');
      if (!routeGroups.has(rk)) routeGroups.set(rk, []);
      routeGroups.get(rk).push({ route, aircraft });
    }

    for (const [, group] of routeGroups) {
      if (group.length < 2) continue; // single aircraft — simulateRoute handles it

      const { route: r0 } = group[0];
      const maturity = r0.weeksOpen != null ? routeMaturityFactor(r0.weeksOpen) : 1;
      const market   = buildRouteMarket(r0.origin, r0.destination, gameDate, maturity);

      // Aggregate capacity across all aircraft in the group
      let totalEcoSeats = 0;
      let totalBizSeats = 0;
      let totalFreq     = 0;
      let totalQuality  = 0;
      let hasBusinessCabin = false;

      for (const { route, aircraft } of group) {
        const type = getAircraftType(aircraft.typeId);
        if (!type) continue;
        const cfg  = aircraft.config ?? defaultConfig(type.seats);
        const freq = route.weeklyFrequency ?? 7;
        const eco  = (cfg.economy ?? type.seats) * freq;
        const biz  = (cfg.businessClass ?? 0) * freq;
        totalEcoSeats += eco;
        totalBizSeats += biz;
        totalFreq     += freq;
        totalQuality  += computeQualityScore({
          onTimeRate:    laborEffects(labor).onTimeRate,
          serviceLevel:  ({ basic: 'economy', standard: 'economy', premium: 'premium', luxury: 'business' })[cfg.seatQuality ?? 'standard'] ?? 'economy',
          fleetAgeYears: (aircraft.ageWeeks ?? 0) / 52,
          customerRating: laborEffects(labor).customerRating,
        });
        if (biz > 0) hasBusinessCabin = true;
      }

      const avgQuality = Math.round(totalQuality / group.length);
      const cp0 = r0.classPrices ?? {};
      const ecoPrice = Math.max(1, cp0.economy ?? r0.ticketPrice ?? 1);
      const bizPrice = hasBusinessCabin && cp0.businessClass != null
        ? Math.max(1, cp0.businessClass)
        : hasBusinessCabin ? ecoPrice * 3.5 : null;
      const connBonus = (r0.origin === r0.hub || r0.destination === r0.hub) ? 0.20 : 0;

      const combinedOffer = {
        airlineId:         'player',
        origin:            r0.origin,
        destination:       r0.destination,
        economyPrice:      ecoPrice,
        businessPrice:     bizPrice,
        weeklyFrequency:   totalFreq,
        seatsPerFlight:    totalFreq > 0 ? Math.round((totalEcoSeats + totalBizSeats) / totalFreq) : 0,
        economySeats:      totalEcoSeats,
        businessSeats:     totalBizSeats,
        qualityScore:      avgQuality,
        connectivityBonus: connBonus,
      };

      const competitorOffers = COMPETITOR_AIRLINES
        .map(c => buildCompetitorOffer(c, market))
        .filter(Boolean);
      // Inject any encroachment challengers contesting this O&D pair.
      const rkPre = [r0.origin, r0.destination].sort().join('-');
      for (const spec of encroachByPair(rkPre)) {
        const offer = buildEncroachmentOffer(spec, market);
        if (offer) competitorOffers.push(offer);
      }
      const [combinedResult] = computeMarketShare(market, [combinedOffer, ...competitorOffers]);

      // Distribute pax to each aircraft proportionally by seat share
      for (const { route, aircraft } of group) {
        const type = getAircraftType(aircraft.typeId);
        if (!type) continue;
        const cfg  = aircraft.config ?? defaultConfig(type.seats);
        const freq = route.weeklyFrequency ?? 7;
        const eco  = (cfg.economy ?? type.seats) * freq;
        const biz  = (cfg.businessClass ?? 0) * freq;
        const ecoFrac = totalEcoSeats > 0 ? eco / totalEcoSeats : 1 / group.length;
        const bizFrac = totalBizSeats > 0 ? biz / totalBizSeats : 1 / group.length;

        demandAllocations.set(aircraft.id, {
          leisurePax:      Math.round(combinedResult.leisurePax  * ecoFrac),
          businessPax:     Math.round(combinedResult.businessPax * bizFrac),
          economyRevenue:  Math.round(combinedResult.economyRevenue  * ecoFrac),
          businessRevenue: Math.round(combinedResult.businessRevenue * bizFrac),
          leisureShare:    combinedResult.leisureShare,
          businessShare:   combinedResult.businessShare,
          capacityCapped:  combinedResult.capacityCapped,
        });
      }
    }
  }
  // ── End pre-pass ─────────────────────────────────────────────────────────────

  for (const route of routes) {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    if (!aircraft) continue;
    if (aircraft.status === 'grounded') continue; // mechanical failure — no revenue this week
    if (!isRouteActive(route, gameDate.month)) continue; // seasonal route dormant this month

    // ── Tag (multi-stop) route: self-contained O&D split via simulateTagRoute ──
    // It already returns blended revenue/costs across all legs & segments. We
    // apply the same demand multipliers and per-airport landing fees, but skip
    // the single-leg connecting-demand model (tag/network feed is a later phase).
    if (isMultiStop(route)) {
      const stopsList = routeStops(route);
      const tagHubQuality = Math.max(0, ...stopsList.map(c => {
        const t = hubs[c]?.tier;
        return t ? (HUB_TIERS[t]?.qualityBonus ?? 0) : 0;
      }));
      const tagRoute = tagHubQuality > 0 ? { ...route, hubQualityBonus: tagHubQuality } : route;
      const result = simulateTagRoute(tagRoute, aircraft, gameDate, labor, fuelMultiplier);
      if (!result) continue;

      const cateringRev    = result.cateringRevenue ?? 0;
      // Loyalty boost is concentrated on hub-touching routes.
      const tagLoyaltyBoost = tagHubQuality > 0 ? loyaltyBoostHub : loyaltyBoostOffHub;
      const combinedMult   = awarenessMultiplier * mktMultiplier * (1 + tagLoyaltyBoost);
      const boostedRevenue = Math.round((result.revenue - cateringRev) * combinedMult) + cateringRev;
      const routeRevenue   = boostedRevenue;   // no simple connecting add for tag routes

      const type       = getAircraftType(aircraft.typeId);
      const landingFee = routeLandingFee(route, type, route.weeklyFrequency);

      totalRevenue        += routeRevenue;
      totalFuel           += result.fuelCost;
      totalCrew           += result.crewCost;
      totalQuality        += result.qualityCost;
      totalCatering        += result.cateringCost      ?? 0;
      totalCateringRevenue += cateringRev;
      totalGroundHandling += result.groundHandlingCost ?? 0;
      totalLounge         += result.loungeCost         ?? 0;
      totalLayover        += result.layoverCost        ?? 0;
      totalCompensation   += result.compensationCost   ?? 0;
      totalLandingFees    += landingFee;
      totalPassengers     += result.passengers ?? 0;

      const { maintenanceCostMultiplier } = laborEffects(labor);
      const weeklyLeaseCost = aircraft.ownershipType === 'owned' ? 0
        : (aircraft.weeklyLease ?? type?.weeklyLease ?? 0);
      const weeklyMaintCost = Math.round(
        (type?.baseMaintenancePerWk ?? 0)
        * maintenanceMultiplier(aircraft.ageWeeks ?? 0)
        * maintenanceBudget * maintenanceCostMultiplier * (aircraft.maintMod ?? 1.0)
      );

      routeResults.push({
        routeId: route.id,
        ...result,
        revenue:       routeRevenue,
        marketingLift: Math.round(result.revenue * (mktMultiplier   - 1)),
        loyaltyLift:   Math.round(result.revenue * tagLoyaltyBoost),
        allianceLift:  0,
        landingFee,
        profit:        Math.round(routeRevenue - result.totalOpCost - landingFee),
        weeklyLeaseCost,
        weeklyMaintCost,
        trueProfit:    Math.round(routeRevenue - result.totalOpCost - landingFee - weeklyLeaseCost - weeklyMaintCost),
        connecting:    { totalPax: 0, totalRevenue: 0 },
      });
      continue;
    }

    // Inject hub quality bonus from the best hub on this route
    const originTier  = hubs[route.origin]?.tier;
    const destTier    = hubs[route.destination]?.tier;
    const hubQuality  = Math.max(
      originTier ? (HUB_TIERS[originTier]?.qualityBonus ?? 0) : 0,
      destTier   ? (HUB_TIERS[destTier]?.qualityBonus   ?? 0) : 0,
    );
    const routeWithHubBonus = hubQuality > 0 ? { ...route, hubQualityBonus: hubQuality } : route;

    const rkRoute = [route.origin, route.destination].sort().join('-');
    const result = simulateRoute(routeWithHubBonus, aircraft, gameDate, labor, fuelMultiplier,
      demandAllocations.get(aircraft.id) ?? null, encroachByPair(rkRoute));
    if (!result) continue;

    // Connecting passengers: additional revenue from hub-feed and partner agreements.
    // The cannibalizationMap factor reduces connecting demand on routes where a
    // direct flight (own or competitor) siphons off O&D passengers that previously
    // connected through the player's hubs.
    // Guard the fare: a route missing its pair-pricing (malformed/legacy save)
    // would pass undefined here, and the divisions inside computeConnectingDemand
    // would yield NaN — which cascades into NaN revenue and permanently corrupts
    // the save. Fall back to the market reference fare.
    const connectingPrice = route.ticketPrice ?? referencePrice(route.origin, route.destination);
    const connectingRaw = computeConnectingDemand(
      route.origin,
      route.destination,
      hubs,
      routeCountByAirport[route.origin]      ?? 0,
      routeCountByAirport[route.destination] ?? 0,
      connectingPrice,
      { weeklyFrequency: route.weeklyFrequency ?? 7, partnerHubCodes },
    );
    // Apply marketing + loyalty + alliance demand boosts to passenger revenue
    const routeKey       = [route.origin, route.destination].sort().join('-');
    const cannibFactor = cannibalizationMap[routeKey] ?? 1.0;
    const connecting   = cannibFactor < 1.0
      ? {
          ...connectingRaw,
          totalPax:     Math.round(connectingRaw.totalPax     * cannibFactor),
          totalRevenue: Math.round(connectingRaw.totalRevenue * cannibFactor),
          origin:       { ...connectingRaw.origin,      pax: Math.round((connectingRaw.origin?.pax      ?? 0) * cannibFactor), revenue: Math.round((connectingRaw.origin?.revenue      ?? 0) * cannibFactor) },
          destination:  { ...connectingRaw.destination, pax: Math.round((connectingRaw.destination?.pax ?? 0) * cannibFactor), revenue: Math.round((connectingRaw.destination?.revenue ?? 0) * cannibFactor) },
          cannibalizationFactor: +cannibFactor.toFixed(3),
        }
      : connectingRaw;
    const allianceLift   = partnerContestedKeys.has(routeKey) ? allianceDemandBoostPct : 0;
    const marketingLift  = mktMultiplier - 1;
    // Loyalty boost concentrated on hub-touching routes, diluted elsewhere.
    const loyaltyLift    = hubQuality > 0 ? loyaltyBoostHub : loyaltyBoostOffHub;
    const combinedMult   = awarenessMultiplier * mktMultiplier * (1 + loyaltyLift) * (1 + allianceLift);
    // Ancillary catering revenue is per-actual-passenger income — it should NOT be
    // amplified by the marketing/awareness/loyalty demand multipliers (those proxy
    // for attracting MORE passengers, which catering income would then double-count).
    // Strip it out before boosting, then add it back unscaled.
    const cateringRev    = result.cateringRevenue ?? 0;
    const boostedRevenue = Math.round((result.revenue - cateringRev) * combinedMult) + cateringRev;
    const routeRevenue   = boostedRevenue + connecting.totalRevenue;

    // Landing & navigation fees for this route
    const type         = getAircraftType(aircraft.typeId);
    const originAp     = getAirport(route.origin);
    const destAp       = getAirport(route.destination);
    const landingFee   = weeklyLandingFee(
      type?.category ?? 'Narrow Body',
      route.weeklyFrequency,
      originAp?.tier ?? 'major',
      destAp?.tier   ?? 'major',
    );

    totalRevenue        += routeRevenue;
    totalConnecting     += connecting.totalRevenue;
    totalFuel           += result.fuelCost;
    totalCrew           += result.crewCost;
    totalQuality        += result.qualityCost;
    totalCatering        += result.cateringCost       ?? 0;
    totalCateringRevenue += cateringRev;
    totalGroundHandling += result.groundHandlingCost  ?? 0;
    totalLounge         += result.loungeCost          ?? 0;
    totalLayover        += result.layoverCost         ?? 0;
    totalCompensation   += result.compensationCost    ?? 0;
    totalLandingFees    += landingFee;
    totalPassengers   += result.passengers ?? 0;
    // Aircraft fixed costs — exposed on the route result so the UI can show
    // a "true profit" (fully loaded) alongside the variable-cost profit.
    // These are NOT added to the route-level totals (the fleet loop in section 2
    // handles lease/maint for the overall P&L to avoid double-counting).
    const acType           = getAircraftType(aircraft.typeId);
    const { maintenanceCostMultiplier } = laborEffects(labor);
    const weeklyLeaseCost  = aircraft.ownershipType === 'owned' ? 0
      : (aircraft.weeklyLease ?? acType?.weeklyLease ?? 0);
    const weeklyMaintCost  = Math.round(
      (acType?.baseMaintenancePerWk ?? 0)
      * maintenanceMultiplier(aircraft.ageWeeks ?? 0)
      * maintenanceBudget
      * maintenanceCostMultiplier
      * (aircraft.maintMod ?? 1.0)
    );

    routeResults.push({
      routeId: route.id,
      ...result,
      revenue:          routeRevenue,
      marketingLift:    Math.round(result.revenue * marketingLift),
      loyaltyLift:      Math.round(result.revenue * loyaltyLift),
      allianceLift:     Math.round(result.revenue * allianceLift),
      landingFee,
      profit:           Math.round(routeRevenue - result.totalOpCost - landingFee),
      weeklyLeaseCost,
      weeklyMaintCost,
      trueProfit:       Math.round(routeRevenue - result.totalOpCost - landingFee - weeklyLeaseCost - weeklyMaintCost),
      connecting,
    });
  }

  // 1b. Cargo route revenue + variable operating costs
  // Freighters run a parallel, simpler economics path: tonnes × yield, no cabins,
  // no catering, no connecting pax. Fixed costs (lease/maint/insurance/labor) are
  // handled for ALL fleet — including freighters — in the loops below, so here we
  // only add cargo's variable costs and revenue.
  let totalCargoRevenue = 0;
  let totalCargoTonnes  = 0;
  let totalCargoProfit  = 0;
  const cargoRouteResults = [];

  for (const route of cargoRoutes) {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    if (!aircraft || aircraft.status === 'grounded') continue;

    const result = simulateCargoRoute(route, aircraft, gameDate, labor, fuelMultiplier, awarenessMultiplier);
    if (!result) continue;

    const type     = getAircraftType(aircraft.typeId);
    const originAp = getAirport(route.origin);
    const destAp   = getAirport(route.destination);
    const landingFee = weeklyLandingFee(
      freighterLandingCategory(type?.payloadTonnes ?? 0),
      route.weeklyFrequency,
      originAp?.tier ?? 'major',
      destAp?.tier   ?? 'major',
    );

    totalRevenue        += result.revenue;
    totalFuel           += result.fuelCost;
    totalCrew           += result.crewCost;
    totalGroundHandling += result.groundHandlingCost;
    totalLandingFees    += landingFee;

    totalCargoRevenue += result.revenue;
    totalCargoTonnes  += result.tonnes;
    const cargoProfit  = result.revenue - result.totalOpCost - landingFee;
    totalCargoProfit  += cargoProfit;

    // Per-aircraft fixed costs surfaced for the UI's "true profit" (not added to totals
    // here — the fleet loop handles lease/maint for the overall P&L).
    const { maintenanceCostMultiplier } = laborEffects(labor);
    const weeklyLeaseCost = aircraft.ownershipType === 'owned' ? 0
      : (aircraft.weeklyLease ?? type?.weeklyLease ?? 0);
    const weeklyMaintCost = Math.round(
      (type?.baseMaintenancePerWk ?? 0)
      * maintenanceMultiplier(aircraft.ageWeeks ?? 0)
      * maintenanceBudget
      * maintenanceCostMultiplier
      * (aircraft.maintMod ?? 1.0)
    );

    cargoRouteResults.push({
      routeId: route.id,
      ...result,
      landingFee,
      profit:     cargoProfit,
      weeklyLeaseCost,
      weeklyMaintCost,
      trueProfit: cargoProfit - weeklyLeaseCost - weeklyMaintCost,
    });
  }

  // 2. Fleet fixed costs (lease + maintenance)
  let totalLeases      = 0;
  let totalMaintenance = 0;
  const fleetCosts     = [];

  for (const aircraft of fleet) {
    const type = getAircraftType(aircraft.typeId);
    if (!type) continue;
    const maintMult         = maintenanceMultiplier(aircraft.ageWeeks ?? 0);
    const { maintenanceCostMultiplier } = laborEffects(labor);
    const maint             = Math.round(
      type.baseMaintenancePerWk * maintMult * maintenanceBudget * maintenanceCostMultiplier * (aircraft.maintMod ?? 1.0)
    );
    // Owned aircraft carry no lease — only maintenance applies.
    // Use the per-aircraft weeklyLease stored at delivery time (may differ from type default
    // due to engine options / wingtips chosen at order time); fall back to type default.
    const leaseThisWk = aircraft.ownershipType === 'owned' ? 0
      : (aircraft.weeklyLease ?? type.weeklyLease);
    totalLeases      += leaseThisWk;
    totalMaintenance += maint;
    fleetCosts.push({ aircraftId: aircraft.id, lease: leaseThisWk, maintenance: maint });
  }

  // 3. Labor overhead (fixed per aircraft, scaled by pay multiplier for each group)
  let totalLaborCosts = 0;
  if (labor && fleet.length > 0) {
    for (const group of LABOR_GROUPS) {
      const payMult = labor[group.id]?.payMultiplier ?? 1.0;
      totalLaborCosts += Math.round(group.baseWeeklyPerAircraft * payMult * fleet.length);
    }
  }

  // 4. Gate rental fees (monthly fee billed pro-rata as weekly)
  let totalGateFees = 0;
  for (const [code, count] of Object.entries(gates)) {
    if (!count) continue;
    const ap = getAirport(code);
    if (!ap) continue;
    totalGateFees += Math.round(totalGateMonthlyFee(ap, count) / 4);
  }

  // 5. Fleet family MRO base costs (one fixed fee per active aircraft family, regardless of fleet size)
  const totalFamilyBaseCosts = fleet.length > 0 ? weeklyFamilyBaseCost(fleet) : 0;

  // 6. Hub investment costs — higher tiers require ongoing weekly spend
  let totalHubInvestment = 0;
  for (const [, hubData] of Object.entries(hubs)) {
    const tierDef = HUB_TIERS[hubData.tier] ?? HUB_TIERS[1];
    totalHubInvestment += tierDef.weeklyInvestment;
  }

  // 7. HQ & corporate overhead — scales with fleet size
  const totalHQCost = calcHQCost(fleet.length);

  // 8. Insurance — hull (owned aircraft) + liability (all aircraft)
  let totalInsurance = 0;
  for (const aircraft of fleet) {
    const type = getAircraftType(aircraft.typeId);
    totalInsurance += weeklyInsuranceCost(aircraft, type);
  }

  // 9. Marketing spend — deducted as a cost; demand effect already in revenue above
  const totalMarketingSpend = marketingBudget > 0 ? Math.round(marketingBudget) : 0;

  // 10. Loyalty program costs:
  //   - Weekly investment (technology, partnerships, admin)
  //   - Points redemption / award seat cost: up to 3.5% of revenue at full membership.
  //   Real programs run 2–4% of revenue; 3.5% cap is realistic for a large mature program.
  const loyaltyInvestment = loyalty?.weeklyInvestment ?? 0;
  // Redemption cost scales with penetration AND how generous the current tier is.
  // A program kept alive with members but zero budget still honours outstanding
  // points, so fall back to a baseline generosity when members remain.
  const loyaltyGenerosity = loyaltyTier(loyaltyInvestment).generosity
    || (loyaltyMembers > 0 ? 0.85 : 0);
  const loyaltyPointsCost = loyaltyMembers > 0
    ? Math.round(totalRevenue * loyaltyPointsCostPct(loyaltyPenet, loyaltyGenerosity))
    : 0;
  const totalLoyaltyCost  = loyaltyInvestment + loyaltyPointsCost;

  // 11. Alliance & codeshare partnerships
  // O&D-based partner revenue (replaces the old flat per-adjacent-route model).
  // Computed by network.js: for each mixed-leg connection (player leg + partner leg),
  // the player earns a mileage-prorated share of the itinerary fare.
  const totalAllianceRevenue  = 0;   // now folded into partnerODRevenue
  const totalCodeshareRevenue = partnerODRevenue.totalRevenue;
  const totalPartnerRevenue   = partnerODRevenue.totalRevenue;

  const totalAllianceFee   = allianceMembership ? (allianceDef?.weeklyFee ?? 0) : 0;
  const totalCodeshareFees = codeshareAgreements.reduce((s, a) => s + (a.weeklyFee ?? 0), 0);
  const totalPartnerFees   = totalAllianceFee + totalCodeshareFees;

  // Distribution: GDS fees, OTA commissions, credit-card processing (~2.5% of revenue)
  const totalDistributionCost = Math.round((totalRevenue + totalPartnerRevenue) * DISTRIBUTION_COST_PCT);

  const totalOpCost = totalFuel + totalCrew + totalQuality + totalCatering + totalGroundHandling + totalLounge + totalLayover + totalCompensation + totalLandingFees;
  const totalCost   = totalLeases + totalMaintenance + totalOpCost + totalGateFees
    + totalLaborCosts + totalFamilyBaseCosts + totalHubInvestment
    + totalHQCost + totalInsurance + totalMarketingSpend + totalLoyaltyCost + totalPartnerFees
    + totalDistributionCost;
  const cashDelta   = totalRevenue + totalPartnerRevenue - totalCost;

  return {
    cashDelta:              Math.round(cashDelta),
    totalRevenue:           Math.round(totalRevenue + totalPartnerRevenue),
    totalConnecting:        Math.round(totalConnecting),
    totalLeases:            Math.round(totalLeases),
    totalMaintenance:       Math.round(totalMaintenance),
    totalFuel:              Math.round(totalFuel),
    totalCrew:              Math.round(totalCrew),
    totalQuality:           Math.round(totalQuality),
    totalLandingFees:       Math.round(totalLandingFees),
    totalCatering:          Math.round(totalCatering),
    totalCateringRevenue:   Math.round(totalCateringRevenue),
    totalGroundHandling:    Math.round(totalGroundHandling),
    totalLounge:            Math.round(totalLounge),
    totalDistributionCost:  Math.round(totalDistributionCost),
    totalLayover:           Math.round(totalLayover),
    totalCompensation:      Math.round(totalCompensation),
    totalGateFees:          Math.round(totalGateFees),
    totalLaborCosts:        Math.round(totalLaborCosts),
    totalFamilyBaseCosts:   Math.round(totalFamilyBaseCosts),
    totalHubInvestment:     Math.round(totalHubInvestment),
    totalHQCost:            Math.round(totalHQCost),
    totalInsurance:         Math.round(totalInsurance),
    totalMarketingSpend:    Math.round(totalMarketingSpend),
    totalLoyaltyCost:       Math.round(totalLoyaltyCost),
    totalAllianceRevenue:   Math.round(totalAllianceRevenue),
    totalCodeshareRevenue:  Math.round(totalCodeshareRevenue),
    totalPartnerRevenue:    Math.round(totalPartnerRevenue),
    totalAllianceFee:       Math.round(totalAllianceFee),
    totalCodeshareFees:     Math.round(totalCodeshareFees),
    totalPartnerFees:       Math.round(totalPartnerFees),
    // Network / O&D data for the UI and GameContext
    partnerODRevenue,        // { totalRevenue, entries[] } — detailed O&D breakdown
    partnerHealthDecay,      // { [competitorId]: hpLost } — for partnership state updates
    networkConnections:      networkTick.connections, // full Connection[] for debugging/UI
    loyaltyMultiplier,
    awarenessMultiplier,
    totalPassengers,
    mktMultiplier,
    totalOpCost:            Math.round(totalOpCost),
    totalCost:              Math.round(totalCost),
    routeResults,
    fleetCosts,
    // Cargo
    cargoRouteResults,
    totalCargoRevenue:      Math.round(totalCargoRevenue),
    totalCargoTonnes:       Math.round(totalCargoTonnes),
    totalCargoProfit:       Math.round(totalCargoProfit),
  };
}

// ─────────────────────────────────────────────
// FORMATTING HELPERS
// ─────────────────────────────────────────────

export function formatMoney(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

export function formatPercent(n) {
  return `${(n * 100).toFixed(1)}%`;
}
