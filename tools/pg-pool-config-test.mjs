// Prisma now runs Rust-free over node-postgres (see
// apps/headwinds-server/src/lib/pgPool.mjs for the memory measurements). The
// risk in that move is the DATABASE_URL: node-postgres does not understand
// Prisma's parameters, and handed the production URL as-is it silently
// ignores connection_limit (pool of 10 instead of 5/3), ignores pool_timeout
// (waits forever instead of 20s), and treats sslmode=require as verify-full,
// which refuses Supabase's certificate chain outright.
//
// Verified failing on HEAD: pgPool.mjs does not exist there, so the old call
// path was reproduced in a probe: new pg.Pool({ connectionString: <prod-style
// URL> }) gave max = 10 and no connectionTimeoutMillis, and a client with
// ?sslmode=require failed with "self-signed certificate in certificate chain".
// The first test below keeps that trap on record.
//
//   node tools/pg-pool-config-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgPoolConfig } from '../apps/headwinds-server/src/lib/pgPool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}

// Shapes of the production URLs (OUTAGE notes, 2026-09-21): direct connection,
// API connection_limit=5, worker connection_limit=3, pool_timeout=20.
const HOST = 'postgres:secret@db.example.supabase.co:5432/postgres';
const API_URL = `postgresql://${HOST}?connection_limit=5&pool_timeout=20`;
const WORKER_URL = `postgresql://${HOST}?connection_limit=3&pool_timeout=20`;

// What node-postgres will actually use, after it merges the connection string.
const effective = (poolCfg) => new pg.Client(poolCfg).connectionParameters;

await t('the trap is real: the URL passed straight to pg drops both pool settings', () => {
  const naive = new pg.Pool({ connectionString: API_URL });
  assert.equal(naive.options.max, 10);
  assert.equal(naive.options.connectionTimeoutMillis, undefined);
});

await t('API URL → pool of 5, 20s wait, encrypted', () => {
  const { pool } = pgPoolConfig(API_URL);
  assert.equal(pool.max, 5);
  assert.equal(pool.connectionTimeoutMillis, 20_000);
  assert.deepEqual(pool.ssl, { rejectUnauthorized: false });
  const p = new pg.Pool(pool);
  assert.equal(p.options.max, 5);
  assert.equal(p.options.connectionTimeoutMillis, 20_000);
});

await t('worker URL → pool of 3', () => {
  assert.equal(pgPoolConfig(WORKER_URL).pool.max, 3);
});

await t('every Prisma-only parameter is stripped from what pg sees', () => {
  const url = `postgresql://${HOST}?pgbouncer=true&connection_limit=18&pool_timeout=20&sslmode=require&connect_timeout=5&schema=public&statement_cache_size=0&application_name=headwinds`;
  const { pool, schema } = pgPoolConfig(url);
  const q = new URL(pool.connectionString).searchParams;
  assert.deepEqual([...q.keys()], ['application_name'], 'only non-Prisma params survive');
  assert.equal(schema, 'public');
  assert.equal(pool.max, 18);
});

await t('sslmode=require stays encrypted-but-unverified, as Prisma had it (pg would have made it verify-full)', () => {
  const { pool } = pgPoolConfig(`${API_URL}&sslmode=require`);
  const ssl = effective(pool).ssl;
  assert.ok(ssl && ssl.rejectUnauthorized === false, `effective ssl = ${JSON.stringify(ssl)}`);
});

await t('no sslmode on a remote host is still encrypted (Prisma default was prefer)', () => {
  const ssl = effective(pgPoolConfig(`postgresql://${HOST}`).pool).ssl;
  assert.ok(ssl && ssl.rejectUnauthorized === false, `effective ssl = ${JSON.stringify(ssl)}`);
});

await t('sslmode=disable turns TLS off; verify-full and sslaccept=strict verify', () => {
  assert.equal(effective(pgPoolConfig(`postgresql://${HOST}?sslmode=disable`).pool).ssl, false);
  assert.equal(pgPoolConfig(`postgresql://${HOST}?sslmode=verify-full`).pool.ssl.rejectUnauthorized, true);
  assert.equal(pgPoolConfig(`postgresql://${HOST}?sslaccept=strict`).pool.ssl.rejectUnauthorized, true);
});

await t('a bare localhost URL gets Prisma\'s defaults: no TLS, pool of 10, 10s wait', () => {
  const { pool } = pgPoolConfig('postgresql://u:p@localhost:5432/headwinds');
  assert.equal(pool.ssl, false);
  assert.equal(pool.max, 10);
  assert.equal(pool.connectionTimeoutMillis, 10_000);
});

