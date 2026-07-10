// /worlds — browse, view, create, join, and leave worlds.
import { requireAuth, resolveAccount } from '../auth.mjs';
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

    // Optional auth: members of a private world get its join code back (so the
    // creator can re-find it to share); everyone else never sees it.
    let isMember = false;
    try {
      const account = await resolveAccount(request);
      isMember = airlines.some((a) => a.accountId === account.id);
    } catch { /* anonymous viewer */ }

    return {
      world: serializeWorld(world, {
        playerCount: world._count.airlines,
        includeJoinCode: isMember,
      }),
      standings: airlines.map((a, i) => ({
        rank: i + 1,
        ...serializeAirline(a),
        // Public network-size signals for the rivals view.
        routes: a.state?.routes?.length ?? 0,
        fleet: a.state?.fleet?.length ?? 0,
      })),
    };
  });

  // ── Rival profile: an airline's PUBLIC view ────────────────────────────────
  // What any player (or spectator) can see about a rival: their route network
  // with fares and frequencies (public information at any real airport), fleet
  // composition, rank history, and recent visible moves. Never exposes private
  // internals like cash-flow detail, loans, hedges, or marketing budgets.
  const PUBLIC_DECISIONS = new Set([
    'ADD_ROUTE', 'CLOSE_ROUTE', 'ADD_CARGO_ROUTE', 'CLOSE_CARGO_ROUTE',
    'LEASE_AIRCRAFT', 'BUY_AIRCRAFT', 'SELL_AIRCRAFT', 'RETIRE_AIRCRAFT', 'ORDER_AIRCRAFT',
    'ADD_GATE', 'UPGRADE_HUB', 'DESIGNATE_HUB', 'DESIGNATE_FOCUS_CITY',
    'JOIN_ALLIANCE', 'LEAVE_ALLIANCE',
  ]);
  // Only the payload fields that describe a PUBLIC move — never echo payloads raw.
  const publicPayload = (d) => {
    const p = d.payload ?? {};
    return {
      ...(p.origin ? { origin: p.origin } : {}),
      ...(p.destination ? { destination: p.destination } : {}),
      ...(p.typeId ? { typeId: p.typeId } : {}),
      ...(p.airportCode ? { airportCode: p.airportCode } : {}),
      ...(p.allianceId ? { allianceId: p.allianceId } : {}),
    };
  };
  fastify.get('/worlds/:id/rivals/:airlineId', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, airlineId: { type: 'string' } },
        required: ['id', 'airlineId'],
      },
    },
  }, async (request, reply) => {
    const airline = await prisma.airline.findUnique({
      where: { id: request.params.airlineId },
    });
    if (!airline || airline.worldId !== request.params.id) {
      return reply.code(404).send({ error: 'No such airline in this world' });
    }
    const s = airline.state ?? {};

    const routes = (s.routes ?? []).map((r) => {
      const key = [r.origin, r.destination].sort().join('-');
      return {
        origin: r.origin,
        destination: r.destination,
        weeklyFrequency: r.weeklyFrequency ?? 0,
        economyFare: Math.round(s.routePricing?.[key]?.economy ?? r.ticketPrice ?? 0) || null,
      };
    });

    const fleetByType = {};
    for (const a of s.fleet ?? []) {
      fleetByType[a.typeId] = (fleetByType[a.typeId] ?? 0) + 1;
    }

    const [rankHistory, recentDecisions] = await Promise.all([
      prisma.standing.findMany({
        where: { worldId: airline.worldId, airlineId: airline.id },
        orderBy: { week: 'desc' },
        take: 26,
        select: { week: true, rank: true },
      }),
      prisma.decision.findMany({
        where: { worldId: airline.worldId, airlineId: airline.id },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
    ]);

    return {
      airline: { ...serializeAirline(airline), routes: routes.length, fleet: (s.fleet ?? []).length },
      hubs: Object.keys(s.hubs ?? {}),
      alliance: s.allianceMembership?.allianceId ?? null,
      routeNetwork: routes,
      fleetByType,
      rankHistory: rankHistory.reverse(),
      recentMoves: recentDecisions
        .filter((d) => PUBLIC_DECISIONS.has(d.type))
        .slice(0, 12)
        .map((d) => ({ week: d.week, type: d.type, payload: publicPayload(d) })),
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
    return reply.code(201).send({
      world: serializeWorld(world, { playerCount: 0, includeJoinCode: true }),
    });
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
