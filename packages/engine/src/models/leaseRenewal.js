// Lease auto-renewal and the lease warning window.
//
// Discord (LtFrosty, 2026-10-01): 182 leased aircraft, one "+1 year" click
// each, and "if you sleep for 8 hours you're almost guaranteed to lose some
// leased planes". Two things were wrong underneath:
//
//   1. Renewing was only ever something the PLAYER did. A multiplayer world
//      ticks on a clock whether anyone is logged in, so a lease that ran out
//      overnight took its routes with it. Auto-renew is a standing order the
//      tick carries out: airline-wide, with a per-tail "let it expire" opt-out
//      for the frames the player actually wants to hand back.
//
//   2. The warning was "8 game weeks", which is 8 real hours in a 24-weeks-a-
//      day world and 2 hours at 96. The window is now the larger of 8 weeks and
//      one real day of game time, so it is a warning a person can act on.
//
// Solo states carry no `weeksPerDay` and no `leaseAutoRenew`, so every
// function here returns the pre-change answer for them (golden-master parity).

/** Terms the auto-renew rule can sign for, in weeks (1, 2 and 5 years). */
export const LEASE_AUTO_RENEW_TERMS = [52, 104, 260];
export const DEFAULT_LEASE_AUTO_RENEW_WEEKS = 52;

/**
 * Weeks remaining at which the rule renews. Late enough that a player who
 * opts a tail out the week it shows up as expiring is still in time; early
 * enough that nothing about the tail's checks or routes is disturbed.
 */
export const LEASE_AUTO_RENEW_AT_WEEKS = 4;

/** The floor of the warning window — what solo has always used. */
export const LEASE_WARN_MIN_WEEKS = 8;
/** Ceiling, so a 96-weeks-a-day world doesn't flag a two-year lease on day one. */
export const LEASE_WARN_MAX_WEEKS = 52;

/** The airline's auto-renew setting, normalised. Absent = off. */
export function leaseAutoRenewSetting(state) {
  const s = state?.leaseAutoRenew;
  const addWeeks = LEASE_AUTO_RENEW_TERMS.includes(s?.addWeeks) ? s.addWeeks : DEFAULT_LEASE_AUTO_RENEW_WEEKS;
  return { enabled: !!s?.enabled, addWeeks };
}

/** True when the tick will renew this tail rather than let it go back. */
export function leaseWillAutoRenew(state, a) {
  return !!a && a.ownershipType === 'lease'
    && leaseAutoRenewSetting(state).enabled
    && !a.leaseAutoRenewOff;
}

/**
 * Weeks ahead that count as "expiring": max(8, one real day of game weeks),
 * capped at a year. `weeksPerDay` is injected by the Headwinds server each
 * tick and absent in solo.
 */
export function leaseWarnWeeks(state) {
  const wpd = Number(state?.weeksPerDay);
  if (!(wpd > 0)) return LEASE_WARN_MIN_WEEKS;
  return Math.min(LEASE_WARN_MAX_WEEKS, Math.max(LEASE_WARN_MIN_WEEKS, Math.ceil(wpd)));
}

/**
 * Human phrase for the warning window, e.g. "24 weeks (~1 day)". Real time is
 * only shown when the world has a clock.
 */
export function leaseWarnPhrase(state) {
  const w = leaseWarnWeeks(state);
  const wpd = Number(state?.weeksPerDay);
  if (!(wpd > 0)) return `${w} weeks`;
  const hours = (w / wpd) * 24;
  const real = hours >= 36 ? `~${Math.round(hours / 24)} days` : hours >= 20 ? '~1 day' : `~${Math.round(hours)} hr`;
  return `${w} weeks (${real})`;
}
