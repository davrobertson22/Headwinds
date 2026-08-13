# Game Improvement Audit — 2026-08-06

Scope: Headwinds (engine + MP server + live client) and Tailwinds, audited by four parallel passes — realism/economy, engagement/progression, UX/friction, and TW/drift. Every finding below was anchored to code (file:line), and the highest-impact claims were independently re-verified. Recently shipped work and existing plan docs (Alliances v2, MRO bases, used market, stock market v2, lease restrictions, NWR) were excluded or only extended, not re-proposed.

Legend: impact H/M/L · effort S/M/L · class [realism] [engagement] [ease-of-use] [balance] [defect] [drift]

---

## Top 10 — best value across all four passes

| # | Finding | Class | Impact | Effort |
|---|---------|-------|--------|--------|
| 1 | TW: AI competitors never actually contest routes (dead branch HW already fixed) | defect | H | M |
| 2 | World end is a non-event — no awards, ceremony, or hall of fame | engagement | H | M |
| 3 | Server rejections invisible on mobile (`.hw-topbar-err { display:none }`) | defect | H | S |
| 4 | Fuel hedging is a solved arbitrage, not a risk decision | balance | H | S |
| 5 | Labor overhead flat per airframe — Dash 8 crews cost the same as an A380 | realism/balance | H | S |
| 6 | No "while you were away" digest — debrief covers exactly one week | ease-of-use | H | M–L |
| 7 | Late joiners get week-1 capital against year-3 empires — no catch-up | balance | H | S |
| 8 | "Profit" means three different things across screens | ease-of-use | H | M |
| 9 | Frequency edits are ±1-click steppers, one server write per click, no bulk | ease-of-use | H | S–M |
| 10 | No re-engagement channel — nothing can call a player back to a real-time world | engagement | H | M |

---

## A. Realism & economy (engine — applies to both games unless noted)

### A1. Labor overhead is flat per airframe [realism][balance] — H / S
`simulation.js:3139` charges `baseWeeklyPerAircraft × fleet.length` with rates in `labor.js:31-62` totaling ~$58k/wk per airframe regardless of size. A turboprop's ~$49k/wk revenue (per overhead.js's own calibration table) is nearly consumed by labor alone, while a widebody pays ~0.5% of revenue. This is the same per-airframe distortion the NWR HQ-departure-fee rework fixed for corporate overhead — labor still has it.
**Fix:** step `baseWeeklyPerAircraft` by category, mirroring `LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY` (overhead.js:170-177), calibrated so Narrow Body lands near today's number. Golden re-baseline required.

### A2. Fuel hedging is free money below index ~0.93 [balance][engagement] — H / S
`fuel.js:134-136` prices the lock at spot × (1 + premium), but the OU walk publicly mean-reverts (θ=0.06 toward 1.0). At index 0.75 a 26-week hedge is guaranteed +EV; at 1.0 it's guaranteed −EV. Dominant strategy: hedge max whenever cheap, never otherwise.
**Fix:** price the lock off the OU expected mean over the term — `1 + (spot−1)·(1−e^(−θT))/(θT)` — plus premium. One formula change; hedging becomes genuine insurance at any index.

### A3. Fuel *events* bypass hedges — two disjoint fuel-price systems [realism][defect] — M-H / M
`reducer.mjs:2750`: `effectiveFuelMultiplier(index, hedges) * fuelMult` — the event multiplier applies AFTER the hedge blend. Being 100% hedged during a fuel_spike does nothing (the one moment hedging exists for), and the paid price disagrees with the fuel chart.
**Fix:** have fuel events shock the index walk itself (clamped), so hedges, chart, and MP's shared walk agree. Needs a small `worldEconomy.mjs` change for seeded replay.

### A4. No inflation / fuel-to-fare pass-through [realism] — M / S-M
`referencePrice` = distance × constant `_fareIndex` (market.js:532-543); labor.js:94-99 itself notes the missing fare inflation. A 6-month fuel crisis is a pure margin grinder with no strategic response.
**Fix:** fare index as a slow follower of fuel: `fareIndex += k·((1 + 0.4·(fuelIndex−1)) − fareIndex)`, k≈0.1. Cargo yields already ride the same index → freight fuel surcharges for free.
**Bundle note:** A2+A3+A4 form a coherent "fuel economy v2" pass — same files, one golden re-baseline.

