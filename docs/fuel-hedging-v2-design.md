# Fuel Hedging v2 — Scoreboard + Regime Walk Design

**Date:** 2026-08-13
**Scope chosen by Dave:** (A) hedge scoreboard + rival fuel-price comparison, then (B) fuel regimes with news foreshadowing. Caps/unwind instruments and A4 fare pass-through deliberately deferred.
**Revised 2026-08-13** after Dave's pushback — "I'm not sure it's clear to players how they can make (or lose) money from hedging" — adding Part C, a dollar-legibility layer that ships WITH Part A.
**Status:** design — no code written.

## Problem statement

After the A2 fix, `hedgeLockedPrice` prices off the OU forward curve (`expectedMeanIndex`) plus premium, so hedging is *fair* — but fair against a fully known, symmetric, memoryless walk (θ=0.06, σ=0.04, μ=1.0). The player and the hedge desk share the same model, so the only gap is the stated premium: hedging is always slightly −EV insurance with no information to act on. And nothing accumulates — the contracts table shows an instantaneous "vs market" but no realized outcome, so even a hedge that saved millions never says so.

Two fixes: make outcomes **visible** (scoreboard), then make the market **readable** (regimes + news), so hedging becomes a skill the scoreboard can showcase.

**Third gap (Dave, on review): the money mechanics themselves are illegible.** Everything on the hedge screen is denominated in dimensionless index multipliers — "lock at 0.991×", "3% premium" — with no dollars anywhere, and fuel isn't even a visible P&L line (it's folded into `totalOpCost` → "direct operating cost" in the pnlBridge). A player can't see how big their fuel bill is, so they can't see what hedging a fraction of it is worth, so they can't reason about making or losing money at all. Part C fixes the comprehension layer and ships alongside Part A: outcomes-after-the-fact (A) only teach if the player understood the bet they placed (C).

---

## Part A — Hedge scoreboard

### A1. Per-contract realized P&L

Every route sim already returns `fuelCost` (simulation.js:1750, 2192, and the cargo path). During ADVANCE_WEEK, after routes are simulated:

```
totalFuelSpend = Σ fuelCost over pax + tag + cargo results   // at the blended multiplier
baseBill       = totalFuelSpend / fuelMultiplier             // fuel bill at index 1.0
```

`fuelMultiplier` here is the blended value tickPrep already computed and passed into the sims, so `baseBill` is exact, not an estimate. Guard: if `fuelMultiplier <= 0` (impossible after the coverage sanitiser, but cheap to guard), skip accumulation that week.

Per active contract *i*, using the same normalisation `effectiveFuelMultiplier` uses:

```
covEff_i  = coverage_i × (totalCoverage / rawCoverage)        // rawCoverage may exceed 1
savings_i = baseBill × covEff_i × (currentFuelIndex − lockedPrice_i)
```

Positive = the hedge saved money this week. Accumulate onto the contract:

```
contract.realizedSavings = (contract.realizedSavings ?? 0) + savings_i
```

Notes:
- `currentFuelIndex` is the post-shock index from tickPrep (event shocks are folded in — A3 fix), so a hedge that rides through a spike gets credited for it. This is the payoff moment the feature exists for.
- Sum over contracts of `savings_i` ≡ `baseBill × totalCoverage × (index − weightedLocked)` ≡ the true difference between the unhedged and paid fuel bill. This identity is the accounting test (see Tests).
- Old saves: contracts without `realizedSavings` default to 0 via `?? 0` — no migration.

### A2. Lifetime record

New state field (default `{}` in the loader alongside `hedgeContracts` at reducer.mjs:5430):

```
hedgeStats: {
  lifetimeSavings: 0,     // Σ realizedSavings of all EXPIRED contracts
  contractsClosed: 0,
  wins: 0,                // expired with realizedSavings > 0
  losses: 0,
}
```

Fold a contract into `hedgeStats` at the tick where it drops out of `liveHedges` (tickPrep already computes the live/expired split — do the fold where `liveHedges` is written back as `hedgeContracts`). Keep the last few expired contracts in state as today for the "Recently Expired" card, but the durable record is `hedgeStats`.

### A3. UI (Finance → Fuel & Hedging)

- Active contracts table: new column **"Saved so far"** — `$fmt(realizedSavings)`, green/red/muted with the same ±threshold style as "vs Market".
- Recently Expired: replace the flat "expired" cell with final P&L, coloured.
- Summary tiles row: add **"Lifetime hedge P&L"** (from `hedgeStats.lifetimeSavings`) and **"Record"** (`wins–losses`).
- The buy panel copy already explains forward-curve pricing; no change.