await t('pool_timeout=0 still means "no timeout"', () => {
  assert.equal(pgPoolConfig(`postgresql://${HOST}?pool_timeout=0`).pool.connectionTimeoutMillis, 0);
});

await t('idle connections are kept for Prisma\'s 300s, not pg\'s 10s', () => {
  assert.equal(pgPoolConfig(API_URL).pool.idleTimeoutMillis, 300_000);
});

await t('credentials and database survive the rewrite', () => {
  const c = effective(pgPoolConfig(API_URL).pool);
  assert.equal(c.user, 'postgres');
  assert.equal(c.password, 'secret');
  assert.equal(c.host, 'db.example.supabase.co');
  assert.equal(c.port, 5432);
  assert.equal(c.database, 'postgres');
});

// ── Dead-peer detection (outage 2026-10-03) ──────────────────────────────────
// Postgres restarted at 6:40 AM PT. Queries the API had in flight sat on sockets
// whose peer was gone without a FIN, so nothing ever answered them. pg sets
// keepAlive with keepAliveInitialDelayMillis defaulting to 0, and 0 means "leave
// the OS value", which on Linux is tcp_keepalive_time = 7200s (+9×75s probes).
// The five stuck queries held the API's whole pool for 2h11m; every other
// request waited out pool_timeout (20s) and failed, while the worker, whose
// idle sockets had aged out, ticked normally. Measured with `ss -tno` on a live
// pool: timer:(keepalive,119min) before, 9.3s with the delay set.
// Verified failing on HEAD: keepAliveInitialDelayMillis was undefined → 0.

await t('dead peers are noticed in seconds, not the 2-hour Linux default', () => {
  for (const url of [API_URL, WORKER_URL]) {
    const { pool } = pgPoolConfig(url);
    assert.equal(pool.keepAlive, true);
    const c = new pg.Client(pool);
    const delay = c.connection._keepAliveInitialDelayMillis;
    assert.ok(delay > 0, `keepAliveInitialDelayMillis is ${delay}: 0 leaves the OS 7200s default`);
    assert.ok(delay <= 30_000, `keepAliveInitialDelayMillis ${delay} is too slow to notice a dead peer`);
  }
});

// ── Connection recycling (same outage) ───────────────────────────────────────
// Before the 6:40 restart Postgres sat at 2.3–2.7 GB committed against a ~2.0 GB
// limit on Small compute, 0.5–0.9 GB in swap; after it, ~300 MB used. A backend
// keeps the memory its largest query needed (our state reads are ~93 MB), and a
// busy pool never idles a connection out, so backends only ever grew. Recycling
// hands that memory back. pg-pool ends an expired client on release, never mid-
// query, so a long tick transaction is not cut off.
// Verified failing on HEAD: maxLifetimeSeconds was undefined → 0 (never).

await t('connections are recycled every 30 minutes by default', () => {
  for (const url of [API_URL, WORKER_URL]) {
    const { pool } = pgPoolConfig(url);
    assert.equal(pool.maxLifetimeSeconds, 1800);
    assert.equal(new pg.Pool(pool).options.maxLifetimeSeconds, 1800);
  }
});

await t('Prisma\'s max_connection_lifetime overrides it, and is stripped from the URL', () => {
  const { pool } = pgPoolConfig(`${API_URL}&max_connection_lifetime=600`);
  assert.equal(pool.maxLifetimeSeconds, 600);
  assert.doesNotMatch(pool.connectionString, /max_connection_lifetime/);
});

await t('a missing URL is a clear error', () => {
  assert.throws(() => pgPoolConfig(undefined), /DATABASE_URL is not set/);
});

// ── Wiring ────────────────────────────────────────────────────────────────────
// Importing db.mjs opens nothing, but asserting on the live client would need a
// database; check the wiring statically, as transient-db-error-test does.

await t('db.mjs builds the client on the adapter through pgPoolConfig', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/headwinds-server/src/db.mjs'), 'utf8');
  assert.match(src, /from '@prisma\/adapter-pg'/);
  assert.match(src, /pgPoolConfig\(process\.env\.DATABASE_URL\)/);
  assert.match(src, /adapter:/);
});

await t('schema.prisma generates the Rust-free client', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/headwinds-server/prisma/schema.prisma'), 'utf8');
  assert.match(src, /generator client \{[^}]*engineType\s*=\s*"client"/s);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
