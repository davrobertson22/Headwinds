// Change-stamp format for the airline read.
//
// A stamp is `<selfVersion>:<worldSum>.<worldCount>` and carries two unrelated
// facts that gate two very differently sized halves of the response:
//
//   self  — this airline's `version`; moves when WE act or a tick lands.
//           Gates the state blob (megabytes).
//   world — the sum of every active airline's `version`, plus the active count
//           so joins and abandons register; moves when ANYBODY acts.
//           Gates the rival overlay (kilobytes).
//
// Pure string handling, deliberately kept out of the route module: the route
// imports the Prisma client, which requires DATABASE_URL at import time, and
// this logic is worth testing without a database.
export function splitStamp(stamp) {
  if (typeof stamp !== 'string') return [null, null];
  const i = stamp.indexOf(':');
  // No colon means it isn't one of ours (or it's empty). Return a pair that
  // compares unequal to any real value, so the caller does a full load rather
  // than a silently stale read.
  if (i < 0) return [null, null];
  // Split on the FIRST colon only: the world half contains a dot but never a
  // colon, and slicing this way keeps it intact.
  return [stamp.slice(0, i), stamp.slice(i + 1)];
}

// Does this echoed stamp still match the current pair? Returns which halves
// moved, so the caller can ship only what is actually stale.
export function stampDelta(echoed, selfVersion, worldStamp) {
  const [prevSelf, prevWorld] = splitStamp(echoed);
  return {
    selfChanged: prevSelf !== String(selfVersion),
    worldChanged: prevWorld !== worldStamp,
  };
}
