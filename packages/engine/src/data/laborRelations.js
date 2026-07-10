/**
 * laborRelations.js — union unrest, strikes, and contract negotiations.
 *
 * Two mechanics layered on top of the per-group morale model in labor.js:
 *
 * 1. STRIKES — each group accumulates "unrest" while its morale sits below 50.
 *    Once unrest crosses UNREST_STRIKE_THRESHOLD the group may walk out: a
 *    strike cancels a share of the week's flights (STRIKE_SEVERITY, applied as
 *    a revenue line-item loss in the weekly tick) for 1–2 weeks. The player
 *    can end a strike immediately by settling (SETTLE_STRIKE: a 15% raise).
 *
 * 2. CONTRACT NEGOTIATIONS — every ~2–3 game years each group's union tables
 *    a pay demand. The player has NEGOTIATION_RESPONSE_WEEKS to respond:
 *      accept  → pay jumps to the demand, morale +8, unrest −40
 *      counter → pay set to the midpoint; union accepts (morale +4) or,
 *                if relations are sour, takes the raise but stays angry
 *                (morale −6, unrest +25, next talks come sooner)
 *      refuse  → morale −10, unrest +30 (strike territory if morale is low)
 *    Ignoring the demand until it expires counts as refusing.
 *
 * All state lives in state.laborRelations; the pure helpers here are consumed
 * by the ADVANCE_WEEK / RESOLVE_NEGOTIATION / SETTLE_STRIKE reducer cases.
 */

import { LABOR_GROUPS } from './labor.js';

export const DEFAULT_LABOR_RELATIONS = {
  // 0–100 per group. Builds while morale < 50, decays otherwise.
  unrest: { pilots: 0, cabinCrew: 0, groundStaff: 0, maintenanceTeam: 0 },
  // Active walkout: { group, weeksLeft, totalWeeks, severity } | null
  strike: null,
  // Open pay demand: { group, demandMultiplier, weeksLeft, totalWeeks } | null
  negotiation: null,
  // Per-group absolute week when the union next tables a demand.
  // null on old saves — initialized lazily on the first tick.
  nextNegotiationAbsWeek: null,
  // No new strike can begin before this absolute week (post-strike truce).
  strikeCooldownUntilAbsWeek: 0,
};

// ─── Strikes ──────────────────────────────────────────────────────────────────

/** Share of the week's flights cancelled while each group is on strike. */
export const STRIKE_SEVERITY = {
  pilots:          0.55,  // aircraft don't move without flight crews
  cabinCrew:       0.30,  // minimum-crew rules ground many departures
  groundStaff:     0.25,  // turnarounds collapse at struck stations
  maintenanceTeam: 0.15,  // airworthiness sign-offs lapse, spares pile up
};

/** Unrest level a group must reach before a walkout becomes possible. */
export const UNREST_STRIKE_THRESHOLD = 60;

/** Weeks of industrial truce after a strike ends (no new walkouts). */
export const STRIKE_COOLDOWN_WEEKS = 26;

/**
 * Advance each group's unrest one week from its current morale.
 * Below 50 morale unrest builds (faster the deeper it is); at or above 50 it
 * decays. A rejected/ignored negotiation adds bumps elsewhere (reducer).
 */
export function tickUnrest(labor, unrest) {
  const next = {};
  for (const g of LABOR_GROUPS) {
    const morale = labor?.[g.id]?.morale ?? 80;
    const u      = unrest?.[g.id] ?? 0;
    const v = morale < 50
      ? u + (50 - morale) * 0.5          // morale 30 → +10/wk, morale 10 → +20/wk
      : u * 0.9 - 1.5;                   // recovery once pay is fixed
    next[g.id] = Math.max(0, Math.min(100, Math.round(v * 10) / 10));
  }
  return next;
}

/** Weekly walkout probability at a given unrest level (0 below threshold). */
export function strikeProbability(unrest) {
  if (unrest < UNREST_STRIKE_THRESHOLD) return 0;
  return (unrest - (UNREST_STRIKE_THRESHOLD - 5)) / 120; // ~4% at 60 → ~37% at 100
}

