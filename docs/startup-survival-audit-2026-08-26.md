# Startup survival audit — do small-aircraft starts actually die?

2026-08-26. Read-only pass over all six live worlds: 144 airlines, 105 accounts,
~110k decisions. Prompted by a Discord claim that new players pick regional /
island-hopper starts, find them impossible to profit with, go bankrupt, and never
come back.

> **Read §6b first.** The HQ attribution in §3 was over-stated: labour was the
> bigger half of the same defect and had already been fixed on 2026-08-05. §6b
> corrects it and §7 records what shipped on the back of it.

**Verdict: mostly true, for a reason that is in the overhead formula rather than in
the aircraft.** The claim overstates one thing — it is not impossible, and three live
airlines prove it — but the shape of the complaint holds up, and the survival gap is
real. Roughly a third of the July mortality is also attributable to the silent
route-open bug fixed on 2026-08-13 rather than to economics.

---

## 1. The population

| | count |
|---|---|
| worlds (all RUNNING) | 6 |
| airlines | 144 |
| ACTIVE | 63 |
| BANKRUPT | 67 |
| ABANDONED | 14 |
| overall death rate | **56%** |
| distinct accounts | 105 |

Every bankruptcy but two was `consecutive_negative` — airlines bleed out, they do
not get hit by a single catastrophic event.

## 2. Opening gauge vs outcome

Airlines bucketed by the seat-weighted average of every aircraft they ordered in
their first 26 weeks. "Never profitable" counts only airlines whose stats history
covers their whole life, so it is a smaller, cleaner subset.

| opening gauge | n | death rate | never had a profitable week | median peak fleet |
|---|---|---|---|---|
| **under 80 seats** | 20 | **70%** | **11/13 (85%)** | 2 |
| 80–129 seats | 20 | 65% | 8/13 (62%) | 6 |
| 130–219 seats | 42 | **38%** | **5/21 (24%)** | 10 |
| 220+ seats | 32 | 50% | 7/19 (37%) | 7 |

The profitability gap is the solid result: **Fisher exact p = 0.0011** for
sub-80-seat vs narrowbody starts never reaching a profitable week.

Mortality points the same way but is underpowered on its own. Restricting to
airlines that either reached 52 weeks or died before it (so survivors are not
silently censored): 47% of small-gauge starts died in their first year vs 26% of
narrowbody starts — p = 0.142, suggestive, not conclusive at n = 19 / 38.

## 3. Why — it is the HQ overhead, and it is not subtle

First-year weekly averages, taken from each airline's own financial history:

| opening gauge | median weekly revenue | median weekly HQ cost | HQ as % of revenue | median margin | loss-making in year 1 |
|---|---|---|---|---|---|
| under 80 seats | $71,985 | $68,495 | **130%** | **-133%** | 92% |
| 80–129 seats | $289,379 | $68,495 | 10% | -89% | 100% |
| 130–219 seats | $1,980,782 | $95,337 | 4% | -9% | 71% |
| 220+ seats | $3,649,285 | $131,700 | 4% | -8% | 85% |

Note the middle column. `$68,495` is exactly `calcHQCost(2)` — the two smallest
buckets are paying an **identical** head-office bill on 1/27th the revenue. Revenue
spans a 50x range across these rows; overhead spans 1.9x.

That is `calcHQCost = 38_000 × n^0.85` doing precisely what the comment in
`overhead.js` already warns about — *"because it counts airframes rather than
output, an A380 and a Dash 8 cost the same to administer."* The per-departure
rework fixed that for large airlines. It did not fix it for small ones, because
`HQ_BASE_WEEKLY` is a flat $40,000.

### The individual cases

Every small-gauge startup's first year, worst revenue first:

