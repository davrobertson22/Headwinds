# Headwinds — Multiplayer Plan

*A technical and product plan for building a multiplayer mode for Tailwinds, running alongside the existing single-player game.*

Status: draft for discussion · Last updated: 2026-06-20

---

## TL;DR

Tailwinds is unusually well-suited to becoming multiplayer, because the hard part is already done. Your entire economy runs through one deterministic function (`weeklyTick`), the world already simulates 15 AI carriers competing for shared demand pools, and the game already advances on a real-time clock (one game-week per real hour). Multiplayer is, at its core, three changes:

1. **Move the authoritative tick to a server** instead of running it in each player's browser.
2. **Let human players occupy the "competitor carrier" slots** that AI carriers already fill.
3. **Keep the React app as a thin client** that submits decisions and renders server-computed results.

Single-player ("Tailwinds") stays exactly as it is — 100% client-side, no server, no accounts, works offline. Multiplayer ("Headwinds") is a separate mode that talks to a backend. They share one game engine but ship as two experiences.

**How hard is it with AI assistance?** Moderate, not extreme. The realistic estimate is **6–12 weeks of focused part-time work** to a playable closed beta, mostly because of the *un*-glamorous work: extracting the engine into a shared package, building accounts, and handling the dozens of edge cases that don't exist when there's only one player. AI (Claude, Copilot, etc.) accelerates the boilerplate-heavy 70% dramatically and the genuinely novel 30% only modestly.

**What to buy to start:** essentially nothing beyond what you likely already pay. A cheap managed setup (Railway/Render/Fly.io + managed Postgres) runs **~$5–25/month** and covers hundreds of players. The upgrade path to thousands of concurrent players is **~$50–300/month** and doesn't require re-architecting if you make a few right choices up front (documented below).

---

## 1. Why this is more feasible than it sounds

Most games can't be "made multiplayer" without a rewrite because their logic is tangled into the UI and runs per-client. Tailwinds is the opposite. Three properties of your current code make this tractable:

**The simulation is already pure and centralized.** `src/utils/simulation.js` (~1,900 lines) and the `ADVANCE_WEEK` path in `src/store/GameContext.jsx` take a full game state in and produce the next week's state out. `weeklyTick(state)` is essentially a pure function: same input, same output. That is *exactly* the shape you want for an authoritative server tick. You don't have to reverse-engineer your own rules — they're already isolated.

**The world already has competitors.** `src/models/demand.js` samples and initializes 15 AI carriers, grows them, prices them, and allocates demand between them and the player each week (`tickCompetitorGrowth`, `tickCompetitorPricing`, `computeCompetitorWeeklyStats`). Multiplayer means swapping some of those AI carriers for human-controlled ones. The demand-allocation math that decides "who wins which passengers on this route" already exists and already handles N carriers. This is the single biggest reason Headwinds is realistic.

**Time already advances on a clock.** `src/App.jsx` advances one week every real hour via a timestamp in `localStorage` (`airline_next_week_at`). Headwinds just moves that clock to the server so every player in a world ticks in lockstep. The pacing model you'd want for a persistent multiplayer economy is the one you already built.

**State is already serializable.** Saves are plain JSON in `localStorage` (`SaveLoadModal.jsx`). The same JSON shape becomes a row in a database. No binary formats, no in-memory object graphs to untangle.

The corollary: the work is less "invent a multiplayer game" and more "relocate the engine you have to a server and wrap it in accounts, networking, and a lobby." That's real work, but it's well-trodden, AI-friendly work.

---

## 2. The one genuinely hard design problem

Everything above makes this sound easy. Here's the part that needs real thought: **demand allocation between humans must feel fair and be cheat-resistant, and the tick must be authoritative.**

In single-player, the player competes against AI whose behavior you fully control and who never complain. With humans:

- **The server must be the source of truth.** Today the browser computes the week. If a browser computes the week in multiplayer, a player can edit their own numbers (give themselves $1B in cash, infinite range aircraft, etc.). So `weeklyTick` has to run on the server, and clients only *submit decisions* (open route, set price, buy aircraft) and *read results*. The client can still run a local "preview" simulation for instant UI feedback, but the server's tick is canonical.

- **Two players targeting the same route now interact.** Your demand model already splits demand across carriers on a route, so the math exists — but you'll need to decide how aggressive that competition is, whether there are slot/gate limits that humans fight over (you already model gates and slots), and how to avoid one whale dominating every route and making the game un-fun for newcomers.

