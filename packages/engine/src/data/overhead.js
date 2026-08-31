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

/**
 * Weekly HQ & corporate overhead for a fleet, in NARROWBODY-EQUIVALENTS.
 *
 * The argument is deliberately NOT `fleet.length` any more — see fleetHQScale()
 * below. An all-narrowbody fleet returns exactly its aircraft count, so every
 * calibration figure in the table above still reads true for it.
 */
export function calcHQCost(fleetScale) {
  if (fleetScale <= 0) return 0;
  return Math.round(38_000 * Math.pow(fleetScale, 0.85) * _eraCostScale);
}

// ─── 1a. Corporate overhead scales with the aeroplane ────────────────────────
//
// The curve above counted AIRFRAMES, so a Dash 8 carried an A380's head office.
// That is the same defect crew pay had before CREW_SCALE_BY_CATEGORY (labor.js)
// and liability insurance had before LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY
// (below): it is not a rounding error at the bottom of the range. A turboprop's
// whole weekly revenue is about $49k on the calibration table in this file, and
// at two airframes the fleet-size curve alone billed $68.5k — more than gross,
// before fuel, crew or leases. Measured over six live worlds, sub-80-seat starts
// died at 70% against a narrowbody's 38%, and 11 of 13 never recorded a single
// profitable week. See docs/startup-survival-audit-2026-08-26.md.
//
// Corporate overhead is not seat-proportional the way cabin crew is — a CEO, a
// finance team and an AOC exist whatever is parked outside — but it is not flat
// either: reservations, revenue management, station admin and dispatch all track
// the size of what is being sold. So this sits between the two, nearer the
// pilots scale (0.55 for a turboprop) than the cabin-crew one (0.30).
//
// Narrow Body is 1.00 BY CONSTRUCTION, so the game's most common category sees
// no change at all. This is a re-shape, not a rise: measured against the live
// worlds it moves small-gauge airlines by -3 to -5% of revenue and the largest
// widebody operators by +0.1 to +0.2%, and pushes no profitable airline into
// loss. It is also the same principle the per-departure table below was built
// on — upgauging must not dodge overhead, and neither must downgauging pay an
// upgauged airline's bill.
export const HQ_SCALE_BY_CATEGORY = {
  'Air Taxi':     0.11,   // anchor only — an AOC, a desk and a phone
  'Commuter':     0.20,   // anchor only — see CATEGORY_MEDIAN_SEATS
  'Turboprop':    0.35,
  'Regional Jet': 0.55,
  'Narrow Body':  1.00,
  'Wide Body':    1.70,
  'Double Deck':  2.10,
  'Supersonic':   1.60,
};

/**
 * Freighters all share one category, so — exactly as with insurance and crew —
 * they step by payload instead. Rates sit below the passenger equivalents: no
 * cabin means no distribution, no revenue management across four fare classes
 * and no loyalty programme to administer.
 */
export const HQ_SCALE_FREIGHTER = [
  { maxTonnes:  20, scale: 0.40 },
  { maxTonnes:  45, scale: 0.60 },
  { maxTonnes:  80, scale: 0.90 },
  { maxTonnes: 130, scale: 1.30 },
  { maxTonnes: Infinity, scale: 1.70 },
];

