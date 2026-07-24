/**
 * maintenance.js — Heavy-maintenance (C & D check) model.
 *
 * A & B checks are abstracted into the weekly line-maintenance cost (the
 * maintenanceBudget slider). This module models the two HEAVY checks that take
 * an aircraft out of service:
 *
 *   C check — ~every 4,500 block-hours OR 2 game-years (whichever first)
 *   D check — ~every 24,000 block-hours OR 6 game-years (a D also resets the C clock)
 *
 * Wear (hours flown since the last check) drives both the failure probability
 * and when a check comes due, so a hard-flown airframe wears out sooner than an
 * idle spare. Every value here is a tuning constant — this is the single place
 * to rebalance the system.
 *
 * All functions are PURE (no Date.now / Math.random) so the reducer and the
 * multiplayer tick stay deterministic and replayable.
 */

// ─── Due thresholds (dual trigger — whichever comes first) ────────────────────
export const C_HOURS_DUE = 4_500;
export const C_WEEKS_DUE = 104;      // 2 game-years
export const D_HOURS_DUE = 24_000;
export const D_WEEKS_DUE = 312;      // 6 game-years

// ─── Grace windows (weeks past due before the regulator forces a grounding) ───
export const C_GRACE_WEEKS = 12;
export const D_GRACE_WEEKS = 16;

// ─── "Due soon" advisory window (amber chip / one-off toast) ──────────────────
export const DUE_SOON_WEEKS = 12;
export const DUE_SOON_HOURS = 800;

// ─── Cost (fraction of the airframe's market purchasePrice) ───────────────────
export const C_COST_PCT = 0.01;   // 1%
export const D_COST_PCT = 0.06;   // 6%

// ─── Downtime (weeks out of service) by aircraft category ─────────────────────
const C_DURATION = { 'Turboprop': 1, 'Regional Jet': 1, 'Narrow Body': 1, 'Wide Body': 2, 'Double Deck': 2, 'Supersonic': 2 };
const D_DURATION = { 'Turboprop': 3, 'Regional Jet': 3, 'Narrow Body': 4, 'Wide Body': 5, 'Double Deck': 6, 'Supersonic': 6 };

// ─── Overdue / forced-grounding penalties ─────────────────────────────────────
export const OVERDUE_MAINT_MULT = 1.25;  // weekly line-maintenance surcharge while overdue
export const FORCED_EXTRA_WEEKS = 2;     // extra downtime when the regulator parks it (no slot booked)
export const FORCED_COST_MULT   = 1.5;   // check costs more when forced (rush, no planning)
export const FORCED_REP_HIT     = 2;     // flat reputation hit on a forced grounding

// ─── D-check benefits ─────────────────────────────────────────────────────────
export const D_AGE_CREDIT_MAX_WEEKS = 156;  // a D check knocks up to 3y off EFFECTIVE age (running cost only)

// ─── Valuation modifiers (fleetNAV + SELL_AIRCRAFT) ───────────────────────────
export const NAV_RECENT_D_BONUS   = 0.05;  // +5% if a D check completed recently
export const NAV_DUE_PENALTY      = 0.15;  // −15% if a check is currently due/overdue (kills sell-to-dodge)
export const RECENT_D_WINDOW_WEEKS = 104;

// ─── Scheduling ───────────────────────────────────────────────────────────────
export const MAX_SCHEDULE_AHEAD_WEEKS = 26;

// ─── Reputation hit from a forced grounding (persistent, decays weekly) ───────
export const REP_PENALTY_DECAY = 0.92;  // multiplicative decay per week
export const REP_PENALTY_MAX   = 25;    // cap so repeated forced groundings can't zero reputation forever

/** An aircraft the sim must treat as not flying (no revenue, no accrual, not deployable). */
export function isOutOfService(a) {
  return a?.status === 'grounded' || a?.status === 'maintenance';
}

/** Downtime in weeks for a check on a given aircraft category. */
export function checkDurationWeeks(category, checkType) {
  const table = checkType === 'D' ? D_DURATION : C_DURATION;
  return table[category] ?? (checkType === 'D' ? 4 : 1);
}

/**
 * Cost of a check ($). Scales with airframe value so one formula covers the
 * whole roster. Optional multipliers: engine maintMod, the labor-team maintenance
 * multiplier, a hub line-maintenance discount factor (≤1), and the forced surcharge.
 */
export function checkCost(type, checkType, { maintMod = 1, laborMult = 1, hubFactor = 1, forced = false } = {}) {
  const pct  = checkType === 'D' ? D_COST_PCT : C_COST_PCT;
  const base = (type?.purchasePrice ?? 0) * pct * maintMod * laborMult * hubFactor;
  return Math.round(base * (forced ? FORCED_COST_MULT : 1));
}

