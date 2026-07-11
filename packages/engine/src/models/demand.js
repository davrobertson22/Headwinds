/**
 * demand.js — Rich demand model scaffold
 *
 * This module defines the data shapes and core calculations for the
 * market demand system. It sits on top of simulation.js and is designed
 * so that competition, service quality, fare classes, and network effects
 * can be implemented incrementally without breaking existing code.
 *
 * KEY CONCEPTS
 * ─────────────
 * 1. RouteMarket     – total passenger pool for a city pair this week
 * 2. AirlineOffer    – what one airline offers on that route (price, quality, freq)
 * 3. MarketShare     – how demand splits across competing airlines
 * 4. DemandResult    – passengers & revenue for one airline on one route
 *
 * PASSENGER SEGMENTS
 * ───────────────────
 * Leisure  – price-sensitive, elasticity ~1.5. Cares little about frequency.
 * Business – quality/time-sensitive, elasticity ~0.6. Pays premium, wants freq.
 *
 * HOW SHARE IS CALCULATED
 * ────────────────────────
 * Each airline gets a utility score per segment. Share = softmax over utilities.
 * Utility = qualityWeight * qualityScore - priceWeight * (price / refPrice)
 *         + frequencyWeight * log(frequency + 1)
 *         + connectivityBonus
 *
 * If the player is the ONLY airline on a route, no competitive softmax is
 * needed — they capture min(adjustedDemand, capacity).
 */

import { baseCityPairDemand, referencePrice, routeDistance } from '../utils/market.js';
import { AIRPORTS, getAirport, getAirportScores } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType, fuelCostPerKm } from '../data/aircraft.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Business class share of total route demand — now route-specific via getRouteClassDemandShares(). */
export const BUSINESS_DEMAND_SHARE = 0.15; // kept for any external references; prefer the function below

/** Business class price is this multiple of economy reference price. */
export const BUSINESS_PRICE_MULTIPLIER = 3.5;

/**
 * Maximum fare any class may charge, as a multiple of that class's own
 * reference price. Two jobs:
 *   1. Input cap — reducers clamp player/AI prices to this ceiling so a fare
 *      can never be set absurdly high (see clampClassPrice in simulation.js).
 *   2. Demand choke — demand tapers to ~0 as price approaches this ceiling
 *      (see priceChokeFactor below), so pricing at the cap is not a free lunch.
 * Both use the same multiple so the choke reaches zero exactly at the input cap.
 */
export const PRICE_CAP_MULTIPLE = 3;

/**
 * Competitive fare compression: each rival on a city pair drags the effective
 * reference fare down (competition compresses yields, not just passenger
 * splits). Applied inside computeMarketShare's competitive branch — symmetric
 * for player and AI carriers.
 */
export const COMPETITIVE_FARE_COMPRESSION_PER_RIVAL = 0.05; // −5% per extra carrier
export const COMPETITIVE_FARE_COMPRESSION_FLOOR    = 0.90;  // max −10%

/**
 * Demand multiplier (0–1) that forces demand toward zero as a fare climbs from
 * its reference price up to the cap (PRICE_CAP_MULTIPLE × reference).
 *
 *   price ≤ reference        → 1   (no extra penalty; elasticity already applies)
 *   price ≥ cap × reference  → 0   (nobody buys at the ceiling)
 *   in between               → convex falloff (1 - t²)
 *
 * This sits on TOP of the existing elasticity power-curve. Elasticity alone
 * flattens to a small but non-zero asymptote (the bug that made a $1M fare still
 * sell ~8 seats); the choke guarantees the curve actually reaches zero.
 *
 * @param {number} price        the fare being charged ($)
 * @param {number} refForClass  the reference fare for this class ($)
 * @returns {number} 0–1
 */
export function priceChokeFactor(price, refForClass) {
  const ref = Math.max(refForClass, 1);
  const ratio = price / ref;
  if (ratio <= 1) return 1;
  if (ratio >= PRICE_CAP_MULTIPLE) return 0;
  const t = (ratio - 1) / (PRICE_CAP_MULTIPLE - 1); // 0 at ref, 1 at cap
  return Math.max(0, 1 - t * t);
}

/**
 * Price elasticity per segment.
 * A ratio of (refPrice / yourPrice) is raised to this power.
 */
export const ELASTICITY = {
  // Firm end of empirical airline elasticities. Leisure/economy demand runs
  // ~-1.5 to -2.1 in the literature (short-haul leisure is the most elastic —
  // travelers substitute driving, rail, or simply not going). At 2.0, pricing
  // a monopoly route 25% over reference cuts leisure demand ~36%, so gouging
  // costs revenue rather than printing it.
  leisure: 2.0,    // was 1.8 (originally 1.5)
  business: 0.7,   // was 0.6 — business is inelastic, but not immune (~-0.7)
  connecting: 1.2, // was 1.0 — connecting pax have hub alternatives; less captive
};

/**
 * Price-response multiplier (0–1) for CONNECTING passengers.
 *
 * Connecting pax used to ignore price entirely — they paid whatever fare was set,
 * so an overpriced route still earned full feed revenue. They should be *less*
 * price-sensitive than pure origin–destination leisure travelers (they've committed
 * to your network for the connection and have fewer one-hop alternatives), but they
 * are not captive: as the fare climbs toward the cap, connecting demand tapers and
 * reaches zero at PRICE_CAP_MULTIPLE × reference — exactly like direct demand.
 *
 *   price ≤ reference        → 1
 *   price ≥ cap × reference  → 0
 *   in between               → (ref/price)^ELASTICITY.connecting × priceChokeFactor
 *
 * @param {number} price     the fare being charged ($)
 * @param {number} refPrice  the route economy reference fare ($)
 * @returns {number} 0–1
 */
export function connectingPriceFactor(price, refPrice) {
  const ref = Math.max(refPrice, 1);
  if (price <= ref) return 1;
  return Math.pow(ref / price, ELASTICITY.connecting) * priceChokeFactor(price, ref);
}

/**
 * Utility weights used in competitive market-share model.
 * Tune these to change how much price vs quality vs frequency matter.
 */
export const UTILITY_WEIGHTS = {
  leisure:  { price: 1.8, quality: 0.5, frequency: 0.4 },
  business: { price: 0.8, quality: 1.4, frequency: 0.9 },
};

/**
 * Seasonality multipliers by month (1-indexed).
 * Route-specific seasonal profiles (index 1–12 = Jan–Dec).
 * Each value is a demand multiplier for that month.
 */

// ── Seasonal profiles ──────────────────────────────────────────────────────
export const SEASONAL_PROFILES = {
  // Northern summer + December holiday peak. Default for most N-hemisphere routes.
  generic:     [null, 0.82, 0.80, 0.90, 0.95, 1.05, 1.15, 1.25, 1.22, 1.00, 0.92, 0.88, 1.10],

  // Business hub routes (long-haul between financial centres). Stable, Aug dip.
  business:    [null, 0.96, 0.97, 1.02, 1.06, 1.08, 1.04, 0.87, 0.82, 1.06, 1.08, 1.02, 0.97],

  // Leisure/beach destinations — very strong summer, quiet shoulder seasons.
  beach:       [null, 0.70, 0.68, 0.78, 0.88, 0.98, 1.28, 1.48, 1.42, 1.05, 0.84, 0.76, 1.10],

  // Ski/winter-sport destinations — peaks Dec–Mar, deep summer trough.
  ski:         [null, 1.22, 1.30, 1.14, 0.70, 0.58, 0.62, 0.85, 0.88, 0.78, 0.84, 1.10, 1.30],

  // Southern-hemisphere origins/destinations — seasons are flipped.
  southern:    [null, 1.25, 1.28, 1.08, 0.90, 0.80, 0.74, 0.76, 0.80, 0.94, 1.02, 1.12, 1.20],

  // Asia–Pacific: Chinese New Year Jan/Feb, Golden Week May, steady.
  asia:        [null, 1.14, 1.22, 0.95, 1.02, 1.12, 1.00, 0.96, 0.97, 1.03, 1.05, 1.00, 0.96],

  // Middle East: cool-season peak Oct–Apr, summer too hot for leisure.
  middleEast:  [null, 1.10, 1.08, 0.96, 0.88, 0.84, 0.78, 0.76, 0.78, 0.90, 1.04, 1.14, 1.18],

  // Caribbean / tropical — dry-season winter peak, hurricane-season summer trough.
  caribbean:   [null, 1.14, 1.18, 1.10, 0.97, 0.84, 0.76, 0.73, 0.70, 0.78, 0.88, 1.00, 1.20],

  // Sub-Saharan Africa — safari dry-season Jul–Oct peak; otherwise fairly stable.
  africa:      [null, 0.90, 0.88, 0.86, 0.90, 0.92, 0.96, 1.10, 1.12, 1.10, 1.06, 0.96, 0.92],
};

// ── Country → profile mapping ─────────────────────────────────────────────
const COUNTRY_PROFILE = {
  // Southern hemisphere
  AU: 'southern', NZ: 'southern',
  AR: 'southern', CL: 'southern', PE: 'southern', BR: 'southern',
  ZA: 'southern',

  // Middle East
  AE: 'middleEast', QA: 'middleEast', SA: 'middleEast', IL: 'middleEast',

  // Asia
  JP: 'asia', KR: 'asia', CN: 'asia', TW: 'asia', HK: 'asia', IN: 'asia',
  SG: 'asia', MY: 'asia', TH: 'asia', ID: 'asia', PH: 'asia',

  // Africa
  KE: 'africa', NG: 'africa', ET: 'africa', EG: 'africa', MA: 'africa',

  // Caribbean / tropical
  MX: 'caribbean', PA: 'caribbean',

  // Beach Mediterranean — leisure-driven even though geographically Europe
  ES: 'beach', IT: 'beach', GR: 'beach', PT: 'beach',

  // Ski / alpine — winter sport dominant (short routes; blends with partner airport)
  CH: 'ski', AT: 'ski', NO: 'ski', FI: 'ski',
  // SE: actually mixed but leave generic for now (ski in winter, Midsommar peak)
};

/**
 * Return the seasonal multiplier profile (index 1–12) for a route.
 * Averages origin and destination profiles so mixed routes blend naturally.
 * e.g.  JFK (generic) → GVA (ski)  →  slightly winter-heavy compromise
 *        LHR (generic) → DXB (middleEast) → dampened summer, stronger autumn
 */
export function getSeasonalProfile(originCode, destCode) {
  const oCountry = getAirport(originCode)?.country ?? 'US';
  const dCountry = getAirport(destCode)?.country   ?? 'US';

  const oPid = COUNTRY_PROFILE[oCountry] ?? 'generic';
  const dPid = COUNTRY_PROFILE[dCountry] ?? 'generic';

  if (oPid === dPid) return SEASONAL_PROFILES[oPid];

  // Blend origin + destination profiles
  const oP = SEASONAL_PROFILES[oPid];
  const dP = SEASONAL_PROFILES[dPid];
  return [null, ...Array.from({ length: 12 }, (_, i) =>
    Math.round(((oP[i + 1] + dP[i + 1]) / 2) * 1000) / 1000
  )];
}

// Keep the old export for any code still referencing it (will be removed later).
export const SEASONALITY = SEASONAL_PROFILES.generic;

// ─── Data Shapes (JSDoc typedefs) ─────────────────────────────────────────────

/**
 * @typedef {object} RouteMarket
 * Total demand pool for a city pair in the current game week.
 *
 * @property {string}  origin
 * @property {string}  destination
 * @property {number}  baseWeeklyDemand   - raw gravity model output (one-way pax/week)
 * @property {number}  leisureDemand      - price-sensitive segment (pax/week)
 * @property {number}  businessDemand     - quality/freq-sensitive segment (pax/week)
 * @property {number}  seasonalityFactor  - 0.8–1.3 multiplier for current month
 * @property {number}  maturityFactor     - 0–1, ramps to 1 over 26 weeks on a new route
 * @property {number}  referencePrice     - market equilibrium economy price ($)
 * @property {number}  distanceKm
 */

/**
 * @typedef {object} AirlineOffer
 * What a single airline offers on a route this week.
 * Both player and AI competitors use this shape.
 *
 * @property {string}       airlineId         - 'player' or competitor id
 * @property {string}       origin
 * @property {string}       destination
 * @property {number}       economyPrice      - one-way economy fare ($)
 * @property {number|null}  businessPrice     - one-way business fare ($), null = no business cabin
 * @property {number}       weeklyFrequency   - one-way departures per week
 * @property {number}       seatsPerFlight    - economy seats (business is separate allocation)
 * @property {number}       economySeats      - total weekly economy capacity (seatsPerFlight * freq)
 * @property {number}       businessSeats     - total weekly business capacity
 * @property {number}       qualityScore      - 0–100 (see computeQualityScore)
 * @property {number}       connectivityBonus - 0–0.3, hub network bonus (see computeConnectivityBonus)
 */

/**
 * @typedef {object} QualityInputs
 * Raw inputs used to compute an airline's qualityScore on a route.
 *
 * @property {number} onTimeRate         - 0–1 (1 = always on time). Starts at 0.85.
 * @property {number} [cabinPoints]      - hard+soft product points from the cabin
 *   config (see cabinQualityPoints). Preferred over legacy serviceLevel.
 * @property {'economy'|'premium'|'business'} [serviceLevel] - legacy cabin tier,
 *   used only when cabinPoints is not provided.
 * @property {number} fleetAgeYears      - average age of aircraft on route
 * @property {number} customerRating     - 0–5 stars (player-facing display metric)
 */

/**
 * @typedef {object} CompetitorAirline
 * An AI-controlled airline operating in the same market.
 * TODO: implement AI logic to adjust prices in response to player.
 *
 * @property {string}   id
 * @property {string}   name
 * @property {string}   homeHub           - IATA code of their hub airport
 * @property {string}   tier              - 'budget' | 'legacy' | 'premium'
 * @property {number}   baseQualityScore  - fixed quality for now (35–80)
 * @property {object}   routes            - map of routeKey → { frequency, priceMultiplier }
 */

/**
 * @typedef {object} MarketShareResult
 * How demand splits across all airlines on a route.
 *
 * @property {string} airlineId
 * @property {number} leisureShare    - 0–1 fraction of leisure segment
 * @property {number} businessShare   - 0–1 fraction of business segment
 * @property {number} leisurePax      - passengers carried (leisure)
 * @property {number} businessPax     - passengers carried (business)
 * @property {number} totalPax        - both segments combined
 * @property {number} economyRevenue
 * @property {number} businessRevenue
 * @property {number} totalRevenue
 * @property {boolean} capacityCapped - true if demand exceeded available seats
 */

// ─── Route demand character ───────────────────────────────────────────────────

/**
 * Premium-segment share by seasonal profile.
 * Leisure-heavy profiles have very few premium passengers;
 * business-corridor profiles have a large premium share.
 */
const PROFILE_PREMIUM_SHARE = {
  business:   0.36,  // e.g. FRA-LHR, JFK-ORD — heavy corporate travel
  middleEast: 0.28,  // Gulf hubs attract high-yield business traffic
  asia:       0.24,  // mixed, strong business corridors
  generic:    0.18,  // default N-hemisphere route
  southern:   0.16,  // Southern-hemisphere mixed
  africa:     0.14,  // mostly leisure + diaspora
  beach:      0.08,  // Mediterranean leisure destinations
  ski:        0.08,  // ski/alpine — almost entirely leisure
  caribbean:  0.07,  // Caribbean — tourist-dominant
};

/**
 * Compute demand class shares for a route using per-airport business/leisure scores.
 *
 * Each airport has a businessScore (0–100) and a leisureScore (0–100).
 * The route's premium share is determined by the ratio of the combined
 * business scores to the total combined scores — so FRA (b=88,l=28) + LHR
 * (b=82,l=55) gives ~35% premium, while CUN (b=8,l=92) + MCO (b=12,l=92)
 * gives ~5% premium. Long-haul adds a small bonus (passengers pay for comfort).
 *
 * Returns fractions that sum to 1.0.
 *
 * @param {string} origin
 * @param {string} destination
 * @returns {{ firstClass: number, businessClass: number, premiumEconomy: number, economy: number }}
 */
export function getRouteClassDemandShares(origin, destination) {
  const oScores = getAirportScores(origin);
  const dScores = getAirportScores(destination);

  const totalBusiness = oScores.businessScore + dScores.businessScore;
  const totalLeisure  = oScores.leisureScore  + dScores.leisureScore;

  // Premium share = business fraction of combined demand, scaled to max 0.45
  let premiumShare = (totalBusiness / (totalBusiness + totalLeisure)) * 0.45;

  // Long-haul adds premium demand: flat beds and extra legroom matter more on a 10h flight
  const dist = routeDistance(origin, destination);
  const distBonus = Math.min(0.08, dist / 50000); // +1% per 500 km, capped at +8%
  premiumShare = Math.min(0.45, premiumShare + distBonus);

  // First class is only meaningful on long-haul (>4 000 km)
  const firstShare   = dist > 4000 ? premiumShare * 0.10 : premiumShare * 0.03;
  const bizShare     = premiumShare * 0.60;
  const premEcoShare = premiumShare - firstShare - bizShare;
  const ecoShare     = 1 - premiumShare;

  return {
    firstClass:     +firstShare.toFixed(3),
    businessClass:  +bizShare.toFixed(3),
    premiumEconomy: +premEcoShare.toFixed(3),
    economy:        +ecoShare.toFixed(3),
  };
}

// ─── Core calculations ────────────────────────────────────────────────────────

/**
 * Build a RouteMarket for a given city pair and game date.
 *
 * @param {string} origin
 * @param {string} destination
 * @param {object} gameDate   - { week: number, month: number }  (month 1-12)
 * @param {number} [maturityFactor=1]  - pass <1 if route was recently opened
 * @param {number} [demandMult=1]      - world-event demand multiplier (pandemic,
 *                                       recession, regional disruption...) — scales
 *                                       the passenger pool BEFORE the share fight,
 *                                       so load factors genuinely drop in a slump.
 * @returns {RouteMarket}
 */
export function buildRouteMarket(origin, destination, gameDate, maturityFactor = 1, demandMult = 1) {
  const base     = baseCityPairDemand(origin, destination);
  const refPrice = referencePrice(origin, destination);
  const seasonal = getSeasonalProfile(origin, destination)[gameDate.month] ?? 1;
  const adjusted = Math.round(base * seasonal * maturityFactor * demandMult);

  const shares        = getRouteClassDemandShares(origin, destination);
  const premiumShare  = shares.firstClass + shares.businessClass + shares.premiumEconomy;
  const businessDemand = Math.round(adjusted * premiumShare);
  const leisureDemand  = adjusted - businessDemand;

  return {
    origin,
    destination,
    baseWeeklyDemand: base,
    leisureDemand,
    businessDemand,
    seasonalityFactor: seasonal,
    maturityFactor,
    eventDemandMult: demandMult,
    referencePrice: refPrice,
    distanceKm: routeDistance(origin, destination),
  };
}

/**
 * Compute a 0–100 quality score from raw inputs.
 * Used both by the player and AI competitors.
 *
 * @param {QualityInputs} inputs
 * @returns {number}
 */
// ─── Cabin product quality points ─────────────────────────────────────────────
// Hard product (seats) and soft product (service) each contribute their own
// points to the quality score. `basic` is a deliberate LCC tradeoff: it saves
// weekly cost (see *_QUALITY_COST_PER_ROUTE in simulation.js) at a quality
// penalty; `standard` is the neutral baseline.

export const SEAT_QUALITY_POINTS = {
  basic:    -6,
  standard:  0,
  premium:  12,
  luxury:   20,
};

export const SERVICE_QUALITY_POINTS = {
  basic:    -5,
  standard:  0,
  premium:   8,
  luxury:   14,
};

/** Combined quality points from a cabin config's seat + service settings. */
export function cabinQualityPoints(config) {
  return (SEAT_QUALITY_POINTS[config?.seatQuality ?? 'standard'] ?? 0)
       + (SERVICE_QUALITY_POINTS[config?.serviceQuality ?? 'standard'] ?? 0);
}

/**
 * Business travelers demand a credible product — even without airline
 * competition they have alternatives (rail, another hub, a video call, not
 * traveling). Capturable business demand scales with quality: ~0.88× at
 * quality 30, 1.0× at the 65 baseline, ~1.12× at 100.
 *
 * Applied per-offer in monopoly markets and share-weighted across the market
 * in competitive ones (an all-budget market shrinks its business pool), so
 * quality pays business demand twice: a bigger pool AND a bigger slice.
 */
export function businessQualityCapture(qualityScore) {
  const q = Math.max(0, Math.min(100, qualityScore ?? 65));
  return Math.max(0.6, Math.min(1.15, 1 + (q - 65) * 0.0035));
}

/**
 * High quality also stretches what business travelers consider a fair premium
 * fare: the effective business reference price used for elasticity and the
 * fare choke scales ~0.93× at quality 30 → 1.0× at 65 → ~1.07× at 100. A
 * flagship product can hold a fatter business fare before demand collapses;
 * a bare-bones one gets punished for premium pricing sooner.
 */
export function businessFareTolerance(qualityScore) {
  const q = Math.max(0, Math.min(100, qualityScore ?? 65));
  return Math.max(0.9, Math.min(1.1, 1 + (q - 65) * 0.002));
}

export function computeQualityScore({ onTimeRate, cabinPoints, serviceLevel, fleetAgeYears, customerRating }) {
  const onTimePoints    = onTimeRate * 30;          // max 30
  // Prefer explicit cabin points (seat + service); legacy serviceLevel fallback.
  const productPts      = cabinPoints
    ?? ({ economy: 0, premium: 12, business: 22 }[serviceLevel] ?? 0);
  const agePts          = Math.max(0, 20 - fleetAgeYears * 1.5); // max 20 (new a/c), 0 at ~13yr
  const ratingPts       = (customerRating / 5) * 28; // max 28

  return Math.max(0, Math.min(100, Math.round(onTimePoints + productPts + agePts + ratingPts)));
}

/**
 * Hub connectivity bonus for an airline on a given route.
 * Rewards airlines whose hub matches origin or destination —
 * connecting traffic feeds demand to that flight.
 *
 * TODO: extend to count actual connections through the network.
 *
 * @param {string} airlineHub   - IATA code of airline's primary hub
 * @param {string} origin
 * @param {string} destination
 * @returns {number}  0.0–0.25
 */
