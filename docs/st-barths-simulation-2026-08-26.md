# The St Barths test — simulated

2026-08-26. Companion to `docs/startup-survival-audit-2026-08-26.md`, which
looked at what live airlines actually did. This one runs the specific challenge
that was thrown down in Discord:

> "Or be my guest and make an airline who's only hub is in st barths and we can
> see how long it lasts"

**Answer: it lasts about two years, and it never has a single profitable week —
in any of the 45 strategies tried. But the reason is not St Barths.** An
identical Twin Otter operation at JFK dies four months *sooner*. The island
adds one thing the rest of the map does not: it takes the escape hatch away.

Method and caveats: `tools/stbarths/README.md`. Everything below is the shipped
engine, seeded by the server's own `seedAirlineState()` and advanced with the
same `ADVANCE_WEEK` payload `tickService` sends. Single airline, no human rivals
— every number here is the *uncontested* best case.

---

## 1. St Barths can only be flown by two aircraft in the game

`SBH` (Gustaf III, Gustavia) has a **2,119 ft** runway and a catchment
population of 10,000.

| | |
|---|---|
| aircraft types in the game | 164 |
| types that clear a 2,119 ft runway | **2** |

Those two are the **DHC-6 Twin Otter 400** (19 seats, $14,000/wk lease) and the
**Britten-Norman Islander** (9 seats, $4,000/wk). Nothing else fits, at any
price, ever. There is no upgauge path out of St Barths — which matters, because
upgauging is precisely what the live data shows the survivors doing.

Reachable, legal, non-zero-demand markets from SBH: **50** on the Twin Otter,
19 on the Islander.

## 2. The whole market is smaller than one airline's overhead

Total weekly O&D demand across **all 50** markets a Twin Otter can reach from
SBH: **4,985 passengers**. The best single market is SJU (San Juan) at 609/wk.

Fares there are thin and the market is price-inelastic in the wrong direction —
it is a leisure market (`businessScore 20 / leisureScore 90`), so demand
collapses the moment you mark up. Measured on the engine, one Twin Otter at the
NWR block-hour ceiling on SBH–SJU:

| fare vs reference | $ fare | weekly seats | pax | load factor | weekly revenue |
|---|---|---|---|---|---|
| 0.6× | $55 | 798 | 551 | 69% | **$61,105** |
| 0.8× | $73 | 798 | 291 | 36% | $43,143 |
| 1.0× | $91 | 798 | 177 | 22% | $33,033 |
| 1.2× | $109 | 798 | 80 | 10% | $17,620 |
| 1.4× | $127 | 798 | 2 | 0% | $517 |
| 1.7× | $155 | 798 | 0 | 0% | **$0** |

Above about 1.3× reference the market simply stops buying. "Price up and fly
premium to a luxury island" is not a strategy the demand model supports.

## 3. What the best possible St Barths airline looks like

Best cell out of 45 (fleet size × frequency × fare), at week 26 — one Twin
Otter worked to its block-hour ceiling across three markets:

| | weekly |
|---|---|
| revenue | **$115,221** |
| — | |
| gate fees | $37,500 |
| HQ overhead | $45,800 |
| hub investment | $25,000 |
| labour | $29,381 |
| crew | $33,038 |
| fuel | $26,624 |
| lease | $14,000 |
| insurance | $6,000 |
| maintenance | $4,005 |
| everything else | ~$63,000 |
| **total cost** | **$284,278** |
| **profit** | **−$169,057** |

Read the first three lines together. **Gates, head office and the hub cost
$108,300 a week — 94% of everything the airline earns — before it buys a single
litre of fuel.** Deleting HQ overhead entirely still leaves it $123k/week in the
red. This is not the flat-$40k-base problem from the last audit; it is bigger
than that.

## 4. The sweep: 45 strategies, 45 deaths, zero profitable weeks

36 cells of fleet size {1, 2, 4} × schedule {1 daily, 2 daily, block-hour max,
demand-matched} × fare {0.6×, 0.8×, 1.0×}, plus 9 more of fleet {1, 2, 3} ×
fare {0.8×, 1.0×, 1.2×} with each airframe spread over several markets. Median
death week at the best fare in each column, 5 seeds per cell:

| fleet | 1 daily | 2 daily | max frequency | spread over 3 routes |
|---|---|---|---|---|
| 1 aircraft | wk 106 | **wk 108** | wk 97 | wk 95 |
| 2 aircraft | wk 77 | wk 74 | wk 63 | wk 64 |
| 3 aircraft | — | — | — | wk 50 |
| 4 aircraft | wk 51 | wk 46 | wk 38 | — |

