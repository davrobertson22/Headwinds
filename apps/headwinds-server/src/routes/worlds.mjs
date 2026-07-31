// /worlds — browse, view, create, join, and leave worlds.
import { requireAuth, requireAdmin, resolveAccount } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { createWorld, joinWorld } from '../lib/worldService.mjs';
import { restartAirline, MAX_RESTARTS } from '../lib/restartService.mjs';
import { isDevEmail } from '../lib/humanRivals.mjs';
// The public-move allowlist and payload scrubber are shared with the news feed
// (lib/newsService.mjs) — one definition of "what a rival may see", not two.
import { PUBLIC_DECISIONS, publicPayload } from '../lib/publicDecisions.mjs';
import { buildNews } from '../lib/newsService.mjs';
import { allow } from '../lib/rateLimit.mjs';

// Join/leave are rare, deliberate actions — 20 per minute per account is far
// above any real use and stops join/leave churn from spamming inserts/deletes.
const MEMBERSHIP_LIMIT   = 20;
const MEMBERSHIP_WINDOWMS = 60_000;
import {
  serializeWorld, serializeAirline,
  MIN_LENGTH_YEARS, MAX_LENGTH_YEARS, MIN_WEEKS_PER_DAY, MAX_WEEKS_PER_DAY,
  MIN_STARTING_CAPITAL, MAX_STARTING_CAPITAL, MIN_DEMAND_MULT, MAX_DEMAND_MULT,
  WORLD_STAGES, DEFAULT_WORLD_STAGE,
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

    // Egress-aware: the lobby polls this endpoint, and the state blob is by far
    // the heaviest thing on an airline row — but standings only need two counts
    // from it. Compute those counts IN the database (jsonb_array_length) so the
    // blobs never leave Supabase. OG + DEV badges ride on the ACCOUNT, never the
    // name string; the email is only compared against ADMIN_EMAILS server-side —
    // never emitted.
    const airlines = await prisma.$queryRaw`
      SELECT a.id, a."worldId", a."accountId", a.name, a.hub, a.cash, a."marketCap",
             a.shares, a.svps,
             a.week, a.status::text AS status, a."joinedWeek",
             CASE WHEN jsonb_typeof(a.state->'routes') = 'array'
                  THEN jsonb_array_length(a.state->'routes') ELSE 0 END AS routes,
             CASE WHEN jsonb_typeof(a.state->'fleet') = 'array'
                  THEN jsonb_array_length(a.state->'fleet') ELSE 0 END AS fleet,
             acc."isOG" AS og, acc.email AS email
      FROM "Airline" a
      JOIN "Account" acc ON acc.id = a."accountId"
      WHERE a."worldId" = ${world.id}
      ORDER BY a."svps" DESC
      LIMIT 100`;

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
        id: a.id,
        worldId: a.worldId,
        name: a.name,
        hub: a.hub,
        cash: Number(a.cash),
        marketCap: Number(a.marketCap),
        shares: Number(a.shares),
        // Per-share shareholder value in dollars — what `rank` is ordered by.
        svps: Number(a.svps) / 10_000,
        week: a.week,
        status: a.status,
        joinedWeek: a.joinedWeek,
        // Public network-size signals for the rivals view (computed in-DB).
        routes: Number(a.routes),
        fleet: Number(a.fleet),
        alliance: allianceNameByAirline.get(a.id) ?? null,
        og: a.og === true,
        dev: isDevEmail(a.email),
      })),
    };
  });

  // ── Rival profile: an airline's PUBLIC view ────────────────────────────────
  // What any player (or spectator) can see about a rival: their passenger route
  // network with fares and frequencies and their freight lanes with published
  // rates (public information at any real airport), fleet composition, rank
  // history, and recent visible moves. Never exposes private
  // internals like cash-flow detail, loans, hedges, or marketing budgets.
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

    // Freight lanes are public for the same reason passenger schedules are — a
    // freighter turning at a ramp is not a secret. Tonnes carried, load factor
    // and per-lane margin stay private and are deliberately absent.
    const cargoNetwork = (s.cargoRoutes ?? []).map((r) => ({
      origin: r.origin,
      destination: r.destination,
      weeklyFrequency: r.weeklyFrequency ?? 0,
      yieldPrice: r.yieldPrice ?? null,
    }));

    const fleetByType = {};
    for (const a of s.fleet ?? []) {
      fleetByType[a.typeId] = (fleetByType[a.typeId] ?? 0) + 1;
    }

    // A re-founded airline reuses its database row, so its Standing and Decision
    // rows still carry everything the company it replaced ever did. Unfiltered,
    // the rank chart would splice the dead carrier's curve onto the new one
    // (with a gap for the weeks it spent bankrupt) and "recent moves" would
    // attribute its route openings and fleet orders to a player who was not
    // flying at the time. Scope both to this generation. Never restarted →
    // restartedWeek is null → joinedWeek → the whole history, as before.
    const generationStart = airline.restartedWeek ?? airline.joinedWeek ?? 0;

    const [rankHistory, recentDecisions, membership] = await Promise.all([
      prisma.standing.findMany({
        where: { worldId: airline.worldId, airlineId: airline.id, week: { gte: generationStart } },
        orderBy: { week: 'desc' },
        take: 26,
        select: { week: true, rank: true },
      }),
      prisma.decision.findMany({
        where: { worldId: airline.worldId, airlineId: airline.id, week: { gte: generationStart } },
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
      cargoNetwork,
      fleetByType,
      rankHistory: rankHistory.reverse(),
      recentMoves: recentDecisions
        .filter((d) => PUBLIC_DECISIONS.has(d.type))
        .slice(0, 12)
        .map((d) => ({ week: d.week, type: d.type, payload: publicPayload(d) })),
    };
  });

  // ── World activity ticker (legacy alias) ───────────────────────────────────
  // Superseded by GET /worlds/:id/news, which composes the same sources but
  // rolls related moves into one item, tiers them by importance, and adds the
  // world economy, the used-aircraft market, bankruptcies, rank changes and the
  // share tape. This endpoint stays so a browser tab left open on an older build
  // keeps working; it returns the top headlines under the legacy `events` key.
  fastify.get('/worlds/:id/feed', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: {
          before: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    const { items, nextBefore } = await buildNews(prisma, {
      world,
      before: request.query.before,
      limit: request.query.limit ?? 40,
    });
    return { events: items, nextBefore };
  });

  // ── Create a world (ADMIN ONLY) ───────────────────────────────────────────
  // World supply is operator-controlled: only ADMIN_EMAILS accounts may create
  // worlds (the auto-spawner was removed 2026-07-19 — admin-created only).
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
          // Optional gate scarcity (finite airport capacity, auctions, gate market).
          gateScarcity: { type: 'boolean' },
          newWorldRestrictions: { type: 'boolean' },
          // Cosmetic maturity label: alpha | beta | live (default beta).
          stage: { type: 'string', enum: WORLD_STAGES },
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
    if (!allow(`join:${request.account.id}`, MEMBERSHIP_LIMIT, MEMBERSHIP_WINDOWMS)) {
      return reply.code(429).send({ error: 'Too many join/leave attempts — try again shortly.' });
    }
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

  // ── Restart: re-found a bankrupt or abandoned airline ─────────────────────
  // Going under used to end your season in that world. It now costs you the
  // company — fleet, network, cash, board objectives, alliance seat, gates and
  // any stock rivals held in you — but not your seat at the table, up to
  // MAX_RESTARTS times.
  //
  // Deliberately a SEPARATE endpoint from join rather than a status-aware
  // branch inside it. Join creates; this one demolishes and rewrites, and the
  // demolition (restartService.purgeAirlineFootprint) is the entire risk of the
  // feature — folding it into join would put an irreversible teardown one bad
  // conditional away from running on a healthy airline.
  fastify.post('/worlds/:id/restart', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['airlineName', 'hub'],
        properties: {
          airlineName: { type: 'string', minLength: 1, maxLength: 40 },
          hub: { type: 'string', minLength: 3, maxLength: 4 },
        },
      },
    },
  }, async (request, reply) => {
    // Shares the join/leave bucket on purpose: a restart is the same class of
    // rare, deliberate membership action, and it is far more expensive to serve.
    if (!allow(`join:${request.account.id}`, MEMBERSHIP_LIMIT, MEMBERSHIP_WINDOWMS)) {
      return reply.code(429).send({ error: 'Too many join/leave attempts — try again shortly.' });
    }
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });

    const airline = await prisma.airline.findUnique({
      where: { worldId_accountId: { worldId: world.id, accountId: request.account.id } },
    });

    const updated = await restartAirline(prisma, {
      account: request.account,
      world,
      airline,
      airlineName: request.body.airlineName,
      hub: request.body.hub.toUpperCase(),
      log: request.log ?? console,
    });

    // No explicit rival-view invalidation needed. The world stamp is DERIVED
    // (a sum of airline versions, memoised for 2.5s in routes/decisions.mjs),
    // and the restart increments this airline's version — so the stamp moves on
    // its own well inside the client's ~25s poll, and every open client picks up
    // the re-founded airline without a cross-route import of the cache handle.
    return reply.code(200).send({ airline: serializeAirline(updated), maxRestarts: MAX_RESTARTS });
  });

  // ── Leave / abandon your airline in a world ───────────────────────────────
  fastify.post('/worlds/:id/leave', {
    preHandler: requireAuth,
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request, reply) => {
    if (!allow(`join:${request.account.id}`, MEMBERSHIP_LIMIT, MEMBERSHIP_WINDOWMS)) {
      return reply.code(429).send({ error: 'Too many join/leave attempts — try again shortly.' });
    }
    const airline = await prisma.airline.findUnique({
      where: { worldId_accountId: { worldId: request.params.id, accountId: request.account.id } },
      include: { world: true },
    });
    if (!airline) return reply.code(404).send({ error: 'You are not in this world' });

    await prisma.airline.update({
      where: { id: airline.id },
      data: { status: 'ABANDONED' },
    });
    // Gate scarcity: an abandoned airline's gates return to every airport's
    // pool (and its open listings are withdrawn).
    if (airline.world?.tickConfig?.gateScarcity === true) {
      const { releaseAllFor } = await import('../lib/gateService.mjs');
      await releaseAllFor(prisma, airline.worldId, airline.id);
    }
    return { ok: true };
  });

  // ── Set a world's maturity stage (ADMIN — reversible) ─────────────────────
  // Cosmetic only: alpha shows a loud ⚗ ALPHA chip, beta a muted BETA one, live
  // no chip at all. No rule depends on it, so unlike gateScarcity and
  // newWorldRestrictions it is safe to change on a world that's already running.
  fastify.post('/worlds/:id/stage', {
    preHandler: requireAdmin,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: WORLD_STAGES } } },
    },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    const tc = { ...(world.tickConfig ?? {}) };
    const { stage } = request.body;
    // Drop the key at the default rather than storing it, so tickConfig stays a
    // record of what was actually changed. The legacy `alpha` boolean goes too —
    // leave it and worldStageOf() would fall back to it and undo this write.
    if (stage === DEFAULT_WORLD_STAGE) delete tc.stage; else tc.stage = stage;
    delete tc.alpha;
    const updated = await prisma.world.update({
      where: { id: world.id },
      data: { tickConfig: tc },
    });
    return { world: serializeWorld(updated, {}) };
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
