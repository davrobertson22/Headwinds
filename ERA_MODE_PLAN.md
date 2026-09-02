# Era Worlds — a calendar that starts in 1950

**Status:** ALL PHASES BUILT — 0–5 pushed in Headwinds; phase 6 (Tailwinds port) built in the Tailwinds repo 2026-08-31. See BUILD STATE below.

## BUILD STATE (2026-08-27)

Built and green in this repo (all uncommitted, Dave to commit/push):

- **Phase 0 — the epoch.** `tickConfig.startYear` → validate/serialize (`worldConfig.mjs`) → `createWorld` (`worldService.mjs`, `routes/worlds.mjs` schema) → baked into the blob at join beside `foundedAbsWeek`. Engine: `calendarYear` / `yearLabel` / `shortYearLabel` + era-aware `formatGameDate` (`simulation.js`), era-aware history labels (`reducer.mjs`, `calendar.mjs` + rebase). UI: WeeklyDebrief, News, Finance charts + hedge expiry, SaveLoadModal, web world list/header, admin create-form era picker (`ERA_PRESETS`).
- **Phase 1 — production windows.** `oop` on 118 types (real line-closure years; in-production types carry none). `aircraftAvailability` + `eraDeliveredAgeWeeks` (anchored interpolation, 2026 reproduces all 164 published values exactly; freighter conversion lines exempt; band-0 types age only past 2026). `orderDenial` in the reducer, enforced in `ORDER_AIRCRAFT`; all 4 `ageWeeks` stamp sites era-aware; `lessorSupplies(type, calYear)` (era = "in service", guarded ≥1900 because it's used as a bare filter callback — the array INDEX arrived as calYear and emptied the lease market until guarded). Marketplace era locks (future types visible ≤3y out, locked with "Enters service YYYY"), era filters in RouteFinder/CargoRouteFinder/CargoRoutePlanner/RoutePlanner.
- **Phase 2 — the era economy.** `packages/engine/src/data/era.js`: demand/fare/fuel anchors + `eraDemandGrowthFactor`. **The factor is the ABSOLUTE index (1950 = 0.054×), not a ratio-from-start** — the classic base pool is already ~2026-scale, so level-scaling is what makes 1950 small; this also collapses the §3.3 27×-cap fear to a [0.054, 1.48] absolute band. `setEraStartYear` module state in `market.js`; `pairDemandGrowth` replaced in era worlds. Derived fareIndex at the reducer entry (composes × NWR) and in `humanRivals.priced()`. `tickFuelPrice`/`clampFuelIndex` take mean/min params; solo walk era-aware; `worldFuelIndex`/`worldEconomyAt` era-aware + memoised; tickService/worldService pass startYear. **γ_yield retuned 0.31 → 0.20 during calibration** (1950 fare 1.55, not 1.79) — at 1.79 the propliners printed money.
- **Tests:** `tools/era-calendar-test.mjs` (7), `tools/era-availability-test.mjs` (12), `tools/era-balance-test.mjs` (6 — pool plausibility bands, flagship profitability, RoC premium ceiling 8×, fare-clamp fit, fuel century). Suite: 147/148 pass (the 1 failure is `adsense-readiness-test` hitting the desktop bridge's no-delete sandbox — passes in a real terminal). `PARITY OK` throughout.
- **Verified end-to-end:** `seedAirlineState` on a 1950 world → blob carries `startYear`, join-time fuel 0.43. All 10 edited JSX files parse (@babel/parser).

- **Phase 3 — anti-degeneration (on disk, uncommitted).** Era money scales in `era.js` (`eraRevenueScale` = demand×fare, `eraPaxScale`, `eraCapitalScale` = √revenue floored 0.25 — sqrt because capital buys constant-dollar aircraft). Objectives: thresholds via `snap.M`/`snap.P` scalers built at the reducer's objective pass, era-adjusted descriptions via `objectiveDesc` + `descTemplate`/`money`/`pax` template metadata, rewards × capitalScale at payout, BoardObjectives mirrors all three. Starting capital × capitalScale at seed (`worldService`; the tickConfig knob stays modern-equivalent, mid-era joiners scale to the CURRENT year: 1950 → $4.34M, 1978 → $9.28M). Cost floors via module-scoped `setEraCostScale` in `overhead.js` (same pattern as `_fareIndex`), set at the reducer entry: HQ base both paths, marketing-effectiveness floor, campaign cost/metro-M, route launch cost, liability insurance. **Airframe market lifetime**: `AIRFRAME_MARKET_LIFETIME_YEARS = 30` — a line 30y+ closed is `'expired'`: not orderable (`orderDenial` `no_airworthy_frames`), not leasable, hidden in Marketplace/planners (`aircraftOrderable`); owned frames keep flying. Sub-80-seat $/seat vintage floors added to the consistency test. **Yearly rollup**: `state.statsHistoryYearly` (era-gated, cap 150, one row per completed year with calendar label) + "Era history · full years" card on Finance ▸ Statistics.
- Phase-3 tests: `tools/era-progression-test.mjs` (6) + expired-line coverage in era-availability (now 13) + small-type floors in aircraft-consistency. Suite 148/149 (the 1 failure is the sandbox-only adsense generator), `PARITY OK` throughout.

- **Phase 4 — the propliner catalogue (on disk, uncommitted).** 22 pre-1960 types appended to `aircraft.js` (§7's table, Viscount 700 at its corrected 1959 oop): pistons and first turboprops as category 'Turboprop' with per-type `cruiseKmh` overrides (350–640 km/h — the DC-3's precedent; the engine honours the override for any category), first jets (Comet 1/4, Tu-104, 707-120, DC-8-30) as 'Narrow Body'. The era lives in the cost data: radial maintenance at 0.4–0.6% of hull/week vs ~0.2% modern, flight-engineer crew costs, honest per-seat fuel (pistons ~2.1–3.0 L/seat/100km, early jets ~5–9.5 — the Comet 1's 9.5 is the point). All banded 832w, all clearing the $/seat floors, Stratocruiser `doubleDeck: true` (NWR test set updated). 13 new FAMILY_INFO entries derived by the table's own interpolation rules; `b707120`→`boeing_707`, `dc830`→`mcd_dc8`. Images via Commons `Special:FilePath` redirects (sourced from Commons' search index — worth an eyeball in the market UI). **Era progression: 1950 fields 5 types, 1955 11, 1958 20, 1962 32, 1978 52.**
- **AI competitors now shop the 2026 market** (`demand.js` picker filters `aircraftAvailability(t, 2026) !== 'expired'`) — without it, classic solo worlds seeded AI airlines on DC-6Bs. Deliberate behaviour change; **golden master re-baselined** (competitor sampling shifts: count 20→18 in the fixture).
- Balance test decades now fly the propliners (1950 DC-4, 1955 DC-6B, 1958 Viscount 800) — profitability and the 8× RoC ceiling hold. Suite 148/149 (sandbox-only adsense failure), era tests 32/32.
- NOTE for deploy: the generated aircraft guide pages (`headwinds-public.mjs`) need regenerating on a real machine — the sandbox can't (EPERM unlink).

- **Phase 5 — anachronism gates + the Comet grounding (on disk, uncommitted).** NEW `data/eraFeatures.js`: wifi 2004, ancillaries 2008, codeshares 1990, globalAlliances 1997, lounges 1985, gateAuctions 1990 — enforced by `eraFeatureDenial`/`refuseEraFeature` in the reducer (JOIN_ALLIANCE, SIGN_CODESHARE, SET_ANCILLARIES, INSTALL_WIFI, BUILD_LOUNGE all refuse with a "🕰 Not in this era yet" toast), mirrored in the UI (Alliances join, codeshare sign, Ancillaries CTA, Fleet Wi-Fi badge hidden pre-2004, AirportDetail lounge button), and server-side (`gateService.openDueAuctions` returns early pre-1990 — congested airports simply stay congested). Events: `fromYear` on tech_outage (1995), pandemic_scare (1990), mega_conference (1980), filtered in `rollEvents` via opts.calendarYear from both tickPrep (solo) and tickService (MP).
- **The Comet 1 grounding is real.** Entering calendar week 15 of 1954 holding Comet 1s: the fleet is withdrawn permanently (RETIRE mechanics — covers settled, routes released), hull insurance pays 80% of purchase on owned frames, a 15-second toast tells the story, `state.cometGrounded` one-shots it, and `withdrawnYear: 1955` on the type means the used market never reappears (new `withdrawnYear` clause in `aircraftAvailability`). Implemented as a pre-tick transform that recurses into ADVANCE_WEEK — which required letting era worlds CARRY pre-tick pendingToasts through the tick (the return replaces the array; classic keeps replace-semantics byte-identical).
- Phase-5 tests: `tools/era-features-test.mjs` (6). Era suite 38 tests; full suite 149/150 (sandbox-only adsense failure); `PARITY OK` — no golden change this phase.

- **Phase 6 — the Tailwinds port (built in the Tailwinds repo 2026-08-31).** Same data layer copied/adapted into TW's flat `src/` (era.js, eraFeatures.js verbatim; `oop` on 118 types + the 22 propliners + availability API in aircraft.js; families, events `fromYear`+`rollEvents(active, opts)`, fuel mean/min params, tickPrep, overhead `setEraCostScale`, simulation calendar helpers, market `setFareIndex`/`setEraStartYear`/**`setEraCalendarYear`** (TW-only: the AI aircraft picker reads it — `pickCompetitorAircraftType` filters `aircraftOrderable(t, eraYear)` in era games, `!== 'expired'` @2026 in classic), objectives M/P + `objectiveDesc`). Reducer (`src/store/GameContext.jsx`): `setEraModuleState()` at the entry of every action; `START_GAME` takes `startYear` (validated 1900–2100), sets the module state BEFORE `freshState()` so the competitor sample is era-appropriate (1950 rivals fly Stratocruisers), and scales the seed cash × capitalScale (1950 → $4.3M); `orderDenial` gates ORDER **and LEASE and BUY** (TW's UI dispatches all three — HW only gates ORDER, worth backporting); 3 ageWeeks stamps era-aware; 6 feature gates (incl. TW's per-product `SET_ANCILLARY`); ADVANCE_WEEK: Comet pre-tick transform, era fuel walk, toast carry, era history labels, yearly rollup, objective scaling. SetupScreen: Era picker card grid (Classic / 1950 Piston age / 1958 Dawn of the jets / 1970 Jumbo / 1978 Deregulation / 2000 Modern / Custom year 1930–2100) on the Launch step. UI ports: Marketplace (era filter + locks on table AND grid, era-correct delivered-age note), 4 planners, News, WeeklyDebrief, Finance (label trick, hedge expiry, Era history card), SaveLoadModal, BoardObjectives, Alliances, Ancillaries, Fleet, AirportDetail. Tests: `tools/era-{calendar,availability,balance,features,progression,ui}-test.mjs` (5 node:test suites + 1 SSR smoke: setup picker, marketplace locks 1950/1959/classic, scaled objective copy, ancillaries gate); small-type floors in aircraft-consistency. Full TW suite 107/107. Devlog entry + sitemap bump; aircraft guide pages regenerated (`generate-aircraft-pages.mjs`).
- No golden master in TW; parity is by construction (every era branch keyed on `startYear != null`) and by the classic assertions in each era test.

- **Post-ship playtest 2026-08-31 (headless bot, TW).** Found and fixed in BOTH repos: (1) TW era games opened at fuel index 1.0 instead of the decade mean — START_GAME now seeds `fuelPrice.index = eraFuelMean(startYear)` (HW already did this at join); (2) **fixed overheads were unscaled** — gate rents (~$20K/gate/wk), wages, family MRO contracts and hub investment ran at modern-dollar levels, so a 1950 Constellation earning $150K/wk faced $150K+/wk of overhead before flying and the bot went bankrupt inside a year. Now scaled through the same `getEraCostScale()` knob at source (`gateMonthlyFee`/`totalGateMonthlyFee`, `weeklyFamilyBaseCost`) and at the tick (labor, hub investment), mirrored in Operations/HubManagement displays. Golden PARITY OK (scale is 1 in classic). After the fix the bot's first-year return: 1950 ≈ +190% on $4.3M, 1978 ≈ +130% on $9.3M, classic ≈ +110% on $15M — the early-era premium is real and now on the generous side; if playtesting agrees, soften by scaling overheads with capitalScale^0.75 rather than capitalScale. HW: LEASE_AIRCRAFT/BUY_AIRCRAFT now carry the `orderDenial` gate like TW. **Dave's call (superseded for HW, see next): seed capital floored to a whole million** — NEW `eraSeedCapital(modern, calYear)` in era.js (both repos; HW `seedAirlineState`, TW `START_GAME`): 1950 opens on $4.0M (was $4.34M), 1978 on $9M (was $9.28M). **HW 1950 capital sweep (NWR + crew pipeline, no rivals, JFK):** seed $1M/$2M/$3M/$4M all reach ~$10–13M by end-1951 — a leased CV-240 costs $4.9K/wk and earns ~$80K/wk on a monopoly trunk, so seed capital barely bites; the market is what caps growth (fleet plateaus at ~6 tails / 6 routes on JFK's 1950 demand). Overheads therefore now run at NEW `eraOverheadScale` = √capitalScale (1950: 0.54, not 0.29) — year-one profit on $4M fell from +$5.6M to +$3.3M. Real worlds split that demand between humans, which is the real difficulty. **Dave's second call: in HW the admin knob is the LITERAL founding amount** — NEW `eraJoinCapital(knob, startYear, calYear)`: founders get exactly the knob ($4M typed = $4M in 1950); later joiners are scaled by capitalScale(now)/capitalScale(startYear) rounded to $100K (a 1970 joiner to a $4M 1950 world gets ~$8M). `seedAirlineState` + `serializeWorld.seedCapital` use it; the create form now says "Airlines founded in 1950 start with exactly $4.0M … the modern $15.0M is worth about $4.0M in 1950". TW (no knob) keeps `eraSeedCapital` (modern $15M floored → $4M). Cost audit (Dave: "any other costs scale?"): landing fees, ground handling, crew layovers and passenger compensation now follow the overhead scale too (overhead.js, both repos); NOT scaled by design — fuel (indexed by the era script), leases/purchase/maintenance/per-flight crew (type data; the new-build lever), catering (a quality choice), distribution (% of revenue), loan interest and tax (rates). Remaining lever if still generous: era new-build pricing (catalogue prices for closed lines are used-frame prices; ×2.5–3 while the line is open would be historically right — a 1950 CV-240 was ~$6.5M in today's money, not $1.9M).
- Playtest observations NOT acted on: (a) the crew pipeline parks the OLDEST tail first when short-staffed (`unstaffedAircraftIds` sorts by crew scale then id) — leasing a second aircraft before its crew are trained grounds the one that is flying; both games, not era-specific. (b) In classic games the propliners are the cheapest lease per seat (Vanguard $912/seat-wk vs Q400 $1,328) — the AI shops the 2026 market but players can still lease them; consider limiting the classic Marketplace to `aircraftOrderable(t, 2026)`.

- **Era new-build pricing BUILT 2026-09-02 (both repos), plus the C-47 and honest delivered ages.** Discord (Ross, 2026-09-01): the first 1950 HW world showed in-production types as "16y used" (HW Marketplace read the frozen-2026 `deliveredAgeWeeks`; TW's port was already right) and asked for a C-47. NEW `eraPriceScale/eraPurchasePrice/eraWeeklyLease/setEraPriceYear` in aircraft.js: `ERA_NEW_BUILD_PREMIUM` 2.5× catalogue while a closed-by-2026 line is open, sliding to 1× over `ERA_PRICE_DECAY_YEARS` 12 after `oop`; lines still open in 2026 and `surplus` types (C-47, DC-4) untouched; calYear null → 1 (golden PARITY OK). Reducer sets the price year on every action (like the cost scale); applied at BUY/ORDER/LEASE-at-signing, SELL NAV, fleetNAVOf, Comet payout, `airframeNAV`/check/AOG costs (maintenance.js), collateral (credit.js), hull-insurance book value (overhead.js), depreciation (financeProjection), server fire-sale NAV, and every UI quote. **Found underneath it: `valueRemaining` normalised against the 2026 band, so a factory-new 1950 CV-240 (age 0 vs a 16y band) was worth 2.14× catalogue — buy-then-sell printed ~$2M per frame on the LIVE 1950 world.** Now normalises against `eraDeliveredAgeWeeks(type, priceYear)`. 1950 opening market: C-47 $1.15M/$2.9K, DC-4 $1.9M/$4.9K, DC-3 $3.0M/$8K, CV-240 $4.75M/$12.25K, L-749 $7.75M/$20K, Stratocruiser $13M/$33.75K against a $4M seed — leasing is now the opening move. Locked lease rates mean existing tails keep their terms. `tools/era-pricing-test.mjs` (10, both repos). NOT re-run: the 1950 capital sweep / RoC — do that next.

Still open (both repos): the RoC ceiling in era-balance-test is 8× — the era new-build pricing question (classic prices are used-frame prices) remains the lever to ratchet it down. HW's LEASE_AIRCRAFT/BUY_AIRCRAFT lack the `orderDenial` gate TW has (HW's UI only dispatches ORDER, so it's latent). TW's 1950 AI picker converges on the Stratocruiser for most trunk routes (seat-fit scoring with 5 types) — cosmetic. The RoC ceiling in era-balance-test is 8× — the era new-build pricing question (classic prices are used-frame prices) remains the lever to ratchet it down.

---

**Original proposal follows.**
**Scope:** a Headwinds world option and a Tailwinds new-game option.
**Revised 2026-08-27, twice.** A first review found four real errors and four omissions; a final pass against the revised text found one more mechanism gap (fareIndex is static — §3.3) and tightened the catalogue data. §11 records all of it — the corrections are load-bearing, not cosmetic.

**Decisions taken (Dave, 2026-08-27):**

1. **All money stays in constant 2026 dollars.** No inflation index, no period pricing. A 1955 DC-6B is priced at what a 60-seat piston airliner is *worth in modern money*, not at its 1955 sticker.
2. **The calendar drives aircraft, demand and fuel.** Not a full period simulation — regulatory eras, airport opening dates and scripted historical shocks are explicitly deferred.
3. **Build the missing pre-1960 catalogue** (~22 types) so 1950–1957 is genuinely playable, rather than starting the era at 1958.

---

## 1. The idea

A world is stamped with a real calendar year at creation. Week 1 of Year 1 is January 1950. The tick advances as it always has; the only difference is that the world knows what year it is, and three systems ask.

- **Aircraft** are orderable only between the year they entered service and the year the line closed — after that they are second-hand only, at an age that grows the further past the line's closure you are.
- **Demand** sits on a curve anchored to real world air-traffic history instead of compounding upward from an arbitrary Year 1.
- **Fuel** walks a scripted historical path — flat and cheap through the 1960s, the 1973 and 1979 shocks, the 1986–99 glut, the 2008 spike — and then, past 2026, reverts to the procedural random walk we already have. **History is written; the future is not.**

The pitch to a player: you found an airline in 1950 with a fleet of DC-3s, watch the Comet arrive and then watch it get grounded, bet the company on the 707 in 1958, survive 1973 with the wrong fleet, and end up flying whatever 2050 turns out to hold.

---

## 2. What already exists

More than expected. This is not a from-scratch feature.

| Thing we need | Already there? | Where |
|---|---|---|
| Entry-into-service year on every aircraft | **Yes — all 164 types**, freighters included | `packages/engine/src/data/aircraft.js` (`eis`, 1936 → 2030) |
| 100-year world length | **Yes** | `worldConfig.mjs:19` `LENGTH_YEARS = [10, 25, 50, 100, 200]`, max 300 |
| A world-level fare/yield knob | **Yes** | `state.fareIndex` → `setFareIndex()` `market.js:749`; NWR worlds already run at 0.95 |
| Per-world config that needs no DB migration | **Yes** | `tickConfig Json` on the World row; `crewPipeline` / `gateScarcity` / `demandMultiplier` are the templates |
| Absolute-week clock | **Yes** | `absoluteWeek(year, week)` in `fuel.js:231` |
| Deterministic, seeded world fuel walk | **Yes** | `worldEconomy.mjs:32` `worldFuelIndex(seed, weekIndex)` |
| Secular demand growth over time | **Yes** | `market.js:229` `pairDemandGrowth(o, d, absWeek)` |
| "Delivered already used" for old types | **Yes, but see §3.2** | `deliveredAgeWeeks` on 109 types |
| An era gate on the aircraft market | **No** | `Marketplace.jsx:704` filters on category, manufacturer and text search only |
| Anything that retires an old airframe | **No — see §6** | nothing. A frame can be flown forever |

The one place `eis` is read at runtime today is a *lease-availability message string* (`Marketplace.jsx:640-643`, `aircraft.js:3407 lessorSupplies`). Tailwinds doesn't read it at all — its own header says *"Inert to the engine — nothing reads it at runtime."*

### How thin each era actually is

| Start year | Types available | Pax / freight |
|---|---|---|
| 1950 | **1** | DC-3, and nothing else |
| 1958 | **2** | + F27 |
| 1970 | **18** | 17 pax, 1 freighter |
| 1978 | **32** | 31 pax, 1 freighter |
| 2000 | **101** | 87 pax, 14 freighters |

This table is why the phasing in §9 changed. 1978 is a fully-stocked era with **zero catalogue work** — and it carries deregulation, the second oil shock, the widebody build-out and the birth of the LCC. It is the cheapest possible way to find out whether era mode is any fun.

---

## 3. Core design

### 3.1 The calendar epoch — and the one invariant

**`state.year` stays a 1-based ordinal. It is never renumbered.**

This is the load-bearing decision. `absoluteWeek(year, week) = (year - 1) * 52 + week` is threaded through demand growth, delivery weeks, hedge expiry, lease expiry, hub `tierSince`, `statsHistory` and every history label. Renumbering `year` to 1950 would multiply every absolute week by ~39 and quietly corrupt all of it.

Instead, add one number:

```js
// worldConfig.mjs
export const ERA_START_YEARS = [1950, 1958, 1970, 1978, 2000];
export const MIN_START_YEAR = 1930;
export const MAX_START_YEAR = 2100;

// tickConfig.startYear = 1950   (absent / null = classic "Year N" world)
```

and one helper, in the engine, next to `formatGameDate`:

```js
export function calendarYear(state) {
  const s = state.startYear;
  return s == null ? null : s + (state.year - 1);
}
```

**The invariant: when `startYear == null`, every line of era code is dead.** `calendarYear()` returns null, every gate short-circuits, every curve returns 1.0. This is what makes the feature safe to ship — see §10 for the exact (and narrower than first claimed) form of the parity guarantee.

Display: `formatGameDate` becomes

```js
const cy = calendarYear(state);
return cy == null
  ? `Week ${weekInMonth} ${monthName} Year ${state.year}`
  : `Week ${weekInMonth} ${monthName} ${cy}`;
```

That single change covers the topbar, the mobile menu, save slots and the weekly debrief. The ~15 other year render sites (§10) each need the same two-line treatment, and they are the bulk of the phase-0 grind.

`startYear` reaches the airline blob the way every other world flag does: `worldService.mjs seedAirlineState` copies it out of `tickConfig` at join, exactly as `crewPipeline` and `worldDemandMult` do today. No Prisma migration.

### 3.2 Aircraft availability windows

Add one field to the catalogue: **`oop`** — the year the production line closed. `null` means still in production.

| Calendar year vs. type | State | Behaviour |
|---|---|---|
| `year < eis` | **Not yet flying** | Row is visible but locked, showing "Enters service 1958" — the tease is half the fun. Not orderable, new or used, leased or bought. |
| `eis ≤ year ≤ (oop ?? ∞)` | **In production** | Orderable new. `ageWeeks: 0`. Full order-book lead time. |
| `year > oop` | **Out of production** | Second-hand only. Arrives already used, at an age that grows the further past `oop` you are. Price discounted accordingly. |

> ### ⚠ The published bands and real `oop` dates contradict each other
>
> The first draft claimed `deliveredAgeWeeks` generalises cleanly into a function of the calendar. It doesn't, not without a decision first. The existing bands are keyed on **`eis` alone** (`tools/aircraft-consistency-test.mjs:778 expectedAgeBand`), and **93 non-freighter types with `eis ≤ 2004` all carry a band** — including types that were still rolling off the line well into the 2020s:
>
> | Type | eis | band says | real line closure |
> |---|---|---|---|
> | Boeing 777-300ER | 2004 | 312w (6y used) | ~2022 |
> | Airbus A330-200 | 1998 | 312w | ~2020 |
> | Dash 8 Q400 | 2000 | 312w | ~2022 |
> | Boeing 737-800 | 1998 | 312w | 2019 |
> | CRJ-900 | 2003 | 312w | 2020 |
>
> So the band is a *vintage proxy*, not "years since the line closed." Once real `oop` data lands, the two disagree for dozens of types. **Phase 1 has to pick one as authoritative**, and I'd pick the published band: keep it as the anchor at 2026 and interpolate,
>
> ```js
> function deliveredAgeWeeks(type, calYear) {
>   if (type.oop == null || calYear <= type.oop) return 0;
>   const bandAt2026 = PUBLISHED_BAND[type.id] ?? 0;
>   const span = Math.max(1, 2026 - type.oop);
>   return Math.min(832, Math.round(bandAt2026 * (calYear - type.oop) / span));
> }
> ```
>
> which reproduces today's 109 values exactly at 2026 and moves monotonically either side of it — **but only for types whose real `oop` is before 2026.** For anything still in production that carries a band today, the two models are simply inconsistent and the data has to be fixed by hand. Add a consistency assertion: *every type with `deliveredAgeWeeks > 0` must have `oop != null` and `oop < 2026`.* That test will fail on first run, and the failures are the work list.

**Two adjacent rules generalise for free:**

- **Lessor books.** `LESSOR_EIS_CUTOFF = 2000` (`aircraft.js:3378`) encodes "lessors carry mature types, not the newest thing." In era mode that becomes `eis ≤ calendarYear - 26`, and the 2000 constant is just its value at 2026. Same rule, one variable freed.
- **Used market.** `aircraftMarketService.mjs` needs no era logic at all — its inventory is entirely player-generated. In a 1950 world the second-hand market is whatever the other players have sold, which is correct and rather lovely.

**Enforcement must be in the reducer, not the UI.** `Marketplace.jsx:704` is the display filter, but `ORDER_AIRCRAFT` (`reducer.mjs:1335`) does not re-validate today. The era gate goes next to `leaseDenial` as `orderDenial(state, typeId)`, and the UI calls the same function for its message — one source of truth, the pattern `newWorldRestrictions` already uses.

Six other components render `AIRCRAFT_TYPES` and need the same filter: `RouteFinder`, `CargoRouteFinder`, `CargoRoutePlanner`, `TagRoutePlanner`, `RoutePlanner`, and `data/families.js` for MRO base certification.

### 3.3 The era economy

Constant 2026 dollars mean the era can't be expressed through prices. It has to be expressed through **traffic volume** and **real yield** — and the mechanism for the second one is not what the first draft said.

#### Yield rides `fareIndex`, and `fareIndex` is clamped to 2.0

The first draft said the yield curve "rides on the fare/reference-price path." That was wrong in a way that matters. `referencePrice()` (`market.js:911`) is the **elasticity anchor, the price ceiling and the default fare** — it is *not* what the player earns. Revenue comes from `state.routePricing[pairKey]`, the player's own number (`simulation.js:1829-1835`). Multiplying `referencePrice` by 3 would not triple yield; it would make the player's existing fare read as a 67% discount and send demand through the roof. The file warns about exactly this at `market.js:672-675`.

The correct hook already exists: **`state.fareIndex`**, set from world state on every action (`reducer.mjs:1229`), which scales the whole reference ladder — anchor, cap and defaults together — leaving elasticity untouched. New World Restrictions worlds already run at 0.95. That is precisely the lever the era needs.

**But `setFareIndex` clamps to `0.25 < v ≤ 2.0`** (`market.js:751`) and silently falls back to 1 outside it. A yield index of 3.07 would be swallowed without an error. Two consequences:

1. γ<sub>yield</sub> has to be tuned so the whole era fits inside the clamp — **1950 lands around 1.8, not 3.1**, which means γ<sub>yield</sub> ≈ 0.31, not 0.60.
2. The rest of the era's economic character has to live somewhere else — and it should live in **the aircraft cost data**, which is where it physically belongs. A DC-6B burns far more fuel per seat-km than a 737, carries five crew instead of two, cruises at 500 km/h instead of 850 (so it flies fewer block hours of revenue per week), and needs a hangar visit far more often. Put the period in `fuelBurnPer100km`, `crewCostPerKm`, `baseMaintenancePerWk` and `cruiseKmh`, not in a global multiplier.

**And one more mechanism gap, caught on the final pass: `fareIndex` is static today.** It is seeded into the airline blob once at join (`worldService.mjs:173`, whose own comment says "SEEDED AT JOIN: retuning a live world needs `tools/rebase-world-fare-index.mjs`") and nothing ever updates it. The era yield curve *declines across the century* — 1.79 in 1950 down to 1.00 by 2019 — so a seeded-once value is wrong within a decade. Era mode makes it **derived, not stored**: the reducer already sets the module-scoped index from state on every action (`reducer.mjs:1229`), so that one line becomes

```js
setFareIndex(state.startYear != null
  ? eraFareIndex(calendarYear(state))
  : (state?.fareIndex ?? 1));
```

and the ladder moves with the calendar automatically — no rebase tool, no stale blob value. The two out-of-reducer callers follow the same pattern: `humanRivals.mjs:785` already re-derives the index from the target world's rows before pricing rival views, and `restartService`'s `fareIndexOverride` simply becomes vestigial in era worlds (harmless — the derived value wins at the next action). An era world that is *also* NWR composes multiplicatively: `eraFareIndex(y) × (tc.fareIndex ?? 1)`.

The era **demand** curve needs the same treatment for the same reason: `pairDemandGrowth`'s ~12 call sites carry no world context, which is exactly why `_fareIndex` and `_nwrYieldChoke` are module-scoped setters fed from the reducer entry. Add a third — `setEraCurve(startYear)` — beside them rather than threading a parameter through the demand model.

And treat `fareIndex` with respect. The calibration note at `market.js:693` is blunt about how sharp this lever is: a fare cut multiplies the break-even load factor by 1/f, so 1.00 → 16.5% margin at full load, and 0.85 → 1.8%. Running it *up* is equally violent in the other direction.

| Year | RPK vs 2026 | **Demand idx** (γ=0.50) | Real yield vs 2026 | **fareIndex** (γ=0.31) | Revenue scale |
|---|---|---|---|---|---|
| 1950 | 0.0029 | 0.054 | 6.5× | 1.79 | 0.10 |
| 1960 | 0.011 | 0.105 | 4.5× | 1.59 | 0.17 |
| 1970 | 0.047 | 0.217 | 2.8× | 1.38 | 0.30 |
| 1980 | 0.111 | 0.333 | 2.2× | 1.28 | 0.43 |
| 1990 | 0.193 | 0.439 | 1.6× | 1.16 | 0.51 |
| 2000 | 0.310 | 0.557 | 1.3× | 1.08 | 0.60 |
| 2010 | 0.485 | 0.696 | 1.05× | 1.02 | 0.71 |
| 2019 | 0.888 | 0.942 | 1.00× | 1.00 | 0.94 |
| 2026 | 1.000 | 1.000 | 1.00× | 1.00 | 1.00 |
| 2050 | ~2.2 | 1.48 | ~0.85× | 0.95 | 1.41 |

Read the 1950 row: **5% of today's traffic, at fares 80% above the modern ladder.** A 60-seat DC-6B flying LGA–ORD twice a week fills up. A 737 MAX would fly at a 15% load factor, which is exactly the constraint that should make the era feel like the era.

**These are a starting hypothesis, not a result.** The deliverable is `tools/era-balance-test.mjs`. It must check two things per decade, not one:

- **Load factor** — fly the era's flagship type over a basket of reference pairs (LGA–ORD, LHR–CDG, LAX–HNL, LHR–JFK, SYD–MEL) at a historically plausible frequency; assert 60–85%.
- **Return on capital** — assert weekly profit per $ of airframe lands in the same band across every decade. This is the check that actually matters, and the first draft omitted it. Because both curves move together, per-aircraft revenue is roughly *conserved* across the era — a 60-seat aircraft at 1.8× fares earns about 60% of what a 180-seat aircraft earns at 1.0×, on a $6M airframe instead of a $100M one. **The risk is not that 1950 is too poor. It's that cheap old aircraft at modern-dollar prices are wildly too profitable** — which is the exact bug the consistency test's `$/seat` price floors were written to catch after a 1971 Trident started out-earning a 737 MAX by 6.5×.

#### The demand growth cap is the biggest unsolved problem

`pairDemandGrowth` is **replaced** in era worlds rather than layered on, or growth counts twice:

```js
eraDemandIndex(calYear) / eraDemandIndex(startYear)
```

Over 1950 → 2050 that ratio is **27×**. `DEMAND_GROWTH_CAP = 3.0` (`market.js:213`) exists precisely so "a decade-old world stays playable," and every balance assumption in the game — gate capacity, slot limits, aircraft sizing, market-share dynamics, the entire competitive model — is tuned for a span of 3× or less.

A 27× span is not just a raised ceiling, it is a different game. It means an incumbent who does nothing gets 27× larger, so week-one position compounds beyond any plausible catch-up, and it means the aircraft you need in 2040 are three size classes above the ones the world was balanced around. **This is a bigger open question than the γ calibration and it has no obviously right answer.** Three candidate resolutions, in the order I'd try them:

1. **Compress the span hard** — cap era demand growth at, say, 6× and accept that the century's traffic curve is a caricature. Least invasive, least honest.
2. **Ship era slices only** (§5). A 40-year slice at these numbers spans 4–8×, which is inside shouting distance of what the model already handles.
3. **Raise the cap and add a genuine catch-up mechanic** — this is a real balance project in its own right and should not ride along inside era mode.

I would ship (2) and treat the full century as an explicitly experimental world.

#### Fuel

`worldFuelIndex(seed, weekIndex)` is already a pure seeded function of the week, so a historical mean drops in without disturbing determinism or the join-time backfill (`worldEconomyAt`). Replace the constant `FUEL_BASE_INDEX = 1.00` that the OU process reverts to with `eraFuelMean(calendarYear)`:

| Era | Mean index | The story |
|---|---|---|
| 1950–1972 | 0.45 | Cheap and boringly flat. Fuel is not your problem. |
| 1973–1974 | → 0.95 | First oil shock. Doubles inside a year. |
| 1979–1981 | → 1.45 | Second shock. Widebody orders die. |
| 1982–1985 | 1.10 | Slow bleed down. |
| 1986–1999 | 0.55 | The glut. A decade and a half of cheap fuel. |
| 2000–2002 | 0.75 | Creeping back. |
| 2003–2008 | → 1.85 | The long climb to July 2008. |
| 2009 | 0.95 | Crash. |
| 2010–2014 | 1.35 | The expensive plateau. Fuel burn wins routes. |
| 2015–2019 | 0.70 | Shale. |
| 2020 | 0.45 | COVID. |
| 2021–2022 | → 1.50 | Snapback. |
| 2023–2026 | 1.00 | Where the classic model starts. |
| **2027+** | **procedural** | The existing OU walk, seeded from wherever 2026 left off. |

The weekly OU volatility (σ = 0.04) rides on top throughout, so no two worlds see the same 1973 — the shape is history, the texture is the world's own seed.

Two implementation notes:

- `FUEL_MIN_INDEX = 0.55` (`fuel.js:55`) sits above the 1950–72 and 2020 means. Era worlds need it around 0.35. Cheap to thread: `clampFuelIndex` has only **two live call sites** (`fuel.js:93` inside `tickFuelPrice`, and `tickPrep.js:129`, which already has world state in scope) plus a dead import at `reducer.mjs:96` that can just be deleted. An optional second parameter defaulting to `FUEL_MIN_INDEX` is source-compatible.
- `worldFuelIndex` is **O(weekIndex)** — it replays the entire walk from week 1 on every call, every tick. At week 5,200 that is 5,200 iterations per world per tick. Tolerable today because worlds are short; a century of era worlds makes it routine. Memoize per (seed, week) or store the running index on the World row.

### 3.4 Anachronism gates

The brief scoped this to aircraft, demand and fuel — but shipping without it makes the world look silly, and it's cheap. One table, one function, one-line guards at the call sites:

```js
// data/eraFeatures.js
export const FEATURE_FROM = {
  wifi:            2004,   // data/wifi.js — $750K per-airframe installs in 1950
  ancillaries:     2008,   // data/ancillaries.js — unbundling is post-GFC
  codeshares:      1990,   // data/alliances.js
  globalAlliances: 1997,   // Star Alliance
  loungeTiers:     1985,   // lounges themselves are fine from day one
  gateAuctions:    1990,   // airports.js GATE_AUCTION_OPEN_WEEK
};
export const featureLive = (f, calYear) =>
  calYear == null || calYear >= (FEATURE_FROM[f] ?? 0);
```

Also needs a pass: three event templates in `data/events.js` are anachronistic before the 2000s (`tech_outage` "Industry-Wide IT Outage", `pandemic_scare`, `mega_conference`), and `airportRestrictions.js:46` literally says *"Enacted in 1984"* in the player-facing copy for the LaGuardia perimeter rule — a restriction that simply should not exist before 1984, and now the world knows it.

---

## 4. What else has to scale with the era

The constant-dollar decision holds for **aircraft prices and per-flight economics**. It does not hold for the game's fixed-dollar progression furniture, all of which is calibrated against a 2026-scale airline. In 1950, industry revenue scale is ~0.10 and a typical aircraft has 60 seats instead of 180. These constants do not care:

**Objectives — nothing is scaled by anything.** `data/objectives.js` compares raw literals against snapshots; no world config reaches it (`initialObjectives(set)` takes only a set name).

- Solo board: 9 dollar thresholds — `revenue_500k` (weekly) through `market_cap_1b`, plus `net_worth_100m` and `annual_profit_25m`.
- Solo board: `pax_250k` — a quarter-million passengers **in a single week**, which in 1950 is roughly the entire scheduled traffic of a mid-sized country.
- MP starter board: `mp_pax_10k` / `mp_pax_100k` / `mp_pax_1m` lifetime passengers, plus fleet and route counts. At 5% demand these are ~20× harder; the board's own comment calibrates its $6.8M of rewards "vs $15M starting capital", so the on-ramp silently reweights too.

**Entry-cost constants that bite a small airline.** Most capex the player opts into (lounges $12M, MRO L3 $90M, hub tier 3 $100M) can stay — a 1950 airline simply doesn't buy them. The ones that bite unavoidably are the floors:

| Constant | Value | Where |
|---|---|---|
| Marketing weekly floor | `max(revenue × 0.04, 40_000)` | `overhead.js:671` |
| HQ base weekly | `40_000`, min `8_000` | `overhead.js:245,255` |
| Route launch cost | `40_000 + distKm × 22` | `overhead.js:784` |
| Liability insurance | `$6K–$24K/wk` by category | `overhead.js:352-360` |
| Starting capital | `15_000_000` (×3 places) | `reducer.mjs:1040`, `credit.js:30`, `worldConfig.mjs:35` |
| Market cap / share seed | `STARTING_CASH × 0.85` | `reducer.mjs:1109-1120` |

**Recommendation:** scale a *narrow, named* set by the era revenue index — starting capital, the marketing floor, route launch cost, the insurance minimums, and every objective threshold. Leave aircraft prices, fares and opt-in capex alone. This is a deliberate and limited re-opening of the money question, and it should be stated as such rather than smuggled in: **decision 1 said prices stay in 2026 dollars; it did not say the game's on-ramp does.**

**Cargo needs its own curve.** Air freight grew even faster than passenger traffic from an even smaller base. Cargo is already flagged in the audit notes as an uncontested dominant strategy; feeding it an unscaled 2026 demand pool inside a 1950 world would make it strictly dominant. One era index per side.

---

## 5. World configuration and pacing

New admin fields on the create-world form (`apps/headwinds-web/src/App.jsx:336-446` is the pattern):

- **Start year** — presets 1950 / 1958 / 1970 / 1978 / 2000, plus custom.
- **Length** — already exists. 1950 → 2050 is `lengthYears: 100`, inside the current 300 cap.

The pacing problem is real:

| Pace | 100 years (1950→2050) | 40 years (1978→2018) | 25 years |
|---|---|---|---|
| 48 wk/day (1 wk / 30 min) | **108 real days** | 43 days | 27 days |
| 96 wk/day (1 wk / 15 min) | **54 real days** | 22 days | 14 days |

96 is the current `MAX_WEEKS_PER_DAY`. **The full 1950→2050 world is a two-month commitment at the fastest pace we allow.** And raising the ceiling further has a limit that isn't technical: at 168 weeks/day a player gets 8½ minutes of real time per game week, which for a game built around weekly decisions is hostile. The structural tension — a century of content against human attention — resolves in favour of **era slices as the product** and the full century as a one-off marquee world:

- **Deregulation** 1978–2018 · 32 types on day one, no catalogue work
- **Jet Age** 1958–1998
- **Propliner** 1950–1990

Each is ~3 weeks at the current top pace, and each spans a demand ratio the balance model can actually survive.

---

## 6. Nothing ever retires, and that gets worse over a century

There is no scrap value, no life limit, no cycle limit, no forced retirement, no airworthiness expiry anywhere in the engine. An airframe ages by `ageWeeks += 1` forever with no threshold consequence. In a 25-year world that's fine. Across a hundred years it compounds into an exploit:

- **Delivered age is capped at 832 weeks / 16 years** regardless of vintage. A type 60 years out of production arrives at exactly the same age as one 16 years out.
- **The quality age penalty is already zero at 13 years** (`simulation.js:679` `agePts = max(0, 20 - fleetAgeYears × 1.5)`). A frame delivered at 16y scores 0 from week one and can never get worse.
- **Depreciation deliberately cancels the delivered-age discount** (`overhead.js:337` `valueRemaining` divides by `base`), and floors at 10% of value. That was the right call for a 12-year-old 747F; over a century it means NAV never goes away.
- **The only growing cost is `maintenanceMultiplier`** — and heavy checks buy back `maintAgeCredit` against it.
- **The price floors that guard against this only apply to types with ≥80 seats** (`aircraft-consistency-test.mjs:825`). Most propliners are under 80 seats. **They are entirely unguarded.**

So in a 2040 era world, nothing stops a player buying DC-3s and Convair 240s at propliner prices and flying them profitably forever. This is the "1971 Trident printing money" bug the consistency test was written to kill, resurrected with a longer runway.

**Era mode needs an airframe life limit** — an airworthiness expiry keyed on total age, forcing retirement or an expensive life-extension, plus extending the `$/seat` price floors below 80 seats. This is not optional polish; it is the thing that stops the mode degenerating in its second half.

---

## 7. The catalogue gap

Today the pre-1965 roster is: DC-3 (1936), F27 (1958), Caravelle (1959), L-188 Electra (1959), An-12 (1959), Convair 580 (1960), 720B (1961), 707-320B (1962), An-24 (1962), CV-990 (1962), VC10 (1964).

**A 1950 world currently has exactly one flyable aircraft.** Proposed additions (~22 types), priced in constant 2026 dollars by their economics, not their sticker:

| Type | eis | oop | Seats | Range km | Note |
|---|---|---|---|---|---|
| Douglas DC-4 | 1946 | 1947 | 44 | 4,000 | The war-surplus workhorse. Cheap, slow, unpressurised. |
| Lockheed L-749 Constellation | 1947 | 1951 | 62 | 4,690 | |
| Convair CV-240 | 1948 | 1954 | 40 | 1,930 | |
| Boeing 377 Stratocruiser | 1949 | 1950 | 100 | 6,760 | `doubleDeck: true` — lower deck was a lounge. Luxurious, unreliable, ruinous. |
| Douglas DC-6B | 1951 | 1958 | 68 | 4,835 | The one that actually made money. |
| Martin 4-0-4 | 1951 | 1953 | 40 | 1,738 | |
| de Havilland Comet 1 | 1952 | 1954 | 44 | 2,410 | **The first jet.** Short window by design — see below. |
| Vickers Viscount 700 | 1953 | 1959 | 53 | 2,830 | First turboprop airliner. Quiet, fast, transformative. |
| Ilyushin Il-14 | 1954 | 1958 | 32 | 1,500 | |
| Lockheed L-1049G Super Constellation | 1955 | 1958 | 95 | 5,840 | |
| Convair CV-440 Metropolitan | 1956 | 1958 | 52 | 2,100 | |
| Douglas DC-7C Seven Seas | 1956 | 1958 | 105 | 7,410 | First reliably nonstop transatlantic piston. |
| Tupolev Tu-104 | 1956 | 1960 | 100 | 2,650 | Second jet airliner in service, and it shows. |
| Bristol Britannia 310 | 1957 | 1960 | 139 | 7,100 | "Whispering Giant" — arrived two years too late. |
| Lockheed L-1649A Starliner | 1957 | 1958 | 92 | 9,000 | The last and best piston. Obsolete on delivery. |
| Vickers Viscount 800 | 1957 | 1964 | 75 | 2,780 | |
| Boeing 707-120 | 1958 | 1963 | 174 | 5,600 | **The one that changes everything.** |
| de Havilland Comet 4 | 1958 | 1964 | 81 | 5,190 | |
| Ilyushin Il-18 | 1959 | 1978 | 110 | 6,500 | |
| Douglas DC-8-30 | 1960 | 1967 | 177 | 8,300 | |
| Vickers Vanguard | 1961 | 1964 | 139 | 2,945 | |
| Hawker Siddeley 748 | 1962 | 1988 | 48 | 1,700 | |

The `eis` / `oop` / seat / range values above are a first pass from memory and must be verified against references during the catalogue phase — the Viscount 700's line closure already moved once (1964 → 1959; the 800/810 series is what ran to 1964).

Plus **`oop` backfilled onto the existing 164** — a single year per row, `null` for anything still in production. Roughly 110 rows need a real value, and per §3.2 that backfill will surface real contradictions with the published bands.

Implementation requirements for every new type, both hard-enforced by existing tests:

- A **`FAMILY_INFO` entry in `data/families.js`**, or the type pays $0 MRO base cost and is invisible to jet-base certification (`families.js:12-24`).
- Clearing the vintage `$/seat` price floors and the 20-year delivered-age cap in `tools/aircraft-consistency-test.mjs`.

Cost data is where the period actually lives (§3.3) — the propliners must carry honest `fuelBurnPer100km` per seat, five-crew `crewCostPerKm`, heavy `baseMaintenancePerWk` and low `cruiseKmh`. If they don't, the era's economics collapse into "cheap aircraft, modern revenue."

**One historical beat worth building deliberately:** the Comet 1's window is 1952–1954. If a player has Comet 1s in the fleet when 1954 arrives, ground the type — a scripted, newsworthy, once-per-timeline event. It costs almost nothing and it is the single most memorable thing this mode could do. Pair it with an insurance payout rather than a seizure so it reads as history rather than as punishment. Flagging it as the template for scripted historical events later, not as v1 scope.

---

## 8. A century you can't see

`STATS_HISTORY_CAP_MP = 260` weeks — **5 game years** (`reducer.mjs:120-130`). The cap exists for a good reason: the series lives inside every airline's state blob, which is re-read on polls and re-read-and-rewritten every tick, so an unbounded series feeds straight into the Supabase egress and disk-IO problem.

But it is applied at **write** time (`reducer.mjs:4868`), so the data is discarded, not hidden. In a 100-year world:

- The Statistics page shows the last five years, full stop. Its 10 / 20 / 30-year period buttons never render, because `Finance.jsx:3025` stops adding buttons once the period exceeds the series length. "All" *is* five years.
- Ninety-five years of the world's history are permanently gone.

For a mode whose entire selling point is the sweep of a century, that is a product hole, not a nice-to-have. The fix is a **second, downsampled series** — one row per game year, ~100 rows for a century, a rounding error against the blob — written alongside the weekly one and read by the long period filters. Solo (`STATS_HISTORY_CAP = 1820`, 35 years) has the same problem more mildly.

---

## 9. Phases — reordered

The first draft built the catalogue before the economy. That is backwards: the catalogue is the grind and the economy is the risk, and **the economy can be fully validated with today's 164 types by starting a world in 1978.**

| Phase | What | Ships? | Rough size |
|---|---|---|---|
| **0** | `startYear` in tickConfig → blob → UI. `calendarYear()`. All ~15 year-render sites. **No gameplay change whatsoever.** | Internal | 1 session |
| **1** | `oop` on all 164 types + the band reconciliation (§3.2). `orderDenial()` in the reducer, era filter in Marketplace + the 5 planner components. Generalised delivered age, generalised lessor cutoff. | Playable from 1970 | 1–2 sessions |
| **2** | Era demand + `fareIndex` curves. `tools/era-balance-test.mjs` with **both** the load-factor and return-on-capital checks, and the γ tuning pass. Historical fuel curve, widened clamp, memoised walk. Resolve the demand-cap question. | **A 1978 world is real and playable** | 2–3 sessions |
| **3** | Era scaling for objectives, starting capital and the cost floors (§4). Airframe life limit + price floors below 80 seats (§6). Yearly stats rollup (§8). | Doesn't degenerate late | 1–2 sessions |
| **4** | ~22 pre-1960 types with honest period cost data, `FAMILY_INFO` entries, balance against the consistency test. | Playable from 1950 | 1–2 sessions |
| **5** | Anachronism gates (`eraFeatures.js`), event-template review, LaGuardia perimeter copy. | Ship-quality | ½ session |
| **6** | Tailwinds port + setup screen + AI competitor era-gating + save migration. | Solo mode | 2 sessions |

**Ship phases 0–2 and put a 1978 world in front of players before writing a single propliner.** If the era economy isn't fun with 32 aircraft and the second oil shock, twenty-two Constellations won't save it.

**Later, if it lands:** regulatory eras (bilaterals → 1978 US dereg → 1997 EU single market → open skies), airport opening years (~80 of the 500 postdate 1950 — DEN 1995, ICN 2001, HKG 1998, CDG 1974, IAD 1962), scripted historical events beyond the fuel curve, period runway lengths, era-appropriate country codes.

---

## 10. Testing, and a correction to the parity claim

The first draft asserted "the acceptance test for phases 0–4 is `PARITY OK`." **That is wrong for the catalogue phase**, and the reason is worth knowing.

`tools/golden-master/harness.mjs` runs `START_GAME` → lease an A320 → add a gate → add JFK–LAX → 60× `ADVANCE_WEEK`, and hashes the entire final state. `START_GAME` calls `freshState()`, which calls `sampleAndInitializeCompetitors(25)` (`reducer.mjs:1098`) → `buildCompetitorFleet` → `pickCompetitorAircraftType` (`demand.js:2166`), which **iterates the whole of `AIRCRAFT_TYPES`** and picks by seat/range score. Adding 22 types changes at least one competitor's fleet, which changes capacity, share, revenue and therefore the hash.

So the honest statement:

- **Phases 0, 1, 2, 3, 5 must print `PARITY OK`** — that is the invariant, and a break means era code leaked into a classic world.
- **Phase 4 legitimately re-baselines.** Any catalogue addition does. Re-run with `--update` and say so in the commit, per `CLAUDE.md:27`.

Worth knowing separately: **the golden-master baseline is a bankruptcy.** `golden.json` records `phase: "bankrupt"`, `week 9 / year 2`, cash −$40.3M, because the harness's `ADD_ROUTE` passes no `ticketPrice` and `reducer.mjs:2288` floors it at **$1 fares**. It is a real fingerprint and it does catch changes, but it exercises a degenerate corner of the model and it will trip on almost anything. Independent of era mode, it is worth re-authoring the fixture to fly a solvent airline.

New tests:

- `tools/era-availability-test.mjs` — a type is orderable iff `eis ≤ year ≤ oop`; used-only past `oop`; delivered age at 2026 reproduces the existing 109 published bands exactly; `oop ≥ eis` for every row; **every type with `deliveredAgeWeeks > 0` has `oop != null && oop < 2026`** (this one fails on first run — the failures are the §3.2 work list).
- `tools/era-balance-test.mjs` — load factor *and* return on capital, per decade.
- `tools/era-parity-test.mjs` — for a fixed seed, a `startYear: null` world and today's engine produce byte-identical state after 52 ticks.

Per `CLAUDE.md`, each new engine behaviour ships with a test verified failing on HEAD first.

Year-render sites to convert in phase 0 (`formatGameDate` covers the first four):

`src/App.jsx:553, 641, 843` · `WeeklyDebrief.jsx:139` · `News.jsx:246, 421, 440` · `Finance.jsx:2971, 2983, 3935` · `SaveLoadModal.jsx:71` · `BoardObjectives.jsx:10, 85, 86` · `apps/headwinds-web/src/App.jsx:642, 908` · `reducer.mjs:4570` · `calendar.mjs:45` · `worldConfig.mjs:172 worldProgress()`

---

## 11. What the review changed

Four errors and four omissions in the first draft, worth recording because they're the kind that would have surfaced mid-build:

**Errors**

1. **The yield curve had the wrong mechanism.** It said the curve rides `referencePrice`. `referencePrice` is the elasticity anchor and price cap, not earned revenue — tripling it would have spiked demand rather than yield. The correct hook is `state.fareIndex`, which already exists. *And* it is clamped to ≤ 2.0, so γ<sub>yield</sub> drops from 0.60 to ~0.31 and the era's economics move into the aircraft cost data, where they belong. (§3.3)
2. **The parity claim was too broad.** Phase 4 (the catalogue) legitimately breaks the golden master, because competitor fleet selection iterates `AIRCRAFT_TYPES`. (§10)
3. **The delivered-age generalisation doesn't hold on the existing data.** 93 types are banded by `eis` regardless of whether the line was still open in 2022. Real `oop` data contradicts them and phase 1 has to reconcile. (§3.2)
4. **Table precision.** Demand indices are 0.054 / 0.105, not 0.05 / 0.11.

**Omissions**

5. **`DEMAND_GROWTH_CAP = 3.0` against a 27× era span** — the largest unresolved balance question in the plan, and the strongest argument for era slices over the full century. (§3.3)
6. **Nothing retires an airframe**, and every age penalty is already saturated by year 16. Over a century that is an exploit, and the price floors that guard it don't cover aircraft under 80 seats — i.e. most propliners. (§6)
7. **Objectives and the cost floors are unscaled** — nine dollar thresholds, a 250,000-passengers-in-one-week objective, a $40K/wk marketing floor. Needs a narrow, named set of era-scaled constants. (§4)
8. **A century of history is discarded at write time** by the 260-week MP stats cap, so the Statistics page can only ever show five of a hundred years. (§8)

Also folded in: the `clampFuelIndex` threading is cheaper than feared (2 live call sites), `worldFuelIndex` is O(week) and wants memoising, cargo needs its own era index, every new type needs a `FAMILY_INFO` entry, and the Viscount 700 is a 53-seater not a 65-seater.

**Final pass (rev 3)**

9. **`fareIndex` is seeded once and never updated** — the era yield curve declines over time, so it must become *derived* from `calendarYear` at the reducer's existing choke point, with the two out-of-reducer callers following suit and NWR composing multiplicatively. (§3.3)
10. **The era demand curve needs a module-scoped setter** (`setEraCurve`), the same pattern as `_fareIndex` / `_nwrYieldChoke`, because `pairDemandGrowth`'s call sites carry no world context. (§3.3)
11. Catalogue dates flagged as first-pass; Viscount 700 `oop` corrected 1964 → 1959. (§7)

---

## 12. Deliberately not in v1

Inflation and period pricing · regulatory eras and bilaterals · airport opening dates · period runway lengths · scripted historical shocks beyond the fuel curve · period-correct country codes and airport names · era-specific liveries · piston-era route structure, which needs no work at all — fuel stops at Gander and Shannon fall straight out of the range limits, which is a rather nice accident.
