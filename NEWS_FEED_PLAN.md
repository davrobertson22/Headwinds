# Headwinds News Feed Plan

**Status:** proposal — not built. Written 2026-07-27.
**Scope decision (Dave, 2026-07-27):** dedicated **News tab**, drawer kept as a lightweight ticker.
Content: rival moves + world economy events + gates/auctions/used market + standings/bankruptcies/stocks.
Default view: **everything, chronological** (with rollup + filters, not raw firehose).

**Decisions settled (Dave, 2026-07-27):**

| Question | Decision |
|---|---|
| Stock trades in news | **Full public tape** — every buy/sell posts (see B2a) |
| Retention | **Rolling 52-week window** — the feed pages back one game year |
| Rank changes | **Top-5 entries/exits only** |
| Tab name | **News** |

---

## Why this exists

Community feedback (Discord, Kat the Fox):

> "D is hallucinated. Theres not really a news feed and the one that is there is kinda
> redundant/broken (doesn't list number of aircraft purchased and is just often flooded
> with noise)."

That's three distinct complaints, and all three are real. Every one of them is reproducible
in the code as it stands. Part A lists them with file:line. Part B is the fix.

---

## Part A — What's actually broken today (verified)

The current feed is `GET /worlds/:id/feed` (`apps/headwinds-server/src/routes/worlds.mjs:229`)
rendered by `apps/headwinds-web/src/Feed.jsx` into a slide-over drawer behind a 🌍 Activity
button in the multiplayer topbar (`GamePlayScreen.jsx:265`).

### A1. Aircraft quantity is silently dropped — the literal complaint

`publicPayload` (`worlds.mjs:134`) is an allowlist scrubber. It forwards
`origin, destination, typeId, airportCode, allianceId, routes[], count` — and **not `quantity`**.

But `ORDER_AIRCRAFT` carries `quantity`, clamped 1–100 in the reducer
(`packages/engine/src/reducer.mjs:544`). So a 12-frame 737 order reaches the client as
`{ typeId: 'B738' }` and `Feed.jsx` renders:

> Sky Blue **ordered a B738**

Two bugs in one line: the count is gone, and `typeId` is printed raw instead of the type's
display name.

**Fix:** add `quantity` to `publicPayload` (clamp 1–100, omit when 1); change the
`ORDER_AIRCRAFT` label to `ordered 12× 737-800`, resolving the name through `AIRCRAFT_TYPES`.
`BUY_AIRCRAFT` is single-unit by construction (`reducer.mjs:503`, prices at the single-frame
tier), so it needs the name fix only.

### A2. Joins flood every page

Five of the six source queries in the feed are windowed (`orderBy createdAt desc, take: limit`).
The `airlines` query (`worlds.mjs:258`) is **not** — it fetches every airline in the world and
maps each to a `joined` event. In a 40-player world that's 40 join events competing for 40
slots in the merged result. The first page of "this week in your world" can be almost entirely
"joined the world · hub XXX" from months ago.

**Fix:** split it. One unwindowed lean query for the id→name/OG/dev label maps (which genuinely
needs all airlines), one windowed query for join *events*.

### A3. No rollup — bulk actions read as spam

`ADD_ROUTE` is one decision per route. A player opening eight routes in a sitting emits eight
rows. Same for gates. There is no grouping by airline, week, or action family anywhere in the
pipeline — the server merges six arrays, sorts by timestamp, and slices
(`worlds.mjs:369-372`). This is the "flooded with noise" half of the complaint, and it's
structural, not cosmetic.

### A4. It shows trivia and misses the big stuff

`PUBLIC_DECISIONS` (`worlds.mjs:127`) predates several systems. Cross-referencing it against
`ALLOWED_PLAYER_ACTIONS` (`apps/headwinds-server/src/world.mjs:21`):

