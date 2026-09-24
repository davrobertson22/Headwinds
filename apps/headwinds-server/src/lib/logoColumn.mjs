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
//          already dropped it). Rivals get a URL instead — see RIVALS below.
//
//   RIVALS (2026-09-24, Discord: "custom logos only appear for me") rival
//          views carry `customLogo: '/logos/<airlineId>?v=<hash>'` — a path,
//          never the bytes, so the egress trim above still holds. The hash is
//          computed in the rival SQL projection (md5 over the column, Postgres
//          side) or here from a full row, and both agree byte-for-byte.
//          routes/logos.mjs serves the image with an immutable cache header;
//          a new upload changes the hash and therefore the URL.
//
// All functions here are pure and DB-free (see stamp.mjs for why: importing
// routes/*.mjs in a test pulls db.mjs → env.mjs and throws without
// DATABASE_URL — testable logic lives in lib/). tools/logo-column-test.mjs
// guards the contract.

import { createHash } from 'node:crypto';

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

// ── Rival-facing logo URL ─────────────────────────────────────────────────────
// Must equal Postgres `left(md5("customLogo"), LOGO_HASH_LEN)` — loadRivalRows
// computes it there so the column's bytes never leave the database.
export const LOGO_HASH_LEN = 12;

export function logoHashOf(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return null;
  return createHash('md5').update(dataUrl, 'utf8').digest('hex').slice(0, LOGO_HASH_LEN);
}

// A ROOT-RELATIVE path on the API. The web client resolves it against its API
// origin (AirlineLogo's setLogoOrigin) — the server never needs to know its
// own public URL.
export function logoPathOf(airlineId, hash) {
  if (!airlineId || !hash) return null;
  return `/logos/${encodeURIComponent(airlineId)}?v=${hash}`;
}

// Raster formats only. SVG is refused on purpose: an SVG served from the API
// origin is a document that can run script if anyone opens its URL directly.
// The client uploads 128×128 PNGs (src/utils/logoImage.js); the others are here
// only so an older upload path's JPEG/WebP still displays.
const SERVABLE_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Decode a stored logo data URL → { contentType, bytes } or null if unservable. */
export function decodeLogoDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) return null;
  const contentType = m[1].toLowerCase();
  if (!SERVABLE_LOGO_TYPES.has(contentType)) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) return null;
  return { contentType, bytes };
}

