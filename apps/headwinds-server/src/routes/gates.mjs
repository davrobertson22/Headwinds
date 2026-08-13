// /worlds/:id/gates — gate scarcity: availability, sealed auction bids, and the
// player-to-player gate marketplace. Only meaningful in worlds created with
// tickConfig.gateScarcity; every route 409s cleanly elsewhere.
import { requireAuth, optionalAccount } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { assertWorldReadable } from '../lib/access.mjs';
import { allow } from '../lib/rateLimit.mjs';
import { GATE_BID_MAX_QTY } from '@tailwinds/engine/data/airports.js';
import { buildWorldRivalViews, withRivals, loadAllianceMap, loadRivalRows } from '../lib/humanRivals.mjs';
import {
  isGateScarcity, buildGateMarketViews, gateWorldSummary,
  placeBid, withdrawBid, createListing, withdrawListing, buyListing,
} from '../lib/gateService.mjs';

const GATE_LIMIT = 30;
const GATE_WINDOWMS = 10_000;

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

async function loadWorldAndAirline(request) {
  const world = await prisma.world.findUnique({ where: { id: request.params.id } });
  if (!world) throw httpError(404, 'No such world');
  if (!isGateScarcity(world)) throw httpError(409, 'This world does not use gate scarcity.');
  const airline = await prisma.airline.findUnique({
    where: { worldId_accountId: { worldId: world.id, accountId: request.account.id } },
  });
  if (!airline) throw httpError(404, 'You have no airline in this world');
  if (airline.status !== 'ACTIVE') throw httpError(409, `Your airline is ${airline.status}`);
  return { world, airline };
}

// The caller's fresh personalized gate-market view (post-mutation) so the UI
// updates instantly instead of waiting for the next poll. State-bearing rows
// (projected — histories trimmed in Postgres) because the alliance slot pool
// derives every member's usage from their blobs.
async function gateMarketFor(world, airlineId) {
  const rows = await loadRivalRows(prisma, world.id);
  const allianceMap = await loadAllianceMap(prisma, world.id);
  const views = await buildGateMarketViews(prisma, world.id, { airlines: rows, allianceMap, world });
  return views.get(airlineId) ?? { week: null, airports: {}, slotPool: {} };
}

const rateLimited = (request) => {
  if (!allow(`gates:${request.account.id}`, GATE_LIMIT, GATE_WINDOWMS)) {
    throw httpError(429, 'Too many gate-market actions — slow down a moment.');
  }
};