- **Simultaneity.** All players in a world submit decisions during the week; at tick time the server reads everyone's latest decisions, runs one tick for the whole world, and writes everyone's new state. This is a "simultaneous-turn" model and it's the clean way to do it. It also means you never need real-time sub-second netcode — you need a reliable scheduled job, which is far easier.

If you internalize one thing: **Headwinds is a turn-based-economy game with a server-run clock, not a twitch game.** That keeps the networking requirements modest and the whole project achievable.

---

## 3. Persistent world vs. seasons (you picked "both")

You weren't sure, so here's the recommendation: **build a persistent backend, but run the game as seasons on top of it.** This gives you the best of both and is barely more work than either alone, because a "season" is just a world with a start date, an end date, and a reset.

| | Persistent shared world | Seasons / matches |
|---|---|---|
| **Feel** | MMO-style ongoing economy; your airline is "always there" | Time-boxed competition with a winner, then reset |
| **Pros** | Strong attachment, natural retention, no "wasted" progress | Easy to balance, newcomers aren't behind, natural marketing beat ("Season 3 starts Monday"), easy moderation, leaderboards have an end |
| **Cons** | Newcomers join hopelessly behind veterans; griefing compounds; hard to ever rebalance; abandoned airlines clutter the world | Players lose their empire on reset (mitigate with persistent meta-progression / cosmetics / hall of fame) |
| **Infra** | One long-lived world row that grows forever | Many world rows, each archived at season end |

**Recommended model — "Seasons on persistent infra":**

- A **world** is a database row with `status` (lobby → running → ended), a tick schedule, and a pace (e.g. 1 week/hour for fast seasons, 1 week/day for slow/casual leagues).
- A **season** is a world that runs for a fixed number of game-years (say 3 game-years ≈ a few real weeks), then freezes, declares standings, and archives.
- **Meta-progression persists across seasons**: account, cosmetics, unlocked logos/liveries, a "career stats" page, hall-of-fame placements. Your *airline empire* resets each season; your *account identity* does not.
- You can run **multiple worlds in parallel** — different paces (blitz vs. casual), private worlds for friends ("invite-only lobby"), and public matchmade worlds. This directly satisfies the "friends" and "real launch" cases from one codebase.

This is why the answer to "persistent or seasons" is "build persistent, play in seasons": the persistent layer is the database and the engine; the season is just configuration on a world.

---

## 3a. World tiers & launch cadence (canonical config)

This is the locked-in world model for Headwinds. The site runs **several worlds in parallel**, launched on a **staggered schedule** so there is always a recently-started world to join. Each world runs for a fixed number of game-years at a fixed pace, crowns a winner when it ends, archives, and a fresh world takes its place.

**The two knobs.** Every world is defined by a **length** (in game-years) and a **pace** (game-weeks advanced per real day). Real-time duration is fully derived:

```
real_time_days = length_years × 52 ÷ weeks_per_day
```

**Lengths:** 50 or 100 game-years (2,600 or 5,200 game-weeks).

**Paces:** 6, 12, 24, or 48 game-weeks/day — i.e. a tick every 4h, 2h, 1h, or 30 min. The 48 wk/day "blitz" tier (a week every 30 minutes) is the fastest.

**Resulting real-time durations:**

| | 6 wk/day (4h tick) | 12 wk/day (2h tick) | 24 wk/day (1h tick) | 48 wk/day (30m tick) |
|---|---|---|---|---|
| **50 yr (2,600 wk)** | ~433 days | ~217 days | ~108 days (~15 wk) | ~54 days (~7.7 wk) |
| **100 yr (5,200 wk)** | ~867 days | ~433 days | ~217 days (~31 wk) | ~108 days (~15 wk) |

The **fastest/blitz tier is a 50-year world at 48 wk/day (~7–8 weeks real-time)**; everything slower runs longer via the same formula. Length and pace tune independently, so any future tier just picks a `(length, pace)` pair — no new mechanics needed.

**Pacing note.** At 30-minute weeks, decisions that feel "weekly" arrive twice an hour, so the blitz tier rewards players who check in often. That's the intended high-engagement tier; slower paces (4h/2h ticks) are the casual/long-haul tiers.

