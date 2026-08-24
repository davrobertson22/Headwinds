// /players/:accountId — a player's public, cross-world profile.
//
// The account-level face of the game: what someone is flying now, what they
// have won, how many seasons they have survived — assembled for OTHER players
// to look at, which makes this endpoint an exercise in what NOT to send. The
// rules (Dave, 2026-08-24 — PLAYER_PROFILES_PLAN.md):
//
//   - Signed-in players only (requireAuth). Profiles are community-facing,
//     not public web pages.
//   - PRIVATE worlds are invisible: current airlines are filtered on the
//     World join in the database; finished seasons go through publicCareer(),
//     which recomputes totals and badges from the public subset and FAILS
//     CLOSED on any world it cannot resolve.
//   - Podium or nothing: a finished season carries place 1–3 or reads
//     "Played". Redacted server-side in publicCareer, never in the client.
//   - A banned account's profile is a 404. The ban already blocks the account
//     everywhere; its profile should not remain standing.
//
// Scalar columns only throughout — the ~500 kB state blobs never leave the
// database for a profile view (same discipline as /me and the rivals
// endpoint).
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { normalizeCareer, publicCareer } from '../lib/career.mjs';
import { isDevEmail } from '../lib/humanRivals.mjs';
import { dmRefusal } from '../lib/accountMessaging.mjs';
import { sharesWorld } from './accountMessages.mjs';

const toNum = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0);

export default async function playerRoutes(fastify) {
  fastify.get('/players/:accountId', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
        required: ['accountId'],
      },
    },
  }, async (request, reply) => {
    const account = await prisma.account.findUnique({
      where: { id: request.params.accountId },
      select: {
        id: true, displayName: true, username: true, isOG: true, email: true,
        createdAt: true, bannedAt: true, careerStats: true, dmPolicy: true,
      },
    });
    if (!account || account.bannedAt) {
      return reply.code(404).send({ error: 'No such player' });
    }

    // Whether the viewer can actually DM this player, resolved the SAME way the
    // send path does (dmRefusal + sharesWorld) so the profile's Message button
    // reflects reality instead of dead-ending in a 403 after the user has
    // written the message. NOBODY → button hidden; SHARED_WORLD without a
    // shared world → hidden; yourself → hidden. Per-click endpoint, so the
    // extra shared-world lookup is cheap.
    const isSelf = request.account.id === account.id;
    // Only SHARED_WORLD (the default) needs the shared-world lookup; EVERYONE
    // and NOBODY are decided by the policy alone, so skip the two queries then.
    const needsShared = account.dmPolicy == null || account.dmPolicy === 'SHARED_WORLD';
    const shares = !isSelf && needsShared
      ? await sharesWorld(request.account.id, account.id) : false;
    const canMessage = !isSelf
      && dmRefusal(account.dmPolicy, { sharesWorld: shares }) === null;

    // Currently flying: every airline in a PUBLIC world that is still going.
    // ENDED worlds live in the finished-seasons list instead; PRIVATE worlds
    // are filtered in the database and never counted anywhere. Bankrupt and
    // abandoned airlines in running worlds stay — a bust in progress is
    // already visible in that world's standings, and `status` lets the UI
    // badge it.
    const airlines = await prisma.airline.findMany({
      where: {
        accountId: account.id,
        world: { visibility: 'PUBLIC', status: { in: ['LOBBY', 'RUNNING'] } },
      },
      select: {
        id: true, worldId: true, name: true, hub: true, status: true,
        week: true, svps: true, joinedWeek: true,
        world: { select: { name: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Latest rank per airline: one point query each on the [airlineId, week]
    // index. Null (pre-first-tick, or never ranked) renders as a dash — the
    // same convention career records use for private airlines.
    const latestRanks = await Promise.all(airlines.map((a) =>
      prisma.standing.findFirst({
        where: { worldId: a.worldId, airlineId: a.id },
        orderBy: { week: 'desc' },
        select: { rank: true },
      }).catch(() => null)));

    // Career records banked before the profile feature predate the stored
    // `visibility` field — resolve those worlds by primary key. A world that
    // cannot be found resolves to nothing, and publicCareer treats nothing as
    // PRIVATE: fail closed.
    const stored = normalizeCareer(account.careerStats);
    const unresolved = Object.values(stored.worlds)
      .filter((w) => w?.visibility == null)
      .map((w) => w.worldId);
    let visibilityByWorldId = new Map();
    if (unresolved.length > 0) {
      const rows = await prisma.world.findMany({
        where: { id: { in: unresolved } },
        select: { id: true, visibility: true },
      });
      visibilityByWorldId = new Map(rows.map((r) => [r.id, r.visibility]));
    }

    const career = publicCareer(account.careerStats, visibilityByWorldId);

    return {
      player: {
        id: account.id,
        // Display = username ?? displayName, resolved here so every client
        // renders the claimed name without knowing the rule.
        displayName: account.username ?? account.displayName,
        username: account.username ?? null,
        isOG: account.isOG === true,
        // The email itself never leaves the server — only this comparison.
        dev: isDevEmail(account.email),
        memberSince: account.createdAt,
        // Does the VIEWER's DM to this player currently pass the policy? Drives
        // whether the profile shows an active Message button (see PlayerProfile).
        canMessage,
      },
      // totals, badges, trophies, seasons — the public subset only.
      ...career,
      current: airlines.map((a, i) => ({
        worldId: a.worldId,
        worldName: a.world?.name ?? null,
        worldStatus: a.world?.status ?? null,
        airlineId: a.id,
        airlineName: a.name,
        hub: a.hub,
        status: a.status,
        week: a.week,
        rank: latestRanks[i]?.rank ?? null,
        // Per-share shareholder value in dollars — same scaling the world
        // standings serializer uses.
        svps: toNum(a.svps) / 10_000,
      })),
    };
  });
}