### A5. Cargo is disconnected from the macro sim [realism][engagement] — M-H / S-M
Cargo tick passes no `eventDemandMultFor` and `cargoCityPairDemand` has no month term (simulation.js:3004-3007, market.js:1530); `CARGO_BACKHAUL_FACTOR = 0.65` flat. Real air cargo is MORE cyclical than pax (Q4 peak is the defining feature). Recessions, booms, and November leave tonnage untouched.
**Fix:** (a) cargo seasonal profile (Oct–Dec ~1.25, Jan–Feb ~0.85); (b) pipe (dampened) event demand into the cargo pool; (c) per-lane backhaul from endpoint cargo-mass asymmetry (`getCargoMass` exists). Each piece independent.

### A6. Unions: "always refuse" dominates for any healthy airline [balance][engagement] — M-H / S-M
Refuse = one-time −10 morale / +30 unrest (laborRelations.js:202-207), but unrest decays whenever morale ≥50 (`u*0.9 − 1.5`) and morale caps at 1.25× pay. At 1.25× you can refuse every demand forever; strikes only threaten airlines already underpaying.
**Fix:** persistent per-group grievance stock that lowers the morale *target* until a future deal clears it, or work-to-rule (−OTP for a few weeks) after refusals. No migration (default 0).

### A7. No crew pipeline — fleets crew themselves instantly [realism][engagement] — M-H / M
No hire/train action exists; 10 widebodies delivered in one week staff themselves that tick. Real growth is pilot-constrained.
**Fix (weekly-tick abstraction):** per-airline "crewed capacity" stock in block-hours growing a capped %/week (faster at higher pilot pay — finally giving >1.25× pay a purpose, see A6); aircraft beyond it fly with a temporary OTP/quality penalty rather than a hard block. New family = one-time training drag. Ties into existing `utilizationOnTimePenalty`.

### A8. Strikes cancel revenue but still burn fuel for cancelled flights [realism][balance] — M / S
`reducer.mjs:2964-2976` charges `severity × revenue` while 100% of variable costs still run. A 0.55-severity walkout costs ~double the realistic hit.
**Fix:** refund `severity ×` the week's variable route costs (fuel + catering + handling + landing); optionally a 1-2pt satisfaction hit.

### A9. Weekly tax on positive weeks, no loss carryforward [realism][balance] — M / S
`reducer.mjs:3475-3482`: 21% of `max(0, EBT)` per week; losses vanish. Volatile/seasonal airlines pay effective rates far above 21% — airlines are the canonical NOL industry.
**Fix:** single `nolCarryforward` field: losses accrue, positive EBT drains it first. ~10 lines; surfaces in pnlBridge.

### A10. Credit rating is client-side fiction; debt can't finance aircraft [defect][engagement] — M (H for MP integrity) / M
Rating + rate live in Finance.jsx:3189-3231; the reducer takes `action.interestRate` verbatim and the server guard only enforces ≥3% and ≤520 weeks — a modded client borrows at the floor with an F rating. Meanwhile UI loan products cap at $20M/52wk, so "own vs lease" is a dead choice mid-game.
**Fix:** move rating/rate into the engine (`TAKE_LOAN` ignores payload rate); add a secured multi-year aircraft loan collateralized by `valueRemaining()`. Distinct from the used-market plan (trading ≠ financing).

### A11. Disruption events never disrupt operations [realism][engagement] — M / S
Event effects support only fuel/demand/competitor multipliers (events.js:16-23); OTP is untouched by any event. During volcanic ash you run a perfect schedule to 30% fewer pax.
**Fix:** optional `otpDelta` effect field folded into `laborEffects`' on-time rate, scoped by `regionCodes`. Compensation/quality/satisfaction react through existing plumbing.

