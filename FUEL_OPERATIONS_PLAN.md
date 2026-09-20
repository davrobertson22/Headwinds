# Fuel Operations — Design & Implementation Plan

**Date:** 2026-09-19
**Status:** Phases 1 + 2 BUILT 2026-09-19, Phase 3 BUILT 2026-09-20 (Headwinds; Tailwinds port pending). Phases 4–6 design only; 3c age creep parked (open question 3).
Deviations from plan, Phase 3: the burn modifier rides the multiplier the sims receive (`fuelSimMultiplier` = price × burn, threaded by `tickPrep` and exposed as `proj.fuelMultiplier`; the price alone is `proj.fuelPriceMultiplier`) rather than wrapping `aircraft.fuelMod`, because `coverPass.fleet` is persisted and a wrap would compound weekly. The per-week fuel resolution moved out of `tickPrep` into `utils/fuelOps.js` (`resolveFuelForWeek`, byte-identical) so `projectRouteAddition` can default to `fuelSimMultiplierOf(state)` — which fixed a pre-existing bug: it defaulted to `state.fuelMultiplier ?? 1.0`, a field never written, so the Route Planner, route finder and aircraft recommender all forecast fuel at par whatever the index. Programme side effects hook existing channels only: OTP via `labor.eventOtpDelta`, maintenance via a `fleetMaintMod` on the four `aircraft.maintMod` sites in `weeklyTick`, breakdown odds via a `probMult` on `rollMechanicalFailures` (one RNG draw per tail either way), opex as `totalFuelProgrammeCosts` in the overhead bucket; `weight_reduction` has capex as its only cost (no satisfaction drag — no clean transient hook for it). Report fields (`fuelBurnMod`, `fuelProgrammeSavings`, `totalFuelProgrammeCosts`) are written only while a programme is on, so `PARITY OK` held with no re-baseline. Tests: `tools/fuel-programme-test.mjs` (17), `tools/fuel-programme-ui-test.mjs` (8, SSR incl. a per-route preview vs the tick's `routeResults`).
Deviations from plan, Phase 1+2: `hedgeStats` and `financialHistory[].fuelMultiplier` are written **lazily** (only once a contract closes / only on hedged weeks) so a never-hedged save stays byte-identical and the golden master needed no re-baseline; a `guardUnwindHedge` was added to `decisionGuard.mjs` and `UNWIND_HEDGE` to the `world.mjs` allow-list; the rival projection's `RIVAL_FIN_KEEP` moved 12 → 13 and its field set gained `fuelIndex`/`fuelMultiplier` (SQL and JS twin both); the quarterly news row renders in `News.jsx` and the `Feed.jsx` ticker; the old "Recently Expired" card (which read contracts the tick had already dropped) became "Closed Contracts" fed from `hedgeStats.recent`; the preview's expiry label was fixed (it clamped to W52). Tests: `tools/hedge-desk-test.mjs` (20), `tools/fuel-paid-test.mjs` (12), plus additions to `fuel-hedge-ui-test.mjs`, `hedge-coverage-guard-test.mjs`, `rival-projection-test.mjs`.
**Scope:** both games. Engine work lands in `packages/engine` and ports to Tailwinds by intent (the engine is shared by convention, not by package). Multiplayer-only pieces are marked **[MP]**.
**Provenance:** Discord, 9/17–9/18 — LtFrosty ("fuel contracts could be extended? … 26 wk contract only saves 3.5 mill … purchase our own fuel station, refinery, or trucks"), TheCookiesGuy ("they add a premium on top of the percentage so the savings is negligible"). Follows `claude/heavy-landing-profit-collapse.md` (zero hedges across the top 8 airlines) and `claude/fuel-impact-visibility.md` (dollar legibility, shipped 9/16).
**Explicitly out of scope (Dave, 9/19):** the regime walk + news foreshadowing (`docs/fuel-hedging-v2-design.md` Part B) and fuel→fare pass-through (audit A4). Neither is assumed anywhere below; nothing here blocks adding them later.

---

## 1. The problem

Fuel is one shared number that everyone pays, and the only lever is a hedge priced *fair* against a walk the player can fully see. LtFrosty's numbers are exactly what the model produces: at spot 1.38 the 26-week lock is `expectedMeanIndex` (~1.18) × 1.10 = ~1.30. On a $62M/wk bill at 75% cover that saves ~$3M/wk *if the market holds* and loses ~$4M/wk if it reverts as the model says it will. The 10% premium is roughly 60% of a one-sigma move of the stationary walk (σ ≈ 0.17), so the desk is correct, the players are correct that it's negligible, and the equilibrium is that nobody hedges. Heavy Landing sat at ≥1.25 for ~30 game weeks — longer than the longest contract — and every airline in the world ate it in parallel.

Fuel is weather. Nothing a player does about it changes their standing against anyone else.

## 2. Design principles

1. **Levers players pull differently.** Every phase adds a decision with a trade-off, not a discount. A feature that just makes fuel cheaper for whoever has the most cash makes the world worse.
2. **Price and burn stay separate.** Hedges cover the *price* (`fuelMultiplier`). Programmes, retrofits, stations and tankering change *burn or basis*. They live in different state fields and different factors so `fuelImpact.js`'s base-bill reconstruction and hedge accounting stay exact.
3. **Previews agree with the tick.** One helper, `routeFuelFactor(state, route, aircraft)` in a new `packages/engine/src/utils/fuelOps.js`, is the only way any screen or the tick derives the per-route fuel factor. `pairShare.projectRouteAddition`, `financeProjection`, the route-launch forms, the cargo planner and Fleet ▸ Aircraft Detail all route through it. (CLAUDE.md rule; the hydrated-`stops` bug is the precedent.)
4. **Live worlds never jump.** Opt-in additions (hedge products, programmes, retrofits, farms) ship to every world immediately. Anything that changes the cost of flying the player already does (station basis, age creep) is versioned: `world.tickConfig.fuelOpsV` (absent = 1) for Headwinds, `state.fuelOpsV` for solo saves. New worlds/games get 2; existing ones stay on 1 unless explicitly opted in.
5. **Verified failing on HEAD** for every engine behaviour; `PARITY OK` on the golden master except where a balance change is intended and stated in the commit.

## 3. Phases at a glance

| # | Phase | Answers | Games | Effort |
|---|---|---|---|---|
| 1 | Hedge desk: reprice, 52-week product, unwind | LtFrosty, TheCookiesGuy directly | both | ~1 session |
| 2 | Hedge scoreboard + rival "fuel paid" tile + quarterly news | makes hedging visible/social | both (tile+news MP) | ~1–2 |
| 3 | Fuel efficiency programme + winglet retrofits (+ optional age creep) | levers for non-traders | both | ~2 |
| 4 | Station fuel pricing + tankering | hub choice matters for fuel | both | ~2–3 |
| 5 | Fuel farms: consortium stake / owned farm, throughput fees | "own fuel station … trucks" | both (fees MP) | ~2–3 |
| 6 | Refinery (endgame, crack-spread model) | "refinery … several billion" | both | ~2–3, optional |

Ship 1+2 together — that's the reply to the Discord thread. 3 and 4 are independent of each other. 5 depends on 4. 6 depends on nothing but is the most debatable (§9).

---

## 4. Phase 1 — Hedge desk

### 4.1 Reprice and lengthen

`fuel.js` `HEDGE_DURATIONS`:

| id | weeks | premium today | premium new |
|---|---|---|---|
| short | 8 | 3% | 1.5% |
| medium | 13 | 6% | 2.5% |
| long | 26 | 10% | 4% |
| **year** (new) | **52** | — | **6%** |

Pricing stays `expectedMeanIndex(spot, weeks) × (1 + premium)` — the forward-curve fix (A2) was right; the premium on top of it was just too fat. A 52-week product at spot 1.38 locks ~1.18 (decay at 52 wk ≈ 0.29); if the walk actually averages 1.30 over the year, that's 0.12 × cover × base bill. On LtFrosty's book (~$34M/wk base at 75%) that is ~$4M/wk, ~$210M over the term — a real bet with a real downside, priced at 6% instead of a coin toss you pay 10% to enter.

Existing contracts store `lockedPrice`, so nothing already bought changes. `HEDGE_COVERAGES` unchanged (stacking to 100% already works).

### 4.2 Unwind

New action `UNWIND_HEDGE { id }` (reducer.mjs, beside `BUY_HEDGE`):

```
remaining  = contract.expiryAbsWeek − curAbsWeek          (≤ 0 → no-op)
baseBill   = lastReport.totalFuel / lastReport.fuelMultiplier   (no report or ≤ 0 → refuse)
covEff     = coverage_i × min(1, rawCoverage) / rawCoverage     (same normalisation as effectiveFuelMultiplier)
notional   = baseBill × covEff × remaining
mtm        = notional × (expectedMeanIndex(spot, remaining) − lockedPrice)
haircut    = UNWIND_HAIRCUT (1.5%) × notional
settlement = mtm − haircut                                (cash += settlement; refuse if cash + settlement < 0)
```

Symmetry matters: the desk buys back on the *same* expected-mean curve it sells on, so a buy-then-unwind round trip costs exactly premium + haircut and there is no arbitrage. An in-the-money contract during a spike pays out positive; an underwater one costs cash to exit (that's the point — the player who hedged into a glut can cut the loss instead of riding it).

The unwound contract is removed from `hedgeContracts` and folded into `hedgeStats` (Phase 2) with `realizedSavings + settlement`.

### 4.3 UI

Finance ▸ Fuel & Hedging: the 52-week card in the duration picker; each active contract gets **Unwind** with a live preview ("receive $X now" / "pay $Y to exit"), using the same `hedgeQuoteDollars` framing as the buy preview. Copy pass on the buy panel: premiums are now small enough to say plainly "you pay 4% over the forward curve for certainty".

### 4.4 Tests

- `tools/fuel-hedge-test.mjs`: new pricing table (lock at 0.75 / 1.00 / 1.38 for all four durations); 52-week lock at spot 1.38 ≈ 1.177.
- Unwind: round trip is lossy by exactly premium + haircut; in-the-money contract at a spike settles > 0; underwater contract settles < 0 and is refused when cash is short; unwinding an expired id is a no-op. Failing on HEAD by reproducing `UNWIND_HEDGE` returning `state` unchanged.
- `tools/fuel-hedge-ui-test.mjs`: SSR the real Fuel tab, assert the four duration cards and the Unwind control render.
- Golden master: expected `PARITY OK` — confirm the golden fixture holds no hedges before claiming it. If it does, this is a stated balance change and re-baselines in the same commit.

---

## 5. Phase 2 — Scoreboard and the social layer

This is `docs/fuel-hedging-v2-design.md` Part A, unchanged in substance; summarised here so this plan is self-contained.

### 5.1 Per-contract realized P&L (A1)

In `ADVANCE_WEEK`, where `liveHedges` is written back: `baseBill = report.totalFuel / fuelMultiplier`; per active contract `savings_i = baseBill × covEff_i × (currentFuelIndex − lockedPrice_i)`; accumulate `contract.realizedSavings`. Identity test: Σ savings_i ≡ baseBill × totalCoverage × (index − weightedLocked).

### 5.2 Lifetime record (A2)

`state.hedgeStats = { lifetimeSavings, contractsClosed, wins, losses }` (default `{}` in the loader). Fold contracts in when they expire or unwind.

### 5.3 UI (A3)

Active contracts: **Saved so far** column. Recently expired: final P&L, coloured. Tiles: **Lifetime hedge P&L**, **Record W–L**.

### 5.4 Rival "fuel paid" tile (A4) **[MP]**

`financialHistory` entries gain `fuelMultiplier` (new field; older entries lack it and are skipped). `humanRivals.mjs` `toHumanCompetitor` adds `fuelPaid13w: avg(fuelMultiplier over last 13)`. Competition per-airline view: **Avg fuel paid (13w)** vs the world spot average over the same weeks — "6% below market" / "12% over market". Reveals the outcome, never the contracts; Competition's privacy rule stands.

Solo/Tailwinds: AI carriers don't hedge, so the tile is you-vs-market.

### 5.5 Quarterly news line **[MP]**

At weeks 13/26/39/52, `newsService.mjs` gains `fuelQuarterNewsRows` (same shape as `gateForfeitureNewsRows`, kind `fuel_quarter`): "Cheapest fuel this quarter: Bob Airways at 0.97× — world average 1.18×." Written inside the tick transaction alongside the other rows.

### 5.6 Tests

Accounting identity; fold-on-expiry and fold-on-unwind; a contract bought at spot 0.80 then riding a shock to 1.30 shows positive savings; SSR of Fuel tab with the new columns; `toHumanCompetitor` averages correctly and ignores entries without the field. `PARITY OK` (no hedges in the golden fixture).

---

## 6. Phase 3 — Efficiency programme and retrofits

The lever for the majority of players who won't trade. Five to eight percent off a $62M bill beats the hedge that started the thread, and it reads as progression.

### 6.1 Programmes

`packages/engine/src/data/fuelProgrammes.js`, airline-wide toggles in `state.fuelProgrammes = { [id]: { active, sinceAbsWeek } }`, action `SET_FUEL_PROGRAMME { id, active }`. Each has a cost and a side effect that hooks an *existing* system — no new systems.

| id | burn | cost | side effect (existing knob) |
|---|---|---|---|
| `single_engine_taxi` | −0.8% | $2M one-off training | +1% maintenance multiplier (uneven engine cycles) |
| `cost_index` (reduced cruise speed) | −2.0% | none | −1.5 pt OTP; +2% block time feeds the utilisation cap |
| `weight_reduction` (seats, carts, water, EFBs) | −1.0% | $120k per tail one-off | −1 satisfaction (thinner seats) |
| `flight_planning` (optimised routings, CDA) | −1.5% | $400k/wk licence, scales with fleet | none — this is the "just pay" option |
| `apu_policy` (ground power at own gates) | −0.5% | none | only counts at airports where the airline holds gates |
| `contingency_fuel` (statistical contingency) | −1.5% | none | +10% mechanical/disruption event odds on the airline's routes |
| `engine_wash` | −1.0% | $6k per tail per wk | −2% maintenance multiplier (it helps the engines too) |

Total if everything is on: ~8.3%, but with the OTP, satisfaction and event side effects a player has to *choose*. The effect is one number, `fleetBurnMod(state)` = Π(1 − burn_i) over active programmes, computed in tickPrep and applied by wrapping each aircraft at the sim call sites: `{ ...aircraft, fuelMod: aircraft.fuelMod × burnMod }`. The sims already read `aircraft.fuelMod`; nothing in `simulateRoute`'s signature changes.

Report: `report.fuelProgrammeSavings` (dollars, = fuel at burnMod 1.0 − fuel actual) and a P&L note row under Fuel & Oil, mirroring the "above normal" note from the visibility work. Dashboard tile subtitle picks it up.

### 6.2 Winglet retrofits

Today wingtips are order-time only (`ORDER_AIRCRAFT` folds `wingtipDef.fuelMod` into `fleet[].fuelMod`, `hasWingtips`). New action `RETROFIT_WINGTIPS { aircraftIds[] }` on the `INSTALL_WIFI` pattern: eligible when the type has a `wingtips` option and the tail has `!hasWingtips`; cost `wingtipDef.cost × (1 + RETROFIT_PREMIUM)` with the same 0.40 premium as Wi-Fi; sets `hasWingtips` and multiplies `fuelMod`. Bulk select in Fleet, same as the Wi-Fi bulk action. No downtime for MVP.

Engine swaps are not retrofittable (they aren't in reality either).

### 6.3 Age creep (optional, versioned)

Burn +0.15%/yr from year 5, capped at +3% at 25 years, applied through the same `fuelMod` wrap. Small, but it gives fleet renewal a fuel payoff instead of only a maintenance one. **New worlds/games only** (`fuelOpsV ≥ 2`) — it's a silent tax on an existing fleet otherwise.

### 6.4 Previews

`routeFuelFactor` (principle 3) carries `burnMod`. Acceptance test is SSR of the route-launch form and Fleet ▸ Aircraft Detail with a programme active, asserting the projected fuel line equals the tick's.

### 6.5 Tests

Each programme's burn and side effect asserted through `weeklyTick` on a fixture, not through the data table; `fleetBurnMod` composition; retrofit eligibility, cost, bulk path; report savings equals the difference of two ticks; previews-agree SSR. `PARITY OK` — programmes default off, no retrofits in the fixture; age creep gated by version.

---

## 7. Phase 4 — Station fuel pricing and tankering

### 7.1 Station basis

Real into-plane prices vary ±15–30% by airport (tax, remoteness, local supply). `packages/engine/src/data/fuelStations.js`: `stationFuelBasis(airport)` derived deterministically from region, tier and an island/remote flag — not hand-curated per airport:

| driver | adjustment |
|---|---|
| region: Middle East, US Gulf/Southwest | −8% |
| region: Europe (tax) | +5% |
| region: Japan/Korea, Australasia | +6% |
| region: Africa, Pacific/Caribbean islands, Central Asia | +15% to +25% |
| tier: mega | −3% |
| tier: small | +5% |
| explicit override list | as stated (a dozen airports at most: ANC cheap, some islands dearer) |

**Mean-preserving:** calibrate the table so the departure-weighted mean basis over the golden-master network is 1.00 ± 0.01 (asserted in a test), so the world's total fuel bill doesn't shift — only its distribution across airlines.

Round-trip fuel is uplifted half at each end: `routeBasis = (basis(origin) + basis(destination)) / 2`; multi-stop routes average over each leg's departure station. It's a per-route multiplier that lives in the `stationFactor` slot of `routeFuelFactor`, separate from price and burn.

### 7.2 Tankering

Per-route setting `route.tankering: 'off' | 'auto'` (default `auto` on new routes, `off` on existing ones so nothing changes silently). When the spread between the two ends is worth it, uplift the whole round trip at the cheaper end and carry it:

```
penalty      = TANKER_PENALTY_PER_HR (0.035) × sectorBlockHours
worth it iff  basis(dear) − basis(cheap) > penalty
cost         = the dear-end half is charged at basis(cheap) × (1 + penalty)
```

Break-even spread is 3.5% per block hour — a 6% spread pays on a 1.5h sector and not on a 4h one, which is what real tankering decisions look like.

**Range constraint.** The tanks must hold outbound + return + reserves, so full tankering is only possible when the sector is under ~45% of range. Rather than a hard cut-off, the tankerable share of the return fuel is whatever tank capacity is left after the outbound load and reserves:

```
tankerFrac = clamp((0.9 × range − sector) / sector, 0, 1)
```

Full at 45% of range, half at 60%, none at 90%. The block-hour penalty usually bites first (a 0.6-range narrowbody sector is ~4h and needs a >14% spread), so tankering is a short-haul mechanic in practice, as in reality. MTOW/payload displacement on full flights is not modelled separately; the range fraction is the proxy. `auto` re-evaluates every tick, so a station whose basis changes (future events) flips on its own.

### 7.3 UI — the basis is visible everywhere an airport is

Rule: **any surface that names an airport shows its fuel basis**, the same way it shows gate fees or runway length. Nobody should discover a station is dear by reading the P&L. One shared chip, `FuelBasisChip({ code })` in `AirportLink.jsx`'s neighbourhood, rendering `0.92×` / `1.22×` with the `fuelIndexStatus`-style colour band (green ≤ 0.95, neutral to 1.05, amber to 1.15, red above), and a tooltip giving the $/litre at today's world index and the plain-language driver ("island station, +22%" / "Gulf Coast supply, −8%").

Surfaces, all in `src/components/`:

- `Airports.jsx` — new sortable **Fuel** column, so a player can sort the world by cheapest fuel when choosing a hub.
- `AirportDetail.jsx` — basis beside gate fee and runway, plus "your uplift here: $X/wk" and any farm ownership (Phase 5).
- `AirportSelect.jsx` / `OriginPicker.jsx` — chip in every option row, so it's seen while picking, not after.
- `RoutePlanner.jsx`, `TagRoutePlanner.jsx`, `CargoRoutePlanner.jsx`, `RouteFinder*.jsx` — chip on both endpoints; the fuel line of the projection shows the route basis and, if it applies, "tankering from XXX, −$Y/wk". The projection itself already comes through `routeFuelFactor` (principle 3).
- `RouteDetail.jsx`, `Routes.jsx`, `CargoRoutesList.jsx` — basis on the fuel line / a small column; tankering state per route.
- `HubManagement.jsx` — basis beside the gate fee on the hub setup and upgrade cards, before the player commits capex.
- `RouteMap.jsx` / `RivalRouteMap.jsx` (`mapCore.js`) — optional **fuel** map layer colouring airports by basis; cheap once the chip's colour scale exists.
- Finance ▸ Fuel tab — the **Stations** table: uplift $/wk by airport, basis, share of your fuel, "tankering saves $X/wk" or "not worth it (spread 4%, 5h sector)", farm/stake column (Phase 5).
- Competition airport view **[MP]** — basis and farm owner.

Tailwinds has its own copies of most of these (`tw/…`); port by intent, same rule.

When regional drift arrives (§7.6) the chip also carries a 13-week arrow so a station getting dearer is noticed on the airport, not on the bill.

### 7.4 Versioning and balance

This changes the cost of every route the player already flies, so it is versioned: `fuelOpsV: 2` for new worlds and new solo games; live worlds opt in by an admin flag with a news announcement. Golden master: intended balance change, `--update` in the same commit, stated.

### 7.5 Tests

Basis derivation and override precedence; mean-preservation over the golden network; tankering break-even in both directions and the range rule (`tankerFrac` at 45/60/90% of range); a route's fuel through `weeklyTick` equals `routeFuelFactor` × distance × burn (previews agree); the report's `fuelByStation` sums to `totalFuel` (needed by Phase 5). Failing on HEAD by asserting a route between a +20% and a −8% station costs more than one between two 1.00 stations. UI: SSR `Airports`, `AirportDetail`, `RoutePlanner` and `HubManagement` with a fixture containing a 1.22× station and assert the chip text appears on each — the visibility rule is a test, not a convention.

### 7.6 Follow-on — regional drift (not in v1)

In v1 the basis is a **fixed multiple of the world index**: when the world goes 1.0 → 1.38 every station rises 38% together and the spread between airports never moves. That is deliberate — the decision it creates (where to hub) is structural and slow, the calibration is trivial, no world-versioned RNG is needed, and no live world's history can be rewritten.

The cost is that a route's tankering verdict never changes, so `auto` is set-and-forget. The v2 that fixes that is drift per **fuel region**, not per airport: six to eight seeded OU walks (Gulf Coast, NWE, Med, Gulf/ME, Singapore, NE Asia, Oceania, Africa), mean 1.0, low σ, slow θ, clamped to about ±10%, layered on the static basis, plus occasional regional events ("Gulf Coast refinery outage, +12% for 8 weeks"). Replayed from the world seed like `worldFuelIndex` so everyone in a world sees the same regional prices; solo stores the regional state in `state.fuelPrice.regions`. Hundreds of per-airport walks would be noise nobody could track; a handful of regions is readable and is how jet fuel actually trades. Do this only after the static Stations table has been live long enough to know people read it.

---

## 8. Phase 5 — Fuel farms

The vertical-integration ask, in the form that actually exists at airports: the fuel consortium / fuel farm and hydrant. Built on the jet-base pattern in `data/mroBase.js` (levels, capex by size, ramp, close refund, host fees), which is the closest thing in the engine.

### 8.1 Levels

`packages/engine/src/data/fuelFarm.js`, `state.fuelFarms = [{ airport, level, builtAbsWeek, capex }]`, actions `BUY_FUEL_STAKE`, `BUILD_FUEL_FARM`, `CLOSE_FUEL_FARM`.

| level | what | capex (small / medium / large / mega) | effect on own uplift there | opex | requires |
|---|---|---|---|---|---|
| 1 Consortium stake | a seat at the airport's fuel consortium | $8M / $20M / $45M / $80M | −4% | 0.10% of capex /wk | ≥ 20 own weekly departures |
| 2 Owned farm & hydrant | you run the tank farm | 4× the stake | −10%, ramping from 60% over 26 wk (MRO pattern) | 0.15% of capex /wk | ≥ 60 own weekly departures; **one owner per airport per world** |

Close refund 25%. Owned farms capped at one per 25 aircraft, so a 200-aircraft airline can own eight, not eighty. The discount applies to the station basis from Phase 4, which is why 5 depends on 4.

### 8.2 Throughput fees **[MP]**

The owner of a level-2 farm earns `FARM_HOST_FEE` (3%) of every *other* airline's fuel spend at that airport last week — the consortium margin, now captured by the owner. Rivals' cost is unchanged (no griefing lever; the fee comes out of the market's margin, not their pocket). Alliance members pay half the fee and receive half the discount, on the lounge/MRO alliance-guest precedent. Settlement: `report.fuelByStation` from each airline's tick → summed by the server → credited on the *next* tick, the same shape as the dividend settlement in `tickService.mjs` (~line 404). Farm ownership is public (Competition ▸ airport view, like gates), which is what makes "who owns DXB's fuel" a thing people talk about.

One-owner-per-airport is deliberately a race at contested hubs; in a gate-scarcity world it stacks with the territory game.

Solo/Tailwinds: a pure cost lever with the same capex/opex; AI carriers don't own farms in v1 (a later add: AI fortress hubs pre-own their farm, so the player can't take it).

### 8.3 Events (flavour, later)

"Fuel farm contamination at XXX": owner's discount suspended 2–3 weeks; "Hydrant expansion complete": +2% discount for 13 weeks. One roll in the existing event table.

### 8.4 Tests

Eligibility thresholds; capex by tier; ramp; discount composes with station basis and tankering in `routeFuelFactor`; cap per fleet size; one-owner rule refused at the reducer *and* the server (a client can't claim a taken airport); fee settlement sums and lands one tick later; alliance halving. `PARITY OK` (no farms in the fixture).

---

## 9. Phase 6 — Refinery (optional endgame)

The precedent is Delta buying the Trainer refinery in 2012 for ~$150M plus upgrades: it saved on the jet crack spread in good years and lost $100M+ in years the spread collapsed. That's the model to copy — a refinery is a *different* risk, not less risk. A refinery that is "fuel 20% off forever" is a money-printer for the biggest airline and should not be built.

### 9.1 Model

Introduce a **crack index**: a second seeded OU walk (μ 1.12, θ 0.03, σ 0.03, clamped [0.95, 1.45]) replayed from the world seed exactly as `worldFuelIndex` is, stored for solo in `state.fuelPrice.crack`. The jet walk is untouched, so no live world's history is rewritten; crude is *derived*: `crude = jet / crack`. Nobody sees crude unless they own a refinery.

A refinery has fixed capacity in litres/week (set at purchase to 40% of the airline's then-current need — it does not scale with the airline) and charges that share at `crude × 1.0 + REFINING_COST (0.05)` instead of `jet`. At the mean crack of 1.12 that's ~7% cheaper on covered litres; it swings from −5% (crack at 1.0: you lose) to +25% (crack at 1.4). Hedges apply to the *non-refinery* share only. Purchase $2.5B, 52 weeks to commission, opex $2M/wk, sale at 40% of capex, one per airline. On a Kat-scale bill ($250M/wk): 40% × 7% ≈ $7M/wk gross, ~$260M/yr net — a ~10% return with real variance, on a "several billion" ticket. LtFrosty's airline ($62M/wk) would clear ~$1.7M/wk gross: it's an endgame purchase, not a mid-game one.

Outage event: 3–6 week shutdown, covered fuel reverts to jet price.

### 9.2 Why this is last

It's the only phase that needs a second stochastic process, it interacts with hedge coverage, and its audience is the two or three largest airlines in a world. Phases 1–5 give everyone else something. Build it if the farms land well and people still ask.

---

## 10. Cross-cutting

### 10.1 State additions

| field | phase | default (loader) |
|---|---|---|
| `hedgeContracts[].realizedSavings` | 2 | `0` via `?? 0` |
| `hedgeStats` | 2 | `{}` |
| `financialHistory[].fuelMultiplier` | 2 | absent on old entries |
| `fuelProgrammes` | 3 | `{}` |
| `fleet[].hasWingtips` (already exists) | 3 | — |
| `routes[].tankering` | 4 | `'off'` |
| `fuelOpsV` / `tickConfig.fuelOpsV` | 3c, 4 | absent = 1 |
| `fuelFarms` | 5 | `[]` |
| `refinery`, `fuelPrice.crack` | 6 | `null` |

### 10.2 The one helper

`packages/engine/src/utils/fuelOps.js`:

```
routeFuelFactor(state, route, aircraft, { priceMult }) →
  { priceMult, stationFactor, burnMod, total: priceMult × stationFactor × burnMod, tankering: {...} | null }
```

`weeklyTick`, `pairShare.projectRouteAddition`, `financeProjection`, the launch forms, the cargo planner and Fleet ▸ Aircraft Detail all call it. `fuelImpact.js`'s base bill keeps dividing by `priceMult` only; station and burn are part of "the same flying".

### 10.3 Golden master expectations

| phase | expectation |
|---|---|
| 1, 2, 3 (programmes/retrofits), 5, 6 | `PARITY OK` — all opt-in or off by default |
| 3c age creep, 4 station basis | intended balance change, `--update` in the same commit, stated in the message; gated to `fuelOpsV ≥ 2` so live worlds don't move |

### 10.4 Tailwinds port

Engine files port verbatim (`fuel.js`, `fuelOps.js`, `fuelProgrammes.js`, `fuelStations.js`, `fuelFarm.js`, reducer cases). UI by intent — TW's Finance/Fleet have diverged. Two known TW bugs must be fixed in the same pass or the new previews will disagree with the tick there: `tw/Finance.jsx` reads the dead `state.fuelMultiplier` (forecast always at 1.0×) and `tw/Fleet.jsx` passes the raw spot index instead of the hedged multiplier (both from `docs/game-improvement-audit-2026-08-24.md`). The 9/16 `fuelImpact.js` port is still pending too; do it first, it's the foundation the scoreboard UI sits on.

---

## 11. Sequencing

1. **Phase 1 + 2** — one PR pair, ~2–3 sessions. Reply to the thread with the 52-week product, cheaper premiums, unwind, and the scoreboard.
2. **Phase 3** — programmes + retrofits, ~2 sessions. Independent of 4.
3. **Phase 4** — stations + tankering, ~2–3 sessions, new worlds by default.
4. **Phase 5** — farms, ~2–3 sessions, after 4 has been live a couple of weeks and the station basis has been seen to be sane.
5. **Phase 6** — only if asked for again after 5.

## 12. Open questions for Dave

1. Premiums at 1.5 / 2.5 / 4 / 6% — comfortable, or keep the 26-week nearer 5%?
2. Station pricing for live worlds: opt-in flag with announcement (recommended), or push to everyone since it's mean-preserving in aggregate?
3. Age creep — worth its tiny effect, or skip?
4. Farms: one owner per airport (race) or unlimited owned farms with no fee mechanic? The race is the fun part but it's also the griefing surface.
5. Refinery at all?