### A4. Rival comparison (multiplayer)

Everyone in a world shares ONE fuel walk, so "what did each airline actually pay per unit of fuel" is a clean apples-to-apples number — and it's the public face of a private decision. Competition.jsx's privacy rule ("loans, hedges, marketing never appear") stays intact: we reveal the **outcome** (average price paid), never the contracts.

Mechanism:
- At MP tick time the server runs each airline's reducer and has `fuelMultiplier` (blended) per airline. Append `{ week, effIndex: fuelMultiplier }` to a rolling 13-week array in the airline's **public snapshot** (wherever Competition's StatTiles are sourced today).
- Competition per-airline view gets a tile: **"Avg fuel paid (13w)"** — `avg(effIndex)` vs the world spot average over the same weeks, with a delta ("6% below market" / "12% over market").
- Optional standings-style line in the news feed at quarter end (tier-2, category `standings`): "Cheapest fuel this quarter: Bob Airways at 0.97× — world average 1.18×". This is one `WorldNews` row written inside the tick transaction, same pattern as `gateForfeitureNewsRows`.

Solo/Tailwinds: AI rivals don't hedge, so show "you vs market" only (the tile degrades to spot average comparison). AI hedge personalities are a possible later add, out of scope here.

### A5. Tests

Extend `tools/fuel-hedge-test.mjs` or add `tools/hedge-scoreboard-test.mjs`:
1. **Accounting identity:** run N ticks with stacked contracts; assert Σ per-contract weekly savings == baseBill × totalCoverage × (index − weightedLocked) each week, and == (unhedged bill − paid bill) integrated over the run.
2. **Spike credit:** inject a fuel_spike event; assert the hedged contract's realizedSavings jumps by the shock share (proves the A3 fold-in reaches the scoreboard).
3. **Expiry fold:** contract expiring mid-run lands in hedgeStats exactly once (tick twice past expiry, no double count).
4. **Old-save heal:** blob with contracts lacking `realizedSavings` ticks cleanly.

---

## Part C — Dollar legibility (ships with Part A)

The rule for every surface: **denominate in dollars first, index second.** The index stays visible for chart-reading, but no decision point may show an index number without its dollar translation.

### C1. The fuel bill, front and center

Top of the Fuel & Hedging screen, before anything about hedging:

> **Your fuel bill: ~$8.4M/week** at today's price ($1.52/L, +5% vs normal). Unhedged share: $6.3M/week.

Computed from last week's summed `fuelCost` (already per-route in results — Part A stores the weekly total anyway for the scoreboard; reuse it, with a projection fallback for week 1). This one line is what makes every other number mean something: 50% coverage of $8.4M/week for 26 weeks is a ~$109M decision, and the player should see that scale before choosing.

Same number belongs in the P&L bridge as its own line — **break Fuel out of "direct operating cost"** (`fuelCost` is already separable in route results; pnlBridge change only). Once fuel is a visible line, a hedge visibly moves a line the player already watches. Add a sub-line when hedges are active: *"incl. hedge effect: −$210k"*.

### C2. Scenario preview at purchase — "what am I betting?"

The buy panel currently previews only the locked index. Replace with a three-scenario dollar table, computed for the selected duration+coverage from the current weekly bill (`weeklyBill`, held constant over the term — stated in a footnote):

| over 26 weeks | avg fuel price ends up | your hedge nets |
|---|---|---|
| Fuel falls (−15%) | $1.29/L | **−$3.1M** (locked in above market) |
| Fuel follows forecast | $1.47/L | **−$0.6M** (the premium — cost of certainty) |
| Fuel spikes (+25%) | $1.90/L | **+$4.7M** (protected from the spike) |

Formula per row: `cov × weeklyBill/spotIndex × (scenarioAvgIndex − lockedIndex) × weeks`. Scenario rows: −15% / forward-curve / +25% off the expected path (constants, tuneable). Plus one **break-even line** under the table: *"You come out ahead if fuel averages above $1.55/L (lock + premium) over the term."*

This is the make/lose-money answer in one glance: hedging costs the premium if nothing happens, pays off big if fuel spikes, costs you if fuel falls. The buy button confirms with the same framing ("Lock 50% of ~$8.4M/wk at $1.52/L for 26 weeks").

### C3. Cash feedback in the weekly loop

The scoreboard (A1) accrues `realizedSavings` silently. Surface it where the player already looks:

- **Weekly debrief / toast:** when |weekly hedge effect| crosses a threshold (say $100k), one line: *"Fuel hedges saved you $340k this week"* / *"cost you $120k this week"*. Threshold so quiet weeks stay quiet.
- **Contracts table (A3)** shows "Saved so far" in dollars — never in index points.
- **Contract expiry toast:** *"26-week hedge expired: net +$2.1M over its life."* This is the learning moment — the full arc of one bet, closed out in cash.

### C4. Copy pass

The buy panel's explanatory text should say the three-sentence truth plainly, in money terms: *"A hedge locks today's forward price for part of your fuel bill. If fuel gets more expensive, the hedge saves you the difference; if it gets cheaper, you overpay. Either way you pay a small premium for the certainty."* Kill any copy that requires knowing what an index multiplier is.

### C5. Tests

Extend the Part A suite: scenario-table math cross-checks the same identity as the scoreboard (a simulated term whose realized average equals a scenario row's index must produce that row's dollar figure ± rounding); P&L bridge fuel line equals summed `fuelCost`; break-even price = `lockedIndex × FUEL_PRICE_PER_LITRE` shown vs realized.

---

## Part B — Regime walk + news foreshadowing

### B1. Regimes

The walk keeps its OU form; a regime changes the **target μ and volatility σ**, never θ (so `expectedMeanIndex`'s decay math stays honest for the naive desk):

| regime | μ (target) | σ | typical dwell | notes |
|---|---|---|---|---|
| `calm` | 1.00 | 0.04 | 30–80 wk | today's walk, the default |
| `glut` | 0.78 | 0.05 | 10–25 wk | downside regime — cheap-fuel eras |
| `tight` | 1.28 | 0.06 | 10–25 wk | sustained squeeze |
| `crisis` | 1.60 | 0.09 | 4–10 wk | rare, short, only reachable from `tight` |

`tickFuelPrice(currentIndex, rand, mu = FUEL_BASE_INDEX, sigma = FUEL_VOLATILITY)` — two new defaulted params, existing callers unchanged. Clamp stays [0.55, 1.90].

Transition graph: `calm → glut | tight`, `glut → calm`, `tight → calm | crisis`, `crisis → tight` (crises decay through tight, they don't snap to calm). Per-week transition probability shaped so dwell lands in the ranges above, with a hard minimum dwell (e.g. 6 wk calm, 4 wk others) so regimes never flicker.

### B2. Foreshadowing — the skill loop

When a transition is drawn at week *w*, it does **not** take effect at *w*. Instead:

1. A **signal** is posted at week *w* (news item), naming a direction, not a regime: "OPEC members signal production cuts" / "Refinery strikes spreading" (→ tight), "Record inventories build at trading hubs" (→ glut), "Shipping lanes disrupted" (tight → crisis).
2. The transition takes effect at week *w + L*, with lead time **L drawn from 2–5 weeks** (seeded).
3. **Feints:** with probability ~30%, a signal is drawn WITHOUT a pending transition — the news posts, nothing happens, and a follow-up "tensions ease" item posts at w + L. Symmetrically, a small share of transitions (~10%) fire **unsignalled** (lead 0) so 100% coverage is never a pure formality.

The hedge desk stays **naive**: `hedgeLockedPrice` keeps pricing off `expectedMeanIndex` with base μ=1.0, θ=0.06, regardless of regime. That gap is the whole design — a player who reads a credible tight signal locks 26 weeks at a price the desk computes assuming reversion to 1.0, and profits when the walk instead reverts to 1.28. The edge is bounded three ways: coverage cap (100%), feint rate (~30% of signals cost you the premium for nothing), and the duration premium itself. A player who ignores the news entirely experiences today's game, minus nothing.

Existing `fuel_spike` / `fuel_drop` events stay as short shocks on top of the regime index. Cheap flavour add: weight their roll probability by regime (spikes 2× as likely in `tight`/`crisis`, drops 2× in `glut`) — one multiplier in the event roll, and it makes the world feel coherent.

### B3. Determinism & multiplayer — the hard constraint

`worldFuelIndex(seed, week)` and `worldEconomyAt` replay the walk from week 1 on every call. The regime machine must live **inside that replay**: per week, draw `seededRand(seed, 'fuelRegime:' + w)` for the transition/signal/feint/lead decisions (one namespaced draw per decision, e.g. `fuelRegime:w`, `fuelLead:w`, `fuelFeint:w`), then `seededRand(seed, 'fuel:' + w)` for the price shock exactly as today. Deterministic, stateless, replayable — signals for the news feed fall out of the same replay (the tick, at week *w*, asks the walk "did a signal fire this week?" and writes the `WorldNews` row inside its transaction, kind `fuel_outlook`; the regime change itself posts as kind `fuel_regime_change` when it lands).

**Existing worlds must not jump.** Changing the walk formula changes every replayed value, so a live world's current index — and every price its airlines already paid — would silently rewrite. Version the walk:

```
world.tickConfig.fuelWalkV: 1 (absent = 1) | 2
```

`worldFuelIndex` / `worldEconomyAt` branch on the version; new worlds get 2, existing worlds stay on 1 forever. (Same instinct as `tools/backfill-world-economy.mjs` / calendar rebasing: never rewrite a world's lived history.) Solo saves store the regime in `state.fuelPrice.regime = { id, weeksIn, pending: { to, atAbsWeek } | null }`; absent → `calm`, so old saves heal.

**Golden master:** the solo/HW golden re-baselines once (the walk consumes different RNG draws). Do it in the same commit as the walk change, per house rule.

### B4. Where the player sees it

- **News feed:** signals and regime changes are tier-1 `world` items — the feed is the instrument panel. No new UI needed for MVP.
- **Fuel & Hedging screen:** the fuel chart (52-wk history) already tells the story visually once regimes exist — sustained departures from 1.0 become *visible*. Add one line under the price header: the most recent active signal, if any ("⚠ Supply tension reported 2wk ago"), so a player landing on the hedge screen isn't required to have read the feed. Do **not** show the regime itself — the label would collapse the inference game.
- `fuelIndexStatus` bands unchanged.

### B5. Balance sketch

Rough EV of a correctly-read tight signal, 26-wk lock at 50% coverage: naive lock ≈ 1.0×(1+0.10) = 1.10; realized average under tight (μ=1.28 from ~1.0 spot, θ=0.06) ≈ 1.19 over the term → ~0.09 index points × 50% of a fuel bill that is typically 30–40% of opex. Meaningful, not game-breaking — and a feint costs the ~0.06–0.10 premium on the same coverage, so signal-chasing without judgement nets roughly zero. Tune feint rate and μ_tight against that symmetry; these four numbers (μ per regime, feint rate) are THE balance knobs, keep them exported constants in fuel.js.

Interaction with the deferred A4 (fare pass-through): once fares lag fuel, regimes get sharper teeth (crisis squeezes the unhedged specifically). The regime design needs no change to accommodate it later — A4 reads the same index.

### B6. Tests

New `tools/fuel-regime-test.mjs`:
1. **Replay equality:** `worldFuelIndex(seed, w)` twice → identical; v1 worlds byte-identical to today's values across a long horizon.
2. **Dwell bounds:** simulate 5,000 weeks across seeds; assert min-dwell respected, dwell distributions land in the table's ranges, crisis only ever follows tight.
3. **Signal contract:** every effected transition (minus the ~10% unsignalled share) had a signal exactly L∈[2,5] weeks prior; feints post ease-items; all replayable from seed.
4. **Naive desk:** `hedgeLockedPrice` output is unchanged by regime (byte-for-byte vs v1 given the same spot) — the desk must never leak regime knowledge.
5. **Old-save heal:** solo blob without `fuelPrice.regime` ticks as calm.

---

## Sequencing

1. **Ship A + C together first** (scoreboard + dollar legibility). No walk change, no golden re-baseline, no world versioning — additive state + UI. C is what makes A teach; A is what makes C's promises verifiable. Both repos (A1–A3 + C; the rival tile A4 is HW-only).
2. **Then B** as its own pass: fuel.js params → regime machine in worldEconomy.mjs + solo reducer path → news rows → golden re-baseline → `fuelWalkV` gate. B's news signals also inherit C's framing: a supply-tension item should say what it might do to *your weekly bill*.
3. Revisit deferred items (fare pass-through A4-audit, caps/unwind, AI hedge personalities) once B has soaked in a live world. Note the honest caveat: until fare pass-through exists, big fuel moves mostly move everyone's margins in parallel — C makes the dollars visible, but the *strategic* stakes only fully arrive with pass-through.

## Open questions for Dave

1. Rival tile window: 13 weeks (quarter) feels right — or lifetime-in-world?
2. Should the quarter-end "cheapest fuel" news line name the *most over-market* airline too? Fun, but it publicly dunks on someone every quarter.
3. Feint rate 30% / unsignalled 10% — comfortable starting points, or want them meaner/kinder?
4. TW parity for B: port the regime walk to solo Tailwinds too, or keep regimes an HW-multiplayer flavour? (Scoreboard A should port regardless.)
