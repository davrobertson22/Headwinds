# Travel Partnerships — Design Plan

**Status:** BUILT in Headwinds (2026-10-29), on disk, not committed. New worlds only. Tailwinds port later. See §12.
**Date:** 2026-10-29

Airlines sign partnerships with **cruise lines, tour/vacation operators, hotel chains and ride-share
companies**. Each partner lifts one demand segment at the airports it works in: cruise lines and tour
operators lift **leisure**, hotels and ride share lift **business**. In return each partner sets its own
**requirements** (e.g. "1,500 leisure passengers a week into our Caribbean ports, November to April").
How well you meet them moves the partner's **happiness**. Happy partners renew cheaply and on the same
terms. Unhappy ones charge more, tighten their targets, drag your reputation down and can walk out.

## 0. Decisions so far (Dave, 2026-10-29)

- **Design doc first.** No code until this is signed off.
- **Payoff is demand, split by segment.** Cruise and vacations boost leisure; hotels and ride share boost
  business. Requirements are partner-specific, e.g. a cruise line needs X leisure passengers delivered to
  ports X, Y, Z.
- **Shared, like catering.** Any airline can sign any partner. There is no contention between players and no
  server-side lock.
- **New worlds only.** A world flag that is on by default for newly created worlds. Existing worlds are
  unchanged.
- **The boost fades with happiness**: full at h ≥ 50, nothing at h = 20.
- **Happy partners add reputation**, capped at +2. Unhappy ones subtract, down to −8.
- **Walk-outs go on the world news feed**, visible to everyone in the world.
- **Every contract runs 2 years.** There is no term choice.
- **A lost partner stays away for 5 years** (260 weeks). "Lost" means it walked out or refused to renew.
  In most worlds that is effectively permanent.

---

## 1. What exists today (the hooks this reuses)

| Existing system | What partnerships takes from it |
|---|---|
| **Lounges** (`data/lounges.js`, `loungeAppeal`) | The template. It is a business-only demand multiplier. In `computeUtility` it enters as `log(appeal) × weight`, with weight 1 on business and 0 on leisure. `_monopolyResult` and `_soloCeiling` apply it to the business pool. It is resolved once by `stateLoungeFields`, which the tick, `pairShare.js`, `humanRivals.mjs` and `encroachment.js` all call. Partnerships needs the same thing again, once per segment. |
| **Catering contracts** (`data/cateringContracts.js`) | A shared, deterministic book: prices hash from supplier × 26-week window, so every airline sees the same prices with no server state. Also terms, break penalties, the 8-week expiry warning, and conditional state spreading so the golden master stays put. |
| **Reputation** (`models/reputation.js`) | `overall` = the components + `loyaltyBonus` − `reputationPenalty`. The penalty is transient: it decays ×0.92 a week and is capped at 25. Reputation feeds `brandReach` (±7.5% demand on both segments) and price sensitivity (±0.10). |
| **Production lines world flag** | `tickConfig.productionLines !== false` turns it on for new worlds by default, and the state carries `productionLinesWorld: true`. Partnerships copies this pattern. |
| **Airport data** | `AIRPORT_SCORES` (businessScore / leisureScore), `visitors`, seasonal profiles. All 70-odd airports named below already exist. |

**One gap.** Route results carry passengers by **cabin** (`classSummary`), not by **segment**, once the
capacity cap and upgrade spill have run. A "leisure passengers delivered" requirement needs the
post-cap segment split. §6 adds it, but only on routes that touch a partner city.

---

## 2. Partner types

