# Ground Handling Stations — Design & Implementation

**Status:** **BUILT 2026-09-20** — engine, UI, tests and MP guards in BOTH repos, on disk,
both new suites green (24 engine + 10 UI in each), golden master and beta-world both `PARITY OK`
with **no re-baseline**.
**Scope:** Tailwinds (solo) **and** Headwinds (multiplayer). The engine work is identical; Headwinds
adds the server guard, the world allow-list and the decision label.

**Decisions locked with Dave (2026-09-20):**

| Question | Decision |
|---|---|
| Scale | **Tiered by capacity** — three levels, each covering up to N weekly departures; overflow is outsourced pro-rata |
| Economics | 30% off ground handling at that airport at full efficiency; L1 ≈ $8M / 8 wks / $60K per wk / 2 gates; 12-week ramp from 60%; close refunds 25% (half while building) |
| On-time effect | **Kept** — up to +3 pts airline-wide, weighted by the self-handled share of weekly departures |
| Stacking with hubs | **Best-of**, never summed; ground handling only — catering keeps the hub factor |
| Repos | **Both** |
| Catering contracts | Separate plan (`CATERING_CONTRACTS_PLAN.md`), built later |

---

## 1. The idea

Ground handling (overhead.js §5) was a pure per-passenger contract: $10–$55 per boarded passenger by
cabin, wherever they board, with a 4–16% discount at hubs that nobody chose. It is the largest
passenger-services line after catering and the only one with no capital decision behind it.

A **station** turns that per-head bill into capex plus payroll at **one airport** — the same shape as a
jet base (`mroBase.js`) and a lounge (`lounges.js`), and the same real-world trade-off: self-handling
is a fixed-cost bet that a hub wins and an outstation loses. What it adds to the game is a second
spatial capex decision that rewards concentrating flying, independent of the hub tier ladder.

## 2. What was built

### Engine — `data/groundStation.js` (new)

| Level | Name | Capex | Build | Opex/wk | Gates | Departures/wk |
|---|---|---|---|---|---|---|
| 1 | Ramp Station | $8M | 8 wks | $60K | 2 | 250 |
| 2 | Handling Base | $18M | 12 wks | $130K | 3 | 600 |
| 3 | Hub Operation | $40M | 16 wks | $260K | 4 | unlimited |

- `GROUND_STATION_DISCOUNT = 0.30`, `GROUND_STATION_OTP_BONUS = 0.03`, ramp 12 wks from 0.60,
  upgrade premium 15% on the capex gap, close refund 25% (× 0.5 while building).
- **Capacity is pro-rata.** `stationCoverage(station, departures, absWeek)` → share = min(1, cap/dep);
  discount = 0.30 × efficiency × share. A hard per-route on/off would make the answer depend on route
  order — exactly the nondeterminism the pooling invariant exists to catch.
- **Departures** come from `airportDeparturesMap(routes, routeStops)`: a round trip departs from each
  end once per frequency, a tag rotation from every stop; dormant seasonal routes count zero. Cargo
  routes neither fill a station nor earn the discount (freighter handling is per tonne on its own line).
- `groundHandlingFactorAt(HUB_TIERS, hubs, stations, codes, departures, absWeek)` → the route factor:
  per endpoint, `max(hubStationDiscount, stationDiscount)`; mean over endpoints (same shape as
  `hubCostFactorsAt().station`). Returns **null** when no open station touches the route, so a
  station-less route object is byte-identical to before.
- `stationOtpBonus(stations, departures, absWeek)` = 0.03 × (Σ covered × efficiency / Σ departures).
- `canBuildStation` / `makeStation` / `tickStationConstruction` / `stationCloseRefund` follow the base
  and lounge contracts exactly: one function prices and refuses for both the card and the reducer;
  upgrades build in place (`upgradeTo` / `upgradeWeeksLeft`); the ramp is not restarted by an upgrade.

### Tick

- `tickPrep`: `tickStationConstruction` runs beside the base and lounge ticks; the on-time bonus is
  computed from the **season-adjusted** routes and attached as a **transient** labor field
  (`labor.stationOtpBonus`, read in `laborEffects` beside `eventOtpDelta` / `crewShortfall`).
  `state.labor` is untouched; the field is absent whenever no station is open.
- `weeklyTick`: one departures map per tick; `groundHandlingFactor` attached to each route (single-leg
  and tag) only when an open station touches it. `simulateRoute` / `simulateTagRoute` charge
  `groundHandlingBase × min(stationF, groundHandlingFactor)` and expose `groundStationSavings` (only
  when > 0). Catering keeps `stationF`.
