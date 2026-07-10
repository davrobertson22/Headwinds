# Hub Redesign — Design Doc

Covers three features: **Focus Cities**, **Itinerary-Based Connecting Revenue**, and **Hub Competition**.
Status: draft for review. No code changes yet.

---

## Current state (summary)

- Hubs live in `state.hubs = { [code]: { tier: 1|2|3 } }` (`GameContext.jsx`), require 10/15/20 gates, cost $25k/$150k/$500k per week, grant +5/+12/+20 quality on hub routes, and are restricted to the home country.
- Own-hub connecting revenue comes from an **abstract pool**: `AIRPORT_GATEWAY_SCORES[code] × 800 × captureRate` split into an "external" term (distance + partner boosts) and an "internal" term (linear in spoke count) — `connectingAtEndpoint()` in `demand.js`. Where spokes point doesn't matter; only how many there are.
- Meanwhile `network.js` already enumerates **real A→hub→C itineraries** weekly (`runNetworkTick`) with a logit choice model, but uses them only for cannibalization and partner prorate revenue.
- Competitors have a `homeHub` and route maps but exert **zero pressure** on the player's hub economics.

---

## Feature A — Focus Cities

A lighter designation below Hub. Real-world analogue: JetBlue at LGB, Alaska at SAN — a base with meaningful connectivity but no full banked operation.

### Rules

| | Focus City | Hub (T1) |
|---|---|---|
| Min gates | **5** | 10 |
| Weekly cost | **$10k** | $25k |
| Quality bonus | **+3** | +5 |
| External gateway feed | **10% of Hub (T1) rate** — captureRate 0.025 | Yes (0.25) |
| Own-metal connections | Yes, weaker (see §B) | Yes |
| Location | Anywhere, but **max 1 focus city per foreign country** (unlimited at home) | Home country only |
| Upgrade path | → Hub at 10 gates (home country only) | → Major Hub |

- **Foreign focus cities are the release valve** for the home-country hub restriction: you can build a connecting presence abroad, but never a full hub there, and only **one focus city per country outside your home country**. Foreign focus cities show a permanent "max designation" note instead of an upgrade button; the designate button is disabled (with tooltip) for airports in a foreign country that already has one.
- The small external capture (0.025) means a focus city at a big gateway like DXB still sees a trickle of feed, but the hub/focus distinction stays crisp.
- Promotion (`focus city → hub`) is the standard `UPGRADE_HUB` flow; demotion (`hub T1 → focus city`) replaces today's "Remove Hub" as an intermediate step.

### State & data

- Reuse the existing map: `state.hubs[code] = { tier: 0 }`. Add `HUB_TIERS[0] = { name: 'Focus City', captureRate: 0.025, qualityBonus: 3, weeklyInvestment: 10_000, minGates: 5, color: 'var(--green, #4cc38a)' }`.
- **Audit required:** call sites assuming truthy tier or `tier ?? 1` fallbacks — `connectingAtEndpoint` (`HUB_TIERS[hubInfo.tier] ?? HUB_TIERS[1]` would silently promote tier 0 → fix to explicit lookup), `DOWNGRADE_HUB` (`tier <= 1` boundary becomes `tier <= 0`), `DESIGNATE_HUB` (min gates 5, skip country check for tier 0), tag-route hub quality in `simulation.js` (~line 1561), `HubManagement.jsx` tier progression strip (render 4 cells), `Wiki.jsx` docs.
- Save-compat: old saves have no tier-0 entries — nothing to migrate.

### Reducer changes

- `DESIGNATE_FOCUS_CITY` (new): ≥5 gates, writes `{ tier: 0 }`. Country rule: if the airport is outside `state.homeCountry`, reject when any existing tier-0 entry is already in that same country (derive countries from `getAirport(code).country` over `state.hubs` — no new state needed).
- `DESIGNATE_HUB`: unchanged (≥10 gates, home country), but also allowed when a tier-0 entry exists (promotion) — reuse `UPGRADE_HUB` with the country check firing on the 0→1 transition.

---

## Feature B — Itinerary-Based Connecting Revenue

Replace the abstract internal-feed pool with revenue derived from the **real own-metal connections** `network.js` already builds. Adding a spoke to a hub should visibly open new O&D markets.

### Model

For each own-metal connection A→H→C where H is a player hub/focus city (both legs player metal — these already exist in `buildAllConnections` output):

