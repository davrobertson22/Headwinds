# Aircraft data audit — full table review

**Date:** 2026-07-29
**Scope:** all passenger jets in `packages/engine/src/data/aircraft.js`, checked against real specifications.
**Trigger:** the 757-200 dominance report ("why on earth is a 757-200 cheaper, bigger and more fuel efficient than a 737-800?"), which turned out to be one instance of a much wider pattern.

Nothing in this document is applied. The 757-200/-300, A320ceo, C919, 737-900ER, A319ceo and 757-200PF fixes agreed earlier **are** applied and are not repeated here.

---

## 0. The systemic finding

**Maintenance cost per seat is flat across every decade of airframe.**

| EIS decade | n | avg $/seat/wk |
|---|---|---|
| 1960s | 9 | $317 |
| 1970s | 12 | $569 |
| 1980s | 17 | $348 |
| 1990s | 22 | $347 |
| 2000s | 14 | $347 |
| 2010s | 20 | $379 |
| 2020s | 14 | $350 |

A 1968 airframe costs the same per seat to maintain as a 2026 one. (The 1970s figure is skewed by Concorde at $2,500.)

This is the passenger-side twin of the gap that caused the 757 bug. The **freighters** got `deliveredAgeWeeks` *and* an old-airframe maintenance penalty in the 2026-07-29 freighter repricing — there is even a test named `every classic freighter conversion carries an old-airframe maintenance penalty`. **The passenger table got neither.**

The consequence is that an old passenger jet is cheap to buy (used-value pricing per `docs/aircraft-price-audit.md`), cheap to maintain (no age penalty), and arrives at zero hours with full life ahead. There is no downside to flying a 1970s fleet. Every individual price in the table can be defensible while the *table* is unplayable — which is exactly the failure mode the freighter audit documented.

**This is the one finding worth fixing structurally rather than value-by-value.**

---

## 1. Ladder-breaking errors — highest priority

These make an aircraft strictly better than something it should lose to.

| id | field | current | correct | why |
|---|---|---|---|---|
| `b737max8200` | fuel | 320 | **~385** | Identical airframe to the MAX 8 — same fuselage, same LEAP-1B, same 82,600 kg MTOW, one extra exit pair, ~450 kg more OEW. It cannot burn 16% *less*. At 320 it is the most efficient narrowbody in the game by 12%. Fuel÷length is near-constant per generation (MAX = 9.42–9.67); the 8-200 sits at 8.10. |
| `a330800` | fuel | 798.25 | **~690** | The A330-800 is a 5-frame shrink of the A330-900 with the same wing, engine and MTOW, so it must burn **less** than the -900 (723.25). It currently burns 10% more — and more than the A330-200ceo it replaces. Airbus markets it as 4% better per seat than a 787-8; the table makes it 11% worse. **The only stretch/shrink inversion in the widebody section.** |
| `a330800` | maint | $200k | **~$160k** | Same family, same engines, five frames shorter than the -900 — yet the most expensive A330 to maintain, above the -900 ($165k), the -300 ($160k) and the larger 787-9 ($190k). |
| `do328jet` | fuel | 234.25 | **~160** | Implies 1,390 kg/h for a **15.7 t** twinjet, when the table's own CRJ-200 (24 t) implies 1,034 kg/h and ERJ-135 (20 t) implies 916. Physically impossible. Its 6.890 L/seat is 2.2× every other regional jet. |
| `mc21310` | fuel | 360 | **~425** | The PD-14 is ~5% behind the PW1400G *and* the Russified airframe is ~5.75 t heavier — so the -310 must burn **more** than the MC-21-300 (387.75), not 7% less. At 360 it is the second-most-efficient narrowbody in the game. |

---

## 2. Fuel-scale errors

A forensic note that makes this section tractable: **the table's fuel figures were derived from operational block-hour (kg/h) tables divided by an assumed cruise speed.** The Il-96-300's 1150.25 matches the Russian Transport Clearing House figure of 7,818 kg/h ÷ 850 km/h to within 0.05%; the same table's A320 and A321 rows reproduce the game's 409.5 and 462.25 almost exactly. So the scale is sound and the entries below are the ones that fell off it.

