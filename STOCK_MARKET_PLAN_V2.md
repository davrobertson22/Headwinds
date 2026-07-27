# Headwinds Stock Market Plan v2 — Capital Markets

**Status: ALL FIVE PHASES BUILT (2026-07-27). Phases 1-2 committed as a81c20f; phases 3-5 on disk, uncommitted.**
Supersedes the balance sections of
`STOCK_MARKET_PLAN.md` (which shipped 2026-07-20 and is otherwise still accurate as a
description of what exists today).

Dave's four complaints, verbatim:

1. Share prices grow way too quickly and it's too easy to make money on it
2. The companies you invest in don't get any benefit
3. The cash comes from outside the game when you sell and it becomes a glut of money
4. It just feels unrealistic

All four have a single common cause, and it isn't in the stock market code. **The world
leaderboard ranks on market cap** (`tickService.mjs:207`,
`sort((a, b) => b.marketCap - a.marketCap)`). Market cap measures how *big* you got, so
the game pays you to accumulate and punishes you for ever returning capital to
shareholders. Every mechanic that would make a stock market feel like a stock market —
dividends, buybacks, meaningful dilution — is score-negative under that metric and would
be correctly ignored by any player optimising to win.

So this plan changes the ranking metric, and everything else follows.

---

## Decisions (2026-07-27)

Dave's answers to the six open questions, which are now baked into the plan below:

1. **Leaderboard: one board, SVPS only.** Market cap survives as a displayed stat and
   keeps its index, but it is not ranked.
2. **Ownership rights: purely financial.** No disclosure filings, no dossier intel, no
   blocking stakes, no takeovers. **Part H is dropped entirely.**
3. **Staying private: allowed, but private airlines cannot win.** They tick and appear in
   the world normally; they are excluded from the ranked standings until they list.
4. **Float pool replenishment: 2% of seed per game year, on from the start.**
5. **Pool seed: 5x total starting capital.**
6. **Solo AI delist paths: strip them from the Headwinds engine.**

## Build status

| Phase | State |
|---|---|
| 1 — valuation v3 + market index | **BUILT.** `tools/valuation-test.mjs` (25), golden re-baselined. Committed a81c20f. |
| 2 — share counts + SVPS ranking | **BUILT.** `tools/equity-test.mjs` (18), migration `20260727000000_capital_markets`, `tools/backfill-equity.mjs`. Committed a81c20f. |
| 3 — float pool + trading mechanics | **BUILT.** `tools/trading-test.mjs` (32), `lib/marketService.mjs`, migration `20260727020000_float_pool`. |
| 4 — capital actions | **BUILT.** `tools/capital-test.mjs` (32), migration `20260727030000_capital_actions`, dividend ledger. |
| 5 — UI and feel | **BUILT.** Capital-actions panel on the Stocks tab, rewritten Wiki chapter. |

Test totals: **107 new assertions** across four suites, all wired into `npm test`; whole
suite green (18 files) and golden master at parity.

### Deviations from the plan as first written, and why

- **Founder share count stays 100M for every airline, not 5M.** A uniform count means
  share prices are directly comparable inside a world with no per-world configuration and
  no reverse-split migration — and crucially it makes the Phase 2 migration *exactly*
  rank-neutral. It also removes the need for stock splits ever: a $12.75M startup opens
  near $0.13 and a mature $2.7B carrier lands near $27, which is a realistic range for a
  whole airline's life. The cost is a penny-stock opening price, which is honest for a
  startup airline. **`cumSplitFactor` and the auto-split item are therefore dropped.**
- **`isPublic` defaults to `true` in Phase 2.** `GO_PUBLIC` does not exist until Phase 4,
  so defaulting new airlines to private would leave nobody rankable. Phase 4 flips the
  default when the action lands.
- **Tailwinds is NOT affected.** The plan originally said the engine is shared; it isn't —
  the repos have been standalone since 2026-07-12 and Tailwinds is mirrored by hand.
  Nothing here touches Tailwinds until someone ports it deliberately.
