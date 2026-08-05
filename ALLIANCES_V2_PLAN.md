# Alliances 2.0 — Design & Implementation Plan

**Status:** PROPOSED 2026-08-04 (nothing built yet).
**Scope:** Headwinds multiplayer only. Solo Tailwinds keeps its AI-bloc alliances untouched —
every engine change below is gated on server-injected state that solo saves never have
(the same trick as `state.allianceDef`).
**Goal:** turn player alliances from a passive stat buff into the social core of the game —
things members *do together*, reasons to pick *these* partners, and verbs for the founder.

---

## 1. Where alliances stand today (honest inventory)

What a player alliance currently gives you (`humanRivals.playerAllianceDef`):

| Benefit | Value | How it lands |
|---|---|---|
| Demand boost | +6% `demandBoostPct` | Brand-reach lift on routes where a partner **also competes** (post brand-reach fix: pool multiplier / `log(brandReach)` utility term) |
| Quality bonus | +4 flat | All routes |
| Partner feed | `PRORATE_FLOOR.alliance = 0.42`, `CONNECTION_PENALTY.alliance = 0.50` | Real O&D itineraries over shared hubs via `network.js` — this part already scales with network complementarity |
| Chat | ALLIANCE message board | `messages.mjs`, per-airline read cursor |
| Weekly fee | $60k (`PLAYER_ALLIANCE_WEEKLY_FEE`) | Overhead |
| Gate cap | **80% combined** (`GATE_ALLIANCE_CAP`) | The only *active* alliance mechanic — and it's a penalty |

Governance: anyone founds, founder accepts/rejects joins, max 8 members
(`PLAYER_ALLIANCE_MAX_MEMBERS`), founder who leaves hands off to the longest-tenured member.
No kick, no officers, no settings, no identity (every alliance is the same 🤝 teal).

The critique, in one line: **membership is a checkbox**. Benefits are identical regardless of
who your partners are (except the partner feed, which is invisible enough that nobody plans
around it), there is nothing to do together after joining, and in gate-scarcity worlds the
only thing the alliance *actively* does is stop you leasing gates.

Latent machinery worth knowing about before designing anything new:

- `network.js` already models **joint ventures** (`jointVenture` partnership type:
  prorate floor 0.50 vs alliance 0.42, connection penalty 0.38 vs 0.50) and
  `buildPartnershipMap` accepts a `jvRoutes` map — **but nothing in the reducer or server
  ever sets it**. A finished feature with no on-switch.
- The gate ledger (`gateService.mjs`) already does atomic player-to-player transfers
  (marketplace), per-airline personalized views incl. `allianceTaken`, and post-tick
  forfeiture reconciliation. Sharing is mostly bookkeeping on top.
- The news feed already emits `alliance_founded` / `alliance_joined` / `alliance_left`.

---

## 2. Design goals

1. **Partner choice matters.** Who is in your alliance should change what the alliance is
   worth — networks, hubs, gate holdings, tiers.
2. **Verbs, not auras.** Members should make decisions *at* each other: lend, borrow,
   coordinate, contribute, vote.
3. **The cap becomes the price of power, not a pure tax.** Alliances accept the 80% gate cap;
   in exchange they get to use each other's gates.
4. **No new win-more spiral.** Every benefit is bounded (caps, fees, consent, tenure gates)
   so a maxed 8-member alliance is strong but not inevitable. Keep the passive numbers
   modest; put the upside in things that take coordination effort.
5. **Solo untouched, worlds opt in cleanly.** Gate sharing only exists in
   `gateScarcity` worlds (nothing to share otherwise); everything else works in all HW worlds.

---

## 3. Phase 1 — Alliance slot pool (the headline)

