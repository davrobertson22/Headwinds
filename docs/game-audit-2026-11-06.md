# Headwinds game audit: fun and realism (2026-11-06)

Fourth full pass, the first since the 2026-08-24 improvement audit (236 commits ago). Scope: the shared engine (demand, share, pricing, costs, catalogue, events), the multiplayer server rules, and the player-facing systems as the in-game Wiki describes them. **This is a report only. No game code was changed.** The numbers come from throwaway probes that drive the real engine (`tools/_probe/audit-*.mjs`, untracked) and from the existing `tools/catalogue-deadweight-report.mjs`.

**What I couldn't do:** a read-only pass over the live worlds (the way the startup-survival audit used `tools/startup-survival/`) was blocked by a permission check on production reads, so nothing here uses live player data. Three questions only the live worlds can answer are listed at the end. With your OK they're a quick follow-up.

---

## The short version

The simulation is in much better shape than in August. Every high-value data and correctness item from the last audit is closed, and the cost structure looks believable. What's left is mostly **design**, and it comes down to one theme plus a few gaps in multiplayer play:

1. **Big planes flown rarely beat frequency, and pricing is a wall instead of a lever.** On a route you fly alone, frequency has no effect on demand. On a contested route, frequency share is rewarded *less* than proportionally, so real airlines' core competitive weapon is weak here. Fares above the reference fare fall off an exponential cliff: a 40% premium loses 82% of the passengers on a route you fly alone. Together these make the A380 the best aircraft for LAX–SFO and Boise–Salt Lake, and they make "fill the plane at about the reference fare" the answer to most pricing questions.
2. **There's nothing to aim for between week 1 and the final ranking for most players.** The starter objectives run out after ten. Late joiners start with the same $10M as founders. The ranking is absolute dollars of profit, which rewards whoever got big first. Nothing ever moves a player off the board except bankruptcy or quitting.
3. **Player-to-player play is thin for an MMO-style game.** Rivals can share routes, bid for gates, trade up to 20% of each other's shares, ally and codeshare. They can't merge, take each other over, sell a failing airline, bid against each other for contracts, or talk in a public channel. Consolidation is the main arc of real airline history, and it's missing.

Each section below gives evidence, why it matters for fun or realism, a concrete proposal, and a rough impact and effort. Every balance change is meant for new worlds only, in line with how you've rolled out the other big rules.

---

## Closed since the 2026-08-24 audit (checked in the tree)

| Item | Status now |
|---|---|
| H4: HPN and SWF carried all of New York | **Fixed**: HPN 1.0M, SWF 0.4M population |
| H18: same-metro pairs escaping suppression | **Fixed**: HKG–SZX, MCO–SFB, SIN–JHB, GRU–VCP now have 0 demand |
| DKR/DSS 0 km route | **Route blocked** by `isSameLocation`. The duplicate airport row is still there (see small things) |
| A-new-1: cargo never contested | **Fixed**: contested cargo with `cargo-contest-test` |
| B1: world-end ceremony | **Built**: `SeasonResults.jsx` and season awards (Iron Throne, Busiest, Biggest Network, Best Comeback) |
| B11: year-in-review | **Built**, written by the tick |
| B13: re-founded airline news row | **Built** (`restartService`) |
| B-new-3: "last active" signal | **Partly**: `lastMoveAt` is on profiles |
| B4: per-airline service events | **Removed by design** (events model the world; anything that singles out one airline should be earned by its management). See R6 |

**Still open from the backlog:** B3 rotating objectives, B5 notifications, B7 late-join capital, B10 public channel, B14 prestige sinks, A9 tax-loss carryforward. A4 (fuel fare pass-through) you declined, and that's still the right call.

---

## Part 1: Realism, where a fix also makes the game more fun

### R1. Frequency doesn't sell seats on a route you fly alone (H impact / M effort)

**Evidence** (Boise–Salt Lake City, flown alone, 737-800, reference fare, demand model 3 under the new-world rules):

| Weekly frequency | Passengers | Load factor |
|---|---|---|
| 737-800 × 2 | 228 | 60% |
| 737-800 × 7 | 228 | 17% |
| 737-800 × 21 | 228 | 6% |
| E175 × 7 | 228 | 37% |
| E175 × 28 | 228 | 9% |

Twice a week and three times a day carry exactly the same people. On LAX–SFO, an A380 flown 4 times a week carries 3,229 passengers and makes $352k of route profit; a 737-800 flown 21 times a week makes $354k. The real market would never give the 4-a-week shuttle the same customers. In the code, frequency only appears in the contested share utility (`computeUtility`, `log1p(freq) × w.frequency`). `_monopolyResult` prices the demand pool on fare, quality, brand and appeal only.

