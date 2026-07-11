// /worlds/:id/report — one player flags another for a rule violation.
//
// A report ties together WHO filed it (account + the airline they fly), WHO it's
// about (the reported airline → its owning account), a category, and optional
// detail. Admins review the queue in the moderation panel (routes/admin.mjs) and
// may ban the reported account. Reporting is member-only: you can only report a
// rival in a world you're actually playing.
//
// Guardrails mirror messaging: you can't report yourself, a duplicate open
// report against the same player is folded into the existing one, and there's a
// rolling per-reporter rate limit so the queue can't be flooded.
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';

// The categories a player can choose. Kept in sync with REPORT_CATEGORIES in the
// web client (Report.jsx).
export const REPORT_CATEGORIES = ['HARASSMENT', 'CHEATING', 'OFFENSIVE_NAME', 'SPAM', 'OTHER'];

export const REPORT_RATE_LIMIT_PER_HOUR = 10;
export const REPORT_DETAILS_MAX_LENGTH = 1000;

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

export default async function reportRoutes(fastify) {
  fastify.post('/worlds/:id/report', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['airlineId', 'category'],
        properties: {
          airlineId: { type: 'string' },
          category: { type: 'string', enum: REPORT_CATEGORIES },
          details: { type: 'string', maxLength: REPORT_DETAILS_MAX_LENGTH },
        },
      },
    },
  }, async (request, reply) => {
    const worldId = request.params.id;
    const { airlineId, category } = request.body;
    const details = (request.body.details ?? '').trim() || null;

    // You must be a player in this world to report someone in it.
    const me = await prisma.airline.findUnique({
      where: { worldId_accountId: { worldId, accountId: request.account.id } },
    });
    if (!me) throw httpError(404, 'You have no airline in this world');
    if (airlineId === me.id) throw httpError(400, 'You cannot report yourself');

    // The reported airline must live in this world; we ban the ACCOUNT behind it.
    const target = await prisma.airline.findUnique({
      where: { id: airlineId },
      include: { account: { select: { id: true } } },
    });
    if (!target || target.worldId !== worldId) {
      throw httpError(404, 'No such airline in this world');
    }
    if (target.accountId === request.account.id) {
      throw httpError(400, 'You cannot report your own account');
    }

    // Rolling rate limit across all of this reporter's reports.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await prisma.report.count({
      where: { reporterAccountId: request.account.id, createdAt: { gte: oneHourAgo } },
    });
    if (recent >= REPORT_RATE_LIMIT_PER_HOUR) {
      throw httpError(429, `Rate limit: max ${REPORT_RATE_LIMIT_PER_HOUR} reports per hour`);
    }

    // Fold a repeat into the existing open report rather than stacking duplicates
    // (still refreshes the airline context + detail so the admin sees the latest).
    const existing = await prisma.report.findFirst({
      where: {
        worldId,
        reporterAccountId: request.account.id,
        reportedAccountId: target.accountId,
        status: 'OPEN',
      },
    });
    if (existing) {
      await prisma.report.update({
        where: { id: existing.id },
        data: { category, details: details ?? existing.details, reportedAirlineId: target.id, reporterAirlineId: me.id },
      });
      return reply.code(200).send({ ok: true, id: existing.id, alreadyReported: true });
    }

    const report = await prisma.report.create({
      data: {
        worldId,
        reporterAccountId: request.account.id,
        reporterAirlineId: me.id,
        reportedAccountId: target.accountId,
        reportedAirlineId: target.id,
        category,
        details,
      },
    });
    return reply.code(201).send({ ok: true, id: report.id });
  });
}
