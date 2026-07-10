# Headwinds — Game Server

Authoritative multiplayer server for Headwinds. Runs the **same simulation engine
as the solo game** (`@tailwinds/engine`) as a server-side authority: clients submit
validated intents, the server runs the weekly tick for a whole world in lockstep.

Two services share this package:

- **API** (`src/server.mjs`) — Fastify, player-facing: accounts + the world lobby.
- **Worker** (`worker/index.mjs`) — background jobs: the staggered world spawner now,
  the authoritative weekly tick in Phase 2.

State lives in **Postgres** (via Prisma); auth is **Supabase**. See
`HEADWINDS_PHASE1_SCOPE.md` for the full plan.

---

## Status

Phase 1 done: accounts, the world data model, the lobby API, the staggered spawner.
Phase 2 done: the authoritative weekly tick — the worker advances every RUNNING
world on its pace schedule (compare-and-set on the world clock for idempotency,
capped catch-up after downtime, TickLog + weekly Standing snapshots) — and the
gameplay decisions API (`POST /worlds/:id/decisions`): allow-listed intents run
through the shared engine reducer; `GET /worlds/:id/airline` returns your
authoritative state. **Not yet:** cross-player demand coupling (Phase 3). The legacy zero-infra in-memory demo (`demo.mjs`, `src/store.mjs`,
`src/world.mjs`) is kept as a runnable illustration and is independent of the DB.

---

## Local setup

```bash
# 1. From the repo root — install workspace deps (links @tailwinds/engine)
npm install

# 2. Configure env
cp apps/headwinds-server/.env.example apps/headwinds-server/.env
#    then fill in DATABASE_URL / DIRECT_URL / SUPABASE_URL / SUPABASE_ANON_KEY

# 3. Create the database schema (uses DIRECT_URL)
npm run -w @headwinds/server db:migrate

# 4. Run the two services (separate terminals)
npm run -w @headwinds/server dev      # API on :8787
npm run -w @headwinds/server worker   # spawner — seeds joinable worlds
```

`GET http://localhost:8787/health` should return `{ ok: true }`. After the worker
runs once, `GET /worlds` lists the freshly spawned worlds.

---

## Setting up Supabase + Railway

**Supabase** (database + auth):
1. Create a project (set a strong database password — you'll need it). Click
   **Connect** → copy the **Session pooler** string (port 5432) into both
   `DATABASE_URL` and `DIRECT_URL`, replacing `[YOUR-PASSWORD]`.
2. Project Settings → API (or **API Keys**) → copy `SUPABASE_URL` (Project URL)
   and the `anon` / publishable key into `SUPABASE_ANON_KEY`.
3. Authentication → Providers → enable Email (Google can come later — it needs a
   Google Cloud OAuth client).

**Railway** (two services from this repo):
1. New project → Deploy from GitHub repo.
2. Service **api**: start command `npm run -w @headwinds/server start`
   (build: `npm install && npm run -w @headwinds/server db:generate`).
3. Service **worker**: start command `npm run -w @headwinds/server worker`.
4. Add the same env vars to both services. Run `db:deploy` once (Railway shell or
   a one-off) to apply migrations in production.

---

## API (Phase 1)

All routes return JSON. Authed routes need `Authorization: Bearer <supabase-token>`.

```
GET  /health                         → liveness
GET  /me                      (auth) → account + your airlines across worlds
GET  /worlds      [?status&length&pace]  → list PUBLIC worlds (with filters)
GET  /worlds/:id                     → world detail + standings
POST /worlds                  (auth) → create world { lengthYears, weeksPerDay, name?, visibility?, maxPlayers? }
POST /worlds/:id/join         (auth) → join → creates your airline { airlineName, hub, joinCode? }
POST /worlds/:id/leave        (auth) → abandon your airline in this world
```

World tiers (validated): `lengthYears ∈ {50, 100}`, `weeksPerDay ∈ {6, 12, 24, 48}`
(HEADWINDS_MULTIPLAYER_PLAN.md §3a).

---

## Layout

| Path | Role |
|---|---|
| `prisma/schema.prisma` | Postgres schema (Account, World, Airline, + Phase-2 tables) |
| `src/server.mjs` | Fastify app + route registration |
| `src/auth.mjs` | Supabase token verification → ensures an Account |
| `src/db.mjs` | Prisma client singleton |
| `src/lib/worldConfig.mjs` | tier constants, `endsAt`/tick derivations, serializers |
| `src/lib/worldService.mjs` | create / join a world (seeds airlines from the engine) |
| `src/routes/*` | `me`, `worlds` handlers |
| `worker/index.mjs` | worker entrypoint (runs the spawner on an interval) |
| `worker/spawner.mjs` | staggered world spawner (keeps fresh worlds joinable) |
| `src/world.mjs` | tick + action allow-list — **used by the Phase-2 tick** |
| `demo.mjs`, `src/store.mjs` | legacy zero-infra in-memory proof (independent) |

---

## Still ahead (Phase 2+)

1. **The authoritative tick** — the worker advances each running world one
   game-week on its pace, through the shared reducer, writing all airline state
   atomically; idempotent + logged via `TickLog`.
2. **Cross-player demand** — inject other players' routes/prices as competitors in
   each airline's demand model before ticking (the one big engine change for true
   competition; see `world.mjs` `tickWorld()` and plan §2).
3. **Live push (SSE)** + standings UI, then seasons/lobbies and moderation.
