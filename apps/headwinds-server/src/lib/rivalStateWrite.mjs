// Airline."rivalState" written by the weekly tick itself (outage 2026-10-22).
//
// The column is the trimmed copy of `state` that loadRivalRows reads. A
// trigger (migration 20261022000000_airline_rival_state) fills it on every
// `state` write by running rival_state_of() inside Postgres, which costs
// ~0.15 s per MB of state. For a world's weekly commit that is every airline at
// once (Scarce Assets: ~10 s), inside the tick's transaction budget.
//
// The tick already has each airline's new state in memory, and
// projectRivalState() is the JS twin of rival_state_of(). So the tick:
//   1. beginAppRivalStates(tx)  marks its transaction (SET LOCAL), which makes
//      the trigger stand aside (migration 20261023000000_rival_state_app_writer);
//   2. writes its airline rows as before;
//   3. writeRivalStates(tx, map) sets "rivalState" for every row it wrote, in
//      ONE statement, from projectRivalState(persisted state).
// Writers that never call (1) keep the trigger: decisions, joins, fire sales.
//
// A prisma double without $queryRaw (the tick test harnesses) skips both: it
// has no trigger and no column to keep in step.
import { projectRivalState } from './humanRivals.mjs';

export const RIVAL_STATE_WRITER_SETTING = 'headwinds.rival_state_writer';

/** Mark this transaction as the writer of "rivalState". Returns whether it did. */
export async function beginAppRivalStates(tx) {
  if (typeof tx?.$queryRaw !== 'function') return false;
  // set_config(..., true) is SET LOCAL: it ends with this transaction.
  await tx.$queryRaw`SELECT set_config('headwinds.rival_state_writer', 'app', true)`;
  return true;
}

/** The value the trigger would have written for a persisted `state`. */
export const rivalStateFor = (persistedState) => projectRivalState(persistedState);

/**
 * Write "rivalState" for each id in `byId` (Map id -> rival state, already
 * projected). One statement; returns the number of rows updated.
 */
export async function writeRivalStates(tx, byId) {
  if (typeof tx?.$queryRaw !== 'function' || !byId || byId.size === 0) return 0;
  const payload = JSON.stringify(Object.fromEntries(byId));
  const rows = await tx.$queryRaw`
    UPDATE "Airline" AS a
       SET "rivalState" = v.value
      FROM jsonb_each(${payload}::jsonb) AS v(key, value)
     WHERE a.id = v.key
    RETURNING a.id`;
  return Array.isArray(rows) ? rows.length : 0;
}