**Overstated (aircraft made too thirsty):**

| id | current | correct | why |
|---|---|---|---|
| `a340300` | 1322.25 | **~900–950** | Implies ~9,210 kg/h; published A340-300 burn is 6–7 t/h, and 9 t/h is the figure quoted for the A340-600. Set 66% above the correctly-calibrated A330-300 when the real gap on the same cross-section is 12–20%. |
| `md11` | 1281.5 | **~1,020–1,060** | Implies ~8,700–9,000 kg/h; Aircraft Commerce operator data for CPH–PVG gives ~6,750–7,150 kg/h. Also creates a false inversion — it makes the 1990 MD-11 worse per seat than the 1972 L-1011. |
| `a340600` | 1437 | **~1,250** | Implies ~10,100 kg/h against a published ceiling of ~9 t/h. Lower confidence than the -300. |

**Understated (aircraft made too efficient):**

| id | current | correct | why |
|---|---|---|---|
| `fokker70` | 223.75 | **~315** | 41% low. Line-pilot block data: F70 ≈ 1,900 kg/h. Also 4074 km range is *exactly* the E175's figure — a copy artifact. |
| `fokker100` | 267 | **~355** | 33% low. ~2,250 kg/h averaged over a 2 h sector. At 267 a 1988 Tay-powered F100 is nearly as efficient per seat as a 737-800. |
| `bae146200` | 287.5 | **~365** | 25% low. Wikipedia's measured FL310 figures interpolate to ~2,220 kg/h at the type's M0.70 cruise. |
| `avrorj85` | 273.75 | **~345** | Same family; keeps its ~5% edge (LF507 vs ALF502). |
| `ssj100` | 264 | **~347** | 24% low. The exact source figure was found: TCH lists SSJ-100 at 2,296 kg/h in the *same table* as the Il-96 row the database already matches. |
| `sj100new` | 275 | **~355** | Must stay above a corrected `ssj100` to keep PD-8 vs SaM146 in the right order. |
| `tu204` | 468.75 | **~540** | TCH operational data: Tu-204 3,688 kg/h vs A321 3,085 — **19.5% thirstier than an A321**. The table has it 1.4% above. |
| `md80` | 439 | **~510** | Aircraft Commerce: the MD-80 burns "about 25% more than the A320 or 737NG". The table has 7%. Currently the 68 t, 172-seat MD-80 burns the same as the 54.9 t, 139-seat DC-9-50. |
| `tu154m` | 700 | **~770** | TCH: 5,230 kg/h ÷ 850 km/h = 769. |
| `a319neo` | 337 | **~319** | vs the A319ceo's 336.75 that is a **0% generational gain** — the only neo in the table with no improvement (A320neo −5.2%, A321neo −3.8%). |
| `a220100` | 269.25 | **~286** | The -100 shrink is currently *better* per seat (1.994) than its own -300 stretch (2.005). |

**E-Jet E2 generation gap is about one third of the real one.** The E1 entries check out (103–109% of pilot-reported block data); the E2s are the problem:

| id | current | correct | basis |
|---|---|---|---|
| `e190e2` | 274.75 (−6.2%) | **~242** (−17.3%) | Embraer flight test: 17.3% better than the E1 |
| `e195e2` | 324 (−8.7%/seat) | **~265** (−25.4%/seat) | Embraer flight test: 25.4% less per seat |
| `e175e2` | 220.5 (−4.9%) | **~199** | extrapolated — no E175-E2-specific figure published |

Cross-check: a corrected `e195e2` at 265 gives 1.81 L/seat against the table's own A220-300 at 2.005 — 9.6% better, independently reproducing Embraer's "10% better than the A220" claim.

---

## 3. Copy artifacts and wrong values

**Boeing's range table was read one row off.** The MAX 7's 7,037 km matches Boeing exactly, so the source is right — but:

| id | field | current | correct |
|---|---|---|---|
| `b737max9` | range | 6570 (the MAX 8's number) | **6110** |
| `b737max10` | range | 6110 (the MAX 9's number) | **5740** |

Other copy artifacts and errors:

| id | field | current | correct | why |
|---|---|---|---|---|
| `a220100` | range | 5700 | **6700** | Airbus: -100 = 3,600 nm, -300 = 3,400 nm. The -300 is right; the -100 is 1,000 km short **and in the wrong order** — the lighter shrink really does out-range the stretch. |
| `a318` | range | 6800 | **5700** | Currently within 100 km of the A319, erasing the shrink's real range deficit. |
| `e190e2` | range | 4537 | **5460** | The E190 E1 figure copied verbatim. |
| `e195e2` | range | 4800 | **5600** | Raised to 3,000 nmi in July 2024. |
| `fokker70` | range | 4074 | **3410** | 4074 is exactly the E175's 2,200 nmi figure. |
| `b737500` | seats | 140 | **149** | Boeing ACAP: "FAA EXIT LIMIT: 149" — same door/overwing arrangement as the -300, which the table already has at 149. |
| `b737400` | seats | 188 | **189** | ACAP exit limit. Trivial. |
| `b707320` | seats | 219 | **189** | 219 is the 707-**320C**'s limit, which needed two extra aft exits the passenger -320B doesn't have. |
| `b737max10` | runway | 7000 | **~6050** | Real TOFL: MAX 8 8,300 ft, MAX 10 ~8,858 ft — only 6.7% more. The table gives +22.8%, making the MAX 10 need more runway than a 757-300. |
| `b7778x` | eis | 2027 | **2029/2030** | The 777-8 *freighter* is 2028 at the earliest; the passenger variant is behind it. |
| `b7779x` | eis | 2026 | **2027** | 777-9 first delivery (Lufthansa) confirmed for 2027. |
| `arj21` | price | $38M | **$20–24M** | $38M is the **list** price; the table's convention is ~50% off list. At $38M it costs nearly as much as an E190-E2 ($40M) for 90-ish seats vs 114 and 3,700 km vs 5,460. |

---

## 4. Checked and defensible — do not change

- **`b7778x` maintenance $275k/wk** (higher than the larger 777-300ER). The table scales maintenance with asset value and technology tier, not size or age — the A350-900 ($185M/$250k) already sits above the 777-300ER ($170M/$240k). The 777-8 at $195M/$275k fits that curve, and matches real lessor practice where reserves track engine value. The GE9X is a very expensive engine.
- **`c929`** — every number leans conservative. Range 12,000 km matches COMAC exactly, 440 seats is the top of the published band, and its fuel makes it 5% thirstier than the *heavier* A350-900.
- **`spacejet`** — fuel 234.5 correctly sits between the E175-E1 and E175-E2 (PW1200G generation, ~2 t overweight). Seats and range check out. Its $40M price for a cancelled type is a design call, not a spec error.
- **`e175` $30M > `e190` $24M** — matches the real used market, where US scope clauses keep E175 values well above E190-E1s.
- **`crj900` range 2,876 km < `crj1000` 3,004 km** — looks odd, is real.
- **MAX 7/8/9/10 seat counts** (172/210/220/230) all match Boeing's published maxima, including MAX 8 = 210 with the extra exit pair.
- **All 27 widebody ranges** verified within ~1%, and all widebody seat counts match certified exit limits.

## 5. Could not verify

- 777-8 / 777-9 exit limits (440/550) — the FAA TCDS and Boeing's 777X ACAP were both unreachable; Wikipedia's 395/426 are two-class marketing numbers, not exit limits.
- A350 takeoff field lengths — secondary sources say 2,600/2,800 m but no primary source found.
- `b737300` fuel 362.5 looks ~3% low on the fuel÷length curve, but no clean published -300 vs -400 block pair was found.
- `b720b` seats 165 / range 6,700 km both look ~10–14% generous, but 1960s data varies widely by source.

---

## Suggested order

1. **Section 1** — five values, all ladder-breaking, all verified. Cheapest real gameplay win.
2. **Section 3** — mechanical corrections, no balance judgement needed.
3. **Section 2** — the largest set; changes seat-mile economics across many types, so worth doing as one pass with the golden master re-baselined once.
4. **Section 0** — the structural fix. Biggest change and the one that stops this class of bug recurring, but it touches live saves and wants its own design pass.
