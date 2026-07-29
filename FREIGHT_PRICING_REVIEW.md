# Freight Aircraft Pricing Review

**Date:** 2026-07-29
**Scope:** all 23 `freighter: true` types in `packages/engine/src/data/aircraft.js`
**Status:** IMPLEMENTED (Option C — hybrid) in BOTH repos, on disk, uncommitted.
Suites green: Headwinds 533 / Tailwinds 275, golden-master parity OK. See §7.

Prompted by Kat the Fox on Discord: *"you need to overhaul the entire freight pricing
scheme — you're telling me an MD-10 is cheaper than an ATR-72? AND A B737-8BCF. same
with the 757-2"*.

She's right, and it's worse than the three cards she screenshotted.

---

## 1. The headline number

Purchase price per tonne of payload, across the freighter table:

| | $M per tonne |
|---|---|
| Douglas DC-8-73F | **0.113** |
| McDonnell Douglas DC-10-30F | 0.128 |
| Boeing 727-200F | 0.154 |
| … | … |
| Boeing 767-300F | 2.115 |
| **ATR 72-600F** | **2.444** |

**A 21.6× spread.** Meanwhile operating cost per tonne-km — the thing that spread is
supposed to be compensating for — only spans **2.7×** (44 ¢/tkm for an A350F,
118 ¢/tkm for an An-12).

Capital cost varies eight times more widely than the efficiency difference it is
pricing. So price dominates every buy decision, and it points the wrong way.

## 2. What that does to the game

Simulated on a demand-limited lane (350 t/wk one-way, 2,000 km — the realistic case,
since cargo demand is a hard per-city-pair cap and every type is flown at the frequency
needed to lift the same tonnage, so **revenue is identical for all of them**):

| Aircraft | weekly profit | **payback** |
|---|---|---|
| Boeing 727-200F | $426k | **9 wk** |
| Antonov An-12 | $356k | 11 wk |
| Douglas DC-8-73F | $453k | 13 wk |
| Boeing 737-300F | $475k | 17 wk |
| Boeing 757-200PF | $703k | 23 wk |
| McDonnell Douglas DC-10-30F | $426k | 23 wk |
| … | | |
| Boeing 767-300F | $621k | 177 wk |
| Boeing 777F | $660k | 280 wk |
| Airbus A350F | $644k | 326 wk |
| Boeing 747-8F | $461k | 390 wk |
| Antonov An-225 | $35k | **8,458 wk** |

**900× payback spread.** Every modern purpose-built freighter in the game — 777F,
777-8F, A350F, A330-200F, 747-8F, 767-300F — is dominated by a 1970s conversion. There
is one rational freighter strategy and it is "buy the oldest thing on the lot."

On a capacity-limited lane it's even more lopsided: the DC-10-30F pays back in **3 weeks**,
the ATR 72-600F in **98**.

## 3. Root cause — two price populations glued together

The table is really two tables that were calibrated independently:

**Population A — modern purpose-built, priced off real new/near-new market values**
767-300F 2.115 · A350F 1.927 · 777F 1.814 · A330-200F 1.786 · 777-8F 1.786 · 747-8F 1.314
→ tight cluster, **1.3–2.1 $M/t**. Internally consistent.

**Population B — used conversions from the 2026-06-17 expansion block, priced off
scrap-market values**
DC-8-73F 0.113 · DC-10-30F 0.128 · 727-200F 0.154 · An-12 0.200 · MD-11F 0.330 ·
747-400F 0.357 · 757-200PF 0.410 · 767-200SF 0.429 · 737-300F 0.444 · A300-600F 0.463 ·
737-400F 0.500
→ tight cluster, **0.11–0.50 $M/t**. Also internally consistent.

**Every individual price is defensible against real transaction values.** The failure is
that the two populations sit in the same buy menu with nothing separating them. This is
the same seam the 2026-07-28 pass fixed for *maintenance* (classics were cheaper to
maintain per tonne than new-builds) — the *price* half of that seam was never closed.

In the real world the classics are held in check by things this game does not model:
noise/Stage-3 rules, third crew member, remaining airframe life, and the fact that
nobody sells you a zero-hour DC-8. See §5.

## 4. Individual outliers worth calling out

**ATR 72-600F — 2.444 $M/t, the most expensive freighter in the game per tonne.**
Kat's "expensive as hell" is literally true, and the 2026-07-24 pass made it *worse* in
relative terms: it was dropped $26M→$22M for parity with the passenger -600, but the pax
-600 sells 78 seats and the freighter sells 9 tonnes. At $22M for 9 t it costs more than
a DC-10-30F carrying **8.7× the payload**.

