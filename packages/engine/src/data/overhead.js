/**
 * overhead.js — Corporate overhead costs not tied to individual routes or aircraft.
 *
 * Covers four cost categories:
 *   1. HQ & Corporate overhead  — scales with fleet size (management, IT, legal, admin)
 *   2. Insurance                — hull (owned aircraft) + liability (all aircraft)
 *   3. Landing & Nav fees       — per departure, by aircraft category
 *   4. Marketing budget         — player-controlled; drives a demand multiplier
 */

// ─── 1. HQ & Corporate overhead ──────────────────────────────────────────────
//
// Represents: executive pay, HQ office rent, GDS/reservation system,
// crew-scheduling software, revenue management, legal, compliance, finance/accounting.
//
// Modelled as a continuous power function of fleet size:
//   weeklyHQCost = 45_000 × n^0.85
//
// This captures the two economic realities of airline overhead:
//   (a) There are strong fixed costs — a 1-aircraft airline still needs a CEO, legal, IT
//   (b) Economies of scale — per-aircraft overhead falls as you grow
//
// Calibration (weekly cost → annual cost → per-aircraft/year):
//   1  aircraft  →  $45K/wk  →  $2.3M/yr  →  $2.3M per aircraft
//   5  aircraft  →  $190K/wk →  $9.9M/yr  →  $2.0M per aircraft
//   10 aircraft  →  $319K/wk →  $16.6M/yr →  $1.7M per aircraft
//   20 aircraft  →  $599K/wk →  $31.1M/yr →  $1.6M per aircraft
//   40 aircraft  →  $1.13M/wk → $58.7M/yr →  $1.5M per aircraft
//   100 aircraft →  $2.53M/wk → $131M/yr  →  $1.3M per aircraft
//
// Industry reference: G&A runs $1–3M per aircraft/year for mid-size carriers.

/** Weekly HQ & corporate overhead for a given fleet size. */
export function calcHQCost(fleetSize) {
  if (fleetSize <= 0) return 0;
  return Math.round(38_000 * Math.pow(fleetSize, 0.85));
}

/**
 * Descriptive label and description for the current fleet size — purely for UI display.
 * Cost no longer jumps at discrete thresholds; these labels are size-based approximations.
 */
export function hqBracket(fleetSize) {
  if (fleetSize === 0) return { label: 'Pre-launch',  description: 'No corporate structure yet.' };
  if (fleetSize <= 3)  return { label: 'Startup',     description: 'Small office, basic booking system, lean management team.' };
  if (fleetSize <= 8)  return { label: 'Regional',    description: 'Proper office, IT systems, revenue management, finance & legal.' };
  if (fleetSize <= 15) return { label: 'Mid-size',    description: 'Full HQ, GDS integrations, crew-scheduling platform, HR dept.' };
  if (fleetSize <= 30) return { label: 'National',    description: 'Corporate HQ, all departments, regulatory affairs office.' };
  return                      { label: 'Major',       description: 'Full corporate apparatus: investor relations, government affairs, global IT.' };
}

/**
 * No longer meaningful — overhead now scales continuously.
 * Returns null so any UI that checks this simply hides the threshold warning.
 */
export function nextHQThreshold(_fleetSize) {
  return null;
}


// ─── 2. Insurance ─────────────────────────────────────────────────────────────
//
// Hull insurance: protects owned aircraft against damage/total loss.
//   Rate ≈ 0.5% of purchase price per year.  Only applies to owned aircraft.
//
// Liability insurance: third-party passenger & hull liability for all aircraft,
//   regardless of ownership — lessor's insurance typically covers the hull but
//   the lessee still needs full liability coverage.

/** Annual hull insurance rate as a fraction of aircraft purchase price. */
export const HULL_INSURANCE_ANNUAL_RATE = 0.008;   // 0.8 % p.a.