/** Effective age (weeks) used ONLY for the running-cost curve — D checks credit it down. */
export function effectiveMaintAgeWeeks(a) {
  return Math.max(0, (a?.ageWeeks ?? 0) - (a?.maintAgeCredit ?? 0));
}

/**
 * Full due picture for an aircraft. `absWeek` is the current absolute game week
 * (used with the stamped cDueAtWeek/dDueAtWeek markers to measure grace).
 */
export function dueInfo(a, type, absWeek) {
  const hoursSinceC = a?.hoursSinceC ?? 0;
  const hoursSinceD = a?.hoursSinceD ?? 0;
  const weeksSinceC = a?.weeksSinceC ?? 0;
  const weeksSinceD = a?.weeksSinceD ?? 0;

  const cDue = hoursSinceC >= C_HOURS_DUE || weeksSinceC >= C_WEEKS_DUE;
  const dDue = hoursSinceD >= D_HOURS_DUE || weeksSinceD >= D_WEEKS_DUE;

  const cOver = (cDue && a?.cDueAtWeek != null) ? Math.max(0, absWeek - a.cDueAtWeek) : 0;
  const dOver = (dDue && a?.dDueAtWeek != null) ? Math.max(0, absWeek - a.dDueAtWeek) : 0;
  const cPastGrace = cDue && cOver > C_GRACE_WEEKS;
  const dPastGrace = dDue && dOver > D_GRACE_WEEKS;

  const cSoon = !cDue && (hoursSinceC >= C_HOURS_DUE - DUE_SOON_HOURS || weeksSinceC >= C_WEEKS_DUE - DUE_SOON_WEEKS);
  const dSoon = !dDue && (hoursSinceD >= D_HOURS_DUE - DUE_SOON_HOURS || weeksSinceD >= D_WEEKS_DUE - DUE_SOON_WEEKS);

  // A D check also satisfies the C clock, so D takes priority when both are due.
  const primaryDue = dDue ? 'D' : (cDue ? 'C' : null);
  const forcedType = dPastGrace ? 'D' : (cPastGrace ? 'C' : null);
  const soonType   = dSoon ? 'D' : (cSoon ? 'C' : null);

  const state = forcedType ? 'overdue' : primaryDue ? 'due' : soonType ? 'soon' : 'ok';

  // Fraction of the way to due (max of hours/weeks progress) for progress bars.
  const cProgress = Math.max(hoursSinceC / C_HOURS_DUE, weeksSinceC / C_WEEKS_DUE);
  const dProgress = Math.max(hoursSinceD / D_HOURS_DUE, weeksSinceD / D_WEEKS_DUE);

  return {
    hoursSinceC, hoursSinceD, weeksSinceC, weeksSinceD,
    cDue, dDue, cPastGrace, dPastGrace, cOver, dOver,
    cSoon, dSoon, primaryDue, forcedType, soonType, state,
    cProgress, dProgress,
    // The single check the player should act on next (D covers C).
    nextCheck: primaryDue ?? soonType ?? (dProgress >= cProgress ? 'D' : 'C'),
  };
}

/**
 * Accrue one week of wear and stamp due markers. Out-of-service airframes fly 0
 * hours (frozen wear) but the calendar clock still advances for everyone.
 */
export function accrueMaintenance(a, weeklyBlockHours, absWeek) {
  const bh = isOutOfService(a) ? 0 : Math.max(0, weeklyBlockHours || 0);
  const next = {
    ...a,
    hoursSinceC: (a.hoursSinceC ?? 0) + bh,
    hoursSinceD: (a.hoursSinceD ?? 0) + bh,
    weeksSinceC: (a.weeksSinceC ?? 0) + 1,
    weeksSinceD: (a.weeksSinceD ?? 0) + 1,
  };
  const cDue = next.hoursSinceC >= C_HOURS_DUE || next.weeksSinceC >= C_WEEKS_DUE;
  const dDue = next.hoursSinceD >= D_HOURS_DUE || next.weeksSinceD >= D_WEEKS_DUE;
  next.cDueAtWeek = cDue ? (a.cDueAtWeek ?? absWeek) : null;
  next.dDueAtWeek = dDue ? (a.dDueAtWeek ?? absWeek) : null;
  return next;
}

/** Put an aircraft into the shop. `forced` adds downtime and clears any booking. */
export function startCheck(a, checkType, durationWeeks, { forced = false } = {}) {
  return {
    ...a,
    status:         'maintenance',
    checkType,
    checkForced:    forced,
    checkWeeksLeft: Math.max(1, durationWeeks + (forced ? FORCED_EXTRA_WEEKS : 0)),
    scheduledCheck: null,
  };
}

