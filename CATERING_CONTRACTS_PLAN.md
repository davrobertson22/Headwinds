# Catering Contracts — Design Plan

**Status:** BUILT in Headwinds 2026-09-21 — engine, UI, MP guards and tests (23 engine + 8 UI),
both golden masters PARITY OK with no re-baseline. Tailwinds port pending (see §6).
**Scope:** Tailwinds **and** Headwinds. Engine work shared; Headwinds adds a guard and an allow-list entry.
**Origin:** Dave, 2026-09-20 — "give people a list of catering contracts they can choose from, some
higher quality and some cheaper, different geography coverage, and choose a contract length with
penalties for leaving."

---

## 1. What exists today

`data/catering.js` is a **service-level** model, not a supplier model. Per route you pick one of five
levels (`none` / `paid` / `partial` / `hybrid` / `full`); each has a cost per passenger by cabin and a
quality bonus amplified by distance (`cateringQualityAmplifier`), and the paid levels sell ancillary
catering revenue back. `weeklyCateringCost` in `overhead.js` prices it per boarded passenger, and a
hub's `stationDiscount` shaves the cost at both endpoints (own flight kitchens).

So today the player answers *"how good is the meal on this route?"* and never *"who makes it, what did
you agree to pay, and for how long?"* — which is the actual commercial decision an airline makes, and
it is made **per airport, for years at a time**, not per route per week.

The ground handling station (`GROUND_HANDLING_PLAN.md`, built 2026-09-20) has just made the same move
for handling: a per-head contract became a capital-and-commitment decision with a spatial footprint.
Catering is the natural sibling, but it should **not** be a second copy of it — a station is a thing you
*build*, a catering contract is a thing you *sign*, and the interesting mechanics are different.

## 2. The idea

A **catering contract** is an agreement with a named supplier covering a **set of airports**, at a
**rate** and a **quality**, for a **term**, with an **exit penalty**. The route-level service level
stays exactly as it is — it remains the "how good is the meal" dial. The contract decides what that
level *costs you* and caps how good it can actually be at each airport.

The shape of the decision the player faces:

- A **cheap regional supplier** covering one country at 0.75× cost but capping quality — on a premium
  long-haul out of that country you are paying for a "full" service the caterer cannot deliver.
- A **global premium supplier** at 1.30× cost with a quality uplift, worth it only if you actually fly
  premium cabins over long sectors.
- **Term length** is the real tension: a 5-year deal is cheaper per meal than a 1-year deal, but the
  network you sign it for is not the network you will have in three years, and leaving early costs you.

That is a genuinely different decision from every other system in the game: the others ask "can I
afford this?", this one asks "how confident am I about where I'll be flying in four years?" — and it
is the first mechanic that punishes over-confidence about your own growth.

## 3. Proposed model

### 3.1 The offer book

A world-generated list of suppliers (say 8–12), refreshed periodically, each with:

| Field | Meaning |
|---|---|
| `id`, `name` | e.g. "Gate Gourmet", invented names to avoid real brands |
| `coverage` | a region / country list / `global` — which airports it can serve |
| `costFactor` | multiplier on the route catering cost at covered airports (0.70–1.35) |
| `qualityCap` | the best effective service level it can actually deliver (e.g. `partial`) |
| `qualityBonus` | ± on the catering quality term for covered endpoints |
| `terms` | the lengths offered (1 / 3 / 5 years) and the `costFactor` discount for each |
| `minVolume` | optional: pax/week below which a surcharge applies (small carriers pay more) |

Signing writes `state.cateringContracts: { [contractId]: { supplierId, termWeeks, signedWeek, airports } }`.

### 3.2 How it reaches the tick

Mirror the ground-station resolution exactly — it is the pattern that now has a test guarding it:

- One helper `cateringFactorsAt(contracts, hubs, codes, absWeek)` → `{ costFactor, qualityDelta, cap }`
  per route, taking the **best available** contract at each endpoint and averaging over endpoints.
- Attached to the route by `weeklyTick` as `cateringContractFactors`, spread **conditionally** so an
  airline with no contract is byte-identical (golden master — see the ground-station plan's §3 note;
  this is now a hard rule, not a preference).
- A shared `stateCateringFields(state, o, d)` for previews, and a call-site guard test like
  `ground-station-ui-test.mjs`'s so no screen forecasts a route at the wrong catering cost.
- **Uncovered airports fall back to today's rates**, so the model degrades to the current game exactly.

