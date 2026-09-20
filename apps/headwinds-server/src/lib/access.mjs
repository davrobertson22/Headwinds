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

// ── Supporter worlds ─────────────────────────────────────────────────────────
// A world with an owner was created by a ♥ SUPPORTER for their own group, and
// EVERY member must hold the badge (Dave, 2026-09-19: "supporters only").
// Membership is still what admits you (the rule above); the badge is what
// keeps you in. When it lapses the member is locked out of every read and
// every decision in that world — a 403 with a renew prompt, not the 404 a
// stranger gets, because a member is entitled to know why — while their
// airline keeps flying on autopilot exactly like any player who is away.
// Admin-created worlds (ownerAccountId null) never consult the badge.
//
// Deliberately NOT part of mayReadWorld: that answers "may this caller see
// this world exists?", and a lapsed member may. This answers "may they use it".

/** Was this world created by a supporter for their own group? */
export function isSupporterWorld(world) {
  return Boolean(world?.ownerAccountId);
}

export const SUPPORTER_LAPSED_MESSAGE =
  'This is a supporter world and your ♥ SUPPORTER badge is no longer active. '
  + 'Your airline keeps flying — renew your monthly tip on Ko-fi and you are back in as soon as the badge is on.';

/** The 403 a supporter world shows a member whose badge has lapsed. */
export function supporterLapsedError() {
  const e = new Error(SUPPORTER_LAPSED_MESSAGE);
  e.statusCode = 403;
  e.code = 'SUPPORTER_LAPSED';
  return e;
}

/**
 * Pure decision: may this account USE (read the standings of, act in) this
 * world as far as the supporter rule is concerned? Membership is checked
 * elsewhere. `admin` exempts the operator, who moderates every world.
 */
export function mayUseSupporterWorld(world, account, { admin = false } = {}) {
  if (!isSupporterWorld(world)) return true;
  if (admin) return true;
  return account?.isSupporter === true;
}

/** Throws the 403 above when the supporter rule refuses this caller. */
export function assertSupporterAccess(world, account, { admin = false } = {}) {
  if (!mayUseSupporterWorld(world, account, { admin })) throw supporterLapsedError();
}

/**
 * Pure decision. `account` is the resolved Account (or null for an anonymous
 * caller) and `isMember` the answer to "does this account hold an airline row
 * in this world?".
 */
export function mayReadWorld(world, { account = null, isMember = false } = {}) {
  if (!world) return false;
  if (!isPrivateWorld(world)) return true;
  if (!account) return false;
  // The OWNER of a supporter world is a member from the moment it exists —
  // before they have founded an airline in it. Otherwise the create → join
  // hand-off would show them their own world as a stranger (no password, a
  // join form asking for it).
  if (isOwner(world, account)) return true;
  return isMember === true;
}

/** Did this account create this (supporter) world? */
export function isOwner(world, account) {
  return Boolean(account?.id) && world?.ownerAccountId === account.id;
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
export async function assertWorldReadable(prisma, world, account, { admin = false } = {}) {
  if (!isPrivateWorld(world)) return;
  const isMember = account ? await isWorldMember(prisma, world.id, account.id) : false;
  if (!mayReadWorld(world, { account, isMember })) throw privateWorldError();
  // A member, but of a supporter world: the badge has to be on too. Supporter
  // worlds are always PRIVATE (worldService forces it), so this never runs
  // for a public world and never costs a spectator anything.
  assertSupporterAccess(world, account, { admin });
}
