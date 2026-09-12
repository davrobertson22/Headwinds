// ─── Recently picked airports ────────────────────────────────────────────────
//
// "Would it be possible to chose which airports come up first? I am mostly
// flying Asian routes but I have to go all the way down to select them."
// (Barca, Discord 2026-09-10)
//
// The honest answer is that the game already knows which airports he wants
// first — they are the ones he just picked — and never asked. So nothing here
// is configured: every airport picker writes the code it was given, and every
// airport picker reads the list back. No star to discover, no settings screen,
// and a player who has picked nothing yet loses nothing.
//
// This is a UI preference, not game state: it is per-browser, survives a reload,
// and is deliberately NOT in the save blob. Putting it there would mean a server
// round-trip and a schema change for something that is worth exactly as much as
// the last six airports you clicked.

const KEY   = 'hw_recent_airports_v1';
const LIMIT = 6;

// Frozen so a caller cannot mutate the shared empty list, and stable by identity
// so useSyncExternalStore's server snapshot never trips the "getSnapshot should
// be cached" warning.
const EMPTY = Object.freeze([]);

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

// localStorage does not re-render anything on its own (same note as
// utils/awayDigest.js), so the value is cached here and listeners are told.
let cache = null;
const listeners = new Set();

function read(storage) {
  if (cache) return cache;
  try {
    const raw = storage?.getItem(KEY);
    const list = raw ? JSON.parse(raw) : null;
    cache = Object.freeze(
      Array.isArray(list)
        ? list.filter(c => typeof c === 'string' && c.length > 0).slice(0, LIMIT)
        : [],
    );
  } catch (_) {
    cache = EMPTY;
  }
  return cache;
}

/** The player's last few airport picks, most recent first. Never null. */
export function recentAirports(storage = defaultStorage()) {
  return read(storage);
}

/**
 * Record that the player picked `code`. Moves it to the front if it was already
 * there, so the list is genuinely "most recent" and not "first six ever".
 *
 * Silently ignores a blank code: a `<select>` with a placeholder option fires
 * onChange with '' when the player scrolls back to it, and "" is not an airport.
 */
export function rememberAirport(code, storage = defaultStorage()) {
  if (!code || typeof code !== 'string') return;
  const prev = read(storage);
  if (prev[0] === code) return;                       // already on top — nothing to do
  const next = Object.freeze([code, ...prev.filter(c => c !== code)].slice(0, LIMIT));
  cache = next;
  try { storage?.setItem(KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
  for (const fn of listeners) fn();
}

/** Test seam / "start fresh": drop the list in memory and on disk. */
export function clearRecentAirports(storage = defaultStorage()) {
  cache = EMPTY;
  try { storage?.removeItem(KEY); } catch (_) { /* private mode */ }
  for (const fn of listeners) fn();
}

/** useSyncExternalStore plumbing — exported for the hook and for tests. */
export function subscribeRecentAirports(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export { LIMIT as RECENT_AIRPORT_LIMIT, EMPTY as NO_RECENT_AIRPORTS };
