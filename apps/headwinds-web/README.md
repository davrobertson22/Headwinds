# Headwinds — Web Client

The multiplayer client. **Phase 1 is built**: sign in (Supabase — Google or email
magic link) → browse public worlds → create a world (public, or private with a
join code) → join with an airline name + hub → sit in the live lobby watching
standings. Gameplay (submitting decisions against the server tick) is Phase 2.

## Run it

```bash
# From the repo root (installs workspace deps, links @tailwinds/engine)
npm install

# Configure
cp apps/headwinds-web/.env.example apps/headwinds-web/.env.local
#   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — same values as the server's .env
#   VITE_API_URL — where @headwinds/server runs (default http://localhost:8787)

# Dev server (with the API + worker running — see apps/headwinds-server/README.md)
npm run web:dev          # → http://localhost:5173
```

## Shape

- `src/App.jsx` — the whole Phase-1 UI: session hook, hash router (`#/` worlds,
  `#/w/<id>` world), sign-in, world list + create form, join form, lobby/standings
  with 5s polling.
- `src/api.js` — fetch wrapper; sends the Supabase access token as a Bearer header.
- `src/supabase.js` — browser auth client (null when env is missing → setup notice).
- The hub picker imports `AIRPORTS` directly from `@tailwinds/engine` — the same
  data the game runs on.

Smoke-tested by `tools/headwinds-web-smoke-test.mjs` (SSR-renders the real App;
part of `npm test`).

## Phase 2 (next)

Submit decisions to the server (`POST /worlds/:id/decisions`), render the
server-computed weekly results, and reuse the solo game's screens with the data
source swapped from localStorage to the API. See `HEADWINDS_PHASE1_SCOPE.md` §"Not
in Phase 1" and the plan's §10 roadmap.