/**
 * Useful life for straight-line depreciation AND book value, in years.
 * Single source of truth: drives the depreciation tax shield, balance-sheet book
 * value, and hull-insurance book value. Defined here (a dependency-free leaf
 * module) so every layer imports the same number with no import cycles.
 */
export const DEPRECIATION_YEARS = 30;

/**
 * Weekly liability premium per aircraft (owned or leased), stepped by aircraft
 * category — larger aircraft carry far more passenger/third-party liability, so a
 * turboprop is much cheaper to insure than a widebody. This also gives small-aircraft
 * startups meaningful relief versus a flat rate.
 */
export const LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY = {
  'Turboprop':    6_000,
  'Regional Jet': 9_000,
  'Narrow Body':  12_000,
  'Wide Body':    18_000,
  'Double Deck':  24_000,
  'Supersonic':   20_000,
};
/** Fallback weekly liability premium when an aircraft's category is unknown. */
export const LIABILITY_INSURANCE_WEEKLY_PER_AIRCRAFT = 12_000;

/** Weekly liability premium for one aircraft, by its type's category. */
export function liabilityInsuranceWeekly(aircraftType) {
  return LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY[aircraftType?.category]
    ?? LIABILITY_INSURANCE_WEEKLY_PER_AIRCRAFT;
}

/**
 * Weekly insurance cost for a single aircraft.
 *   owned:  hull (book-value based) + liability
 *   leased: liability only
 */
export function weeklyInsuranceCost(aircraft, aircraftType) {
  const liability = liabilityInsuranceWeekly(aircraftType);
  if (aircraft.ownershipType !== 'owned' || !aircraftType?.purchasePrice) {
    return liability;
  }
  // Hull: book value declines linearly over the useful life (same schedule as
  // depreciation and the balance sheet — one definition of "book value").
  const ageYears   = (aircraft.ageWeeks ?? 0) / 52;
  const remaining  = Math.max(0.1, 1 - ageYears / DEPRECIATION_YEARS);   // never below 10 % of new value
  const bookValue  = aircraftType.purchasePrice * remaining;
  const hullAnnual = bookValue * HULL_INSURANCE_ANNUAL_RATE;
  const hullWeekly = Math.round(hullAnnual / 52);
  return liability + hullWeekly;
}


// ─── 3. Landing & Navigation fees ────────────────────────────────────────────
//
// Covers: airport landing fees, Eurocontrol/ATC en-route charges, passenger
// facility charges.  Charged per actual departure (each direction of each
// weekly frequency).
//
// Fees vary by both aircraft category and destination airport tier:
//   mega   — LHR, JFK, DXB, NRT etc.  High slot demand, expensive infrastructure.
//   major  — ORD, SFO, FRA etc.
//   regional — smaller city airports
//
// Each leg pays the fee for its destination airport (landing fee is charged
// at the airport you land at, not the one you depart from).

export const LANDING_FEE_PER_DEPARTURE = {
  //                    mega      major   regional   [~15% lower than original]
  'Turboprop':   { mega:   600, major:   380, regional:   170 },
  'Regional Jet':{ mega: 1_700, major: 1_020, regional:   470 },
  'Narrow Body': { mega: 3_800, major: 2_400, regional:   950 },
  'Wide Body':   { mega: 7_650, major: 4_900, regional: 2_050 },
};

/** Default fallback if category or tier not found. */
const LANDING_FEE_DEFAULT = 1_400;

/**
 * Weekly landing + nav fee for one route.
 *   = (fee at origin tier + fee at destination tier) × weekly_frequency
 *
 * @param {string} aircraftCategory  - 'Narrow Body', 'Wide Body', etc.
 * @param {number} weeklyFrequency   - one-way weekly departures
 * @param {string} [originTier]      - 'mega' | 'major' | 'regional'
 * @param {string} [destTier]        - 'mega' | 'major' | 'regional'
 */
