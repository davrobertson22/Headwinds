/**
 * Which leased aircraft are about to walk out of the fleet.
 *
 * Lease expiry is the one recurring event that deletes revenue-producing routes
 * without the player doing anything: the tick returns the aircraft, charges four
 * weeks' rent as a redelivery fee, and CLOSES every route it was flying. All the
 * warning it gave was a toast at eight and four weeks — which a multiplayer
 * player who was asleep for thirty ticks never saw, and which the Dashboard
 * alert strip (idle aircraft, cash runway, losing routes, events) did not
 * mention at all.
 *
 * Three surfaces now need the same answer — the Dashboard alert, the Fleet
 * "expiring" chip, and the weekly debrief — so the predicate lives here once.
 * Three hand-rolled copies of "is this lease nearly up" is exactly how the
 * Routes tab ended up saying "3 losing" over a screen of green cards.
 */

/** How far ahead we call a lease "expiring". The engine toasts at 8 and 4. */
export const LEASE_EXPIRY_WARN_WEEKS = 8;

/**
 * Weeks left on this aircraft's lease, or null if it is owned (or the field has
 * never been set — an old save, or a tail the tick has not touched yet).
 */
export function leaseRemainingWeeks(a) {
  if (!a || a.ownershipType !== 'lease') return null;
  const w = a.leaseRemainingWeeks;
  return typeof w === 'number' ? w : null;
}

/**
 * True when this lease ends within `within` weeks and has not ended already.
 *
 * The `> 0` half matters: the tick removes the aircraft on the week the counter
 * hits zero, so a zero here is a tail that is already gone. Counting it would
 * leave the alert warning about an aircraft the player can no longer see.
 */
export function isLeaseExpiring(a, within = LEASE_EXPIRY_WARN_WEEKS) {
  const w = leaseRemainingWeeks(a);
  return w !== null && w > 0 && w <= within;
}

/** Expiring tails, soonest first — the order you'd want to fix them in. */
export function leasesExpiringSoon(fleet, within = LEASE_EXPIRY_WARN_WEEKS) {
  return (fleet ?? [])
    .filter(a => isLeaseExpiring(a, within))
    .sort((a, b) => leaseRemainingWeeks(a) - leaseRemainingWeeks(b));
}
