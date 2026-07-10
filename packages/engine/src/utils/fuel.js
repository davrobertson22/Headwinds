/**
 * fuel.js — Fuel price dynamics and hedging model
 *
 * PRICE MODEL
 * ───────────
 * Jet fuel price is modelled as an Ornstein-Uhlenbeck (mean-reverting) process.
 * The index starts at 1.0 and drifts back toward 1.0 over time, with weekly
 * random shocks. Realistic range: 0.55 (cheap surplus) → 1.90 (crisis spike).
 *
 * HEDGING
 * ───────
 * The player can lock in the current market price for a portion of their fleet's
 * fuel consumption for a fixed number of weeks, paying a small premium for the
 * certainty. Active contracts insulate that fraction from market moves.
 *
 * effectiveFuelMultiplier = hedgedFraction × lockedPrice
 *                         + (1 − hedgedFraction) × marketIndex
 */

// ── Reference price ───────────────────────────────────────────────────────────

/**
 * Reference (base) jet-fuel price in $ per litre, at index 1.0.
 * This is the single world-fuel knob: change it once to make fuel globally
 * cheaper/dearer. The market index below is a dimensionless multiplier on top
 * of it, so the price an airline actually pays is FUEL_PRICE_PER_LITRE × index.
 *
 * Each aircraft stores its own physical burn (litres/100km), independent of
 * this price. Effective $/km for a type = (burnPer100km / 100) × pricePerLitre.
 */
export const FUEL_PRICE_PER_LITRE = 1.20;

/**
 * Market fuel price ($/litre) for a given index (defaults to base, index 1.0).
 */
export function fuelPricePerLitre(index = 1.0) {
  return parseFloat((FUEL_PRICE_PER_LITRE * index).toFixed(4));
}

/**
 * Effective fuel cost per km ($) for an aircraft type at base price (index 1.0).
 * Burn is the stable physical property; multiply by the live market multiplier
 * at the call site to get the real per-km cost.
 *
 * @param {object} type   - aircraft type with fuelBurnPer100km (litres/100km)
 * @returns {number}      - $ per km at base fuel price
 */
export function fuelCostPerKm(type) {
  return ((type?.fuelBurnPer100km ?? 0) / 100) * FUEL_PRICE_PER_LITRE;
}

// ── Price model constants ─────────────────────────────────────────────────────

export const FUEL_BASE_INDEX    = 1.00;   // long-run equilibrium multiplier
export const FUEL_MIN_INDEX     = 0.55;   // floor (cheap-oil scenario)
export const FUEL_MAX_INDEX     = 1.90;   // ceiling (crisis spike)
export const FUEL_MEAN_REVERSION = 0.06;  // θ: weekly pull toward base (higher = faster)
export const FUEL_VOLATILITY     = 0.04;  // σ: weekly random shock magnitude

// ── Hedge contract options ────────────────────────────────────────────────────

/**
 * Duration options the player can choose when buying a hedge.
 * premium: fraction added on top of the current market index to compute lockedPrice.
 * A shorter hedge is cheaper because the airline bears less counter-party risk.
 */
export const HEDGE_DURATIONS = [
  { id: 'short',  label: '8-week',  weeks:  8, premium: 0.03 },
  { id: 'medium', label: '13-week', weeks: 13, premium: 0.06 },
  { id: 'long',   label: '26-week', weeks: 26, premium: 0.10 },
];

/**
 * Coverage options: what fraction of the fleet's total fuel bill is hedged.
 * Stacking multiple contracts is allowed; total is capped at 100%.
 */
export const HEDGE_COVERAGES = [0.25, 0.50, 0.75];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Advance the fuel price index by one week.
 * Uses an Ornstein-Uhlenbeck process: drift toward mean + random shock.
 *
 * @param {number} currentIndex   - this week's market price index
 * @param {number} [rand]         - optional random value in [0,1] (for seeding/testing)
 * @returns {number}              - next week's index, clamped to [MIN, MAX]
 */