**Staggered launch cadence.** A scheduler periodically spins up new world rows, varying the `(length, pace)` mix across the available tiers, so the world browser always shows fresh worlds alongside in-progress ones. The launch cadence (how often a new world spawns, and the tier distribution) is itself config, not code. The lobby displays each running world with its config and progress, e.g. `100yr · 12 wk/day · year 8 of 100 · 23 airlines`, and players self-select into one that suits them. Staggered launches are the primary mitigation for the "newcomer joins hopelessly behind" problem (see §11).

**Cost.** Even the 30-minute cadence is trivially cheap to tick, so running many parallel worlds at mixed paces is not a cost concern (see §12). Pace remains a cost lever only at extreme world counts.

**Schema impact.** The `world` row carries `length_years`, `weeks_per_day` (pace), `started_at`, and derived `ends_at`; see §8. A player has at most one airline per world (`airline` table, one row per account per world) but may play several worlds at once; account-level meta-progression persists across all of them.

---

## 4. Reference architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CLIENT (React + Vite SPA — your existing app, extended)      │
│                                                               │
│   Single-player mode (Tailwinds)   Multiplayer mode (Headwinds)│
│   • runs engine locally            • submits decisions via API │
│   • localStorage saves             • reads world state via API │
│   • offline, no account            • live updates via WS/SSE   │
│   • UNCHANGED                      • local "preview" sim for UX │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTPS (REST) + WebSocket/SSE
┌───────────────────────────▼───────────────────────────────────┐
│  GAME SERVER (Node — same language, can reuse the engine)      │
│   • Auth & sessions                                            │
│   • Lobby / world management (create, join, list)              │
│   • Decision intake (validate every action server-side)       │
│   • Authoritative tick runner (scheduled job per world)        │
│   • Reads everyone's decisions → runs weeklyTick → writes state│
│   • Pushes "week N complete" events to connected clients       │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│  SHARED ENGINE PACKAGE  (@tailwinds/engine)                    │
│   • simulation.js, demand.js, market.js, fuel.js, aircraft data│
│   • the SAME code single-player and the server both import     │
│   • pure functions, no React, no DOM, no localStorage          │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│  DATA                                                          │
│   • Postgres: accounts, worlds, airlines(player state), ticks  │
│   • Redis (later): live presence, pub/sub for push, rate limits│
└─────────────────────────────────────────────────────────────────┘
```

The key structural move is the **shared engine package**. Today your simulation logic lives inside the React app. You'll extract the pure, framework-free parts into a package (a workspace in a monorepo) that *both* the browser client and the Node server import. Single-player keeps running it in the browser; the server runs the identical code. One source of truth for the rules means single-player and multiplayer can never silently diverge.

---

## 5. Recommended tech stack

You're already a Node/React/Vite shop, so the highest-leverage choice is **stay in JavaScript/TypeScript end-to-end** and reuse the engine verbatim. Don't introduce a second language for the backend.

**Engine (shared):** Your existing `src/utils`, `src/models`, `src/data` modules, lifted into a workspace package. Add TypeScript gradually if you want, but it's optional — the win is co-location, not types. (Types do help a lot once a server and a client share a contract; worth doing for the new API boundary at least.)

**Backend framework:** **Fastify** (or Express if you prefer familiarity). Fastify is fast, has first-class schema validation (which doubles as your anti-cheat input validation), and is boring in the good way.

**Database:** **Postgres**. One relational store handles accounts, worlds, and per-player airline state. Use a JSONB column for the big airline-state blob (which is already JSON today) plus normal columns for the things you query/sort on (cash, week, world_id, standings). Use a query builder/ORM you like — **Drizzle** or **Prisma** (Prisma is the most AI-assistable; Drizzle is lighter).

**Realtime updates:** Start with **Server-Sent Events (SSE)** or simple polling — you only need to tell clients "the week advanced, refetch." That's once an hour (or once a day), not 60fps. Full **WebSockets** (via `ws` or Socket.IO) are a nice upgrade later for live chat, presence ("3 rivals online"), and instant "someone just opened a route into your hub" nudges, but they are *not* required for v1.

**Scheduled tick:** A per-world scheduled job. Start with a simple in-process scheduler or a cron-like worker; graduate to a durable queue (BullMQ on Redis, or a managed scheduler) when you run many worlds. The tick is the heartbeat of the whole system, so make it idempotent and logged from day one (you already wrap `ADVANCE_WEEK` in try/catch and log — keep that discipline).

**Auth:** Don't build it. Use a managed auth provider — **Clerk**, **Auth0**, or **Supabase Auth** — for email/password + Google/Apple sign-in. This removes an entire category of security risk and is generously free at low volume.

**Hosting:** see §6.

**Why not a game-specific netcode stack** (Colyseus, Nakama, Photon)? Those shine for real-time state sync (positions, physics, rooms with sub-second updates). Headwinds is a scheduled-tick economy — a normal web backend fits better, is cheaper, and is far more AI-assistable because it's just CRUD + a cron job + validation. Colyseus is the one worth a look *if* you later want rich live lobbies, but don't start there.

---

## 6. What servers to buy (cheap start → upgrade path)

You asked specifically what to buy. The honest answer for the start: **a single managed app host + a managed Postgres database, and nothing else.** Resist buying raw VMs you have to patch and babysit.

### Tier 0 — Prototype / friends (≈ $0–25/month)

Target: tens to low-hundreds of players, a handful of worlds.

- **App host:** **Railway**, **Render**, or **Fly.io**. All three deploy a Node service from your repo with near-zero ops. Railway and Render have usage-based/hobby tiers in the **$5–20/mo** range; Fly.io has a small-VM free-ish allowance. Pick whichever UI you like — they're interchangeable for this.
- **Database:** Managed Postgres on the **same provider** (Railway/Render both offer it), or **Supabase** / **Neon** free tier. **$0–15/mo** to start. Neon and Supabase have real free tiers that comfortably cover a beta.
- **Auth:** Clerk/Supabase/Auth0 free tier. **$0.**
- **Static client:** Keep serving the SPA from **Vercel** (you're already on it — `@vercel/analytics` and `ads.txt` are in your build). **$0** on the hobby tier.
- **Realtime:** SSE/polling from the app host. **$0 extra.**

**Tier 0 total: realistically $5–25/month.** Often it's just the app host's hobby fee. This is enough to launch a closed beta with friends and several public worlds.

### Tier 1 — Real launch (≈ $50–300/month)

Target: hundreds-to-thousands of concurrent players, many parallel worlds.

- **App host:** Bump to a paid plan with 1–2 always-on instances behind the provider's load balancer (Render/Railway/Fly all do this). **$25–100/mo.** Separate the **tick worker** into its own service so a slow tick never blocks player requests.
- **Database:** Paid managed Postgres with daily backups and a read replica if you add heavy leaderboards — **Neon**, **Supabase Pro**, **Render Postgres**, or **AWS RDS/Aurora Serverless** if you go cloud-native. **$25–150/mo.**
- **Redis:** Add **Upstash** (serverless Redis, pay-per-use) or a small managed Redis for presence, pub/sub push, rate limiting, and the durable tick queue. **$0–20/mo.**
- **Realtime:** WebSockets on the app host, or offload to a managed pub/sub (Ably/Pusher) if connection counts get large. **$0–50/mo.**
- **CDN/client:** Vercel Pro if traffic warrants. **$20/mo.**

**Tier 1 total: ~$50–300/month** depending on concurrency and how many worlds tick how often.

### The two decisions that protect the upgrade path

You don't need to build Tier 1 now, but make these two choices at the start so you never have to re-architect:

1. **Make the tick worker a separate logical service from the API**, even if they run in the same process at first. When you need to scale, you split them by config, not by rewrite.
2. **Keep all authoritative state in Postgres, never in server memory.** The instant you can restart the server and lose a world, you're stuck on one machine forever. State-in-DB means you can run multiple stateless API instances behind a load balancer whenever you want.

**What NOT to buy:** a bare EC2/DigitalOcean droplet you manage yourself (ops burden with no benefit at this scale), Kubernetes (massive overkill until you're well past thousands of concurrent players), or a dedicated game-server product (wrong tool, as in §5).

---

## 7. How hard is it — and where AI actually helps

Honest breakdown. AI assistance (Claude Code, Copilot, etc.) is a large multiplier on the boilerplate and a modest one on the novel design work. Here's the split:

**AI makes these fast (the ~70%):**

- Extracting the engine into a shared package and wiring up the monorepo — mechanical, AI does it well.
- The entire CRUD/API surface: auth wiring, world create/join/list, decision endpoints, schema validation — this is AI's home turf.
- The database schema, migrations, and ORM models.
- The client networking layer: API client, SSE/WS subscription, optimistic UI.
- The lobby UI, world browser, standings/leaderboard pages — React you can largely generate.
- Tests for the engine (you already have a `tools/` test suite; AI extends it).
- DevOps glue: Dockerfile, deploy config, CI.

**AI helps but you must drive (the ~30%):**

- **Game-balance design for human competition** — how aggressive demand-stealing should be, anti-snowball mechanics, newcomer protection, anti-griefing. This is judgment, not code; AI is a sounding board, not the decider.
- **The authoritative tick orchestration** — reading all players' decisions, running the world tick, writing all results atomically, handling a player who joined mid-week or went bankrupt. The logic is novel to your game.
- **Anti-cheat boundaries** — deciding exactly which actions the client may compute vs. which the server must re-validate. Easy to get subtly wrong.
- **Moderation & abuse** — naming filters, report flows, rate limits. Necessary the moment strangers play together.

**Overall difficulty: moderate.** Nothing here is research-grade. The risk isn't any single hard problem; it's the *volume* of small correctness details that simply don't exist in single-player (concurrency, partial failures, "what if two players do X in the same tick"). Budget time for that long tail.

**Rough effort to a playable closed beta:** 6–12 weeks part-time, front-loaded on the engine extraction (the highest-value, lowest-glamour task).

---

## 8. Data model (starting point)

```
account        id, email, display_name, auth_provider_id, created_at,
               cosmetics_unlocked[], career_stats(jsonb)

