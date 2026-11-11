// Lean decision replies: the client's half.
//
// A decision is answered with what it changed (engine utils/statePatch.js)
// when the client names the version of its airline it holds and the server
// applied the action to exactly that version. To use the patch the client
// keeps a SHADOW: the server's copy of the airline as last confirmed, with its
// version. It starts as a whole state the server sent (a load, a tick, a
// whole-state reply) and every lean reply moves it on by one write.
//
// The shadow is not the state on screen. The screen is ahead of it by
// whatever the player has clicked since (optimistic), and the two are compared
// when the newest decision comes back, exactly as the whole state used to be
// (decisionAdoption.js): equal, and nothing is adopted; different, and the
// server's wins. Because the shadow began as the very object that was put on
// screen and both sides only ever replace what they change, the comparison
// stops at the first shared object and reads only what an action touched.
//
// Anything that changes the airline behind the client's back — a tick, another
// tab, a purchase through another endpoint — moves the server's version. The
// next decision then names a version the server no longer has, gets the whole
// state back, and the shadow starts again from it. Nothing here has to know
// about those paths.

/** Our own half of a stamp ("<version>:<world>"), or null. */
export function selfVersionOf(stamp) {
  if (typeof stamp !== 'string') return null;
  const v = Number(stamp.split(':')[0]);
  return Number.isInteger(v) ? v : null;
}

/** The stamp with our half moved to `version` (never backwards); the world half is kept. */
export function withSelfVersion(stamp, version) {
  if (typeof stamp !== 'string' || !Number.isInteger(version)) return stamp;
  const i = stamp.indexOf(':');
  if (i < 0) return stamp;
  const have = selfVersionOf(stamp);
  return have != null && have >= version ? stamp : `${version}${stamp.slice(i)}`;
}

/**
 * Move the shadow on by one lean reply.
 * @returns {{ shadow: object|null, applied: boolean, lost: boolean }}
 *   applied — the shadow is now the server's airline after this write
 *   lost    — the reply does not follow from what we hold: fetch the whole state
 *   neither — the reply is older than the shadow (a load overtook it): ignore it
 */
export function advanceShadow(shadow, reply, apply) {
  if (!reply?.patch || !Number.isInteger(reply.base)) return { shadow: null, applied: false, lost: true };
  if (!shadow) return { shadow: null, applied: false, lost: true };
  if (shadow.version > reply.base) return { shadow, applied: false, lost: false };
  if (shadow.version < reply.base) return { shadow: null, applied: false, lost: true };
  try {
    const version = Number.isInteger(reply.version) ? reply.version : reply.base + 1;
    return { shadow: { state: apply(shadow.state, reply.patch), version }, applied: true, lost: false };
  } catch {
    return { shadow: null, applied: false, lost: true };
  }
}
