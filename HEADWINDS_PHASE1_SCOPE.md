# Headwinds — Phase 1 Scope: Server Foundation

*The concrete build plan for Phase 1, building on `HEADWINDS_MULTIPLAYER_PLAN.md`
(esp. §3a world tiers, §8 data model) and the completed Phase 0 engine extraction.*

Status: agreed · Last updated: 2026-06-20

---

## 1. Goal of Phase 1 (and what's explicitly NOT in it)

**Goal:** a player can sign in, browse the worlds that exist, and create or join
one — then sit in it. That's the whole milestone. Proving accounts + persistence +
the lobby end-to-end, *before* any gameplay, so later concurrency bugs can't hide
behind half-built foundations.

**In scope:**
- Managed accounts (sign up / sign in) via Supabase Auth.
- Postgres schema (via Prisma) for accounts, worlds, airlines, and the
  Phase-2-ready tables (decisions, tick log, standings).
- A Fastify API: who am I, list worlds, world detail, create world, join world,
  leave world.
- The **staggered world spawner** — a scheduled job that keeps fresh worlds
  available to join (our §3a decision).
- Deploy: both Node services on Railway, database+auth on Supabase, client stays
  on Vercel.

**NOT in scope (deferred):**
- The authoritative weekly **tick / gameplay** → Phase 2.
- Humans competing in shared demand allocation → Phase 3.
- Live push (SSE), leaderboard UI polish, chat, moderation → Phase 3+.
- The `headwinds-web` client beyond a minimal "list/join worlds" screen → grows in
  Phase 2.

The reason for the hard line: Phase 1 has zero game logic, so if something breaks
it's auth/CRUD/deploy — a small, well-understood surface.

---

## 2. Stack (decided)

| Concern | Choice | Notes |
|---|---|---|
| Database | **Supabase Postgres** | Free tier to build; flip to Pro ($25/mo) when real players exist (never-pauses + backups). |
| Auth | **Supabase Auth** | Bundled with the DB — email + Google/Apple. No separate auth bill. |
| ORM | **Prisma** | Schema-first, great migrations, most AI-assistable. Free (OSS). |
| API framework | **Fastify** | Schema validation doubles as anti-cheat input validation later. |
| App host | **Railway** | API and tick worker run as **two separate services** (architecture rule). Hobby ~$5/mo. |
| Client host | **Vercel** | Unchanged, free hobby tier. |
| Realtime | **Polling for now**, SSE in Phase 3 | Phase 1 has nothing to push yet. |

Cost: ~$0–5/mo to build (Supabase Free + Railway Hobby), ~$30/mo once live
(Supabase Pro + Railway). See `HEADWINDS_MULTIPLAYER_PLAN.md` §12.

---

## 3. Two architecture rules we honor from day one

These are cheap now and save a rewrite later (plan §6):

1. **All authoritative state lives in Postgres, never in server memory.** The
   current `apps/headwinds-server/src/store.mjs` in-memory store is replaced by
   Prisma/Postgres. This is what lets us run multiple stateless API instances
   behind a load balancer whenever we want.
2. **The tick worker is a separate service from the API.** In Phase 1 the "worker"
   only runs the world spawner (no gameplay tick yet), but it ships as its own
   Railway service from the start. When the Phase-2 tick arrives, it slots into
   this same worker — no re-architecture.

---

## 4. Data model (Prisma schema sketch)

Incorporates the §3a world-tier model (`lengthYears`, `weeksPerDay`) and the §8
table set. The big per-airline save blob lands in `Airline.state` (JSONB) — it's
the same JSON shape the solo game already serializes. Queryable fields (cash,
week, status) are promoted to real columns for sorting/leaderboards.

```prisma
// schema.prisma (illustrative — finalized during build)

model Account {
  id            String    @id @default(cuid())
  authUserId    String    @unique          // Supabase auth user id
  email         String    @unique
  displayName   String
  cosmetics     Json      @default("[]")   // unlocked liveries/logos (meta-progression)
  careerStats   Json      @default("{}")   // cross-season hall-of-fame stats
  createdAt     DateTime  @default(now())
  airlines      Airline[]
}

model World {
  id           String    @id @default(cuid())
  name         String
  status       WorldStatus @default(LOBBY)   // LOBBY | RUNNING | ENDED | ARCHIVED
  visibility   Visibility  @default(PUBLIC)  // PUBLIC | PRIVATE
  lengthYears  Int                            // 50 | 100  (§3a)
  weeksPerDay  Int                            // 6 | 12 | 24 | 48  (§3a)
  currentWeek  Int       @default(1)
  currentYear  Int       @default(1)
  maxPlayers   Int       @default(50)
  joinCode     String?   @unique             // for PRIVATE worlds
  worldSeed    String                         // deterministic world generation
  tickConfig   Json      @default("{}")
  startedAt    DateTime?
  endsAt       DateTime?                      // derived: startedAt + lengthYears*52/weeksPerDay days
  createdAt    DateTime  @default(now())
  endedAt      DateTime?
  airlines     Airline[]
  standings    Standing[]
  @@index([status, visibility])
}

model Airline {
  id          String   @id @default(cuid())
  worldId     String
  accountId   String
  name        String
  hub         String
  homeCountry String?
  state       Json                           // ← the existing solo save blob (JSONB)
  cash        BigInt   @default(0)           // promoted for sorting
  marketCap   BigInt   @default(0)
  week        Int      @default(1)
  status      AirlineStatus @default(ACTIVE) // ACTIVE | BANKRUPT | ABANDONED
  joinedWeek  Int      @default(1)
  createdAt   DateTime @default(now())
  world       World    @relation(fields: [worldId], references: [id])
  account     Account  @relation(fields: [accountId], references: [id])
  @@unique([worldId, accountId])             // one airline per account per world
  @@index([worldId, cash])
}

// ── Phase-2-ready (created now, written later) ──────────────────────────────
model Decision {
  id        String   @id @default(cuid())
  worldId   String
  airlineId String
  week      Int
  type      String                           // validated against engine allow-list
  payload   Json
  createdAt DateTime @default(now())
  @@index([worldId, week])
}

model TickLog {
  id         String   @id @default(cuid())
  worldId    String
  week       Int
  startedAt  DateTime @default(now())
  finishedAt DateTime?
  status     String                          // ok | error
  error      String?
  @@index([worldId, week])
}

model Standing {
  id        String @id @default(cuid())
  worldId   String
  airlineId String
  week      Int
  rank      Int
  score     BigInt
  world     World  @relation(fields: [worldId], references: [id])
  @@index([worldId, week, rank])
}

enum WorldStatus { LOBBY RUNNING ENDED ARCHIVED }
enum Visibility  { PUBLIC PRIVATE }
enum AirlineStatus { ACTIVE BANKRUPT ABANDONED }
```