- **The free float is 30% of shares, not 100%.** `emptyEquity()` locks 70% in a founder
  block. Without a float there is nothing for the pool to sell, so trading would have
  deadlocked the moment the pool became the counterparty. 30% is set deliberately above
  `MAX_OWNERSHIP_PCT` (20%) so one player taking their maximum stake still leaves float
  for everyone else. A private airline has a founder block of 100% and therefore no float
  at all until it lists.
- **The weekly volume cap was dropped.** Price impact is the same tool done properly: it
  makes dumping a large stake expensive through the price rather than forbidding it, and it
  scales continuously. A 2%-of-float weekly cap would also have been *smaller than the
  $100k minimum ticket* for a startup carrier, i.e. it would have blocked trading outright.
- **Next-tick settlement was NOT built.** The plan proposed executing orders at the
  following tick's price to remove any edge from trading on the last published print.
  Deliberately skipped: in multiplayer, rival prices inside a tick are built from the
  previous week's states, so a genuine information lag needs a *two*-week order round trip,
  which is a heavy UX cost. Instead the edge is taxed and diluted — 25% capital gains tax,
  ~3% round-trip friction, price impact, the pool's liquidity discount, and above all the
  correlated market index, which can swamp a single carrier's earnings move.
  **Honest caveat for Dave:** a player who reads rivals' published profit trends still has
  a real edge, because the price converges toward fair value gradually. That is arguably
  what a market *should* reward; it is no longer close to risk-free. If it still feels too
  easy in play, next-tick settlement is the remaining lever and it is a self-contained
  change to `BUY_STOCK`/`SELL_STOCK` plus a pending-orders UI.

---

## Part A — Why prices explode (measured)

`computeMarketCap` (`packages/engine/src/utils/market.js`) sets

```
fairValue = 0.85 × netBook + annualizedProfit × peMultiple × confidence
peMultiple = 12 + growthBonus(−5..+15) + reputationBonus(0..+5)     → 7 .. 32
```

Two defects:

**A1. The earnings term swamps the balance sheet.** Annualizing weekly profit at up to
32× means each extra $100k/week of profit adds `100k × 52 × 32 = $166M` of market cap.
One good route is worth a quarter-billion. Real airlines trade at P/E 6–10 and 0.3–1.5×
sales — the lowest-multiple, most cyclical sector there is. Headwinds prices them like
software companies.

**A2. `WEEKLY_MOVE_CLAMP: 0.20` turns the gap into an annuity.** When fair value sits far
above price, the clamp guarantees +20%/week, smoothly, for many weeks. A stock returning
a predictable 20%/week against a 3% round-trip cost is not an investment.

### Measured effect of the proposed constants

Run against the real `computeMarketCap` with candidate v3 constants
(`tools/valuation-v3-check.mjs`, to be added):

| Profile | Current fair value | Proposed | Ratio | P/E now → new |
|---|---|---|---|---|
| Week 6 startup (losing) | $6M | $6M | 1.00× | 9 → 5.8 |
| Week 40 growing | $912M | $494M | 0.54× | 20 → 9.9 |
| Week 150 mature | $4,927M | $2,744M | 0.56× | 20.8 → 10.2 |
| Week 200 cash hoarder | $4,396M | $2,408M | 0.55× | 20.5 → 10.1 |
| **Absurd-margin outlier (53% net)** | **$8,929M** | **$1,098M** | **0.12×** | 21.3 → 10.4 |

Normal airlines re-rate to roughly half — a healthy correction toward real multiples. The
money-printer case (implausible margins) collapses to an eighth, which is the sales cap
doing its job.

### A3. Valuation v3 constants

```js
export const VALUATION = {
  BOOK_WEIGHT:        0.85,
  FLEET_NAV_WEIGHT:   0.90,
  BOOK_FLOOR:         0.40,
  PE_BASE:            8,        // was 12
  PE_GROWTH_SPAN:     3,        // was −5..+15
  PE_REP_SPAN:        2,        // was 0..+5   → band 5..13 (real airline range)
  EARNINGS_SALES_CAP: 1.2,      // NEW: earnings term ≤ 1.2 × annualized revenue
  IDLE_CASH_REV_FRAC: 0.20,     // NEW: cash above 20% of annual revenue is "idle"
  IDLE_CASH_WEIGHT:   0.25,     // NEW: idle cash credited at 25c on the dollar
  LOSS_MULTIPLE:      4,
  MIN_EARNINGS_WEEKS: 4,
  EARNINGS_CONF_POW:  2,
  CONVERGENCE:        0.30,
  WEEKLY_MOVE_CLAMP:  0.08,     // was 0.20
  NOISE_PCT:          0.035,    // was 0.015
  MIN_MARKET_CAP:     500_000,
};
```

