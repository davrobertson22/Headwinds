# Used Aircraft Market — Design & Implementation Plan

**Status:** DRAFT / design exploration (2026-07-24). Nothing built yet. The core model is decided
(see the table below); this mirrors `GATE_SCARCITY_PLAN.md` / `STOCK_MARKET_PLAN.md` so it can
graduate to an implementation plan once the smaller calls in §7 are settled.
**Scope:** Headwinds multiplayer only. No solo Tailwinds version (the market is world-shared).

### Decisions made (Dave, 2026-07-24)
| Question | Decision |
|---|---|
| Counterparty | **The game is the counterparty on both sides.** No direct player-to-player transfer. |
| Selling | **All sales go to the game instantly at NAV − 5%** (exactly today's `SELL_AIRCRAFT` price). Guaranteed, no waiting for a buyer. |
| The market | The game **re-lists every sold aircraft in the Used Market at NAV**, where any airline can buy it. The **5% spread is the game's cut** (a cash sink) and the only anti-abuse needed. |
| Pricing | **NAV-based, frozen at sale.** A listed aircraft's **age is paused** while it sits in the shop, so its price never moves until someone buys it. |
| Delivery | **Buying used always takes one week** — the plane arrives on the **next world tick** ("the next click of the world"). Never instant. |
| Matching | **Fixed price at NAV, first buyer wins** (atomic). |
| Stale inventory | **A listing unsold for more than 2 years (104 game-weeks) is scrapped** — removed from the shop, no compensation. Keeps the market clean. |

---

## 1. The idea

Today an airline's fleet only grows **at the factory** (`ORDER_AIRCRAFT` new with a delivery lead
time; `BUY_AIRCRAFT` instant new at list price) and only shrinks **to nobody** — `SELL_AIRCRAFT`
already sells an owned tail to "the house" at **NAV − 5%** (NAV = purchase price ×
depreciation-remaining, floored at 10%, ~30-yr linear — see `fleetNAVOf` / the `SELL_AIRCRAFT` case
in `reducer.mjs`), and the aircraft simply **vanishes**.

The used aircraft market changes exactly one thing about that: **the sold aircraft doesn't vanish —
the game takes it into a world Used Market and lists it at NAV**, where any airline can buy it.

- **Selling is unchanged for the seller:** you sell an owned tail, you get **NAV − 5% instantly**,
  guaranteed, no waiting on a buyer — identical to today.
- **Buying used is new:** any airline can buy a listed tail **at NAV** — cheaper than new (it's
  depreciated) and **much faster than a new build** (it arrives next tick — one week — instead of
  the multi-week factory queue) — inheriting its age, cabin config, and engine spec.
- **The game keeps the 5% spread** (buys at NAV − 5%, sells at NAV). That spread is a **cash sink**
  that quietly drains money from the world (good for the economy, like gate fees and commissions)
  and it's the *only* anti-abuse mechanism the design needs (see §2).

So all used-aircraft supply still comes **from players** — re-fleeting, downsizing, failing airlines
— but the game intermediates, so there's no negotiation, no price-gaming, and no way to get stuck.

### Why this is a good fit
- The **sell side is literally unchanged** (`SELL_AIRCRAFT` at NAV − 5%). We only add a downstream
  "put it in the shop" step and a buy path. Low risk — no touching the sell pricing that shows up
  in the old bug-audit exploit history.
- The **NAV math already exists** and already backs `SELL_AIRCRAFT`, `BUY_OUT_LEASE`, and valuation.
- The **1-week delivery reuses the existing order-delivery machinery** — `ORDER_AIRCRAFT` already
  builds aircraft from a pending queue on the weekly tick; a used purchase is just a pending
  delivery that always lands on the very next tick and carries a real airframe's snapshot.
- The **gate marketplace is the template** for the atomic first-buyer-wins claim, the injected
  read-only market view, and the decisionGuard boundary.

---

## 2. Why game-as-counterparty is the clean design

Making the game the middleman (rather than direct player-to-player) deletes four whole problem
areas at once:

- **No thin-market stalls.** The seller is paid instantly at NAV − 5% whether or not a buyer ever
  exists — exactly as today. An empty Used Market just means "no bargains to buy right now," never
  "can't sell."
