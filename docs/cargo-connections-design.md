# Freight connections — design

Status: BUILT in both games (5 Nov 2026), ALL saves (no world flag). Tests:
`tools/cargo-connections-test.mjs` (engine + tick) and `tools/cargo-connections-ui-test.mjs`
(freight table SSR) in both repos.
Origin: Discord feature request "Freight connections" (Barca, 3 Nov 2026).

## Problem

Freight is point-to-point. A freighter route earns only from its own city pair, so
HKG–ANC plus ANC–ORD earns nothing from Hong Kong–Chicago freight. Real freight is
MORE hub-and-spoke than passengers (Memphis, Leipzig, Anchorage, Dubai), and the
passenger side has had own-metal connections for a long time. `cargo-design.md` §4
deferred this ("freight consolidates through hubs differently").

## Decisions (locked)

| Decision | Choice |
|---|---|
| Where freight connects | ANY airport where the player has ≥2 active freighter routes — no hub designation needed (Anchorage-style transit points work) |
| Full legs | Local first: a leg's own city-pair freight loads first, connecting freight fills what is left |
| Rollout | All saves, both games, no flag. Intended balance change (Headwinds golden master still PARITY OK: no fixture flies freight through a shared airport) |
| Scope | One connection (two legs). No multi-hop. AI freighters stay point-to-point |

## Scale check (why it needs limits)

Gravity demand between the outer cities of an 8-spoke freight hub, measured with
`cargoCityPairDemand`:

| Hub | Hub's own freight | All spoke pairs | Pairs with circuity ≤ 1.3 |
|---|---|---|---|
| FRA | 11,725 t/wk | 42,964 (3.7×) | 16,694 (1.4×) |
| ANC | 7,620 | 36,172 (4.7×) | 21,558 (2.8×) |
| DXB | 11,928 | 33,484 (2.8×) | 20,819 (1.7×) |

Unfiltered, HKG–NRT freight "connects" in Frankfurt and the pool quintuples. Three
things keep it sane: a circuity cap, a capture rate, and the fact that connecting
freight only ever fills SPARE payload.

## Model

`simulateCargoNetwork(cargoRoutes, fleet, opts)` in `utils/simulation.js` is the ONE
entry point for freight economics — the weekly tick and every freight screen call it,
so previews agree with the tick by construction. It:

1. Runs the existing lane allocation + `simulateCargoRoute` for every active route
   (unchanged: local freight, local first).
2. Finds connections: for each airport H with ≥2 active freighter routes, every pair
   of spokes (A, C) with `cargoCityPairDemand(A, C) > 0` and
   circuity `(d(A,H) + d(H,C)) / d(A,C) ≤ CARGO_CONN_MAX_CIRCUITY` (1.3).
3. Prices each O&D market once, across every hub that offers it:
   - pool = `cargoCityPairDemand(A, C, month)` × awareness × event multiplier(A, C)
     × min(leg maturities)
   - through yield = km-weighted average of the two legs' yield ratios × the A–C
     reference yield; elasticity exactly as a direct route (cap 1.6)
   - capture = `CARGO_CONN_CAPTURE` (0.6) at circuity 1.0, falling linearly to half
     that at the cap — forwarders prefer a nonstop, and other networks bid for it
   - against nonstop capacity on the lane (the player's own A–C freighters plus
     rivals' price-weighted capacity, the `cargoLaneAllocations` index): each
     connection weighs `CARGO_CONN_WEIGHT` (0.5) × its smaller leg's capacity, so
     demand_k = pool × elast_k × capture_k × w_k / (Σw + directCap)
   - total never exceeds what the player's own nonstop on A–C leaves of the pool
4. Loads connecting demand onto both legs, local first, through the SAME spill
   model local freight uses: a leg's room is
   `min(C, expectedCarried(local + Σconn, C × LOAD_CEILING) × jitter) − localCarried`.
   Each connection gets `D × min(ratio leg1, ratio leg2)`, so no leg exceeds capacity.
5. Books it on the legs: revenue = T × (1 + backhaul(A,C)) × d(A,C) × through yield,
   split between the legs by km; handling = T × 2 × (end handling + transfer
   handling `CARGO_TRANSFER_HANDLING_PER_TONNE` $60) split the same way. Fuel and
   crew are already paid by the flights — connecting freight is pure marginal revenue
   on empty space, which is exactly the commercial logic of a freight hub.

Each leg's result gains `localTonnes`, `connectingTonnes`, `connectingRevenue`,
`connectingHandling` and `feeds` (O&D, via, tonnes, revenue); `tonnes`, `revenue`,
`loadFactor`, `groundHandlingCost`, `totalOpCost` and `profit` include the
connecting share.

## Out of scope (v1)

- Rivals do not see the player's connecting freight in their own lane contest
  (their share is unchanged); AI does not build freight hubs.
- Belly cargo (still the bigger, separate feature).
- Three-leg routings.

## Where it shows

- Freight table: a green "+N t connecting" tag per route (Headwinds: per lane), with the
  markets in its tooltip; the summary bar adds "of which connecting".
- Freight Route Planner: what the new route would pick up, plus what it adds to the
  routes it connects with (network revenue after minus before).
- Fleet card and route map read the same results (Tailwinds Fleet card computes through
  simulateCargoNetwork; Headwinds reads the tick's report as before).
- Not yet: the Cargo Route Finder still ranks lanes by their own demand only.

## Findings while building

- A single freighter at the most it can fly on a long lane (777F HKG–ANC, 6×/wk) is
  usually nearly filled by the lane's own freight, so connections mostly pay once you
  add capacity beyond a lane's own demand. That is the intended "local first" result.
- ANC's cargo score reflects its real throughput, which is mostly transit. Its own
  lanes already look strong locally (HKG–ANC ~1,000 t/wk) and now also get connections,
  so Anchorage may be double-counted. Left as is; a candidate for a cargo-score pass.
- Classic Headwinds worlds have no freight spill model, so connecting freight fills
  legs to the last tonne there; NWR worlds use the 95% ceiling and weekly jitter.