// ─── Category tables are ANCHORS on a seat curve, not step functions ─────────
//
// Keying a scale off `category` puts a cliff at every boundary, and the game's
// categories are not evenly spaced in seats. The worst case measured:
//
//   757-300   Narrow Body  295 seats   labour $58,000  + HQ $38,000  = $96,000
//   767-200ER Wide Body    290 seats   labour $105,300 + HQ $59,658  = $164,958
//
// Five fewer seats, 72% more fixed cost — which handed the 757-300 the lowest
// break-even load factor of any aircraft in the game. Across the catalogue that
// produced four places where MORE seats cost LESS, and 107 pairs sitting within
// ten seats of each other yet differing by over 15%.
//
// A category is a shorthand for size. Where the two disagree, size wins. So the
// category tables are read as ANCHOR POINTS on a curve through seat count, at
// the same median seats the per-departure fee table above was calibrated
// against — every calibrated number still holds exactly at its own anchor, and
// only aircraft BETWEEN anchors move. The ends CLAMP rather than extrapolate,
// so an 853-seat A380 keeps paying the double-deck rate it pays today rather
// than silently repricing the largest airlines in the game.
// Two of these are not aircraft categories at all. 'Air Taxi' and 'Commuter' are
// ANCHOR POINTS ONLY — no type in the catalogue carries either as its category,
// and nothing looks them up directly. They exist because the curve used to stop
// at 39 seats and CLAMP, so a 9-seat Islander was charged a 39-seater's head
// office and crew. Measured consequence: every type under about 21 seats was
// loss-making with every seat sold at maximum legal frequency — not
// uncompetitive, incapable. That stranded ten aircraft AND the 25 airports under
// 4,000ft they exist to serve, St Barths (2,119ft) among them.
export const CATEGORY_MEDIAN_SEATS = {
  'Air Taxi':       9,
  'Commuter':      19,
  'Turboprop':     39,
  'Regional Jet':  92,
  'Narrow Body':  186,
  'Wide Body':    420,
  'Double Deck':  605,
};

/**
 * Read a by-category scale table as a piecewise-linear curve through seats.
 * Shared by HQ overhead here and by crew pay in labor.js, so the two can never
 * disagree about where a 200-seat aircraft sits.
 */
export function scaleBySeats(byCategory, seats) {
  const n = Number(seats);
  // No usable seat count means the curve has nothing to read. Return null so the
  // caller falls back to its category — NOT the smallest anchor, which would
  // administer and crew an unknown widebody as though it were a 39-seat commuter.
  // This is how a synthetic type with no `seats` field got turboprop pilots.
  if (!Number.isFinite(n) || n <= 0) return null;
  const pts = Object.entries(CATEGORY_MEDIAN_SEATS)
    .map(([cat, s]) => [s, byCategory?.[cat]])
    .filter(([, v]) => typeof v === 'number')
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  if (n <= pts[0][0]) return pts[0][1];
  if (n >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [s0, v0] = pts[i - 1], [s1, v1] = pts[i];
    if (n <= s1) return v0 + (v1 - v0) * ((n - s0) / (s1 - s0));
  }
  return pts[pts.length - 1][1];
}

/**
 * How many narrowbody-equivalents of head office one airframe costs.
 *
 * Freighters step by payload — they have no cabin to count. Supersonic keeps a
 * category override: Concorde is 128 seats of extraordinary complexity, and
 * interpolating it against a regional jet would under-price it badly. Everything
 * else reads the table as a seat curve. A missing type falls back to 1.00 — a
 * new aircraft is charged the common rate rather than administering itself free.
 */
export function hqScaleFor(aircraftType) {
  if (!aircraftType) return 1;
  if (aircraftType.freighter) {
    const t = aircraftType.payloadTonnes ?? 0;
    return HQ_SCALE_FREIGHTER.find(s => t <= s.maxTonnes).scale;
  }
  if (aircraftType.category === 'Supersonic') return HQ_SCALE_BY_CATEGORY['Supersonic'];
  if (aircraftType.doubleDeck) return HQ_SCALE_BY_CATEGORY['Double Deck'];
  return scaleBySeats(HQ_SCALE_BY_CATEGORY, aircraftType.seats)
      ?? HQ_SCALE_BY_CATEGORY[aircraftType.category]
      ?? 1;
}

/**
 * The fleet's total head-office scale, in narrowbody-equivalents. This is what
 * replaces `fleet.length` in calcHQCost — an all-narrowbody fleet returns
 * exactly its aircraft count, so nothing moves for it.
 */