| airline | world | regime | outcome | peak fleet | weekly revenue | weekly HQ | HQ/rev |
|---|---|---|---|---|---|---|---|
| air Gatineau | Old Metal | NWR | bankrupt | 1 | $0 | $40,000 | ∞ |
| Mallard Airlines | Scarce Assets | legacy | bankrupt | 2 | $0 | $68,495 | ∞ |
| MoggerAirline | Old Metal | NWR | bankrupt | 1 | $0 | $40,000 | ∞ |
| Tung Air | Scarce Assets | legacy | bankrupt | 2 | $0 | $68,495 | ∞ |
| Delta Global | Onyx Wake | legacy | bankrupt | 2 | $10,919 | $68,495 | **627%** |
| F8L Frontier | Scarce Assets | legacy | bankrupt | 5 | $55,005 | $141,511 | 257% |
| Cookies Airlines | Scarce Assets | legacy | bankrupt | 3 | $71,985 | $93,862 | 130% |
| Maribondo Air | Old Metal | NWR | bankrupt | 1 | $147,427 | $47,000 | 32% |
| AirGaule | Cobalt Meridian | legacy | bankrupt | 2 | $285,209 | $68,495 | 24% |
| Sámi Airways | Scarce Assets | legacy | abandoned | 4 | $286,432 | $103,993 | 36% |
| Changzhou | Old Metal | NWR | active | 1 | $374,422 | $47,000 | 13% |
| China Balls Airlines | Cobalt Meridian | legacy | active | 160 | $20.0M | $1.51M | 8% |

Only one of the twelve is comfortably alive, and it did not stay small — it grew to
160 aircraft.

### The arithmetic, from the engine's own calibration

`overhead.js` documents revenue per departure by class. Running a two-aircraft
startup at the frequency a new player naturally picks — one round trip a day:

| class | gross revenue/wk | legacy HQ | HQ % of revenue | NWR HQ | HQ % of revenue |
|---|---|---|---|---|---|
| **Turboprop** | $48,734 | $68,495 | **141%** | $41,400 | **85%** |
| Regional Jet | $153,272 | $68,495 | 45% | $43,500 | 28% |
| Narrow Body | $500,234 | $68,495 | 14% | $50,500 | 10% |
| Wide Body | $2,893,842 | $68,495 | 2% | $96,000 | 3% |

A two-turboprop airline cannot pay its head office out of **gross** revenue. Not
after fuel, crew, maintenance, leases or gates — before any of them. Under New
World Restrictions it is better and still fatal, because the $40k base alone is
most of the revenue.

## 4. But it is not impossible — and the escape hatch is interesting

Three small operators are solidly profitable right now:

| airline | fleet | routes | weekly revenue | weekly profit |
|---|---|---|---|---|
| Air Premium (EVN) | 3 × CV-580 | 12 | $2.00M | **+$635k** |
| Air Fiji (SUV) | 2 × CV-580, DHC-8, 2 × CRJ200 | 14 | $2.16M | **+$415k** |
| Critical Success (SVO) | 2 × Saab 2000 | 2 | $1.73M | **+$356k** |

All three do the same thing: **very high frequency on very few short routes.**
Critical Success flies SVO–LED at 41 weekly frequencies and SVO–VOZ at 48, from two
58-seaters. Re-running the table above at four times the utilisation:

| class | gross revenue/wk | legacy HQ | HQ % of revenue |
|---|---|---|---|
| Turboprop | $194,936 | $68,495 | **35%** |
| Narrow Body | $2,000,936 | $68,495 | 3% |

So the real shape of the problem is narrower than "small aircraft don't work":

> Small aircraft are unviable at the utilisation a new player naturally picks, and
> viable at a utilisation nothing in the game tells them about.

Two small-gauge starts at big hubs also grew into the largest airlines in their
worlds — Axo Air (STL, 89-seat opening) reached 242 frames; Sunshine Air (DFW) 168.
The opening gauge is not a death sentence. It is a much narrower survivable window,
entered blind.

## 5. The "they don't come back" part

This is the strongest signal in the dataset, and the least ambiguous.

| opening gauge | airlines that died | later restarted or hold another live airline | no decision anywhere in 14+ days |
|---|---|---|---|
| under 80 seats | 14 | **0%** | **79%** |
| 80–129 seats | 13 | 31% | 46% |
| 130–219 seats | 16 | 38% | 56% |
| 220+ seats | 16 | 19% | 69% |

Not one of the fourteen small-gauge failures ever came back. Across the whole
player base: 68 accounts have lost an airline, and 57 of them (84%) have no live
airline now. Half of all accounts have been silent for a fortnight.

## 6. Two confounds worth being honest about

**New players pick small aircraft.** 80% of small-gauge starters are accounts with
exactly one airline ever, against 50% for the larger buckets — so inexperience and
gauge are entangled. Restricting to first-timers only, the gap survives but narrows:

| gauge, first-timers only | n | death rate | never profitable |
|---|---|---|---|
| under 80 seats | 16 | 75% | 8/9 |
| 130–219 seats | 21 | 43% | 4/12 |

The overhead arithmetic in §3 is not subject to this confound at all — it is
accounting, not behaviour.

