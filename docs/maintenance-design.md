# Headwinds Maintenance Overhaul — C/D Check System (Design v1)

**Date:** 2026-07-24
**Status:** Design for review — no code written yet
**Scope decisions (agreed):** C + D checks only (A/B abstracted into line maintenance) · manual scheduling with forced-overdue grounding · wear model replaces raw-age failure probability · implement in Headwinds first, mirror to Tailwinds after playtest

---

## 1. Goals

- Turn maintenance from a passive weekly cost into a **planning mechanic**: aircraft periodically need heavy checks that take them out of service, and *when* you send them matters (seasonality, route coverage, cash).
- Make check discipline **mechanically rewarded**: a fresh airframe flies reliably; an overdue one breaks down, and eventually the regulator parks it for you.
- Create a real **end-of-life decision**: pay for a D check on a 20-year-old airframe, or retire/sell it — the same call real fleet planners make.
- Keep it fully **deterministic-enough for multiplayer**: all player choices go through the existing decision pipeline; all periodic effects run in the weekly tick reducer.

**Non-goals (v1):** hangar/MRO capacity limits, ferry-to-MRO, engine-swap modelling, per-component tracking. These are Phase 3 candidates (§11).

---

## 2. What exists today (audit)

| Mechanic | Where | Notes |
|---|---|---|
| Weekly maintenance cost | `simulation.js` weeklyTick (~L2341) | `baseMaintenancePerWk × maintenanceMultiplier(ageWeeks) × maintenanceBudget × laborMult × maintMod × hubLineMaintFactor` |
| Age cost curve | `simulation.js` L749 `maintenanceMultiplier` | 1.0× new → ~1.5× @10y → ~3.0× @20y |
| Budget slider | `SET_MAINTENANCE_BUDGET` (reducer L1759), clamped 0.5–2.0 | Scales weekly cost, **divides** failure probability, and drives `agingRate` (low budget → faster aging, reducer L2151) |
| Random failures | `events.js` L740 `mechanicalFailureProb` / `rollMechanicalFailures` | Pure age-based: ~0.5%/wk new → ~15%/wk @20y; grounds 1–5 weeks |
| Grounding machinery | reducer L2153 (countdown), L2384 (apply), `status: 'grounded'` + `groundedWeeksLeft` | Grounded aircraft earn no revenue (simulation.js L2006, L2291), excluded from utilization & deployment |
| Block hours | `simulation.js` L568 `MAX_WEEKLY_BLOCK_HOURS = 140`, `routeBlockHours()` | Per-aircraft weekly hours are already computable from assigned routes |
| Labor | `maintenanceTeam` labor group exists | Morale/pay already feeds `maintenanceCostMultiplier` |
| MP pipeline | `decisions.mjs` → `ALLOWED_PLAYER_ACTIONS` (world.mjs) → `guardDecision` → shared reducer | New actions need allow-listing + a guard |

**Key insight:** everything the check system needs already exists — per-aircraft `ageWeeks`, block-hour math, an out-of-service status with countdown, and a decision pipeline. This is additive, not a rewrite.

---

## 3. Player experience (narrative)

Your A320 has been flying 9× daily SFO–SEA for a year and a half. The Fleet tab shows an amber chip: **C check due in 6 wks**. You open the aircraft row, see the check costs $480k and takes 1 week, and schedule it for the first week of February — demand trough, and your spare A320 can cover the route. The week it goes in, the Weekly Debrief lists it under Maintenance; a week later a toast confirms it's back, and its failure risk indicator drops back to green.

Three years later the same airframe shows **D check due** — $4.2M and 4 weeks down. It's 22 years old and worth $11M. You check the resale price, decide the D check doesn't pencil out, and sell it instead — at a 15% haircut because it's due, but that beats $4.2M plus a month of lost revenue.

Meanwhile your rival has been ignoring checks to keep planes flying through the summer peak. Their 767 blows past the grace window; the regulator grounds it on the spot — 6 weeks, 1.5× cost, and a reputation hit — right in August.

---

## 4. The wear model

### 4.1 New per-aircraft state

```js
{
  hoursSinceC: 0,      // block hours flown since last C check (or delivery)
  hoursSinceD: 0,      // block hours flown since last D check (or delivery)
  weeksSinceC: 0,      // calendar weeks since last C (idle planes still age)
  weeksSinceD: 0,
  maintAgeCredit: 0,   // weeks of effective-age credit from D checks (§5.4)
  scheduledCheck: null // { type: 'C'|'D', startWeek } or null
  // during a check: status: 'maintenance', checkType: 'C'|'D', checkWeeksLeft: n
}
```

### 4.2 Accrual (weekly tick, alongside the existing `agedFleet` map at reducer L2384)

