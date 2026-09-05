# Hub Connectivity — direct vs indirect flying for the whole world

**Status:** Phase 1a BUILT (2026-09-05, both repos, on disk, uncommitted). Phase 1b next.

## 0. BUILD STATE

**Decisions taken (Dave, 2026-09-05):** 1 declared hubs tiered by spoke count · 2 sum-of-legs now, through-fares Phase 3 · 4 `tickConfig.rivalItineraries` flag, on for new worlds · Phase 0 probe before engine code. (3 — the gateway pool — still open, per plan.)

**Phase 0 — `tools/rival-itinerary-probe.mjs` (`@not-a-test`), classic solo, JFK T2 + 20 spokes / ORD T1 + 10 spokes / 6 point-to-point, stock AI carriers, `CIRC=1.5`:**

| | +0 wk | +52 wk | +104 wk |
|---|---|---|---|
| AI carriers / routes | 25 / 161 | 19 / 211 | 18 / 283 |
| Qualifying rival hubs (T1 / T2 / T3) | 25 / 0 / 0 | 23 / 0 / 0 | 20 / 2 / 0 |
| Player nonstops uncontested today | **78%** | 19% | **3%** |
| Player nonstops gaining ≥1 rival one-stop | 33% | 36% | 50% |
| Own-metal markets gaining ≥1 rival one-stop | 8% | 16% | 28% |
| First-order nonstop pax, one-stops appended as-is | −7.1% | −11.2% | **−17.4%** |
| …of which rival one-stops actually *carry* | 72% | 20% | **18%** |
| Same, with spill recaptured (rough) | n/m | −1.1% | +0.2% |
| Index build / probes per tick | 0.2 ms / ~6k | | |

**Phase 1a — spill recapture, BUILT 2026-09-05 (both repos, on disk).** `computeMarketShare` (HW `packages/engine/src/models/demand.js`, TW `src/models/demand.js`):

- `allocateWithSpill(raw, cap, ceil)` — capped offers' excess re-allocated to open offers pro rata to raw allocation (share × choke), iterating; lost only when nobody is open. Applied to business first (own cabin), then leisure (remaining physical seats).
- `_soloCeiling(market, offer, compressedRef)` — the monopoly rule as a per-offer ceiling on raw + spill: what the offer would carry ALONE at its own fare (brand reach × appeal × own-price elasticity × choke). Found necessary by the suite: without it a full $300 rival filled an $800 player (the tag-route fixture) and a full known rival filled an unknown start-up above its monopoly figure. "You can never do better beside a sold-out rival than alone."
- `offersBrandCapture(offers)` = `1 − ∏(1 − min(1, reach_i))` on the contested pool — the brand sibling of `offersAppealCapture`. Two 45%-reach start-ups previously reached 100% of a pair between them (reach cancelled in the softmax); now 70%.
- `leisurePaxUncapped` = raw + spill received (the load models read it).
- `DEBUG_MS=1` dumps every share fight to stderr (node only; guarded for the browser).
- Tests: `tools/spill-recapture-test.mjs` (11, both repos; 5 failed on HEAD). Fixtures that encoded the old demand destruction were corrected, not weakened: `cargo-demand-test` JFK–ORD → JFK–DEN (on ORD every rival is full so the share fight is irrelevant); TW `battle-card-share-test` gets its 0.05 pool shrink as an active event (TW has no `worldDemandMult`, so the fixture had silently been running oversubscribed 3.7×).
- Golden master: **PARITY OK — no rebaseline needed**; the golden scenario's lone JFK–LAX A320 is full every week either way. The playbot runs with no rivals, so neither could see this — hence:
- **`tools/contested-balance-probe.mjs`** (`@not-a-test`, both repos; `FIXRAND=1` pins the dice so two engines walk the same path): the Phase 0 network + stock AI carriers, 104 weeks. HW: revenue **+5.6% / +4.4%**, pax +2%, cash 974M → 1,202M (+23%; thin margins amplify). TW: revenue +2.3% / −0.2%, cash +4.7%. All of it on pairs where AI rivals fly full — the removal of an accidental haircut, not a new bonus. Suites: HW 158/159 (sandbox adsense), TW 113/113.
- Open question for 1b: AI carriers cap often because their capacity is crude (`TIER_SEAT_TARGET` or one type × frequency, 3–21×/wk). With spill now flowing from full AI rivals to the player, AI capacity realism is worth a look before rival one-stops add more seat-thin offers.