| Type | Segment lifted | Where it applies | What it typically asks for | Flavour |
|---|---|---|---|---|
| **Cruise line** | Leisure | Its embarkation ports, **in its sailing season** | Leisure passengers delivered to its ports in season | Seasonal: the requirement and the lift only run in season |
| **Tour / vacation operator** | Leisure | A list of holiday destinations | Serve at least K of the destinations, leisure passengers, a quality floor | Breadth: rewards a wide leisure network |
| **Hotel chain** | Business | Business cities | Business passengers delivered, a premium cabin or quality floor, a reputation floor to sign | Premium: hard to land early |
| **Ride share** | Business | Every airport in its country or continent | Weekly departures from those airports, on-time rate | Operational: scale and punctuality |

---

## 3. Catalogue (provisional: 16 partners, invented names)

Lift = how much this partner adds to its segment on a route touching a covered airport.
Prominence (1–3) weights its effect on reputation (§5.5). Fees are the **calibrated** figures from
`tools/travel-partner-calibration.mjs` (§12), not the original placeholders.

### Cruise lines (leisure)
| Partner | Ports | Season | Lift | Requirements | To sign | Fee/yr | Prom. |
|---|---|---|---|---|---|---|---|
| Azure Horizon Cruises | MIA FLL MCO TPA SJU | Nov–Apr | +7% | ≥1,500 leisure pax/wk arriving at these ports | — | $0.25M | 3 |
| Northern Passage Line | SEA YVR ANC JNU | May–Sep | +6% | ≥500 leisure pax/wk; serve ≥2 of the 4 | — | $0.25M | 2 |
| Mare Nostrum Cruises | BCN FCO VCE ATH | Apr–Oct | +7% | ≥1,200 leisure pax/wk; route quality ≥50 on those routes | — | $0.25M | 3 |
| Southern Star Cruising | SYD BNE AKL SIN | Oct–Mar | +6% | ≥400 leisure pax/wk | — | $0.25M | 1 |

### Tour / vacation operators (leisure)
| Partner | Destinations | Lift | Requirements | To sign | Fee/yr | Prom. |
|---|---|---|---|---|---|---|
| Solstice Holidays | PMI AGP ALC FAO HER TFS LCA | +6% | Serve ≥4 of 7; ≥2,000 leisure pax/wk across them | — | $0.55M | 2 |
| Farfield Expeditions | DPS MLE CPT HNL CUN BKK | +8% | Serve ≥3 of 6; route quality ≥60 on those routes | Rep ≥55 | $1.15M | 2 |
| Palm & Reef Vacations | AUA NAS MBJ PUJ OGG NAN | +7% | Serve ≥3 of 6; ≥600 leisure pax/wk | — | $0.30M | 1 |
| Backroads Budget Tours | Every North American airport with leisureScore ≥60 | +3% | ≥3,000 leisure pax/wk to those airports; on-time ≥80% | — | $0.45M | 1 |

### Hotel chains (business)
| Partner | Cities | Lift | Requirements | To sign | Fee/yr | Prom. |
|---|---|---|---|---|---|---|
| Aldgate Hotels & Resorts | JFK LHR CDG FRA HKG SIN NRT DXB | +6% | ≥1,500 business pax/wk to these; route quality ≥65 on those routes | Rep ≥60 | $0.40M | 3 |
| Lodestar Inns | Every North American airport with businessScore ≥55 | +4% | ≥1,000 business pax/wk; on-time ≥85% | — | $0.25M | 2 |
| Kestrel Suites | HKG SIN NRT HND ICN PVG TPE KUL BOM DEL | +6% | ≥800 business pax/wk; business cabin on ≥60% of routes to these | Rep ≥50 | $0.25M | 2 |
| Harbourline Hotels | LHR FRA CDG AMS ZRH MUC MAD | +5% | ≥1,000 business pax/wk; on-time ≥85% | — | $0.25M | 2 |

### Ride share (business)
| Partner | Coverage | Lift | Requirements | Fee/yr | Prom. |
|---|---|---|---|---|---|
| Zipway | United States | +3% | ≥400 weekly departures from US airports; on-time ≥82% | $1.70M | 1 |
| Velo Rides | Europe | +3% | ≥300 weekly departures; on-time ≥85% | $1.65M | 1 |
| Lumo Ride | Asia | +3% | ≥300 weekly departures; on-time ≥82% | $7.50M | 1 |
| Rumbo | South & Central America, Mexico | +3% | ≥150 weekly departures; on-time ≥80% | $3.60M | 1 |

