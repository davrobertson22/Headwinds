# Private-company share price — diagnosis and fix options

**Status:** **BUILT** 2026-07-29 — options A, B and C all implemented, on disk, uncommitted.
Full Headwinds suite green (38 suites), golden master re-baselined, new `tools/private-valuation-test.mjs`
(14 tests) wired into `npm test` and verified to FAIL against the pre-fix engine at `HEAD`.
**Raised:** 2026-07-29, Discord (Kat the Fox).
**Repos affected:** Headwinds only (Tailwinds has no stock market).

---

## 1. The report

A rival airline — **Air Chicago**, hub ORD, still marked **Private** — displayed:

| Field | Value |
| --- | --- |
| Share price | **$0.5793** |
| Weekly move | **+8383.2%** |
| Market cap | **$57.93M** |
| Cash | $22.82M |
| Weekly profit | +$1.53M |
| Weekly revenue | $5.67M |
| Quality | 62 / 100 |
| Fleet / routes | 2 aircraft (378 seats) / 3 routes |

> "their hypothetical stock is more valuable than mine and this is their company"

Two distinct complaints are bundled here, and both are legitimate:

1. A **+8383.2% weekly move** is impossible under the documented rules — the Markets tab tells players prices move at most ±20% a week.
2. A **2-aircraft startup outvaluing an established listed airline**, while not even being on the market.

---

## 2. Root cause

### 2.1 Private airlines bypass price smoothing entirely

`packages/engine/src/reducer.mjs`, weekly tick, ~line 3673:

```js
prevMarketCap: (state.equity?.isPublic === false) ? null : (state.marketCap ?? null),
```

Passing `prevMarketCap: null` selects the **cold-valuation branch** of `computeMarketCap`
(`packages/engine/src/utils/market.js`, ~line 843):

```js
let marketCap;
if (Number.isFinite(prevMarketCap) && prevMarketCap > 0) {
  // converge 30% toward fair value, clamp to moveClampFor(), apply noise
} else {
  marketCap = fairValue;          // ← private airlines land here, every single week
}
```

So a private airline **republishes its raw, unsmoothed fair value every week**: no `CONVERGENCE`
(0.30), no `moveClampFor` band (8% resting, widening to 35%), no `NOISE_PCT`. Meanwhile every
listed airline is held to that band.

The existing comment explains the intent, and the intent is correct:

> A PRIVATE airline has no market, so there is no market price to smooth: publish its fair value
> straight. That is what makes the IPO price honest — pricing the listing off a smoothed series
> that had been chasing a fast-growing fair value for years meant floating a quarter of the
> company for a rounding error.

The defect is not the reasoning. It is that this **internal, unsmoothed valuation is also what
gets published to every other player** as a share price, a weekly move %, and a sparkline.

### 2.2 The $0.0050 floor is what makes the percentage explode

```js
MIN_MARKET_CAP: 500_000        // VALUATION, market.js
TOTAL_SHARES:   100_000_000    // founder count, every airline
```

→ floor share price of exactly **$0.0050**.

A leveraged startup has **negative net book** for its first weeks — cash spent on down-payments,
`debt` exceeding `creditedCash + 0.90 × fleetNAV`. Both fair-value terms
(`BOOK_WEIGHT × netBook + earningsValue` and `BOOK_FLOOR × netBook`) go negative, so `fairValue`
clamps to `MIN_MARKET_CAP` and the airline sits **pinned at $0.0050**.

Then `MIN_EARNINGS_WEEKS = 4` lets the earnings term switch on, the confidence ramp
(`EARNINGS_CONF_POW = 2`) starts biting, and the whole valuation teleports in a single tick —
with no clamp to slow it down, because it is private.

`+8383.2%` is a factor of **×84.83**, implying a prior print of **~$0.0068** — a hair above the
floor, consistent with the very first week the earnings term contributed anything.

### 2.3 Reproduction

Run against the real engine module, modelling a leveraged startup that turns profitable
(`fleetNAV` $44M, `debt` $62M, revenue ramping to $5.67M/wk, profit to $1.53M/wk):