export function tickFuelPrice(currentIndex, rand = Math.random()) {
  const drift = FUEL_MEAN_REVERSION * (FUEL_BASE_INDEX - currentIndex);
  // Map uniform [0,1] → approximately Normal via Box-Muller lite (single draw)
  const shock = (rand * 2 - 1) * FUEL_VOLATILITY * 2.5;
  const next  = currentIndex + drift + shock;
  return parseFloat(Math.max(FUEL_MIN_INDEX, Math.min(FUEL_MAX_INDEX, next)).toFixed(3));
}

/**
 * Compute the effective fuel cost multiplier after applying active hedge contracts.
 *
 * Hedged fraction uses the locked-in price; unhedged fraction uses market price.
 * Multiple contracts stack (coverage is summed, capped at 1.0).
 *
 * @param {number} marketIndex    - current market fuel price index
 * @param {Array}  activeHedges   - hedge contracts active this week
 * @returns {number}              - effective multiplier to apply to base fuelCostPerKm
 */
export function effectiveFuelMultiplier(marketIndex, activeHedges = []) {
  if (!activeHedges.length) return marketIndex;

  // rawCoverage may exceed 1.0 when multiple contracts are stacked.
  // Use it as the denominator for the weighted average so each contract's
  // contribution is normalised correctly, then cap effective coverage at 1.0.
  const rawCoverage   = activeHedges.reduce((s, h) => s + h.coverage, 0);
  const totalCoverage = Math.min(1.0, rawCoverage);
  if (rawCoverage <= 0) return marketIndex;

  // Coverage-weighted average of locked prices (normalised over raw sum)
  const weightedLocked = activeHedges.reduce((s, h) => s + h.coverage * h.lockedPrice, 0)
    / rawCoverage;

  return parseFloat(
    ((1 - totalCoverage) * marketIndex + totalCoverage * weightedLocked).toFixed(4)
  );
}

/**
 * Locked-in price for a new hedge contract.
 * = current market index × (1 + duration premium).
 *
 * @param {number} marketIndex   - current fuel price index at time of purchase
 * @param {object} durationOpt   - one entry from HEDGE_DURATIONS
 * @returns {number}
 */
export function hedgeLockedPrice(marketIndex, durationOpt) {
  return parseFloat((marketIndex * (1 + durationOpt.premium)).toFixed(3));
}

/**
 * How much of the fleet's fuel bill is currently hedged (0–1).
 * Useful for showing the player their exposure.
 *
 * @param {Array} activeHedges
 * @returns {number}
 */
export function totalHedgedCoverage(activeHedges = []) {
  return Math.min(1.0, activeHedges.reduce((s, h) => s + h.coverage, 0));
}

// ── Display helpers ───────────────────────────────────────────────────────────

/**
 * Human-readable label + colour for a given fuel index.
 */
export function fuelIndexStatus(index) {
  if (index < 0.72) return { label: 'Very Low',  color: '#38d39f', bg: '#1a3b1e' };
  if (index < 0.88) return { label: 'Low',        color: '#6bc46d', bg: '#1e3a20' };
  if (index < 1.12) return { label: 'Normal',     color: '#ffb43d', bg: '#3b2e0a' };
  if (index < 1.32) return { label: 'High',       color: '#f0883e', bg: '#3b2010' };
  if (index < 1.58) return { label: 'Very High',  color: '#ff5d6c', bg: '#3b1010' };
  return             { label: 'Crisis',    color: '#ff7b72', bg: '#4a0e0e' };
}

/**
 * Convert a fuel index to a percentage change vs baseline (1.0).
 * e.g. 1.25 → "+25%"
 */
export function fuelIndexDelta(index) {
  const pct = Math.round((index - 1.0) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * Absolute week number from game year + week.
 * Used for hedge expiry comparisons.
 */
export function absoluteWeek(year, week) {
  return (year - 1) * 52 + week;
}
