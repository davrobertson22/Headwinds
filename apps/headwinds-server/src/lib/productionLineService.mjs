// ─────────────────────────────────────────────────────────────────────────────
// Production lines — the server half (engine: data/productionLines.js).
//
// The reducer books slots against `state.lineBook`, the OTHER airlines' bookings
// as they stood when this request's rival view was built. Two airlines can read
// the same view and both reach for the last slot of a week, so the decision
// transaction re-checks under a per-world advisory lock: every order write on
// the world's lines serialises here, re-reads the rivals' committed order books
// for just the lines this decision touched, and refuses (409 version_conflict →
// the client retries against the fresh view) if any new frame no longer fits.
//
// There is no ledger table. The order books ARE the ledger: a cancelled order
// or a bankrupt (no longer ACTIVE) airline frees its slots with no bookkeeping,
// and nothing new needs a migration.
// ─────────────────────────────────────────────────────────────────────────────

import { lineConflicts } from '@tailwinds/engine/data/productionLines.js';

export class LineSlotConflict extends Error {
  constructor(conflicts) {
    super('Another airline has just taken that delivery slot.');
    this.conflicts = conflicts;
  }
}

/** Orders this decision added that sit on a production line. */
export function newLineOrdersOf(before, after) {
  const had = new Set((before ?? []).map((o) => o?.id));
  return (after ?? []).filter((o) => o && !had.has(o.id) && o.lineId && !o.used);
}

const lockKey = (worldId) => `production-lines:${worldId}`;

/** OTHER active airlines' bookings on `lines`, from week `absWeek` on. */
async function othersBookingsTx(tx, { worldId, airlineId, lines, absWeek }) {
  const out = {};
  if (typeof tx.$queryRaw !== 'function') {
    // Test doubles: the ORM path, same filter in JS.
    const rows = await tx.airline.findMany({ where: { worldId, status: 'ACTIVE' } });
    for (const r of rows) {
      if (r.id === airlineId) continue;
      for (const o of r.state?.pendingOrders ?? []) {
        if (!o?.lineId || o.used || !lines.includes(o.lineId) || !(o.deliverAbsWeek >= absWeek)) continue;
        (out[o.lineId] ??= {})[o.deliverAbsWeek] = (out[o.lineId]?.[o.deliverAbsWeek] ?? 0) + 1;
      }
    }
    return out;
  }
  // The week is read through a CASE so one malformed order anywhere in the
  // world (a non-number deliverAbsWeek) is skipped instead of failing the cast
  // for every order on every line — Postgres may evaluate a WHERE cast before
  // the lineId filter has thrown the row out.
  const rows = await tx.$queryRaw`
    SELECT line, week::int AS week, count(*)::int AS n FROM (
      SELECT o->>'lineId' AS line,
             CASE WHEN jsonb_typeof(o->'deliverAbsWeek') = 'number'
                  THEN floor((o->>'deliverAbsWeek')::numeric) END AS week,
             COALESCE(o->>'used', 'false') AS used
        FROM "Airline" a
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(a.state->'pendingOrders') = 'array'
               THEN a.state->'pendingOrders' ELSE '[]'::jsonb END) AS o
       WHERE a."worldId" = ${worldId}
         AND a.status = 'ACTIVE'
         AND a.id <> ${airlineId}
         AND o->>'lineId' = ANY(${lines}::text[])
    ) b
     WHERE used <> 'true' AND week IS NOT NULL AND week >= ${absWeek}
     GROUP BY 1, 2`;
  for (const r of rows) (out[r.line] ??= {})[Number(r.week)] = Number(r.n);
  return out;
}

/**
 * Inside the decision transaction, before the airline write. Throws
 * LineSlotConflict if any of `newOrders` landed on a full week.
 */
export async function assertLineSlotsTx(tx, { worldId, airlineId, pendingOrders, newOrders, scale = 1, rates = null, absWeek }) {
  if (!newOrders?.length) return;
  if (typeof tx.$executeRaw === 'function') {
    // Transaction-scoped: released at COMMIT/ROLLBACK, so it is safe behind the
    // transaction pooler. Every order write on this world queues here.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(worldId)}))`;
  }
  const lines = [...new Set(newOrders.map((o) => o.lineId))];
  const othersBookings = await othersBookingsTx(tx, { worldId, airlineId, lines, absWeek });
  const conflicts = lineConflicts({
    othersBookings, pendingOrders, newOrderIds: newOrders.map((o) => o.id), scale, rates, absWeek,
  });
  if (conflicts.length > 0) throw new LineSlotConflict(conflicts);
}
