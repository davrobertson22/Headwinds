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
 *    a pay demand (unless they are already on MAX_PAY_MULTIPLIER, in which case
 *    there is nothing to ask for and the round is quietly rescheduled). The
 *    player has NEGOTIATION_RESPONSE_WEEKS to respond:
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
  // 0–1 per group. Memory of talks that went nowhere — see GRIEVANCE_* below.
  grievance: { pilots: 0, cabinCrew: 0, groundStaff: 0, maintenanceTeam: 0 },
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

/**
 * Highest pay multiplier the player can set (matches the Labor pay slider's
 * max). Nothing in the labor model may demand, counter or settle above it.
 */
export const MAX_PAY_MULTIPLIER = 2.0;

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

// ─── Grievance: the memory of talks that went nowhere ────────────────────────
//
// Refusing a pay demand cost −10 morale and +30 unrest, ONCE. Morale healed
// back to its pay-determined target within a few weeks, and unrest decays
// whenever morale is at or above 50 — so an airline paying 1.25× (where morale
// targets 100) could refuse every demand forever and never see a strike. The
// negotiation system had teeth only against airlines that were already
// underpaying, which are the ones least able to settle. The whole mechanic was
// a free "no" button for anyone doing well.
//
// A grievance is what a union actually carries out of a failed round: not a
// mood that passes, but a position that hardens. It does two things.
//
//   1. It caps morale below what the money alone would buy. You can be the
//      best-paying airline in the world and still have a workforce that does
//      not believe you.
//   2. It slows unrest RECOVERY. This is the half that matters, because it is
//      the decay rule that made serial refusal safe: at full grievance unrest
//      barely falls, so the +30 from the next refusal lands on top of the last
//      one and the strike threshold finally comes into reach.
//
// It is not a trap. Settling clears most of it at once, and it fades slowly on
// its own, so an airline that changes course recovers without being forced into
// a deal it cannot afford.
export const GRIEVANCE_REFUSE          = 0.45;  // per outright refusal
export const GRIEVANCE_COUNTER_REJECTED = 0.20; // talks collapsed, but you did offer
export const GRIEVANCE_SETTLED         = 0.50;  // cleared by a deal
export const GRIEVANCE_WEEKLY_DECAY    = 0.002; // ~10 years to forget on its own
/** Morale points the ceiling drops by at full grievance. */
export const GRIEVANCE_MORALE_PENALTY  = 20;
/**
 * Unrest a fully-grieved union never falls below — a standing dispute.
 *
 * This is the part that actually changes the outcome, and it took a rewrite to
 * see why. Slowing the decay is not enough on its own: contract rounds are
 * roughly a year apart, and even a badly slowed +30 has faded to nothing over
 * fifty-two weeks. So a refusal has to leave a LEVEL, not just a slower fall.
 *
 * Played out at 1.25× pay — the case the old model could not touch at all —
 * with contract rounds a year apart:
 *
 *   refuse once   grievance 0.45, unrest settles near 20  "Restless"
 *   refuse twice  grievance 0.80, unrest settles near 36  "Militant"
 *   refuse a third time  36 + 30 = 66, past the strike threshold of 60
 *
 * Which is the point: refusing once is free, refusing as a policy is not. The
 * floor coefficient is deliberately below the strike threshold, so a grievance
 * on its own is never a walkout — it always takes a fresh refusal on top.
 */
export const GRIEVANCE_UNREST_FLOOR    = 45;

/** The unrest level a group will not fall below at a given grievance. */
export function unrestFloor(grievance = 0) {
  const g = Math.max(0, Math.min(1, Number(grievance) || 0));
  return Math.round(GRIEVANCE_UNREST_FLOOR * g * 10) / 10;
}

/** Grievance-adjusted morale ceiling for a group. */
export function grievedMoraleTarget(baseTarget, grievance = 0) {
  const g = Math.max(0, Math.min(1, Number(grievance) || 0));
  return Math.max(10, Math.round(baseTarget - GRIEVANCE_MORALE_PENALTY * g));
}

