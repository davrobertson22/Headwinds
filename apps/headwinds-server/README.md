# Headwinds — Game Server

Authoritative multiplayer server for Headwinds. Runs the **same simulation engine
as the solo game** (`@tailwinds/engine`) as a server-side authority: clients submit
validated intents, the server runs the weekly tick for a whole world in lockstep.

## Run it

```bash
# End-to-end demo — two players, one world, server-run ticks (no infra needed)
node apps/headwinds-server/demo.mjs

# HTTP API on :8787
node apps/headwinds-server/src/server.mjs
```

## Layout

| File | Role |
|---|---|
| `src/world.mjs` | World model + **authoritative tick** + action allow-list (anti-cheat boundary) |
| `src/store.mjs` | In-memory world store — **swap for Postgres** in production |
| `src/server.mjs` | Minimal REST API (Node built-in `http`) — **port to Fastify** in production |
| `demo.mjs` | Runnable proof of the multiplayer thesis |

## API (current scaffold)

```
GET  /worlds                     → list worlds
POST /worlds                     → create world  { name, pace, seasonEndYear }
GET  /worlds/:id                 → clock + standings
POST /worlds/:id/join            → join          { airlineName, hub }   (x-account-id header)
POST /worlds/:id/actions         → submit intent { type, ... }          (validated)
POST /worlds/:id/tick            → authoritative tick (prod: scheduler-only)
```

## What is real vs. stubbed

**Real / proven:** the engine runs server-side; multiple players share one world;
the weekly tick advances every airline in lockstep via the shared reducer; the
action allow-list rejects illegal client actions (`ADVANCE_WEEK`, `SET_CASH`, …).

**Stubbed (documented next steps):**

1. **Persistence** — `store.mjs` is in-memory. Replace with Postgres (schema in
   `HEADWINDS_MULTIPLAYER_PLAN.md` §8). Keep all state in the DB, never in memory.
2. **Auth** — `accountId` is a faked header. Put managed auth (Clerk/Supabase) in
   front.
3. **Scheduler** — `/tick` is called manually here. In production a per-world
   scheduled worker ticks on the world's pace; `/tick` is not public.
4. **Cross-player demand** — the single biggest engine change for true
   competition: inject other players' routes/prices as competitors in each
   airline's demand model before ticking. See `world.mjs` `tickWorld()` and the
   plan, §2. Today each airline still competes only against AI.
