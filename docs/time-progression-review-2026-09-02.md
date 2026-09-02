# Time-progression review — Headwinds, 2026-09-02

Scope: the world clock (tickService / worldConfig / calendar.mjs), the era
calendar (engine simulation.js `calendarYear`, data/era.js), the shared
economy walks (worldEconomy.mjs), aircraft availability windows, the Comet
grounding, year rollover bookkeeping, and how the web client adopts all of
it. Every era test in `tools/` passes on the working tree (era-calendar 7,
era-availability 14, era-progression 6, era-features 6, era-balance 6,
world-calendar 13, world-economy 8, headwinds-tick 11). The findings below
were reproduced with throwaway probes in `tools/_probe/_*_probe.mjs`.

## What is right

- One clock per world: the tick derives the schedule from `startedAt`, the
  CAS on `currentWeek/currentYear` makes catch-up idempotent, and every
  airline is rebased onto the world clock at join (`rebaseStateCalendar`
  shifts every absolute-week field; the seed probe finds nothing left behind).
- `calendarYear(state)` is the single translation point; `state.year` stays
  ordinal everywhere, so `absoluteWeek()` fields never see a real year.
- The reducer flies `state.week` and then increments; the tick passes
  `fromIndex` for fuel, events and the Comet check — the same convention, so
  there is no off-by-one between the server's economy and the blob's week.
- Fuel/market walks are replayed from the seed, memoised, and the join-time
  backfill uses the same `eraWeekParams`, so late joiners land on the same
  economy.

## Status (2026-09-02, later the same day)

Findings 1–3 are FIXED on disk, uncommitted:
- 1 → `src/store/GameContext.jsx`: `effectiveFareIndex()` + `syncEngineWorldState()`
  (fare index composed with the era curve, era start year, era cost scale, NWR
  choke), called synchronously in both providers and from their effects (deps
  now include `startYear` and `year`). Test: `tools/era-client-sync-test.mjs`
  (7 checks; HEAD fails 5 of them).
- 2 → `packages/engine/src/reducer.mjs`: `cometWithdrawn(state, typeId)`
  (calendar-derived: 1954 W15 onward) feeds `orderDenial`; `applyCometGrounding`
  cancels pending Comet orders and refunds price / deposit in full. The
  Marketplace lock + list and the four planners consult it. Test added to
  `tools/era-features-test.mjs`.
- 3 → `apps/headwinds-server/src/lib/worldEconomy.mjs`: `fuelWalkSeed(startYear)`
  seeds the memo, the backfill and the no-tick index at `eraFuelMean(startYear)`.
  Test added to `tools/world-economy-test.mjs`.
Later the same day, 4–6 also FIXED on disk:
- 4 → `calendarYearFrac(state)` in `utils/simulation.js` (startYear + (year−1) +
  (week−1)/52). The CONTINUOUS curves read it: reducer entry (fare, overhead
  scale), solo fuel mean, `humanRivals` fare ladder, the client sync helper
  (effects now also keyed on `week`), `eraDemandGrowthFactor` and the server
  fuel-mean walk (`eraWeekParams`). The DISCRETE gates (eis/oop, features,
  events, Comet, objectives, era price year) still read the integer
  `calendarYear`. Worst weekly demand step across the century is now <0.4%
  (was +10.7% on 1961 W1). Tests in `era-calendar-test.mjs`.
- 5 → `tickService.completeIndex(world) = totalWeeks + 1`: the final tick flies
  week 52 of the last year and parks the clock on year L+1 week 1, which is
  exactly `endsAt`; the year-in-review and auction-resolve hooks skip that tick
  (`!ended`), the engine's yearly rollup fires for the last year.
  `worldProgress` reports weeks FLOWN and clamps a finished world to
  "year L week 52, 100%". Test in `headwinds-tick-test.mjs`. NOTE: any RUNNING
  world gets one extra tick at the end — a classic world near its finish will
  end one interval later than before.