**Boeing 737-800BCF is strictly dominated by the 757-200PF.**
$20M / 23 t / 3,750 km vs $16M / 39 t / 5,800 km. The 757 is cheaper, 70% bigger,
55% longer-ranged and better per tonne-km. There is no reason to buy the BCF. (Kat
flagged exactly this pair.)

**767-200SF vs 767-300F — $18M/42 t vs $110M/52 t.**
Your read on Discord was "shouldn't have that much of a price difference but should def
be cheaper." Currently it's **6.1× the price for 24% more payload**. The 767-300F is also
the worst-value modern freighter (2.115 $M/t) and is beaten outright by the A330-200F
(1.786 $M/t, bigger, longer-ranged, more efficient).

**Antonov An-225 — a $300M trap.** `payloadTonnes: 250` × any usable frequency exceeds the
total weekly cargo demand of the densest lane in the world (HKG–LAX calibrates to ~1,500
t/wk). It physically cannot fill. On the test lane it earns $35k/wk and **loses money on
its own lease**. Payback 8,458 weeks. Same shape, less extreme, for the An-124 (330 wk).

**DC-8-73F range is 9,000 km** — longest-ranged freighter in the game bar the 777F,
ahead of the 747-400F and A350F. Real max-payload range is nearer 7,000–7,400. It's also
the cheapest aircraft per tonne in the game by a factor of 1.1×. Both at once is too much.

**Payloads and lease rates are fine.** All 23 `payloadTonnes` are within 6% of real max
structural payload (only DC-8-73F is out, 53 vs ~48). Leases are a uniform 12.3–13.2% of
price per year except the modern purpose-builts at 9.5–11.4% — defensible, since newer
metal really does lease at lower rates, but note it *widens* the gap: the expensive jets
are the ones that already get the discount.

## 5. Why nothing else catches the classics

There is no compensating mechanic anywhere in the engine:

- **Everything delivers at `ageWeeks: 0`.** Hard-coded at all four entry points
  (`reducer.mjs:550, 576, 746, 3744`). A DC-8-73F arrives as a zero-hour airframe with a
  full 30-year depreciation runway.
- **No vintage data exists.** `aircraft.js` has no `introduced` / `builtYear` /
  `outOfProduction` field. Age is expressed only as bad static numbers, never as
  remaining life.
- **Resale doesn't know either.** `nav = purchasePrice × max(0.1, 1 − ageYears/30)`, so a
  one-year-old DC-8-73F is still worth $5.8M of its $6M.
- **No noise / Stage-3 / Stage-4 / curfew rules exist.** Grepping the engine returns only
  descriptive prose on the SNA entry, whose `check()` enforces a frequency cap and
  nothing else. An An-225 and a 727-200F may fly anywhere a 787 can.
- **Cargo has no quality/age demand penalty.** `computeQualityScore`'s age term is in the
  passenger pipeline only; `simulateCargoRoute` never calls it.

## 6. Incidental bugs found along the way

These are not pricing, but they all fall out of `category: 'Freighter'` missing from
lookup tables, and several distort the economics above:

1. **`CRUISE_SPEED_KMH` has no `'Freighter'` key** (`simulation.js:605`) → every freighter
   falls back to **840 km/h**, including the ATR 72-600F turboprop (real ~510) and the
   An-12 (real ~550). Both get ~65% more block-hour productivity than they should.
2. **`TURNAROUND_HOURS` has no `'Freighter'` key** → 0.75 h for everything. A 250-tonne
   An-225 turns in 45 minutes; a passenger widebody takes 90.
3. **`LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY` has no `'Freighter'` key**
   (`overhead.js:87`) → flat $12k/wk fallback. An An-225 insures like a 737.
4. **`C_DURATION` / `D_DURATION` have no `'Freighter'` key** (`maintenance.js:42`) →
   default 1 wk / 4 wk for every freighter regardless of size.
5. **Landing-fee category caps at ≥50 t = Wide Body** (`simulation.js:1429`) → the An-225
   pays the same landing fee as a 767-300F.
6. **Freighters pay the Cabin Crew labor group** ($10k/wk/aircraft, `labor.js:42`) despite
   carrying no cabin crew.
7. **`runwayFt` is never enforced** — `runwayViolation` only runs when
   `context.aircraftType` is passed, and **no call site in `reducer.mjs` ever passes it**
   (all five call sites pass only `{routes, excludeKey}`). The An-225's 11,500 ft
   requirement is dead data.
8. **Category bans miss freighters entirely** — LGA/DCA/ASE/SXM block
   `['Wide Body']`, but a 137-tonne 747-8F has `category: 'Freighter'` and is therefore
   **permitted at LaGuardia, National, Aspen and St. Maarten**.

