// /me — the current account and the airlines it controls across all worlds.
import { requireAuth, isAdmin } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { serializeAirline } from '../lib/worldConfig.mjs';
import { serializeCareer } from '../lib/career.mjs';
import { usernameProblem, RENAME_COOLDOWN_DAYS } from '../lib/username.mjs';

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const DAY_MS = 24 * 60 * 60 * 1000;

export default async function meRoutes(fastify) {
  fastify.get('/me', { preHandler: requireAuth }, async (request) => {
    const account = request.account;
    const airlines = await prisma.airline.findMany({
      where: { accountId: account.id },
      // Select only the scalar columns serializeAirline needs — NOT the large
      // `state` JSONB blob, which /me discards. Avoids pulling megabytes of state
      // (one blob per world the account is in) on every app boot / join / leave.
      select: {
        id: true, worldId: true, name: true, hub: true,
        cash: true, marketCap: true, week: true, status: true, joinedWeek: true,
        world: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    // Account-inbox unread count, piggybacked so the shell badge costs no
    // extra polling loop. Blocked senders don't count. Tolerant of a database
    // that predates the account-messages migration — the badge is not worth
    // failing the app's boot call over.
    let unreadMessages = 0;
    try {
      const blocks = await prisma.accountMessageBlock.findMany({
        where: { accountId: account.id },
        select: { blockedAccountId: true },
      });
      unreadMessages = await prisma.accountMessage.count({
        where: {
          toAccountId: account.id,
          readAt: null,
          ...(blocks.length > 0
            ? { fromAccountId: { notIn: blocks.map((b) => b.blockedAccountId) } }
            : {}),
        },
      });
    } catch (err) {
      request.log?.warn?.({ err }, 'unread account-message count unavailable');
    }

    return {
      account: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        // Admins may create worlds; the web client shows the create UI on this.
        // The server is the real gate (requireAdmin on POST /worlds).
        isAdmin: isAdmin(account),
        // OG veteran badge (playing since the original Tailwinds).
        isOG: account.isOG === true,
        // Claimed unique username (null until the account picks one from the
        // lobby). Display everywhere is username ?? displayName.
        username: account.username ?? null,
      },
      // Unread account-level DMs (the ✉ badge in the lobby header).
      unreadMessages,
      // Seasons finished, and what they came to. Badges are DERIVED here rather
      // than stored (see lib/career.mjs) so the rule can change without a
      // migration and the client can never disagree about who has earned one.
      career: serializeCareer(account.careerStats),
      // Your own worlds include their join code — you're a member.
      airlines: airlines.map((a) =>
        serializeAirline(a, { world: a.world, includeJoinCode: true })),
    };
  });

  // ── Claim or change the account's username ─────────────────────────────────
  // The first set is free; after that, one change per RENAME_COOLDOWN_DAYS —
  // a scammer has to wear a name long enough for reports to land on it. Every
  // set (the first claim included) writes a NameChange audit row the
  // moderation panel reads, so a rename never outruns a reputation.
  //
  // Uniqueness: pre-checked case-insensitively for a friendly error, but the
  // authority is the DB's unique index on lower("username") — two racing
  // claims resolve there, and the loser gets the same 409.
  fastify.post('/me/username', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string', minLength: 1, maxLength: 64 } },
      },
    },
  }, async (request) => {
    const account = request.account;
    const requested = request.body.username.trim();

    const problem = usernameProblem(requested);
    if (problem) throw httpError(422, problem);

    const current = account.username ?? null;
    if (current === requested) return { username: current }; // no-op, no audit row

    if (current != null) {
      const last = await prisma.nameChange.findFirst({
        where: { accountId: account.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last) {
        const elapsed = Date.now() - last.createdAt.getTime();
        const waitMs = RENAME_COOLDOWN_DAYS * DAY_MS - elapsed;
        if (waitMs > 0) {
          const days = Math.max(1, Math.ceil(waitMs / DAY_MS));
          throw httpError(429,
            `You can change your username again in ${days} day${days === 1 ? '' : 's'}.`);
        }
      }
    }

    // Friendly pre-check (a case-only change of your OWN name passes).
    const clash = await prisma.account.findFirst({
      where: {
        username: { equals: requested, mode: 'insensitive' },
        NOT: { id: account.id },
      },
      select: { id: true },
    });
    if (clash) throw httpError(409, 'That username is taken.');

    try {
      await prisma.$transaction([
        prisma.account.update({ where: { id: account.id }, data: { username: requested } }),
        prisma.nameChange.create({
          data: { accountId: account.id, oldName: current, newName: requested },
        }),
      ]);
    } catch (e) {
      // The race the pre-check cannot cover: both unique indexes surface as
      // P2002 through Prisma, or 23505 straight from Postgres via raw paths.
      if (e?.code === 'P2002' || e?.meta?.code === '23505') {
        throw httpError(409, 'That username is taken.');
      }
      throw e;
    }
    return { username: requested };
  });
}
