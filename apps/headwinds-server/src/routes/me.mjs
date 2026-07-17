// /me — the current account and the airlines it controls across all worlds.
import { requireAuth, isAdmin } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { serializeAirline } from '../lib/worldConfig.mjs';

export default async function meRoutes(fastify) {
  fastify.get('/me', { preHandler: requireAuth }, async (request) => {
    const account = request.account;
    const airlines = await prisma.airline.findMany({
      where: { accountId: account.id },
      include: { world: true },
      orderBy: { createdAt: 'desc' },
    });
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
      },
      // Your own worlds include their join code — you're a member.
      airlines: airlines.map((a) =>
        serializeAirline(a, { world: a.world, includeJoinCode: true })),
    };
  });
}
