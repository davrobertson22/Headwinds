// Prisma client singleton. Both the API and the worker import this so they share
// one connection pool per process. Authoritative state lives in Postgres — never
// in server memory (HEADWINDS_PHASE1_SCOPE.md §3).
import { PrismaClient } from '@prisma/client';

// Reuse a single instance across hot-reloads in dev (node --watch re-imports).
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__headwindsPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__headwindsPrisma = prisma;
}
