# Game Improvement Audit — 2026-08-24

Third full sweep. Scope: Headwinds (engine + MP server + live client) and Tailwinds, four parallel finder passes (realism/economy, engagement/retention, UX/clarity, exploits/MP-fairness) plus a fifth pass that re-checked the current status of every finding from the **2026-08-06** improvement audit and the **2026-08-12** bug audit. Report only — no code changed.

Legend: impact H/M/L · effort S/M/L · class [realism] [balance] [engagement] [ease-of-use] [exploit] [defect] [drift]. Every new finding is anchored to `file:line` in the tree as it sits on disk (HW HEAD `2d4b327`). Line numbers drift; grep the described pattern if one has moved.

---

## What changed since the last two audits

The tree has moved **a lot**. The metro-demand rework and the P1 UX build-out swept up most of the 8/12 bug audit as a side effect:

- **Every CRITICAL from 8/12 is CLOSED** (C1 rival double-count, C2 BUY_HEDGE negative-coverage money printer, C3 Finance monopoly sim, C4 fare-blind editor, C5 TW launch forecast).
- **HIGH is almost entirely CLOSED** — 15 of 19. Still open: **H4** (HPN/SWF carry all of New York's population) and **H18** (HKG–SZX etc. escape same-metro suppression); **H5/H13** are now PARTIAL (main preview paths fixed, a few grounded-route fallbacks and TW's Fleet detail remain).
- The **fuel/labor/economy** feature bundle (A1, A2, A3, A5, A6, A8, A10, A11, A13, A14) and the **UX QoL** bundle (C3, C4, C5, C6, C7, C8, C9, C11, C12) largely **shipped**.
- Tailwinds' competitive revival shipped its core (D1 live AI offers, D5 real positioning chart, D10 load-factor ceiling).

So the yield of *new* material is narrower than last time, and it clusters in two places: **(1)** the newly-shipped profiles / account-DMs / career work is only half-surfaced — it exists on the server and in the lobby but barely reaches the world where players actually live; and **(2)** the **engagement / seasons** bundle from 8/6 (world-end ceremony, rotating objectives, per-airline events, notifications, public channel, year-in-review) is still almost entirely unbuilt. That cluster is now the single biggest lever left.

---

## Top 12 — new findings + still-open known items, ranked by value

| # | Finding | Class | New? | Impact | Effort |
|---|---------|-------|------|--------|--------|
| 1 | Cargo demand is never contested between airlines — freighters are a structurally dominant, uncontestable revenue stream | balance/defect | new* | H | S–M |
| 2 | Account DMs are unreachable & invisible from inside a world — the shipped DM feature is half-wired | defect | new | H | S |
| 3 | HPN & SWF carry all 20.1M of New York — HPN out-earns JFK (8/12 **H4**, still open) | balance | known-open | H | S |
| 4 | The season is invisible: career badges/SVPS never reach in-world standings or the rival dossier | engagement | new | M–H | S |
| 5 | SET_BRANDING bypasses the reserved-tag filter — `[DEV]`/`[OG]` impersonation via in-game rename | exploit/fairness | new | M | S |
| 6 | Engagement/seasons bundle still unbuilt — world-end ceremony, rotating objectives, per-airline events, notifications, public channel, year-in-review (8/6 B1/B3/B4/B5/B10/B11) | engagement | known-open | H (cumulative) | M each |
| 7 | Finance forecast omits the lease **deposit refund** on a lease's final week — deterministic, always-same-direction miss | defect | new | M | S |
| 8 | A380 (and old freighters) are the cheapest widebody per seat — inverts real economics, dominant owned trunk buy | balance | new | M | S |
| 9 | No "last active" signal anywhere — a live rival is indistinguishable from an abandoned one | engagement | new | M | M |
| 10 | Bulk cabin reconfigure & live-drag sliders fire N serialized server writes — the batch-action remediation missed them | ease-of-use/defect | new | M | S |
| 11 | Same-metro suppression still misses 23 land-connected pairs; 3 dominated widebodies with no test; DKR/DSS duplicate airport (8/12, still open) | balance/data | known-open | M | S |
| 12 | Stock float pool is sized for **one** player on start-on-first-join worlds — the SVPS venue runs at ~1/N liquidity | defect | new | M | S |

