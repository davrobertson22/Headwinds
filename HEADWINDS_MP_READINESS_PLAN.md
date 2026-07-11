# Headwinds Multiplayer Readiness Plan

**Goal:** remove every remaining single-player leftover from the in-game experience, and make rivals fully visible — full open book: routes, fares, fleet, cash, market cap, profit history, alliance. Plus two liveness features: a real tick countdown in the game bar and a rival activity feed.

**Date:** 2026-07-11 · based on a full audit of the current repo state.

---

## Ground rule for every UI change in this plan

The shared game UI (`src/`) is synced FROM Tailwinds (`tools/sync-from-tailwinds.mjs`, rsync --delete). Any edit to a shared file will be wiped on the next sync unless it is either:

1. **Upstreamed to Tailwinds** as a `remote`-guarded edit (reads `remote` from `useGame()`, no-op in solo) or as **neutral copy** that reads correctly in both games — preferred, no patch needed; or
2. **Added to `MULTIPLAYER_PATCHES`** in the sync script (anchor-based, idempotent, hard-fails if the anchor drifts).

Each item below is tagged **[upstream-neutral]** (reword so it's true in both games — cleanest), **[remote-guard]** (branch on `remote`), or **[headwinds-only]** (lives in `apps/headwinds-*`, no sync exposure).

---

## Phase 1 — Purge single-player leftovers

These are the "you can still advance weeks" class of bugs. Audit findings, file by file:

### 1.1 Dashboard "Getting Started" card — *the guide Dave spotted* **[remote-guard]**
`src/components/Dashboard.jsx` (~line 431). Shown at the bottom of the Dashboard whenever the player has no routes and no fleet — which is exactly the state every new Headwinds player starts in. Step 3 says **"Click Next Week → to collect revenue."** There is no Next Week button in multiplayer.

Remote variant of the checklist:
1. Go to **Market** and lease an aircraft.
2. Go to **Routes** and open your first route.
3. The world clock advances automatically — revenue lands every game-week.
4. Watch the **Rivals** tab: every other airline is a real player.

### 1.2 Hourly auto-advance timer still runs in multiplayer — *real bug, not just copy* **[remote-guard]**
`src/App.jsx` (~lines 150–195). The solo auto-advance interval runs whenever `state.phase === 'playing'` — which is true in remote. The `ADVANCE_WEEK` dispatch is swallowed by Headwinds' dispatch filter, **but the rest of `advanceWeek.current()` still executes**: every hour the player is yanked to the Dashboard (`setActiveTab('dashboard')`), the ad-break counter increments and can fire `gameAdBreak()`, and a meaningless localStorage countdown is maintained.

Fix: gate the entire timer effect, `resetTimer`, and the `LS_KEY` localStorage usage on `!remote`. Also verify the "Advance Week Error" overlay (~line 438) can never appear in remote.

### 1.3 Wiki tab is solo documentation **[remote-guard]**
`src/components/Wiki.jsx` line 36: *"The game auto-advances one week every hour, but you can always advance manually with **Next Week**. Your progress is auto-saved; use **Save** to keep named slots."* All false in Headwinds.

Do a remote pass over the whole Wiki (same pattern as OnboardingTour's `remoteBody` fields, or a section-level `remoteOnly`/`soloOnly` flag):
- **Getting Started** — server clock, no save/load, no manual advance.
- **The Core Loop & Winning** — leaderboard of real players, world end date.
- **Competition** section — rewrite around human rivals and demand-splitting on contested pairs; no AI carriers, no acquisitions.
- **Alliances** section — player-founded alliances (found/request/accept, max 8, founder governance), not the static AI blocs.
- Add short **Rivals**, **Messaging**, and **World Clock & Pace** entries (Headwinds-only concepts).

### 1.4 Delivery copy tells you to advance time **[upstream-neutral]**
`src/components/Routes.jsx` lines 525/558: *"advance time to receive it"*. Reword neutrally: *"arrives on a future week"* / *"your aircraft is on the way — it arrives with an upcoming week."* True in both games; no guard needed.

### 1.5 Empty states that say "advance a week" **[upstream-neutral]**
- `Finance.jsx` ~2497: "Advance at least 2 weeks to see trends" → "Trends appear once 2 weeks of history exist."
- `Finance.jsx` ~3264: "History builds as you advance weeks" → "History builds week by week."
- `HubManagement.jsx` ~208: "no data yet — advance a week" → "no data yet — updates weekly."
- `Competition.jsx` ~191/347: "Advance a few weeks to populate the leaderboard" / "Advance one week to see financials" → "Populates as weeks complete." (This tab is rebuilt in Phase 2 anyway, but the neutral copy should land upstream for solo too.)

### 1.6 Footer help links 404 in Headwinds **[remote-guard]**
`src/App.jsx` footer links to `/how-to-play.html`, `/strategy.html`, `/glossary.html`, `/devlog.html`, `/about.html`, `/privacy.html`. Those pages live in the **root** `public/` (Tailwinds Vercel project). `apps/headwinds-web` has **no public dir** → every footer link on headwindsairlinegame.com 404s, and the content is solo-specific anyway.

Now: hide the doc links when `remote` (keep Privacy/About — copy those two into `apps/headwinds-web/public/` with Headwinds branding). Later (Phase 3+): write a Headwinds `how-to-play.html`.

### 1.7 Rivals tab still offers AI-era actions **[remote-guard]** *(folded into Phase 2)*
`src/components/Competition.jsx` renders **Acquire** buttons and the acquisition modal for every carrier with a marketCap — including humans. The server 403s `ACQUIRE_COMPETITOR` in multiplayer, so clicking it errors. Also AI chrome that's wrong for humans: tier badges driven by archetypes, fire-sale pricing, "Competitor Networks" heading.

### 1.8 Recovery/save copy in error overlay **[remote-guard]**
`src/App.jsx` ~531: "Your current game is auto-saved and can be recovered via **Load Game**…" — remote-gate this sentence (server state is the save).

### 1.9 Verification sweep **[checklist]**
- Confirm `SetupScreen` is unreachable in remote (phase is never `'setup'`; `RESET` is not in `ALLOWED_PLAYER_ACTIONS`).
- Confirm OnboardingTour assert-guards still hold after edits (`__..._MUST_BE_...__` anchors).
- Grep sweep on shared `src/` for: `Next Week`, `advance`, `auto-sav`, `Save`, `Load`, `New Game`, `AI`, `acquir`, `fire.?sale`, `archetype` — triage every hit as solo-only-path / neutral-reword / remote-guard.
- Check `WeeklyDebrief.jsx`, `Marketplace.jsx`, `BoardObjectives.jsx`, `Loyalty.jsx` (codeshares), `SaveLoadModal.jsx` mount points for the same classes of leftovers.

**Phase 1 exit test:** create a fresh account in a prod world; read every tab and every empty state; nothing on screen may reference advancing time manually, saving/loading, starting a new game, or AI airlines.

---

## Phase 2 — Full competitor visibility (open book)

Dave's call: **full open book** — routes, frequencies, real fares, fleet, cash, market cap, profit history, quality, alliance are all public. (Interior levers that no real observer could see — loan schedules, fuel hedges, marketing budgets — stay private; the rivals endpoint already draws this line.)

### What already exists (don't rebuild)
- `humanRivals.mjs` injects `state.competitors` for every rival: routes (frequency, priceMultiplier, aircraftType), cash, marketCap, 12-week profitHistory, quality, hub, logo, allianceId.
- `GET /worlds/:id/rivals/:airlineId` already returns: full route network **with absolute economy fares** and frequencies, fleetByType, hubs, alliance, 26-week rankHistory, and `recentMoves` (public decisions, filtered + payload-scrubbed). **Currently surfaced only in the lobby.**
- `Standing` table stores per-week rank history; `Decision` table stores every move.

### 2.1 Server: enrich the public competitor shape **[headwinds-only]**
In `toHumanCompetitor` / rivals endpoint, add per route: **absolute economy fare** (UI shouldn't reverse-engineer the multiplier), configured **seats**, and **last-week load factor / pax carried** where the state blob has it (`lastReport`). Add airline-level: focus cities, reputation components, fleet list with type + age (not just counts). Keep the payload bounded (cap route list, no raw state).

### 2.2 In-game Rivals tab, human-first **[remote-guard — this is the big UI piece]**
Branch `Competition.jsx` on `remote` (or extract a `RivalsHuman` view) so multiplayer gets:

- **Leaderboard** — rank (+ ▲/▼ change vs last week from rankHistory), airline + logo + hub, market cap, cash, last-week profit + 12-week sparkline, routes/fleet counts, alliance badge. No tiers, no archetypes, **no Acquire**.
- **Contested routes** — for each shared pair: your fare vs each rival's fare, frequency, seats/week, quality score, and the resulting demand split (see 2.4). "They undercut you by $23" is the core multiplayer moment — make it legible.
- **Rival profile drill-in** — reuse the lobby's rivals endpoint inside the game (expandable row or slide-over): full route list with fares, fleet by type, hubs, rank-history chart, recent public moves, alliance. Everywhere a rival's name appears (leaderboard, contested route, messages), it links here.
- **Rival networks** — table of every rival's routes (already renders from `state.competitors`; keep, relabel "Rival Networks").

### 2.3 Fetching **[headwinds-only]**
Profile data loads on expand via the existing endpoint with the session token (the shared component can receive a `fetchRivalProfile` capability via context from `RemoteGameProvider`, keeping `src/` free of Headwinds API imports — same pattern as Messages staying Headwinds-owned).

### 2.4 Contested-pair outcomes (engine check)
Verify what `weeklyTick`'s encroachment split records in `lastReport` per contested pair (pax won/lost, revenue impact). If it isn't retained, add a small `state.lastReport.contested[pairKey] = { yourPax, rivalPax, yourShare }` record in the engine (remote-guarded or harmless in solo). This powers both the head-to-head UI and the Weekly Debrief line "You lost ~180 pax to Rival Air on SFO–JFK."

**Phase 2 exit test:** with two accounts on one contested route, each player can see the other's exact fare, frequency, seats, quality, full network, fleet, cash, market cap, profit trend, and last week's split — all from inside the game, without visiting the lobby.

---

## Phase 3 — Liveness

### 3.1 Tick countdown in the game bar **[headwinds-only]**
Next tick time is deterministic: week N lands at `startedAt + N × tickIntervalMs(weeksPerDay)` (`tickService.mjs` / `worldConfig.mjs`).

- **Server:** include `nextTickAt` and `paceLabel` in `GET /worlds/:id/airline` (and world meta).
- **Client (`GamePlayScreen.jsx`):** replace the vague "weeks advance automatically" with a live countdown — *"Y3 W14 · next week in 42m"*. When the countdown crosses zero, trigger `load()` immediately and briefly poll faster (every ~5s until the new week arrives) so the tick feels punctual instead of "within 15 seconds, maybe".

### 3.2 The "new week" moment **[remote-guard, small]**
When a poll brings in a new week: open the **WeeklyDebrief** automatically (solo gets it via the advance click; verify it fires on remote week-change) and toast "Week N results are in." Extend the debrief with the contested-pair outcomes from 2.4. This is the heartbeat that makes a shared-clock game feel alive.

### 3.3 Rival activity feed **[headwinds-only]**
The backbone exists: the `Decision` table plus the `PUBLIC_DECISIONS` allowlist and payload scrubber already define "publicly visible move."

- **Server:** `GET /worlds/:id/feed` — recent public decisions across **all** airlines in the world (airline name/logo + move + scrubbed payload + game-week), newest first, cursor-paginated. Fold in system events: player joined, world started, alliance founded / member joined / member left (alliance tables have timestamps). No new tables needed for v1.
- **UI:** a "This week in your world" card on the Dashboard (top 5, remote-only) and a full feed panel inside the Rivals tab. Rides the existing 15s poll.
- **v1.5 (optional):** targeted fare-change events — `UPDATE_TICKET_PRICE` is too noisy to show raw, but *"Rival Air undercut you on SFO–JFK"* (price change on a pair you fly) is high-signal. Needs a contested-pair filter at feed-build time.

### Deferred (explicitly out of scope for now)
- Rival route overlays on the map (Dave deprioritized).
- Websockets/SSE — polling is fine at current scale.
- Presence ("who's online").
- Headwinds-specific how-to-play/strategy static pages (stub links hidden in 1.6).

---

## Phase 4 — Verification & rollout

1. **Sync safety:** every shared-file change lands as upstream-neutral copy or a `MULTIPLAYER_PATCHES` entry with anchors; run the sync script against a clean Tailwinds copy and confirm zero anchor failures.
2. **Tests:** extend `tools/headwinds-rivals-test.mjs` for the enriched competitor shape + contested outcomes; add route tests for `/feed` and `nextTickAt`; remember the fake prisma in tick tests needs every model touched. `npm run test:web` + `app.ready()` smoke in the VM (no local web builds — Vercel/Railway do real builds).
3. **Two-account prod smoke** (still outstanding from launch): second account joins via join code → open the same route → verify demand split, full mutual visibility, messaging, alliance flow, feed, countdown, and the new-week debrief moment.
4. **Ship order:** Phase 1 first (small, high-embarrassment fixes), then 3.1 countdown (tiny, big feel win), then Phase 2, then 3.2/3.3.

## Rough sizing

| Chunk | Size |
|---|---|
| 1.1–1.2 (guide card + timer bug) | small — one sitting |
| 1.3–1.9 (Wiki pass + copy sweep) | medium |
| 3.1 countdown | small |
| 2.1–2.3 Rivals tab rebuild | large — the main event |
| 2.4 + 3.2 contested outcomes + debrief | medium (engine touch) |
| 3.3 activity feed | medium |
| Phase 4 | small–medium, ongoing |