Three findings that change the plan:

1. **Uncapped circuity is absurd.** Without a cap the probe offered *Gulf Pearl via DOH* on JFK–CDG and *Aztec Air via MEX* on JFK–MAD. A hard cap of 1.5× (sum of legs ÷ nonstop distance) drops the affected-market count from 47% → 33% with almost no change to the pax effect — the absurd routings carried nothing anyway. **The cap moves into Phase 1**; the smooth penalty stays in Phase 3.
2. **The model has no spill recapture, and one-stops expose it.** `computeMarketShare` (`demand.js:967-975`) caps an offer at its seats and *discards the excess* — it is not handed back to the uncapped offers. Rival nonstops already do this quietly; a connecting offer is seat-thin by construction (`seatFraction` 0.10–0.22 of the thinner leg), so it takes a large softmax share it cannot carry and the passengers vanish. At +104 weeks, 82% of the player's apparent −17% is evaporated demand, not rivals winning. **New Phase 1a: iterative spill recapture in `computeMarketShare`**, landed and measured on its own before any rival offer exists. It is a pre-existing gap and a balance change in its own right (year-1 contested markets have a lot of capped rival nonstops).
3. **"Monopoly pools" are a year-one phenomenon in solo.** 78% of the player's nonstops are uncontested at week 0, 3% by week 104 — the AI encroaches nonstop, fast. The era sweep's 95% LF came from the playbot's *no-rivals* config, not from the model. Rival one-stops are therefore less about breaking monopolies than about making the *right* rivals matter: with recapture, the net nonstop effect is ≈ −1% to 0%, concentrated on secondary-Europe transatlantic (JFK–AMS/MAD/FCO via FRA/CDG) and West Coast (JFK–SFO via SEA/LAX/DEN) — which is where it should be.

Also observed, not acted on: a T1 one-stop over MCO takes 42% of MIA–ATL (970 km) — a connection on a 90-minute sector doubles the trip and the flat `connPenalty` doesn't know that. Phase 3's elapsed-time term should scale the penalty by (connection time ÷ nonstop time).

---

**Original proposal follows (revised 2026-09-05 after Phase 0).**
Audit findings in §2 are code-verified (file:line); everything after is design.
**Scope:** engine (both repos), the battle card / route detail / airport detail UI, a Headwinds rival-view change, a golden-master rebaseline.
**Origin:** Dave, 2026-09-05 — "get to a position where the demand model tries to take into account direct vs indirect flying … making it more realistic to include non-direct routes." Same week as the Barca report (airport details showed zero connecting pax at a live hub — a symptom of how thin the hub picture is).

**Decisions for Dave (recommendation in bold):**

1. **What counts as a rival's connection point.** Any airport with ≥ N rival routes, or declared hubs only? **Declared hubs only, tiered by spoke count using the player's own thresholds** (§3.2). Symmetric with the rule you live under; uses the AI's existing `homeHub` / `secondaryHub`; human rivals use their real designated hubs.
2. **How a connecting itinerary is priced.** Sum of the two leg fares (what your own-metal does today), or a through-fare pegged to the nonstop market? **Sum of legs in Phase 1** so the effect of adding rivals is isolatable; **through-fares in Phase 3 for everyone at once** (§3.5) — it changes your own connecting share too, and should be measured on its own.
3. **The gateway pool.** Delete it once real interline feed exists, or shrink it to "the world beyond the 70 modeled carriers"? **Shrink, then decide with playbot numbers** (§4 Phase 2). 70 AI airlines with ≤30 routes each cannot represent the real world's feed at LHR; a zero pool over-corrects.
4. **Rollout in live Headwinds worlds.** This is a revenue cut mid-season for every player. **Ship behind `tickConfig.rivalItineraries`, on for new worlds, and turn existing worlds on by hand with a news-feed notice** — the `crewPipeline` / `gateScarcity` template. Tailwinds: on for every game, with a devlog entry.
5. **Golden-master rebaseline.** Required for Phase 1. Stated balance change: *rival one-stop itineraries now compete in every passenger market.*

---

## 1. The idea

Today the only airline in the game that sells a connection is you. Every rival — 70 AI carriers and every human in a Headwinds world — flies point-to-point as far as the demand model is concerned. Rival hubs exist only as three fudges (§2.2). The result is the asymmetry players feel without being able to name it:

