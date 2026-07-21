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
import { buildWorldRivalViews, withRivals, stripRivals } from '../lib/humanRivals.mjs';
import { guardDecision } from '../lib/decisionGuard.mjs';
import { allow } from '../lib/rateLimit.mjs';

// Per-account decision throttle. Generous enough that no human bursting through
// the UI is ever affected (60 in 10s ≈ 6/s), but a scripted flood hits 429 fast,
// so it can't bloat the Decision table / Supabase egress or hammer rivals' locks.
const DECISION_LIMIT   = 60;
const DECISION_WINDOWMS = 10_000;

// A cheap change detector for a whole world: any decision or tick bumps an
// airline's version, and joins/abandons change the active count, so this pair
// moves whenever ANYTHING a client could see has changed. It costs one tiny
// aggregate row from the DB — vs. the full state blobs it lets us skip.
async function worldStampOf(worldId) {
  const agg = await prisma.airline.aggregate({
    where: { worldId, status: 'ACTIVE' },
    _sum: { version: true },
    _count: { _all: true },
  });
  return `${agg._sum.version ?? 0}.${agg._count._all}`;
}

// Live rival view for one airline (validated by the world stamp — never
// stale-from-blob, and shared across every player polling this world).
async function rivalViewFor(airline, worldStamp) {
  const views = await buildWorldRivalViews(prisma, airline.worldId, { stamp: worldStamp });
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
    if (!Number.isFinite(v) || Math.abs(v) > 1e10) throw httpError(400, `Invalid numeric value at ${path}`);
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
  // Egress-aware: the client passes back the `stamp` from its last response;
  // when nothing in the world has changed (the overwhelmingly common case — the
  // game polls every ~25s, worlds tick hourly) we answer from three tiny reads
  // and never touch a state blob. Only a changed stamp pays for the full load.
  fastify.get('/worlds/:id/airline', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: { stamp: { type: 'string', maxLength: 80 } },
      },
    },
  }, async (request) => {
    const slim = await prisma.airline.findUnique({
      where: {
        worldId_accountId: { worldId: request.params.id, accountId: request.account.id },
      },
      select: { id: true, worldId: true, version: true, status: true, week: true },
    });
    if (!slim) throw httpError(404, 'You have no airline in this world');

    const world = await prisma.world.findUnique({ where: { id: slim.worldId } });
    const worldStamp = await worldStampOf(slim.worldId);
    const stamp = `${slim.version}:${worldStamp}`;
    const dueAt = nextTickAt(world);
    const base = {
      airlineId: slim.id,
      status: slim.status,
      week: slim.week,
      worldStatus: world.status,
      worldClock: {
        week: world.currentWeek,
        year: world.currentYear,
        // Countdown material for the game bar: when the next week lands (null
        // for LOBBY/ENDED worlds) and the world's human-readable pace.
        nextTickAt: dueAt ? dueAt.toISOString() : null,
        paceLabel: paceLabel(world.weeksPerDay),
      },
      stamp,
    };
    if (request.query.stamp && request.query.stamp === stamp) {
      return { ...base, unchanged: true };
    }

    // Something changed (or first load): full blob + the CURRENT rival view so
    // the Rivals tab and demand previews show other humans as they are right
    // now, not as of the last tick.
    const airline = await prisma.airline.findUnique({ where: { id: slim.id } });
    const view = await rivalViewFor(airline, worldStamp);
    return { ...base, state: withRivals(airline.state, view) };
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

    if (!allow(`dec:${request.account.id}`, DECISION_LIMIT, DECISION_WINDOWMS)) {
      throw httpError(429, 'You are submitting actions too quickly — slow down a moment.');
    }

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

    // Server-authoritative validation of economic values the solo client would
    // normally clamp in its UI (loan terms, cabin layout, reconfigure cost). The
    // client is untrusted in multiplayer; re-derive/bound these before the reducer.
    // Guards may also SANITIZE: the returned payload (e.g. stock trades come
    // back whitelisted to { targetId, shares }) is what actually runs & journals.
    const guarded = guardDecision(type, payload, airline.state) ?? payload;

    // Journal enrichment: route-close payloads only carry ids, which mean
    // nothing once the routes are gone. Resolve ids to origin/destination pairs
    // from the PRE-reducer state so the world feed can say "closed SFO–MSP"
    // instead of "closed ?–?". The enriched copy is journalled only; the
    // reducer still runs on `guarded` untouched.
    let journalled = guarded;
    if (type === 'CLOSE_ROUTE' || type === 'CLOSE_ROUTES' || type === 'CLOSE_CARGO_ROUTE') {
      const pool = type === 'CLOSE_CARGO_ROUTE'
        ? (airline.state?.cargoRoutes ?? [])
        : (airline.state?.routes ?? []);
      const ids = type === 'CLOSE_ROUTES'
        ? (guarded.routeIds ?? (guarded.routeId != null ? [guarded.routeId] : []))
        : (guarded.routeId != null ? [guarded.routeId] : []);
      const pairs = pool
        .filter((r) => ids.includes(r.id))
        .map((r) => ({ origin: r.origin, destination: r.destination }));
      if (pairs.length === 1 && type !== 'CLOSE_ROUTES') {
        journalled = { ...guarded, origin: pairs[0].origin, destination: pairs[0].destination };
      } else if (pairs.length > 0) {
        journalled = { ...guarded, routes: pairs.slice(0, 20), count: pairs.length };
      }
    }

    // Authoritative computation — same reducer as the solo game and the tick.
    // Run it over the rival-injected view so (a) the stored blob is scrubbed of
    // any pre-humans-only AI competitors, and (b) the response the client
    // re-renders from shows the same rivals the read path does.
    const view = await rivalViewFor(airline, await worldStampOf(airline.worldId));
    const next = gameReducer(withRivals(airline.state, view), { type, ...guarded });

    try {
      await prisma.$transaction(async (tx) => {
        // Optimistic concurrency: only write if the airline is still at the version
        // we read. If the worker tick (or another decision) got there first, bail
        // with a 409 instead of silently clobbering it — the client re-GETs + retries.
        const updated = await tx.airline.updateMany({
          where: { id: airline.id, version: airline.version },
          data: {
            // Persist WITHOUT the injected rival views (rebuilt on every read/tick).
            // The client still gets the full `next` (with rivals) in the response.
            state: stripRivals(next),
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
            payload: journalled,
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
      // Post-write stamp (our version bumped by the transaction) so the client's
      // next poll short-circuits instead of re-downloading what it already has.
      stamp: `${airline.version + 1}:${await worldStampOf(airline.worldId)}`,
    });
  });
}
