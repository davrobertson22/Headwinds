# Metro demand rework — one market per metro pair

**Date:** 2026-08-13 · **Status: IMPLEMENTED** (full metro pooling, per Dave's call)
**Scope:** `packages/engine/src/data/metros.js` (new), `utils/market.js`, `models/demand.js`, `models/encroachment.js`, `models/pairShare.js`, `utils/simulation.js`, `utils/tickPrep.js`, `reducer.mjs` + guard suites `tools/metro-demand-test.mjs`, `tools/demand-growth-test.mjs`.

## The problem (audit open question 1, now closed)

Every member airport of a multi-airport metro carried the full metro demand mass — all six NYC airports at 20.1, all five London airports at an effective 22 — and nothing connected the airport pairs they formed. JFK–LHR, EWR–LHR and LGA–STN each generated a near-full-size New York↔London market of its own: serving a metro pair through two member pairs roughly **doubled** the passengers the model handed out (probed on the old engine: 1.95x; Tokyo↔Osaka was 4x). A rival on EWR–LHR was invisible to a player flying JFK–LHR. As a bonus bug, the same-metro suppression matched by city *string*, so Columbus OH–Columbus GA, the two Norfolks, the Albanys, Augustas, Watertowns and all three Greenvilles priced at **zero**.

## The design: full metro pooling

`data/metros.js` is the single source of truth: ~35 metro groups, each with a primary airport, per-member haul-aware **appeal** (`dom`/`intl`, optional `perimeterKm` past which appeal collapses ×0.05 — LGA, DCA, LCY, SHA, GMP, TSA, SDU, CGH…), and an optional demand **lift**. Codes missing from the airport data are ignored, so the registry can stay ahead of the data.

1. **One market.** `baseCityPairDemand` prices any pair touching a metro at the registry *primaries* — mass is the heaviest member's, attractiveness the strongest member's, distance/country/captivity/border all at the primaries — so every member pair returns the *same* metro↔metro total. `baseCityPairDemand(EWR, LGW) === baseCityPairDemand(JFK, LHR)`, exactly.
2. **One share fight.** `weeklyTick`'s pre-pass groups routes by metro-pair lane (`metroPairKeyOf`). The player gets one combined offer *per member airport pair served* (your JFK and EWR services are different products and genuinely compete), rivals are gathered from **every** member pair (`memberPairKeysOf` over competitor route maps, `encroachments`, `humanRivals`, per-pair spec-vs-carrier dedupe intact), and one `computeMarketShare` runs for the lane. Each sub-offer's result splits across its own tails by seat share, as before. A lone route whose only rivals are on its own pair keeps the historical solo path — behavior-identical there.
3. **Appeal.** Offers carry their real member-pair codes; `offerAirportAppeal` resolves appeal automatically (explicit `airportAppeal` wins; unresolvable → parity, the brandReach pattern). Contested: `log(appeal)` in utility, weight 1.0 — the identity translation of a multiplicative factor into softmax space. Monopoly: `min(1, appeal)` scales the pool — a lone Newburgh–Stansted route reaches a sliver of New York–London (~80 pax where JFK books ~1,360 in the fixture), a lone JFK–LHR route reaches all of it. Contested pools also carry the *union* capture `1 − ∏(1 − appeal_i)` so a market served only from weak fields shrinks; one primary airport in the fight ⇒ 1.0, and it reduces to the monopoly rule for a single offer. Fare compression now counts **distinct carriers**, not offers — your own second airport is not a rival.
4. **Previews agree.** `pairMarketShare` builds the same lane: sub-offers per member pair (requested pair first → `playerResult`), lane-wide `playerShare`, `pooled` flag mirroring the tick's pooling rule; `projectRouteAddition` slices the pooled result only when the tick would pool. Guarded by a tick-vs-preview agreement test in the metro suite.
5. **AI + cargo.** `buildPairIncumbents` counts distinct carriers per lane; competitor P&L applies the pair's appeal cap. Cargo lanes pool by metro pair too, anchored on the strongest *served* member pair (freight masses are airport-specific).
6. **Metro lift.** Benchmarked against metro-*aggregated* real O&D (`metroX` column in `tools/demand-audit/bench.mjs`), pairs between big multi-airport metros undershot at 0.44–0.60 — a metro that needed five airports built generates more travel than its largest member's mass implies. Per-metro `lift` (NYC 1.8, London 1.6, LA 1.5 … each side contributes √lift) closes it. Bench after: median 0.95, geo-mean 1.00, spread 6.5.

## Demand growth over game time

`COUNTRY_DEMAND_GROWTH` (market.js): relative air-travel growth by country — India 0.08, Vietnam 0.075, Indonesia/Philippines 0.07 … US 0.02, Japan 0.01 (default 0.03). Growth is a **saturating curve**, not compounding — worlds run up to a century, so `countryGrowthFactor` follows `1 + (ceiling−1)·t/(t+30yr)` with `ceiling = 1 + rate×15` (India tops out at 2.2x, the US at 1.3x); a pair takes the geometric mean of its ends, hard-capped at 3.0 as a backstop. India: ~+17% by year 5, ~1.9x at year 100 — a thin emerging-market route grows meaningfully over a world's life without becoming a trunk route inside a decade (Dave's call, 2026-08-13). `buildRouteMarket` applies it via `gameDate.absWeek`, stamped by `tickPrep`'s calendar block and `currentGameDate` — a bare `{ week, month }` gameDate gets exactly 1, so fixtures and legacy callers are untouched. Competitor P&L takes the same factor (`absWeek` threaded through `computeCompetitorWeeklyStats` from the reducer). Strategic intent: planting a flag early in an emerging market pays off over a world's life. Cargo growth is deliberately NOT applied yet (freight growth curves differ; candidate follow-up).

## What changed for players (devlog material)

- Routes into multi-airport metros no longer duplicate demand across airport pairs; popular NYC/London/Tokyo-style routes see a one-time correction at the next tick after deploy. Where both ends are big metros the new lift means the *single-pair* market is often close to before — what disappears is the free duplication from serving several member pairs, and rivals at sibling airports now genuinely compete with you.
- The right airport for the right mission matters: LGA beyond its perimeter, transatlantic from Newburgh, international from Sapporo-style domestic fields all collapse in appeal.
- Same-name different-city pairs (Columbus↔Columbus etc.) now have demand.
- Demand grows as worlds age, fastest in emerging markets.

## Known follow-ups (documented, not hidden)

- `tickEncroachment` still *enters* on the player's exact pair; entering via a sibling airport (cheaper gates at a secondary field) would be a nice AI behavior.
- UI rival lists on a route detail screen show the requested pair's rivals; sibling-pair rivals fight in the pool (and are in `rivalCount`) but aren't listed per-airport yet.
- Cargo has no per-airport appeal (its airport-specific cargo scores partly cover this) and no demand growth.
- Rail/HSR corridor competition (Tokyo–Osaka ~0.57, MAD–BCN 0.62, SYD–MEL 0.34 residuals) — deferred by Dave's call this round.
- Metro `lift`/appeal values are estimates against schedule-derived aggregates; tune with `node tools/demand-audit/bench.mjs`.

## Verification

- `tools/metro-demand-test.mjs` (10) + `tools/demand-growth-test.mjs` (6), both in the `npm test` chain; old behavior probed failing on HEAD (member pairs priced independently 15,438 vs 8,732; 1.95x duplication; CMH–CSG = 0; sibling rival invisible; SWF monopoly booked 1,209).
- Full chain: 1,485 assertions green. Golden master re-baselined (intended balance change, this doc is the statement). Bench: median 0.95 / geo-mean 1.00 / spread 6.5.
