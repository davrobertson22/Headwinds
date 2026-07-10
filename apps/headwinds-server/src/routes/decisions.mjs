// /worlds/:id/airline + /worlds/:id/decisions — Phase 2 gameplay.
//
// The client never computes outcomes. It reads its authoritative state blob from
// GET /worlds/:id/airline and submits INTENTS to POST /worlds/:id/decisions; the
// server validates the action type against the allow-list and re-runs it through
// the shared engine reducer. Every accepted decision is also journaled to the
// Decision table (audit trail + Phase-3 replay/anti-abuse analysis).
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../world.mjs';
import { gameReducer } from '@tailwinds/engine/reducer';
import { weekIndex } from '../lib/tickService.mjs';
import { buildRivalViews, withRivals } from '../lib/humanRivals.mjs';

// Live rival view for one airline (fresh on every read — never stale-from-blob).
async function rivalViewFor(airline) {
  const airlines = await prisma.airline.findMany({
    where: { worldId: airline.worldId, status: 'ACTIVE' },
  });
  return buildRivalViews(airlines).get(airline.id)
    ?? { competitors: [], humanRivals: {} };
}

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
    include: { world: true },
  });
  if (!airline) throw httpError(404, 'You have no airline in this world');
  return airline;
}

export default async function decisionRoutes(fastify) {
  // ── Your authoritative airline state (the full save blob) ─────────────────
  fastify.get('/worlds/:id/airline', {
    preHandler: requireAuth,
    schema: { params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }, async (request) => {
    const airline = await loadMyAirline(request);
    // Inject the CURRENT rival view so the Rivals tab and demand previews show
    // other humans as they are right now, not as of the last tick.
    const view = await rivalViewFor(airline);
    return {
      airlineId: airline.id,
      status: airline.status,
      week: airline.week,
      worldStatus: airline.world.status,
      worldClock: { week: airline.world.currentWeek, year: airline.world.currentYear },
      state: withRivals(airline.state, view),
    };
  });

  // ── Submit a decision (validated intent → authoritative reducer) ───────────
  fastify.post('/worlds/:id/decisions', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', maxLength: 40 },
          payload: { type: 'object', additionalProperties: true },
        },
      },
    },
  }, async (request, reply) => {
    const { type, payload = {} } = request.body;

    if (!ALLOWED_PLAYER_ACTIONS.has(type)) {
      throw httpError(403, `Action not allowed: ${type}`);
    }
    // You can't buy out a human. Acquisitions were a solo-game mechanic against
    // AI carriers; in Headwinds every competitor is a real player.
    if (type === 'ACQUIRE_COMPETITOR') {
      throw httpError(403, 'Acquisitions are disabled in multiplayer — your rivals are real people.');
    }
    // Defense in depth: a payload can't override the validated type.
    if ('type' in payload) delete payload.type;

    const airline = await loadMyAirline(request);
    if (airline.status !== 'ACTIVE') throw httpError(409, `Your airline is ${airline.status}`);
    if (airline.world.status !== 'RUNNING') throw httpError(409, `This world is ${airline.world.status}`);

    // Authoritative computation — same reducer as the solo game and the tick.
    const next = gameReducer(airline.state, { type, ...payload });

    await prisma.$transaction([
      prisma.airline.update({
        where: { id: airline.id },
        data: {
          state: next,
          cash: BigInt(Math.round(next.cash ?? 0)),
          marketCap: BigInt(Math.round(next.marketCap ?? 0)),
        },
      }),
      prisma.decision.create({
        data: {
          worldId: airline.worldId,
          airlineId: airline.id,
          week: weekIndex(airline.world),
          type,
          payload,
        },
      }),
    ]);

    return reply.code(201).send({
      ok: true,
      // The client re-renders from the authoritative result — no local guessing.
      state: next,
      // Engine convention: rejected/no-op intents leave state unchanged and often
      // set state.error / a toast. Surface a hint so the UI can show it.
      error: next.error ?? null,
    });
  });
}