`EARNINGS_SALES_CAP` is the important new one: it makes the valuation impossible to run
away from the actual business, whatever the margin. `IDLE_CASH_*` is the lazy-balance-sheet
penalty — see Part E, it's what gives dividends and buybacks a reason to exist.

Honest note on the clamp: dropping 20% → 8% only reduces the predictable ramp from
18.9%/week to 7.2%/week (measured). The ramp is really killed by three things together —
a smaller and more stable fair value (A3), noise of comparable magnitude to the drift
(±3.5%), and the correlated market index (Part B) which can move the *whole sector* against
you while you're waiting.

---

## Part B — World market index

Sector-wide, correlated risk. Without it, "the market" is 8 uncorrelated savings accounts.

`tickService.mjs` already has exactly the machinery needed: `seededRand(worldSeed, salt)`
and `worldFuelIndex(seed, weekIndex)`, both replayable and identical for every airline in
the world.

```js
function worldMarketIndex(seed, weekIndex, fuelIndex) {
  // Zero-drift OU walk, ±25% band, mean 1.0, plus fuel coupling:
  // every 10% above baseline fuel knocks ~4% off sector valuations.
  ...
}
```

Injected into `ADVANCE_WEEK` alongside `worldFuelIndex` / `worldEvents`, multiplies
`fairValue` for **every** airline including the player's. Consequences:

- Real drawdowns exist. Buying is a decision, not a formality.
- Fuel spikes now hit your share price as well as your P&L — which is what actually
  happens to airlines, and it makes the existing fuel-hedging system matter more.
- A world-level "Market Index" chart is a cheap, high-value UI addition, and lets a
  player see whether they beat the market or just rode it.

---

## Part C — Variable share counts (the keystone)

Every airline currently has exactly `TOTAL_SHARES = 100_000_000`, so
`sharePrice === marketCap / 1e8` and **ranking on share price is arithmetically identical
to ranking on market cap.** Nothing downstream in this plan is possible until share count
becomes per-airline state.

### C1. State shape

```js
// state.equity — new, defaults via reconcileState for old saves
{
  shares:            5_000_000,   // shares outstanding
  founderShares:     5_000_000,   // never-sold block, for float math
  isPublic:          false,       // private until you IPO
  cumDividendsPerShare: 0,        // split-adjusted, drives the ranking metric
  cumSplitFactor:    1,           // for the auto-split in Part I
  ipoWeek:           null,
  offeringsThisYear: 0,
}
```

`TOTAL_SHARES` stops being a constant and becomes `sharesOf(state)`. Call sites to change:
`computeMarketCap` (returns `sharePrice = marketCap / shares`), the `BUY_STOCK` /
`SELL_STOCK` ownership caps, `humanRivals.mjs:163-169` (rival payload must carry `shares`),
`StockMarket.jsx`, `Dashboard.jsx` (the portfolio card), and `Finance.jsx`.

### C2. Founder share count and price scale — REVISED

**Every airline is incorporated at 100,000,000 shares**, new and migrated alike. See
"Deviations" above for the reasoning: a uniform count makes the Phase 2 migration exactly
rank-neutral, needs no per-world config, and removes any need for stock splits. Opening
price is `12.75M / 1e8 = $0.1275`; a mature $2.7B carrier reaches roughly $27.

`TOTAL_SHARES` therefore survives as the *founder count and fallback*, but nothing may
treat it as "the" share count any more — `sharesOf(state)` is the only correct reader.

### C3. Migration for live worlds