**The route bug contaminates the July numbers.** 22 airlines earned $0 across their
entire first year. Several were filing route decisions the whole time — Nicholas
Airlines filed 57 ADD_ROUTE decisions for KBP–WAW and ended with zero routes and
zero revenue before going bankrupt; Fin Laden Air filed 35 for DTW–MIA. That is the
silent-refusal path `routeBlocks.mjs` was written to close on 2026-08-13. Splitting
by era:

| era | small-gauge death rate | large-gauge death rate |
|---|---|---|
| founded before 2026-08-13 | 73% | 49% |
| founded after | 50% (n=8) | 41% (n=27) |

The gap narrows after the fix but does not close. Post-fix samples are small — two
weeks of data — so this needs re-running in a month.

## 6b. Correction — labour was the bigger half, and it was already fixed

The first cut of this document attributed the small-gauge death rate mostly to HQ
overhead. That over-stated it. `baseWeeklyPerAircraft` totalled **$58,000 per
airframe flat** — a Cessna crewed for an A380's money — and `CREW_SCALE_BY_CATEGORY`
fixed that on 2026-08-05 (351a818). It is live: active small operators now pay
$28.7k per turboprop frame. The cost decomposition that pointed at HQ was reading
financial history from airlines that died before that shipped.

What remained was HQ, the last fixed cost still counting airframes. Fixed cost per
airframe per week, and the operating tempo needed to cover it:

| | labour/frame | HQ/frame | break-even departures/aircraft/day |
|---|---|---|---|
| Turboprop | $28,700 | $34,248 | **2.58** |
| Regional Jet | $37,400 | $34,248 | 0.93 |
| Narrow Body | $58,000 | $34,248 | **0.37** |
| Wide Body | $105,300 | $34,248 | **0.10** |

A widebody covers its fixed costs on one departure every ten days; a turboprop needs
two and a half a day. A 26x spread in required tempo, invisible to the player. It
also predicts the survivors exactly: Critical Success runs 12.7 departures per
aircraft per day, Air Premium 4.7, Air Fiji 2.9 — every dead small operator sits
below the 2.58 line. (Revenue per departure is the calibration table in
`overhead.js`, at 85% load and reference fares, so these are indicative.)

## 7. What shipped, 2026-08-26

**HQ overhead now scales with the aeroplane, in all worlds.** `calcHQCost` takes
narrowbody-equivalents instead of `fleet.length`, via a new `HQ_SCALE_BY_CATEGORY`
(turboprop 0.35, RJ 0.55, **narrowbody 1.00 by construction**, widebody 1.70,
double-deck 2.10, supersonic 1.60) and `fleetHQScale()`. Freighters step by payload,
as they already do for crew and insurance. In restricted worlds the flat
$40k `HQ_BASE_WEEKLY` becomes `hqBaseWeekly()`, scaled by the fleet average and
**capped at narrowbody**, so that base can only ever fall. A fleetless airline still
pays the full base on purpose — that state is momentary or terminal, and a dying
airline should die rather than linger cheaply.

Measured with the real engine against every live airline: 11 better off, 20 worse
off, 15 unchanged. Largest relief −6.48% of revenue (China Balls Airlines, 164
turboprops); worst increase +1.85% (Bing Chilling Air, five double-deckers), with
every other rise under 0.7%. No profitable airline is pushed into loss. Turboprop
break-even falls from 2.58 to 1.75 departures/day.

Deliberately NOT shipped: any player-facing break-even number. Dave's call — the
figure would solve the game rather than teach it.

Files: `packages/engine/src/data/overhead.js`, `packages/engine/src/utils/simulation.js`,
`src/components/Operations.jsx` (now reads `lastReport.totalHQCost` so the page cannot
drift from the tick — it was already wrong in restricted worlds),
`tools/hq-gauge-scale-test.mjs` (new, 15 checks, verified failing on HEAD before the
fix landed), `tools/new-world-restrictions-test.mjs` (two assertions re-pointed),
`package.json`. Ported to Tailwinds: `src/data/overhead.js`, `src/utils/simulation.js`,
`src/components/Operations.jsx`, `tools/hq-gauge-scale-test.mjs` (10 checks).

