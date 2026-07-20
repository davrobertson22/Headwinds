# Headwinds Stock Market Plan

**Status: PLAN ONLY — nothing built yet.**
Goal: make stock price / market cap a real gameplay system — you can buy shares in rival
airlines and make (or lose) money — and fix the valuation algorithm so it can't be gamed.

Scope decisions assumed (flag if wrong):

1. **Portfolio value counts toward your own market cap** — and therefore the world
   leaderboard. Smart investing moves you up the standings, not just your cash pile.
2. **v1 is long-only.** Buy and sell rival shares. Shorting, dividends, and a world
   index are documented as future phases, not built now.
3. **Tailwinds gets a mirror** (buying stock in the AI carriers) as a late phase —
   the engine changes are shared anyway.

---

## Part A — Fix the valuation algorithm first

### A1. How it works today

`packages/engine/src/utils/market.js → computeMarketCap(profitHistory, cash, qualityScore)`:

```
annualizedProfit = trailing ≤12 weeks of profit × (52 / weeksAvailable)
P/E              = 12 + growthBonus(−5..+15) + reputationBonus(0..+5)     → 12–32
profitComponent  = profit ≥ 0 ? annualized × P/E : annualized × 5
marketCap        = max(profitComponent + cash × 0.8, $500k)
sharePrice       = marketCap / 100,000,000 shares
```

Recomputed from scratch every weekly tick for the player (reducer.mjs ~L2749) and every
rival. In multiplayer the `marketCap` column is the **leaderboard score**
(`tickService.mjs` → Standing rows, `worlds.mjs` orders by `marketCap DESC`).

### A2. The loopholes and defects (why it's a "money printer")

These matter *today* for the leaderboard, and become **actual money printers** the moment
stock trading exists, because anything that moves a price predictably can be bought
before and sold after.