export function weeklyLandingFee(aircraftCategory, weeklyFrequency, originTier, destTier) {
  const catFees = LANDING_FEE_PER_DEPARTURE[aircraftCategory];
  const feeAtOrigin = catFees?.[originTier] ?? LANDING_FEE_DEFAULT;
  const feeAtDest   = catFees?.[destTier]   ?? LANDING_FEE_DEFAULT;
  // Each weekly frequency generates one outbound (lands at dest) + one return (lands at origin)
  return (feeAtDest + feeAtOrigin) * weeklyFrequency;
}


// ─── 4. Catering ─────────────────────────────────────────────────────────────
//
// Per-passenger, per-leg catering cost.  Applies to actual boarded passengers.
// Covers food, beverages, packaging, and galley provisioning.
// Economy rate assumes a snack + drink; premium cabins get full meal service.

export const CATERING_COST_PER_PAX = {
  economy:        12,   // snack + drink (legacy: 4 — was too low, real rate ~$10-15)
  premiumEconomy: 28,   // light meal + drink (legacy: 11)
  businessClass:  80,   // full hot meal, wine, amenity kit (legacy: 30 — real rate ~$80-150)
  firstClass:     160,  // multi-course, premium spirits, luxury amenities (legacy: 65)
};

/**
 * Weekly catering cost for one route.
 * classSummary: { [cls]: { passengers: number } } — one-way pax (per direction).
 * Multiply by 2 to get total boarded passengers in both directions.
 */
export function weeklyCateringCost(classSummary) {
  return Math.round(
    Object.entries(CATERING_COST_PER_PAX).reduce((s, [cls, rate]) => {
      return s + (classSummary[cls]?.passengers ?? 0) * 2 * rate;
    }, 0)
  );
}


// ─── 5. Ground handling ───────────────────────────────────────────────────────
//
// Ramp agents, baggage handlers, pushback, gate agents, check-in staff.
// Charged per boarded passenger (both directions), by cabin class.
// Economy rate assumes simple turnaround; premium cabins get dedicated agents.

export const GROUND_HANDLING_COST_PER_PAX = {
  economy:        10,   // standard ramp + bag + boarding
  premiumEconomy: 13,   // slightly more baggage weight, priority boarding
  businessClass:  30,   // dedicated check-in, lounge coordination, bag priority (was 20)
  firstClass:     55,   // personal agent, limo-to-tarmac, bespoke handling (was 35)
};

/**
 * Weekly ground handling cost for one route.
 * classSummary: { [cls]: { passengers: number } } — one-way pax (per direction).
 * Multiply by 2 to get total boarded passengers in both directions.
 */
export function weeklyGroundHandlingCost(classSummary) {
  return Math.round(
    Object.entries(GROUND_HANDLING_COST_PER_PAX).reduce((s, [cls, rate]) => {
      return s + (classSummary[cls]?.passengers ?? 0) * 2 * rate;
    }, 0)
  );
}


// ─── 5b. Lounge & premium airport services ────────────────────────────────────
//
// Airport lounge access, fast-track security, priority check-in, and dedicated
// ground agents for business/first class passengers.
//
// This is a substantial, real cost often omitted from simple models:
//   - Lounge access (owned lounge amortised, or pay-per-use third-party): ~$40-60/pax
//   - Fast-track security facilitation fees: ~$10-15/pax at major airports
//   - Dedicated premium check-in agents: included in ground handling above
//
// Applied per boarded premium passenger (both directions).

export const LOUNGE_COST_PER_PAX = {
  economy:        0,
  premiumEconomy: 0,
  businessClass:  60,   // lounge access + fast-track + premium ground service
  firstClass:     110,  // first class terminal/lounge (Heathrow T5, Lufthansa FTL, etc.)
};

/**
 * Weekly lounge & premium airport service cost for one route.
 * classSummary: { [cls]: { passengers: number } } — one-way pax (per direction).
 * Multiply by 2 to get total boarded passengers in both directions.
 */
export function weeklyLoungeCost(classSummary) {
  return Math.round(
    Object.entries(LOUNGE_COST_PER_PAX).reduce((s, [cls, rate]) => {
      return s + (classSummary[cls]?.passengers ?? 0) * 2 * rate;
    }, 0)
  );
}