The mix is deliberate. Ride share, Backroads and Palm & Reef are within reach of a young airline.
Aldgate, Farfield and Kestrel are reputation-gated and are something to grow into.

Like catering, list fees drift ±10% on a 26-week window, hashed from partner and window. The book is
identical for every airline in a world and needs no server state. Signing locks the fee.

---

## 4. The lift: how a partner moves demand

**Two new offer fields:** `travelLeisureAppeal` and `travelBusinessAppeal`. Both are multipliers, and 1
means no partner. The code says "travel partner" rather than "partner" because `partner` already means
alliance and codeshare partners (`partnerContestedKeys`, partner O&D).

**Per route:** every active partner that covers either endpoint, and is in season, contributes
`lift × happinessScale(h)`. Lifts within a segment add and are capped:
`appeal = min(1.15, 1 + Σ lifts)`. Two hotel chains at LHR stack until they hit the cap. Covering both
ends of a route does not double the lift.

**Happiness scales the lift** (decided). The full lift applies at h ≥ 50 and falls linearly to nothing at
h = 20. A sour partner stops promoting you before it walks out.

**In the demand model**, the same identity lounges use:
- `computeUtility`: + `log(travelLeisureAppeal) × w`, with w = 1 on leisure and 0 on business. Mirror image
  for business. On a contested pair it shifts share.
- `_monopolyResult`: multiply the leisure pool by the leisure appeal and the business pool by the business
  appeal. When there is no business cabin, the folded-in business travellers keep **their own** segment's
  appeal. On a monopoly it grows the pool: people who would not have flown book the package.
- `_soloCeiling`: the same multipliers. The solo-ceiling business-fold bug is the reason this step is
  listed separately.
- **Not** revenue, **not** quality score, **not** `brandReach`. Brand moves both segments; quality feeds
  the fare cliff and the quality ladders. Keeping the lift to segment demand keeps all of those
  untouched.

**Shared partners cancel out on contested pairs.** If you and a rival both sign Azure Horizon, the log
terms are equal and share does not move, though monopoly pools still grow. The value comes from out-signing
rivals who haven't signed, and from routes you fly alone. That is the honest result of "shared". It is worth
saying so in the wiki.

**One resolver:** `stateTravelPartnerFields(state, origin, destination, gameDate)` is the
`stateLoungeFields` twin. Every place that reads `loungeAppeal` today must spread it too:
`simulation.js` (tick hydration, tag routes, pooled groups, `routeQualityBreakdown` for display),
`pairShare.js` (`pairMarketShare`, `projectRouteAddition`), `humanRivals.mjs` (other players' offers,
so your lift shows up in their markets), and `encroachment.js`. A preview that leaves it out quotes
parity, which is the bug CLAUDE.md warns about.

Cargo is ignored. AI rivals never sign partners.

---

## 5. Requirements, happiness, renewal, reputation

### 5.1 Requirement kinds

Each kind is a pure function of the week's results. The same function, run on last week's report, gives the
UI's "you're at 1,140 / 1,500".

| Kind | Measures | Notes |
|---|---|---|
| `segmentPaxTo` | One-way pax of a segment **arriving** at the covered airports | Summed per covered endpoint per route, so MIA–SJU counts both directions. O&D only in v1 (open question 4). Needs the post-cap segment split (§6). |
| `serveCount` | Covered airports with ≥1 weekly passenger frequency | Dormant seasonal routes don't count. |
| `departures` | Weekly departures from covered airports | `airportDeparturesMap` already exists. |
| `onTime` | Airline on-time rate | `laborEffects(...).onTimeRate`, the same figure the Operations page shows. |
| `routeQuality` | Pax-weighted mean route quality on routes touching covered airports | The tick's own quality score. |
| `premiumCabin` | Share of routes touching covered airports that have business seats | |
| `reputationMin` | Overall reputation | Checked **at signing only**. |

