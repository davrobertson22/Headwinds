// /worlds/:id/alliances — player-founded alliances (Headwinds has no AI blocs).
//
// Governance model: anyone with an active airline can FOUND an alliance; other
// players REQUEST to join; the FOUNDER accepts or rejects. Members get the
// standard alliance benefits (see humanRivals.playerAllianceDef) — injected
// into their game state on every read/tick, so membership changes take effect
// immediately without touching the reducer. The AllianceMember.airlineId
// UNIQUE constraint enforces "one alliance (or one pending request) per
// airline" at the database level.
import { requireAuth, resolveAccount } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { PLAYER_ALLIANCE_MAX_MEMBERS } from '../lib/humanRivals.mjs';

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
  if (airline.status !== 'ACTIVE') throw httpError(409, `Your airline is ${airline.status}`);
  return airline;
}

async function loadAlliance(request) {
  const alliance = await prisma.alliance.findUnique({
    where: { id: request.params.allianceId },
    include: { members: true },
  });
  if (!alliance || alliance.worldId !== request.params.id) {
    throw httpError(404, 'No such alliance in this world');
  }
  return alliance;
}

const isFounder = (alliance, airlineId) =>
  alliance.members.some((m) => m.airlineId === airlineId && m.role === 'FOUNDER' && m.status === 'ACTIVE');

const activeCount = (alliance) => alliance.members.filter((m) => m.status === 'ACTIVE').length;

const idParams = (extra = {}) => ({
  type: 'object',
  properties: { id: { type: 'string' }, ...extra },
  required: ['id', ...Object.keys(extra)],
});

