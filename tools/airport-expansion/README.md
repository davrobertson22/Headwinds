# Airport Expansion Scorer

A data-driven tool to decide **which** airports are worth adding to the game —
instead of chasing a round number like "3,000" or "5,000".

It scores each candidate against two gates using the **game's own gravity model**
(imported live from `src/data/airports.js`, so it never drifts):

1. **Distinctiveness** — km to the nearest airport already in the game. A candidate
   sitting on top of an existing one only cannibalizes it.
2. **Viability** — best modeled weekly one-way demand from the candidate to any
   existing airport (its natural partner/hub). If nothing clears the floor, no
   aircraft in the fleet can profitably serve it.

Verdicts: `ADD` | `DUPLICATE` (too close) | `WEAK` (no viable market) | `EXISTS` (code already in game).

## Run

```bash
node tools/airport-expansion/score-candidates.mjs [candidates.csv] [path/to/src/data/airports.js]
```

Writes `scored-candidates.csv` (ranked, with verdict + the modeled numbers behind it)
and prints a summary by region.

## Policy levers (top of the script)

| Lever | Default | Meaning |
|-------|---------|---------|
| `DISTINCT_MIN_KM` | 90 | closer than this to an existing airport → DUPLICATE |
| `VIABLE_MIN_PAX` | 150 | best weekly one-way market below this → WEAK |
| `FEEDER_MAX_KM` | 2500 | radius for reporting the "natural feeder hub" |

Tune these and re-run to make the bar stricter or looser.

## Candidate file format

`candidates.csv`: `code,name,city,country,lat,lon,population,leisure`
- `population` = metro **catchment** in millions (drives the gravity model)
- `leisure` = 1 for tourism-driven destinations (gets the leisure demand multiplier,
  mirroring the game's `{business:15, leisure:90}` profile vs the plain regional `{32,55}`)

## Key finding (June 2026 run, 145 curated gap-market candidates)

Against the existing **1,009** airports:

- **122 (84%) already in the game** — even a deliberately chosen list of "missing"
  secondary cities (Chinese Tier-2, Indian Tier-2, Indonesian/Philippine islands,
  African metros, European leisure) was mostly already covered.
- **4 DUPLICATE** — e.g. both Boracay airports (MPH ~ KLO 54km), Krabi ~ Phuket (74km).
- **0 WEAK** in this batch (the curated list was already biased toward viable markets).
- **19 genuinely new + viable (ADD)** — concentrated in East/SE Asia.

Top adds by modeled demand: Bandung (BDO), Nantong (NTG), Wuxi (WUX), Zhanjiang (ZHA),
Shantou (SWA), Zhangjiajie (DYG), Udaipur (UDR), Pontianak (PNK).

**Conclusion:** the marginal real airport that is *both distinct and viable* is rare.
Your 1,009 already reach down to 3,000-population fields. Expanding toward 3,000–5,000
would overwhelmingly add `DUPLICATE`/`WEAK` entries — clutter and N² cost, not depth.
A targeted pass adding the ~couple-hundred true `ADD`s (mostly Asian secondary metros +
a few coherent island networks) is the high-value move. Aim for ~1,200–1,500 chosen by
this gate, not a headline count.

## Scaling to a full candidate pool

This repo ships a **curated starter pool** (`candidates.csv`) because the build sandbox
blocks bulk dataset downloads. To screen *every* real airport on your own machine:

1. Download **OpenFlights** `airports.dat` (or **OurAirports** `airports.csv`) for
   IATA code + lat/lon + country.
2. Join to **GeoNames** `cities15000.txt` (or `all-the-cities` npm) — match each airport
   to its nearest city to get a `population` catchment estimate.
3. Set `leisure=1` heuristically (resort/island keywords, or low-business GeoNames feature codes).
4. Emit the same `candidates.csv` columns and run the scorer. The `EXISTS`/`DUPLICATE`
   gates auto-filter the ~1,009 you already have and anything redundant.
