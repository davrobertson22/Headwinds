# Headwinds Reserve Aircraft — Hub-Based Standby Covers (Design v1)

**Date:** 2026-07-27
**Status:** Design for review — no code written yet
**Scope decisions (agreed):** designated reserves with automatic dispatch (not fully-automatic, not manual-only) · hub-based scope (a reserve is stationed at one of your hubs/focus cities and covers routes touching it) · **identical-type coverage only** (a 737 cannot cover an A320 — the reserve must be the same aircraft type as the tail it replaces) · **stationing costs money**: a line-maintenance readiness premium plus a hub parking fee while on standby · implement in Headwinds first, mirror to Tailwinds after playtest

**Origin:** Discord — Mariaklinga (7/25/26): *"I don't like when a game tells me aircraft are sitting idle so would it be possible to make something that you can set aircraft to replace certain routes when delayed/cancelled or aircraft are grounded/checked to replace their routes as good as possible?"* Several players have asked for variants of this since the C/D check system shipped.

---

## 1. Goals

- Give idle aircraft a **job**: a spare stationed at a hub automatically steps onto the routes of any aircraft that breaks down or goes into a check, and steps off when it comes back.
- Make it a **placement decision**, not a checkbox: reserves cover only routes touching their base airport and only tails of their own type, so *where* you station spares — and *which type* you keep spare — against your network's shape matters. This is exactly the hub-standby pattern real airlines use, and it quietly rewards fleet commonality: an all-A320neo operator needs one spare where a five-type boutique fleet needs five.
- Complete the loop the maintenance overhaul opened: checks made downtime a planning problem; reserves are the tool the player was implicitly promised for solving it ("your spare A320 can cover the route" — maintenance-design.md §3).
- **"As good as possible", honestly:** coverage is per-route and best-effort. A same-type reserve is a true like-for-like swap — full capacity, full range, no weird substitution math — and whatever can't be covered (wrong base, no same-type spare, block hours full) is shown, not hidden.
- Deterministic and MP-safe: designation goes through the decision pipeline; dispatch/return run inside the weekly tick reducer. No randomness anywhere in this feature.

**Non-goals (v1):** ferry positioning to cover routes away from the base, pre-positioning ahead of scheduled checks, wet-leasing covers from other players, crew modelling. Phase 3 candidates (§10). Strike cancellations are explicitly NOT covered by reserves — strikes are a crew problem, and a spare airframe doesn't fix a picket line (also the strike revenue forfeit at reducer L2508 is a fleet-wide percentage, not per-aircraft).

---

## 2. What exists today (audit)

| Mechanic | Where | Notes |
|---|---|---|
| Out-of-service machinery | `maintenance.js` `isOutOfService` — `'grounded'` (breakdowns) + `'maintenance'` (C/D checks) | Routes of an OOS tail earn nothing (`simulation.js` L1952, L2080, L2373) but stay open — the exact gap covers fill |
| Route→tail model | one route record per tail; `route.aircraftId` | The sim resolves the aircraft per route (`fleet.find` at L2078), so *temporarily rewriting `aircraftId` reuses every line of existing math* — revenue, wear, block hours, hub maint factor, utilization |
| Full compatibility guard | `transferCompatibility` (reducer L100) | Idle target, pax/freighter match, per-leg range, per-leg regulatory re-check, per-month peak block hours. Under the identical-type rule most of this collapses to no-ops for covers (same type ⇒ same range/category/restrictions already approved on the route) — only the block-hours check survives |
| TRANSFER_ROUTES | reducer L885, already MP allow-listed | Proof the "move routes between tails" shape is safe; covers are a temporary, per-route, engine-initiated version |
| Hubs & focus cities | `state.hubs = { CODE: { tier, tierSince } }` (tier 0 = focus city) | The basing targets. No aircraft-location concept exists anywhere — the base is a designation, not simulated geography |
| Tick anchor points | ADVANCE_WEEK (reducer L2247): grounded countdown ~L2343, check lifecycle ~L2623, failures applied ~L2591 | Recoveries/failures resolve at tick END, so a dispatch/return pass at tick TOP sees clean statuses and covers the first lost week — zero revenue gap |
| Per-route value | `financialHistory[last].routeRevenues` (reducer L3100) | Deterministic greedy-priority key, already in state |
| Idle-plane nudge | the "aircraft sitting idle" messaging that started this thread | Becomes the feature's front door: "…or station it as a reserve" |

