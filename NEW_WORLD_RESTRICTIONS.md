# New World Restrictions — as built

**Status: BUILT, on disk, uncommitted.** 2026-07-29. Headwinds only.
Supersedes `LEASE_RESTRICTIONS_PLAN.md` (moved to `_to_delete/`), whose premise was
wrong — see §6.

An optional per-world rule set, set at world creation like gate scarcity, riding in
the existing `World.tickConfig` JSON. **No migration.** Off by default; when off the
engine is byte-identical to today, asserted by test.

---

## 1. The two rules

**Rule 1 — lessors carry single-deck, previous-generation aircraft only.**
Entry into service on or before **2000**, plus a curated allow list, and **no
double-deckers at any age**. Anything bigger or newer must be bought — new from the
manufacturer, or used from another airline.

**Rule 2 — the lease order book is capped at `max(5, 25% of active fleet)`.**
Five frames on order until you operate 20 aircraft, scaling after. A rate limit, not
a level cap: it never stops an airline growing, it forces growth to happen in waves
with deliveries and P&L in between.

Purchases are untouched by both rules. They are already capital-gated.

## 2. Why rule 1 is not just a year test

`eis <= 2000` alone blocks the A380 (2007) and leaves **every other double-decker
open** — and they are all older, and cheaper:

| | seats | lease/wk | 196 frames, deposits |
|---|---|---|---|
| A380 (blocked by year) | 853 | $364k | $856M |
| 747-400 | 605 | $109k | $256M |
| 747-300 | 605 | $64k | $150M |

The 747-400 is 71% of the A380's seats for 30% of the rent. A year rule on its own
would have made the observed strategy roughly **six times cheaper** rather than
stopping it. Hence an explicit `doubleDeck` flag rather than a year threshold.

The same flag is carried on the **freighter** 747s. They sit in
`category: 'Freighter'`, so a category-based test would have missed the 747-400F
(112t, $138k/wk) and handed the identical strategy straight to cargo.

**Effect on the ceiling:** the largest leasable aircraft becomes the 777-200ER /
A330-300 / A340-300 at 440 seats — **2.33× a 737-800's seats per gate slot, down
from the A380's 4.51×. A 48% cut, with no change to slot maths.**

104 of 164 types remain leasable.

## 2b. The two economic levers (added after the leasing rules)

Investigating margins found the gap is **not** a missing cost line — it is the
fare-to-cost ratio. A leased 737-800 at 85% load runs 62.5% costs (real carriers
run 92-97%); owned, 52.6%. Otter Air's 30% net is *below* what a single well-run
route yields.

**Rule 3 — HQ overhead is charged per departure, by aircraft class.**
The classic curve prices overhead per AIRFRAME (`38,000 x fleet^0.85`), which for a
43-aircraft carrier turning $199M/wk is $931k — **0.47% of revenue**, against a
real-world G&A of 5-8%. Worse, counting airframes means an A380 and a Dash 8 cost
the same to administer, so upgauging dodges overhead entirely.

| class | median seats | rev/departure | fee | % of revenue |
|---|---|---|---|---|
| Turboprop | 39 | $3,481 | $200 | 5.7% |
| Regional Jet | 92 | $10,948 | $500 | 4.6% |
| Narrow Body | 186 | $35,731 | $1,500 | 4.2% |
| Wide Body | 420 | $206,703 | $8,000 | 3.9% |
| Double Deck | 605 | $337,862 | $15,000 | 4.4% |
| Supersonic | 128 | $161,269 | $6,500 | 4.0% |

A **flat** per-departure fee was rejected: revenue per departure spans 58x
($7,227 for a turboprop short sector to $419,804 for an A380 long-haul), so a flat
$5,000 would cost a regional operator 69% of revenue and an A380 operator 1.2%.
The class table holds the charge at 2.2-4.8% across the whole fleet.

