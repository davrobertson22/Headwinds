// The weekly report lives in its own Airline COLUMN ("report"), not in the
// save blob. Same contract as customLogo (lib/logoColumn.mjs), for a different
// reason.
//
// Why (2026-10-23, Postgres killed ~12 times in a day): Postgres cannot update
// part of a JSONB, so every decision rewrote the WHOLE `state` — and for the
// big Time Flies airlines `lastReport` was most of it (Ajax Air: 10.9 MB of a
// 15 MB blob). A fare change re-TOASTed and re-WALed a 15 MB value, and the
// rivalState trigger ran rival_state_of() over all of it, several decisions a
// minute, on a ~2 GB database. Only the weekly tick ever produces a report.
// As its own column it is written by the tick and (almost) never by anything
// else: an UPDATE that leaves a TOASTed column out of its SET list leaves the
// stored chunks alone, so a decision now writes the blob WITHOUT the report.
//
// The contract, in one place so no call site has to reason about it:
//
//   READ   every state the engine runs on or the owner is served goes through
//          joinReport(state, row.report). The client keeps reading
//          `state.lastReport` exactly as before — zero client changes — and
//          the engine sees the same state it always did.
//
//   WRITE  the tick writes the column on every airline write (splitReport).
//          A decision writes it only when the reducer replaced the report or
//          the row is still LEGACY (see below) — reportWriteFor() decides.
//          Every other writer (gates, codeshares, used market, admin, event
//          re-stamps) reads `state` from the DB and writes `state` back; they
//          never see the report and never touch the column.
//
//   LEGACY a row last written before this change still carries `lastReport`
//          inside `state`, and its column is NULL. A `lastReport` key inside
//          `state` WINS over the column, so those rows read exactly as before
//          until their next tick (or decision) moves the report out. A fresh
//          template (join, restart, tombstone) carries `lastReport: null`, which
//          therefore also wins over any stale column value.
//
//   RIVALS rivalState's three report fields come from the column once `state`
//          has no `lastReport` key — the triggers in migration
//          20261024000000_airline_report_column, and the tick's JS writer via
//          joinReport(). See tools/report-column-test.mjs.
//
// Pure and DB-free (see stamp.mjs for why).

/** The state the engine and the owner see: the report back inside it. */
export function joinReport(state, report) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (Object.prototype.hasOwnProperty.call(state, 'lastReport')) return state;   // legacy row / fresh template
  return { ...state, lastReport: report ?? null };
}

/**
 * Split the report out of a state about to be persisted.
 * @returns {{ state: object, report: object|null|undefined }}
 *   `report` is undefined when the state carried no `lastReport` key.
 */
export function splitReport(state) {
  if (!state || typeof state !== 'object' || !Object.prototype.hasOwnProperty.call(state, 'lastReport')) {
    return { state, report: undefined };
  }
  const { lastReport, ...rest } = state;
  return { state: rest, report: lastReport ?? null };
}

/** A row last written before the report moved to its column. */
export function isLegacyRow(row) {
  return !!row && row.report == null
    && !!row.state && typeof row.state === 'object'
    && Object.prototype.hasOwnProperty.call(row.state, 'lastReport');
}

/**
 * What a decision must persist.
 *
 * @param {object} row          the Airline row the decision read (state, report)
 * @param {*}      readReport   the `lastReport` the reducer was handed
 * @param {object} next         the reducer's output (report inside, as read)
 * @returns {{ state: object, writeReport: boolean, report: object|null }}
 *   `state` never carries `lastReport`. `writeReport` is true only when the
 *   reducer REPLACED the report (identity: every reducer case that leaves it
 *   alone spreads the same object through), or the row is legacy and its
 *   report has to move into the column now that `state` will not carry it.
 */
export function reportWriteFor(row, readReport, next) {
  const { state, report } = splitReport(next);
  if (report === undefined) return { state, writeReport: false, report: null };
  const writeReport = report !== readReport || isLegacyRow(row);
  return { state, writeReport, report };
}