**Slot-level sharing, not whole-gate subleases** (Dave, 2026-08-04: "you can use slots they
have in excess so that you don't need to lease a whole gate"). Spare capacity becomes
ambient alliance infrastructure you draw on at route-add time — no offers, no acceptance
flow, no bilateral deals.

### 3.1 The mechanic

Every gate provides `SLOTS_PER_GATE = 50` weekly departure slots. A member's **spare
slots** at an airport = `heldGates × 50 − own usage` (pax + cargo frequency, peak-week for
seasonal routes — same accounting the congestion readout uses). Shared spare slots form
the **alliance slot pool** at that airport.

- **Owner opts in per airport** (Dave's call): nothing is shared by default. In the
  Airports gate panel the owner flips "Share spare slots" per airport, optionally holding
  back a reserve for their own growth ("share all spares" / "keep N back"). Everything
  else is automatic once the switch is on.
- **Drawing from the pool:** when a member adds a route or raises frequency past their own
  capacity, the reducer's slot check passes if `ownSlots + poolAvailable` covers it; the
  overflow is drawn from the pool with no further interaction. The route form shows both
  numbers ("Your slots: 12 free · Alliance pool: 41 free") so borrowing is always visible,
  never surprising.
- **Eligibility to borrow** (Dave, 2026-08-04: "if I want to launch a route somewhere and
  don't have a gate, I could borrow slots from an alliance partner"): **no own gate
  required** — a pool grant opens the airport, so a member can launch a route somewhere
  entirely on a partner's spare slots. Ceiling: a gateless member may borrow up to **one
  gate's worth** (`SLOTS_PER_GATE`) at that airport; holding your own gates raises the
  ceiling to your own slot capacity there (tunable constants). A **rule-5 lockout still
  bars borrowing** at that airport — the pool is not a lockout escape hatch.
- **Money — fee share + 25% markup** (Dave's call): each borrowed slot costs the borrower
  `weeklyGateFee(airport) / 50 × 1.25`, congestion surcharge included (the airport doesn't
  care whose plane it is). The fee share relieves the owner's rent pro-rata; the 25%
  markup is the owner's profit. Spare gates in an alliance thus flip from cap-hostile
  dead weight to passive income. Borrowed slots are **attributed to specific owners,
  most-spare-first** (deterministic order: spare desc, then airlineId), so Finance shows
  concrete per-partner income/expense lines, not a blur.
- **Owner priority is absolute — 4-week squeeze** (Dave's call): they're still the owner's
  gates. The owner's own decisions never check the pool; if the owner (or a reserve
  increase, or the share toggle going off, or membership ending) shrinks the pool below
  what's borrowed, affected borrowers get a **4-week countdown warning** on the dependent
  routes, then the engine trims frequency to fit via the **existing forfeiture
  reconciliation path** — same machinery as rule-5 gate loss, no new failure mode.
  Leaving the alliance, being removed, or disbanding triggers the same 4-week wind-down on
  every draw in both directions.
- **Rule 5 (use-it-or-lose-it):** slots partners are using count as **the owner's usage** —
  a gate that is feeding the pool cannot be forfeited. Sharing protects gates you can't
  fill yet, which is exactly the incentive we want.
- **Caps:** pool draws move **usage, not holdings** — the 60% airline / 80% alliance caps
  keep binding on holdings exactly as today, so sharing cannot mint a monopoly the caps
  were built to prevent. (The alliance-formation cap check in `alliances.mjs`
  `refuseIfOverGateCap` is unchanged and still gates joins.)
- **Guaranteed hub gates** (`GATE_HUB_GUARANTEE = 5`): their slots are **never pooled**
  (the guarantee is personal). Anti-flip (`GATE_ANTI_FLIP_WEEKS = 12`) does **not** block
  pooling — no ownership moves, so there's nothing to flip; the anti-flip rule stays a
  marketplace/auction concern.

### 3.2 Why this design

The 80% alliance cap already treats the alliance as one economic entity when it *restricts*
them; the pool extends the same logic to the upside. Because holdings never move, every
existing cap, auction, and marketplace rule is undisturbed — the pool layer is pure usage
accounting plus money. And because drawing is frictionless (opt-in is the owner's decision,
made once per airport), the feature gets used constantly instead of sitting behind a
negotiation nobody initiates. What it deliberately trades away: haggling drama — pricing is
formulaic. Alliance chat still matters for "can you open up some slots at LHR?", which is
the right level of coordination to ask of players.

### 3.3 Contention & authority

Two members can race for the last pool slots in the same real-time window. Same class of
problem the gate ledger already solves: pool draws are arbitrated at **decision time**
against the `WorldGate` row's version (compare-and-set — the row is already the per-airport
arbiter), and the tick recomputes attributions from the blobs as the source of truth.
A draw that loses the CAS gets the standard tagged-409 retry treatment from
`decisionPolicy.js`. Weekly money is computed in the tick from the recomputed attribution,
never from the decision-time estimate.

### 3.4 Implementation map

| Layer | Change |
|---|---|
| Prisma | New `GateSlotShare` (worldId, airlineId, airportCode, sharing bool, reservedSlots int, updatedAt; unique (airlineId, airportCode)) — the owner's per-airport switch. **No per-draw table**: borrowed usage is derived from route blobs + share settings each tick (attribution is deterministic), so there's nothing to desync. Countdown state for squeezes lives on the airline blob (like forfeiture warnings). |
| gateService | Pool math in `buildGateMarketViews` (per airport: own / spare / shared / pool available / your draws with owner attribution); decision-time CAS check for draws; post-tick sweep next to `reconcileForfeitures`: recompute attributions, detect shrinkage, start/advance 4-week countdowns, trim at zero; rule-5 usage attribution ("pooled = used by owner"). |
| Server routes | `PUT /worlds/:id/gates/:code/share` (sharing, reservedSlots — owner only); pool state folded into the existing gates + alliance detail endpoints. Toggle-off starts wind-downs, never insta-kills. |
| Tick injection | Alongside `allianceDef`: `state.allianceSlotPool = { [code]: { available, myDraws: [{ownerAirlineId, slots, weeklyCost}], myShared, myEarnings } }` injected per airline on every read/tick. |
| Engine | Slot checks become `ownCapacity + pool.available` when `state.allianceSlotPool` is present (solo saves never have it — untouched); pool income/expense as overhead + pnlBridge line items; countdown warnings surfaced like forfeiture warnings. |
| UI | Airports.jsx gate panel: "Share spare slots" toggle + reserve input, own/shared/borrowed readout; route form + frequency stepper show "Your slots · Alliance pool"; Alliances.jsx "Gates" tab: pool overview per airport, who's drawing on whom, income/expense; Finance lines per partner; squeeze countdown toasts. |
| News | `slot_pool_opened` / `slot_squeeze` events (players category). |

---

## 4. Phase 2 — Network cooperation: alliance JV corridors

Light up the dormant `jointVenture` machinery as the alliance's earned, targeted upgrade.

- Any two ACTIVE members can propose a **JV corridor**: one city pair (or one shared hub —
  see open questions) where their cooperation upgrades from `alliance` to `jointVenture`
  in `buildPartnershipMap` — prorate 0.42 → 0.50 and connection penalty 0.50 → 0.38 on
  itineraries connecting over that corridor, *for both sides symmetrically*.
- **Consent + tenure:** both airlines confirm; both must have been ACTIVE members ≥ 12
  weeks (stops join-JV-leave tourism). JVs auto-dissolve if either side leaves the
  alliance.
- **Limits:** max **2 JV corridors per member pair**, max **6 per alliance** (tunable
  constants). Scarcity is what makes choosing them a decision.
- **Cost:** a one-time signing cost each (say $250k) + small weekly admin fee, so a JV is
  an investment in a corridor you both actually feed.
- **Relationship health already exists** in network.js (JV partners' health decays when you
  launch directs that undercut the JV's connecting traffic) — we inherit that drama for
  free: launching a nonstop over your partner's JV feed strains the JV.

Also in this phase, one **rebalance** to the passive aura: cut the flat contested-route
`demandBoostPct` from 0.06 to **0.04**, and let the JV/feed side carry more of the
alliance's value. Rationale: the flat boost pays most when partners *overlap*, which is
backwards; the post-fix brand-reach channel makes it honest but it's still a passive aura.
(Golden re-baseline needed; the brand-demand and route-map-consistency test chains must
stay green.)

Implementation: new `AllianceJv` table (allianceId, aId, bId, corridorKey, since); reducer
stays untouched — the server injects `state.jvRoutes = { [partnerAirlineId]: true }` scoped
per corridor via the same personalization path as `allianceDef`, and `buildPartnershipMap`
takes it from there (already coded). UI: propose/confirm in Alliances.jsx, corridor badges
on RouteDetail/RouteMap.

### Alliance hub designation (Dave, 2026-08-04)

The alliance names **one airport as its official hub**. While **≥ 3 ACTIVE members hold
gates there**, connections between members over that airport get a connectivity bonus —
mechanically, the designated airport counts as a partner hub for every member in the O&D
model (the `partnerHubCodes` machinery already grants +20% per partner hubbing at an
airport; designation extends that to all members at the alliance hub, capped so it doesn't
stack absurdly with actual member home hubs there). Gives the alliance a physical home, a
reason to co-locate gates (which also feeds the slot pool and the shared-lounge perk), and
an obvious target for rivals to contest.

- Designation is a founder action (or officer, once roles exist); changeable at most
  **once per game year** — picking the hub is a commitment, not a dial.
- If ACTIVE members holding gates there drops below 3, the designation **lapses after a
  4-week grace** (same countdown pattern as the slot-pool squeeze) and the yearly change
  budget is not refunded.
- Shows on the map and the alliance page; `alliance_hub_designated` / `_lapsed` news
  events.

---

## 5. Phase 3 — Treasury & perks

Gives the founder something to govern and dues somewhere visible to go.

- **Treasury:** the $60k weekly fee (founder-tunable: $30k–$120k) pays into an alliance
  treasury instead of vanishing. Balance visible to all members; only unlocks below can
  spend it (no cash-outs — the treasury is not a bank and cannot fund bailouts, which
  keeps it out of exploit territory).
- **Perks** (founder proposes, members majority-vote, treasury pays a one-time unlock +
  weekly upkeep; one active perk per ~3 members, so a full alliance runs 2–3):
  - **Shared lounges** — +2 quality on routes touching airports where ≥2 members hold
    gates. Rewards physical co-location, stacks meaning onto gate geography.
  - **Joint maintenance pool** — −8% maintenance cost for members at airports where any
    member has an MRO base (ties into MRO_JET_BASES). Makes one member's MRO investment an
    alliance asset.
  - **Joint marketing campaign** — 8-week +brand-awareness pulse for all members
    (reuses the ad-campaign machinery; respects the brand-reach capacity cap — it moves
    passengers only where seats exist, per the 2026-07-31 fix).
- Perks are deliberately **small numbers on top of coordination requirements** — the value
  comes from planning gates/MRO/hubs together, not from the buff itself.

Implementation: `treasuryBalance` on Alliance, `AlliancePerk` table + vote rows,
weekly fee redirect in overhead injection, perk effects injected like `allianceDef`
fields. UI: Treasury tab with vote cards.

---

## 6. Phase 4 — Governance & identity

Cheap, high-feel. Mostly server + UI, no engine.

- **Roles:** add `OFFICER` (founder appoints; officers can accept joins and propose
  perks/JVs). Founder can **remove a member** (with the same gate-cap re-check and
  sublease/JV wind-downs as voluntary leave).
- **Charter:** founder sets join mode — `OPEN` (instant join), `APPLY` (today's flow),
  `INVITE_ONLY`; plus dues level and a 200-char description.
- **Identity:** founder picks color + icon from a palette (replaces the hardcoded teal 🤝);
  shows on Competition, RouteMap, gate views, news items.
- **Alliance network map** (Dave, 2026-08-04): the alliance page renders the combined
  route network of all ACTIVE members — one color per member, designated hub starred,
  freight dashed. Nearly free: `mapCore.js` is already extracted and shared, RouteMap
  already draws partner networks, and the RivalRouteMap redraw-signature rules apply
  verbatim (key the signature on everything the tooltip asserts; `fitBounds` off the
  airport set only).
- **Recruiting board** (Dave, 2026-08-04): the charter gains a `recruiting` flag + a short
  requirements blurb; unaffiliated airlines can flag themselves "looking for an
  alliance." Recruiting alliances are surfaced on the Alliances tab, and join requests
  already carry the applicant's name/hub/marketCap (the `describe()` projection) — add
  routes + quality so founders decide on substance. Matchmaking is half of getting
  alliances adopted in a live world.
- **Rivalry declarations** (Dave, 2026-08-04): a founder declares a rivalry with another
  alliance — **unilateral, no acceptance needed** (being declared on is content), max one
  active per alliance, 12-week minimum before it can be dropped (no spam-cycling).
  **Strictly stat-only, forever:** it switches on tracking the tick already computes —
  head-to-head share on contested routes between the two rosters, standings gap,
  overtake events — rendered as a rivalry card on BOTH alliance pages, plus
  `rivalry_declared` / `rivalry_overtake` news. Zero gameplay effects, same guard rail as
  the standings table.
- **Alliance standings — financial rankings** (Dave, 2026-08-04: "ranking alliances based
  on total profit, revenue, market cap etc" — a scoreboard of real results, not a
  synthetic score; consistent with the game's open-book economy and the existing airline
  standings). A sortable table, one row per alliance, refreshed weekly at the tick:

  | Column | Source |
  |---|---|
  | Combined market cap | `Airline.marketCap` sum over ACTIVE members |
  | Weekly revenue / weekly profit | Members' `lastReport` P&L, summed |
  | Pax + cargo carried (wk) | `lastReport`, summed |
  | Airports / countries served | Deduped across members |
  | Members / gates held | allianceMap + gate ledger |

  Default sort: **combined market cap** (the game's established headline number for
  standing — stable week to week, no resets, no mid-year join distortions); every column
  click-sortable, same pattern as the Fleet table sort. Aggregates are computed in the
  tick from data it already holds (allianceMap + blobs + Airline rows — no new
  collection) and stored as a weekly `AllianceStandingsWeek` row so the alliance page
  gets trend charts. Yearly **"Alliance of the Year"** goes to the top combined market
  cap at the year tick (the news feed already rolls yearly awards); #1 **overtakes** on
  market cap feed the news tape — "Horizon Coalition passes SkyBridge" is how rivalries
  start. Per-alliance stat page (members, network, gates, treasury, standings history)
  doubles as the recruiting pitch. NOTE: rankings on financial totals reward recruiting
  the biggest airlines — that's accepted here as scoreboard honesty (it ranks what
  happened, it doesn't pay out gameplay benefits); keep it that way — the moment a
  standings position grants an in-game buff, revisit per the stock-market-v2 lesson
  (marketCap-as-score made dividends score-negative).

---

## 7. Considered, deliberately later

- **Member-to-member aircraft leases/sales** — wants the used-aircraft-market plumbing;
  better shipped as a marketplace feature with an alliance discount than as an alliance
  feature.
- **Financial mutual aid / cross-shareholding** — collides with STOCK_MARKET_PLAN_V2 and
  private share pricing; design there, not here. Treasury explicitly cannot lend (5).
- **Alliance co-op goals ("carry 50k connecting pax this year")** — great PvE glue, easy
  to add once treasury exists as the reward sink; not load-bearing for v2.
- **Seasonal alliance contests** — quarterly themed competitions (most connecting pax,
  most new cities, quality growth) with a treasury prize or temporary perk. Natural
  follow-on once the Alliance Rating components exist; discussed 2026-08-04, deferred.
- **Leave cooldown** — N unaffiliated weeks after quitting an alliance, making defections
  to a rival bloc costly and newsworthy. Discussed 2026-08-04, deferred (revisit if
  alliance-hopping becomes a real pattern).
- **Joint aircraft orders** — group buys where the combined member quantity sets
  everyone's bulk-discount tier (the tiered discount to 20%@100 already exists per
  airline). Strong candidate for a later phase: it's the slot-pool trick applied to
  procurement, and it creates a recurring alliance *event*. Discussed 2026-08-04,
  deferred.
- **Shared loyalty program** — a joint FFP: partial loyalty spillover in markets where a
  partner operates and the member doesn't, flowing through the (now capacity-honest)
  brand-reach channel. Discussed 2026-08-04, deferred — touches demand balance, so it
  wants the Phase-2 rebalance settled first.
- **Alliance insurance pool** — opt-in mutual fund smoothing mechanical-failure costs
  (premium in, reimbursement above a deductible out; exploit-free because payouts key off
  engine-rolled incidents). Discussed 2026-08-04, deferred — pairs naturally with the
  MRO_JET_BASES work, design it there.
- **Cargo alliance mechanics** — cross-airline cargo competition doesn't exist yet
  (rival cargo is display-only); alliance cargo cooperation should wait for it.

---

## 8. Decisions & open questions

### Decisions already made (Dave, 2026-08-04)

| Question | Decision |
|---|---|
| Sharing model | **Slot pool**, not whole-gate subleases — draw partners' excess slots directly |
| Opt-in | **Owner opts in per airport** (with optional slot reserve); nothing shared by default |
| Pricing | **Fee share + 25% markup**: `gateFee/50 × 1.25` per borrowed slot, to the owner |
| Owner-priority squeeze | **4-week grace with countdown warning**, then engine trims to fit (forfeiture path) |
| Gateless borrowing | **Allowed** — no own gate needed; capped at one gate's worth per airport (own gates raise the ceiling); rule-5 lockouts still bar it |
| Alliance ranking | **Financial standings table** — combined profit / revenue / market cap etc., sortable; no synthetic composite score. Default sort **combined market cap** (cumulative-profit default rejected) |
| Alliance hub | **Yes** — one designated hub airport, bonus while ≥3 members hold gates there |
| Phase-4 UI cluster | **In**: alliance network map, recruiting board, stat-only rivalry declarations. Joint orders / shared loyalty / insurance pool → §7 deferred |

### Still open

| # | Question | Options / lean |
|---|---|---|
| 1 | Borrow ceilings: one gate's worth when gateless / own capacity when not — right knobs? | Tunable constants; revisit once live worlds show real pool usage |
| 2 | JV scope: per **city pair** or per **shared hub** (all connections over it)? | Pair is tighter to reason about; hub is more dramatic |
| 3 | Flat demand boost 0.06 → 0.04 alongside JV launch — OK, or keep 0.06 until we see JV uptake? | Do it together; one rebalance, one re-baseline |
| 4 | Founder-tunable dues range and whether existing alliances migrate at $60k | Migrate at current $60k |
| 5 | Is pool usage visible in the public gate view (everyone sees "NJA is flying on SkyTeam's slots"), or alliance-private? | Public — open-book economy matches the fare open-book precedent |
| 6 | Phase order confirm: 1 gates → 2 JV → 3 treasury → 4 governance? Governance is cheap and could jump the queue | — |

---

## 9. Test plan (per house rules: verified-failing-first where a bug fix, chain green before ship)

- `tools/alliance-slot-pool-test.mjs` — pool math (spare = gates×50 − usage; reserve
  honored; hub-guarantee slots excluded), most-spare-first attribution is deterministic,
  per-slot pricing incl. congestion surcharge, ≥1-own-gate + lockout eligibility, borrow
  cap, rule-5 attribution (a pooled gate never forfeits while drawn on), squeeze:
  countdown starts on shrink / trims via the forfeiture path at week 4 / owner decisions
  never blocked, caps unchanged by pool draws, decision-time CAS race (two borrowers, one
  slot).
- `tools/alliance-jv-test.mjs` — jvRoutes injection reaches `buildPartnershipMap`;
  prorate/penalty deltas visible in partner O&D revenue; dissolution on leave; tenure gate;
  hub designation: bonus applies only while ≥3 members hold gates, lapse countdown, no
  double-stack with a member's real home hub.
- `tools/alliance-standings-test.mjs` — aggregates are deterministic from blobs (retried
  tick = same row), PENDING members and bankrupt/ended airlines excluded, dedup on
  airports/countries (two members at JFK count once), member join/leave moves future
  weeks only (no retroactive restatement of history rows), overtake events fire once,
  Alliance of the Year matches top combined market cap at the year tick.
- Server route tests: share-toggle races (version CAS like the gate ledger), membership
  churn mid-draw, founder-removal wind-downs, recruiting-flag visibility, rivalry rules
  (one active, 12-week floor, declared-on alliance sees the card).
- Full HW chain + golden: phases 1/3/4 should pass golden UNCHANGED (server-state gated,
  absent in solo/golden fixtures); phase 2's rebalance is the one deliberate re-baseline.
- SSR consistency: gate views (`allianceTaken`, lent/borrowed) identical across Airports,
  RouteMap, and detail screens — same class of check as route-map-consistency-test.

---

## 10. Rollout

1. Phase 1 ships behind the existing `gateScarcity` world flag (no new flag needed —
   a slot pool simply doesn't exist in unlimited-gate worlds).
2. Phase 2 needs a world-level `allianceJv` toggle only if we want old worlds excluded;
   lean: ship to all HW worlds, constants start conservative.
3. Phases 3–4 are world-agnostic server features; ship whenever ready.
4. Devlog entry per phase; news feed events make each phase self-announcing in-world.
