# Cargo has no price ceiling — audit, 2026-08-27

**One sentence:** passenger fares are disciplined above reference by two chokes; the
cargo path calls neither, so freight yield is a free variable and the profit-maximising
price is 2.6x–4.0x reference with the freighter still full.

**Trigger:** Singapore Airlines in *Heavy Landing* (Y1 W27) sitting on $257.7M cash and
SVPS $11.98 against a #2 on $19.8M / $2.60, from 10 leased aircraft and 7 routes.

**Decision needed from Dave:** which fix (§6), and whether to clamp existing yields on
deploy (§8). Nothing in this doc is implemented.

---

## 1. What the leader actually did

| | Singapore Airlines | Asteria Air (#3) |
|---|---|---|
| Aircraft | 10, all leased | 17 |
| Routes | 2 pax + 5 cargo | 60 pax |
| Weekly revenue | $40.0M | $13.6M |
| Weekly profit | **$16.3M** | $0.45M |
| Cash, Y1 W27 | $257.7M | $2.6M |

74% of their revenue is freight. Their cash curve: ~$4.4M/wk profit on two A330s for
weeks 1–6, first MD-11F in week 7, $16M/wk by week 18.

They are **not** exploiting the passenger game. Their economy fares are exactly
`referencePrice()` on both routes ($864 SIN–CDG, $501 SIN–DXB). The entire edge is on
the freight side, and it was found by brute force: **236 `UPDATE_CARGO_YIELD` decisions**
in the decision log, walking yields in $0.02 steps until load factor started to move.

Their SIN–DXB freighter charges **1.926 against a reference yield of 0.753 — 2.56x — and
still fills to 77%.**

## 2. What is NOT broken: passengers

Worth stating plainly, because it was my first (wrong) read. In a restricted world the
pax model behaves exactly as designed. Sweeping their SIN–CDG A330 with the world's real
settings (`newWorldRestrictions: true`, `fareIndex: 0.95`):

| fare vs reference | 0.75x | 1.0x | **1.1x** | 1.25x | 1.5x | 2.0x |
|---|---|---|---|---|---|---|
| passengers | 994 | 994 | 994 | 994 | 42 | 0 |
| weekly profit | $2.44M | $3.67M | **$4.16M** | $3.24M | −$0.67M | −$0.94M |

Profit peaks at 1.1x reference and demand is gone by 1.5x. That is `nwrYieldChokeFactor`
doing its job. (Careful when sweeping: `_nwrYieldChoke` is module-scoped and defaults to
**false** on a fresh import, so any harness that doesn't call `setNwrYieldChoke(true)`
silently measures a classic world and reports a cliff that isn't there.)

## 3. The mechanism

Passenger demand above reference passes through **two** multipliers, both in
`models/demand.js → priceChokeFactor()`:

1. a convex cap — `1 − t²`, `t = (ratio−1)/(PRICE_CAP_MULTIPLE−1)`, hitting exactly zero
   at `PRICE_CAP_MULTIPLE = 3`. Applies in classic worlds too.
2. `nwrYieldChokeFactor(ratio, quality)` from `utils/market.js` — an extra
   `exp(−15·(ratio − threshold))` above a quality-scaled threshold of 1.10x (quality ≤50)
   to 1.25x (quality 100). Restricted worlds only.

The header comment on (2) describes this exact exploit and why the choke exists:

> the fare equilibrium ("raise fares until the post-elasticity pool shrinks to my
> capacity") lands at 1.3-3x reference with the aircraft still full. Real airlines can't
> live there because a rival undercuts within a season; this choke stands in for that
> missing rival.

**Cargo calls neither.** `simulateCargoRoute()` (simulation.js line 2524) and the pooled
path in `cargoLaneAllocations()` (line 2731) both compute demand as nothing but

```js
const elasticity = Math.min(1.6, Math.pow(refYield / yieldPrice, CARGO_YIELD_ELASTICITY));
```

with `CARGO_YIELD_ELASTICITY = 1.1`. A power law with no floor: at 2.56x reference it
still returns 0.356, and since the gravity pool on a trunk lane is 3–7x one freighter's
weekly payload, cutting the pool to a third costs nothing at all. The aircraft is still
oversubscribed, so the higher rate is banked on every tonne.

`grep -rn "nwrYieldChokeFactor" packages/` returns exactly one call site: the pax path.

**The demand pools, for scale** (month 6, one MD-11F at 6x weekly = 546 t capacity):

| lane | pool t/wk | capacity t/wk | oversubscription |
|---|---|---|---|
| SIN–DXB | 1,696 | 546 | 3.1x |
| SIN–PVG | 1,922 | 728 | 2.6x |
| SIN–NRT | 1,841 | 546 | 3.4x |

Same shape on the pax side: SIN–CDG carries 7,547 weekly demand against 1,059 seats
offered (7.1x), SIN–DXB 14,803 against 2,118 (7.0x). Pricing power is only bounded by
the chokes, and freight has none.

## 4. The profit curve, measured

SIN–DXB, MD-11F at 6x weekly, restricted world, straight through `simulateCargoRoute()`
with the world's real settings:

| yield vs ref | 1.0x | 1.5x | 2.0x | 2.56x | 3.0x | 3.5x | 4.0x |
|---|---|---|---|---|---|---|---|
| tonnes | 507 | 506 | 500 | 481 | 452 | 407 | 359 |
| load factor | 0.93 | 0.93 | 0.92 | 0.88 | 0.83 | 0.75 | 0.66 |
| weekly profit | $2.52M | $4.49M | $6.38M | $8.18M | $9.16M | $9.70M | **$9.81M** |

Monotonic to 4x and still climbing. There is no cliff on this curve because nothing
ever forces demand to zero. Across five representative lanes the profit-maximising
yield sits at **2.6x–4.0x reference**, worth **2.3x–3.8x** the profit of pricing at
reference (§6 table).

## 5. This is already spreading

All cargo routes in running worlds, priced against their own reference yield:

| yield vs reference | routes |
|---|---|
| ≤ 1.0x | 131 |
| 1.0–1.25x | 45 |
| 1.25–1.5x | 32 |
| 1.5–2.0x | 39 |
| 2.0–3.0x | 7 |
| > 3.0x | 5 |

**83 of 259 live cargo routes (32%) are priced above 1.25x reference**, spread across
**ten airlines in four of the six running worlds** — Singapore Airlines, Air Caldor,
Otter Air, British Airways, Axo Air, Air Asia Pacific, ANA, Air France, Royal Airways
and Drunken Jew Air, in Heavy Landing, Scarce Assets, Lunar Gateway and Cobalt Meridian.
The worst is Air Caldor's JFK–ATL at **5.18x**. The clustering of
exact 2.00x values suggests players are sharing the trick, not each rediscovering it.

**Where it actually hurts is year 1.** In *Scarce Assets* (classic, Y17) cargo is only
9–23% of the top airlines' revenue — mature pax networks out-scale it. The damage is
early-game: freight needs no route network, no reputation, no loyalty ramp and no
awareness build, so a player who finds the yield ceiling compounds away from the field
before anyone else has a second aircraft. Heavy Landing is that, live.

## 6. Options

| | what it does | optimum yield after | verdict |
|---|---|---|---|
| **A. Wire the existing chokes into cargo** | cargo demand gets `1−t²` + `nwrYieldChokeFactor`, same as pax | **1.10–1.15x ref** | **recommended** |
| B. Segmented willingness-to-pay pools | replace the power law with fare/yield bands so LF degrades smoothly with price | tunable | right long-term model, wrong first move — see below |
| C. Cargo-only cost/capture changes | drop `FREIGHTER_CAPTURE_RATE` below 1.0, add belly cargo, thicken cargo costs | unchanged | doesn't touch pricing; the exploit survives at lower volume |
| D. Hard cap in the UI | refuse yields above N x reference in the planner | n/a | server must enforce it anyway, so it's A with a worse error message |

**Why not B first**, despite it being what I recommended before reading the code: the
codebase already contains the intended discipline mechanism, with a written rationale,
tests and a quality-scaled threshold. Cargo simply doesn't call it. Building a new
demand model to solve a problem the existing model already solves is a lot of risk for
no additional correctness. B remains the better *eventual* model — it would let load
factor fall smoothly with price instead of via an exponential penalty, and would replace
both chokes with one mechanism — but it should be a deliberate demand-model project with
a golden-master rebaseline, not this week's balance fix.

Measured effect of A, profit-maximising yield as a multiple of reference:

| lane | today | with A (restricted) | premium today | premium with A |
|---|---|---|---|---|
| SIN–DXB, MD-11F | 3.95x | 1.15x | 3.81x | 1.18x |
| JFK–LHR, 747-400F | 2.90x | 1.10x | 2.73x | 1.16x |
| JFK–ATL, 757-200PF | 2.60x | 1.10x | 2.30x | 1.15x |
| SIN–PVG, MD-11F | 3.40x | 1.10x | 3.09x | 1.14x |
| CDG–DXB, 777F | 3.50x | 1.10x | 3.01x | 1.13x |

"premium" = profit at the optimum ÷ profit at reference. A collapses the reward for
gouging from ~3x to ~1.15x, and leaves a real but modest edge for pricing slightly
above reference — which is the intended shape.

## 7. Recommended implementation (A)

**New in `models/demand.js`**, beside `priceChokeFactor`:

```js
export const CARGO_PRICE_CAP_MULTIPLE = 3;   // mirror PRICE_CAP_MULTIPLE

export function cargoPriceChokeFactor(yieldPrice, refYield, quality = 50) {
  const ref = Math.max(refYield, 0.01);
  const ratio = yieldPrice / ref;
  if (ratio <= 1) return 1;
  if (ratio >= CARGO_PRICE_CAP_MULTIPLE) return 0;
  const t = (ratio - 1) / (CARGO_PRICE_CAP_MULTIPLE - 1);
  return Math.max(0, 1 - t * t) * nwrYieldChokeFactor(ratio, quality);
}
```

**Three call sites**, all in `utils/simulation.js`:

1. `simulateCargoRoute()` — multiply the solo-path `elasticity` by the new factor.
2. `cargoLaneAllocations()` — same, on each route's own `elasticity` in the group loop.
3. `cargoLaneAllocations()` rival weighting — apply it to `rivalElast` too, so a rival
   gouging at 3x reference correctly dilutes the lane by nearly nothing.

**Design notes:**

- *Cap multiple.* Kept at 3 to mirror pax. It barely matters in restricted worlds — the
  exponential term dominates and the optimum lands at 1.10–1.15x whether the cap is 2.0
  or 3.5 (measured). It matters only in classic worlds, see below.
- *Quality input.* Freighters have no cabin, so v1 passes the default `quality = 50`
  (threshold 1.10x). If a freighter should be able to earn pricing headroom the way a
  premium cabin does, the natural input is the on-time rate `laborEffects()` already
  computes on the pax path — forwarders genuinely buy reliability. Flagged, not built.
- *Classic worlds.* The exponential term is restricted-worlds-only, so in classic the
  convex cap alone still leaves an optimum at 1.65x–2.05x reference (premium 1.9x–2.6x).
  That is
  the same weakness classic pax already has — classic is documented in-repo as "the old
  arcade model" — so this is consistent rather than a new hole. If you want classic
  tightened too, the lever is `CARGO_PRICE_CAP_MULTIPLE = 2`, which pulls the classic
  optimum to 1.45x–1.65x. **Decision for Dave.**
- *Back-compat.* The convex half is not NWR-gated, so cargo numbers change in classic
  worlds and in Tailwinds. The golden master will need a rebaseline and Tailwinds a
  balance pass. If you'd rather keep classic byte-identical for now, gate the whole
  cargo choke behind `getNwrYieldChoke()` — every world created since the NWR default
  flip has it on, so the fix still lands where new players are.

**Tests** (all exist, all need extending): `test:cargo`, `test:cargo-contest`,
`test:nwr`, `test:metro-lanes`. New assertions worth adding — a route priced at or below
reference is bit-identical to today; profit is non-monotonic in yield with a maximum
below 1.25x in a restricted world; the lane-pool conservation invariant ("every route
priced at reference sums back to the lane pool") still holds; a gouging rival dilutes a
contested lane less than a reference-priced one.

## 8. The live-world question

The choke is savage where it bites: at 2.56x reference in a restricted world the factor
is `exp(−15 × 1.46) ≈ 3e-10`. Singapore Airlines' freight network would go to **zero
tonnes** the tick after deploy.

Routes that would be affected on a straight deploy, by airline:

| world / airline | restricted? | cargo routes | above threshold | cargo as % of revenue |
|---|---|---|---|---|
| Heavy Landing / Singapore Airlines | yes | 5 | **5** | 74% |
| Scarce Assets / Air Caldor | no | 80 | 3 | 23% |
| Scarce Assets / Air France | no | 6 | 1 | 7% |
| Scarce Assets / Royal Airways | no | 2 | 1 | 100% |

Only 10 routes, but for one player it is their whole airline. They found a legal edge in
a shipped model; they didn't cheat. **Recommendation:** on deploy, clamp every existing
cargo route's `yieldPrice` to its threshold (`1.10 × cargoReferenceYield` in restricted
worlds, `CARGO_PRICE_CAP_MULTIPLE × ref` in classic) as a one-shot migration, and post a
world news item explaining the rate correction. Nobody's network dies overnight, revenue
normalises over a few ticks, and the fix isn't a punishment. A backfill script in
`apps/headwinds-server/tools/` following the pattern of `rebase-world-fare-index.mjs` is
the natural shape.

Leaving Heavy Landing's result standing is defensible either way — it's an alpha world —
but worth a deliberate call rather than a default.

## 9. Open questions

1. Option A as specced, or A gated behind NWR to keep classic and Tailwinds untouched?
2. `CARGO_PRICE_CAP_MULTIPLE` — 3 (mirror pax) or 2 (also tighten classic)?
3. Clamp existing yields on deploy, or let the choke bite?
4. Should freighters earn pricing headroom from on-time performance, or stay at the
   flat quality-50 threshold?
5. Does the cargo planner UI surface the reference yield? If not, players are tuning
   blind against a rate they can't see — which is how you get 236 probe decisions.

---

*Evidence gathered live from the production Postgres (`Decision` table, airline state
blobs) and by sweeping the engine directly. Reproduction notes are in project memory
under `headwinds-price-cliff-cargo`.*

---

## 10. Built, 2026-08-27 — option A, on disk, not yet committed

Implemented as specced in §7, with one correction to what §7 claimed.

**Engine**
- `models/demand.js` — new `CARGO_PRICE_CAP_MULTIPLE` (3, mirroring `PRICE_CAP_MULTIPLE`)
  and `cargoPriceChokeFactor(yieldPrice, refYield, quality = 50)`.
- `utils/simulation.js` — the factor multiplied into the elasticity at all three sites:
  `simulateCargoRoute()` solo path (line 2530), `cargoLaneAllocations()` group loop
  (2743), and the `rivalElast` weighting (2725) so a rival pricing itself out of the
  market no longer dilutes a contested lane.

**Correction to §7's back-compat claim.** §7 said classic worlds and Tailwinds would stay
byte-identical. That is true at or below reference, where the choke returns exactly 1 —
but the convex `1 − t²` half is not NWR-gated (it isn't on the passenger side either), so
classic cargo priced *above* reference does change: the classic optimum moves from
2.6x–4.0x to **1.65x–2.05x** reference, and freight demand now reaches zero at 3x like
fares do. That is deliberate — a classic world where fares have a ceiling and freight has
none is what produced Air Caldor's 5.18x route — but it is a balance change, and
**Tailwinds carries its own copy of the engine (`src/utils/simulation.js`), so the port
there is a separate decision.**

**UI** — the ceiling is now legible instead of brute-forced:
- `CargoRoutesList.jsx` — the yield stepper (where the 236 probe decisions came from)
  shows `1.49× ref · −18% freight` beside the rate, coloured, with a tooltip naming the
  going rate and the zero point.
- `CargoRoutePlanner.jsx` — a warning under the yield slider quoting the forfeited
  freight. Both call `cargoPriceChokeFactor` directly, so the number shown can never
  drift from the number the tick charges.

**Migration** — `apps/headwinds-server/tools/clamp-cargo-yields.mjs`
(`npm run clamp:cargo-yields`), dry-run by default, `--list` / `--all` / `--write`.
Clamps yields above the ceiling down to it, bumps `version` so clients refetch, and
writes a `freight_rate_correction` news row per affected airline (rendered in
`News.jsx`). Dry run against production today: **15 routes across 5 airlines** —
Singapore Airlines 5/5 in Heavy Landing, Air Caldor 6/80, Royal Airways 2/2, Axo Air
1/11 and Air France 1/6 in Scarce Assets. Everything else is already at or below
its ceiling.

**Run the clamp BEFORE deploying the engine change.** Measured on Singapore Airlines'
live network:

| | weekly cargo profit |
|---|---|
| today (no choke) | +$23.0M |
| choke deployed, yields untouched | **−$6.0M** — freighters fly empty and still burn crew, fuel and lease |
| choke deployed, yields clamped first | +$14.7M |

**Tests** — 49 pass in `test:cargo` (10 new, section 9), 81 in `test:nwr` (4 new),
10 in `test:nwr-default` (2 new, asserting the whole createWorld → tickConfig →
blob → `setNwrYieldChoke` → freight chain from the default). Full chain: 138 pass,
1 environmental failure (`adsense-readiness-test` regenerates
`apps/headwinds-web/public/` and cannot unlink through the session's file bridge —
unrelated, passes locally).

Two footguns found while writing the tests, both now commented in place:
`cargoLaneAllocations` needs an explicit `gameDate` or it scores the lane in a
different month than `simulateCargoRoute` does and the pool-conservation invariant
looks 4% broken; and `setNwrYieldChoke` is module-scoped, so any test that sets it
must restore it or every later test in the file silently runs in a restricted world.