world          id, name, status(lobby|running|ended|archived), visibility(public|private),
               length_years(50|100), weeks_per_day(6|12|24|48),
               current_week, current_year, max_players, join_code,
               tick_config(jsonb), world_seed,
               created_at, started_at, ends_at(derived), ended_at
               -- pace = weeks_per_day; tick interval = 24h / weeks_per_day
               -- total weeks = length_years × 52; ends_at = started_at + length_years×52 / weeks_per_day days
               -- see §3a for the canonical length/pace tiers and staggered-launch cadence

airline        id, world_id, account_id, name, logo_id, logo_color, custom_logo,
               hub, home_country, state(jsonb  ← your existing save blob),
               cash, market_cap, week, status(active|bankrupt), joined_week

decision       id, world_id, airline_id, week, type, payload(jsonb), created_at
               (the queue of intended actions to apply at next tick;
                OR apply-immediately with server validation — see note)

tick_log       id, world_id, week, started_at, finished_at, status, error,
               snapshot_ref   (for replay/debugging/audit)

standing       world_id, airline_id, week, rank, score   (for leaderboards)
```

**Decision model note:** you have two valid styles. (a) **Apply-immediately**: actions like "open route" take effect the moment the server validates them, and the weekly tick just runs the economy — closest to how single-player feels. (b) **Queued/simultaneous**: actions are staged and all resolve at tick time — more "fair" for competitive seasons but a bigger UX change. Recommendation: **apply-immediately for operational actions** (buy aircraft, open route, set price) since they already feel continuous in Tailwinds, and let the **weekly tick resolve the shared economy** (demand allocation, finances). This is the smallest departure from your current game feel.

---

## 9. Coexistence with single-player

This is a hard requirement you set, and it's straightforward to honor because single-player never needs the network.

**Naming & entry point.** On the main menu, two cards: **Tailwinds** (Solo) and **Headwinds** (Multiplayer). Same app, same look, a mode flag in the router. Single-player loads instantly with no account; Headwinds prompts sign-in.

**Code sharing.** Restructure into a monorepo:

```
/packages/engine     ← @tailwinds/engine  (pure sim — shared)
/packages/data       ← aircraft, airports, etc. (shared)
/apps/client         ← your current Vite SPA (both modes live here)
/apps/server         ← new Node game server (Headwinds only)
```

Single-player imports `@tailwinds/engine` and runs it in the browser exactly as today. The server imports the *same* package. Neither can silently drift from the other's rules — a balance change ships to both at once, which is a feature.

**No regressions to solo.** Because the engine is extracted but not rewritten, single-player behavior is byte-for-byte the same. Your existing `tools/` test suite becomes the guardrail: run it against the extracted engine and confirm identical outputs before shipping. (Worth adding a "golden master" test: snapshot 50 weeks of a fixed seed before extraction, assert it matches after.)

**Shared cosmetics.** Liveries, logos, airline names a player creates in solo can carry into their Headwinds account — a nice tie between the modes and a reason to make an account.

---

## 10. Phased roadmap

**Phase 0 — Engine extraction (the foundation).** Pull `simulation.js`, `demand.js`, `market.js`, `fuel.js`, `financeProjection.js`, and the `data/` modules into `@tailwinds/engine` with zero React/DOM/localStorage dependencies. Add a golden-master test proving single-player output is unchanged. *Nothing player-visible ships, but everything depends on this.* Do not skip or rush it.

**Phase 1 — Server skeleton + accounts.** Fastify app, Postgres, managed auth, deploy to Railway/Render. Endpoints: sign in, create world, list worlds, join world. No gameplay yet — just "I can make an account and sit in a lobby."

**Phase 2 — Single-player-against-server.** One human in a world, AI fills the rest (reuse your competitor model). Client submits decisions to the server; server runs the authoritative tick on a schedule; client renders results. This proves the whole pipeline end-to-end with only one human, so concurrency bugs can't hide other bugs.

**Phase 3 — True multiplayer.** Multiple humans in one world. Human carriers occupy competitor slots in demand allocation. Standings/leaderboard. Live "week advanced" push via SSE. This is the first genuinely *multiplayer* milestone — invite friends.

**Phase 4 — Seasons & lobbies.** World lifecycle (lobby → running → ended → archived), join codes for private friend games, public matchmade worlds, multiple paces, hall of fame / persistent meta-progression.

**Phase 5 — Polish & scale.** Moderation tooling, naming filters, anti-griefing/anti-snowball balance passes, WebSockets + Redis for presence and chat, the Tier-1 hosting split. Marketing beats around season launches.

A natural **first public milestone is end of Phase 3** (friends can play together) and a **launchable product at end of Phase 4**.

---

## 11. Risks & open questions

- **Balance for humans is unknown until humans play.** Plan for a closed beta and expect to retune demand competition, starting cash, and anti-snowball rules. Build the tick so you *can* change constants between seasons without migrations.
- **Griefing / dominance.** A veteran or a coordinated group can make a world miserable for newcomers. Seasons mitigate this (fresh start); also consider per-route entry caps, diminishing returns on dominance, and newcomer-protected sub-leagues.
- **Tick reliability is mission-critical.** If the world tick fails silently, every player in that world is frozen. Make it idempotent, logged, alerting, and replayable from the last good snapshot. (You already log `ADVANCE_WEEK` failures — extend that rigor server-side.)
- **Abandoned airlines.** Players quit mid-season. Decide whether their airline becomes AI-piloted, frozen, or liquidated — this affects everyone sharing their routes.
- **Cost of frequent ticks × many worlds.** Ticking 100 worlds every hour is cheap; ticking 100 worlds every minute is not. Pace is a cost lever — keep it configurable.
- **Moderation obligation.** The moment strangers share a world with names and (maybe) chat, you own a moderation surface. Start with name filtering and a report button; don't add free-text chat until you're ready to moderate it.
- **Monetization vs. fairness.** Your solo game uses ads. For multiplayer, cosmetic-only monetization (liveries, names, season passes) preserves competitive integrity; avoid pay-for-advantage, which poisons competitive games fast.

---

## 12. Cost summary

| Item | Tier 0 (friends/beta) | Tier 1 (real launch) |
|---|---|---|
| App host (API) | $5–20/mo (Railway/Render/Fly hobby) | $25–100/mo (always-on, LB) |
| Tick worker | shared with API | $0–25/mo (separate service) |
| Postgres | $0–15/mo (Neon/Supabase free→hobby) | $25–150/mo (paid + backups) |
| Redis | not needed | $0–20/mo (Upstash) |
| Auth | $0 (free tier) | $0–25/mo (paid tier at scale) |
| Client hosting | $0 (Vercel hobby) | $0–20/mo (Vercel Pro) |
| Realtime push | $0 (SSE/poll) | $0–50/mo (WS / Ably) |
| **Total** | **~$5–25/mo** | **~$50–300/mo** |

You can start Headwinds for roughly the price of a couple of coffees a month and only spend more once you have players who justify it.

---

## 13. Recommended next step

Don't start by buying servers or building lobbies. Start with **Phase 0: extract the engine into a shared package with a golden-master test.** It's the lowest-risk, highest-leverage move — it costs nothing, can't break single-player if done with the test in place, and every later phase depends on it. Once the engine is a clean shared package, the server is mostly assembly work that AI can carry a long way.