Golden master prints PARITY OK — its scenario leases A320s, so the anchor property
holds end to end. Headwinds 122 suites green; Tailwinds 88 green. Pre-existing
failures unrelated to this change, verified on HEAD in both repos: HW
`pnl-reconcile-test` ("the C-check fixture actually charged a heavy check" — the
fixture stopped reaching a paid C check, so the `maintenanceChecks` half of that row
is currently untested), TW `demand-conservation-test` (2 H2 tag-pool checks) and TW
`reserve-cover-test` (D-check reserve dispatch). HW `adsense-readiness-test` fails
only over the desktop bridge, which cannot unlink `public/`.

## 7b. Correction — the gauge scale had a category cliff, now a seat curve

Shipping §7 stepped the scale by `category`, which put a cliff at every boundary.
The worst case, found while auditing aircraft prices the same afternoon:

| | category | seats | labour + HQ per week |
|---|---|---|---|
| 757-300 | Narrow Body | 295 | **$96,000** |
| 767-200ER | Wide Body | 290 | **$164,958** |

Five fewer seats, 72% more fixed cost — and it handed the 757-300 the lowest
break-even load factor of any aircraft in the game. Across the catalogue: four
places where MORE seats cost LESS, and 107 pairs sitting within ten seats of each
other yet differing by over 15%. `CREW_SCALE_BY_CATEGORY` already had the same
cliff; §7 copied the pattern and compounded it.

The category tables are now read as **anchor points on a curve through seat
count** (`CATEGORY_MEDIAN_SEATS` + `scaleBySeats()` in `overhead.js`), at the same
median seats the per-departure fee table was calibrated against. Every calibrated
number still holds exactly at its own anchor; only aircraft *between* anchors move.
The ends clamp rather than extrapolate, so the 853-seat A380 keeps paying today's
double-deck rate. Freighters keep payload bands, Concorde keeps a category
override, and double-deckers keep theirs — a 747SP is a 747 cut short, so four
engines and an upper deck on 400 seats legitimately cost more than a 406-seat
A330-200.

Two real bugs surfaced by the existing suites while doing this, both fixed:

- A type with **no seat count** fell through to the *smallest* anchor, so a
  seatless widebody fixture was being crewed as a 39-seat commuter.
- `splitStarterHire` floored a now-fractional requirement, so a new player's first
  two aircraft landed **in training** — precisely the wait the Starter Fleet perk
  exists to waive.

Net of both changes, measured with the real engine against every live airline: 19
better off, 26 worse off, 1 unchanged. Best relief −7.06% of revenue (Changzhou,
one 52-seat turboprop); worst rise +1.85% (Bing Chilling Air, five double-deckers).
Every small operator this audit set out to help is still net ahead.

Headwinds 135 suites green, Tailwinds 89, golden master `PARITY OK` — its scenario
leases the A320ceo, which is 186 seats, exactly the narrowbody anchor.

## 8. What could change next

Not recommendations, options — in rough order of how surgical they are.

1. **Make `HQ_BASE_WEEKLY` gauge-aware.** The per-departure table already prices
   overhead by body class; the flat $40k base undoes it for exactly the airlines
   the table was meant to protect. Scaling the base by the fleet's median body
   class would cost one line and fix the structural case.
2. **Ramp overhead over the first N weeks**, or waive it until the first profitable
   week. Gives a new player room to find the frequency lever before the meter runs.
3. **Teach the frequency lever.** The three profitable small operators found it;
   nothing surfaces it. A hint on the route form when a small aircraft is scheduled
   below some daily-rotation threshold would convert the trap into a lesson.
4. **Roll New World Restrictions to all new worlds.** Small-gauge HQ share falls
   from 130% to 32% of revenue and median margin from -133% to -16% under it,
   though on n=2 that is directional only.
5. **Warn at founding.** A player buying two turboprops at a regional hub is, on
   this data, taking a 70% chance of not surviving. That is worth a sentence before
   they commit.

Doing nothing is also a legitimate answer — a hard opening is a design position,
not a bug. But it is currently hard in a way the player cannot see, and the people
it eliminates do not come back.

## 9. Unrelated, found on the way

`apps/headwinds-server/.env.example` is tracked in git and its comments contain what
looks like a real database password. Worth rotating and scrubbing the comment.

---

Method: `tools/startup-survival/` — read-only, opens no transaction. Data pulled
2026-08-26 from all six RUNNING worlds. Opening strategy is reconstructed from the
`Decision` log rather than from current state, because bankruptcy wipes the fleet.
`statsHistory` is a rolling 260-week window and `financialHistory` a rolling 52, so
every history-based figure above is restricted to airlines whose window covers their
founding; those subset sizes are shown throughout.