Existing airlines get `shares: 100_000_000`, `founderShares: 100_000_000`,
`isPublic: true`, `cumDividendsPerShare: 0`. Their share price is unchanged, and because
every airline has the same share count at the moment of migration, **the leaderboard order
is unchanged on deploy.** Ranks only start diverging as players issue or retire shares.
This is the single most important property of the rollout — see Part J.

---

## Part D — The ranking metric

Replace market cap with **Shareholder Value Per Share (SVPS)**:

```
SVPS = sharePrice + cumDividendsPerShare      (both split-adjusted)
```

Because every player starts from the same $15M and the same 5M founder shares, SVPS is
equivalent to a total-return index with a common base — it measures how much value you
created per unit of ownership, which is the thing a share price is *for*. Late joiners
start at $2.55 like everyone else, so there's no low-base advantage to joining late, and no
penalty for being small other than not having compounded yet.

What this changes about how the game is won:

| Move | Under market cap | Under SVPS |
|---|---|---|
| Issue shares / IPO | free score | dilutive — only wins if the capital out-earns the dilution |
| Buy back shares | loses score | wins when your stock is cheap or your cash is idle |
| Pay a dividend | loses score | rank-neutral by construction (add-back), positive via yield re-rating |
| Hoard idle cash | gains score | penalised by `IDLE_CASH_WEIGHT` |
| Grow profitably | gains score | still gains score |

Growing a big profitable airline remains the dominant strategy. What changes is that
capital allocation stops being free.

### D1. Storage

`Standing.score` is already a generic `BigInt` — **no schema change needed for the metric
itself.** Store `round(SVPS × 10_000)` (ten-thousandths of a dollar) so cents survive the
BigInt.

`tickService.mjs:207` becomes `sort((a, b) => b.svps - a.svps)`. The `Airline` model needs
`shares BigInt` and `svps BigInt` columns plus `@@index([worldId, svps])` so the standings
endpoint (`worlds.mjs:101`) can order without deserialising every blob. Keep `marketCap`
as a displayed stat and keep its index — "biggest airline" is still worth showing, it's
just no longer the win condition.

### D2. UI honesty

One ranked board, ordered by SVPS, with market cap shown as an unranked column and a
"vs market index" column beside it. Players need to see immediately that the game rewards
per-share value, or the change will read as a bug.

---

## Part E — Capital actions (the company finally participates)

All four are new reducer cases. Each has a *reason a rational player would use it*, which
is the thing that was missing.

### E1. `GO_PUBLIC { sharesOffered, discountPct }` — the IPO

Airlines start **private**: they have a valuation and a share price, but no tradable float
and nobody can buy in. Listing issues new shares to the float pool and puts the proceeds in
your treasury.

- Offer 10–35% of post-issue shares. Priced at fair value less an IPO discount (5–15%,
  larger for a short track record or a hot pool — real IPOs are underpriced).
- Proceeds come *from the float pool* (Part F), so they're capped and someone else can get
  there first.
- Cannot list before week 26 or with fewer than 12 weeks of history — you have to have a
  business first.
- **Why you'd do it:** capital, at the cost of permanent dilution and permanent scrutiny.
  It's the single biggest strategic decision in the mid-game.
- **Why you might not:** stay private, stay uncontested, keep 100% of the upside — but a
  private airline is **excluded from the ranked standings** (no traded share price, nothing
  comparable to rank). It is a legitimate way to play, not a way to win. Already
  implemented in Phase 2: `tickService` filters non-public airlines out of the standings.

### E2. `ISSUE_SHARES { shares }` — secondary offering

Up to 15% of outstanding per game year (`offeringsThisYear`, reset annually), priced at a
discount that *widens* with how much you've issued recently and *narrows* with your
dividend/buyback track record. Cheap equity later is what a shareholder-return record buys
you.

### E3. `BUY_BACK_SHARES { shares }` — buyback

Retire shares from the float at market plus the spread. Cash leaves, share count falls.
Neutral to SVPS at fair value; **accretive when your stock trades below fair value or your
cash is being idle-haircut.** This will be the common capital-return lever — obviously
attractive, no ongoing obligation.