- Report: `totalGroundStationCosts` (opex of OPEN stations; inside `totalCost`, named in the P&L
  bridge's overhead row) and `totalGroundStationSavings` (display only — the saving is already inside
  `totalGroundHandling`). Financial history gains `groundStations` (opex).
- Previews: `stateGroundHandlingFields(state, origin, destination, extraRoutes)` mirrors
  `stateLoungeFields`; spread into every `simulateRoute` call site in `src/components`, the Finance
  fallback sims and `projectRouteAddition` (which counts the route being launched against capacity).
  A guard in `ground-station-ui-test.mjs` fails if a component call site carries the lounge fields
  without the station fields.

### Reducer

`BUILD_GROUND_STATION { code, level }`, `UPGRADE_GROUND_STATION { code, level }`,
`CLOSE_GROUND_STATION { code }`. State: `groundStations: { [code]: { code, level, openedWeek,
buildWeeksLeft, upgradeTo?, upgradeWeeksLeft? } }`. Old saves load with `{}`. No era lock — airlines
have loaded their own bags since the DC-3.

### UI

- **Airport Detail** — a Ground Handling card beside the lounge card: the level ladder with capex /
  build time / opex / gates / capacity, the airport's own weekly departures, last week's handling bill
  there (read off `lastReport.routeResults`, half of each touching route) and each level's projected
  saving coloured against its opex; once built, coverage in plain words, "outgrown" nudge, in-place
  upgrade at the upgrade price, close with the refund quoted. Every price and refusal is
  `canBuildStation`'s.
- **Finance** — under Passenger Services: a "Self-handled at X, Y — saved $N" line inside Ground
  Handling and a "Ground Handling Stations" opex sub-section; both sum into the section total.
- **Wiki** — new "Ground Handling Stations" entry after Hubs.

### Tests

- `tools/ground-station-test.mjs` (24) — ladder, break-even sanity, lifecycle, ramp, eligibility,
  departures, pro-rata coverage, best-of, OTP weighting, `laborEffects`, tick byte-identity without a
  station, cost/opex/bridge with one, construction inert, over-capacity, both ends, hub best-of with
  catering untouched, tickPrep transient, preview agreement, reducer actions, ADVANCE_WEEK.
- `tools/ground-station-ui-test.mjs` (10) — SSR of the real Airport Detail and Finance pages against a
  seeded save, plus the call-site guard.
- Verified failing on HEAD before the fix: `tools/_probe_ground_station_head.mjs` reproduced the old
  call path (weeklyTick over a state carrying an open station) — handling unchanged at $58,760 and no
  opex line — then passed once the wiring landed.

## 3. Headwinds specifics

- `apps/headwinds-server/src/lib/decisionGuard.mjs`: `guardGroundStation(payload, { needLevel })` —
  code + level hygiene only; pricing stays in the reducer.
- `apps/headwinds-server/src/world.mjs`: the three types added to the allowed intents.
- `apps/headwinds-web/src/App.jsx`: decision labels for the activity feed.
- **Not public**: a ground station is back-of-house, unlike a lounge, so it is not in
  `publicDecisions.mjs` and does not print on the news feed.
- Golden master: **no re-baseline was needed, and none should be.** The first cut added
  `totalGroundStationCosts` / `totalGroundStationSavings` to every report, `groundStations: {}` to
  `freshState`, and `groundStations: 0` to every history entry. All four are behaviour-neutral, but
  each one changes the serialized state of a world that has never built a station, and the hash moved
  while the projection stayed byte-identical. Rather than re-baseline — which would have spent the
  guardrail on a change that alters nothing — all four are now spread **conditionally**, the same
  device `allianceSlotPool` already uses a few lines above the report keys. Every reader takes `?? 0`
  or `?? {}`, so absent and zero are the same number downstream; only the bytes differ, and the bytes
  are the point. `tools/ground-station-test.mjs` asserts the ABSENCE of each key on a station-less
  tick, so the parity contract is a test rather than a convention. Both `golden-master/run.mjs` and
  `golden-master/beta-world.mjs` print `PARITY OK`.

## 4. Deferred / open

- **Cargo terminal** — the natural sibling (per-tonne handling, capacity, cargo-hub decision).
- **Third-party handling sales / alliance hosting** — same shape as the deferred MRO alliance
  settlement; the cross-airline money movement deserves its own pass with a reconciliation tool.
- **Ground staff labour interplay** — the `groundStaff` labour group's morale already feeds OTP;
  a station could plausibly weight it more. Not built.
- **Confirm-before-close** exists on the card; the CLOSE_MRO_BASE button still lacks one (noted
  2026-09-20 during the sibling survey).