```
wk  history  fairValue($M)  PRIVATE price   PUBLIC price   wow%(private)
 1        1          0.50        $0.0050        $0.0050              —
 2        2          0.50        $0.0050        $0.0050          +0.0%
 3        3          0.50        $0.0050        $0.0050          +0.0%
 4        4          0.50        $0.0050        $0.0050          +0.0%
 5        5          0.50        $0.0050        $0.0050          +0.0%
 6        6         18.51        $0.1851        $0.0067       +3602.3%
 7        7         74.52        $0.7452        $0.0091        +302.6%
 8        8        144.84        $1.4484        $0.0123         +94.4%
 9        9        230.29        $2.3029        $0.0166         +59.0%
```

The exact magnitude depends on how many weeks the airline sat pinned at the floor and how fast
the earnings term ramps — +8383% is the same phenomenon with a slightly longer pinned stretch.

### 2.4 Why rivals can see it

- `apps/headwinds-server/src/lib/humanRivals.mjs` ~199–215 ships `marketCap`, `sharePrice`,
  `isPublic` and a 26-week `sharePriceHistory` (sliced out of `statsHistory`) for **every** human
  rival, private ones included.
- `src/components/StockMarket.jsx` ~650–690 renders private airlines as **full table rows** —
  price, `<MovePct>`, `<PriceSparkline>`, market cap — and only disables the **Buy** button
  (label flips to "Private"). `<MovePct>` is a plain last-two-points ratio with no clamp
  assumption baked in, so it will happily print four digits.

**Standings are safe.** `apps/headwinds-server/src/lib/tickService.mjs` ~322 filters the SVPS
ranking on `isPublic`, so a private airline never enters the leaderboard. This is a Markets/rival
surface problem, not a scoring problem.

### 2.5 What is *not* wrong

- **Share count.** 100M founder shares for every airline is deliberate and documented — it makes
  prices directly comparable inside a world with no per-world config and no need for splits.
  Air Chicago's $0.58 × 100M = $57.93M is internally consistent.
- **Going public.** Because every airline starts private, `state.marketCap` at IPO time is already
  the honest fair value, so the smoothed series begins at the right level. Listing does not
  permanently suppress your published cap.

---

## 3. Fix options

### Option A — Stop publishing the private price *(smallest, UI only)*

For `isPublic === false` rows, render "Private" (or "—") in place of price, move %, and sparkline
in the Markets table, and suppress the same fields on the rival detail card. Optionally suppress
market cap too, since a private company's cap is the same unsmoothed number.

- **Touches:** `src/components/StockMarket.jsx`, the rival detail card. Possibly
  `humanRivals.mjs` to stop shipping the fields at all (also trims payload).
- **Risk:** none to the engine, IPO pricing, or live world balance.
- **Leaves unfixed:** the internal series is still jagged, so the sparkline is still ugly the
  moment the airline lists (its pre-IPO history is part of the 26-week window).

### Option B — Smooth the published series, keep an unsmoothed one for the IPO

Have the tick compute both: keep publishing a smoothed `marketCap` for private airlines (pass the
real `prevMarketCap`), and store the unsmoothed `fairValue` separately for `GO_PUBLIC` to price
off. `computeMarketCap` already returns `fairValue` — it just isn't persisted.

- **Touches:** `packages/engine/src/reducer.mjs` (~3673 and the state write ~3763),
  `GO_PUBLIC` at ~4274 to read the stored fair value, plus a migration default for saves without
  the field.
- **Risk:** moderate. Changes what every private airline's published cap is, so golden-master will
  move and will need re-baselining.
- **Wins:** fixes the readout *and* the sparkline without re-breaking the "float the company for a
  rounding error" bug the `null` was added to solve.

### Option C — Raise the floor off `MIN_MARKET_CAP`

The flat $500k floor is what creates the pin-then-teleport. Replace it with something book-aware —
e.g. floor on a fraction of gross assets, or on `STARTING_CASH × 0.85` (the value `reducer.mjs`
~455 already seeds `state.marketCap` with at incorporation, ~$12.75M).

- **Touches:** `VALUATION` in `market.js`, plus the floor expression in `computeMarketCap`.
- **Risk:** highest. Every distressed airline in every live world is affected, and the floor
  interacts with the loss-cliff interpolation and `LOSS_MULTIPLE`.
- **Wins:** kills the problem at source rather than hiding it.

**Recommendation:** A now (it is the visible defect and costs nothing), B when there is a clean
window to move golden-master. C only as part of a deliberate valuation-balance pass.

---

## 4. Unrelated drift found in the same files

`src/components/StockMarket.jsx` ~707 tells players:

> "Prices are set by each airline's fundamentals … and move once per weekly tick
> (max ±20% a week, plus a little market noise)."