| Action | In MP? | In feed? | Newsworthy? |
|---|---|---|---|
| `LEASE_AIRCRAFT` | **No** — explicitly disallowed in MP | Yes (dead entry + dead label) | n/a |
| `TRANSFER_ROUTES` | Yes | No | Yes — network handover between players |
| `ADD_TAG_ROUTE` | Yes | No | Yes — same as a route open |
| `BUY_STOCK` / `SELL_STOCK` | Yes | No | Yes — see B2/open questions |
| Used-aircraft purchase | Yes, via `POST /worlds/:id/used-aircraft/:lid/buy` | No | Yes |
| World economy events | Shared, server-rolled | **No** | Very |
| Bankruptcy / abandonment | `AirlineStatus` | No | Very |
| Rank changes | `Standing` table, weekly | No | Yes |

Used-aircraft trades bypass the `Decision` table entirely — `aircraftMarket.mjs` writes no
decision row (only `decisions.mjs:276` creates them), so those trades are invisible to the feed
by construction.

The biggest omission is the **world economy**. `tickService.mjs:120` rolls one shared event set
per week for the whole world — fuel spikes, recessions, regional demand shocks, 27 templates in
`packages/engine/src/data/events.js`. Every player faces the same ones. Right now they surface
only in each player's private Weekly Debrief, never as shared world news. That's the single
richest untapped source of actual *news*, and it's already computed.

### A5. Nothing is ranked or scoped to you

Every event is equal weight and there is no relevance signal. A rival opening a route into your
fortress hub reads identically to a stranger on the other side of the map adding a focus city.
"Collates it in a useful way" is mostly this.

### A6. Polling cost

`Feed.jsx:105` polls every 15s while open, 60s while closed — six DB queries per poll, per
online client. Forty online players ≈ 240 queries/min against `Decision`, `Airline`, `Alliance`,
`AllianceMember`, `GateAuction`, `GateListing`. A short per-world cache pays for itself before
the News tab makes the payload bigger.

---

## Part B — The News tab

### B1. Player experience

A top-level **News** tab (📰) in the game nav, MP-only. Opening it shows a chronological,
newest-first feed of everything happening in the world — but *composed*, not dumped:

```
── Year 3 · Week 14 ─────────────────────────  (sticky week divider)

⛽  Fuel Price Spike                                            world · W14
    Oil market disruption pushes jet fuel prices up 23%. Expected 3–6 weeks.

🔨  LAX gate auction resolved                                          W14
    Sky Blue won 3 gates at $4,200,000/gate · Condor Air won 1 at $3,850,000

✈️  Sky Blue ordered 12× 737-800                                       W14
    First delivery expected W17

🛫  Condor Air opened 6 routes from DEN                                W14
    DEN–BOI, DEN–TUS, DEN–OKC +3 more                          [expand ▾]

📉  Meridian Airways filed for bankruptcy                              W14
    Was ranked #7 · 22 routes and 14 aircraft leave the market

📈  Sky Blue climbed to #2 (from #5)                                   W14
```

Above the list: **filter chips** (World · Rivals · Fleet · Routes · Gates · Market · Standings),
an **airline filter**, and a **"Big moves only"** toggle (off by default). A **"Near me"** chip
narrows to events touching your airports and city pairs — not the default, but one click away,
since it's the strongest answer to "flooded with noise".

The 🌍 drawer stays, retargeted as a **ticker**: top 8 tier-1 items only, unread dot, and a
"See all news →" button that opens the tab.

### B2. Event taxonomy

Seven categories, each independently filterable.

| Category | Events | Source |
|---|---|---|
| `world` | economy event started / ended (fuel, demand, disruption, economy) | new `WorldNews` rows written by the tick |
| `routes` | routes opened / closed (pax, cargo, tag), route transfers | `Decision` |
| `fleet` | orders placed, aircraft bought / sold / retired, deliveries of note | `Decision` |
| `gates` | gate added / released, auction opened / resolved, gate sold | `Decision` + `GateAuction` + `GateListing` |
| `market` | used-aircraft listings sold | `UsedAircraftListing` |
| `standings` | rank changes, bankruptcies, abandonments, world milestones | `Standing` + `WorldNews` |
| `players` | joins, alliance founded / joined / left | `Airline` + `Alliance` + `AllianceMember` |
| `stocks` | share purchases and sales between airlines | `Decision` (see B2a) |

