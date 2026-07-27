# Outage: "The server did not respond — retrying…" (2026-07-27)

## What players saw

The world screen never loaded. In its place, the connection banner shipped the
day before:

> The server did not respond — retrying…

That banner is correct — it fires when a request exceeds the client's 15s budget
(`apps/headwinds-web/src/api.js`, `REQUEST_TIMEOUT_MS`). It was reporting a real
upstream failure, not a client bug.

## Measurements

Taken from a browser against production while the outage was live:

| Endpoint | Result |
| --- | --- |
| `api.headwindsairlinegame.com/health` | **15 ms**, steady |
| Supabase `/rest/v1/` (PostgREST → Postgres) | **45 ms** |
| Supabase `/auth/v1/health` (GoTrue) | **18.0s / 0.9s / 18.7s** on three consecutive calls |
| Supabase `/auth/v1/user` (GoTrue) | **35.2s → 504 Gateway Timeout** |
| `GET /worlds` | **7.6s**, then **1.2s** — wildly variable |
| `GET /worlds/:id/airline` (week-109 airline) | **22.8s**, **3.66 MB** uncompressed |

Supabase's public status page reported all systems operational throughout, so
this was specific to the project, not a platform incident.

## Root cause

Every authenticated route ran through `resolveAccount()`, which called
`supabase.auth.getUser(token)` on each cache miss — **one network round-trip to
GoTrue per request, with no timeout**. When GoTrue degraded, every game request
inherited a 35s hang, which the client's 15s budget turned into the banner.

Two things made it worse than a slow game:

1. **A failure to reach GoTrue was reported as `401 Invalid or expired
   session`.** The client reads 401 as a dead session, so an outage that had
   nothing to do with a player's credentials could sign them out mid-game.
2. **`refreshSession()` on the client had no timeout either**, so the recovery
   path could hang for as long as the request it was trying to rescue.

## Fixes shipped

| Change | File |
| --- | --- |
| Verify access tokens **locally** against the project's published JWKS (ES256/RS256) — gameplay no longer depends on GoTrue being reachable | `apps/headwinds-server/src/lib/jwt.mjs` (new) |
| Time-box every call to the auth provider (5s); classify an unreachable provider as **503, not 401**; serve a recently-cached account for up to 10 minutes during an outage | `apps/headwinds-server/src/auth.mjs` |
| Cache accounts by Supabase **user id** rather than by the hourly-rotating token, and `SELECT` before `UPDATE` instead of upserting on every poll | `apps/headwinds-server/src/auth.mjs` |
| Client treats **502/503/504 as transient** and retries; 500 still surfaces as a real error | `apps/headwinds-web/src/api.js` |
| Time-box `refreshSession()` at 10s | `apps/headwinds-web/src/authedApi.js` |
| gzip/brotli on responses over 4 KB — the 3.66 MB state blob was going out uncompressed | `apps/headwinds-server/src/server.mjs` |
| 19 tests: real ES256/RS256 keypairs, forged/tampered/expired/wrong-issuer tokens, `alg:none`, algorithm substitution, unknown-kid fallback, 503-is-transient | `tools/auth-verify-test.mjs` (new) |

After this, a GoTrue outage no longer touches players who are already signed in.
Only **fresh sign-ins** — which have to talk to GoTrue regardless — are affected.

## Open question: are we starving Postgres of connections?

Worth checking, because the evidence points at it and it is the one part of this
we could still be causing ourselves.

**The shape of the data.** PostgREST answered in 45 ms while GoTrue took 18-35s.
Those two reach the database differently: PostgREST and Supavisor hold long-lived
pools that were already established, whereas GoTrue opens connections directly to
Postgres. A service that is slow *only when it needs a new connection* is the
signature of a connection ceiling, not a slow database. Our own queries were
erratic in the same window (`GET /worlds` at 7.6s, then 1.2s), which fits
requests queueing for a pooler slot.

**Why we might be the cause.** `DATABASE_URL` is the Supavisor **session** pooler
(port 5432). Session mode pins one real Postgres connection per client connection
for its entire lifetime. Two Railway services (`api` and `worker`) each hold a
Prisma pool, and neither sets `connection_limit` — Prisma's default is
`num_cpus * 2 + 1`, which on a Railway container can be 9-17 **per service**.
Add PostgREST, Realtime, Storage and GoTrue's own pool, and a small instance's
`max_connections` is not far away.

**What to check** (Supabase dashboard):

- Database → Roles: connection counts per role. `postgres` (us, via Supavisor)
  vs `supabase_auth_admin` (GoTrue).
- Database → Connection pooling: Supavisor's configured `pool_size`.
- Reports → Database: connection count against the instance maximum, over the
  outage window.

**Remedies, cheapest first:**

1. **Cap Prisma's pool.** Append `?connection_limit=5&pool_timeout=20` to
   `DATABASE_URL` on both the api and worker services. Low risk, reversible, and
   it bounds the worst case immediately. The worker can go lower still — it runs
   one tick loop, not concurrent player traffic.
2. **Move to the transaction pooler** (same string, port **6543**, plus
   `&pgbouncer=true`), keeping `DIRECT_URL` on 5432 for migrations. Transaction
   mode multiplexes many clients onto few Postgres connections. Test first: it
   disables prepared statements, and the tick's interactive `$transaction` blocks
   should be exercised on a staging world before this goes live.
3. **Raise the instance size** if the counts show genuine demand rather than
   waste. Only worth doing after 1 and 2, which may make it unnecessary.

Note that the auth fix above also removes what was probably the largest single
source of load on GoTrue: one `getUser()` per player per 30 seconds, each of
which was itself a database query against the same instance.