/**
 * Advance each group's unrest one week from its current morale.
 * Below 50 morale unrest builds (faster the deeper it is); at or above 50 it
 * decays. A rejected/ignored negotiation adds bumps elsewhere (reducer).
 */
export function tickUnrest(labor, unrest, grievance = null) {
  const next = {};
  for (const g of LABOR_GROUPS) {
    const morale = labor?.[g.id]?.morale ?? 80;
    const u      = unrest?.[g.id] ?? 0;
    const gr     = Math.max(0, Math.min(1, Number(grievance?.[g.id]) || 0));
    // Grievance slows RECOVERY, it does not add anger of its own. A union that
    // has been refused twice does not calm down between rounds, so the next
    // refusal's +30 stacks instead of replacing what has already faded — which
    // is the only way serial refusal ever reaches the strike threshold.
    const v = morale < 50
      ? u + (50 - morale) * 0.5                    // morale 30 → +10/wk, morale 10 → +20/wk
      : u * (0.9 + 0.08 * gr) - 1.5 * (1 - gr);    // recovery, resisted by grievance
    // ...but never below the standing dispute the grievance represents.
    next[g.id] = Math.max(unrestFloor(gr), Math.min(100, Math.round(v * 10) / 10));
  }
  return next;
}

/** One week of grievance fading on its own. */
export function tickGrievance(grievance) {
  const next = {};
  for (const g of LABOR_GROUPS) {
    const cur = Math.max(0, Math.min(1, Number(grievance?.[g.id]) || 0));
    next[g.id] = Math.round(Math.max(0, cur - GRIEVANCE_WEEKLY_DECAY) * 1000) / 1000;
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
  return Math.min(MAX_PAY_MULTIPLIER, Math.round(payMultiplier * 1.15 * 20) / 20);
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
 * The pay multiplier the union demands, or `null` when it has nothing to ask
 * for. Paying below market → they demand a return to ~market rate. Otherwise
 * → a 10–18% raise, +5% more if the airline just had a good year.
 *
 * A group already on MAX_PAY_MULTIPLIER is at the top of the pay slider, so a
 * demand could only ever be the rate the player is already paying. That made
 * for a nonsense round of talks: accepting cost nothing, countering offered
 * the union its own number (and could still be "rejected"), and refusing was
 * punished for declining to hand over nothing. Return null instead — callers
 * push the next round out rather than tabling a no-op demand.
 */
export function negotiationDemand(payMultiplier, profitable, rng = Math.random) {
  if (payMultiplier >= MAX_PAY_MULTIPLIER - 1e-9) return null;
  let demand;
  if (payMultiplier < 0.95) {
    demand = Math.min(1.05, payMultiplier * (1.25 + rng() * 0.10));
  } else {
    demand = payMultiplier * (1 + 0.10 + rng() * 0.08 + (profitable ? 0.05 : 0));
  }
  demand = Math.min(MAX_PAY_MULTIPLIER, Math.round(demand * 20) / 20);
  // Rounding down can land the demand on current pay — nudge it one slider
  // step. The ceiling guard above means there is always a step to take.
  if (demand <= payMultiplier) {
    demand = Math.min(MAX_PAY_MULTIPLIER, Math.round((payMultiplier + 0.05) * 20) / 20);
  }
  return demand;
}

/**
 * Midpoint counter-offer, rounded to the pay slider's 0.05 steps. Note this
 * can round UP to the full demand (1.95× vs a 2.00× demand); the reducer
 * treats that as an outright accept rather than a counter the union could
 * reject — see counterMeetsDemand().
 */
export function counterOfferMultiplier(payMultiplier, demandMultiplier) {
  const mid = (payMultiplier + demandMultiplier) / 2;
  return Math.min(MAX_PAY_MULTIPLIER, Math.round(mid * 20) / 20);
}

/** True when a counter lands at or above the demand — i.e. it isn't a counter. */
export function counterMeetsDemand(payMultiplier, demandMultiplier) {
  return counterOfferMultiplier(payMultiplier, demandMultiplier) >= demandMultiplier - 1e-9;
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