export function fleetHQScale(fleet, typeOf) {
  return (fleet ?? []).reduce((s, a) => s + hqScaleFor(typeOf(a)), 0);
}

// ─── 1b. HQ overhead by DEPARTURE (New World Restrictions worlds only) ───────
//
// The fleet-size curve above prices corporate overhead per AIRCRAFT, which has two
// problems once an airline is big. It is tiny relative to revenue (a 43-aircraft
// carrier turning $199M/wk pays $931k — 0.47%, against a real-world G&A of 5-8%),
// and because it counts airframes rather than output, an A380 and a Dash 8 cost
// the same to administer. Upgauging dodges overhead entirely.
//
// Real corporate overhead — dispatch, crew pairing, ops control, revenue
// management, station admin — scales with DEPARTURES, and with how big the
// aircraft departing is. So: a fee per departure, by class.
//
// Calibrated against revenue per departure (median seats for the class, at the
// sector length that class actually flies, 85% load, economy at reference fare)
// so the charge lands at a roughly flat share of revenue instead of crushing
// short-haul. A FLAT per-departure fee would cost a turboprop operator 69% of
// revenue and an A380 operator 1.2% — an 58x spread, which is why this is a
// table and not a constant.
//
// HALVED 2026-07-29, hours after shipping. The first table was calibrated at ~4%
// of revenue per departure, which sounded modest — but measured against a real
// airline it took G&A from 5.3% to 10.2% of revenue, ~$98k/wk on a $3M carrier,
// and pushed an otherwise-healthy operation to a negative margin. The mistake
// underneath was the premise: the fee was built to rein in 30% margins observed
// on a mature year-3 premium long-haul carrier, but a NORMAL airline at ordinary
// scale runs ~4% EBITDA, so a uniform per-departure charge barely touches the
// airline it was aimed at and guts the ones starting out.
//
//   class          median seats   rev/departure   fee      as % of revenue
//   Turboprop            39          $3,481       $100          2.9%
//   Regional Jet         92         $10,948       $250          2.3%
//   Narrow Body         186         $35,731       $750          2.1%
//   Wide Body           420        $206,703     $4,000          1.9%
//   Double Deck         605        $337,862     $7,500          2.2%
//   Supersonic          128        $161,269     $3,250          2.0%
//
// Freighters are priced by their airframe's body class (freighterBodyClass), not
// as passenger aircraft — a freighter carries no cabin, so cabin-service overhead
// does not apply. That puts the 747-400F on the wide-body fee, not the
// double-deck one.
export const HQ_DEPARTURE_FEE = {
  'Turboprop':      100,
  'Regional Jet':   250,
  'Narrow Body':    750,
  'Wide Body':    4_000,
  'Double Deck':  7_500,
  'Supersonic':   3_250,
};

// Fixed corporate structure in a restricted world — the CEO, the finance team and
// the AOC exist before the first departure. Deliberately small: in these worlds the
// DEPARTURE fees are meant to be the driver, so this is a base, not a floor that
// swamps them (the fleet-size curve would: at 10 aircraft it prints $269k/wk, which
// is 5x what ten turboprops generate in departure fees, leaving the small-class
// rates completely inert).
export const HQ_BASE_WEEKLY = 40_000;

// ── Era cost scale (ERA_MODE_PLAN.md §4) ─────────────────────────────────────
// Module-scoped for the same reason as market.js's _fareIndex: these helpers
// are called from ~a dozen sites (tick, reducer guards, UI previews) that
// carry no world context. gameReducer sets it from state on EVERY action;
// 1 (classic) leaves every number below byte-identical — the parity invariant.
// Scales the FIXED-dollar floors a small-revenue era airline cannot outgrow:
// HQ base, the marketing-effectiveness floor, campaign cost per metro-million,
// route launch cost and liability insurance. Nothing revenue-proportional or
// aircraft-value-derived is touched — those self-scale.
let _eraCostScale = 1;
export function setEraCostScale(v) {
  _eraCostScale = Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
}
export function getEraCostScale() { return _eraCostScale; }

