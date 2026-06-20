# Airport List Audit — Bias & Novelty

Run against the live list: **1,028 airports, 182 countries** (June 2026).
Method: counts from `src/data/airports.js`, scored via `score-candidates.mjs`.

---

## Part 1 — Is the list biased? Yes, in two specific ways.

### Regional balance vs. real air traffic

"Share of list" compared to each region's share of global air traffic (~2019 RPK/passengers)
and share of world population. Ratio > 1 = over-represented, < 1 = under-represented.

| Region | List % | Traffic % | vs traffic | Pop % | vs pop |
|---|---:|---:|---:|---:|---:|
| North America | 33.0 | 23 | **1.43** | 7.5 | 4.40 |
| Europe | 23.8 | 27 | 0.88 | 9.3 | 2.56 |
| Asia | 20.9 | 32 | **0.65** | 54 | 0.39 |
| Middle East | 5.4 | 9 | **0.61** | 4 | 1.36 |
| South America | 5.7 | 5 | 1.15 | 5.5 | 1.04 |
| Africa | 7.8 | 2.5 | 3.11 | 18 | 0.43 |
| Oceania | 3.3 | 3 | 1.10 | 0.6 | 5.51 |

Takeaway: **North America is over-weighted and Asia + the Middle East are under-weighted**
relative to where flying actually happens. (Africa looks "over" by traffic only because
it has very little air traffic; by population it's under-served — but low real demand means
it shouldn't be force-grown.)

### The bigger bias: per-capita depth

Airports per 10M people, major markets:

| Country | Airports | per 10M | | Country | Airports | per 10M |
|---|---:|---:|---|---|---:|---:|
| US | 253 | **7.55** | | Indonesia | 20 | 0.73 |
| France | 24 | 3.69 | | Nigeria | 11 | 0.49 |
| UK | 22 | 3.28 | | China | 55 | **0.39** |
| Mexico | 29 | 2.27 | | Egypt | 4 | 0.35 |
| Japan | 28 | 2.26 | | India | 41 | **0.29** |
| Brazil | 29 | 1.35 | | Pakistan | 4 | 0.17 |
| | | | | Bangladesh | 2 | 0.12 |

The US has **~20× the per-capita airport depth of China and ~26× that of India** — the two
largest growth markets in aviation. The US tail runs all the way down to fields like
Binghamton and Kalamazoo, while comparably huge markets stop at the majors.

### The starkest gaps — giant countries with almost nothing

| Country | Pop (M) | Airports in game | Obvious missing majors |
|---|---:|---:|---|
| Pakistan | 240 | 4 (KHI, LHE, ISB, SKT) | Peshawar PEW, Multan MUX, Quetta UET, Faisalabad LYP |
| Bangladesh | 173 | 2 (DAC, CGP) | Sylhet ZYL, Cox's Bazar CXB, Jessore JSR |
| Ethiopia | 127 | 1 (ADD) | Bahir Dar BJR, Dire Dawa DIR |
| Egypt | 113 | 4 (CAI, HRG, SSH, ALY) | Luxor LXR, Aswan ASW |
| Iran | 88 | 2 (IKA, MHD) | Shiraz SYZ, Isfahan IFN, Tabriz TBZ |
| Sudan | 48 | 1 (KRT) | Port Sudan PZU |
| Uganda | 49 | 1 (EBB) | — |

### Recommendation on balance

Don't trim the US — it genuinely has the most airports with scheduled service, so the depth
is *realistic*. But **freeze US additions** and direct all future growth toward the
under-weighted side:

1. **China & India secondary cities** — the single biggest realism/traffic gap (the 19 we
   just added were a start; both still sit near 0.3–0.4 airports/10M).
2. **South & Southeast Asia + Middle East** — Pakistan, Bangladesh, Iran, Indonesia.
3. **Fill the "1-airport giant" cases** above — each missing major is a real, viable market.

A balanced target is ~1,200–1,400 airports where the *new* ~200 are ~70% Asia/MEA, not more US.

---

## Part 2 — Novelty / "rule of cool" airports

I scored 44 famous/extreme/record-holding airports. Good news: **your curation already has
strong novelty taste** — 16 were already in the game (St Maarten SXM, Innsbruck INN,
La Paz LPB, Leh IXL, Telluride TEX, Juneau JNU, Lhasa LXA, Kathmandu KTM, Congonhas CGH,
Réunion RUN, and more).

### Tier 1 — Iconic *and* commercially viable (add normally)

These clear the demand gate, so they enrich routes *and* add character:

| Code | Airport | Why it's interesting | Best market |
|---|---|---|---|
| DIL | Dili, Timor-Leste | **Missing national capital** | 1,788 pax → CGK |
| PBH | Paro, Bhutan | Himalayan approach; handful of certified pilots | 1,422 → DAC |
| USH | Ushuaia, Argentina | **Southernmost airport in the world** | 677 → EZE |
| FAE | Vágar, Faroe Islands | Dramatic fjord approach | 905 → LHR |
| GOH | Nuuk, Greenland | New intl runway; Arctic gateway | 333 → JFK |
| DCY | Daocheng Yading, China | **Highest airport on Earth (4,411 m)** | 629 → DAC |
| BPX | Qamdo Bamda, Tibet | One of the longest/highest runways | 841 → DAC |
| LUA | Lukla, Nepal | **"World's most dangerous" — Everest gateway** | 340 → DEL |
| HGU | Mount Hagen, PNG | Remote highlands hub | 432 → HND |
| PPG | Pago Pago, Am. Samoa | South Pacific outpost | 426 → NRT |
| IPC | Easter Island, Chile | **Most remote airport on Earth** | 161 → MEX |
| INU | Nauru | Airport of the world's smallest island nation | 240 → NRT |
| GIS | Gisborne, NZ | Railway crosses the runway | 334 → AKL |
| FSP | St-Pierre (France, off Canada) | Geographic oddity | 252 → JFK |
| MNK | Maumere, Indonesia | Archipelago depth | 1,064 → CGK |

### Tier 2 — Pure novelty (low demand; add for flavor, not economics)

The scorer flags these `WEAK` or `DUPLICATE` because the demand is tiny or they sit next to
an existing airport — but that's exactly the point of a novelty pick. Add a handful if you
want "achievement" destinations / charter flavor:

- **BRR Barra (Scotland)** — only airport with scheduled flights landing **on a tidal beach**.
- **LYR Longyearbyen (Svalbard)** — northernmost scheduled airport.
- **HLE St Helena** — notorious wind shear; "world's most useless airport."
- **SAB Saba** — **shortest commercial runway on Earth (400 m)**; sits 46 km from SXM.
- **SBH St Barthélemy** — steep hillside approach; 33 km from SXM.
- **GIB Gibraltar** — a public road crosses the runway.
- **CVF Courchevel** — alpine altiport with a sloped runway (the *Bond* one).
- **SFJ Kangerlussuaq / NLK Norfolk Island / AXA Anguilla / VQS Vieques** — remote/island color.
- **SDU Santos Dumont (Rio)** — downtown-waterfront airport, 14 km from GIG (great as a
  slot-constrained second city airport if the game ever models those).

> Note: a couple of candidate rows had data quirks worth a manual check before adding —
> `TRW` (Tarawa) collided oddly with an existing code, and `THE` is already used for Teresina,
> not Thimphu (Bhutan = `PBH`).

---

## Suggested next step

If you like, I can:
1. Add the **Tier-1 novelty set** (15 airports) the same way we added the last 19, and
2. Generate a **balanced ~80-airport pack** filling the China/India/Pakistan/Bangladesh/
   Iran/Egypt gaps, run through the scorer so only viable, distinct ones make the cut.

Full per-airport numbers are in `scored-candidates.csv` (re-run `node score-candidates.mjs
novelty.csv <path-to-airports.js>` to reproduce).