1. Build the O&D market with `buildRouteMarket(A, C, gameDate)` (as `computePartnerODRevenue` already does for mixed-leg itineraries).
2. Score a player connection offer against competitor nonstops on A–C plus the outside option, via the existing `computeMarketShare` path. Reuse `buildPlayerConnectionOffer` with a **hub-tier-dependent connection penalty**:

   | Designation | ownMetal penalty | Rationale |
   |---|---|---|
   | Int'l Gateway (T3) | 0.26 | dedicated transfer facilities |
   | Major Hub (T2) | 0.32 | fast-connect baggage |
   | Hub (T1) | 0.38 | basic connection mgmt |
   | Focus City (T0) | 0.48 | self-connect-ish, long MCT |
   | No designation | ∞ (skip) | own-metal connections only monetize at designated airports |

   (Current flat `CONNECTION_PENALTY.ownMetal = 0.30` becomes this table; mixed-leg partner penalties unchanged.)
3. Captured pax → revenue at the two-leg fare, **split across the legs by mileage**, then each leg's share is added to that route's connecting revenue.
4. **Capacity coupling (new, important):** per leg, connecting pax are capped by remaining seats after direct pax (`seats × freq × 0.92 − directPax`). Connecting feed can now fill an under-performing spoke — a real hub-and-spoke gameplay loop — instead of being free bonus revenue.

### What happens to the old pool

- **Internal term: deleted.** Fully replaced by real itineraries.
- **External term: kept but halved** (`0.15 + distBonus` → `0.075 + distBonus/2`). It represents feed the model can't see (other carriers interlining onto you at big gateways) and keeps `AIRPORT_GATEWAY_SCORES` relevant. Partner boost and congestion factor stay on this term.
- Cannibalization: unchanged in mechanism, but it now applies to itinerary-level pax naturally (`connectionShare` already computed per O&D) — the blunt per-routeKey multiplier can be retired for own-metal flows once revenue comes from the connections themselves. Keep the multiplier only for the residual external term.

### Performance

Spokes² blowup: a 20-spoke hub ⇒ ~380 directional own-metal ODs. Guards:
- Existing `MIN_OD_DEMAND_PAX = 5` filter.
- Cache `buildRouteMarket` per (O, D, month) within a tick (also benefits the partner path).
- Hard cap: score only the top ~150 ODs per hub by `odDemand` (sorted before market-building); the tail is negligible revenue anyway.
- Target: weekly tick stays < ~50 ms extra on a 60-route network (measure with a `tools/network-perf-test.mjs`).

### Calibration

Target: total connecting revenue for a representative mid-game save (1 T2 hub, 12 spokes) lands within **±15%** of the current model, so existing games aren't shocked. Tune via the penalty table and `CONNECTING_SEAT_FRACTION`. Add `tools/connecting-revenue-test.mjs` comparing old vs new on synthetic networks (small hub / big hub / focus city / no designation).

### UI

- **RouteDetail:** connecting section shows top 5 feeding O&D markets ("DXB→SIN feeds 34 pax/wk from CAI, 21 from IST…").
- **HubManagement HubCard:** "Top markets over this hub" table (O&D, pax, revenue) replacing the single `Est. Connecting` guess — the estimate function in `HubManagement.jsx` can now read real numbers from the last tick (store `networkConnections` summary in state, already returned by the sim).
- **RoutePlanner:** when adding a spoke to a designated airport, preview "new connecting markets opened" (mirror of the existing cannibalization preview — `getConnectionOpportunityPreview`).

---

## Feature C — Hub Competition

The external gateway pool and own-metal captured share become **contested** by competitors operating at the same airport.

### Competitor hub presence

A competitor "hubs" at an airport if it's their `homeHub`, or they operate **≥6 routes** touching it. Presence weight:

```
compWeight = routesAt(comp, code) × tierFactor        // budget 0.7, legacy 1.0, premium 1.2
playerWeight = routesAt(player, code) × (1 + captureRate(tier))   // tier 0 → 1.0
```

### Effects

1. **Contested external pool:** player's external feed is multiplied by `playerWeight / (playerWeight + Σ compWeights)`. At an empty airport this is 1.0 (no change); at ORD vs ZoomJet's fortress it might be 0.35.
2. **Stronger outside option for itineraries:** when scoring own-metal connections over hub H (§B), add `+0.15 × ln(1 + Σ compWeights/10)` to the outside option's connectivity bonus — competitor hubs at H offer rival connecting paths.
3. **Fortress bonus:** requires an **International Gateway (T3)** with player share **> 60%**. Routes touching it gain `priceSensitivityReduction +0.05` and +2 quality ("dominant hub: schedule breadth and loyalty lock-in"). Displayed as a badge. Lower tiers show the contest bar but can never earn the bonus — a late-game payoff for the $500k/wk T3 investment.