- **No collusion / wash-trade surface.** Prices are fixed at NAV by the game, and the 5% spread
  means every round trip **loses 5%**. You can't hand an alt account a $190M widebody for $1, and
  buy-then-resell always loses — so none of the min-ask floors, sale fees, or anti-flip cooldowns
  the direct-P2P model needed exist here. The spread is the whole enforcement.
- **No escrow question.** The tail leaves your fleet the instant you sell (as today) and becomes
  the game's inventory. Nothing is held in limbo.
- **No negotiation UI.** No asks, no bids, no withdraws — just a shop you sell into and buy from.

Inventory is still a genuine reflection of the world's fleet churn (every used tail was really
somebody's), it's just brokered. If worlds ever feel thin, the lever is economic (e.g. AI/bankrupt
fleets flowing into the shop), not a redesign.

---

## 3. Ruleset

### 3.1 Selling (unchanged price, one new effect)
- `SELL_AIRCRAFT` behaves exactly as today: **owned tails only** (leased tails still go back to the
  lessor via `RETIRE_AIRCRAFT`, they don't enter the shop), seller receives **NAV − 5%** instantly,
  the tail's routes close.
- **New:** the sold tail is added to the world **Used Market inventory** at NAV, carrying its
  snapshot (age, cabin config, engine/wingtip spec, tail flavor). Its **price and age are frozen**
  at this moment (§3.3).

### 3.2 Buying used
- Any airline can buy any listed tail **at its listed NAV**, paid to the game. The listing is
  **claimed immediately** (first buyer wins, atomic — so no one else can grab it), the cash is
  **debited at purchase**, and the aircraft is **delivered on the next world tick — one week later.**
  Never instant (this also means the multiplayer "first two aircraft deliver instantly" starter
  perk does **not** apply to used purchases).
- The buyer inherits the exact aircraft — its **age** (which resumes ticking up once delivered),
  **cabin config** (reconfigure via the existing `CONFIGURE_AIRCRAFT` for the usual cost), and
  **engine spec**.
- Buying used is therefore *cheaper than new in absolute terms* (it's depreciated) and *much faster*
  (one week vs. the several-week factory queue), traded off against an older, higher-maintenance,
  shorter-life airframe.

### 3.3 Pricing (NAV, frozen — age paused on the market)
- A listing's price is the aircraft's **NAV at the moment it was sold into the shop**, and it
  **does not change while it sits** — the airframe's **age is effectively paused** in inventory, so
  a plane nobody buys stays the same price and the same age until someone does. (No live
  depreciation, no drift.) The price is computed server-side and fixed on the row.
- Under the current ~30-yr linear NAV, a lightly-used jet lists near its new price and an old jet
  lists cheap — so in practice the shop mostly clears **older, genuinely-cheap** airframes, a
  natural fit for startups and rapid expansion. If you want the *mid-age* market livelier (used
  feeling like a real deal at 5–10 yrs), a front-loaded NAV curve is the one lever — noted in §7
  Q1, not assumed.

### 3.4 Scrapping stale inventory (keeping the shop clean)
- A listing that goes **unsold for more than 2 years — 104 game-weeks — is scrapped**: removed from
  the Used Market, gone for good, no compensation (the game already paid the seller NAV − 5% at
  sale; the airframe is the game's, and it's simply written off). Tracked by `listedWeek` — the
  airframe's *age* is paused, but its *time on the market* is not — and swept on the weekly tick.
- This stops old, unwanted types piling up forever and keeps the shop feeling live: the worst
  bargains quietly age out instead of cluttering the list.

### 3.5 The one edge to watch
With the ≤5% fleet-discount on new orders, an airline that already owns 4+ of a type buys new at
~0.95× list, and a **zero-age** tail's NAV is ~1.0× list, so selling a brand-new plane nets ~0.95×
— i.e. buy-new-then-immediately-sell is roughly **break-even, never profitable** (and now costs a
week to get the used one back anyway). Not an exploit; just the one interaction to sanity-check.

### 3.6 Feed drama (free engagement)
Reuse the world feed: `aircraft_sold_to_market` ("Azure Air retired a 12-yr-old A320 to the used
market — $8.9M"), `used_aircraft_bought` ("Vertex bought a used A320 for $9.4M — delivers next
week"), and optionally `aircraft_scrapped` ("An unsold 16-yr-old A320 was scrapped after 2 years").
A failing airline's fleet flooding the shop cheap is exactly the pull-players-back moment.

---

## 4. Architecture

The Used Market inventory is a **shared world resource** while fleets live in per-airline blobs
under per-airline optimistic locking (`Airline.version`). Two buyers claiming the same tail in the
same second must not both win — so the shop needs its own authority in Postgres, updated atomically
inside the same transaction as the decision commit. Same shape as gates.

### 4.1 Table (mirrors `GateListing`)
```prisma
// One row per aircraft the game holds in a world's Used Market.
model UsedAircraftListing {
  id           String   @id @default(cuid())
  worldId      String
  origin       String?  // ex-operator airline name, for feed flavor ("ex-Azure Air")
  typeId       String   // aircraft type key (into AIRCRAFT_TYPES)
  snapshot     Json     // the full portable aircraft object: FROZEN ageWeeks, config, engine mods
  navPrice     Int      // NAV fixed at sale time — never recomputed (age is paused)
  listedWeek   Int      // linear week index — drives the 2-yr scrap sweep + feed ordering (NOT pricing)
  status       String   @default("OPEN") // OPEN | SOLD | SCRAPPED
  buyerId      String?
  createdAt    DateTime @default(now())
  soldAt       DateTime?
  world        World    @relation(fields: [worldId], references: [id], onDelete: Cascade)
  @@index([worldId, status])
}
```
The `snapshot` carries the real tail (frozen age, cabin, engines) and `navPrice` is fixed at sale —
so nothing about a listing moves while it waits.

> ⚠️ New public table → **re-run the Supabase RLS DO-block** after the migration (see
> `headwinds-supabase-rls` memory).

### 4.2 Server-side flow (cash math stays in the engine)
- **Sell:** the player still dispatches the allow-listed `SELL_AIRCRAFT` (engine credits NAV − 5%,
  removes the tail). The decisions handler, **after** applying it, reads the just-removed aircraft
  (by `action.aircraftId` from the pre-sale fleet) and writes a `UsedAircraftListing` row with its
  snapshot + `navPrice` — inside the same transaction. No engine change to the sell path.
- **Buy:** the buy route atomically claims the listing, then dispatches a server-only reducer
  action `BUY_USED_AIRCRAFT { snapshot, price }` that **debits `price` now** and pushes a **1-week
  pending delivery** carrying the snapshot (delivery week = current + 1, flagged `used`). The
  existing weekly-tick delivery step materializes it into the buyer's fleet on the next tick,
  building the tail from the snapshot (frozen age, config, engine) rather than fresh. **Not** on
  `ALLOWED_PLAYER_ACTIONS` — dispatched only by the buy route, like `GATE_PURCHASED`.

### 4.3 Injected read-only market view (mirrors `state.gateMarket`)
`state.usedMarket` injected on every read + tick, stripped on persist (the `withRivals` /
`stripRivals` pattern in `humanRivals.mjs`):
```js
state.usedMarket = {
  listings: [ { id, typeId, name, origin, ageWeeks, config, engineLabel, price /* fixed navPrice */ } ],
}
```
Rides the existing rival-view cache invalidation (world stamp bumps on every decision) — no new
invalidation logic.

### 4.4 Anti-cheat boundary (decisionGuard)
- Buy payload whitelisted to `{ listingId }`; **price read from the row's `navPrice`**, never
  trusted from the client.
- Buyer cash checked at resolution; can't pay → void.
- Atomic claim: `UPDATE UsedAircraftListing SET status='SOLD', buyerId=? WHERE id=? AND
  status='OPEN'` — race loser gets 0 rows and a clean 409, inside the tx that also debits the
  buyer's blob + writes the Decision row.

---

## 5. Changes by layer

### 5.1 Engine — `packages/engine/` (shared; inert without the injected view)
| File | Change |
|---|---|
| `src/reducer.mjs` | New **server-only** case `BUY_USED_AIRCRAFT` (debit price + enqueue a 1-week pending delivery carrying the snapshot, flagged `used`). Extend the weekly-tick delivery step so a `used` pending order materializes from its snapshot (frozen age/config/engine) instead of a fresh build. `SELL_AIRCRAFT` **unchanged.** |
| `src/data/aircraft.js` | Optional: a shared `usedNAV(type, ageWeeks)` helper so client + server price identically (thin wrapper over existing NAV math; add the front-loaded curve here iff §7 Q1) |

### 5.2 Server — `apps/headwinds-server/`
| File | Change |
|---|---|
| `prisma/schema.prisma` + migration | `UsedAircraftListing` (+ RLS re-run) |
| `src/lib/aircraftMarketService.mjs` **(new)** | `listSoldAircraft(worldId, snapshot, navPrice, origin)`, atomic `buy(listingId, buyer)`, `scrapStale(worldId, currentWeek)` (2-yr sweep), `purgeWorld` on end |
| `src/routes/decisions.mjs` | After a successful `SELL_AIRCRAFT` in a world, capture the sold tail and `listSoldAircraft` in the same transaction |
| `src/routes/aircraftMarket.mjs` **(new)** | `GET /worlds/:id/used-aircraft` (view), `POST .../used-aircraft/:lid/buy` (transactional claim → `BUY_USED_AIRCRAFT`). Behind `requireAuth` + the decision rate limiter |
| `src/lib/decisionGuard.mjs` | `guardBuyUsed` — cash re-check, price = row `navPrice`, payload whitelisted to `{ listingId }` |
| `src/lib/tickService.mjs` | Delivery of used pending orders rides the existing order-delivery pass; **scrap sweep** each tick — mark any OPEN listing with `currentWeek − listedWeek > 104` as SCRAPPED (+ feed event) |
| `src/world.mjs` | Keep `BUY_USED_AIRCRAFT` **off** `ALLOWED_PLAYER_ACTIONS` |
| Feed route | New event kinds `aircraft_sold_to_market`, `used_aircraft_bought` |

### 5.3 Client — shared components + `apps/headwinds-web/`
| File | Change |
|---|---|
| Fleet UI (App.jsx / Fleet component) | The existing "Sell" already does the job — copy tweak so players know a sold jet enters the Used Market (they still just get NAV − 5%) |
| **Used Market** tab (new, near Stocks) | Browse inventory (filter by category/type/age/price), buy button, fixed price, "delivers next week" note. Reuse the sortable-table pattern from the Gates/Stocks tabs |
| Order flow | On the buy-aircraft screen, a **"Buy used"** toggle surfacing shop inventory of that type — cheaper, one-week delivery vs. the longer factory queue. It joins the same pending-deliveries list players already see |
| Wiki / `rules.html` + a devlog entry | Document the ruleset |

### 5.4 What Tailwinds (solo) gets
Nothing — world-shared inventory has no solo analog. Engine change is inert without the injected
view (same precedent as stocks). No Tailwinds mirror.

---

## 6. Suggested build order
- **Phase 1 — The shop (one phase).** Table + migration (+ RLS), `BUY_USED_AIRCRAFT` reducer case +
  used-delivery in the tick, `aircraftMarketService`, the `SELL_AIRCRAFT` → list hook in decisions,
  the buy route + decisionGuard, injected `state.usedMarket` view, Used Market tab + "Buy used" on
  the order screen, the 2-yr scrap sweep, feed events, `purgeWorld` on world end. *The whole feature
  is live.*
- **Phase 2 — Polish.** Wiki/rules/devlog, `tools/reconcile-used-market.mjs`.
- **Phase 3 (optional/future).** Feed AI/bankrupt fleets into the shop if worlds feel thin;
  front-loaded NAV curve if the mid-age market needs livening; lease-transfer variant.

**Test checklist (cloud build workaround: fresh clone, `npm install --ignore-scripts`,
`npx vite build`):** sell → seller gets NAV − 5% and a listing row appears with the right snapshot
+ frozen `navPrice`; a listing sitting for weeks keeps the same price and age (no drift); two
simultaneous buys of one listing → exactly one 409; buy debits `navPrice` immediately and the plane
arrives on the **next tick** (not before) with carried-over age/config/engine; buy-new-then-sell is
break-even; a listing reaching 104 weeks unsold is scrapped and disappears from the shop; world-end
purges inventory; solo Tailwinds + a Headwinds world with an empty shop behave byte-identically to
today.

---

## 7. Remaining smaller calls (defaulting unless you say otherwise)
1. **Front-loaded NAV curve?** — keep the existing ~30-yr linear NAV (default; used = fair value,
   appeal is depreciation + faster-than-factory delivery) vs. a steeper early curve so 5–10-yr jets
   feel like a real bargain in the shop.
2. **Confirm owned-only** (default yes — leased tails still return to the lessor via
   `RETIRE_AIRCRAFT`, never entering the shop).
