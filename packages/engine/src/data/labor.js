/**
 * labor.js — Employee group definitions and morale model.
 *
 * Four groups each have a pay multiplier (controlled by the player) and a
 * morale score (computed each week as a lagged response to pay vs. market).
 *
 * Pay effects:
 *   pilots         → main driver of onTimeRate in qualityScore (affects demand)
 *   cabinCrew      → customerRating in qualityScore + minor onTimeRate share
 *   groundStaff    → onTimeRate share (turnarounds) + small quality-score bonus/penalty
 *   maintenanceTeam → maintenance cost multiplier
 *
 * On-time rate is a weighted morale blend (pilots 50%, ground staff 30%,
 * cabin crew 20%) minus a schedule-pressure penalty when the fleet is flown
 * close to the weekly block-hour cap (see utilizationOnTimePenalty).
 *
 * Maintenance budget (separate slider) controls:
 *   → direct maintenance cost scaling
 *   → aircraft aging rate (low budget → faster aging → higher future maint costs)
 */

export const LABOR_GROUPS = [
  {
    id:   'pilots',
    name: 'Pilots',
    emoji: '🧑‍✈️',
    // NOTE: flight duty pay (hourly pay while flying) is charged separately as crewCostPerKm.
    // This group covers FIXED overhead: base salary guarantees, sim training, type ratings,
    // standby pay, scheduling staff, chief pilots office.
    description: 'Fixed pilot overhead (base pay, training, standby). Variable flight duty pay is charged separately via Crew Operating Costs. Biggest single driver of your on-time rate.',
    baseWeeklyPerAircraft: 38_000,
    effectDescription: (morale) =>
      `On-time rate (50% share) · ${moraleBand(morale)}`,
  },
  {
    id:   'cabinCrew',
    name: 'Cabin Crew',
    emoji: '🛎️',
    // NOTE: same split as pilots — variable flight costs are in crewCostPerKm.
    // This covers fixed overhead: base pay guarantees, training, uniforms, scheduling.
    description: 'Fixed cabin crew overhead (base pay, training, uniforms). Variable flight duty pay is charged separately via Crew Operating Costs. Service delivery feeds passenger satisfaction (which drives your customer rating over time) plus a small share of on-time rate.',
    baseWeeklyPerAircraft: 10_000,
    effectDescription: (morale) =>
      `Service delivery ${(morale / 100 * 5).toFixed(1)} / 5 · on-time 20% share · ${moraleBand(morale)}`,
  },
  {
    id:   'groundStaff',
    name: 'Ground Staff',
    emoji: '🔧',
    description: 'Check-in, boarding and ramp agents. Fast turnarounds keep flights on time (30% of on-time rate), plus a small bonus or penalty to your overall quality score.',
    baseWeeklyPerAircraft: 4_000,
    effectDescription: (morale) => {
      const bonus = ((morale - 80) / 10).toFixed(1);
      return `On-time 30% share · quality ${bonus >= 0 ? '+' : ''}${bonus} pts · ${moraleBand(morale)}`;
    },
  },
  {
    id:   'maintenanceTeam',
    name: 'Maintenance Team',
    emoji: '🔩',
    description: 'Engineers and technicians. Morale multiplies all maintenance costs. Unhappy mechanics cost more. Pay them ≥1.30× (with a ≥1.30× maintenance budget) and they auto-schedule heavy C/D checks as they come due.',
    baseWeeklyPerAircraft: 6_000,
    effectDescription: (morale) => {
      const mult = (1.4 - morale / 200).toFixed(2);
      return `Maintenance ×${mult} · ${moraleBand(morale)}`;
    },
  },
];

function moraleBand(m) {
  if (m >= 90) return 'Excellent';
  if (m >= 70) return 'Good';
  if (m >= 50) return 'Neutral';
  if (m >= 30) return 'Poor';
  return 'Crisis';
}

