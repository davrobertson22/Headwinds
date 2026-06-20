# Monorepo scaffold — Tailwinds (solo) + Headwinds (multiplayer)

This scaffold turns the project into two games that **share one engine**, per
`HEADWINDS_MULTIPLAYER_PLAN.md`. It was added **additively** — your existing solo
game in `src/` is untouched and still builds/runs exactly as before.

```
/                          ← solo game (Tailwinds) — UNCHANGED, still builds from here
  src/                       the app + (today) the engine source lives here
  packages/
    engine/                ← @tailwinds/engine — shared engine entrypoint
      index.mjs              namespaced re-exports of the pure sim + data
      reducer.mjs            the pure gameReducer + freshState (server-runnable)
      package.json           name, exports
  apps/
    headwinds-server/      ← @headwinds/server — authoritative multiplayer server
      src/world.mjs          world model + authoritative tick + anti-cheat allow-list
      src/store.mjs          in-memory store (→ Postgres)
      src/server.mjs         minimal REST API (→ Fastify)
      demo.mjs               runnable end-to-end proof
    headwinds-web/         ← multiplayer client (placeholder)
  tools/
    golden-master/         ← behavior-parity guardrail for the engine extraction
      harness.mjs / run.mjs / golden.json
```

## Try it

```bash
node apps/headwinds-server/demo.mjs       # two players, one world, server-run ticks
node tools/golden-master/run.mjs          # engine parity check (✓ PARITY OK)
npm test                                   # existing engine tests (28 passing)
```

## How "shared architecture" works right now

`@tailwinds/engine` is currently a **facade** that re-exports the pure modules
already in `src/` (audited: zero React/DOM/localStorage). Both games depend on
this one entrypoint:

- **Tailwinds (solo)** still imports from `src/` directly (unchanged).
- **Headwinds (server)** imports `@tailwinds/engine/reducer` and runs the tick.

A relative symlink at `node_modules/@tailwinds/engine → packages/engine` makes the
bare specifier resolve — this is exactly what `npm` workspaces create, so it keeps
working once you formalize workspaces.

## Finishing the extraction (Phase 0 — do when you can run a local build)

This scaffold deliberately stopped short of moving code, because the working tree
has uncommitted changes and a browser build can't be verified in this environment.
When you're ready, on a clean branch:

1. **Commit your current WIP first** (so the move is isolated and reversible).
2. Add workspaces to the root `package.json`:
   ```json
   "workspaces": ["packages/*", "apps/*"]
   ```
   then `npm install` to link the packages properly.
3. **Physically move** the pure modules into the package, preserving their relative
   layout so internal imports keep resolving unchanged:
   `src/utils/{simulation,market,fuel,financeProjection}.js`,
   `src/models/{network,encroachment,demand}.js`,
   `src/data/*.js` → `packages/engine/src/{utils,models,data}/`.
4. Leave **thin re-export shims** at the old `src/` paths (e.g.
   `export * from '@tailwinds/engine/...'`) so the solo app's ~30 import sites keep
   working with zero edits. Remove them gradually by repointing imports to
   `@tailwinds/engine`.
5. Extract the pure reducer out of `GameContext.jsx` into `packages/engine` as the
   single source of truth; have the solo app's React provider import it from there.
   (Today `reducer.mjs` re-exports the existing React-free `_engine.generated.mjs`.)
6. **After every step run the guardrails** — they must stay green:
   ```bash
   node tools/golden-master/run.mjs     # must print ✓ PARITY OK
   npm test                              # 28 passing
   npm run build                         # browser build (verify locally)
   ```
   A `✗ MISMATCH` from the golden master means the move changed behavior — revert
   and investigate before continuing.

## Notes / caveats

- The Vite **browser build** was not run here (the checked-in `node_modules` is
  macOS; this sandbox is Linux — a platform mismatch, not a code issue). Verify
  `npm run build` on your machine.
- Everything Node-level **was** verified here: engine tests (28 passing), golden
  master (deterministic, parity-stable), the server demo, and the HTTP API.