| # | Defect | Exploit |
|---|--------|---------|
| 1 | **Debt is invisible.** `cash × 0.8` counts, loans don't subtract. | Take max loans → cash balloons → market cap balloons → leaderboard jump. With trading: two colluding players loan-pump one airline, the other rides the price up and sells. |
| 2 | **Fleet is invisible.** Owned aircraft (often $100M+ of assets) add zero value; cash does. | Selling your fleet *raises* your market cap (assets → cash at 0.8×); buying planes *tanks* it. Backwards, and trivially gameable around any trading window. |
| 3 | **Annualization spikes with short history.** 2 weeks of data → profit × 26 × P/E up to 32. | One good early week can swing market cap by hundreds of millions. Any rival who watches a newcomer's first weeks buys the spike risk-free. |
| 4 | **Profitable↔loss-making cliff.** P/E jumps from 5× to 12–32× the week trailing profit crosses zero. | Fully visible in advance (rivals see each other's `profitHistory` in the rival payload). Buy the week before a rival crosses positive → guaranteed multi-× pop. |
| 5 | **Growth-rate divide-by-near-zero.** `(recent − prior)/|prior|` explodes when the prior window is near zero. | Random P/E whiplash; more predictable pops for anyone doing the arithmetic. |
| 6 | **Fully deterministic and fully observable.** Rivals' profit history, cash, fares, and routes are open-book (by design), and next week's price is a pure function of them. | Anyone can compute tomorrow's price today. With trading, that's riskless arbitrage — the "crazy money-making loophole" at its purest. |
| 7 | **No path dependence.** Price teleports to the formula output each week. | Charts look like noise, and every defect above hits at full force in a single tick. |

### A3. The new model — fundamentals + smoothing + friction

Keep it one pure function in `market.js` (shared solo/MP), but value the airline like a
real company and make the price *evolve* instead of teleport.

**Step 1 — Book value (replaces raw cash):**

```
fleetNAV   = Σ owned aircraft: purchasePrice × depreciationRemaining
             (identical NAV math to SELL_AIRCRAFT, without the 5% fee)
debt       = Σ outstanding loan principal
netBook    = cash + 0.9 × fleetNAV + portfolioValue − debt
```

Fixes #1 and #2 in one stroke: loans are now net-zero on day one (cash up, debt up),
and buying aircraft converts cash into fleetNAV instead of vaporizing value.
`portfolioValue` is the mark-to-market of stock held in rivals (Part B) — zero until
trading ships, so this is safe to land first.

**Step 2 — Earnings value with a confidence ramp (fixes #3):**

```
weeks       = min(profitHistory.length, 12)
confidence  = weeks / 12                       // 0 → 1 over the first 12 weeks
annualized  = trailingAvgWeeklyProfit × 52
earnVal     = annualized ≥ 0
              ? annualized × P/E × confidence
              : annualized × 4  × confidence   // losses drag, but gently early on
```

A brand-new airline is valued on book; earnings only dominate once there's a real
track record. No more ×26 spikes.

**Step 3 — Smooth the P/E cliff (fixes #4, #5):**

- Growth rate: clamp the denominator — `growth = (recent − prior) / max(|prior|, 5% of trailing revenue)`, then clamp growth itself to ±100%.
- Loss cliff: instead of a hard 5×-vs-P/E switch, linearly interpolate the effective
  multiple between −$X and +$X annualized (X ≈ 4 weeks of revenue), so crossing zero
  moves the price smoothly across several weeks.

**Step 4 — Fair value with a floor:**

```
fairValue = max( netBook × 0.85 + earnVal,
                 netBook × 0.40,          // an asset-rich loser is still worth something
                 $500k )
```

**Step 5 — Path-dependent price with clamps and noise (fixes #6, #7):**

```
target    = prevMarketCap + 0.30 × (fairValue − prevMarketCap)   // converge, don't jump
clamped   = clamp(target, prevMarketCap × 0.80, prevMarketCap × 1.20)  // ±20%/week max
marketCap = clamped × (1 + ε)        // ε ∈ ±1.5%, server-seeded per (world, week, airline)
```

- The ±20% weekly clamp caps *any* residual exploit at 20% per tick — no more single-week
  10× pops, and the migration to the new formula glides instead of snapping (important
  for the live world's leaderboard).
- The noise term makes exact next-tick prices unknowable, killing riskless arbitrage
  while leaving the *direction* predictable — reading a rival's fundamentals and buying
  early is skill and should pay; computing the exact print shouldn't.
- **MP:** noise must be server-generated during the world tick (seeded from
  `(worldId, weekIndex, airlineId)` so it's deterministic per tick and retry-idempotent —
  reducer scripts can't use `Math.random()` results the client could predict or replay
  differently). Injected via the tick, like `worldEvents`. **Solo:** local RNG is fine.
- `state.marketCap` already exists as prev; old saves fall back to
  `fairValue` directly on their first tick.

**Worked sanity checks** (to verify in a harness before shipping):

- Fresh airline, $15M cash, no fleet, no history → netBook 15M → cap ≈ $12.75M
  (was $22.5M). Share price ≈ $0.13.
- Mature airline: $40M cash, $300M fleet NAV, $120M debt, $2M/wk profit, decent growth →
  netBook = 40 + 270 − 120 = $190M; earnVal ≈ 104M × ~18 ≈ $1.9B → fair ≈ $2.0B.
  Comparable to today's outputs for healthy airlines — the leaderboard shape survives.
- Loan test: +$50M loan → cash +50, debt +50 → netBook unchanged. Exploit #1 dead.

### A4. Where Part A touches code

| File | Change |
|------|--------|
| `packages/engine/src/utils/market.js` | `computeMarketCap` v2 (new signature takes `{ profitHistory, cash, fleet, loans, portfolioValue, prevMarketCap, qualityScore, revenueHint, noise }`); keep old export shape `{ marketCap, sharePrice, peMultiple, … }` so Finance/Competition UI keeps working. |
| `packages/engine/src/reducer.mjs` | Player weekly block (~L2749) passes the new inputs; competitor weekly block (~L2513) same; add `sharePrice` to `statsEntry` so the player gets a **price history chart** for free; ACQUIRE_COMPETITOR valuation (~L1780) inherits v2 automatically. |
| `apps/headwinds-server/src/lib/tickService.mjs` | Generate the seeded noise per airline and pass through the tick action; `safeInt` guards already protect against NaN. |
| `apps/headwinds-server/src/lib/worldService.mjs` | Seed-scaling comment/values (seeds marketCap at a fixed multiple of cash) updated for the new formula. |
| `packages/engine` tests / `demo.mjs` | A small harness that runs 60 ticks of a scripted airline and asserts: loan-neutrality, fleet-purchase-neutrality, no week-over-week move >20%+noise, smooth loss-crossing. |

**Live-world note:** existing airlines' caps will re-rate toward the new fair value at
≤20%/week. Expect a few weeks of leaderboard drift; worth a line in the devlog.

---

## Part B — The stock market (trading rivals' shares)

### B1. Player experience

- New **Markets** tab (or a "Markets" section atop the existing Rivals/Competition tab):
  every airline in the world listed with share price, day-1-indexed price chart
  (sparkline), weekly move %, market cap, P/E, and your position if any.
- Click a rival → their existing dossier modal gains a **price chart + Buy/Sell** panel.
- **Portfolio view**: holdings with shares, avg cost, market value, unrealized P&L,
  realized P&L to date; total portfolio value repeated on the Dashboard as a tile.
- Trades execute instantly at the current (this-week) price — prices only move on the
  world tick, so each tick is the "trading day". The next-tick countdown is already in
  the game bar, which makes this legible.

### B2. Data model — no new tables

Holdings live in the state blob (like everything else):

```js
state.portfolio = {
  holdings: {
    // key: rival airline id ("human:<id>" in MP, competitor id in solo)
    [airlineId]: { shares: 1_250_000, costBasis: 812_500, name: 'Pacific Wing' },
  },
  realizedPnL: 0,          // lifetime, for display
  lastValuation: 0,        // portfolioValue at last tick (feeds computeMarketCap)
}
```

- Trades are journaled in the existing `Decision` table (audit trail for manipulation
  review — this is why every trade goes through the normal decision pipeline).
- Old saves: `portfolio ??= { holdings: {}, realizedPnL: 0, lastValuation: 0 }`.
- No Prisma migration needed; `marketCap` column already exists and keeps being the
  leaderboard score (now including portfolio value via netBook).

### B3. New engine actions

```
BUY_STOCK  { targetId, shares, pricePerShare }   // price ALWAYS server-injected in MP
SELL_STOCK { targetId, shares, pricePerShare }
```

Reducer rules (shared solo/MP):

- Target must exist in `state.competitors`, not be yourself, not be delisted.
- **Execution price**: buy at `sharePrice × 1.01`, sell at `sharePrice × 0.99`
  (2% spread), plus **0.5% commission** each way. Round trip ≈ 3% — churn is lossy,
  wash trading between colluding accounts burns money instead of minting it.
- **Position limits** (per trade, enforced at buy time):
  - ≤ **20%** of any one rival's 100M shares outstanding;
  - portfolio total **cost basis ≤ 40% of your own market cap** — investing is a
    side-game, running your airline stays the main game;
  - minimum ticket $100k (no dust spam; the 60-per-10s decision rate limit already
    caps volume).
- Buy: `cash −= shares × execPrice + commission`; holding's shares/costBasis update.
- Sell: FIFO-free (single avg-cost lot per rival), `cash += proceeds − commission`,
  `realizedPnL += proceeds − avgCost × shares`.

**Where gains go (important for the algorithm loop):** trading P&L does **NOT** enter
`financialHistory[].profit` (the operating P&L that drives the earnings half of your own
valuation). Otherwise a good trade would be annualized ×52 and multiplied by P/E —
recreating loophole #3 through the back door. Instead:

- Unrealized: `portfolioValue` flows into **netBook** (book value, ~0.85×) — so gains
  lift your market cap dollar-for-dollar-ish, not at 20×.
- Realized: lands in cash (already in netBook) and shows on the Finance P&L as a
  separate below-the-line **"Investment income"** row, excluded from the valuation's
  profit series.

### B4. Valuation ordering — killing the circularity

A holds B's stock and B holds A's → whose price computes first? Resolution: during the
world tick, **snapshot every airline's marketCap/sharePrice at tick start** (the
previous week's prices — already sitting in the `marketCap` column), and value all
portfolios against that snapshot. One pass, deterministic, order-independent,
retry-idempotent. Feedback between airlines propagates at one week per hop and is
damped by the 0.85 book weight, the 0.30 convergence factor, and the ±20% clamp —
a two-account mutual-pump loop is mathematically a decaying series, not an amplifier
(worth asserting in the test harness).

Solo mirror: the reducer values the portfolio against `state.competitors[].sharePrice`
from the *previous* tick before recomputing this week's — same one-pass rule.

### B5. Delisting — what happens to shares you hold

| Event | Outcome for holders |
|-------|--------------------|
| Rival **abandons** the world / is **purged** for inactivity (existing mechanics) | Forced liquidation at last price × **0.75** (delisting haircut). Cash credited at next tick + toast: "Pacific Wing delisted — position liquidated at a 25% haircut." Risk is real but not a rug-pull to zero. |
| Rival goes deeply negative but keeps playing | No special case — their price just falls (floored by 0.40 × netBook, ultimately $500k cap ⇒ $0.005/share). Buying distressed rivals hoping for a turnaround is a legitimate strategy. |
| **World ends** (season end) | Final standings use final marketCap (portfolio included via netBook). Nothing to do. |
| Solo: AI carrier acquired in AI-vs-AI M&A or by the player | Cashed out at the deal price (0.9× / 1.25× cap respectively). Bankruptcy: same 0.75× haircut rule. |

### B6. Server pipeline (MP) — anti-cheat by construction

Reuses the existing decision pipeline (`decisions.mjs` + `decisionGuard.mjs`) exactly
as-is, plus:

1. `ALLOWED_PLAYER_ACTIONS` += `BUY_STOCK`, `SELL_STOCK` (`world.mjs`).
2. `guardDecision` additions:
   - resolve `targetId` to a **live airline row in the same world**, status ACTIVE,
     `id ≠ self` — 400 otherwise;
   - **delete any client-supplied `pricePerShare` and inject the authoritative one**
     from the target's `marketCap` column (same pattern as the loan/reconfigure
     guards: the client is untrusted, economics are re-derived server-side);
   - re-check share-count integer > 0 and both position limits against the
     server-loaded state (never client math).
3. The reducer then runs over the rival-injected view as usual; optimistic version
   check + Decision journal already handle concurrency and audit.
4. Egress: the rival payload (`humanRivals.mjs → toHumanCompetitor`) already carries
   `marketCap`/`sharePrice`/`profitHistory`. Add `sharePriceHistory` — last **26**
   ticks, plain number array (~200 bytes/rival) — sourced from the rival's
   `statsHistory[].sharePrice` (added in Part A). Small enough to not fight the
   egress work already done.

**Manipulation review, pre-answered:**

- *Pump via loans/asset sales* → dead (Part A netBook).
- *Wash trading / collusion churn* → lossy (3% round trip) and journaled per-account
  in `Decision` for after-the-fact review (`/admin` tooling already exists for bans).
- *Buy your own stock to lift your own cap* → `targetId ≠ self`, enforced server-side.
- *Compute the exact next print and arb it* → seeded noise makes the exact price
  unknowable; direction remains skill.
- *Multi-account mutual pumping* → damped loop (B4) + 20%-ownership cap + 40%-of-cap
  portfolio limit + moderation tools for the ban-hammer.
- *Front-running the tick with a decision flood* → existing 60/10s rate limit.

### B7. UI work

| Surface | Change |
|---------|--------|
| **Markets tab** (new, in `src/components/` shared UI) | Table of all listed airlines: price, sparkline (from `sharePriceHistory`), Δ%, cap, P/E, your position. Sortable, mirroring the new Gates-tab table conventions. Mobile: collapses to cards per the @640px rules from the mobile pass. |
| **Rival dossier** (`RivalDetailView`) | Price chart pane + Buy/Sell trade ticket (shares ⇄ $ amount entry, spread/commission shown, limit warnings inline). |
| **Dashboard** | "Portfolio" tile: value + unrealized P&L; drilldown to Markets tab. |
| **Finance P&L** | "Investment income" below-the-line row (realized); balance sheet gains an "Investments (at market)" asset line — the equity identity in `Finance.jsx` must include it or the balance check banner will flag an imbalance. |
| **Wiki + onboarding** | Short "Stock Market" wiki chapter; one Markets step appended to the tour. |
| **Toasts** | Delisting liquidations, big weekly portfolio moves (±10%). |

### B8. Explicitly out of scope for v1 (future phases)

- **Short selling** — biggest fun-add, biggest manipulation surface (borrow mechanics,
  margin calls, forced buy-ins on delisting). Design later as its own doc.
- **Dividends** — airlines electing a payout ratio; makes holding mature airlines
  attractive. Straightforward v2 once trading is proven.
- **World index / ETF** — "buy the market" instrument + index chart on the lobby page.
- **Activist thresholds** — perks at 10%/20% ownership (see a rival's route P&L,
  board seat flavor events). Fun, but needs the P&L-privacy question resolved first
  (deferred leak item #4 from the security audit).

---

## Part C — Tailwinds solo mirror (late phase)

Everything in Parts A+B lands in the shared engine, so solo support is mostly wiring:

- Part A applies verbatim (AI carriers already flow through `computeMarketCap` weekly).
- `BUY_STOCK`/`SELL_STOCK` reducer cases already work against `state.competitors`
  (AI ids instead of `human:` ids); solo dispatches them directly — no guard needed
  (no server, nothing to cheat but yourself).
- Delisting rules for AI M&A/bankruptcy per B5.
- Mirror the Markets tab/dossier/dashboard UI to the Tailwinds repo per the usual
  process (+ devlog + wiki + sitemap), same as the Gates-table mirror.

---

## Suggested build order

| Phase | Contents | Size |
|-------|----------|------|
| **1. Valuation v2** | market.js rewrite, reducer wiring, statsHistory.sharePrice, tick noise, test harness, devlog note on re-rating | ~1 session |
| **2. Trading engine** | portfolio state, BUY/SELL reducer cases, valuation snapshot ordering, delisting liquidation, migration defaults | ~1 session |
| **3. Server hardening** | allow-list, guardDecision (price injection, limits), sharePriceHistory in rival payload, egress check | ~½ session |
| **4. UI** | Markets tab, dossier trade ticket, dashboard tile, Finance rows, wiki/tour, mobile pass | ~1–1½ sessions |
| **5. Balance + QA** | Exploit harness (loan-pump, wash-trade, mutual-pump, delist), live-world smoke test in a dev world, tune constants | ~½ session |
| **6. Tailwinds mirror** | Solo wiring + UI mirror + devlog/sitemap | ~1 session |

Phase 1 is worth shipping alone even if trading waits — it fixes the leaderboard
exploits that exist today.

### Tunable constants (single source, e.g. `market.js` exports)

```
BOOK_WEIGHT 0.85 · FLEET_NAV_WEIGHT 0.9 · BOOK_FLOOR 0.40 · CONVERGENCE 0.30
WEEKLY_MOVE_CLAMP ±20% · NOISE ±1.5% · SPREAD 1% · COMMISSION 0.5%
MAX_OWNERSHIP_PCT 20% · MAX_PORTFOLIO_PCT_OF_CAP 40% · MIN_TICKET $100k
DELIST_HAIRCUT 0.75 · SHARE_PRICE_HISTORY_WEEKS 26 · TOTAL_SHARES 100M (unchanged)
```

### Verification checklist (Phase 5 gate)

- [ ] Loan of $50M changes market cap by ~$0 at next tick.
- [ ] Buying a $100M aircraft changes market cap by ≈ −$10M (cash→0.9×NAV), not −$80M.
- [ ] No airline's cap moves >20%+noise in one tick under any scripted scenario.
- [ ] Crossing from loss to profit re-rates over ≥3 weeks, not one.
- [ ] Wash trade (buy+sell same tick) loses ≈3%; 100 round trips lose ≈3% each, rate-limited.
- [ ] Two-account mutual pump converges (run 30 ticks, assert caps bounded).
- [ ] Client-supplied `pricePerShare` is ignored (guard injects; crafted decision at $0.0001 rejected/overridden).
- [ ] Purged rival → holder credited at 0.75×, toast fires, holding removed.
- [ ] Balance sheet still balances with an investments line; leaderboard sort unchanged in SQL.
- [ ] Old saves (no `portfolio`) tick cleanly; `safeInt` never sees NaN.

### Open questions for Dave

1. Confirm: portfolio counts toward leaderboard market cap? (Plan assumes yes.)
2. Happy with the side-game sizing (40% of cap max invested, 20% max ownership)?
   Bigger numbers make it a bigger part of the game.
3. Should the Markets tab be its own top-level tab or live inside Competition/Rivals?
4. Any appetite to fast-follow with dividends in v1.5? It's the cheapest of the
   future phases and gives long-term holders a reason to exist.