// ─── Seniority (New World Restrictions worlds only) ──────────────────────────
//
// Every wage above is a STARTING scale. In reality an airline's unit labour cost
// climbs relentlessly as it ages: seniority steps, pensions, union scale. It is
// the classic structural weight of a legacy carrier and the main reason a mature
// airline cannot hold the margins a startup can.
//
// The engine had none of it — `baseWeeklyPerAircraft x fleet.length`, flat, so a
// twenty-year-old major paid a week-old startup's rates. Measured against two
// real airlines in this game, labour ran 9.6% of revenue at maturity against a
// real 25-35%, and it FELL as a share of revenue with scale (23.0% -> 15.7%)
// because yields rise while the wage bill does not.
//
// So the scale itself inflates: +5% per year the airline has existed. The player's
// payMultiplier slider is unchanged and still means "relative to the market rate"
// — the market rate is simply no longer frozen at founding.
//
// CAPPED, and the cap matters. Uncapped 5% is x125 over a 100-year world: not a
// difficulty curve, a countdown, because referencePrice carries no matching fare
// inflation. The cap is also the realistic part — real unit labour cost converges
// rather than compounding forever, as senior crew retire and juniors are hired
// beneath them. A workforce reaches a steady-state seniority mix.
//
//   year  1 -> x1.00     year 10 -> x1.55     year 20 -> x2.50 (cap)
//   year  5 -> x1.22     year 15 -> x1.98     year 30 -> x2.50
export const SENIORITY_ANNUAL_RISE = 0.05;
export const SENIORITY_CAP         = 2.5;   // reached ~year 20

/**
 * Wage-scale multiplier for an airline that has been operating `weeksOperating`
 * weeks. Restricted worlds only — callers pass 1 elsewhere.
 *
 * Keyed off the airline's OWN age, never the world calendar: a player joining a
 * year-17 world founded their airline that morning and must start at x1.00.
 */
export function seniorityMultiplier(weeksOperating) {
  const w = Math.max(0, Math.floor(Number(weeksOperating) || 0));
  const years = w / 52;
  return Math.min(SENIORITY_CAP, Math.pow(1 + SENIORITY_ANNUAL_RISE, years));
}

export const LABOR_GROUP_MAP = Object.fromEntries(LABOR_GROUPS.map(g => [g.id, g]));

// ─── Crew cost scales with the aeroplane ─────────────────────────────────────
//
// `baseWeeklyPerAircraft × fleet.length` charged every airframe the same $58k a
// week, so a Dash 8 carried an A380's crew bill. That is not a rounding error:
// a turboprop's whole weekly revenue is around $49k on the calibration table in
// overhead.js, so the labour line ALONE more than consumed it and regional
// flying could not be made to work at any fare. At the other end a widebody
// paid about half a percent of revenue for its crews.
//
// The four groups scale differently, because they are different jobs:
//
//   pilots         two on the flight deck almost regardless of size, so this
//                  scales LEAST. Widebodies carry augmented crews on long
//                  sectors, hence >1 but nothing like seat-proportional.
//   cabinCrew      roughly one per fifty seats by regulation everywhere, so
//                  this scales almost linearly with the cabin. A freighter has
//                  no cabin at all.
//   groundStaff    turn size: bags, catering trucks, cleaners, loaders.
//                  Freighters are ground-labour HEAVY — palletising and loading
//                  is most of what a freight operation does.
//   maintenanceTeam line and base labour, roughly with airframe size.
//
// Narrow Body is 1.00 by construction, so an airline flying the game's most
// common category sees no change at all. This is a re-shape, not a rise.
//
// Same precedent as LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY in overhead.js —
// including the freighter problem, since all 23 freighters share one category
// and an ATR-72F cannot cost the same to crew as an An-124. They step by
// payload instead.
export const CREW_SCALE_BY_CATEGORY = {
  pilots: {
    'Turboprop': 0.55, 'Regional Jet': 0.70, 'Narrow Body': 1.00,
    'Wide Body':  1.55, 'Double Deck':  1.85, 'Supersonic': 1.60,
  },
  cabinCrew: {
    'Turboprop': 0.30, 'Regional Jet': 0.45, 'Narrow Body': 1.00,
    'Wide Body':  2.60, 'Double Deck':  3.60, 'Supersonic': 1.20,
  },
  groundStaff: {
    'Turboprop': 0.45, 'Regional Jet': 0.60, 'Narrow Body': 1.00,
    'Wide Body':  2.10, 'Double Deck':  2.80, 'Supersonic': 1.10,
  },
  maintenanceTeam: {
    'Turboprop': 0.50, 'Regional Jet': 0.65, 'Narrow Body': 1.00,
    'Wide Body':  2.00, 'Double Deck':  2.70, 'Supersonic': 2.00,
  },
};

