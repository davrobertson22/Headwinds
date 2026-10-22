// ─── Shortcuts bar ("favourites") ────────────────────────────────────────────
//
// "Requesting we have a configurable favourites-menu under the current
//  drop-down menus, where we can add a handful of buttons to get to certain
//  areas quicker. Just to save some clicks" (VodkaOnFire, Discord 2026-10-21)
//
// Every page inside a nav dropdown (Network, Fleet, Airports, Company) carries a
// star; a starred page gets a button on a bar under the menus, in the order it
// was pinned. A page that is already one click away (Dashboard, News, Finance,
// Help) has nothing to save and no star.
//
// A UI preference, not game state — same reasoning as utils/airportRecents.js:
// per-browser, survives a reload, and deliberately NOT in the save blob, so it
// follows the player across every save and every new game on this browser.

const KEY   = 'hw_nav_favourites_v1';
const LIMIT = 8;

const EMPTY = Object.freeze([]);
const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

let cache = null;
const listeners = new Set();

function read(storage) {
  if (cache) return cache;
  try {
    const raw = storage?.getItem(KEY);
    const list = raw ? JSON.parse(raw) : null;
    cache = Object.freeze(
      Array.isArray(list)
        ? [...new Set(list.filter(id => typeof id === 'string' && id.length > 0))].slice(0, LIMIT)
        : [],
    );
  } catch (_) {
    cache = EMPTY;
  }
  return cache;
}

function write(next, storage) {
  cache = Object.freeze(next);
  try { storage?.setItem(KEY, JSON.stringify(cache)); } catch (_) { /* private mode */ }
  for (const fn of listeners) fn();
}

/** The pinned page ids, in pin order. Never null. */
export function navFavourites(storage = defaultStorage()) {
  return read(storage);
}

/**
 * Pin `id`, or unpin it if it is pinned. Returns the new pinned state, or null
 * when the bar is full and nothing changed — the caller says so rather than
 * silently dropping the oldest.
 */
export function toggleNavFavourite(id, storage = defaultStorage()) {
  if (!id || typeof id !== 'string') return null;
  const prev = read(storage);
  if (prev.includes(id)) { write(prev.filter(x => x !== id), storage); return false; }
  if (prev.length >= LIMIT) return null;
  write([...prev, id], storage);
  return true;
}

/** Test seam / "start fresh". */
export function clearNavFavourites(storage = defaultStorage()) {
  cache = EMPTY;
  try { storage?.removeItem(KEY); } catch (_) { /* private mode */ }
  for (const fn of listeners) fn();
}

/** useSyncExternalStore plumbing — exported for the hook and for tests. */
export function subscribeNavFavourites(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export { LIMIT as NAV_FAVOURITES_LIMIT };
