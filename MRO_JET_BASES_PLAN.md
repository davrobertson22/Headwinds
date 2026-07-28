# MRO Network & Jet Bases — Design & Implementation Plan

**Status:** **BUILT 2026-07-28** — engine, UI, tests and MP guards in BOTH repos, on disk,
suites green (HW 456, TW 232). Alliance hosting (§5) is deliberately NOT landed — see AS BUILT below.

### AS BUILT — what shipped, and how it differs from this plan

| Planned | Shipped |
|---|---|
| AOG cost 0.25 / 0.6 / 1.2% of purchase price | **0.2 / 0.5 / 1.0%, multiplied by an age curve** (1.0× new → 3× at 20y → 5.5× at 30y). Without the age term the write-off branch was mathematically unreachable — max repair cost sat below the NAV floor — so write-offs only happen to genuinely elderly airframes, which is the intended drama. |
| Remove hub `maintFactor`, 26-week grandfather | **Kept.** Hub and base factors take the BEST of the two rather than stacking, so nothing is taken away from anyone and no grandfather window or migration is needed. |
| 8-week ramp on the cost increases | **Not built.** The increases land in full; the devlog explains them. One less moving part in live worlds. |
| Upgrading takes the base offline for the new level's build time | **Upgrades build in place** — the existing level keeps working throughout (`upgradeTo` / `upgradeWeeksLeft`). Losing a working hangar for six months to upgrade it was a bad deal nobody would take. |
| Parts pool at 0.4% of capex per week | **0.15%.** At 0.4% the pool cost as much as a Heavy MRO's entire opex, making the dial the dominant cost rather than a lever. |
| Prisma `MroBase` model + migration | **Not needed yet.** Bases live in the airline's state blob like hubs and pre-scarcity gates. The DB model is only required to make bases visible to OTHER players, which is the alliance-hosting feature below. |
| §5 alliance hosting | **Engine primitives built and tested** (`mroFactorsFor(..., { guest: true })`, `allianceHostFee()`, guest discount/fee symmetry) but the cross-airline settlement is NOT wired. Moving money between airlines is the exact shape of the 2026-07-27 float-pool dividend bug and deserves its own focused pass with a reconciliation tool, not the tail end of a long session. |

