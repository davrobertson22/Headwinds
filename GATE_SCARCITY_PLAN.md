# Gate Scarcity — Design & Implementation Plan

**Status:** IMPLEMENTED 2026-07-22 (all phases in one pass — engine, DB, server, UI).
Run the Prisma migration (`20260722000000_gate_scarcity`, RLS enabled inside it) before deploy.
Deviations from plan: no separate WeeklyDebrief section (warnings arrive as toasts); the
hub-picker availability endpoint exists (`GET /worlds/:id/gates`) but the setup screen doesn't
render it yet; auction/marketplace feed events come from their own tables, not the Decision journal.
**Scope:** Headwinds multiplayer only, as an **optional per-world setting** chosen at world creation.
Solo Tailwinds is untouched — every engine change below is gated on a flag that solo saves never have.

---

## 1. The idea

Today gates are an unlimited rental: any airline can lease any number of gates at any airport
(`ADD_GATE`), paying an escalating monthly fee (`gateMonthlyFee` in
`packages/engine/src/data/airports.js`), and the only interaction between airlines is price.
There is no competition for the airport itself.

Gate scarcity turns airports into a finite, contested resource — the defining constraint of the
real airline industry (Heathrow slots trade for $10M+). In a scarcity world:

1. Every airport has a **fixed gate capacity** by size: **25 / 100 / 250 / 500** gates.
2. **No airline may hold more than 60%** of an airport's gates, and **no alliance's members may
   together hold more than 80%**.
3. When an airport **reaches capacity**, **X gates per year** (X scales with airport size) go up
   for **sealed-bid auction** — bidding opens at **week 40** and runs until the new game year;
   highest bids win, ties broken randomly; won gates are added to the airport's total.
4. Airlines can **sell gates to other airlines** (player-to-player market — the pool itself only
   grows through auctions).
5. **Use it or lose it:** an airline that doesn't fly to an airport for **24 consecutive weeks**
   has its gates there returned to the pool and is **locked out of leasing there for 24 weeks**.
6. **Home-hub guarantee:** every airline is guaranteed **5 gates at its home hub**, even if the
   airport is full. These guaranteed hub gates **can never be sold** to other players.
7. **Congestion surcharge:** at any airport with **> 90% of gates in use**, every airline pays
   **+20% on its gate leasing fees** there for as long as the airport stays that full.

### Decisions already made (Dave, 2026-07-22)

| Question | Decision |
|---|---|
| Selling gates | **Player-to-player only** — no sell-back-to-airport refund |
| Auction format | **Sealed bids** (opens wk 40, closes at the year tick), top-X win at their bid price, ties broken randomly |
| Full-airport protection | **Guarantee 5 hub gates** per airline; guaranteed gates unsellable |
| Ownership caps | **60% per airline, 80% per alliance** of an airport's capacity |
| Use it or lose it | **24 idle weeks → forfeit, 24-week lockout** |
| Congestion surcharge | **+20% lease fees** at airports > 90% full |
| Where it applies | Optional world-spawn setting (`gateScarcity: true`), off by default |

---

## 2. Full ruleset

### 2.1 Airport capacity

Capacity is derived deterministically from existing airport data (no per-airport hand-tuning):

```
gateCapacityOf(airport):
  tier === 'mega'                                → 500
  tier === 'major'                               → 250
  tier === 'regional' && effectivePop >= 2       → 100   // millions; population + gateway
  otherwise                                      → 25
```