Restricted worlds charge `HQ_BASE_WEEKLY ($40k) + per-departure fees` — a base, not
the fleet-size curve as a floor. Using the curve as a floor made the small-class
rates inert (at 10 aircraft it prints $269k, 5x what ten turboprops generate in
fees). Net effect vs classic: turboprop operator 0.4x, narrowbody 0.9x, widebody
2.5x, double-deck 3.5x.

Freighters are priced on their airframe's body class (`freighterBodyClass`), so a
747-400F pays the wide-body rate — no cabin, no cabin overhead. Note this differs
from the LEASING rule, where the same aircraft is blocked as a double-decker.

**Rule 4 — the whole reference-fare ladder is trimmed (`NWR_FARE_INDEX = 0.95`).**
Applied to `referencePrice()` and `cargoReferenceYield()` alike, so freight is not a
loophole. Scaling the REFERENCE rather than realised revenue is deliberate: the
demand model prices elasticity off `playerPrice / referencePrice`, so moving both
together leaves demand untouched and simply lowers the ladder. Cutting revenue
directly would show players a fare they do not receive.

**Calibration — shipped at 0.85 and corrected to 0.95 the same evening.** A fare cut
does not lower margins by its own size: it multiplies the **break-even load factor by
1/f**, because costs do not fall with fares. Measured on a real Old Metal route
(757-200, DFW-JFK, 2,235 km, catering off):

| fareIndex | margin at full load | break-even load |
|---|---|---|
| 1.00 | 16.5% | 82.5% |
| **0.95** | **12.1%** | **86.9%** |
| 0.90 | 7.3% | 91.7% |
| 0.85 | 1.8% | 97.1% |

At 0.85 the player was flying **98.9% load with fares 30% over reference and clearing
2%** — every route below 97% load lost money. Unplayable. 0.95 keeps break-even near
87%: meaningfully tighter than classic without making the world hostile.

The corollary worth remembering: **you cannot get world-average margins into the
3-8% band with a fare cut** without pushing break-even past 90%. Bringing the *best*
routes to ~12% is the realistic target.

`tickConfig.fareIndex` overrides the default — but it is **seeded into airline state at
join**, so editing it moves only future joiners. Retune a live world with
`tools/rebase-world-fare-index.mjs`, which also repairs anyone who joined during a
deploy window without the restrictions flag at all.

**Implementation note — module-scoped index.** `referencePrice(o, d)` is a pure
function called from ~12 sites across the demand model, competitor AI, encroachment,
positioning and network layers, none of which carry world context. Rather than
thread a parameter through ten signatures, `market.js` holds `_fareIndex` and it is
set from state at **three** choke points, all found and closed during the pre-push
review:

1. `reducer()` — on every action (covers every player action and every tick).
2. `buildWorldRivalViews()` in `humanRivals.mjs` — this prices rival fares via
   `referencePrice()` and `calcPositioning()` and runs **before** the reducer on
   every decision request, so without it a rival view was priced with whatever
   index the previous request left behind, feeding a 15%-wrong price ratio into the
   contested-route demand split. Set from the rows about to be priced, at both the
   passed-in and cache-miss paths (the rows do not exist until after the `findMany`).
3. `GameContext`'s lazy initialiser plus a `useEffect` on `state.fareIndex` —
   `useReducer(reducer, null, init)` does **not** run the reducer, so a restricted
   world rendered the Marketplace, FareEditor and route planners on the classic
   ladder until the player's first action.

If this feature is ever promoted from a per-world toggle to a global rule, thread
the index as a parameter instead — the discipline of "whoever prices, sets first"
does not scale.

## 3. Files changed

**Engine**
- `packages/engine/src/data/aircraft.js` — `eis` on all 164 types; `doubleDeck: true`
  on the 747 family + A380 (passenger and freighter); `LESSOR_EIS_CUTOFF`,
  `LESSOR_ALLOW`, `LESSOR_BLOCK`, `lessorSupplies()`, `leasableTypes()`,
  `LEASE_ORDER_BOOK_PCT/MIN`, `leaseOrderBookCap()`.
