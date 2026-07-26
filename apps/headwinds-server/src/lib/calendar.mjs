// Shared world calendar — one date for everyone in a world.
// ----------------------------------------------------------------------------
// WHY THIS EXISTS
// Each airline's save blob carries its own { week, year }. It used to be seeded
// from the solo game's freshState() (Year 1 Week 1) at JOIN time, while the world
// clock kept its own currentWeek/currentYear. Two players who joined the same
// world weeks apart therefore ran different calendars — one player's top bar read
// "December Y1" while their rival's read "April Y1".
//
// That was not merely cosmetic: seasonality is derived from state.week (see
// currentGameDate/weekToGameDate in the engine), so rivals in ONE world were
// flying DIFFERENT seasons and their leaderboard positions partly reflected who
// happened to be in a peak month. The fix is to rebase the airline's own calendar
// onto the world clock — display and simulation then agree by construction.
//
// REBASE RULE
// Shifting a blob's calendar forward must not fast-forward anything that is
// scheduled in absolute-week terms: a delivery 3 weeks out must stay 3 weeks out,
// not land instantly because its deliverAbsWeek is suddenly in the past. So every
// stored ABSOLUTE week moves by the same delta; every RELATIVE counter
// (ageWeeks, weeksRemaining, weeksLeft, weeksSinceC, checkWeeksLeft, …) is left
// exactly as it is.
//
// Keep the field list below in sync with the reducer when a new absolute-week
// field lands. The audit source of truth is `grep -n "absoluteWeek(" reducer.mjs`.
import { weekToGameDate } from '@tailwinds/engine/utils/simulation.js';
import { WEEKS_PER_YEAR } from './worldConfig.mjs';

/** Linear 1-based week index of a { year, week } pair. Mirrors the engine's absoluteWeek(). */
export const absWeekOf = (year, week) =>
  ((Number(year) || 1) - 1) * WEEKS_PER_YEAR + (Number(week) || 1);

/** Inverse of absWeekOf — a linear index back to { year, week }. */
export const yearWeekOf = (absWeek) => {
  const i = Math.max(1, Math.round(Number(absWeek) || 1));
  return {
    year: Math.floor((i - 1) / WEEKS_PER_YEAR) + 1,
    week: ((i - 1) % WEEKS_PER_YEAR) + 1,
  };
};

/** The history-row label the reducer writes, e.g. "Dec W4 Y3". */
export const historyLabel = (year, week) => {
  const d = weekToGameDate(week);
  return `${d.monthName} W${d.weekInMonth} Y${year}`;
};

// Shift a number by `delta`, leaving null/undefined/non-finite values untouched.
const shiftNum = (v, delta) =>
  typeof v === 'number' && Number.isFinite(v) ? v + delta : v;

// Shift every numeric value of a { key: absWeek } map (labor's per-group
// negotiation schedule). Null/absent maps pass through unchanged.
const shiftMap = (obj, delta) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = shiftNum(v, delta);
  return out;
};

// Re-stamp a history row (financialHistory / statsHistory) onto the new calendar
// so charts stay monotonic across the rebase instead of jumping backwards.
const shiftHistoryRow = (row, delta) => {
  if (!row || typeof row !== 'object') return row;
  const abs = absWeekOf(row.year, row.week) + delta;
  const { year, week } = yearWeekOf(abs);
  return {
    ...row,
    week,
    year,
    ...(row.label != null ? { label: historyLabel(year, week) } : {}),
    ...(row.absWeek != null ? { absWeek: abs } : {}),
  };
};

/**
 * Move an airline save blob onto a target calendar position, preserving the
 * relative timing of everything already in flight.
 *
 * @param {object} state           the airline's engine state blob
 * @param {object} target          { year, week } — normally the world clock
 * @returns {{ state: object, delta: number }} the rebased blob and the shift applied
 */
export function rebaseStateCalendar(state, { year, week }) {
  if (!state || typeof state !== 'object') return { state, delta: 0 };
  const delta = absWeekOf(year, week) - absWeekOf(state.year, state.week);
  if (!Number.isFinite(delta) || delta === 0) return { state, delta: 0 };

  const next = {
    ...state,
    week: Number(week) || 1,
    year: Number(year) || 1,
  };

  // ── Fleet: heavy-check booking + the stamped due markers ────────────────────
  // ageWeeks / weeksSinceC / weeksSinceD / checkWeeksLeft / leaseRemainingWeeks
  // are RELATIVE counters and deliberately untouched.
  if (Array.isArray(state.fleet)) {
    next.fleet = state.fleet.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const out = { ...a };
      if (a.cDueAtWeek != null) out.cDueAtWeek = shiftNum(a.cDueAtWeek, delta);
      if (a.dDueAtWeek != null) out.dDueAtWeek = shiftNum(a.dDueAtWeek, delta);
      if (a.scheduledCheck && a.scheduledCheck.startWeek != null) {
        out.scheduledCheck = { ...a.scheduledCheck, startWeek: shiftNum(a.scheduledCheck.startWeek, delta) };
      }
      return out;
    });
  }

  // ── Aircraft on order: keep each delivery the same number of weeks out ──────
  if (Array.isArray(state.pendingOrders)) {
    next.pendingOrders = state.pendingOrders.map((o) =>
      o && typeof o === 'object' ? { ...o, deliverAbsWeek: shiftNum(o.deliverAbsWeek, delta) } : o);
  }

  // ── Hubs: tierSince gates the tier-3 throughput prereq and downgrade timing ─
  if (state.hubs && typeof state.hubs === 'object') {
    const hubs = {};
    for (const [code, h] of Object.entries(state.hubs)) {
      hubs[code] = (h && typeof h === 'object' && h.tierSince != null)
        ? { ...h, tierSince: shiftNum(h.tierSince, delta) }
        : h;
    }
    next.hubs = hubs;
  }

  // ── Fuel hedges: a contract with 8 weeks to run still has 8 weeks to run ────
  if (Array.isArray(state.hedgeContracts)) {
    next.hedgeContracts = state.hedgeContracts.map((h) =>
      h && typeof h === 'object'
        ? { ...h, startAbsWeek: shiftNum(h.startAbsWeek, delta), expiryAbsWeek: shiftNum(h.expiryAbsWeek, delta) }
        : h);
  }

  // ── Labor: next pay demand per group + the post-strike truce window ─────────
  if (state.laborRelations && typeof state.laborRelations === 'object') {
    next.laborRelations = {
      ...state.laborRelations,
      nextNegotiationAbsWeek: shiftMap(state.laborRelations.nextNegotiationAbsWeek, delta),
      strikeCooldownUntilAbsWeek: shiftNum(state.laborRelations.strikeCooldownUntilAbsWeek, delta),
    };
  }

  // ── History series: re-stamp so the charts read on the new calendar ─────────
  if (Array.isArray(state.financialHistory)) {
    next.financialHistory = state.financialHistory.map((r) => shiftHistoryRow(r, delta));
  }
  if (Array.isArray(state.statsHistory)) {
    next.statsHistory = state.statsHistory.map((r) => shiftHistoryRow(r, delta));
  }

  return { state: next, delta };
}