// ─── 6. Distribution & booking fees ──────────────────────────────────────────
//
// GDS fees, OTA commissions, credit-card processing.
// Typically 2–3 % of passenger revenue for a mid-size carrier.
// Applied as a flat percentage of total route revenue.

/** Fraction of revenue charged as distribution / GDS / booking cost. */
export const DISTRIBUTION_COST_PCT = 0.025;


// ─── 7. Crew layover & accommodation ─────────────────────────────────────────
//
// When a one-way sector is long enough that crew cannot return to base
// the same day, the airline must pay for hotel rooms + per diem.
// Threshold is 4 hours block time (roughly 3h flight + 1h on-ground).

export const LAYOVER_BLOCK_HOURS_THRESHOLD = 4.0;
export const LAYOVER_COST_PER_CREW_NIGHT   = 200;   // hotel + per diem, USD

/**
 * Weekly layover cost for one route.
 * @param {number} blockTimeHrs  - one-way block time for the sector
 * @param {number} seats         - aircraft total seats (used to size cabin crew)
 * @param {string} category      - aircraft category (Wide Body needs 3 flight-deck)
 * @param {number} weeklyFreq    - one-way weekly frequency (×2 for both directions)
 */
export function weeklyLayoverCost(blockTimeHrs, seats, category, weeklyFreq) {
  if (blockTimeHrs <= LAYOVER_BLOCK_HOURS_THRESHOLD) return 0;
  const flightDeckCrew = category === 'Wide Body' ? 3 : 2;
  const cabinCrew      = Math.max(1, Math.ceil(seats / 50));
  const totalCrew      = flightDeckCrew + cabinCrew;
  return Math.round(totalCrew * LAYOVER_COST_PER_CREW_NIGHT * weeklyFreq * 2);
}


// ─── 8. Passenger compensation ───────────────────────────────────────────────
//
// When flights are significantly delayed or cancelled, airlines owe compensation
// (EU261 / DOT rules).  Linked to pilot morale → on-time-rate.
//
// Model:
//   delay rate = 1 − onTimeRate
//   ~10% of delays escalate into compensable events (>3h delay or cancellation)
//   compensation amount scales with route distance

export const COMPENSATION_ESCALATION_RATE = 0.10;   // fraction of delays that become compensable

/**
 * Compensation per affected passenger (USD), by route distance (km).
 * Based on EU261 thresholds translated to USD.
 */
export function compensationPerPax(distKm) {
  if (distKm < 1_500) return 275;
  if (distKm < 3_500) return 440;
  return 660;
}

/**
 * Weekly passenger compensation cost for one route.
 * @param {number} passengers  - total weekly passengers (both directions)
 * @param {number} onTimeRate  - 0–1, derived from pilot morale
 * @param {number} distKm      - route distance
 */
export function weeklyPassengerCompensation(passengers, onTimeRate, distKm) {
  const delayRate = Math.max(0, 1 - onTimeRate);
  const compensableFraction = delayRate * COMPENSATION_ESCALATION_RATE;
  return Math.round(passengers * compensableFraction * compensationPerPax(distKm));
}


// ─── 9. Marketing (adstock model) ─────────────────────────────────────────────
//
// Marketing no longer buys an instant demand multiplier. It works like real
// advertising ("adstock"): spend builds a persistent AWARENESS stock (0–100)
// that decays without upkeep, and demand lift derives ONLY from awareness.
// Effects therefore LAG spend by weeks and PERSIST after it stops — cutting the
// budget doesn't crater demand overnight, and a launch blitz has lasting value.
//
// Two layers:
//   1. BRAND spend  → global awareness stock  (slow build, slow decay)
//   2. TARGETED spend per airport → local campaign stock (fast build, fast
//      decay — tactical/promo advertising). Lifts only routes touching that
//      airport.