- 6 → `eraDeliveredAgeWeeks`: a band-less line closed before 2005 (only the
  Concorde) ages on the 832w band in era years before 2026; classic and the
  2026-era-equals-classic invariant untouched. DC-3 test wording fixed.
Golden master: PARITY OK after all six.

## Findings, in priority order

### 1. HIGH — the web client never sets the era module state on load, and un-sets the fare ladder on every render

`RemoteGameProvider` (src/store/GameContext.jsx ~L145) does
`setFareIndex(state.fareIndex ?? 1)` synchronously on every render, and
never calls `setEraStartYear` / `setEraCostScale`. The engine only sets
those at the top of `gameReducer`, which on the Headwinds client runs
only for an optimistic apply.

Consequences in an era world, measured (tools/_probe/_ui_era_probe.mjs):

| calendar | planner demand vs what the tick flies | fare ladder |
|---|---|---|
| 1950 (Y1) | 18.5× overstated | 1.00 shown, 1.55 used by the tick |
| 1975 (Y26) | 6.0× overstated | 1.00 vs 1.30 |
| 2000 (Y51) | 4.8× overstated | 1.00 vs 1.06 |

Until the first optimistic action the RoutePlanner / CargoRouteFinder /
FareEditor / Marketplace overhead figures all render on the classic 2026
economy. After the first action `_eraStartYear` and the cost scale stick
(nothing clears them), but the fare index snaps back to 1.0 on the very next
render because the provider compares `getFareIndex()` to the STORED index,
not to the era-composed one — the exact "reference reverts when I click off"
symptom the comment above that code describes. NWR era worlds are the same
bug with 0.85 instead of 1.0.

Fix (client only, no engine or golden change):
- Derive the effective index the same way the reducer does:
  `eraFareIndex(calendarYear(state))` × `(state.fareIndex ?? 1)`.
- Call `setEraStartYear(state.startYear ?? null)` and
  `setEraCostScale(eraOverheadScale(calendarYear(state)) ?? 1)` in the same
  synchronous block, keyed on `state.startYear` and `state.year` (the era
  index moves every January).
- Same three lines in `GameProvider`'s lazy initialiser and adoption effect
  (solo era saves in this repo, and a backport candidate for Tailwinds'
  GameContext lazy init, which has the same gap).
- Suggested test: render RoutePlanner via SSR with a `startYear: 1950` blob
  and assert the demand figure matches `buildRouteMarket` with
  `setEraStartYear(1950)`; assert `getFareIndex()` after render equals 1.55.

### 2. HIGH — the Comet 1 stays orderable (and flies) after the grounding

`aircraftAvailability` reads `withdrawnYear: 1955` and the grounding fires
at 1954 W15, so for the 37 weeks in between the type is `'new'`:
`orderDenial` returns null, ORDER_AIRCRAFT succeeds, the starter-fleet perk
delivers it instantly, and because `cometGrounded` is already true the
grounding never fires again — the frame flies into 1955 and beyond
(tools/_probe/_comet_probe.mjs: order at 1954 W40 → `comet1:idle` in the
fleet at 1955 W2). A player who JOINS between W15 and W52 of 1954 gets the
same window with a fresh blob. Pending Comet orders placed before W15 also
still deliver after the grounding.

Fix (engine):
- Derive "withdrawn" from the calendar, not the flag: in `orderDenial` treat
  `type.id === COMET_GROUNDING.typeId` as `'expired'` when
  `cy > 1954 || (cy === 1954 && state.week >= COMET_GROUNDING.week)`.
  (Cleanest: give `aircraftAvailability` an optional `week` and let
  `withdrawnYear` carry a `withdrawnWeek`; the Marketplace then shows the
  lock too.)
- In `applyCometGrounding`, drop pending `comet1` orders and refund the
  purchase price / lease deposit with the hull payout.
- Era-features test: order at 1954 W16 must be refused; a pending order at
  W14 must not deliver.