- `hoursFlown = Σ routeBlockHours(r, type, r.weeklyFrequency)` over the aircraft's assigned pax **and cargo** routes that are active this month (skip seasonal-dormant routes — reuse `isRouteActive`).
- Grounded / in-maintenance aircraft accrue **0 hours** that week; `weeksSince*` still increments for everyone.
- Idle spares accrue hours ≈ 0 → they mostly come due on the calendar clock, much later. Flying a plane hard genuinely wears it faster. This is the strategic heart of the system.

### 4.3 Failure probability rewrite (`mechanicalFailureProb`)

Replace the raw-age curve with wear-since-check, keeping age as a mild background term:

```js
wearC = hoursSinceC / C_HOURS_DUE     // 1.0 = exactly due; >1 = overdue
wearD = hoursSinceD / D_HOURS_DUE
ageTerm = Math.pow(ageYears / 25, 1.2) * 0.02

prob = Math.min(0.35,
  (0.002 + 0.03 * wearC ** 2 + 0.06 * wearD ** 2 + ageTerm)
  / Math.max(0.5, maintenanceBudget))
```

Resulting behaviour (budget = 1.0):

| State | Weekly failure prob |
|---|---|
| Fresh out of C+D | ~0.2–0.5% |
| Halfway to C | ~1% |
| C due now | ~3.5% |
| C overdue by half a grace window | ~5–6% |
| D due on a 20-year-old | ~10%+ |

Checks now *visibly buy reliability* — the incentive the current system lacks. The overdue quadratic means ignoring checks compounds fast but never feels arbitrary.

The budget slider keeps its current three roles unchanged (weekly cost scale, failure divisor, aging rate). Its identity sharpens to "line maintenance quality" — the A/B-check layer, abstracted.

---

## 5. C and D checks

### 5.1 Due rules (dual trigger — whichever comes first)

| | Hours trigger | Calendar trigger | Real-world anchor |
|---|---|---|---|
| **C check** | 4,500 block hrs | 104 wks (2 game years) | ~20–24 months / 4,000–6,000 FH |
| **D check** | 24,000 block hrs | 312 wks (6 game years) | ~6–10 years, "heavy maintenance visit" |

At a typical 60–80 block hrs/wk, C lands every ~60–75 weeks and D every ~5–6 years; a maxed-out 140 hr/wk workhorse comes due in ~33 weeks. Turboprops/RJs fly shorter sectors but the same table works because hours, not cycles, drive it (cycles modelling is a non-goal for v1).

A **D check also satisfies the C clock** (resets both). A C check resets only C.

### 5.2 Duration and cost

Cost scales with the airframe so one table covers the whole 100+ type roster:

```
C check:  cost = purchasePrice × 1.0% × maintMod × laborMaintMult
D check:  cost = purchasePrice × 6.0% × maintMod × laborMaintMult
```

(Game `purchasePrice` is market value, not list price — e.g. A320neo $50M — so the percentages are set against that scale.)

| Category | C duration | D duration |
|---|---|---|
| Turboprop / Regional Jet | 1 wk | 3 wks |
| Narrow Body | 1 wk | 4 wks |
| Wide Body | 2 wks | 5 wks |
| Double Deck / Supersonic | 2 wks | 6 wks |

Sanity check against in-game prices: A320neo ($50M) → C ≈ $500k, D ≈ $3M. 777-300ER ($170M) → C ≈ $1.7M, D ≈ $10.2M over 5 weeks. Dash 8-100 ($4M) → C ≈ $40k, D ≈ $240k — small planes stay cheap to overhaul, which is right. All meaningful but survivable at game cash scales (an A320neo already costs ~$3M/yr in weekly line maintenance).

Hub line-maintenance synergy: if the aircraft's routes touch a T2+ hub (the existing `aircraftMaintFactor` discount), apply the same factor to check costs. In-house base = cheaper heavy checks, reinforcing the hub investment loop.

### 5.3 Grace window and forced grounding

- **Due soon** (amber): within 12 wks / 800 hrs of trigger → planner nudge, no penalty.
- **Due** (red): trigger passed. Grace window: **12 wks (C)** / **16 wks (D)**. Failure prob climbs per §4.3; weekly maintenance cost ×1.25 while overdue.
- **Past grace → forced AOG grounding** (the regulator acts): starts immediately, duration +2 wks over the scheduled length (no slot booked, parts not staged), cost ×1.5, reputation −2, and a red toast + Weekly Debrief entry. This is the backstop that makes "manual scheduling" honest without hard-blocking anyone mid-season.

### 5.4 What a completed check gives you