\* #1 is noted as a known limitation in the cargo-lane-pooling session memo ("cross-airline cargo competition still doesn't exist") but appears in neither audit doc and was never quantified. Treat it as new.

---

## A. New findings — realism & economy

### A-new-1. Cargo demand is never contested between airlines [balance][defect] — H / S–M · BOTH (MP far worse)
`utils/simulation.js:2293` (`FREIGHTER_CAPTURE_RATE = 1.0`), `:2356` (`simulateCargoRoute` — the signature has **no** competitor/rival parameter), `:2378-2382` (pool = `cargoCityPairDemand × maturity × 1.0 × demandMult`, no rival term), `:2468` (`cargoLaneAllocations` groups only the **player's own** fleet), tick loop `:4046-4056`.

The passenger path now runs every offer through `computeMarketShare` against competitor/encroachment/human-rival offers, so demand is split and conserved across airlines — that was the whole point of the C1/H9 remediation. **The cargo path has no equivalent.** `simulateCargoRoute` cannot even receive a rival, and `FREIGHTER_CAPTURE_RATE` is 1.0, so every airline on a lane independently draws the *entire* freight pool up to its own capacity. In MP, two carriers on FRA–JFK each bank the full ~1,378 t/wk. There is also no belly-cargo reservation (the code comment admits it), so freighters take 100% of a pool that in reality is ~half belly.

Measured (all fixed per-aircraft costs subtracted, FRA–JFK at max frequency, monopoly-equivalent for both):

| aircraft | net $/wk | price | annual ROI |
|---|---|---|---|
| b747-400F (cargo) | 3.96M | $55M | **375%** |
| MD-11F (cargo) | 3.43M | $44M | **405%** |
| b747-8F (cargo) | 5.43M | $175M | 161% |
| A350F (cargo) | 4.89M | $175M | 145% |
| b787-9 (pax) | 1.30M | $150M | 45% |
| A350-900 (pax) | 1.22M | $185M | 34% |
| 777-300ER (pax) | 1.88M | $170M | 57% |
| A380 (pax) | 2.54M | $150M | 88% |

Cargo ROI runs 2–4× the best passenger widebody, and the gap **widens** as a world fills up — passenger ROI erodes under the share fight while cargo stays at monopoly levels. This is the current dominant strategy of the game, and in MP it is uncontestable by design. The fix is the passenger fix, ported: give `simulateCargoRoute` a competitor/rival term and split the pool across airlines the way `cargoLaneAllocations` already splits it across your own tails. (Discord's original "spam freighters and still max it out" complaint was the *own-fleet* half of this; the cross-airline half was never built.)

### A-new-2. A380 is the cheapest widebody per seat — economics inverted [balance] — M / S · BOTH
`data/aircraft.js:483-496`. A380 `purchasePrice = $150M` for 853 seats = **$176k/seat**, against 787-9 $357k, 777-300ER $309k, A350-900 $420k, 747-8i $314k. In reality the A380 cost *more* per seat than any of them (~$445M list) and failed commercially for exactly that reason. Its only offsets in-game are highest maintenance ($390k/wk) and worst widebody fuel burn (1,800 L/100km), but on any demand-rich trunk it still posts the best per-dollar ROI of the passenger widebodies (88% monopoly, table above). Owned A380 is the correct capacity buy far more often than it should be. Price should be the *highest* per-seat, not the lowest. The same "cheap old airframe → outsized ROI" shape lifts the b747-400F / MD-11F in A-new-1 and used widebodies generally (depreciation floors don't track earning power); the A380 is the clean new-build mispricing.

### A-new-3. Double-Deck & Supersonic layover cost assumes only 2 flight-deck crew [realism] — L / S · BOTH
`data/overhead.js:396` — `const flightDeckCrew = category === 'Wide Body' ? 3 : 2;`. An A380 or ultra-long-haul is flown by 3–4 augmented pilots, *more* than a widebody, yet Double Deck and Supersonic get 2 while Wide Body gets 3. Undercounts the layover hotel/per-diem line for the largest aircraft and compounds A-new-2's cost advantage. One-line category bump.

---

## B. New findings — engagement (the shipped-but-unsurfaced cluster)

The profiles + account-DMs + career work (commits `44f5371` / `3d6a62e` / `2d4b327`) landed on the server and in the lobby, but almost none of it reaches the play screen where a persistent-world player spends the entire season. These three are cheap because the data already exists.

### B-new-1. Account DMs are unreachable & invisible from inside a world [defect] — H / S · HW
`AccountInboxWidget` is mounted only in the lobby shell (`apps/headwinds-web/src/App.jsx:1328`), which renders *after* the early `route.screen === 'play'` return at `:1304` — so it never appears while a player is in a world. `GamePlayScreen.jsx:25-27` imports `MessagesWidget` and `FeedWidget` but **not** `AccountInboxWidget`, and it renders the rival profile overlay without an `onMessage` handler (`:574-577`), so you can't start an account DM from a rival's in-game profile either. The server even computes the badge (`me.mjs:36 unreadMessages`) but **no client code reads it** (zero references). Net: in a ~7-month real-time world, an account DM — whose stated purpose is cross-world/cross-season contact — produces no unread indicator, can't be read, and can't be answered until the player leaves for the lobby. With no email/push fallback, a DM to an active player can sit unseen for the whole season. Surfacing the existing widget (or just the `unreadMessages` badge + `onMessage`) in the game topbar is pure composition.

### B-new-2. The season is invisible: career badges & SVPS never reach in-world surfaces [engagement] — M–H / S · HW
`CAREER_BADGES` (Champion, Podium, Veteran, Million-flyer, Phoenix) are derived from totals the account already carries (`career.mjs:114-160`) and render on the profile screen and the lobby `CareerPanel`. But every in-*world* surface carries only `og`/`dev`: the standings serializer (`worlds.mjs:127-150`), the rival dossier select (`rivalProfile.mjs:29-50` — account select is `{ isOG, email }` only), the Feed, and Messages. A returning three-time champion joining your world is visually identical to a week-one rookie in the standings table. Also `players.mjs:125` ships `svps` per current airline but `PlayerProfile.jsx` renders no SVPS column (dead field). Surfacing career badges (one `careerStats` read per distinct account, or piggybacked on the joins these queries already do) is the strongest "who am I actually up against" signal a season has, and it's the natural payoff for the career layer that just shipped.

### B-new-3. No "last active" signal for any airline [engagement] — M / M · HW
No `lastActive` / `lastSeen` / `lastMoveAt` is tracked anywhere on the server (zero hits). Every ACTIVE airline ticks to the same game `week` whether or not a human has touched it in a month (`tickService.mjs:103`), so `week` is not an activity signal and standings can't tell a live rival from an abandoned-but-coasting one. "Is my rival still playing / is this alliance member pulling their weight / is now the time to attack" is a core competitive hook and is currently unanswerable. Cheaper than it looks: a rival's most recent player `Decision.createdAt` (already queried for the dossier's `recentMoves`, `worlds.mjs:227-231`) yields a "last move" timestamp with no new tracking.

### B-new-4 (minor). Two half-wired edges from the profiles/DM work [defect] — L / S · HW
(a) The profile "✉ Message" button shows for any player (`PlayerProfile.jsx:103-108`), but the default DM policy is `SHARED_WORLD` (`accountMessaging.mjs:14`), so messaging a stranger 403s *after* the user writes the message — the payload could carry a `canMessage` hint. (b) Hub selection at join is blind: `JoinForm` lists every airport (`App.jsx:196-199`) with no note of which hubs are taken/contested, though the same screen already renders every rival's `hub` from the standings payload (`worlds.mjs:141`). Annotating the picker with "N airlines already based here" targets first-session drop-off for free.

---

## C. New findings — UX & correctness

### C-new-1. Finance forecast omits the lease deposit refund on a lease's final week [defect] — M / S · BOTH
`utils/financeProjection.js:171-183` charges `leaseRedelivery` (4 × rent) on a lease's last week but never adds back the security deposit. The reducer pays it back the same week (`reducer.mjs:3699 leaseDepositRefund += depositBack`, `LEASE_DEPOSIT_WEEKS = 12`). So the forecast shows a `−4×rent` cash hit where the real movement is `+8×rent` (−4 redelivery, +12 deposit): an A380 lease ($364k/wk) is understated by **~$4.4M**, a narrowbody ~$1.2M — always in the same direction, on the week the projection has already detected the lease ends. This is exactly the "forecast is wrong and the week always comes in higher" pattern `financeProjection`'s own header rails against. TW twin identical (`tw/src/utils/financeProjection.js:176`). (Same module also never sees a *scheduled* heavy-check's cash cost, computed only in the reducer — lumpier, but a booked D-check week is deterministic and under-forecast too.)

### C-new-2. Bulk cabin reconfigure & live-drag sliders fire N serialized writes [ease-of-use][defect] — M / S · HW
The batch-action remediation (SELL/RETIRE/SCHEDULE_CHECKS as single `*_BULK` actions) missed two controls. **(a)** `FleetConfig.jsx:120-131` bulk-configure loops `targets.forEach(a => dispatch('CONFIGURE_AIRCRAFT'))` — there is no `CONFIGURE_AIRCRAFT_BULK` — so "Configure N × Type" for one quoted `reconfCost` fires N serialized `POST /decisions`, the affordability check is a single snapshot of the sum, and a mid-loop rejection leaves a partially-reconfigured fleet after the modal has already closed (a dialog promising an atomic outcome over a loop). **(b)** Three `<input type=range onChange={dispatch}>` sliders — labor pay (`Operations.jsx:378`), maintenance budget (`Maintenance.jsx:119`), MRO parts pool (`Maintenance.jsx:333`) — write on every intermediate drag value with no local draft, queuing ~30 writes per drag that drain one-at-a-time behind the CAS and congest the decision channel. `Loyalty.jsx:82` already shows the right pattern (local draft, commit on button). HW-only (TW's reducer is local).

### C-new-3 (PLAUSIBLE). RouteFinder "est. profit" disagrees with RoutePlanner for the same route [defect] — M / M · BOTH
`models/routeFinder.js:307` ranks candidates by `projectRouteAddition().mature.profit − type.weeklyLease` — the bare O&D result, no connecting/hub-feed revenue. RoutePlanner, for the same origin/dest/aircraft, adds `computeConnectingDemand(...)` feed (`RoutePlanner.jsx:777`). So a hub spoke shows a *lower* "best est. profit" in the discovery/sort surface than the "net profit" the planner shows when you open that very row — systematically under-ranking hub-feed routes. Per the house rule, the two disagree and one is wrong; verify which matches the tick's feed crediting before fixing. Both also subtract the *catalogue* lease even when the route would be flown by an owned or negotiated-rate tail (`RouteFinder.jsx:367` tooltip says as much) — a smaller, consistent overstatement of cost.

---

## D. New findings — exploits & MP fairness

### D-new-1. SET_BRANDING bypasses the reserved-tag filter — operator/veteran impersonation [exploit][fairness] — M / S · HW
`apps/headwinds-server/src/lib/decisionGuard.mjs:394` (`guardBranding`) forwards `airlineName` verbatim — no pattern check, no length cap — and `reducer.mjs:1998` stores `action.airlineName.trim()` unchecked. The game reserves the "✈ OG" and "🛠 DEV" badges and defines `OG_NAME_PATTERN` (`worldService.mjs:89`) to reject names mimicking them, but that pattern is enforced **only** at creation (`joinWorld`, `restartAirline`) — **not** on the in-game rename path. A player joins with a clean name, then submits one `SET_BRANDING {airlineName:"[DEV] Official Support"}`; the decision route's rename-heal (`decisions.mjs:519-520`, written `:577`) copies it into the top-level `Airline.name` column that rival views, standings, the news feed, alliance rosters and the DM directory all read. `[DEV]` is 5 chars, so it survives the 40-char DB slice and shows game-wide — enabling "[DEV] Support" scam DMs the anti-impersonation filter exists to stop. Verified: `OG_NAME_PATTERN.test("[DEV] Official Support") === true` (rejected on join) while `guardBranding` returns it unchanged. **Secondary:** `guardBranding` puts no length bound on `airlineName`; the DB column caps at 40 but the state blob persists it up to the 1 MB body limit and echoes it back. Fix both: import `OG_NAME_PATTERN` into `guardBranding` (reject on match) and slice to 40.

### D-new-2 (PLAUSIBLE). Stock float pool sized for one player on start-on-first-join worlds [defect] — M / S · HW
`worldService.mjs:288-289`: when the first player's join starts the world clock, `players = count({status:'ACTIVE'})` is evaluated *after* the joiner's row is created — so it's **1** — and `seedWorldMarket` upserts with `update:{}` and never re-seeds. A 50-player world then runs its entire share market (the SVPS leaderboard's price-discovery venue) on ~1/50th of the intended liquidity, and `poolCash`-short refusals dominate stock/capital actions all season. Scheduled-start worlds are unaffected (their pool is created lazily at real player count by `ensureWorldMarket`). Affects everyone in an affected world equally, so it's a correctness/balance bug rather than a targeted exploit — flagged because the code's own comment ("sized off the players who actually joined") describes an intent the first-join reality contradicts. Fix: size at `world.maxPlayers`, or scale as players join.

---

## E. Still-open known items, re-ranked for this cycle

These survive from 8/12 (bug audit) or earlier. Confirmed still open in the current tree.

**Data — high value, low effort (do first):**
- **H4 — HPN & SWF carry all 20.1M of New York; HPN out-earns JFK.** `data/airports.js:528` (HPN), `:570` (SWF) — both `population: 20.1`, no `effectivePop`. Westchester (a 6,549 ft regional) and Stewart out-earn JFK on the same lane because the population field does all the demand work. Ten more regional-tier rows carry ≥8M mass; the NY group totals ~102M for a 20.1M metro. Fix is a handful of `effectivePop`/`population` edits + a near-duplicate-coordinate and metro-mass test so it can't regress. **H / S.**
- **H18 — same-metro suppression misses 23 land-connected pairs.** `utils/market.js:451 SAME_METRO_MAX_KM = 35`; HKG–SZX (38 km, different country) prints 33,268 pax/wk over a 38 km hop at ~20× the per-km yield of a real route; MCO–SFB, SIN–JHB, SUB–MLG, FUK–KKJ, GRU–VCP similar. Water hops in the same band (BOB–HUH, POS–TAB…) are legitimately left alone, so this needs a curated group list, not just a wider radius. **M / S.**
- **DKR/DSS duplicate airport** (`airports.js:358`/`:796`, identical Blaise Diagne coords) — the only sub-3 km pair in the table; `addRouteBlockReason` only rejects `origin===destination`, so the 0 km route is openable and consumes gates/slots/a launch fee. **L / S.**
- **Three dominated widebodies + no passenger dominance test.** `b787x10` and `c929` lose to `a330neo` on all nine axes; `b7778x` loses to `a350900ulr` at identical $195M. `aircraft-consistency-test.mjs` runs a strict-dominance sweep for freighters and 757s only — a whole-table passenger sweep finds these immediately. **M / S.**

**Engine correctness — still open:**
- **Line-maintenance hub discount is last-route-wins.** `simulation.js:3993` assigns `aircraftMaintFactor[aircraft.id] = hcfRoute?.maint ?? 1.0` inside the per-route loop, so a spoke route touching no hub resets a gateway discount — ~8%/wk decided by `state.routes` array order (which changes on any route delete/re-add). The heavy-check sibling correctly takes `Math.min`. **M / S.**
- **NWR weekly load jitter keyed on `route.id`.** `simulation.js:3091` draws independent ±2.5% jitters per tail on a pooled lane, a spread above the 0.05 tolerance of the engine's own `poolingAnomalies` self-check — so the diagnostic meant to catch pooling failures fires on every multi-aircraft pair in an NWR world. Re-key to the O&D pair (TW already did). **M / S.**
- **ACQUIRE_COMPETITOR has no cash/break-up floor in HW** (D3). Prices at `marketCap × 1.25` with no `cash + fleetNAV × 0.95` floor; a cash-rich, loss-making rival is a money printer. **Blocked in MP** by the 403 at `decisions.mjs:287`, so latent — but it's live for any future solo/AI-merger path and TW already has the floor. **M / S.**

**TW drift — still open:**
- **TW Finance Forecast reads a dead field:** `tw/Finance.jsx:2374 state.fuelMultiplier ?? 1.0` (read in 3 places, written in 0) — the forecast always simulates at fuel ×1.0 while the correct `proj.fuelMultiplier` is already a prop. **M / S.**
- **TW Fleet ▸ Aircraft Detail bypasses `projectWeek`** (D8): `tw/Fleet.jsx:493` passes the raw spot `fuelPrice.index`, not `effectiveFuelMultiplier(index, hedges)`, so a player who just paid for hedging sees ~17% *worse* per-route profit on the page where they inspect aircraft. **M / S.**
- **TW `hw_profit_basis_v1` localStorage key** (`tw/routeEconomics.js:72`) — Headwinds-namespaced key in the Tailwinds build; un-greppable from the TW side and collides if the two apps ever share an origin. **L / S.**

**Server / MP — still open (mostly hardening):**
- Service events (`catering_scandal`, `baggage_meltdown`, `viral_praise`, `service_award`) still fire **world-wide** (8/6 B4 / 8/12) — every carrier wins the same award or suffers the same meltdown the same week, and the second-person copy ("**Your** catering contractor…") is a lie for 39 of 40. Rolling them per-airline is the seed of real per-player drama (see F). **M / M.**
- Late joiners and re-founded airlines get flat starting capital (8/6 B7) — `worldService.mjs` — an 8-month world is effectively closed to newcomers. **H / S.**
- Non-ACTIVE airlines keep full messaging privileges (`messages.mjs` never checks status); `joinWorld` capacity and alliance-accept are check-then-act outside a transaction (small-margin overflow under simultaneous requests). **L–M / S.**

---

## F. Feature backlog — what shipped, what's left

**Shipped since 8/6** (verified present): A1 category labor · A2 OU-forward hedge pricing · A3 fuel shock into the index · A5 cargo seasonality/events · A6 union grievance stock · A8 strike variable-cost refund · A10 server-side credit + secured aircraft loans · A11 events hit OTP · A13 scaled hub bonus · A14 dead-code delete · B2 career layer + badges · B6 debrief competition strip · B8 bankruptcy fire sale · B9 bilateral codeshares · B12 alliance dashboard · C3 away digest · C4 one profit basis · C5 tour rewording · C6 lease alerts/bulk · C7 fare break-even preview · C8 REASSIGN_ROUTE · C9 bulk fleet actions · C11 alert links · C12 first-touch callouts · D1 TW live AI offers · D5 TW real positioning · D10 TW load-factor ceiling.

**Still not built** (the real backlog):

| ID | Item | Why it still matters |
|---|---|---|
| **B1** | World-end ceremony / awards / hall of fame | A ~7-month season still ends in silence; ended worlds vanish from the lobby. Now that the **career layer (B2) has shipped**, this is the event that *feeds* it — champions, longest #1 tenure, most pax. Highest-leverage single build. |
| **B3** | Rotating per-quarter objectives | The 10-item starter board still retires itself (`BoardObjectives.jsx:52`); ranks 6–40 have nothing framing the next 50 hours. |
| **B4** | Per-airline events | (see E) world-wide events can never change standings or name a player. |
| **B5** | Re-engagement channel | No email/push/webhook exists — a player 5 weeks from bankruptcy finds out by dying. Cheapest version: a per-world Discord webhook posting the tier-1 feed that's already computed. |
| **B10** | Public world channel | No way to declare a fare war or coordinate against the leader; moderation prerequisites already exist. |
| **B11** | Year-in-review beat | New Year (≈ every 6.5 real days) is an unused natural cadence; presentation over existing Standing/statsHistory. |
| **B13** | Refounded news row | Comebacks are socially invisible; the career layer already tracks the Phoenix badge, the news row isn't written. |
| **B14** | Prestige sinks | Late-game money buys nothing other players can see. |
| **A4 / A7 / A9** | Fuel→fare pass-through · crew pipeline · NOL carryforward | The three economy pieces the fuel/labor bundle didn't reach. A9 is ~10 lines. |
| **A12** | Promote NWR economics to default | Classic worlds and all of TW still run the arcade model the flag fixed. |
| **C10** | Promote Rivals out of the Company drawer | The game's differentiator is still two clicks deep. |
| **D2 / D6 / D9** | TW difficulty · TW victory tiers · drift reporter | D9 (resurrect `sync-from-tailwinds --check` as a read-only drift report) is the process fix that prevents the next round of D-items. |

**The through-line:** profiles, DMs, and the career layer all shipped in the last three weeks, but they live in the lobby and barely touch the world. Finishing that wiring (B-new-1 DMs into the play screen, B-new-2 badges into standings, B-new-3 last-active) **plus** the world-end ceremony (B1) and year-in-review (B11) turns four disconnected features into one coherent "the season is legible and social" story — and every piece is composition over data the server already computes.

---

## Suggested packages (report-first; nothing built until you pick)

**P1 — Finish the season layer (mostly S, high engagement ROI).** B-new-1 (DMs reach the play screen) + B-new-2 (career badges + SVPS in standings/dossier) + B-new-3 (last-active from `Decision.createdAt`) + B13 (refounded news) + B-new-4 (canMessage hint, hub-pick annotation). All composition over existing data. This is the highest value-per-hour cluster in the report.

**P2 — World-end & time beats (M).** B1 world-end ceremony/awards/hall-of-fame + B11 year-in-review. The retention backbone the career layer is now waiting for.

**P3 — Cargo & aircraft rebalance (S–M, one golden re-baseline).** A-new-1 (contest cargo across airlines — the current dominant strategy) + A-new-2 (A380 per-seat price) + A-new-3 (crew count) + the E dominated-widebodies fix and passenger-dominance test. State it as a balance change; it moves live cargo P&L.

**P4 — Data integrity (S).** H4 (NY population) + H18 (same-metro list) + DKR/DSS, each with the missing cross-reference/near-duplicate test. Cheap, and H4 is a live "why does Westchester out-earn JFK" waiting to be noticed.

**P5 — Correctness quick wins (S).** C-new-1 (lease deposit in the projection) + D-new-1 (SET_BRANDING reserved-tag + length guard) + D-new-2 (stock pool sizing) + line-maint last-route-wins + NWR jitter re-key + C-new-2 (bulk configure + slider drafts).

**P6 — TW drift sweep (S each).** TW dead `state.fuelMultiplier` · TW Fleet raw fuel index · TW `hw_` key · then D9 (drift reporter) so the next round is caught by a script.

**Bigger swings (choose one):** B4 per-airline events · B5 notifications/Discord webhook · B10 public channel · A7 crew pipeline · A4 fuel→fare pass-through.
