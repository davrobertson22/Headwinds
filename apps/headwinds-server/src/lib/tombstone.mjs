// ─────────────────────────────────────────────────────────────────────────────
// TOMBSTONE — what a dead airline is allowed to keep
//
// A bankrupt or abandoned airline never ticks again (the tick loads ACTIVE
// only), but its full state blob — ~520kB on average, over half of it the
// lastReport — used to sit in the row forever. With more dead airlines than
// live ones in every mature world (measured 2026-08-25: 86 dead vs 65 active
// across all worlds), the corpses were the majority of the blob bytes the
// lobby standings query detoasted on every poll, and the majority of the page
// cache the live game wanted for itself.
//
// The fire sale (fireSaleService) already strips the estate's VALUE — fleet to
// the used market, gates back to the pool. This strips its WEIGHT: the heavy
// report/history keys are cut down, and what remains is exactly the shape of a
// freshly joined airline plus its final headline numbers, which is a shape
// every client screen already renders (a new joiner has lastReport: null and
// empty histories too — that path is exercised on every join).
//
// Deliberately NOT deletion. The row must survive: re-founding resurrects it
// in place (restartService), the unique (worldId, accountId) key is what stops
// a bankrupt player re-joining as a fresh airline with a reset restart count,
// and the season snapshot (careerService) banks from its scalar columns at
// world end. Careers never read the blob of a dead airline — passengers for
// non-ticked airlines already record 0 by design — so nothing here can cost
// anyone a badge.
// ─────────────────────────────────────────────────────────────────────────────

/** Heavy keys a dead airline gives up, and the empty shape each collapses to.
 *  null = "never ticked yet"; [] = "no history yet" — both are the seed-state
 *  values a brand-new airline carries, so no client guard is new. */
export const TOMBSTONE_CUTS = {
  lastReport: null,       // ~56% of an average blob
  financialHistory: [],   // ~19%
  statsHistory: [],       // ~15%
  newsLog: [],            // solo-style log; MP reads WorldNews instead
};

/** Marker key: the linear week the estate was settled. Presence = tombstoned. */
export const TOMBSTONE_KEY = 'tombstonedWeek';

/**
 * Pure: the tombstoned version of a dead airline's state.
 *
 * @param {object|null} state
 * @param {object} [opts]
 * @param {number|null} [opts.weekIndex]  linear week of death (display only)
 * @returns {{ state: object|null, changed: boolean }}
 */
export function tombstoneState(state, { weekIndex = null } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { state, changed: false };
  }
  let changed = false;
  const next = { ...state };
  for (const [key, emptyShape] of Object.entries(TOMBSTONE_CUTS)) {
    const cur = next[key];
    const alreadyEmpty = cur == null || (Array.isArray(cur) && cur.length === 0);
    if (!alreadyEmpty) changed = true;
    next[key] = emptyShape;
  }
  if (next[TOMBSTONE_KEY] == null) {
    next[TOMBSTONE_KEY] = weekIndex;
    // The marker alone is not worth a 500kB row rewrite: only count it as a
    // change when something heavy was actually cut. Backfills stay idempotent.
  }
  return { state: changed ? next : state, changed };
}

/**
 * Settle one dead airline's blob in the database. Best-effort by contract —
 * callers treat a failure exactly like a fire-sale failure: log and move on,
 * never roll back the week that killed it.
 *
 * @returns {Promise<{ changed: boolean, before: number, after: number }>}
 *          byte sizes are JSON-serialized approximations, for logging.
 */
export async function tombstoneAirline(prisma, { airlineId, weekIndex = null, log = console }) {
  const row = await prisma.airline.findUnique({
    where: { id: airlineId },
    select: { id: true, status: true, state: true },
  });
  if (!row) return { changed: false, before: 0, after: 0 };
  // Refuse to strip a living airline, whatever the caller thinks it knows —
  // an ACTIVE blob is the game.
  if (row.status === 'ACTIVE') return { changed: false, before: 0, after: 0 };

  const { state, changed } = tombstoneState(row.state, { weekIndex });
  if (!changed) return { changed: false, before: 0, after: 0 };

  const before = JSON.stringify(row.state)?.length ?? 0;
  const after = JSON.stringify(state)?.length ?? 0;
  await prisma.airline.update({ where: { id: row.id }, data: { state } });
  log.info?.(`[tombstone] airline ${row.id}: ${Math.round(before / 1024)}kB → ${Math.round(after / 1024)}kB`);
  return { changed: true, before, after };
}
