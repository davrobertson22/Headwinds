# Game audit fixes, as built (2026-11-06)

What was built from `docs/game-audit-2026-11-06.md`, in Headwinds only. Away-from-game notifications and player mergers were left out, as asked. Nothing is committed yet.

**New worlds only.** Every balance rule rides **demand model v4**, which is now the default for new worlds. The create form sends 4, and `DEMAND_MODEL_LATEST` is 4. v4 uses v3's demand tables, seasons and airport-market table unchanged. Every `>= 3` test in the engine treats v4 as v3. Older worlds are untouched: the golden master still prints `PARITY OK`. The beta-world master was re-baselined for one stated, all-worlds catalogue change (see R3).

## What was built

| Item | What it does | Where |
|---|---|---|
| **R1 Frequency sells seats** | On a route you fly alone, demand is scaled by a schedule-convenience factor, normalised so daily service = 1.0. For a 500 km business market: 1/wk 0.69, 4/wk 0.87, 14/wk 1.19, capped at 1.25. Leisure is flatter, and long haul saturates at about daily. On shared routes the pool uses the combined timetable. The frequency utility weight rises (business 0.9 → 1.4, leisure 0.4 → 0.7), so 3× a rival's frequency takes about 80% of business travellers instead of 71%. The connection model's synthetic "outside option" keeps its v3 calibration for a daily connection. | `utils/market.js` `scheduleConvenience`; `models/demand.js` (monopoly, solo ceiling, contested pool, `computeUtility`) |
| **R2 Earned pricing headroom** | The fare-cliff threshold rises with headroom earned on the pair. A protected market (nobody flies it and no rival flies to both airports) adds +0.10. Your hub at either end adds +0.02 to +0.08 by tier. The total is capped at 0.18. Past the threshold the fall-off is softer (steepness 15 → 8). A rival's offer carries only its hub term. The fare-cliff warnings use the same helper. | `models/pricingPower.js` (new); `nwrYieldChokeFactor`; `priceChokeFactor`; spread via `statePricingFields` in weeklyTick, pairShare, Route Detail, rival specs and encroachment; `models/fareCliff.js` |
| **R3 Code-F stands** | The A380 and 747-8I can only use 77 code-F gateway airports. Route opening, reassigning, the route planner and the tag-route planner all respect this. Freighters are not affected. | `data/airportRestrictions.js` `CODE_F_AIRPORTS`, `standShortfall` |
| **R3 Catalogue (all worlds)** | The 787 and A350 families cruise at 900 km/h (Mach 0.85). New fuel burn: 787-9 690 (was 717.5), 787-10 725, A350-900 740, A350-1000 825, 900ULR 770, 1000ULR 860. The 787-9 now peaks at 95.6% of the winner (was 84%) and the A350-900 at 90% (was 76%). The beta-world golden master was re-baselined for this change. | `data/aircraft.js` |
| **R4 Gate rent** | Rent is flat by airport tier, with a big-tenant discount (gates 11–25 at 90%, gate 26 onward at 80%). It replaces the curve that made each extra gate dearer. | `data/airports.js` (`setGateRentV4`, set by `setDemandModel`) |
| **R5 Business cycle** | One AR(2) cycle per world: about 4 game years peak to peak, a typical swing of ±3–5%, clamped to −15%/+12%. It scales all demand and new-lease rates (1 + 0.6x). Multiplayer replays it from the world seed; a late joiner is backfilled onto it. Demand events come half as often and hit 1.5× as hard. A Dashboard card shows the phase, momentum, demand and lease rates. | `models/economyCycle.js` (new); `worldEconomy.mjs` `worldEconomyCycle`; reducer `economyCycle`; `EconomyIndicator.jsx` (new) |
| **R6 Earned meltdowns** | Weekly risk rises when the fleet is flown past 85% of its hours (amplified by having no spares) or the lowest of pilot, ground and cabin morale is under 55. Risk is zero otherwise, and no random number is drawn. Airlines under 5 aircraft are exempt. A meltdown costs −6 satisfaction and a 3-point reputation hit, sends a toast, and posts an `operational_meltdown` news row naming the airline. No cash line, so the P&L still reconciles. | `models/incidents.js` (new); reducer; `newsService.mjs` `incidentNewsRows`; News.jsx and Feed.jsx renderers |
| **F2 Live races** | Side races shown above the standings: best newcomer (scored per week flown), regional champions (regions with 2+ airlines) and busiest this week. Built from public rows only. | `utils/standings.js` `liveRaces`; `StandingsTable.jsx` |
| **F2 Board mandates** | One mandate per quarter from Q2, picked from where the airline stands and never already met. Six kinds: passengers, margin, load factor, satisfaction, new country, new routes. A flat $1.5M bonus, era-scaled. The pick is deterministic (a hash, no random draw). The card stays on the Dashboard after the starter board retires. | `models/boardMandates.js` (new); reducer; `BoardObjectives.jsx` |
| **F5 Rule presets** | The create form gets a preset picker: Standard (the form's defaults), Hardcore, Sandbox and Classic. Touching any switch changes it to "Custom". | `apps/headwinds-web/src/App.jsx` `WORLD_RULE_PRESETS` |
| **Small fixes** | Wiki now says $10M, notes production-line delivery dates, and has a new **Newer World Rules** section. Stale plan headers corrected (news feed, profiles, used market). The `.fuse_hidden` file moved to `_to_delete/`. The world tag reads "frequency sells seats". The alert-prefs categories cover the new toasts. | — |

## Tests

These new suites were each checked failing on HEAD. Where the new API doesn't exist on HEAD, a throwaway probe of the old call path proved it instead (`tools/_probe/audit-*-head-probe.mjs`):

- `schedule-demand-test`: 9 checks, including that the forecast, the Route Planner and the fare-cliff warning agree with the tick
- `code-f-stands-test`: 7
- `gate-rent-v4-test`: 3
- `economy-cycle-test`: 7, including a Dashboard SSR render
- `incidents-test`: 6
- `live-races-test`: 4, including a StandingsTable SSR render
- `board-mandates-test`: 6, including a Dashboard SSR render
- `world-presets-test`: 3

`demand-model-v2/v3` tests were updated for the new default, and `catalogue-deadweight-report` now sweeps v4 rules (pass `--v3` for the old ones).

Full suite: every remaining failure was already failing before this work started: `adsense-readiness`, `era-pricing`, `market-filters`, `rival-state-app-writer`, `worlds-pages`. Golden master: PARITY OK.

## What changed from the audit's claims

The deadweight report gives each type one airframe per mission. At 40–60k passengers a week the biggest cabin wins by construction. With code-F applied, the A380 now only wins between gateways. LAX–SFO and JFK–BOS are both code-F airports, so it still wins there in that framing. On the live network, R1's S-curve is what punishes a 4-a-week A380 against a rival flying 21 a week.

On a naive 22-tail hub network flying twice daily, v4 carries about 9% more passengers than v3: frequency stimulates demand. Airlines flying less than daily lose some. This is intended.

## Removed

- **Late-joiner capital** (F2) was built, then taken out the same day at Dave's request. Late joiners start on the world's normal capital, as before.

## Not built yet

- **F3 subsidy tenders and charters.** This needs an exclusive claim across airlines: a world-locked first-come claim, or a sealed bid resolved by the tick like gate auctions. It also needs a P&L subsidy line, obligations, a page and news. It's a design-doc-first item.
- **F5 progressive disclosure and an advisor line.** UI work across many pages.
- **Rival one-stop connections** keep pricing headroom at 0, the same in the tick and in previews.
- **Tailwinds port.** Its folder isn't connected in this session. To port: v4 in `market.js` and `demand.js`; the new models (`pricingPower`, `economyCycle`, `incidents`, `boardMandates`); the airport and aircraft changes; the reducer hooks.
