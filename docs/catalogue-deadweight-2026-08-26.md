# Which aircraft are never the right answer?

2026-08-26. Prompted by a Discord argument that the catalogue carries types that
are "more screen filler than anything anyone will have in their fleet". Tool:
`tools/catalogue-deadweight-report.mjs` (read-only, no database).

**Answer: ten of them were, and for one fixable reason. Two still are.**

---

## 1. Defining dead weight without getting it wrong

Two earlier definitions failed and are recorded so they are not tried again.

**Attribute dominance** — A beats B if it has at least the seats and range for no
more price, fuel, maintenance and runway. This "proved" the A319 kills the E190,
which is nonsense. It rewards seat count, and a small aircraft exists precisely to
*match thin demand*. Filling 149 seats is not a virtue on a route with 90
passengers.

**Best-profit-at-a-market-size**, sampled over six sectors and eight demand points.
Right shape, wrong resolution: 48 cells cannot support a claim about 140 types, and
its headline ("122 never win") was an artefact of the grid.

What the report does instead: a mission is (sector, weekly market size). 33 sectors
spanning distance **and field length** × 24 log-spaced market sizes from 60 to
60,000 pax/week = 792 missions. Eligible types are those with the range to fly it
and the field performance to use both ends. Each type picks **its own** best weekly
frequency under the block-hour cap — this is what makes the comparison fair to
small aircraft, whose answer to a thin market is more rotations, not a bigger cabin.

A type is dead weight only if it never wins **and never comes close**. Most of the
catalogue peaks at 90–99% of the winner, which is a healthy catalogue, not a broken
one — only 34 of 141 types win a mission outright and that is fine. Ranking is by
best ratio to the winner across every mission the type can fly.

`--validate` reconciles the cost model against `weeklyTick` and prints the worst
disagreement. It currently reads **0.1%** across Dash 8 to A380. It caught a real
bug on its first run: the tick's fields are `totalFuel` / `totalCrew`, not
`totalFuelCost` / `totalCrewCost`, and the wrong names silently compared against
landing fees alone — 1011% drift. Run `--validate` before believing the report.

## 2. The finding

Every aircraft below about 21 seats was loss-making **with every seat sold at
maximum legal frequency**. Not uncompetitive — incapable, on any sector.

| | best possible week, before |
|---|---|
| BN-2 Islander (9 seats) | −$30,934 to −$53,166 |
| PC-12 (9) | −$52,709 |
| Cessna 208B (14) | −$19,681 |
| DHC-6 Twin Otter (19) | −$4,275 to −$24,990 |
| 1900D / Do-228 / L-410 / SkyCourier (19) | −$11,577 to −$15,326 |
| Jetstream 31 (19) | −$906 |
| **EMB-110 (21)** | **+$10,652** — the crossover |

The cause was one missing anchor. The scale tables' smallest entry was the 39-seat
turboprop and `scaleBySeats` clamped below it, so **a 9-seat Islander was charged a
39-seater's head office and crew**. This predated the seat curve — the old category
lookup gave every turboprop 0.35 too — but the curve made it visible.

**It stranded the airports too.** 25 airports sit under 4,000 ft: SAB (1,312),
LUA (1,729), CVF (1,762), SBH (2,119), DGH, BRR and nineteen more. They were built
for exactly these aircraft. Pruning the aircraft would have stranded all 25.

And it answers the Discord taunt precisely. *"Be my guest and make an airline whose
only hub is in St Barths and we can see how long it lasts."* SBH is 2,119 ft;
exactly two aircraft in the game can use it, and both lost money at full load. The
challenge was unwinnable by arithmetic, not by skill.

## 3. What shipped

Two anchor points below the turboprop, in `CATEGORY_MEDIAN_SEATS` and both scale
tables. Neither is an aircraft category — no type carries them and nothing looks
them up directly; they exist purely as points on the curve.

| | Air Taxi (9) | Commuter (19) | Turboprop (39, unchanged) |
|---|---|---|---|
| HQ | 0.11 | 0.20 | 0.35 |
| pilots | 0.25 | 0.38 | 0.55 |
| cabin crew | 0.02 | 0.10 | 0.30 |
| ground staff | 0.08 | 0.20 | 0.45 |
| maintenance | 0.12 | 0.24 | 0.50 |

Per group rather than one flat fraction, on physical logic: single-pilot
certification at 9 seats, no cabin crew required below 20, nine bags and a
hand-loaded hold is not a ramp operation. The 39-seat anchor is untouched, so every
existing calibration still holds exactly.

**Result.** The Twin Otter goes from −$4,275 to **+$12,638** on the SBH–SXM shuttle
and now wins **42 missions** — more than any other small aircraft. It needs 1,200 ft,
which is under the shortest field in the game, so **all 25 short-field airports are
now open**. The Do-228 and L-410 came off the prune list too.

**And the counter-risk did not materialise.** Opening the bottom of the curve could
have created a new dominant strategy — a 9-seater at 28 rotations a week is
structurally the same shape as any other high-frequency exploit. It did not: the
win table is still led by the A380 at high demand, the E195-E2, 757-300 and A330neo
in the middle, and 39–58 seat turboprops at the bottom. A test pins it.

## 4. What is still dead, and now deserves to be

| | seats | why |
|---|---|---|
| BN-2 Islander | 9 | Strictly dominated by the Twin Otter — identical 1,200 ft field performance, twice the seats, and profitable where the Islander is not (+$12,638 vs −$3,227 at SBH). |
| PC-12 | 9 | Same, and needs 2,600 ft, so it cannot even reach the fields that would justify it. |

No anchor value rescues these without over-subsidising the Twin Otter alongside
them. They are genuine prune candidates — but now for a defensible reason (beaten
by a same-field aircraft carrying twice as many) rather than because the cost curve
starved them.

The remainder of the prune list is ordinary obsolescence, not starvation:
Do-328JET 7.6%, Yak-40 14.9%, 1900D 17.2%, ERJ-135 27.2%, SkyCourier 27.5%,
L-410 40.6%, Il-62M 44.1%, VC10 47.7%, ERJ-145 48.2%, CV-990 49.3%. In a game that
ships a 1936 DC-3, obsolete-but-cheap is reasonable historical texture; prune only
if a shorter catalogue is wanted for its own sake.

## 5. Blast radius

Eight airlines of 144 hold an aircraft under 39 seats. **Every change is a
reduction** — nothing gets more expensive:

| airline | status | change | as % of revenue |
|---|---|---|---|
| China Balls Airlines (75 × DC-3) | active | −$357,485 | −1.45% |
| Air France (2 × Islander) | active | −$44,699 | −0.05% |
| F8L Frontier, Delta Global, Tung Air, Cookies, Sámi, Maribondo | bankrupt/abandoned | −$1,671 to −$78,246 | — |

Six of the eight are already dead — and that is the finding arriving from the other
end. They bought aircraft that could not profit at any load factor, and went
bankrupt on schedule.

## 6. Test state

Headwinds 136 suites green (the one failure, `adsense-readiness-test`, needs to
unlink `public/` and only fails over the desktop bridge). Tailwinds 91 green — the
two that were failing earlier were fixed by 80aa828, not by this work. Golden
master `PARITY OK`.
