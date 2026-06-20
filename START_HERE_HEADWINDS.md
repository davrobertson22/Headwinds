# START HERE — Headwinds session guide

**Read this first.** You (a fresh Claude session) are connected to the **Headwinds**
folder. This document is your handoff brief: what this project is, what already
exists, how to run it, and what to build next.

---

## 1. What this is

This folder is a **complete, standalone copy of "Tailwinds"** — a working airline
management game (React 18 + Vite, fully client-side). Your job is to evolve this
copy into **Headwinds, the multiplayer version**, while keeping the original
single-player game intact as the "solo" mode and shared foundation.

- **Tailwinds** = the existing solo game. It runs entirely in the browser, saves to
  `localStorage`, and advances one game-week per real hour. It works today.
- **Headwinds** = the multiplayer game you are building. Many human players share
  one world; a **server** runs the authoritative weekly tick. It is **scaffolded
  but not finished** — see §5.

This is a *copy*. It has no shared git history with the original Tailwinds repo and
you can change anything here freely without affecting the original. (Run
`git init` to start version control — see §3.)

## 2. Read these two design docs before coding

1. **`HEADWINDS_MULTIPLAYER_PLAN.md`** — the full technical + product plan:
   architecture, the one hard problem (authoritative server tick + fair demand
   allocation), persistent-world-vs-seasons model, hosting recommendations
   (cheap start ~$5–25/mo → scale ~$50–300/mo), data model, phased roadmap, costs.
2. **`README-MONOREPO.md`** — how the shared-engine monorepo scaffold is laid out
   and how to finish the engine extraction safely.

Everything below is a summary; those two files are the source of truth.

## 3. First commands (run these to get oriented)

```bash
# 1. Install deps fresh (the copy intentionally ships without node_modules)
npm install

# 2. Confirm the solo game still works
npm run dev          # http://localhost:5173 — play Tailwinds
npm run build        # production build (must pass)
npm test             # engine test suite — expect "28 passed, 0 failed"

# 3. Confirm the engine parity guardrail
node tools/golden-master/run.mjs          # expect "✓ PARITY OK"

# 4. See the multiplayer scaffold work end-to-end (needs the engine link below)
node apps/headwinds-server/demo.mjs       # two players, one world, server-run ticks
```

**Engine link for the server.** `apps/headwinds-server` imports `@tailwinds/engine`.
Make that bare specifier resolve in one of two ways:

```bash
# Option A — formalize npm workspaces (recommended). Add to package.json:
#   "workspaces": ["packages/*", "apps/*"]
# then:
npm install

# Option B — quick relative symlink (what workspaces create anyway):
mkdir -p node_modules/@tailwinds && ln -sfn ../../packages/engine node_modules/@tailwinds/engine
```

The golden master (`tools/golden-master`) uses **relative** imports, so it runs with
zero install — handy as a fast sanity check.

## 4. Repo map

```
/                          solo game (Tailwinds) — the app + (today) the engine source
  src/
    store/GameContext.jsx    the reducer (the whole game tick lives here) + React provider
    store/_engine.generated.mjs   React-free copy of the reducer (server-runnable)
    utils/ models/ data/     the PURE engine + reference data (no React/DOM/localStorage)
    components/              React UI (~40 components)
    App.jsx                  drives the weekly clock (1 wk / real hour)
  packages/
    engine/                @tailwinds/engine — the SHARED engine entrypoint
      index.mjs              namespaced re-exports of the pure sim + data
      reducer.mjs            gameReducer + freshState (what the server runs)
  apps/
    headwinds-server/      authoritative multiplayer server (scaffold, runnable)
      src/world.mjs          world model + authoritative tick + anti-cheat allow-list
      src/store.mjs          in-memory store  → replace with Postgres
      src/server.mjs         minimal REST API → replace with Fastify
      demo.mjs               end-to-end proof
    headwinds-web/         multiplayer client — PLACEHOLDER, build this
  tools/
    golden-master/         engine behavior-parity guardrail
    *.mjs                  existing engine tests
  HEADWINDS_MULTIPLAYER_PLAN.md   ← the plan
  README-MONOREPO.md              ← scaffold + extraction guide
```

## 5. What's done vs. what to build

**Already proven / working:**
- The solo game (unchanged).
- The shared engine package — both games can import one engine entrypoint.
- The server runs the engine as an authoritative tick; multiple players share a
  world; ticks advance everyone in lockstep; the action allow-list blocks illegal
  client actions (`ADVANCE_WEEK`, `SET_CASH`, …).
- A deterministic golden-master guardrail.

**Not built yet — your roadmap (priority order, from the plan):**

1. **Phase 0 — finish the engine extraction.** Physically move the pure modules
   into `packages/engine` and leave re-export shims in `src/` (steps in
   `README-MONOREPO.md`). Keep the golden master green at every step.
2. **Phase 1 — server foundation.** Replace the in-memory store with **Postgres**,
   put **managed auth** (Clerk/Supabase) in front of `accountId`, port the API to
   **Fastify**, run the tick from a **scheduled worker** (not a public endpoint).
3. **Phase 2 — one human + AI, end-to-end through the server**, with the
   `headwinds-web` client submitting actions and rendering server state.
4. **Phase 3 — true multiplayer.** The key engine change: make players compete by
   injecting other players' routes/prices as competitors in each airline's demand
   model before ticking (see `apps/headwinds-server/src/world.mjs` `tickWorld()`
   and plan §2). Add standings/leaderboards and a "week advanced" push (SSE).
5. **Phase 4 — seasons & lobbies** (world lifecycle, private join codes, public
   worlds, meta-progression). **Phase 5 — moderation, balance, scale.**

## 6. Rules / conventions (important)

- **Keep the engine pure.** Nothing in `src/utils`, `src/models`, `src/data`, or
  `packages/engine` may import React, touch the DOM, or use `localStorage`/`window`.
  Purity is what lets the server run it. (It's clean today — keep it that way.)
- **The server is the source of truth.** Clients submit *intents* from the
  allow-list in `world.mjs`; the server re-runs them through the reducer. Never let
  the client compute authoritative results. A client may run the engine locally
  only for instant UI *preview*.
- **Golden master must stay green.** Any change meant to preserve behavior (e.g.
  the Phase 0 move) must keep `node tools/golden-master/run.mjs` printing
  `✓ PARITY OK`. If you *intend* to change game logic, update the baseline with
  `node tools/golden-master/run.mjs --update` and note why.
- **Don't break solo.** `npm run build` and `npm test` must keep passing.
- **Branding.** This is still named/branded "Tailwinds" internally (e.g.
  `package.json` name, app title, logos in `public/`). Rebranding the multiplayer
  surfaces to "Headwinds" is a task, not done yet.

## 7. If you get stuck

- The plan answers most "how/why" questions: `HEADWINDS_MULTIPLAYER_PLAN.md`.
- The reducer is the heart of the game: `src/store/GameContext.jsx` (and its
  React-free twin `src/store/_engine.generated.mjs`).
- Run the demo and the golden master — they're the fastest way to see the engine
  and the server behave.