Note `Airline.state` reuses `freshState()` from `@tailwinds/engine` — when a player
joins a world, the server calls `freshState()` (seeded for their hub) and stores
the result. No new state shape to invent.

---

## 5. API surface (Fastify)

All routes require a valid Supabase session JWT (verified server-side) except where
noted. This replaces the minimal REST in `apps/headwinds-server/src/server.mjs`.

```
POST /auth/callback        finalize Supabase session → ensure Account row exists
GET  /me                   current account + its airlines across worlds

GET  /worlds               list worlds; filter by status, visibility, tier (length/pace)
GET  /worlds/:id           world detail: config, progress (year X of N), players, standings
POST /worlds               create a world (config: length, pace, visibility, maxPlayers)
POST /worlds/:id/join      join by id (PUBLIC) or joinCode (PRIVATE) → creates Airline
POST /worlds/:id/leave     abandon airline in a world (status → ABANDONED)
```

Fastify JSON schemas validate every request body — the same mechanism becomes the
Phase-2 anti-cheat boundary on decision endpoints.

---

## 6. The staggered world spawner

A scheduled job in the **worker** service (not the API). On a configurable cadence
it ensures there's always a recently-started public world per tier to join:

- Config: target count of open/young worlds, the `(lengthYears, weeksPerDay)` mix
  across tiers, and the spawn interval. All data, not code (§3a).
- On each run: count public worlds younger than a threshold; spawn new `World`
  rows (status `LOBBY` → `RUNNING` once seeded) to top up the pool.
- Derives `endsAt` from `startedAt + lengthYears*52/weeksPerDay days`.
- Idempotent and logged (same discipline the Phase-2 tick will need).

In Phase 1 the spawner just creates worlds; the per-world weekly **tick** that
advances them is Phase 2 and runs in this same worker.

---

## 7. Repo layout changes (additive)

```
apps/headwinds-server/
  src/
    server.mjs        → Fastify app (replaces the scaffold REST)
    routes/           → me, worlds (handlers)
    db/               → Prisma client + helpers
    auth/             → Supabase JWT verification middleware
    store.mjs         → kept (legacy in-memory demo; not used by the API)
    world.mjs         → keep (tick + allow-list; used in Phase 2)
  worker/
    index.mjs         → separate service entrypoint
    spawner.mjs       → staggered world spawner
  prisma/
    schema.prisma     → the model above (schema lives with the server package)
    migrations/       → generated on first `db:migrate`
  .env.example        → DATABASE_URL, DIRECT_URL, SUPABASE_URL, SUPABASE_ANON_KEY
```

The engine (`@tailwinds/engine`) is consumed unchanged — `freshState()` for new
airlines now, `gameReducer` for the tick in Phase 2.

---

## 8. What you (Dave) set up vs. what I build

**You (accounts/secrets — can't be done from the sandbox):**
1. Create a Supabase project → grab `DATABASE_URL`, `SUPABASE_URL`, anon key, JWT
   secret. Enable email + Google auth providers.
2. Create a Railway project with **two services** from the GitHub repo: `api`
   (start: server) and `worker` (start: worker). Add the env vars to both.
3. (When live) flip Supabase to Pro for backups + no-pause.

**Me (code, in the repo):**
- Prisma schema + migrations, Supabase JWT middleware, the Fastify routes, the
  worker + spawner, `.env.example`, and a local dev path. Plus tests where they can
  run without network.

I'll provide exact click-by-click setup steps when we reach the deploy step.

---

## 9. Build order (checklist)

1. Add Prisma + Fastify deps; `prisma/schema.prisma`; generate client + first
   migration (run against a local or Supabase Postgres).
2. Supabase JWT verification middleware; `/me` + `/auth/callback`.
3. Worlds routes (list/detail/create/join/leave) with Fastify schemas.
4. Worker service + staggered spawner; seed a few worlds across tiers.
5. Minimal client screen in `headwinds-web`: sign in, list worlds, join one.
6. Deploy: Supabase project, Railway api+worker services, env wiring; smoke test
   the full "sign in → see worlds → join" loop in production.

**Guardrails that must stay green throughout:** Phase 0's `golden-master` and the
zero-install engine tests (the engine is untouched, so they should never move).

---

## 10. Open questions to settle as we build

- **Abandoned airlines:** when a player leaves mid-world, does their airline become
  AI-piloted, frozen, or liquidated? (Affects everyone sharing their routes — plan
  §11.) Phase 1 just marks `ABANDONED`; behavior decided in Phase 3.
- **Starting cash / hub choice on join:** reuse solo defaults for now.
- **World naming:** auto-generated names per season, or player-named private worlds
  only? (Moderation surface — keep auto-generated for public worlds initially.)
