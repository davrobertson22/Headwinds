// /me — the current account and the airlines it controls across all worlds.
import { requireAuth } from '../auth.mjs';
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
      },
      // Your own worlds include their join code — you're a member.
      airlines: airlines.map((a) =>
        serializeAirline(a, { world: a.world, includeJoinCode: true })),
    };
  });
}