## 7. What was implemented (2026-07-29) — Option C, the hybrid

Dave's call: hybrid, plus the §6 lookup-table bugs in the same pass. Both repos.
Suites green — **Headwinds 533 assertions, Tailwinds 275, zero failures**, and
`tools/golden-master/run.mjs` still reports byte-identical parity.

### 7.1 Prices — half the seam closed

Each price is the geometric mean of today's value and a full per-tonne curve,
then hand-clamped to stay within touching distance of real market values.
Lease rates follow at 13.0% / 12.5% / 10.5% of price per year by vintage tier.

| | now → new | $M/t | | now → new | $M/t |
|---|---|---|---|---|---|
| ATR 72-600F | $22M → **$16M** | 1.78 | DC-8-73F | $6M → **$15M** | 0.31 |
| E190F | $17M → $23M | 1.77 | A300-600F | $25M → $33M | 0.61 |
| 737-300F | $8M → $13M | 0.72 | A330-200F | $125M → **$115M** | 1.64 |
| 737-400F | $10M → $15M | 0.75 | DC-10-30F | $10M → $17M | 0.22 |
| An-12 | $4M → $7M | 0.35 | MD-11F | $30M → $44M | 0.48 |
| 737-800BCF | $20M → $30M | 1.30 | 777F | $185M → **$158M** | 1.55 |
| 727-200F | $4M → $7.5M | 0.29 | A350F | $210M → **$175M** | 1.61 |
| A321P2F | $32M → $42M | 1.50 | 747-400F | $40M → $55M | 0.49 |
| 757-200PF | $16M → $24M | 0.62 | 777-8F | $200M → **$170M** | 1.52 |
| 767-200SF | $18M → $26M | 0.62 | An-124 | $120M → **$98M** | 0.82 |
| 767-300F | $110M → **$96M** | 1.85 | 747-8F | $180M → **$175M** | 1.28 |
| | | | An-225 | $300M → **$96M**\* | 0.68 |

\*An-225 to $170M. Also: DC-8-73F payload 53 → **48 t** and range 9,000 → **7,400 km**
(both were off real figures, and it was the cheapest frame in the game with
near-best range).

### 7.2 Vintage — the counterweight that lets classics stay cheap

