import { getAirport, gateMonthlyFee, totalGateMonthlyFee, GATE_SURCHARGE_MULT } from '../data/airports.js';
import { getAircraftType, fuelCostPerKm } from '../data/aircraft.js';
import { isOutOfService, effectiveMaintAgeWeeks } from '../data/maintenance.js';
import {
  resolveBaseFor, mroFactorsFor, familyContractOffsets, totalBaseWeeklyCost,
  contractOffsetSavings, isBaseOpen, RESERVE_AT_BASE_READINESS_DISCOUNT,
} from '../data/mroBase.js';
import { RESERVE_READINESS_MULT, RESERVE_NO_DISPATCH_IF_CHECK_WITHIN_WEEKS, reserveParkingFee, isReserve } from '../data/reserve.js';
export { baseCityPairDemand } from './market.js';
import { cargoCityPairDemand, cargoReferenceYield, referencePrice,
         cargoBackhaulFactor, cargoSeasonalFactor,
         nwrDemandScale, weeklyLoadJitter, NWR_LF_CEILING,
         setNwrYieldChoke, metroPairKeyOf, memberPairKeysOf } from './market.js';
import { LABOR_GROUPS, fleetCrewScale, laborEffects, seniorityMultiplier } from '../data/labor.js';
import { weeklyFamilyBaseCost, activeFamilies, FAMILY_INFO,
         fleetComplexityMultiplier, COMPLEXITY_AFFECTED_GROUPS } from '../data/families.js';
import {
  calcHQCost,
  fleetHQScale,
  hqDepartureFee,
  hqBaseWeekly,
  weeklyInsuranceCost,
  weeklyLandingFee,
  awarenessDemandMultiplier,
  campaignDemandBoostPct,
  competitorPressureDrag,
  weeklyLayoverCost,
  weeklyPassengerCompensation,
  weeklyGroundHandlingCost,
  weeklyLoungeCost,
  DISTRIBUTION_COST_PCT,
} from '../data/overhead.js';
import { routeCatering, cateringQualityBonus, normalizeCateringLevel } from '../data/catering.js';
import { routeAncillaries, ancillaryQualityBonus } from '../data/ancillaries.js';
import {
  isWifiEquipped, wifiCoverageFor, groupWifiCoverage, fleetWifiCoverage, fleetWifiWeeklyCost,
} from '../data/wifi.js';
import {
  isLoungeOpen, totalLoungeWeeklyOpex, routeLoungeAppeal, loungeContractFactor,
  loungeEndpointCoverage, loungeGuestEconomics,
} from '../data/lounges.js';
import {
  buildRouteMarket,
  computeMarketShare,
  computeQualityScore,
  cabinQualityPoints,
  buildCompetitorOffer,
  routeMaturityFactor,
  computeConnectivityBonus,
  connectivityBonusForSpokes,
  CONNECTIVITY_LEGACY_SPOKES,
  directionalSeasonalSkew,
  directionalLoadMultiplier,
  COMPETITOR_AIRLINES,
  computeConnectingDemand,
  HUB_TIERS,
  PRICE_CAP_MULTIPLE,
} from '../models/demand.js';
import {
  ALLIANCES,
  getAlliance,
  allianceMembers,
  partnerInterlineRevenue,
} from '../data/alliances.js';
import { runNetworkTick } from '../models/network.js';
import { competitorMarketingSpend } from '../models/competitorAI.js';
import { calcReputation, reputationDemandMultiplier, reputationElasticityReduction } from '../models/reputation.js';
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
 *
 * Re-exported from market.js — single source of truth shared with competitor
 * economics. (Previously this file carried its own ×1.1-boosted copy while
 * competitors used the ×0.95 market.js version, giving the player a hidden
 * ~15% fare advantage.)
 */
export { referencePrice };

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

/** Ordered airport codes a route visits. Falls back to [origin, destination].
 *
 * A stray/degenerate `stops` array (e.g. [SFO, SFO, LAX], or an interior stop
 * that merely repeats an endpoint) is collapsed to the route's real waypoints.
 * A route whose waypoints reduce to just its two endpoints is a DIRECT flight —
 * so it groups into the shared per-O&D demand pool and prices like the nonstop
 * it is, instead of being mis-read as a phantom multi-stop route and pulled out
 * of the pool (which made two identical nonstops on one pair diverge wildly). */
