// /worlds — browse, view, create, join, and leave worlds.
import { requireAuth, requireAdmin, resolveAccount } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { createWorld, joinWorld } from '../lib/worldService.mjs';
import { isDevEmail } from '../lib/humanRivals.mjs';
import {
  serializeWorld, serializeAirline,
  MIN_LENGTH_YEARS, MAX_LENGTH_YEARS, MIN_WEEKS_PER_DAY, MAX_WEEKS_PER_DAY,
  MIN_STARTING_CAPITAL, MAX_STARTING_CAPITAL, MIN_DEMAND_MULT, MAX_DEMAND_MULT,
} from '../lib/worldConfig.mjs';

export default async function worldRoutes(fastify) {
  // ── List public worlds (with optional tier filters) ───────────────────────
  fastify.get('/worlds', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['LOBBY', 'RUNNING', 'ENDED', 'ARCHIVED'] },
          length: { type: 'integer', minimum: MIN_LENGTH_YEARS, maximum: MAX_LENGTH_YEARS },
          pace: { type: 'integer', minimum: MIN_WEEKS_PER_DAY, maximum: MAX_WEEKS_PER_DAY },
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
      // OG + DEV badges ride on the ACCOUNT, never the name string. The email
      // is only compared against ADMIN_EMAILS server-side — never emitted.
      include: { account: { select: { isOG: true, email: true } } },
    });

    // Alliance tags for the standings (ACTIVE memberships only).
    const worldAlliances = await prisma.alliance.findMany({
      where: { worldId: world.id },
      include: { members: { where: { status: 'ACTIVE' } } },
    });
    const allianceNameByAirline = new Map();
    for (const al of worldAlliances) {
      for (const m of al.members) allianceNameByAirline.set(m.airlineId, al.name);
    }

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
        alliance: allianceNameByAirline.get(a.id) ?? null,
        og: a.account?.isOG === true,
        dev: isDevEmail(a.account?.email),
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
      include: { account: { select: { isOG: true, email: true } } },
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

    const [rankHistory, recentDecisions, membership] = await Promise.all([
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
      prisma.allianceMember.findUnique({
        where: { airlineId: airline.id },
        include: { alliance: true },
      }),
    ]);

    return {
      airline: {
        ...serializeAirline(airline),
        routes: routes.length,
        fleet: (s.fleet ?? []).length,
        og: airline.account?.isOG === true,
        dev: isDevEmail(airline.account?.email),
      },
      hubs: Object.keys(s.hubs ?? {}),
      alliance: membership?.status === 'ACTIVE' ? membership.alliance.name : null,
      routeNetwork: routes,
      fleetByType,
      rankHistory: rankHistory.reverse(),
      recentMoves: recentDecisions
        .filter((d) => PUBLIC_DECISIONS.has(d.type))
        .slice(0, 12)
        .map((d) => ({ week: d.week, type: d.type, payload: publicPayload(d) })),
    };
  });

  // ── World activity feed: everyone's PUBLIC moves, newest first ─────────────
  // "This week in your world": route openings/closings, fleet moves, hub and
  // gate expansion, plus system events (players joining, alliances forming).
  // Built on the same PUBLIC_DECISIONS allowlist + payload scrubber as the
  // rival profile — nothing private (prices, budgets, loans) ever leaks here.
  fastify.get('/worlds/:id/feed', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: {
          before: { type: 'string' },                        // ISO cursor (createdAt)
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    const limit = request.query.limit ?? 40;
    const before = request.query.before ? new Date(request.query.before) : null;
    const cutoff = before && !Number.isNaN(before.getTime()) ? before : null;
    const beforeFilter = cutoff ? { createdAt: { lt: cutoff } } : {};

    const [decisions, airlines, alliances, allianceJoins] = await Promise.all([
      prisma.decision.findMany({
        where: {
          worldId: world.id,
          type: { in: [...PUBLIC_DECISIONS] },
          ...beforeFilter,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.airline.findMany({
        where: { worldId: world.id },
        select: {
          id: true, name: true, hub: true, status: true, createdAt: true,
          account: { select: { isOG: true, email: true } },
        },
      }),
      prisma.alliance.findMany({
        where: { worldId: world.id, ...beforeFilter },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.allianceMember.findMany({
        where: {
          status: 'ACTIVE',
          alliance: { worldId: world.id },
          ...beforeFilter,
        },
        include: { alliance: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const nameOf = new Map(airlines.map((a) => [a.id, a.name]));
    const ogOf = new Map(airlines.map((a) => [a.id, a.account?.isOG === true]));
    const devOf = new Map(airlines.map((a) => [a.id, isDevEmail(a.account?.email)]));
    const events = [
      ...decisions.map((d) => ({
        kind: 'move',
        at: d.createdAt.toISOString(),
        week: d.week,
        airlineId: d.airlineId,
        airline: nameOf.get(d.airlineId) ?? 'An airline',
        og: ogOf.get(d.airlineId) ?? false,
        dev: devOf.get(d.airlineId) ?? false,
        type: d.type,
        payload: publicPayload(d),
      })),
      ...airlines
        .filter((a) => (cutoff ? a.createdAt < cutoff : true))
        .map((a) => ({
          kind: 'joined',
          at: a.createdAt.toISOString(),
          airlineId: a.id,
          airline: a.name,
          og: a.account?.isOG === true,
          dev: isDevEmail(a.account?.email),
          hub: a.hub,
        })),
      ...alliances.map((al) => ({
        kind: 'alliance_founded',
        at: al.createdAt.toISOString(),
        alliance: al.name,
      })),
      // Founders are covered by alliance_founded — only report genuine joins.
      ...allianceJoins
        .filter((m) => m.role !== 'FOUNDER')
        .map((m) => ({
          kind: 'alliance_joined',
          at: m.createdAt.toISOString(),
          airlineId: m.airlineId,
          airline: nameOf.get(m.airlineId) ?? 'An airline',
          og: ogOf.get(m.airlineId) ?? false,
          dev: devOf.get(m.airlineId) ?? false,
          alliance: m.alliance.name,
        })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, limit);

    return {
      events,
      // Pass the oldest timestamp back as ?before= to page further into history.
      nextBefore: events.length === limit ? events[events.length - 1].at : null,
    };
  });

  // ── Create a world (ADMIN ONLY) ───────────────────────────────────────────
  // World supply is operator-controlled: the worker's spawner keeps public
  // worlds topped up, and only ADMIN_EMAILS accounts may create them by hand.
  fastify.post('/worlds', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['lengthYears', 'weeksPerDay'],
        properties: {
          name: { type: 'string', maxLength: 60 },
          lengthYears: { type: 'integer', minimum: MIN_LENGTH_YEARS, maximum: MAX_LENGTH_YEARS },
          weeksPerDay: { type: 'integer', minimum: MIN_WEEKS_PER_DAY, maximum: MAX_WEEKS_PER_DAY },
          visibility: { type: 'string', enum: ['PUBLIC', 'PRIVATE'] },
          maxPlayers: { type: 'integer', minimum: 1, maximum: 500 },
          // Admin-only per-world knobs (server also re-validates in worldConfig).
          startingCapital: { type: 'integer', minimum: MIN_STARTING_CAPITAL, maximum: MAX_STARTING_CAPITAL },
          demandMultiplier: { type: 'number', minimum: MIN_DEMAND_MULT, maximum: MAX_DEMAND_MULT },
          // Optional scheduled start (ISO date-time string); real validation in worldConfig.
          scheduledStartAt: { type: 'string', maxLength: 40 },
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

  // ── Archive a world (ADMIN — reversible) ──────────────────────────────────
  // Hides it from the lobby and stops ticks (the scheduler only advances RUNNING
  // worlds). Remembers the prior status + archive instant in tickConfig so
  // unarchive can restore it and resume a paused RUNNING world at the same
  // game-week (no phantom catch-up for the paused span).
  fastify.post('/worlds/:id/archive', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    if (world.status === 'ARCHIVED') return reply.code(409).send({ error: 'World is already archived' });
    const updated = await prisma.world.update({
      where: { id: world.id },
      data: {
        status: 'ARCHIVED',
        tickConfig: { ...(world.tickConfig ?? {}), _prevStatus: world.status, _archivedAt: new Date().toISOString() },
      },
    });
    return { world: serializeWorld(updated, {}) };
  });

  // ── Unarchive / restore a world (ADMIN) ───────────────────────────────────
  fastify.post('/worlds/:id/unarchive', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    if (world.status !== 'ARCHIVED') return reply.code(409).send({ error: 'World is not archived' });
    const tc = { ...(world.tickConfig ?? {}) };
    const prev = tc._prevStatus;
    const archivedAt = tc._archivedAt ? new Date(tc._archivedAt) : null;
    delete tc._prevStatus; delete tc._archivedAt;
    const restored = (prev && prev !== 'ARCHIVED') ? prev : (world.startedAt ? 'RUNNING' : 'LOBBY');
    let startedAt = world.startedAt;
    let endsAt = world.endsAt;
    if (restored === 'RUNNING' && startedAt && archivedAt) {
      const delta = Date.now() - archivedAt.getTime();
      if (delta > 0) {
        startedAt = new Date(new Date(startedAt).getTime() + delta);
        endsAt = endsAt ? new Date(new Date(endsAt).getTime() + delta) : endsAt;
      }
    }
    const updated = await prisma.world.update({
      where: { id: world.id },
      data: { status: restored, tickConfig: tc, startedAt, endsAt },
    });
    return { world: serializeWorld(updated, {}) };
  });

  // ── Delete a world PERMANENTLY (ADMIN) ────────────────────────────────────
  // Hard delete. The schema cascades (onDelete: Cascade) so every airline,
  // standing, tick log, decision, alliance, message and report in this world is
  // removed too. Irreversible — the UI shows the player count and double-confirms.
  fastify.delete('/worlds/:id', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    await prisma.world.delete({ where: { id: world.id } });
    return { ok: true, deleted: world.id, name: world.name };
  });
}