- `packages/engine/src/reducer.mjs` — exported **`leaseDenial(state, typeId, quantity)`**
  beside `gateLeaseDenial`; guards in `ORDER_AIRCRAFT`/`BUY_AIRCRAFT` (lease path only)
  and `LEASE_AIRCRAFT`.
- `packages/engine/reducer.mjs` — re-export the new helper.

**Server** (no migration)
- `lib/worldConfig.mjs` — validate + serialize `newWorldRestrictions`.
- `lib/worldService.mjs` — write to `tickConfig` at create; seed
  `state.newWorldRestrictions` at join.
- `routes/worlds.mjs` — create-world body schema.
- `routes/decisions.mjs` — 400 with the denial message on a blocked lease.

**Client**
- `apps/headwinds-web/src/App.jsx` — create-world toggle, lobby badge, world-header
  badge (`🔒 NEW WORLD RESTRICTIONS`).
- `src/components/Marketplace.jsx` — rules banner + live order-book meter; Lease
  buttons disabled with an inline reason on both the card and table layouts.
- `src/components/AircraftCheckout.jsx` — quantity ceiling clamped to free slots,
  slot readout above the stepper.

**Tests**
- `tools/new-world-restrictions-test.mjs` — 30 assertions, wired into `npm test` and
  `npm run test:nwr`.

## 4. `leaseDenial` is the single source of truth

The Marketplace calls it to disable and explain, the reducer calls it to block or
clamp, and the decisions route calls it to return a readable 400. A disabled button
and a rejected request cannot disagree because they are the same function.

A `order_book_partial` result carries `free`, so callers **clamp instead of
rejecting** — ordering 196 against 10 free slots places 10 and toasts what was
trimmed, mirroring the affordability trim that already existed in `ORDER_AIRCRAFT`.

`EXTEND_LEASE` is never blocked. Placed orders are never retro-cancelled when the
fleet shrinks; the tightened cap only gates *new* orders.

## 5. Verification

- **30/30 pass.** Falsification checked: with `leaseDenial` stubbed to return null,
  **12 of the 30 fail**, so the guard is provably load-bearing.
- Full Headwinds suite green — 37 test files, every one passing.
- The motivating case is covered directly: 196 A380 leases against a 43-aircraft
  fleet → **0 orders**; the 747-400 substitution → **0**; the 747-400F freight
  substitution → **0**; 196 737-800s → **clamped to 10**; buying an A380 →
  **still allowed**; flag off → **unchanged at 100**.

## 6. What this replaces, and what it does not fix

The original plan aimed at per-class lease *count* caps (50/30/20/10/10) on the
premise that leasing made growth too easy. Investigating the order that prompted it
(world "Scarce Assets", airline Otter Air, Y3W32) produced three findings, recorded
in project memory:

1. **The news feed publishes requested quantity, not filled quantity.**
   `newsService.mjs:258` reads `payload.quantity` and never consults what the reducer
   did — and for a purchase it can post a headline when **zero** aircraft were
   ordered. Latent misinformation vector in a game where rivals read the feed.
   **Not fixed here.**
2. **Net margins run ~30%** ($59.73M profit on $199.41M revenue, at rank #6) against
   a real-world 3–8%. This is the actual reason growth is easy. **Not fixed here.**
3. **Market cap sits ~60× below fair value** — Otter Air is priced at $197.77M while
   holding $419.43M of cash and earning ~$3.1B/yr. Affects SVPS standings, share
   issuance, and the cost of buying a rival. **Not root-caused.**

Neither rule in this document touches any of those. They shape *leasing*; a
cash-rich airline can still buy 196 A380s outright.

## 7. Not done

- Tailwinds setup-screen toggle (deferred until the test world settles the rules).
- Wiki article + devlog + Discord post.
- Deploy: build in the cloud, Railway API + worker, Vercel web.