/** Freighter crew scale by payload — one category cannot hold a 9t to 250t range. */
export const CREW_SCALE_FREIGHTER = [
  { maxTonnes:  20, pilots: 0.55, cabinCrew: 0, groundStaff: 0.70, maintenanceTeam: 0.55 },
  { maxTonnes:  45, pilots: 0.75, cabinCrew: 0, groundStaff: 1.00, maintenanceTeam: 0.80 },
  { maxTonnes:  80, pilots: 1.00, cabinCrew: 0, groundStaff: 1.50, maintenanceTeam: 1.30 },
  { maxTonnes: 130, pilots: 1.35, cabinCrew: 0, groundStaff: 2.00, maintenanceTeam: 1.90 },
  { maxTonnes: Infinity, pilots: 1.70, cabinCrew: 0, groundStaff: 2.60, maintenanceTeam: 2.50 },
];

/**
 * How many "narrowbody-equivalents" of one labour group an airframe costs.
 * Unknown categories fall back to 1.00 — a new aircraft type is charged the
 * common rate rather than accidentally flying its crews for free.
 */
export function crewScaleFor(groupId, aircraftType) {
  if (!aircraftType) return 1;
  if (aircraftType.freighter) {
    const t = aircraftType.payloadTonnes ?? 0;
    const band = CREW_SCALE_FREIGHTER.find(s => t <= s.maxTonnes);
    return band?.[groupId] ?? 1;
  }
  return CREW_SCALE_BY_CATEGORY[groupId]?.[aircraftType.category] ?? 1;
}

/**
 * The fleet's total scale for one group, in narrowbody-equivalents. This is
 * what replaces `fleet.length` in the weekly labour bill — an all-narrowbody
 * fleet returns exactly its aircraft count, so nothing moves for it.
 */
export function fleetCrewScale(groupId, fleet, typeOf) {
  return (fleet ?? []).reduce((s, a) => s + crewScaleFor(groupId, typeOf(a)), 0);
}

export const DEFAULT_LABOR_STATE = {
  pilots:          { payMultiplier: 1.0, morale: 80 },
  cabinCrew:       { payMultiplier: 1.0, morale: 80 },
  groundStaff:     { payMultiplier: 1.0, morale: 80 },
  maintenanceTeam: { payMultiplier: 1.0, morale: 80 },
};

export const DEFAULT_MAINTENANCE_BUDGET = 1.0;

// ─── Crew pipeline (A7) ───────────────────────────────────────────────────────
// Everything below is INERT unless a world/save sets `crewPipeline: true`.
//
// WHY THIS EXISTS
// ---------------
// Without it, crew is infinitely elastic and instantaneous: the weekly bill is
// `baseWeeklyPerAircraft × fleetCrewScale(...)`, so an airline that takes
// delivery of ten aircraft on Monday pays for ten crews and flies all ten at
// full capability the same week. Headcount was never state — `estimateHeadcount`
// existed only as a display number on the Operations page and had zero engine
// references. Hiring was the one input to an airline that had no lead time.
//
// The pipeline makes crew a resource you plan for:
//   1. Every group has a REQUIREMENT derived from the fleet, in the same
//      narrowbody-equivalents the wage bill already uses (fleetCrewScale) —
//      so the sizing needs no new calibration.
//   2. Hiring enters a PIPELINE with a lead time, not the headcount directly.
//      A pilot needs a type rating and line training; a ramp agent does not.
//   3. Being short degrades the operation before it stops it (see the
//      graduated band below).
//   4. Crew LEAVE, faster when underpaid — so payMultiplier stops being purely
//      "cost vs morale" and becomes your retention rate too.

/** Weeks between hiring a group and them being usable on the line. */
export const CREW_LEAD_WEEKS = {
  pilots: 10,          // type rating + line training
  cabinCrew: 5,        // safety + service training
  groundStaff: 2,      // ramp/check-in induction
  maintenanceTeam: 6,  // type-specific certification
};

/** One-off training/recruitment cost per narrowbody-equivalent crew unit ($). */
export const CREW_TRAINING_COST = {
  pilots: 45_000,
  cabinCrew: 12_000,
  groundStaff: 4_000,
  maintenanceTeam: 18_000,
};

/**
 * Graduated shortfall. Below CREW_SEVERE_SHORTFALL the operation just degrades
 * (on-time rate, and satisfaction through it); at or beyond it, aircraft start
 * going unstaffed and cannot be flown. The soft band is deliberately wide so a
 * player gets a visible warning long before anything is grounded.
 */
export const CREW_SEVERE_SHORTFALL = 0.15;
/** Max on-time penalty from understaffing alone, reached at the severe line. */
export const CREW_MAX_OTP_PENALTY = 0.15;

/** Baseline weekly attrition at market pay (1.0×), as a fraction of headcount. */
export const CREW_ATTRITION_BASE = 0.004;