**Attainment** `a` for each requirement:
- Volume kinds: `a = clamp(actual / target, 0, 1.25)`.
- Rate kinds (on-time, quality): a 10-point band. At target, a = 1. Ten points short, a = 0. Above target it
  rises to a maximum of 1.25. Being 2 points short of 85% on-time is a mild miss, not a 2% miss.
- A seasonal requirement out of season is skipped.

### 5.2 Happiness (0–100)

- A first signing starts at **60**. Re-signing after a walk-out or an early break starts at **40**: the
  partner remembers.
- Each week, combined attainment `A = 0.5 · min(aᵢ) + 0.5 · mean(aᵢ)`. Averaging can't bury one big miss.
- Target happiness: A ≤ 0.4 → 0; from 0.4 to 1.0, rises linearly from 0 to **80**; from 1.0 to 1.25, rises
  from 80 to **100**. Meeting the brief exactly makes a partner content. Over-delivering is what
  delights them.
- `h ← h + 0.10 · (T − h)`, the same EWMA shape as satisfaction.
- **Grace:** for the first 8 weeks after signing, happiness can only rise. You get time to add flights.
- With no requirement in force (all seasonal, out of season), happiness holds.

*Worked example.* Azure Horizon, delivering 1,200 of 1,500 (a = 0.8), so A = 0.8 and T = 53. Happiness
settles in the low 50s: "lukewarm". Deliver 1,500 and it climbs toward 80. Deliver nothing and it halves
about every 6.5 weeks.

### 5.3 Terms and renewal

- Every contract runs **2 years (104 weeks)**, and so does every renewal. The fee is charged in **two
  annual instalments**, one at signing and one at week 52. It shows as a "Partnerships" P&L line, and the
  finance forecast includes the upcoming instalment.
- The renewal window opens **8 weeks** before expiry. The price and targets depend on happiness **when you
  renew**:

| Happiness | Mood | Renewal price | Targets |
|---|---|---|---|
| ≥ 75 | Delighted | ×0.60 of list | unchanged |
| 55–75 | Content | ×0.85 | unchanged |
| 35–55 | Lukewarm | ×1.00 | unchanged |
| 15–35 | Frustrated | ×1.35 | +15% |
| < 15 | — | refuses to renew: the partner is **lost** (§5.4) | — |

- **Auto-renew** works like leases: an airline-wide default with a per-partner opt-out. It renews at
  expiry for another 2 years if the cash covers it **and happiness ≥ 35**. Below that it never
  auto-renews into Frustrated pricing; it asks instead.
- Tightened targets stay on the contract. Happiness carries over at renewal.
- Letting a contract expire costs nothing and has no reputation effect.

### 5.4 Exits

- **The partner walks out:** after h < 15 for **4 consecutive weeks** (grace weeks excluded). No refund of
  the current year. `reputationPenalty += 3 × prominence`, which decays through the existing ×0.92
  mechanism. A **world news item** is posted ("Azure Horizon Cruises ends its partnership with …").
- **Lost partners stay away for 5 years.** A walk-out, or a refusal to renew at h < 15, sets a
  **260-week cooldown** before that airline can sign that partner again. When the cooldown ends, the
  partner comes back at 40. Most worlds are shorter than 5 years, so in practice losing a partner is
  permanent for that world. The book card says so ("Won't work with you until 2031").
- **You break early:** pay 50% of the instalment still unpaid (if you break in year 1, that is the year-2
  instalment); `reputationPenalty += 1.5 × prominence`. *Interpretation to confirm:* breaking is your
  choice, not the partner leaving, so it does **not** trigger the 5-year cooldown. The partner only
  remembers: re-signing starts at 40.