### AI reciprocity (cheap version)

No new competitor behavior needed initially — presence is derived from their existing route maps, which `competitorAI.js` already grows. A later iteration can make AI carriers respond to player fortress hubs (avoid or attack), out of scope here.

### UI

- HubCard gains a **contest bar**: your share vs. named competitors at that airport (e.g. "You 58% · ZoomJet 30% · Lone Star 12%"), with the fortress badge at >60% (T3 hubs only).
- AirportDetail lists competitor presence weights.

---

## Feature D — Hub Cost Efficiencies

Flights touching your hubs are cheaper to operate: own ground staff instead of contracted handlers, own flight kitchen, crews sleeping at home, line maintenance on site. This gives hubs a **defensive economic identity** (cost moat) alongside the revenue one, and is the tangible payback for the weekly hub investment.

### What gets discounted

Only **station costs** — costs incurred at the airport, not in the air. Fuel, crew block pay, and quality/compensation costs are untouched.

| Bucket | Mechanism | Discount basis |
|---|---|---|
| `groundHandlingCost` | Self-handling: own ramp/baggage/gate staff | Per endpoint, averaged |
| `cateringCost` | Own flight kitchen vs. outstation uplift contract | Per endpoint, averaged |
| `layoverCost` | Crews based at the hub go home — no hotels/per-diem | **Max** endpoint tier (crew scheduling routes crews through base) |
| `weeklyMaintCost` (per aircraft) | On-site line maintenance station | Route touches a T2+ hub |

### Numbers

Per-endpoint station discount (ground handling + catering; route value = mean of the two endpoints, so a hub-to-hub route gets the full rate and hub-to-outstation gets half):

| Designation | Station discount | Layover discount | Maintenance |
|---|---|---|---|
| Focus City (T0) | 4% | 8% | — |
| Hub (T1) | 8% | 15% | — |
| Major Hub (T2) | 12% | 25% | ×0.95 |
| Int'l Gateway (T3) | 16% | 35% | ×0.92 |

Layover uses the max of the two endpoints; maintenance uses the best T2+ hub the route touches. Undesignated airports contribute 0%.

### Implementation