### A12. Classic worlds still run the arcade economics NWR fixed [balance][realism] — M-H / S eng + M rebalance
The NWR flag has become "realistic economy v2" (block-hour cap, HQ-by-departure, seniority, load jitter/spill, 0.95 LF ceiling) validated in production — but defaults keep the exploits for classic worlds and all TW players.
**Fix:** promote the proven non-restriction pieces to defaults for newly created worlds/saves; keep genuinely restrictive rules behind the flag.

### A13. Hub utility bonus is a flat binary 0.20 [realism][balance] — M / S-M
`demand.js:525-529` (with its own TODO): a 5-gate focus city and a 60-route fortress hub confer the identical share bonus.
**Fix:** scale 0.08→0.25 by log of spoke count at the matching endpoint; preview parity via `pairShare.js` per house rules.

### A14. Smaller items
- Directional seasonal skew for pax (demand.js:237-252 has per-endpoint profiles pre-blend) — polish, do with A5. [realism] L-M / S-M
- Dead code: `PROFILE_PREMIUM_SHARE` + legacy `SEASONALITY` export in demand.js — looks tunable, does nothing. Delete. [defect] L / S
- Fuel burn ignores load factor (simulation.js:1159). Only touch bundled with a deliberate rebalance — it moves the fresh ~65% break-even calibration. [realism] L-M / S+M

---

## B. Engagement & progression (Headwinds MP)

### B1. World end is a non-event [engagement] — H / M
The final tick flips `status:'ENDED'` (tickService.mjs:87,218), the countdown vanishes, and the client has zero ENDED handling; ended worlds even disappear from the lobby (default filter `['LOBBY','RUNNING']`). A ~7-real-month season ends in silence.
**Fix:** (a) `world_ended` news + computed awards — champion by SVPS, longest #1 tenure (Standing table has per-week ranks), most pax all-time, biggest network, best comeback; (b) end-of-season screen keyed on status + own final rank; (c) "Concluded worlds" lobby section as a permanent hall of fame. All derivable from existing tables — presentation + one tick pass, no migration.

### B2. No cross-world career layer [engagement] — H / M
Only persistent account distinction is the OG badge. Champions, 1M-pax airlines, four seasons of play — invisible next world. Season games live on meta-progression; it's also the retention answer for the #1 airline.
**Fix:** account career record aggregated at world end (worlds played, best finish, championships, lifetime pax) + earned badges via the existing badge pipeline; public player profile linked from standings.

### B3. Objectives go dark after week ~15 [engagement] — H / M (or S)
MP serves only the 10-objective starter set (worldService.mjs:124-125); most complete inside year 1, then BoardObjectives sits at 10/10 forever. For ranks 6–40 nothing frames the next 50 hours.
**Fix:** rotating per-quarter world challenges computed at tick from lastReport/standings ("best OTP among 20+ route airlines"), published as tier-1 news with a prize, feeding B1's season awards. Cheap alternative: serve the solo empire-phase board in MP (one flag).

### B4. Events are symmetric noise — and personal-narrative events fire world-wide [engagement][realism][defect] — M-H / M
Events roll once per world and apply to every airline (tickService.mjs:118-123): "YOUR catering contractor fails inspection" hits all 40 airlines at once; the viral-crew-video praises everyone. The 3 events with competitive texture are solo-only, so MP events can never change relative standings or name a player.
**Fix:** split world-shared economics (keep) from airline-targeted events rolled per airline server-side (seeded like `valuationNoise`), each landing as a news row ("Sunjet's baggage meltdown goes viral") — instantly giving rivals openings and the feed drama.

### B5. Zero re-engagement channel [engagement] — H / M
No email/push/webhook anywhere in the server. Bankruptcy countdowns, strikes, auctions, DMs — all surface only as in-client toasts via polling. A player 5 weeks from bankruptcy who doesn't open a tab finds out by dying.
**Fix:** opt-in notifications for a small critical set; cheapest community-fitting version is a per-world Discord webhook posting tier-1 headlines (the tier-1 feed is exactly the right payload and already computed).

