# Deploying Headwinds

Three pieces, per `HEADWINDS_PHASE1_SCOPE.md` §2:

| Piece | Host | What it runs |
|---|---|---|
| Database + Auth | **Supabase** (already set up) | Postgres, Google/email sign-in |
| API + Worker | **Railway** — two services, one repo | `@headwinds/server` |
| Web client | **Vercel** | `@headwinds/web` |

Do them in this order. Total time ~30–45 min the first time.

---

## 0. Before you start

- Push `main` to GitHub (both Railway and Vercel deploy from the repo).
- Supabase dashboard → confirm the project is not paused.
- Supabase → Authentication → Providers → enable **Google** (email links already work).
- Have handy (Supabase → Project Settings → API / Database):
  `DATABASE_URL` (session pooler, port 5432), `SUPABASE_URL`, `SUPABASE_ANON_KEY`
  — the same values already in `apps/headwinds-server/.env`.

---

## 1. Railway — API + worker (two services)

1. railway.app → New Project → **Deploy from GitHub repo** → pick `Headwinds`.
2. The first service becomes the **API**. Settings:
   - **Start command:** `npm run server:start`
   - **Healthcheck path:** `/health`
   - **Pre-deploy (release) command:** `npm run db:deploy`  ← runs Prisma migrations
   - **Variables:** `DATABASE_URL`, `DIRECT_URL` (same value), `SUPABASE_URL`,
     `SUPABASE_ANON_KEY`, and later `CORS_ORIGINS` (step 3).
   - Networking → **Generate domain** → note it, e.g. `headwinds-api.up.railway.app`.
3. Project → **+ New → GitHub repo → same repo** — this is the **worker**:
   - **Start command:** `npm run worker:start`
   - Same variables as the API (no domain needed — it serves no HTTP).
4. Both deploy on every push to `main` from now on.

Notes: `prisma generate` runs automatically on install (postinstall hook).
Node 22 is pinned by `engines` in package.json (supabase-js needs native WebSocket, Node 22+).

---

## 2. Vercel — web client

1. vercel.com → Add New Project → import the `Headwinds` GitHub repo.
2. **Root Directory:** `apps/headwinds-web`
   → expand *Root Directory* settings and **enable "Include source files outside
   of the Root Directory"** (the client imports the engine + game UI from the
   repo root; the build needs them).
3. Framework auto-detects Vite (`vercel.json` is provided). Env vars:
   - `VITE_SUPABASE_URL` — same as server
   - `VITE_SUPABASE_ANON_KEY` — same as server
   - `VITE_API_URL` — `https://<your-railway-api-domain>` (no trailing slash)
4. Deploy → note the URL, e.g. `headwinds.vercel.app`.

---

## 3. Point the pieces at each other

1. Railway → API service → Variables → set
   `CORS_ORIGINS=https://<your-vercel-domain>` (comma-add `http://localhost:5173`
   if you still want local dev against prod). Redeploy.
2. Supabase → Authentication → **URL Configuration**:
   - Site URL: `https://<your-vercel-domain>`
   - Redirect URLs: add `https://<your-vercel-domain>` (and keep
     `http://localhost:5173` for local dev).
   Without this, Google/email sign-in redirects back to localhost.
3. Google provider (if using it beyond Supabase's built-in demo credentials):
   Google Cloud Console → OAuth client → add the Supabase callback URL shown in
   the provider settings.

---

## 4. Smoke test

1. `https://<vercel-domain>` → sign in (email link first — fewest moving parts).
2. Create a **private** world at the fastest pace (1 wk/30 min) → join it.
3. Open the game, lease an aircraft, add a gate, open a route.
4. Wait ~30 min (or check Railway worker logs — you'll see `[tick] … week(s) due`)
   → cash and the debrief should update.
5. Second account (different email / a friend) joins with the join code → both
   airlines appear in standings.

## Troubleshooting

- **401 on everything** → Supabase URL/anon key mismatch between client and API.
- **CORS errors in the browser console** → `CORS_ORIGINS` on the API doesn't
  match the Vercel domain exactly (scheme included, no trailing slash).
- **Sign-in bounces to localhost** → Supabase URL Configuration (step 3.2).
- **`prisma` errors on deploy** → check `DATABASE_URL`/`DIRECT_URL` are the
  session-pooler string (port 5432) with the real DB password.
- **Worlds never tick** → is the worker service running? Check its logs.

## Costs

Supabase Free + Railway Hobby (~$5/mo) + Vercel Hobby (free) to start.
Flip Supabase to Pro ($25/mo) when real players exist (no pausing + backups) —
see `HEADWINDS_MULTIPLAYER_PLAN.md` §12.
