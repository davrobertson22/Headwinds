// /worlds/:id/messages — in-game messaging.
//
// Two channels:
//   DM        airline → airline private messages, threaded per counterpart,
//             with unread markers (Message.readAt).
//   ALLIANCE  a shared board for your alliance's ACTIVE members; read state is
//             a per-airline cursor (MessageCursor.allianceSeenAt).
//
// Guardrails: 1000-char bodies (schema-enforced), a rolling rate limit across
// both channels, and a block list — a blocked sender gets a clear 403 rather
// than shadow-dropped mail (an airline that won't deal with you is itself
// information in a competition game).
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { isDevEmail } from '../lib/humanRivals.mjs';

export const MESSAGE_RATE_LIMIT_PER_HOUR = 30;
export const MESSAGE_MAX_LENGTH = 1000;

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

async function loadMyAirline(request) {
  const airline = await prisma.airline.findUnique({
    where: {
      worldId_accountId: {
        worldId: request.params.id,
        accountId: request.account.id,
      },
    },
  });
  if (!airline) throw httpError(404, 'You have no airline in this world');
  return airline;
}

// ACTIVE alliance membership (or null).
async function myAlliance(airlineId) {
  const m = await prisma.allianceMember.findUnique({
    where: { airlineId },
    include: { alliance: true },
  });
  return m?.status === 'ACTIVE' ? m : null;
}

async function assertUnderRateLimit(airline) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const sent = await prisma.message.count({
    where: { worldId: airline.worldId, fromAirlineId: airline.id, createdAt: { gte: oneHourAgo } },
  });
  if (sent >= MESSAGE_RATE_LIMIT_PER_HOUR) {
    throw httpError(429, `Rate limit: max ${MESSAGE_RATE_LIMIT_PER_HOUR} messages per hour`);
  }
}

const idParams = (extra = {}) => ({
  type: 'object',
  properties: { id: { type: 'string' }, ...extra },
  required: ['id', ...Object.keys(extra)],
});

