# Multi-stop (tag) flights — design & scope

## What we're adding

A **tag flight** is one aircraft, one rotation, flying `A → B → C` (and back), where:

- It sells **three markets**: local `A–B`, local `B–C`, and through `A–C`.
- A through `A–C` passenger occupies a seat on **both** legs; a local `A–B` passenger frees their seat at B.
- Each **leg** must be within aircraft range, but the **total** trip may exceed it — this is the main reason tag flights exist (reach a far city via a fuel/commercial stop).

This is **not** the same as the hub-connection model already in `network.js`. That model derives connecting demand emergently from two *independent* direct routes the player happens to operate. A tag flight is a **single scheduled route on one aircraft** that the player builds deliberately. The two should coexist.

Scope below is for **1 intermediate stop** (3 airports / 2 legs). The data model is written to allow N stops later, but the sim and UI target 2 legs first.

---

## The hard part: shared seat inventory across legs

Everything else is plumbing. This is the real modelling problem.

One aircraft of, say, 162 economy seats flies A→B→C. Each leg has 162 seats. Three O&D markets compete for them:

- `A–B` local needs a seat on **leg 1** only.
- `B–C` local needs a seat on **leg 2** only.
- `A–C` through needs a seat on **leg 1 AND leg 2**.

So leg-1 capacity is split between `A–B` and `A–C`; leg-2 capacity between `B–C` and `A–C`. A through booking is the constrained one — it consumes scarce inventory twice.

**Recommended model (greedy by yield, not a full LP).** Keep it in the spirit of the existing sim:

1. Run `buildRouteMarket` + `computeMarketShare` independently for each of the three O&D pairs to get *uncapped* demand (`leisurePax`/`businessPax`) and per-class fares, exactly as `simulateRoute` does today.
2. Allocate the shared seat pool greedily by **revenue per seat-leg**: through pax yield revenue but cost two seat-legs, so rank by `fare / legsUsed`. Fill highest-yield O&D first, decrement the affected leg(s)' remaining seats, continue. Spill premium→economy stays as-is per leg.
3. Load factor is reported **per leg** (and a blended figure for the route card).

This is ~one new function (`simulateTagRoute`) that calls the existing demand primitives three times and does a small allocation loop. No solver needed. It degrades to today's `simulateRoute` when there's only one leg.

A simpler v0 (ship-first) option: **ignore through traffic** — model the tag purely as two independent legs sharing an airframe for cost/block-hour/range purposes. Loses the `A–C` market (the main selling point) but de-risks the capacity math. I'd only use this as a stepping stone.

---

## Files that change

### Data model — `src/store/GameContext.jsx`
- Route shape today (line ~65): `{ id, origin, destination, aircraftId, weeklyFrequency, hub }`. Add an optional `stops: [A, B, C]` (ordered, length ≥ 2). Keep `origin`/`destination` as derived `stops[0]`/`stops[last]` for backward compat so every existing reader keeps working and old saves migrate trivially (`stops = [origin, destination]`).
- `ADD_ROUTE` reducer: validate **each leg** for range, regulatory restrictions, and block hours; validate slots at **every** airport in `stops` (intermediate airports consume an arrival *and* a departure). Today slot checks only hit origin/destination (reducer lines ~487–488).
- Pricing is the sharp edge: `routePricing` is keyed by `routePairKey(origin, destination)` which **sorts** the two codes (`simulation.js` line ~132). A 3-airport directional route has *three* fare markets and sorting collapses direction. Introduce a route-scoped pricing key (e.g. by `route.id` or an ordered segment key) for tag routes, or store a `segmentPricing` map on the route. This touches `hydrateRoute` too.

### Simulation — `src/utils/simulation.js`
- New `simulateTagRoute(route, aircraft, …)` implementing the capacity model above; `simulateRoute` stays for single-leg and can delegate.
- `blockTimeHours` is per-sector already — good. Weekly block hours become **sum over legs** plus an added turnaround at each intermediate stop. `weeklyBlockHours` and `maxFrequency` need a legs-aware variant.
- Range check moves from "total distance" to "**max leg distance** ≤ effective range" (line ~444).
- Fuel/crew cost is `Σ dist_leg × rate × flights` — fine, just loop legs.
- `weeklyTick`'s multi-aircraft pre-pass groups by sorted `routeKey` (line ~926). Tag routes need their own grouping/aggregation path so they don't get mis-bucketed with single-leg routes on the same endpoints.
- Landing fees: charged at each airport in `stops`, not just two.

### Network model — `src/models/network.js`
- A real `A–C` tag competes with hub connections over the same O&D. Decide whether a tag leg can also *feed* connections (it should — `A→B→C` makes B a viable connect point) and make sure `buildAdjacencyIndex` ingests each leg as an edge. Otherwise tag routes are invisible to the cannibalization/partner-feed logic.

### UI
- `RoutePlanner.jsx`: the picker is hard-wired to two `AirportPicker`s and a swap. Add "+ add stop" to insert an intermediate airport, show per-leg distance/range feasibility, and surface three demand/economics blocks (per-leg + through). The "reachable types" filter changes from total distance to max-leg distance.
- `RouteDetail.jsx` / `RouteMap.jsx`: render a polyline through stops and per-leg load factors.

---

## Suggested phasing