Also added beyond the plan: a reserve stationed at one of your own open bases gets a
10% discount on its readiness premium (open question #4, answered yes). Freighters ride
their passenger family's certification (open question #1) — this falls out of `families.js`
for free. Base transfer (#2) and third-party MRO sales (#3) remain deferred.

**Original plan follows, unchanged.**

---

**Status (original):** PROPOSED — 2026-07-28
**Scope:** Headwinds (multiplayer) **and** Tailwinds (solo). The engine work is shared; only
alliance settlement differs between the two.
**Decisions locked with Dave (2026-07-28):**

| Question | Decision |
|---|---|
| Where can a jet base be built? | **Any airport where you hold enough gates** — decoupled from hub tier, still gated by gate scarcity |
| How much more expensive is maintenance? | **~1.75–2×** overall, concentrated in fixed + event costs (see §4) |
| Who may use your base? | **Alliance members only**, at a **world-set rate** — no player-set pricing, no negotiation UI |
| Repos | **Both** — full system in HW, same page + bases + rebalance in TW |

---

## 1. The idea

Maintenance today is a slider and a queue. It lives inside Operations next to labour pay, it costs
about 1% of what a real airline spends on fixed MRO infrastructure, and the only spatial decision in
it is an accidental one: `aircraftHubMaintFactor()` gives a 5–8% discount if an aircraft happens to
fly through a Major Hub. Nothing about maintenance rewards planning.

The proposal turns MRO into a **network you build**, parallel to (and interacting with) the route
network:

1. **Maintenance becomes its own page**, out of Operations, in the Company dropdown.
2. Airlines **build jet bases** — hangars at specific airports, **certified for specific aircraft
   families**. A base cuts what a check or a breakdown costs *and* how long the aircraft is stuck.
3. Breakdowns finally **cost money**, not just downtime — which is what gives a base something to
   discount and makes an old fleet genuinely frightening.
4. **Alliance members may use your bases** and pay you for the privilege — the first purely
   cooperative revenue line in Headwinds, and a real reason to care who is in your alliance beyond
   the interline trickle.
5. **Maintenance gets roughly twice as expensive**, concentrated where it will not retroactively
   break live worlds' route economics.

The strategic shape it creates: a standardised fleet flying through a couple of well-equipped bases
is cheap and resilient. A ragbag of nine families scattered across a continent bleeds. That is the
real industry's core tension, and right now the game barely models it.

---

## 2. What exists today

Worth stating plainly, because the plan reuses almost all of it.

**`packages/engine/src/data/maintenance.js`** — heavy checks are already good. C at 4,500 block hours
or 104 weeks, D at 24,000 / 312, dual-trigger wear from actual hours flown, grace windows, forced
groundings with a 1.5× rush cost and a reputation hit, a D-check age credit, valuation modifiers so
you cannot sell your way out of a due check, and the auto-scheduling rule added last week
(pay ≥ 1.30× **and** budget ≥ 1.30× → checks book themselves). `checkCost()` already takes a
`hubFactor` parameter — **the hook for jet bases is already in the signature.**

**`packages/engine/src/data/families.js`** — 30-odd families, each with a flat `weeklyBaseCost`
charged if you operate ≥ 1 airframe from it ($8K turboprop → $55K A380). This is the "fleet
complexity" line in Operations. Conceptually it is *already* an outsourced MRO contract; it has just
never been named as one or given an alternative.

**`packages/engine/src/data/events.js`** — `rollMechanicalFailures()` rolls per airframe per week
off `weeklyWearFailureProb()`, picks from eight failure templates, and grounds the aircraft for 1–5
weeks. **It has no cost and no location.** An engine fault is currently free.

**`packages/engine/src/data/reserve.js`** — hub-stationed, same-type standby aircraft that auto-cover
grounded tails. Shipped last week; jet bases should compose with it, not compete.

**Hubs** (`HUB_TIERS` in `models/demand.js`) carry `maintFactor` 1.0 / 1.0 / 0.95 / 0.92 —
essentially a rounding error, and the only geography maintenance currently has.

**MP:** `Alliance` / `AllianceMember` tables exist and are DB-authoritative; gate scarcity
(`WorldGate`, sealed-bid auctions, 60%/80% caps) is the precedent for a contested world-level
resource; `decisionGuard.mjs` validates every player action server-side; `tickService.mjs` runs the
shared engine reducer.

---

## 3. The jet base model

### 3.1 What a base is

A base is a record keyed by **airport × airline**, carrying a **level** and a set of **family
certifications**:

```js
state.mroBases = {
  LHR: {
    code: 'LHR',
    level: 2,                                  // 1 = Line Station, 2 = Maintenance Base, 3 = Heavy MRO
    families: ['boeing_737', 'airbus_a320'],   // certified types
    openedWeek: 412,                           // absolute week; drives the efficiency ramp
    buildWeeksLeft: 0,                         // > 0 while under construction
    partsPool: 1.0,                            // 0.5–2.0 spares-inventory slider
    slotsInUse: 3,                             // derived each tick, not persisted authoritatively
  },
}
```

Certifications are per **family**, not per type — the same granularity as the existing fleet-complexity
cost, so the two systems talk to each other cleanly. A 737 base covers every 737 variant you fly.

### 3.2 The three levels

| | L1 · Line Station | L2 · Maintenance Base | L3 · Heavy MRO |
|---|---|---|---|
| Capex | $4M | $25M | $90M |
| Weekly opex | $30K | $120K | $350K |
| Build time | 4 weeks | 12 weeks | 24 weeks |
| Gates required at the airport | 2 | 4 | 6 |
| Family certifications included | 1 | 2 | 4 |
| Extra certification | $1.5M + $10K/wk | $4M + $25K/wk | $8M + $40K/wk |
| Shop slots (concurrent airframes) | 2 | 4 | 8 |
| Handles | AOG + line | AOG + line + **C checks** | AOG + line + C + **D checks** |

Upgrading L1 → L2 → L3 costs the difference in capex plus a 15% conversion premium, and takes the
higher level's build time. Closing a base refunds 25% of capex and frees the gates.

**Gate requirement** is the siting rule Dave picked: the gates must be gates you already hold at that
airport, and they are **consumed** — a gate assigned to the hangar is not available for flying. In a
gate-scarcity world this is a genuinely painful trade at a congested airport, which is exactly right:
Heathrow should be a terrible place to put a heavy maintenance base.

### 3.3 What a base does for you

A base helps an aircraft when **(a)** the base is certified for that aircraft's family, **(b)** the
aircraft's network touches that airport (same test as today's `aircraftHubMaintFactor`, reusing the
same route-scan), and **(c)** a shop slot is free.

| Benefit | L1 | L2 | L3 |
|---|---|---|---|
| AOG repair cost | ×0.70 | ×0.60 | ×0.55 |
| AOG downtime | −1 wk | −1 wk | −2 wks |
| C check cost / downtime | — | ×0.70 / −1 wk | ×0.65 / −1 wk |
| D check cost / downtime | — | — | ×0.70 / −2 wks |
| Line maintenance factor | ×0.98 | ×0.95 | ×0.90 |
| Family outsourced contract | −25% | −60% | −85% |

Downtime never drops below 1 week. The **family contract offset** is the one that makes the maths
interesting: a $42K/wk A350 contract (post-rebalance $80K/wk — see §4) is 85% erased by a Heavy MRO
base, which pays a big chunk of that base's $350K opex before a single check happens. Concentrate one
family through one base and it nearly pays for itself; spread four families across four airports and
you are paying four opex bills for four partial offsets.

**Shop slots** are the scarcity that makes bases a planning object rather than a passive discount.
Every airframe in a check or an AOG repair at that base occupies a slot for its whole downtime. When
slots run out, overflow work goes **outsourced** — full price, full downtime, no discount — and the
weekly debrief says so by name. Your own aircraft always take priority over alliance guests.

### 3.4 Two mechanics that add texture cheaply

**Parts pool** — a per-base slider, 0.5× to 2.0×, costing `0.4% of base capex × pool` per week in
tied-up inventory. It multiplies AOG downtime by `1 / sqrt(pool)`: a 2.0× pool at a Heavy MRO base
turns a 4-week engine fault into a 3-week one. Cheap to implement (one number, one formula), and it
gives players a dial to fiddle with between checks.

**Efficiency ramp** — a base opens at 60% of its stated benefits and reaches 100% over 26 weeks
(linear). It stops a cash-rich player from buying instant immunity the week their fleet starts to
wear out, and it makes the build decision a genuine bet on where your network will be in six months.

---

## 4. The cost rebalance

The guiding constraint: **do not change `baseMaintenancePerWk`.** It feeds per-route operating cost,
and raising it would push existing routes in live worlds into the red overnight through no decision
of the player's. Every increase below lands on **fixed overhead** and **events** — costs that sit at
the airline level, where players can respond by building bases, standardising, or retiring old metal.

| Lever | Today | Proposed | Rationale |
|---|---|---|---|
| Family `weeklyBaseCost` | $8K–$55K | **×1.9** ($15K–$105K) | The headline "MRO costs seem low" fix. Bites hardest on small operators of many families, which is correct. |
| `C_COST_PCT` | 1% | **1.8%** | A C check on a $55M 737 goes $550K → $990K, once every ~2 years. |
| `D_COST_PCT` | 6% | **10%** | $3.3M → $5.5M on that 737; $9M → $15M on an A380. Roughly real-world scale. |
| AOG repair cost | **$0** | **new** — 0.25% / 0.6% / 1.2% of purchase price by minor / major / severe | The biggest single change. A structural crack on an A380 becomes a $1.8M event, not a free three-week nap. |
| `OVERDUE_MAINT_MULT` | 1.25 | 1.40 | Neglect should sting more now that there is a real alternative. |
| Hub `maintFactor` | 0.95 / 0.92 | **removed** | Superseded by bases. Hubs keep every other benefit; grandfather existing worlds for 26 weeks (see §8). |

Worked example — 40 narrowbodies (~$55M each), three families, average age 9 years, so a weekly
mechanical-failure probability around 2.5% per airframe:

| Line item | Today | Proposed |
|---|---|---|
| Line maintenance (40 × $57.6K) | $2.30M/wk | $2.30M/wk *(unchanged, by design)* |
| Family contracts (737 + A320 + E-Jet) | $56K/wk | $106K/wk |
| C checks amortised (40 ÷ 104 wks) | $211K/wk | $380K/wk |
| D checks amortised (40 ÷ 312 wks) | $423K/wk | $705K/wk |
| AOG repairs (~1 event/wk) | $0 | $275K/wk |
| **Everything except line maintenance** | **$690K/wk** | **$1.47M/wk — 2.1×** |
| **Total maintenance** | $2.99M/wk | $3.77M/wk — **+26%** |

That is the shape Dave asked for: heavy checks and MRO base costs roughly double, total spend rises
by about a quarter, and **route-level economics do not move at all**. A player who builds two
well-chosen L2 bases recovers most of the increase. A player who ignores the system pays it.

A player who builds two well-chosen L2 bases recovers most of it. A player who ignores the system
pays it. That is the intended shape.

**One safety valve:** AOG repair cost is capped at 60% of the airframe's current NAV, so a
near-worthless 25-year-old jet cannot generate a repair bill larger than the aircraft. Past that
point the aircraft is written off and retired with an insurance payout — which, pleasingly, gives
hull insurance a reason to exist.

---

## 5. Alliance sharing

Locked as **alliance-only at a world-set rate**. No haggling, no price UI, no griefing surface.

When an alliance partner's aircraft needs an AOG repair or a heavy check, and **your** base is
certified for its family and sits on that aircraft's network:

- The guest receives **half the host's cost discount** and **−1 week** of downtime.
- The guest pays the host a **hosting fee = 15% of the undiscounted job cost**.
- Net to the guest on an L2 C check: 15% off the cost minus a 15% fee ≈ **break-even on cash, one
  week back on downtime** — worth it, but not free money.
- Net to the host: **pure margin** on capacity they already own.
- The job **consumes a shop slot**. Host aircraft always take priority; guests only ever use slack.

Constants live in one place (`ALLIANCE_HOST_FEE_PCT`, `ALLIANCE_GUEST_DISCOUNT_FRACTION`) so the
balance can be tuned without touching logic.

This is deliberately a **small** number per event and a **large** number in aggregate for a big
alliance with well-sited bases. It gives alliances something to coordinate about — "who covers the
A320s in Asia?" is a much better group chat than the current "please join, +6% demand".

**Tailwinds (solo):** AI alliance members generate the same revenue passively. Reuse
`countAdjacentRoutes()` from `alliances.js` — each member's routes adjacent to a base airport
generate a weekly hosting fee at the same rate. Symmetrically, when you are in an alliance your own
aircraft get the guest discount at member hubs. Same numbers, no cross-airline settlement needed.

---

## 6. The Maintenance page

New nav entry in the **Company** group, between Operations and Ancillaries:

```js
{ id: 'maintenance', label: 'Maintenance', Icon: WrenchIcon }
```

### Moves out of Operations

- Maintenance Budget card (slider, projection, auto-scheduling status)
- Heavy Checks status card
- Fleet Complexity / MRO Base Costs table — **reframed** as "Outsourced MRO Contracts", with each
  family row now showing which of your bases covers it and the resulting offset

Maintenance-team pay stays in Operations (it shares the morale model with the other labour groups)
but the control is **mirrored** on the Maintenance page — same action, no duplicated state — since
it gates auto-scheduling and belongs in the player's field of view here.

### New on the page

1. **MRO Network map** — your bases as cards: airport, level, certified families, slot utilisation
   this week, weekly cost, alliance hosting revenue earned. A "Build base" flow with the gate
   requirement and family picker.
2. **Shop board** — every airframe currently in a check or AOG repair, where it is, weeks left, what
   it cost, and whether it went to your base or outsourced. This is the screen the game is currently
   missing entirely; today that information is scattered across Fleet rows and toasts.
3. **Due queue** — the fleet-wide C/D check list currently buried in Fleet's bulk-action bar, with
   the base each check would route to and the cost either way. Keep the Fleet bulk actions as well;
   they are good, they just should not be the only home.
4. **Cost breakdown** — line, heavy, AOG, contracts, base opex, hosting revenue, as a weekly stacked
   trend. Follows the `dataviz` conventions already used elsewhere.
5. **Alliance panel** (HW) — partner bases you may use, and what your bases earned from partners.

---

## 7. Implementation

### Phase 1 — Engine: cost rebalance + AOG cost *(no new concepts)*

- `data/families.js`: `weeklyBaseCost` ×1.9.
- `data/maintenance.js`: `C_COST_PCT` 0.018, `D_COST_PCT` 0.10, `OVERDUE_MAINT_MULT` 1.40; new
  `AOG_COST_PCT_BY_SEVERITY`, `AOG_COST_NAV_CAP`, `aogRepairCost()`.
- `data/events.js`: `rollMechanicalFailures()` returns `repairCost` per failure; add the write-off
  branch when cost exceeds the NAV cap.
- `reducer.mjs`: charge `repairCost` in the weekly tick, add to `lastReport.mechanicalFailures`,
  surface in the toast and WeeklyDebrief.
- Ships alone and is worth shipping alone — it is the "maintenance is too cheap" fix.

### Phase 2 — Engine: the base model

- New `packages/engine/src/data/mroBase.js` — every constant in §3, plus `baseFactorFor(aircraft,
  bases, routes, cargoRoutes)` returning `{ level, costMult, weeksSaved, slotAvailable }`.
- Reducer actions: `BUILD_MRO_BASE`, `UPGRADE_MRO_BASE`, `ADD_BASE_CERTIFICATION`,
  `SET_BASE_PARTS_POOL`, `CLOSE_MRO_BASE`. Gate-availability check on build; capex and build-week
  countdown in the tick.
- Wire the factor into `checkCost()`'s existing `hubFactor` argument (rename to `baseFactor`), into
  `checkDurationWeeks()` call sites, into AOG cost/duration, and into the fleet-cost loop's line
  maintenance and family-contract terms.
- Slot allocation runs once per tick: own aircraft first (D before C before AOG), then guests,
  then overflow to outsourced.

### Phase 3 — UI

- `src/components/Maintenance.jsx` (new page), nav entry, section moves out of `Operations.jsx`,
  shop board, build flow, cost chart.
- `Fleet.jsx`: check rows show the base each check would route to and both prices.
- `WeeklyDebrief.jsx`: an MRO block — jobs done, where, saved vs outsourced, hosting revenue.
- `Wiki.jsx`: a Maintenance & MRO section.

### Phase 4 — Multiplayer

- Prisma model `MroBase` (`worldId`, `airlineId`, `code`, `level`, `families Json`, `openedWeek`,
  `buildWeeksLeft`, `status`) + migration `20260728000000_mro_bases`, RLS enabled inside it as with
  the gate-scarcity migration.
- `decisionGuard.mjs`: guards for each new action — gate ownership, cash, family validity, level
  progression, one base per airport per airline.
- `tickService.mjs`: settle alliance hosting fees **as an explicit cross-airline transfer**. This is
  the exact shape of the float-pool dividend bug from 2026-07-27 — money moving between airlines
  must be booked against normalised airline keys and reconciled, not inferred. Write the
  reconciliation tool alongside it, not after.
- `GET /worlds/:id/mro-bases` so players can see partner bases; bases mutate the **world** half of
  the split change stamp.
- Feed events via `newsService.mjs` when a Heavy MRO opens — a $90M hangar going up at a contested
  airport is news.

### Phase 5 — Tailwinds port

Same engine files (they are byte-identical between the repos), same page, same rebalance. Alliance
sharing collapses to the passive AI model in §5. Watch the two known traps: HW's `src/data/*.js` are
re-export shims to `packages/engine/src/data/`, so **edits go in the engine package**; and TW's
`src/store/_engine.generated.mjs` is stale — import `gameReducer` from `GameContext.jsx`.

### Testing

`tools/mro-base-test.mjs` in **both** repos, wired into the `npm test` chain in **both** repos:
AOG cost and the NAV write-off cap; base benefit application and the family/network/slot gating;
slot overflow to outsourced; the efficiency ramp; alliance fee and discount symmetry (host credit
exactly equals guest debit); build-week countdown; gate consumption and the refusal to build without
gates. Per the aircraft-picker regression: **verify each test fails without its fix before
committing**, and confirm the change is actually in both repos' git, not just on disk.

---

## 8. Migration and live worlds

Live worlds are the real risk here — this changes costs under running airlines.

- Existing saves get `mroBases: {}` and behave exactly as today apart from the Phase 1 rebalance.
- **Grandfather window:** hub `maintFactor` stays live for 26 weeks after deploy, tapering to 1.0,
  so an airline that built a Major Hub partly for the maintenance discount has two quarters to build
  a base instead. Announce it in-game via the news feed.
- **Rebalance ramp:** phase the family-contract and check-percentage increases in over 8 weeks
  (linear from 1.0× to the new value) rather than as a step. A player who wakes up to a doubled
  fixed-cost line and no warning will be justifiably annoyed, and it is one constant to implement.
- AOG cost starts at 100% immediately — it is new revenue-neutral risk, not a repricing, and
  delaying it just delays the reason to build bases.

---

## 9. Open questions for Dave

1. **Freighters and wet-leased metal** — do freighter families get their own certifications, or ride
   on the passenger family (a 767F on a `boeing_767` base)? Riding along is simpler and probably
   right.
2. **Base transfer** — should a base be sellable to another airline the way gates are? It would be a
   nice endgame market, but it is a whole flow; suggest deferring past v1.
3. **Third-party MRO revenue** — selling slack capacity to *AI competitors* (not just alliance
   members) is a natural extension and a genuinely different business model to run. Deliberately out
   of scope here per the alliance-only decision, but worth flagging as the obvious v2.
4. **Interaction with reserves** — should stationing a reserve at a base airport get a discount on
   its readiness premium? A hangar with your own mechanics in it arguably should. Cheap to add.
5. **The 8-week ramp in §8** — worth the complexity, or just ship the new numbers and post about it?
