// Headwinds API — Fastify, backed by Postgres (Prisma) and Supabase auth.
//
//   npm run -w @headwinds/server dev     # local, auto-reload
//   npm run -w @headwinds/server start   # production
//
// The authoritative weekly TICK is NOT here — it runs in the worker. This service
// is the player-facing API: accounts, the world lobby, and gameplay decisions.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.mjs';
import { prisma } from './db.mjs';
import meRoutes from './routes/me.mjs';
import worldRoutes from './routes/worlds.mjs';
import decisionRoutes from './routes/decisions.mjs';
import allianceRoutes from './routes/alliances.mjs';
import messageRoutes from './routes/messages.mjs';

export function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
  });

  app.register(cors, { origin: env.corsOrigins, credentials: true });

  // Uniform error shape. Respect an error's statusCode (set by our helpers /
  // Fastify's validation); default to 500 and log unexpected ones.
  app.setErrorHandler((err, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error(err);
    reply.code(status).send({ error: err.message || 'Internal Server Error' });
  });

  app.get('/health', async () => ({ ok: true, service: 'headwinds-api' }));

  app.register(meRoutes);
  app.register(worldRoutes);
  app.register(decisionRoutes);
  app.register(allianceRoutes);
  app.register(messageRoutes);

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
