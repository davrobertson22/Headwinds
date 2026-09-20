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
 * premium: fraction added on top of the EXPECTED average index over the term
 * (see hedgeLockedPrice) to compute lockedPrice. A longer hedge costs more
 * because the desk carries more counter-party and model risk.
 *
 * Repriced 2026-09 (FUEL_OPERATIONS_PLAN.md §4). The old 3/6/10% premiums
 * were roughly 60% of a one-sigma move of the stationary walk (σ ≈ 0.17), so
 * a 26-week lock at spot 1.38 cost ~1.30 against an expected ~1.18: a coin
 * toss you paid 10% to enter. Nobody hedged (Heavy Landing, Sep 2026: zero
 * contracts across the top eight airlines through a 30-week 1.25×+ stretch).
 * The 52-week product exists because that stretch outlasted the longest
 * contract on offer.
 */
export const HEDGE_DURATIONS = [
  { id: 'short',  label: '8-week',  weeks:  8, premium: 0.015 },
  { id: 'medium', label: '13-week', weeks: 13, premium: 0.025 },
  { id: 'long',   label: '26-week', weeks: 26, premium: 0.04  },
  { id: 'year',   label: '52-week', weeks: 52, premium: 0.06  },
];

/**
 * Fraction of the remaining notional the desk keeps when a contract is
 * unwound early (hedgeUnwindQuote). Buying and immediately unwinding costs
 * exactly premium + haircut, so the round trip is lossy by construction.
 */
export const UNWIND_HAIRCUT = 0.015;

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

  const { hedges, rawCoverage, totalCoverage } = hedgeWeights(activeHedges);
  if (!hedges.length || rawCoverage <= 0) return marketIndex;

  // Coverage-weighted average of locked prices (normalised over raw sum)
  const weightedLocked = hedges.reduce((s, h) => s + h.coverage * Number(h.lockedPrice), 0)
    / rawCoverage;

  return parseFloat(
    ((1 - totalCoverage) * marketIndex + totalCoverage * weightedLocked).toFixed(4)
  );
}

/**
 * The sanitised contract list and the coverage normalisation every hedge
 * calculation shares — the blended multiplier, the weekly realized savings
 * and the unwind quote. One place, so the three can never disagree about how
 * much of the bill a contract covers.
 *
 * Only real fractions get a vote. The reducer refuses a BUY_HEDGE whose
 * coverage is not in (0, 1], but a world that was exploited before that
 * landed still carries the poisoned contracts in its saved blob — and this is
 * where they cash out. A signed sum let a pair of contracts at -1000 and
 * +1000.1 slip past a `rawCoverage <= 0` guard and return -68.997, i.e. a
 * large NEGATIVE fuel bill on every route, every week. Sanitising here means
 * such a blob heals itself on the next tick instead of minting money until
 * someone notices.
 *
 * rawCoverage may exceed 1.0 when contracts are stacked; totalCoverage is the
 * capped effective coverage. A contract's effective share of the bill is
 * coverage × totalCoverage / rawCoverage (`effOf`).
 */
export function hedgeWeights(activeHedges = []) {
  const hedges = (activeHedges ?? []).filter((h) => {
    const c = Number(h?.coverage);
    return Number.isFinite(c) && c > 0 && Number.isFinite(Number(h?.lockedPrice));
  }).map((h) => ({ ...h, coverage: Math.min(1, Number(h.coverage)) }));
  const rawCoverage   = hedges.reduce((s, h) => s + h.coverage, 0);
  const totalCoverage = Math.min(1.0, rawCoverage);
  const scale = rawCoverage > 0 ? totalCoverage / rawCoverage : 0;
  return {
    hedges, rawCoverage, totalCoverage,
    effOf: (h) => Math.min(1, Math.max(0, Number(h?.coverage) || 0)) * scale,
  };
}

/**
 * What each live contract saved (+) or cost (−) this week, in dollars.
 *
 *   savings_i = baseBill × effCoverage_i × (marketIndex − lockedPrice_i)
 *
 * `baseBill` is the week's fuel spend at 1.0× — the tick's totalFuel divided
 * by the blended multiplier it actually charged, so this is exact, not an
 * estimate. Summed over contracts it equals the difference between the
 * unhedged and the paid bill (the accounting identity the scoreboard test
 * asserts).
 *
 * @returns {Map<string, number>} contract id → savings this week (rounded $)
 */
export function hedgeWeekSavings(activeHedges = [], marketIndex, baseBill) {
  const out = new Map();
  if (!(baseBill > 0) || !Number.isFinite(marketIndex)) return out;
  const { hedges, effOf } = hedgeWeights(activeHedges);
  for (const h of hedges) {
    out.set(h.id, Math.round(baseBill * effOf(h) * (marketIndex - Number(h.lockedPrice))));
  }
  return out;
}

