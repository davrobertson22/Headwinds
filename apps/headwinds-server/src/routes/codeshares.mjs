// /worlds/:id/codeshares — bilateral codeshare agreements.
//
// `SIGN_CODESHARE` used to be a plain client decision on the allow-list, which
// is how a player came to be able to sign a deal against a real rival without
// that rival ever hearing about it. It is server-governed now, exactly like
// alliance membership: offer → accept, both sides written together.
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import {
  CodeshareError, offerCodeshare, resolveOffer, acceptOffer, cancelCodeshare,
  buildOfferView,
} from '../lib/codeshareService.mjs';

/** Linear week index — same arithmetic gateService uses. */
const worldWeekIndex = (world) => (world.currentYear - 1) * 52 + world.currentWeek;

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

async function loadWorld(request) {
  const world = await prisma.world.findUnique({ where: { id: request.params.id } });
  if (!world) throw httpError(404, 'No such world');
  if (world.status !== 'RUNNING') throw httpError(409, 'This world is not running');
  return world;
}

async function loadMyAirline(request) {
  const airline = await prisma.airline.findUnique({
    where: { worldId_accountId: { worldId: request.params.id, accountId: request.account.id } },
  });
  if (!airline) throw httpError(404, 'You have no airline in this world');
  if (airline.status !== 'ACTIVE') throw httpError(409, `Your airline is ${airline.status}`);
  return airline;
}

/** Service errors already carry the right status; anything else is a 500. */
const rethrow = (err) => {
  if (err instanceof CodeshareError) throw httpError(err.statusCode, err.message);
  throw err;
};

const idParams = (extra = {}) => ({
  type: 'object',
  properties: { id: { type: 'string' }, ...extra },
  required: ['id', ...Object.keys(extra)],
});

export default async function codeshareRoutes(fastify) {
  // ── What is on the table ───────────────────────────────────────────────────
  fastify.get('/worlds/:id/codeshares', {
    preHandler: requireAuth,
    schema: { params: idParams() },
  }, async (request) => {
    const airline = await loadMyAirline(request);
    const offers = await buildOfferView(prisma, { worldId: request.params.id, airlineId: airline.id });
    return { ...offers, myAirlineId: airline.id };
  });

  // ── Propose ────────────────────────────────────────────────────────────────
  // If the other player has already offered YOU one, this accepts it instead of
  // stacking a mirror-image proposal nobody needs to answer.
  fastify.post('/worlds/:id/codeshares/offer', {
    preHandler: requireAuth,
    schema: {
      params: idParams(),
      body: {
        type: 'object',
        required: ['toAirlineId'],
        properties: { toAirlineId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const world = await loadWorld(request);
    const from = await loadMyAirline(request);
    try {
      const res = await offerCodeshare(prisma, {
        world, from, toAirlineId: request.body.toAirlineId, weekIndex: worldWeekIndex(world),
      });
      return reply.code(201).send({
        ok: true,
        mutual: !!res.mutual,
        // A mutual offer signs immediately, so hand back the new state rather
        // than making the client wait a poll to see a deal it just made.
        state: res.myState ?? null,
        partnerName: res.partnerName ?? res.toName ?? null,
      });
    } catch (err) { return rethrow(err); }
  });

  // ── Accept / decline / withdraw ────────────────────────────────────────────
  fastify.post('/worlds/:id/codeshares/offers/:offerId', {
    preHandler: requireAuth,
    schema: {
      params: idParams({ offerId: { type: 'string' } }),
      body: {
        type: 'object',
        required: ['decision'],
        properties: { decision: { type: 'string', enum: ['accept', 'reject', 'withdraw'] } },
      },
    },
  }, async (request) => {
    const world = await loadWorld(request);
    const airline = await loadMyAirline(request);
    try {
      const offer = await resolveOffer(prisma, {
        world, offerId: request.params.offerId, airlineId: airline.id,
        decision: request.body.decision,
      });
      if (request.body.decision === 'accept') {
        const res = await acceptOffer(prisma, {
          world, offer, acceptor: airline, weekIndex: worldWeekIndex(world),
        });
        return { ok: true, status: 'ACCEPTED', state: res.myState, partnerName: res.partnerName };
      }
      // Declining and withdrawing are the same write: the row goes. Keeping a
      // REJECTED tombstone would only get in the way of offering again later.
      await prisma.codeshareOffer.delete({ where: { id: offer.id } }).catch(() => {});
      return { ok: true, status: request.body.decision === 'reject' ? 'REJECTED' : 'WITHDRAWN' };
    } catch (err) { return rethrow(err); }
  });

  // ── Cancel a live agreement (both sides) ───────────────────────────────────
  fastify.post('/worlds/:id/codeshares/cancel', {
    preHandler: requireAuth,
    schema: {
      params: idParams(),
      body: {
        type: 'object',
        required: ['partnerId'],
        properties: { partnerId: { type: 'string' } },
      },
    },
  }, async (request) => {
    const world = await loadWorld(request);
    const airline = await loadMyAirline(request);
    try {
      const res = await cancelCodeshare(prisma, { world, airline, partnerId: request.body.partnerId });
      return { ok: true, state: res.myState, partnerName: res.partnerName };
    } catch (err) { return rethrow(err); }
  });
}
