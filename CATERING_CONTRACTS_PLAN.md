# Catering Contracts — Design Plan

**Status:** PROPOSED — 2026-09-20. Nothing built.
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

## 4. Open questions for Dave

1. **Per airport or per contract?** Above assumes one contract covers a *set* of airports by coverage
   region. The alternative — one contract per airport — is more granular but becomes admin at 40
   stations. Recommend coverage-region.
2. **Does a hub flight kitchen still apply?** Today a T1+ hub discounts catering cost. Best-of with the
   contract (like the station/hub rule), or should owning a hub kitchen mean you *are* your own
   supplier at that airport and no contract applies there?
3. **Can a bad contract cap a route's chosen level?** The `qualityCap` field assumes yes — picking
   "full" on a route whose caterer tops out at "partial" should deliver partial and, ideally, *say so*
   on the route screen rather than silently underdelivering.
4. **Should suppliers refuse you?** A minimum volume or a credit-rating gate would make the premium
   book something you grow into. `credit.js` already publishes a grade.
5. **World-shared or per-airline?** In Headwinds, is the offer book the same for everyone (a market)
   or rolled per airline? Shared is more interesting and matches the gate market, but needs the offers
   to live in world state rather than the airline blob.
6. **Freighters** — cargo has no catering. Confirm contracts ignore cargo entirely.

## 5. What NOT to do

- Do not make this a second ground station. No capex, no construction weeks, no capacity ceiling — the
  whole point is that this is a *commitment* mechanic, not a *building* one. If it grows a build timer
  it has become the wrong feature.
- Do not let it silently change existing worlds' route economics. Uncovered = today's numbers, and the
  first contract is opt-in.
- Do not use real supplier names.