### E4. `SET_DIVIDEND_POLICY { payoutRatio }` — dividends

A policy (0–60% of trailing 13-week net profit), paid every 13th week. Rare by design.

**Who gets paid, and why the money loop closes:**

| Holder | Effect |
|---|---|
| Your own founder block | **not paid** — paying yourself is a wash, and skipping it means the cost scales with how much of yourself you sold |
| Rival players' holdings | player → player transfer, conserved |
| Float pool (outside investors) | cash leaves the world — **money sink** |

A dividend can therefore never create money. It transfers or destroys it — the exact
opposite of today's `SELL_STOCK`.

**Guardrails:** skipped if trailing profit ≤ 0, or if paying would drop cash below ~4
weeks of operating cost. A skipped payment is a public event in the world feed
("Aurora Air suspends its dividend"). Cutting your dividend should be embarrassing.

**Settlement — the one real trap.** `tickWorldOnce` computes all airlines in one pass and
commits in one transaction, but the per-airline `updateMany` is a version compare-and-set
that **skips** any airline whose player just made a decision. If the payer's write lands and
the receiver's doesn't, money vanishes; reverse it and money is minted. So:

1. The reducer debits the payer and emits `next.pendingDividends = [{ toAirlineId, amount }]`.
2. Inside the same transaction, credit rows are written **only for airlines whose write
   landed** (the loop already tracks `written`).
3. Each airline's next tick receives `incomingDividends` as an action field, credits cash,
   and the rows are marked consumed — again only if that write lands.

A skipped airline just gets paid next week. Money is conserved on every path, including
retried ticks.

**Accounting:** dividends received go to `historyEntry.investmentIncome`, *not* operating
profit — same reason trading P&L is already below the line, otherwise it feeds back through
the ×52 × P/E loop.

**Why anyone pays one:** the idle-cash haircut. Late game, gates are gone, the orderbook is
backlogged, and cash piles up being credited at 25c on the dollar. Returning it beats
sitting on it. Plus a better price on your next offering (E2). Real airlines paid
essentially nothing for decades while growing — dividends should be a mature-carrier move
here too, and most players will never declare one. That's correct.

---

## Part F — The finite float pool (closing the money loop)

Today `BUY_STOCK` deletes cash and `SELL_STOCK` mints it against an infinite off-world
counterparty. Fix: give each world **one pool with a finite cash balance and a finite share
inventory.**

```prisma
model WorldMarket {
  id        String @id @default(cuid())
  worldId   String @unique
  poolCash  BigInt          // outside-investor cash available to buy equity
  holdings  Json   @default("{}")   // { [airlineId]: shares } held by the pool
  version   Int    @default(0)      // optimistic-concurrency guard
  world     World  @relation(fields: [worldId], references: [id], onDelete: Cascade)
}
```

Modelled directly on `WorldGate` (`schema.prisma:262`) — same worldId + JSON + version CAS
pattern, so the concurrency handling is already proven in this codebase.

**Seed:** `5 × Σ starting capital` (a 10-player world → $750M).

**Replenishment: 2% of the seed per game year, on from the start** — so a 100-year world
sees at most 2x the seed in total lifetime injection, and late-world liquidity stays alive
rather than dying permanently. Still a hard bound, just a looser one than zero.

**Flows:**

| Flow | Direction | Bounded by |
|---|---|---|
| IPO / offering proceeds | pool → player | pool cash |
| Player buys rival shares | player → pool | player cash |
| Player sells rival shares | pool → player | **pool cash** |
| Buyback | player → pool | player cash |
| Dividend to pool-held shares | player → pool | payer cash |
| Dividend to rival player | player → player | payer cash |
| Capital gains tax | player → void | — |

**Net exogenous injection into the world is capped at the pool seed, permanently.** That is
the whole fix for complaint #3.

**Emergent behaviour, all of it desirable:**

- Pool cash low → widening liquidity discount on sales, and eventually *the equity window
  closes*: you cannot IPO or raise, because there's no money on the other side. Real, and
  brutally thematic.
- Everyone dumping at once drains the pool and craters realisable prices. Crashes become
  possible for a structural reason rather than a dice roll.
