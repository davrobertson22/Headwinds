// /worlds/:id/used-aircraft — the used aircraft market.
//
// GET  /worlds/:id/used-aircraft          → the world's open inventory (public)
// POST /worlds/:id/used-aircraft/:lid/buy → buy a listing at its frozen NAV; the
//                                           tail arrives on the next weekly tick.
// POST /worlds/:id/used-aircraft/buy      → buy several listings in one request
//                                           ({ listingIds }, at most USED_BATCH_MAX).
//                                           Ones that can't be had are skipped and
//                                           reported; the rest go through.
//
// Selling is NOT here — it rides the normal SELL_AIRCRAFT decision, which the
// decisions route lists into this market in the same transaction.
import { requireAuth, optionalAccount } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { assertWorldReadable } from '../lib/access.mjs';
import { allow } from '../lib/rateLimit.mjs';
import { buildWorldRivalViews, withRivals, RIVAL_ROWS_MAX_STALE_MS } from '../lib/humanRivals.mjs';
import { injectLogo } from '../lib/logoColumn.mjs';
import { joinReport } from '../lib/reportColumn.mjs';
import { buildUsedMarketView, buyUsed, buyUsedBatch, USED_BATCH_MAX } from '../lib/aircraftMarketService.mjs';

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
      // `visibility` rides along for the private-world gate below.
      select: { id: true, visibility: true },
    });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    await assertWorldReadable(prisma, world, await optionalAccount(request));
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
    return { ok: true, ...(await afterPurchase(world, airline, buyerState)) };
  });

  // ── Buy several listings at once (all deliver next tick) ──────────────────
  // One request, one transaction, one rival-view rebuild — instead of one of
  // each per jet, which is what made buying ten take minutes on a busy server.
  fastify.post('/worlds/:id/used-aircraft/buy', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          listingIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: USED_BATCH_MAX },
        },
        required: ['listingIds'],
      },
    },
  }, async (request) => {
    if (!allow(`used:${request.account.id}`, UM_LIMIT, UM_WINDOWMS)) {
      throw httpError(429, 'Too many market actions — slow down a moment.');
    }
    const { world, airline } = await loadWorldAndAirline(request);
    const { buyerState, bought, skipped } = await buyUsedBatch(prisma, {
      world, buyer: airline, listingIds: request.body.listingIds,
    });
    return {
      ok: true,
      bought:  bought.map(({ id, typeId, typeName, price }) => ({ id, typeId, typeName, price })),
      skipped: skipped.map(({ id, typeId, typeName, reason }) => ({ id, typeId, typeName, reason })),
      ...(await afterPurchase(world, airline, buyerState)),
    };
  });
}

// Re-render material after a purchase: the buyer's new state with the CURRENT
// rival view injected (same shape the decision endpoint returns), plus the
// refreshed market so the listings just bought disappear immediately. Rivals'
// blobs may be up to RIVAL_ROWS_MAX_STALE_MS old; the gate market, alliance graph
// and float pool are rebuilt fresh (lib/humanRivals.mjs).
async function afterPurchase(world, airline, buyerState) {
  const views = await buildWorldRivalViews(prisma, world.id,
    { world, rowsMaxStaleMs: RIVAL_ROWS_MAX_STALE_MS, forAirlineId: airline.id });
  const view = views.get(airline.id) ?? { competitors: [], humanRivals: {}, alliance: null };
  return {
    // injectLogo: buyerState came off the (key-free) DB blob — see gates.mjs.
    state: withRivals(injectLogo(joinReport(buyerState, airline.report), airline.customLogo), view),
    usedMarket: await buildUsedMarketView(prisma, world.id),
  };
}
