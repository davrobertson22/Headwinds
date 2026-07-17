// /admin/* — the moderation surface. Every route here is admin-only
// (requireAdmin → account email in ADMIN_EMAILS). Admins review the report queue
// and ban/unban accounts. Bans are account-wide: auth.mjs rejects a banned
// account on its next request, and we also abandon all of its airlines so it
// drops out of live competition immediately.
import { requireAdmin, isAdmin } from '../auth.mjs';
import { prisma } from '../db.mjs';

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

const accountSummary = (a) => ({
  id: a.id,
  email: a.email,
  displayName: a.displayName,
  isOG: a.isOG,
  bannedAt: a.bannedAt,
  banReason: a.banReason,
  bannedByEmail: a.bannedByEmail,
});

export default async function adminRoutes(fastify) {
  // ── The report queue ───────────────────────────────────────────────────────
  // Defaults to OPEN reports (the admin's to-do list); ?status=ALL shows history.
  fastify.get('/admin/reports', {
    preHandler: requireAdmin,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['OPEN', 'ACTIONED', 'DISMISSED', 'ALL'] },
        },
      },
    },
  }, async (request) => {
    const status = request.query.status ?? 'OPEN';
    const where = status === 'ALL' ? {} : { status };

    const reports = await prisma.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        world: { select: { id: true, name: true } },
        reporter: { select: { id: true, email: true, displayName: true } },
        reported: { select: { id: true, email: true, displayName: true, bannedAt: true, banReason: true } },
      },
    });

    // Resolve airline display names for the reporter/reported airline context.
    const airlineIds = [
      ...new Set(reports.flatMap((r) => [r.reporterAirlineId, r.reportedAirlineId]).filter(Boolean)),
    ];
    const airlines = airlineIds.length
      ? await prisma.airline.findMany({
          where: { id: { in: airlineIds } },
          select: { id: true, name: true, hub: true, status: true },
        })
      : [];
    const airlineById = new Map(airlines.map((a) => [a.id, a]));

    // How many OPEN reports each reported account has — a repeat offender signal.
    const openCounts = await prisma.report.groupBy({
      by: ['reportedAccountId'],
      where: { status: 'OPEN' },
      _count: { _all: true },
    });
    const openByAccount = new Map(openCounts.map((c) => [c.reportedAccountId, c._count._all]));

    return {
      reports: reports.map((r) => ({
        id: r.id,
        category: r.category,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        resolvedByEmail: r.resolvedByEmail,
        resolutionNote: r.resolutionNote,
        world: r.world,
        reporter: {
          accountId: r.reporter.id,
          displayName: r.reporter.displayName,
          email: r.reporter.email,
          airline: airlineById.get(r.reporterAirlineId) ?? null,
        },
        reported: {
          accountId: r.reported.id,
          displayName: r.reported.displayName,
          email: r.reported.email,
          bannedAt: r.reported.bannedAt,
          banReason: r.reported.banReason,
          openReportCount: openByAccount.get(r.reported.id) ?? 0,
          airline: airlineById.get(r.reportedAirlineId) ?? null,
        },
      })),
    };
  });

  // ── Dismiss a report (no action warranted) ─────────────────────────────────
  fastify.post('/admin/reports/:id/dismiss', {
    preHandler: requireAdmin,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', properties: { note: { type: 'string', maxLength: 500 } } },
    },
  }, async (request) => {
    const report = await prisma.report.findUnique({ where: { id: request.params.id } });
    if (!report) throw httpError(404, 'No such report');
    await prisma.report.update({
      where: { id: report.id },
      data: {
        status: 'DISMISSED',
        resolvedAt: new Date(),
        resolvedByEmail: request.account.email,
        resolutionNote: (request.body.note ?? '').trim() || 'Dismissed — not actionable',
      },
    });
    return { ok: true };
  });

  // ── Ban an account (account-wide) ──────────────────────────────────────────
  // Blocks sign-in on the next request, abandons every airline the account owns,
  // and resolves all OPEN reports about it as ACTIONED.
  fastify.post('/admin/accounts/:accountId/ban', {
    preHandler: requireAdmin,
    schema: {
      params: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
      body: { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (request) => {
    const target = await prisma.account.findUnique({ where: { id: request.params.accountId } });
    if (!target) throw httpError(404, 'No such account');
    if (target.id === request.account.id) throw httpError(400, 'You cannot ban yourself');
    if (isAdmin(target)) throw httpError(403, 'You cannot ban another admin');
    if (target.bannedAt) throw httpError(409, 'That account is already banned');

    const reason = (request.body.reason ?? '').trim() || null;
    const now = new Date();

    const [, airlineResult, reportResult] = await prisma.$transaction([
      prisma.account.update({
        where: { id: target.id },
        data: { bannedAt: now, banReason: reason, bannedByEmail: request.account.email },
      }),
      // Drop the banned player out of live competition everywhere.
      prisma.airline.updateMany({
        where: { accountId: target.id, status: 'ACTIVE' },
        data: { status: 'ABANDONED' },
      }),
      // Close out the open reports that led here.
      prisma.report.updateMany({
        where: { reportedAccountId: target.id, status: 'OPEN' },
        data: {
          status: 'ACTIONED',
          resolvedAt: now,
          resolvedByEmail: request.account.email,
          resolutionNote: reason ? `Banned: ${reason}` : 'Banned',
        },
      }),
    ]);

    return {
      ok: true,
      account: { id: target.id, email: target.email, displayName: target.displayName },
      airlinesAbandoned: airlineResult.count,
      reportsActioned: reportResult.count,
    };
  });

  // ── Unban an account ───────────────────────────────────────────────────────
  // Lifts the sign-in block. Airlines that were abandoned stay abandoned — the
  // player rejoins worlds fresh (abandoning is intentionally irreversible, same
  // as a voluntary "Abandon airline").
  fastify.post('/admin/accounts/:accountId/unban', {
    preHandler: requireAdmin,
    schema: {
      params: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
    },
  }, async (request) => {
    const target = await prisma.account.findUnique({ where: { id: request.params.accountId } });
    if (!target) throw httpError(404, 'No such account');
    if (!target.bannedAt) throw httpError(409, 'That account is not banned');
    await prisma.account.update({
      where: { id: target.id },
      data: { bannedAt: null, banReason: null, bannedByEmail: null },
    });
    return { ok: true };
  });

  // ── List banned accounts (for the unban view) ──────────────────────────────
  fastify.get('/admin/bans', { preHandler: requireAdmin }, async () => {
    const banned = await prisma.account.findMany({
      where: { bannedAt: { not: null } },
      orderBy: { bannedAt: 'desc' },
      take: 200,
    });
    return { bans: banned.map(accountSummary) };
  });

  // ── OG veteran badge ────────────────────────────────────────────────────────
  // Players who've been flying since the original Tailwinds DM the admin their
  // email (or the email behind their Discord sign-in); the admin grants the
  // badge here BY EMAIL. Account-wide flag — the gold "✈ OG" chip then follows
  // the player onto every airline they fly, in every world.
  fastify.get('/admin/ogs', { preHandler: requireAdmin }, async () => {
    const ogs = await prisma.account.findMany({
      where: { isOG: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return { ogs: ogs.map(accountSummary) };
  });

  // Find an account by display name, email, or one of its airline names — so a
  // Discord player ("give OG to Fonnesx") can be granted without knowing the
  // email behind their sign-in. Admin-only, so surfacing the email here is fine
  // (the admin needs it for moderation anyway; it never reaches other players).
  fastify.get('/admin/accounts/search', {
    preHandler: requireAdmin,
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string', minLength: 2, maxLength: 100 } },
      },
    },
  }, async (request) => {
    const q = request.query.q.trim();
    const accounts = await prisma.account.findMany({
      where: {
        OR: [
          { displayName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { airlines: { some: { name: { contains: q, mode: 'insensitive' } } } },
        ],
      },
      include: { airlines: { select: { name: true }, take: 5, orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    return {
      accounts: accounts.map((a) => ({
        ...accountSummary(a),
        airlines: a.airlines.map((x) => x.name),
      })),
    };
  });

  // Grant/revoke by accountId (from the search above) OR by email (legacy path,
  // still handy when a player DMs their address directly).
  fastify.post('/admin/og', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['og'],
        properties: {
          accountId: { type: 'string', minLength: 1, maxLength: 60 },
          email: { type: 'string', minLength: 3, maxLength: 200 },
          og: { type: 'boolean' },
        },
      },
    },
  }, async (request) => {
    const { accountId } = request.body;
    const email = request.body.email?.trim().toLowerCase();
    if (!accountId && !email) throw httpError(400, 'Provide accountId or email');
    const target = accountId
      ? await prisma.account.findUnique({ where: { id: accountId } })
      : await prisma.account.findUnique({ where: { email } });
    if (!target) {
      throw httpError(404, accountId
        ? 'No such account'
        : `No account with email ${email} — they need to sign in to Headwinds at least once first`);
    }
    if (target.isOG === request.body.og) {
      throw httpError(409, request.body.og
        ? `${target.displayName} already has the OG badge`
        : `${target.displayName} doesn't have the OG badge`);
    }
    const updated = await prisma.account.update({
      where: { id: target.id },
      data: { isOG: request.body.og },
    });
    return { ok: true, account: accountSummary(updated) };
  });

  // ── All worlds, for admin management (any status/visibility) ────────────────
  // Powers the "Manage all worlds" panel: archived/private worlds vanish from the
  // public lobby, so admins need this to find and restore/delete them.
  fastify.get('/admin/worlds', { preHandler: requireAdmin }, async () => {
    const worlds = await prisma.world.findMany({
      include: { _count: { select: { airlines: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return {
      worlds: worlds.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        visibility: w.visibility,
        lengthYears: w.lengthYears,
        weeksPerDay: w.weeksPerDay,
        playerCount: w._count.airlines,
        createdAt: w.createdAt,
        startedAt: w.startedAt,
      })),
    };
  });
}