export function routeStops(route) {
  const raw = (route && Array.isArray(route.stops) && route.stops.length >= 2)
    ? route.stops
    : [route?.origin, route?.destination];
  // Drop empties and consecutive duplicates.
  const cleaned = [];
  for (const code of raw) {
    if (!code) continue;
    if (cleaned.length && cleaned[cleaned.length - 1] === code) continue;
    cleaned.push(code);
  }
  // Drop interior stops that merely repeat the origin or destination endpoint —
  // they add no real leg. Genuine distinct intermediates are preserved.
  if (cleaned.length > 2) {
    const o = cleaned[0], d = cleaned[cleaned.length - 1];
    const interior = cleaned.slice(1, -1).filter(c => c !== o && c !== d);
    return [o, ...interior, d];
  }
  return cleaned.length >= 2 ? cleaned : [route?.origin, route?.destination];
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

// Extra weekly operating cost per route from quality settings.
// Demand-side effects come from SEAT/SERVICE_QUALITY_POINTS in demand.js
// (via cabinQualityPoints → computeQualityScore). `basic` SAVES money —
// slimline seats and a stripped soft product are the LCC tradeoff: cheaper
// to run, but they cost quality points.
// Ongoing weekly operating cost per route from seat quality. `basic` economy is
// now the FREE floor; anything above it carries a rising weekly charge.
export const SEAT_QUALITY_COST_PER_ROUTE = {
  basic:    0,
  standard: 400,
  premium:  900,
  luxury:   2_400,
};
// One-off fitting fee (per aircraft) to install seats above basic economy —
// charged at order time and, incrementally, when upgrading an existing cabin.
export const SEAT_QUALITY_FITTING_FEE = {
  basic:    0,
  standard: 30_000,
  premium:  80_000,
  luxury:   180_000,
};
// One-off install fee per premium seat (charged at order + when a reconfigure ADDS
// premium seats). Economy seats are free; premium cabins cost more to fit out.
export const CABIN_INSTALL_FEE_PER_SEAT = {
  premiumEconomy: 200,
  businessClass:  500,
  firstClass:     1_000,
};
/** Total one-off install fee for the premium seats in a cabin config (absolute). */
export function cabinInstallFee(config) {
  return (config?.firstClass     ?? 0) * CABIN_INSTALL_FEE_PER_SEAT.firstClass
       + (config?.businessClass  ?? 0) * CABIN_INSTALL_FEE_PER_SEAT.businessClass
       + (config?.premiumEconomy ?? 0) * CABIN_INSTALL_FEE_PER_SEAT.premiumEconomy;
}

// ─── Cabin refit: cost + downtime ────────────────────────────────────────────
// ONE definition of what a reconfigure costs and how long it grounds the tail.
// This used to live in src/components/FleetConfig.jsx with a hand-kept copy in
// the multiplayer decision guard; the reducer had neither and so could not
// charge for a partial batch or ground anything. Every caller — the modal, the
// guard, the reducer — reads these two functions now.
export const REFIT_SEAT_COST      = 2_500;   // per seat moved between classes
export const REFIT_MIN_COST       = 10_000;  // any refit at all costs at least this
// A refit is real shop work: the tail comes out of service while the cabin is
// stripped and refitted. Wide-bodies and up take a second week; a change that
// moves a quarter of the airframe's seats takes one more on top.
export const REFIT_BASE_WEEKS     = { 'Turboprop': 1, 'Regional Jet': 1, 'Narrow Body': 1, 'Wide Body': 2, 'Double Deck': 2, 'Supersonic': 2 };
export const REFIT_MAJOR_FRACTION = 0.25;    // seats moved / airframe seats
export const REFIT_MAX_WEEKS      = 4;

/**
 * Seats moved between classes by a reconfigure. Economy is the residual — it
 * absorbs whatever the premium cabins give up — so counting the three premium
 * classes counts every seat that physically moves, without double-counting.
 */
export function refitSeatsMoved(current, next) {
  return Math.abs((next?.firstClass     ?? 0) - (current?.firstClass     ?? 0))
       + Math.abs((next?.businessClass  ?? 0) - (current?.businessClass  ?? 0))
       + Math.abs((next?.premiumEconomy ?? 0) - (current?.premiumEconomy ?? 0));
}

/**
 * One-time cost to reconfigure a cabin: per seat moved, plus a one-off install
 * fee for premium seats ADDED (removals are free), plus the incremental fitting
 * fee for a seat-quality UPGRADE (downgrades are free). Returns 0 for a no-op.
 */
export function calcReconfCost(current, next) {
  const seatChanges = refitSeatsMoved(current, next);

  const fitUpgrade = Math.max(
    0,
    (SEAT_QUALITY_FITTING_FEE[next?.seatQuality    ?? 'basic'] ?? 0) -
    (SEAT_QUALITY_FITTING_FEE[current?.seatQuality ?? 'basic'] ?? 0)
  );

  const premInstall =
    Math.max(0, (next?.firstClass     ?? 0) - (current?.firstClass     ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.firstClass +
    Math.max(0, (next?.businessClass  ?? 0) - (current?.businessClass  ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.businessClass +
    Math.max(0, (next?.premiumEconomy ?? 0) - (current?.premiumEconomy ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.premiumEconomy;

  if (seatChanges === 0 && fitUpgrade === 0 && premInstall === 0) return 0;

  return Math.max(REFIT_MIN_COST, seatChanges * REFIT_SEAT_COST + premInstall + fitUpgrade);
}

/**
 * Weeks out of service for a reconfigure. 0 when nothing chargeable changes —
 * a no-op refit must not ground a flying aircraft. `typeOrCategory` accepts an
 * aircraft TYPE object (preferred) or a bare category string.
 *
 * Freighters have no passenger cabin to refit, so they never ground here: their
 * config carries no premium seats and no quality tier, leaving cost at 0.
 */
export function refitWeeks(typeOrCategory, current, next) {
  if (calcReconfCost(current, next) === 0) return 0;
  const type     = typeof typeOrCategory === 'object' ? typeOrCategory : null;
  const category = type ? type.category : typeOrCategory;
  let weeks = REFIT_BASE_WEEKS[category] ?? 1;
  const seats = type?.seats ?? 0;
  if (seats > 0 && refitSeatsMoved(current, next) >= seats * REFIT_MAJOR_FRACTION) weeks += 1;
  return Math.min(REFIT_MAX_WEEKS, weeks);
}

export const SERVICE_QUALITY_COST_PER_ROUTE = {
  basic:    -800,
  standard: 0,
  premium:  1_000,
  luxury:   3_500,
};

// ─────────────────────────────────────────────
// PASSENGER SATISFACTION (earned customer rating)
// ─────────────────────────────────────────────
// Satisfaction is a persistent 0–100 stat that tracks the experience the
// airline ACTUALLY delivered, with inertia — a reputation you build and can
// squander. Each week it moves SATISFACTION_ADAPT_RATE of the way toward the
// delivered experience; customerRating in the quality score derives from it
// (see laborEffects). Old saves start at null and initialize to their first
// week's delivered experience.

/** Weekly convergence rate toward delivered experience (like morale, ~15%/wk). */
export const SATISFACTION_ADAPT_RATE = 0.15;

/**
 * The three lounge fields a route needs, resolved from STATE.
 *
 * THE single implementation. weeklyTick calls it, pairShare's projection calls
 * it, and every screen that hand-builds a route object for simulateRoute or
 * simulateTagRoute calls it — because a route object without these is scored at
 * the parity default (appeal 1, coverage 1, contract factor 1), which means a
 * lounge owner is quoted nearly three times the premium ground cost the tick
 * actually charges, and an airline with no lounges is shown day-pass revenue the
 * tick refuses to book. That preview/tick divergence is the single most
 * repeated bug in this engine; there is one function so there is one answer.
 *
 * Spread it into the route: `{ ...route, ...stateLoungeFields(state, o, d) }`.
 */
export function stateLoungeFields(state, origin, destination) {
  const lounges = state?.lounges ?? {};
  const alliance = state?.allianceMembership
    ? getAlliance(state.allianceMembership.allianceId) : null;
  return {
    loungeAppeal: routeLoungeAppeal({
      lounges, policy: state?.loungePolicy ?? null, origin, destination, alliance,
    }),
    loungeCoverage:       loungeEndpointCoverage(lounges, origin, destination),
    loungeContractFactor: loungeContractFactor(lounges, origin, destination),
  };
}

/**
 * The experience delivered this week, 0–100. Inputs are what passengers
 * actually encountered: punctuality, crew service, the cabin product +
 * catering, and fleet age. Deliberately EXCLUDES customerRating itself so the
 * satisfaction loop has no feedback term.
 */
export function deliveredExperience({ fleet = [], routes = [], labor = null, ancillaries = null, lounges = null }, avgUtilization = null) {
  const { onTimeRate } = laborEffects(labor, avgUtilization);
  const assigned = fleet.filter(a => routes.some(r => r.aircraftId === a.id));
  const avgCabinPts = assigned.length > 0
    ? assigned.reduce((s, a) => s + cabinQualityPoints(a.config), 0) / assigned.length
    : 0;
  // Spacious cabins build lasting goodwill too: average space bonus (empty
  // floor → extra room per passenger) across assigned aircraft.
  const avgSpacePts = assigned.length > 0
    ? assigned.reduce((s, a) => {
        const type = getAircraftType(a.typeId);
        return s + (type ? configSpaceQualityBonus(a.config ?? defaultConfig(type.seats), type) : 0);
      }, 0) / assigned.length
    : 0;
  const avgAgeYears = assigned.length > 0
    ? assigned.reduce((s, a) => s + (a.ageWeeks ?? 0) / 52, 0) / assigned.length
    : 0;
  const avgCatering = routes.length > 0
    ? routes.reduce((s, r) => s + cateringQualityBonus(
        normalizeCateringLevel(r.cateringLevel),
        routeDistanceKm(r.origin, r.destination)), 0) / routes.length
    : 0;
  const cabinMorale = labor?.cabinCrew?.morale ?? 80;
  // Airline-wide ancillary generosity lifts (or dents) the delivered experience.
  //
  // Provisioned amenities are scored on what the airline can actually DELIVER,
  // network-wide, not on what the policy screen claims. Wi-Fi coverage is
  // weighted by SEATS rather than airframes, because the question here is what
  // fraction of passengers found it on board — a fitted widebody carries far
  // more of them than a fitted turboprop. Lounge coverage is the share of routes
  // with at least one lounged endpoint, which is the same question asked of the
  // ground product. Both default to full when the caller supplies nothing, so
  // every existing call site is scored exactly as before.
  const ancQ = ancillaryQualityBonus(ancillaries, 0, {
    wifi:   fleetWifiCoverage(fleet, a => getAircraftType(a.typeId)?.seats ?? 0),
    lounge: lounges
      ? (routes.length > 0
          ? routes.reduce((n, r) => n + loungeEndpointCoverage(lounges, r.origin, r.destination), 0) / routes.length
          : 0)
      : 1,
  });

  const otpPts   = onTimeRate * 40;                                            // 0–40
  const crewPts  = (cabinMorale / 100) * 22;                                   // 0–22
  const cabinPts = Math.max(0, Math.min(24, 12 + (avgCabinPts + avgCatering + avgSpacePts + ancQ) * 0.55)); // 0–24
  const agePts   = Math.max(0, 14 - avgAgeYears * 1.1);                        // 0–14
  return Math.max(0, Math.min(100, Math.round(otpPts + crewPts + cabinPts + agePts)));
}

/** EWMA step: null/NaN current (new game or old save) snaps to delivered. */
export function nextSatisfaction(current, delivered) {
  if (current == null || Number.isNaN(current)) return delivered;
  return Math.round((current + SATISFACTION_ADAPT_RATE * (delivered - current)) * 10) / 10;
}

/**
 * Per-source quality point breakdown for one player route — the same inputs
 * and stacking order simulateRoute/simulateTagRoute use, exposed for the UI so
 * players can see where their quality score comes from. Returns null if the
 * aircraft type is unknown.
 */
export function routeQualityBreakdown(route, aircraft, state) {
  const type = aircraft ? getAircraftType(aircraft.typeId) : null;
  if (!type) return null;
  const config = aircraft.config ?? defaultConfig(type.seats);
  const r      = hydrateRoute(route, state.routePricing ?? {}, state.routeCatering ?? {});

  const avgUtilization = fleetAvgUtilization(state.fleet ?? [],
    [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
  const satisfaction = state.satisfaction ?? null;
  const { onTimeRate, customerRating, groundQualityBonus } =
    laborEffects(state.labor ?? null, avgUtilization, satisfaction);

  const fleetAgeYears = (aircraft.ageWeeks ?? 0) / 52;
  const onTimePts   = onTimeRate * 30;
  const cabinPts    = cabinQualityPoints(config);
  const agePts      = Math.max(0, 20 - fleetAgeYears * 1.5);
  const ratingPts   = (customerRating / 5) * 28;
  const spacePts    = configSpaceQualityBonus(config, type);
  const dist        = isMultiStop(r) ? routeMaxLegKm(r) : routeDistanceKm(r.origin, r.destination);
  const cateringPts = cateringQualityBonus(normalizeCateringLevel(r.cateringLevel), dist);
  // Same two capability gates the tick applies, so this breakdown cannot claim
  // quality points for a Wi-Fi kit that isn't fitted or a lounge that isn't
  // built. A preview that disagrees with weeklyTick is a bug in one of them.
  const lounges     = state.lounges ?? {};
  const ancCoverage = {
    wifi:   wifiCoverageFor(aircraft),
    lounge: loungeEndpointCoverage(lounges, r.origin, r.destination),
  };
  const ancillaryPts = ancillaryQualityBonus(state.ancillaries ?? null, 0, ancCoverage);
  // Not a quality term — lounges move the BUSINESS segment of the demand model
  // directly rather than the route's quality score. Surfaced here so the route
  // detail screen can explain a business share the quality ladder doesn't.
  const loungeAppeal = routeLoungeAppeal({
    lounges,
    policy:      state.loungePolicy ?? null,
    origin:      r.origin,
    destination: r.destination,
    alliance:    state.allianceMembership ? getAlliance(state.allianceMembership.allianceId) : null,
  });

  // Hub investment bonus: best player hub touching the route (all stops for tag routes)
  const hubs = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const stops = isMultiStop(r) ? routeStops(r) : [r.origin, r.destination];
  const hubPts = Math.max(0, ...stops.map(c => {
    const t = hubs[c]?.tier;   // tier 0 (Focus City) is valid — check != null
    return t != null ? (HUB_TIERS[t]?.qualityBonus ?? 0) : 0;
  }));

  const raw   = computeQualityScore({ onTimeRate, cabinPoints: cabinPts, fleetAgeYears, customerRating });
  const total = Math.max(0, Math.min(100, raw + groundQualityBonus + spacePts + cateringPts + ancillaryPts + hubPts));

  return {
    onTimePts, cabinPts, agePts, ratingPts,
    groundPts: groundQualityBonus, spacePts, cateringPts, ancillaryPts, hubPts,
    raw, total,
    onTimeRate, customerRating, satisfaction, avgUtilization,
    // Capability context for the UI: which of the provisioned amenities this
    // route can actually deliver, and what the lounge network is worth to the
    // business segment on it.
    wifiEquipped: isWifiEquipped(aircraft),
    loungeCoverage: ancCoverage.lounge,
    loungeAppeal,
  };
}

// ─────────────────────────────────────────────
// AIRCRAFT UTILIZATION & GATE LIMITS
// ─────────────────────────────────────────────

/** Hard cap: an aircraft cannot fly more than this many block-hours per week. */
export const MAX_WEEKLY_BLOCK_HOURS = 140;

// New World Restrictions worlds cap scheduling at 100h/wk instead — 14.3h/day
// against the classic cap's 20h/day, which no real airline sustains (a hard-run
// 737 does ~9-11h). GRANDFATHERED: the cap is only ever enforced at action time
// (ADD_ROUTE / frequency INCREASES / swaps), never by the weekly tick, so an
// aircraft already scheduled above it keeps flying every route it has. It just
// can't add more, and its frequency changes are a one-way ratchet down — the
// same never-retro-cancel policy as the lease order book. planCovers and
// fleetAvgUtilization deliberately stay on the physical 140h: reserve covers
// must be able to replicate a grandfathered schedule, and crew-morale pressure
// is about hours actually flown, not the local legal ceiling.
export const NWR_MAX_WEEKLY_BLOCK_HOURS = 100;

/** The scheduling cap in force for this airline's world. */
export function maxWeeklyBlockHoursFor(state) {
  return state?.newWorldRestrictions ? NWR_MAX_WEEKLY_BLOCK_HOURS : MAX_WEEKLY_BLOCK_HOURS;
}

/**
 * Minimum weekly block-hours left before an airframe is worth calling "spare".
 * A plane with 1-2 hours free can't actually absorb another sector, so counting
 * it as available made the fleet look more deployable than it is. Anything at
 * or below this is treated as fully utilised for display and for the "aircraft
 * with spare hours" counters.
 */
export const MIN_SPARE_BLOCK_HOURS = 5;

/** Slot capacity of a single gate per week (departures from that airport). */
export const SLOTS_PER_GATE = 50;

/**
 * Weekly slots consumed at `code` by cargo routes. Freighters use gates and
 * slots exactly like passenger flights, so this is summed alongside passenger
 * slot usage wherever capacity is displayed or enforced. Cargo routes have no
 * seasonal dormancy, so every freight route counts year-round.
 */
export function cargoSlotsUsedAt(code, cargoRoutes = []) {
  return (cargoRoutes ?? [])
    .filter(r => r.origin === code || r.destination === code)
    .reduce((s, r) => s + (r.weeklyFrequency ?? 0), 0);
}

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

// Freighters all share one category, so they can be stepped by neither the speed
// nor the turnaround table above — a 9-tonne ATR and a 250-tonne An-225 would
// otherwise both take the generic fallback. Turnaround steps by payload (loading
// and unloading main-deck ULDs is what takes the time); speed comes from each
// type's own `cruiseKmh` field.
const FREIGHTER_TURNAROUND_HOURS = [
  { maxTonnes:  20, hours: 0.75 },
  { maxTonnes:  50, hours: 1.00 },
  { maxTonnes: 130, hours: 1.50 },
  { maxTonnes: Infinity, hours: 1.75 },
];

/** Cruise speed (km/h) for a type: explicit override, else its category. */
export function cruiseSpeedKmh(type) {
  return type?.cruiseKmh ?? CRUISE_SPEED_KMH[type?.category] ?? 840;
}

/** Ground turnaround (hours) for a type: payload-stepped for freighters, else category. */
export function turnaroundHours(type) {
  if (type?.freighter) {
    const t = type.payloadTonnes ?? 0;
    return FREIGHTER_TURNAROUND_HOURS.find(b => t <= b.maxTonnes).hours;
  }
  return TURNAROUND_HOURS[type?.category] ?? 0.75;
}

/**
 * Block time for one sector (hours).
 * = flight time in the air + turnaround on the ground.
 *
 * @param {number} distKm
 * @param {object} type  - aircraft type from AIRCRAFT_TYPES
 */
export function blockTimeHours(distKm, type) {
  return distKm / cruiseSpeedKmh(type) + turnaroundHours(type);
}

/**
 * Total weekly block-hours consumed by an aircraft on a route (both directions).
 * Must be ≤ MAX_WEEKLY_BLOCK_HOURS.
 */
export function weeklyBlockHours(distKm, weeklyFrequency, type) {
  return blockTimeHours(distKm, type) * weeklyFrequency * 2;
}

/**
 * Maximum weekly frequency that keeps block-hours within the cap.
 * Pass maxWeeklyBlockHoursFor(state) as capHours in restricted worlds.
 */
export function maxFrequency(distKm, type, capHours = MAX_WEEKLY_BLOCK_HOURS) {
  const bt = blockTimeHours(distKm, type);
  return bt > 0 ? Math.floor(capHours / (bt * 2)) : 0;
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
 * Average fleet block-hour utilization (0–1): each active (non-grounded)
 * aircraft's assigned weekly block hours as a fraction of MAX_WEEKLY_BLOCK_HOURS,
 * averaged across the fleet. Idle aircraft count as 0 — spare airframes act as
 * an operational buffer that protects on-time performance (see
 * utilizationOnTimePenalty in data/labor.js).
 */
export function fleetAvgUtilization(fleet = [], routes = []) {
  const byAircraft = new Map();
  for (const r of routes) {
    if (!r?.aircraftId) continue;
    if (!byAircraft.has(r.aircraftId)) byAircraft.set(r.aircraftId, []);
    byAircraft.get(r.aircraftId).push(r);
  }
  let sum = 0, n = 0;
  for (const a of fleet) {
    if (isOutOfService(a)) continue;
    const type = getAircraftType(a.typeId);
    if (!type) continue;
    const rs  = byAircraft.get(a.id) ?? [];
    const hrs = rs.reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0);
    sum += Math.max(0, Math.min(1, hrs / MAX_WEEKLY_BLOCK_HOURS));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// ─────────────────────────────────────────────
// ONE SOURCE OF TRUTH FOR "WHAT IS THIS TAIL FLYING?"
// ─────────────────────────────────────────────
// Every screen that shows utilisation, and every guard that enforces the
// block-hour cap, must answer this question the same way the weekly tick does.
// They did not, and it produced a Fleet list showing eight airframes above the
// 140h cap (top one 278h, i.e. 199% of it):
//
//   · the tick charges hours for the routes that OPERATE THIS MONTH, leg by leg
//     (ADVANCE_WEEK's heavy-maintenance accrual), and nothing at all for an
//     aircraft that is out of service;
//   · the cap is enforced as a PER-MONTH PEAK, which is the whole reason a
//     summer route and a winter route can share one airframe;
//   · the Fleet list summed the WHOLE YEAR at the direct O&D distance and
//     compared that to a per-week cap — over-counting every dormant route and
//     under-counting every tag route's intermediate legs at the same time.
//
// It also has to count routes a reserve is temporarily covering. A covered
// route's aircraftId points at the RESERVE (coverForAircraftId remembers the
// original), so a tail with its network out on cover looked EMPTY to every
// guard: the route pickers offered it as a free airframe and the reducer took a
// second full 140h load, which came home the week the tail did.

/**
 * Every route a tail is on the hook for: the ones it flies now, plus the ones a
 * reserve is temporarily covering for it (those come home the week it returns).
 * Passenger and cargo networks together — one airframe, one schedule.
 */
export function routesCommittedTo(aircraftId, routes = [], cargoRoutes = []) {
  if (!aircraftId) return [];
  const all = cargoRoutes && cargoRoutes.length ? [...(routes ?? []), ...cargoRoutes] : (routes ?? []);
  return all.filter(r => r && (r.aircraftId === aircraftId || r.coverForAircraftId === aircraftId));
}

/**
 * Weekly block-hours this tail is committed to in each 1-indexed month.
 * Legs-aware (a tag flight costs every sector it flies) and season-aware
 * (a dormant month costs nothing).
 */
export function committedBlockHoursByMonth(aircraftId, type, routes = [], cargoRoutes = []) {
  const mine = routesCommittedTo(aircraftId, routes, cargoRoutes);
  if (!type || mine.length === 0) return ALL_MONTHS.map(() => 0);
  return ALL_MONTHS.map(m => mine
    .filter(r => isRouteActive(r, m))
    .reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0));
}

/**
 * The per-month PEAK weekly block-hours for a tail — the quantity
 * MAX_WEEKLY_BLOCK_HOURS actually governs. Use this, never an annual sum, in
 * any check of the form "would this fit?".
 */
export function committedPeakBlockHours(aircraftId, type, routes = [], cargoRoutes = []) {
  return committedPeakBlockHoursIn(aircraftId, type, routes, cargoRoutes, null);
}

/**
 * Peak weekly block-hours a tail is committed to across a GIVEN set of months.
 * Pass the months a proposed route would operate in; omit them (or pass an
 * empty list) for the year-round peak. Legs-aware, season-aware, cargo-aware,
 * and it sees routes a reserve is covering — the same reading the guards use.
 */
export function committedPeakBlockHoursIn(aircraftId, type, routes = [], cargoRoutes = [], months = null) {
  const byMonth = committedBlockHoursByMonth(aircraftId, type, routes, cargoRoutes);
  const ms = (Array.isArray(months) && months.length > 0) ? months : ALL_MONTHS;
  return Math.max(0, ...ms.map(m => byMonth[m - 1] ?? 0));
}

/**
 * "Would these extra flights fit on this tail?" — THE answer, for the guard and
 * for every screen that previews one.
 *
 * A preview that computes this itself is a bug waiting to be reported, and has
 * been three times now. The Add Flights form's utilisation bar summed
 * `routes.filter(r => r.aircraftId === id)` at the DIRECT O&D distance, so a
 * tag rotation cost it only its end-to-end hop and a rotation out on cover cost
 * it nothing at all: the bar read 136 / 140h and green, the picker on the same
 * screen read 11h free, and the submit came back "no spare flying hours — this
 * would need 151h/wk". Call this instead.
 *
 * @param {string}  aircraftId
 * @param {object}  type            its aircraft type
 * @param {array}   routes          state.routes
 * @param {array}   cargoRoutes     state.cargoRoutes
 * @param {array?}  months          1-indexed months the addition would operate
 *                                  in; omit for the year-round peak
 * @param {number}  hoursPerFlight  block hours ONE weekly flight costs, both
 *                                  directions and every leg — i.e.
 *                                  routeBlockHours(proto, type, 1), or
 *                                  blockTimeHours(dist, type) * 2 for one leg
 * @param {number}  weeklyFrequency the proposed frequency
 * @param {number}  capHours        maxWeeklyBlockHoursFor(state)
 *
 * @returns {{
 *   existingHours: number,   // committed in the busiest of `months`
 *   addedHours:    number,
 *   totalHours:    number,
 *   spareHours:    number,   // cap - existing, never negative
 *   capHours:      number,
 *   fits:          boolean,
 *   maxFrequency:  number    // most flights/wk that still fit (0 = none)
 * }}
 */
export function blockHourFit({
  aircraftId, type, routes = [], cargoRoutes = [], months = null,
  hoursPerFlight = 0, weeklyFrequency = 0, capHours = MAX_WEEKLY_BLOCK_HOURS,
  ignoreSeason = false,
} = {}) {
  const cap = capHours > 0 ? capHours : MAX_WEEKLY_BLOCK_HOURS;
  // ignoreSeason: charge EVERY committed route whether or not it operates in the
  // month in question — the conservative reading the multi-stop and freight
  // guards have always used, kept here so their previews can ask this function
  // and get back exactly what those guards will decide. The passenger route
  // guard uses the per-month peak instead (pass `months`), which is what lets a
  // summer route and a winter route share one airframe.
  const existingHours = ignoreSeason
    ? routesCommittedTo(aircraftId, routes, cargoRoutes)
        .reduce((s, r) => s + (type ? routeBlockHours(r, type, r.weeklyFrequency) : 0), 0)
    : committedPeakBlockHoursIn(aircraftId, type, routes, cargoRoutes, months);
  const addedHours = Math.max(0, hoursPerFlight) * Math.max(0, weeklyFrequency);
  const totalHours = existingHours + addedHours;
  const spareHours = Math.max(0, cap - existingHours);
  return {
    existingHours, addedHours, totalHours, spareHours, capHours: cap,
    fits: totalHours <= cap + 1e-9,
    maxFrequency: hoursPerFlight > 0 ? Math.floor((spareHours + 1e-9) / hoursPerFlight) : 0,
  };
}

/**
 * The single utilisation reading every screen must use.
 *
 * @param {object}  aircraft     the tail (object; an id is accepted but then
 *                               out-of-service can't be detected)
 * @param {object}  type         its aircraft type
 * @param {array}   routes       state.routes
 * @param {array}   cargoRoutes  state.cargoRoutes
 * @param {number?} month        1-indexed game month; omit for the peak month
 * @param {number}  capHours     maxWeeklyBlockHoursFor(state)
 *
 * @returns {{
 *   flyingHours:    number,  // what the tick charges THIS week (0 if out of service)
 *   scheduledHours: number,  // hours on the schedule in `month`, flying or not
 *   peakHours:      number,  // busiest month — the figure the cap governs
 *   peakMonth:      number,
 *   capHours:       number,
 *   pct:            number,  // flyingHours / capHours, UNCLAMPED (may exceed 1)
 *   peakPct:        number,
 *   overCap:        boolean, // the schedule breaches the cap in some month
 *   grounded:       boolean,
 *   seasonal:       boolean, // the schedule differs month to month
 *   routes:         array    // the committed routes, for counters/badges
 * }}
 */
export function aircraftUtilization({
  aircraft, type, routes = [], cargoRoutes = [], month = null,
  capHours = MAX_WEEKLY_BLOCK_HOURS,
} = {}) {
  const id = (aircraft && typeof aircraft === 'object') ? aircraft.id : aircraft;
  const t  = type ?? ((aircraft && typeof aircraft === 'object') ? getAircraftType(aircraft.typeId) : null);
  const committed = routesCommittedTo(id, routes, cargoRoutes);
  const byMonth   = committedBlockHoursByMonth(id, t, routes, cargoRoutes);

  let peakHours = 0, peakMonth = 1;
  byMonth.forEach((h, i) => { if (h > peakHours) { peakHours = h; peakMonth = i + 1; } });

  const scheduledHours = month != null ? (byMonth[month - 1] ?? 0) : peakHours;
  const grounded    = !!(aircraft && typeof aircraft === 'object' && isOutOfService(aircraft));
  const flyingHours = grounded ? 0 : scheduledHours;
  const cap = capHours > 0 ? capHours : MAX_WEEKLY_BLOCK_HOURS;

  return {
    flyingHours, scheduledHours, peakHours, peakMonth,
    capHours: cap,
    pct:      flyingHours / cap,
    peakPct:  peakHours / cap,
    overCap:  peakHours > cap + 1e-6,
    grounded,
    seasonal: byMonth.some(h => Math.abs(h - byMonth[0]) > 1e-6),
    routes:   committed,
  };
}

// ─────────────────────────────────────────────
// ONE-OFF MIGRATION: TRIM SCHEDULES THAT ARE ALREADY OVER THE PHYSICAL CAP
// ─────────────────────────────────────────────
// Companion to routesCommittedTo above. Closing the guards stopped NEW
// over-cap schedules; it did nothing for saves that already had one, and a
// player reported a Fleet list with eight airframes above 140h/wk, the worst at
// 278h. Those aeroplanes have been flying — and earning, and accruing wear —
// on hours that do not exist, which in a shared world is other players' money.
//
// WHICH CAP. Deliberately MAX_WEEKLY_BLOCK_HOURS, the PHYSICAL limit, and not
// maxWeeklyBlockHoursFor(state). New World Restrictions worlds cap SCHEDULING
// at 100h, and that lower ceiling is explicitly grandfathered (see the comment
// on NWR_MAX_WEEKLY_BLOCK_HOURS): an aircraft already scheduled above it keeps
// flying every route it has, and may only ratchet down. Trimming those tails to
// 100h would delete frequency the engine has always considered legal — a
// balance change to NWR worlds, not a repair. 140h is the only figure that is
// physically impossible, so 140h is what this migration enforces.
//
// WHAT IT DOES, in priority order:
//   1. TRIM, never delete. Frequency comes down on one route at a time until the
//      tail's PEAK MONTH fits — peak month, because that is the quantity the cap
//      governs (counter-seasonal routes sharing an airframe are legal and must
//      stay legal).
//   2. Cheapest schedule first: routes are cut in ascending revenue PER BLOCK
//      HOUR, so the airline sheds the most hours for the least money.
//   3. Closing a route is the LAST RESORT — only once every route active in the
//      peak month is already down to one weekly flight.
//   4. Nothing on a tail that is within the cap is touched, ever.

/** Save-schema version for the over-cap schedule trim. Bump to re-run. */
export const SCHEDULE_TRIM_VERSION = 1;

/** How many trim notices a save keeps (they are the player's durable receipt). */
export const SCHEDULE_TRIM_NOTICE_CAP = 50;

/**
 * Per-route weekly revenue for ranking cuts, and where it came from.
 *
 * Preference order:
 *   'lastReport'       — report.routeResults / report.cargoRouteResults, the most
 *                        recent week actually simulated. Covers cargo too.
 *   'financialHistory' — the prior week's routeRevenues map (passenger only).
 *   null               — no revenue anywhere (a save that has never ticked).
 *
 * A route with no entry scores 0, which sorts it first: an unflown route is the
 * cheapest thing on the airframe to give up.
 */
export function routeRevenueSource(state) {
  const revenues = {};
  const pax   = state?.lastReport?.routeResults;
  const cargo = state?.lastReport?.cargoRouteResults;
  let source = null;
  if (Array.isArray(pax) && pax.length > 0) {
    for (const r of pax) revenues[r.routeId] = Math.max(0, Number(r.revenue) || 0);
    source = 'lastReport';
  }
  if (Array.isArray(cargo) && cargo.length > 0) {
    for (const r of cargo) revenues[r.routeId] = Math.max(0, Number(r.revenue) || 0);
    source = 'lastReport';
  }
  if (!source) {
    const hist = state?.financialHistory?.[state.financialHistory.length - 1]?.routeRevenues;
    if (hist && Object.keys(hist).length > 0) {
      for (const [id, v] of Object.entries(hist)) revenues[id] = Math.max(0, Number(v) || 0);
      source = 'financialHistory';
    }
  }
  return { revenues, source };
}

/**
 * Compute the trim. PURE — takes a state, returns new route lists plus a notice
 * per affected aircraft. Does not decide whether the migration should run; see
 * applyScheduleTrimMigration for that.
 *
 * @returns {{ routes, cargoRoutes, fleet, notices, changed, revenueSource }}
 */
export function trimOverCapSchedules(state, { capHours = MAX_WEEKLY_BLOCK_HOURS } = {}) {
  const routes      = (state?.routes ?? []).map(r => ({ ...r }));
  const cargoRoutes = (state?.cargoRoutes ?? []).map(r => ({ ...r }));
  const cargoIds    = new Set(cargoRoutes.map(r => r.id));
  const { revenues, source } = routeRevenueSource(state);

  const committed = (id) => [...routes, ...cargoRoutes]
    .filter(r => r.aircraftId === id || r.coverForAircraftId === id);

  const peakInfo = (id, type) => {
    const mine = committed(id);
    let hours = 0, month = 1;
    for (const m of ALL_MONTHS) {
      const h = mine.filter(r => isRouteActive(r, m))
        .reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0);
      if (h > hours) { hours = h; month = m; }
    }
    return { hours, month };
  };

  const notices = [];
  // Deterministic order so server and client converge on the same result.
  const fleet = [...(state?.fleet ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const a of fleet) {
    const type = getAircraftType(a.typeId);
    if (!type) continue;
    let { hours: peak, month } = peakInfo(a.id, type);
    if (peak <= capHours + 1e-6) continue;

    const peakBefore = peak;
    const monthBefore = month;
    const cuts = new Map();   // routeId → { ..., fromFrequency, toFrequency, closed }
    const noteCut = (r, from, to, closed) => {
      const prev = cuts.get(r.id);
      cuts.set(r.id, {
        routeId:       r.id,
        origin:        r.origin,
        destination:   r.destination,
        cargo:         cargoIds.has(r.id),
        multiStop:     isMultiStop(r),
        fromFrequency: prev ? prev.fromFrequency : from,
        toFrequency:   to,
        closed,
      });
    };

    // Bounded: every pass strictly lowers one route's frequency, and there are
    // finitely many frequency units on a tail.
    let guard = 0;
    while (peak > capHours + 1e-6 && guard++ < 1000) {
      const active = committed(a.id)
        .filter(r => isRouteActive(r, month) && (r.weeklyFrequency ?? 0) > 0);
      if (active.length === 0) break;

      const hoursPerFreq = (r) => routeBlockHours(r, type, 1);
      const revPerHour   = (r) => {
        const h = routeBlockHours(r, type, r.weeklyFrequency);
        return h > 0 ? (revenues[r.id] ?? 0) / h : 0;
      };
      // Cheapest schedule first. Ties: shed the biggest hour-consumer, then id —
      // so a save with no revenue history at all still trims deterministically.
      const order = [...active].sort((x, y) =>
        revPerHour(x) - revPerHour(y)
        || hoursPerFreq(y) - hoursPerFreq(x)
        || String(x.id).localeCompare(String(y.id)));

      const reducible = order.find(r => (r.weeklyFrequency ?? 0) > 1);
      if (reducible) {
        const per  = hoursPerFreq(reducible);
        const need = peak - capHours;
        let drop = per > 0 ? Math.ceil(need / per - 1e-9) : (reducible.weeklyFrequency - 1);
        drop = Math.max(1, Math.min(drop, reducible.weeklyFrequency - 1));
        const from = reducible.weeklyFrequency;
        reducible.weeklyFrequency = from - drop;
        noteCut(reducible, from, reducible.weeklyFrequency, false);
      } else {
        // LAST RESORT: everything active in the peak month is down to one
        // weekly flight and it still does not fit. Close the cheapest.
        const victim = order[0];
        const from = victim.weeklyFrequency;
        victim.weeklyFrequency = 0;
        noteCut(victim, from, 0, true);
      }
      ({ hours: peak, month } = peakInfo(a.id, type));
    }

    if (cuts.size > 0) {
      notices.push({
        aircraftId:  a.id,
        name:        a.name ?? null,
        tailNumber:  a.tailNumber ?? null,
        typeId:      a.typeId,
        capHours,
        peakBefore:  Math.round(peakBefore * 10) / 10,
        peakAfter:   Math.round(peak * 10) / 10,
        peakMonth:   monthBefore,
        cuts:        [...cuts.values()],
      });
    }
  }

  if (notices.length === 0) {
    return { routes: state?.routes ?? [], cargoRoutes: state?.cargoRoutes ?? [],
             fleet: state?.fleet ?? [], notices, changed: false, revenueSource: source };
  }

  // Routes driven to zero are closed; survivors keep their identity (id,
  // weeksOpen ramp, pricing, season) so nothing re-enters its maturity ramp.
  const keptRoutes = routes.filter(r => (r.weeklyFrequency ?? 0) > 0);
  const keptCargo  = cargoRoutes.filter(r => (r.weeklyFrequency ?? 0) > 0);
  // Status is re-derived ONLY for tails that actually lost a whole route, so the
  // migration cannot quietly restatus airframes it never touched.
  const closedOn = new Set(notices
    .filter(n => n.cuts.some(c => c.closed))
    .map(n => n.aircraftId));
  const stillFlying = new Set([...keptRoutes, ...keptCargo].map(r => r.aircraftId));
  const nextFleet = closedOn.size === 0 ? (state?.fleet ?? []) : (state?.fleet ?? []).map(a => {
    if (!closedOn.has(a.id) || a.status === 'retired' || isOutOfService(a)) return a;
    const want = stillFlying.has(a.id) ? 'assigned' : 'idle';
    return a.status === want ? a : { ...a, status: want };
  });

  return { routes: keptRoutes, cargoRoutes: keptCargo, fleet: nextFleet,
           notices, changed: true, revenueSource: source };
}

/**
 * The migration as the save sees it. Runs AT MOST ONCE per save: the version
 * flag is stamped whether or not anything needed trimming, so a schedule the
 * player rebuilds afterwards is never touched again.
 *
 * Called from reconcileState (every client save load, solo and multiplayer) and,
 * in Headwinds, from the server tick — because the server blob is authoritative
 * and a player who never opens the client must still be migrated.
 */
export function applyScheduleTrimMigration(state, opts = {}) {
  if (!state) return state;
  if ((state.scheduleTrimVersion ?? 0) >= SCHEDULE_TRIM_VERSION) return state;
  const res = trimOverCapSchedules(state, opts);
  const stamped = { ...state, scheduleTrimVersion: SCHEDULE_TRIM_VERSION };
  if (!res.changed) return stamped;
  return {
    ...stamped,
    routes:      res.routes,
    cargoRoutes: res.cargoRoutes,
    fleet:       res.fleet,
    scheduleTrimNotices: [...(state.scheduleTrimNotices ?? []), ...res.notices]
      .slice(-SCHEDULE_TRIM_NOTICE_CAP),
  };
}

/** Human sentence for one aircraft's trim. Shared so every surface words it identically. */
export function scheduleTrimMessage(notice) {
  if (!notice) return '';
  const tail  = notice.tailNumber || notice.name || 'An aircraft';
  const flights = (n) => `${n} weekly flight${n === 1 ? '' : 's'}`;
  const parts = (notice.cuts ?? []).map(c => {
    const pair = `${c.origin}–${c.destination}`;
    return c.closed
      ? `${pair} was closed — it was already down to ${flights(c.fromFrequency)}`
      : `${pair} was reduced from ${c.fromFrequency} to ${flights(c.toFrequency)}`;
  });
  const list = parts.length <= 1 ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${tail} was scheduled for ${Math.round(notice.peakBefore)}h a week against a `
       + `${notice.capHours}h limit. ${list} to bring it back within limits.`;
}

/**
 * Which aircraft of a given type can be deployed to open (or join) a route.
 *
 * The reducer (ADD_ROUTE / ADD_CARGO_ROUTE) lets ONE aircraft fly several
 * routes until it hits the weekly block-hour cap, provided every extra route
 * touches an airport the aircraft already serves. This helper surfaces that to
 * the UI so the route planners can offer a plane that already has a route but
 * still has spare hours — not just fully-idle airframes.
 *
 * Block-hours are summed across the aircraft's existing routes (a conservative
 * upper bound vs. the reducer's per-month peak, so anything this returns as
 * eligible the reducer will also accept).
 *
 * Range is checked per airframe (effectiveRangeKm, so engine/wingtip mods and the
 * cabin-payload bonus count) rather than against the catalogue figure — the same
 * measure addRouteBlockReason uses, so nothing this returns as eligible is then
 * refused by the reducer.
 *
 * @returns array of { aircraft, idle, usedBlockHrs, spareBlockHrs, newBlockHrs,
 *   connectivityOk, hoursOk, rangeOk, eligible }, idle airframes first then most-spare.
 */
export function deployableFleetForRoute({
  fleet = [], existingRoutes = [], typeId, origin, dest, distKm, weeklyFrequency,
  capHours = MAX_WEEKLY_BLOCK_HOURS,
}) {
  const type = getAircraftType(typeId);
  if (!type) return [];
  const newBH = weeklyBlockHours(distKm, weeklyFrequency, type);
  return fleet
    .filter(a => a.typeId === typeId && !isOutOfService(a) && a.status !== 'retired')
    .map(a => {
      const acRoutes = routesCommittedTo(a.id, existingRoutes);
      const usedBH   = acRoutes.reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0);
      const served   = new Set(acRoutes.flatMap(r => [r.origin, r.destination]));
      const connectivityOk = acRoutes.length === 0 || served.has(origin) || served.has(dest);
      const hoursOk  = usedBH + newBH <= capHours + 1e-6;
      // Range is per AIRFRAME: two tails of the same type differ once one has
      // sharklets or an uprated engine. Own one modded jet and one stock, and the
      // stock one must not be counted as "ready" for a lane only the modded one
      // reaches — ADD_ROUTE would reject it. Measured exactly as the reducer's
      // guard measures it, so the pickers and the reducer never disagree.
      const rangeOk  = !(distKm > 0) || distKm <= effectiveRangeKm(a, type);
      return {
        aircraft:      a,
        idle:          a.status === 'idle',
        // Stationed reserves stay in the pool (you CAN deploy one — it simply
        // ends its standby) but they are flagged so the route pickers can label
        // them and keep them out of the plain "idle" counters.
        reserve:       isReserve(a),
        usedBlockHrs:  usedBH,
        spareBlockHrs: Math.max(0, capHours - usedBH),
        newBlockHrs:   newBH,
        connectivityOk,
        hoursOk,
        rangeOk,
        // Usable spare: 1-2 free hours is not real availability (see
        // MIN_SPARE_BLOCK_HOURS). Drives the "with spare hours" counters and
        // the free-hours labels in the route pickers.
        hasUsableSpare: (capHours - usedBH) > MIN_SPARE_BLOCK_HOURS,
        eligible:      connectivityOk && hoursOk && rangeOk,
      };
    })
    // Free idle tails first, then planes with spare hours, then reserves last —
    // a standby cover should never be the plane you reach for by accident.
    .sort((x, y) => {
      const rank = d => (d.reserve ? 2 : (d.idle ? 0 : 1));
      return (rank(x) !== rank(y)) ? (rank(x) - rank(y)) : (y.spareBlockHrs - x.spareBlockHrs);
    });
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
 * Hub line-maintenance factor for an aircraft (≤1): the best maintFactor among
 * T2+ hubs any of its routes touch. Mirrors hubCostFactorsFor()'s maint term so
 * heavy C/D checks get the same in-house-base discount as weekly line maintenance.
 */
export function aircraftHubMaintFactor(aircraftId, routes = [], cargoRoutes = [], hubs = {}) {
  let best = 1.0;
  for (const r of [...(routes ?? []), ...(cargoRoutes ?? [])]) {
    if (r.aircraftId !== aircraftId) continue;
    const codes = r.stops ?? [r.origin, r.destination];
    for (const c of codes) {
      const t = hubs?.[c]?.tier;
      const f = t != null ? (HUB_TIERS[t]?.maintFactor ?? 1.0) : 1.0;
      if (f < best) best = f;
    }
  }
  return best;
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
  // absWeek rides along so every caller that builds a market off this date gets
  // the world's demand growth — buildRouteMarket keys growth on it and falls
  // back to 1.0 when it is absent, so leaving it off silently froze every
  // preview and every UI-side market at year-one demand while the tick grew.
  return {
    week: state.week,
    month: monthIndex,
    absWeek: ((state.year ?? 1) - 1) * 52 + (state.week ?? 1),
  };
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
    seatQuality:    'basic',
    serviceQuality: 'standard',
  };
}

/**
 * The rival offers contesting one city pair — each airline exactly ONCE.
 *
 * A rival can reach the demand model down two channels, and on a contested pair
 * it usually reaches it down both at the same time:
 *
 *   • `competitors[].routes[pairKey]` — a carrier's real scheduled network.
 *     In Headwinds every other active player is published here as a dossier row
 *     by buildRivalViews(), flagged `human: true`.
 *   • an offer spec — `state.encroachments[pairKey]` (a synthetic AI entrant
 *     ramping into the pair) or, in multiplayer, `state.humanRivals[pairKey]`
 *     (a real player's actual offer on that pair).
 *
 * Both channels were concatenated blind, so one airline published down both was
 * scored by computeMarketShare as TWO airlines — the encroachment offer
 * publishes as `encroach:<id>` and the carrier offer as `<id>`, so nothing
 * collided and the softmax had no way to notice. Measured on the fixture in
 * tools/rival-dedupe-test.mjs: 240 passengers where one counting gives 642, a
 * 62% haircut applied to every player on every contested pair, symmetrically,
 * with world-wide booked passengers exceeding the demand pool. The preview
 * helper (pairShare.buildRivalPairOffers) had carried the dedupe from the start;
 * only the tick was missing it, so the two disagreed by the same third.
 *
 * Precedence depends on which channel the duplicate came down, and the two rules
 * point opposite ways:
 *
 *   • Human rival — the SPEC wins. state.humanRivals is the purpose-built
 *     representation of a player on a pair: their real economy and business
 *     fares, quality score, brand reach, lounge network and frequency-blended
 *     seats-per-flight. The dossier row is the thinner of the two.
 *   • Encroachment — the CARRIER wins. A scheduled route is that carrier's
 *     actual capacity on the pair; a spec naming them is a ramping stand-in for
 *     capacity that already exists.
 *
 * A human competitor with no spec on this pair is still counted, so a gap in
 * state.humanRivals costs a rival's presence rather than silently exempting them.
 *
 * @param {object[]|null} competitors  state.competitors — the live carrier bank
 * @param {object[]|null} specs        offer specs contesting this pair
 * @param {object}        market       from buildRouteMarket
 */
export function rivalOffersFor(competitors, specs, market) {
  const key = [market.origin, market.destination].sort().join('-');
  const specList = (specs ?? []).filter(Boolean);
  const spokenFor = new Set(
    specList.map(s => s.competitorId).filter(id => id != null));
  const offers = [];
  const servingByRoute = new Set();

  for (const c of competitors ?? []) {
    if (!c?.routes?.[key]) continue;
    if (c.human && spokenFor.has(c.id)) continue;   // their spec speaks for them
    const offer = buildCompetitorOffer(c, market);
    if (!offer) continue;
    servingByRoute.add(c.id);
    offers.push(offer);
  }
  for (const spec of specList) {
    if (spec.competitorId != null && servingByRoute.has(spec.competitorId)) continue;
    const offer = buildEncroachmentOffer(spec, market);
    if (offer) offers.push(offer);
  }
  return offers;
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
 * @param {number} [eventDemandMult=1.0]   - world-event demand multiplier for this
 *                                           O&D (global × regional). Scales the
 *                                           passenger pool so a pandemic actually
 *                                           empties seats instead of skimming revenue.
 * @returns {object|null}
 */
export function simulateRoute(route, aircraft, gameDate = { month: 6 }, labor = null, fuelMultiplier = 1.0, demandOverride = null, encroachmentSpecs = [], avgUtilization = null, satisfaction = null, eventDemandMult = 1.0, ancillaries = null, competitors = null) {
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

  // Labor morale feeds into quality inputs — on-time rate blends pilot/ground/cabin
  // morale minus schedule pressure from fleet utilization; customer rating is
  // earned from the persistent satisfaction stat (cabin-morale fallback);
  // ground staff → small quality bonus/penalty applied after scoring.
  const { onTimeRate, customerRating, groundQualityBonus } = laborEffects(labor, avgUtilization, satisfaction);

  const rawQualityScore = route.qualityScore ?? computeQualityScore({
    onTimeRate,
    cabinPoints:    cabinQualityPoints(config),   // seat (hard) + service (soft) product
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
  // Provisioned-amenity capability for THIS route. Policy says what you want to
  // offer; these say what you can actually deliver here. Wi-Fi is read straight
  // off the metal flying the route — simulateRoute already has the aircraft, so
  // nothing has to be threaded in for it. Lounge coverage is a property of the
  // two airports, so weeklyTick (and the pairShare preview) attach it to the
  // route alongside hubQualityBonus and brandReach. A caller that attaches
  // neither is scored at parity, exactly as before these existed.
  const ancCoverage = {
    wifi:   wifiCoverageFor(aircraft),
    lounge: route.loungeCoverage ?? 1,
  };
  // Ancillary quality: airline-wide à la carte generosity (free/cheap extras and
  // simply offering expected amenities lift perceived quality; nickel-and-diming
  // and dropping amenities drag it). Zero when no policy is active.
  const ancillaryQuality = ancillaryQualityBonus(ancillaries, dist, ancCoverage);
  // Hub quality bonus: routes through a player-designated hub get a quality boost from hub investment
  const qualityScore = Math.max(0, Math.min(100, rawQualityScore + groundQualityBonus + spaceQualityBonus + cateringQuality + ancillaryQuality + (route.hubQualityBonus ?? 0)));

  // Hub connectivity bonus — scaled by the spokes you actually connect there
  // (route.hubSpokes, attached by weeklyTick). A caller that doesn't know the
  // network omits it and gets the historical flat 0.20.
  const connectivityBonus = computeConnectivityBonus(
    route.hub, route.origin, route.destination, route.hubSpokes ?? CONNECTIVITY_LEGACY_SPOKES);

  // Build market and player offer, then run through demand model
  const maturity     = route.weeksOpen != null ? routeMaturityFactor(route.weeksOpen) : 1;
  const market       = buildRouteMarket(route.origin, route.destination, gameDate, maturity, eventDemandMult);
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
    // Total physical seats across ALL cabins. The demand model caps leisure
    // demand at this (minus business pax) so excess leisure can fill premium-cabin
    // and spare economy seats, rather than being thrown away at the economy cap.
    totalSeats:        configBodies(config) * route.weeklyFrequency,
    qualityScore,
    connectivityBonus,
    // Loyalty program + reputation blunt price sensitivity (attached by weeklyTick).
    priceSensitivityReduction: route.priceSensitivityReduction ?? 0,
    // Targeted advertising at either endpoint (attached by weeklyTick). Enters
    // the share fight on contested pairs and the demand pool on monopolies.
    marketingBoost: route.marketingBoost ?? 0,
    // Brand reach — awareness × reputation × loyalty × alliance, net of rival
    // ad pressure (attached by weeklyTick). Same two channels as marketingBoost.
    // Callers that don't attach it (previews, tests) sit at parity.
    brandReach: route.brandReach ?? 1,
    // Airport lounges at this route's endpoints (attached by weeklyTick). Moves
    // the BUSINESS segment only — a share term on a contested pair, a business
    // pool term on a monopoly. 1 = no lounges, scored as before.
    loungeAppeal: route.loungeAppeal ?? 1,
  };

  // Gather any AI competitors serving this route and compute market share.
  // When multiple player aircraft share the same O&D, weeklyTick pre-computes
  // aggregated demand and passes a demandOverride so we don't double-count.
  let demandResult;
  let competitorOffersCount = 0;
  if (demandOverride) {
    demandResult = demandOverride;
  } else {
    // The LIVE carrier bank, passed in by the caller — never the COMPETITOR_AIRLINES
    // module constant.
    //
    // This loop used to read that constant directly, and it was a dead branch for
    // the whole life of the file: sampleAndInitializeCompetitors() does
    // `{ ...c, routes: {} }` and then populates the COPIES it hands to
    // state.competitors, so every entry in COMPETITOR_AIRLINES keeps `routes: {}`
    // forever. buildCompetitorOffer() bails on `competitor.routes[routeKey]`, so it
    // returned null 70 times out of 70 — measured at 0 offers on 155/155 pairs the
    // sampled carriers actually fly. Every solo player route, in the tick as well
    // as in every preview, was scored as an uncontested monopoly.
    //
    // Callers that pass nothing still get an empty bank (today's behaviour) rather
    // than a silently-empty constant, so a missed call site reads as "no rivals
    // supplied" instead of masquerading as "no rivals exist".
    //
    // Injected challengers (route encroachment, and every human rival in
    // multiplayer) contest this O&D through the same channel — rivalOffersFor()
    // merges the two banks and publishes each airline exactly once.
    const competitorOffers = rivalOffersFor(competitors, encroachmentSpecs, market);
    competitorOffersCount = competitorOffers.length;
    const allOffers = [playerOffer, ...competitorOffers];
    const shareResults = computeMarketShare(market, allOffers);
    [demandResult] = shareResults; // player is always first
  }

  // Fan leisure/business pax across cabin classes using segment preferences.
  // Premium classes are filled first; any demand that can't find a premium seat
  // spills down into economy (passengers downgrade rather than not fly).
  let { leisurePax, businessPax } = demandResult; // one-way totals
  // Capacity reflects the REAL configured seat count (premium cabins + any empty
  // floor reduce it below the aircraft's max economy-equivalent units).
  const totalCapOneWay = configBodies(config) * route.weeklyFrequency;
  // Both load models below apply min(demand, capacity) THEMSELVES, so they must
  // see the demand the market generated — not the pool computeMarketShare has
  // already capped at the seat count. Fed the capped figure they were locked
  // permanently into the demand<=capacity regime: a route 13x oversubscribed
  // was docked the identical haircuts as one scraping parity, which is the one
  // case where a haircut is wrong. (Older results and pooled demandOverrides
  // may lack the uncapped fields — fall back to the capped pool, i.e. exactly
  // the old behaviour.)
  const uncappedOneWay =
    (demandResult.leisurePaxUncapped  ?? leisurePax)
    + (demandResult.businessPaxUncapped ?? businessPax);
  // NWR load-factor realism: spill against an achievable ceiling plus a
  // deterministic weekly jitter (see market.js). weeklyTick attaches
  // route.nwrLoadJitter only in restricted worlds; when absent the scale is
  // exactly 1 and this block leaves classic worlds byte-identical. Applied to
  // the demand POOL before cabin fan-out so class allocation, downgrade spill
  // and involuntary upgrades all stay internally consistent.
  //
  // nwrDemandScale divides by the demand it is given, so its result must be
  // converted to a CARRIED-PASSENGER target before it can scale the (capped)
  // pool — dividing the uncapped scale into the capped pool directly would
  // under-shoot precisely when the two differ.
  const pool0 = leisurePax + businessPax;
  const nwrScaleRaw = nwrDemandScale(uncappedOneWay, totalCapOneWay, route.nwrLoadJitter);
  const nwrScale = (nwrScaleRaw !== 1 && pool0 > 0)
    ? Math.min(1, (uncappedOneWay * nwrScaleRaw) / pool0)
    : 1;
  if (nwrScale !== 1) {
    // Round to whole passengers: the class fan-out and the involuntary-upgrade
    // block below both do integer arithmetic on these, and a fractional pool
    // leaks fractions all the way to the UI (4,276.271 pax/wk on a route table).
    leisurePax  = Math.round(leisurePax  * nwrScale);
    businessPax = Math.round(businessPax * nwrScale);
  }

  // Directional seasonal skew: when the two ends of a route are in different
  // seasons the traffic is lopsided, and symmetric seats cannot carry a
  // lopsided week. Exactly 1 when both endpoints share a seasonal profile or
  // when the aeroplane isn't full — most of the world is untouched.
  // directionalLoadMultiplier's contract is "fraction of a balanced week's
  // carriage", so it composes directly with the capped pool — but its INPUT
  // must be the uncapped demand: with real demand far above capacity both
  // directions stay full and the correct haircut is exactly zero.
  const seasonalSkew = directionalSeasonalSkew(route.origin, route.destination, gameDate?.month);
  const directionalScale = directionalLoadMultiplier(
    uncappedOneWay, totalCapOneWay, seasonalSkew);
  if (directionalScale !== 1) {
    leisurePax  = Math.round(leisurePax  * directionalScale);
    businessPax = Math.round(businessPax * directionalScale);
  }
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
  const crewCost    = Math.round(dist * type.crewCostPerKm * flights * (labor?.seniorityMult ?? 1));
  const qualityCost =
    (SEAT_QUALITY_COST_PER_ROUTE[config.seatQuality ?? 'standard'] ?? 0) +
    (SERVICE_QUALITY_COST_PER_ROUTE[config.serviceQuality ?? 'standard'] ?? 0);

  // Hub cost efficiencies — own staff/kitchen/crew base at designated hubs.
  // station: discount on ground handling + catering (mean of the two endpoints);
  // layover: discount on crew hotels/per-diem (max endpoint — crews sleep at base).
  const hcf      = route.hubCostFactors ?? null;
  const stationF = hcf ? Math.max(0, 1 - (hcf.station ?? 0)) : 1;
  const layoverF = hcf ? Math.max(0, 1 - (hcf.layover ?? 0)) : 1;

  // Catering — driven by the route's chosen service level. Cost AND ancillary
  // revenue both scale with distance; revenue only on the paid/hybrid levels.
  // (Hub flight kitchens discount the COST; ancillary revenue is untouched.)
  const catering        = routeCatering(cateringLevel, classSummary, dist);
  const cateringCost    = Math.round(catering.cost * stationF);
  const cateringRevenue = catering.revenue;
  // Ancillary catering income folds straight into route revenue.
  totalRevenue += cateringRevenue;

  // À la carte ancillaries (bags, seats, Wi-Fi, lounge, …) — airline-wide policy.
  // Per-actual-passenger income + provisioning cost; both fold into the route.
  const ancillary        = routeAncillaries(ancillaries, classSummary, dist, ancCoverage);
  const ancillaryRevenue = ancillary.revenue;
  const ancillaryCost    = ancillary.cost;
  totalRevenue += ancillaryRevenue;

  // Ground handling — ramp, baggage, gate agents, pushback; per boarded passenger
  const groundHandlingCost = Math.round(weeklyGroundHandlingCost(classSummary) * stationF);

  // Crew layover — when one-way block time > 4 hours
  const blockTimeOneWay = blockTimeHours(dist, type);
  const layoverCost = Math.round(
    weeklyLayoverCost(blockTimeOneWay, type.seats, type.category, route.weeklyFrequency) * layoverF
  );

  // Savings surfaced for the UI ("Hub efficiency" line in the cost breakdown)
  const hubCostSavings = hcf ? Math.round(
    catering.cost * (1 - stationF)
    + weeklyGroundHandlingCost(classSummary) * (1 - stationF)
    + weeklyLayoverCost(blockTimeOneWay, type.seats, type.category, route.weeklyFrequency) * (1 - layoverF)
  ) : 0;

  // Passenger compensation — tied to pilot on-time rate (from morale)
  // Compensation applies to all boarded passengers (both directions = ×2).
  const compensationCost = weeklyPassengerCompensation(totalPaxOneWay * 2, onTimeRate, dist);

  // Lounge & premium ground service — airport lounge access, fast-track security,
  // dedicated check-in for business/first pax. Per-passenger, both directions.
  // An endpoint where the airline has BUILT its own lounge pays the marginal
  // cost of the room instead of a contractor's per-head rate (see
  // loungeContractFactor in data/lounges.js). This is the hard financial payback
  // on a lounge, and it is why lounges earn at hubs and lose money at
  // outstations: it scales with the premium traffic actually pushed through.
  const loungeCost = weeklyLoungeCost(classSummary, route.loungeContractFactor ?? 1);

  const totalOpCost = fuelCost + crewCost + qualityCost + cateringCost + ancillaryCost + groundHandlingCost + layoverCost + compensationCost + loungeCost;

  return {
    revenue:      Math.round(totalRevenue),
    // Final quality score used in the demand model (all bonuses, clamped 0–100).
    // Consumed by the Alliances page (eligibility) and available to any UI.
    qualityScore,
    fuelCost,
    crewCost,
    qualityCost,
    cateringCost,
    cateringRevenue,
    cateringLevel,
    cateringQuality,
    cateringByClass: catering.byClass,
    ancillaryRevenue,
    ancillaryCost,
    ancillaryQuality,
    ancillaryByItem: ancillary.byItem,
    groundHandlingCost,
    loungeCost,
    layoverCost,
    compensationCost,
    hubCostSavings,
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
    seasonalSkew,        // −0.35…+0.35, how lopsided this week's traffic is
    directionalScale,    // ≤1, seats lost to that lopsidedness
    connectivityBonus,   // what your network at the hub was actually worth
    competitorCount: competitorOffersCount,
    capacityCapped:  demandResult.capacityCapped,
    ticketPremium,   // >1 for supersonic aircraft (e.g. Concorde = 2.5)
  };
}


// ─── Break-even load factor ──────────────────────────────────────────────────
//
// 2026-08-11, Kat the Fox: "either BEP is wrong or the CASK/RASK is wrong. If
// I'm not making a profit why isn't it showing that I'm losing money on said
// route because of its CASK" — a screenshot of ten routes, every one of them
// with RASK comfortably ABOVE CASK (spread +$0.041, grade A) and every one of
// them stamped "✗ Below BEP" at break-even load factors of 130–412%.
//
// Both columns cannot be right, and the CASK/RASK pair was the honest one:
// it divides the engine's booked revenue and the engine's totalOpCost by the
// same ASK. The BEP column did not read the engine at all. It rebuilt a
// theoretical 100%-load revenue from scratch:
//
//     fullRevenue = type.seats × frequency × 2 × route.ticketPrice × blendedMult
//     breakEvenLF = cost / fullRevenue
//
// where `blendedMult` was the DEFAULT cabin ladder (F 5.0 / J 2.5 / W 1.4).
// That estimate desynchronises from the fare the airline actually charges the
// moment a player touches anything:
//
//   * per-class fares. `route.ticketPrice` is the ECONOMY fare. Sell economy
//     cheap to fill the aeroplane and price the front cabins where they belong
//     and the estimate collapses — Kat's A380 was booking ~$500/seat-leg while
//     the formula priced all 853 seats off a $60 economy ticket. Reproduced at
//     ASK 63.9M: BEP 393% on a route earning $2.4M/wk.
//   * supersonic ticketPremium. Concorde charges 2.75×; the formula charged 1×,
//     so a full Concorde read 217% break-even instead of 79%.
//   * ancillary and catering income, which the engine folds into route revenue.
//   * connecting-feed and itinerary revenue — the very figure (proj.revById)
//     that the RASK beside it is computed from.
//
// The fix is to stop estimating. Break-even is a property of the cost
// structure and the fare actually realised, both of which the engine already
// reports. Split the week's costs into the part that is fixed once the
// schedule is flown and the part that walks up the airbridge:
//
//     contributionPerPax = (revenue − paxVariableCost) / pax
//     breakEvenPax       = fixedCost / contributionPerPax
//     breakEvenLF        = breakEvenPax / configuredSeats
//
// which is algebraically the load factor at which profit is exactly zero, so
// `loadFactor ≥ breakEvenLF` and `RASK ≥ CASKfull` can no longer disagree:
//
//     LF ≥ BEP  ⟺  pax × contribution ≥ fixed  ⟺  revenue ≥ totalCost
//
// guarded by tools/bep-consistency-test.mjs.

/**
 * Cost lines from simulateRoute that scale with passengers CARRIED rather than
 * with seats flown. Everything else in totalOpCost (fuel, crew, cabin quality,
 * crew layover) is spent whether the aeroplane goes out full or empty.
 */
export const PAX_VARIABLE_COST_KEYS = Object.freeze([
  'cateringCost',
  'ancillaryCost',
  'groundHandlingCost',
  'compensationCost',
  'loungeCost',
]);

/**
 * Split a route week into fixed and passenger-variable cost.
 *
 * `fixed` is derived by subtraction rather than by adding up a second list, so
 * `fixed + variable` always equals the engine's total exactly — a cost line
 * added to simulateRoute later lands on the fixed side instead of silently
 * vanishing from break-even.
 *
 * @param {object} result          a simulateRoute() result
 * @param {number} [allocatedFixed] lease + maintenance allocated to this route
 * @returns {{ fixed: number, variable: number, total: number }}
 */
export function routeCostSplit(result, allocatedFixed = 0) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const variable = PAX_VARIABLE_COST_KEYS.reduce((s, k) => s + num(result?.[k]), 0);
  const total    = num(result?.totalOpCost) + Math.max(0, num(allocatedFixed));
  return { fixed: Math.max(0, total - variable), variable, total };
}

/**
 * Load factor at which this route's profit is exactly zero, from the revenue it
 * actually booked — not from a re-derived list fare.
 *
 * @param {object} result           a simulateRoute() result. `revenue` may be
 *                                  overridden by the caller with the tick's
 *                                  booked figure; whatever is passed is the
 *                                  figure break-even is measured against, which
 *                                  is what keeps it agreeing with RASK.
 * @param {number} [allocatedFixed] lease + maintenance allocated to this route
 * @returns {number|null} 0…1 (or >1 when a full aeroplane still loses money),
 *                        Infinity when no load factor breaks even,
 *                        null when the route flies no seats at all.
 */
export function breakEvenLoadFactor(result, allocatedFixed = 0) {
  const cap = Number(result?.configuredSeatsOneWay) || 0;
  if (cap <= 0) return null;

  const { fixed, variable, total } = routeCostSplit(result, allocatedFixed);
  if (total <= 0) return 0;

  const pax = Number(result?.passengers) || 0;
  // Nobody flew, so there is no realised fare to extrapolate a break-even from.
  if (pax <= 0) return Infinity;

  const revenue = Number(result?.revenue) || 0;
  const contributionPerPax = (revenue - variable) / pax;
  // Each extra passenger costs more to carry than they pay: no load factor
  // saves this route, only a higher fare or a cheaper cabin does.
  if (contributionPerPax <= 0) return Infinity;

  return (fixed / contributionPerPax) / cap;
}

// ─── Hub connectivity: how big is the network at this station? ──────────────
// The demand model's connectivity bonus scales with the number of distinct
// places you connect at a hub (see computeConnectivityBonus). This is where the
// count comes from: every leg of every route you fly, including the internal
// legs of multi-stop rotations — a tag route through your hub genuinely does
// feed it.

/**
 * Distinct onward destinations served from every airport in a route list.
 *
 * @param {object[]} routes
 * @returns {Record<string, number>} airport code → spoke count
 */
export function hubSpokeCounts(routes = []) {
  const sets = new Map();
  for (const route of routes ?? []) {
    const stops = routeStops(route);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (!a || !b || a === b) continue;
      if (!sets.has(a)) sets.set(a, new Set());
      if (!sets.has(b)) sets.set(b, new Set());
      sets.get(a).add(b);
      sets.get(b).add(a);
    }
  }
  const out = {};
  for (const [code, set] of sets) out[code] = set.size;
  return out;
}

/**
 * The connectivity bonus a pair earns from the player's own network. Whichever
 * endpoint is the hub supplies the spoke count; a pair touching no hub scores 0.
 *
 * The ONE helper every preview and the tick share, so a screen can't quietly
 * disagree with the week about how big your hub is.
 *
 * @param {Record<string,number>} spokeCounts  from hubSpokeCounts()
 * @param {string[]} hubCodes                  every station you've designated
 * @param {string} origin
 * @param {string} destination
 */
export function pairConnectivityBonus(spokeCounts, hubCodes, origin, destination) {
  let best = 0;
  for (const code of hubCodes ?? []) {
    if (!code) continue;
    if (code !== origin && code !== destination) continue;
    best = Math.max(best, spokeCounts?.[code] ?? 0);
  }
  return connectivityBonusForSpokes(best);
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
export function simulateTagRoute(route, aircraft, gameDate = { month: 6 }, labor = null, fuelMultiplier = 1.0, avgUtilization = null, satisfaction = null, demandMultFor = null, ancillaries = null, competitors = null, encroachSpecsFor = null, segmentDemandFor = null) {
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
  const { onTimeRate, customerRating, groundQualityBonus } = laborEffects(labor, avgUtilization, satisfaction);
  const baseQuality = route.qualityScore ?? computeQualityScore({
    onTimeRate,
    cabinPoints:   cabinQualityPoints(config),   // seat (hard) + service (soft) product
    fleetAgeYears: (aircraft.ageWeeks ?? 0) / 52,
    customerRating,
  });
  const spaceBonus    = configSpaceQualityBonus(config, type);
  const cateringLevel = normalizeCateringLevel(route.cateringLevel);
  // Provisioned-amenity capability, same two gates as simulateRoute: Wi-Fi off
  // the metal, lounges off the airports (attached by weeklyTick). On a tag
  // rotation the lounge figure covers the ORIGIN and FINAL destination — the
  // intermediate stops are a technical stop for most of the people on board.
  const ancCoverage = {
    wifi:   wifiCoverageFor(aircraft),
    lounge: route.loungeCoverage ?? 1,
  };

  // ── Per-leg seat capacity (one-way seats/week), economy vs pooled premium ──
  const ecoSeatsPerFlight = config.economy ?? type.seats;
  const bizSeatsPerFlight = (config.firstClass ?? 0) + (config.businessClass ?? 0) + (config.premiumEconomy ?? 0);
  // NWR load-factor realism on multi-leg rotations: sellable seats per leg are
  // capped at the achievable ceiling × this week's jitter, and segment demand
  // carries the same jitter so quiet segments breathe too. Simpler than the
  // full spill model on simulateRoute (a per-segment normal-loss against a
  // shared leg pool isn't well-defined), but the observable behaviour matches:
  // a saturated rotation lands at ~ceiling±jitter, an empty one is untouched.
  // route.nwrLoadJitter is only attached in restricted worlds; when absent
  // both factors are 1 and this path is byte-identical to classic.
  const nwrJ      = route.nwrLoadJitter;
  const nwrLegCap = (seats) => nwrJ != null
    ? Math.floor(seats * f * NWR_LF_CEILING * nwrJ)
    : seats * f;
  const ecoCap = legs.map(() => nwrLegCap(ecoSeatsPerFlight));   // remaining economy seats per leg
  const bizCap = legs.map(() => nwrLegCap(bizSeatsPerFlight));   // remaining premium seats per leg

  // ── Uncapped demand per sellable segment ──────────────────────────────────
  const maturity = route.weeksOpen != null ? routeMaturityFactor(route.weeksOpen) : 1;
  const segData = routeSegments(route).map(seg => {
    const dist   = distanceKm(getAirport(seg.from), getAirport(seg.to));
    // World-event demand shock per segment (regional events hit only the legs
    // that touch an affected country; global events hit every leg).
    const segEventMult = demandMultFor ? demandMultFor(seg.from, seg.to) : 1;
    const market = buildRouteMarket(seg.from, seg.to, gameDate, maturity, segEventMult);
    const sp     = route.segmentPrices?.[routeSegmentKey(seg.from, seg.to)];
    const eco    = Math.max(1, sp?.economy ?? market.referencePrice);
    const biz    = Math.max(1, sp?.businessClass ?? eco * CLASS_FARE_MULTIPLIERS.businessClass);
    const quality = Math.max(0, Math.min(100,
      baseQuality + groundQualityBonus + spaceBonus
      + cateringQualityBonus(cateringLevel, dist) + ancillaryQualityBonus(ancillaries, dist, ancCoverage) + (route.hubQualityBonus ?? 0)));
    const connectivityBonus = computeConnectivityBonus(
      route.hub, seg.from, seg.to, route.hubSpokes ?? CONNECTIVITY_LEGACY_SPOKES);
    const offer = {
      airlineId: 'player', origin: seg.from, destination: seg.to,
      economyPrice: eco, businessPrice: biz, weeklyFrequency: f,
      seatsPerFlight: type.seats,
      economySeats: 1e12, businessSeats: 1e12,   // huge → demand returns uncapped
      qualityScore: quality, connectivityBonus,
      priceSensitivityReduction: route.priceSensitivityReduction ?? 0,
      marketingBoost: route.marketingBoost ?? 0,
      brandReach: route.brandReach ?? 1,
      loungeAppeal: route.loungeAppeal ?? 1,
    };
    // The LIVE bank, plus whatever contests this SEGMENT — same channel and same
    // one-airline-one-offer merge the single-leg path uses.
    //
    // This loop read the COMPETITOR_AIRLINES module constant, which is the dead
    // branch simulateRoute was fixed for and this function was missed by:
    // sampleAndInitializeCompetitors() does `{ ...c, routes: {} }` and populates
    // the COPIES it hands to state.competitors, so every entry in the constant
    // keeps an empty routes map forever and buildCompetitorOffer() returns null
    // 70 times out of 70. Every segment of every tag route was scored as an
    // uncontested monopoly — so rerouting a trunk through one intermediate stop
    // made every competitor on it disappear, permanently and for free, and no
    // human rival could reach a tag route at all.
    const segKey = [seg.from, seg.to].sort().join('-');
    // When the tick has already pooled this pair (the player also flies it as a
    // nonstop, or with another tag rotation), the segment takes its SLICE of
    // that shared fight instead of running its own — running both let one pair
    // pay out its whole pool twice.
    const pooledSlice = segmentDemandFor ? segmentDemandFor(segKey) : null;
    const competitorOffers = pooledSlice ? [] : rivalOffersFor(
      competitors, encroachSpecsFor ? encroachSpecsFor(segKey) : null, market);
    const res = pooledSlice
      ? { leisurePax: pooledSlice.ecoDemand ?? 0, businessPax: pooledSlice.bizDemand ?? 0 }
      : computeMarketShare(market, [offer, ...competitorOffers])[0];
    const legIdxs = [];
    for (let k = seg.fromIdx; k < seg.toIdx; k++) legIdxs.push(k);
    return {
      from: seg.from, to: seg.to, dist, eco, biz, legIdxs, legSpan: seg.legSpan,
      ecoDemand: nwrJ != null ? Math.round(res.leisurePax  * nwrJ) : res.leisurePax,
      bizDemand: nwrJ != null ? Math.round(res.businessPax * nwrJ) : res.businessPax,
      quality,
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
  const crewCost = Math.round(totalDist * type.crewCostPerKm * sectorFactor * (labor?.seniorityMult ?? 1));
  const qualityCost =
    (SEAT_QUALITY_COST_PER_ROUTE[config.seatQuality ?? 'standard'] ?? 0) +
    (SERVICE_QUALITY_COST_PER_ROUTE[config.serviceQuality ?? 'standard'] ?? 0);

  // Hub cost efficiencies — same model as simulateRoute (station = handling +
  // catering discount averaged over endpoints; layover = max-endpoint discount).
  const hcfTag    = route.hubCostFactors ?? null;
  const stationFT = hcfTag ? Math.max(0, 1 - (hcfTag.station ?? 0)) : 1;
  const layoverFT = hcfTag ? Math.max(0, 1 - (hcfTag.layover ?? 0)) : 1;

  const catering        = routeCatering(cateringLevel, classSummary, totalDist);
  const cateringCost    = Math.round(catering.cost * stationFT);
  const cateringRevenue = catering.revenue;
  totalRevenue += cateringRevenue;

  // À la carte ancillaries — airline-wide policy, per-passenger across the tag route.
  const ancillary        = routeAncillaries(ancillaries, classSummary, totalDist, ancCoverage);
  const ancillaryRevenue = ancillary.revenue;
  const ancillaryCost    = ancillary.cost;
  totalRevenue += ancillaryRevenue;

  const groundHandlingCost = Math.round(weeklyGroundHandlingCost(classSummary) * stationFT);
  const loungeCost         = weeklyLoungeCost(classSummary, route.loungeContractFactor ?? 1);
  // Layover cost accrues per leg whose one-way block time clears the threshold.
  const layoverCostRaw = legDistKm.reduce(
    (s, d) => s + weeklyLayoverCost(blockTimeHours(d, type), type.seats, type.category, f), 0);
  const layoverCost = Math.round(layoverCostRaw * layoverFT);
  const compensationCost = weeklyPassengerCompensation(totalPaxOneWay * 2, onTimeRate, totalDist);

  const hubCostSavings = hcfTag ? Math.round(
    catering.cost * (1 - stationFT)
    + weeklyGroundHandlingCost(classSummary) * (1 - stationFT)
    + layoverCostRaw * (1 - layoverFT)
  ) : 0;

  const totalOpCost = fuelCost + crewCost + qualityCost + cateringCost + ancillaryCost
    + groundHandlingCost + loungeCost + layoverCost + compensationCost;

  const totalSeatLegsAvail = legs.length * (ecoSeatsPerFlight + bizSeatsPerFlight) * f;
  const totalSeatLegsUsed  = perLeg.reduce((s, l) => s + l.ecoUsed + l.bizUsed, 0);

  return {
    tag:          true,
    revenue:      Math.round(totalRevenue),
    // Average per-segment quality score (all bonuses, clamped) — same field
    // simulateRoute exposes, consumed by the Alliances page.
    qualityScore: segData.length > 0
      ? Math.round(segData.reduce((s, d) => s + d.quality, 0) / segData.length)
      : null,
    fuelCost,
    crewCost,
    qualityCost,
    cateringCost,
    cateringRevenue,
    cateringLevel,
    ancillaryRevenue,
    ancillaryCost,
    ancillaryByItem: ancillary.byItem,
    groundHandlingCost,
    loungeCost,
    layoverCost,
    compensationCost,
    hubCostSavings,
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
  if (payloadTonnes >= 150) return 'Outsize';
  if (payloadTonnes >= 50) return 'Wide Body';
  if (payloadTonnes >= 20) return 'Narrow Body';
  if (payloadTonnes >= 10) return 'Regional Jet';
  return 'Turboprop';
}

/**
 * The passenger body class an airport's rules should judge a freighter as.
 *
 * Airport restrictions are written against passenger categories ('Wide Body',
 * 'Regional Jet', …), but every freighter has category 'Freighter', which
 * appears in no blocked list — so a 137-tonne 747-8F was legal at LaGuardia,
 * National, Aspen and St. Maarten, none of which a widebody may use. Map by
 * payload so a freighter is judged as the aeroplane it actually is. Outsize
 * types fold into 'Wide Body' here (a ban on widebodies certainly covers an
 * An-225), unlike the landing-fee table where they pay their own higher rate.
 */
export function freighterBodyClass(type) {
  if (!type?.freighter) return type?.category ?? null;
  const t = type.payloadTonnes ?? 0;
  if (t >= 50) return 'Wide Body';
  if (t >= 20) return 'Narrow Body';
  if (t >= 10) return 'Regional Jet';
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
 * `demandOverride` ({ demandTonnes }) replaces the route's OWN demand computation
 * with a pre-allocated share of a lane-level pool — set by cargoLaneAllocations()
 * when several of your freighters fly the same city pair. Without it each route
 * independently claims the FULL pool (correct only when it's alone on the lane).
 *
 * @returns {object|null} null if the aircraft isn't a freighter or can't reach the route.
 */
export function simulateCargoRoute(route, aircraft, gameDate = { month: 6 }, labor = null, fuelMultiplier = 1.0, demandMultiplier = 1.0, demandOverride = null) {
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
  const refYield   = cargoReferenceYield(route.origin, route.destination);
  const yieldPrice = Math.max(0.01, route.yieldPrice ?? refYield);
  let demandTonnes;
  if (demandOverride != null) {
    // Shared lane: this route's slice of the pair's ONE demand pool (already
    // maturity-, awareness- and elasticity-adjusted by cargoLaneAllocations).
    demandTonnes = Math.max(0, demandOverride.demandTonnes ?? 0);
  } else {
    const maturity   = route.weeksOpen != null ? routeMaturityFactor(route.weeksOpen) : 1;
    const basePool   = cargoCityPairDemand(route.origin, route.destination, gameDate?.month)
                     * maturity * FREIGHTER_CAPTURE_RATE * demandMultiplier;
    // Yield elasticity: pricing above the reference rate shrinks the tonnage you win.
    const elasticity = Math.min(1.6, Math.pow(refYield / yieldPrice, CARGO_YIELD_ELASTICITY));
    demandTonnes = basePool * elasticity;
  }

  // ── Capacity & load ──────────────────────────────────────────────────────────
  const capacityTonnes = type.payloadTonnes * route.weeklyFrequency;   // one-way
  // NWR load-factor realism: same spill + weekly-jitter model as passenger
  // routes (see market.js) — freight peaks and directional imbalance are, if
  // anything, worse than pax. Scale is exactly 1 when route.nwrLoadJitter is
  // absent (classic worlds), leaving this line numerically identical.
  const tonnesOneWay   = Math.min(
    demandTonnes * nwrDemandScale(demandTonnes, capacityTonnes, route.nwrLoadJitter),
    capacityTonnes);
  const loadFactor     = capacityTonnes > 0 ? tonnesOneWay / capacityTonnes : 0;

  // Revenue covers both directions, with backhaul imbalance (return leg lighter).
  // Yield is $/tonne-km; tonnes are one-way (headhaul). The imbalance is the
  // LANE's, not a global constant: Shanghai–Los Angeles and Frankfurt–Hong Kong
  // are not the same business (see cargoBackhaulFactor).
  const backhaul = cargoBackhaulFactor(route.origin, route.destination);
  const revenue = Math.round(tonnesOneWay * (1 + backhaul) * dist * yieldPrice);

  // ── Operating costs ──────────────────────────────────────────────────────────
  const flights         = route.weeklyFrequency * 2;
  const aircraftFuelMod = aircraft.fuelMod ?? 1.0;
  const fuelCost  = Math.round(dist * fuelCostPerKm(type) * flights * fuelMultiplier * aircraftFuelMod);
  const crewCost  = Math.round(dist * type.crewCostPerKm * flights * (labor?.seniorityMult ?? 1));
  const groundHandlingCost = Math.round(tonnesOneWay * 2 * CARGO_HANDLING_PER_TONNE);

  const totalOpCost = fuelCost + crewCost + groundHandlingCost;

  return {
    cargo:        true,
    backhaulFactor: backhaul,
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

/**
 * Same-lane cargo demand pooling — the freight analogue of the passenger
 * pre-pass in weeklyTick. Without it, every cargo route on a city pair
 * independently claimed the FULL demand pool, so N freighters on one lane
 * overcounted tonnage N× (the "spam 15 massive aircraft on a single route
 * and you'll still max it out" exploit).
 *
 * Groups ACTIVE cargo routes (aircraft exists, in service, freighter, lane in
 * range — the same eligibility the weekly tick applies) by METRO pair, so a
 * freighter on EWR–LHR and one on JFK–LHR share one New York↔London lane rather
 * than drawing a full market each (measured before: 1.805× on that lane, 2.618×
 * across three member pairs). Unlike passengers, the lane is priced at the
 * strongest SERVED member pair, not the metro primary — freight masses are
 * airport-specific — and cargo carries no per-airport appeal (its cargo scores
 * partly cover that; see docs/METRO_DEMAND_REWORK.md). For lanes with ≥2 routes,
 * the pool is computed ONCE and split by capacity share, with each route's slice
 * scaled by its own yield elasticity:
 *
 *   demand_i = pool × elasticity(yield_i) × (capacity_i / laneCapacity)
 *
 * Summed at identical yields this equals exactly what ONE route computes solo,
 * so total lane tonnage no longer scales with the number of route entries —
 * and a route priced above reference loses tonnage from ITS slice only.
 * Solo lanes are never entered in the map: simulateCargoRoute's own path
 * handles them unchanged (bit-identical to the pre-pooling behaviour).
 *
 * Lane maturity is the MAX weeksOpen across the lane's routes (null = mature,
 * matching simulateCargoRoute's own null handling): forwarders already know an
 * established lane, so adding a freighter joins the mature pool rather than
 * restarting the ramp — and closing/reopening a route can't reset the lane.
 *
 * @param {Array}  cargoRoutes
 * @param {Array}  fleet
 * @param {number} demandMultiplier  awareness multiplier from the weekly tick
 * @returns {Map<string, {demandTonnes:number, laneCapacityTonnes:number, laneRoutes:number}>}
 *          keyed by route.id; ONLY routes on shared lanes appear.
 */
export function cargoLaneAllocations(cargoRoutes = [], fleet = [], demandMultiplier = 1.0, opts = {}) {
  // `groundedIds` — tails that cannot be crewed this week (A7 severe band). They
  // are excluded exactly like a tail in a heavy check: a freighter nobody can fly
  // must not claim lane share it will never carry, which would dilute the routes
  // that DO fly.
  const { gameDate = null, demandMultFor = null, competitors = [], groundedIds = null } = opts;
  const groundedSet = groundedIds instanceof Set ? groundedIds : new Set(groundedIds ?? []);
  const alloc  = new Map();
  const groups = new Map();

  // ── Cross-airline contest ─────────────────────────────────────────────────
  // Freight used to be a monopoly: every airline on a lane drew the whole gravity
  // pool independently, so two carriers on FRA–JFK each banked the full tonnage.
  // Passengers have been contested since the pair-share work; cargo never was.
  // Rival freighter capacity+yield already reach the tick on
  // `state.competitors[].cargoRoutes` (airport-keyed {tonnesPerWeek, yieldPrice}
  // from humanRivals.cargoRoutesOf); fold it into each METRO lane so a rival's
  // capacity dilutes the player's share, weighted by how aggressively it prices —
  // the only lever cargo has. When no rival flies the lane this adds nothing, so
  // a solo (or purely own-fleet) operator's allocation is byte-identical to before.
  const rivalByLane = new Map(); // metroKey → { cap, yieldCapSum }
  for (const c of competitors ?? []) {
    for (const [pairKey, cr] of Object.entries(c?.cargoRoutes ?? {})) {
      const cap = cr?.tonnesPerWeek ?? 0;
      if (!(cap > 0)) continue;
      // cargoRoutesOf keys by the SORTED airport pair; recover the endpoints to
      // roll the rival up to the same metro lane the player's routes group on.
      const [a, b] = String(pairKey).split('-');
      if (!a || !b) continue;
      const mk = metroPairKeyOf(a, b);
      const e = rivalByLane.get(mk) ?? { cap: 0, yieldCapSum: 0 };
      e.cap += cap;
      e.yieldCapSum += (cr.yieldPrice ?? 0) * cap; // capacity-weighted blended yield
      rivalByLane.set(mk, e);
    }
  }
  for (const route of cargoRoutes ?? []) {
    const aircraft = (fleet ?? []).find(a => a.id === route.aircraftId);
    if (!aircraft || isOutOfService(aircraft)) continue;
    if (groundedSet.has(aircraft.id)) continue;   // nobody to crew it this week
    const type = getAircraftType(aircraft.typeId);
    if (!type?.freighter) continue;
    const o = getAirport(route.origin);
    const d = getAirport(route.destination);
    if (!o || !d) continue;
    // A route the aircraft can't fly carries nothing (simulateCargoRoute
    // returns null) — it must not dilute the shares of routes that do fly.
    if (distanceKm(o, d) > effectiveRangeKm(aircraft, type)) continue;
    // Lane = METRO pair (design point 5): a freighter on EWR–LHR and one on
    // JFK–LHR draw the SAME New York↔London freight, exactly as two on JFK–LHR
    // do. For a pair with no metro member this is the ordinary sorted pair key,
    // so every non-metro lane groups as before.
    const rk = metroPairKeyOf(route.origin, route.destination);
    if (!groups.has(rk)) groups.set(rk, []);
    groups.get(rk).push({ route, type });
  }
  for (const [rk, group] of groups) {
    const rivalLane    = rivalByLane.get(rk) ?? null;
    const rivalLaneCap = rivalLane?.cap ?? 0;
    // A lane is contested when the PLAYER flies ≥2 routes on it (own pooling) OR
    // a rival also flies it. A single own route with no rival stays "solo" and
    // simulateCargoRoute's full-pool path handles it exactly as before.
    if (group.length < 2 && !(rivalLaneCap > 0)) continue;
    // Anchor the lane on the strongest SERVED member pair. Freight is NOT like
    // passengers here: cargoCityPairDemand is genuinely airport-specific (cargo
    // scores differ per field — JFK–LHR 1,483 t/wk, EWR–LHR 1,194, EWR–LGW 632),
    // so a metro lane cannot price at the registry primary. An all-Newark lane
    // is Newark's freight; adding JFK to it grows the lane to JFK's. Scored WITH
    // the event multiplier so a closure at the strongest field hands the lane to
    // the next one instead of deleting it, and ties break on the sorted pair key
    // so the anchor never depends on route order. A same-pair lane has exactly
    // one candidate and lands on group[0] — the historical behaviour, unchanged.
    let r0 = null, bestScore = -1, bestKey = null;
    const seenPairs = new Set();
    for (const { route } of group) {
      const key = [route.origin, route.destination].sort().join('-');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const score = cargoCityPairDemand(route.origin, route.destination, gameDate?.month)
                  * (demandMultFor ? demandMultFor(route.origin, route.destination) : 1);
      if (score > bestScore || (score === bestScore && key < bestKey)) {
        r0 = route; bestScore = score; bestKey = key;
      }
    }
    const weeks    = group.map(g => g.route.weeksOpen);
    const maturity = weeks.some(w => w == null) ? 1 : routeMaturityFactor(Math.max(...weeks));
    // Same event exposure the solo path gets — a lane shared by two of your
    // freighters must not be the one place in the world a recession can't reach.
    const laneMult = demandMultiplier
                   * (demandMultFor ? demandMultFor(r0.origin, r0.destination) : 1);
    const pool     = cargoCityPairDemand(r0.origin, r0.destination, gameDate?.month)
                   * maturity * FREIGHTER_CAPTURE_RATE * laneMult;
    const laneCapacity = group.reduce((s, g) => s + g.type.payloadTonnes * g.route.weeklyFrequency, 0);
    if (laneCapacity <= 0) continue;
    // Rival freighter capacity on this metro lane, weighted by how it prices:
    // a rival at reference dilutes with its full capacity; one charging a premium
    // wins less freight and dilutes less; a cut-rate rival dilutes more (elasticity
    // capped at 1.6, exactly as own routes). Judged against the lane anchor's
    // reference yield so own and rival are compared on the same scale. Zero when
    // no rival flies the lane — the own-only denominator, unchanged.
    let rivalWeightedCap = 0;
    if (rivalLaneCap > 0) {
      const rivalYield = rivalLane.yieldCapSum > 0 ? rivalLane.yieldCapSum / rivalLaneCap : 0;
      const anchorRef  = cargoReferenceYield(r0.origin, r0.destination);
      const rivalElast = rivalYield > 0
        ? Math.min(1.6, Math.pow(anchorRef / rivalYield, CARGO_YIELD_ELASTICITY))
        : 1;
      rivalWeightedCap = rivalLaneCap * rivalElast;
    }
    const laneDenominator = laneCapacity + rivalWeightedCap;
    for (const { route, type } of group) {
      const cap        = type.payloadTonnes * route.weeklyFrequency;
      // Elasticity is judged against the route's OWN pair reference — the rate
      // simulateCargoRoute charges it and the planner quotes it. Member pairs of
      // one metro lane sit a stage-length apart and so carry (marginally)
      // different reference yields; scoring each route at its own keeps the
      // invariant exact: every route priced at reference sums back to the lane
      // pool. On a single-pair lane this is the anchor's yield, as before.
      const refYield   = cargoReferenceYield(route.origin, route.destination);
      const yieldPrice = Math.max(0.01, route.yieldPrice ?? refYield);
      const elasticity = Math.min(1.6, Math.pow(refYield / yieldPrice, CARGO_YIELD_ELASTICITY));
      alloc.set(route.id, {
        // Own share of the lane pool: the player's own capacity as a fraction of
        // ALL freighter capacity on the lane (own + yield-weighted rival), then
        // scaled by this route's own price elasticity. With no rival on the lane
        // `laneDenominator === laneCapacity`, so this is the historical value.
        demandTonnes:       pool * elasticity * (cap / laneDenominator),
        laneCapacityTonnes: laneCapacity,
        rivalCapacityTonnes: rivalLaneCap,
        laneRoutes:         group.length,
        contested:          rivalLaneCap > 0,
      });
    }
  }
  return alloc;
}

// ─────────────────────────────────────────────
// LOYALTY PROGRAM MODEL
// ─────────────────────────────────────────────
// Loyalty is a slow-compounding ASSET, not a slider you profit from instantly.
// Three stocks drive it:
//   PENETRATION — share of your own flyers enrolled (members / 4 wks of pax).
//   MATURITY    — 0→1 over ~18 months of continuous funding. New programs are
//                 shallow: a member card means little until members have status,
//                 history and a points balance worth protecting. All demand-side
//                 effects scale with penetration × maturity, so the payoff is
//                 heavily back-loaded even after sign-ups plateau.
//   POINTS LIABILITY — a real balance-sheet debt. Members earn points now (a %
//                 of member revenue accrues to the liability) and redeem them
//                 over the following months as award seats — a genuine cost that
//                 arrives LATER. Breakage (points that expire unused) is where a
//                 well-run program eventually finds its margin.
// Net effect: the program costs real money for its first year-plus and only
// pays for itself once maturity unlocks the full demand shield.

export function loyaltyPenetration(members, weeklyPassengers) {
  if (!weeklyPassengers || weeklyPassengers <= 0) return 0;
  // Capped at 85%: not every flyer can be a member. Anything above the cap is
  // lapsing dead weight (see LOYALTY_HARD_CAP_PEN), not usable penetration.
  return Math.min(0.85, (members ?? 0) / (weeklyPassengers * 4));
}

// Passenger base used for penetration & enrollment ceilings: an 8-week average
// rather than last week's count, so a seasonal dip or route cut doesn't
// instantly inflate penetration (members ÷ tiny pax week = fake 100%).
// Falls back to last week's passengers for old saves without history data.
export function loyaltyPaxBase(state) {
  const hist = (state?.financialHistory ?? [])
    .slice(-8)
    .map(h => h?.passengers ?? 0)
    .filter(v => v > 0);
  const last = state?.lastReport?.totalPassengers ?? 0;
  if (!hist.length) return last;
  return Math.round(hist.reduce((s, v) => s + v, 0) / hist.length);
}

// Not every seat can hold a member — a monthly flyer base is at most ~85%
// enrolled. Members beyond that (people who no longer fly you) lapse at
// ~10%/wk of the excess: status expires when the flying stops.
export const LOYALTY_HARD_CAP_PEN = 0.85;
export const LOYALTY_EXCESS_LAPSE = 0.10;

// Investment tier → program quality. Higher tiers unlock a higher achievable
// penetration CEILING, richer rewards (generosity drives points earn), HIGHER
// EFFECT CAPS (demandCap / sensCap — the reason Elite exists), and faster
// maturity growth (maturityFactor).
export function loyaltyTier(weeklyInvestment) {
  const inv = weeklyInvestment ?? 0;
  if (inv <= 0)        return { label: 'None',   maxPenetration: 0,    generosity: 0,    demandCap: 0,     sensCap: 0,    maturityFactor: 0    };
  if (inv < 100_000)   return { label: 'Basic',  maxPenetration: 0.15, generosity: 0.85, demandCap: 0.05,  sensCap: 0.08, maturityFactor: 0.60 };
  if (inv < 250_000)   return { label: 'Silver', maxPenetration: 0.30, generosity: 1.00, demandCap: 0.075, sensCap: 0.11, maturityFactor: 0.85 };
  if (inv < 500_000)   return { label: 'Gold',   maxPenetration: 0.45, generosity: 1.15, demandCap: 0.10,  sensCap: 0.15, maturityFactor: 1.00 };
  return                      { label: 'Elite',  maxPenetration: 0.60, generosity: 1.30, demandCap: 0.125, sensCap: 0.18, maturityFactor: 1.15 };
}

// Per-week enrollment pull as a fraction of passengers flown, driven by budget.
// Deliberately slow — a program should take the better part of a year to fill,
// not a fiscal quarter.
export function loyaltyEnrollPull(weeklyInvestment) {
  return Math.min(0.12, (weeklyInvestment ?? 0) / 4_000_000);
}

// Maturity growth: 0→1 in ~80 funded weeks at Gold pace (maturityFactor 1.0);
// Elite matures ~15% faster, Basic ~40% slower. Unfunded programs decay in
// ~20 weeks — members drift away far faster than trust was built.
export const LOYALTY_MATURITY_WEEKS = 80;
export const LOYALTY_MATURITY_DECAY = 1 / 20;

// Effective program strength — the single number every demand-side effect keys
// off. A brand-new program delivers only 25% of its penetration's potential;
// full value requires full maturity.
export function loyaltyEffectiveStrength(penetration, maturity) {
  return (penetration ?? 0) * (0.25 + 0.75 * Math.min(1, Math.max(0, maturity ?? 0)));
}

// Demand stability boost (retained price-defectors). Concentrated on hub routes
// by the caller; this is the full hub-route figure. Cap set by tier.
export function loyaltyDemandBoostPct(strength, tier) {
  return Math.min(tier?.demandCap ?? 0.10, 0.25 * (strength ?? 0));
}

// Effective price-sensitivity reduction members confer. Cap set by tier.
export function loyaltyPriceSensitivityReduction(strength, tier) {
  return Math.min(tier?.sensCap ?? 0.15, 0.35 * (strength ?? 0));
}

/**
 * Combined price-sensitivity shield on a player offer: reputation blunts price
 * sensitivity everywhere, loyalty blunts it fully on hub-touching routes and at
 * 40% strength off-hub (frequent flyers are captive at their hub; leisure
 * travellers elsewhere buy on price regardless).
 *
 * Exported because weeklyTick and the client-side share previews must produce
 * the SAME number — when this lived only as a closure inside weeklyTick, the
 * previews silently passed 0 and under-reported the player's share.
 */
export function priceSensitivityReductionFor(repElasticityRed, loyaltyStrength, loyaltyTierNow, hubQ) {
  return Math.max(-0.2, Math.min(0.35,
    (repElasticityRed ?? 0)
    + loyaltyPriceSensitivityReduction(loyaltyStrength, loyaltyTierNow) * (hubQ > 0 ? 1 : 0.4)
  ));
}

/**
 * The same figure, derived straight from a game state — for callers outside the
 * tick (UI previews) that don't have the tick's intermediate loyalty/reputation
 * locals to hand.
 */
export function stateSensReduction(state, hubQ = 0) {
  const loyalty = state.loyalty ?? { weeklyInvestment: 0, members: 0 };
  const strength = loyaltyEffectiveStrength(
    loyaltyPenetration(loyalty.members ?? 0, loyaltyPaxBase(state)),
    loyalty.maturity ?? 0,
  );
  const tier = loyaltyTier(loyalty.effInvestment ?? loyalty.weeklyInvestment ?? 0);
  const avgUtilization = fleetAvgUtilization(state.fleet ?? [],
    [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
  const repInfo = calcReputation(state, loyaltyReputationBonus(strength), avgUtilization);
  return priceSensitivityReductionFor(
    reputationElasticityReduction(repInfo.overall), strength, tier, hubQ);
}

/**
 * Brand reach for a pair, computed from raw state — the preview-side twin of
 * weeklyTick's `brandReachFor`. Share previews (models/pairShare.js) must build
 * the player's offer the same way the tick does; omitting this field would show
 * a brand-new airline the market share of an established one.
 *
 * Rival ad drag is deliberately NOT included here: it depends on competitor
 * marketing spend resolved during the tick, and a preview that guessed at it
 * would disagree with the tick in the other direction. The omission is worth at
 * most COMPETITOR_MKT_MAX_DRAG (5%).
 *
 * @param {object}   state
 * @param {number}   hubQ                hub quality bonus for the pair (0 = off-hub)
 * @param {boolean}  allianceContested   whether an alliance partner contests it
 * @returns {number} ~0.45–1.35, 1 = parity
 */
export function stateBrandReach(state, hubQ = 0, allianceContested = false) {
  const loyalty = state.loyalty ?? { weeklyInvestment: 0, members: 0 };
  const strength = loyaltyEffectiveStrength(
    loyaltyPenetration(loyalty.members ?? 0, loyaltyPaxBase(state)),
    loyalty.maturity ?? 0,
  );
  const tier = loyaltyTier(loyalty.effInvestment ?? loyalty.weeklyInvestment ?? 0);
  const avgUtilization = fleetAvgUtilization(state.fleet ?? [],
    [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
  const repInfo = calcReputation(state, loyaltyReputationBonus(strength), avgUtilization);
  const loyaltyBoostHub = loyaltyDemandBoostPct(strength, tier);
  const loyaltyLift = hubQ > 0 ? loyaltyBoostHub : loyaltyBoostHub * 0.4;
  const allianceLift = allianceContested
    ? (getAlliance(state.allianceMembership?.allianceId)?.demandBoostPct ?? 0)
    : 0;
  return Math.max(0.01,
    awarenessDemandMultiplier(state.awareness ?? 5)
    * reputationDemandMultiplier(repInfo.overall)
    * (1 + loyaltyLift) * (1 + allianceLift));
}

// Brand/reputation bonus: only a deep, MATURE program earns the full +8.
// Full value at strength ≈ 0.40 (e.g. 53% penetration at full maturity).
export function loyaltyReputationBonus(strength) {
  return Math.max(0, Math.min(8, Math.round(8 * ((strength ?? 0) / 0.40))));
}

// ── Points economics ──
// Members earn points worth LOYALTY_EARN_RATE × member-attributable revenue
// (member revenue ≈ total revenue × penetration), scaled by tier generosity.
// That value accrues to the liability. Each week ~LOYALTY_REDEEM_RATE of the
// outstanding liability is drawn down: most becomes award-seat cost on the
// P&L, LOYALTY_BREAKAGE expires unused (free liability relief).
export const LOYALTY_EARN_RATE   = 0.09;   // points value earned / member revenue
export const LOYALTY_REDEEM_RATE = 0.035;  // share of liability drawn per week
export const LOYALTY_BREAKAGE    = 0.20;   // share of drawn points that expire

export function loyaltyPointsFlows(liability, totalRevenue, penetration, generosity) {
  const lia     = Math.max(0, liability ?? 0);
  const earned  = Math.round(Math.max(0, totalRevenue ?? 0) * (penetration ?? 0) * LOYALTY_EARN_RATE * (generosity || 0));
  const drawn   = Math.round(lia * LOYALTY_REDEEM_RATE);
  const expired = Math.round(drawn * LOYALTY_BREAKAGE);
  const redeemedCost = drawn - expired;              // real award-seat cost this week
  const newLiability = Math.max(0, lia + earned - drawn);
  return { earned, redeemedCost, expired, newLiability };
}

// Legacy flat redemption-cost curve — kept only for save-file back-compat
// estimates in old reports; the engine now uses loyaltyPointsFlows.
export function loyaltyPointsCostPct(penetration, generosity) {
  return Math.min(0.04, 0.06 * (penetration ?? 0) * (generosity || 1));
}

// ─────────────────────────────────────────────
// WEEKLY TICK
// ─────────────────────────────────────────────

/**
 * Build the world-event demand model from active events.
 * Returns { globalMult, multFor(origin, dest) } where multFor combines the
 * global demand multiplier with any regional multipliers whose country codes
 * match either endpoint. Used by weeklyTick and by route-planning previews so
 * "what-if" numbers match what the engine will actually book during an event.
 *
 * @param {object[]} [activeEvents]
 * @returns {{ globalMult: number, multFor: (a: string, b: string) => number }}
 */
export function buildEventDemandModel(activeEvents) {
  let   globalMult  = 1.0;
  const regionMults = [];   // [{ codes:Set<country>, mult }]
  for (const ev of activeEvents ?? []) {
    const fx = ev.effects ?? {};
    if (fx.globalDemandMult) globalMult *= fx.globalDemandMult;
    if (fx.regionCodes && fx.regionDemandMult) {
      regionMults.push({ codes: new Set(fx.regionCodes), mult: fx.regionDemandMult });
    }
  }
  const multFor = (a, b) => {
    let m = globalMult;
    if (regionMults.length) {
      const ca = getAirport(a)?.country;
      const cb = getAirport(b)?.country;
      for (const r of regionMults) {
        if (r.codes.has(ca) || r.codes.has(cb)) m *= r.mult;
      }
    }
    return m;
  };
  return { globalMult, multFor };
}

// ─────────────────────────────────────────────
// RESERVE AIRCRAFT (hub-based standby covers)
// ─────────────────────────────────────────────
// Design doc: docs/reserve-aircraft-design.md. Covers are engine-managed
// TEMPORARY transfers: a covered route's aircraftId points at the reserve for
// the duration, with coverForAircraftId remembering the original tail. The
// route markers are the single source of truth — no extra per-aircraft cover
// state — so every existing consumer of route.aircraftId (revenue, wear,
// block hours, hub maintenance factors) follows the covering metal for free.

/** Does this route touch the given airport code (origin, destination, or any tag stop)? */
function routeTouchesAirport(route, code) {
  if (!code) return false;
  if (route.origin === code || route.destination === code) return true;
  return (route.stops ?? []).includes(code);
}

/** Per-month (1-12) weekly block hours for a route — 0 in dormant months. */
function routeMonthlyHours(route, type) {
  const hrs = routeBlockHours(route, type, route.weeklyFrequency);
  return Array.from({ length: 12 }, (_, i) => (isRouteActive(route, i + 1) ? hrs : 0));
}

/**
 * Plan this week's reserve covers. PURE and deterministic: routes needing
 * cover are sorted by last week's revenue (then id), reserves scan in id
 * order, and the first same-type reserve based at an airport the route
 * touches — with block-hour headroom at the per-month peak — takes it.
 *
 * Returns { assignments: [{ routeId, cargo, reserveId, forId }],
 *           gaps: [{ routeId, cargo, forId, revenue, reason }] }.
 * Reasons: 'no-reserve' (no same-type reserve based on the route) or
 * 'hours-full' (a matching reserve exists but its weekly hours are spent).
 */
export function planCovers({ fleet = [], routes = [], cargoRoutes = [], hubs = {}, absWeek = 0, routeRevenues = {} }) {
  const byId = new Map(fleet.map(a => [a.id, a]));

  const need = [
    ...routes.map(r => ({ r, cargo: false })),
    ...cargoRoutes.map(r => ({ r, cargo: true })),
  ].filter(({ r }) => {
    if (r.coverForAircraftId) return false;            // already covered
    const owner = byId.get(r.aircraftId);
    return owner && isOutOfService(owner);
  });
  need.sort((a, b) =>
    (routeRevenues[b.r.id] ?? 0) - (routeRevenues[a.r.id] ?? 0)
    || String(a.r.id).localeCompare(String(b.r.id)));

  // A reserve that is ALREADY OUT ON A COVER is still a reserve. It is
  // 'assigned' while covering (design doc §3), so filtering the pool on
  // status === 'idle' quietly retired every reserve the moment it took its
  // first cover: a second tail breaking down at the same base was told
  // 'no-reserve' while a stationed, same-type spare sat on 9% of its block
  // hours. The design is explicit that one reserve covers several broken tails
  // at once (§4.3, "plus everything R is already covering"), and the monthly
  // ledger below is what makes that safe.
  const allOps = [...routes, ...cargoRoutes];
  const coversFlownBy = new Map();   // reserveId -> routes it is covering right now
  for (const r of allOps) {
    if (!r.coverForAircraftId || !r.aircraftId) continue;
    if (!coversFlownBy.has(r.aircraftId)) coversFlownBy.set(r.aircraftId, []);
    coversFlownBy.get(r.aircraftId).push(r);
  }
  // Spare capacity only: a tail counts as available if everything it flies is a
  // cover. A reserve that was deployed onto a route of its own has had its
  // reserveBase nulled by the reducer, but check anyway rather than trust it.
  const ownRouteCount = (id) => allOps
    .filter(r => r.aircraftId === id && !r.coverForAircraftId).length;

  const reserves = fleet
    .filter(a => a.reserveBase
      && hubs[a.reserveBase] != null
      && a.status !== 'retired'
      && (a.status === 'idle' || coversFlownBy.has(a.id))
      && ownRouteCount(a.id) === 0
      && !isOutOfService(a)
      && !(a.scheduledCheck
           && (a.scheduledCheck.startWeek ?? 0) <= absWeek + RESERVE_NO_DISPATCH_IF_CHECK_WITHIN_WEEKS))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // Monthly block-hour ledger per reserve, SEEDED with the covers it is already
  // flying (an idle one seeds to zero). Without the seed a reserve re-entering
  // the pool would look empty every week and stack itself past the cap.
  const loads = new Map(reserves.map(a => {
    const load = Array(12).fill(0);
    const type = getAircraftType(a.typeId);
    if (type) {
      for (const r of (coversFlownBy.get(a.id) ?? [])) {
        routeMonthlyHours(r, type).forEach((h, i) => { load[i] += h; });
      }
    }
    return [a.id, load];
  }));

  const assignments = [];
  const gaps = [];
  for (const { r, cargo } of need) {
    const broken = byId.get(r.aircraftId);
    let sawTypeMatch = false;
    let placed = false;
    for (const res of reserves) {
      if (res.typeId !== broken.typeId) continue;      // identical-type rule
      if (!routeTouchesAirport(r, res.reserveBase)) continue;
      sawTypeMatch = true;
      const type = getAircraftType(res.typeId);
      if (!type) continue;
      const load  = loads.get(res.id);
      const added = routeMonthlyHours(r, type);
      const peak  = Math.max(...load.map((h, i) => h + added[i]));
      if (peak > MAX_WEEKLY_BLOCK_HOURS + 1e-6) continue;
      added.forEach((h, i) => { load[i] += h; });
      assignments.push({ routeId: r.id, cargo, reserveId: res.id, forId: broken.id });
      placed = true;
      break;
    }
    if (!placed) {
      gaps.push({
        routeId: r.id, cargo, forId: broken.id,
        revenue: routeRevenues[r.id] ?? 0,
        reason:  sawTypeMatch ? 'hours-full' : 'no-reserve',
      });
    }
  }
  return { assignments, gaps };
}

/**
 * The weekly reserve pass: RETURN finished covers, then DISPATCH new ones.
 * Runs at the top of ADVANCE_WEEK (after grounding/check countdowns, before
 * the revenue sim), so a cover starts the first week revenue would have been
 * lost, and routes hand back the same week the original returns.
 *
 * Returns fresh { fleet, routes, cargoRoutes } plus event lists for
 * toasts/debrief: coversStarted / coversEnded / coversPermanent (each grouped
 * per reserve+original) and coverGaps (grouped per broken aircraft).
 */
export function applyReserveCovers({ fleet = [], routes = [], cargoRoutes = [], hubs = {}, absWeek = 0, routeRevenues = {} }) {
  const fl   = fleet.map(a => ({ ...a }));
  const rts  = routes.map(r => ({ ...r }));
  const crts = cargoRoutes.map(r => ({ ...r }));
  const byId = new Map(fl.map(a => [a.id, a]));

  const endedRaw = [];      // { reserveId, forId }
  const permRaw  = [];      // { reserveId, forId }

  // ── 1. Reconcile existing covers ──────────────────────────────────────────
  for (const list of [rts, crts]) {
    for (const r of list) {
      if (!r.coverForAircraftId) continue;
      const orig = byId.get(r.coverForAircraftId);
      const res  = byId.get(r.aircraftId);
      if (!orig) {
        // Original sold/retired/lease-returned → the cover becomes permanent.
        permRaw.push({ reserveId: r.aircraftId, forId: r.coverForAircraftId });
        r.coverForAircraftId = null;
        if (res) res.reserveBase = null;   // it's a line aircraft now
      } else if (!res) {
        // Covering tail vanished (e.g. its lease expired) → hand the routes back.
        endedRaw.push({ reserveId: r.aircraftId, forId: orig.id });
        r.aircraftId = orig.id;
        r.coverForAircraftId = null;
      } else if (!isOutOfService(orig) || isOutOfService(res)) {
        // Original is back in service — or the reserve itself broke down.
        // Either way the routes go home (a re-dispatch below may re-cover them).
        endedRaw.push({ reserveId: res.id, forId: orig.id });
        r.aircraftId = orig.id;
        r.coverForAircraftId = null;
      }
    }
  }
  syncStatuses(fl, rts, crts);

  // ── 2. Dispatch new covers ─────────────────────────────────────────────────
  const { assignments, gaps } = planCovers({ fleet: fl, routes: rts, cargoRoutes: crts, hubs, absWeek, routeRevenues });
  for (const asg of assignments) {
    const r = (asg.cargo ? crts : rts).find(x => x.id === asg.routeId);
    if (!r) continue;
    r.coverForAircraftId = asg.forId;
    r.aircraftId = asg.reserveId;
  }
  syncStatuses(fl, rts, crts);

  // ── 3. Group events for toasts / the Weekly Debrief ───────────────────────
  const nameOf = id => { const a = byId.get(id); return a ? { id, name: a.name, tailNumber: a.tailNumber ?? '' } : { id, name: 'sold aircraft', tailNumber: '' }; };
  const groupPairs = (raw) => {
    const m = new Map();
    for (const e of raw) {
      const k = `${e.reserveId}|${e.forId}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => {
      const [reserveId, forId] = k.split('|');
      return { reserve: nameOf(reserveId), original: nameOf(forId), routes: count };
    });
  };
  const startedPairs = groupPairs(assignments.map(a => ({ reserveId: a.reserveId, forId: a.forId })));
  // Don't announce an "ended" cover that was immediately re-dispatched to the
  // same reserve (reserve fine, original still down — that's a continuation).
  const restartKeys = new Set(assignments.map(a => `${a.reserveId}|${a.forId}`));
  const endedPairs  = groupPairs(endedRaw).filter(e => !restartKeys.has(`${e.reserve.id}|${e.original.id}`));
  const permanentPairs = groupPairs(permRaw);

  const gapsByFor = new Map();
  for (const g of gaps) {
    if (!gapsByFor.has(g.forId)) gapsByFor.set(g.forId, { original: nameOf(g.forId), routes: 0, revenueAtRisk: 0, reasons: new Set() });
    const e = gapsByFor.get(g.forId);
    e.routes += 1;
    e.revenueAtRisk += g.revenue;
    e.reasons.add(g.reason);
  }
  const coverGaps = [...gapsByFor.values()].map(e => ({
    original: e.original, routes: e.routes,
    revenueAtRisk: Math.round(e.revenueAtRisk),
    reason: e.reasons.has('no-reserve') ? 'no-reserve' : 'hours-full',
  }));

  return {
    fleet: fl, routes: rts, cargoRoutes: crts,
    coversStarted: startedPairs, coversEnded: endedPairs,
    coversPermanent: permanentPairs, coverGaps,
  };
}

/**
 * One week of the downtime countdown, exactly as tickPrep runs it at the top of
 * ADVANCE_WEEK. Split out so a PREVIEW can ask "what will be flying next week?"
 * with the tick's own arithmetic instead of a second opinion.
 *
 * The maintenance branch deliberately does NOT run completeCheck() — the
 * outlook only needs to know whether the tail is back in service, not to reset
 * its check ledger.
 */
export function advanceDowntimeOneWeek(a, hasRoute = false) {
  if (!a || a.status === 'retired') return a;
  const stuckGrounded = (a.groundedWeeksLeft ?? 0) > 0
    && a.status !== 'grounded' && a.status !== 'maintenance';
  if (a.status === 'grounded' || stuckGrounded) {
    const left = (a.groundedWeeksLeft ?? 1) - 1;
    return left <= 0
      ? { ...a, status: hasRoute ? 'assigned' : 'idle', groundedWeeksLeft: 0, groundedReason: null }
      : { ...a, status: 'grounded', groundedWeeksLeft: left };
  }
  if (a.status === 'maintenance') {
    const left = (a.checkWeeksLeft ?? 1) - 1;
    return left <= 0
      ? { ...a, status: hasRoute ? 'assigned' : 'idle', checkWeeksLeft: 0 }
      : { ...a, checkWeeksLeft: left };
  }
  return a;
}

/**
 * What the reserve system will DO for each out-of-service tail at the next tick.
 *
 * The Fleet page used to answer this from the route table alone: no route
 * carrying `coverForAircraftId` meant "no cover — N routes idle", flagged the
 * moment any same-type reserve existed anywhere in the fleet. That reading is
 * wrong twice over, and a player caught both in one screenshot (Discord,
 * Knightmare 2026-08-25 — a stationed same-type reserve at the route's own
 * origin, still labelled "no cover"):
 *
 *   1. Covers are DISPATCHED BY THE TICK, and a breakdown is rolled at the END
 *      of the tick. So a tail that broke this week has necessarily not been
 *      covered yet; the cover it is going to get starts next week.
 *   2. A tail on its LAST week of downtime is never covered at all — the
 *      countdown returns it to service before the reserve pass runs, and it
 *      flies its own routes. Nothing is idle, so warning about it is noise.
 *
 * This runs the real pass — countdowns, then applyReserveCovers — against the
 * projected fleet and reports what actually happens, per aircraft id:
 *
 *   coveredNow   routes a reserve is flying for it right now
 *   coversNext   routes a reserve will be flying for it after the next tick
 *   ownRoutes    routes still sitting with the broken tail right now
 *   returning    true when the countdown puts it back in service next tick
 *   reserves     names/ids of the reserves that will cover it
 *   reason       null | 'no-reserve' | 'hours-full' — why any gap is a gap
 *
 * @returns {Object<string, object>} keyed by aircraft id (out-of-service tails only)
 */
export function coverOutlookByAircraft({
  fleet = [], routes = [], cargoRoutes = [], hubs = {}, absWeek = 0, routeRevenues = {},
}) {
  const ops = [...routes, ...cargoRoutes];
  const hasRoute = (id) => ops.some(r => r.aircraftId === id);
  const nextFleet = fleet.map(a => advanceDowntimeOneWeek(a, hasRoute(a.id)));
  const pass = applyReserveCovers({
    fleet: nextFleet, routes, cargoRoutes, hubs, absWeek, routeRevenues,
  });

  const nextById = new Map(nextFleet.map(a => [a.id, a]));
  const nameOf   = (id) => {
    const a = fleet.find(x => x.id === id);
    return a ? (a.name ?? a.tailNumber ?? id) : id;
  };
  const out = {};
  for (const a of fleet) {
    if (!isOutOfService(a)) continue;
    const coveredNow = ops.filter(r => r.coverForAircraftId === a.id).length;
    const ownRoutes  = ops.filter(r => r.aircraftId === a.id).length;
    if (coveredNow === 0 && ownRoutes === 0) continue;   // nothing to say
    const nextOps    = [...pass.routes, ...pass.cargoRoutes];
    const coversNext = nextOps.filter(r => r.coverForAircraftId === a.id);
    const gap        = pass.coverGaps.find(g => g.original?.id === a.id) ?? null;
    out[a.id] = {
      coveredNow,
      ownRoutes,
      coversNext:  coversNext.length,
      returning:   !isOutOfService(nextById.get(a.id) ?? a),
      reserves:    [...new Set(coversNext.map(r => nameOf(r.aircraftId)))],
      reason:      gap?.reason ?? null,
      revenueAtRisk: gap?.revenueAtRisk ?? 0,
    };
  }
  return out;
}

/** Recompute assigned/idle for every in-service tail from the (possibly rewritten) routes. */
function syncStatuses(fl, rts, crts) {
  const assigned = new Set([...rts, ...crts].map(r => r.aircraftId));
  for (const a of fl) {
    if (a.status === 'retired' || isOutOfService(a)) continue;
    a.status = assigned.has(a.id) ? 'assigned' : 'idle';
  }
}

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
    mroBases = {}, absWeek = 0,
    lounges = {}, loungePolicy = null,
    marketingBudget = 0,
    targetedMarketing = {},
    campaignStrength = {},
    loyalty = { weeklyInvestment: 0, members: 0 },
    awareness = 5,
    encroachments = {},
  } = state;

  // ── Seniority (New World Restrictions worlds only) ──────────────────────────
  // Wage scale rises 5%/yr with the AIRLINE's age — never the world calendar, so a
  // player joining a year-17 world starts at x1.00. Falls back to x1 whenever
  // foundedAbsWeek is absent (classic worlds, old saves), so nothing else moves.
  const seniorityMult = state.newWorldRestrictions
    ? seniorityMultiplier(Math.max(0, (absWeek ?? 0) - (state.foundedAbsWeek ?? (absWeek ?? 0))))
    : 1;
  // Threaded to the route sims via the labor object they already receive, so the
  // per-km crew cost inflates with the same scale as the standing payroll.
  const laborWithSeniority = labor ? { ...labor, seniorityMult } : labor;

  // ── Lounges ────────────────────────────────────────────────────────────────
  // Three numbers per route, resolved once here and attached to the route copy
  // handed to the simulators — the same channel hubQualityBonus and brandReach
  // already use, so no simulator signature has to change:
  //
  //   loungeAppeal          business-segment demand multiplier (1 = no lounges)
  //   loungeCoverage        0/0.5/1 — can you sell a day pass on this route
  //   loungeContractFactor  discount on the third-party premium ground contract
  //
  // Resolved from the OPEN lounges only: a fit-out in progress is capex that has
  // bought nothing yet. The alliance is looked up once, not per route.
  const loungeAlliance = state.allianceMembership
    ? getAlliance(state.allianceMembership.allianceId) : null;
  const hasOpenLounge = Object.keys(lounges ?? {}).some(c => isLoungeOpen(lounges[c]));
  // Always attached, never left to the simulators' parity default. Inside the
  // tick, "this airline has no lounges" is a real answer (coverage 0 — no day
  // passes, full contract rate) and must not be confused with "the caller didn't
  // say", which is what the default 1 means for previews and tests.
  //
  // Delegates to the exported stateLoungeFields so the tick and every preview
  // run the SAME code rather than two copies that agree today.
  const loungeState = { lounges, loungePolicy, allianceMembership: state.allianceMembership };
  const loungeFieldsFor = (origin, destination) => stateLoungeFields(loungeState, origin, destination);
  // Non-premium passengers boarded at stations with an open lounge — the pool the
  // free-access policies draw their guests from. Accumulated in the route loops.
  let loungeThroughputPax = 0;
  const loungeStationPax = (origin, destination, classSummary) => {
    if (!hasOpenLounge || !classSummary) return 0;
    const ends = (isLoungeOpen(lounges?.[origin]) ? 1 : 0) + (isLoungeOpen(lounges?.[destination]) ? 1 : 0);
    if (ends === 0) return 0;
    // Economy and premium economy only. Business and first are already paid for
    // on the per-passenger premium ground line, which the contract-factor
    // discount above has just cut for exactly these airports — counting them
    // again here would charge the same passenger twice.
    const nonPremium = (classSummary.economy?.passengers ?? 0)
                     + (classSummary.premiumEconomy?.passengers ?? 0);
    // One-way pax per direction; a passenger uses the lounge at the end where
    // they depart, so `ends` of the two directions are lounge departures.
    return nonPremium * ends;
  };

  // ── Load-factor realism (New World Restrictions worlds only) ────────────────
  // Attaches a per-route, per-week deterministic jitter to every route copy
  // handed to the simulators; its presence switches on the spill-against-ceiling
  // model inside them (see market.js for the full rationale). Keyed on the O&D
  // pair and the absolute week, so every tail on a pooled lane draws the SAME
  // jitter (a per-tail key spread the pool above poolingAnomalies' tolerance and
  // tripped its self-check on every multi-aircraft pair). Returns an empty object
  // in classic worlds, keeping every route copy — and the golden master — untouched.
  const nwrLoadFieldsFor = state.newWorldRestrictions
    ? (r) => ({ nwrLoadJitter: weeklyLoadJitter(`${r.origin}-${r.destination}`, absWeek ?? 0) })
    : () => ({});
  // The yield choke is module-scoped (like the fare index) and normally set by
  // the reducer / providers — but tools and server paths call weeklyTick
  // directly, so pin it from THIS state to make every tick self-consistent.
  setNwrYieldChoke(state.newWorldRestrictions === true);

  // Crew pipeline, severe band: tails with nobody to fly them. Transient for this
  // week only (see tickPrep) — an unstaffed aircraft earns nothing but still costs
  // its lease and maintenance, exactly like one stuck in a heavy check.
  const crewGroundedSet = new Set(state.crewGroundedIds ?? []);

  // Encroachment challengers, keyed by O&D pair, injected into the demand model so
  // they split the route's passenger pool with the player.
  // Multiplayer (Headwinds): state.humanRivals carries OTHER HUMAN PLAYERS'
  // offers per pair in the same spec shape — they flow through the identical
  // channel, so every contested city pair splits demand between real people.
  const humanRivalsByPair = state.humanRivals ?? {};
  const encroachByPair = (pairKey) => {
    const e = encroachments?.[pairKey];
    const humans = humanRivalsByPair[pairKey] ?? [];
    return e ? [e, ...humans] : humans;
  };

  // Price and catering live on the route (O&D pair) in state.routePricing /
  // state.routeCatering — hydrate each route object so the engine reads
  // route.classPrices / route.cateringLevel as before.
  const routePricing  = state.routePricing  ?? {};
  const routeCatering = state.routeCatering ?? {};
  // Airline-wide ancillary policy (null = inactive → zero revenue/cost/quality).
  const ancillaries   = state.ancillaries   ?? null;
  const routes = rawRoutes.map(r => hydrateRoute(r, routePricing, routeCatering));
  // Routes operating THIS month. Dormant seasonal routes must not provide network
  // feed, interline adjacency, or cannibalization while they're out of season.
  const activeRoutes = routes.filter(r => isRouteActive(r, gameDate.month));

  // Average fleet block-hour utilization (pax + cargo schedules): fleets flown
  // near the cap lose punctuality; idle spares buffer the schedule. Feeds the
  // on-time rate via laborEffects(labor, avgUtilization).
  const avgUtilization = fleetAvgUtilization(fleet, [...routes, ...cargoRoutes]);

  // Persistent passenger satisfaction: this week's sims use the CURRENT stat;
  // the post-week value (EWMA toward this week's delivered experience) is
  // returned on the report for the reducer to persist.
  const satisfaction  = state.satisfaction ?? null;
  const deliveredExp  = deliveredExperience({ fleet, routes, labor, ancillaries, lounges }, avgUtilization);
  const satisfactionNext = nextSatisfaction(satisfaction, deliveredExp);

  // Awareness multiplier (adstock model): demand reach derives ONLY from the
  // awareness stock — marketing spend has no instant effect, it builds the
  // stock over time (see GameContext weekly update). 0.4 (unknown) → 1.0 at
  // parity (75) → 1.12 (household name).
  const awarenessMultiplier = awarenessDemandMultiplier(awareness);

  // ── World-event demand shocks ──────────────────────────────────────────────
  // Active events scale the passenger POOL itself (before the market-share
  // fight), so a pandemic scare empties seats and drops load factors instead of
  // skimming booked revenue off the top. Global events hit every pair; regional
  // events (volcanic ash, unrest, expos...) hit only routes touching an affected
  // country. Oversubscribed routes absorb small shocks — demand above capacity
  // buffers them — which is exactly how real fortress routes behave.
  // Spokes per station, computed once for the whole week and handed to every
  // route below. A hub's connectivity bonus is a property of the NETWORK, not
  // of the route asking about it (see computeConnectivityBonus).
  const spokeCounts = hubSpokeCounts(routes);

  const { globalMult: eventGlobalDemandMult, multFor: eventDemandMultFor0 } =
    buildEventDemandModel(state.activeEvents);
  // Multiplayer (Headwinds): a per-world demand multiplier (state.worldDemandMult,
  // set by the admin at world creation) scales the whole passenger POOL so busier
  // worlds can support more surviving airlines. Applied to the per-pair demand
  // function that actually drives bookings; the reported eventGlobalDemandMult
  // stays pure so the Finance "Events ×" chip shows only event shocks. Defaults to
  // 1 → byte-identical to the solo game (state.worldDemandMult is undefined there).
  const worldDemandMult = state.worldDemandMult ?? 1;
  const eventDemandMultFor = worldDemandMult === 1
    ? eventDemandMultFor0
    : (a, b) => eventDemandMultFor0(a, b) * worldDemandMult;

  // Targeted campaign boost per route: strongest campaign at either endpoint
  // (max, not sum — the same seats can't be sold twice). Strength stocks are
  // last week's; GameContext advances them after the tick.
  const campaignBoostFor = (a, b) => campaignDemandBoostPct(
    Math.max(campaignStrength?.[a] ?? 0, campaignStrength?.[b] ?? 0)
  );

  // Share of voice: competitor marketing (hub advertising, station presence,
  // ad blitzes) drags demand on routes touching contested airports. Countering
  // with your own targeted spend reduces the drag.
  const compMktSpend = competitorMarketingSpend(state.competitors ?? []);
  const mktDragCache = {};
  const mktDragAt = (code) => {
    if (!(code in mktDragCache)) {
      const ap = getAirport(code);
      mktDragCache[code] = competitorPressureDrag(
        compMktSpend[code],
        targetedMarketing?.[code],
        ap?.effectivePop ?? ap?.population ?? 1,
      );
    }
    return mktDragCache[code];
  };
  // Net marketing lift for a route (campaign boost minus rival drag; can be negative).
  const netMarketingLift = (boost, drag) => (1 + boost) * (1 - drag) - 1;

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

  // IDs of alliance and codeshare partners. Alliance membership is DYNAMIC:
  // carriers join/leave blocs over time, so partners are read from live
  // competitor state (allianceMembers) rather than the static founding list.
  // Multiplayer (Headwinds): player-founded alliances carry their definition in
  // state.allianceDef (injected by the server, id namespace 'hw:'). Solo games
  // resolve from the static ALLIANCES bank as always.
  const allianceDef         = state.allianceDef
    ?? (allianceMembership ? getAlliance(allianceMembership.allianceId) : null);
  const alliancePartnerIds  = allianceDef ? allianceMembers(allianceDef.id, competitors).map(c => c.id) : [];
  const codesharePartnerIds = codeshareAgreements.map(a => a.competitorId);
  const allPartnerIds       = new Set([...alliancePartnerIds, ...codesharePartnerIds]);

  // One entry per partner (duplicates allowed when multiple partners share a hub airport)
  // — used to boost external connecting feed at airports where partners operate
  const partnerHubCodes = [];
  for (const partnerId of allPartnerIds) {
    const comp = competitors.find(c => c.id === partnerId);
    if (comp?.homeHub) partnerHubCodes.push(comp.homeHub);
  }

  // Build the hubs map, with backward-compat for saves that only have state.hub (a string).
  // Only COMPLETED designations live here — under-construction tiers sit in
  // state.hubConstruction and grant nothing until they finish.
  const hubs = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});

  // Pre-count how many routes the player has at each airport (hub feed, congestion,
  // contest weights). Dormant seasonal routes don't operate this month.
  const routeCountByAirport = {};
  // Slot utilisation: weekly aircraft departures touching each airport. Drives
  // gate congestion (a low-frequency spoke costs far fewer slots than a daily
  // one), while routeCountByAirport still feeds hub contest / feed weighting.
  const slotsByAirport = {};
  for (const r of routes) {
    if (!isRouteActive(r, gameDate.month)) continue;
    const freq = r.weeklyFrequency ?? 7;
    routeCountByAirport[r.origin]      = (routeCountByAirport[r.origin]      ?? 0) + 1;
    routeCountByAirport[r.destination] = (routeCountByAirport[r.destination] ?? 0) + 1;
    slotsByAirport[r.origin]      = (slotsByAirport[r.origin]      ?? 0) + freq;
    slotsByAirport[r.destination] = (slotsByAirport[r.destination] ?? 0) + freq;
  }

  // ── Network O&D cannibalization + itinerary revenue + hub competition ──────
  // Run the full network tick: enumerates 1-stop connections, applies logit
  // diversion when a direct route competes, computes O&D-based partner revenue,
  // own-metal itinerary revenue over designated hubs, and hub contest weights.
  const networkTick = runNetworkTick({
    routes: activeRoutes,
    competitors,
    allianceMembership,
    codeshareAgreements,
    allianceDef,
    gameDate,
    hubs,
    gates,
    routeCountByAirport,
    slotsByAirport,
    demandMultFor: eventDemandMultFor,   // world-event shocks hit itinerary O&Ds too
  });
  const {
    cannibalizationMap, partnerODRevenue, partnerHealthDecay,
    hubContestMap, ownMetalOD,
  } = networkTick;

  // Contest factors for the external connecting pool, keyed by airport.
  const contestFactors = {};
  for (const [code, c] of Object.entries(hubContestMap ?? {})) {
    contestFactors[code] = c.contestFactor;
  }

  // Hub cost efficiency factors for a set of airports a route touches.
  // station: mean of per-endpoint discounts (hub-to-hub gets the full rate);
  // layover: max endpoint (crews based at the hub sleep at home);
  // maint:   best (lowest) factor among T2+ hubs touched.
  const hubCostFactorsFor = (codes) => {
    const defs = codes.map(c => {
      const t = hubs[c]?.tier;
      return t != null ? (HUB_TIERS[t] ?? null) : null;
    });
    const station = defs.reduce((s, d) => s + (d?.stationDiscount ?? 0), 0) / Math.max(1, defs.length);
    const layover = Math.max(0, ...defs.map(d => d?.layoverDiscount ?? 0));
    const maint   = Math.min(1.0, ...defs.map(d => d?.maintFactor ?? 1.0));
    if (station <= 0 && layover <= 0 && maint >= 1.0) return null;
    return { station: +station.toFixed(4), layover, maint };
  };

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
  // scales with member PENETRATION × program MATURITY (see loyalty model above),
  // using last week's passenger count as the base. It is CONCENTRATED on hub
  // routes — where frequent flyers actually have a captive relationship — and
  // diluted on off-hub leisure routes where people buy on price regardless.
  const loyaltyMembers      = loyalty?.members ?? 0;
  const loyaltyPaxSmoothed  = loyaltyPaxBase(state);
  const loyaltyPenet        = loyaltyPenetration(loyaltyMembers, loyaltyPaxSmoothed);
  const loyaltyMaturity     = loyalty?.maturity ?? 0;
  const loyaltyStrength     = loyaltyEffectiveStrength(loyaltyPenet, loyaltyMaturity);
  const loyaltyTierNow      = loyaltyTier(loyalty?.effInvestment ?? loyalty?.weeklyInvestment ?? 0);
  const loyaltyBoostHub     = loyaltyDemandBoostPct(loyaltyStrength, loyaltyTierNow); // full, hub routes
  const loyaltyBoostOffHub  = loyaltyBoostHub * 0.4;                                  // diluted, off-hub
  // Headline multiplier reported to the UI is the hub-route ("up to") figure,
  // consistent with how marketing/awareness lifts are surfaced.
  const loyaltyMultiplier   = 1 + loyaltyBoostHub;

  // Reputation: brand trust nudges demand (±7.5%) and — together with the
  // loyalty program — blunts passengers' price sensitivity. These are the same
  // figures the Reputation page displays; they now actually feed the engine.
  const repInfo          = calcReputation(state, loyaltyReputationBonus(loyaltyStrength), avgUtilization);
  const reputationMult   = reputationDemandMultiplier(repInfo.overall);
  const repElasticityRed = reputationElasticityReduction(repInfo.overall);
  // Combined price-sensitivity reduction for player offers. Loyalty's share is
  // concentrated on hub routes (captive frequent flyers), diluted off-hub.
  // Delegates to the exported helper so the client's share previews compute the
  // identical figure instead of quietly omitting it (see models/pairShare.js).
  const sensReductionFor = (hubQ) =>
    priceSensitivityReductionFor(repElasticityRed, loyaltyStrength, loyaltyTierNow, hubQ);

  // ── Brand reach ────────────────────────────────────────────────────────────
  // Awareness, reputation, the loyalty programme, alliance membership and rival
  // ad pressure, collapsed into ONE demand multiplier that rides into the demand
  // model on the route object — exactly like marketingBoost above it.
  //
  // These five used to be multiplied together as `combinedMult` and applied to
  // route REVENUE, after the share fight and after the capacity cap. That was
  // wrong in three separate ways:
  //
  //   1. It changed no passengers. `passengers`, `loadFactor` and `classSummary`
  //      came back from simulateRoute unboosted while `revenue` was scaled, so
  //      revenue ÷ pax stopped equalling the fare the player had set, per-cabin
  //      revenues stopped summing to the route total, and Finance's yield/RASK
  //      (revenue ÷ RPK) drifted upward year after year on routes nobody had
  //      repriced. A new airline wasn't reaching 45% of the market — it was
  //      quietly selling every seat at 45% of its own ticket price.
  //   2. The payout was largest on routes already at 100% load factor, i.e.
  //      precisely where a stronger brand cannot sell one more seat. The reward
  //      was inverted.
  //   3. The freight path already did it correctly — simulateCargoRoute takes
  //      the same awareness figure as `demandMultiplier` and applies it to
  //      TONNES. One engine, two contradictory meanings for one number.
  //
  // As a demand term it does what it says: on a contested pair an unknown brand
  // loses passengers to its rivals (a log-odds shift in computeUtility), and on
  // a monopoly it loses them to not-flying (a pool multiplier in
  // _monopolyResult). Either way the player now flies emptier aircraft at the
  // fare they set, instead of full aircraft at a fare they never charged.
  //
  // Reputation and loyalty still ALSO blunt price elasticity via
  // sensReductionFor — a separate, deliberate channel (see reputation.js).
  //
  // @param {number}   hubQ   hub quality bonus for the route (0 = off-hub);
  //                          loyalty is concentrated on hub-touching routes.
  // @param {string[]} stops  every airport the route touches — rival ad drag is
  //                          the worst along the whole path, as before.
  // @param {boolean}  allianceContested  whether a partner contests this pair.
  const brandReachFor = (hubQ, stops, allianceContested = false) => {
    const rivalAdDrag = Math.max(0, ...stops.map(mktDragAt));
    const loyaltyLift = hubQ > 0 ? loyaltyBoostHub : loyaltyBoostOffHub;
    const allianceLift = allianceContested ? allianceDemandBoostPct : 0;
    return Math.max(0.01,
      awarenessMultiplier * reputationMult * (1 - rivalAdDrag)
      * (1 + loyaltyLift) * (1 + allianceLift));
  };
  /** Sorted city-pair key, matching partnerContestedKeys / cannibalizationMap. */
  const pairKeyOf = (a, b) => [a, b].sort().join('-');

  // NOTE: no instant marketing multiplier — spend feeds the awareness stock
  // (brand) and campaign-strength stocks (targeted) instead. See overhead.js §9.

  // 1. Route revenue + operating costs
  let totalRevenue        = 0;
  let totalConnecting     = 0;   // connecting REVENUE (own-metal + external feed)
  let totalConnectingPax  = 0;   // connecting PAX (own-metal itineraries + external gateway feed)
  let totalFuel           = 0;
  let totalCrew           = 0;
  let totalQuality        = 0;
  let totalCatering       = 0;   // catering COST
  let totalCateringRevenue = 0;  // ancillary catering REVENUE
  let totalAncillaryRevenue = 0; // à la carte ancillary REVENUE (bags/seats/wifi/…)
  let totalAncillaryCost    = 0; // à la carte ancillary provisioning COST
  let totalGroundHandling = 0;
  let totalLounge         = 0;
  let totalLayover        = 0;
  let totalCompensation   = 0;
  let totalLandingFees    = 0;
  let totalPassengers     = 0;
  let totalHubCostSavings = 0;   // station/layover savings from hub efficiencies (§D)
  const routeResults    = [];
  const hubExternalPax  = {};    // external connecting pax attributed per designated hub
  const aircraftMaintFactor = {};  // aircraftId → hub line-maintenance factor (≤1)

  // (hubs + routeCountByAirport were built above, before the network tick.)

  // ── Pre-pass: aggregate player demand per O&D pair ───────────────────────────
  // When multiple aircraft share the same origin–destination pair each
  // simulateRoute call would independently claim the full market share,
  // overcounting passengers by N×.  Instead, build ONE combined player offer
  // per route group, compute market share once, then split pax proportionally
  // by each aircraft's seat contribution.
  // Keyed by ROUTE id — NOT aircraft id. One aircraft may fly several routes
  // (e.g. a shared JFK-DEN pair plus solo JFK-RDU / JFK-CHS); keying by
  // aircraft id leaked the shared pair's per-aircraft slice into the SAME
  // aircraft's OTHER routes, capping their pax at the wrong pair's share
  // (identical low load factors on unrelated routes).
  const demandAllocations = new Map(); // routeId → demandResult override
  // `${routeId}|${pairKey}` → { ecoDemand, bizDemand } for a tag route's slice
  // of a pair it shares with other player metal.
  const tagSegmentDemand  = new Map();

  {
    // Group active routes by sorted routeKey. A tag route joins a group ONCE
    // PER SEGMENT: its JFK–ORD leg competes on the JFK–ORD pair exactly like a
    // nonstop does, and leaving it out ("tag routes self-contain their O&D
    // split") let a tag segment and a nonstop on the same pair EACH draw the
    // full demand pool — measured at 1.74x the whole market, all of it booked
    // as real revenue, from nothing but restating one route as two.
    const routeGroups = new Map(); // routeKey → [{ route, aircraft, seg? }]
    for (const route of routes) {
      const aircraft = fleet.find(a => a.id === route.aircraftId);
      if (!aircraft || isOutOfService(aircraft)) continue;
      if (!isRouteActive(route, gameDate.month)) continue;   // dormant this month
      if (isMultiStop(route)) {
        for (const seg of routeSegments(route)) {
          const rk = [seg.from, seg.to].sort().join('-');
          if (!routeGroups.has(rk)) routeGroups.set(rk, []);
          routeGroups.get(rk).push({ route, aircraft, seg });
        }
        continue;
      }
      const rk = [route.origin, route.destination].sort().join('-');
      if (!routeGroups.has(rk)) routeGroups.set(rk, []);
      routeGroups.get(rk).push({ route, aircraft });
    }

    // Lanes: one share fight per METRO pair, not per airport pair.
    //
    // data/metros.js prices every member pair of a metro pair at the same metro
    // total — New York↔London is one market however you fly it. Grouping the
    // share fight by AIRPORT pair then handed that whole market to each member
    // pair separately, so a player flying JFK–LHR and EWR–LHR drew it twice
    // (measured: 2,716 pax against 1,358 for the same metal on one pair), and a
    // rival on a sibling airport was invisible (1,358 contested vs 1,358 alone).
    // That is the duplication the metro rework set out to kill; pricing was
    // pooled, the share fight was not.
    //
    // Within a lane the player gets one offer PER MEMBER PAIR SERVED — your JFK
    // and EWR services are genuinely different products competing for the same
    // travellers — and every member pair is scanned for rivals.
    const lanes = new Map(); // laneKey → [pairKey, ...]
    for (const pk of routeGroups.keys()) {
      const [a, b] = pk.split('-');
      const laneKey = metroPairKeyOf(a, b);
      if (!lanes.has(laneKey)) lanes.set(laneKey, []);
      lanes.get(laneKey).push(pk);
    }

    for (const [, pairKeys] of lanes) {
      // Rivals across EVERY member pair of the lane, deduped per pair the same
      // way the single-aircraft path does.
      const firstPair = pairKeys[0].split('-');
      const laneMemberKeys = memberPairKeysOf(firstPair[0], firstPair[1]);
      const servedByPlayer = new Set(pairKeys);

      // Does anything actually need pooling here? A lone route whose only
      // rivals sit on its own pair keeps the historical solo path, byte for
      // byte — simulateRoute runs exactly the fight it always did.
      const presences = pairKeys.reduce(
        (n, pk) => n + new Set((routeGroups.get(pk) ?? []).map(g => g.route.id)).size, 0);
      const siblingRivalKeys = laneMemberKeys.filter(k => !servedByPlayer.has(k));
      const hasSiblingRivals = siblingRivalKeys.some(k =>
        (encroachByPair(k) ?? []).length > 0
        || (competitors ?? []).some(c => c?.routes?.[k]));
      if (presences < 2 && !hasSiblingRivals) continue;

      const subs = [];
      for (const pairKey of pairKeys) {
        const group = routeGroups.get(pairKey);
        if (!group || group.length === 0) continue;
        // Pair orientation and pricing anchor: prefer a nonstop member (its
        // routePricing governs the pair); an all-tag group anchors on its first
        // segment.
        const anchor = group.find(g => !g.seg) ?? group[0];
        const { route: r0 } = anchor;
        const pairO = anchor.seg?.from ?? r0.origin;
        const pairD = anchor.seg?.to   ?? r0.destination;
        // Lane maturity is the OLDEST route on the pair, not group[0] — the market
        // has known the service as long as the longest-serving tail has flown it.
        // Array order made this the oldest route by luck (routes are appended in
        // creation order) right up until someone closed the founding route and
        // reopened it, which silently re-ramped the whole lane. Matches the
        // documented cargo rule (lane maturity = MAX weeksOpen) and pairShare.
        const laneWeeksOpen = group.reduce(
          (m, g) => Math.max(m, g.route.weeksOpen ?? 0), 0);
        const maturity = group.some(g => g.route.weeksOpen != null)
          ? routeMaturityFactor(laneWeeksOpen) : 1;
        const market   = buildRouteMarket(pairO, pairD, gameDate, maturity,
          eventDemandMultFor(pairO, pairD));

        // Pair-level bonuses (same as the single-aircraft simulateRoute path):
        // hub investment, catering (distance-amplified), ground staff. Previously
        // the combined offer used ONLY the raw quality score — multi-aircraft
        // routes silently lost up to ~30 pts of space/catering/ground/hub quality
        // and the reputation/loyalty price-sensitivity shield in the share fight.
        const groupDist   = routeDistanceKm(pairO, pairD);
        const groupHubQ   = Math.max(
          hubs[pairO]?.tier      ? (HUB_TIERS[hubs[pairO].tier]?.qualityBonus      ?? 0) : 0,
          hubs[pairD]?.tier ? (HUB_TIERS[hubs[pairD].tier]?.qualityBonus ?? 0) : 0,
        );
        const fx = laborEffects(labor, avgUtilization, satisfaction);
        // Lounge context for the pair — identical for every tail in the group,
        // because it is a property of the two airports, not of the metal.
        const groupLounge = loungeFieldsFor(pairO, pairD);

        // Aggregate capacity across all aircraft in the group
        let totalEcoSeats = 0;
        let totalBizSeats = 0;
        let totalSeatsAll = 0; // ALL cabins (incl. premium economy / first) × freq
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
          totalSeatsAll += configBodies(cfg) * freq;
          totalFreq     += freq;
          const raw = computeQualityScore({
            onTimeRate:    fx.onTimeRate,
            cabinPoints:   cabinQualityPoints(cfg),
            fleetAgeYears: (aircraft.ageWeeks ?? 0) / 52,
            customerRating: fx.customerRating,
          });
          // Full per-aircraft quality with every bonus simulateRoute applies —
          // including this tail's OWN Wi-Fi equipage. Averaging the per-aircraft
          // figures (rather than scoring the group once at blended coverage) is
          // what makes an unfitted tail on a shared pair drag the pair's quality
          // in proportion to how much of the schedule it flies.
          totalQuality += Math.max(0, Math.min(100,
            raw + fx.groundQualityBonus
            + configSpaceQualityBonus(cfg, type)
            + cateringQualityBonus(normalizeCateringLevel(route.cateringLevel), groupDist)
            + ancillaryQualityBonus(ancillaries, 0, {
                wifi:   wifiCoverageFor(aircraft),
                lounge: groupLounge.loungeCoverage,
              })
            + groupHubQ));
          if (biz > 0) hasBusinessCabin = true;
        }

        const avgQuality = Math.round(totalQuality / group.length);
        // Fares, member-aware: nonstop members all fly the pair's stored fares
        // (routePricing is per-pair), a tag member flies its own segment fare.
        // Seat-weight the group's economy fare so a mixed group's offer is priced
        // at what its seats actually sell for — for an all-nonstop group every
        // member price is identical and this is exactly the old single read.
        const memberEcoPrice = (g) => {
          if (g.seg) {
            const sp = g.route.segmentPrices?.[routeSegmentKey(g.seg.from, g.seg.to)];
            return Math.max(1, sp?.economy ?? market.referencePrice);
          }
          const cp = g.route.classPrices ?? {};
          return Math.max(1, cp.economy ?? g.route.ticketPrice ?? 1);
        };
        let ecoPriceWeighted = 0, ecoPriceSeats = 0;
        for (const g of group) {
          const t = getAircraftType(g.aircraft.typeId);
          if (!t) continue;
          const c = g.aircraft.config ?? defaultConfig(t.seats);
          const seats = (c.economy ?? t.seats) * (g.route.weeklyFrequency ?? 7);
          ecoPriceWeighted += memberEcoPrice(g) * seats;
          ecoPriceSeats    += seats;
        }
        const cp0 = r0.classPrices ?? {};
        const ecoPrice = ecoPriceSeats > 0
          ? Math.max(1, Math.round(ecoPriceWeighted / ecoPriceSeats))
          : Math.max(1, cp0.economy ?? r0.ticketPrice ?? 1);
        const bizPrice = hasBusinessCabin && cp0.businessClass != null
          ? Math.max(1, cp0.businessClass)
          : null;  // match single-aircraft path (no implicit 3.5x biz fare)
        const connBonus = computeConnectivityBonus(
          r0.hub, pairO, pairD, spokeCounts[r0.hub] ?? 0);

        const combinedOffer = {
          airlineId:         'player',
          origin:            pairO,
          destination:       pairD,
          economyPrice:      ecoPrice,
          businessPrice:     bizPrice,
          weeklyFrequency:   totalFreq,
          seatsPerFlight:    totalFreq > 0 ? Math.round((totalEcoSeats + totalBizSeats) / totalFreq) : 0,
          economySeats:      totalEcoSeats,
          businessSeats:     totalBizSeats,
          totalSeats:        totalSeatsAll,
          qualityScore:      avgQuality,
          connectivityBonus: connBonus,
          // Reputation/loyalty price-sensitivity shield — same as single-aircraft
          // routes get via sensReductionFor (was: always 0 for grouped routes).
          priceSensitivityReduction: sensReductionFor(groupHubQ),
          // Same targeted-campaign term the single-aircraft path gets.
          marketingBoost: campaignBoostFor(pairO, pairD),
          // Same brand-reach term too. The pooled demand this offer produces is
          // handed straight to each aircraft as a demandOverride, so omitting it
          // here would exempt every multi-aircraft route from the brand model.
          brandReach: brandReachFor(groupHubQ, [pairO, pairD],
            partnerContestedKeys.has(pairKeyOf(pairO, pairD))),
          // And the same lounge term. The pooled demand this offer produces is
          // handed straight to each aircraft as a demandOverride, so omitting it
          // here would exempt every multi-aircraft route from the lounge model —
          // exactly the hole brandReach fell into on this code path.
          loungeAppeal: groupLounge.loungeAppeal,
        };


        subs.push({ group, offer: combinedOffer, market, totalEcoSeats, totalBizSeats });
      }
      if (subs.length === 0) continue;

      // One market for the lane — every member pair prices identically by
      // construction, so the first sub-offer's is the lane's.
      const laneMarket = subs[0].market;
      const laneRivalOffers = [];
      for (const k of laneMemberKeys) {
        const [ka, kb] = k.split('-');
        const kMarket = k === pairKeys[0] ? laneMarket
          : buildRouteMarket(ka, kb, gameDate, laneMarket.maturityFactor,
              eventDemandMultFor(ka, kb));
        laneRivalOffers.push(...rivalOffersFor(
          (competitors ?? []).filter(c => c?.routes?.[k]), encroachByPair(k), kMarket));
      }

      const laneResults = computeMarketShare(
        laneMarket, [...subs.map(s => s.offer), ...laneRivalOffers]);

      for (let si = 0; si < subs.length; si++) {
        const { group, totalEcoSeats, totalBizSeats } = subs[si];
        const combinedResult = laneResults[si];
        // Distribute pax to each member proportionally by seat share. Nonstop
        // members take a demandOverride into simulateRoute exactly as before; a
        // tag member's slice is recorded per SEGMENT and handed to
        // simulateTagRoute, which then skips its own (whole-pool) share fight for
        // that segment.
        for (const g of group) {
          const { route, aircraft, seg } = g;
          const type = getAircraftType(aircraft.typeId);
          if (!type) continue;
          const cfg  = aircraft.config ?? defaultConfig(type.seats);
          const freq = route.weeklyFrequency ?? 7;
          const eco  = (cfg.economy ?? type.seats) * freq;
          const biz  = (cfg.businessClass ?? 0) * freq;
          const ecoFrac = totalEcoSeats > 0 ? eco / totalEcoSeats : 1 / group.length;
          const bizFrac = totalBizSeats > 0 ? biz / totalBizSeats : 1 / group.length;

          if (seg) {
            tagSegmentDemand.set(`${route.id}|${[seg.from, seg.to].sort().join('-')}`, {
              ecoDemand: Math.round((combinedResult.leisurePaxUncapped ?? combinedResult.leisurePax) * ecoFrac),
              bizDemand: Math.round((combinedResult.businessPaxUncapped ?? combinedResult.businessPax) * bizFrac),
            });
            continue;
          }

          demandAllocations.set(route.id, {
            leisurePax:      Math.round(combinedResult.leisurePax  * ecoFrac),
            businessPax:     Math.round(combinedResult.businessPax * bizFrac),
            // Pre-cap demand rides along so the load models downstream see the
            // demand the market generated, not the seat count (see simulateRoute).
            leisurePaxUncapped:  Math.round((combinedResult.leisurePaxUncapped ?? combinedResult.leisurePax) * ecoFrac),
            businessPaxUncapped: Math.round((combinedResult.businessPaxUncapped ?? combinedResult.businessPax) * bizFrac),
            economyRevenue:  Math.round(combinedResult.economyRevenue  * ecoFrac),
            businessRevenue: Math.round(combinedResult.businessRevenue * bizFrac),
            leisureShare:    combinedResult.leisureShare,
            businessShare:   combinedResult.businessShare,
            capacityCapped:  combinedResult.capacityCapped,
          });
        }
      }
    }

    }
  // ── End pre-pass ─────────────────────────────────────────────────────────────

  for (const route of routes) {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    if (!aircraft) continue;
    if (isOutOfService(aircraft)) continue; // grounded or in a heavy check — no revenue this week
    if (crewGroundedSet.has(aircraft.id)) continue; // nobody to crew it this week
    if (!isRouteActive(route, gameDate.month)) continue; // seasonal route dormant this month

    // ── Tag (multi-stop) route: self-contained O&D split via simulateTagRoute ──
    // It already returns blended revenue/costs across all legs & segments. We
    // apply the same demand multipliers and per-airport landing fees, but skip
    // the single-leg connecting-demand model (tag/network feed is a later phase).
    if (isMultiStop(route)) {
      const stopsList = routeStops(route);
      // NOTE: tier 0 (Focus City) is a valid designation — check != null, not truthy.
      const tagHubQuality = Math.max(0, ...stopsList.map(c => {
        const t = hubs[c]?.tier;
        return t != null ? (HUB_TIERS[t]?.qualityBonus ?? 0) : 0;
      }));
      // Fortress bonus: an International Gateway (T3) the player dominates (>60%
      // share of connecting weight) grants +2 quality and blunted price sensitivity.
      const tagFortress = stopsList.some(c =>
        hubs[c]?.tier === 3 && (hubContestMap?.[c]?.playerShare ?? 0) > 0.6
      );
      const tagHcf = hubCostFactorsFor(stopsList);
      // Strongest campaign among ALL stops on a tag route, and the heaviest rival
      // marketing drag along the way. Same split as single-leg routes: YOUR
      // campaign rides into the demand model on the route object, rivals' ad
      // pressure stays a drag on the revenue multiplier.
      const tagCampaignBoost = campaignDemandBoostPct(
        Math.max(0, ...stopsList.map(c => campaignStrength?.[c] ?? 0)));
      const tagRivalAdDrag   = Math.max(0, ...stopsList.map(mktDragAt));
      const tagRoute = {
        ...route,
        hubSpokes: spokeCounts[route.hub] ?? 0,
        ...(tagHubQuality + (tagFortress ? 2 : 0) > 0
          ? { hubQualityBonus: tagHubQuality + (tagFortress ? 2 : 0) } : {}),
        priceSensitivityReduction: Math.min(0.40,
          sensReductionFor(tagHubQuality) + (tagFortress ? 0.05 : 0)),
        marketingBoost: tagCampaignBoost,
        // Brand reach across every stop on the tag route. No alliance term:
        // partnerContestedKeys is keyed by single city pairs, and a multi-stop
        // rotation isn't one — same omission the old combinedMult made here.
        brandReach: brandReachFor(tagHubQuality, stopsList, false),
        // Lounges on the rotation's TRUE endpoints. The intermediate stops are a
        // technical stop for most of the people on board, and a lounge there is
        // not what sold them the ticket.
        ...loungeFieldsFor(route.origin, route.destination),
        ...(tagHcf ? { hubCostFactors: tagHcf } : {}),
        ...nwrLoadFieldsFor(route),
      };
      const result = simulateTagRoute(tagRoute, aircraft, gameDate, laborWithSeniority, fuelMultiplier, avgUtilization, satisfaction, eventDemandMultFor, ancillaries, competitors, encroachByPair,
        (segKey) => tagSegmentDemand.get(`${route.id}|${segKey}`) ?? null);
      if (!result) continue;

      const cateringRev    = result.cateringRevenue ?? 0;
      const ancillaryRev   = result.ancillaryRevenue ?? 0;
      // Loyalty boost is concentrated on hub-touching routes.
      const tagLoyaltyBoost = tagHubQuality > 0 ? loyaltyBoostHub : loyaltyBoostOffHub;
      const tagMarketingLift = netMarketingLift(tagCampaignBoost, tagRivalAdDrag);
      // Brand and campaign are both already inside result.revenue — they went
      // through the demand model on tagRoute.brandReach / .marketingBoost and
      // sold real seats at the real fare. Nothing is applied on top here.
      const routeRevenue   = result.revenue;   // no simple connecting add for tag routes

      const type       = getAircraftType(aircraft.typeId);
      const landingFee = routeLandingFee(route, type, route.weeklyFrequency);

      totalRevenue        += routeRevenue;
      totalFuel           += result.fuelCost;
      totalCrew           += result.crewCost;
      totalQuality        += result.qualityCost;
      totalCatering        += result.cateringCost      ?? 0;
      totalCateringRevenue += cateringRev;
      totalAncillaryRevenue += ancillaryRev;
      totalAncillaryCost    += result.ancillaryCost    ?? 0;
      totalGroundHandling += result.groundHandlingCost ?? 0;
      totalLounge         += result.loungeCost         ?? 0;
      totalLayover        += result.layoverCost        ?? 0;
      totalCompensation   += result.compensationCost   ?? 0;
      totalLandingFees    += landingFee;
      totalPassengers     += result.passengers ?? 0;

      // Hub line-maintenance: routes touching a T2+ hub get discounted maintenance.
      aircraftMaintFactor[aircraft.id] = Math.min(aircraftMaintFactor[aircraft.id] ?? 1.0, tagHcf?.maint ?? 1.0);
      const { maintenanceCostMultiplier } = laborEffects(labor);
      const weeklyLeaseCost = aircraft.ownershipType === 'owned' ? 0
        : (aircraft.weeklyLease ?? type?.weeklyLease ?? 0);
      const weeklyMaintCost = Math.round(
        (type?.baseMaintenancePerWk ?? 0)
        * maintenanceMultiplier(effectiveMaintAgeWeeks(aircraft))
        * maintenanceBudget * maintenanceCostMultiplier * (aircraft.maintMod ?? 1.0)
        * (tagHcf?.maint ?? 1.0)
      );
      totalHubCostSavings += result.hubCostSavings ?? 0;

      routeResults.push({
        routeId: route.id,
        ...result,
        revenue:       routeRevenue,
        marketingLift: Math.round(result.revenue * (tagMarketingLift / (1 + tagMarketingLift))),
        loyaltyLift:   Math.round(result.revenue * (tagLoyaltyBoost / (1 + tagLoyaltyBoost))),
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

    // Inject hub quality bonus from the best hub on this route.
    // Tier 0 (Focus City) is a valid designation — compare against null, not truthy.
    const originTier  = hubs[route.origin]?.tier;
    const destTier    = hubs[route.destination]?.tier;
    let hubQuality  = Math.max(
      originTier != null ? (HUB_TIERS[originTier]?.qualityBonus ?? 0) : 0,
      destTier   != null ? (HUB_TIERS[destTier]?.qualityBonus   ?? 0) : 0,
    );
    // Fortress bonus: a dominated (>60% share) International Gateway grants
    // +2 quality and +0.05 price-sensitivity reduction on routes touching it.
    const fortress =
      (originTier === 3 && (hubContestMap?.[route.origin]?.playerShare      ?? 0) > 0.6) ||
      (destTier   === 3 && (hubContestMap?.[route.destination]?.playerShare ?? 0) > 0.6);
    if (fortress) hubQuality += 2;
    const hcfRoute = hubCostFactorsFor([route.origin, route.destination]);
    const routeWithHubBonus = {
      ...route,
      hubSpokes: spokeCounts[route.hub] ?? 0,
      ...(hubQuality > 0 ? { hubQualityBonus: hubQuality } : {}),
      priceSensitivityReduction: Math.min(0.40,
        sensReductionFor(hubQuality) + (fortress ? 0.05 : 0)),
      // Targeted campaign strength at either endpoint, ridden into the demand
      // model rather than multiplied onto revenue afterwards (see the
      // marketingLift note below).
      marketingBoost: campaignBoostFor(route.origin, route.destination),
      // Awareness / reputation / loyalty / alliance / rival ad drag, ridden in
      // the same way for the same reason (see brandReachFor).
      brandReach: brandReachFor(hubQuality,
        [route.origin, route.destination],
        partnerContestedKeys.has(pairKeyOf(route.origin, route.destination))),
      // Lounge appeal (business segment), day-pass coverage and the premium
      // ground-contract discount. Spread conditionally so a game with no lounges
      // produces a byte-identical route object and the golden master is unmoved.
      ...loungeFieldsFor(route.origin, route.destination),
      ...(hcfRoute ? { hubCostFactors: hcfRoute } : {}),
      ...nwrLoadFieldsFor(route),
    };

    const rkRoute = [route.origin, route.destination].sort().join('-');
    const result = simulateRoute(routeWithHubBonus, aircraft, gameDate, laborWithSeniority, fuelMultiplier,
      demandAllocations.get(route.id) ?? null, encroachByPair(rkRoute), avgUtilization, satisfaction,
      eventDemandMultFor(route.origin, route.destination), ancillaries, competitors);
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
    // EXTERNAL feed only (residual gateway/partner pool) — the internal feed is
    // now real itineraries from network.js (ownMetalOD), added below.
    const connectingRaw = computeConnectingDemand(
      route.origin,
      route.destination,
      hubs,
      slotsByAirport[route.origin]      ?? 0,
      slotsByAirport[route.destination] ?? 0,
      connectingPrice,
      { weeklyFrequency: route.weeklyFrequency ?? 7, partnerHubCodes, gates, contestFactors },
    );
    const routeKey     = [route.origin, route.destination].sort().join('-');
    // Cannibalization multiplier applies ONLY to the residual external pool —
    // own-metal itineraries handle direct-route competition inside the market
    // model (conn.connectionShare), so applying it there would double-count.
    const cannibFactor = Math.min(1.0, cannibalizationMap[routeKey] ?? 1.0);
    // External connecting feed rides the same world-event demand shock as the
    // local O&D pool — fewer people flying means fewer people connecting.
    const evConnMult   = eventDemandMultFor(route.origin, route.destination);
    let   extPax       = Math.round(connectingRaw.totalPax     * cannibFactor * evConnMult);
    let   extRevenue   = Math.round(connectingRaw.totalRevenue * cannibFactor * evConnMult);

    // Own-metal itinerary feed on this leg (competition/congestion-adjusted upstream).
    const ownMetalLeg = ownMetalOD?.byRouteKey?.[routeKey] ?? null;
    let   itinPax     = ownMetalLeg?.pax     ?? 0;
    let   itinRevenue = ownMetalLeg?.revenue ?? 0;

    // Capacity coupling: connecting passengers occupy real seats. Cap combined
    // connecting pax by the seats left after direct passengers board (5% ops buffer).
    const seatHeadroom = Math.max(0,
      Math.round((result.configuredSeatsOneWay ?? 0) * 0.95) - (result.passengers ?? 0));
    const wantPax  = extPax + itinPax;
    const capScale = wantPax > seatHeadroom && wantPax > 0 ? seatHeadroom / wantPax : 1;
    if (capScale < 1) {
      extPax      = Math.round(extPax      * capScale);
      extRevenue  = Math.round(extRevenue  * capScale);
      itinPax     = Math.round(itinPax     * capScale);
      itinRevenue = Math.round(itinRevenue * capScale);
    }

    const connecting = {
      totalPax:         extPax + itinPax,
      totalRevenue:     extRevenue + itinRevenue,
      externalPax:      extPax,
      externalRevenue:  extRevenue,
      itineraryPax:     itinPax,
      itineraryRevenue: itinRevenue,
      feeds:            ownMetalLeg?.feeds ?? [],   // top O&D markets feeding this leg
      origin:           connectingRaw.origin,
      destination:      connectingRaw.destination,
      priceFactor:      connectingRaw.priceFactor,
      cannibalizationFactor: +cannibFactor.toFixed(3),
      capacityScale:         +capScale.toFixed(3),
    };

    // Hub throughput accounting (T3 prerequisite + HubManagement UI): attribute
    // external feed to designated endpoints proportional to the raw endpoint split.
    {
      const rawO  = connectingRaw.origin?.pax      ?? 0;
      const rawD  = connectingRaw.destination?.pax ?? 0;
      const denom = rawO + rawD;
      if (denom > 0 && extPax > 0) {
        if (originTier != null) hubExternalPax[route.origin] =
          (hubExternalPax[route.origin] ?? 0) + Math.round(extPax * rawO / denom);
        if (destTier != null) hubExternalPax[route.destination] =
          (hubExternalPax[route.destination] ?? 0) + Math.round(extPax * rawD / denom);
      }
    }
    const allianceLift   = partnerContestedKeys.has(routeKey) ? allianceDemandBoostPct : 0;
    // Marketing is now SPLIT across two mechanisms, and each is applied exactly once:
    //
    //   your campaign  → routeWithHubBonus.marketingBoost → the demand model
    //     (a utility term on contested pairs, a pool multiplier on monopolies).
    //     It used to live here as a flat revenue multiplier applied AFTER the
    //     share fight, which is why a player could outspend every rival at both
    //     endpoints and watch their market share refuse to move.
    //   rivals' ad pressure → still a straight demand drag here. It is noise in
    //     the market, not a lever the passenger-allocation model can act on.
    //
    const rivalAdDrag    = Math.max(mktDragAt(route.origin), mktDragAt(route.destination));
    const campaignBoost  = campaignBoostFor(route.origin, route.destination);
    // Reported net lift (campaign minus rival pressure) — display only; the
    // campaign half is already inside result.revenue via the demand model.
    const marketingLift  = netMarketingLift(campaignBoost, rivalAdDrag);
    // Loyalty boost concentrated on hub-touching routes, diluted elsewhere.
    const loyaltyLift    = hubQuality > 0 ? loyaltyBoostHub : loyaltyBoostOffHub;
    // No multiplier is applied here any more. Brand reach and the campaign both
    // rode into the demand model on routeWithHubBonus and have already decided
    // how many people booked; result.revenue is those passengers at the fare the
    // player set. Catering and ancillaries no longer need stripping out and
    // adding back either — nothing is being scaled, so nothing can double-count.
    // (They are still broken out below for the revenue-mix totals.)
    const cateringRev    = result.cateringRevenue ?? 0;
    const ancillaryRev   = result.ancillaryRevenue ?? 0;
    const routeRevenue   = result.revenue + connecting.totalRevenue;

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
    totalConnectingPax  += connecting.totalPax ?? 0;
    totalFuel           += result.fuelCost;
    totalCrew           += result.crewCost;
    totalQuality        += result.qualityCost;
    totalCatering        += result.cateringCost       ?? 0;
    totalCateringRevenue += cateringRev;
    totalAncillaryRevenue += ancillaryRev;
    totalAncillaryCost    += result.ancillaryCost     ?? 0;
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
    // Hub line-maintenance: routes touching a T2+ hub get discounted maintenance.
    aircraftMaintFactor[aircraft.id] = Math.min(aircraftMaintFactor[aircraft.id] ?? 1.0, hcfRoute?.maint ?? 1.0);
    totalHubCostSavings += result.hubCostSavings ?? 0;
    const { maintenanceCostMultiplier } = laborEffects(labor);
    const weeklyLeaseCost  = aircraft.ownershipType === 'owned' ? 0
      : (aircraft.weeklyLease ?? acType?.weeklyLease ?? 0);
    const weeklyMaintCost  = Math.round(
      (acType?.baseMaintenancePerWk ?? 0)
      * maintenanceMultiplier(effectiveMaintAgeWeeks(aircraft))
      * maintenanceBudget
      * maintenanceCostMultiplier
      * (aircraft.maintMod ?? 1.0)
      * (hcfRoute?.maint ?? 1.0)
    );

    routeResults.push({
      routeId: route.id,
      ...result,
      revenue:          routeRevenue,
      // Revenue attributable to each brand lever. All of these are now INSIDE
      // result.revenue (they went through the demand model), so every one is
      // backed out — revenue × lift/(1+lift) — rather than multiplied on top of
      // an already-boosted figure. loyalty and alliance used the multiply-on-top
      // form while they were post-cap revenue multipliers; that over-reported
      // them by a factor of (1+lift) once they moved into demand.
      // These are attribution estimates for the UI only — nothing downstream
      // sums them into revenue.
      marketingLift:    Math.round(result.revenue * (marketingLift / (1 + marketingLift))),
      loyaltyLift:      Math.round(result.revenue * (loyaltyLift  / (1 + loyaltyLift))),
      allianceLift:     Math.round(result.revenue * (allianceLift / (1 + allianceLift))),
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

  // Same-lane pooling: several freighters on one city pair share ONE demand
  // pool (see cargoLaneAllocations) instead of each claiming the full market.
  const cargoAllocations = cargoLaneAllocations(cargoRoutes, fleet, awarenessMultiplier,
    { gameDate, demandMultFor: eventDemandMultFor, competitors, groundedIds: crewGroundedSet });

  for (const route of cargoRoutes) {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    if (!aircraft || isOutOfService(aircraft)) continue;
    if (crewGroundedSet.has(aircraft.id)) continue; // nobody to crew it this week

    const result = simulateCargoRoute(
      state.newWorldRestrictions ? { ...route, ...nwrLoadFieldsFor(route) } : route,
      aircraft, gameDate, laborWithSeniority, fuelMultiplier,
      // Freight is not exempt from the world: a recession, a pandemic scare or a
      // closed airspace moves tonnage exactly as it moves passengers.
      awarenessMultiplier * eventDemandMultFor(route.origin, route.destination),
      cargoAllocations.get(route.id) ?? null);
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
      * maintenanceMultiplier(effectiveMaintAgeWeeks(aircraft))
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
      // True when this route's demand came from a shared-lane pool (≥2 of the
      // player's freighters on the pair) rather than the full-market path.
      pooled:     cargoAllocations.has(route.id),
    });
  }

  // ── Jet bases: resolve each aircraft's best available base ONCE ────────────
  // Slot contention is NOT applied here — line maintenance and the contract
  // offset are ownership benefits that a base delivers to the whole fleet it
  // covers. Slots gate the discrete JOBS (checks, AOG repairs) in the reducer.
  const mroFactorsByAircraft = {};
  for (const aircraft of fleet) {
    const resolved = resolveBaseFor(aircraft, mroBases, rawRoutes, cargoRoutes, absWeek);
    if (resolved) mroFactorsByAircraft[aircraft.id] = mroFactorsFor(resolved);
  }
  const mroContractOffsets = familyContractOffsets(mroBases, absWeek);

  // 2. Fleet fixed costs (lease + maintenance + reserve standby)
  let totalLeases         = 0;
  let totalMaintenance    = 0;
  let totalReserveParking = 0;
  const fleetCosts      = [];
  const reserveStandby  = [];   // per-reserve cost breakdown for the Finance page

  for (const aircraft of fleet) {
    const type = getAircraftType(aircraft.typeId);
    if (!type) continue;
    const maintMult         = maintenanceMultiplier(effectiveMaintAgeWeeks(aircraft));
    const { maintenanceCostMultiplier } = laborEffects(labor);
    // Line-maintenance facility discount: the BEST of the hub factor and the
    // jet-base factor — they do not stack, you only maintain the jet once.
    const mroF              = mroFactorsByAircraft[aircraft.id] ?? null;
    const facilityFactor    = Math.min(aircraftMaintFactor[aircraft.id] ?? 1.0, mroF?.lineFactor ?? 1.0);
    const baseMaint         = Math.round(
      type.baseMaintenancePerWk * maintMult * maintenanceBudget * maintenanceCostMultiplier * (aircraft.maintMod ?? 1.0)
      * facilityFactor
    );
    // Reserve standby costs (design doc §4.4): a stationed reserve pays a
    // readiness premium on line maintenance (crew on standby, systems warm),
    // plus a weekly parking fee at its base — suspended in weeks it is out
    // covering (it's flying, not parked) or in the shop itself.
    // A reserve parked at one of your OWN open bases is cheaper to keep warm —
    // your mechanics are already standing there.
    const stationed = !!aircraft.reserveBase && aircraft.status !== 'retired';
    const atOwnBase = stationed && isBaseOpen(mroBases?.[aircraft.reserveBase]);
    const readiness = atOwnBase
      ? 1 + (RESERVE_READINESS_MULT - 1) * (1 - RESERVE_AT_BASE_READINESS_DISCOUNT)
      : RESERVE_READINESS_MULT;
    const maint     = stationed ? Math.round(baseMaint * readiness) : baseMaint;
    let parking = 0;
    if (stationed && !isOutOfService(aircraft)) {
      const covering = rawRoutes.some(r => r.aircraftId === aircraft.id && r.coverForAircraftId)
        || cargoRoutes.some(r => r.aircraftId === aircraft.id && r.coverForAircraftId);
      if (!covering && aircraft.status === 'idle') {
        const feeCat = type.freighter ? freighterLandingCategory(type.payloadTonnes ?? 0) : type.category;
        const tier   = getAirport(aircraft.reserveBase)?.tier ?? 'major';
        parking = reserveParkingFee(feeCat, tier);
      }
    }
    if (stationed) {
      reserveStandby.push({
        aircraftId: aircraft.id, name: aircraft.name, base: aircraft.reserveBase,
        parking, readinessPremium: maint - baseMaint,
      });
    }
    // Owned aircraft carry no lease — only maintenance applies.
    // Use the per-aircraft weeklyLease stored at delivery time (may differ from type default
    // due to engine options / wingtips chosen at order time); fall back to type default.
    const leaseThisWk = aircraft.ownershipType === 'owned' ? 0
      : (aircraft.weeklyLease ?? type.weeklyLease);
    totalLeases         += leaseThisWk;
    totalMaintenance    += maint;
    totalReserveParking += parking;
    fleetCosts.push({ aircraftId: aircraft.id, lease: leaseThisWk, maintenance: maint, reserveParking: parking });
  }

  // 3. Labor overhead (fixed per aircraft, scaled by pay multiplier for each group).
  //    Pilots & maintenance also carry a fleet-complexity surcharge: +2% per
  //    aircraft family beyond the first (split pilot pools, extra type ratings).
  const complexityMult = fleetComplexityMultiplier(fleet);
  let totalLaborCosts = 0;
  if (labor && fleet.length > 0) {
    for (const group of LABOR_GROUPS) {
      const payMult = labor[group.id]?.payMultiplier ?? 1.0;
      const famMult = COMPLEXITY_AFFECTED_GROUPS.includes(group.id) ? complexityMult : 1.0;
      // seniorityMult inflates the SCALE these wages are measured against. The
      // player's payMultiplier is untouched and still means "relative to market".
      // Narrowbody-EQUIVALENTS, not airframes: see CREW_SCALE_BY_CATEGORY.
      const crewScale = fleetCrewScale(group.id, fleet, a => getAircraftType(a.typeId));
      totalLaborCosts += Math.round(group.baseWeeklyPerAircraft * payMult * crewScale * famMult * seniorityMult);
    }
  }

  // 4. Gate rental fees (monthly fee billed pro-rata as weekly)
  // Gate-scarcity worlds add a congestion surcharge: while an airport is >90%
  // full (server-injected state.gateMarket marks it `surcharge: true`), every
  // gate held there costs GATE_SURCHARGE_MULT× its normal weekly fee. Solo and
  // non-scarcity worlds have no gateMarket, so this is inert there.
  let totalGateFees = 0;
  let totalGateSurcharge = 0;
  const surchargeMap = state.gateScarcityWorld ? state.gateMarket?.airports : null;
  for (const [code, count] of Object.entries(gates)) {
    if (!count) continue;
    const ap = getAirport(code);
    if (!ap) continue;
    const weekly = Math.round(totalGateMonthlyFee(ap, count) / 4);
    totalGateFees += weekly;
    if (surchargeMap?.[code]?.surcharge) {
      totalGateSurcharge += Math.round(weekly * (GATE_SURCHARGE_MULT - 1));
    }
  }
  totalGateFees += totalGateSurcharge;

  // 4b. Alliance slot pool rent (Headwinds gate-scarcity worlds only).
  // Borrowed slots are billed per-slot — the airport's base weekly gate fee
  // pro-rata × SLOT_POOL_MARKUP — and the whole payment goes to the owning
  // member: the fee share relieves the owner's rent, the markup is their
  // profit. Both weekly figures are computed server-side at injection time
  // (state.allianceSlotPool); solo and non-pool states carry nothing here and
  // book exactly zero. Netted INTO totalGateFees ("Gates & slots") so every
  // downstream reconciliation — totalCost, cashDelta, the P&L bridge — holds
  // without a new line: a landlord's gate bill shrinks, a tenant's grows.
  let totalSlotPoolCost = 0;
  let totalSlotPoolEarnings = 0;
  for (const p of Object.values(state.allianceSlotPool ?? {})) {
    totalSlotPoolCost     += p.weeklyCost     ?? 0;
    totalSlotPoolEarnings += p.weeklyEarnings ?? 0;
  }
  totalSlotPoolCost     = Math.round(totalSlotPoolCost);
  totalSlotPoolEarnings = Math.round(totalSlotPoolEarnings);
  totalGateFees += totalSlotPoolCost - totalSlotPoolEarnings;

  // 5. Fleet family MRO base costs (one fixed fee per active aircraft family, regardless of fleet size).
  //    These are OUTSOURCED contract rates — a certified jet base offsets most of
  //    the family's bill because you are now doing that work yourself.
  const familyBaseGross      = fleet.length > 0 ? weeklyFamilyBaseCost(fleet) : 0;
  const totalFamilyBaseCosts = fleet.length > 0 ? weeklyFamilyBaseCost(fleet, mroContractOffsets) : 0;
  const mroContractSavings   = Math.max(0, familyBaseGross - totalFamilyBaseCosts);

  // 5b. Jet-base running costs — opex, extra certifications, parts pool.
  const totalMroBaseCosts = totalBaseWeeklyCost(mroBases);

  // 5c. Onboard connectivity — one weekly charge per EQUIPPED tail, whether it
  //     flew, sat on a reserve stand or spent the week in a hangar. The airtime
  //     commitment and the support contract are bought by the airframe, which is
  //     exactly why over-fitting a fleet quietly costs money. The traffic-driven
  //     part of the bill is separate and already inside totalAncillaryCost.
  const totalWifiCosts = fleetWifiWeeklyCost(fleet);

  // 5d. Lounges — the room's own running cost, plus what the free-access
  //     policies cost net of what alliance partners settle for their members.
  //     Only OPEN lounges bill; a fit-out is capex, already paid.
  const totalLoungeOpex = totalLoungeWeeklyOpex(lounges);
  // Who walked through the door. Read off the route results rather than
  // accumulated inside the route loops, so passenger, tag and (future) any other
  // route path are all counted by the same rule and none can be forgotten.
  if (hasOpenLounge) {
    for (const rr of routeResults) {
      const rt = routes.find(r => r.id === rr.routeId);
      if (!rt) continue;
      loungeThroughputPax += loungeStationPax(rt.origin, rt.destination, rr.classSummary);
    }
  }
  const loungeGuests = loungeGuestEconomics({
    throughputPax:      loungeThroughputPax,
    loyaltyPenetration: loyaltyPenet,
    policy:             loungePolicy,
    allianceActive:     !!loungeAlliance,
    hasOpenLounge,
  });
  // ONE cost line, not a cost and a revenue. Settlement income from partners is
  // neither route revenue nor alliance partner revenue in the sense the P&L
  // bridge means; presenting it as either puts a phantom row on the Finance page
  // and breaks the bridge's residual check.
  const totalLoungeCosts = totalLoungeOpex + loungeGuests.netCost;

  // 6. Hub investment costs — higher tiers require ongoing weekly spend
  let totalHubInvestment = 0;
  for (const [, hubData] of Object.entries(hubs)) {
    const tierDef = HUB_TIERS[hubData.tier] ?? HUB_TIERS[1];
    totalHubInvestment += tierDef.weeklyInvestment;
  }

  // 7. HQ & corporate overhead.
  //
  // Classic worlds: the size curve (calcHQCost), measured in NARROWBODY-
  // EQUIVALENTS rather than airframes. Counting airframes billed a Dash 8 an
  // A380's head office — the same defect crew pay and liability insurance both
  // already fixed by stepping per category — and at the bottom of the range it
  // was fatal rather than merely wrong: a turboprop pair's whole gross revenue
  // is under the bill the old curve printed for it. An all-narrowbody fleet
  // returns exactly its aircraft count, so nothing moves for the common case.
  //
  // New World Restrictions: a per-departure fee scaled by aircraft class, because
  // overhead really tracks DEPARTURES and the size of what is departing, not the
  // number of airframes parked. The base is charged so an airline with no flying
  // still carries a small corporate structure; it is scaled by the fleet AVERAGE
  // and capped at narrowbody, so it can only ever fall (hqBaseWeekly).
  // Freighters are priced on their airframe's body class, so a 747-400F pays the
  // wide-body rate rather than the double-deck one (no cabin, no cabin overhead).
  const typeOfAircraft = a => getAircraftType(a.typeId);
  let totalHQCost = calcHQCost(fleetHQScale(fleet, typeOfAircraft));
  if (state.newWorldRestrictions) {
    let departureFees = 0;
    // Only flights that ACTUALLY OPERATE this week are charged. The passenger and
    // cargo revenue loops both skip dormant seasonal routes and out-of-service
    // aircraft (grounded / in a heavy check); charging dispatch and ops overhead
    // for departures that never happen would bill an airline for a schedule it
    // isn't flying — and would hit seasonal operators hardest, which is exactly
    // the regressive shape this table was built to avoid.
    for (const route of [...routes, ...cargoRoutes]) {
      const aircraft = fleet.find(a => a.id === route.aircraftId);
      if (!aircraft || isOutOfService(aircraft)) continue;
      if (!isRouteActive(route, gameDate.month)) continue;   // safe for cargo: no season => year-round
      const type = getAircraftType(aircraft.typeId);
      if (!type) continue;
      const bodyClass = type.freighter
        ? freighterBodyClass(type)
        : (type.doubleDeck ? 'Double Deck' : type.category);
      // weeklyFrequency is departures from ONE endpoint; a rotation departs twice.
      departureFees += hqDepartureFee(bodyClass) * (route.weeklyFrequency ?? 0) * 2;
    }
    totalHQCost = hqBaseWeekly(fleet, typeOfAircraft) + Math.round(departureFees);
  }

  // 8. Insurance — hull (owned aircraft) + liability (all aircraft)
  let totalInsurance = 0;
  for (const aircraft of fleet) {
    const type = getAircraftType(aircraft.typeId);
    totalInsurance += weeklyInsuranceCost(aircraft, type);
  }

  // 9. Marketing spend — brand budget + targeted campaigns. Deducted as a cost;
  // demand effect flows through awareness / campaign-strength stocks.
  const totalTargetedSpend  = Object.values(targetedMarketing ?? {})
    .reduce((s, v) => s + Math.max(0, v || 0), 0);
  const totalMarketingSpend = Math.round(Math.max(0, marketingBudget) + totalTargetedSpend);

  // 10. Loyalty program costs:
  //   - Weekly investment (technology, partnerships, admin)
  //   - Points flows: members EARN points now (accrues to the liability stock),
  //     and outstanding points are REDEEMED over the following months as award
  //     seats — that draw-down (minus breakage) is the real weekly cost.
  //   A program that stops being funded still owes its outstanding points.
  const loyaltyInvestment = loyalty?.weeklyInvestment ?? 0;
  const loyaltyGenerosity = loyaltyTier(loyaltyInvestment).generosity
    || (loyaltyMembers > 0 ? 0.85 : 0);
  const loyaltyPrevLiability = Math.max(0, loyalty?.pointsLiability ?? 0);
  const loyaltyFlows = (loyaltyMembers > 0 || loyaltyPrevLiability > 0)
    ? loyaltyPointsFlows(loyaltyPrevLiability, totalRevenue, loyaltyPenet, loyaltyGenerosity)
    : { earned: 0, redeemedCost: 0, expired: 0, newLiability: 0 };
  const loyaltyPointsCost = loyaltyFlows.redeemedCost;
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

  // Hub throughput: connecting pax over each designated hub this week
  // (own-metal itineraries + attributed external feed). Drives the T3
  // throughput prerequisite (4-week average kept by GameContext) and the UI.
  const hubThroughput = {};
  for (const code of Object.keys(hubs)) {
    hubThroughput[code] = (ownMetalOD?.byHub?.[code]?.pax ?? 0) + (hubExternalPax[code] ?? 0);
  }

  // ── Single connecting number ────────────────────────────────────────────────
  // The Statistics chart's "Connecting" band now equals EXACTLY the Hubs-tab
  // throughput (sum over designated hubs) so the two surfaces can never disagree.
  // The residual network-wide gateway/partner transit feed (extPax routed through
  // NON-hub airports) is reclassified into the interline / partner-fed band below,
  // where it actually belongs — it is not traffic you hubbed yourself.
  const hubConnectingPax   = Object.values(hubThroughput).reduce((a, v) => a + (v ?? 0), 0);
  const gatewayResidualPax = Math.max(0, Math.round(totalConnectingPax) - hubConnectingPax);

  const totalOpCost = totalFuel + totalCrew + totalQuality + totalCatering + totalAncillaryCost + totalGroundHandling + totalLounge + totalLayover + totalCompensation + totalLandingFees;
  const totalCost   = totalLeases + totalMaintenance + totalOpCost + totalGateFees
    + totalLaborCosts + totalFamilyBaseCosts + totalMroBaseCosts + totalHubInvestment
    + totalHQCost + totalInsurance + totalMarketingSpend + totalLoyaltyCost + totalPartnerFees
    + totalDistributionCost + totalReserveParking + totalWifiCosts + totalLoungeCosts;
  const cashDelta   = totalRevenue + totalPartnerRevenue - totalCost;

  // ── Pooling invariant self-check (diagnostic only — changes no economics) ─────
  // Aircraft sharing one O&D pair pool their demand (see the pre-pass) and must
  // therefore land within rounding of the SAME load factor. If two ever diverge in
  // the OUTPUT, the pool silently failed — capture the exact inputs (including
  // whether the pre-pass actually allocated each aircraft) so the cause is
  // deterministic instead of guesswork. Surfaced on the report as `poolingAnomalies`
  // and logged once per tick.
  const poolingAnomalies = [];
  {
    const groups = new Map();
    for (const rr of routeResults) {
      const rt = routes.find(r => r.id === rr.routeId);
      if (!rt || isMultiStop(rt)) continue;
      const key = [rt.origin, rt.destination].sort().join('-');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ rr, rt });
    }
    for (const [pair, list] of groups) {
      if (list.length < 2) continue;
      const lfs = list.map(x => x.rr.loadFactor ?? 0);
      const spread = Math.max(...lfs) - Math.min(...lfs);
      if (spread > 0.05) {
        poolingAnomalies.push({
          pair, spread: +spread.toFixed(3), week: gameDate?.week,
          multiplayer: state.multiplayer === true,
          aircraft: list.map(({ rr, rt }) => {
            const ac = fleet.find(a => a.id === rt.aircraftId);
            return {
              routeId: rt.id, aircraftId: rt.aircraftId, freq: rt.weeklyFrequency,
              loadFactor: +(rr.loadFactor ?? 0).toFixed(3), passengers: rr.passengers,
              capacity: rr.configuredSeatsOneWay, capacityCapped: rr.capacityCapped,
              pooled: demandAllocations.has(rt.id),
              status: ac?.status, stops: rt.stops, season: rt.season ?? null,
              weeksOpen: rt.weeksOpen, config: ac?.config,
            };
          }),
        });
      }
    }
    if (poolingAnomalies.length && typeof console !== 'undefined' && console.warn) {
      console.warn('[pooling-anomaly]', JSON.stringify(poolingAnomalies));
    }
  }

  return {
    // Crew pipeline (A7): what the week was flown short of, so the UI can warn
    // before it costs anything more. Spread ONLY when the pipeline is active, so
    // a classic world's report keeps byte-identical shape (golden master).
    ...(labor?.crewShortfall ? { crewShortfall: labor.crewShortfall } : {}),
    ...(crewGroundedSet.size ? { crewGrounded: [...crewGroundedSet] } : {}),
    poolingAnomalies,
    cashDelta:              Math.round(cashDelta),
    totalRevenue:           Math.round(totalRevenue + totalPartnerRevenue),
    totalConnecting:        Math.round(totalConnecting),
    totalLeases:            Math.round(totalLeases),
    totalMaintenance:       Math.round(totalMaintenance),
    totalReserveParking:    Math.round(totalReserveParking),
    reserveStandby,
    totalFuel:              Math.round(totalFuel),
    totalCrew:              Math.round(totalCrew),
    totalQuality:           Math.round(totalQuality),
    totalLandingFees:       Math.round(totalLandingFees),
    totalCatering:          Math.round(totalCatering),
    totalCateringRevenue:   Math.round(totalCateringRevenue),
    totalAncillaryRevenue:  Math.round(totalAncillaryRevenue),
    totalAncillaryCost:     Math.round(totalAncillaryCost),
    totalGroundHandling:    Math.round(totalGroundHandling),
    totalLounge:            Math.round(totalLounge),
    totalDistributionCost:  Math.round(totalDistributionCost),
    totalLayover:           Math.round(totalLayover),
    totalCompensation:      Math.round(totalCompensation),
    totalGateFees:          Math.round(totalGateFees),
    totalGateSurcharge:     Math.round(totalGateSurcharge), // congestion (>90% full) portion, already inside totalGateFees
    // Alliance slot rent, itemized (already netted inside totalGateFees). The
    // keys exist only when the pool was injected, so every solo / pre-pool
    // report stays byte-identical (golden parity without a re-baseline).
    ...(state.allianceSlotPool
      ? { totalSlotPoolCost, totalSlotPoolEarnings } : {}),
    totalLaborCosts:        Math.round(totalLaborCosts),
    totalFamilyBaseCosts:   Math.round(totalFamilyBaseCosts),
    totalMroBaseCosts:      Math.round(totalMroBaseCosts),
    mroContractSavings:     Math.round(mroContractSavings),
    // Connectivity & lounges. Always present (0 when unused) so the Finance page
    // and the P&L bridge can name them unconditionally.
    totalWifiCosts:         Math.round(totalWifiCosts),
    totalLoungeCosts:       Math.round(totalLoungeCosts),
    totalLoungeOpex:        Math.round(totalLoungeOpex),
    loungeGuests:           loungeGuests,
    wifiEquippedCount:      fleet.filter(a => isWifiEquipped(a) && a.status !== 'retired').length,
    wifiFleetCoverage:      fleetWifiCoverage(fleet, a => getAircraftType(a.typeId)?.seats ?? 0),
    mroFactorsByAircraft,   // aircraftId → resolved jet-base benefits this week
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
    // Hub systems (§B–§F)
    hubContestMap,           // { [code]: { playerShare, rivals, ... } } — hub competition
    hubThroughput,           // { [code]: connecting pax/wk } — T3 prereq + HubManagement
    totalHubCostSavings:     Math.round(totalHubCostSavings),
    ownMetalOD: {            // own-metal itinerary revenue summary (trimmed for state size)
      totalRevenue: ownMetalOD?.totalRevenue ?? 0,
      totalPax:     ownMetalOD?.totalPax ?? 0,
      byHub:        ownMetalOD?.byHub ?? {},
      entries:      (ownMetalOD?.entries ?? []).slice(0, 40),
    },
    loyaltyMultiplier,
    loyaltyStrength,                                   // penetration × maturity factor
    loyaltyPointsEarned:    Math.round(loyaltyFlows.earned),
    loyaltyPointsCost:      Math.round(loyaltyPointsCost),
    loyaltyPointsExpired:   Math.round(loyaltyFlows.expired),
    loyaltyLiability:       Math.round(loyaltyFlows.newLiability), // for the reducer to persist
    awarenessMultiplier,
    reputationMultiplier:   reputationMult,
    reputationScore:        repInfo.overall,
    // World-event demand shock baked into this week's demand pools (global
    // component only — regional shocks vary per route). 1.0 = no active events.
    eventDemandMult:        eventGlobalDemandMult,
    // Passenger satisfaction: post-week stat for the reducer to persist, plus
    // this week's delivered experience for UI display.
    satisfaction:           satisfactionNext,
    deliveredExperience:    deliveredExp,
    totalPassengers,
    // ── Passenger segmentation (one-way boardings per direction; ×2 for round-trip)
    // Organic    = direct local O&D boarded on the player's own routes.
    // Connecting = throughput over the player's DESIGNATED hubs — own-metal
    //              itineraries plus the external feed attributed to those hubs.
    //              This is the SAME figure the Hubs tab shows (sum of hubThroughput),
    //              so the two surfaces are guaranteed to agree.
    // Interline  = partner-fed O&D (interline / codeshare / alliance) PLUS the
    //              residual gateway transit feed routed through non-hub airports.
    // Organic is an estimate; Connecting is the exact hub throughput.
    paxOrganic:             totalPassengers,
    paxConnecting:          hubConnectingPax,
    paxInterline:           (partnerODRevenue?.totalPax ?? 0) + gatewayResidualPax,
    totalTargetedSpend:     Math.round(totalTargetedSpend),
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
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

export function formatPercent(n) {
  return `${(n * 100).toFixed(1)}%`;
}