/** Crew REQUIRED for a group, in narrowbody-equivalents. */
export function crewRequired(groupId, fleet, typeOf) {
  return fleetCrewScale(groupId, fleet, typeOf);
}

/** Crew AVAILABLE now (excludes anyone still in training). */
export function crewAvailable(labor, groupId) {
  return Math.max(0, Number(labor?.[groupId]?.headcount) || 0);
}

/** Crew still in training for a group. */
export function crewInTraining(labor, groupId) {
  return (labor?.[groupId]?.pipeline ?? []).reduce((s, b) => s + (Number(b?.count) || 0), 0);
}

/**
 * Shortfall per group and overall, as a FRACTION of the requirement (0 = fully
 * staffed, 1 = nobody). A group needing nobody is never short.
 */
export function crewShortfall(labor, fleet, typeOf) {
  const byGroup = {};
  let worst = 0;
  for (const g of LABOR_GROUPS) {
    const need = crewRequired(g.id, fleet, typeOf);
    const have = crewAvailable(labor, g.id);
    const short = need > 0 ? Math.max(0, (need - have) / need) : 0;
    byGroup[g.id] = short;
    if (short > worst) worst = short;
  }
  return { byGroup, worst, severe: worst >= CREW_SEVERE_SHORTFALL };
}

/**
 * On-time penalty from understaffing, weighted by which groups actually fly the
 * schedule (the same OTP_MORALE_WEIGHTS the morale model uses), ramping to
 * CREW_MAX_OTP_PENALTY at the severe line and holding there.
 */
export function crewOtpPenalty(shortfall) {
  if (!shortfall) return 0;
  const w = OTP_MORALE_WEIGHTS;
  const byGroup = shortfall.byGroup ?? {};
  const weighted =
      (byGroup.pilots      ?? 0) * w.pilots
    + (byGroup.groundStaff ?? 0) * w.groundStaff
    + (byGroup.cabinCrew   ?? 0) * w.cabinCrew;
  const ramp = Math.min(1, weighted / CREW_SEVERE_SHORTFALL);
  return ramp * CREW_MAX_OTP_PENALTY;
}

/**
 * How many narrowbody-equivalents of the fleet cannot be staffed at all. Only
 * bites past the severe line; below it the operation degrades instead.
 * Driven by the flight-critical groups — a short ramp does not ground a jet.
 */
export function unstaffedCrewScale(labor, fleet, typeOf) {
  let worstGap = 0;
  for (const id of ['pilots', 'cabinCrew']) {
    const need = crewRequired(id, fleet, typeOf);
    if (need <= 0) continue;
    const have = crewAvailable(labor, id);
    if ((need - have) / need < CREW_SEVERE_SHORTFALL) continue;
    const gapScale = (need - have) / need;
    if (gapScale > worstGap) worstGap = gapScale;
  }
  return worstGap;
}

/**
 * Weekly attrition rate for a group. Underpaying bleeds people: at 1.0× pay it
 * is the base rate, rising sharply below market and easing above it. Morale
 * (which lags pay) modulates it, so a recent pay cut hurts for several weeks.
 */
export function crewAttritionRate(payMultiplier = 1.0, morale = 80) {
  const pay = Math.max(0.1, Number(payMultiplier) || 1.0);
  const payFactor = Math.max(0.25, Math.min(4, Math.pow(1 / pay, 2.2)));
  const moraleFactor = Math.max(0.5, Math.min(2.5, 1 + (80 - (Number(morale) || 80)) / 60));
  return CREW_ATTRITION_BASE * payFactor * moraleFactor;
}

/** Training cost for hiring `count` narrowbody-equivalents into a group. */
export function crewHireCost(groupId, count) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  return n * (CREW_TRAINING_COST[groupId] ?? 0);
}

/** Fully-staffed labor state for a fleet — used when seeding a new save/world. */
export function seedCrewFor(labor, fleet, typeOf) {
  const next = { ...labor };
  for (const g of LABOR_GROUPS) {
    const need = Math.ceil(crewRequired(g.id, fleet, typeOf));
    next[g.id] = { ...(labor?.[g.id] ?? {}), headcount: need, pipeline: [] };
  }
  return next;
}



// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The morale score a group will converge toward given a pay multiplier.
 * Market rate (1.0×) → 80; premium (1.25×) → 100; below-market (0.7×) → 56.
 */
export function moraleTarget(payMultiplier) {
  return Math.min(100, Math.max(10, Math.round(payMultiplier * 80)));
}

// ─── On-time performance model ────────────────────────────────────────────────