- First mover to IPO gets the cheap capital. Genuine race dynamics.
- Pool appetite scales with the market index (Part B): hot market pays near fair value, bad
  market pays a deep discount or nothing.

**Also in Phase 3:** strip the solo AI delist paths (bankruptcy 50% haircut, AI merger at
par) from the Headwinds engine per decision 6. Headwinds has been humans-only since the
world spawner was removed, so they are dead code that would otherwise be a route for
exogenous cash if solo ever returned.

---

## Part G — Trading mechanics

- **Price impact.** Slippage proportional to order size vs float:
  `execPrice = price × (1 + SPREAD_HALF + IMPACT_K × shares / floatShares)`. Kills
  large-scale accumulation at the marked price, which is currently free.
- **Settlement at next tick's price.** Orders queue and execute at the *next* print, not the
  stale visible one. Removes the last risk-free element from trading and is how real orders
  work at your time resolution.
- **Capital gains tax** (~25% of realized gains) — realistic, and a money sink offsetting
  the pool.
- **Weekly volume cap** ~2% of float per airline per week, so nobody exits a large stake at
  one price.
- **Raise the sizing limits.** With the metric fixed and money conserved, the current
  `MAX_PORTFOLIO_PCT_OF_CAP: 0.40` side-game cap can loosen; `MAX_OWNERSHIP_PCT` should rise
  above 20% to make the control mechanics in Part H reachable.

---

## Part H — Ownership rights and disclosure — DROPPED

Per decision 2, equity in a rival is **purely financial**: an income and capital-gains
asset, with no filings, no intel, no blocking stake and no takeover path. Shares confer
money, not politics, and running the airline stays the only real game.

