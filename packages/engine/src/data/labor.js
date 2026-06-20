/**
 * labor.js — Employee group definitions and morale model.
 *
 * Four groups each have a pay multiplier (controlled by the player) and a
 * morale score (computed each week as a lagged response to pay vs. market).
 *
 * Pay effects:
 *   pilots         → onTimeRate in qualityScore (affects demand)
 *   cabinCrew      → customerRating in qualityScore (affects demand)
 *   groundStaff    → small quality-score bonus/penalty
 *   maintenanceTeam → maintenance cost multiplier
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
    description: 'Fixed pilot overhead (base pay, training, standby). Variable flight duty pay is charged separately via Crew Operating Costs.',
    baseWeeklyPerAircraft: 26_000,
    effectDescription: (morale) =>
      `On-time rate ${((0.55 + morale / 100 * 0.45) * 100).toFixed(0)}% · ${moraleBand(morale)}`,
  },
  {
    id:   'cabinCrew',
    name: 'Cabin Crew',
    emoji: '🛎️',
    // NOTE: same split as pilots — variable flight costs are in crewCostPerKm.
    // This covers fixed overhead: base pay guarantees, training, uniforms, scheduling.
    description: 'Fixed cabin crew overhead (base pay, training, uniforms). Variable flight duty pay is charged separately via Crew Operating Costs.',
    baseWeeklyPerAircraft: 6_500,
    effectDescription: (morale) =>
      `Customer rating ${(morale / 100 * 5).toFixed(1)} / 5 · ${moraleBand(morale)}`,
  },
  {
    id:   'groundStaff',
    name: 'Ground Staff',
    emoji: '🔧',
    description: 'Check-in, boarding and ramp agents. Morale adds a small bonus or penalty to your overall quality score.',
    baseWeeklyPerAircraft: 3_000,
    effectDescription: (morale) => {
      const bonus = ((morale - 80) / 10).toFixed(1);
      return `Quality score ${bonus >= 0 ? '+' : ''}${bonus} pts · ${moraleBand(morale)}`;
    },
  },
  {
    id:   'maintenanceTeam',
    name: 'Maintenance Team',
    emoji: '🔩',
    description: 'Engineers and technicians. Morale multiplies all maintenance costs — unhappy mechanics cost more.',
    baseWeeklyPerAircraft: 4_500,
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

/**
 * Derive operational effects from the full labor state object.
 * Used by simulateRoute and weeklyTick.
 */
export function laborEffects(labor) {
  const pilots  = labor?.pilots?.morale          ?? 80;
  const cabin   = labor?.cabinCrew?.morale        ?? 80;
  const ground  = labor?.groundStaff?.morale      ?? 80;
  const maint   = labor?.maintenanceTeam?.morale  ?? 80;
  return {
    // 0.55 at zero morale → 1.00 at full morale
    onTimeRate:               0.55 + (pilots / 100) * 0.45,
    // 0–5 stars
    customerRating:           (cabin / 100) * 5,
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