**Key insight:** the sim already treats `route.aircraftId` as the single source of truth. Covers can therefore be implemented as *engine-managed temporary transfers* — a pre-pass and a revert-pass in the tick, ~zero changes inside `weeklyTick` simulation itself.

---

## 3. Player experience (narrative)

Your A320neo fleet runs a tight bank out of DFW. You take delivery of one more than the schedule needs, and instead of letting it sit idle you click **Station as reserve → DFW** in the Fleet tab. It shows a blue shield chip: **Reserve @ DFW**.

In March, N-482HW goes into its scheduled C check. Same week, the reserve slides onto its DFW routes automatically — a genuine like-for-like swap, same type, same capacity. The Weekly Debrief reads "N-517HW covering N-482HW: 7 of 7 routes". Revenue doesn't blink; a week later the C check completes, the reserve hands the routes back and returns to standby. Two toasts, zero clicks.

In July, a 767 blows an engine at your MIA focus city — but your only reserve is an A320neo based at DFW: wrong base AND wrong type. The Operations coverage card shows the gap plainly: "3 routes uncovered, ~$410k/wk at risk — no 767 reserve based at MIA". You decide whether a spare widebody is worth holding at MIA, or whether the 767 fleet is small enough to just eat check downtime. That's the placement game working — spares are a per-type, per-hub investment, exactly like real airlines.

---

## 4. The model

### 4.1 New state

```js
// On the reserve aircraft (set by the player):
reserveBase: 'DFW' | null   // airport code of one of YOUR hubs/focus cities

// While a cover is live (set/cleared only by the tick):
//   on the covering tail:  coveringForId: '<original aircraft id>'
//   on each moved route:   coverForAircraftId: '<original aircraft id>'
// route.aircraftId points at the RESERVE for the duration — nothing else changes.
```