### B6. The weekly debrief never mentions the competition [engagement][ease-of-use] — M-H / S
WeeklyDebrief.jsx renders profit, events, maintenance — all solo-shaped. No rank movement, no share deltas, no rival moves against your network, though the client already holds all of it.
**Fix:** competition strip (rank ±, biggest share gain/loss pair with rival named, rivals who touched your pairs) + when `absWeek` jumped >1, an interim "while you were away" line. Pairs with C3.

### B7. Late joiners: seed capital vs empires [balance][engagement] — H / S (+M)
`seedAirlineState` gives the identical $15M opening regardless of world age; incumbents have years of compounding, brand reach, and (scarcity worlds) all the gates. An 8-month world is effectively closed — capping every world's population at its launch cohort.
**Fix:** era-scaled join capital (e.g. ×(1 + 0.25·yearsElapsed), capped ×4 — still far below incumbents) + a "growth market" hint listing the least-contested viable pairs near the chosen hub. Server-side only, no migration.

### B8. Bankruptcy evaporates assets instead of feeding a fire sale [engagement][realism] — M / M
Gates return silently to the pool, fleet and orderbook cease to exist; rivals get one news row. The machinery for the fun version already exists (used-market listings with scrap timers, gate auctions).
**Fix:** administration sweep in the bankruptcy hook — list the dead airline's owned aircraft on the used market at distressed NAV; auction its gates at contested airports. Pure composition of existing services.

### B9. Codeshares with human rivals are unilateral and invisible to the counterparty [defect][realism] — M / M
`SIGN_CODESHARE` is on the MP allow-list (world.mjs:61) and creates the agreement against a human rival's view with no consent or notification — you collect interline revenue computed off a real player's network while they neither know nor benefit. The game's only bilateral "deal" verb isn't bilateral.
**Fix:** offer/accept flow riding the existing Message table (both blobs get the agreement next tick, news row). Until then: strip it from the allow-list or make it symmetric. Natural seed for the diplomacy layer alongside Alliances v2.

### B10. All communication is private — the world has no voice [engagement] — M / S-M
Channels are DM + alliance board only; nowhere to declare a fare war, gloat, or coordinate against the leader. Moderation prerequisites (blocks, reports, admin queue) already exist.
**Fix:** per-world public channel (same Message table, kind:'WORLD', same rate limit), rendered beside News; optionally short player "statements" attached to big feed items.

### B11. Nothing marks time inside a season [engagement] — M-H / S
Only calendar-anchored beats are gate auctions (scarcity worlds only). At 8 wk/day a game year ≈ 6.5 real days — a natural weekly cadence the game ignores.
**Fix:** make New Year a beat: "Year N in review" news bundle + client year-end card (rank deltas, world totals, award leaders). Presentation over existing Standing/statsHistory.

### B12. Alliance members can't see each other [engagement] — M / S
(Extends, not duplicates, ALLIANCES_V2_PLAN.) No shared dashboard: no combined map, no bloc share of world pax, no coverage-gap view — though the server computes alliance graphs every tick and members already receive the data.
**Fix:** alliance dashboard tab — pure client composition. Makes blocs feel like teams a full phase before Alliances 2.0.

### B13. Comebacks are socially invisible [engagement] — L-M / S
Restarts produce no news (`joined` filters on `createdAt`, which a reused row predates). The best story a persistent world produces goes untold.
**Fix:** tier-1 `refounded` news row in the restart route + track generation best-rank for a "Phoenix" award at world end.

