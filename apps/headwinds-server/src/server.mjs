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
import { errorHandler } from './lib/errorHandler.mjs';
import { probeDatabase, healthReport } from './lib/health.mjs';
import meRoutes from './routes/me.mjs';
import playerRoutes from './routes/players.mjs';
import accountMessageRoutes from './routes/accountMessages.mjs';
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
import logoRoutes from './routes/logos.mjs';
import tailwindsSaveRoutes from './routes/tailwindsSaves.mjs';

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

  // Uniform error shape — see lib/errorHandler.mjs.
  app.setErrorHandler(errorHandler);

  // Railway's healthcheck path, and the cheapest way to answer "what is actually
  // running right now?" — which cost us a dashboard hunt on 2026-08-03 while
  // working out whether an egress fix had shipped. Railway injects
  // RAILWAY_GIT_COMMIT_SHA into every deploy; anywhere else it is simply absent
  // and this reports 'unknown' rather than throwing.
  //
  // It also asks Postgres a question. See lib/health.mjs for why: a healthcheck
  // that stays green while every real request times out is how the 2026-09-16
  // outage ran for eighteen hours with every dashboard reporting "Online".
  app.get('/health', async (request, reply) => {
    const db = await probeDatabase(prisma);
    const { status, body } = healthReport({
      db,
      service: 'headwinds-api',
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'unknown',
    });
    return reply.code(status).send(body);
  });

  app.register(meRoutes);
  app.register(playerRoutes);
  app.register(accountMessageRoutes);
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
  app.register(logoRoutes);
  // Tailwinds cloud saves (supporter perk). Its browser origin must be listed in
  // CORS_ORIGINS alongside the Headwinds web client's.
  app.register(tailwindsSaveRoutes);

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