- `simulation.js` already attaches hub info per route (the `routeWithHubBonus` construction, ~line 1629). Extend it with `hubCostFactors = { station, layover }` computed from both endpoint tiers, applied inside `simulateRoute` / `simulateTagRoute` when summing `groundHandlingCost`, `cateringCost`, `layoverCost`. For tag routes, evaluate per leg endpoint.
- Maintenance: multiply `weeklyMaintCost` in the tick loop (both places it's computed, ~lines 1603 and 1723) by the route's maintenance factor.
- UI: RouteDetail cost breakdown shows a "Hub efficiency" line with the savings; HubCard adds a "Cost savings" stat (sum across routes touching the hub) so the weekly investment can be judged against it.

### Balance notes

- Rough magnitude: station buckets are ~15–25% of a typical route's op cost, so a T3-to-outstation route saves ~1.5–2.5% of op cost plus layover/maintenance — modest per route, meaningful summed over a 15-spoke bank. Intent: a busy T2 hub's savings should offset **roughly half** its $150k/wk investment; connecting revenue remains the primary justification.
- This intentionally widens the hub-and-spoke vs. point-to-point gap; focus cities' 4% keeps scrappy P2P bases mildly rewarded.
- Add to `tools/connecting-revenue-test.mjs` scope (rename `tools/hub-model-test.mjs`): assert savings magnitudes per archetype so rebalances don't silently blow past the investment payback target.

## Feature E — Hub Tier Progression Friction

Tiers are currently gated only by gate count and are instant + free to activate. With §B–§D making hubs strictly stronger, progression gets three layers of friction: **capex** (decision weight), **build time** (money can't skip it), and **hard operational prerequisites** (tiers are earned by network shape, not bought).

### Requirements table

| | Focus City (T0) | Hub (T1) | Major Hub (T2) | Int'l Gateway (T3) |
|---|---|---|---|---|
| Gates | 5 | 10 | 15 | 20 |
| One-time capex | $1M | $5M | $25M | $100M |
| Build time | instant | 4 wks | 8 wks | 16 wks |
| Routes at airport | — | ≥4 | **≥20** | **≥50** |
| Int'l destinations served from airport | — | — | ≥2 | **≥6** |
| Connecting throughput | — | — | — | **≥1,000 pax/wk** (4-wk avg over this hub) |
| Time at previous tier | — | — | — | ≥26 wks as Major Hub |

- Prerequisites are checked at upgrade time only (no auto-demotion if routes later drop — avoid punishing temporary restructuring; revisit if abused).
- Capex is charged upfront; the tier's weekly investment starts on completion. Benefits (quality, capture, cost efficiencies, fortress eligibility) activate on completion.
- The T3 connecting-throughput prerequisite depends on §B's itinerary model for a real number; until PR 3 lands, T3 gating uses the other rows only.

### State & implementation

- `state.hubs[code] = { tier, construction?: { targetTier, weeksLeft } }`. Weekly tick decrements `weeksLeft`; at 0, tier bumps and construction clears. Track `tierSince` (game week) for the 26-week rule.
- `UPGRADE_HUB` / `DESIGNATE_HUB` / `DESIGNATE_FOCUS_CITY`: validate prereqs, deduct capex from cash (reject if insufficient), write construction entry. Downgrade during construction refunds 50% of capex and cancels.
- UI: HubCard shows an "Under construction — N wks" banner with progress bar; the upgrade CTA becomes a checklist of unmet prerequisites (gates ✓, routes 9/12 ✗, int'l dests 1/2 ✗ …) so the player always sees the path.
- Save-compat: existing hubs keep their tier with `tierSince` backfilled to current week (existing T2s must still wait 26 wks before starting T3 — acceptable, and the itinerary-revenue rebalance lands at the same time).

### Balance intent

T3 becomes a deliberate late-game project: ~6 months at T2, a genuine mega-hub network (50 routes, 6 international), $100M, then 4 more months of construction — and only then fortress-bonus eligibility (§C). Expected outcome: at most one T3 per playthrough, and only in dedicated hub-and-spoke builds.

Note: 50 routes on the 20-gate minimum implies heavy gate utilization — in practice players will hold far more than 20 gates (see §F congestion), so gates stay a soft constraint and routes the hard one, which is the intended shape.

## Feature F — Gate-Based Congestion (replaces the route-count curve)

**Decision (2026-07-07):** the hidden route-count congestion curve (soft cap above 15 routes in `connectingAtEndpoint`) is removed and replaced with a **visible, solvable** mechanic driven by gate utilization.

- `ratio = playerRoutesAtAirport / max(1, gatesAtAirport)`
- Efficient threshold by designation: **T0 1.2 · T1 1.5 · T2 2.0 · T3 2.5** routes/gate (higher tiers have transfer infrastructure that sweats gates harder).
- Below threshold: factor 1.0. Above: `factor = max(0.55, (threshold / ratio)^0.6)` — smooth decline, floored so congestion is painful but never a cliff.
- Applies to **connecting capture only** (external feed + own-metal itinerary revenue at that hub). Direct O&D demand is unaffected.
- UI: HubCard shows utilization ("48 routes / 16 gates — congested") with the factor and a "buy gates to relieve" hint. RoutePlanner warns when a new route would tip a hub over its threshold.
- Design intent: congestion is the organic driver of the "open a second hub" decision — gate scarcity at the fortress, not an arbitrary curve.

## Rollout plan

1. **PR 1 — Focus cities** (self-contained: `HUB_TIERS[0]`, reducers, HubManagement UI, wiki). Low risk.
2. **PR 2 — Progression friction + cost efficiencies** (§E capex/build-time/prereqs — except the T3 connecting-throughput check — plus §D cost path). Reducers, tick, HubCard UI.
3. **PR 3 — Itinerary revenue** (demand.js + network.js + simulation.js, calibration test). Highest risk; ship behind a calibration test in `tools/`. Enables the T3 connecting-throughput prerequisite from §E.
4. **PR 4 — Hub competition** (builds on PR 3's scoring path; adds contest bar + T3-only fortress bonus).
5. Each PR: devlog entry in `public/devlog.html` + sitemap `<lastmod>`; update `/route-economics.html` guide (hub section) after PR 3/4.

## Resolved decisions (2026-07-07)

1. **Foreign focus cities:** hubs remain home-country only; **max 1 focus city per foreign country** (unlimited domestically).
2. **Focus-city external feed:** captures **10% of the Hub (T1) rate** (captureRate 0.025).
3. **Cannibalization multiplier:** retired for own-metal flows (itinerary model supersedes it); kept for the residual external term.
4. **Fortress bonus:** flat 60% share threshold, but **International Gateway (T3) only**.