- **Letting it expire** at h ≥ 15 without renewing is neutral: no cooldown, no reputation effect.

### 5.5 Reputation

There is a continuous **Partners** term in `calcReputation`, alongside `loyaltyBonus`:

`partners = clamp( Σ prominence · g(h), −8, +2 )`, where g(h) = +0.25 at h ≥ 75, 0 between 35 and 75,
and −(35 − h)/35 below 35.

A prominence-3 partner at h = 0 costs 3 reputation points for as long as you hold it, on top of the
walk-out spike. Reputation drives `brandReach` and price sensitivity on **every** route, so a sour partner
portfolio leaks into the whole network. The term is a pure function of state, so every screen that calls
`calcReputation` agrees with the tick. The Reputation page gets a "Partners" line.

---

## 6. State, actions, tick, server

**State** is spread conditionally, like `cateringContracts`. A world that never signs a partner is
byte-identical.
```
partnershipsWorld: true                      // injected from tickConfig, like productionLinesWorld
travelPartners: { [partnerId]: {
  partnerId, signedWeek, termWeeks /* 104 */, annualFee, instalmentsPaid,
  targets,            // per-requirement, after any renewal tightening
  happiness, lowWeeks, graceUntil, autoRenew,
  lastWeek: { A, T, actuals }               // for the UI
} }
travelPartnerMemory: { [partnerId]: { cooldownUntil /* lost: +260 wk */, rejoinHappiness } }
```

**Reducer actions:** `SIGN_TRAVEL_PARTNER {partnerId}`, `RENEW_TRAVEL_PARTNER {partnerId}`,
`BREAK_TRAVEL_PARTNER {partnerId}`, `SET_TRAVEL_PARTNER_AUTORENEW {partnerId | 'all', on}`. All of them
are refused without `partnershipsWorld`. A shared `canSignTravelPartner` (cash, rep gate, cooldown,
already signed) serves the reducer, the server guard and the button, so the UI never offers what the
reducer refuses.

**Tick order:**
1. Hydrate routes with `stateTravelPartnerFields`. Happiness is last week's, so the lift is known before
   the week.
2. Simulate. Routes touching a partner city also return `segmentPaxOneWay: { leisure, business }`,
   meaning the segment split after the capacity cap and upgrade spill. This is attached **only** to those
   routes, which keeps the golden master unmoved.
3. Compute requirement actuals from `routeResults`.
4. Update happiness, low-week counters, walk-outs, expiry and auto-renew, and charge instalments.
5. Add a `travelPartners` block to the weekly report (conditional).

**Server:**
- Add `partnerships: { type: 'boolean' }` to the world schema. The default is `!== false` for new worlds,
  with a checkbox on the admin and supporter world form.
- `worldConfig` serialisation; the `decisionGuard` allow-list plus a world-flag guard.
- `humanRivals.mjs` carries the two appeal fields on other players' offers.
- Shared book: no new tables, no cross-airline locking.

---

## 7. UI