export function computeConnectivityBonus(airlineHub, origin, destination) {
  if (airlineHub === origin || airlineHub === destination) return 0.20;
  return 0;
  // TODO: iterate airline route network, count connections through hub → bonus up to 0.25
}

/**
 * Compute utility score for one airline on one segment.
 * Higher = more attractive to passengers.
 *
 * @param {AirlineOffer} offer
 * @param {RouteMarket}  market
 * @param {'leisure'|'business'} segment
 * @returns {number}
 */
export function computeUtility(offer, market, segment) {
  const w        = UTILITY_WEIGHTS[segment];
  const price    = segment === 'business' && offer.businessPrice != null
                   ? offer.businessPrice
                   : offer.economyPrice;
  const refPrice = segment === 'business'
                   ? market.referencePrice * BUSINESS_PRICE_MULTIPLIER
                   : market.referencePrice;

  // priceSensitivityReduction (−0.2…+0.35, from loyalty program + reputation)
  // scales how much price matters to THIS airline's passengers: loyal members
  // and a trusted brand blunt undercutting rivals; a poor reputation makes
  // passengers more price-driven.
  const sens        = 1 - (offer.priceSensitivityReduction ?? 0);
  const priceUtil   = -(price / refPrice) * w.price * sens;
  const qualityUtil = (offer.qualityScore / 100) * w.quality;
  const freqUtil    = Math.log1p(offer.weeklyFrequency) * w.frequency;
  const connUtil    = offer.connectivityBonus;

  return priceUtil + qualityUtil + freqUtil + connUtil;
}

/**
 * Softmax over an array of utility values.
 * Returns an array of market share fractions (sum = 1).
 *
 * @param {number[]} utilities
 * @returns {number[]}
 */
