// /worlds/:id/used-aircraft — the used aircraft market.
//
// GET  /worlds/:id/used-aircraft          → the world's open inventory (public)
// POST /worlds/:id/used-aircraft/:lid/buy → buy a listing at its frozen NAV; the
//                                           tail arrives on the next weekly tick.
//
// Selling is NOT here — it rides the normal SELL_AIRCRAFT decision, which the
// decisions route lists into this market in the same transaction.
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { allow } from '../lib/rateLimit.mjs';
import { buildWorldRivalViews, withRivals } from '../lib/humanRivals.mjs';
import { buildUsedMarketView, buyUsed } from '../lib/aircraftMarketService.mjs';

const UM_LIMIT = 30;
const UM_WINDOWMS = 10_000;

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

async function loadWorldAndAirline(request) {
  const world = await prisma.world.findUnique({ where: { id: request.params.id } });
  if (!world) throw httpError(404, 'No such world');
  const airline = await prisma.airline.findUnique({
    where: { worldId_accountId: { worldId: world.id, accountId: request.account.id } },
  });
  if (!airline) throw httpError(404, 'You have no airline in this world');
  if (airline.status !== 'ACTIVE') throw httpError(409, `Your airline is ${airline.status}`);
  return { world, airline };
}

export default async function aircraftMarketRoutes(fastify) {
  // ── The world's open used-aircraft inventory ──────────────────────────────
  fastify.get('/worlds/:id/used-aircraft', {
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({
      where: { id: request.params.id },
      select: { id: true },
    });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    return buildUsedMarketView(prisma, world.id);
  });

  // ── Buy a listed used aircraft (delivers next tick) ───────────────────────
  fastify.post('/worlds/:id/used-aircraft/:lid/buy', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, lid: { type: 'string' } },
        required: ['id', 'lid'],
      },
    },
  }, async (request) => {
    if (!allow(`used:${request.account.id}`, UM_LIMIT, UM_WINDOWMS)) {
      throw httpError(429, 'Too many market actions — slow down a moment.');
    }
    const { world, airline } = await loadWorldAndAirline(request);
    const { buyerState } = await buyUsed(prisma, { world, buyer: airline, listingId: request.params.lid });
    // Re-render material: the buyer's new state with the CURRENT rival view
    // injected (same shape the decision endpoint returns), plus the refreshed
    // market so the listing that was just bought disappears immediately.
    const views = await buildWorldRivalViews(prisma, world.id, { world });
    const view = views.get(airline.id) ?? { competitors: [], humanRivals: {}, alliance: null };
    return {
      ok: true,
      state: withRivals(buyerState, view),
      usedMarket: await buildUsedMarketView(prisma, world.id),
    };
  });
}