- Resets `hoursSince*` / `weeksSince*` → failure prob collapses back to baseline.
- **D check age credit:** `maintAgeCredit += min(156, ageWeeks − maintAgeCredit)` — knocks up to 3 years off the *effective* age used in `maintenanceMultiplier` (weekly cost curve). A well-maintained 20-year-old costs like a ~14-year-old to run. `ageWeeks` itself is untouched (it still drives depreciation and delivery/lease logic).
- **Valuation (fleetNAV, reducer L366) and SELL_AIRCRAFT:** ±modifiers, applied in both so selling can't dodge the rule:
  - D check completed within last 104 wks → **+5%** on that airframe's NAV.
  - Any check currently due/overdue → **−15%**.
  This is what makes "sell it instead of D-checking it" a priced decision rather than an exploit.

---

## 6. Scheduling mechanics and edge cases

### 6.1 Actions (engine reducer — shared by SP and MP)

```js
SCHEDULE_CHECK { aircraftId, checkType: 'C'|'D', startNow?: true, startWeek?: n }
CANCEL_SCHEDULED_CHECK { aircraftId }
```

- `startNow` pulls the aircraft immediately: status → `'maintenance'`, `checkWeeksLeft` set, cost charged up front (one cash hit, like purchases).
- `startWeek` books a future week (≤ 26 wks out). The tick starts the check automatically when the week arrives — assuming the cash is there; if not, it converts to "due" and the toast says why.
- **Early checks are allowed** at any time and full price. That's deliberate: pulling a C check forward into February to clear the summer peak is exactly the planning gameplay we want.
- Cancel is free before the start week; no cancelling mid-check.

### 6.2 New status: `'maintenance'`