### B14. Prestige sinks for the late game [engagement][balance] — M / M
Standings correctly rank SVPS, but everything money buys is invisible to other players. Bounded, score-neutral flexes: hub terminal naming at tier-3 hubs (shows in rivals' airport view), map/standings livery color, a charitable-foundation line buying a permanent news mention.

---

## C. UX & ease of use (Headwinds client)

### C1. Server rejections are invisible on mobile [defect][ease-of-use] — H / S
`styles.css:337`: `.hw-topbar-err { display:none }` under 640px — `actionNotice` (including the new rollback explanations) never reaches a phone; decisions silently revert, resurrecting the exact bug class the desktop fix addressed. Desktop's version is also a 12px ellipsized strip auto-cleared in 15s.
**Fix:** route `showActionNotice` through the existing ToastSystem; keep the topbar chip for connection state only.

### C2. Frequency editing: ±1 click = 1 server write, no typed input, no bulk [ease-of-use] — H / S-M
`Routes.jsx:2015-2060` — 3×→14× = 11 clicks and 11 serialized writes (11 chances to collide with a tick commit); retuning 20 routes ≈ 200+ writes. The add-route form accepts a typed number, so the asymmetry is pure UI.
**Fix:** editable number committing one `UPDATE_FREQUENCY` + a batched "set/adjust frequency" action in the SelectionActionBar mirroring `CLOSE_ROUTES`.

### C3. No away-time digest [ease-of-use][engagement] — H / M-L
The debrief is built from `lastReport` only; poll adoption replaces state wholesale, so intermediate weeks' failures, forced checks, lease returns, and expired events are simply gone. The most common session shape is "come back after N ticks."
**Fix:** "While you were away" debrief variant when `absWeek` jumps ≥2: aggregated cash delta + merged event list from a small server-side rolling digest (or `recentEvents` ring buffer). Suppress stale toasts on multi-week adoption; stamp toasts with game weeks.

### C4. "Profit" means three different things [ease-of-use] — H / M
Routes table allocates fixed by frequency share; Routes cards show op-profit excluding fixed while the same screen's "losing" strip counts fixed-inclusive (strip says "3 losing", every visible card is green); Dashboard/Finance allocate by block-hours; Finance ▸ By Route is pure contribution. The close/keep/reprice decision is fed numbers disagreeing by the whole fixed-cost slice under near-identical labels.
**Fix:** one allocation basis (block-hours), two labels ("Contribution" / "Fully-loaded"), a shared toggle, and make the Dashboard alert count match the Routes losing filter.

### C5. Onboarding tour points at tabs that don't exist [ease-of-use] — H / S
Tour says "Look for: Market →" / "Routes" / "Rivals tab", but the nav is grouped dropdowns (Network/Fleet/Airports/Company) — step 1 fails immediately for its target audience.
**Fix:** minimally reword ("Fleet ▸ Market"); better, drive highlights through the existing `hw:navigate`/`focusSection` machinery to actually open the group and flash the item.

### C6. Lease expiry: no alert, no filter, no bulk renew — then auto-return closes routes [ease-of-use] — H / S-M
Expiry auto-returns the tail, charges 4 weeks' rent, closes its routes with only a toast (reducer.mjs:3124-3139) — which an away MP player never sees. Not in Dashboard alerts; Fleet can't filter or sort by lease remaining; renewal is per-row.
**Fix:** Dashboard alert ("N leases expire within 8 wks" → Fleet pre-filtered), an "expiring" chip + sort key, "Extend all expiring +1yr" bulk action, and a debrief warning line in the final 4 weeks.

### C7. Fares commit blind — break-even exists only in Finance [ease-of-use] — H / M
FareEditor shows reference fare and cap only; break-even LF lives in Finance ▸ Breakdown. Commits fire one write per cabin on blur with no preview, though `projectRouteAddition`/pairShare exist for exactly this.
**Fix:** per-cabin "proj. load X% · BE Y%" in FareEditor (debounced local projection); single `UPDATE_CLASS_PRICES` commit for all edited cabins.

### C8. Moving one route to another aircraft = close + reopen, paying launch cost and resetting the 16-week ramp [ease-of-use] — H / M
`TRANSFER_ROUTES` is all-or-nothing per aircraft. Routine equipment swaps are punished with money and demand loss, so players don't do them or feel cheated.
**Fix:** `REASSIGN_ROUTE {routeId, toAircraftId}` reusing `transferCompatibility`, preserving ramp/pricing/season; "Move to another aircraft…" in the expanded row.

### C9. Bulk fleet actions loop N single dispatches [ease-of-use][defect] — M-H / M
Fleet sell/retire/check loops dispatch per aircraft (Fleet.jsx:1475,1506,1556) — the pattern `CLOSE_ROUTES`' own comment explains is wrong in MP. 25 writes, and a mid-loop failure leaves an unlabeled partial result after a confirm dialog that promised one atomic outcome.
**Fix:** `SELL_AIRCRAFT_BULK` / `RETIRE_AIRCRAFT_BULK` / `SCHEDULE_CHECKS` batch actions mirroring CLOSE_ROUTES.

### C10. Rivals and Stocks are buried in an 8-item "Company" junk drawer [ease-of-use] — M-H / S
The game's differentiator (human rivals) is two clicks deep under a label that describes neither it nor Stocks; the tour references a "Rivals tab" that isn't visible.
**Fix:** promote Rivals to top-level in MP; split Company into Ops/Commercial or add attention badges (dot when a strike/negotiation/auction is pending).

### C11. Dashboard alerts aren't links [ease-of-use] — M / S-M
Alerts are inert divs while the KPI boxes beside them navigate. "N loss-making routes" should land on Routes with the Losing filter active — plumbing (`hw:navigate` + `filterTab`) exists, just unwired + needs a filter payload.

### C12. Systems nothing teaches [ease-of-use] — M / M
Tour covers 7 of ~20 systems. Never mentioned anywhere in-flow: cargo/Freight toggle, C/D checks (players learn the forced-check rule by being grounded at +50% cost), gate auctions, catering, ancillaries, seasonal windows, reserves, bulk tools. Wiki covers all of it but is passive.
**Fix:** one-time contextual callouts on first touch (first Fleet visit, first freighter, week ~8 "bulk tools exist") using the existing TOUR_KEY versioning pattern.

### C13. Smaller items
- Mobile sticky column pins the 30px checkbox, not the name (index.css intent comment vs Fleet.jsx:2013-2029 column order); Fleet has no mobile card fallback. M / S
- Bulk pricing is %-only — no "set to reference ± X%" normalization, so fares drift with no way home. M / S-M
- Marketplace/checkout never compares a candidate against the fleet you own (fuel/seat and fixed-cost deltas vs your current type at current ages — all inputs exist client-side). M / M
- Multi-week catch-up fires stale toasts with no timestamps; debrief titles itself with only the latest week. L-M / S (fold into C3)

---

## D. Tailwinds + engine drift

### D1. TW: AI competitors never contest routes — the tick's competitor branch is dead code [defect] — H / M
`tw/src/utils/simulation.js:963-965` builds offers from the `COMPETITOR_AIRLINES` module constant, whose entries keep `routes: {}` forever (live networks live only in `state.competitors`). HW measured this exact bug at "0 offers on 155/155 pairs" and fixed it by threading a `competitors` param; TW still has the dead branch. Meanwhile RoutePlanner builds its share panel from live `state.competitors` — preview says "you'd get 42%", tick pays 100%.
**Fix:** port HW's parameter; dedupe vs encroachment (drop the synthetic entrant when the same rival has a real route on the pair); re-tune + golden re-baseline. **This unlocks D2 for free:** TW's genuinely good AI drama — fare wars, capacity matching, "moving in on your market" — currently only hurts the AI's own P&L; once offers are live, `buildCompetitorOffer` already reads live priceMultiplier/frequency.

### D2. TW: no difficulty selection [engagement] — H / S
No difficulty anywhere; the only adaptive pressure is market-cap-keyed. A setup-screen enum mapped onto existing tunables (starting cash, startup/encroachment probabilities, AI reserves, fare-war prob). No migration. Pairs with D1 — contested demand makes "hard" meaningful.

### D3. Drift: TW is AHEAD on acquisitions — HW solo lacks the acquisition-price floor [defect][balance] — M-H / S
TW floors the price at `cash + fleetNAV × 0.95` ("anything lower is a money printer with extra steps") for both player acquisitions and AI-AI mergers; HW's engine pays `marketCap × premium` with no floor and Competition.jsx re-derives the price locally. Port `acquisitionQuote`/merger floor to HW.

### D4. Drift: HW is AHEAD — four fixes TW needs [defect] — M / S each
- Pooled-lane allocations keyed by aircraft.id in TW (`simulation.js:2347,2472,2624`) — an aircraft on a pooled pair leaks that allocation into its other routes. HW re-keyed by route.id + anomaly telemetry.
- TW pooled lanes synthesize a phantom 3.5× business fare and take maturity from the FIRST route in the group (adding a second aircraft can reset the lane's ramp). HW: null fare + group max.
- TW delivers out-of-production types factory-fresh — HW's `eis`/`deliveredAgeWeeks` banding never ported, so Old Metal is strictly cheaper in TW than intended.
- TW `projectWeek` has no memoization — four screens re-run the full tick per render and can show different numbers for the same week (HW: WeakMap cache in financeProjection.js:70-94).
- TW over-reports loyalty/alliance revenue lift (`revenue × lift` instead of `lift/(1+lift)` — marketing was fixed, these weren't; simulation.js:2789-2790).

### D5. TW: fake positioning chart, real data available [engagement] — M / S-M
Reputation.jsx plots three hardcoded fake brands while 26+ live AI carriers with tiers/quality/fares sit in state. HW's `positioning.js` is a drop-in.

### D6. TW: endgame is a serial-acquisition grind [engagement] — M / M
Victory fires only at rival count zero — practically, buying out dozens of carriers one modal at a time. Add victory tiers evaluated in the tick (#1 by cap for 52 straight weeks; 1M pax/wk) + a new-game+ seed using D2's constants.

### D7. TW: best HW ports by concrete gap [ease-of-use][engagement] — M-H cumulative
Ranked: (a) **FareEditor** — TW reprices route-by-route through RouteDetail; (b) **lease terms + extend/buyout + used market** — TW has one lease shape and no used metal; (c) **stock market/IPO** — TW computes sharePrice weekly but has no IPO, so late-game cash has no sink (also the natural difficulty escalator for D6); (d) **RivalRouteMap**; (e) **pnlBridge**. Weakest candidate: gate scarcity (TW's AI doesn't consume gates).

### D8. TW: preview/tick disagreements [defect] — L-M / S
Fleet.jsx:306 uses a bare `simulateRoute` (no fuel/labor/events/encroachment); RoutePlanner forecasts at `fuelMultiplier = 1.0` during live fuel spikes. Same fix pattern Dashboard/Routes already use.

### D9. Drift is now policy and needs a reporter [process] — H (generator of D1–D8) / S
Measured today: 9/9 shared engine model/util files differ (~1,900 diff lines), 8/15 data files, 26/44 shared components; 14 HW-only reducer actions, zero TW-only. The retired sync script already knows the file mapping — resurrect its `--check` mode as a read-only drift reporter run periodically, plus a one-time triage of D3/D4.

### D10. TW shares A12 fully [realism] — M / S port
Permanent 100.0% load factors: TW's flat `min(demand, cap)` has the artifact HW's NWR spill/jitter/0.95-ceiling machinery fixed. TW (single save, offline) can adopt it directly with a modest retune — the code is already written in HW's market.js.

---

## Suggested sequencing

**Quick wins, ship this week (all S):** C1 mobile toasts · C5 tour rewording · A2 hedge formula · A9 NOL carryforward · A8 strike variable-cost refund · B7 era-scaled join capital · B13 refounded news · B11 year-in-review beat · C11 alert links · A14 dead-code deletion · D2 TW difficulty.

**Bundle 1 — Fuel economy v2 (M):** A2 + A3 + A4 (+optional A11 events-hit-OTP). One golden re-baseline, turns fuel from a cost dial into a strategic axis.

**Bundle 2 — Seasons & legacy (M):** B1 world-end ceremony + B2 career layer + B3 rotating objectives + B11 + B13. All computable from existing tables; the retention backbone.

**Bundle 3 — Network ops QoL (M):** C2 frequency + C6 leases + C8 REASSIGN_ROUTE + C9 bulk actions + C4 one profit definition. The mid-game toil killers.

**Bundle 4 — TW competitive revival (M):** D1 live competitor offers + D2 difficulty + D5 positioning + D4 drift fixes. Makes single-player's whole AI layer real.

**Bigger swings (choose one at a time):** A7 crew pipeline · B4 per-airline events · B5 notifications/Discord webhook · B9 consensual codeshares (seed of diplomacy) · A10 engine-side credit + aircraft loans · B8 bankruptcy fire sales.
