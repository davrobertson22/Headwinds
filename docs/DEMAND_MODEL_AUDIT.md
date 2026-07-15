# Headwinds Demand Model Audit — City-Pair Demand vs Reality

**Date:** 2026-07-15 · **Status: IMPLEMENTED** (real-world scale, per Dave's call — see "What was implemented" below)
**Scope:** `baseCityPairDemand()` in `packages/engine/src/utils/market.js` plus the airport mass data in `packages/engine/src/data/airports.js`, audited against real-world origin–destination traffic for 47 city pairs across every major market type.

## How the audit was run

The current model is a gravity formula: `demand = 1054 · sqrt(massO·multO · massD·multD) / (1 + km/3000)^1.1`, where mass is metro population (plus optional `visitors`/`gateway`/`effectivePop` fields) and mult is `(businessScore + leisureScore)/100`. I ran it on 47 benchmark pairs and compared against real one-way weekly O&D passengers, derived from OAG's 2025 busiest-routes data, Wikipedia's busiest-routes list, and schedule-based estimates (seats × ~82% load factor × an O&D share to strip out connecting traffic, since the game adds connecting demand separately). Each benchmark carries a confidence tag; conclusions below lean on the high-confidence rows.

## Verdict: your instinct is right

The model's *relative* demand between pairings does not reflect reality. The spread between the most under-modeled and most over-modeled pair is **~400x**. The median route also sits at only ~46% of real-world volume (which may be a deliberate playability choice — see open question 1).

### Headline comparisons (one-way pax/week, total market)

| Pair | km | Model | Real (est.) | Model/Real | Note |
|---|---|---|---|---|---|
| GMP–CJU | 451 | 2,181 | ~111,000 | **0.02** | World's #1 route (14.4M seats/yr, OAG 2025) |
| JED–RUH | 853 | 5,150 | ~73,000 | **0.07** | World's #5 |
| SYD–MEL | 706 | 5,796 | ~84,000 | **0.07** | 9.2M pax in 2024 |
| HND–CTS | 819 | 8,768 | ~91,000 | **0.10** | World's #2 |
| SGN–HAN | 1,160 | 7,888 | ~75,000 | **0.11** | World's #4 |
| HKG–TPE | 806 | 12,094 | ~46,000 | **0.27** | World's #1 international |
| JFK–LAX | 3,974 | 9,198 | ~23,000 | 0.40 | The calibration anchor itself is ~2.5x low |
| JFK–LHR | 5,541 | 9,607 | ~21,000 | 0.46 | |
| LAX–SFO | 544 | 13,305 | ~22,000 | 0.60 | |
| LAX–NRT | 8,755 | 6,960 | ~6,700 | 1.03 | Long-haul is roughly right |
| YYZ–ORD | 700 | 7,094 | ~4,900 | 1.45 | |
| LOS–ADD | 3,916 | 3,519 | ~900 | **3.81** | |
| MEX–GRU | 7,433 | 6,990 | ~1,800 | **3.89** | ~2 daily widebodies in reality |
| DAC–DEL | 1,426 | 19,805 | ~2,400 | **8.17** | Model makes it bigger than JFK–LHR |

### The four systematic causes

**1. No "air-captivity" effect.** The biggest routes on Earth are short hops where flying is the only practical option — islands (Jeju, Sapporo, Okinawa, Taiwan, Bali, San Juan) and no-rail/vast-distance domestic trunks (Australia, Saudi Arabia, South Africa, Vietnam). The model treats GMP–CJU like any 451 km pair. Median model/real for this category: **0.10**.

**2. No income/propensity-to-fly term.** The attractiveness multiplier `(biz+leisure)/100` spans only 0.87–1.45, but real per-capita propensity to fly spans ~50x between rich and poor countries. Result: DAC–DEL (two huge, low-income metros) is modeled at 8x reality and beats JFK–LHR; conversely wealthy-market routes run low.

**3. No border/ties friction.** Domestic and international pairs are treated identically. Real cross-border demand is systematically lower than domestic at the same distance and masses, except where ties are strong (UK–Ireland, US–Canada, HK–Taiwan, Gulf–Egypt). This is why MEX–GRU and LOS–ADD overshoot while YYZ–ORD sits 45% above its domestic-equivalent control.

**4. Missing mass data for tourism magnets and national catchments.** The `visitors` and `gateway` fields exist in `market.js`/`airports.js` and work — but they're populated for only 276 mostly-small airports (Aruba, Easter Island, Paro…) while the airports that need them most have none: CJU (0.67M pop, ~13M air visitors/yr), MCO, LAS, CUN, OKA, DPS, HNL, SJU, CTS. Same for `gateway`: only 4 airports have it, yet SGN/HAN/DEL/BOM/CGK/JNB draw on national catchments far beyond their metro pops. This is why Jeju's mass is 0.7 while the route it anchors is the busiest on the planet.

**Not broken:** the distance-decay curve `(1+km/3000)^1.1` is actually fine. Long-haul benchmarks (LAX–NRT 1.03, SFO–HKG 0.69, SIN–LHR 0.61) sit close to the overall median — the errors come from the four factors above, not from distance shape.

## What was implemented (2026-07-15)

The recalibration keeps the existing gravity formula and distance curve and adds five layers in `market.js`, plus a data pass on `airports.js`:

1. **Border factor** (`borderFactor`) — domestic 1.0; international 0.70 same-region; 0.70 cross-region between two high-propensity countries; 0.45 otherwise. `COUNTRY_AFFINITY` overrides for ~70 special corridors (GB–IE 1.0, AU–NZ 1.0, EG–SA 1.0, HK–TW 0.95, SG–MY 0.95, Gulf labor corridors, US–CA 0.65, IN–BD 0.45, …) and `REGION_PAIR_AFFINITY` for EastAsia↔SEAsia, NA↔Caribbean, Europe↔NorthAfrica (0.70).
2. **Country propensity index** (`COUNTRY_PROPENSITY`, all 221 countries; US=1.0: AU 1.6, JP/KR 1.3 … IN 0.35, BD 0.08, NG 0.10) — full strength on international pairs, softened to `p^0.35` on domestic (domestic flying is far less income-sensitive: cheap LCC fares, no visas).
3. **Air-captivity multiplier** (`captivityFactor`) — `max(islandBoost, domesticAirReliance)`, never stacked. Isolated endpoints (islands, SE Alaska, Perth, Kyushu) get ×2.8 domestic but only ×1.6 international (foreign traffic to domestic resort islands routes via national gateways), fading to ×1 beyond ~7,000 km. `AIR_RELIANT_DOMESTIC` by country: SA 2.4, AU 2.2, ZA/VN/ID/PH 1.9, IN 1.5, JP 1.3 (Shinkansen owns Honshu — the big JP air markets get the island boost instead), US 1.0, CN 0.85 (HSR).
4. **Short-hop ground ramp** (`groundRampFactor`) — pairs under 200 km in contiguous-road countries taper toward ×0.2 (nobody flies 120 km); archipelago countries and isolated airports exempt so Hawaii inter-island and the Alaska milk run keep their demand. Jakarta–Bandung added to METRO_GROUPS (HSR corridor; the air route is dead in reality).
5. **Global constant** 1054 → 1900 (real-world scale).

Data pass: `visitors` fills for major leisure magnets (CUN 15, MCO/LAS 12, DPS, HNL, OGG, SJU, JED); new `domesticVisitors` field (counts only toward same-country pairs) for CJU 13, CTS 5, OKA 3 — their tourism is overwhelmingly domestic and a plain `visitors` fill invented huge phantom international routes like Tokyo–Jeju at 126k/wk. `gateway` fills for national-catchment hubs (SGN 30, HAN 25, CAI 30, DEL 22, BOM 15, JNB 12, CGK 12, BOG 15, LIM 12, PEK 15, SHA 10, RUH 8, GRU/EZE 8, …). `effectivePop` 24 for GMP (all-Seoul), 20 for NRT (secondary-airport trim).

### Result (implemented engine, 47-pair benchmark)

| Metric | Before | After |
|---|---|---|
| Median model/real | 0.46 | 0.90 |
| Geometric mean | ~0.4 | 0.97 |
| Worst-case spread | **408x** | **6.7x** |
| GMP–CJU | 0.02 | 0.93 |
| JED–RUH | 0.07 | 0.90 |
| HND–CTS | 0.10 | 1.16 |
| JFK–LHR | 0.46 | 0.73 |
| DAC–DEL | 8.17 | 1.43 |
| MEX–GRU | 3.89 | 2.02 |

A full sweep of all ~2.2M airport pairs shows the game's top routes now mirror the real world's: HND–CTS and GMP–CJU on top, then HAN–SGN, DEL–BOM, JED–RUH, CGK–DPS, PEK–SHA, SIN–CGK. Network-wide total demand lands at 0.84x the old model (played routes in wealthy markets are up ~1.5–2x; the long tail of low-propensity pairs is down).

Rerun the benchmark any time with `node tools/demand-audit/bench.mjs` (healthy: median/geo-mean ≈ 1, spread < ~10).

### Known residuals (documented, not hidden)

SYD–MEL and HND–FUK still run ~0.3–0.55 (small metros relative to traffic). Japan's rail-dominated Honshu corridors (Tokyo–Osaka/Nagoya) remain ~2x over because the game has no rail competitor. BOS–LGA (~2.1) and LHR–AMS (~1.7) overshoot from the multi-airport metro issue below. MEX–GRU (~2.0), MCO–SJU and CGK–DPS are against low/medium-confidence estimates.

## Remaining design questions

**1. Multi-airport metros.** Every NYC airport carries mass 20.1, every London airport 22 — each airport pair into a metro independently generates near-full-metro demand, multiplying the true city-to-city market by the number of airport pairs served (Tokyo↔Osaka worst: four inflated pairs). The NRT/GMP effectivePop trims soften it. A real fix (splitting metro mass across member airports via METRO_GROUPS) is a bigger refactor that would shrink player options — separate decision.

**2. Live-world migration.** This reshapes demand on routes players already fly: existing MP worlds will see demand jump ~1.5–2x on typical routes at the next tick after the server redeploys. Options: accept the one-time shock (with a devlog note), or gate by world-creation version.

**3. Golden master.** `tools/golden-master` is a byte-for-byte behavior guardrail; this change is intentionally behavior-altering, so the baseline needs `node tools/golden-master/run.mjs --update` (done as part of this change — verify it's committed alongside).

## Sources

Real-world benchmarks from [OAG Busiest Routes 2025](https://www.oag.com/busiest-routes-world-2025) (route-level annual seats), [World Airline News summary of OAG 2025 US routes](https://worldairlinenews.com/2025/12/24/oag-usas-and-the-worlds-busiest-airline-routes-in-2025/), and [Wikipedia: List of busiest passenger flight routes](https://en.wikipedia.org/wiki/List_of_busiest_passenger_flight_routes) (SYD–MEL, DEL–BOM, MAD–BCN pax counts). Load-factor and O&D-share assumptions are stated per row in the audit script.

## Artifacts

- `tools/demand-audit/bench.mjs` — 47-pair benchmark harness (`node tools/demand-audit/bench.mjs`)
- `packages/engine/src/utils/market.js` — all new tables and factors live here, exported for tuning
- `packages/engine/src/data/airports.js` — 27 airports gained `visitors` / `domesticVisitors` / `gateway` / `effectivePop` data