**Not one run in any cell had a single profitable week.** The airline survives
longest by staying at one aircraft and burning the $15M founding capital as
slowly as possible — which is a countdown, not a business.

Every Twin Otter added at SBH costs roughly **$95,000 a week**. The marginal
airframe is loss-making from the first one, so there is no scale to grow into.

## 5. The important part: it is the aircraft, not the island

Same bot, same rules, same world, different hub and gauge:

| hub | aircraft | survives 2 yrs | ever profitable | died (median) | revenue wk 26 | profit wk 26 |
|---|---|---|---|---|---|---|
| **SBH** St Barths | Twin Otter (19) | 0/10 | **0/10** | wk 51 | $50k | **−$346k** |
| SJU San Juan | Twin Otter (19) | 0/10 | **0/10** | wk 42 | $287k | **−$441k** |
| JFK New York | Twin Otter (19) | 0/10 | **0/10** | wk 40 | $511k | **−$458k** |
| SJU San Juan | A320 (186) | 7/10 | 10/10 | wk 96 | $4.44M | **+$161k** |
| JFK New York | A320 (186) | **10/10** | 10/10 | — | $5.11M | **+$648k** |

Ten seeds per row, identical bot, identical settings — so this table compares
hubs and gauges, not strategies. (St Barths' *own* best strategy is the one in
§3, and it still loses $169k a week.) SBH looks least-bad on profit here only
because its market is too small for the bot to spend money into: it survives
longest by having less to do.

A Twin Otter operation dies at John F. Kennedy International — with the deepest
demand pool on the map, at *week 40* — eleven weeks sooner than at St Barths. Move
the same airline to a narrowbody and it is profitable and alive.

So the complaint in Discord is aimed at roughly the right thing and lands on the
wrong noun. It is not that small islands are unviable. **It is that small
aircraft are unviable, everywhere, and St Barths is simply the one place where
you are not allowed to fix it.**

## 6. Harness validation — small does not always die

If the harness killed every small operator it would prove nothing. It does not.
Two live airlines from the audit, reproduced:

| | live | simulated |
|---|---|---|
| Critical Success — 2 × Saab 2000 at SVO, 2 routes, ~45 weekly freq | +$356k/wk | **survives, profitable 5/5 runs, +$25k/wk at wk 26** |
| Air Premium — 3 × CV-580 at EVN, 12 routes | +$635k/wk | survives, −$128k at wk 26 and improving |

The simulated versions are weaker than the live ones because the live airlines
are three seasons old and carry the awareness, loyalty and reputation that come
with that; the bot has none. That gap is the honest margin of error on every
number above, and it runs in the *optimistic* direction for St Barths.

The pattern those two share is the one §4 of the audit found: 58-seaters, very
high frequency, very few short routes. **58 seats works. 19 does not.** The
viable-gauge floor sits somewhere between them.

## 7. What this changes

Nothing here contradicts the previous audit — it sharpens it.

1. The audit's fix list is aimed at HQ overhead. This says HQ is **one third**
   of the fixed-cost wall on a one-aircraft airline. **Gate fees ($37.5k) and
   hub investment ($25k) are the other two thirds**, and neither scales down for
   a 19-seat operator. A gauge-aware `HQ_BASE_WEEKLY` alone will not make small
   aircraft viable; it will just move the death from week 100 to week 130.
2. **The runway constraint should be surfaced at founding.** A player who picks
   St Barths as their hub has, at that moment, chosen from 2 of 164 aircraft
   for the rest of the game. Nothing in the UI says so. That is the single
   cheapest fix on this page.
3. **Consider a floor on tiny-gauge viability, or stop offering the airports.**
   Right now SBH is selectable, evocative, and mathematically a trap. Either it
   should be survivable at one or two airframes, or it should not be a hub
   option. A third option — leave it, and label it — is defensible too, but the
   label has to exist.
4. The fare curve in §2 is worth a look on its own. Demand hitting exactly zero
   at 1.4× reference on a leisure pair is a cliff, not a curve, and it means
   yield management has no room to work in small leisure markets.

---

Method: `tools/stbarths/`. No database access. Single airline, no human rivals,
uncontested markets — the friendliest possible reading for St Barths. Bot
limitations are listed in the tool README and all of them understate the losses.