### 3.3 Term and exit

- `signedWeek + termWeeks` is the expiry. Expiry should **warn** well ahead (news item / toast) and
  then revert to spot rates, which are worse than any contract — so letting one lapse is a mistake you
  can see coming.
- **Exit penalty**: remaining weeks × weekly spend under the contract × a `breakFraction` (say 0.35),
  charged as a one-off. Cheap to leave a deal that is nearly over, brutal to leave a fresh 5-year one.
- Renewal at expiry should be offered at the *then-current* book, which is how a supplier market
  actually punishes a carrier that has become dependent.

## 4. Decisions (locked with Dave, 2026-09-21)

| Question | Decision |
|---|---|
| Contract ↔ airports | **Coverage region.** One contract covers every airport in the supplier's region (country, continent, or global). A handful of contracts, not one per station. |
| Hub flight kitchen | **Best-of with the contract**, never stacked — per airport you pay the cheaper of the hub kitchen rate and the contract rate. Same rule as ground stations. |
| Quality cap | **Cap it, and say so.** A route delivers the lower of its chosen level and the caterer's `qualityCap`, and the route screen warns when the cap bites. You pay for what is delivered. |
| Headwinds market | **Shared book, no contention.** Every airline in a world sees the same suppliers at the same prices, refreshed on a world schedule; signing does not take a supplier from anyone. No cross-airline money moves. Tailwinds rolls the same book per save. |
| Gating | **Volume surcharge only.** Nobody is refused. Below a supplier's `minVolume` (weekly pax in its region) the rate carries a surcharge, so small carriers pay more rather than being locked out. No credit-grade gate. |
| Early exit | **35% of remaining spend.** One-off penalty = weeks left × current weekly spend under the contract × 0.35. Terms of 1 / 3 / 5 years, longer terms cheaper. |

Defaulted without asking (flag if wrong): **cargo is ignored entirely** — freighters carry no catering, so contracts neither cover nor bill cargo routes.

## 5. What NOT to do

- Do not make this a second ground station. No capex, no construction weeks, no capacity ceiling — the
  whole point is that this is a *commitment* mechanic, not a *building* one. If it grows a build timer
  it has become the wrong feature.
- Do not let it silently change existing worlds' route economics. Uncovered = today's numbers, and the
  first contract is opt-in.
- Do not use real supplier names.

## 6. As built (2026-09-21)

- `data/cateringContracts.js` — 14 invented suppliers (3 global, 7 continental on airports.js `getRegion`,
  4 single-country budget). Book rate drifts ±8% per 26-week window, hashed from supplier + window, so the
  book is the same for every airline in a world with no server state. Terms 1/3/5y at ×1.00/0.94/0.88,
  locked at signing. Volume = weekly seats departing covered airports (knowable before the tick, so previews
  and the tick agree); surcharge up to +20% below `minVolume`. Break = weeks left × last week's spend × 0.35.
- **Resolution happens once, at route hydration in `weeklyTick`.** The simulated copy gets
  `cateringCostFactor` (per endpoint best-of hub kitchen vs contract, averaged), `cateringQualityDelta`,
  `cateringCooks` and — when the cap bites — the delivered `cateringLevel` (with `cateringLevelChosen`).
  Every downstream reader (cost, route quality, pooled-pair quality, delivered experience) therefore sees
  the delivered level with no further wiring. State keeps the player's choice.
- **Interpretation to confirm:** "best-of with the hub kitchen" is implemented as *whoever is cheaper at
  that endpoint cooks*, and the cap and quality delta travel with the cook. So a premium caterer adds
  nothing at a hub whose own kitchen is cheaper. The alternative (pay the cheaper rate but keep the
  premium quality) would make premium contracts free at hubs.
- `stateCateringFields(state, route)` / `stateCateringCapReport(...)` for previews and the picker warning;
  spread into every component `simulateRoute` call site and `projectRouteAddition`. UI suite guards both
  the preview call sites and that every route-level `<CateringSelector>` gets `capNote`.
- Everything conditional (freshState, write-back, load, report `cateringContractSpend`) for golden parity;
  when the last contract expires the key is cleared explicitly rather than left to `...state`.
- Operations page: "Catering Contracts" card under Default Catering. Toasts 8 weeks before and at expiry.
- Verified failing on HEAD via a probe against `git archive HEAD` — $122,779 catering and Full Service
  with or without a contract; $44,243 and Partial on the working tree.
