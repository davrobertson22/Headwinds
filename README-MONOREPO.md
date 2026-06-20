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

**The pure engine modules have been physically moved into the package** (Phase 0
move, commit `996b77c`). `@tailwinds/engine` now owns the real source in
`packages/engine/src/{utils,models,data}/`; the old `src/` paths are thin
`export *` re-export shims that forward to it. Both games depend on one entrypoint:

- **Tailwinds (solo)** still imports from its `src/` paths — those are now shims
  that forward into the package, so the app's import sites are unchanged.
- **Headwinds (server)** imports `@tailwinds/engine/reducer` and runs the tick.

A relative symlink at `node_modules/@tailwinds/engine → packages/engine` makes the
bare specifier resolve — this is exactly what `npm` workspaces create, so it keeps
working once you formalize workspaces.

## Finishing the extraction (Phase 0)

**Done (commit `996b77c`):**

- ✅ Moved the 17 pure modules into `packages/engine/src/{utils,models,data}/`,
  preserving the `utils/models/data` layout so every intra-engine relative import
  resolves unchanged.
- ✅ Left `export *` re-export shims at the old `src/` paths (no default exports
  exist, so `export *` forwards the full surface) — the solo app's import sites are
  untouched.
- ✅ Repointed `packages/engine/index.mjs` at the package's own `./src` modules and
  added `src` to the package `files` manifest.
- ✅ Guardrails green: golden master `✓ PARITY OK`; cargo/multistop/multistop-edge
  tests pass; server demo runs the authoritative tick through the moved engine.

**Done (reducer extraction commit — see git log):**

- ✅ Extracted the canonical reducer to `packages/engine/src/reducer.mjs`
  (`gameReducer` + `freshState` + `reconcileState`), taken **verbatim** from
  `GameContext.jsx` — confirmed byte-identical via `diff` against the pre-change
  file, so solo behavior is unchanged.
- ✅ `GameContext.jsx` shrank from ~2,200 lines to ~50: it now imports the reducer
  from the engine and is purely the React binding (provider + localStorage + hook).
- ✅ **Fixed a latent drift bug.** The old `src/store/_engine.generated.mjs` (what
  the server/golden-master ran) had fallen behind `GameContext.jsx` — it was missing
  the `ADD_TAG_ROUTE`, `SET_BRANDING`, `SET_SEGMENT_PRICE` actions plus seasonal /
  multi-stop route logic. The golden master only said "PARITY OK" because its
  baseline was generated *from* that stale file. The stale copy is now **deleted**;
  `harness.mjs`, `packages/engine/reducer.mjs`, and the solo app all import the one
  canonical module. The golden-master baseline was regenerated (`--update`) because
  the server now runs the newer, correct logic; the scenario's economic summary is
  unchanged — only the state *shape* gained the newer fields (e.g. `customLogo`,
  route `stops`).

**Remaining Phase 0 work:**

1. **Verify on macOS** (can't run in the Cloud sandbox — npm registry is blocked and
   the Vite build needs a browser toolchain): `npm install`, then `npm run build`
   and the full `npm test` (the babel/jsx-dependent suites — `reducer-tag`,
   `seasonal`, `ui-smoke`, `route-config` — only run with deps installed).
2. **Formalize npm workspaces** — add `"workspaces": ["packages/*", "apps/*"]` to the
   root `package.json` and `npm install`, so `@tailwinds/engine` resolves without the
   manual `node_modules/@tailwinds/engine` symlink.
3. *(Optional, gradual)* repoint solo-app imports from the `src/` shims to
   `@tailwinds/engine` directly, then delete the shims.

**Run the guardrails after every step — they must stay green:**

```bash
node tools/golden-master/run.mjs     # must print ✓ PARITY OK
npm test                              # full suite (needs deps; run on macOS)
npm run build                         # browser build (run on macOS)
```

A `✗ MISMATCH` from the golden master means a change altered behavior — revert and
investigate before continuing.

## Notes / caveats

- The Vite **browser build** and the **full `npm test`** were not run in the cloud
  sandbox: the npm registry is blocked there (403) so deps can't be installed, and
  the build needs a browser toolchain. The Node-level, zero-install guardrails were
  run and are green (see above). **Confirm `npm run build` + `npm test` on your Mac.**
- `node_modules` is gitignored, including the `@tailwinds/engine` symlink — recreate
  it locally via workspaces (`npm install` after adding the `workspaces` field) or the
  manual `ln -sfn ../../packages/engine node_modules/@tailwinds/engine`.