1. ✅ **Data model + migration** — `stops[]` added with `origin`/`destination` derived; save migration normalizes every route; helpers in `simulation.js` (`routeStops`, `routeLegs`, `routeSegments`, `routeMaxLegKm`, `routeSegmentKey`, `normalizeRouteStops`). No behaviour change. Tested in `tools/multistop-test.mjs`.
2. ✅ **Sim core** — `simulateTagRoute` with the shared-inventory model (greedy by **revenue per seat-leg**), legs-aware range (longest leg binds), block hours, fuel, crew, catering/handling/lounge/layover/compensation. Through-pax double-booking proven by test. **Landing fees still pending** — they live in `weeklyTick` and become a Phase 3 item.
3. ✅ **Reducer + tick integration** — `weeklyTick` now dispatches multi-stop routes to `simulateTagRoute`, applies demand multipliers, and charges per-airport landing fees (`routeLandingFee`, interior stops twice); tag routes are excluded from the single-leg demand pre-pass. New `ADD_TAG_ROUTE` reducer validates per-leg range (longest leg), per-leg regulatory restrictions, legs-aware cumulative block hours (`routeBlockHours`), connectivity, and gates+slots at every stop; `SET_SEGMENT_PRICE` edits directional fares. Player-set fares stored on the route in `segmentPrices`, keyed by `routeSegmentKey`. Save migration preserves tag routes' `segmentPrices` + per-route `cateringLevel`. Tested in `tools/multistop-test.mjs` (§6) and `tools/reducer-tag-test.mjs`.
4. ✅ **UI** — new **Multi-stop** mode in the Planner (`ModeToggle` → `TagRoutePlanner.jsx`): ordered stops builder (add/remove intermediate stops), aircraft picker filtered to types that can fly the longest leg, frequency, per-market economy fares (incl. through markets, premium auto-scaled), and a live `simulateTagRoute` preview with per-leg load + per-airport landing fees + validity blockers (range/gates/slots/block-hours/connectivity/cash). Dispatches `ADD_TAG_ROUTE`. The Routes page now renders tag routes in their own "Multi-stop Routes" section (`TagRouteCard`) using `simulateTagRoute`, excluded from the single-leg city-pair grouping; fleet utilisation is legs-aware (`routeBlockHours`). `SET_SEGMENT_PRICE` exists for future per-segment fare editing on saved routes.
5. ✅ **Network integration** — `network.js` now expands every player route into its flown legs (`expandRoutesToLegs`) before building the adjacency graph, so a tag flight's intermediate stops become real network nodes that can form and feed hub connections. Each leg is priced from the route's per-segment fare and tagged with `_tagParentId`; the connection enumerator skips any connection whose two legs share a parent (a tag's own through service — already sold by `simulateTagRoute`, so this prevents double-booking). Consequences: tag legs now participate in cannibalization and in partner O&D feed (a tag leg + a partner leg over a shared hub earns the player prorate revenue). Verified by tests (§7): legs split correctly, a lone tag forms zero connections, and a tag leg + a separate spoke forms a real connection over the shared hub.

All five phases are done and green — **71 automated tests** across cargo + multistop + reducer suites; every touched component parse-checks clean.

### Remaining refinement (optional, not blocking)
Tag routes still don't book their own gravity-model hub-feed line (`computeConnectingDemand`) the way single-leg routes do — they earn connecting value only through the network's partner-feed path. Adding a per-stop hub-feed line for tag routes is a clean future enhancement; it was left out here to avoid any risk of double-counting the through markets `simulateTagRoute` already sells.

### Phase 4 validation note
The full `vite build` can't run in this environment (an unrelated rollup native-binary arch issue), and the JSX-render transform package isn't installable offline, so UI was validated by Babel parse-check of every touched component plus the full test suite (including the real reducer executed via the transpile harness). Worth a quick `npm run dev` to eyeball the new Multi-stop tab before shipping.

### Testing note
`tools/reducer-tag-test.mjs` exercises the real reducer. Since `GameContext.jsx` is a React/JSX module Node can't import directly, the harness transpiles it with Babel (already a dependency), strips JSX to `null`, rewrites import specifiers to absolute URLs, runs it from a temp file, and cleans up — no app/runtime changes needed for testability.

### Fidelity note on the sim core (Phase 2, intentional)
`simulateTagRoute` models **two cabins** (economy + a pooled premium bucket), no cross-cabin spill, and uses whole-route distance for catering/handling/compensation. This keeps the leg-capacity constraint clean and the allocation provably correct. The full 4-class fanning that single-leg `simulateRoute` does can be layered on later if tag routes need to match it exactly.

---

## Decisions (locked)

1. **Stops cap** — **2 intermediate stops** (4 airports / 3 legs), set by `MAX_ROUTE_STOPS = 4` in `simulation.js` and enforced in the reducer (`ADD_TAG_ROUTE`) and the planner UI. The sim, fees, and network model are all N-stop-capable; this is purely the gameplay limit, so raising it is a one-line change. (Originally scoped to 1 stop; widened to 2 by request.)
2. **Through-fare policy** — **player sets the `A–C` fare** explicitly, alongside the two leg fares. Requires segment/through pricing in the model and a third fare control in the UI; validate it against per-leg fares.
3. **v0 scope** — **full shared-inventory model** from the start (A–B, B–C, and A–C through with shared seat allocation). No two-independent-legs stepping stone.
4. **Network feed** — **tag legs feed hub connections** in `network.js`; `buildAdjacencyIndex` ingests each leg as an edge so B becomes a real connect point and tag routes participate in cannibalization/partner-feed.