- **Partnerships page.** Proposed as a tab next to Marketing, since this is a demand lever (open
  question 6).
  - **Book:** grouped by type. Each card shows coverage chips, season, lift, the 2-year fee, the gate
    state and any cooldown. It also shows each requirement with **your figure from last week**
    ("1,140 / 1,500 leisure pax into Caribbean ports") and a settle-point preview ("at today's network
    they'd settle around 53").
  - **Your partners:** a happiness gauge with the mood word and direction ("62 → heading to 80"),
    per-requirement bars, weeks to renewal, the renewal price at today's happiness, an auto-renew
    toggle, and a priced Break button with confirm.
- **Route detail:** "Travel partners: +7% leisure (Azure Horizon, in season)".
- **Reputation page:** a Partners line.
- **Toasts:** dropping below 35 (naming the miss: "delivering 900 of 1,500"), the 8-week renewal
  warning, auto-renewed, walked out.
- **Wiki entry**, including the shared-partner note from §4.
- *Phase 2:* Route Finder and Planner show which partner cities a candidate touches and what it adds
  toward a requirement ("+180 toward Azure Horizon").

---

## 8. Build phases

1. **Engine:** `data/travelPartners.js` (catalogue, coverage, seasons, requirements, attainment,
   happiness, renewal pricing, reputation term); demand.js fields; `stateTravelPartnerFields`; tick
   integration; reducer actions.
2. **Server:** the world flag and default, the guard, `humanRivals`, the world form.
3. **UI:** the page, the route-detail line, the reputation line, toasts, wiki.
4. **Calibration probe:** a `@not-a-test` tool that, for each partner, puts a reference airline exactly on
   target and reports the revenue the lift adds per year. **List fee ≈ 35–45% of that.** The table fees in §3
   get replaced with these. Then a Discord post.
5. **Later:** finder hints, Tailwinds port (as "new games").

## 9. Tests (per CLAUDE.md)

- Demand probes verified failing on HEAD: the monopoly pool multiplies only the matching segment; the
  contested log identity (an offer's softmax weight × appeal exactly); `_soloCeiling` includes it.
- Preview equals tick: `projectRouteAddition` and the SSR-rendered Route Planner quote the same passengers
  as `weeklyTick` for a route into a partner city. `humanRivals` offers carry the fields.
- Unit: attainment bands, the happiness EWMA and grace, the walk-out after 4 weeks, the renewal table,
  auto-renew refusing below 35, the reputation clamp.
- Requirement actuals from the tick match the `travelPartners` report block.
- World flag: an old world refuses `SIGN_TRAVEL_PARTNER`; a new world has it on by default.
- `node tools/golden-master/run.mjs` → **PARITY OK**, no re-baseline.

## 10. What NOT to do

- **No commission revenue.** Partners pay out in demand, not cash. Like loyalty, this must not become a
  money tap.
- **Not through `brandReach` or the quality score.** Those move both segments and the fare cliff.
- **No random partner events.** Happiness moves only on what the airline delivers. Anything that singles
  out one airline has to be earned, which is the same rule as the deleted per-airline service events.
- **No hand-built offers without the new fields.** That is the recurring preview bug.
- **No server contention state.** The book is shared.

## 11. Open questions for Dave

Answered 2026-10-29: the boost fades with happiness (yes); happy-partner reputation bonus up to +2
(yes); walk-outs on the world news feed (yes); 2-year contracts; lost partners stay away 5 years. All
are folded in above.

Still open. Each has a default the build will use unless you say otherwise:

1. **Breaking early and the 5-year rule.** *Default:* only a partner leaving you (walk-out or refusal to
   renew) triggers the 5-year cooldown. If you break early, re-signing just starts at 40.
2. **Connecting passengers** toward "delivered to". *Default:* nonstop/O&D only in v1.
3. **Placement.** *Default:* its own tab beside Marketing.
4. **Catalogue.** *Default:* the 16 partners in §3.
5. **Commitment tiers** (Silver or Gold). *Default:* v2.
6. **Tailwinds.** *Default:* port after Headwinds ships.

---

## 12. As built (Headwinds, 2026-10-29)

Built to this plan with the decisions in §0. Nothing committed: everything is on disk.

**Engine**
- `packages/engine/src/data/travelPartners.js` (new) is the whole model. It holds the catalogue, coverage
  and seasons, the shared book, requirements and attainment, happiness, rollover and settle, renewal
  pricing, the break cost and the reputation term.
- `models/demand.js`: `travelLeisureAppeal` and `travelBusinessAppeal` use the lounge identity. That means
  a log term in `computeUtility` (weight 1 on its own segment, 0 on the other), segment pools in
  `_monopolyResult`, and the same multipliers in `_soloCeiling`.
- `utils/simulation.js`:
  - `stateTravelPartnerFields` is the single resolver.
  - The tick runs rollover before simulating, charges instalments on the report
    (`totalTravelPartnerFees`, which is in `totalCost`), and settles after the week. The report carries
    `travelPartnersNext`, `MemoryNext`, `Scores`, `Events` and `RepHit`, but only for an airline that
    had partners.
  - In partnership worlds, route results carry `segmentPax`.
  - Tag routes resolve the lift per segment.
- `reducer.mjs` adds `SIGN_`, `RENEW_` and `BREAK_TRAVEL_PARTNER` and `SET_TRAVEL_PARTNER_AUTORENEW`. It
  also persists the settled contracts, adds walk-out hits to `reputationPenalty`, raises toasts, and
  carries the new keys through load.
- Partner offers are carried by `pairShare.js` (both previews), `encroachment.js`, `reputation.js`
  (Partners term, `rep.partners`) and `pnlBridge.js` (fees sit in the brand bucket).

**Server**
- The world flag: `tickConfig.partnerships` is ON unless the creator passes `false`, and is in the
  serialised world. Joining stamps `partnershipsWorld`, and the tick re-stamps it.
- The four actions are on the allow-list. The guard checks only that the partner id exists; every rule
  is the reducer's.
- `humanRivals` ships each rival's lift on its spec.
- Walk-outs and refusals are written as `travel_partner_lost` world news.

**UI**
- A new Company ▸ Partnerships page, hidden in worlds without the feature. It shows your partners
  (happiness bar with the target marker, the lift you get now, each requirement against its target, the
  renewal price at today's happiness, auto-renew, end early) and the book (your figures from last week,
  where the partner would settle, the gate and the cooldown).
- A Travel Partners line on Reputation, a partner row on Route Detail, a Wiki entry, a
  create-world checkbox and badge, and the news renderers.

**Calls made during the build**
- **Business travellers in economy count as business.** With no business cabin, or a full one, the
  demand model folds business travellers into the economy pool. `segmentSplit` credits that share
  back to business. Otherwise a hotel's "business passengers" target would quietly require a business
  cabin. (Tag routes still count J-seated passengers only.)
- **Fees came out far lower than the placeholders**, except ride share. The rule is about 40% of the
  yearly revenue the lift adds for an airline exactly on target, from engine fares × target arrivals
  × season weeks × 70% of flights with spare seats, floored at $250K. Ride share comes out dearest
  because its 3% covers every business traveller in a whole region.
- **Open design question:** value grows with how much you fly into a partner's airports, but the fee is
  flat. A big airline gets far more from the same contract than a small one. The obvious next step, if
  you want it, is a fee that scales with your volume at the partner's airports.
- A shared partner cancels out between two carriers on a contested pair; the Wiki and the book both
  say so.

**Tests**
- New suites, all green: `travel-partner-demand-test` (8; 6 fail on HEAD), `travel-partners-test` (38),
  `travel-partners-server-test` (9) and `travel-partners-ui-test` (11, SSR of the real Partnerships,
  Reputation and Route Detail).
- A throwaway HEAD probe showed the tick ignoring a partner: HEAD 248 passengers either way, working tree
  260.
- Golden master is PARITY OK, with no re-baseline.
- The full suite's only failures are outside this work: EPERM static-site tests, and map view, Dashboard
  alert and rival-state-writer suites in files another session is editing.

**Committing:** another session is working in the same tree. `src/App.jsx`, `tickService.mjs` and
`humanRivals.mjs` contain both its changes and these, so either commit them together or use `git add -p`.
Every other file listed above is partnerships-only.

**Not done:** the Tailwinds port; the Route Finder hint ("+180 toward Azure Horizon", phase 2); Silver
and Gold tiers; a Discord post. The map-view rework in progress elsewhere has its own page groups.
Partnerships is reachable through Company, but check it sits where you want once that rework lands.
