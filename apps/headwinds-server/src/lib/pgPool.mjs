// Translate a Prisma-style DATABASE_URL into node-postgres Pool options.
// ----------------------------------------------------------------------------
// WHY THIS EXISTS: Prisma's Rust query engine held native memory it never gave
// back. Measured 2026-09-23 against production data (5 running worlds, 91
// airlines, ~93 MB of state JSON per tick-sized read), 4 consecutive reads:
//
//                    after read 1   after read 4   JS heap
//   Rust engine          916 MB        2233 MB      ~89 MB   (and still climbing)
//   + MALLOC_ARENA_MAX=2 944 MB        1565 MB      ~89 MB
//   engineType=client    323 MB         329 MB      ~62 MB   (flat)
//
// That growth was ~$43 of a ~$52 Railway bill: both services sat at 2.5–3.3 GB
// despite NODE_OPTIONS=--max-old-space-size=512, because the memory was never
// in the JS heap. So Prisma now runs Rust-free (schema.prisma engineType =
// "client") over @prisma/adapter-pg, and node-postgres owns the pool.
//
// THE TRAP: node-postgres does not understand Prisma's URL parameters. Handed
// the production URL as-is it silently
//   - ignores connection_limit      → pool of 10, not the 5 (API) / 3 (worker)
//                                     sized against Postgres max_connections = 90
//   - ignores pool_timeout          → waits FOREVER for a connection, where the
//                                     decision commit cutoff (tx.mjs) assumes 20s
//   - treats sslmode=require as verify-full → "self-signed certificate in
//                                     certificate chain": no connection at all.
// Prisma's own default was sslmode=prefer with sslaccept=accept_invalid_certs —
// encrypted, certificate not verified — which is what `ssl` below reproduces.
// Every parameter Prisma consumed is mapped here and stripped from the string.

const PRISMA_ONLY = [
  'connection_limit', 'pool_timeout', 'connect_timeout', 'socket_timeout',
  'pgbouncer', 'sslmode', 'sslaccept', 'sslcert', 'sslidentity', 'sslpassword',
  'schema', 'statement_cache_size', 'max_connection_lifetime', 'max_idle_connection_lifetime',
];

// Prisma's defaults where the URL is silent.
const DEFAULT_POOL_TIMEOUT_S = 10;
const DEFAULT_MAX = 10;
// Prisma kept idle connections for 300s; node-postgres drops them after 10s by
// default, which would add a TLS handshake to most requests on a quiet server.
const IDLE_TIMEOUT_MS = 300_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {string} databaseUrl  a postgres:// URL, possibly carrying Prisma parameters
 * @returns {{ pool: import('pg').PoolConfig, schema: string|null }}
 */
export function pgPoolConfig(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const url = new URL(databaseUrl);
  const q = url.searchParams;

  const max = num(q.get('connection_limit'));
  const poolTimeoutS = num(q.get('pool_timeout'));
  const sslmode = (q.get('sslmode') ?? '').toLowerCase();
  const strict = (q.get('sslaccept') ?? '').toLowerCase() === 'strict'
    || sslmode === 'verify-full' || sslmode === 'verify-ca';
  const schema = q.get('schema') || null;

  let ssl;
  if (sslmode === 'disable') ssl = false;
  else if (strict) ssl = { rejectUnauthorized: true };
  else if (LOCAL_HOSTS.has(url.hostname) && sslmode !== 'require') ssl = false;
  else ssl = { rejectUnauthorized: false };

  for (const k of PRISMA_ONLY) q.delete(k);

  return {
    pool: {
      connectionString: url.toString(),
      ssl,
      max: max && max > 0 ? max : DEFAULT_MAX,
      // pool_timeout=0 means "no timeout" in Prisma; 0 means the same to pg.
      connectionTimeoutMillis: (poolTimeoutS ?? DEFAULT_POOL_TIMEOUT_S) * 1000,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      keepAlive: true,
    },
    schema,
  };
}