export default async function allianceRoutes(fastify) {
  // ── List a world's alliances ───────────────────────────────────────────────
  // Public: names + active members. Pending requests are visible only to the
  // alliance's founder (and every caller sees their own membership/request).
  fastify.get('/worlds/:id/alliances', {
    schema: { params: idParams() },
  }, async (request) => {
    const worldId = request.params.id;

    // Optional auth — anonymous viewers still get the public list.
    let myAirline = null;
    try {
      const account = await resolveAccount(request);
      myAirline = await prisma.airline.findUnique({
        where: { worldId_accountId: { worldId, accountId: account.id } },
      });
    } catch { /* anonymous */ }

    const [alliances, airlines] = await Promise.all([
      prisma.alliance.findMany({ where: { worldId }, include: { members: true }, orderBy: { createdAt: 'asc' } }),
      prisma.airline.findMany({ where: { worldId }, select: { id: true, name: true, hub: true, marketCap: true, status: true } }),
    ]);
    const airlineById = new Map(airlines.map((a) => [a.id, a]));
    const describe = (m) => ({
      airlineId: m.airlineId,
      name: airlineById.get(m.airlineId)?.name ?? 'Unknown',
      hub: airlineById.get(m.airlineId)?.hub ?? null,
      marketCap: Number(airlineById.get(m.airlineId)?.marketCap ?? 0),
      role: m.role,
      since: m.createdAt,
    });

    const myMembership = myAirline
      ? await prisma.allianceMember.findUnique({ where: { airlineId: myAirline.id } })
      : null;

    return {
      maxMembers: PLAYER_ALLIANCE_MAX_MEMBERS,
      mine: myMembership
        ? { allianceId: myMembership.allianceId, status: myMembership.status, role: myMembership.role }
        : null,
      myAirlineId: myAirline?.id ?? null,
      alliances: alliances.map((a) => ({
        id: a.id,
        name: a.name,
        createdAt: a.createdAt,
        members: a.members.filter((m) => m.status === 'ACTIVE').map(describe),
        // Founders see who's knocking; everyone else just gets a count.
        pending: isFounder(a, myAirline?.id)
          ? a.members.filter((m) => m.status === 'PENDING').map(describe)
          : undefined,
        pendingCount: a.members.filter((m) => m.status === 'PENDING').length,
      })),
    };
  });

  // ── Found an alliance ──────────────────────────────────────────────────────
  fastify.post('/worlds/:id/alliances', {
    preHandler: requireAuth,
    schema: {
      params: idParams(),
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 3, maxLength: 40 } },
      },
    },
  }, async (request, reply) => {
    const airline = await loadMyAirline(request);
    const existing = await prisma.allianceMember.findUnique({ where: { airlineId: airline.id } });
    if (existing) {
      throw httpError(409, existing.status === 'PENDING'
        ? 'You already have a pending join request — cancel it first.'
        : 'You are already in an alliance — leave it first.');
    }
    const name = request.body.name.trim();
    const clash = await prisma.alliance.findUnique({
      where: { worldId_name: { worldId: airline.worldId, name } },
    });
    if (clash) throw httpError(409, 'An alliance with that name already exists in this world');

    let alliance;
    try {
      alliance = await prisma.alliance.create({
        data: {
          worldId: airline.worldId,
          name,
          members: { create: { airlineId: airline.id, status: 'ACTIVE', role: 'FOUNDER' } },
        },
        include: { members: true },
      });
    } catch (e) {
      // Concurrent found of the same name (or a double-submit) races the unique
      // index — return 409 instead of a raw 500.
      if (e?.code === 'P2002') throw httpError(409, 'An alliance with that name already exists in this world');
      throw e;
    }
    return reply.code(201).send({ ok: true, alliance: { id: alliance.id, name: alliance.name } });
  });

  // ── Request to join ────────────────────────────────────────────────────────
  fastify.post('/worlds/:id/alliances/:allianceId/join', {
    preHandler: requireAuth,
    schema: { params: idParams({ allianceId: { type: 'string' } }) },
  }, async (request, reply) => {
    const airline = await loadMyAirline(request);
    const alliance = await loadAlliance(request);
    const existing = await prisma.allianceMember.findUnique({ where: { airlineId: airline.id } });
    if (existing) {
      throw httpError(409, existing.status === 'PENDING'
        ? 'You already have a pending join request.'
        : 'You are already in an alliance — leave it first.');
    }
    if (activeCount(alliance) >= PLAYER_ALLIANCE_MAX_MEMBERS) {
      throw httpError(409, 'This alliance is full');
    }
    await prisma.allianceMember.create({
      data: { allianceId: alliance.id, airlineId: airline.id, status: 'PENDING', role: 'MEMBER' },
    });
    return reply.code(201).send({ ok: true, status: 'PENDING' });
  });

  // ── Founder decides on a request ───────────────────────────────────────────
  fastify.post('/worlds/:id/alliances/:allianceId/requests/:airlineId', {
    preHandler: requireAuth,
    schema: {
      params: idParams({ allianceId: { type: 'string' }, airlineId: { type: 'string' } }),
      body: {
        type: 'object',
        required: ['decision'],
        properties: { decision: { type: 'string', enum: ['accept', 'reject'] } },
      },
    },
  }, async (request) => {
    const airline = await loadMyAirline(request);
    const alliance = await loadAlliance(request);
    if (!isFounder(alliance, airline.id)) {
      throw httpError(403, 'Only the alliance founder can decide on join requests');
    }
    const target = alliance.members.find(
      (m) => m.airlineId === request.params.airlineId && m.status === 'PENDING',
    );
    if (!target) throw httpError(404, 'No pending request from that airline');

    if (request.body.decision === 'accept') {
      if (activeCount(alliance) >= PLAYER_ALLIANCE_MAX_MEMBERS) {
        throw httpError(409, 'This alliance is full');
      }
      await prisma.allianceMember.update({ where: { id: target.id }, data: { status: 'ACTIVE' } });
      return { ok: true, status: 'ACTIVE' };
    }
    await prisma.allianceMember.delete({ where: { id: target.id } });
    return { ok: true, status: 'REJECTED' };
  });

  // ── Leave (or cancel a pending request) ────────────────────────────────────
  // A departing founder hands leadership to the longest-standing active member;
  // if nobody is left, the alliance disbands (pending requests cascade away).
  fastify.post('/worlds/:id/alliances/:allianceId/leave', {
    preHandler: requireAuth,
    schema: { params: idParams({ allianceId: { type: 'string' } }) },
  }, async (request) => {
    const airline = await loadMyAirline(request);
    const alliance = await loadAlliance(request);
    const mine = alliance.members.find((m) => m.airlineId === airline.id);
    if (!mine) throw httpError(404, 'You are not part of this alliance');

    await prisma.allianceMember.delete({ where: { id: mine.id } });

    if (mine.role === 'FOUNDER' && mine.status === 'ACTIVE') {
      const heir = alliance.members
        .filter((m) => m.status === 'ACTIVE' && m.id !== mine.id)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
      if (heir) {
        await prisma.allianceMember.update({ where: { id: heir.id }, data: { role: 'FOUNDER' } });
      } else {
        await prisma.alliance.delete({ where: { id: alliance.id } });
        return { ok: true, disbanded: true };
      }
    }
    return { ok: true };
  });
}