/**
 * The floor the gauge scale below decays towards, so a turboprop operator still
 * carries a real corporate structure rather than none. NOT the fleetless rate:
 * an airline with no aircraft keeps paying HQ_BASE_WEEKLY in full, because that
 * state is either momentary (the starter fleet arrives the same week) or
 * terminal, and an airline whose metal has all gone is supposed to bleed out
 * and free the player to re-found rather than linger cheaply.
 */
export const HQ_BASE_MIN = 8_000;

/**
 * The restricted-world base, scaled by what the fleet actually flies.
 *
 * HQ_BASE_WEEKLY was flat, which re-introduced at the base exactly the defect
 * the per-departure table removed at the margin: $40k a week is a rounding
 * error to a widebody operator and most of a turboprop pair's gross revenue.
 * The scale is the fleet AVERAGE, not the sum — this is a base, charged once,
 * not a per-airframe fee — and it is capped at 1.00, so no airline flying
 * narrowbodies or larger pays a cent more than it does today. Relief at the
 * bottom, unchanged at the top; the departure fees remain the driver.
 *
 * A fleetless airline is not "smaller" than a turboprop operator, it is an
 * airline in an abnormal state, and it pays the full base — see HQ_BASE_MIN.
 */
export function hqBaseWeekly(fleet, typeOf) {
  if (!fleet?.length) return Math.round(HQ_BASE_WEEKLY * _eraCostScale);   // see HQ_BASE_MIN — not the floor
  const avg = fleetHQScale(fleet, typeOf) / fleet.length;
  return Math.round((HQ_BASE_MIN + (HQ_BASE_WEEKLY - HQ_BASE_MIN) * Math.min(avg, 1)) * _eraCostScale);
}

