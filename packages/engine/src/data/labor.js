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
    description: 'Engineers and technicians. Morale multiplies all maintenance costs. Unhappy mechanics cost more.',
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

export const LABOR_GROUP_MAP = Object.fromEntries(LABOR_GROUPS.map(g => [g.id, g]));

export const DEFAULT_LABOR_STATE = {
  pilots:          { payMultiplier: 1.0, morale: 80 },
  cabinCrew:       { payMultiplier: 1.0, morale: 80 },
  groundStaff:     { payMultiplier: 1.0, morale: 80 },
  maintenanceTeam: { payMultiplier: 1.0, morale: 80 },
};

export const DEFAULT_MAINTENANCE_BUDGET = 1.0;

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
  const pilots  = labor?.pilots?.morale          ?? 80;
  const cabin   = labor?.cabinCrew?.morale        ?? 80;
  const ground  = labor?.groundStaff?.morale      ?? 80;
  const maint   = labor?.maintenanceTeam?.morale  ?? 80;
  const w = OTP_MORALE_WEIGHTS;
  const otpMorale = pilots * w.pilots + ground * w.groundStaff + cabin * w.cabinCrew;
  return {
    // 0.55 at zero blended morale → 1.00 at full, minus schedule pressure
    onTimeRate: Math.max(0.35, Math.min(1,
      0.55 + (otpMorale / 100) * 0.45 - utilizationOnTimePenalty(avgUtilization))),
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