/**
 * Mark-to-market quote for closing a contract before expiry.
 *
 * The desk buys back on the SAME expected-mean curve it sells on, so the
 * unwind value of the remaining term is
 *
 *   notional   = baseBill × effCoverage × weeksRemaining
 *   mtm        = notional × (expectedMeanIndex(spot, weeksRemaining) − lockedPrice)
 *   settlement = mtm − UNWIND_HAIRCUT × notional
 *
 * A contract that is in the money during a spike pays out (settlement > 0);
 * one bought into a glut costs cash to exit. Buy-then-unwind round-trips to
 * exactly −(premium + haircut) × notional: no arbitrage, in either direction.
 *
 * `hedges` is the full live list, so the contract's effective coverage is the
 * same normalised share effectiveFuelMultiplier charges for it.
 *
 * @returns {object|null} null when the contract has no weeks left
 */
export function hedgeUnwindQuote({ contract, marketIndex, curAbsWeek, baseBill, hedges = [] }) {
  if (!contract) return null;
  const remaining = Math.max(0, (Number(contract.expiryAbsWeek) || 0) - (Number(curAbsWeek) || 0));
  if (remaining <= 0) return null;
  const { effOf } = hedgeWeights(hedges.length ? hedges : [contract]);
  const covEff   = effOf(contract);
  const bill     = Math.max(0, Number(baseBill) || 0);
  const notional = bill * covEff * remaining;
  const expected = expectedMeanIndex(marketIndex, remaining);
  const mtm      = notional * (expected - Number(contract.lockedPrice));
  const haircut  = notional * UNWIND_HAIRCUT;
  return {
    remaining,
    covEff,
    baseBill:      Math.round(bill),
    notional:      Math.round(notional),
    expectedIndex: parseFloat(expected.toFixed(4)),
    mtm:           Math.round(mtm),
    haircut:       Math.round(haircut),
    settlement:    Math.round(mtm - haircut),
  };
}

/** A closed contract's line for the record: what it made or lost over its life. */
export function hedgeOutcome(contract, { settlement = 0, closedAbsWeek, reason = 'expired' } = {}) {
  const realized = Math.round(Number(contract?.realizedSavings) || 0);
  return {
    id:            contract?.id,
    durationLabel: contract?.durationLabel ?? null,
    coverage:      contract?.coverage ?? 0,
    lockedPrice:   contract?.lockedPrice ?? null,
    marketAtPurchase: contract?.marketAtPurchase ?? null,
    startAbsWeek:  contract?.startAbsWeek ?? null,
    closedAbsWeek: closedAbsWeek ?? contract?.expiryAbsWeek ?? null,
    reason,                                   // 'expired' | 'unwound'
    realized,                                 // weekly savings accumulated while live
    settlement: Math.round(settlement),       // cash on unwind (0 for expiry)
    total: realized + Math.round(settlement),
  };
}

export const HEDGE_RECENT_KEEP = 5;

/** The empty scoreboard. Absent on saves that never held a contract. */
export function emptyHedgeStats() {
  return { lifetimeSavings: 0, contractsClosed: 0, wins: 0, losses: 0, recent: [] };
}

/** Fold a closed contract's outcome into the lifetime record. Pure. */
export function foldHedgeOutcome(stats, outcome) {
  const s = stats ?? emptyHedgeStats();
  return {
    lifetimeSavings: (s.lifetimeSavings ?? 0) + outcome.total,
    contractsClosed: (s.contractsClosed ?? 0) + 1,
    wins:            (s.wins ?? 0) + (outcome.total > 0 ? 1 : 0),
    losses:          (s.losses ?? 0) + (outcome.total < 0 ? 1 : 0),
    recent:          [...(s.recent ?? []), outcome].slice(-HEDGE_RECENT_KEEP),
  };
}

/**
 * One week of hedge accounting for ADVANCE_WEEK: credit every live contract
 * with this week's savings, and fold the contracts that dropped out of the
 * live list (expired at this tick's prep) into the scoreboard.
 *
 * Returns the contracts to write back and the stats to write back — `stats`
 * is null when nothing closed AND the save had no scoreboard yet, so a save
 * that has never hedged gains no new key (the golden master hashes the whole
 * state; a schema change is not a behaviour change and must not read as one).
 */
export function settleHedgeWeek({ prior = [], active = [], marketIndex, baseBill, stats = null, closedAbsWeek }) {
  const savings = hedgeWeekSavings(active, marketIndex, baseBill);
  const contracts = active.map(h => savings.has(h.id)
    ? { ...h, realizedSavings: Math.round((Number(h.realizedSavings) || 0) + savings.get(h.id)) }
    : h);
  const liveIds = new Set(active.map(h => h.id));
  const closed  = (prior ?? []).filter(h => h && !liveIds.has(h.id));
  let next = stats ?? null;
  for (const h of closed) {
    next = foldHedgeOutcome(next, hedgeOutcome(h, { closedAbsWeek, reason: 'expired' }));
  }
  return { contracts, stats: next, closed };
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