// ── Brand awareness ──────────────────────────────────────────────────────────

export const AWARENESS_FLOOR       = 5;      // airline stays findable even with zero marketing
export const AWARENESS_PARITY      = 65;     // awareness at which demand reach = 100%
export const AWARENESS_MAX_LIFT    = 0.12;   // household name (100): +12% above parity
export const AWARENESS_DECAY_RATE  = 0.01;   // 1%/wk of awareness above the floor fades
export const MARKETING_MAX_GAIN    = 3.5;    // max awareness points/week from brand spend
export const MARKETING_GAIN_SCALE  = 0.04;   // spend = 4% of revenue → ~63% of max gain
// Equilibria (organic + decay included): no marketing settles ≈52 (reach ~89%);
// sustained heavy spend settles ≈83 (reach ~106%). 100 is asymptotic — household
// names are earned over years, not bought in a quarter.

/**
 * Demand multiplier from brand awareness. Replaces the old separate
 * awareness-penalty and instant-marketing-boost multipliers with one curve:
 *   awareness 0   → 0.40  (unknown brand reaches 40% of potential demand)
 *   awareness 65  → 1.00  (established carrier — parity)
 *   awareness 100 → 1.12  (household name stimulates demand beyond parity)
 * @param {number} awareness – 0–100 brand awareness stock
 */
export function awarenessDemandMultiplier(awareness) {
  const a = Math.max(0, Math.min(100, awareness ?? 0));
  if (a <= AWARENESS_PARITY) return 0.4 + (a / AWARENESS_PARITY) * 0.6;
  return 1 + ((a - AWARENESS_PARITY) / (100 - AWARENESS_PARITY)) * AWARENESS_MAX_LIFT;
}

/**
 * Awareness points gained this week from brand marketing spend, BEFORE the
 * diminishing (1 − awareness/100) factor applied by the caller. Scaled by
 * airline size: moving a big carrier's national awareness costs more.
 * @param {number} weeklySpend   – brand marketing budget ($/wk)
 * @param {number} weeklyRevenue – for scaling spend effectiveness
 */
export function marketingAwarenessGain(weeklySpend, weeklyRevenue) {
  if (weeklySpend <= 0) return 0;
  const scale = Math.max((weeklyRevenue || 0) * MARKETING_GAIN_SCALE, 40_000);
  return MARKETING_MAX_GAIN * (1 - Math.exp(-weeklySpend / scale));
}

// ── Targeted (per-airport) campaigns ─────────────────────────────────────────
//
// Campaign strength is a 0–100 stock per airport. It builds fast with spend
// (scaled by metro size — saturating New York costs more than Boise) and
// decays fast when unfunded (~25%/wk — tactical advertising fades in weeks,
// unlike brand). Sustained spend settles at an equilibrium strength where
// decay balances gain; the UI can show that steady-state boost.

export const CAMPAIGN_MAX_BOOST   = 0.15;    // demand lift at strength 100 (asymptotic scaling constant)
export const CAMPAIGN_DECAY_RATE  = 0.20;    // 20%/wk decay of campaign strength
export const CAMPAIGN_MAX_GAIN    = 40;      // max strength points/week from spend
export const CAMPAIGN_COST_PER_M  = 30_000;  // $/wk per million metro pop for ~63% of max gain
// Max SUSTAINED strength ≈67 → boost ≈ +10%; realistic saturating spend lands +7–9%.

/**
 * Campaign strength points gained this week from targeted spend at one airport,
 * BEFORE the (1 − strength/100) saturation factor applied by the caller.
 * @param {number} weeklySpend – targeted spend at this airport ($/wk)
 * @param {number} airportPopM – metro population in millions (effectivePop preferred)
 */
export function campaignStrengthGain(weeklySpend, airportPopM) {
  if (weeklySpend <= 0) return 0;
  const scale = Math.max(airportPopM ?? 1, 0.2) * CAMPAIGN_COST_PER_M;
  return CAMPAIGN_MAX_GAIN * (1 - Math.exp(-weeklySpend / scale));
}

