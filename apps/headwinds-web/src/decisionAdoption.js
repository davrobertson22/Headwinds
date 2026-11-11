// What to do with the state a decision comes back with.
//
// A click is applied twice: optimistically in the browser (same reducer, for
// instant feedback) and authoritatively on the server, whose result then
// replaces local state. "Replaces" used to mean a brand-new state object on
// every click — and a new state object is a new weekly projection, a second
// full run of the engine's week on the main thread right after the one the
// optimistic apply had just paid for. On a 1,900-tail airline that was two
// ~1 s freezes per click (measured 2026-11-10).
//
// Nearly always the server's answer says nothing new about the airline: it is
// the optimistic state, byte for byte, plus whatever the rivals have done
// since the last poll. So the answer is compared before it is adopted:
//
//   'same'    nothing differs            → keep the state on screen untouched
//   'overlay' only the rival view moved  → apply it the way a rival poll does
//                                          (projected in the worker first)
//   'state'   the airline itself differs → adopt the server's state, as before
//
// "Differs" is by value, as JSON would carry it — the server's copy has been
// through JSON and the local one has not.

/**
 * The server-derived half of the state: everything rebuilt from OTHER airlines
 * on every read and stripped before the save is stored. Must match stripRivals
 * (apps/headwinds-server/src/lib/humanRivals.mjs) — decision-adoption-test
 * holds the two together.
 */
export const RIVAL_OVERLAY_KEYS = Object.freeze([
  'competitors', 'humanRivals', 'encroachments',
  'allianceMembership', 'allianceDef', 'accountOG', 'accountDev', 'accountSupporter',
  'gateMarket', 'worldMarket', 'stockPool', 'allianceSlotPool', 'laborMarket', 'selfStanding', 'lineBook', 'marketDev',
]);
const OVERLAY = new Set(RIVAL_OVERLAY_KEYS);

/**
 * Deep equality as JSON sees it: a key holding `undefined` is a missing key,
 * and -0 is 0. Anything JSON cannot carry faithfully (NaN, Infinity, a Date, a
 * Map) compares unequal unless it is the very same value, which errs on the
 * side of adopting the server's state.
 */
export function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  const pa = Object.getPrototypeOf(a), pb = Object.getPrototypeOf(b);
  if ((pa !== Object.prototype && pa !== null) || (pb !== Object.prototype && pb !== null)) return false;
  let defined = 0;
  for (const k in a) {
    if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
    const va = a[k];
    if (va === undefined) continue;
    defined++;
    const vb = b[k];
    if (vb === undefined || !sameJson(va, vb)) return false;
  }
  for (const k in b) {
    if (Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined) defined--;
  }
  return defined === 0;
}

/** The overlay keys `state` carries, as their own object (the shape a poll's `rivals` has). */
export function overlayOf(state) {
  const out = {};
  if (!state || typeof state !== 'object') return out;
  for (const k of RIVAL_OVERLAY_KEYS) if (state[k] !== undefined) out[k] = state[k];
  return out;
}

/**
 * Compare the state on screen with the state a decision returned.
 * @returns {'same'|'overlay'|'state'}
 */
export function compareDecisionResult(local, server) {
  if (!local || !server || typeof local !== 'object' || typeof server !== 'object') return 'state';
  if (local === server) return 'same';
  // The airline's own half first: if it differs nothing else matters.
  for (const k in server) {
    if (OVERLAY.has(k) || server[k] === undefined) continue;
    if (!sameJson(local[k], server[k])) return 'state';
  }
  for (const k in local) {
    if (OVERLAY.has(k) || local[k] === undefined) continue;
    if (server[k] === undefined) return 'state';
  }
  for (const k of RIVAL_OVERLAY_KEYS) {
    if (!sameJson(local[k], server[k])) return 'overlay';
  }
  return 'same';
}