### 3. MEDIUM — era worlds open on 2026 fuel and take ~10 weeks to reach the period price

`worldFuelIndex` / `worldEconomyAt` start the OU walk at `FUEL_BASE_INDEX`
(1.0) regardless of era, and only the reversion TARGET is historical. A
1950 world's shared index runs 1.00 → 0.95 → 0.70 (W5) → 0.54 (W10) → 0.43
(W20) against a mean of 0.45; a 2000 world runs 1.0 → 0.67 at W10 against
0.75. Founders pay roughly double the era's fuel for their first two months
— the most fragile stretch — and can lock hedges at 1.0× in week 1. This is
the same bug fixed in the Tailwinds port on 2026-08-31 (seed at START_GAME);
the Headwinds walk was not covered.

Fix (server, worldEconomy.mjs): start the walk at
`eraFuelMean(startYear) ?? FUEL_BASE_INDEX` when `startYear` is an integer
(both the memo's fresh entry and the backfill loop), and seed
`fuelPrice.index` in `seedAirlineState` from `worldEconomyAt` as today.
Classic worlds are byte-identical (startYear null). Existing era worlds in
production: none yet, so no migration. Add a world-economy test: week-1
index of a 1950 world within 2σ of 0.45.

### 4. LOW-MEDIUM — every era curve steps once a year, on January W1

`eraDemandGrowthFactor`, `eraFareIndex`, `eraOverheadScale` and the fuel
mean are all evaluated at the integer calendar year, so demand jumps
+9.4 % (1950→51), +10.7 % (1960→61), +5.3 % (1970→71) overnight at New
Year, fares drop a step, gate rents and wages jump a step. At 48 weeks/day
that is a visible load-factor discontinuity every real day-and-a-bit in the
1950s–60s. Proposal: a `calendarYearFrac(state) = startYear + (absWeek-1)/52`
helper for the CONTINUOUS curves (demand, fare, overhead scale, fuel mean),
keeping the integer year for the discrete gates (eis/oop, features, events,
Comet). Touches era-balance/progression test expectations; golden unaffected.

### 5. LOW — the last week of a world is never flown and the final year never rolls up

The final tick lands on `toIndex === totalWeeks`, which flies week
`totalWeeks-1` and leaves the blob at W52. So a 100-year 1950 world flies
2049 W51 last, `statsHistoryYearly` never gets its 2049 row (the rollup
fires on `newWeek === 1`), and the world ENDs one tick-interval before
`endsAt`. If the sweep-of-a-century Finance card matters, either let the
tick run to `totalWeeks + 1` (ending the world after week 52 is flown) or
have `ADVANCE_WEEK` also roll up when `action.finalWeek` is set.

### 6. LOW — cosmetics and hygiene

- `docs`/admin copy says "1950→2050"; a 100-year 1950 world's last calendar
  year is 2049 (see 5).
- `tools/delivered-age-card-test.mjs` (uncommitted) says the 1950 DC-3
  arrives "four years old"; `eraDeliveredAgeWeeks(dc3, 1950)` is 42 weeks
  (linear from oop 1946 to the 2026 band). The assertion only checks
  "not 16", so it passes — fix the wording or the expectation.
- Concorde has `oop: 1979` with `deliveredAgeWeeks: 0`, so an era world
  delivers a factory-fresh Concorde any year 1980–2009. Give it a band.
- The uncommitted C-47 append (aircraft.js / families.js) changes the
  catalogue: re-baseline the golden master before pushing (memory note: any
  append breaks golden via the solo picker).
- Events roll with the calendar year of `fromIndex`, consistent with the
  reducer, so the first week of a new year rolls on last year's gate list.
  Harmless (one week) but worth a comment where `calendarYear:` is built.

## Suggested order

1 and 2 are player-visible in the first era world; 3 is a one-line seed
change; 4 is a design choice; 5–6 are tidy-ups.
