// Headwinds API — Fastify, backed by Postgres (Prisma) and Supabase auth.
//
//   npm run -w @headwinds/server dev     # local, auto-reload
//   npm run -w @headwinds/server start   # production
//
// The authoritative weekly TICK is NOT here — it runs in the worker. This service
// is the player-facing API: accounts, the world lobby, and gameplay decisions.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import { env } from './env.mjs';
import { prisma } from './db.mjs';
import { isTransientTxError } from './lib/tx.mjs';
import meRoutes from './routes/me.mjs';
import worldRoutes from './routes/worlds.mjs';
import newsRoutes from './routes/news.mjs';
import decisionRoutes from './routes/decisions.mjs';
import gateRoutes from './routes/gates.mjs';
import aircraftMarketRoutes from './routes/aircraftMarket.mjs';
import allianceRoutes from './routes/alliances.mjs';
import codeshareRoutes from './routes/codeshares.mjs';
import messageRoutes from './routes/messages.mjs';
import reportRoutes from './routes/reports.mjs';
import adminRoutes from './routes/admin.mjs';

export function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
  });

  app.register(cors, { origin: env.corsOrigins, credentials: true });

  // The airline state blob is the biggest thing this API sends: a week-109
  // airline measured 3.66 MB of JSON, uncompressed, on every changed poll. JSON
  // that repetitive compresses roughly 10:1, so this is the single cheapest way
  // to cut both the time a player waits for a world to load and the Supabase
  // egress bill. `threshold` leaves the small lobby/stamp responses alone, where
  // the compression round-trip would cost more than it saves.
  app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'], threshold: 4096 });

  // Uniform error shape. Respect an error's statusCode (set by our helpers /
  // Fastify's validation); default to 500 and log unexpected ones.
  //
  // Below 500 the message is ours and is written for the player, so it is sent
  // as-is. At 500+ it is NOT: it is whatever the driver said, and the client
  // renders `error` directly in a toast — which is how players ended up staring at
  // "Invalid `prisma.airline.updateMany()` invocation: Transaction API error...".
  // Internals stay in the log; the player gets something actionable.
  app.setErrorHandler((err, request, reply) => {
    // A transaction that timed out or lost a deadlock is not a broken request —
    // it is a busy database. Say so, and mark it retryable so the client can just
    // re-submit instead of telling the player their move failed.
    const transient = !err.statusCode && isTransientTxError(err);
    const status = err.statusCode ?? (transient ? 503 : 500);

    if (status >= 500) request.log.error(err);
    // Below 500, pass through the machine-readable code when a helper set one.
    // Read from `appCode`, NOT `code`: Prisma ('P2028') and Fastify
    // ('FST_ERR_VALIDATION') both put their own values on `err.code`, and
    // isTransientTxError above matches on it — a name collision here would be a
    // very quiet way to break transient-failure retry.
    // The client cannot decide whether a failed write is safe to re-submit from
    // the status alone — 409 is both "lost the version check, nothing written"
    // and "your airline is BANKRUPT". See apps/headwinds-web/src/decisionPolicy.js.
    if (status < 500) {
      return reply.code(status).send({
        error: err.message || 'Request failed',
        ...(err.appCode ? { code: err.appCode } : {}),
      });
    }

    return reply.code(status).send({
      error: transient
        ? 'The world is busy committing this week — give it a moment and try again.'
        : 'Something went wrong on our end. Try again in a moment.',
      retryable: transient,
    });
  });

  // Railway's healthcheck path, and the cheapest way to answer "what is actually
  // running right now?" — which cost us a dashboard hunt on 2026-08-03 while
  // working out whether an egress fix had shipped. Railway injects
  // RAILWAY_GIT_COMMIT_SHA into every deploy; anywhere else it is simply absent
  // and this reports 'unknown' rather than throwing.
  app.get('/health', async () => ({
    ok: true,
    service: 'headwinds-api',
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'unknown',
  }));

  app.register(meRoutes);
  app.register(worldRoutes);
  app.register(newsRoutes);
  app.register(decisionRoutes);
  app.register(gateRoutes);
  app.register(aircraftMarketRoutes);
  app.register(allianceRoutes);
  app.register(codeshareRoutes);
  app.register(messageRoutes);
  app.register(reportRoutes);
  app.register(adminRoutes);

  return app;
}

// Start only when run directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildServer();
  app.listen({ port: env.port, host: '0.0.0.0' })
    .then(() => app.log.info(`Headwinds API on :${env.port}`))
    .catch((err) => { app.log.error(err); process.exit(1); });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    });
  }
}