The real constants are `WEEKLY_MOVE_CLAMP: 0.08` widening to `MOVE_CLAMP_MAX: 0.35`, plus
`NOISE_PCT: 0.035`. The help text predates the widening-band rework and should read something like
"typically ±8% a week, widening when the price is far from fair value."

---

## 5. Testing notes for whichever option is taken

- A regression test should assert that **no published weekly move exceeds
  `MOVE_CLAMP_MAX + NOISE_PCT`** for any airline, public or private — that single assertion would
  have caught this.
- Verify the test **fails on pre-fix data** before landing it.
- Option B moves golden-master; re-baseline `golden.json` in the same commit.
- Reproduction harness used for section 2.3 is a ~30-line script importing `computeMarketCap`
  directly from `packages/engine/src/utils/market.js`; worth keeping as
  `tools/private-valuation-test.mjs`.


---

## 6. What was actually built (2026-07-29)

### A — the readout
- `src/components/StockMarket.jsx`: private airlines (own row and rival rows) render **Private / — / not listed**
  in place of price, weekly move and sparkline. **Market cap is kept** — the valuation is real and honestly
  labelled; it is the *price* that implied a market that does not exist.
- `src/components/Competition.jsx`: the leaderboard quotes no `$/share` for a private airline (it falls through
  to the weekly-profit line), and the rival dossier's "Share price" tile reads **Private**.
- Help text corrected: the "max ±20% a week" claim now describes the real widening band.

### B — the engine
- `reducer.mjs` weekly tick now passes a real `prevMarketCap` for **every** airline. The unsmoothed fundamental
  value is kept on the new **`state.fairValue`** instead of being published.
- `GO_PUBLIC` prices the listing off `state.fairValue` and **rebases the published cap to it in the same step**
  — listing is the price-discovery event, so the stock does not gap down on day one.
- A private airline now records **`sharePrice: null`** in `statsHistory`. This turned out to be the cleanest
  part of the fix: there is no pre-listing price series at all, so a newly listed airline's chart starts at its
  listing and no client can compute a move % from weeks nobody could have traded.
- `reconcileState` gives pre-`fairValue` saves their own published cap, so nothing moves at the migration.

### C — the floor
- New `VALUATION.ASSET_FLOOR_FRAC = 0.08`: the equity floor is now the larger of `MIN_MARKET_CAP` and 8% of
  **gross assets** (what the airline owns, before what it owes). A leveraged startup with a negative net book
  no longer pins at $0.0050.
- **Deliberately applied to fair value only, not to the published cap.** Flooring the published cap let the
  floor jump the move clamp — buy a fleet, gross assets leap, the print outruns its band in one tick. That is
  the same defect this whole pass exists to fix, so the print converges up to a floored fair value inside the
  band like anything else. `computeMarketCap` now also returns `grossAssets` and `valueFloor`.

### Verification
- **Pre-fix proof** (isolated copy of `HEAD`, live tree never touched): the private-airline band assertion fails
  with **“week 1 printed 2239.1%”**, the history assertion fails with a recorded `$3.14237`, and the floor
  assertion fails with exactly `$0.0050`.
- **The band is multiplicative, not additive.** The clamp bounds the cap *before* noise and the noise is a
  multiplier, so the true ceiling is `(1 + 0.35) × (1 + 0.035) − 1 = 39.7%`, not 38.5%. An additive bound would
  have let this suite pass by accident.
- **Golden master moved by exactly three things** and nothing else: the new `fairValue` field,
  `statsHistory[].sharePrice` going null while private, and `statsHistory[].svps` for private weeks (now derived
  from the smoothed print). Cash, `financialHistory`, fleet, routes, phase, final market cap and final share
  price are **byte-identical**. Standings are unaffected — `tickService` already filters on `isPublic`.
- Two existing tests in `tools/valuation-dilution-test.mjs` asserted the OLD contract (that a private airline
  republishes raw fair value). They were **rewritten, not deleted** — the intent behind them (an IPO must not be
  priced off a lagging series) is preserved and still asserted, now via `state.fairValue`.

### Not ported to Tailwinds
Tailwinds runs the older v1 valuation model — its `src/utils/market.js` has no `MIN_MARKET_CAP`, no
`prevMarketCap` smoothing and no `equity`/`isPublic` at all. This bug class does not exist there, and porting
option C alone would mean grafting a floor onto a different model. **Headwinds only.**