### B2a. The stock tape

**Decision: full public tape.** Every `BUY_STOCK` / `SELL_STOCK` posts.

`BUY_STOCK` and `SELL_STOCK` are already in `ALLOWED_PLAYER_ACTIONS`
(`apps/headwinds-server/src/world.mjs:45`) and therefore already land as `Decision` rows — no
new source needed. They join `PUBLIC_DECISIONS`, and `publicPayload` gains the target airline
id and share count.

Rendered:

> 📊 **Sky Blue** bought **12,000 shares** of Condor Air — now holds **8.4%**

Notes:
- The reducer prices trades from the server-injected rival view, never from the payload
  (`world.mjs:43-45`), so the price shown in news is the world's price and can be published
  safely. Publish **price per share and total value** too — it's already public information
  once the valuation prints.
- Roll up per `airlineId + week + targetAirlineId` (family `stocks`), so a player scaling into
  a position across one week reads as one line, not twenty. This matters more here than
  anywhere else in the feed — trading is the highest-volume action in the game.
- Resulting stake % is the newsworthy number; include it in `data` so the client can bold it.
- **Consequence, accepted:** a takeover run is visible from the very first share. Stealth
  accumulation is not possible under a full tape.
- **Variant if that turns out to bite** (not implemented, one-line change): post the tape at
  the *next tick* rather than instantly, so a raider gets exactly one week of surprise. The
  rollup already groups by week, so this is a matter of filtering `stocks` items to
  `week < currentWeek`.
- Tier: **1** when the trade crosses 5% / 10% / 25% of the target or the target is you,
  **2** otherwise.

### B3. The rollup rules (this is the anti-noise engine)

Roll up **after** fetching, **before** slicing. Key = `airlineId + gameWeek + family`:

| Family | Members | Rolled render |
|---|---|---|
| `routes_opened` | `ADD_ROUTE`, `ADD_CARGO_ROUTE`, `ADD_TAG_ROUTE` | `opened 6 routes from DEN — DEN–BOI, DEN–TUS, DEN–OKC +3 more` |
| `routes_closed` | `CLOSE_ROUTE`, `CLOSE_ROUTES`, `CLOSE_CARGO_ROUTE` | `closed 4 routes — …` |
| `fleet_in` | `BUY_AIRCRAFT`, `ORDER_AIRCRAFT` | `ordered 12× 737-800 and 2× 787-9` (sum `quantity` per `typeId`) |
| `fleet_out` | `SELL_AIRCRAFT`, `RETIRE_AIRCRAFT` | `retired 3 aircraft` |
| `gates` | `ADD_GATE`, `REMOVE_GATE` | `added 4 gates at ORD` (per airport) |
| `stocks` | `BUY_STOCK`, `SELL_STOCK` | `bought 12,000 shares of Condor Air — now holds 8.4%` (per target airline; net the week's buys and sells) |

Never rolled — rare and high-signal, each gets its own line: hub designation/upgrade, focus
city, alliance events, auction results, bankruptcies, rank changes, world economy events.

Rolled items carry `detail[]` so the client can expand to the individual moves. A rolled group
keeps the timestamp of its **newest** member for sort order.

Rollup happens on the server so the ticker, the tab, and any future mobile client all agree,
and so pagination counts are stable.

### B4. Importance tiers

Every item gets `tier: 1 | 2 | 3`, used by "Big moves only", the ticker, and (later) push.

- **Tier 1** — alliance founded, hub designated or upgraded, gate auction resolved, bankruptcy
  or abandonment, **rank change into or out of the top 5**, fleet order ≥ 5 frames, world
  economy event start/end, a stock trade crossing a 5/10/25% stake, **any event on a city pair
  you fly or involving your airline** (computed per-viewer).
- **Tier 2** — rolled route opens/closes, gate buys/sells, used-market trades, small orders,
  ordinary stock trades, alliance joins/leaves.
- **Tier 3** — world joins, everything else. Present, never promoted.

Tier is computed server-side except the "touches your network" promotion, which needs the
viewer's route list — cheap, since the request is already authenticated and the airline state
is loaded.

### B5. Data model

**No new tables for anything already queryable.** Player moves keep coming from `Decision`
(already indexed `[worldId, createdAt]`, `schema.prisma:126`), so all existing history stays
visible with zero backfill. Used-market trades read `UsedAircraftListing`
(`status='SOLD'`, `soldAt`, `buyerId`, `origin`, `typeId`, `navPrice`). Stock trades are
already `Decision` rows. Rank changes diff consecutive `Standing` rows
(`[worldId, week, rank]` index already exists) and emit **only** when an airline enters or
leaves the top 5 — one comparison per tick against last week's top 5, so at most a handful of
rows even in a 50-player world.

**One new table** for events that have no durable source today:

```prisma
model WorldNews {
  id        String   @id @default(cuid())
  worldId   String
  week      Int                    // linear week index
  category  String                 // world | standings
  kind      String                 // event_started | event_ended | bankruptcy | abandoned |
                                   // rank_change | world_started | final_week
  airlineId String?                // subject, when there is one
  payload   Json                   // event template id/name/icon/desc, or from/to rank, etc.
  tier      Int      @default(2)
  createdAt DateTime @default(now())
  world     World    @relation(fields: [worldId], references: [id], onDelete: Cascade)

  @@index([worldId, createdAt])
}
```

Why a table rather than deriving: `tickService.mjs:175` persists only the world's **current**
event set into `world.tickConfig.runtimeEvents`. There is no history — once a fuel spike
expires it is gone. Writing news rows inside the existing tick transaction
(`tickService.mjs`, same `$transaction` that advances the clock and snapshots standings) gives
history for free and keeps the news atomic with the week it describes.

Rows written per tick: 0–4 typically (`MAX_ACTIVE_EVENTS = 2`, plus rare bankruptcies and
top-5 rank changes). Negligible.

Bankruptcy detection already exists — `tickService.mjs` computes `bankrupt: next.phase ===
'bankrupt'` per airline before the commit; the news row is one more write in the same block.

**Retention: rolling 52-week window.** The feed pages back one game year and stops — every
source query carries `week >= currentLinearWeek - 52` alongside the `before` cursor, and
`nextBefore` returns `null` at the boundary so the client shows an end-of-feed marker
("News older than one year isn't kept"). This bounds query cost predictably regardless of
world age, and keeps a 50-year world's news table from growing without limit.

Pruning: a sweep in the weekly tick deletes `WorldNews` rows older than the window (cheap —
`deleteMany` on the `[worldId, createdAt]` index, a handful of rows a week). `Decision` rows
are **not** pruned — they're load-bearing for rival profiles and audit, and the window is
applied as a query filter there rather than a delete.

### B6. Server API

```
GET /worlds/:id/news
  ?before=<ISO cursor>
  &limit=<1..100, default 40>
  &categories=world,routes,fleet,gates,market,standings,players,stocks   (default: all)
  &airlineId=<filter to one airline>
  &tier=1            (Big moves only)
  &scope=all|near    (near = touches your airports/city pairs)

→ { items: [...], nextBefore, latestAt }
```

Each item:

```js
{
  id,            // stable: `${source}:${sourceId}` or rollup key — client dedupe + read state
  at,            // ISO
  week, year,    // game clock, for the week dividers
  category,      // B2
  kind,          // machine-readable, drives the icon + label
  tier,          // B4
  airlineId, airline, og, dev,   // subject, when there is one
  headline,      // pre-composed string? NO — see below
  data: {...},   // structured fields the client formats
  detail: [...], // rolled-up members, when applicable
}
```

Compose the sentence **client-side** from `data`, as `Feed.jsx` does today. Keeps i18n and
restyling possible, and keeps aircraft/airport display-name lookups in the client where
`AIRCRAFT_TYPES` and `AIRPORTS` already live.

Implementation notes:
- Fetch `limit × 3` per source under a shared `before` cutoff, roll up, tier, sort, then slice
  to `limit`. Rollup before slicing is what makes the page counts honest.
- Per-world in-process cache, ~20s TTL, keyed on
  `worldId|categories|tier|scope|before=null` (first page only — deep pages are rare and
  uncached). Kills the A6 polling cost.
- `GET /worlds/:id/feed` stays as a thin wrapper (`limit=8&tier=1`) so the ticker and any
  cached client build keep working. Deprecate later.
- Every query is additionally bounded to the **52-week window** (B5), and `nextBefore` returns
  `null` at that boundary.
- Same `PUBLIC_DECISIONS` allowlist and payload scrubber discipline — **no** budgets, loans,
  cash balances, or route-level fares ever cross this boundary. The stock tape is the one
  deliberate exception and it publishes only world-priced, already-public figures (B2a). Every
  new field added to `publicPayload` gets a one-line justification comment, as the existing
  ones do.

### B7. Client work

| File | Change |
|---|---|
| `src/App.jsx` | Add `{ id: 'news', label: 'News', Icon: NewsIcon }` to `TABS` (:95); add to `NAV_GROUPS` (:121) as a top-level entry next to Dashboard; render `<News />` in `tabContent` (:270). Gate on `remote` — the tab is hidden in solo (see Part C). |
| `src/components/News.jsx` | **New.** The tab: filter chips, week dividers, rolled rows with expand, infinite scroll on `nextBefore`, empty state. |
| `src/components/Icons.jsx` | `NewsIcon`. |
| `apps/headwinds-web/src/Feed.jsx` | Retarget to ticker: `tier=1&limit=8`, drop pagination, add "See all news →" which navigates to the News tab. |
| `src/components/Wiki.jsx` | New `news` section (fits between `rivals` and `stocks`). |
| `public/devlog.html` | Entry, per convention. |

The News tab lives in `src/components/` (the shared game UI that Headwinds mounts via
`GamePlayScreen.jsx:15`), not in `apps/headwinds-web/src/` — that's where the tab system is,
and it keeps the Tailwinds mirror in Part C cheap. It reads from the MP API through the same
`remote` plumbing the Rivals tab uses.

### B8. Out of scope for v1

- Push / email notifications, and any per-player "notify me when X" subscription.
- Comments or reactions on news items.
- A public world-news RSS/JSON endpoint for Discord bots. (Tempting — `headwinds-public.mjs`
  already exists. Phase 2.)
- Per-item read state. v1 tracks a single `lastSeenAt` per world in `localStorage`, as the
  drawer does today.
- AI-written narrative headlines.

---

## Part C — Tailwinds solo mirror (later, optional)

Solo has real news too: the same 27 world-event templates (rolled per-save rather than
per-world), plus `competitorEvents` from the AI — launches, fare wars, capacity cuts — which
currently flash past in the Weekly Debrief and are then unrecoverable.

A solo News tab reusing `News.jsx` with a local adapter (read `state.activeEvents`,
`lastReport.newEvents/expiredEvents/competitorEvents`, plus a rolling in-save `newsLog[]`
capped at ~200 entries) gives Tailwinds players a scrollable history of their world for very
little extra work. Do it after the MP tab has settled — same sequencing as
`STOCK_MARKET_PLAN.md` Part C.

---

## Build order

1. **Part A quick fixes** — `quantity` through the scrubber, aircraft display names, joins
   windowed, `LEASE_AIRCRAFT` dropped from `PUBLIC_DECISIONS`, `TRANSFER_ROUTES` and
   `ADD_TAG_ROUTE` added. Ships in the existing drawer, immediately answers the Discord
   complaint. *Small — half a day.*
2. **`WorldNews` table + tick writes** — migration, plus economy-event start/end, bankruptcy,
   and top-5 rank-change rows written inside the existing tick transaction, and the
   older-than-52-weeks prune sweep.
3. **`GET /worlds/:id/news`** — new sources (including the stock tape), rollup, tiers, the
   52-week window, cache. `/feed` becomes a wrapper.
4. **`News.jsx` + tab wiring** — filters, week dividers, expand, infinite scroll.
5. **Ticker retarget** — drawer to tier-1 top-8 with a link into the tab.
6. **Wiki + devlog**, then a Discord post back to the thread (Kat gets the credit).

Steps 1 and 2 are independent and can land in either order. Step 3 depends on 2; 4 and 5
depend on 3.

## Verification checklist

- [ ] `tools/news-feed-test.mjs`, wired into `npm test` (convention: `contested-routes-test`,
      `world-calendar-test`).
- [ ] A 12-frame `ORDER_AIRCRAFT` renders `ordered 12× 737-800` — not `ordered a B738`.
- [ ] Eight `ADD_ROUTE`s in one week from one airline collapse to one row with
      `detail.length === 8`.
- [ ] A 40-player world's first news page contains **zero** stale `joined` events.
- [ ] Rollup happens before the slice: page 1 + page 2 contain no duplicate item ids and no
      gaps across the `before` cursor.
- [ ] Scrubber audit: no response field anywhere in the payload exposes cash, loans, budgets,
      or route fares. Diff `publicPayload` against the `Decision.payload` shapes. The `stocks`
      category is the one intentional disclosure — confirm it leaks nothing beyond target,
      share count, world price, and resulting stake.
- [ ] Twenty `BUY_STOCK`s against one target in one week collapse to a single tape line with
      the correct net share count and stake %.
- [ ] A rank shuffle between #8 and #9 produces **no** news; #6 → #4 produces exactly one.
- [ ] Retention: in a world past week 60, the feed pages back exactly 52 weeks and then returns
      `nextBefore: null`; the prune sweep leaves no `WorldNews` row older than the window.
- [ ] A world with an active fuel spike shows `event_started` at the right week, and
      `event_ended` when it expires.
- [ ] Bankruptcy of a top-10 airline produces exactly one `standings` item.
- [ ] Cache: two clients polling the same world within the TTL produce one DB round trip.
- [ ] `npm test` green (note: `itinerary feed present on leg` fails on a clean tree already —
      pre-existing, unrelated).

## Resolved (2026-07-27)

1. **Stock trades** → full public tape (B2a). Consequence accepted: no stealth accumulation.
   One-week-delay variant documented if it proves too harsh in play.
2. **Retention** → rolling 52-week window, enforced as a query filter everywhere and a prune
   sweep on `WorldNews` (B5).
3. ~~Dashboard activity strip~~ — checked, `Dashboard.jsx` has no activity strip. Non-issue.
4. **Rank changes** → top-5 entries and exits only.
5. **Naming** → "News".

## Still open

- **Should your OWN moves appear in the news?** They're public to everyone else, so hiding them
  is odd, but a feed that narrates your own actions back at you is filler. Suggestion: include
  them, tagged "(you)" as the drawer does today, and offer a "Hide my moves" toggle.
- **Ticker unread semantics.** Should the unread dot fire on any tier-1 item, or only ones
  touching your network? The latter is quieter but risks players missing world-economy news.
- **World-ended worlds.** Does the News tab stay readable after a world ends (a scrollable
  history of the whole 50 years, minus the pruned window), or freeze at a final summary?