/** Per-departure HQ fee for a body class, falling back to the narrowbody rate. */
export function hqDepartureFee(bodyClass) {
  return HQ_DEPARTURE_FEE[bodyClass] ?? HQ_DEPARTURE_FEE['Narrow Body'];
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
 * Fraction of an airframe's PURCHASE PRICE it is still worth, at a given age.
 *
 * purchasePrice is the price of a frame of that type AS DELIVERED — for a used
 * conversion (type.deliveredAgeWeeks > 0) that is already a used-market price,
 * not a new-build one. So depreciation has to run from the delivered value, or
 * a 12-year-old 747-400F would lose 40% of its value the instant it arrived,
 * double-counting an age discount already baked into the price.
 *
 * Straight-line to the same 10% floor at 30 years of TOTAL airframe age, which
 * means a used frame depreciates faster in percentage terms — correct, since it
 * has fewer years left to spread the loss over.
 */
export function valueRemaining(ageWeeks, type) {
  const ageYears       = (ageWeeks ?? 0) / 52;
  const deliveredYears = (type?.deliveredAgeWeeks ?? 0) / 52;
  const now  = 1 - ageYears / DEPRECIATION_YEARS;
  const base = 1 - deliveredYears / DEPRECIATION_YEARS;   // = 1 for a new build
  return Math.max(0.1, base > 0 ? now / base : 0);
}

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

/**
 * Freighters all share one category, so they cannot be stepped by it the way
 * passenger types are — a 9-tonne ATR and a 250-tonne An-225 would insure
 * identically. Step them by payload instead. Rates sit below the passenger
 * equivalents: no passengers means far less third-party liability exposure.
 */
export const LIABILITY_INSURANCE_WEEKLY_FREIGHTER = [
  { maxTonnes:  20, weekly:  4_000 },
  { maxTonnes:  45, weekly:  7_000 },
  { maxTonnes:  80, weekly: 11_000 },
  { maxTonnes: 130, weekly: 15_000 },
  { maxTonnes: Infinity, weekly: 20_000 },
];

/** Weekly liability premium for one aircraft, by its type's category (or payload). */
export function liabilityInsuranceWeekly(aircraftType) {
  if (aircraftType?.freighter) {
    const t = aircraftType.payloadTonnes ?? 0;
    return Math.round(LIABILITY_INSURANCE_WEEKLY_FREIGHTER.find(s => t <= s.maxTonnes).weekly * _eraCostScale);
  }
  return Math.round((LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY[aircraftType?.category]
    ?? LIABILITY_INSURANCE_WEEKLY_PER_AIRCRAFT) * _eraCostScale);
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
  const remaining  = valueRemaining(aircraft.ageWeeks, aircraftType);    // never below 10 % of delivered value
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
  // Outsize freighters (An-124 / An-225 class). Previously these fell into
  // 'Wide Body' and paid the same as a 52-tonne 767F despite needing dedicated
  // stands, heavy-lift ground equipment and closed taxiways.
  'Outsize':     { mega: 13_000, major: 8_300, regional: 3_500 },
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
  // Each weekly frequency generates one outbound (lands at dest) + one return (lands at origin).
  // Era: airport charges are constant-dollar overhead and follow the era scale (1 in classic).
  return Math.round((feeAtDest + feeAtOrigin) * weeklyFrequency * _eraCostScale);
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
  // Era: handling is a labour service — follows the era scale (1 in classic).
  return Math.round(
    Object.entries(GROUND_HANDLING_COST_PER_PAX).reduce((s, [cls, rate]) => {
      return s + (classSummary[cls]?.passengers ?? 0) * 2 * rate;
    }, 0) * _eraCostScale
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
 *
 * `contractFactor` is the discount for premium ground service you no longer buy
 * from a contractor because you BUILT THE ROOM YOURSELF. It comes from
 * loungeContractFactor() in data/lounges.js — 1 at an airport where you own
 * nothing (the historical behaviour, and the default for every caller that
 * doesn't pass it), falling toward LOUNGE_OWNED_COST_FACTOR as your own lounges
 * cover the route's endpoints. You still feed and staff the room; you have
 * stopped paying somebody else's margin on every premium passenger.
 */
export function weeklyLoungeCost(classSummary, contractFactor = 1) {
  const f = Math.max(0, Number.isFinite(contractFactor) ? contractFactor : 1);
  return Math.round(
    Object.entries(LOUNGE_COST_PER_PAX).reduce((s, [cls, rate]) => {
      return s + (classSummary[cls]?.passengers ?? 0) * 2 * rate;
    }, 0) * f
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
  // The biggest and longest-range airframes fly with an augmented flight deck
  // (3-4 pilots), not fewer than a widebody: a Double Deck or a Supersonic is
  // never a 2-pilot operation. Widebody and up get 3; everything smaller, 2.
  const flightDeckCrew = (category === 'Wide Body' || category === 'Double Deck' || category === 'Supersonic') ? 3 : 2;
  const cabinCrew      = Math.max(1, Math.ceil(seats / 50));
  const totalCrew      = flightDeckCrew + cabinCrew;
  // Era: hotel nights and per diems follow the era scale (1 in classic).
  return Math.round(totalCrew * LAYOVER_COST_PER_CREW_NIGHT * weeklyFreq * 2 * _eraCostScale);
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
  // Era: compensation regimes are a modern thing and the amounts are set in
  // modern money — follows the era scale (1 in classic).
  return Math.round(passengers * compensableFraction * compensationPerPax(distKm) * _eraCostScale);
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
  const scale = Math.max((weeklyRevenue || 0) * MARKETING_GAIN_SCALE, 40_000 * _eraCostScale);
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
  const scale = Math.max(airportPopM ?? 1, 0.2) * CAMPAIGN_COST_PER_M * _eraCostScale;
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
  return Math.round((40_000 + distKm * 22) * _eraCostScale);
}