export default async function gateRoutes(fastify) {
  // ── Availability summary (world lobby / hub picker) ────────────────────────
  fastify.get('/worlds/:id/gates', {
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    // Unauthenticated by design for a PUBLIC world (the hub picker reads it
    // before you join); members-only for a PRIVATE one.
    await assertWorldReadable(prisma, world, await optionalAccount(request));
    if (!isGateScarcity(world)) return { gateScarcity: false, airports: [] };
    return { gateScarcity: true, airports: await gateWorldSummary(prisma, world.id) };
  });

  // ── Alliance slot pool: share / reserve your spare slots at one airport ───
  // The owner's switch. Turning sharing OFF (or raising the reserve) never
  // insta-kills a partner's flights: their grant shrinks on the next view
  // build and the ENGINE gives them the 4-week squeeze countdown before
  // trimming — that countdown IS the wind-down.
  fastify.put('/worlds/:id/gates/:code/share', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, code: { type: 'string', minLength: 3, maxLength: 4 } },
        required: ['id', 'code'],
      },
      body: {
        type: 'object',
        required: ['sharing'],
        properties: {
          sharing: { type: 'boolean' },
          reservedSlots: { type: 'integer', minimum: 0, maximum: 100000 },
        },
      },
    },
  }, async (request) => {
    rateLimited(request);
    const { world, airline } = await loadWorldAndAirline(request);
    const code = request.params.code.toUpperCase();

    const allianceMap = await loadAllianceMap(prisma, world.id);
    if (!allianceMap.get(airline.id)) {
      throw httpError(409, 'Slot sharing is an alliance benefit — join or found an alliance first.');
    }
    if (!((airline.state?.gates?.[code] ?? 0) > 0)) {
      throw httpError(409, `You hold no gates at ${code}.`);
    }

    await prisma.gateSlotShare.upsert({
      where: { airlineId_airportCode: { airlineId: airline.id, airportCode: code } },
      create: {
        worldId: world.id,
        airlineId: airline.id,
        airportCode: code,
        sharing: request.body.sharing === true,
        reservedSlots: Math.max(0, Math.round(request.body.reservedSlots ?? 0)),
      },
      update: {
        sharing: request.body.sharing === true,
        reservedSlots: Math.max(0, Math.round(request.body.reservedSlots ?? 0)),
      },
    });
    // Bump the owner's version so every member's world stamp moves and the new
    // pool shows up on their next poll (same trick as gate listings).
    await prisma.airline.update({ where: { id: airline.id }, data: { version: { increment: 1 } } });
    return { ok: true, gateMarket: await gateMarketFor(world, airline.id) };
  });

  // ── Sealed auction bid: place / update ────────────────────────────────────
  fastify.post('/worlds/:id/gates/:code/bid', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, code: { type: 'string', minLength: 3, maxLength: 4 } },
        required: ['id', 'code'],
      },
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number', minimum: 1 },
          // Outer bound only — placeBid() also caps at the auction's lot count.
          quantity: { type: 'integer', minimum: 1, maximum: GATE_BID_MAX_QTY },
        },
      },
    },
  }, async (request) => {
    rateLimited(request);
    const { world, airline } = await loadWorldAndAirline(request);
    await placeBid(prisma, {
      world, airline,
      airportCode: request.params.code.toUpperCase(),
      amount: request.body.amount,
      quantity: request.body.quantity ?? 1,
      // Needed for the 80% combined cap — without it an allied airline could
      // place a bid the auction would never be allowed to award.
      allianceMap: await loadAllianceMap(prisma, world.id),
    });
    return { ok: true, gateMarket: await gateMarketFor(world, airline.id) };
  });

  // ── Withdraw a sealed bid ─────────────────────────────────────────────────
  fastify.delete('/worlds/:id/gates/:code/bid', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, code: { type: 'string', minLength: 3, maxLength: 4 } },
        required: ['id', 'code'],
      },
    },
  }, async (request) => {
    rateLimited(request);
    const { world, airline } = await loadWorldAndAirline(request);
    await withdrawBid(prisma, { world, airline, airportCode: request.params.code.toUpperCase() });
    return { ok: true, gateMarket: await gateMarketFor(world, airline.id) };
  });

  // ── List one of your gates for sale ───────────────────────────────────────
  fastify.post('/worlds/:id/gates/listings', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['airportCode', 'askPrice'],
        properties: {
          airportCode: { type: 'string', minLength: 3, maxLength: 4 },
          askPrice: { type: 'number', minimum: 1 },
        },
      },
    },
  }, async (request) => {
    rateLimited(request);
    const { world, airline } = await loadWorldAndAirline(request);
    await createListing(prisma, {
      world, airline,
      airportCode: request.body.airportCode.toUpperCase(),
      askPrice: request.body.askPrice,
    });
    return { ok: true, gateMarket: await gateMarketFor(world, airline.id) };
  });

  // ── Withdraw your listing ─────────────────────────────────────────────────
  fastify.delete('/worlds/:id/gates/listings/:lid', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, lid: { type: 'string' } },
        required: ['id', 'lid'],
      },
    },
  }, async (request) => {
    rateLimited(request);
    const { world, airline } = await loadWorldAndAirline(request);
    await withdrawListing(prisma, { airline, listingId: request.params.lid });
    return { ok: true, gateMarket: await gateMarketFor(world, airline.id) };
  });

  // ── Buy a listed gate at the asking price ─────────────────────────────────
  fastify.post('/worlds/:id/gates/listings/:lid/buy', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, lid: { type: 'string' } },
        required: ['id', 'lid'],
      },
    },
  }, async (request) => {
    rateLimited(request);
    const { world, airline } = await loadWorldAndAirline(request);
    const allianceMap = await loadAllianceMap(prisma, world.id);
    const { buyerState } = await buyListing(prisma, {
      world, buyer: airline, listingId: request.params.lid, allianceMap,
    });
    // Re-render material: the buyer's new state with the CURRENT rival view
    // injected (same shape the decision endpoint returns).
    const views = await buildWorldRivalViews(prisma, world.id, { world });
    const view = views.get(airline.id) ?? { competitors: [], humanRivals: {}, alliance: null };
    return {
      ok: true,
      state: withRivals(buyerState, view),
      gateMarket: await gateMarketFor(world, airline.id),
    };
  });
}