No new aircraft status. A stationed reserve keeps `status: 'idle'` (it isn't flying); while covering it is `'assigned'` (it is). Every existing consumer of status keeps working; the UI derives its chips from `reserveBase`/`coveringForId`. This avoids re-touching the ~6 call sites the `'maintenance'` status migration just consolidated behind `isOutOfService`.

### 4.2 Dispatch pass (top of ADVANCE_WEEK, before the sim runs)

Runs before `weeklyTick`, right after the previous tick's statuses are final:

1. **Return first.** For every live cover whose original is back in service (`!isOutOfService(original)` — its check/grounding completed at the end of last tick): move the routes back (`aircraftId` → original, clear `coverForAircraftId`), original → `'assigned'`, reserve → `'idle'` (still stationed). Also return if the *reserve* has gone OOS (it broke down or got force-grounded itself — routes revert to the original, and step 2 may immediately re-cover them with a different reserve).
2. **Dispatch.** Build the uncovered-route pool: every route whose `aircraftId` is OOS and not already covered. Sort by last week's revenue (`routeRevenues`, fallback 0), tiebreak by route id — deterministic. For each route, scan stationed reserves (idle, in service, sorted by id) and assign to the first that passes the **cover check** (§4.3). Multiple reserves can split one broken aircraft's network; one reserve can cover routes from several broken aircraft at once — "as good as possible" is per-route greedy by value.
3. Emit toasts/debrief entries for covers started, ended, and — important — for value **left on the table** (uncovered routes + revenue at risk + the reason: no same-type reserve at that base / reserve's block hours full).

Because recoveries resolve at tick end and dispatch runs at the next tick's top, coverage starts the first week revenue would have been lost, and the original never fights its own cover for the routes. Order within the pass is fully specified — no `Math.random()`, MP-tick safe, replayable.

### 4.3 The cover check (per route, factored out of transferCompatibility)

A reserve R may cover route r of broken tail B iff:

- **Identical type:** `R.typeId === B.typeId`. The rule (agreed): a 737 can't cover an A320. This does most of the compatibility work for free — same type means same range, same category (so no regulatory re-check), same pax/freighter role, and same per-route block hours as the schedule the route was approved on. It also keeps the swap honest: no capacity arithmetic, no "my spare turboprop is covering a 777 route at 4% capacity" silliness.
- **Base touch:** `reserveBase` ∈ {origin, destination, every tag/multi-stop leg endpoint} of r (reuse `routeLegs`). This is the hub-based scope — the spare is *at* one end of the route.
- **Block hours:** r's block hours *plus everything R is already covering* ≤ `MAX_WEEKLY_BLOCK_HOURS` at the per-month peak (mirrors ADD_ROUTE/transfer) — the one transfer-guard check that survives the identical-type rule, since one reserve can be covering for two broken tails at once.
- **Not needed in the shop:** R has no `scheduledCheck` starting within the next 2 weeks (don't dispatch a spare that's about to leave itself; if its own check comes DUE mid-cover, the normal machinery handles it and step 1 recycles the routes).

Cabin config may still differ between two tails of the same type (one all-economy, one three-class) — the sim prices the covering tail's actual config, which is the right, visible consequence of keeping a differently-configured spare. Gates and slots need no changes: the routes keep their identity and frequencies, so pair budgets are untouched — same waiver `TRANSFER_ROUTES` already relies on.

*(Considered and rejected: family-level matching — A320neo covering A321neo — and free-for-all with capacity math. Same-family is the natural first relaxation if playtest says strict typing makes reserves too expensive to hold for mixed fleets; it's a one-line change to this predicate, noted in §11 Q2. Starting strict is the right default: relaxing later is a buff players will cheer, tightening later is a nerf they'll riot over.)*

### 4.4 Economics — what covering costs and earns

- **Revenue is computed with the covering tail** through the untouched sim. Same type ⇒ near-identical economics; the only divergence is cabin config (a differently-fitted spare earns what its actual seats earn). No synthetic sub-service penalty — a like-for-like swap deserves like-for-like revenue.
- **Wear follows the metal.** `maintHoursById` (reducer L2577) keys off `route.aircraftId`, so the covering tail accrues the block hours toward ITS C/D clocks while the broken tail's wear is frozen in the shop. Flying your spare hard genuinely consumes it — the correct tradeoff, for free.
- **Holding cost (decided):** an idle spare already pays lease/ownership + weekly line maintenance; stationing adds two explicit charges on top, so the designation is a real decision rather than a free checkbox:
  - **Readiness premium** — +15% on the reserve's weekly line-maintenance cost while stationed (crew on standby, systems kept warm). Rides the existing per-aircraft maintenance line in the weekly fleet-cost pass, so labor multipliers and the budget slider apply to it naturally.
  - **Hub parking fee** — a weekly charge for occupying a stand at the base airport, priced off the existing `LANDING_FEE_PER_DEPARTURE` table (overhead.js L139) so it scales with both aircraft size and airport tier for free: `parking = LANDING_FEE_PER_DEPARTURE[category][baseTier] × RESERVE_PARKING_FEE_MULT` per week. At the proposed ×3: a narrow body parked at a mega hub ≈ $11.4k/wk, a widebody ≈ $23k/wk, a turboprop at a regional field ≈ $510/wk — real money next to line maintenance, trivial next to a lease, and it makes *regional* bases genuinely cheaper places to keep spares. The fee is **suspended in any week the reserve is out covering** (it's flying, not parked — the spare earns its keep when dispatched); the readiness premium applies throughout.
  - Both surface as their own line in the Finance fleet-cost breakdown ("Reserve standby — N-517HW: parking $11.4k + readiness $8.7k"), never silently folded into maintenance.

### 4.5 Ownership edge cases (all resolved by one rule: *covers are temporary; permanence requires the original to be gone*)

- **Original sold / retired / lease-expired while covered** → the cover becomes a permanent transfer: clear the markers, routes stay on the (now plain-assigned) ex-reserve, `reserveBase` cleared. Better than yanking routes dead the moment the broken plane is sold.
- **Reserve sold while covering** → routes revert to the original first (still OOS → back to earning nothing), then the existing SELL path runs. The −15% NAV due-penalty already prevents the related dodge on the original.
- **Player closes / re-prices / transfers a covered route** → all normal; CLOSE clears the marker, TRANSFER_ROUTES off a covering tail makes it permanent (player overrode the engine — respect it).
- **Player manually assigns new routes to a stationed reserve** → allowed; planner shows a confirm ("this tail is your DFW reserve") and clears `reserveBase`.
- **Hub removed (DOWNGRADE below focus city)** → reserves based there lose their station: `reserveBase` cleared, toast explains.
- **Migration:** old saves/MP blobs have no covers and need nothing beyond field defaulting in the load normalizer (`reserveBase: null` etc.). No golden-master shift — with zero reserves designated, the tick pass is a no-op.

---

## 5. Actions (engine reducer — shared SP and MP)

```js
SET_RESERVE   { aircraftId, baseCode }   // idle, in-service tail; baseCode ∈ your hubs/focus cities
CLEAR_RESERVE { aircraftId }             // free; if currently covering, cover runs to natural end, then just goes idle
```

No `COVER_NOW` action: weeks are atomic and dispatch runs at tick top, so a manual button could never beat the automatic pass — it would be UI theater. (If playtest demands a manual override — "cover THIS plane's routes, not that one's" — it's a priority field on the aircraft, not a new verb. §11 Q3.)

---

## 6. UI plan

- **Fleet tab (`Fleet.jsx`):** idle tails get **Station as reserve** → picker of your hubs/focus cities, with a live preview per base: what it covers ("from DFW this A320neo can stand in for your 6 other A320neos whose routes touch DFW — 41 routes reachable"; and honestly, "0 — none of your DFW aircraft are this type" when basing it there is pointless) and what it costs ("standby cost ≈ $20.1k/wk: $11.4k parking + $8.7k readiness"). The cost line is what makes the choice legible — and makes cheap regional bases an intentional discovery. Chips: `🛡 Reserve @ DFW` (blue) / `🛡 Covering N-482HW — 6 routes` (blue, active) — alongside, OOS tails show `covered by N-517HW (6/7 routes)`. New sortable "Reserve" facet in the existing click-to-sort header row.
- **Operations tab (`Operations.jsx`):** the Maintenance card grows a **Coverage** section: reserves by base, live covers, and the gap list — uncovered OOS routes with $/wk at risk and the blocking reason. This is the screen that teaches placement.
- **Check scheduling flow:** the routes-affected list in the schedule-check UI (maintenance-design §6.3) now annotates each route *covered by N-xxx / uncovered (reason)* — the two features complete each other: schedule the check where your coverage is.
- **Routes list / RouteDetail:** small shield badge on covered routes; uncovered-while-OOS routes keep their current dead state but gain the reason line.
- **Weekly Debrief:** Coverage section — covers started/ended, est. revenue saved (covered routes' revenue that week), gaps.
- **Toasts:** cover started (info), cover ended/handed back (success), gap warning (warning, once per incident): "3 of N-991HW's routes are uncovered — no 767-300ER reserve based at MIA."
- **The idle nudge:** wherever "aircraft sitting idle" appears today, append "— station it as a reserve so it can cover breakdowns and checks." That sentence is the direct answer to the Discord post.
- **Wiki:** "Reserve aircraft" article; devlog + sitemap entry at ship time per the usual routine.

---

## 7. Multiplayer specifics

- **Allow-list:** add `SET_RESERVE`, `CLEAR_RESERVE` to `ALLOWED_PLAYER_ACTIONS` (world.mjs L21).
- **decisionGuard:** `guardSetReserve` — aircraft belongs to the airline, is idle and in service, `baseCode` is one of the airline's own hub/focus-city codes, payload sanitized to exactly `{ aircraftId, baseCode }` (same pattern as `guardScheduleCheck`, decisionGuard.mjs L216).
- **Tick:** dispatch/return run inside each airline's own reducer pass — no cross-airline reads, no new race surface, no randomness at all (unlike failure rolls, this feature never even needs the server-side Math.random carve-out).
- **Journal/world feed:** enrich `SET_RESERVE` with the tail name ("stationed N-517HW as a reserve at DFW") — harmless-to-share flavor; covers themselves are tick events and stay in the private debrief. No `stripRivals` changes.
- **Anti-cheat surface:** payload carries no amounts; everything is computed server-side from state. The only exploit-shaped thing is free designation churn, which the readiness premium (if adopted) prices, and which is otherwise harmless.

---

## 8. Tuning constants (one new file: `packages/engine/src/data/reserve.js`)

```js
export const RESERVE_READINESS_MULT    = 1.15;  // line-maint surcharge while stationed (agreed)
export const RESERVE_PARKING_FEE_MULT  = 3;     // × LANDING_FEE_PER_DEPARTURE[cat][baseTier], per week (agreed; suspended while covering)
export const RESERVE_NO_DISPATCH_IF_CHECK_WITHIN_WEEKS = 2;
export const RESERVE_MATCH = 'type';            // 'type' (agreed v1) | 'family' (possible later relaxation, §11 Q1)
```

Pure functions beside them: `canCoverRoute(reserve, type, route, state)` and `planCovers(state)` (returns the full deterministic assignment for the tick pass AND the Fleet-UI preview — one implementation, two consumers, mirroring the `transferCompatibility` shared-guard pattern).

---

## 9. Test plan

New `tools/reserve-cover-test.mjs` (wired into npm test like the rest):

- Zero-gap: schedule a check → cover live the first OOS week → routes and statuses revert the week after completion; original comes back `'assigned'`.
- Hub scope: route not touching the base is never covered; stationing at the right hub covers it.
- Identical type: a same-family-different-type reserve (A320neo vs A321neo) never covers; a same-type one does; cumulative block-hour rejection produces an uncovered route with the right reason.
- Greedy value order: with one reserve and two broken tails, the higher-revenue routes win, deterministically across repeated runs.
- Reserve breaks mid-cover → routes revert; second stationed reserve picks them up next tick.
- Sell original mid-cover → permanent transfer, markers cleared, reserveBase cleared.
- Wear: covering tail's `hoursSinceC` grows during the cover; broken tail's is frozen.
- Standby costs: readiness premium and parking fee charged while stationed-idle; parking suspended (premium kept) in a covering week; both stop the week `CLEAR_RESERVE` lands; fee scales with base tier and category per the landing-fee table.
- Migration: old-shape save loads with no covers, no reserveBase, tick is a no-op; MP guard rejects foreign aircraft ids and non-owned base codes.

Plus ui-smoke + web-smoke passes. No golden-master re-baseline expected (feature is inert until designated).

---

## 10. Phasing

| Phase | Contents | Size |
|---|---|---|
| **1 — Core loop** | State fields + migration defaulting, `SET_RESERVE`/`CLEAR_RESERVE`, `canCoverRoute`/`planCovers`, tick dispatch+return pass, standby costs (readiness premium + parking fee, Finance line), Fleet UI (station/chips/cost preview), toasts + debrief section, MP allow-list + guard, `tools/reserve-cover-test.mjs` | Medium (~7–9 files HW) — much smaller than the checks system; the sim itself is untouched |
| **2 — Visibility layer** | Operations coverage card, check-scheduling coverage preview, Routes/RouteDetail badges, idle-nudge copy, wiki + devlog | Small |
| **3 — Depth (design again first)** | Ferry positioning (cover any route within ferry range of base: 1-week positioning delay + fuel cost), pre-positioning ahead of a `scheduledCheck`, reserve priority ordering, MP wet-lease market ("rent my idle 777 as your reserve" — genuinely novel multiplayer economy hook) | Later |

Recommendation: ship 1+2 together — Phase 2 is mostly copy and one card, and the feature's teaching loop (the gap list) is what makes hub-basing feel fair rather than punishing.

## 11. Open questions for Dave

*(Settled: readiness premium — yes, +15% line maint while stationed; hub parking fee — yes, weekly, landing-fee-scaled, suspended while covering. Both per Dave 2026-07-27.)*

1. **Strict typing pressure valve:** if playtest shows mixed fleets can't justify a spare per type, relax `RESERVE_MATCH` to `'family'` (A320neo↔A321neo, with the transfer guard's range/restriction checks re-enabled for the size difference)? Ship strict, hold this in the back pocket.
2. **Parking fee multiplier:** ×3 the per-departure landing fee feels right on paper (NB @ mega ≈ $11.4k/wk); happy to start ×2 if playtest says holding spares is too punishing for small carriers.
3. If playtest surfaces fights over *which* broken tail gets the reserve, add a per-aircraft cover priority — worth pre-building, or wait for the complaint?
4. Announce in Discord as a reply to Mariaklinga's post once shipped? (It's a direct yes to their ask, minus the strike case — worth saying why.)

## 12. Tailwinds mirror

Engine changes port near-verbatim (shared reducer lineage). TW has no decision pipeline/allow-list; hubs/focus cities exist identically, so scope rules carry over. Mirror after HW playtest confirms the greedy heuristics feel right — the constants file plus `planCovers` isolation makes re-tuning a one-file diff, same as the checks system.