/** Qualitative label + color for a group's unrest level (UI). */
export function unrestBand(unrest) {
  if (unrest >= UNREST_STRIKE_THRESHOLD) {
    return { label: 'Strike ballot passed', color: 'var(--red)' };
  }
  if (unrest >= 35) return { label: 'Militant',  color: 'var(--red)' };
  if (unrest >= 15) return { label: 'Restless',  color: 'var(--yellow)' };
  return              { label: 'Calm',           color: 'var(--green)' };
}

/**
 * Roll for a new walkout. Only the angriest eligible group rolls (one strike
 * at a time). Returns a new strike object or null.
 */
export function rollStrike(unrest, absWeek, cooldownUntilAbsWeek, rng = Math.random) {
  if (absWeek < (cooldownUntilAbsWeek ?? 0)) return null;
  let worst = null;
  for (const g of LABOR_GROUPS) {
    const u = unrest?.[g.id] ?? 0;
    if (u >= UNREST_STRIKE_THRESHOLD && (!worst || u > worst.u)) worst = { id: g.id, u };
  }
  if (!worst) return null;
  if (rng() >= strikeProbability(worst.u)) return null;
  const weeks = rng() < 0.5 ? 1 : 2;
  return {
    group:      worst.id,
    weeksLeft:  weeks,
    totalWeeks: weeks,
    severity:   STRIKE_SEVERITY[worst.id] ?? 0.25,
  };
}

/** Pay multiplier after capitulating to end a strike early (15% raise). */
export function settlementPayMultiplier(payMultiplier) {
  return Math.min(2.0, Math.round(payMultiplier * 1.15 * 20) / 20);
}

// ─── Contract negotiations ────────────────────────────────────────────────────

/** Weeks the player has to answer a tabled pay demand before it lapses. */
export const NEGOTIATION_RESPONSE_WEEKS = 4;

/** First demand lands 1¼–2½ game years in (staggered per group). */
export function scheduleFirstNegotiations(absWeek, rng = Math.random) {
  const out = {};
  for (const g of LABOR_GROUPS) {
    out[g.id] = absWeek + 65 + Math.floor(rng() * 66); // +65–130 wks
  }
  return out;
}

/**
 * When the union comes back after a resolved negotiation.
 * Soured talks (rejected counter / refusal) return ~1 year; clean deals ~2–3.
 */
export function scheduleNextNegotiation(absWeek, soured, rng = Math.random) {
  return soured
    ? absWeek + 39  + Math.floor(rng() * 27)   // 39–65 wks
    : absWeek + 104 + Math.floor(rng() * 53);  // 104–156 wks
}

/**
 * The pay multiplier the union demands.
 * Paying below market → they demand a return to ~market rate.
 * Otherwise → a 10–18% raise, +5% more if the airline just had a good year.
 */
export function negotiationDemand(payMultiplier, profitable, rng = Math.random) {
  let demand;
  if (payMultiplier < 0.95) {
    demand = Math.min(1.05, payMultiplier * (1.25 + rng() * 0.10));
  } else {
    demand = payMultiplier * (1 + 0.10 + rng() * 0.08 + (profitable ? 0.05 : 0));
  }
  demand = Math.min(2.0, Math.round(demand * 20) / 20);
  if (demand <= payMultiplier) demand = Math.min(2.0, payMultiplier + 0.05);
  return demand;
}

/** Midpoint counter-offer, rounded to the pay slider's 0.05 steps. */
export function counterOfferMultiplier(payMultiplier, demandMultiplier) {
  const mid = (payMultiplier + demandMultiplier) / 2;
  return Math.min(2.0, Math.round(mid * 20) / 20);
}

/** Whether the union accepts a counter-offer (better relations → more likely). */
export function counterAccepted(morale, rng = Math.random) {
  const p = 0.25 + (morale / 100) * 0.6; // morale 80 → 73%, morale 30 → 43%
  return rng() < p;
}

/** Morale / unrest deltas for each negotiation outcome (applied in reducer). */
export const NEGOTIATION_EFFECTS = {
  accept:          { morale: +8,  unrest: -40 },
  counterAccepted: { morale: +4,  unrest: -25 },
  counterRejected: { morale: -6,  unrest: +25 },
  refuse:          { morale: -10, unrest: +30 },
};