New type field **`deliveredAgeWeeks`**. Used conversions no longer arrive as
zero-hour airframes; `ageWeeks: 0` is gone from all four delivery sites in the
reducer (and Tailwinds' GameContext). Delivered ages, capped well short of true
build era because `maintenanceMultiplier = 1 + (age/20)² × 2` is quadratic:

- **16 y** — DC-8-73F, DC-10-30F, 727-200F, An-12 (2.28× maintenance on arrival)
- **12 y** — 747-400F, MD-11F, A300-600F, 737-300F/400F, 757-200PF, 767-200SF (1.72×)
- **10 y** — An-124, An-225 (1.50×)
- **6 y** — 737-800BCF, A321P2F, E190F (1.18×)
- **0** — everything still in production (767-300F, ATR 72-600F, A330-200F, 777F, A350F, 777-8F, 747-8F)

New shared helper **`valueRemaining(ageWeeks, type)`** in `overhead.js`.
Depreciation now runs *from the delivered value*, so `purchasePrice` is what the
frame is worth the day it arrives. Without this a 12-year-old 747-400F would shed
40% of its value the instant it landed, double-counting an age discount already
in the price. Wired into `fleetNAVOf`, `SELL_AIRCRAFT`, `airframeNAV` and hull
insurance — one definition, four call sites.

**Effect on the numbers:**

| lane | payback spread before | after |
|---|---|---|
| mid-haul 2,000 km / 350 t | **900×** | **24×** |
| long-haul 6,000 km / 600 t | 15× | **6×** |
| $M per tonne, whole table | 21.6× | **8.5×** |

The design this lands on: classics are cheap, pay back fast, and die young —
~14 years of life on a steepening maintenance curve, worth 10% of price at the
end. Modern metal is a long, expensive commitment that runs 30 years at flat
cost. That's a real decision, which is what was missing.

### 7.3 The §6 lookup-table bugs, all fixed

1. **Cruise speed** — new per-type `cruiseKmh` on all 23 freighters, and
   `blockTimeHours` now reads it via a new `cruiseSpeedKmh(type)`. The ATR 72-600F
   drops 840 → **510 km/h** and the An-12 840 → **550**; both had been getting ~65%
   more block-hour productivity than they should.
2. **Turnaround** — new `turnaroundHours(type)`, payload-stepped 0.75–1.75 h. The
   An-225 no longer turns in 45 minutes.
3. **Liability insurance** — `LIABILITY_INSURANCE_WEEKLY_FREIGHTER`, stepped
   $4k–$20k by payload, replacing the flat $12k fallback.
4. **Check durations** — `FREIGHTER_C_DURATION` / `FREIGHTER_D_DURATION`, and
   `checkDurationWeeks` now takes the type object (still accepts a bare category
   string for legacy callers). All four reducer call sites updated.
5. **Landing fees** — new **`'Outsize'`** tier (mega 13,000 / major 8,300 /
   regional 3,500) for ≥150 t. The An-225 no longer pays a 767F's landing fee.
6. **Runway limits + category bans** — new `freighterBodyClass(type)` maps a
   freighter to the passenger body class airport rules are written against, and
   all five `checkRouteRestrictions()` call sites now pass `aircraftType`. The
   747-8F is no longer legal at LaGuardia, National, Aspen and St. Maarten.

**Worth knowing:** Tailwinds *already* passed `aircraftType` at all five sites —
runway checks have been live there the whole time. Headwinds' generated
`reducer.mjs` had lost them, so every runway check in the multiplayer game was
silently inert. Same shape as the aircraft-picker regression on 2026-07-28: a fix
that exists in Tailwinds but never reached Headwinds' git. The reducer's
"GENERATED — do not hand-edit" header was also stale (that sync was retired
2026-07-12); it now says so, and flags the drift.

### 7.4 Regression test

`tools/aircraft-consistency-test.mjs` gains **7 tests** in both repos — capital
spread under 10×, no scrap-priced outlier, vintage present and correctly signed,
delivered age capped at 20 y, older-is-cheaper monotonicity, every freighter
carries a cruise speed, and payload within 8% of real. Verified they **fail 5 of 7
against the pre-fix data**. 26 assertions in the file, wired into `npm test`.

### 7.5 One test updated that wasn't mine

`the 747-8I is placarded for fewer seats than the -400` started failing mid-session
— because of your concurrent 747-400D work, not this pass. You moved the 660-seat
exit limit off the -400 (now 605, matching the -8I) onto the new -400D. The
assertion was a strict `<`. Rewritten to pin 660 to the **-400D specifically**,
assert the -400D trades range for those seats (so it can't strictly dominate the
-400), and relax the -8I check to `<=`.

### 7.6 Still open

- **The An-225 has no niche.** At 250 t it cannot fill any lane in the game —
  `capacityTonnes` exceeds the entire calibrated pool of the densest city pair
  (HKG–LAX ≈ 1,500 t/wk) at any usable frequency. Cheaper now, but still a
  prestige buy. It needs an outsize/project-cargo demand niche to be a real
  aircraft, which is a feature, not a data fix.
- **Cargo revenue looks high at full load.** A 777F at 100% load on a 2,000 km
  lane clears ~$4M/week. Demand caps hide this most of the time, but it's worth a
  separate look at `CARGO_YIELD_BASE` / `CARGO_BACKHAUL_FACTOR`.
- **Freighters still pay the Cabin Crew labor group** ($10k/wk/aircraft) despite
  carrying none. Left alone deliberately — it's fleet-wide overhead and changing
  it moves every operator's P&L for a reason unrelated to pricing.

## 8. Live-world impact — read before choosing

`purchasePrice` is not cosmetic. It feeds:

- **fleet NAV** (`fleetNAVOf`, `reducer.mjs:428`) → balance sheet, and therefore borrowing
- **hull insurance** — `purchasePrice × max(0.1, 1−age/30) × 0.008 / 52` weekly
- **C and D check costs** — `C_COST_PCT = 0.018`, `D_COST_PCT = 0.10` of `purchasePrice`
- **AOG repair cost** and the write-off threshold (`AOG_NAV_CAP_FRACTION = 0.60` of NAV)
- **used-market listing prices** — listed at the seller's NAV at time of sale
- **resale proceeds**

Fleets store type ids and resolve specs at runtime, so any change here lands on the next
tick for everyone already flying these types. Raising classic prices makes existing owners
*richer* on paper (NAV up) but raises their check bills; cutting modern prices does the
reverse. Same caution as the 2026-07-28 fuel-burn pass, but on more axes.

What this pass actually does to a live world: classic-freighter operators get a
NAV *rise* (prices up) but immediately pay 1.5–2.3× maintenance and lose the
resale cushion; modern-freighter operators see NAV fall 3–18% with lower C/D
check bills to match. Nobody’s aircraft is snapshotted — fleets store type ids
and resolve specs at runtime, so all of it lands on the next tick.