**On contested routes the curve runs the wrong way** (utility terms alone, equal carriers otherwise):

| You vs them | Leisure share | Business share |
|---|---|---|
| 2× frequency (14 v 7) | 56% | 64% |
| 3× frequency (21 v 7) | 60% | 71% |
| Undercut 10% | 55% | 52% |
| Undercut 25% | 61% | 54% |

In the real industry the "S-curve" means a carrier with 75% of a market's frequency takes *more* than 75% of the passengers. That's why airlines fight frequency wars and why hubs run waves. Here 75% of the frequency wins 60–71%.

**Why it matters:** this one gap explains several things players will eventually notice. The A380 wins short shuttles (R3), upgauging always beats frequency, regional jets lose their real reason to exist, and the schedule editor and hub banks have little to work with. You said you want the schedule to matter more without being confusing. Frequency is that lever, and it needs no new UI.

**Proposal:**
- Multiply monopoly demand by a schedule-convenience factor that saturates. For example, business demand at 1 flight a week = 0.55× rising to 1.0× at about 3 a day; leisure flatter, 0.85× to 1.0×. Long-haul saturates sooner (once a day is plenty).
- On contested pairs, make frequency share super-proportional (an exponent around 1.3–1.5 on the frequency share, or raise `w.frequency` for business).
- Optionally let banked hub departures count as "effective frequency" for connecting markets. That's a natural reward for the hub-banks work.

Re-baseline the golden master as a stated balance change; new worlds only.

### R2. The fare cliff makes pricing a wall, not a decision (H / S–M)

**Evidence** (same route, E175 × 4, fare as a multiple of the reference fare). "Route profit" is the tick's own `routeResults.profit`:

| Fare | 0.5× | 0.7× | 0.85× | 1.0× | 1.1× | 1.2× | 1.4× | 1.6× | 2.0× |
|---|---|---|---|---|---|---|---|---|---|
| Passengers | 341 | 336 | 304 | 228 | 182 | 153 | 42 | 2 | 0 |
| Route profit | −$2k | $12k | **$18k** | $15k | $11k | $9k | −$14k | −$24k | −$25k |

Below the reference fare, elasticity behaves sensibly. Above it, a 20% premium loses a third of the passengers, 40% loses 82%, and 60% loses all of them, on a route nobody else flies. The best fare is always at or under the reference fare.

The choke (`nwrYieldChokeFactor`, `exp(−15 × overage)` above 1.10–1.25× depending on quality) was added on purpose to "stand in for the rival who would undercut a monopoly". In a multiplayer world the real rival exists, so the choke doubles up on competition and removes a classic strategy: the premium monopoly or fortress-hub carrier. A fortress hub today gets +2 quality and 0.05 less price sensitivity, which is nothing next to the wall. The threshold depends only on quality.

**Proposal:** keep a choke, but make the headroom something a player *earns*, and make the threat that disciplines it a player too:
- Raise the threshold with how hard the market is to enter: your share of gates at both ends, the scarcity at those airports, a fortress hub, and your loyalty share there.
- Lower it when another airline holds gates at both endpoints (a credible entrant), whether or not it flies the route yet.
- Soften the steepness (15 → about 5) so a strong airline can hold +30–40% on a protected route and lose roughly half its passengers, not all of them.

This turns "enter a rival's fat monopoly" into a real counter-move, which gives multiplayer worlds the competitive spark that low player density otherwise denies them. Pair it with the existing fare-cliff warnings so the threshold is always visible.

### R3. The aircraft catalogue's ordering is upside down at both ends (M–H / S–M)