/**
 * Finish a check: reset the relevant clocks, apply the D-check age credit, and
 * hand the airframe back to service (assigned if it still has routes, else idle).
 */
export function completeCheck(a, absWeek, hasRoute) {
  const t = a.checkType;
  const next = {
    ...a,
    status:         hasRoute ? 'assigned' : 'idle',
    checkType:      null,
    checkForced:    false,
    checkWeeksLeft: 0,
  };
  if (t === 'C' || t === 'D') {
    next.hoursSinceC = 0; next.weeksSinceC = 0; next.cDueAtWeek = null;
  }
  if (t === 'D') {
    next.hoursSinceD = 0; next.weeksSinceD = 0; next.dDueAtWeek = null;
    next.lastDCheckWeek = absWeek;
    const credit = Math.min(D_AGE_CREDIT_MAX_WEEKS, Math.max(0, (a.ageWeeks ?? 0) - (a.maintAgeCredit ?? 0)));
    next.maintAgeCredit = (a.maintAgeCredit ?? 0) + credit;
  }
  return next;
}

/** Wear-based weekly mechanical-failure probability (replaces the raw-age curve). */
export function weeklyWearFailureProb(a, type, maintenanceBudget = 1.0) {
  const wearC   = (a?.hoursSinceC ?? 0) / C_HOURS_DUE;
  const wearD   = (a?.hoursSinceD ?? 0) / D_HOURS_DUE;
  const ageYears = (a?.ageWeeks ?? 0) / 52;
  const ageTerm = Math.pow(ageYears / 25, 1.2) * 0.02;
  const base = 0.002 + 0.03 * wearC * wearC + 0.06 * wearD * wearD + ageTerm;
  return Math.min(0.35, base / Math.max(0.5, maintenanceBudget));
}

/** Valuation multiplier for an airframe (recent D bonus, currently-due penalty). */
export function maintNavMultiplier(a, absWeek) {
  let m = 1;
  if (a?.lastDCheckWeek != null && (absWeek - a.lastDCheckWeek) <= RECENT_D_WINDOW_WEEKS) {
    m += NAV_RECENT_D_BONUS;
  }
  const cDue = (a?.hoursSinceC ?? 0) >= C_HOURS_DUE || (a?.weeksSinceC ?? 0) >= C_WEEKS_DUE;
  const dDue = (a?.hoursSinceD ?? 0) >= D_HOURS_DUE || (a?.weeksSinceD ?? 0) >= D_WEEKS_DUE;
  if (cDue || dDue) m -= NAV_DUE_PENALTY;
  return Math.max(0.5, m);
}

// Deterministic [0,1) hash of a string — used to seed migration counters so a
// live fleet doesn't all come due the same week.
function hash01(str) {
  let h = 2166136261 >>> 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Seed maintenance counters for an aircraft that has none (old save / freshly
 * migrated MP blob / pre-existing used airframe). Deterministic from the id and
 * age; GUARANTEED never to come out already due or overdue.
 */
export function seedMaintenance(a, type) {
  if (a?.hoursSinceC != null && a?.weeksSinceC != null) {
    // Already has maintenance state — just ensure the optional fields exist.
    return {
      ...a,
      hoursSinceD:    a.hoursSinceD ?? 0,
      weeksSinceD:    a.weeksSinceD ?? 0,
      maintAgeCredit: a.maintAgeCredit ?? 0,
      cDueAtWeek:     a.cDueAtWeek ?? null,
      dDueAtWeek:     a.dDueAtWeek ?? null,
      scheduledCheck: a.scheduledCheck ?? null,
    };
  }
  const seed = hash01(a?.id);
  const cFrac = 0.20 + seed * 0.60;                    // 20–80% of the C interval
  const age   = a?.ageWeeks ?? 0;
  const dFrac = Math.min(0.85, (age % D_WEEKS_DUE) / D_WEEKS_DUE);
  return {
    ...a,
    hoursSinceC:    Math.round(C_HOURS_DUE * cFrac),
    weeksSinceC:    Math.round(C_WEEKS_DUE * cFrac),
    hoursSinceD:    Math.round(D_HOURS_DUE * Math.min(0.9, dFrac + seed * 0.1)),
    weeksSinceD:    Math.min(Math.round(D_WEEKS_DUE * dFrac), D_WEEKS_DUE - 4),
    maintAgeCredit: a?.maintAgeCredit ?? 0,
    cDueAtWeek:     null,
    dDueAtWeek:     null,
    scheduledCheck: a?.scheduledCheck ?? null,
  };
}
