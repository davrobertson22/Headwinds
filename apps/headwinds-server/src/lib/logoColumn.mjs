// customLogo lives in its own Airline COLUMN, not in the save blob.
//
// Why (2026-08-24, Supabase "disk IO budget" warnings): the tick rewrites every
// active airline's whole `state` JSONB every world-week, and Postgres cannot
// update part of a JSONB — each write TOASTs a complete new copy of the value
// (plus the same again in WAL, plus the dead copy autovacuum later reclaims).
// A user-uploaded logo is a static data-URL that never changes between ticks,
// yet it was riding inside that blob and being re-written to disk on every
// single tick, forever. As a plain column it is written ONCE (on SET_BRANDING)
// and never again: updating other columns of the row leaves an unchanged
// TOASTed column's chunks in place, so ticks stop paying for it entirely.
//
// The contract, in one place so no call site has to reason about it:
//
//   WRITE  every persist of a full `state` goes through splitLogo() — the blob
//          is stored WITHOUT the key, and the column is written only when the
//          state actually carried one (i.e. a SET_BRANDING decision just ran;
//          `logo` is undefined otherwise, so untouched states never clobber
//          the column). Migration 20260824000000 backfilled the column from
//          every existing blob and stripped the key, so post-deploy reads from
//          the DB never contain it — services that read state from the DB and
//          write it back (tick, gates, codeshares, used market) stay clean
//          automatically and need no changes.
//
//   READ   every full `state` served to its OWNER passes through injectLogo()
//          with the row's column value, so the client keeps reading
//          `state.customLogo` exactly as before — zero client changes. The
//          rival path never sees it (RIVAL_DROPPED_KEYS / the SQL projection
//          already dropped it; rivals render `logoId`).
//
// Both functions are pure and DB-free (see stamp.mjs for why: importing
// routes/*.mjs in a test pulls db.mjs → env.mjs and throws without
// DATABASE_URL — testable logic lives in lib/). tools/logo-column-test.mjs
// guards the contract.

/**
 * Split `customLogo` out of a state about to be persisted.
 *
 * @returns {{ state: object, logo: string|null|undefined }}
 *   `state` — the blob to store (never carries the key)
 *   `logo`  — undefined when the input had no key (leave the column alone);
 *             null when branding explicitly cleared it (null the column);
 *             the data-URL string when one was set (write the column).
 */
export function splitLogo(state) {
  if (!state || typeof state !== 'object' || !('customLogo' in state)) {
    return { state, logo: undefined };
  }
  const { customLogo, ...rest } = state;
  return { state: rest, logo: customLogo ?? null };
}

/**
 * Put the column value back into a state being served to its owner. A state
 * that already carries the key wins — that is the SET_BRANDING response path,
 * where the reducer output is newer than the row that was read before it ran.
 */
export function injectLogo(state, logo) {
  if (!state || typeof state !== 'object') return state;
  if ('customLogo' in state) return state;
  if (logo == null) return state;
  return { ...state, customLogo: logo };
}