**Evidence** from `catalogue-deadweight-report.mjs`: 768 missions, 170 passenger types, 30 win at least one mission.
- **The A380 wins 81 missions, more than any other type**, including Boise–Salt Lake, JFK–Boston and LAX–SFO. That combines R1 (frequency doesn't matter) with the fact that it can use any 9,800 ft runway.
- **The 787-9 and A350-900 never win a mission.** Their best results are 84% and 76% of the winner. The A350-1000 reaches 79% and the 787-10 87%. The A330neo wins 28 missions. In the data, the A330neo has more seats (460 vs 420/440), the best fuel per seat (1.57 vs 1.71/1.77) and the cheapest lease per seat ($583 vs $800/$916). The types airlines have actually ordered in their thousands are never the right answer here.

**Proposal:**
- Add a `codeF` (or "superjumbo stands") flag for the airports that can handle A380s and 747-8s, checked the same way `runwayFt` is.
- Count a widebody departure as more slot or gate occupancy than a narrowbody one.
- Give the new-generation widebodies their real advantages: more belly cargo, a passenger-appeal bonus (cabin altitude and humidity), and payload-range at full seats. Then re-run the deadweight report with a target in mind, for example 787-9 and A350 own the thin-to-mid long-haul cells and the A380 owns only dense trunks into code-F hubs.

### R4. Gates get more expensive the more you hold, the opposite of how hubs work (M / M)

**Evidence** (`totalGateMonthlyFee`, ORD, a mega airport): 5 gates cost $147k per gate per month, 20 cost $343k, 40 cost $531k, and 80 cost $626k ($11.6M a week). A regional airport barely escalates. Real hub carriers get the *best* per-gate terms (long-term use agreements, whole terminals). The cost rise works as an anti-snowball tool, but it pushes players away from the fortress hub, the most recognisable real airline strategy.

**Proposal:** keep per-gate rent flat or give a volume discount at a designated hub, and let scarcity (auctions, the gate market, the 60% cap) and congestion be the constraint. If the goal is to check runaway leaders, do it openly (R2's entrant mechanics, F1's antitrust review) instead of through a cost curve that reads as unrealistic.

### R5. Demand shocks are frequent, short and have no memory; there's no business cycle (M / M)

**Evidence:** multiplayer worlds roll 20 world events at about 0.51 per week, roughly 26 a year, lasting 1–16 weeks. A "recession" lasts 8–16 weeks at 1.8% a week, about once a game year. The stock market index has bull and bear phases, but demand, lease rates and used-aircraft values don't follow it.

**Why it matters:** real airline management is about capacity discipline through a multi-year cycle: order in the bust, take delivery in the boom, don't get caught with long leases at the top. You already built the pieces that would make this interesting (production-line backlogs, priority slots, the used market, lease terms), but with only short noise to react to, timing never pays off.

**Proposal:** a shared world macro cycle (a slow random walk with mean reversion, a 3–5 game-year period, ±8–12% demand) shown as a "world economy" indicator in News, with leading signals before it turns. Let lease rates, used-aircraft prices and the cancellation market follow it. Keep shocks, but make them rarer and bigger so each one is a story.

### R6. Incidents your management earned (M / M)

`events.js` already states the principle: anything that singles out one airline should be earned by its management, and the `satisfactionShock` channel was kept for that. Build on it: an operational meltdown becomes likely when fleet use is above about 85%, spare aircraft are thin, and ground or crew morale is low; a regulator fine for a skipped check grace window; an IT outage if you never invest. Each one appears in News naming the airline. This gives per-airline drama without rolling dice against a player, and it gives the "boring" systems (reserves, maintenance pay, ground stations) a visible payoff.

---

## Part 2: Fun, especially in multiplayer

### F1. Player-to-player M&A, and a way out that isn't quitting (H / L)

Today `ACQUIRE_COMPETITOR` returns a 403 in multiplayer ("your rivals are real people"), share stakes are capped at 20%, and an airline whose owner loses interest is simply abandoned (14 of 144 airlines in the August survival pass). Proposal:
- **Negotiated mergers.** One player offers cash and/or shares, the other accepts, and the fair-value model already in the stock market sets the guardrails. Fleet, gates, routes and loyalty members fold in. The absorbed founder is paid out and credited in their career record.
- **Tender offers.** Since shares already trade, crossing 50% of the float through a public tender gives control, with a defence window (the target can buy back stock or find a friendly bidder).
- **Antitrust review.** A deal is blocked or needs divestitures if the combined airline would pass the existing gate caps at any airport. Divestitures go to the gate market, which feeds other players.
- **"Sell my airline"** instead of abandoning. It keeps worlds populated and gives rich late-game airlines something to spend on (B14).

This fits your corp-dev background and is the single biggest new interaction you could add. It's large, so do a design doc first.

### F2. Something to aim for if you aren't #1 (H / S–M)

- **Late-join capital (B7, still open):** a player joining in week 80 gets the same $10M as a founder. Scale it to the world's median net assets, or run it as a "founding round" priced from the world's state.
- **Live secondary standings:** best margin, fastest growth, best newcomer (joined after week N), and regional champions (best airline flying mostly in Europe, Asia and so on). The season awards already compute superlatives at the end. Showing a few of them live, with the logos and rank arrows you just built, gives ranks 6–40 a race they can win.
- **Rotating board objectives (B3):** the 10 starter objectives disappear when they're done. Quarterly board mandates (for example "lift on-time to 85%" or "open two international routes") with modest rewards keep a short-term goal on the Dashboard all game.

### F3. Contracts and tenders players compete for (M–H / M)

This reuses the travel-partner pattern (requirements, happiness, renewal):
- **Government subsidy tenders on thin routes**, modelled on the US Essential Air Service and EU public-service obligations. A government posts a thin route with a minimum frequency; players bid the lowest subsidy; missing the minimum costs penalties. It's realistic, it gives small-aircraft starts a dependable niche (the survival audit's sore spot), and it creates player-vs-player auctions all over the map.
- **Charter contracts:** sports leagues, pilgrimage seasons, cruise turnarounds (ties into cruise partners), military or cargo airlift. Sealed bid, fixed term, lands in News.