/**
 * Demand boost (fraction) on routes touching an airport with the given
 * campaign strength.
 * @param {number} strength – 0–100 campaign strength stock
 */
export function campaignDemandBoostPct(strength) {
  return CAMPAIGN_MAX_BOOST * Math.max(0, Math.min(100, strength ?? 0)) / 100;
}

/**
 * Steady-state campaign strength if this spend is sustained indefinitely —
 * where weekly decay equals weekly gain. For the UI ("sustained boost").
 * Solves: DECAY × s = gain × sov × (1 − s/100).
 * @param {number} [sovFactor=1] – share-of-voice factor scaling the gain
 */
export function campaignEquilibriumStrength(weeklySpend, airportPopM, sovFactor = 1) {
  const g = campaignStrengthGain(weeklySpend, airportPopM) * Math.max(0, Math.min(1, sovFactor));
  if (g <= 0) return 0;
  return Math.min(100, g / (CAMPAIGN_DECAY_RATE + g / 100));
}

// ── Share of voice ───────────────────────────────────────────────────────────
//
// Advertising effectiveness is relative: what matters is your share of the
// noise in a market, not absolute spend. Competitor marketing at an airport
// (hub advertising, station presence, counter-blitzes) does two things:
//   1. SLOWS your campaign build there — shareOfVoiceFactor scales your
//      weekly strength gain.
//   2. DRAGS demand on routes touching the airport — rivals are buying
//      mindshare from the same passengers.

export const SOV_COMPETITION_WEIGHT   = 0.6;    // how strongly rival $ dilute your gain
export const COMPETITOR_MKT_MAX_DRAG  = 0.05;   // max demand drag from rival marketing

/**
 * 0–1 factor scaling the player's campaign-strength gain at an airport.
 * 1 with no rival spend; 0.5 when rivals outspend you ~1.7:1.
 */
export function shareOfVoiceFactor(playerSpend, competitorSpend) {
  const p = Math.max(0, playerSpend || 0);
  if (p <= 0) return 0;
  return p / (p + SOV_COMPETITION_WEIGHT * Math.max(0, competitorSpend || 0));
}

/**
 * Demand drag (fraction) on routes touching an airport where competitors are
 * marketing. Saturates with the market's ad-noise scale; countering with your
 * own targeted spend reduces it.
 * @param {number} competitorSpend – rival marketing $/wk at this airport
 * @param {number} playerSpend    – player's targeted $/wk at this airport
 * @param {number} airportPopM    – metro population in millions
 */
export function competitorPressureDrag(competitorSpend, playerSpend, airportPopM) {
  const cs = Math.max(0, competitorSpend || 0);
  if (cs <= 0) return 0;
  const sat = Math.max(airportPopM ?? 1, 0.2) * CAMPAIGN_COST_PER_M;
  return COMPETITOR_MKT_MAX_DRAG * cs / (cs + Math.max(0, playerSpend || 0) + sat);
}


// ─── 10. Route launch cost ────────────────────────────────────────────────────
//
// One-time cost charged when the player opens a new route.
// Covers: route authority filings, bilateral agreements, slot deposits,
// launch marketing campaign, OTA listing fees, initial catering contracts.
//
// Scales with distance (longer routes require more regulatory work and a
// bigger launch marketing push to fill seats):
//   formula: $40K + dist × $22/km
//
// Reference points:
//   500 km  (short regional)       →  $51K
//   1,500 km (medium domestic)     →  $73K
//   3,500 km (transcontinental)    → $117K
//   6,000 km (transatlantic)       → $172K
//   10,000 km (ultra long-haul)    → $260K
//   15,000 km (max range)          → $370K

/**
 * One-time cash cost to open a new route, in dollars.
 * @param {number} distKm  – great-circle distance of the route
 */
export function routeLaunchCost(distKm) {
  return Math.round(40_000 + distKm * 22);
}