/** Morale weights feeding the on-time rate: pilots fly the schedule,
 *  ground staff turn the aircraft, cabin crew close the doors. */
export const OTP_MORALE_WEIGHTS = { pilots: 0.5, groundStaff: 0.3, cabinCrew: 0.2 };

/** Fleet utilization (fraction of the weekly block-hour cap, averaged across
 *  active aircraft) below which schedules have enough slack to absorb delays. */
export const OTP_UTILIZATION_FREE = 0.6;

/** Max on-time rate penalty when the whole fleet is flown at 100% of the cap. */
export const OTP_UTILIZATION_MAX_PENALTY = 0.12;

/**
 * Schedule-pressure penalty to the on-time rate from average fleet utilization
 * (0–1, fraction of MAX_WEEKLY_BLOCK_HOURS averaged over active aircraft —
 * idle spares count as 0 and act as an operational buffer).
 * Free below OTP_UTILIZATION_FREE, scaling linearly to the max penalty at 1.0.
 */
export function utilizationOnTimePenalty(avgUtilization) {
  if (avgUtilization == null) return 0;
  const over = Math.max(0, Math.min(1, avgUtilization) - OTP_UTILIZATION_FREE);
  return (over / (1 - OTP_UTILIZATION_FREE)) * OTP_UTILIZATION_MAX_PENALTY;
}

/**
 * Derive operational effects from the full labor state object.
 * Used by simulateRoute and weeklyTick.
 *
 * @param {object} labor            - labor state (per-group morale)
 * @param {number|null} avgUtilization - average fleet block-hour utilization
 *   (0–1); null → no schedule-pressure penalty (legacy/preview callers).
 * @param {number|null} satisfaction - persistent passenger-satisfaction stat
 *   (0–100, see deliveredExperience/nextSatisfaction in simulation.js). When
 *   present, customer rating is EARNED from it; when null (old saves,
 *   previews), rating falls back to the legacy cabin-morale mapping.
 */
export function laborEffects(labor, avgUtilization = null, satisfaction = null) {
  // `eventOtpDelta` is a TRANSIENT field the weekly tick attaches to its own
  // copy of the labor object — never persisted, never set by the player. It is
  // how a disruption event reaches the on-time rate.
  //
  // Before this, an event could only move demand: during a volcanic ash cloud
  // an airline ran a flawless schedule to 30% fewer passengers. On-time rate
  // was a pure function of morale and utilisation and did not vary week to
  // week, so the compensation cost line never moved either and the whole
  // irregular-operations texture of the industry — the part passengers
  // actually experience — was a demand scalar.
  const otpDelta = Math.max(0, Number(labor?.eventOtpDelta) || 0);
  // `crewShortfall` is the same kind of TRANSIENT field: the weekly tick attaches
  // the shortfall report to its own copy of the labor object when the crew
  // pipeline is active. Never persisted, never set by the player. Absent (every
  // classic world, every preview caller) → zero, so nothing moves.
  const crewDelta = crewOtpPenalty(labor?.crewShortfall);
  const pilots  = labor?.pilots?.morale          ?? 80;
  const cabin   = labor?.cabinCrew?.morale        ?? 80;
  const ground  = labor?.groundStaff?.morale      ?? 80;
  const maint   = labor?.maintenanceTeam?.morale  ?? 80;
  const w = OTP_MORALE_WEIGHTS;
  const otpMorale = pilots * w.pilots + ground * w.groundStaff + cabin * w.cabinCrew;
  return {
    // 0.55 at zero blended morale → 1.00 at full, minus schedule pressure
    onTimeRate: Math.max(0.35, Math.min(1,
      0.55 + (otpMorale / 100) * 0.45 - utilizationOnTimePenalty(avgUtilization) - otpDelta - crewDelta)),
    // 0–5 stars: earned from the satisfaction track record when available,
    // otherwise (legacy) directly from cabin crew morale
    customerRating:           satisfaction != null
      ? Math.max(0, Math.min(5, (satisfaction / 100) * 5))
      : (cabin / 100) * 5,
    // small ±pts bonus/penalty applied after computeQualityScore
    groundQualityBonus:       (ground - 80) / 10,
    // multiplier on base maintenance cost (high morale = cheaper)
    maintenanceCostMultiplier: 1.4 - maint / 200,
  };
}

/**
 * Color to use for a morale value.
 */
export function moraleColor(morale) {
  if (morale >= 70) return 'var(--green)';
  if (morale >= 45) return 'var(--yellow)';
  return 'var(--red)';
}