export default async function messageRoutes(fastify) {
  // ── Inbox summary: conversations + unread counts + blocks ─────────────────
  // One call drives the in-game badge and the drawer's Direct tab.
  fastify.get('/worlds/:id/messages', {
    preHandler: requireAuth,
    schema: { params: idParams() },
  }, async (request) => {
    const me = await loadMyAirline(request);
    const [dms, blocks, membership, airlines] = await Promise.all([
      prisma.message.findMany({
        where: {
          worldId: me.worldId,
          kind: 'DM',
          OR: [{ toAirlineId: me.id }, { fromAirlineId: me.id }],
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      prisma.messageBlock.findMany({ where: { airlineId: me.id } }),
      myAlliance(me.id),
      prisma.airline.findMany({
        where: { worldId: me.worldId },
        select: {
          id: true, name: true, hub: true, status: true,
          account: { select: { isOG: true, email: true } }, // OG + DEV badges (email stays server-side)
        },
      }),
    ]);
    const nameById = new Map(airlines.map((a) => [a.id, a.name]));
    const ogById = new Map(airlines.map((a) => [a.id, a.account?.isOG === true]));
    const devById = new Map(airlines.map((a) => [a.id, isDevEmail(a.account?.email)]));
    const blockedIds = new Set(blocks.map((b) => b.blockedAirlineId));

    // Fold the flat DM list into conversations keyed by counterpart.
    const conversations = new Map();
    for (const m of dms) {
      const other = m.fromAirlineId === me.id ? m.toAirlineId : m.fromAirlineId;
      if (blockedIds.has(other)) continue; // blocked senders vanish from the inbox
      let c = conversations.get(other);
      if (!c) {
        c = { airlineId: other, name: nameById.get(other) ?? 'Unknown', og: ogById.get(other) ?? false, dev: devById.get(other) ?? false, unread: 0, lastMessage: null };
        conversations.set(other, c);
      }
      if (!c.lastMessage) {
        c.lastMessage = { body: m.body.slice(0, 80), fromMe: m.fromAirlineId === me.id, at: m.createdAt };
      }
      if (m.toAirlineId === me.id && !m.readAt) c.unread++;
    }

    // Alliance channel unread (messages after my cursor, not sent by me).
    let alliance = null;
    if (membership) {
      const cursor = await prisma.messageCursor.findUnique({ where: { airlineId: me.id } });
      const unread = await prisma.message.count({
        where: {
          allianceId: membership.allianceId,
          kind: 'ALLIANCE',
          fromAirlineId: { not: me.id },
          ...(cursor?.allianceSeenAt ? { createdAt: { gt: cursor.allianceSeenAt } } : {}),
        },
      });
      alliance = { id: membership.allianceId, name: membership.alliance.name, unread };
    }

    const totalUnread = [...conversations.values()].reduce((s, c) => s + c.unread, 0)
      + (alliance?.unread ?? 0);

    return {
      myAirlineId: me.id,
      totalUnread,
      conversations: [...conversations.values()],
      alliance,
      blocked: blocks.map((b) => ({ airlineId: b.blockedAirlineId, name: nameById.get(b.blockedAirlineId) ?? 'Unknown' })),
      // Directory for composing a new message (active airlines, minus self/blocked).
      airlines: airlines
        .filter((a) => a.id !== me.id && a.status === 'ACTIVE' && !blockedIds.has(a.id))
        .map((a) => ({ id: a.id, name: a.name, hub: a.hub, og: a.account?.isOG === true, dev: isDevEmail(a.account?.email) })),
    };
  });

  // ── One DM thread (and mark it read) ──────────────────────────────────────
  fastify.get('/worlds/:id/messages/with/:airlineId', {
    preHandler: requireAuth,
    schema: { params: idParams({ airlineId: { type: 'string' } }) },
  }, async (request) => {
    const me = await loadMyAirline(request);
    const other = request.params.airlineId;
    const messages = await prisma.message.findMany({
      where: {
        worldId: me.worldId,
        kind: 'DM',
        OR: [
          { fromAirlineId: me.id, toAirlineId: other },
          { fromAirlineId: other, toAirlineId: me.id },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    await prisma.message.updateMany({
      where: { worldId: me.worldId, kind: 'DM', fromAirlineId: other, toAirlineId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    return {
      messages: messages.map((m) => ({
        id: m.id, fromMe: m.fromAirlineId === me.id, body: m.body, at: m.createdAt,
      })),
    };
  });

  // ── Send a DM ──────────────────────────────────────────────────────────────
  fastify.post('/worlds/:id/messages', {
    preHandler: requireAuth,
    schema: {
      params: idParams(),
      body: {
        type: 'object',
        required: ['toAirlineId', 'body'],
        properties: {
          toAirlineId: { type: 'string' },
          body: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_LENGTH },
        },
      },
    },
  }, async (request, reply) => {
    const me = await loadMyAirline(request);
    if (request.body.toAirlineId === me.id) throw httpError(400, 'Talking to yourself is free — no postage required');

    const target = await prisma.airline.findUnique({ where: { id: request.body.toAirlineId } });
    if (!target || target.worldId !== me.worldId) throw httpError(404, 'No such airline in this world');

    const [blockedByThem, blockedByMe] = await Promise.all([
      prisma.messageBlock.findUnique({
        where: { airlineId_blockedAirlineId: { airlineId: target.id, blockedAirlineId: me.id } },
      }),
      prisma.messageBlock.findUnique({
        where: { airlineId_blockedAirlineId: { airlineId: me.id, blockedAirlineId: target.id } },
      }),
    ]);
    if (blockedByThem) throw httpError(403, 'This airline is not accepting your messages');
    if (blockedByMe) throw httpError(409, 'You have blocked this airline — unblock them first');

    await assertUnderRateLimit(me);
    const message = await prisma.message.create({
      data: {
        worldId: me.worldId,
        kind: 'DM',
        fromAirlineId: me.id,
        toAirlineId: target.id,
        body: request.body.body.trim(),
      },
    });
    return reply.code(201).send({ ok: true, id: message.id, at: message.createdAt });
  });

  // ── Alliance channel: read (advances cursor) + post ───────────────────────
  fastify.get('/worlds/:id/messages/alliance', {
    preHandler: requireAuth,
    schema: { params: idParams() },
  }, async (request) => {
    const me = await loadMyAirline(request);
    const membership = await myAlliance(me.id);
    if (!membership) throw httpError(404, 'You are not in an alliance');

    const [messages, airlines] = await Promise.all([
      prisma.message.findMany({
        where: { allianceId: membership.allianceId, kind: 'ALLIANCE' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.airline.findMany({
        where: { worldId: me.worldId },
        select: { id: true, name: true, account: { select: { isOG: true, email: true } } },
      }),
    ]);
    const nameById = new Map(airlines.map((a) => [a.id, a.name]));
    const ogById = new Map(airlines.map((a) => [a.id, a.account?.isOG === true]));
    const devById = new Map(airlines.map((a) => [a.id, isDevEmail(a.account?.email)]));

    await prisma.messageCursor.upsert({
      where: { airlineId: me.id },
      update: { allianceSeenAt: new Date() },
      create: { airlineId: me.id, allianceSeenAt: new Date() },
    });

    return {
      alliance: { id: membership.allianceId, name: membership.alliance.name },
      messages: messages.reverse().map((m) => ({
        id: m.id,
        fromMe: m.fromAirlineId === me.id,
        from: nameById.get(m.fromAirlineId) ?? 'Unknown',
        fromOG: ogById.get(m.fromAirlineId) ?? false,
        fromDev: devById.get(m.fromAirlineId) ?? false,
        body: m.body,
        at: m.createdAt,
      })),
    };
  });

  fastify.post('/worlds/:id/messages/alliance', {
    preHandler: requireAuth,
    schema: {
      params: idParams(),
      body: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_LENGTH } },
      },
    },
  }, async (request, reply) => {
    const me = await loadMyAirline(request);
    const membership = await myAlliance(me.id);
    if (!membership) throw httpError(404, 'You are not in an alliance');

    await assertUnderRateLimit(me);
    const message = await prisma.message.create({
      data: {
        worldId: me.worldId,
        kind: 'ALLIANCE',
        fromAirlineId: me.id,
        allianceId: membership.allianceId,
        body: request.body.body.trim(),
      },
    });
    return reply.code(201).send({ ok: true, id: message.id, at: message.createdAt });
  });

  // ── Block / unblock an airline ─────────────────────────────────────────────
  fastify.post('/worlds/:id/messages/block', {
    preHandler: requireAuth,
    schema: {
      params: idParams(),
      body: {
        type: 'object',
        required: ['airlineId', 'blocked'],
        properties: { airlineId: { type: 'string' }, blocked: { type: 'boolean' } },
      },
    },
  }, async (request) => {
    const me = await loadMyAirline(request);
    const { airlineId, blocked } = request.body;
    if (airlineId === me.id) throw httpError(400, 'You cannot block yourself');

    if (blocked) {
      await prisma.messageBlock.upsert({
        where: { airlineId_blockedAirlineId: { airlineId: me.id, blockedAirlineId: airlineId } },
        update: {},
        create: { airlineId: me.id, blockedAirlineId: airlineId },
      });
    } else {
      await prisma.messageBlock.deleteMany({
        where: { airlineId: me.id, blockedAirlineId: airlineId },
      });
    }
    return { ok: true, blocked };
  });
}
