// /worlds — browse, view, create, join, and leave worlds.
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { createWorld, joinWorld } from '../lib/worldService.mjs';
import {
  serializeWorld, serializeAirline, LENGTH_YEARS, WEEKS_PER_DAY,
} from '../lib/worldConfig.mjs';

export default async function worldRoutes(fastify) {
  // ── List public worlds (with optional tier filters) ───────────────────────
  fastify.get('/worlds', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['LOBBY', 'RUNNING', 'ENDED', 'ARCHIVED'] },
          length: { type: 'integer', enum: LENGTH_YEARS },
          pace: { type: 'integer', enum: WEEKS_PER_DAY },
        },
      },
    },
  }, async (request) => {
    const { status, length, pace } = request.query;
    const where = {
      visibility: 'PUBLIC',
      status: status ?? { in: ['LOBBY', 'RUNNING'] },
      ...(length ? { lengthYears: length } : {}),
      ...(pace ? { weeksPerDay: pace } : {}),
    };
    const worlds = await prisma.world.findMany({
      where,
      include: { _count: { select: { airlines: true } } },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return { worlds: worlds.map((w) => serializeWorld(w, { playerCount: w._count.airlines })) };
  });

  // ── World detail + standings ──────────────────────────────────────────────
  fastify.get('/worlds/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({
      where: { id: request.params.id },
      include: { _count: { select: { airlines: true } } },
    });
    if (!world) return reply.code(404).send({ error: 'No such world' });

    const airlines = await prisma.airline.findMany({
      where: { worldId: world.id },
      orderBy: { marketCap: 'desc' },
      take: 100,
    });
    return {
      world: serializeWorld(world, { playerCount: world._count.airlines }),
      standings: airlines.map((a, i) => ({ rank: i + 1, ...serializeAirline(a) })),
    };
  });

  // ── Create a world ────────────────────────────────────────────────────────
  fastify.post('/worlds', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['lengthYears', 'weeksPerDay'],
        properties: {
          name: { type: 'string', maxLength: 60 },
          lengthYears: { type: 'integer', enum: LENGTH_YEARS },
          weeksPerDay: { type: 'integer', enum: WEEKS_PER_DAY },
          visibility: { type: 'string', enum: ['PUBLIC', 'PRIVATE'] },
          maxPlayers: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const world = await createWorld(prisma, request.body);
    return reply.code(201).send({ world: serializeWorld(world, { playerCount: 0 }) });
  });

  // ── Join a world (creates your airline) ───────────────────────────────────
  fastify.post('/worlds/:id/join', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['airlineName', 'hub'],
        properties: {
          airlineName: { type: 'string', minLength: 1, maxLength: 40 },
          hub: { type: 'string', minLength: 3, maxLength: 4 },
          joinCode: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });

    const airline = await joinWorld(prisma, {
      account: request.account,
      world,
      airlineName: request.body.airlineName,
      hub: request.body.hub.toUpperCase(),
      joinCode: request.body.joinCode,
    });
    return reply.code(201).send({ airline: serializeAirline(airline) });
  });

  // ── Leave / abandon your airline in a world ───────────────────────────────
  fastify.post('/worlds/:id/leave', {
    preHandler: requireAuth,
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    const airline = await prisma.airline.findUnique({
      where: { worldId_accountId: { worldId: request.params.id, accountId: request.account.id } },
    });
    if (!airline) return reply.code(404).send({ error: 'You are not in this world' });

    await prisma.airline.update({
      where: { id: airline.id },
      data: { status: 'ABANDONED' },
    });
    return { ok: true };
  });
}