`effectivePop = population + (gateway ?? 0) + (visitors ?? 0)` — the same demand-side fields the
airport records already carry. The thresholds are constants in one place so they're tunable.
Capacity **grows over time** through auctions (rule 3), up to a hard ceiling of **2× the base
size** (an airport can't sprawl forever; also keeps the ownership caps meaningful).

### 2.2 Leasing (below capacity)

Unchanged flow: `ADD_GATE` leases the next gate at the standard escalating fee. New checks, all
enforced server-side (and mirrored in the reducer for instant UI feedback):

- **Capacity:** total gates held by all airlines at that airport < current capacity.
- **60% airline cap:** your holding after the lease ≤ `floor(0.60 × capacity)`. Applies to
  *current* capacity, so the cap rises as auctions grow the airport.
- **80% alliance cap:** if you're in an alliance, the combined holdings of all ACTIVE members
  after the lease ≤ `floor(0.80 × capacity)`. Membership is DB-authoritative (the same
  `loadAllianceMap` the tick already uses). If an airline *joins* an alliance that's already
  over the line at some airport, existing holdings are grandfathered — but no member can acquire
  another gate there until the group is back under 80%.
- **Lockout:** you are not inside a rule-5 lockout window for that airport.
- **Congestion surcharge:** while an airport is **> 90% full**, every gate held there costs
  **1.2×** its normal weekly fee. Applied automatically in the weekly fee calculation from the
  airport's live utilization — it switches on and off as the airport crosses the line, and the
  Airports tab shows the surcharged rate so nobody is surprised. (Also a soft incentive to
  release unused gates before rule 5 does it for you.)

### 2.3 The home-hub guarantee

- On joining a world, an airline may lease up to **5 gates at its chosen hub regardless of
  fullness** — if the airport is full, capacity temporarily overshoots (overshoot counts toward
  fullness, which just makes the next auction trigger sooner and larger demand for it).
- Guaranteed hub gates are your **first 5 gates at your home hub**. They are flagged unsellable
  and exempt from rule 5 (an airline that isn't even flying from its own hub is already dying;
  revoking its hub would just be cruel).
- The airline still pays normal weekly fees on them — the guarantee is availability, not charity.

### 2.4 Yearly auctions (at-capacity airports)

- **Trigger:** at **week 40** of each game year, every airport at **≥ 95% of current capacity**
  (tunable; not a strict 100% so one returned gate can't cancel an auction) opens an auction —
  unless it's already at the 2× growth ceiling. Bidding stays open until the new game year
  (~12 game-weeks — even in a fast 48-weeks/day world that's a ~6-hour real-time window).
- **Lot size X by base size:** 25 → **2**, 100 → **5**, 250 → **10**, 500 → **15** gates.
- **Sealed bids:** each airline may submit **one bid per airport auction** (amount = price for
  one gate; a bid may include quantity 1–3, capped by what the 60%/80% caps would allow them to
  win). **Bids are hidden from other players**; a bid can be raised/withdrawn until the auction
  closes at year-end.
- **Reserve price:** `26 × weeklyGateFee(airport, currentCount+1)` (≈ 6 months of rent) — stops
  $1 land-grabs when nobody else shows up.
- **Resolution:** at the **week 52 → week 1 year tick**, bids are ranked by per-gate price and
  lots are awarded top-down (pay-as-bid). **Exact ties are broken randomly** — seeded from the
  world seed + auction id (same trick as valuation noise), so a retried tick reproduces the same
  winner and nobody can game the coin flip. A winner must have the cash **at resolution time** —
  bids are not escrowed; if they can't pay, their award is voided and the next bidder moves up.
- Awarded gates are **added to the airport's capacity** and to the winner's holding, and the
  winner is charged the bid as a one-time premium (then normal weekly fees apply).
- Unsold lots simply don't happen — capacity only grows when someone pays.
- Results are announced in the **world feed** ("Azure Air won 2 gates at LHR for $4.2M each").

### 2.5 Player-to-player gate sales

- An airline may **list** any non-guaranteed gate it holds at an **asking price** (visible to the
  whole world in the Airports tab).
- Any airline may buy a listing outright at ask. The buyer must pass the same checks as a lease:
  60% airline cap, 80% alliance cap, and no active lockout at that airport. Capacity is
  unchanged (the gate changes hands).
- Seller-side check mirrors `REMOVE_GATE`: you cannot sell a gate your current routes need
  (`usedSlots > (count − 1) × SLOTS_PER_GATE` blocks the sale).
- Proceeds go to the seller in full; the weekly fee obligation transfers with the gate.
- **Anti-flip rule:** a gate acquired at auction or by purchase cannot be relisted for
  **12 weeks** (kills pure scalping; combined with rule 5 and the congestion surcharge, hoarding
  is expensive and risky).

### 2.6 Use it or lose it (rule 5)

- Tracked per airline **per airport**: a consecutive-idle-weeks counter that increments on each
  weekly tick where the airline holds gates at an airport but **no passenger or cargo route**
  touches it, and resets to 0 the moment any route does (or when a gate there is newly acquired —
  acquiring restarts your 24-week clock, giving you time to open a route).
- At **24 idle weeks**: all gates at that airport are returned to the pool (no compensation) and
  a **24-week lockout** starts — no leasing, no auction bids, no marketplace purchases there.
- **Exempt:** the home-hub guaranteed gates (§2.3).
- The player gets a **weekly warning from idle week 16** ("Your 3 gates at ORD will be forfeited
  in 8 weeks — no routes serve it") via toast + Weekly Debrief.

### 2.7 Releases back to the pool

Gates return to the airport pool (capacity stays, `taken` drops) when:

- an airline **abandons** the world or goes **BANKRUPT** (all its gates, everywhere, same tick),
- rule 5 fires,
- an airline voluntarily **`REMOVE_GATE`s** (still allowed — shedding rent is legitimate; there's
  just no refund and no player buyer).

Freed gates are instantly leasable first-come-first-served — which is exactly the drama we want
("SLOTS OPEN AT LHR" in the world feed).

### 2.8 Suggested extras (not in the initial build — noted for later)

- **Slot utilization rule (real-world 80/20):** rule 5 only checks *any* service; a stricter rule
  would forfeit gates whose slots are barely used. Adds bookkeeping; revisit if squatting-with-
  one-token-flight becomes a meta.
- **Surcharge tiers:** if +20% above 90% proves too gentle at truly gridlocked airports, add a
  second tier (e.g. +40% at 98%+). One constant away once the surcharge plumbing exists.

---

## 3. Architecture

### 3.1 The core problem: gates become a *shared world resource*

Everything about gates today lives inside each airline's own state blob
(`state.gates = { [code]: count }`), and multiplayer concurrency is **per-airline** optimistic
locking (`Airline.version`). Scarcity introduces the first *contested cross-airline resource*:
two players grabbing the last LHR gate in the same second must not both succeed. Per-airline
version checks can't see each other, so the airport pool needs its own authority.

**Decision: a world-level gate ledger in Postgres**, updated atomically inside the same
transaction as the decision/tick commit. The airline blob keeps its `state.gates` mirror (the
engine's slot math, weekly fees, and the whole solo game keep working unchanged); the ledger is
the arbiter of *availability*.

```prisma
// One row per (world, airport) that has ever had a gate leased or an auction.
model WorldGate {
  id          String @id @default(cuid())
  worldId     String
  airportCode String
  capacity    Int              // current capacity (base size + auction growth)
  baseSize    Int              // 25 | 100 | 250 | 500 (for the 2× ceiling + lot size)
  taken       Int @default(0)  // gates currently held by all airlines
  holdings    Json @default("{}") // { [airlineId]: { count, guaranteed, lockedUntilWeek?, acquiredWeek } }
  world       World @relation(fields: [worldId], references: [id], onDelete: Cascade)
  @@unique([worldId, airportCode])
}

model GateAuction {
  id           String @id @default(cuid())
  worldId      String
  airportCode  String
  year         Int              // game year it resolves into
  lots         Int              // X gates on offer
  reserve      Int              // per-gate minimum bid
  opensWeek    Int              // linear week index (weekIndex()) when bidding opened
  resolvesWeek Int              // linear week index of the year tick that resolves it
  status       String @default("OPEN") // OPEN | RESOLVED | CANCELLED
  results      Json?            // [{ airlineId, gates, pricePerGate }] — written at resolution
  bids         GateBid[]
  world        World @relation(fields: [worldId], references: [id], onDelete: Cascade)
  @@unique([worldId, airportCode, year])
  @@index([worldId, status])
}

model GateBid {
  id         String @id @default(cuid())
  auctionId  String
  airlineId  String
  amount     Int      // per-gate bid
  quantity   Int @default(1)
  createdAt  DateTime @default(now())
  auction    GateAuction @relation(fields: [auctionId], references: [id], onDelete: Cascade)
  @@unique([auctionId, airlineId]) // one (updatable) sealed bid per airline per auction
}

model GateListing {
  id          String @id @default(cuid())
  worldId     String
  airportCode String
  sellerId    String   // airlineId
  askPrice    Int
  status      String @default("OPEN") // OPEN | SOLD | WITHDRAWN
  buyerId     String?
  createdAt   DateTime @default(now())
  soldAt      DateTime?
  world       World @relation(fields: [worldId], references: [id], onDelete: Cascade)
  @@index([worldId, status])
}
```

> ⚠️ **After this migration, re-run the Supabase RLS DO-block** (see the
> `headwinds-supabase-rls` project memory / prior migration notes) — new public tables ship
> without RLS and Supabase flags them.

Atomicity: leasing runs `UPDATE "WorldGate" SET taken = taken + 1 WHERE id = ? AND taken <
capacity` (a conditional update — the loser of a race gets 0 rows and a clean 409) inside the
same transaction that writes the airline blob + Decision row. The blob and ledger can therefore
never diverge on a committed decision. A small admin repair script
(`tools/reconcile-gates.mjs`) can rebuild any world's ledger by summing all blobs' `state.gates`
— derivation-from-blobs is the recovery path, the ledger is the fast path.

### 3.2 The world flag

- `tickConfig.gateScarcity: true` — set at creation (`worldService.createWorld`), immutable after.
- Baked into each airline at join as `state.gateScarcityWorld = true` (same pattern as
  `worldDemandMult`), so the *engine* knows without a server round-trip.
- Serialized in `serializeWorld()` so the lobby can badge scarcity worlds.

### 3.3 The injected gate-market view

The client (and the reducer's UX-level checks) need to see availability. Following the exact
`withRivals`/`stripRivals` pattern in `humanRivals.mjs`:

```js
state.gateMarket = {                    // injected on every read + tick, stripped on persist
  airports: {                           // ONLY airports with a WorldGate row (sparse)
    LHR: { capacity: 500, taken: 500, yours: 12, maxYours: 300,   // floor(0.60 × capacity)
           allianceTaken: 371, maxAlliance: 400,                  // floor(0.80 × capacity); null when unallied
           surcharge: true,                                       // > 90% full → 1.2× weekly fees here
           lockedUntilWeek: null, auction: { lots: 15, reserve: 3120000, closesWeek: 260,
                                             yourBid: { amount: 3500000, quantity: 2 } | null },
           listings: [{ id, seller, askPrice }] },
  },
}
```

Airports with **no** row are simply "empty, capacity = `gateCapacityOf(airport)`" — the view
stays tiny (worlds touch a few dozen airports, not all ~2,300). The rival-view cache
(`buildWorldRivalViews`) already invalidates on every decision via the world stamp, so the gate
view rides the same cache entry with no extra invalidation logic.

---

## 4. Changes by layer

### 4.1 Engine — `packages/engine/` (shared; every change no-ops when flag absent)

| File | Change |
|---|---|
| `src/data/airports.js` | `gateCapacityOf(airport)` + `GATE_CAPACITY_BY_SIZE`, `AUCTION_LOTS_BY_SIZE = {25:2, 100:5, 250:10, 500:15}`, `GATE_CAPACITY_GROWTH_CEILING = 2`, `GATE_AIRLINE_CAP = 0.60`, `GATE_ALLIANCE_CAP = 0.80`, `GATE_SURCHARGE_THRESHOLD = 0.90`, `GATE_SURCHARGE_MULT = 1.2` |
| `src/reducer.mjs` `ADD_GATE` | When `state.gateScarcityWorld`: consult `state.gateMarket` — reject (return state + `error`) if airport full (minus hub-guarantee allowance), over the 60% airline cap, over the 80% alliance cap, or locked out. Non-scarcity path byte-identical to today. |
| `src/reducer.mjs` `ADVANCE_WEEK` | When flag set: maintain `state.gateIdleWeeks = { [code]: n }` (reset on any pax/cargo route touching the airport, or on new acquisition), fire rule 5 at 24 (drop gates from `state.gates`, set `state.gateLockouts[code] = weekIndex + 24`, toast + debrief entry), emit warnings from idle week 16. Hub-guaranteed gates exempt. |
| `src/utils/simulation.js` weekly gate fees | When flag set: multiply an airport's gate fees by `GATE_SURCHARGE_MULT` when `state.gateMarket` marks it > 90% full (`surcharge: true`). The surcharge shows as its own line in the cost report so players see why LHR got pricier. |
| `src/reducer.mjs` new **server-only** actions | `GATE_AWARDED { airportCode, gates, pricePerGate }` (adds gates, deducts cash), `GATE_SOLD { airportCode, proceeds }`, `GATE_PURCHASED { airportCode, price }`. Not in `ALLOWED_PLAYER_ACTIONS` — dispatched only by the worker/marketplace routes, exactly like alliance membership is server-governed. Keeps ALL cash math in the engine. |
| `START_GAME` | Unchanged — still seeds 1 hub gate. The *guarantee* is an entitlement enforced at lease time, not 5 free gates (5 gates at a mega hub = $600k/mo of rent a fresh airline can't carry). |

### 4.2 Server — `apps/headwinds-server/`

| File | Change |
|---|---|
| `src/lib/worldConfig.mjs` | Accept + validate `gateScarcity` (boolean), store in `tickConfig`, expose in `serializeWorld` |
| `src/routes/worlds.mjs` `POST /worlds` | `gateScarcity: { type: 'boolean' }` in the body schema |
| `src/lib/worldService.mjs` `joinWorld` | Bake `gateScarcityWorld: true`; create/update the hub's `WorldGate` row granting the 1 starter gate (guaranteed-flagged) |
| `src/lib/decisionGuard.mjs` | `guardAddGate` / `guardRemoveGate`: in scarcity worlds re-verify capacity / 60% airline cap / 80% alliance cap / lockout / slot-need against the **ledger** + alliance graph (client is untrusted); whitelist payload to `{ airportCode }` |
| `src/routes/decisions.mjs` | For `ADD_GATE`/`REMOVE_GATE` in scarcity worlds, extend the existing transaction with the conditional `WorldGate` update (§3.1); 409 on race loss |
| `src/routes/gates.mjs` **(new)** | `GET /worlds/:id/gates` (market view), `POST .../gates/:code/bid` (place/update/withdraw sealed bid — validates reserve, 60%/80% headroom, lockout, one per airline), `POST .../gates/listings` (create listing; rejects guaranteed gates, anti-flip window, slot-need check), `POST .../gates/listings/:lid/buy` (transactional: buyer checks + `GATE_PURCHASED` + `GATE_SOLD` + holdings transfer), `DELETE .../gates/listings/:lid` (withdraw). All behind `requireAuth` + the existing decision rate limiter. |
| `src/lib/gateService.mjs` **(new)** | The ledger logic: `leaseGate`, `releaseGates`, `transferGate`, `openDueAuctions` (week-40 scan), `resolveDueAuctions` (year tick: rank bids with seeded random tie-break, cash check via blob, apply `GATE_AWARDED`, bump capacity, write results, feed events), `applyIdleForfeitures` (sync rule-5 blob changes into the ledger), `releaseAllFor(airlineId)` (bankrupt/abandon) |
| `src/lib/tickService.mjs` | After the airline loop in a scarcity world: reconcile rule-5 forfeitures into the ledger; at week 40 call `openDueAuctions`; at the year tick call `resolveDueAuctions`; on any airline going BANKRUPT, `releaseAllFor` |
| `src/routes/worlds.mjs` leave route | `releaseAllFor` on abandon |
| Feed (`PUBLIC_DECISIONS` / feed route) | New event kinds: `gate_auction_opened`, `gate_auction_won`, `gate_listed`, `gate_sold`, `gates_forfeited`, `gates_released` — auction/marketplace events come from their tables, not the Decision journal |

### 4.3 Client — `src/components/` (shared UI) + `apps/headwinds-web/`

| File | Change |
|---|---|
| `apps/headwinds-web/src/App.jsx` (admin create form, ~line 206) | "Gate scarcity" toggle beside starting capital / demand multiplier, with a one-line explainer; scarcity badge on world cards + world detail |
| `src/components/Airports.jsx` | Scarcity worlds only: availability bar per airport (`taken/capacity`, amber at >90% with a "+20% fees" chip, red at ≥95%), "FULL — auction opens wk40" chip, your-share-of-cap indicator (airline + alliance), lockout countdown chip, disable + explain the `+` button when blocked. New **Gate Market** section: open auctions (your sealed bid form), open listings (buy button), your listings (list/withdraw, guaranteed gates shown with a 🔒). |
| `src/components/AirportDetail.jsx` | Capacity/holdings breakdown by airline (public info — it's who's at the airport) |
| `src/components/WeeklyDebrief.jsx` | Rule-5 warnings/forfeitures, auction results |
| `src/components/Wiki.jsx` + `headwinds-web/pages/rules.html` | Document the ruleset |
| Setup screen (hub picker) | In scarcity worlds show gate availability per airport so nobody unknowingly hubs somewhere they can't grow |

### 4.4 What Tailwinds gets

Nothing. The engine changes are inert without `gateScarcityWorld`, which only
`joinWorld` ever sets. No mirror commit needed (first Headwinds feature that doesn't mirror —
same precedent as the stock market's rival dependence).

---

## 5. Build order

Each phase ships independently and the world flag can go live from Phase 1.

- **Phase 1 — Scarcity core.** Migration (+ RLS re-run), world flag end-to-end (create form →
  `tickConfig` → baked state → lobby badge), `WorldGate` ledger + transactional lease/release,
  capacity + 60%/80% cap + hub-guarantee + congestion-surcharge enforcement (guard + reducer UX
  checks), bankrupt/abandon
  release, Airports tab availability UI. *Scarcity worlds are playable: first-come-first-served
  until full.*
- **Phase 2 — Use it or lose it.** Idle tracking + forfeiture + lockouts in `ADVANCE_WEEK`,
  ledger reconciliation in the tick, warnings in toast/debrief, lockout UI. *Squatting dies.*
- **Phase 3 — Auctions.** Tables already exist from Phase 1's migration; `openDueAuctions` /
  `resolveDueAuctions` in the tick, bid endpoints, auction UI, feed events. *Full airports grow.*
- **Phase 4 — Marketplace.** Listings endpoints + `GATE_SOLD`/`GATE_PURCHASED` transfer flow,
  anti-flip window, market UI. *Player-to-player economy opens.*
- **Phase 5 — Polish.** Wiki/rules pages, setup-screen availability, AirportDetail breakdown,
  devlog entry, `tools/reconcile-gates.mjs`.

**Test checklist (cloud-container build per the usual workaround: fresh clone,
`npm install --ignore-scripts`, `npx vite build`):** race two simultaneous `ADD_GATE`s at a
1-gate-remaining airport (exactly one 409); 60% cap at 25-gate airport (15 max); alliance of two
airlines blocked at the 80% line, grandfathered-over-cap alliance can't acquire; hub guarantee
overshoot at a full 25-gate airport; rule-5 clock resets on route open and on new acquisition,
fires at exactly 24 idle weeks; surcharge flips on at 91% and off at 90% and shows in the cost
report; auction with more bidders than lots / fewer bidders than lots / broke winner / exact-tie
bids resolve deterministically per world seed; sale of a route-needed gate blocked; guaranteed
gate listing blocked; solo Tailwinds save + non-scarcity Headwinds world behave byte-identically
to today.

---

## 6. Open questions (fine to defaults, flagged for Dave)

1. **Bid quantity** — plan says 1–3 gates per sealed bid; happy to make it 1 for simplicity.
2. **Auction trigger threshold** — ≥95% at week 40 (vs. strict 100%).
3. **Anti-flip window** — 12 weeks (independent of rule 5's 24-week rhythm; could align to 24).
4. **Capacity ceiling** — 2× base; remove if endless growth is preferred.
5. **Guarantee = entitlement, not grant** — new airlines still start with 1 hub gate and lease
   up to 4 more whenever they want, full or not. If you'd rather they *start* with all 5, say so
   (watch the week-1 rent at mega hubs).
