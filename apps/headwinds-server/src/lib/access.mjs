// Per-world read access — ONE definition of "may this caller read this world".
//
// `visibility: 'PRIVATE'` was only ever enforced where worlds are DISCOVERED:
// GET /worlds filters on PUBLIC, and the lobby never lists a private world. But
// every per-world READ endpoint took the id straight from the URL and answered
// it: standings and the world detail card, the rival profile
// (/worlds/:id/rivals/:airlineId — including each rival's whole route network
// and fares), the news feed, the legacy activity ticker, the gate availability
// summary and the used-aircraft market. A world id is a cuid, but it is shared
// in Discord, sits in browser history and is in every link a member posts, so
// "unlisted" was the only protection a private world actually had.
//
// The rule, deliberately narrow:
//   PUBLIC  → unchanged. Anonymous spectators keep working exactly as before.
//   PRIVATE → the caller must be authenticated AND have an airline row in that
//             world. ANY status counts: a BANKRUPT or ABANDONED player is still
//             a member and must keep reading the world they played in (their
//             restart flow depends on it).
//
// A refused read answers 404, not 403: a private world must not confirm its own
// existence to someone who guessed or was forwarded an id.
//
// NOT gated here, on purpose:
//   • POST /worlds/:id/join — you are by definition not a member yet. Private
//     worlds are protected there by the join code (worldService.joinWorld).
//   • GET /worlds/:id keeps returning the world CARD to a non-member (name,
//     status, player count) because that page is where the join form lives —
//     gating it outright would make a private world unjoinable from its own
//     invite link. What it no longer returns to a non-member is the standings:
//     every player's name, hub, cash, market cap and rank. See routes/worlds.mjs.
//
// No prisma/env imports: `prisma` is passed in, exactly like lib/worldService.mjs,
// so this module is directly unit-testable (tools/server-hardening-test.mjs).

/** Does this world restrict reads to its own members? */
export function isPrivateWorld(world) {
  return world?.visibility === 'PRIVATE';
}

/**
 * Pure decision. `account` is the resolved Account (or null for an anonymous
 * caller) and `isMember` the answer to "does this account hold an airline row
 * in this world?".
 */
export function mayReadWorld(world, { account = null, isMember = false } = {}) {
  if (!world) return false;
  if (!isPrivateWorld(world)) return true;
  return Boolean(account) && isMember === true;
}

/**
 * Membership = any Airline row for this account in this world, WHATEVER its
 * status. Uses the (worldId, accountId) unique index, so it is one indexed
 * point read of a single boolean-ish column — never a state blob.
 */
export async function isWorldMember(prisma, worldId, accountId) {
  if (!worldId || !accountId) return false;
  const row = await prisma.airline.findUnique({
    where: { worldId_accountId: { worldId, accountId } },
    select: { id: true },
  });
  return Boolean(row);
}

/** The 404 a private world shows a caller who may not read it. */
export function privateWorldError() {
  const e = new Error('No such world');
  e.statusCode = 404;
  return e;
}

/**
 * Route-level gate. Throws the 404 above when this caller may not read this
 * world; returns silently otherwise. A PUBLIC world costs NOTHING — not even
 * the membership query — so the hot spectator paths are unaffected.
 *
 * @param {object} prisma
 * @param {object} world    the already-loaded World row (needs `id`, `visibility`)
 * @param {object|null} account  resolved Account, or null when anonymous
 */
export async function assertWorldReadable(prisma, world, account) {
  if (!isPrivateWorld(world)) return;
  const isMember = account ? await isWorldMember(prisma, world.id, account.id) : false;
  if (!mayReadWorld(world, { account, isMember })) throw privateWorldError();
}