export function softmax(utilities) {
  const max  = Math.max(...utilities);          // numerical stability
  const exps = utilities.map(u => Math.exp(u - max));
  const sum  = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

/**
 * Compute market share and revenue for ALL airlines on a route.
 *
 * @param {RouteMarket}    market
 * @param {AirlineOffer[]} offers   - one per airline serving this route
 * @returns {MarketShareResult[]}
 */
export function computeMarketShare(market, offers) {
  if (offers.length === 0) return [];

  // Single airline: monopoly, no softmax needed
  if (offers.length === 1) {
    return [_monopolyResult(market, offers[0])];
  }

  // Competitive market: softmax share allocation with price elasticity on market size.
  // Elasticity compresses the total market based on the share-weighted average price
  // across all carriers, so pricing above the reference price shrinks the pie rather
  // than just redistributing share.  Each airline's effective demand is:
  //   market.demand × elasticityFactor × softmaxShare
  //
  // Competitive fare compression: rivals lower what travelers consider a "normal"
  // fare on the pair (real-world yields compress when a second carrier enters, on
  // top of the passenger split). The elasticity/choke reference drifts down 5% per
  // additional carrier, floored at −10% — so holding monopoly-era fares in a
  // contested market shrinks demand instead of merely splitting it.
  const fareCompression = Math.max(
    COMPETITIVE_FARE_COMPRESSION_FLOOR,
    1 - COMPETITIVE_FARE_COMPRESSION_PER_RIVAL * (offers.length - 1)
  );
  const compressedRef    = market.referencePrice * fareCompression;
  const compressedBizRef = compressedRef * BUSINESS_PRICE_MULTIPLIER;

  const leisureUtils  = offers.map(o => computeUtility(o, market, 'leisure'));
  const businessUtils = offers.map(o => computeUtility(o, market, 'business'));
  const leisureShares  = softmax(leisureUtils);
  const businessShares = softmax(businessUtils);

  // Weighted-average prices across the market (share-weighted)
  const avgLeisurePrice  = offers.reduce((s, o, i) => s + o.economyPrice  * leisureShares[i],  0);
  const avgBusinessPrice = offers.reduce((s, o, i) => {
    const p = (o.businessPrice != null ? o.businessPrice : o.economyPrice * BUSINESS_PRICE_MULTIPLIER);
    return s + p * businessShares[i];
  }, 0);

  // Elasticity factors: demand shrinks when average market price is above the
  // (competition-compressed) reference
  const leisureElasticityFactor  = Math.pow(compressedRef / Math.max(avgLeisurePrice,  1), ELASTICITY.leisure);
  const businessElasticityFactor = Math.pow(
    compressedBizRef / Math.max(avgBusinessPrice, 1),
    ELASTICITY.business
  );
  const adjustedLeisureDemand  = Math.round(market.leisureDemand  * Math.min(1.5, leisureElasticityFactor));
  // Business pool scales with the market's share-weighted quality: an
  // all-budget pair loses business travelers to other modes entirely, while a
  // premium-served market attracts extra (see businessQualityCapture).
  const marketBizCapture = offers.reduce(
    (s, o, i) => s + businessQualityCapture(o.qualityScore) * businessShares[i], 0);
  const adjustedBusinessDemand = Math.round(
    market.businessDemand * Math.min(1.5, businessElasticityFactor) * marketBizCapture);

  return offers.map((offer, i) => {
    const lShare = leisureShares[i];
    const bShare = businessShares[i];

    // Raw demand allocation (elastic total × softmax share × per-fare choke).
    // The choke drives an individual carrier's demand to ~0 as its own fare
    // approaches the cap, even though the share softmax alone would still hand it
    // a sliver of the market.
    const bizPrice = offer.businessPrice != null
      ? offer.businessPrice
      : offer.economyPrice * BUSINESS_PRICE_MULTIPLIER;
    let leisurePax  = Math.round(
      adjustedLeisureDemand  * lShare * priceChokeFactor(offer.economyPrice, compressedRef)
    );
    // High quality stretches the tolerable business fare before the choke bites.
    let businessPax = Math.round(
      adjustedBusinessDemand * bShare
      * priceChokeFactor(bizPrice, compressedBizRef * businessFareTolerance(offer.qualityScore))
    );

    // Cap at capacity. Business is capped at its own cabin; leisure may then use
    // ALL remaining physical seats (premium + economy), not just the economy cabin,
    // so excess leisure demand fills spare seats instead of being discarded.
    const businessCapped = offer.businessPrice != null && businessPax > offer.businessSeats;
    if (businessCapped) businessPax = offer.businessSeats;
    // Prefer true total capacity; fall back to economy-seat cap (never below it).
    const leisureCapacity = offer.totalSeats != null
      ? Math.max(0, offer.totalSeats - businessPax)
      : offer.economySeats;
    const leisureCapped  = leisurePax  > leisureCapacity;
    if (leisureCapped)  leisurePax  = leisureCapacity;

    const economyRevenue  = leisurePax  * offer.economyPrice;
    const businessRevenue = offer.businessPrice != null ? businessPax * offer.businessPrice : 0;

    return {
      airlineId:       offer.airlineId,
      leisureShare:    lShare,
      businessShare:   bShare,
      leisurePax,
      businessPax,
      totalPax:        leisurePax + businessPax,
      economyRevenue:  Math.round(economyRevenue),
      businessRevenue: Math.round(businessRevenue),
      totalRevenue:    Math.round(economyRevenue + businessRevenue),
      capacityCapped:  leisureCapped || businessCapped,
    };
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _monopolyResult(market, offer) {
  const noBusiness = offer.businessPrice == null;

  // Loyalty/reputation blunt the elasticity exponent: less-price-sensitive
  // passengers punish above-reference fares less (and reward discounts less).
  const sens = 1 - (offer.priceSensitivityReduction ?? 0);

  // Compute business demand first so we can detect overflow before sizing leisure.
  // Quality gates how much of the business pool is capturable at all — a shoddy
  // product loses business travelers to other modes even without a rival airline —
  // and stretches the fare business travelers will tolerate (businessFareTolerance).
  const businessRef = market.referencePrice * BUSINESS_PRICE_MULTIPLIER
    * businessFareTolerance(offer.qualityScore);
  const businessAdj = noBusiness
    ? 0
    : Math.round(market.businessDemand
        * businessQualityCapture(offer.qualityScore)
        * Math.pow(businessRef / offer.businessPrice, ELASTICITY.business * sens)
        * priceChokeFactor(offer.businessPrice, businessRef));
  const businessPax = noBusiness ? 0 : Math.min(businessAdj, offer.businessSeats);

  // Business travelers who can't get a premium seat downgrade to economy rather
  // than not fly — fold overflow into the leisure / economy pool.
  const businessOverflow = noBusiness ? 0 : Math.max(0, businessAdj - businessPax);

  // When there's no business cabin, all business travelers fold into the leisure pool.
  // When business is offered but full, overflow also folds into the leisure pool.
  const leisurePool = noBusiness
    ? market.leisureDemand + market.businessDemand
    : market.leisureDemand + businessOverflow;

  // Demand with price elasticity applied
  const leisureAdj  = Math.round(
    leisurePool
      * Math.pow(market.referencePrice / offer.economyPrice, ELASTICITY.leisure * sens)
      * priceChokeFactor(offer.economyPrice, market.referencePrice)
  );

  // Cap leisure at TOTAL physical capacity (minus business pax), not just the
  // economy cabin. Leisure travelers also fill premium-economy/business seats via
  // the cabin fan-out, and any excess should fill spare seats anywhere on the
  // aircraft. Capping at economySeats alone froze load below 100% and made it
  // insensitive to price whenever demand exceeded the economy cabin.
  // If a caller didn't supply totalSeats, fall back to the economy-seat cap
  // (the original pre-fix behavior) — never subtract business pax from it, or we'd
  // cap BELOW the economy cabin and make load worse than before.
  const leisureCapacity = offer.totalSeats != null
    ? Math.max(0, offer.totalSeats - businessPax)
    : offer.economySeats;
  const leisurePax  = Math.min(leisureAdj, leisureCapacity);

  const economyRevenue  = leisurePax  * offer.economyPrice;
  const businessRevenue = businessPax * (offer.businessPrice ?? 0);

  return {
    airlineId:       offer.airlineId,
    leisureShare:    1,
    businessShare:   offer.businessPrice != null ? 1 : 0,
    leisurePax,
    businessPax,
    totalPax:        leisurePax + businessPax,
    economyRevenue:  Math.round(economyRevenue),
    businessRevenue: Math.round(businessRevenue),
    totalRevenue:    Math.round(economyRevenue + businessRevenue),
    capacityCapped:  leisurePax < leisureAdj || businessPax < businessAdj,
  };
}

// ─── Competitor definitions ────────────────────────────────────────────────────
// TODO: move to src/data/competitors.js once AI logic is added

/**
 * Starter set of AI competitors.
 * priceMultiplier is relative to referencePrice().
 * routes: { [routeKey]: { frequency, priceMultiplier } }
 *   routeKey = `${origin}-${destination}` (always alphabetical)
 */
export const COMPETITOR_AIRLINES = [
  // ── Legacy ────────────────────────────────────────────────────────────────
  { id: 'globalair',     name: 'Global Air',          homeHub: 'LHR', tier: 'legacy',  logoId: 'compass', baseQualityScore: 68, cash: 50_000_000, weeklyStats: null, routes: {} },
  { id: 'continentalx',  name: 'Continental Express', homeHub: 'JFK', tier: 'legacy',  logoId: 'eagle',   baseQualityScore: 70, cash: 45_000_000, weeklyStats: null, routes: {} },
  { id: 'eaglewings',    name: 'Eagle Wings',          homeHub: 'ATL', tier: 'legacy',  logoId: 'horizon', baseQualityScore: 65, cash: 35_000_000, weeklyStats: null, routes: {} },
  { id: 'pacificrim',    name: 'Pacific Rim Airlines', homeHub: 'NRT', tier: 'legacy',  logoId: 'jade',    baseQualityScore: 72, cash: 55_000_000, weeklyStats: null, routes: {} },
  { id: 'euroconnect',   name: 'Euro Connect',         homeHub: 'CDG', tier: 'legacy',  logoId: 'sapphire',baseQualityScore: 66, cash: 40_000_000, weeklyStats: null, routes: {} },
  { id: 'southerncross', name: 'Southern Cross',       homeHub: 'SYD', tier: 'legacy',  logoId: 'comet',   baseQualityScore: 64, cash: 30_000_000, weeklyStats: null, routes: {} },
  { id: 'iberoair',      name: 'Ibero Air',            homeHub: 'MAD', tier: 'legacy',  logoId: 'phoenix', baseQualityScore: 62, cash: 32_000_000, weeklyStats: null, routes: {} },
  { id: 'rhineair',      name: 'Rhine Air',            homeHub: 'FRA', tier: 'legacy',  logoId: 'summit',  baseQualityScore: 69, cash: 48_000_000, weeklyStats: null, routes: {} },

  // ── Budget ────────────────────────────────────────────────────────────────
  { id: 'zoomjet',       name: 'ZoomJet',              homeHub: 'ORD', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 38, cash: 15_000_000, weeklyStats: null, routes: {} },
  { id: 'fastfly',       name: 'FastFly',              homeHub: 'LAX', tier: 'budget',  logoId: 'prism',   baseQualityScore: 40, cash: 12_000_000, weeklyStats: null, routes: {} },
  { id: 'nofrills',      name: 'NoFrills',             homeHub: 'AMS', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 35, cash:  8_000_000, weeklyStats: null, routes: {} },
  { id: 'sunroute',      name: 'Sunroute',             homeHub: 'MIA', tier: 'budget',  logoId: 'phoenix', baseQualityScore: 42, cash: 10_000_000, weeklyStats: null, routes: {} },
  { id: 'asiaexpress',   name: 'Asia Express',         homeHub: 'BKK', tier: 'budget',  logoId: 'jade',    baseQualityScore: 36, cash:  9_000_000, weeklyStats: null, routes: {} },
  { id: 'vivasud',       name: 'Viva Sud',             homeHub: 'BOG', tier: 'budget',  logoId: 'prism',   baseQualityScore: 38, cash:  8_000_000, weeklyStats: null, routes: {} },

  // ── Premium ───────────────────────────────────────────────────────────────
  { id: 'apexair',       name: 'Apex Air',             homeHub: 'DXB', tier: 'premium', logoId: 'crown',   baseQualityScore: 85, cash: 80_000_000, weeklyStats: null, routes: {} },
  { id: 'gulfpearl',     name: 'Gulf Pearl',           homeHub: 'DOH', tier: 'premium', logoId: 'sapphire',baseQualityScore: 88, cash: 75_000_000, weeklyStats: null, routes: {} },
  { id: 'silkroute',     name: 'Silk Route',           homeHub: 'SIN', tier: 'premium', logoId: 'jade',    baseQualityScore: 82, cash: 70_000_000, weeklyStats: null, routes: {} },
  { id: 'orientprestige',name: 'Orient Prestige',      homeHub: 'HKG', tier: 'premium', logoId: 'compass', baseQualityScore: 80, cash: 65_000_000, weeklyStats: null, routes: {} },
  { id: 'nordicelite',   name: 'Nordic Elite',         homeHub: 'ARN', tier: 'premium', logoId: 'arctic',  baseQualityScore: 78, cash: 35_000_000, weeklyStats: null, routes: {} },
  { id: 'pampapremium',  name: 'Pampa Premium',        homeHub: 'GRU', tier: 'premium', logoId: 'summit',  baseQualityScore: 76, cash: 42_000_000, weeklyStats: null, routes: {} },

  // ── Legacy (new) ──────────────────────────────────────────────────────────
  { id: 'transafrica',      name: 'TransAfrica Airways', homeHub: 'NBO', tier: 'legacy',  logoId: 'comet',   baseQualityScore: 63, cash: 28_000_000, weeklyStats: null, routes: {} },
  { id: 'indiastar',        name: 'India Star',           homeHub: 'BOM', tier: 'legacy',  logoId: 'horizon', baseQualityScore: 67, cash: 42_000_000, weeklyStats: null, routes: {} },
  { id: 'canadianpride',    name: 'Canadian Pride',       homeHub: 'YYZ', tier: 'legacy',  logoId: 'eagle',   baseQualityScore: 66, cash: 38_000_000, weeklyStats: null, routes: {} },
  { id: 'bosphorusair',     name: 'Bosphorus Air',        homeHub: 'IST', tier: 'legacy',  logoId: 'compass', baseQualityScore: 65, cash: 36_000_000, weeklyStats: null, routes: {} },
  { id: 'dragoneast',       name: 'Dragon East',          homeHub: 'PVG', tier: 'legacy',  logoId: 'jade',    baseQualityScore: 68, cash: 44_000_000, weeklyStats: null, routes: {} },
  { id: 'aztecair',         name: 'Aztec Air',            homeHub: 'MEX', tier: 'legacy',  logoId: 'phoenix', baseQualityScore: 62, cash: 30_000_000, weeklyStats: null, routes: {} },
  { id: 'norseman',         name: 'Norseman Airlines',    homeHub: 'CPH', tier: 'legacy',  logoId: 'arctic',  baseQualityScore: 67, cash: 40_000_000, weeklyStats: null, routes: {} },
  { id: 'romaair',          name: 'Roma Air',             homeHub: 'FCO', tier: 'legacy',  logoId: 'summit',  baseQualityScore: 63, cash: 32_000_000, weeklyStats: null, routes: {} },
  { id: 'savannahair',      name: 'Savannah Air',         homeHub: 'JNB', tier: 'legacy',  logoId: 'horizon', baseQualityScore: 61, cash: 26_000_000, weeklyStats: null, routes: {} },
  { id: 'hellenicair',      name: 'Hellenic Air',         homeHub: 'ATH', tier: 'legacy',  logoId: 'compass', baseQualityScore: 60, cash: 24_000_000, weeklyStats: null, routes: {} },
  { id: 'maplecross',       name: 'Maple Cross Air',      homeHub: 'YVR', tier: 'legacy',  logoId: 'comet',   baseQualityScore: 64, cash: 34_000_000, weeklyStats: null, routes: {} },
  { id: 'cariocaair',       name: 'Carioca Air',          homeHub: 'GIG', tier: 'legacy',  logoId: 'phoenix', baseQualityScore: 61, cash: 28_000_000, weeklyStats: null, routes: {} },

  // ── Budget (new) ───────────────────────────────────────────────────────────
  { id: 'wingit',           name: 'WingIt',               homeHub: 'DUB', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 37, cash:  9_000_000, weeklyStats: null, routes: {} },
  { id: 'frugalfly',        name: 'FrugalFly',            homeHub: 'BER', tier: 'budget',  logoId: 'prism',   baseQualityScore: 36, cash:  7_000_000, weeklyStats: null, routes: {} },
  { id: 'bargainbird',      name: 'BargainBird',          homeHub: 'PHX', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 39, cash: 11_000_000, weeklyStats: null, routes: {} },
  { id: 'bahtjet',          name: 'BahtJet',              homeHub: 'KUL', tier: 'budget',  logoId: 'prism',   baseQualityScore: 37, cash:  8_000_000, weeklyStats: null, routes: {} },
  { id: 'rupeefly',         name: 'RupeeFly',             homeHub: 'DEL', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 35, cash:  7_000_000, weeklyStats: null, routes: {} },
  { id: 'pesojet',          name: 'PesoJet',              homeHub: 'MEX', tier: 'budget',  logoId: 'prism',   baseQualityScore: 38, cash:  9_000_000, weeklyStats: null, routes: {} },
  { id: 'suncoast',         name: 'Suncoast Air',         homeHub: 'MCO', tier: 'budget',  logoId: 'phoenix', baseQualityScore: 40, cash: 10_000_000, weeklyStats: null, routes: {} },
  { id: 'pampalow',         name: 'Pampa Low',            homeHub: 'EZE', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 36, cash:  8_000_000, weeklyStats: null, routes: {} },
  { id: 'saharafly',        name: 'SaharaFly',            homeHub: 'CAI', tier: 'budget',  logoId: 'prism',   baseQualityScore: 35, cash:  6_000_000, weeklyStats: null, routes: {} },
  { id: 'balticjet',        name: 'Baltic Jet',           homeHub: 'RIX', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 34, cash:  6_000_000, weeklyStats: null, routes: {} },

  // ── Premium (new) ──────────────────────────────────────────────────────────
  { id: 'tokyoprestige',    name: 'Tokyo Prestige',       homeHub: 'NRT', tier: 'premium', logoId: 'crown',   baseQualityScore: 87, cash: 72_000_000, weeklyStats: null, routes: {} },
  { id: 'zuerichfirst',     name: 'Zürich First',         homeHub: 'ZRH', tier: 'premium', logoId: 'sapphire',baseQualityScore: 84, cash: 68_000_000, weeklyStats: null, routes: {} },
  { id: 'mumbaiselect',     name: 'Mumbai Select',        homeHub: 'BOM', tier: 'premium', logoId: 'crown',   baseQualityScore: 80, cash: 62_000_000, weeklyStats: null, routes: {} },
  { id: 'shanghailux',      name: 'Shanghai Lux',         homeHub: 'PVG', tier: 'premium', logoId: 'jade',    baseQualityScore: 82, cash: 66_000_000, weeklyStats: null, routes: {} },
  { id: 'istanbulprestige', name: 'Istanbul Prestige',    homeHub: 'IST', tier: 'premium', logoId: 'sapphire',baseQualityScore: 79, cash: 58_000_000, weeklyStats: null, routes: {} },
  { id: 'patagoniafirst',   name: 'Patagonia First',      homeHub: 'SCL', tier: 'premium', logoId: 'crown',   baseQualityScore: 76, cash: 48_000_000, weeklyStats: null, routes: {} },
  { id: 'oceaniaprestige',  name: 'Oceania Prestige',     homeHub: 'AKL', tier: 'premium', logoId: 'compass', baseQualityScore: 78, cash: 52_000_000, weeklyStats: null, routes: {} },
  { id: 'capediamonds',     name: 'Cape Diamonds',        homeHub: 'CPT', tier: 'premium', logoId: 'sapphire',baseQualityScore: 77, cash: 50_000_000, weeklyStats: null, routes: {} },

  // ── Legacy (wave 3 — procedural starter networks) ─────────────────────────
  { id: 'cascadia',         name: 'Cascadia Airways',     homeHub: 'SEA', tier: 'legacy',  logoId: 'arctic',  baseQualityScore: 66, cash: 36_000_000, weeklyStats: null, routes: {} },
  { id: 'rockymountain',    name: 'Rocky Mountain Air',   homeHub: 'DEN', tier: 'legacy',  logoId: 'summit',  baseQualityScore: 64, cash: 34_000_000, weeklyStats: null, routes: {} },
  { id: 'lonestar',         name: 'Lone Star Airlines',   homeHub: 'DFW', tier: 'legacy',  logoId: 'horizon', baseQualityScore: 65, cash: 38_000_000, weeklyStats: null, routes: {} },
  { id: 'morningcalm',      name: 'Morning Calm Air',     homeHub: 'ICN', tier: 'legacy',  logoId: 'jade',    baseQualityScore: 70, cash: 46_000_000, weeklyStats: null, routes: {} },
  { id: 'mandarinwings',    name: 'Mandarin Wings',       homeHub: 'PEK', tier: 'legacy',  logoId: 'compass', baseQualityScore: 66, cash: 44_000_000, weeklyStats: null, routes: {} },
  { id: 'nusantara',        name: 'Nusantara Air',        homeHub: 'CGK', tier: 'legacy',  logoId: 'comet',   baseQualityScore: 62, cash: 30_000_000, weeklyStats: null, routes: {} },
  { id: 'volgaair',         name: 'Volga Air',            homeHub: 'SVO', tier: 'legacy',  logoId: 'eagle',   baseQualityScore: 60, cash: 28_000_000, weeklyStats: null, routes: {} },
  { id: 'pennine',          name: 'Pennine Airways',      homeHub: 'MAN', tier: 'legacy',  logoId: 'phoenix', baseQualityScore: 63, cash: 30_000_000, weeklyStats: null, routes: {} },

  // ── Budget (wave 3) ────────────────────────────────────────────────────────
  { id: 'fjordlow',         name: 'Fjord Low',            homeHub: 'OSL', tier: 'budget',  logoId: 'arctic',  baseQualityScore: 38, cash:  9_000_000, weeklyStats: null, routes: {} },
  { id: 'vistulajet',       name: 'VistulaJet',           homeHub: 'WAW', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 36, cash:  8_000_000, weeklyStats: null, routes: {} },
  { id: 'tagusjet',         name: 'TagusJet',             homeHub: 'LIS', tier: 'budget',  logoId: 'prism',   baseQualityScore: 37, cash:  8_000_000, weeklyStats: null, routes: {} },
  { id: 'redseaexpress',    name: 'Red Sea Express',      homeHub: 'JED', tier: 'budget',  logoId: 'phoenix', baseQualityScore: 35, cash:  9_000_000, weeklyStats: null, routes: {} },
  { id: 'naijajet',         name: 'NaijaJet',             homeHub: 'LOS', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 34, cash:  7_000_000, weeklyStats: null, routes: {} },
  { id: 'saigonsky',        name: 'Saigon Sky',           homeHub: 'SGN', tier: 'budget',  logoId: 'prism',   baseQualityScore: 37, cash:  8_000_000, weeklyStats: null, routes: {} },
  { id: 'islasol',          name: 'Isla Sol',             homeHub: 'CUN', tier: 'budget',  logoId: 'phoenix', baseQualityScore: 39, cash: 10_000_000, weeklyStats: null, routes: {} },

  // ── Premium (wave 3) ───────────────────────────────────────────────────────
  { id: 'kansairoyal',      name: 'Kansai Royal',         homeHub: 'KIX', tier: 'premium', logoId: 'crown',   baseQualityScore: 83, cash: 64_000_000, weeklyStats: null, routes: {} },
  { id: 'bavariaprestige',  name: 'Bavaria Prestige',     homeHub: 'MUC', tier: 'premium', logoId: 'sapphire',baseQualityScore: 82, cash: 62_000_000, weeklyStats: null, routes: {} },
  { id: 'levantluxe',       name: 'Levant Luxe',          homeHub: 'TLV', tier: 'premium', logoId: 'crown',   baseQualityScore: 78, cash: 50_000_000, weeklyStats: null, routes: {} },
  { id: 'andesgold',        name: 'Andes Gold',           homeHub: 'LIM', tier: 'premium', logoId: 'summit',  baseQualityScore: 75, cash: 44_000_000, weeklyStats: null, routes: {} },
  { id: 'abyssiniancrown',  name: 'Abyssinian Crown',     homeHub: 'ADD', tier: 'premium', logoId: 'crown',   baseQualityScore: 74, cash: 40_000_000, weeklyStats: null, routes: {} },
];

// ─── Hub tiers ────────────────────────────────────────────────────────────────

/**
 * Hub designation system: Focus City (tier 0) + three hub tiers.
 *
 * captureRate:      fraction of the gateway pool the player captures (before network bonus)
 * qualityBonus:     quality-score points added to routes through this hub
 * weeklyInvestment: ongoing weekly cost in $ on top of gate fees
 * minGates:         gate requirement to reach this tier
 * capex:            one-time construction cost to reach this tier
 * buildWeeks:       construction time before the tier activates (0 = instant)
 * routesRequired:   player routes touching the airport required to START the upgrade
 * intlRequired:     international destinations served from the airport required
 * tenureWeeks:      minimum weeks at the PREVIOUS tier before upgrading
 * throughputRequired: min connecting pax/wk (4-week avg over this hub) — T3 only
 * connPenalty:      logit utility penalty for own-metal connections over this hub
 *                   (lower = better transfer product; undesignated airports don't
 *                   monetize own-metal connections at all)
 * stationDiscount:  discount on ground handling + catering cost at this endpoint
 * layoverDiscount:  discount on crew layover cost (crews based here sleep at home)
 * maintFactor:      multiplier on weekly aircraft maintenance for routes touching it
 * gateRatioThreshold: routes-per-gate the hub handles before congestion sets in
 */
export const HUB_TIERS = {
  0: {
    name: 'Focus City',
    captureRate:      0.025,      // 10% of a Hub's external capture
    qualityBonus:     3,
    weeklyInvestment: 10_000,     // small dedicated team, priority gate block
    minGates:         5,
    capex:            1_000_000,
    buildWeeks:       0,          // instant
    routesRequired:   0,
    intlRequired:     0,
    tenureWeeks:      0,
    throughputRequired: 0,
    connPenalty:      0.48,       // self-connect-ish: long MCT, no transfer desk
    stationDiscount:  0.04,
    layoverDiscount:  0.08,
    maintFactor:      1.0,
    gateRatioThreshold: 1.2,
    color:            '#4cc38a',   // var(--green)
  },
  1: {
    name: 'Hub',
    captureRate:      0.25,
    qualityBonus:     5,
    weeklyInvestment: 25_000,     // dedicated agents, connection management, basic lounge
    minGates:         10,
    capex:            5_000_000,
    buildWeeks:       4,
    routesRequired:   4,
    intlRequired:     0,
    tenureWeeks:      0,
    throughputRequired: 0,
    connPenalty:      0.38,
    stationDiscount:  0.08,
    layoverDiscount:  0.15,
    maintFactor:      1.0,
    gateRatioThreshold: 1.5,
    color:            '#3ea6ff',   // var(--accent)
  },
  2: {
    name: 'Major Hub',
    captureRate:      0.38,
    qualityBonus:     12,
    weeklyInvestment: 150_000,    // full lounge, fast-connect baggage, connection desk staff
    minGates:         15,         // requires 5 more gates than tier-1 designation
    capex:            25_000_000,
    buildWeeks:       8,
    routesRequired:   20,
    intlRequired:     2,
    tenureWeeks:      0,
    throughputRequired: 0,
    connPenalty:      0.32,
    stationDiscount:  0.12,
    layoverDiscount:  0.25,
    maintFactor:      0.95,
    gateRatioThreshold: 2.0,
    color:            '#ffb43d',   // var(--yellow)
  },
  3: {
    name: 'International Gateway',
    captureRate:      0.55,
    qualityBonus:     20,
    weeklyInvestment: 500_000,    // premium lounges, dedicated transfer facilities, customs staff
    minGates:         20,
    capex:            100_000_000,
    buildWeeks:       16,
    routesRequired:   50,
    intlRequired:     6,
    tenureWeeks:      26,         // must have been a Major Hub for half a year
    throughputRequired: 1000,     // connecting pax/wk, 4-week average
    connPenalty:      0.26,
    stationDiscount:  0.16,
    layoverDiscount:  0.35,
    maintFactor:      0.92,
    gateRatioThreshold: 2.5,
    color:            '#a98bff',   // var(--purple)
  },
};

export const HUB_TIER_COUNT  = 3;
export const HUB_MIN_GATES   = 10;   // minimum gates to designate a full hub
export const FOCUS_MIN_GATES = 5;    // minimum gates to designate a focus city

/**
 * Gate-based hub congestion (replaces the old raw route-count curve).
 * Below the tier's routes-per-gate threshold: 1.0 (no penalty). Above it,
 * efficiency declines smoothly, floored at 0.55. Applies to CONNECTING capture
 * only — direct O&D demand is unaffected. Buying gates relieves it.
 *
 * @param {number} routesAt  - player routes touching the airport
 * @param {number} gatesAt   - player gates at the airport
 * @param {number} tier      - hub tier 0–3
 * @returns {number} 0.55–1.0
 */
/** Player routes touching an airport (tag-route stops included). */
export function playerRoutesAtAirport(routes, code) {
  let n = 0;
  for (const r of routes ?? []) {
    const stops = Array.isArray(r.stops) && r.stops.length >= 2 ? r.stops : [r.origin, r.destination];
    if (stops.includes(code)) n++;
  }
  return n;
}

/** Distinct international destinations served nonstop-or-tag from an airport. */
export function intlDestinationsFrom(routes, code) {
  const homeCountry = getAirport(code)?.country;
  const dests = new Set();
  for (const r of routes ?? []) {
    const stops = Array.isArray(r.stops) && r.stops.length >= 2 ? r.stops : [r.origin, r.destination];
    if (!stops.includes(code)) continue;
    for (const s of stops) {
      if (s === code) continue;
      const c = getAirport(s)?.country;
      if (c && c !== homeCountry) dests.add(s);
    }
  }
  return dests.size;
}

/**
 * Prerequisite checklist for designating/upgrading to a hub tier.
 * Shared by the GameContext reducers (enforcement) and HubManagement (display),
 * so the player always sees exactly what the reducer will check.
 *
 * @param {object} snap  - { routes, gates, homeCountry, hubs, hubThroughput, cash, absWeek }
 *                         hubThroughput: { [code]: number[] } — last weeks' connecting pax
 * @param {string} code  - airport
 * @param {number} targetTier - 0–3
 * @returns {{ ok: boolean, checks: [{ id, label, met, current, required }] }}
 */
export function hubUpgradeChecklist(snap, code, targetTier) {
  const tierDef = HUB_TIERS[targetTier];
  if (!tierDef) return { ok: false, checks: [] };
  const {
    routes = [], gates = {}, homeCountry = null, hubs = {},
    hubThroughput = {}, cash = 0, absWeek = 0,
  } = snap;

  const checks = [];
  const add = (id, label, current, required, met) =>
    checks.push({ id, label, current, required, met });

  const gateCount = gates[code] ?? 0;
  add('gates', `${tierDef.minGates} gates at ${code}`, gateCount, tierDef.minGates, gateCount >= tierDef.minGates);

  add('capex', `${(tierDef.capex / 1e6).toFixed(0)}M construction budget`, cash, tierDef.capex, cash >= tierDef.capex);

  if (tierDef.routesRequired > 0) {
    const routesAt = playerRoutesAtAirport(routes, code);
    add('routes', `${tierDef.routesRequired} routes at ${code}`, routesAt, tierDef.routesRequired, routesAt >= tierDef.routesRequired);
  }

  if (tierDef.intlRequired > 0) {
    const intl = intlDestinationsFrom(routes, code);
    add('intl', `${tierDef.intlRequired} international destinations from ${code}`, intl, tierDef.intlRequired, intl >= tierDef.intlRequired);
  }

  if (tierDef.tenureWeeks > 0) {
    const since  = hubs[code]?.tierSince ?? absWeek;
    const tenure = Math.max(0, absWeek - since);
    add('tenure', `${tierDef.tenureWeeks} weeks as ${HUB_TIERS[targetTier - 1]?.name ?? 'previous tier'}`, tenure, tierDef.tenureWeeks, tenure >= tierDef.tenureWeeks);
  }

  if (tierDef.throughputRequired > 0) {
    const hist = hubThroughput[code] ?? [];
    const recent = hist.slice(-4);
    const avg = recent.length >= 4
      ? Math.round(recent.reduce((s, v) => s + v, 0) / recent.length)
      : null;   // need 4 weeks of data
    add('throughput', `${tierDef.throughputRequired} connecting pax/wk (4-wk avg)`, avg ?? 0, tierDef.throughputRequired, avg != null && avg >= tierDef.throughputRequired);
  }

  // Country rules: full hubs (tier ≥ 1) are home-country only; focus cities are
  // allowed anywhere but max ONE per country outside the home country.
  const apCountry = getAirport(code)?.country ?? null;
  if (targetTier >= 1 && homeCountry) {
    const ok = apCountry === homeCountry;
    add('country', `Hub must be in ${homeCountry}`, apCountry ?? '—', homeCountry, ok);
  }
  if (targetTier === 0 && homeCountry && apCountry && apCountry !== homeCountry) {
    const taken = Object.entries(hubs).some(([c, h]) =>
      c !== code && h?.tier === 0 && getAirport(c)?.country === apCountry
    );
    add('foreignCap', `Max 1 focus city per foreign country (${apCountry})`, taken ? 1 : 0, 1, !taken);
  }

  return { ok: checks.every(c => c.met), checks };
}

export function hubCongestionFactor(routesAt, gatesAt, tier) {
  if (!gatesAt || gatesAt <= 0) return 1.0;   // gates unknown (e.g. UI preview) — no penalty
  const tierDef   = HUB_TIERS[tier] ?? HUB_TIERS[1];
  const threshold = tierDef.gateRatioThreshold ?? 1.5;
  const ratio     = (routesAt ?? 0) / gatesAt;
  if (ratio <= threshold) return 1.0;
  return Math.max(0.55, Math.pow(threshold / ratio, 0.6));
}

// ─── Connecting passengers ────────────────────────────────────────────────────

/**
 * Gateway score for each airport: how transit-heavy it is (0–1).
 * High scores = lots of passengers connecting through, low = mostly O&D.
 * Airports not listed default to 0.20.
 *
 * Sources: approximate real-world transit fractions.
 */
export const AIRPORT_GATEWAY_SCORES = {
  DXB: 0.85,  // Dubai: ~75% of traffic is transit
  SIN: 0.80,  // Changi: major Asia-Pacific hub
  AMS: 0.75,  // Schiphol: ~40% transit, punches above its weight
  FRA: 0.70,  // Frankfurt: major European hub-of-hubs
  LHR: 0.65,  // Heathrow: busiest European O&D, still ~35% transit
  HKG: 0.70,  // Hong Kong: key Asia gateway
  IST: 0.65,  // Istanbul: growing hub, links East–West
  ICN: 0.60,  // Incheon: Asia's most-connected single airport
  CDG: 0.55,  // Paris: significant but more O&D than FRA/AMS
  NRT: 0.55,  // Tokyo Narita: gateway to Japan
  JFK: 0.50,  // New York: global gateway, moderate transit
  ORD: 0.48,  // Chicago: US hub-of-hubs
  LAX: 0.45,  // LA: large but terminal-fragmented
  // All others: 0.20 (default)
};

/**
 * Weekly transit passenger pool at an airport (one-directional through-pax).
 * Calibrated so DXB yields ~680 base connecting pax available to capture.
 */
const BASE_GATEWAY_POOL = 800;

/**
 * Compute connecting passenger demand for one endpoint of a route.
 *
 * @param {string}   airportCode       - the airport to evaluate
 * @param {object}   hubs              - player's hub map: { [code]: { tier: 1|2|3 } }
 * @param {number}   playerRoutesHere  - how many player routes touch this airport (incl. this one)
 * @param {number}   ticketPrice       - one-way ticket price on the route ($)
 * @param {object}   [opts]
 * @param {number}   [opts.weeklyFrequency=7]  - one-way departures per week on this route
 * @param {number}   [opts.distKm=0]           - great-circle distance of the route (km)
 * @param {string[]} [opts.partnerHubCodes=[]] - homeHub codes of alliance/codeshare partners
 *                                               (one entry per partner; duplicates allowed)
 * @returns {{ pax, revenue, yield, source, tier?, externalPax?, internalPax?, freqMult?, factors? }}
 */
function connectingAtEndpoint(airportCode, hubs, playerRoutesHere, ticketPrice, {
  weeklyFrequency = 7,
  distKm = 0,
  partnerHubCodes = [],
  gatesHere = 0,
  contestFactor = 1.0,
} = {}) {
  const gwScore = AIRPORT_GATEWAY_SCORES[airportCode] ?? 0.20;
  const pool    = gwScore * BASE_GATEWAY_POOL;

  const hubInfo = hubs[airportCode]; // { tier } or undefined

  if (hubInfo && hubInfo.tier != null) {
    // EXTERNAL feed only: gateway/partner airlines routing pax through your hub
    // onto this route. Boosted by long-haul (higher connecting fraction) and
    // alliance/codeshare partners hubbing here.
    //
    // The old "internal feed" term (abstract pool × spoke count) is GONE —
    // own-metal connecting revenue is now computed from real A→hub→C itineraries
    // in network.js (computeOwnMetalODRevenue) and added by simulation.js.
    // The external base rate is halved accordingly (0.15 → 0.075) so the
    // residual pool only represents feed the itinerary model can't see.
    //
    // Congestion is gate-based (routes per gate vs the tier's threshold) and
    // relieved by buying gates. Contest: competitors hubbing at the same
    // airport siphon the external pool (contestFactor from network.js).

    const tierDef = HUB_TIERS[hubInfo.tier] ?? HUB_TIERS[1];

    // Distance bonus: long-haul routes have a higher connecting fraction.
    const distBonus = Math.min(0.35, distKm / 25000) / 2;

    // Partner boost: each alliance/codeshare partner hubbing here adds 20%.
    const partnerCount  = partnerHubCodes.filter(c => c === airportCode).length;
    const partnerBoost  = Math.min(0.60, partnerCount * 0.20);

    // Frequency multiplier: more departures = more usable connection windows
    // for feed arriving from partners/gateway traffic.
    const freqMult = Math.min(1.5, 0.4 + (Math.log1p(weeklyFrequency) / Math.log1p(7)) * 0.6);

    const congestion = hubCongestionFactor(playerRoutesHere, gatesHere, hubInfo.tier);

    const externalPax = Math.round(
      pool * tierDef.captureRate * (0.075 + distBonus) * (1 + partnerBoost)
      * freqMult * congestion * Math.max(0, Math.min(1, contestFactor))
    );

    const pax = externalPax;
    return {
      pax,
      revenue:      Math.round(pax * ticketPrice),
      yield:        1.0,
      source:       'own-hub',
      tier:         hubInfo.tier,
      // ── breakdown for UI display ──
      externalPax,
      internalPax:  0,   // internal feed now comes from real itineraries (network.js)
      freqMult:     +freqMult.toFixed(2),
      distBonus:    +distBonus.toFixed(2),
      partnerBoost: +partnerBoost.toFixed(2),
      congestion:   +congestion.toFixed(2),
      contestFactor: +Math.max(0, Math.min(1, contestFactor)).toFixed(2),
    };
  }

  if (gwScore >= 0.50) {
    // Major partner hub: interline/codeshare agreement → 80% yield
    const pax = Math.round(pool * 0.06);
    return { pax, revenue: Math.round(pax * ticketPrice * 0.8), yield: 0.8, source: 'partner-hub' };
  }

  // Minor gateway: light transit traffic, 80% yield
  const pax = Math.round(pool * 0.03);
  return { pax, revenue: Math.round(pax * ticketPrice * 0.8), yield: 0.8, source: 'gateway' };
}

/**
 * Total connecting demand for a route (both endpoints combined).
 *
 * @param {string}   origin
 * @param {string}   destination
 * @param {object}   hubs                   - { [airportCode]: { tier: 1|2|3 } }
 * @param {number}   playerRoutesAtOrigin   - # of player routes at origin (incl. this one)
 * @param {number}   playerRoutesAtDest     - # of player routes at destination (incl. this one)
 * @param {number}   ticketPrice
 * @param {object}   [options]
 * @param {number}   [options.weeklyFrequency=7]  - one-way departures/week on this route
 * @param {string[]} [options.partnerHubCodes=[]] - homeHub codes of alliance/codeshare partners
 * @returns {{
 *   totalPax:     number,
 *   totalRevenue: number,
 *   origin:       object,
 *   destination:  object,
 * }}
 */
export function computeConnectingDemand(
  origin, destination, hubs,
  playerRoutesAtOrigin, playerRoutesAtDest,
  ticketPrice,
  options = {}
) {
  // Accept legacy string hub for backward compat
  const hubsMap = typeof hubs === 'string'
    ? (hubs ? { [hubs]: { tier: 1 } } : {})
    : (hubs ?? {});

  const {
    weeklyFrequency = 7,
    partnerHubCodes = [],
    gates = {},            // { [code]: gateCount } — for gate-based congestion
    contestFactors = {},   // { [code]: 0–1 } — competitor hub contest (network.js)
  } = options;
  // Compute distance once here and pass to both endpoints
  const distKm = routeDistance(origin, destination);

  // Connecting passengers now respond to price. They are less elastic than pure O&D
  // leisure travelers (see connectingPriceFactor), but an overpriced route still
  // bleeds its feed: the factor tapers demand as the fare rises and hits zero at the
  // price cap, mirroring direct demand. This replaces the old crude "cap the fare at
  // 4× reference" revenue hack — the elasticity + choke do that job smoothly now, and
  // pax counts (not just revenue) fall with price the way real connecting traffic does.
  const refPrice    = referencePrice(origin, destination);
  const priceFactor = connectingPriceFactor(ticketPrice, refPrice);

  const originSide = _scaleConnecting(
    connectingAtEndpoint(origin, hubsMap, playerRoutesAtOrigin, ticketPrice, {
      weeklyFrequency, distKm, partnerHubCodes,
      gatesHere: gates[origin] ?? 0, contestFactor: contestFactors[origin] ?? 1.0,
    }),
    priceFactor
  );
  const destSide = _scaleConnecting(
    connectingAtEndpoint(destination, hubsMap, playerRoutesAtDest, ticketPrice, {
      weeklyFrequency, distKm, partnerHubCodes,
      gatesHere: gates[destination] ?? 0, contestFactor: contestFactors[destination] ?? 1.0,
    }),
    priceFactor
  );
  return {
    totalPax:     originSide.pax + destSide.pax,
    totalRevenue: originSide.revenue + destSide.revenue,
    origin:       originSide,
    destination:  destSide,
    priceFactor:  +priceFactor.toFixed(3),
  };
}

/**
 * Scale a connecting-endpoint result by a 0–1 price-response factor, keeping the
 * UI breakdown fields (external/internal pax) consistent with the scaled totals.
 * @param {object} side    result from connectingAtEndpoint
 * @param {number} factor  0–1 price response
 * @returns {object}
 */
function _scaleConnecting(side, factor) {
  if (factor >= 1) return side;
  const scaled = { ...side };
  scaled.pax     = Math.round(side.pax     * factor);
  scaled.revenue = Math.round(side.revenue * factor);
  if (side.externalPax != null) scaled.externalPax = Math.round(side.externalPax * factor);
  if (side.internalPax != null) scaled.internalPax = Math.round(side.internalPax * factor);
  return scaled;
}

/**
 * Default routes for each AI competitor, keyed by airline id.
 * routeKey = two IATA codes joined by '-', sorted alphabetically.
 * frequency = one-way departures per week.
 * priceMultiplier = multiplier applied to referencePrice() for this route.
 *
 * Design rationale per carrier:
 *   globalair (LHR, legacy)  — transatlantic + European corridors + long-haul hubs
 *   zoomjet   (ORD, budget)  — domestic US hub-and-spoke from Chicago, high frequency
 *   apexair   (DXB, premium) — Gulf-hub ultra-long-haul to Europe/Americas/Asia
 */
const COMPETITOR_DEFAULT_ROUTES = {
  globalair: {
    'AMS-LHR': { frequency: 14, priceMultiplier: 1.05 }, // London–Amsterdam short-haul workhorse
    'CDG-LHR': { frequency: 14, priceMultiplier: 1.05 }, // London–Paris flagship
    'FRA-LHR': { frequency: 10, priceMultiplier: 1.05 }, // London–Frankfurt business corridor
    'JFK-LHR': { frequency:  7, priceMultiplier: 1.08 }, // Transatlantic flagship
    'LHR-YYZ': { frequency:  7, priceMultiplier: 1.05 }, // London–Toronto
    'DXB-LHR': { frequency:  7, priceMultiplier: 1.06 }, // London–Dubai (contested with apexair)
    'LHR-SIN': { frequency:  5, priceMultiplier: 1.07 }, // London–Singapore ultra-long-haul
  },
  zoomjet: {
    'ATL-ORD': { frequency: 21, priceMultiplier: 0.78 }, // Chicago–Atlanta high-density
    'DEN-ORD': { frequency: 14, priceMultiplier: 0.76 }, // Chicago–Denver
    'DFW-ORD': { frequency: 14, priceMultiplier: 0.76 }, // Chicago–Dallas
    'JFK-ORD': { frequency: 21, priceMultiplier: 0.80 }, // Chicago–New York shuttle
    'LAX-ORD': { frequency: 21, priceMultiplier: 0.79 }, // Chicago–LA budget flagship
    'LAS-ORD': { frequency: 14, priceMultiplier: 0.74 }, // Chicago–Vegas leisure route
    'MIA-ORD': { frequency: 14, priceMultiplier: 0.77 }, // Chicago–Miami
    'MSP-ORD': { frequency: 10, priceMultiplier: 0.75 }, // Chicago–Minneapolis regional
  },
  apexair: {
    'BOM-DXB': { frequency:  7, priceMultiplier: 1.45 }, // Dubai–Mumbai premium
    'CDG-DXB': { frequency:  7, priceMultiplier: 1.50 }, // Dubai–Paris premium
    'DEL-DXB': { frequency:  7, priceMultiplier: 1.42 }, // Dubai–Delhi premium
    'DXB-JFK': { frequency:  7, priceMultiplier: 1.55 }, // Dubai–New York ultra-premium
    'DXB-JNB': { frequency:  5, priceMultiplier: 1.40 }, // Dubai–Johannesburg
    'DXB-LHR': { frequency:  7, priceMultiplier: 1.48 }, // Dubai–London (contested with globalair)
    'DXB-SIN': { frequency:  7, priceMultiplier: 1.45 }, // Dubai–Singapore
  },

  // ── Legacy ────────────────────────────────────────────────────────────────
  continentalx: {
    'BOS-JFK': { frequency: 21, priceMultiplier: 1.04 }, // NY–Boston shuttle
    'CDG-JFK': { frequency:  5, priceMultiplier: 1.06 }, // NY–Paris
    'JFK-LAX': { frequency: 14, priceMultiplier: 1.06 }, // NY–LA flagship
    'JFK-LHR': { frequency:  7, priceMultiplier: 1.07 }, // Transatlantic (vs Global Air)
    'JFK-MIA': { frequency: 14, priceMultiplier: 1.04 }, // NY–Miami
    'JFK-ORD': { frequency: 14, priceMultiplier: 1.05 }, // NY–Chicago
    'JFK-SFO': { frequency:  7, priceMultiplier: 1.05 }, // NY–San Francisco
  },
  eaglewings: {
    'ATL-CUN': { frequency:  7, priceMultiplier: 0.98 }, // Atlanta–Cancún leisure
    'ATL-DFW': { frequency: 14, priceMultiplier: 1.04 }, // Atlanta–Dallas
    'ATL-GRU': { frequency:  5, priceMultiplier: 1.07 }, // Atlanta–São Paulo
    'ATL-JFK': { frequency: 14, priceMultiplier: 1.04 }, // Atlanta–New York
    'ATL-LAX': { frequency: 10, priceMultiplier: 1.05 }, // Atlanta–LA
    'ATL-MIA': { frequency: 14, priceMultiplier: 1.03 }, // Atlanta–Miami
    'ATL-ORD': { frequency: 14, priceMultiplier: 1.04 }, // Atlanta–Chicago (vs ZoomJet)
  },
  pacificrim: {
    'HKG-NRT': { frequency:  7, priceMultiplier: 1.05 }, // Tokyo–Hong Kong
    'ICN-NRT': { frequency: 14, priceMultiplier: 1.04 }, // Tokyo–Seoul
    'LAX-NRT': { frequency:  7, priceMultiplier: 1.08 }, // Transpacific flagship
    'NRT-PEK': { frequency: 10, priceMultiplier: 1.05 }, // Tokyo–Beijing
    'NRT-SFO': { frequency:  5, priceMultiplier: 1.08 }, // Tokyo–San Francisco
    'NRT-SIN': { frequency:  7, priceMultiplier: 1.06 }, // Tokyo–Singapore
  },
  euroconnect: {
    'BCN-CDG': { frequency:  7, priceMultiplier: 1.03 }, // Paris–Barcelona
    'CDG-DXB': { frequency:  7, priceMultiplier: 1.06 }, // Paris–Dubai (vs Apex)
    'CDG-FRA': { frequency: 14, priceMultiplier: 1.03 }, // Paris–Frankfurt
    'CDG-JFK': { frequency:  7, priceMultiplier: 1.06 }, // Paris–NY (vs Continental)
    'CDG-LHR': { frequency: 14, priceMultiplier: 1.04 }, // Paris–London (vs Global Air)
    'CDG-MAD': { frequency: 10, priceMultiplier: 1.03 }, // Paris–Madrid
    'CDG-NRT': { frequency:  5, priceMultiplier: 1.07 }, // Paris–Tokyo
  },
  southerncross: {
    'AKL-SYD': { frequency: 10, priceMultiplier: 1.05 }, // Sydney–Auckland
    'BNE-SYD': { frequency: 21, priceMultiplier: 1.02 }, // Sydney–Brisbane domestic
    'HKG-SYD': { frequency:  7, priceMultiplier: 1.07 }, // Sydney–Hong Kong
    'LAX-SYD': { frequency:  4, priceMultiplier: 1.09 }, // Sydney–LA transpacific
    'MEL-SYD': { frequency: 28, priceMultiplier: 1.03 }, // Sydney–Melbourne (busiest domestic)
    'NRT-SYD': { frequency:  5, priceMultiplier: 1.08 }, // Sydney–Tokyo
    'SIN-SYD': { frequency:  7, priceMultiplier: 1.07 }, // Sydney–Singapore
  },
  iberoair: {
    'BCN-MAD': { frequency: 28, priceMultiplier: 1.02 }, // Madrid–Barcelona shuttle
    'EZE-MAD': { frequency:  4, priceMultiplier: 1.07 }, // Madrid–Buenos Aires
    'GRU-MAD': { frequency:  5, priceMultiplier: 1.07 }, // Madrid–São Paulo
    'LHR-MAD': { frequency:  7, priceMultiplier: 1.04 }, // Madrid–London (vs Global Air)
    'MAD-MEX': { frequency:  5, priceMultiplier: 1.06 }, // Madrid–Mexico City
    'MAD-MIA': { frequency:  5, priceMultiplier: 1.06 }, // Madrid–Miami
    'MAD-SCL': { frequency:  4, priceMultiplier: 1.07 }, // Madrid–Santiago
  },
  rhineair: {
    'AMS-FRA': { frequency: 14, priceMultiplier: 1.03 }, // Frankfurt–Amsterdam
    'FRA-JFK': { frequency:  7, priceMultiplier: 1.07 }, // Frankfurt–New York
    'FRA-LHR': { frequency: 10, priceMultiplier: 1.04 }, // Frankfurt–London (vs Global Air)
    'FRA-MUC': { frequency: 14, priceMultiplier: 1.02 }, // Frankfurt–Munich
    'FRA-NRT': { frequency:  5, priceMultiplier: 1.07 }, // Frankfurt–Tokyo
    'FRA-PEK': { frequency:  5, priceMultiplier: 1.08 }, // Frankfurt–Beijing
    'FRA-SIN': { frequency:  5, priceMultiplier: 1.08 }, // Frankfurt–Singapore
  },

  // ── Budget ────────────────────────────────────────────────────────────────
  fastfly: {
    'DEN-LAX': { frequency: 14, priceMultiplier: 0.76 }, // LA–Denver
    'JFK-LAX': { frequency: 14, priceMultiplier: 0.80 }, // LA–NY (vs Continental)
    'LAS-LAX': { frequency: 28, priceMultiplier: 0.72 }, // LA–Vegas leisure
    'LAX-ORD': { frequency: 21, priceMultiplier: 0.79 }, // LA–Chicago (vs ZoomJet)
    'LAX-PHX': { frequency: 21, priceMultiplier: 0.75 }, // LA–Phoenix
    'LAX-SEA': { frequency: 14, priceMultiplier: 0.77 }, // LA–Seattle
    'LAX-SFO': { frequency: 21, priceMultiplier: 0.73 }, // LA–SF short-haul
  },
  nofrills: {
    'AMS-ATH': { frequency:  7, priceMultiplier: 0.73 }, // Amsterdam–Athens
    'AMS-BCN': { frequency: 14, priceMultiplier: 0.76 }, // Amsterdam–Barcelona
    'AMS-DUB': { frequency:  7, priceMultiplier: 0.74 }, // Amsterdam–Dublin
    'AMS-FCO': { frequency: 10, priceMultiplier: 0.74 }, // Amsterdam–Rome
    'AMS-IST': { frequency: 10, priceMultiplier: 0.74 }, // Amsterdam–Istanbul
    'AMS-LHR': { frequency: 14, priceMultiplier: 0.72 }, // Amsterdam–London (vs Global Air)
    'AMS-MAD': { frequency: 10, priceMultiplier: 0.75 }, // Amsterdam–Madrid
  },
  sunroute: {
    'ATL-MIA': { frequency: 10, priceMultiplier: 0.77 }, // Miami–Atlanta
    'BOG-MIA': { frequency:  7, priceMultiplier: 0.80 }, // Miami–Bogotá
    'CUN-MIA': { frequency: 14, priceMultiplier: 0.76 }, // Miami–Cancún
    'GRU-MIA': { frequency:  5, priceMultiplier: 0.82 }, // Miami–São Paulo
    'JFK-MIA': { frequency: 14, priceMultiplier: 0.78 }, // Miami–NY (vs Continental)
    'LIM-MIA': { frequency:  7, priceMultiplier: 0.80 }, // Miami–Lima
    'MIA-ORD': { frequency: 14, priceMultiplier: 0.77 }, // Miami–Chicago (vs ZoomJet)
  },
  asiaexpress: {
    'BKK-CGK': { frequency: 10, priceMultiplier: 0.74 }, // Bangkok–Jakarta
    'BKK-DEL': { frequency:  7, priceMultiplier: 0.77 }, // Bangkok–Delhi
    'BKK-HKG': { frequency: 10, priceMultiplier: 0.75 }, // Bangkok–Hong Kong
    'BKK-ICN': { frequency:  7, priceMultiplier: 0.76 }, // Bangkok–Seoul
    'BKK-KUL': { frequency: 21, priceMultiplier: 0.72 }, // Bangkok–KL (busiest SE Asia)
    'BKK-MNL': { frequency:  7, priceMultiplier: 0.74 }, // Bangkok–Manila
    'BKK-SIN': { frequency: 14, priceMultiplier: 0.73 }, // Bangkok–Singapore
  },
  vivasud: {
    'BOG-EZE': { frequency:  5, priceMultiplier: 0.80 }, // Bogotá–Buenos Aires
    'BOG-GRU': { frequency:  7, priceMultiplier: 0.80 }, // Bogotá–São Paulo
    'BOG-LIM': { frequency: 10, priceMultiplier: 0.77 }, // Bogotá–Lima
    'BOG-MEX': { frequency:  7, priceMultiplier: 0.79 }, // Bogotá–Mexico City
    'BOG-MIA': { frequency:  7, priceMultiplier: 0.80 }, // Bogotá–Miami (vs Sunroute)
    'BOG-PTY': { frequency:  7, priceMultiplier: 0.75 }, // Bogotá–Panama City
    'BOG-SCL': { frequency:  5, priceMultiplier: 0.78 }, // Bogotá–Santiago
  },

  // ── Premium ───────────────────────────────────────────────────────────────
  gulfpearl: {
    'BOM-DOH': { frequency:  7, priceMultiplier: 1.42 }, // Doha–Mumbai (vs Apex)
    'CDG-DOH': { frequency:  7, priceMultiplier: 1.48 }, // Doha–Paris
    'DEL-DOH': { frequency:  7, priceMultiplier: 1.38 }, // Doha–Delhi
    'DOH-JFK': { frequency:  7, priceMultiplier: 1.52 }, // Doha–New York
    'DOH-LHR': { frequency:  7, priceMultiplier: 1.45 }, // Doha–London
    'DOH-NRT': { frequency:  5, priceMultiplier: 1.48 }, // Doha–Tokyo
    'DOH-SIN': { frequency:  7, priceMultiplier: 1.45 }, // Doha–Singapore
  },
  silkroute: {
    'CDG-SIN': { frequency:  5, priceMultiplier: 1.48 }, // Singapore–Paris
    'DEL-SIN': { frequency:  7, priceMultiplier: 1.38 }, // Singapore–Delhi
    'HKG-SIN': { frequency:  7, priceMultiplier: 1.42 }, // Singapore–Hong Kong
    'LHR-SIN': { frequency:  5, priceMultiplier: 1.48 }, // Singapore–London (vs Global Air)
    'NRT-SIN': { frequency:  7, priceMultiplier: 1.45 }, // Singapore–Tokyo
    'SIN-SYD': { frequency:  7, priceMultiplier: 1.40 }, // Singapore–Sydney
    'SIN-ZRH': { frequency:  4, priceMultiplier: 1.50 }, // Singapore–Zurich
  },
  orientprestige: {
    'CDG-HKG': { frequency:  5, priceMultiplier: 1.48 }, // HK–Paris
    'HKG-JFK': { frequency:  5, priceMultiplier: 1.52 }, // HK–New York
    'HKG-LAX': { frequency:  5, priceMultiplier: 1.50 }, // HK–LA
    'HKG-LHR': { frequency:  7, priceMultiplier: 1.45 }, // HK–London
    'HKG-NRT': { frequency:  7, priceMultiplier: 1.42 }, // HK–Tokyo (vs Pacific Rim)
    'HKG-SIN': { frequency:  7, priceMultiplier: 1.40 }, // HK–Singapore (vs Silk Route)
    'HKG-SYD': { frequency:  5, priceMultiplier: 1.42 }, // HK–Sydney
  },
  nordicelite: {
    'AMS-ARN': { frequency:  7, priceMultiplier: 1.30 }, // Stockholm–Amsterdam
    'ARN-CDG': { frequency:  7, priceMultiplier: 1.32 }, // Stockholm–Paris
    'ARN-DXB': { frequency:  5, priceMultiplier: 1.42 }, // Stockholm–Dubai
    'ARN-HEL': { frequency:  7, priceMultiplier: 1.28 }, // Stockholm–Helsinki
    'ARN-JFK': { frequency:  5, priceMultiplier: 1.45 }, // Stockholm–New York
    'ARN-LHR': { frequency:  7, priceMultiplier: 1.35 }, // Stockholm–London
    'ARN-NRT': { frequency:  4, priceMultiplier: 1.48 }, // Stockholm–Tokyo
  },
  pampapremium: {
    'BOG-GRU': { frequency:  5, priceMultiplier: 1.38 }, // São Paulo–Bogotá
    'CDG-GRU': { frequency:  4, priceMultiplier: 1.48 }, // São Paulo–Paris
    'EZE-GRU': { frequency: 14, priceMultiplier: 1.30 }, // São Paulo–Buenos Aires
    'GRU-JFK': { frequency:  5, priceMultiplier: 1.45 }, // São Paulo–New York
    'GRU-LHR': { frequency:  5, priceMultiplier: 1.45 }, // São Paulo–London
    'GRU-MIA': { frequency:  5, priceMultiplier: 1.40 }, // São Paulo–Miami
    'GRU-SCL': { frequency:  7, priceMultiplier: 1.32 }, // São Paulo–Santiago
  },
  // ── Legacy (new) ──────────────────────────────────────────────────────────
  transafrica: {
    'JNB-NBO': { frequency:  7, priceMultiplier: 1.02 }, // Nairobi–Johannesburg
    'DXB-NBO': { frequency:  7, priceMultiplier: 1.04 }, // Nairobi–Dubai
    'LHR-NBO': { frequency:  5, priceMultiplier: 1.07 }, // Nairobi–London
    'CDG-NBO': { frequency:  3, priceMultiplier: 1.06 }, // Nairobi–Paris
    'BOM-NBO': { frequency:  4, priceMultiplier: 1.05 }, // Nairobi–Mumbai
    'NBO-SIN': { frequency:  4, priceMultiplier: 1.06 }, // Nairobi–Singapore
  },
  indiastar: {
    'BOM-DEL': { frequency: 21, priceMultiplier: 1.02 }, // Mumbai–Delhi domestic
    'BOM-DXB': { frequency: 14, priceMultiplier: 1.04 }, // Mumbai–Dubai
    'BOM-LHR': { frequency:  7, priceMultiplier: 1.07 }, // Mumbai–London
    'BOM-SIN': { frequency:  7, priceMultiplier: 1.05 }, // Mumbai–Singapore
    'BOM-CDG': { frequency:  4, priceMultiplier: 1.06 }, // Mumbai–Paris
    'BOM-NRT': { frequency:  4, priceMultiplier: 1.07 }, // Mumbai–Tokyo
  },
  canadianpride: {
    'JFK-YYZ': { frequency: 14, priceMultiplier: 1.04 }, // Toronto–New York
    'LHR-YYZ': { frequency:  7, priceMultiplier: 1.06 }, // Toronto–London
    'LAX-YYZ': { frequency:  7, priceMultiplier: 1.05 }, // Toronto–LA
    'CDG-YYZ': { frequency:  4, priceMultiplier: 1.06 }, // Toronto–Paris
    'NRT-YYZ': { frequency:  4, priceMultiplier: 1.07 }, // Toronto–Tokyo
    'YVR-YYZ': { frequency: 14, priceMultiplier: 1.03 }, // Toronto–Vancouver
  },
  bosphorusair: {
    'IST-LHR': { frequency: 10, priceMultiplier: 1.04 }, // Istanbul–London
    'FRA-IST': { frequency:  7, priceMultiplier: 1.03 }, // Istanbul–Frankfurt
    'CDG-IST': { frequency:  7, priceMultiplier: 1.04 }, // Istanbul–Paris
    'IST-JFK': { frequency:  5, priceMultiplier: 1.07 }, // Istanbul–New York
    'DXB-IST': { frequency:  7, priceMultiplier: 1.05 }, // Istanbul–Dubai
    'DEL-IST': { frequency:  5, priceMultiplier: 1.05 }, // Istanbul–Delhi
    'BKK-IST': { frequency:  4, priceMultiplier: 1.06 }, // Istanbul–Bangkok
  },
  dragoneast: {
    'NRT-PVG': { frequency: 14, priceMultiplier: 1.05 }, // Shanghai–Tokyo
    'HKG-PVG': { frequency: 14, priceMultiplier: 1.04 }, // Shanghai–Hong Kong
    'PVG-SIN': { frequency:  7, priceMultiplier: 1.05 }, // Shanghai–Singapore
    'LHR-PVG': { frequency:  5, priceMultiplier: 1.08 }, // Shanghai–London
    'FRA-PVG': { frequency:  4, priceMultiplier: 1.07 }, // Shanghai–Frankfurt
    'LAX-PVG': { frequency:  5, priceMultiplier: 1.08 }, // Shanghai–LA
  },
  aztecair: {
    'JFK-MEX': { frequency: 10, priceMultiplier: 1.05 }, // Mexico City–New York
    'LAX-MEX': { frequency: 14, priceMultiplier: 1.04 }, // Mexico City–LA
    'MEX-MIA': { frequency: 10, priceMultiplier: 1.04 }, // Mexico City–Miami
    'MAD-MEX': { frequency:  5, priceMultiplier: 1.06 }, // Mexico City–Madrid
    'BOG-MEX': { frequency:  7, priceMultiplier: 1.05 }, // Mexico City–Bogotá
    'MEX-ORD': { frequency:  7, priceMultiplier: 1.04 }, // Mexico City–Chicago
  },
  norseman: {
    'CPH-LHR': { frequency:  7, priceMultiplier: 1.04 }, // Copenhagen–London
    'CPH-FRA': { frequency:  7, priceMultiplier: 1.03 }, // Copenhagen–Frankfurt
    'CDG-CPH': { frequency:  7, priceMultiplier: 1.04 }, // Copenhagen–Paris
    'CPH-JFK': { frequency:  5, priceMultiplier: 1.07 }, // Copenhagen–New York
    'CPH-DXB': { frequency:  5, priceMultiplier: 1.06 }, // Copenhagen–Dubai
    'ARN-CPH': { frequency: 10, priceMultiplier: 1.02 }, // Copenhagen–Stockholm
  },
  romaair: {
    'FCO-LHR': { frequency:  7, priceMultiplier: 1.04 }, // Rome–London
    'CDG-FCO': { frequency: 10, priceMultiplier: 1.03 }, // Rome–Paris
    'FCO-FRA': { frequency:  7, priceMultiplier: 1.03 }, // Rome–Frankfurt
    'FCO-JFK': { frequency:  5, priceMultiplier: 1.07 }, // Rome–New York
    'DXB-FCO': { frequency:  5, priceMultiplier: 1.06 }, // Rome–Dubai
    'FCO-MAD': { frequency:  7, priceMultiplier: 1.03 }, // Rome–Madrid
  },
  savannahair: {
    'JNB-LHR': { frequency:  5, priceMultiplier: 1.06 }, // Johannesburg–London
    'DXB-JNB': { frequency:  7, priceMultiplier: 1.05 }, // Johannesburg–Dubai
    'JNB-NBO': { frequency:  7, priceMultiplier: 1.02 }, // Johannesburg–Nairobi
    'CDG-JNB': { frequency:  3, priceMultiplier: 1.06 }, // Johannesburg–Paris
    'GRU-JNB': { frequency:  3, priceMultiplier: 1.06 }, // Johannesburg–São Paulo
    'JNB-SIN': { frequency:  4, priceMultiplier: 1.07 }, // Johannesburg–Singapore
  },
  hellenicair: {
    'ATH-LHR': { frequency:  7, priceMultiplier: 1.04 }, // Athens–London
    'ATH-CDG': { frequency:  7, priceMultiplier: 1.03 }, // Athens–Paris
    'ATH-FRA': { frequency:  7, priceMultiplier: 1.03 }, // Athens–Frankfurt
    'ATH-DXB': { frequency:  5, priceMultiplier: 1.05 }, // Athens–Dubai
    'ATH-JFK': { frequency:  4, priceMultiplier: 1.07 }, // Athens–New York
    'AMS-ATH': { frequency: 10, priceMultiplier: 1.02 }, // Athens–Amsterdam
  },
  maplecross: {
    'LAX-YVR': { frequency: 14, priceMultiplier: 1.04 }, // Vancouver–LA
    'NRT-YVR': { frequency:  5, priceMultiplier: 1.07 }, // Vancouver–Tokyo
    'LHR-YVR': { frequency:  5, priceMultiplier: 1.06 }, // Vancouver–London
    'SFO-YVR': { frequency: 10, priceMultiplier: 1.03 }, // Vancouver–San Francisco
    'YVR-YYZ': { frequency: 10, priceMultiplier: 1.04 }, // Vancouver–Toronto
    'HKG-YVR': { frequency:  4, priceMultiplier: 1.07 }, // Vancouver–Hong Kong
  },
  cariocaair: {
    'EZE-GIG': { frequency:  7, priceMultiplier: 1.03 }, // Rio–Buenos Aires
    'GIG-GRU': { frequency: 14, priceMultiplier: 1.02 }, // Rio–São Paulo
    'GIG-LHR': { frequency:  4, priceMultiplier: 1.07 }, // Rio–London
    'CDG-GIG': { frequency:  3, priceMultiplier: 1.07 }, // Rio–Paris
    'GIG-MIA': { frequency:  5, priceMultiplier: 1.05 }, // Rio–Miami
    'GIG-LAX': { frequency:  3, priceMultiplier: 1.08 }, // Rio–LA
  },

  // ── Budget (new) ───────────────────────────────────────────────────────────
  wingit: {
    'DUB-LHR': { frequency: 21, priceMultiplier: 0.72 }, // Dublin–London
    'BCN-DUB': { frequency: 10, priceMultiplier: 0.74 }, // Dublin–Barcelona
    'CDG-DUB': { frequency: 14, priceMultiplier: 0.73 }, // Dublin–Paris
    'DUB-FCO': { frequency:  7, priceMultiplier: 0.75 }, // Dublin–Rome
    'AMS-DUB': { frequency: 10, priceMultiplier: 0.73 }, // Dublin–Amsterdam
    'DUB-MAD': { frequency:  7, priceMultiplier: 0.74 }, // Dublin–Madrid
    'DUB-LIS': { frequency:  7, priceMultiplier: 0.73 }, // Dublin–Lisbon
  },
  frugalfly: {
    'BER-LHR': { frequency: 14, priceMultiplier: 0.73 }, // Berlin–London
    'BCN-BER': { frequency: 10, priceMultiplier: 0.74 }, // Berlin–Barcelona
    'BER-FCO': { frequency:  7, priceMultiplier: 0.74 }, // Berlin–Rome
    'BER-MAD': { frequency:  7, priceMultiplier: 0.74 }, // Berlin–Madrid
    'AMS-BER': { frequency: 14, priceMultiplier: 0.72 }, // Berlin–Amsterdam
    'ATH-BER': { frequency:  7, priceMultiplier: 0.75 }, // Berlin–Athens
    'BER-DUB': { frequency:  7, priceMultiplier: 0.73 }, // Berlin–Dublin
  },
  bargainbird: {
    'LAX-PHX': { frequency: 28, priceMultiplier: 0.74 }, // Phoenix–LA
    'LAS-PHX': { frequency: 14, priceMultiplier: 0.73 }, // Phoenix–Vegas
    'DEN-PHX': { frequency: 14, priceMultiplier: 0.74 }, // Phoenix–Denver
    'ORD-PHX': { frequency: 14, priceMultiplier: 0.76 }, // Phoenix–Chicago
    'DFW-PHX': { frequency: 10, priceMultiplier: 0.75 }, // Phoenix–Dallas
    'PHX-SFO': { frequency: 14, priceMultiplier: 0.75 }, // Phoenix–San Francisco
    'PHX-SEA': { frequency:  7, priceMultiplier: 0.76 }, // Phoenix–Seattle
  },
  bahtjet: {
    'KUL-SIN': { frequency: 28, priceMultiplier: 0.72 }, // KL–Singapore
    'BKK-KUL': { frequency: 21, priceMultiplier: 0.73 }, // KL–Bangkok
    'CGK-KUL': { frequency: 14, priceMultiplier: 0.73 }, // KL–Jakarta
    'KUL-MNL': { frequency: 10, priceMultiplier: 0.74 }, // KL–Manila
    'HKG-KUL': { frequency:  7, priceMultiplier: 0.75 }, // KL–Hong Kong
    'DEL-KUL': { frequency:  7, priceMultiplier: 0.76 }, // KL–Delhi
    'BOM-KUL': { frequency:  7, priceMultiplier: 0.76 }, // KL–Mumbai
  },
  rupeefly: {
    'BOM-DEL': { frequency: 28, priceMultiplier: 0.72 }, // Delhi–Mumbai
    'DEL-DXB': { frequency: 21, priceMultiplier: 0.74 }, // Delhi–Dubai
    'DEL-SIN': { frequency: 14, priceMultiplier: 0.74 }, // Delhi–Singapore
    'BKK-DEL': { frequency:  7, priceMultiplier: 0.75 }, // Delhi–Bangkok
    'DEL-KUL': { frequency:  7, priceMultiplier: 0.75 }, // Delhi–KL
    'DEL-LHR': { frequency:  7, priceMultiplier: 0.78 }, // Delhi–London
    'DEL-ICN': { frequency:  5, priceMultiplier: 0.77 }, // Delhi–Seoul
  },
  pesojet: {
    'LAX-MEX': { frequency: 21, priceMultiplier: 0.76 }, // Mexico City–LA
    'MEX-ORD': { frequency: 14, priceMultiplier: 0.77 }, // Mexico City–Chicago
    'MEX-MIA': { frequency: 14, priceMultiplier: 0.76 }, // Mexico City–Miami
    'DFW-MEX': { frequency: 10, priceMultiplier: 0.76 }, // Mexico City–Dallas
    'BOG-MEX': { frequency:  7, priceMultiplier: 0.80 }, // Mexico City–Bogotá
    'LIM-MEX': { frequency:  5, priceMultiplier: 0.79 }, // Mexico City–Lima
    'JFK-MEX': { frequency:  7, priceMultiplier: 0.79 }, // Mexico City–New York
  },
  suncoast: {
    'JFK-MCO': { frequency: 21, priceMultiplier: 0.76 }, // Orlando–New York
    'MCO-ORD': { frequency: 14, priceMultiplier: 0.77 }, // Orlando–Chicago
    'LAX-MCO': { frequency:  7, priceMultiplier: 0.79 }, // Orlando–LA
    'MCO-MIA': { frequency: 21, priceMultiplier: 0.74 }, // Orlando–Miami
    'ATL-MCO': { frequency: 14, priceMultiplier: 0.76 }, // Orlando–Atlanta
    'BOS-MCO': { frequency: 10, priceMultiplier: 0.77 }, // Orlando–Boston
    'DFW-MCO': { frequency:  7, priceMultiplier: 0.77 }, // Orlando–Dallas
  },
  pampalow: {
    'EZE-GRU': { frequency: 14, priceMultiplier: 0.76 }, // Buenos Aires–São Paulo
    'EZE-SCL': { frequency: 21, priceMultiplier: 0.73 }, // Buenos Aires–Santiago
    'BOG-EZE': { frequency:  7, priceMultiplier: 0.78 }, // Buenos Aires–Bogotá
    'EZE-LIM': { frequency:  7, priceMultiplier: 0.76 }, // Buenos Aires–Lima
    'EZE-MIA': { frequency:  5, priceMultiplier: 0.81 }, // Buenos Aires–Miami
    'EZE-MAD': { frequency:  4, priceMultiplier: 0.82 }, // Buenos Aires–Madrid
    'EZE-GIG': { frequency:  7, priceMultiplier: 0.76 }, // Buenos Aires–Rio
  },
  saharafly: {
    'AMS-CAI': { frequency: 10, priceMultiplier: 0.74 }, // Cairo–Amsterdam
    'CAI-CDG': { frequency:  7, priceMultiplier: 0.75 }, // Cairo–Paris
    'CAI-FRA': { frequency:  7, priceMultiplier: 0.74 }, // Cairo–Frankfurt
    'CAI-LHR': { frequency:  7, priceMultiplier: 0.75 }, // Cairo–London
    'CAI-IST': { frequency: 10, priceMultiplier: 0.73 }, // Cairo–Istanbul
    'CAI-DXB': { frequency: 14, priceMultiplier: 0.74 }, // Cairo–Dubai
    'CAI-NBO': { frequency:  5, priceMultiplier: 0.76 }, // Cairo–Nairobi
  },
  balticjet: {
    'LHR-RIX': { frequency:  7, priceMultiplier: 0.73 }, // Riga–London
    'AMS-RIX': { frequency:  7, priceMultiplier: 0.72 }, // Riga–Amsterdam
    'CDG-RIX': { frequency:  7, priceMultiplier: 0.73 }, // Riga–Paris
    'BCN-RIX': { frequency:  5, priceMultiplier: 0.74 }, // Riga–Barcelona
    'FCO-RIX': { frequency:  5, priceMultiplier: 0.74 }, // Riga–Rome
    'DUB-RIX': { frequency:  5, priceMultiplier: 0.73 }, // Riga–Dublin
    'FRA-RIX': { frequency:  7, priceMultiplier: 0.73 }, // Riga–Frankfurt
  },

  // ── Premium (new) ──────────────────────────────────────────────────────────
  tokyoprestige: {
    'HKG-NRT': { frequency:  7, priceMultiplier: 1.42 }, // Tokyo–Hong Kong
    'NRT-SIN': { frequency:  7, priceMultiplier: 1.45 }, // Tokyo–Singapore
    'LHR-NRT': { frequency:  5, priceMultiplier: 1.48 }, // Tokyo–London
    'JFK-NRT': { frequency:  5, priceMultiplier: 1.52 }, // Tokyo–New York
    'CDG-NRT': { frequency:  4, priceMultiplier: 1.48 }, // Tokyo–Paris
    'NRT-SYD': { frequency:  5, priceMultiplier: 1.40 }, // Tokyo–Sydney
  },
  zuerichfirst: {
    'LHR-ZRH': { frequency:  7, priceMultiplier: 1.38 }, // Zurich–London
    'JFK-ZRH': { frequency:  5, priceMultiplier: 1.50 }, // Zurich–New York
    'DXB-ZRH': { frequency:  5, priceMultiplier: 1.42 }, // Zurich–Dubai
    'SIN-ZRH': { frequency:  4, priceMultiplier: 1.48 }, // Zurich–Singapore
    'HKG-ZRH': { frequency:  4, priceMultiplier: 1.48 }, // Zurich–Hong Kong
    'NRT-ZRH': { frequency:  3, priceMultiplier: 1.50 }, // Zurich–Tokyo
  },
  mumbaiselect: {
    'BOM-DXB': { frequency: 10, priceMultiplier: 1.38 }, // Mumbai–Dubai premium
    'BOM-LHR': { frequency:  5, priceMultiplier: 1.45 }, // Mumbai–London
    'BOM-SIN': { frequency:  7, priceMultiplier: 1.40 }, // Mumbai–Singapore
    'BOM-HKG': { frequency:  5, priceMultiplier: 1.40 }, // Mumbai–Hong Kong
    'BOM-JFK': { frequency:  3, priceMultiplier: 1.52 }, // Mumbai–New York
    'BOM-NRT': { frequency:  4, priceMultiplier: 1.45 }, // Mumbai–Tokyo
  },
  shanghailux: {
    'HKG-PVG': { frequency:  7, priceMultiplier: 1.38 }, // Shanghai–Hong Kong
    'NRT-PVG': { frequency:  7, priceMultiplier: 1.40 }, // Shanghai–Tokyo
    'PVG-SIN': { frequency:  5, priceMultiplier: 1.42 }, // Shanghai–Singapore
    'LHR-PVG': { frequency:  4, priceMultiplier: 1.50 }, // Shanghai–London
    'JFK-PVG': { frequency:  3, priceMultiplier: 1.55 }, // Shanghai–New York
    'DXB-PVG': { frequency:  4, priceMultiplier: 1.45 }, // Shanghai–Dubai
  },
  istanbulprestige: {
    'IST-LHR': { frequency:  7, priceMultiplier: 1.38 }, // Istanbul–London
    'IST-JFK': { frequency:  5, priceMultiplier: 1.48 }, // Istanbul–New York
    'DXB-IST': { frequency:  7, priceMultiplier: 1.40 }, // Istanbul–Dubai
    'IST-SIN': { frequency:  4, priceMultiplier: 1.45 }, // Istanbul–Singapore
    'HKG-IST': { frequency:  4, priceMultiplier: 1.45 }, // Istanbul–Hong Kong
    'IST-NRT': { frequency:  3, priceMultiplier: 1.48 }, // Istanbul–Tokyo
  },
  patagoniafirst: {
    'LHR-SCL': { frequency:  4, priceMultiplier: 1.45 }, // Santiago–London
    'JFK-SCL': { frequency:  4, priceMultiplier: 1.48 }, // Santiago–New York
    'MIA-SCL': { frequency:  5, priceMultiplier: 1.40 }, // Santiago–Miami
    'GRU-SCL': { frequency:  7, priceMultiplier: 1.30 }, // Santiago–São Paulo
    'MAD-SCL': { frequency:  4, priceMultiplier: 1.42 }, // Santiago–Madrid
    'BOG-SCL': { frequency:  5, priceMultiplier: 1.35 }, // Santiago–Bogotá
  },
  oceaniaprestige: {
    'AKL-SYD': { frequency:  7, priceMultiplier: 1.38 }, // Auckland–Sydney
    'AKL-HKG': { frequency:  5, priceMultiplier: 1.42 }, // Auckland–Hong Kong
    'AKL-SIN': { frequency:  5, priceMultiplier: 1.40 }, // Auckland–Singapore
    'AKL-NRT': { frequency:  4, priceMultiplier: 1.45 }, // Auckland–Tokyo
    'AKL-LAX': { frequency:  4, priceMultiplier: 1.48 }, // Auckland–LA
    'AKL-LHR': { frequency:  3, priceMultiplier: 1.55 }, // Auckland–London
  },
  capediamonds: {
    'CPT-JNB': { frequency:  7, priceMultiplier: 1.30 }, // Cape Town–Johannesburg
    'CPT-LHR': { frequency:  4, priceMultiplier: 1.48 }, // Cape Town–London
    'CPT-DXB': { frequency:  5, priceMultiplier: 1.42 }, // Cape Town–Dubai
    'CDG-CPT': { frequency:  3, priceMultiplier: 1.45 }, // Cape Town–Paris
    'CPT-SIN': { frequency:  3, priceMultiplier: 1.48 }, // Cape Town–Singapore
    'AMS-CPT': { frequency:  3, priceMultiplier: 1.45 }, // Cape Town–Amsterdam
  },
};

// ─── Competitor fleets ───────────────────────────────────────────────────────
//
// Competitors own real aircraft. Each route is flown by a concrete aircraft TYPE
// (range-constrained, sized to the carrier's tier) operated by a number of tails
// derived from the route's distance and weekly frequency. The fleet array is the
// inventory you can inspect before buying the carrier and inherit when you do.

/** Seat size a carrier of each tier prefers when choosing aircraft for a route. */
const TIER_SEAT_TARGET = { budget: 160, legacy: 250, premium: 330 };

/** Approx one-way block time (hours): ~820 km/h cruise + 0.5h taxi/turn. */
function blockTimeOneWay(distKm) { return distKm / 820 + 0.5; }

/**
 * Pick the aircraft type a `tier` carrier would fly on a route of `distKm`.
 * Only types with enough range qualify; among those we take the one whose seat
 * count is closest to the tier's preferred size. Returns null if nothing fits
 * (the route is then simply not served — the range constraint in action).
 */
export function pickCompetitorAircraftType(distKm, tier) {
  const target  = TIER_SEAT_TARGET[tier] ?? 200;
  const capable = AIRCRAFT_TYPES.filter(t => (t.range ?? 0) >= distKm);
  if (capable.length === 0) return null;

  // Score each capable aircraft: seat misfit vs the tier's preferred size, plus a
  // mild penalty for range far in excess of the mission. This favours a properly
  // sized airframe for the stage length — a widebody on transatlantic routes, a
  // narrowbody on short hops — instead of an ultra-long-range jet flown short or a
  // marginal small jet stretched across an ocean.
  const need = distKm * 1.25;   // reserve allowance
  const score = (t) =>
    Math.abs((t.seats ?? 0) - target) + Math.max(0, (t.range ?? 0) - need) * 0.005;
  return capable.slice().sort((a, b) => score(a) - score(b))[0];
}

/** Tails needed to fly `frequency` weekly departures over `distKm`, assuming ~98 utilisable block-h/tail/wk. */
export function tailsForRoute(distKm, frequency) {
  const WEEKLY_BLOCK_PER_TAIL = 14 * 7;   // 98h
  const blockPerWeek = blockTimeOneWay(distKm) * frequency * 2;  // round trips
  return Math.max(1, Math.ceil(blockPerWeek / WEEKLY_BLOCK_PER_TAIL));
}

let _tailSeq = 0;
function newTailId(airlineId) { return `${airlineId}-t${(++_tailSeq).toString(36)}`; }

/**
 * Build a tail for a competitor route. `aged` true gives a used airframe (start
 * of game); false gives a fresh delivery (mid-game expansion).
 */
export function makeCompetitorTail(airlineId, typeId, routeKey, aged) {
  return {
    id:       newTailId(airlineId),
    typeId,
    routeKey,
    ageWeeks: aged ? 40 + Math.floor(Math.random() * 260) : 0,
  };
}

/**
 * Annotate a carrier's routes with their assigned aircraft type + tail count and
 * build the matching `fleet` inventory. Returns a NEW carrier object.
 */
export function buildCompetitorFleet(airline) {
  const routes = {};
  const fleet  = [];
  for (const [routeKey, cfg] of Object.entries(airline.routes ?? {})) {
    const [a, b] = routeKey.split('-');
    const dist   = routeDistance(a, b);
    const type   = pickCompetitorAircraftType(dist, airline.tier);
    if (!type) { routes[routeKey] = cfg; continue; }   // no in-range type — leave unflown
    const tails  = tailsForRoute(dist, cfg.frequency ?? 7);
    routes[routeKey] = { ...cfg, aircraftType: type.id, tails };
    for (let i = 0; i < tails; i++) fleet.push(makeCompetitorTail(airline.id, type.id, routeKey, true));
  }
  return { ...airline, routes, fleet };
}

// ─── Procedural starter networks ─────────────────────────────────────────────

/** Per-tier default price multiplier (jittered per route in generateStarterRoutes). */
export const TIER_PRICE_MULT = { budget: 0.76, legacy: 1.04, premium: 1.45 };

/** Starting network size by tier for procedurally generated carriers. */
const TIER_STARTER_ROUTES = { budget: 7, legacy: 6, premium: 5 };

let _bigAirportCache = null;
/** Mega + major airports — the candidate destination pool for AI route planning. */
export function bigAirports() {
  if (!_bigAirportCache) {
    _bigAirportCache = AIRPORTS.filter(a => a.tier === 'mega' || a.tier === 'major');
  }
  return _bigAirportCache;
}

/**
 * Generate a plausible starting network for a carrier with no scripted routes:
 * the top-demand city pairs from its home hub that its tier's aircraft can fly,
 * with distance-appropriate frequency and tier pricing. Short/medium routes are
 * mildly preferred so young networks look regional-first, like real carriers.
 *
 * @param {CompetitorAirline} airline
 * @param {number} [count]  routes to open (defaults by tier)
 * @returns {object} routes map { routeKey: { frequency, priceMultiplier } }
 */
export function generateStarterRoutes(airline, count) {
  const n   = count ?? TIER_STARTER_ROUTES[airline.tier] ?? 6;
  const hub = airline.homeHub;
  const priceBase = TIER_PRICE_MULT[airline.tier] ?? 1.0;

  const scored = [];
  for (const ap of bigAirports()) {
    if (ap.code === hub) continue;
    const dist = routeDistance(hub, ap.code);
    if (!dist || dist < 300) continue;
    if (!pickCompetitorAircraftType(dist, airline.tier)) continue;   // out of range
    const demand = baseCityPairDemand(hub, ap.code);
    if (!demand) continue;
    // Prefer dense pairs; mild haircut for very long stage lengths.
    scored.push({ code: ap.code, dist, demand, score: demand / (1 + dist / 9000) });
  }
  scored.sort((a, b) => b.score - a.score);

  // Sample from the top of the list with light randomness so two carriers
  // sharing a hub don't build identical networks.
  const pool = scored.slice(0, Math.max(n * 2, 12));
  for (let i = pool.length - 1; i > 0; i--) {
    if (Math.random() < 0.35) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }

  const routes = {};
  for (const cand of pool.slice(0, n)) {
    const key   = [hub, cand.code].sort().join('-');
    const seats = TIER_SEAT_TARGET[airline.tier] ?? 200;
    const freq  = Math.max(3, Math.min(21, Math.round(cand.demand / (seats * 0.75))));
    const priceMultiplier = +(priceBase * (0.97 + Math.random() * 0.06)).toFixed(3);
    routes[key] = { frequency: freq, priceMultiplier };
  }
  return routes;
}

/**
 * Populate each competitor's `routes` map with their starting network, then
 * build their owned fleet. Mutates routes in place and attaches `fleet`.
 * Carriers without a scripted default network get a procedural one.
 *
 * @param {CompetitorAirline[]} [competitors]  defaults to COMPETITOR_AIRLINES
 * @returns {CompetitorAirline[]}  carriers with routes + fleet populated
 */
export function initializeCompetitorRoutes(competitors = COMPETITOR_AIRLINES) {
  return competitors.map(airline => {
    const defaults = COMPETITOR_DEFAULT_ROUTES[airline.id] ?? generateStarterRoutes(airline);
    Object.assign(airline.routes, defaults);
    return buildCompetitorFleet(airline);
  });
}

/**
 * Scheduled route expansions for AI competitors.
 *
 * weeksAfterStart: total game-weeks elapsed when the expansion fires
 *   (week 1 = first week of game; fires as that week completes).
 * Re-using an existing routeKey upgrades frequency/price on that route.
 *
 * Growth philosophy per carrier:
 *   globalair — deepens European frequency early, then adds long-haul spokes year 1–2
 *   zoomjet   — saturates Chicago–East corridor fast, then spreads West and into Canada
 *   apexair   — methodically adds one premium Asia-Pacific spoke per quarter
 */
export const COMPETITOR_EXPANSION_SCHEDULE = [
  // ── Global Air (LHR, legacy) ──────────────────────────────────────────────
  { airlineId: 'globalair', weeksAfterStart:  8, routeKey: 'CDG-LHR', frequency: 21, priceMultiplier: 1.05 }, // Paris → 3×/day
  { airlineId: 'globalair', weeksAfterStart: 13, routeKey: 'LHR-MAD', frequency:  7, priceMultiplier: 1.04 }, // London–Madrid launch
  { airlineId: 'globalair', weeksAfterStart: 26, routeKey: 'JFK-LHR', frequency: 10, priceMultiplier: 1.08 }, // Transatlantic frequency boost
  { airlineId: 'globalair', weeksAfterStart: 26, routeKey: 'LHR-NRT', frequency:  5, priceMultiplier: 1.08 }, // London–Tokyo launch
  { airlineId: 'globalair', weeksAfterStart: 39, routeKey: 'GRU-LHR', frequency:  4, priceMultiplier: 1.06 }, // London–São Paulo launch
  { airlineId: 'globalair', weeksAfterStart: 52, routeKey: 'ICN-LHR', frequency:  5, priceMultiplier: 1.07 }, // London–Seoul launch
  { airlineId: 'globalair', weeksAfterStart: 78, routeKey: 'LHR-SYD', frequency:  3, priceMultiplier: 1.09 }, // London–Sydney launch

  // ── ZoomJet (ORD, budget) ─────────────────────────────────────────────────
  { airlineId: 'zoomjet',   weeksAfterStart:  8, routeKey: 'JFK-ORD',  frequency: 28, priceMultiplier: 0.80 }, // NY shuttle → 4×/day
  { airlineId: 'zoomjet',   weeksAfterStart: 13, routeKey: 'BOS-ORD',  frequency:  7, priceMultiplier: 0.78 }, // Chicago–Boston launch
  { airlineId: 'zoomjet',   weeksAfterStart: 26, routeKey: 'ORD-PHX',  frequency: 14, priceMultiplier: 0.76 }, // Chicago–Phoenix launch
  { airlineId: 'zoomjet',   weeksAfterStart: 39, routeKey: 'ORD-SEA',  frequency: 10, priceMultiplier: 0.77 }, // Chicago–Seattle launch
  { airlineId: 'zoomjet',   weeksAfterStart: 52, routeKey: 'ORD-YYZ',  frequency:  7, priceMultiplier: 0.82 }, // Chicago–Toronto launch
  { airlineId: 'zoomjet',   weeksAfterStart: 78, routeKey: 'ORD-SFO',  frequency: 14, priceMultiplier: 0.79 }, // Chicago–San Francisco launch

  // ── Apex Air (DXB, premium) ───────────────────────────────────────────────
  { airlineId: 'apexair',   weeksAfterStart: 13, routeKey: 'DXB-NRT',  frequency:  5, priceMultiplier: 1.48 }, // Dubai–Tokyo launch
  { airlineId: 'apexair',   weeksAfterStart: 26, routeKey: 'DXB-HKG',  frequency:  7, priceMultiplier: 1.42 }, // Dubai–Hong Kong launch
  { airlineId: 'apexair',   weeksAfterStart: 39, routeKey: 'DXB-ICN',  frequency:  5, priceMultiplier: 1.45 }, // Dubai–Seoul launch
  { airlineId: 'apexair',   weeksAfterStart: 39, routeKey: 'DXB-JFK',  frequency: 10, priceMultiplier: 1.55 }, // NY frequency boost
  { airlineId: 'apexair',   weeksAfterStart: 52, routeKey: 'DXB-SYD',  frequency:  4, priceMultiplier: 1.40 }, // Dubai–Sydney launch
  { airlineId: 'apexair',   weeksAfterStart: 78, routeKey: 'DXB-LAX',  frequency:  5, priceMultiplier: 1.52 }, // Dubai–LA launch

  // ── Continental Express (JFK, legacy) ─────────────────────────────────────
  { airlineId: 'continentalx', weeksAfterStart:  8, routeKey: 'JFK-ORD',  frequency: 21, priceMultiplier: 1.05 }, // NY–Chicago freq boost
  { airlineId: 'continentalx', weeksAfterStart: 13, routeKey: 'JFK-DFW',  frequency:  7, priceMultiplier: 1.05 }, // NY–Dallas launch
  { airlineId: 'continentalx', weeksAfterStart: 26, routeKey: 'JFK-YYZ',  frequency:  7, priceMultiplier: 1.04 }, // NY–Toronto launch
  { airlineId: 'continentalx', weeksAfterStart: 39, routeKey: 'JFK-NRT',  frequency:  5, priceMultiplier: 1.08 }, // NY–Tokyo launch
  { airlineId: 'continentalx', weeksAfterStart: 52, routeKey: 'JFK-GRU',  frequency:  4, priceMultiplier: 1.07 }, // NY–São Paulo launch

  // ── Eagle Wings (ATL, legacy) ─────────────────────────────────────────────
  { airlineId: 'eaglewings', weeksAfterStart: 10, routeKey: 'ATL-MIA',  frequency: 21, priceMultiplier: 1.03 }, // Atlanta–Miami freq boost
  { airlineId: 'eaglewings', weeksAfterStart: 18, routeKey: 'ATL-DEN',  frequency:  7, priceMultiplier: 1.04 }, // Atlanta–Denver launch
  { airlineId: 'eaglewings', weeksAfterStart: 30, routeKey: 'ATL-SFO',  frequency:  7, priceMultiplier: 1.05 }, // Atlanta–SF launch
  { airlineId: 'eaglewings', weeksAfterStart: 44, routeKey: 'ATL-LHR',  frequency:  4, priceMultiplier: 1.07 }, // Atlanta–London launch
  { airlineId: 'eaglewings', weeksAfterStart: 60, routeKey: 'ATL-MEX',  frequency:  5, priceMultiplier: 1.05 }, // Atlanta–Mexico City launch

  // ── Pacific Rim (NRT, legacy) ─────────────────────────────────────────────
  { airlineId: 'pacificrim', weeksAfterStart:  8, routeKey: 'ICN-NRT',  frequency: 21, priceMultiplier: 1.04 }, // Seoul–Tokyo freq boost
  { airlineId: 'pacificrim', weeksAfterStart: 20, routeKey: 'NRT-PVG',  frequency:  7, priceMultiplier: 1.05 }, // Tokyo–Shanghai launch
  { airlineId: 'pacificrim', weeksAfterStart: 35, routeKey: 'NRT-SYD',  frequency:  5, priceMultiplier: 1.08 }, // Tokyo–Sydney launch
  { airlineId: 'pacificrim', weeksAfterStart: 52, routeKey: 'LAX-NRT',  frequency: 10, priceMultiplier: 1.08 }, // Transpacific freq boost
  { airlineId: 'pacificrim', weeksAfterStart: 70, routeKey: 'NRT-LHR',  frequency:  4, priceMultiplier: 1.09 }, // Tokyo–London launch

  // ── Euro Connect (CDG, legacy) ────────────────────────────────────────────
  { airlineId: 'euroconnect', weeksAfterStart:  8, routeKey: 'CDG-FRA',  frequency: 21, priceMultiplier: 1.03 }, // Paris–Frankfurt freq boost
  { airlineId: 'euroconnect', weeksAfterStart: 16, routeKey: 'CDG-FCO',  frequency:  7, priceMultiplier: 1.03 }, // Paris–Rome launch
  { airlineId: 'euroconnect', weeksAfterStart: 26, routeKey: 'CDG-GRU',  frequency:  4, priceMultiplier: 1.07 }, // Paris–São Paulo launch
  { airlineId: 'euroconnect', weeksAfterStart: 39, routeKey: 'CDG-HKG',  frequency:  5, priceMultiplier: 1.08 }, // Paris–Hong Kong launch
  { airlineId: 'euroconnect', weeksAfterStart: 65, routeKey: 'CDG-LAX',  frequency:  4, priceMultiplier: 1.08 }, // Paris–LA launch

  // ── Southern Cross (SYD, legacy) ──────────────────────────────────────────
  { airlineId: 'southerncross', weeksAfterStart: 12, routeKey: 'BNE-SYD',  frequency: 28, priceMultiplier: 1.02 }, // Brisbane–Sydney freq boost
  { airlineId: 'southerncross', weeksAfterStart: 24, routeKey: 'MEL-NRT',  frequency:  5, priceMultiplier: 1.08 }, // Melbourne–Tokyo launch
  { airlineId: 'southerncross', weeksAfterStart: 44, routeKey: 'SYD-LHR',  frequency:  4, priceMultiplier: 1.09 }, // Sydney–London launch
  { airlineId: 'southerncross', weeksAfterStart: 65, routeKey: 'SYD-JFK',  frequency:  3, priceMultiplier: 1.10 }, // Sydney–New York ultra-long

  // ── Ibero Air (MAD, legacy) ───────────────────────────────────────────────
  { airlineId: 'iberoair', weeksAfterStart:  9, routeKey: 'BCN-MAD',  frequency: 35, priceMultiplier: 1.02 }, // Madrid–Barcelona freq boost
  { airlineId: 'iberoair', weeksAfterStart: 20, routeKey: 'MAD-CDG',  frequency: 14, priceMultiplier: 1.03 }, // Madrid–Paris freq boost
  { airlineId: 'iberoair', weeksAfterStart: 36, routeKey: 'MAD-BOG',  frequency:  5, priceMultiplier: 1.06 }, // Madrid–Bogotá launch
  { airlineId: 'iberoair', weeksAfterStart: 56, routeKey: 'MAD-NRT',  frequency:  3, priceMultiplier: 1.08 }, // Madrid–Tokyo launch

  // ── Rhine Air (FRA, legacy) ───────────────────────────────────────────────
  { airlineId: 'rhineair', weeksAfterStart:  8, routeKey: 'FRA-LHR',  frequency: 14, priceMultiplier: 1.04 }, // Frankfurt–London freq boost
  { airlineId: 'rhineair', weeksAfterStart: 18, routeKey: 'FRA-MAD',  frequency:  7, priceMultiplier: 1.04 }, // Frankfurt–Madrid launch
  { airlineId: 'rhineair', weeksAfterStart: 30, routeKey: 'FRA-DXB',  frequency:  7, priceMultiplier: 1.06 }, // Frankfurt–Dubai launch
  { airlineId: 'rhineair', weeksAfterStart: 52, routeKey: 'FRA-GRU',  frequency:  4, priceMultiplier: 1.07 }, // Frankfurt–São Paulo launch
  { airlineId: 'rhineair', weeksAfterStart: 70, routeKey: 'FRA-LAX',  frequency:  5, priceMultiplier: 1.08 }, // Frankfurt–LA launch

  // ── FastFly (LAX, budget) ─────────────────────────────────────────────────
  { airlineId: 'fastfly', weeksAfterStart:  6, routeKey: 'LAX-SFO',  frequency: 28, priceMultiplier: 0.73 }, // LA–SF freq boost
  { airlineId: 'fastfly', weeksAfterStart: 13, routeKey: 'LAX-MSP',  frequency:  7, priceMultiplier: 0.77 }, // LA–Minneapolis launch
  { airlineId: 'fastfly', weeksAfterStart: 26, routeKey: 'ATL-LAX',  frequency: 10, priceMultiplier: 0.79 }, // LA–Atlanta launch
  { airlineId: 'fastfly', weeksAfterStart: 45, routeKey: 'LAX-YVR',  frequency:  7, priceMultiplier: 0.80 }, // LA–Vancouver launch
  { airlineId: 'fastfly', weeksAfterStart: 65, routeKey: 'LAX-MEX',  frequency:  7, priceMultiplier: 0.82 }, // LA–Mexico City launch

  // ── NoFrills (AMS, budget) ────────────────────────────────────────────────
  { airlineId: 'nofrills', weeksAfterStart:  6, routeKey: 'AMS-BCN',  frequency: 21, priceMultiplier: 0.76 }, // Amsterdam–Barcelona freq boost
  { airlineId: 'nofrills', weeksAfterStart: 13, routeKey: 'AMS-WAW',  frequency:  7, priceMultiplier: 0.73 }, // Amsterdam–Warsaw launch
  { airlineId: 'nofrills', weeksAfterStart: 24, routeKey: 'AMS-VIE',  frequency:  7, priceMultiplier: 0.74 }, // Amsterdam–Vienna launch
  { airlineId: 'nofrills', weeksAfterStart: 39, routeKey: 'AMS-LIS',  frequency:  7, priceMultiplier: 0.73 }, // Amsterdam–Lisbon launch
  { airlineId: 'nofrills', weeksAfterStart: 60, routeKey: 'AMS-CMN',  frequency:  5, priceMultiplier: 0.74 }, // Amsterdam–Casablanca launch

  // ── Sunroute (MIA, budget) ────────────────────────────────────────────────
  { airlineId: 'sunroute', weeksAfterStart:  8, routeKey: 'JFK-MIA',  frequency: 21, priceMultiplier: 0.78 }, // Miami–NY freq boost
  { airlineId: 'sunroute', weeksAfterStart: 18, routeKey: 'MIA-PTY',  frequency:  7, priceMultiplier: 0.80 }, // Miami–Panama launch
  { airlineId: 'sunroute', weeksAfterStart: 35, routeKey: 'MIA-SCL',  frequency:  5, priceMultiplier: 0.82 }, // Miami–Santiago launch
  { airlineId: 'sunroute', weeksAfterStart: 52, routeKey: 'MIA-MEX',  frequency:  7, priceMultiplier: 0.80 }, // Miami–Mexico City launch

  // ── Asia Express (BKK, budget) ────────────────────────────────────────────
  { airlineId: 'asiaexpress', weeksAfterStart:  6, routeKey: 'BKK-SIN',  frequency: 21, priceMultiplier: 0.73 }, // Bangkok–Singapore freq boost
  { airlineId: 'asiaexpress', weeksAfterStart: 13, routeKey: 'BKK-NRT',  frequency:  7, priceMultiplier: 0.77 }, // Bangkok–Tokyo launch
  { airlineId: 'asiaexpress', weeksAfterStart: 26, routeKey: 'BKK-PEK',  frequency:  7, priceMultiplier: 0.75 }, // Bangkok–Beijing launch
  { airlineId: 'asiaexpress', weeksAfterStart: 44, routeKey: 'BKK-SYD',  frequency:  5, priceMultiplier: 0.79 }, // Bangkok–Sydney launch
  { airlineId: 'asiaexpress', weeksAfterStart: 65, routeKey: 'BKK-DXB',  frequency:  7, priceMultiplier: 0.80 }, // Bangkok–Dubai launch

  // ── Viva Sud (BOG, budget) ────────────────────────────────────────────────
  { airlineId: 'vivasud', weeksAfterStart: 10, routeKey: 'BOG-GRU',  frequency: 10, priceMultiplier: 0.80 }, // Bogotá–São Paulo freq boost
  { airlineId: 'vivasud', weeksAfterStart: 22, routeKey: 'BOG-CUN',  frequency:  7, priceMultiplier: 0.76 }, // Bogotá–Cancún launch
  { airlineId: 'vivasud', weeksAfterStart: 40, routeKey: 'BOG-GDL',  frequency:  7, priceMultiplier: 0.77 }, // Bogotá–Guadalajara launch
  { airlineId: 'vivasud', weeksAfterStart: 60, routeKey: 'BOG-JFK',  frequency:  5, priceMultiplier: 0.82 }, // Bogotá–New York launch

  // ── Gulf Pearl (DOH, premium) ─────────────────────────────────────────────
  { airlineId: 'gulfpearl', weeksAfterStart: 10, routeKey: 'DOH-LHR',  frequency: 10, priceMultiplier: 1.45 }, // Doha–London freq boost
  { airlineId: 'gulfpearl', weeksAfterStart: 20, routeKey: 'DOH-HKG',  frequency:  7, priceMultiplier: 1.42 }, // Doha–Hong Kong launch
  { airlineId: 'gulfpearl', weeksAfterStart: 35, routeKey: 'DOH-ICN',  frequency:  5, priceMultiplier: 1.45 }, // Doha–Seoul launch
  { airlineId: 'gulfpearl', weeksAfterStart: 52, routeKey: 'DOH-SYD',  frequency:  4, priceMultiplier: 1.40 }, // Doha–Sydney launch
  { airlineId: 'gulfpearl', weeksAfterStart: 70, routeKey: 'DOH-LAX',  frequency:  5, priceMultiplier: 1.52 }, // Doha–LA launch

  // ── Silk Route (SIN, premium) ─────────────────────────────────────────────
  { airlineId: 'silkroute', weeksAfterStart:  8, routeKey: 'NRT-SIN',  frequency: 10, priceMultiplier: 1.45 }, // Singapore–Tokyo freq boost
  { airlineId: 'silkroute', weeksAfterStart: 18, routeKey: 'ICN-SIN',  frequency:  7, priceMultiplier: 1.42 }, // Singapore–Seoul launch
  { airlineId: 'silkroute', weeksAfterStart: 35, routeKey: 'SIN-YYZ',  frequency:  3, priceMultiplier: 1.52 }, // Singapore–Toronto launch
  { airlineId: 'silkroute', weeksAfterStart: 56, routeKey: 'JFK-SIN',  frequency:  5, priceMultiplier: 1.55 }, // Singapore–NY launch

  // ── Orient Prestige (HKG, premium) ───────────────────────────────────────
  { airlineId: 'orientprestige', weeksAfterStart: 10, routeKey: 'HKG-SIN',  frequency: 10, priceMultiplier: 1.40 }, // HK–Singapore freq boost
  { airlineId: 'orientprestige', weeksAfterStart: 22, routeKey: 'HKG-ICN',  frequency:  7, priceMultiplier: 1.40 }, // HK–Seoul launch
  { airlineId: 'orientprestige', weeksAfterStart: 39, routeKey: 'HKG-FRA',  frequency:  5, priceMultiplier: 1.48 }, // HK–Frankfurt launch
  { airlineId: 'orientprestige', weeksAfterStart: 60, routeKey: 'HKG-SYD',  frequency:  7, priceMultiplier: 1.42 }, // HK–Sydney freq boost

  // ── Nordic Elite (ARN, premium) ───────────────────────────────────────────
  { airlineId: 'nordicelite', weeksAfterStart: 12, routeKey: 'ARN-LHR',  frequency: 10, priceMultiplier: 1.35 }, // Stockholm–London freq boost
  { airlineId: 'nordicelite', weeksAfterStart: 24, routeKey: 'ARN-SIN',  frequency:  4, priceMultiplier: 1.50 }, // Stockholm–Singapore launch
  { airlineId: 'nordicelite', weeksAfterStart: 44, routeKey: 'ARN-HKG',  frequency:  4, priceMultiplier: 1.48 }, // Stockholm–HK launch
  { airlineId: 'nordicelite', weeksAfterStart: 65, routeKey: 'ARN-ICN',  frequency:  4, priceMultiplier: 1.48 }, // Stockholm–Seoul launch

  // ── Pampa Premium (GRU, premium) ──────────────────────────────────────────
  { airlineId: 'pampapremium', weeksAfterStart: 10, routeKey: 'EZE-GRU',  frequency: 21, priceMultiplier: 1.30 }, // São Paulo–Buenos Aires freq boost
  { airlineId: 'pampapremium', weeksAfterStart: 24, routeKey: 'GRU-LIM',  frequency:  5, priceMultiplier: 1.35 }, // São Paulo–Lima launch
  { airlineId: 'pampapremium', weeksAfterStart: 40, routeKey: 'GRU-NRT',  frequency:  3, priceMultiplier: 1.50 }, // São Paulo–Tokyo launch
  { airlineId: 'pampapremium', weeksAfterStart: 60, routeKey: 'GRU-DXB',  frequency:  4, priceMultiplier: 1.48 }, // São Paulo–Dubai launch

  // ── TransAfrica (NBO, legacy) ─────────────────────────────────────────────
  { airlineId: 'transafrica', weeksAfterStart: 12, routeKey: 'JNB-NBO',  frequency: 10, priceMultiplier: 1.02 },
  { airlineId: 'transafrica', weeksAfterStart: 24, routeKey: 'CAI-NBO',  frequency:  5, priceMultiplier: 1.04 },
  { airlineId: 'transafrica', weeksAfterStart: 40, routeKey: 'LHR-NBO',  frequency:  7, priceMultiplier: 1.07 },
  { airlineId: 'transafrica', weeksAfterStart: 65, routeKey: 'NBO-SIN',  frequency:  4, priceMultiplier: 1.06 },

  // ── India Star (BOM, legacy) ──────────────────────────────────────────────
  { airlineId: 'indiastar', weeksAfterStart:  8, routeKey: 'BOM-DEL',  frequency: 28, priceMultiplier: 1.02 },
  { airlineId: 'indiastar', weeksAfterStart: 20, routeKey: 'BOM-DXB',  frequency: 21, priceMultiplier: 1.04 },
  { airlineId: 'indiastar', weeksAfterStart: 36, routeKey: 'BOM-SIN',  frequency: 10, priceMultiplier: 1.05 },
  { airlineId: 'indiastar', weeksAfterStart: 52, routeKey: 'BOM-LHR',  frequency: 10, priceMultiplier: 1.07 },
  { airlineId: 'indiastar', weeksAfterStart: 72, routeKey: 'BOM-JFK',  frequency:  5, priceMultiplier: 1.08 },

  // ── Canadian Pride (YYZ, legacy) ──────────────────────────────────────────
  { airlineId: 'canadianpride', weeksAfterStart:  8, routeKey: 'JFK-YYZ',  frequency: 21, priceMultiplier: 1.04 },
  { airlineId: 'canadianpride', weeksAfterStart: 20, routeKey: 'LAX-YYZ',  frequency: 10, priceMultiplier: 1.05 },
  { airlineId: 'canadianpride', weeksAfterStart: 36, routeKey: 'LHR-YYZ',  frequency: 10, priceMultiplier: 1.06 },
  { airlineId: 'canadianpride', weeksAfterStart: 56, routeKey: 'CDG-YYZ',  frequency:  5, priceMultiplier: 1.06 },
  { airlineId: 'canadianpride', weeksAfterStart: 78, routeKey: 'NRT-YYZ',  frequency:  4, priceMultiplier: 1.07 },

  // ── Bosphorus Air (IST, legacy) ───────────────────────────────────────────
  { airlineId: 'bosphorusair', weeksAfterStart: 10, routeKey: 'IST-LHR',  frequency: 14, priceMultiplier: 1.04 },
  { airlineId: 'bosphorusair', weeksAfterStart: 22, routeKey: 'IST-JFK',  frequency:  7, priceMultiplier: 1.07 },
  { airlineId: 'bosphorusair', weeksAfterStart: 38, routeKey: 'BKK-IST',  frequency:  7, priceMultiplier: 1.06 },
  { airlineId: 'bosphorusair', weeksAfterStart: 60, routeKey: 'DEL-IST',  frequency:  5, priceMultiplier: 1.06 },

  // ── Dragon East (PVG, legacy) ─────────────────────────────────────────────
  { airlineId: 'dragoneast', weeksAfterStart:  8, routeKey: 'HKG-PVG',  frequency: 21, priceMultiplier: 1.04 },
  { airlineId: 'dragoneast', weeksAfterStart: 18, routeKey: 'NRT-PVG',  frequency: 18, priceMultiplier: 1.05 },
  { airlineId: 'dragoneast', weeksAfterStart: 32, routeKey: 'LHR-PVG',  frequency:  7, priceMultiplier: 1.08 },
  { airlineId: 'dragoneast', weeksAfterStart: 52, routeKey: 'LAX-PVG',  frequency:  7, priceMultiplier: 1.08 },
  { airlineId: 'dragoneast', weeksAfterStart: 70, routeKey: 'JFK-PVG',  frequency:  5, priceMultiplier: 1.09 },

  // ── Aztec Air (MEX, legacy) ───────────────────────────────────────────────
  { airlineId: 'aztecair', weeksAfterStart:  8, routeKey: 'LAX-MEX',  frequency: 21, priceMultiplier: 1.04 },
  { airlineId: 'aztecair', weeksAfterStart: 20, routeKey: 'JFK-MEX',  frequency: 14, priceMultiplier: 1.05 },
  { airlineId: 'aztecair', weeksAfterStart: 36, routeKey: 'MAD-MEX',  frequency:  7, priceMultiplier: 1.06 },
  { airlineId: 'aztecair', weeksAfterStart: 56, routeKey: 'BOG-MEX',  frequency:  7, priceMultiplier: 1.05 },

  // ── Norseman Airlines (CPH, legacy) ──────────────────────────────────────
  { airlineId: 'norseman', weeksAfterStart: 10, routeKey: 'ARN-CPH',  frequency: 14, priceMultiplier: 1.02 },
  { airlineId: 'norseman', weeksAfterStart: 24, routeKey: 'CPH-JFK',  frequency:  7, priceMultiplier: 1.07 },
  { airlineId: 'norseman', weeksAfterStart: 42, routeKey: 'CPH-DXB',  frequency:  7, priceMultiplier: 1.06 },
  { airlineId: 'norseman', weeksAfterStart: 65, routeKey: 'CPH-NRT',  frequency:  4, priceMultiplier: 1.08 },

  // ── Roma Air (FCO, legacy) ────────────────────────────────────────────────
  { airlineId: 'romaair', weeksAfterStart: 10, routeKey: 'CDG-FCO',  frequency: 14, priceMultiplier: 1.03 },
  { airlineId: 'romaair', weeksAfterStart: 22, routeKey: 'FCO-JFK',  frequency:  7, priceMultiplier: 1.07 },
  { airlineId: 'romaair', weeksAfterStart: 38, routeKey: 'DXB-FCO',  frequency:  7, priceMultiplier: 1.06 },
  { airlineId: 'romaair', weeksAfterStart: 60, routeKey: 'FCO-NRT',  frequency:  4, priceMultiplier: 1.08 },

  // ── Savannah Air (JNB, legacy) ────────────────────────────────────────────
  { airlineId: 'savannahair', weeksAfterStart: 12, routeKey: 'DXB-JNB',  frequency: 10, priceMultiplier: 1.05 },
  { airlineId: 'savannahair', weeksAfterStart: 26, routeKey: 'JNB-SIN',  frequency:  5, priceMultiplier: 1.07 },
  { airlineId: 'savannahair', weeksAfterStart: 44, routeKey: 'GRU-JNB',  frequency:  4, priceMultiplier: 1.06 },
  { airlineId: 'savannahair', weeksAfterStart: 65, routeKey: 'JNB-NRT',  frequency:  3, priceMultiplier: 1.08 },

  // ── Hellenic Air (ATH, legacy) ────────────────────────────────────────────
  { airlineId: 'hellenicair', weeksAfterStart: 10, routeKey: 'AMS-ATH',  frequency: 14, priceMultiplier: 1.02 },
  { airlineId: 'hellenicair', weeksAfterStart: 24, routeKey: 'ATH-JFK',  frequency:  5, priceMultiplier: 1.07 },
  { airlineId: 'hellenicair', weeksAfterStart: 42, routeKey: 'ATH-DXB',  frequency:  7, priceMultiplier: 1.05 },
  { airlineId: 'hellenicair', weeksAfterStart: 65, routeKey: 'ATH-SIN',  frequency:  4, priceMultiplier: 1.07 },

  // ── Maple Cross Air (YVR, legacy) ─────────────────────────────────────────
  { airlineId: 'maplecross', weeksAfterStart:  8, routeKey: 'LAX-YVR',  frequency: 21, priceMultiplier: 1.04 },
  { airlineId: 'maplecross', weeksAfterStart: 22, routeKey: 'YVR-YYZ',  frequency: 14, priceMultiplier: 1.03 },
  { airlineId: 'maplecross', weeksAfterStart: 40, routeKey: 'LHR-YVR',  frequency:  7, priceMultiplier: 1.06 },
  { airlineId: 'maplecross', weeksAfterStart: 60, routeKey: 'NRT-YVR',  frequency:  7, priceMultiplier: 1.07 },

  // ── Carioca Air (GIG, legacy) ─────────────────────────────────────────────
  { airlineId: 'cariocaair', weeksAfterStart: 10, routeKey: 'GIG-GRU',  frequency: 21, priceMultiplier: 1.02 },
  { airlineId: 'cariocaair', weeksAfterStart: 24, routeKey: 'GIG-MIA',  frequency:  7, priceMultiplier: 1.05 },
  { airlineId: 'cariocaair', weeksAfterStart: 40, routeKey: 'GIG-LHR',  frequency:  5, priceMultiplier: 1.07 },
  { airlineId: 'cariocaair', weeksAfterStart: 60, routeKey: 'GIG-LAX',  frequency:  4, priceMultiplier: 1.08 },

  // ── WingIt (DUB, budget) ──────────────────────────────────────────────────
  { airlineId: 'wingit', weeksAfterStart:  6, routeKey: 'DUB-LHR',  frequency: 28, priceMultiplier: 0.72 },
  { airlineId: 'wingit', weeksAfterStart: 14, routeKey: 'CDG-DUB',  frequency: 14, priceMultiplier: 0.73 },
  { airlineId: 'wingit', weeksAfterStart: 28, routeKey: 'BCN-DUB',  frequency: 14, priceMultiplier: 0.74 },
  { airlineId: 'wingit', weeksAfterStart: 48, routeKey: 'DUB-FCO',  frequency: 10, priceMultiplier: 0.75 },

  // ── FrugalFly (BER, budget) ───────────────────────────────────────────────
  { airlineId: 'frugalfly', weeksAfterStart:  6, routeKey: 'AMS-BER',  frequency: 21, priceMultiplier: 0.72 },
  { airlineId: 'frugalfly', weeksAfterStart: 15, routeKey: 'BER-LHR',  frequency: 14, priceMultiplier: 0.73 },
  { airlineId: 'frugalfly', weeksAfterStart: 30, routeKey: 'BCN-BER',  frequency: 14, priceMultiplier: 0.74 },
  { airlineId: 'frugalfly', weeksAfterStart: 50, routeKey: 'BER-MAD',  frequency:  7, priceMultiplier: 0.74 },

  // ── BargainBird (PHX, budget) ─────────────────────────────────────────────
  { airlineId: 'bargainbird', weeksAfterStart:  6, routeKey: 'LAX-PHX',  frequency: 35, priceMultiplier: 0.74 },
  { airlineId: 'bargainbird', weeksAfterStart: 14, routeKey: 'DEN-PHX',  frequency: 21, priceMultiplier: 0.74 },
  { airlineId: 'bargainbird', weeksAfterStart: 26, routeKey: 'DFW-PHX',  frequency: 14, priceMultiplier: 0.75 },
  { airlineId: 'bargainbird', weeksAfterStart: 44, routeKey: 'PHX-SEA',  frequency: 14, priceMultiplier: 0.76 },
  { airlineId: 'bargainbird', weeksAfterStart: 65, routeKey: 'ORD-PHX',  frequency: 14, priceMultiplier: 0.77 },

  // ── BahtJet (KUL, budget) ─────────────────────────────────────────────────
  { airlineId: 'bahtjet', weeksAfterStart:  6, routeKey: 'KUL-SIN',  frequency: 35, priceMultiplier: 0.72 },
  { airlineId: 'bahtjet', weeksAfterStart: 14, routeKey: 'BKK-KUL',  frequency: 28, priceMultiplier: 0.73 },
  { airlineId: 'bahtjet', weeksAfterStart: 28, routeKey: 'CGK-KUL',  frequency: 21, priceMultiplier: 0.73 },
  { airlineId: 'bahtjet', weeksAfterStart: 48, routeKey: 'HKG-KUL',  frequency: 10, priceMultiplier: 0.75 },
  { airlineId: 'bahtjet', weeksAfterStart: 70, routeKey: 'DEL-KUL',  frequency:  7, priceMultiplier: 0.76 },

  // ── RupeeFly (DEL, budget) ────────────────────────────────────────────────
  { airlineId: 'rupeefly', weeksAfterStart:  6, routeKey: 'BOM-DEL',  frequency: 35, priceMultiplier: 0.72 },
  { airlineId: 'rupeefly', weeksAfterStart: 14, routeKey: 'DEL-DXB',  frequency: 28, priceMultiplier: 0.74 },
  { airlineId: 'rupeefly', weeksAfterStart: 28, routeKey: 'DEL-SIN',  frequency: 14, priceMultiplier: 0.74 },
  { airlineId: 'rupeefly', weeksAfterStart: 48, routeKey: 'BKK-DEL',  frequency:  7, priceMultiplier: 0.75 },
  { airlineId: 'rupeefly', weeksAfterStart: 70, routeKey: 'DEL-LHR',  frequency:  7, priceMultiplier: 0.78 },

  // ── PesoJet (MEX, budget) ─────────────────────────────────────────────────
  { airlineId: 'pesojet', weeksAfterStart:  6, routeKey: 'LAX-MEX',  frequency: 28, priceMultiplier: 0.76 },
  { airlineId: 'pesojet', weeksAfterStart: 14, routeKey: 'JFK-MEX',  frequency: 14, priceMultiplier: 0.79 },
  { airlineId: 'pesojet', weeksAfterStart: 28, routeKey: 'DFW-MEX',  frequency: 14, priceMultiplier: 0.76 },
  { airlineId: 'pesojet', weeksAfterStart: 48, routeKey: 'BOG-MEX',  frequency:  7, priceMultiplier: 0.80 },

  // ── Suncoast Air (MCO, budget) ────────────────────────────────────────────
  { airlineId: 'suncoast', weeksAfterStart:  6, routeKey: 'JFK-MCO',  frequency: 28, priceMultiplier: 0.76 },
  { airlineId: 'suncoast', weeksAfterStart: 14, routeKey: 'MCO-MIA',  frequency: 28, priceMultiplier: 0.74 },
  { airlineId: 'suncoast', weeksAfterStart: 26, routeKey: 'ATL-MCO',  frequency: 21, priceMultiplier: 0.76 },
  { airlineId: 'suncoast', weeksAfterStart: 44, routeKey: 'MCO-ORD',  frequency: 14, priceMultiplier: 0.77 },
  { airlineId: 'suncoast', weeksAfterStart: 65, routeKey: 'LAX-MCO',  frequency:  7, priceMultiplier: 0.79 },

  // ── Pampa Low (EZE, budget) ───────────────────────────────────────────────
  { airlineId: 'pampalow', weeksAfterStart:  6, routeKey: 'EZE-SCL',  frequency: 28, priceMultiplier: 0.73 },
  { airlineId: 'pampalow', weeksAfterStart: 16, routeKey: 'EZE-GRU',  frequency: 21, priceMultiplier: 0.76 },
  { airlineId: 'pampalow', weeksAfterStart: 32, routeKey: 'EZE-LIM',  frequency: 10, priceMultiplier: 0.76 },
  { airlineId: 'pampalow', weeksAfterStart: 52, routeKey: 'EZE-MIA',  frequency:  5, priceMultiplier: 0.81 },

  // ── SaharaFly (CAI, budget) ───────────────────────────────────────────────
  { airlineId: 'saharafly', weeksAfterStart:  8, routeKey: 'CAI-DXB',  frequency: 21, priceMultiplier: 0.74 },
  { airlineId: 'saharafly', weeksAfterStart: 18, routeKey: 'CAI-IST',  frequency: 14, priceMultiplier: 0.73 },
  { airlineId: 'saharafly', weeksAfterStart: 34, routeKey: 'CAI-LHR',  frequency:  7, priceMultiplier: 0.75 },
  { airlineId: 'saharafly', weeksAfterStart: 54, routeKey: 'AMS-CAI',  frequency: 10, priceMultiplier: 0.74 },

  // ── Baltic Jet (RIX, budget) ──────────────────────────────────────────────
  { airlineId: 'balticjet', weeksAfterStart:  8, routeKey: 'AMS-RIX',  frequency: 10, priceMultiplier: 0.72 },
  { airlineId: 'balticjet', weeksAfterStart: 18, routeKey: 'LHR-RIX',  frequency:  7, priceMultiplier: 0.73 },
  { airlineId: 'balticjet', weeksAfterStart: 32, routeKey: 'CDG-RIX',  frequency:  7, priceMultiplier: 0.73 },
  { airlineId: 'balticjet', weeksAfterStart: 50, routeKey: 'FRA-RIX',  frequency:  7, priceMultiplier: 0.73 },

  // ── Tokyo Prestige (NRT, premium) ─────────────────────────────────────────
  { airlineId: 'tokyoprestige', weeksAfterStart: 12, routeKey: 'NRT-SIN',  frequency: 10, priceMultiplier: 1.45 },
  { airlineId: 'tokyoprestige', weeksAfterStart: 26, routeKey: 'JFK-NRT',  frequency:  7, priceMultiplier: 1.52 },
  { airlineId: 'tokyoprestige', weeksAfterStart: 44, routeKey: 'LHR-NRT',  frequency:  7, priceMultiplier: 1.48 },
  { airlineId: 'tokyoprestige', weeksAfterStart: 65, routeKey: 'NRT-SYD',  frequency:  5, priceMultiplier: 1.40 },

  // ── Zürich First (ZRH, premium) ───────────────────────────────────────────
  { airlineId: 'zuerichfirst', weeksAfterStart: 12, routeKey: 'LHR-ZRH',  frequency: 10, priceMultiplier: 1.38 },
  { airlineId: 'zuerichfirst', weeksAfterStart: 26, routeKey: 'JFK-ZRH',  frequency:  7, priceMultiplier: 1.50 },
  { airlineId: 'zuerichfirst', weeksAfterStart: 44, routeKey: 'DXB-ZRH',  frequency:  5, priceMultiplier: 1.42 },
  { airlineId: 'zuerichfirst', weeksAfterStart: 65, routeKey: 'SIN-ZRH',  frequency:  4, priceMultiplier: 1.48 },

  // ── Mumbai Select (BOM, premium) ──────────────────────────────────────────
  { airlineId: 'mumbaiselect', weeksAfterStart: 10, routeKey: 'BOM-DXB',  frequency: 14, priceMultiplier: 1.38 },
  { airlineId: 'mumbaiselect', weeksAfterStart: 24, routeKey: 'BOM-LHR',  frequency:  7, priceMultiplier: 1.45 },
  { airlineId: 'mumbaiselect', weeksAfterStart: 40, routeKey: 'BOM-SIN',  frequency:  7, priceMultiplier: 1.40 },
  { airlineId: 'mumbaiselect', weeksAfterStart: 60, routeKey: 'BOM-JFK',  frequency:  4, priceMultiplier: 1.52 },

  // ── Shanghai Lux (PVG, premium) ───────────────────────────────────────────
  { airlineId: 'shanghailux', weeksAfterStart: 10, routeKey: 'HKG-PVG',  frequency: 10, priceMultiplier: 1.38 },
  { airlineId: 'shanghailux', weeksAfterStart: 24, routeKey: 'LHR-PVG',  frequency:  5, priceMultiplier: 1.50 },
  { airlineId: 'shanghailux', weeksAfterStart: 40, routeKey: 'JFK-PVG',  frequency:  4, priceMultiplier: 1.55 },
  { airlineId: 'shanghailux', weeksAfterStart: 60, routeKey: 'DXB-PVG',  frequency:  5, priceMultiplier: 1.45 },

  // ── Istanbul Prestige (IST, premium) ──────────────────────────────────────
  { airlineId: 'istanbulprestige', weeksAfterStart: 12, routeKey: 'IST-LHR',  frequency: 10, priceMultiplier: 1.38 },
  { airlineId: 'istanbulprestige', weeksAfterStart: 26, routeKey: 'IST-JFK',  frequency:  7, priceMultiplier: 1.48 },
  { airlineId: 'istanbulprestige', weeksAfterStart: 44, routeKey: 'IST-SIN',  frequency:  5, priceMultiplier: 1.45 },
  { airlineId: 'istanbulprestige', weeksAfterStart: 65, routeKey: 'IST-NRT',  frequency:  4, priceMultiplier: 1.48 },

  // ── Patagonia First (SCL, premium) ────────────────────────────────────────
  { airlineId: 'patagoniafirst', weeksAfterStart: 10, routeKey: 'GRU-SCL',  frequency: 10, priceMultiplier: 1.30 },
  { airlineId: 'patagoniafirst', weeksAfterStart: 24, routeKey: 'MIA-SCL',  frequency:  7, priceMultiplier: 1.40 },
  { airlineId: 'patagoniafirst', weeksAfterStart: 42, routeKey: 'MAD-SCL',  frequency:  5, priceMultiplier: 1.42 },
  { airlineId: 'patagoniafirst', weeksAfterStart: 65, routeKey: 'LHR-SCL',  frequency:  4, priceMultiplier: 1.45 },

  // ── Oceania Prestige (AKL, premium) ──────────────────────────────────────
  { airlineId: 'oceaniaprestige', weeksAfterStart: 12, routeKey: 'AKL-SYD',  frequency: 10, priceMultiplier: 1.38 },
  { airlineId: 'oceaniaprestige', weeksAfterStart: 26, routeKey: 'AKL-SIN',  frequency:  7, priceMultiplier: 1.40 },
  { airlineId: 'oceaniaprestige', weeksAfterStart: 44, routeKey: 'AKL-HKG',  frequency:  7, priceMultiplier: 1.42 },
  { airlineId: 'oceaniaprestige', weeksAfterStart: 65, routeKey: 'AKL-LHR',  frequency:  3, priceMultiplier: 1.55 },

  // ── Cape Diamonds (CPT, premium) ──────────────────────────────────────────
  { airlineId: 'capediamonds', weeksAfterStart: 10, routeKey: 'CPT-JNB',  frequency: 10, priceMultiplier: 1.30 },
  { airlineId: 'capediamonds', weeksAfterStart: 24, routeKey: 'CPT-LHR',  frequency:  5, priceMultiplier: 1.48 },
  { airlineId: 'capediamonds', weeksAfterStart: 42, routeKey: 'CPT-DXB',  frequency:  7, priceMultiplier: 1.42 },
  { airlineId: 'capediamonds', weeksAfterStart: 65, routeKey: 'CPT-SIN',  frequency:  4, priceMultiplier: 1.48 },
];

/**
 * Advance competitor networks by one week.
 * Pure function — returns new objects, safe for React state.
 *
 * @param {CompetitorAirline[]} competitors
 * @param {number} weekNumber  total game-weeks elapsed since start (1-based).
 *   Compute as: (year - startYear) * 52 + week
 * @returns {{ competitors: CompetitorAirline[], events: CompetitorEvent[] }}
 *
 * @typedef {{ airlineId: string, routeKey: string, isUpgrade: boolean }} CompetitorEvent
 */
export function tickCompetitorGrowth(competitors, weekNumber) {
  const events = [];
  const updated = competitors.map(airline => {
    const offset = airline._weekOffset ?? 0;
    const mine = COMPETITOR_EXPANSION_SCHEDULE.filter(
      e => e.airlineId === airline.id && e.weeksAfterStart + offset === weekNumber
    );
    if (mine.length === 0) return airline;

    const newRoutes = { ...airline.routes };
    let   newFleet  = [...(airline.fleet ?? [])];
    let   cashDelta = 0;

    for (const entry of mine) {
      const [a, b] = entry.routeKey.split('-');
      const dist   = routeDistance(a, b);
      const type   = pickCompetitorAircraftType(dist, airline.tier);
      if (!type) continue;   // no in-range aircraft → carrier can't open this route

      const isUpgrade = entry.routeKey in newRoutes;
      const tails     = tailsForRoute(dist, entry.frequency);

      // Replace this route's tails with the new requirement (fresh deliveries).
      const keptFleet = isUpgrade ? newFleet.filter(f => f.routeKey !== entry.routeKey) : newFleet;
      const addedTails = [];
      for (let i = 0; i < tails; i++) addedTails.push(makeCompetitorTail(airline.id, type.id, entry.routeKey, false));
      newFleet = [...keptFleet, ...addedTails];

      newRoutes[entry.routeKey] = {
        frequency:       entry.frequency,
        priceMultiplier: entry.priceMultiplier,
        aircraftType:    type.id,
        tails,
      };

      // Capital outlay for fleet growth: a security deposit (~4 weeks lease) per
      // newly delivered tail. Drains cash, so aggressive expanders get cheaper to buy.
      cashDelta -= addedTails.length * (type.weeklyLease ?? 0) * 4;

      events.push({ airlineId: airline.id, routeKey: entry.routeKey, isUpgrade, aircraftType: type.id, tails });
    }

    return { ...airline, routes: newRoutes, fleet: newFleet, cash: (airline.cash ?? 0) + cashDelta };
  });

  return { competitors: updated, events };
}

/**
 * Adjust competitor pricing in response to the player's fares on shared routes.
 * Call once per ADVANCE_WEEK, after tickCompetitorGrowth.
 *
 * Each tier has different aggression and price bounds:
 *   budget  — cuts fast, can't price high (floor 0.65×, ceiling 0.90×)
 *   legacy  — moderate reactions        (floor 0.85×, ceiling 1.20×)
 *   premium — holds positioning firmly  (floor 1.25×, ceiling 1.70×)
 *
 * Pure function — returns new competitor objects safe for React state.
 *
 * @param {CompetitorAirline[]} competitors
 * @param {Array<{origin: string, destination: string, ticketPrice: number}>} playerRoutes
 * @returns {CompetitorAirline[]}
 */
export function tickCompetitorPricing(competitors, playerRoutes) {
  // Build routeKey → player ticket price
  const playerMap = {};
  for (const r of playerRoutes) {
    const key = [r.origin, r.destination].sort().join('-');
    playerMap[key] = r.ticketPrice;
  }

  const TIER_CONFIG = {
    budget:  { floor: 0.65, ceiling: 0.90, cutRate: 0.04,  raiseRate: 0.01  },
    legacy:  { floor: 0.85, ceiling: 1.20, cutRate: 0.025, raiseRate: 0.015 },
    premium: { floor: 1.25, ceiling: 1.70, cutRate: 0.015, raiseRate: 0.02  },
  };

  return competitors.map(airline => {
    const cfg = airline._pricing ?? TIER_CONFIG[airline.tier];
    if (!cfg) return airline;

    let anyChange = false;
    const newRoutes = { ...airline.routes };

    for (const routeKey of Object.keys(newRoutes)) {
      const playerPrice = playerMap[routeKey];
      if (playerPrice == null) continue; // player not on this route

      const [a, b] = routeKey.split('-');
      const refP = referencePrice(a, b);
      if (!refP) continue;

      const playerRatio = playerPrice / refP;
      const compRatio   = newRoutes[routeKey].priceMultiplier;
      let newMultiplier = compRatio;

      if (playerRatio < compRatio - 0.10) {
        // Player undercutting — competitor cuts price
        newMultiplier = Math.max(cfg.floor, compRatio - cfg.cutRate);
      } else if (playerRatio > compRatio + 0.15) {
        // Player pricing premium — competitor nudges price up
        newMultiplier = Math.min(cfg.ceiling, compRatio + cfg.raiseRate);
      }

      if (Math.abs(newMultiplier - compRatio) > 0.001) {
        newRoutes[routeKey] = { ...newRoutes[routeKey], priceMultiplier: +newMultiplier.toFixed(4) };
        anyChange = true;
      }
    }

    return anyChange ? { ...airline, routes: newRoutes } : airline;
  });
}

// ─── Competitor sampling & per-game personality jitter ───────────────────────

/**
 * Apply per-game personality jitter to a competitor so each run feels different.
 * Mutates a shallow copy — never touches the original COMPETITOR_AIRLINES entry.
 */
function jitterCompetitor(airline) {
  const c = { ...airline };

  // Quality perception: ±5 points
  c.baseQualityScore = Math.round(
    c.baseQualityScore + (Math.random() * 10 - 5)
  );

  // Expansion timing: ±3 weeks (stored on the airline; read by tickCompetitorGrowth)
  c._weekOffset = Math.round(Math.random() * 6 - 3);

  // Pricing personality: jitter tier defaults by small amounts
  const TIER_DEFAULTS = {
    budget:  { floor: 0.65, ceiling: 0.90, cutRate: 0.04,  raiseRate: 0.01  },
    legacy:  { floor: 0.85, ceiling: 1.20, cutRate: 0.025, raiseRate: 0.015 },
    premium: { floor: 1.25, ceiling: 1.70, cutRate: 0.015, raiseRate: 0.02  },
  };
  const base = TIER_DEFAULTS[c.tier] ?? TIER_DEFAULTS.legacy;
  const r = () => Math.random() * 0.12 - 0.06; // ±0.06
  c._pricing = {
    floor:     +(base.floor     + r()).toFixed(3),
    ceiling:   +(base.ceiling   + r()).toFixed(3),
    cutRate:   +(base.cutRate   + (Math.random() * 0.02 - 0.01)).toFixed(4),
    raiseRate: +(base.raiseRate + (Math.random() * 0.01 - 0.005)).toFixed(4),
  };

  return c;
}

/**
 * Stratified random sample of N competitors from the full bank.
 * Preserves roughly the same legacy/budget/premium ratio as the full bank.
 * Returns a new array of jittered competitor objects.
 */
function sampleCompetitors(n = 15) {
  const byTier = { legacy: [], budget: [], premium: [] };
  for (const c of COMPETITOR_AIRLINES) {
    (byTier[c.tier] ?? (byTier.other = byTier.other ?? [])).push(c);
  }
  const total = COMPETITOR_AIRLINES.length;
  const pick = (arr, k) => {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, k);
  };

  const counts = {};
  let remaining = n;
  const tiers = ['legacy', 'budget', 'premium'];
  for (const t of tiers) {
    const share = (byTier[t]?.length ?? 0) / total;
    counts[t] = Math.min(byTier[t]?.length ?? 0, Math.round(share * n));
    remaining -= counts[t];
  }
  // Assign any rounding remainder to the largest tier
  if (remaining !== 0) {
    const largest = tiers.reduce((a, b) =>
      (byTier[a]?.length ?? 0) >= (byTier[b]?.length ?? 0) ? a : b
    );
    counts[largest] = Math.min(byTier[largest]?.length ?? 0, counts[largest] + remaining);
  }

  return tiers.flatMap(t => pick(byTier[t] ?? [], counts[t]));
}

/**
 * Sample N competitors, jitter their personalities, and initialize their routes.
 * Drop-in replacement for the old `initializeCompetitorRoutes(COMPETITOR_AIRLINES.map(...))`.
 *
 * @param {number} [count=25]
 * @returns {CompetitorAirline[]}
 */
export function sampleAndInitializeCompetitors(count = 25) {
  const sampled = sampleCompetitors(count).map(c => jitterCompetitor({ ...c, routes: {} }));
  return initializeCompetitorRoutes(sampled);
}

/**
 * Virtual aircraft parameters by tier, calibrated from real aircraft in aircraft.js.
 *   budget  → B737-800 equivalent (162 seats, $6.54/km op cost)
 *   legacy  → B767-300ER / B777-200ER mix (250 seats, $10.15/km)
 *   premium → B777-200ER / A350-900 mix (335 seats, $12.78/km)
 */
const TIER_AIRCRAFT = {
  budget:  { seats: 162, costPerKm:  6.54 },
  legacy:  { seats: 250, costPerKm: 10.15 },
  premium: { seats: 335, costPerKm: 12.78 },
};

/**
 * Estimated weekly fixed cost per active route (lease amortised across network).
 * Based on ~1 aircraft per route at typical weekly lease rates.
 */
const TIER_FIXED_PER_ROUTE = {
  budget:   80_000,  // ~1 737-800 lease/wk
  legacy:  200_000,  // ~1 767/777 lease/wk
  premium: 290_000,  // ~1 777/A350 lease/wk
};

/**
 * Per-departure airport cost per seat ($): landing fees, gate usage, and
 * ground handling. Budget carriers use secondary airports and 25-minute
 * turns; premium carriers pay for prime slots and lounges.
 */
const AIRPORT_COST_PER_SEAT = { budget: 11, legacy: 16, premium: 18 };

/**
 * Per-passenger service cost ($): catering, distribution/booking fees,
 * loyalty accrual, compensation reserve. LCCs strip nearly all of it
 * (no meals, direct web sales); premium carriers spend heavily.
 */
const PAX_SERVICE_COST = { budget: 10, legacy: 28, premium: 42 };

/**
 * Ancillary revenue per passenger ($): bags, seat selection, onboard sales.
 * The LCC model earns a large chunk of its money here — it's what makes a
 * 0.76× fare viable, mirroring real low-cost economics.
 */
const PAX_ANCILLARY_REVENUE = { budget: 13, legacy: 4, premium: 2 };

/**
 * Uplift on the raw fuel+crew per-km cost covering maintenance consumables,
 * ownership/insurance, and dispatch — brings competitor unit costs in line
 * with what the player actually pays, so route margins are airline-realistic
 * (fat monopolies, thin contested lanes, losses on mistakes) instead of the
 * old ~50%+ margins that let every carrier bank cash forever. Budget fleets
 * fly one aircraft type at high utilisation → lower uplift.
 */
const OP_COST_UPLIFT = { budget: 1.42, legacy: 1.55, premium: 1.62 };

/**
 * Weekly corporate overhead: base + per-route admin (mildly super-linear, so
 * sprawling networks carry real HQ drag like the player's overhead ladder).
 */
function competitorOverhead(routeCount) {
  return 150_000 + 40_000 * Math.pow(routeCount, 1.15);
}

/**
 * Build a map of pairKey → number of carriers serving that O&D (player included).
 * Feeds demand-splitting in competitor economics: carriers sharing a city pair
 * share its passenger pool instead of each pretending to fly a monopoly.
 *
 * @param {CompetitorAirline[]} competitors
 * @param {Array<{origin:string,destination:string}>} [playerRoutes]
 * @returns {Map<string, number>}
 */
export function buildPairIncumbents(competitors, playerRoutes = []) {
  const counts = new Map();
  const seenPlayer = new Set();
  for (const r of playerRoutes) {
    const key = [r.origin, r.destination].sort().join('-');
    if (!seenPlayer.has(key)) { counts.set(key, 1); seenPlayer.add(key); }
  }
  for (const c of competitors) {
    for (const key of Object.keys(c.routes ?? {})) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Weekly P&L for ONE competitor route. Single source of truth for competitor
 * economics — used by the aggregate stats below and by the adaptive AI when
 * deciding which routes to cut or defend.
 *
 * Demand model: baseCityPairDemand × seasonality × price elasticity, SPLIT
 * across all carriers serving the pair (a duopoly grows the market a little,
 * but each carrier gets far less than the whole pool).
 * Cost model: per-km op cost + per-seat airport fees + lease/maintenance.
 *
 * @param {CompetitorAirline} competitor
 * @param {string} routeKey
 * @param {object} cfg              route config { frequency, priceMultiplier, aircraftType?, tails? }
 * @param {number} [month=1]
 * @param {Map<string,number>|null} [pairCounts]  from buildPairIncumbents (null = monopoly)
 * @returns {{ revenue, cost, profit, pax, flights, loadFactor }|null}
 */
export function computeCompetitorRoutePnL(competitor, routeKey, cfg, month = 1, pairCounts = null) {
  const ac      = TIER_AIRCRAFT[competitor.tier]        ?? TIER_AIRCRAFT.legacy;
  const fixedPR = TIER_FIXED_PER_ROUTE[competitor.tier] ?? 200_000;

  const [a, b] = routeKey.split('-');
  const dist  = routeDistance(a, b);
  const refP  = referencePrice(a, b);
  const baseD = baseCityPairDemand(a, b);
  if (!dist || !refP || !baseD) return null;

  const type    = cfg.aircraftType ? getAircraftType(cfg.aircraftType) : null;
  const seats   = type?.seats ?? ac.seats;
  const opPerKm = type ? (fuelCostPerKm(type) + (type.crewCostPerKm ?? 0)) : ac.costPerKm;
  const tails   = cfg.tails ?? 1;

  const seasonal     = getSeasonalProfile(a, b)[month] ?? 1;
  const price        = Math.round(refP * cfg.priceMultiplier);
  const flightsPerWk = cfg.frequency * 2;                          // bidirectional
  const capOneWay    = seats * cfg.frequency;
  const priceRatio   = refP / Math.max(price, 1);

  // Competition split: n carriers share a pool that expands mildly with entry
  // (competition stimulates some demand), so each incumbent's slice shrinks
  // fast as a pair gets crowded: 1 → 100%, 2 → ~54%, 3 → ~37%, 4 → ~29%.
  const nCarriers = Math.max(1, pairCounts?.get(routeKey) ?? 1);
  const shareOfPool = Math.pow(nCarriers, 0.15) / nCarriers;

  const demandOneWay = Math.round(baseD * Math.pow(priceRatio, 1.3) * seasonal * shareOfPool);
  const paxOneWay    = Math.min(demandOneWay, Math.round(capOneWay * 0.88)); // max 88% LF
  const weeklyPax    = paxOneWay * 2;

  const tier        = competitor.tier ?? 'legacy';
  const revenue     = weeklyPax * (price + (PAX_ANCILLARY_REVENUE[tier] ?? 4));
  const opCost      = dist * opPerKm * (OP_COST_UPLIFT[tier] ?? 1.55) * flightsPerWk;
  const airportCost = seats * (AIRPORT_COST_PER_SEAT[tier] ?? 16) * flightsPerWk;
  const paxCost     = weeklyPax * (PAX_SERVICE_COST[tier] ?? 28);
  const fixed       = type ? tails * ((type.weeklyLease ?? 0) + (type.baseMaintenancePerWk ?? 0)) : fixedPR;
  const cost        = Math.round(opCost + airportCost + paxCost + fixed);

  return {
    revenue:    Math.round(revenue),
    cost,
    profit:     Math.round(revenue) - cost,
    pax:        weeklyPax,
    flights:    flightsPerWk,
    loadFactor: capOneWay > 0 ? paxOneWay / capOneWay : 0,
  };
}

/**
 * Simulate one week of a competitor's entire network.
 * Returns aggregated flights, passengers, revenue, cost, and profit.
 * Includes corporate overhead on top of per-route costs.
 *
 * @param {CompetitorAirline} competitor
 * @param {number} [month=1]  current game month (1-12) for seasonality
 * @param {Map<string,number>|null} [pairCounts]  from buildPairIncumbents;
 *   when provided, demand splits across carriers sharing each pair.
 * @returns {{ weeklyFlights, weeklyPax, weeklyRevenue, weeklyCost, weeklyProfit }}
 */
export function computeCompetitorWeeklyStats(competitor, month = 1, pairCounts = null) {
  let totalFlights = 0;
  let totalPax     = 0;
  let totalRevenue = 0;
  let totalCost    = 0;
  let routeCount   = 0;

  for (const [routeKey, cfg] of Object.entries(competitor.routes)) {
    const p = computeCompetitorRoutePnL(competitor, routeKey, cfg, month, pairCounts);
    if (!p) continue;
    routeCount   += 1;
    totalFlights += p.flights;
    totalPax     += p.pax;
    totalRevenue += p.revenue;
    totalCost    += p.cost;
  }

  totalCost += Math.round(competitorOverhead(routeCount));
  const weeklyProfit = totalRevenue - totalCost;

  return {
    weeklyFlights: totalFlights,
    weeklyPax:     totalPax,
    weeklyRevenue: totalRevenue,
    weeklyCost:    totalCost,
    weeklyProfit,
  };
}

/**
 * Build an AirlineOffer for a competitor on a route.
 * Uses their fixed parameters + referencePrice multiplier.
 *
 * @param {CompetitorAirline} competitor
 * @param {RouteMarket}       market
 * @returns {AirlineOffer|null}  null if competitor doesn't serve this route
 */
/**
 * Fraction of a competitor's cabin configured as business class, by carrier
 * tier and stage length. Real carriers dedicate more floor to premium seats on
 * long-haul (lie-flat J cabins) and premium brands carry more than legacies:
 *   budget  → 0 everywhere
 *   legacy  → 8% short-haul → 15% at 6,000 km+
 *   premium → 12% short-haul → 22% at 6,000 km+
 * Deterministic (no RNG) so a route's competitive capacity is stable week to week.
 */
export function competitorBusinessFraction(tier, distanceKm = 0) {
  if (tier === 'budget') return 0;
  const longHaul = Math.min(1, Math.max(0, (distanceKm - 1500) / 4500)); // 0 → 1 at 6,000 km
  return tier === 'premium'
    ? 0.12 + 0.10 * longHaul
    : 0.08 + 0.07 * longHaul;
}

export function buildCompetitorOffer(competitor, market) {
  const routeKey = [market.origin, market.destination].sort().join('-');
  const config   = competitor.routes[routeKey];
  if (!config) return null;

  const economyPrice = Math.round(market.referencePrice * config.priceMultiplier);
  const hasBusinessClass = competitor.tier !== 'budget';
  const businessPrice    = hasBusinessClass
    ? Math.round(economyPrice * BUSINESS_PRICE_MULTIPLIER)
    : null;

  // Use the route's real assigned aircraft for capacity; fall back to mid-size.
  const acType          = config.aircraftType ? getAircraftType(config.aircraftType) : null;
  const seatsPerFlight  = acType?.seats ?? 150;
  const businessPerFlight = hasBusinessClass
    ? Math.round(seatsPerFlight * competitorBusinessFraction(competitor.tier, market.distanceKm))
    : 0;

  return {
    airlineId:         competitor.id,
    origin:            market.origin,
    destination:       market.destination,
    economyPrice,
    businessPrice,
    weeklyFrequency:   config.frequency,
    seatsPerFlight,
    economySeats:      seatsPerFlight  * config.frequency,
    businessSeats:     businessPerFlight * config.frequency,
    // Alliance members' offers read slightly better to passengers (network
    // reach, lounges, miles) — keep in sync with ALLIANCE_OFFER_QUALITY_BONUS
    // in competitorAI.js.
    qualityScore:      competitor.baseQualityScore + (competitor.allianceId ? 3 : 0),
    connectivityBonus: computeConnectivityBonus(competitor.homeHub, market.origin, market.destination)
                       + (competitor.secondaryHub
                          ? computeConnectivityBonus(competitor.secondaryHub, market.origin, market.destination)
                          : 0),
  };
}

// ─── Route maturity tracker ───────────────────────────────────────────────────

/**
 * Ramp-up factor for a newly opened route.
 * Returns a 0–1 maturity multiplier based on weeks since route launch.
 *
 * Real-world route spool-up takes 6–18 months: schedules load into GDS,
 * corporate contracts get signed, connecting itineraries appear, and local
 * awareness builds. Modelled as a square-root ramp — fastest gains in the
 * first weeks (the route becomes bookable), then a long tail to full demand.
 *
 * Launch: 55% of demand · ~82% by week 6 · ~95% by week 13 · 100% at week 16.
 * New routes burn cash before they earn — opening one is an investment, not
 * an instant profit source.
 *
 * @param {number} weeksOpen
 * @returns {number}
 */
export function routeMaturityFactor(weeksOpen) {
  if (weeksOpen >= 16) return 1;
  return Math.min(1, 0.55 + 0.45 * Math.sqrt(weeksOpen / 16));
}
