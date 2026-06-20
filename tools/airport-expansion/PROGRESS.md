# Airport Expansion — Progress & Process (June 2026)

Goal: scale the game from ~1,500 toward 2,500–3,000 airports, adding only airports
that are **distinct** (not on top of an existing one) and **viable** (a real market
exists) under the game's own gravity model.

## The repeatable process

1. **Author candidates** by region into `cand*/` CSVs:
   `code,name,city,country,lat,lon,population,leisure`
   (`population` = metro/catchment in millions; `leisure=1` = tourism-driven.)
2. **Score** with the tiered, region-aware scorer (imports the live game model so it
   never drifts):
   ```bash
   node tools/airport-expansion/score-tiered.mjs <out.csv> cand/*.csv
   ```
   Region tiers relax the bar where coverage is thin:
   | Tier | Examples | distinct (km) | viable (pax/wk) |
   |------|----------|--------------:|----------------:|
   | US | United States (own tier) | 24 | 130 |
   | DENSE | W. Europe, Japan, Korea, AU, Gulf | 90 | 150 |
   | MID | Russia*, Latin America, E. Europe, Turkey, ZA | 65 | 90 |
   | SPARSE | China, India, Africa, most MEA, C. Asia, Pacific | 45 | 55 |
   (*Russia falls to SPARSE in code; only MID set is listed explicitly.)
   The US has its own relaxed-distinctiveness tier because the country genuinely has
   deep multi-airport metros the game already models (JFK/LGA/EWR, DAL/DFW, HOU/IAH,
   ORD/MDW, SFO/OAK/SJC). 24km still rejects truly co-located fields.
   Verdicts: `ADD | DUPLICATE | WEAK | EXISTS | BADGEO`.
3. **Insert** the ADDs (skips anything already present, groups by country, matches
   the existing object format, adds `visitors` for leisure spots):
   ```bash
   node tools/airport-expansion/insert-adds.mjs <scored.csv>
   ```
4. **Verify**: re-import `src/data/airports.js` — check total, no duplicate codes,
   no bad geo/pop. (`vite build` in this repo needs the project's Node 20.x.)

## Waves run

| Wave | Candidates | ADD | Yield | Running total |
|------|-----------:|----:|------:|--------------:|
| start | — | — | — | 1,521 |
| 1 (global tilt to Asia/MEA/Africa) | 656 | 207 | 32% | 1,728 |
| 2 (Americas/Africa/AsiaPac long tail) | 203 | 141 | 69% | 1,869 |
| 3 (China/Africa tertiary/Europe/Russia N) | 83 | 44 | 53% | 1,913 |
| 4a (US regional, strict DENSE 90km) | 73 | 42 | 58% | 1,955 |
| 4b (US secondary metros, US tier 24km) | 26 | 26 | 100% | 1,981 |
| 5 (US regional/EAS tail) | 87 | 75 | 86% | 2,056 |

US is now at 405 airports — effectively the entire US scheduled-passenger-service
network. 11 tiny Alaska bush points (Haines, Deadhorse, Cold Bay, Gustavus, Skagway,
etc.) scored WEAK (real service but sub-floor demand); available as an optional
flavor pack if desired. Beyond these, remaining US fields are general-aviation only
(no scheduled commercial service) and don't belong in an airline game.

## Key finding — the realistic ceiling

The existing list is far deeper than the old AUDIT implied: **~60–65% of even
carefully-chosen "missing" candidates already existed.** The world has only
~3,800–4,000 airports with scheduled passenger service, and the game now holds the
best ~1,900. The remaining pool of *distinct + viable* real airports is roughly
**300–500 more → a practical ceiling around ~2,200–2,400**, and only by admitting
progressively tiny fields. Reaching 2,500–3,000 requires one of:

- **Ingest a real dataset** (OurAirports / OpenFlights) and auto-screen the whole
  global list — most accurate & complete. (Sandbox blocks bulk downloads; drop the
  file into this folder, or fetch via the Chrome extension.)
- **Relax gates further** to admit the small-field long tail (more marginal routes).
- **Keep hand-authoring waves** — diminishing yield + rising data-accuracy risk the
  deeper into the tail you go (verify codes/coords against a real source before trust).

US growth is deliberately frozen (already realistic depth per AUDIT); new airports
are tilted ~70% toward Asia / Middle East / Africa.
