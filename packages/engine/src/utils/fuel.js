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
export const FUEL_PRICE_PER_LITRE = 1.45;

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
export function tickFuelPrice(currentIndex, rand = Math.random(), meanIndex = FUEL_BASE_INDEX, minIndex = FUEL_MIN_INDEX) {
  // Era worlds pass a historical meanIndex (data/era.js eraFuelMean) so the
  // walk reverts to the period's price level — the 1973 shock is a moving
  // target, not a scripted value — and a wider minIndex floor so the cheap
  // decades are actually cheap. Defaults keep classic worlds byte-identical.
  const drift = FUEL_MEAN_REVERSION * (meanIndex - currentIndex);
  // Map uniform [0,1] → approximately Normal via Box-Muller lite (single draw)
  const shock = (rand * 2 - 1) * FUEL_VOLATILITY * 2.5;
  return clampFuelIndex(currentIndex + drift + shock, minIndex);
}

/** Hold an index inside the model's realistic band. */
export function clampFuelIndex(index, minIndex = FUEL_MIN_INDEX) {
  return parseFloat(Math.max(minIndex, Math.min(FUEL_MAX_INDEX, index)).toFixed(3));
}

/**
 * Expected AVERAGE index over the next `weeks`, given today's spot.
 *
 * The walk is mean-reverting, so today's price is not the best guess for the
 * next six months — the pull toward 1.0 is. For the discrete process in
 * tickFuelPrice, E[x_t] = μ + (spot − μ)(1 − θ)^t, and averaging t = 1..T gives
 * the decay factor below. At θ = 0.06 a 26-week horizon retains only ~48% of
 * today's deviation from the mean; an 8-week horizon retains ~76%.
 *
 * This is what a fuel forward curve is, and it is the number a hedge has to be
 * priced against — see hedgeLockedPrice.
 */
export function expectedMeanIndex(spot, weeks, theta = FUEL_MEAN_REVERSION, base = FUEL_BASE_INDEX) {
  if (!(weeks > 0)) return spot;
  const k = 1 - theta;
  // Σ k^t for t = 1..T, divided by T.
  const decay = (k * (1 - Math.pow(k, weeks))) / (theta * weeks);
  return base + (spot - base) * decay;
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

  // Only real fractions get a vote.
  //
  // The reducer now refuses a BUY_HEDGE whose coverage is not in (0, 1], but a
  // world that was exploited before that landed still carries the poisoned
  // contracts in its saved blob — and this function is where they cash out. A
  // signed sum let a pair of contracts at -1000 and +1000.1 slip past the
  // `rawCoverage <= 0` guard below and return -68.997, i.e. a large NEGATIVE
  // fuel bill on every route, every week. Sanitising here means such a blob
  // heals itself on the next tick instead of minting money until someone
  // notices.
  const hedges = (activeHedges ?? []).filter((h) => {
    const c = Number(h?.coverage);
    return Number.isFinite(c) && c > 0 && Number.isFinite(Number(h?.lockedPrice));
  }).map((h) => ({ ...h, coverage: Math.min(1, Number(h.coverage)) }));
  if (!hedges.length) return marketIndex;

  // rawCoverage may exceed 1.0 when multiple contracts are stacked.
  // Use it as the denominator for the weighted average so each contract's
  // contribution is normalised correctly, then cap effective coverage at 1.0.
  const rawCoverage   = hedges.reduce((s, h) => s + h.coverage, 0);
  const totalCoverage = Math.min(1.0, rawCoverage);
  if (rawCoverage <= 0) return marketIndex;

  // Coverage-weighted average of locked prices (normalised over raw sum)
  const weightedLocked = hedges.reduce((s, h) => s + h.coverage * Number(h.lockedPrice), 0)
    / rawCoverage;

  return parseFloat(
    ((1 - totalCoverage) * marketIndex + totalCoverage * weightedLocked).toFixed(4)
  );
}

/**
 * Locked-in price for a new hedge contract.
 * = EXPECTED average index over the term × (1 + duration premium).
 *
 * This used to be spot × (1 + premium), which made hedging a solved arbitrage
 * rather than a risk decision. The walk mean-reverts to 1.0 in public view, so
 * at an index of 0.75 a 26-week lock cost 0.825 against an expected average of
 * ~0.88 — free money, every time, with no judgement involved. Above 1.0 the
 * same arithmetic ran the other way and hedging was never worth doing. The
 * dominant strategy was "hedge to the cap whenever fuel is cheap, otherwise
 * never", which is not a decision.
 *
 * Pricing off the expected path instead means the premium is what you actually
 * pay for certainty, at any index. It also makes hedging INTO a spike sensible
 * — you lock below today's price because the market is expected to come back
 * down, exactly as a real forward curve in backwardation behaves — and the bet
 * becomes whether reversion is faster or slower than the model expects.
 *
 * @param {number} marketIndex   - current fuel price index at time of purchase
 * @param {object} durationOpt   - one entry from HEDGE_DURATIONS
 * @returns {number}
 */
export function hedgeLockedPrice(marketIndex, durationOpt) {
  const expected = expectedMeanIndex(marketIndex, durationOpt?.weeks ?? 0);
  return parseFloat((expected * (1 + (durationOpt?.premium ?? 0))).toFixed(3));
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
