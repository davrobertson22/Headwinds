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
import { weekIndex, nextTickAt } from '../lib/tickService.mjs';
import { paceLabel } from '../lib/worldConfig.mjs';
import { buildWorldRivalViews, withRivals } from '../lib/humanRivals.mjs';

// Live rival view for one airline (fresh on every read — never stale-from-blob).
async function rivalViewFor(airline) {
  const views = await buildWorldRivalViews(prisma, airline.worldId);
  return views.get(airline.id) ?? { competitors: [], humanRivals: {}, alliance: null };
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// The action TYPE is allow-listed, but payload fields were previously trusted
// verbatim. Reject non-finite / absurd numbers (any depth) so a crafted decision
// can't overflow cash or feed NaN into the reducer.
function assertFinitePayload(v, path = 'payload') {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > 1e12) throw httpError(400, `Invalid numeric value at ${path}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertFinitePayload(x, `${path}[${i}]`));
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) assertFinitePayload(val, `${path}.${k}`);
  }
}

// Thrown inside the decision transaction when the optimistic version check fails
// (the worker tick or another decision changed this airline first).
class DecisionConflict extends Error {}
const toBig = (v) => { const n = Math.round(Number(v)); return BigInt(Number.isFinite(n) ? n : 0); };

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
    const dueAt = nextTickAt(airline.world);
    return {
      airlineId: airline.id,
      status: airline.status,
      week: airline.week,
      worldStatus: airline.world.status,
      worldClock: {
        week: airline.world.currentWeek,
        year: airline.world.currentYear,
        // Countdown material for the game bar: when the next week lands (null
        // for LOBBY/ENDED worlds) and the world's human-readable pace.
        nextTickAt: dueAt ? dueAt.toISOString() : null,
        paceLabel: paceLabel(airline.world.weeksPerDay),
      },
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
    // Alliance membership is server-governed in Headwinds (create/join/approve
    // in the world lobby) — the solo reducer actions would bypass the founder.
    if (type === 'JOIN_ALLIANCE' || type === 'LEAVE_ALLIANCE') {
      throw httpError(403, 'Alliances in Headwinds are managed from the world lobby, not in-game.');
    }
    // Defense in depth: a payload can't override the validated type.
    if ('type' in payload) delete payload.type;
    assertFinitePayload(payload);

    const airline = await loadMyAirline(request);
    if (airline.status !== 'ACTIVE') throw httpError(409, `Your airline is ${airline.status}`);
    if (airline.world.status !== 'RUNNING') throw httpError(409, `This world is ${airline.world.status}`);

    // Authoritative computation — same reducer as the solo game and the tick.
    // Run it over the rival-injected view so (a) the stored blob is scrubbed of
    // any pre-humans-only AI competitors, and (b) the response the client
    // re-renders from shows the same rivals the read path does.
    const view = await rivalViewFor(airline);
    const next = gameReducer(withRivals(airline.state, view), { type, ...payload });

    try {
      await prisma.$transaction(async (tx) => {
        // Optimistic concurrency: only write if the airline is still at the version
        // we read. If the worker tick (or another decision) got there first, bail
        // with a 409 instead of silently clobbering it — the client re-GETs + retries.
        const updated = await tx.airline.updateMany({
          where: { id: airline.id, version: airline.version },
          data: {
            state: next,
            cash: toBig(next.cash),
            marketCap: toBig(next.marketCap),
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) throw new DecisionConflict();
        await tx.decision.create({
          data: {
            worldId: airline.worldId,
            airlineId: airline.id,
            week: weekIndex(airline.world),
            type,
            payload,
          },
        });
      });
    } catch (e) {
      if (e instanceof DecisionConflict) {
        throw httpError(409, 'Your airline just changed (a new week ticked) — reload and try again.');
      }
      throw e;
    }

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
