# Headwinds — Web Client (placeholder)

The multiplayer client. **Not built yet** — this directory is a placeholder so the
monorepo shape is clear.

## What goes here

A React/Vite app (sibling to the solo Tailwinds app) that is the *thin client*
described in `HEADWINDS_MULTIPLAYER_PLAN.md`:

- Imports `@tailwinds/engine` for **local "preview" simulation only** (instant UI
  feedback) — never as the source of truth.
- Submits player intents to `@headwinds/server` (`POST /worlds/:id/actions`).
- Reads authoritative world state + standings from the server.
- Subscribes to "week advanced" events (SSE first, WebSockets later).
- Reuses the solo game's UI components wherever possible — the two games share
  the engine and most of the look, and differ in the data source (local state vs.
  server) and the multiplayer-only screens (lobby, world browser, standings).

## How it differs from the solo app

| | Tailwinds (solo) | Headwinds (this app) |
|---|---|---|
| Engine runs | in the browser (authoritative) | on the server (authoritative); browser only previews |
| State | localStorage | server / Postgres |
| Accounts | none | required (managed auth) |
| Time | client clock (1 wk/hr) | server scheduler, lockstep for the whole world |

## Recommended first step

Stand up Vite + React here, point an API client at the running
`@headwinds/server`, and build the **lobby → join → dashboard** flow against the
endpoints already scaffolded in `apps/headwinds-server/src/server.mjs`.
