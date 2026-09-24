// Prisma client singleton. Both the API and the worker import this so they share
// one connection pool per process. Authoritative state lives in Postgres — never
// in server memory (HEADWINDS_PHASE1_SCOPE.md §3).
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { pgPoolConfig } from './lib/pgPool.mjs';

// The adapter needs DATABASE_URL when this module loads. The Rust client read it
// lazily and found apps/headwinds-server/.env by itself, so scripts that import
// this file directly (tools/backfill-careers.mjs, tools/reset-empty-worlds.mjs)
// never loaded it. Do that here; never overrides a variable already set (Railway).
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

// Reuse a single instance across hot-reloads in dev (node --watch re-imports).
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__headwindsPrisma ??
  new PrismaClient({
    // Rust-free client over node-postgres (schema.prisma engineType = "client").
    // See lib/pgPool.mjs for why, and for how the URL's Prisma parameters map.
    // No URL (test harnesses that import a route but never query): build the
    // adapter anyway, as the Rust client did — the pool is only opened on the
    // first query. The server and worker still fail fast on it in env.mjs.
    adapter: (() => {
      if (!process.env.DATABASE_URL) return new PrismaPg({});
      const { pool, schema } = pgPoolConfig(process.env.DATABASE_URL);
      return new PrismaPg(pool, schema ? { schema } : undefined);
    })(),
    log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__headwindsPrisma = prisma;
}
