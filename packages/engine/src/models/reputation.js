// ─────────────────────────────────────────────────────────────────────────────
// REPUTATION MODEL
//
// Pure reputation scoring, shared by the engine (weeklyTick) and the
// Reputation UI. Historically this lived in Reputation.jsx and was
// display-only — the "demand multiplier" and "elasticity reduction" the page
// showed never touched the simulation. Now they do:
//
//   • reputationDemandMultiplier  → multiplies passenger route revenue
//   • reputationElasticityReduction → feeds the player offer's
//     priceSensitivityReduction (together with the loyalty program's), which
//     computeUtility/_monopolyResult in demand.js honor.
//
// NOTE: the loyalty reputation bonus is passed IN (callers compute it via
// loyaltyReputationBonus(loyaltyPenetration(...)) from simulation.js) to keep
// this module free of an import cycle with simulation.js.
// ─────────────────────────────────────────────────────────────────────────────

import { laborEffects } from '../data/labor.js';
import { computeQualityScore, cabinQualityPoints } from './demand.js';

const QUALITY_SCORE = { basic: 15, standard: 45, premium: 72, luxury: 100 };

/**
 * Overall reputation score (0–100) plus component scores.
 * @param {object} state       – game state (fleet, routes, financialHistory, labor, hub, …)
 * @param {number} loyaltyBonus – 0–8 bonus from a mature loyalty program
 * @param {number|null} avgUtilization – average fleet block-hour utilization (0–1),
 *   passed IN (like loyaltyBonus) to avoid an import cycle with simulation.js;
 *   callers compute it via fleetAvgUtilization(fleet, routes). Feeds the
 *   on-time rate's schedule-pressure penalty.
 */
export function calcReputation(state, loyaltyBonus = 0, avgUtilization = null) {
  const { fleet = [], routes = [], financialHistory = [], labor } = state;
  const effects = laborEffects(labor, avgUtilization, state.satisfaction ?? null);

  // ── Service score (35%) ────────────────────────────────────────────────────
  // Based on average cabin quality of assigned aircraft, filtered through morale
  const assignedFleet = fleet.filter(a => routes.some(r => r.aircraftId === a.id));
  const serviceBase = assignedFleet.length > 0
    ? assignedFleet.reduce((s, a) => {
        const seatQ = QUALITY_SCORE[a.config?.seatQuality  ?? 'standard'] ?? 45;
        const servQ = QUALITY_SCORE[a.config?.serviceQuality ?? 'standard'] ?? 45;
        return s + (seatQ + servQ) / 2;
      }, 0) / assignedFleet.length
    : 45;

  // Cabin crew morale boosts/hurts service delivery
  const cabinMorale = labor?.cabinCrew?.morale ?? 80;
  const serviceScore = Math.round(Math.min(100, serviceBase * (cabinMorale / 80)));

  // ── Fleet freshness score (20%) ────────────────────────────────────────────
  const avgAgeYears = fleet.length > 0
    ? fleet.reduce((s, a) => s + (a.ageWeeks ?? 0) / 52, 0) / fleet.length
    : 0;
  const fleetScore = Math.round(Math.max(0, 100 - avgAgeYears * 5));

  // ── Network score (20%) ────────────────────────────────────────────────────
  const airports  = new Set(routes.flatMap(r => [r.origin, r.destination]));
  const hubRoutes = routes.filter(r => r.origin === state.hub || r.destination === state.hub);
  const rawNet = airports.size * 4 + routes.length * 2 + hubRoutes.length * 3;
  const networkScore = Math.round(Math.min(100, rawNet));

  // ── Employee morale score (25%) ────────────────────────────────────────────
  const morales    = Object.values(labor ?? {}).map(g => g.morale ?? 80);
  const avgMorale  = morales.length > 0 ? morales.reduce((s, m) => s + m, 0) / morales.length : 80;
  // Financial health bonus/penalty
  const recentProfit = financialHistory.slice(-4).reduce((s, h) => s + (h.profit ?? 0), 0);
  const profitBump   = Math.max(-10, Math.min(10, recentProfit / 200000 * 10));
  const moraleScore  = Math.round(Math.min(100, Math.max(0, avgMorale + profitBump)));

  const penalty = Math.max(0, state.reputationPenalty ?? 0);
  const overall = Math.max(0, Math.min(100, Math.round(
    serviceScore * 0.35 +
    fleetScore   * 0.20 +
    networkScore * 0.20 +
    moraleScore  * 0.25 +
    loyaltyBonus
  ) - penalty));

  // Quality score as fed into the demand model (mirrors computeQualityScore inputs);
  // cabin points averaged across assigned aircraft — same seat/service points the
  // engine awards per route.
  const avgCabinPoints = assignedFleet.length > 0
    ? assignedFleet.reduce((s, a) => s + cabinQualityPoints(a.config), 0) / assignedFleet.length
    : 0;
  // Ground staff bonus is quality POINTS added after scoring (as the engine
  // does), not stars — adding it to the 0–5 rating inflated this by up to ~11.
  const qualityDemandScore = Math.max(0, Math.min(100, computeQualityScore({
    onTimeRate:     effects.onTimeRate,
    cabinPoints:    avgCabinPoints,
    fleetAgeYears:  avgAgeYears,
    customerRating: effects.customerRating,
  }) + effects.groundQualityBonus));

  return { overall, service: serviceScore, fleet: fleetScore, network: networkScore, morale: moraleScore, qualityDemandScore, avgAgeYears, loyaltyBonus };
}

/**
 * Demand multiplier from reputation, centered at 50: a distrusted brand (0)
 * loses 7.5% of demand, a beloved one (100) gains 7.5%. Deliberately modest —
 * cabin quality already drives market share via qualityScore; this captures
 * the residual brand-trust effect.
 */
export function reputationDemandMultiplier(overall) {
  return 1 + ((overall ?? 50) - 50) / 100 * 0.15;
}

/**
 * Price-sensitivity reduction from reputation, centered at 50 (range −0.10 to
 * +0.10). Trusted brands can hold fares that undercut rivals would otherwise
 * poach; a poor reputation makes your passengers MORE price-driven — cheap
 * fares are the only reason they're aboard.
 */
export function reputationElasticityReduction(overall) {
  return ((overall ?? 50) - 50) / 100 * 0.20;
}
