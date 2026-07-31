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
| Turboprop | 39 | $3,481 | $100 | 2.9% |
| Regional Jet | 92 | $10,948 | $250 | 2.3% |
| Narrow Body | 186 | $35,731 | $750 | 2.1% |
| Wide Body | 420 | $206,703 | $4,000 | 1.9% |
| Double Deck | 605 | $337,862 | $7,500 | 2.2% |
| Supersonic | 128 | $161,269 | $3,250 | 2.0% |

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

**Rule 4 — the whole reference-fare ladder runs 5% lower (`NWR_FARE_INDEX = 0.95`).**
Applied to `referencePrice()` and `cargoReferenceYield()` alike, so freight is not a
loophole. Scaling the REFERENCE rather than realised revenue is deliberate: the
demand model prices elasticity off `playerPrice / referencePrice`, so moving both
together leaves demand untouched and simply lowers the ladder. Cutting revenue
directly would show players a fare they do not receive.

**Calibration — 0.95, and why it has to be flat and small.**

A fare index is a **market price**: every airline flying JFK-LAX faces the same
reference. An index that varies by who is asking is incoherent, so a maturity ramp
(index sliding with fleet size) was built and scrapped. It is one world constant.

Know what a flat revenue cut does, because it is not symmetric. At margin `m`, a
cut of `c` leaves `1 - (1-m)/(1-c)`:

| airline's margin | after a 5% cut |
|---|---|
| 4% | −1.1% |
| 10% | +5.3% |
| 15% | +10.5% |
| 33% | +29.5% |

It is deliberately small. The trim used to carry the whole burden of pulling mature
margins down, which a flat cut can never do without killing startups — it bites
hardest exactly where margins are thinnest. **Rule 5 (labour seniority) does that job
properly.** Together they land a mature carrier near 15%:

| airline age | seniority | mature margin |
|---|---|---|
| 0 | ×1.00 | 29.7% |
| 10 | ×1.63 | 23.4% |
| **20+** | **×2.50** | **14.6%** |

It bites hardest on thin operators and softest on fat ones — and softer still on a
big airline, because ~12.8% of a mature carrier's revenue is **ancillary** (bags,
seats, catering upsell) which no fare index touches. A "5% fare cut" is a 4.4%
revenue cut for them.

Two real airlines measured in this game, which is where those numbers come from:

| | small | mature |
|---|---|---|
| fuel | 35.8% | 21.0% |
| passenger services | 20.9% | 12.9% |
| flight ops | 18.0% | 12.3% |
| **margin** | **4.0%** | **32.8%** |

Note the 4% case was a deliberately-replicated *badly configured* airline —
four-class cabin with full catering on a two-hour domestic hop, 20.9% of revenue on
passenger services. It is not what a well-run startup looks like.

The intent: a restricted world is unforgiving of a badly configured airline, while a
well-run one keeps a real but thinner margin.

**History worth keeping.** Shipped 0.85 → measured a route needing 97% load to break
even → eased to 0.95 → removed entirely at 1.0 after a classic-world comparison
showed a small airline at 4% → restored to 0.85 once a mature airline showed 32.8%.
The lesson is that a single airline's margin says almost nothing: it is a point on a
maturity curve, and both 4% and 33% were mistaken for the baseline at different
points in one evening.

`tickConfig.fareIndex` overrides the default — but it is **seeded into airline state
at join**, so editing it moves only future joiners. Retune a live world with
`tools/rebase-world-fare-index.mjs`, which also repairs anyone who joined during a
deploy window without the restrictions flag at all.

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