Add a fourth status rather than overloading `'grounded'` so the UI can distinguish "planned, wrench icon" from "breakdown, red alert", and so recovery toasts/debrief copy read correctly. Implementation is a mirror of the grounded machinery (countdown at reducer L2153-style, revenue exclusion at simulation.js L2006/L2291, deployment exclusion at L695, utilization exclusion at L661). Introduce one helper — `isOutOfService(a)` — and swap the ~6 `status === 'grounded'` call sites onto it so future statuses are one-line additions. Mid-check failure rolls are skipped (it's in the shop).

### 6.3 Edge cases

- **Existing saves / used aircraft (migration):** seed counters deterministically so a live fleet doesn't all come due the same week: hash the aircraft `id` → `hoursSinceC = hash% in [20%, 80%] of C_HOURS_DUE`, `hoursSinceD` proportional to `ageWeeks mod 312` capped at 85%. Runs in the save-load normalizer (reducer ~L3512) and on first MP tick after deploy. **No aircraft is ever migrated in as already overdue.**
- **New deliveries:** all counters 0. Used-market purchases (if/when added) inherit the seeding rule.
- **Leased aircraft:** checks are the operator's responsibility (realistic) — same rules. One kindness: if `leaseRemainingWeeks ≤ checkDuration + 4` and a check is due, the planner suggests returning it instead, and forced grounding is suppressed in that window (the lessor takes it back anyway). Returning a lease while a check is overdue adds 2 extra weeks of lease as a redelivery penalty, alongside the existing 4-week fee.
- **Sell/retire while due:** allowed; the −15% NAV modifier (§5.4) is the price.
- **Route coverage:** scheduling UI shows which routes lose their aircraft during the check and for how long. Routes behave exactly as they do for grounded aircraft today (no revenue, not auto-closed) — no new route logic needed in v1.
- **Failure during the overdue window:** possible and intended — a breakdown does *not* reset check clocks (repairs ≠ overhaul).

---

## 7. Economy and tuning

- Expected steady-state check spend ≈ `purchasePrice × (1%/1.4y + 6%/6y)` ≈ **1.7% of fleet value per year** — noticeable next to lease/fuel but not dominant (weekly line maintenance on an A320neo alone runs ~6%/yr of its price). If playtest shows pressure, first lever is the D% (6.0 → 4.5).
- Downtime is the real cost: a 4-week D on a plane earning $500k/wk profit costs more in revenue than in shop fees. That's correct and should stay — it's what makes spare aircraft and timing matter.
- The `maintenanceTeam` labor multiplier applying to check costs gives that labor group a visible payoff.
- **Tuning constants live in one new file** (`packages/engine/src/data/maintenance.js`) — thresholds, grace windows, percentages, durations — so balance passes never touch reducer logic.

---

## 8. UI plan

- **Fleet tab (`Fleet.jsx`):** new "Next check" column + chip per aircraft: `✓ OK` (green) / `C due 6wk` (amber) / `C DUE` (red) / `OVERDUE — 4wk grace` (red, pulsing) / `🔧 In C check — 1wk left` (blue). Sortable, consistent with the Gates-tab table pattern. Row expand: hours/weeks since C and D, failure-risk indicator, cost & duration preview, **Schedule check** (now / pick week) and **Cancel** buttons, plus the routes-affected list.
- **Operations tab (`Operations.jsx`):** a "Maintenance" card next to the budget slider: fleet counts (OK / due soon / due / overdue / in check), and a due-within-12-weeks list that deep-links to Fleet rows. The budget slider gets updated copy: "Line maintenance spend — affects wear-related breakdown risk and aging."
- **Weekly Debrief (`WeeklyDebrief.jsx`):** Maintenance section — checks started, completed, forced groundings, total check spend.
- **Toasts:** due-soon (once, at the 12-wk mark), due-now, check started/completed, forced grounding (danger). Reuse existing toast plumbing (reducer newToasts, L2354).
- **Route planners:** deployable-aircraft lists already exclude out-of-service airframes once `isOutOfService` lands; add a small wrench glyph next to names of aircraft with a booked future check.
- **Wiki/how-to-play:** a "Maintenance checks" article; devlog entry at ship time (per the usual devlog + sitemap routine).

---

## 9. Multiplayer specifics

- **Allow-list:** add `SCHEDULE_CHECK`, `CANCEL_SCHEDULED_CHECK` to `ALLOWED_PLAYER_ACTIONS` (world.mjs).
- **decisionGuard:** validate `aircraftId` belongs to the airline, `checkType ∈ {C, D}`, `startWeek` within [current, current+26], aircraft not already in maintenance/grounded, and sanitize the payload to exactly those fields (same pattern as stock-trade whitelisting).
- **Tick:** accrual, auto-start of booked checks, forced groundings, and completions all run inside the existing per-airline tick reducer pass — no new worker code, no cross-airline interaction, no new race surface. `Math.random()` in failure rolls is already accepted server-side practice (rolls happen only in the authoritative tick).
- **Journal/world feed:** journal enrichment for `SCHEDULE_CHECK` resolves the aircraft name so the feed can read "sent N-482HW for its D check". Harmless-to-share; no `stripRivals` changes needed (fleet detail is already private).
- **Anti-cheat surface:** cost is computed server-side from type data — payload carries no amounts. The one exploit to close is sell-to-dodge, handled by the NAV modifier in the shared reducer (§5.4), so SP and MP get it identically.

---

## 10. Migration and compatibility

- Save-shape defaulting in the load normalizer: missing fields get the deterministic seed (§6.3). Old saves, MP blobs, and the golden-master fixtures all pass through it.
- `mechanicalFailureProb(ageWeeks, budget)` keeps its export signature with a deprecation shim (age-only fallback) so any stray caller (tools, TW during the mirror gap) doesn't break; new code calls `mechanicalFailureProbFor(aircraft, budget)`.
- Golden-master runs will shift (failure probs change) — expect to re-baseline `tools/golden-master` as part of the PR, and say so in the commit message.

---

## 11. Phasing

| Phase | Contents | Size |
|---|---|---|
| **1 — Core loop** | State fields + accrual, due/grace/forced-grounding, SCHEDULE/CANCEL actions, `'maintenance'` status + `isOutOfService`, costs/durations, migration seeding, Fleet + Operations UI, debrief/toasts, MP allow-list + guard, `tools/maintenance-test.mjs` | The big one (~8–10 files HW) |
| **2 — Consequence layer** | Wear-based failure prob swap-in, D-check age credit, NAV/sell modifiers, lease-window kindness, hub line-maint discount on checks, wiki + devlog | Small–medium |
| **3 — MRO depth (optional, later)** | Hangar capacity at hubs (build/upgrade), concurrent-check limits, third-party MRO premium, maybe an mp_* objective ("Complete your first D check") | Design again first |

Phases 1 and 2 could ship together if Phase 1 lands cleanly — 2 is mostly formulas, and the system is much more persuasive with the wear model live. Recommendation: build both, playtest as one.

**Test plan:** new `tools/maintenance-test.mjs` — run a 400-week sim asserting: C/D cadence under heavy vs idle utilization, forced grounding fires past grace, check spend matches the table, counters reset, migration seeding never yields overdue, leased-return window suppresses forcing. Plus ui-smoke + web-smoke passes and a golden-master re-baseline.

## 12. Tailwinds mirror

Engine changes port near-verbatim (same reducer lineage). Differences: no decision pipeline/allow-list, no NAV/stock hooks if TW's valuation differs, and TW gets the devlog + sitemap entry per the usual mirror routine. Mirror only after HW playtest confirms tuning — the constants file makes re-tuning a one-file diff.

## 13. Open questions for Dave

1. **D% of purchase price:** 6% of in-game market value feels right on paper; happy to start at 4.5% if you'd rather err cheap and tighten later.
2. **Forced-grounding reputation hit:** −2 flat, or scale with fleet size so a 1-plane startup isn't crushed?
3. **Should booked future checks show to alliance members** in the world feed, or stay fully private until they start?
4. Ship Phases 1+2 together (recommended) or gate 2 behind a playtest of 1?