- Your thin nonstop with no rival on the exact pair is a **monopoly pool** — 95% load factors in the era sweep, "cargo uncontested" in the August audit, the same structural complaint every time.
- Your connection over a hub competes against rival *nonstops* and a generic outside option, never against United-via-ORD. Hubs feel underpowered (the airport card's "Transit Pool 160") and overpowered (nobody contests your itineraries) at the same time.

The change: **one itinerary model for everyone.** For every O&D market the tick evaluates, the offer set becomes {your nonstop, your one-stops over your hubs, rival nonstops, rival one-stops over their hubs, partner-fed itineraries, outside option}, all through the one logit (`computeMarketShare`) that already books passengers. Realism first, then depth: once the world flies connections, hub-building decisions (banks, through-fares, circuity) have something to be decisions *about*.

---

## 2. What already exists (audited 2026-09-05)

| Thing we need | Already there? | Where |
|---|---|---|
| A logit market model every offer goes through | **Yes** — 8-term utility, leisure/business softmaxes, capacity cap | `demand.js:704-770` (`computeUtility`), `:891` |
| The player's own one-stops as real offers | **Yes** — `__own_conn__N` over designated hubs, vs own nonstop (logit split), rival nonstops, outside option | `network.js:980-1220` |
| Partner-fed itineraries (alliance/codeshare/JV) as offers | **Yes** — `__player_conn__N`, mileage prorate | `network.js:475-740` |
| A directional-leg shape for another carrier's route | **Yes** — `buildPartnerRoutes` emits `{origin,destination,routeKey,weeklyFrequency,price,owner,partnerId}` | `network.js:278-313` |
| Rival nonstops indexed by O&D once per tick | **Yes** | `network.js:540-552` (`competitorRouteIndex`) |
| A single choke point where rival offers enter a player market | **Yes** — `rivalOffersFor` (single-aircraft AND metro-lane paths) + its preview twin | `simulation.js:1616-1638`, `:4013-4019`; `pairShare.js:186-213` |
| Rival hubs | **Partly** — AI: `homeHub` + earned `secondaryHub` (≥10 routes, ≥4 touches). Human: `homeHub` only in the rival view; **no `hubs` map exported** | `competitorAI.js:541-553`; `humanRivals.mjs:246-337` |
| Connection penalty by hub tier | **Yes** — `HUB_TIERS[t].connPenalty` .48/.38/.32/.26 | `demand.js:1246-1322` |
| Connecting seat fraction by tier, load factor, assumed seats | **Yes** — `{0:.10,1:.15,2:.18,3:.22}`, 0.85, 180 | `network.js:1168`, `:137`, `:127` |
| Projection ↔ tick agreement test | **Yes** — extend, don't fork | `tools/projection-tick-agreement-test.mjs` |
| Battle card with per-rival rows + hints | **Yes** — price/quality/freq/seats/share + awareness warning | `Competition.jsx:620-712`, `:796-850` |
| Per-world feature flag template | **Yes** — `tickConfig.crewPipeline` / `gateScarcity` | `worldConfig.mjs`, `worldService.mjs` |
| Playbot for before/after | **Yes** | `tools/playbot-era.mjs` |
| A prior design note for rival connections | **No.** Closest: hub-redesign Feature C, *"AI reciprocity (cheap version) … a later iteration"* | `docs/hub-redesign-design.md:118-120` |

### 2.1 What a player nonstop competes against today
`simulateRoute` → `buildRouteMarket` → `computeMarketShare([player, ...rivalOffersFor()])`. `rivalOffersFor` (`simulation.js:1616`) admits: AI carriers with `routes[key]` on the **exact sorted pair**, encroachment specs, human-rival specs. **No outside option** on this path (`buildOutsideOptionOffer` is used only by the two connecting-market functions, `network.js:709`, `:1201`). **No connecting itinerary of any rival, anywhere** — grep of connecting offer ids across the engine returns exactly `__player_conn__`, `__own_conn__`, `__outside__`.

### 2.2 The three fudges that stand in for rival hubs
1. `connectivityBonus` on a rival's **nonstop** offer when the pair touches its `homeHub`/`secondaryHub` (`demand.js:689`, `buildCompetitorOffer` `:3114-3178`) — an abstract "they have feed" utility bump, not a routing.
2. `hubContestMap.contestFactor` (`network.js:896-925`) — presence weights shrink **your external pool** at a contested hub.
3. Outside option raised by `0.15·ln(1+maxCompWeight/10)` in **your** connecting markets (`network.js:1194-1203`).
All three go when real rival itineraries exist (1 partially — see §3.4).

### 2.3 The external pool
`connectingAtEndpoint` (`demand.js:1527-1600`): `pool = AIRPORT_GATEWAY_SCORES[code] × 800`; at your hub `externalPax = pool × captureRate × (0.075 + distBonus) × (1+partnerBoost) × freqMult × congestion × contestFactor`. Priced at the route's own fare, booked onto the route, capacity-coupled (`simulation.js:4225-4288`). It is *the* representation of "other people's passengers connecting onto you". It is also what the airport card calls "Transit Pool".

### 2.4 Sizing the enumeration
70 AI carriers (`demand.js:1122`), caps 22–30 routes (`competitorAI.js:73`), so ≈1,500–2,000 rival legs world-wide; each carrier has ≤2 hubs. Candidate rival one-stops ≈ Σ C(spokes,2) ≈ 100–400 per carrier ≈ 10–25k world-wide — but we never enumerate those. We need rival one-stops **only for O&Ds the player's tick evaluates**: player routes (50–300) + own-metal markets (≤150/hub) + partner markets ≈ ≤1,500 O&Ds. Lookup per O&D = for each rival, for each of its hubs H: `legs[H].has(A) && legs[H].has(C)` ≈ 140 set probes. ≈ 200k probes per airline-tick. Negligible against the logit work already done. Headwinds ticks every airline; the index is per airline (its `competitors` excludes itself) but is built from the same shared rival views — build once per world tick, filter per airline.

---

## 3. Mechanism

### 3.1 Rival leg index (`network.js`)
```
buildRivalHubIndex(competitors) → Map<competitorId, {
  tierAt: Map<hubCode, tier>,               // §3.2
  legs:   Map<hubCode, Map<spokeCode, { freq, price, seats, aircraftType }>>,
}>
```
Built once per tick in `runNetworkTick`, returned beside `competitorRouteIndex`. `price = refPrice(leg) × priceMultiplier` (or `economyFare` for humans); `seats = frequency × (aircraftType?.seats ?? TIER_SEAT_TARGET[tier])`.

### 3.2 Which rival airports are connection points, and at what tier
Declared hubs only (decision 1). AI: `homeHub`, `secondaryHub`. Human: every key of their `hubs` map (exported in Phase 5; until then `homeHub`). Tier by spoke count at that airport using **the player's own** `HUB_TIERS[t].routesRequired` (4 / 20 / 50): <4 → not a connection point; 4–19 → tier 1; 20–49 → tier 2; ≥50 → tier 3 (unreachable for AI at a 30-route cap; reachable for humans, who then use their *actual* designated tier). Focus-city tier 0 for AI: none. The tier sets `connPenalty`, seat fraction, quality bonus — exactly the player's table.

### 3.3 The rival one-stop offer
`buildRivalConnectionOffer(rival, hub, tier, legIn, legOut, market)` → `AirlineOffer`:
- `airlineId: '__rival_conn__<rivalId>__<hub>'` — distinct from the rival's nonstop so shares attribute per routing; the UI sums by rival.
- `economyPrice = legIn.price + legOut.price` (decision 2, Phase 1); `businessPrice = × BUSINESS_PRICE_MULTIPLIER`.
- `weeklyFrequency = min(legIn.freq, legOut.freq)`; `economySeats = round(min(leg seats) × seatFraction[tier])`; business seats 13% of that (mirrors `network.js:1168-1176`).
- `qualityScore = rival.baseQualityScore + qualityBonus[tier]/2` — the same "+bonus/2" the player's own-metal gets (`network.js:1177`). **Not** `CONNECTION_QUALITY_SCORE` (58): that constant was a stand-in for an anonymous connection; a named rival brings its own quality.
- `connectivityBonus = −connPenalty[tier]` (raw, unweighted, as today for `__own_conn__`).
- `brandReach`, `loungeAppeal`, `marketingBoost`: what `buildCompetitorOffer` gives the same rival's nonstop.
- Skipped when the rival flies the pair nonstop (its nonstop already speaks; a carrier does not compete with itself here — matches how the player's `directExists` split is handled inside the itinerary, not as two offers). Skipped when `hub ∈ {A, C}`.

### 3.4 Where the offers enter
1. **Player nonstop markets** — `rivalOffersFor(competitors, specs, market, rivalIndex)` appends rival one-stops for the market's O&D. Both call sites (`simulation.js:1627`, `:4017`) and the preview twin `buildRivalPairOffers` (`pairShare.js:186`) — the projection-tick agreement test guards that they stay identical.
2. **Own-metal markets** (`computeOwnMetalODRevenue`, `network.js:1191`) and **partner markets** (`computePartnerODRevenue`, `:705`) — same append, next to the competitor nonstops.
3. **Retire fudges 2 and 3** (§2.2) in the same phase: the outside-option `compWeight` bump would double-count. `contestFactor` on the external pool stays until Phase 2 (the pool is still the only representation of feed *onto* you). Fudge 1 (`connectivityBonus` on rival nonstops) stays — it models feed *behind* their nonstop, which a one-stop offer does not.
4. **Fare compression** (`demand.js:63-64`, −5%/extra carrier, floor 0.90): rival one-stops **do not** count as extra carriers in Phase 1. Their effect is share only. Revisit with numbers.

### 3.5 Phase 3 — itinerary quality (everyone at once)
- **Circuity:** `circ = (d(A,H)+d(H,C)) / d(A,C)`; `connectivityBonus −= CIRCUITY_WEIGHT × min(circ−1, 1.0)`. A backtracking connection (LAX→JFK→SFO) is priced as the bad product it is; an on-the-way one is barely touched. Applies to `__own_conn__`, `__player_conn__`, `__rival_conn__`.
- **Through-fares (decision 2):** `economyPrice = min(legIn+legOut, refPrice(A,C) × THROUGH_FARE_INDEX)` for every connecting offer. Real carriers price connections against the nonstop market, not additively; today sum-of-legs on a triangle is structurally above the nonstop reference, which is part of why connections are weak. This raises *your* connecting share too — it is a deliberate balance change and gets its own playbot run.
- **Weak-leg frequency** already binds (`min` freq). Elapsed-time / bank timing: deferred (§7).

### 3.6 Phase 2 — feed onto you, from real legs
Extend `buildAllConnections` (`network.js:475`) so a **non-partner rival leg** can be the other half of an itinerary with a player leg at a player hub, `partnershipType: 'interline'` (penalty .75, prorate floor .38 — both constants already exist, `network.js:53-84`). This is what the gateway pool has been approximating. Then `BASE_GATEWAY_POOL` becomes "the world beyond modeled carriers": scale by `GATEWAY_RESIDUAL` (start 0.5) and let the playbot say whether 0.5, 0.25 or 0 is right (decision 3). The airport card's "Transit Pool" becomes the residual plus a real "feed from other carriers" figure.

---

## 4. Phases

Each phase: failing test first, both repos in lockstep (engine in `packages/engine/src` ↔ Tailwinds `src/`), `PARITY OK` or a stated rebaseline, `npm test` green (modulo the sandbox-only adsense failure).

**Phase 0 — measure before touching anything.**
`tools/rival-itinerary-probe.mjs` (`@not-a-test`): on a seeded classic solo game at week 52 and week 156, and on the era-sweep worlds, report (a) share of player nonstop markets with zero rival offers, (b) how many of those would gain ≥1 rival one-stop under §3.2, (c) index build time and probes per tick, (d) the same for own-metal markets. Numbers go into this file under BUILD STATE. Cheap, and it decides whether Phase 1 is a nudge or an earthquake.

**Phase 1a — spill recapture in `computeMarketShare`.** When an offer is capacity-capped, its unserved leisure and business demand is re-allocated among the *uncapped* offers pro rata to their softmax shares, iterating until no new offer caps (≤ #offers rounds). The outside option (infinite seats, connecting markets only) absorbs spill like any other offer — "the field" carries them. In direct markets with every carrier capped, demand is genuinely lost (no seats, no trip). `leisurePaxUncapped` keeps its meaning for the load models: demand generated for this offer *including spill received*. Own golden rebaseline (stated: *capped carriers no longer destroy the demand they cannot carry*), own playbot before/after, own test (`tools/spill-recapture-test.mjs`: conservation — Σ carried ≤ Σ generated, and equality when any offer has room; a monopoly result is untouched; a capped rival hands its excess to the player and vice versa).

**Phase 1b — rival one-stops as real offers.** §3.1–3.4, **plus a hard circuity cap `MAX_CIRCUITY = 1.5`** (Phase 0 finding 1).
- Files: `network.js` (index, offer builder, both connecting-market inserts, remove outside-option bump), `simulation.js` (`rivalOffersFor` signature + both call sites; thread `rivalIndex` from `runNetworkTick`), `pairShare.js` (twin), `reducer.mjs` / `worldConfig.mjs` (`rivalItineraries` flag, decision 4).
- Tests: `tools/rival-itinerary-test.mjs` — circuity cap excludes a backtracking routing; a thin player nonstop A–C with a rival hub at H flying A–H and H–C loses share vs the same world without the hub; a rival that flies A–C nonstop contributes exactly one offer; tier from spoke count; `hub ∈ {A,C}` skipped; offers identical between tick and `pairMarketShare` (extend projection-tick agreement); golden master **rebaselined with the stated reason**.
- Playbot: classic + 1950, 2 years, before/after — yr-1 profit, mean LF, % routes contested, own-metal revenue.

**Phase 2 — feed onto you from real legs; shrink the pool.** §3.6. Tests: an interline itinerary rival-leg→player-leg forms at a designated hub and not at an undesignated one; `hubExternalPax` accounting still feeds `hubThroughput`; playbot decides `GATEWAY_RESIDUAL`.

**Phase 3 — itinerary quality.** §3.5. Tests: circuity monotone; through-fare never above sum-of-legs; symmetric across the three connecting offer kinds. Own playbot run.

**Phase 4 — show it.**
- Battle card (`Competition.jsx:620-712`): a **"via HUB"** column per rival routing, share attributed by `airlineId` prefix; hint *"United's connection over ORD takes 34% — you're competing with their hub, not their nonstop."*
- `RouteDetail.jsx` `competitorsOnRoute`: include one-stop rivals with the hub named.
- `AirportDetail.jsx` Passenger Flows "Competitors" column: nonstop vs *via X*.
- `HubManagement.jsx` contest block: which rival hubs feed the markets you connect.
- Wiki + `route-economics.html` / `hub-strategy.html` (both public sites), devlog. SSR-render the real components in the tests.

**Phase 5 — Headwinds.** `humanRivals.mjs` `toHumanCompetitor` exports `hubs` (code → tier) beside `homeHub`; `tickService` builds the rival hub index once per world tick; log index build time in the existing `committed in Nms` line; `rivalItineraries` flag in `createWorld` + the world-settings UI. Verify tick time on the largest live world before flipping it.

**Phase 6 — AI reciprocity (only if the numbers ask for it).** `competitorAI.js` already earns a `secondaryHub`; it never *uses* one. With Phase 1, its spoke count at a hub finally matters, so "add a spoke where the player's one-stop wins" is a two-line growth-rule change. Deferred until Phases 1–3 have settled.

---

## 5. Balance protocol

- Playbot before/after per phase, same seeds, classic and 1950. Report yr-1/yr-2 profit, LF, contested-route %, own-metal revenue, hub throughput. Expected Phase 1 direction: thin nonstops touching a rival hub lose 10–30% share; long-haul between two rival hubs loses more; your own connections lose a little at contested hubs, nothing at uncontested ones.
- Era-balance test bands (`tools/era-balance-test.mjs`) will move — retune bands only with the playbot numbers in hand, never to make the test pass.
- Golden master: rebaseline at Phase 1a, again at Phase 1b, again at Phase 3. Phase 2 and 4 must be `PARITY OK` (2 changes the pool only when `GATEWAY_RESIDUAL ≠ 1`, so land the mechanism at 1.0 first, then the constant as its own stated change).

## 6. Risks

- **Explainability.** The brand-awareness episode: a player loses to something the UI doesn't name and blames fares. Phase 4 is not optional polish; ship it with Phase 1 in the same deploy.
- **Human-rival double counting** in Headwinds: a human present both in `competitors` and as a spec is de-duped for nonstops (`simulation.js:1622`); one-stops come only from the `competitors` entry. Test it.
- **Metro lanes** (`simulation.js:3868-4024`): rival one-stops must enter the pooled lane market once per rival routing, not once per sibling pair. Enumerate against the lane's canonical O&D.
- **Era worlds**: rival hub tiers derive from spoke counts, so a 1950 rival with 6 routes is a tier-1 hub. Fine — but check the propliner-era playbot separately.
- **State size**: nothing new persisted except a bounded `rivalConnections` summary on `lastReport` for the UI (per-hub round-robin, the trim rule from the Barca fix).

## 7. Deferred, deliberately
Two-stop itineraries; bank timing / MCT as a player lever; elapsed-time utility; AI carriers selling *your* feed (interline from you onto them); cargo contest (separate audit item, same shape).