### F4. Reach players while the clock runs (H / S–M)

Time runs while players are away, but nothing reaches them outside the game (B5 is still open). The cheapest version is a per-world Discord webhook that posts the "big moves" feed the server already builds, plus an opt-in email digest of personal alerts: cash runway under N weeks, a rival entering your route, an auction closing, a partner about to walk out. A **public world channel** (B10) next to the alliance board, with the moderation you already have, is where fare wars get declared.

### F5. Too many systems, all visible from day one (M / M)

The Wiki has 28 sections, and a new airline faces catering contracts, ground stations, jet bases, fuel farms and refineries, hedges, partnerships, loyalty pools, seat products, production lines and more. Most are one-time setup decisions, not decisions you make every week. Suggestions:
- **Progressive disclosure:** show a system's card when it becomes relevant (ground stations at about 100 weekly departures from one airport, jet bases at about 10 frames of one family, refineries late game), with a one-line "why now".
- **World rule presets:** about 13 per-world flags (scarcity, new-world rules, crew pipeline, production lines, partnerships, loyalty pools, hub banks, market development, demand model, era…). A few named presets (Standard, Hardcore, Era, Sandbox) make the lobby readable and shrink the number of rule combinations you have to test.
- **Advisor inbox:** one weekly line naming the single system worth looking at ("your ORD handling bill passed a Ramp Station's break-even").

---

## Small things

- **The Wiki says "$15 million in equity"** in Getting Started, but the multiplayer default is $10M (`DEFAULT_STARTING_CAPITAL`, and `STARTING_CASH` in the engine). The Market section's flat delivery times (1–4 weeks) also don't mention production-line worlds.
- **DKR and DSS** are both "Blaise Diagne Intl" at identical coordinates (`airports.js:368` and `:806`). Routes between them are blocked now, but the airport appears twice in pickers.
- **Stale plan headers:** `NEWS_FEED_PLAN.md`, `PLAYER_PROFILES_PLAN.md` and `USED_AIRCRAFT_MARKET_PLAN.md` still say "not built", but all three shipped.
- **`packages/engine/src/.fuse_hidden0000000f00000001`** (150 KB, from July) is a bridge leftover sitting in the engine source folder.
- **Cost structure looks sane.** A 22-aircraft ORD hub network (18 A320neo, 4 787-9) on demand model 3 spends 33% on fuel, 17% on crew and labour, 14% on leases, 16% on landing, gates and handling, and 8% on maintenance. That's close to a real airline's mix. My untuned version of that network lost money at 74% load factor, so margins depend on network design, as they should. No action.

---

## Suggested order

1. **The frequency and pricing package (R1 + R2 + the A380 airport flag from R3).** One golden-master re-baseline, new worlds only. It changes the most player decisions per line of code and gives the schedule work a real payoff.
2. **Season engagement (F2 + F4).** Late-join capital, live secondary standings, quarterly board objectives, Discord webhook. All small, and all built on data the server already computes.
3. **Contracts and tenders (F3).** Reuses the partnerships machinery and fixes the small-aircraft niche.
4. **Design doc: player M&A (F1).** The big swing; worth thinking through before building.
5. **Business cycle (R5) and earned incidents (R6).** Best done together, since both are about giving the slow systems a payoff.
6. **Catalogue pass (the rest of R3) and gate cost curve (R4).** Do these after R1, because the frequency fix changes which aircraft win.

## Questions only the live worlds can answer

A read-only pass with `tools/startup-survival/`-style scripts, if you OK it, would show:
1. What share of player routes are contested in each world. If it's low, R2 and F3 matter even more.
2. How spread out the standings are, and how often #1 changes. This would confirm or rule out the snowball worry behind F2 and R4.
3. How many airlines have fares sitting at or under the cliff threshold. That shows how much R2 is already shaping play.

## How to re-run the probes

The probe files are untracked in `tools/_probe/`:

```
node --import ./tools/_register-loader.mjs tools/_probe/audit-freq.mjs BOI-SLC
node --import ./tools/_register-loader.mjs tools/_probe/audit-costmix.mjs 1 20
node tools/_probe/audit-share.mjs
node tools/_probe/audit-gates.mjs
node tools/catalogue-deadweight-report.mjs --verbose
```