The `MAX_OWNERSHIP_PCT` cap (20% of a rival's own float) therefore stays as a pure
concentration limit rather than a stepping stone toward control.

---

## Part I — Realism and feel

- **Earnings reactions.** Price should react to the weekly report *as news* — a beat or miss
  against the trailing trend produces a jump, rather than only sliding along the convergence
  curve. Cheap to add on top of A3 and does a lot for the feel.
- **52-week range, yield, P/E, market-cap rank** on the Stocks tab. Real screens show these.
- **A world Market Index chart** and a "you vs the index" line on your own price chart.
- Longer term, deliberately out of scope: shorting, options, index funds, analyst estimates.

---

## Phase order

Each phase is independently shippable and leaves the game in a coherent state.

| Phase | Contents | Risk |
|---|---|---|
| **1** | **BUILT** — Part A valuation v3 + Part B market index. | Live worlds re-rate ~50% down on deploy. Needs a devlog heads-up. |
| **2** | **BUILT** — Part C share counts + Part D SVPS ranking + migration + backfill. | Rank-neutral at migration (verified by the backfill tool's own check). |
| **3** | **BUILT** — Part F float pool + Part G trading mechanics + solo delist paths stripped. | New table + CAS paths, all covered. |
| **4** | **BUILT** — Part E capital actions + the cross-player dividend ledger. | The CAS trap is handled; see below. |
| **5** | **BUILT** — capital-actions UI + Wiki (Part H dropped). | Additive. |

Phase 1 alone fixes complaint #1. Phases 1–3 fix #1 and #3. #2 and #4 need Phase 4.

**Tailwinds:** unaffected. The repos have been standalone since 2026-07-12 — there is no
shared package, and Tailwinds is mirrored by hand. Nothing in this plan reaches Tailwinds
unless someone deliberately ports it, and Tailwinds has no stock market to port it into.

---

## What shipped in phases 3-5

**Phase 3 — the money loop closes.** `WorldMarket` (one row per world: `poolCash`,
`seedCash`, `holdings`, `version`) is the finite counterparty, seeded at
`5 x players x starting capital` and healed 2%/game-year, never above the seed. Buys pay
cash in and take shares out of inventory; sells do the reverse. Settlement happens inside
the decision transaction with a version compare-and-set, keyed off the engine's
`lastStockTrade` — what actually executed, never the request. Also added: price impact
(`IMPACT_K` against the free float, capped at 25%), a 25% capital gains tax on realized
gains only, a pool liquidity discount that widens as the pool drains, and the equity
window shutting entirely when it empties. Solo has no pool and keeps its legacy
unbounded counterparty.

**Phase 4 — the issuer participates.** `GO_PUBLIC`, `ISSUE_SHARES`, `BUY_BACK_SHARES`
and `SET_DIVIDEND_POLICY`, all pool-settled, all allow-listed and payload-guarded down to
a share count (or a payout ratio) so there is nothing worth forging. Dividends pay
quarterly out of trailing-quarter profit, exclude the founder block, and suspend publicly
after a losing quarter or when cash cover would break.

The cross-player settlement trap flagged in Part E is handled exactly as designed:
`DividendCredit` rows are issued only for payers whose tick write landed, and consumed only
when the recipient's own write lands. A skipped airline collects next week. `splitDividend`
caps distribution at what was actually debited, so money is conserved on every path —
rival players receive a real transfer, and the slice held by outside investors leaves the
world as a sink rather than being credited to the pool.

**Phase 5 — reachable.** A "Your company" panel on the Stocks tab surfaces the share
register, IPO or offering, buyback and dividend policy, each showing the trade-off
(proceeds, dilution, discount, per-share cost, yield) before you commit. The Wiki chapter
was rewritten around the new model: real airline multiples, the market index, SVPS ranking,
the four capital actions, price impact, and the pool as a real counterparty that can run
out.

## Migration and rollout

1. **Phase 1 re-rates live worlds ~50% down.** Order is broadly preserved (it's a
   monotonic-ish transform), but not exactly — the sales cap hits high-margin carriers
   hardest. Devlog entry before deploy, same as the July 20 re-rating heads-up.
2. **Phase 2 is rank-neutral at the moment of migration** (Part C3) — every airline has
   100M shares, so SVPS ordering equals market-cap ordering. Ranks diverge only from new
   player choices. This is what makes changing the win condition mid-world defensible.
3. Backfill tool `tools/backfill-equity.mjs` on the pattern of the existing
   `rebaseStateCalendar` / `reconcile-airline-names.mjs` backfills.
4. `reconcileState` defaults `state.equity` for old saves, same pattern as `portfolio`
   (`reducer.mjs:3857`).
5. Golden master will need re-baselining after Phases 1 and 2 (`tools/golden-master/`), and
   remember the concurrent-session dance: `golden.json` reflects the whole working tree.
6. Engine changed → Railway API **and** tick worker must both deploy on the tip commit.
7. **Phases 3-5 add two more migrations** (`20260727020000_float_pool`,
   `20260727030000_capital_actions`) and two new Prisma models, so **`prisma generate` must
   run** before the API or worker boots — otherwise `prisma.worldMarket` and
   `prisma.dividendCredit` are undefined at runtime. The float-pool migration needs no
   backfill: `ensureWorldMarket` lazily seeds a row for already-running worlds from their
   current player count on first use.
8. Existing airlines stay public with a 30% float, so trading keeps working through the
   deploy. New airlines still default to `isPublic: true` as well — flipping new joiners to
   private-by-default is a one-line change to `emptyEquity()` whenever you want the IPO to
   become a real mid-game decision for new worlds.

---

## Open questions

All six original questions were answered on 2026-07-27 — see **Decisions** at the top.

Still worth watching, but not blocking:

1. **Pool seed calibration.** `5 × Σ starting capital` plus 2%/year is a reasoned guess, not
   a simulated one. Worth a long-world run before Phase 3 ships to confirm the equity window
   opens and closes at interesting moments rather than never or always.
2. **The idle-cash threshold.** `20% of annualized revenue, floor $25M, excess at 25c` makes
   hoarding cost a mature carrier ~13% of market cap. Enough to make returning capital the
   better move at the margin; if it turns out nobody notices, the weight is the dial.
3. **Whether the 8% clamp is still too generous.** Measured, it only cuts the predictable
   ramp from 18.9%/wk to 7.2%/wk. The market index and wider noise are what really break the
   free-money shape, so this wants observation on a live world rather than more theory.
