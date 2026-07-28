import { useState, useMemo } from 'react';
import { Glyph } from './Icons.jsx';
import { useGame } from '../store/GameContext.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// In-game Wiki / Help panel.
//
// A player-facing how-to guide. Content lives in the WIKI array below as plain
// data so it's easy to keep in sync with the game. Each section renders into the
// content pane on the right; the left rail is a filterable table of contents.
//
// Block types supported by the renderer:
//   { p:  'text' }                  paragraph (supports **bold** inline)
//   { h:  'text' }                  sub-heading inside a section
//   { ul: ['a', 'b', ...] }         bulleted list (each item supports **bold**)
//   { steps: ['a', 'b', ...] }      numbered step list
//   { tip: 'text' }                 highlighted tip / callout
//   { warn: 'text' }                highlighted warning callout
//
// Multiplayer (Headwinds) awareness — `remote` from useGame():
//   Section flags:  soloOnly / remoteOnly   → whole section shown in one mode
//   Block flags:    solo: true / remote: true → block shown only in that mode
// Solo (Tailwinds) renders identically to before: remote is always false there,
// so `solo` blocks show, `remote` blocks/sections are dropped.
// ─────────────────────────────────────────────────────────────────────────────

const WIKI = [
  {
    id: 'start',
    icon: '🚀',
    title: 'Getting Started',
    blurb: 'Your first 15 minutes',
    blocks: [
      { p: "You've founded an airline with **$15 million in equity**: no debt to service, just cash to invest. Your job is to build a route network that earns more than it spends, week after week, and eventually outgrow every rival." },
      { h: 'The fastest path to your first flight' },
      { solo: true, steps: [
        'Open the **Market** tab and lease a Turboprop or Regional Jet. They are cheap to run and low-commitment, perfect for week one.',
        'Open the **Gates** tab and buy a gate at the airport you want to fly to. You already start with a gate at your home hub, but you need one at *both* ends of every route.',
        'Go to the **Route Planner** (or Routes → New Route), pick your two airports, assign the aircraft, set a ticket price and weekly frequency, then open the route.',
        'Hit **Next Week** in the top bar to fly the route and collect revenue. Check the **Dashboard** afterwards for alerts.',
      ] },
      { remote: true, steps: [
        'Open the **Market** tab and lease a Turboprop or Regional Jet. They are cheap to run and low-commitment, perfect for week one.',
        'Open the **Gates** tab and buy a gate at the airport you want to fly to. You already start with a gate at your home hub, but you need one at *both* ends of every route.',
        'Go to the **Route Planner** (or Routes → New Route), pick your two airports, assign the aircraft, set a ticket price and weekly frequency, then open the route.',
        'The **world clock** flies your route and collects revenue automatically on this world\'s pace · check the **Dashboard** after each new week for results and alerts.',
      ] },
      { tip: "Don't over-spend in week one. Keep a cash cushion, leases, fuel and crew are billed every week whether your planes are full or not." },
      { p: "The game auto-advances one week every hour, but you can always advance manually with **Next Week**. Your progress is auto-saved; use **Save** to keep named slots you can return to.", solo: true },
      { p: "Time belongs to the world, not to you: the server advances **every airline one week at a time, in lockstep**, on this world's pace (shown in the lobby and the bar above the game). Your routes fly and your bills come due even while you're offline. There is no save or load; the server is the save.", remote: true },
    ],
  },
  {
    id: 'loop',
    icon: '🔁',
    title: 'The Core Loop & Winning',
    blurb: 'How a week works, how you win and lose',
    blocks: [
      { p: 'Every week you collect ticket (and cargo) revenue from your routes. Every week, costs come out: fuel, crew, leases, maintenance, gate fees, overhead and any loan payments. The gap between the two is your weekly profit or loss.' },
      { h: 'How you win' },
      { p: 'You win by **acquiring every competitor**. As you grow stronger and rivals weaken, you can buy them out from the **Competition** tab. Take over the last one and the industry is yours.', solo: true },
      { p: 'Every airline in this world belongs to a **real player**, and the **Rivals** leaderboard ranks all of them by market cap. The world runs for a fixed length (shown in the lobby), finish at the top when the clock runs out. There are no buyouts of human airlines: you win by out-building, out-pricing and out-lasting people.', remote: true },
      { h: 'How you go bankrupt' },
      { ul: [
        '**Miss 3 loan payments** · i.e. your cash is negative on a week when loan repayments are due, three times.',
        '**Stay cash-negative for 6 consecutive weeks**: even with no loans, running on empty for too long ends the game.',
      ] },
      { warn: 'Warning toasts appear before you hit either limit. Watch the Finance tab and act early, debt is much easier to manage before it spirals.' },
      { h: 'Why no two games play the same' },
      { p: 'Fuel prices fluctuate, random events fire at different times and intensities, aircraft failures are unpredictable, and regional booms or downturns hit different parts of the world each run. A strategy that won one game may struggle the next.' },
      { p: 'And in a shared world, the biggest variable is the **other players**: every fare cut, new route and alliance is a human decision reacting to yours.', remote: true },
    ],
  },
  {
    id: 'dashboard',
    icon: '📊',
    title: 'Dashboard',
    blurb: 'Your weekly health check',
    blocks: [
      { p: 'The Dashboard is the first thing you see after each week. It summarises how the airline is doing and flags anything that needs attention.' },
      { ul: [
        '**Getting Started** checklist, early objectives to guide your first decisions.',
        '**Financial History**: revenue, costs and profit trends over recent weeks.',
        '**Weekly Cost Breakdown**: where your money is going (fuel, crew, leases, maintenance, gates, overhead and more).',
        '**Fleet Utilisation**: how hard your aircraft are working. Idle planes still cost money.',
        '**Alerts** · surfaced automatically when something needs a look, e.g. idle aircraft, loss-making routes or low cash.',
      ] },
      { tip: 'Make the Dashboard your first stop every week. Acting on its alerts early is the cheapest way to stay healthy.' },
    ],
  },
  {
    id: 'map',
    icon: '🗺️',
    title: 'Map',
    blurb: 'Visualise your network',
    blocks: [
      { p: 'The Map shows your whole route network geographically, every city pair you fly, your hubs, and where your aircraft are deployed.' },
      { p: 'Use it to spot gaps and opportunities: clusters of demand you are not yet serving, routes that overlap inefficiently, or regions where a hub could feed connecting traffic. Click elements on the map to drill into airports and routes.' },
    ],
  },
  {
    id: 'planner',
    icon: '🧭',
    title: 'Route Planner',
    blurb: 'Model a route before you commit',
    blocks: [
      { p: 'The Route Planner lets you test a potential route and see its **estimated economics** before spending a cent. Pick an origin and destination (search by city or IATA code), choose an aircraft type, then set the ticket price and weekly frequency.' },
      { h: 'What the estimate shows you' },
      { ul: [
        '**Demand** split into business and leisure travellers, plus any **connecting passengers** feeding through your hubs.',
        '**Estimated load factor**: what fraction of seats you expect to fill at your chosen price.',
        '**Revenue vs. operating cost**, so you can see whether the route is likely to make money.',
      ] },
      { tip: 'Price is a lever, not a fixed number. Higher fares mean more revenue per seat but fewer passengers; lower fares fill the plane but thin your margin. Nudge the price and watch the load factor respond to find the sweet spot.' },
      { p: 'If an aircraft can\'t reach the destination, the planner will tell you · lease a longer-range type from the Market first. The planner also has a **multi-stop mode** for routing one aircraft through intermediate stops (see Multi-stop Routes), and a **freight mode** for cargo lanes (see Cargo & Freight).' },
    ],
  },
  {
    id: 'routes',
    icon: '🛫',
    title: 'Routes',
    blurb: 'Open, tune and manage routes',
    blocks: [
      { p: 'The Routes tab lists every route you operate, with load factor, assigned aircraft and profitability at a glance. This is where you open new routes and fine-tune existing ones.' },
      { h: 'Opening a route' },
      { steps: [
        'Click **New Route** and choose two airports. You must hold a gate at *both* ends. Buy gates in the Gates tab first.',
        'Assign one or more aircraft and set the weekly frequency (how many round trips).',
        'Set the ticket price and catering level, then confirm.',
      ] },
      { h: 'Managing a route' },
      { p: 'Click any route to open its **Route Detail**, where you can see your performance, market share, the competitors flying the same city pair, connecting-passenger contribution and maintenance status. Adjust price, frequency, aircraft or catering here as conditions change.' },
      { tip: 'A new route ramps up over its first weeks as travellers discover it · don\'t panic if early load factors look soft. Give it time before judging it.' },
    ],
  },
  {
    id: 'multistop',
    icon: '🔗',
    title: 'Multi-stop Routes',
    blurb: 'One aircraft, several cities',
    blocks: [
      { p: 'A **multi-stop (tag) route** is a single aircraft flying through one or two intermediate stops on its way to the final destination, for example **A → B → C**: and back again. Instead of one city pair, it sells **every market along the way**: the local legs *and* the longer "through" journeys.' },
      { p: 'For an A → B → C route that means three markets: **A–B**, **B–C**, and the through **A–C**. A traveller can fly just one leg or ride the whole way. You can add up to **two intermediate stops** (four airports, three legs).' },
      { h: 'Why fly one' },
      { ul: [
        '**Reach farther than your aircraft can in one hop.** Only each *leg* has to be within range, the total trip can be longer. A stop turns an out-of-range city into a reachable one.',
        '**Serve a thin city in the middle.** A stop that would never justify its own route can ride along on a busier one.',
        '**Feed more of your network.** Each leg becomes part of your map, so its stops can also connect passengers onto your other flights.',
      ] },
      { h: 'How to build one' },
      { steps: [
        'Open the **Route Planner** and switch to **Multi-stop** mode (the toggle next to Passenger and Freight).',
        'Pick your airports in order, origin, one or two stops, destination, with **+ Add stop**. You need a gate at *every* airport on the route.',
        'Choose an aircraft that can fly the **longest single leg**, and set the weekly frequency.',
        'Set the **fare for each market**, including the through fares (premium cabins scale automatically), then open the route.',
      ] },
      { h: 'How seats are shared' },
      { p: 'The aircraft has the same seats on every leg, and the markets compete for them. A **through passenger occupies a seat on every leg they fly**, so a busy A–C through market eats into the seats available for local A–B and B–C travellers. The game allocates seats to the most valuable mix automatically. Watch the **per-leg load factors** in the planner to see how full each leg runs.' },
      { warn: 'Every leg adds flying time, so a multi-stop route burns through your aircraft\'s weekly block-hour budget faster · which can cap how many times a week you can fly it. Long chains naturally settle at lower frequencies. You also pay landing fees at every stop.' },
      { p: 'Multi-stop routes appear in their own section on the **Routes** page, showing the full path and each leg\'s load factor.' },
      { tip: 'Reach for a stop when a direct flight isn\'t possible or a lone city is too thin to serve · not as a default. A clean nonstop almost always fills better and costs less when the demand is there.' },
    ],
  },
  {
    id: 'fleet',
    icon: '✈️',
    title: 'Fleet',
    blurb: 'Your aircraft and their cabins',
    blocks: [
      { p: 'The Fleet tab is your aircraft roster: every plane, its type, age, utilisation, lease cost and maintenance status. It also shows aircraft on order and their delivery progress.' },
      { h: 'Configure Cabin' },
      { p: 'Open **Configure** on any aircraft to set its cabin layout and quality:' },
      { ul: [
        '**Cabin Layout**: how many seats and the class mix (economy / business). More premium seats earn more per passenger but reduce total capacity.',
        '**Seat Quality** and **Service Quality**: raise these to lift your in-flight product score, which boosts demand and supports premium pricing. They cost more to run.',
      ] },
      { warn: 'Idle aircraft are pure loss. They accrue leases and maintenance while earning nothing. If a plane has no route, either assign it or return/sell it.' },
      { tip: 'Match the aircraft to the route: turboprops and regional jets for short, thin routes; narrowbodies for busy domestic corridors; widebodies for long, dense international legs.' },
    ],
  },
  {
    id: 'market',
    icon: '🛒',
    title: 'Market',
    blurb: 'Lease or buy aircraft',
    blocks: [
      { p: 'The Market is where you grow your fleet. Browse by manufacturer and category, compare fuel burn and seat efficiency, then either **lease** (lower commitment, weekly payments) or **order** aircraft outright.' },
      { h: 'Delivery times' },
      { p: 'New deliveries are staggered by type: widebodies take 4 weeks, narrowbodies 3, regional jets 2, and turboprops 1. Plan ahead, an order placed today won\'t fly this week.' },
      { h: 'Customising an order' },
      { ul: [
        '**Engine Options** and a **Wingtip Package** can extend range and adjust fuel burn.',
        '**Cabin Configuration** with seat and service quality is set at order time (and can be changed later in Fleet → Configure).',
        'Ordering shows an **Order Summary** with unit price, total weekly lease and maintenance estimates before you confirm.',
      ] },
      { tip: 'Leasing keeps cash free and commitment low early on. Buying outright makes more sense once you have stable cash flow and want to cut long-run per-aircraft costs.' },
    ],
  },
  {
    id: 'gates',
    icon: '🚪',
    title: 'Gates',
    blurb: 'Secure the right to fly somewhere',
    blocks: [
      { p: 'You can only operate a route between airports where you hold gates. The Gates tab (search by code, city or country) is where you buy them.' },
      { ul: [
        'You need a gate at **both** the origin and destination of every route.',
        'Buying more gates at one airport increases your capacity there, and is the first step toward making it a hub.',
        'Click an airport to see your presence and its slot utilisation in **Airport Detail**.',
      ] },
      { tip: 'Buy gates ahead of demand at airports you plan to build around. Securing gates early at a future hub protects you from being locked out as competitors expand.' },
    ],
  },
  {
    id: 'gatescarcity',
    icon: '⛩️',
    title: 'Gate Scarcity (world option)',
    blurb: 'Finite gates, auctions, and a gate market',
    blocks: [
      { p: 'Some multiplayer worlds are created with **gate scarcity** on (look for the ⛩ badge in the lobby). In those worlds every airport has a fixed number of gates — 25, 100, 250 or 500 by size — and airlines compete for them. In all other worlds, gates work classically (unlimited).' },
      { ul: [
        '**Capacity:** once every gate at an airport is taken, no more can be leased — the Airports tab shows each airport\'s availability.',
        '**Ownership caps:** no airline may hold more than **60%** of an airport\'s gates, and an alliance\'s members no more than **80%** combined.',
        '**Home-hub guarantee:** you can always lease up to **5 gates at your home hub**, even when it is full. Those first 5 hub gates can never be sold.',
        '**Auctions:** an airport at capacity auctions new gates once a year — bidding opens at **week 40** with **sealed bids** (nobody sees yours) and resolves at the new year. Highest bids win and pay what they bid; exact ties are settled randomly. Won gates grow the airport. You bid a price **per gate** and choose how many you want \u2014 up to 3, and never more than are on offer. Find the bidding form under **Gates \u2192 Gate Market**, or click the auction item in the News feed.',
        '**The caps bind alliances too.** You may not found or join an alliance whose members would then hold more than 80% of any airport\u2019s gates between them \u2014 the combined cap is checked when membership changes, not only when a gate does. Sell or release gates first if a merger would breach it.',
        '**Bids are not escrowed.** Nothing is taken from you when you bid \u2014 the money has to be in the bank at the new year, when the auction resolves. A bid you can no longer afford is voided and the gates go to the next bidder. The ownership caps are also applied at resolution, so a bid that would push you past 60% (or your alliance past 80%) is voided the same way.',
        '**Every bid gets an answer.** Win or lose, the outcome lands as a notification at the year tick, and the result \u2014 what sold, to whom, at what price, and what became of your bid \u2014 stays under **Gates \u2192 Gate Market** for 12 weeks. An auction where nothing sold says so in the News feed too.',
        '**Gate market:** you can sell non-guaranteed gates to other airlines at your asking price, and buy theirs. Gates won at auction or bought have a 12-week cooldown before re-listing.',
        '**Use it or lose it:** hold gates at an airport you haven\'t flown to for **24 straight weeks** and they are forfeited back to the pool — and you are locked out of that airport for 24 weeks. Warnings start at week 16.',
        '**Congestion surcharge:** while an airport is more than **90% full**, every airline pays **+20%** on its gate fees there.',
      ] },
      { tip: 'In scarcity worlds gates ARE the strategy: grab capacity at growth airports early, keep every gate served (or sell it before the 24-week clock runs out), and save cash for the week-40 auctions at the airports that matter.' },
    ],
  },
  {
    id: 'hubs',
    icon: '🏢',
    title: 'Hubs & Focus Cities',
    blurb: 'Unlock connecting traffic',
    blocks: [
      { p: 'A hub is an airport where your routes connect, letting passengers transfer between your flights. Connecting revenue comes from **real one-stop itineraries** sold over the hub, every spoke you add opens new city-pair markets, plus a residual feed from gateway and partner traffic. Hubs also cut operating costs on routes touching them: own ground staff, own flight kitchens, crews sleeping at home, and (at Major Hub and above) on-site line maintenance.' },
      { h: 'Focus cities' },
      { ul: [
        'A cheap starter designation: **5 gates**, $1M, active immediately.',
        'Enables own-metal connections at a reduced level plus small cost savings.',
        'Allowed **anywhere**: but only one per country outside your home country, and foreign focus cities can never become full hubs.',
        'At home, a focus city with 10 gates can be **promoted to a full hub**.',
      ] },
      { h: 'Hub tiers' },
      { ul: [
        'Full hubs cost real capex and take weeks of construction: Hub ($5M, 4 wks), Major Hub ($25M, 8 wks), International Gateway ($100M, 16 wks).',
        'Higher tiers demand a network to match: **20 routes** (2 international) at the airport for Major Hub; **50 routes**, 6 international destinations, 1,000 connecting pax/wk and 26 weeks as a Major Hub for International Gateway.',
        'Each tier improves the transfer product (more connecting share), quality bonus, and cost savings.',
      ] },
      { h: 'Congestion & competition' },
      { ul: [
        'Congestion is based on **slot utilisation** — weekly aircraft departures vs gate capacity, not route count. A gate physically holds 50 departures a week, but a hub starts to clog before it hits that wall: comfortable capacity is about 30 per gate at a Focus City, 35 at a Hub, 40 at a Major Hub and 45 at a Gateway. Better hubs run their gates harder before connections start to slip. Past that point connecting traffic suffers, and the further over you are the worse it gets (floored at 80%). A few low-frequency spokes barely register, while many daily flights fill your slots fast. Buy gates (or trim frequency) to relieve congestion.',
        'Competitors hubbing at the same airport **contest the connecting pool**. Dominate an International Gateway with over 60% share and it becomes a **fortress hub**: +2 quality and pricing power on every route touching it.',
      ] },
      { tip: 'Hubs reward density. The more spokes you fly into a hub, the more connections become possible, the value compounds as the network grows. When gates run short, that is the game telling you to open a second hub.' },
    ],
  },
  {
    id: 'operations',
    icon: '⚙️',
    title: 'Operations',
    blurb: 'Staff pay, maintenance & overhead',
    blocks: [
      { p: 'Operations is where you manage the people and upkeep behind the flights. Changes take effect next week.' },
      { h: 'Pay rates & morale' },
      { p: 'You set pay rates for your labour groups, pilots, cabin crew, ground staff and maintenance. Pay influences **staff morale**, which feeds your quality score and demand.' },
      { p: 'Your **on-time rate** blends the morale of pilots (50%), ground staff (30%) and cabin crew (20%), and suffers when your fleet is worked too hard. Above roughly 60% average block-hour utilisation, schedules lose the slack to absorb delays; a fleet flown flat-out near the weekly cap loses up to 12 points of punctuality. Idle spare aircraft act as a buffer that protects on-time performance. Late flights hurt your quality score and increase passenger compensation payouts.' },
      { warn: 'Pay cuts reduce costs immediately, but morale falls gradually over several weeks (~12% per week toward the new target) and recovers just as slowly. Underpaying now has lasting consequences.' },
      { h: 'Unions, strikes & contract talks' },
      { p: 'Each labour group has a union. While a group\'s morale sits below 50, **union unrest** builds week by week (faster the deeper the deficit); once it crosses the strike threshold the group can walk out. A **strike** cancels a large share of your flights · pilots hit hardest · for one to two weeks while your fixed costs keep running. You can settle a walkout instantly by granting a 15% raise, or hold out and absorb the losses; either way a truce follows before the union will strike again.' },
      { p: 'Every couple of game years each union also tables a **contract demand**: a new pay rate, and a bigger ask after profitable years or when you pay below market. You have four weeks to accept, counter at the midpoint, or refuse. Counters are a gamble: happy workforces usually take the deal, angry ones pocket the raise and come back sooner. Refusing (or ignoring the demand) costs morale and stokes unrest, strike territory if pay stays low.' },
      { h: 'Maintenance spending' },
      { p: 'Maintenance budget controls spending on parts, components and scheduled checks. Each aircraft family you operate requires its own maintenance base, retiring every aircraft of a type eliminates that base cost. Higher spending keeps aircraft reliable; cutting it saves money but raises the risk of failures.' },
      { h: 'Corporate Overhead' },
      { p: 'Marketing works like real advertising (adstock): brand spend builds awareness over weeks rather than boosting demand instantly, and awareness persists, then slowly fades, after spend stops. Demand reach runs from 40% for an unknown brand to 112% for a household name. Targeted campaigns at individual airports add a fast-building, fast-fading local demand lift (up to ~+10% sustained) on routes touching that airport; bigger metros cost more to saturate. Advertising is a share-of-voice battle: competitors market at their hubs and stations too, which dilutes your campaigns, drags demand at contested airports, and can escalate, invade a fortress carrier\'s hub with a big campaign and expect a counter-blitz.' },
    ],
  },
  {
    id: 'reputation',
    icon: '⭐',
    title: 'Reputation',
    blurb: 'Your brand and positioning',
    blocks: [
      { p: 'Three scores describe how travellers see your airline, each answering one question and pulling one lever:' },
      { ul: [
        '**Quality (0–100)**: how good is the product on the plane? Built from on-time performance, cabin product, fleet age and your earned customer rating, plus catering, space and hub bonuses per route. Wins market share against competitors and captures business travelers. See the breakdown on any route\'s detail page.',
        '**Reputation (0–100)**: how much do travellers trust the brand? Built from service, fleet freshness, network reach, staff morale and loyalty. Nudges demand on every route (±7.5%) and makes your passengers less price-sensitive.',
        '**Awareness (0–100)**: how many travellers know you exist? Built by marketing spend and passengers flown, with a lag. Gates how much of potential demand you can reach at all (40%–112%). It levels off rather than climbing forever: ~1% of your awareness above 5 fades each week, so flying alone settles you near 52 and sustained heavy brand spend settles near 83. Brand spend is judged against your size, roughly 4% of weekly revenue buys most of the gain available, so a budget that moved the needle as a startup does very little at national scale.',
      ] },
      { p: '**Passenger satisfaction** is earned, not set: each week it drifts toward the experience you actually delivered, punctuality, crew service, cabin product and catering, fleet age. It moves slowly in both directions, and your customer rating (a big slice of the quality score) comes from it. Slash service to save money and your rating erodes over the following weeks; win it back the same slow way.' },
      { p: '**Quality captures business travelers.** Business demand you can actually win scales with your quality score (roughly ±12%) even on routes you have to yourself, corporate travelers take rail, another hub, or a video call rather than a shoddy product. Against competitors, quality also dominates how the business segment splits. Quality also stretches the business fare travelers tolerate (about ±7%), so a flagship product can hold a fatter premium before demand collapses. If you sell premium cabins, quality is the engine that fills them.' },
      { p: '**Watch for service moments.** Random events can shock satisfaction directly, a catering contractor meltdown or baggage-system failure dents it; a viral crew moment or an industry service award lifts it. Shocks fade gradually over the following weeks as your delivered experience reasserts itself.' },
      { h: 'Market positioning' },
      { p: 'Where you sit on the price/quality spectrum shapes who flies you:' },
      { ul: [
        '**Premium** · high revenue per seat, profitable even at moderate load. Focus on service consistency and business-friendly routes.',
        '**Low-Cost** · volume over margin. Fill planes at low prices and minimise costs everywhere; best with high frequency and dense leisure routes.',
        '**The middle**: the hardest place to compete. If you\'re not clearly differentiated, consider committing to Premium or Low-Cost.',
      ] },
      { tip: 'Reputation is built slowly through consistent service quality, fair pricing and a loyal member base, and it pays off on every route at once.' },
    ],
  },
  {
    id: 'loyalty',
    icon: '🎟️',
    title: 'Loyalty Program',
    blurb: 'Keep passengers coming back',
    blocks: [
      { p: 'A loyalty program turns one-time flyers into repeat customers, but it\'s a long-term asset, not a quick win. Set a **weekly investment** (tiers from Basic to Elite) to enrol members over time and slowly build **program maturity**.' },
      { h: 'How it pays off' },
      { ul: [
        'Effects scale with **program strength = member penetration × maturity**. Maturity takes **~18 months of continuous funding** to max out, so a young program delivers only a fraction of its potential.',
        'Members are **less price-sensitive**: they book with you even when rivals undercut (up to ~18% sensitivity reduction with Elite caps at full strength).',
        'A strong program adds a **demand boost on hub routes** (up to +12.5% at Elite) and a **reputation bonus** (up to +8).',
        'Higher tiers raise the **effect caps**: Gold and Elite aren\'t just faster, they unlock stronger ceilings.',
      ] },
      { h: 'The cost, and the debt' },
      { p: 'Beyond the weekly investment, members **earn points on every flight** which accrue as a **points liability**: a real debt you repay over the following months as award seats. A growing program looks cheap early because redemptions lag earn; the bill arrives later. Roughly 20% of points expire unused (breakage), which is where a well-run program eventually finds its margin.' },
      { p: '**Defunding a mature program is painful**: elite members defect fast, maturity unwinds four times faster than it was built, and outstanding points must still be honoured.' },
      { tip: 'Expect the program to be a net cost for its first year or more. It pays for itself once maturity unlocks the full demand shield, commit early, budget for the long haul, and don\'t start it during a cash crunch.' },
    ],
  },
  {
    id: 'alliances',
    icon: '🤝',
    title: 'Alliances',
    blurb: 'Partner with other carriers',
    blocks: [
      { p: 'Alliances and codeshares let you earn from passengers you don\'t carry yourself by partnering with competitors.' },
      { h: 'Alliance membership' },
      { p: 'Joining an alliance costs an **initiation fee** plus **weekly dues**, and connects you to a network of partner carriers, extending your reach and reputation.', solo: true },
      { p: 'Alliances here are **founded and run by players**: there are no preset blocs. Anyone can found one right in the **Alliances** tab; others request to join and the **founder** accepts or rejects (up to 8 members). Members pay weekly dues and get a partner demand boost, interline revenue from connecting traffic, and a quality bonus.', remote: true },
      { p: 'Manage everything, founding, join requests, approvals, leaving, in the **Alliances** tab, alongside your current alliance and its benefits.', remote: true },
      { h: 'Bilateral codeshare agreements' },
      { p: 'You can also strike **codeshare agreements** directly with individual competitors. Each agreement has a weekly fee scaled to the partner\'s tier, and earns **interline revenue** from shared traffic across the airports you both serve.' },
      { tip: 'Your in-flight product score matters to partners, upgrade seat and service quality in Fleet → Configure to make yourself a more attractive ally.' },
    ],
  },
  {
    id: 'competition',
    icon: '⚔️',
    title: 'Competition',
    blurb: 'Track rivals and acquire them',
    soloOnly: true, // multiplayer gets the human-rivals section below instead
    blocks: [
      { p: 'The Competition tab is your view of the rest of the industry, a leaderboard of competitors with their cash, fleet size and quality scores, plus their route networks.' },
      { h: 'Living rivals' },
      { p: 'Every rival runs its own airline. Each has a **personality**: Aggressive carriers attack busy routes (including yours), Copycats follow you onto proven markets, Fortress carriers defend their home hub, Niche players hunt under-served pairs, and Expansionists grow fast and thin. They open routes where they see profit, add capacity when you out-schedule them, cut routes that keep losing money, and react to your fares every week.' },
      { h: 'Head-to-head' },
      { p: 'On routes you both fly, you can see **contested-route** comparisons: who has the better price, quality and market share. Use this to decide where to attack and where to retreat. If a rival out-scores you on quality, consider upgrading your cabins. Remember that every carrier on a city pair splits its passenger pool, crowded lanes are thin for everyone.' },
      { h: 'Fare wars' },
      { p: 'Undercut an Aggressive carrier, or invade a Fortress carrier\'s hub · and it may declare a **fare war**: for weeks it prices below cost on the contested route, tracking your fare down at a deep undercut. Wars end in a truce, or early if the attacker runs out of cash. You can fight through it, match down, or retreat.' },
      { h: 'A shifting field' },
      { p: 'Quality scores are not fixed: profitable rivals **invest in cabins and service** (up to what their business model supports), while distressed ones cut standards. Successful carriers also open a **second hub** mid-game, and airlines **join alliances** over time, allied carriers look better to passengers and rescue struggling members. Your own alliance\'s partner benefits track live membership.' },
      { h: 'Boom, bust and consolidation' },
      { p: 'Rivals that overreach bleed cash. A struggling carrier enters a **fire sale** (buy it at a discount instead of a premium), and prolonged distress ends in **bankruptcy**. Strong airlines sometimes acquire weak ones, and brand-new startups appear mid-game to fill the gaps.' },
      { h: 'Acquisitions' },
      { p: 'As you grow and rivals weaken, you can **acquire** competitors. The **Acquisition Summary** previews the cost and the fleet and gates that would transfer to you. Buying out a competitor folds their network into yours.' },
      { warn: 'You win when no rival remains standing, acquire them, or outlast them as they collapse. Each purchase is a big cash outlay, so make sure a takeover strengthens you rather than overextending your balance sheet.' },
    ],
  },
  {
    id: 'rivals',
    icon: '⚔️',
    title: 'Rivals',
    blurb: 'The other players in your world',
    remoteOnly: true,
    blocks: [
      { p: 'There are **no AI airlines** in Headwinds. Every rival on the leaderboard is a real person running a real airline in the same world, on the same clock, from the same $15M start.' },
      { h: 'The Rivals tab' },
      { ul: [
        '**Leaderboard** · every airline in the world ranked by market cap, with cash, last-week profit and alliance.',
        '**Contested routes**: city pairs both you and a rival fly, head-to-head: fares, frequency, quality, and how the passenger pool split.',
        '**Rival profiles**: open any airline to see its full route network with fares, fleet, hubs, rank history and recent moves. It\'s all public · and they can see yours too.',
      ] },
      { h: 'How contested routes work' },
      { p: 'When two or more airlines fly the same city pair, the pair\'s passenger pool is **split between them** based on price, quality and frequency · the same demand model as everywhere else in the game. Undercut a rival and you take their passengers; let your quality slip and they take yours.' },
      { p: 'Head-to-head figures cover your **whole operation** on a pair: if you fly it with three aircraft, the flights and seats per week shown are all three added together, and the fare and quality are blended across them. Seasonal routes only count in the months they actually operate.' },
      { tip: 'Everything about your network is public information, fares, frequencies, fleet. Assume your rivals are watching the same numbers about you that you watch about them.' },
      { h: 'Talking to rivals' },
      { p: 'Use **✉ Messages** in the bar above the game to message any player directly, or your alliance\'s shared board. Coordinate, negotiate, or declare your fare war in person.' },
    ],
  },
  {
    id: 'news',
    icon: '\ud83d\udcf0',
    title: 'News',
    blurb: 'Everything happening in your world',
    remoteOnly: true,
    blocks: [
      { p: 'The **News** tab is your world\'s front page: every public move every player makes, plus the shared economy, the markets and the table. Newest first.' },
      { h: 'What shows up' },
      { ul: [
        '**World** \u00b7 the shared economy. Fuel spikes, recessions and regional demand shocks hit every airline in the world in the same week \u2014 this is where you find out one has started or ended.',
        '**Routes** \u00b7 city pairs opened and closed, passenger and cargo.',
        '**Fleet** \u00b7 orders placed, aircraft bought, sold and retired \u2014 with the numbers. A twelve-frame order says twelve.',
        '**Airports** \u00b7 gates taken and released, hub designations and upgrades, and (in gate-scarcity worlds) auctions opening and resolving.',
        '**Market** \u00b7 used aircraft changing hands.',
        '**Shares** \u00b7 the public tape. Every share purchase and sale between airlines prints here, with the resulting stake.',
        '**Standings** \u00b7 airlines entering or leaving the top 5, and airlines going under.',
        '**Players** \u00b7 new arrivals and alliance moves.',
      ] },
      { h: 'It groups, so it stays readable' },
      { p: 'Moves of the same kind by the same airline in the same week are collapsed into one item. A rival opening eight routes out of Denver is **one line**, not eight \u2014 open it to see the full list. Orders are summed by type, gates grouped by airport, and a week of buying into one rival becomes a single tape line with the net position.' },
      { h: 'Three filters worth knowing' },
      { ul: [
        '**Big moves only** \u00b7 hides the routine and leaves the headlines: hub moves, auction results, large orders, bankruptcies, top-5 changes, world events, and any dealing that crosses a 5%, 10% or 25% stake.',
        '**Near my network** \u00b7 only events touching an airport you serve or a city pair you fly. The fastest way to spot someone moving on you.',
        '**Hide my moves** \u00b7 your own actions are public like everyone else\'s, and appear here tagged \u201c(you)\u201d. Turn them off if you only want to watch the competition.',
      ] },
      { tip: 'The \ud83c\udf0d button in the top bar is the short version \u2014 the last few headlines and an unread dot. Click \u201cSee all news\u201d to come back here.' },
      { h: 'How far back it goes' },
      { p: 'News is kept for **one game year**. Anything older is gone, so if something matters to you, act on it while it is on the page.' },
      { p: 'Nothing private is ever reported. Cash, loans, budgets and per-route profit stay yours \u2014 the feed only carries what an observer at the airport, or a reader of the market tape, could see anyway.' },
    ],
  },
  {
    id: 'stocks',
    icon: '📈',
    title: 'Stock Market',
    blurb: 'Raise capital, return it, and trade rivals',
    blocks: [
      { p: 'Every listed airline appears on the **Stocks** tab at a share price set by its fundamentals: profits and growth, cash, owned fleet, and debt. Airlines are valued the way real airlines are — the lowest-multiple, most cyclical sector there is, on a **P/E of roughly 5 to 13**, with the earnings component capped against actual revenue so no valuation can run away from the business behind it. Prices move once per weekly tick, capped at **±8% a week** plus market noise.' },
      { h: 'The market moves too' },
      { p: 'Every world has a **market index** — one shared sentiment number that multiplies every airline\'s valuation, drifting through bull and bear phases and levered to the fuel price. When fuel spikes, the whole sector re-rates down, so a rising share price can mean the market rose rather than that you did well, and a good quarter can still be swamped by a bad market.' },
      { h: 'How you are ranked' },
      { p: 'The world standings rank on **shareholder value per share** — your share price plus every dividend you have ever paid — not on market cap. Market cap measures how *big* you got, which rewards hoarding and punishes ever returning money to shareholders. Per-share value measures how much you created for each unit of ownership, so every capital decision below is a genuine trade-off.' },
      { warn: 'A **private** airline has no traded share price, so it is not ranked. Staying private is a legitimate way to play — no dilution, no rivals on your register — but it is not a way to win.' },
      { h: 'Your company' },
      { ul: [
        '**Go public** — from week 26, with a trading record behind you, sell a slice (10–35%) of the company to investors. The cash lands in your treasury; the shares are yours no longer. IPOs price at a **discount**, smaller the longer and more profitable your record.',
        '**Share offerings** — raise more later, up to **15% of your shares a game year**. The discount widens each time you go back to the market, and narrows if you have a record of returning capital.',
        '**Buybacks** — retire stock from the float. Cash leaves but the share count falls faster, so it lifts per-share value when your stock is cheap or your cash is sitting idle.',
        '**Dividends** — a standing policy, up to 60% of trailing-quarter profit, paid every 13 weeks. Only shares held *outside* your founder block are paid, so the cost scales with how much of yourself you have sold. Suspended automatically after a losing quarter — publicly.',
      ] },
      { tip: 'Idle cash is credited at a fraction of face value: the market does not reward a lazy balance sheet. Once you have run out of gates to take and aircraft to order, returning capital beats sitting on it — which is exactly when real airlines start paying dividends.' },
      { h: 'Trading rivals' },
      { p: 'You can **buy and sell shares in any listed rival**. Buys execute above the market price and sells below it (a 1% spread and 0.5% commission each way), plus **price impact**: a large order moves the price against itself in proportion to how much of the free float it represents, so a big stake cannot be accumulated at the marked price. Realized gains are taxed at **25%**.' },
      { h: 'There is a real counterparty' },
      { p: 'Your trades are not filled by thin air. Each world has a **float pool** of outside-investor cash and shares: your buys pay cash into it, your sells draw cash out of it, and IPOs and offerings are funded from it. It is finite. As it runs down, sellers get worse fills, and eventually the **equity window shuts** — you cannot raise capital because there is no money on the other side. It heals slowly over time.' },
      { h: 'Your portfolio' },
      { ul: [
        '**Unrealized gains** — holdings are marked to market weekly and sit on your balance sheet as investments.',
        '**Realized gains** — selling turns paper profit into cash, net of tax. Trading and dividend income show on the Finance page as **investment income**, below the line: they never inflate your operating profit or feed your own valuation.',
        '**Limits** — at most **20% of any one airline**, and total invested cost capped at **40% of your own market cap**. Minimum trade $100k.',
      ] },
      { h: 'Risk' },
      { warn: 'If an airline you hold leaves the world, the position is force-liquidated at a **25% haircut** to its last marked price. A cheap, struggling airline can be a bargain turnaround bet — or a write-off.' },
      { tip: 'Your own airline is not tradeable by you — your share price IS the scoreboard. The same fundamentals model prices everyone, so there is no pumping your valuation with loans or asset shuffles: only real performance, and real capital discipline, move it.' },
    ],
  },
  {
    id: 'finance',
    icon: '💰',
    title: 'Finance',
    blurb: 'P&L, loans and key ratios',
    blocks: [
      { p: 'Finance is your full profit-and-loss view: weekly revenue (including connecting feed and cargo), every cost line, and headline metrics like **RASK**, **yield** and your **break-even load factor**: the load factor needed to cover all costs at your current fare mix.' },
      { h: 'Loans' },
      { ul: [
        'Each loan product offers a **guaranteed amount** ($5M / $10M / $20M) available from day one; higher weekly revenue can unlock even more (revenue × a product multiplier).',
        '**Interest rates reflect your credit rating**: a healthier airline borrows more cheaply.',
        'Loan payments are **deducted automatically each week** before your cash updates, split into deductible interest and principal.',
        '**Early repayment** incurs a 2% penalty on the remaining principal.',
      ] },
      { h: 'Key ratios' },
      { p: 'The leverage ratio counts loans plus capitalised lease commitments, so it reflects your true obligations. Keep an eye on it, over-leveraging is the most common road to bankruptcy.' },
      { warn: 'Remember the two failure conditions: missing 3 loan payments, or 6 consecutive cash-negative weeks. Borrow to invest in growth that pays back, not to plug a structural loss.' },
    ],
  },
  {
    id: 'cargo',
    icon: '📦',
    title: 'Cargo & Freight',
    blurb: 'Earn from freight lanes',
    blocks: [
      { p: 'Beyond passengers, you can run dedicated **freight lanes** using freighter aircraft. Switch the Route Planner into freight mode to model a lane: pick origin and destination, choose a freighter type, and review the estimated freight economics before committing.' },
      { p: 'Cargo revenue shows up as its own line in Finance, so you can see exactly how much your freight operation contributes. It can diversify income and make use of routes where passenger demand alone is thin.' },
    ],
  },
  {
    id: 'objectives',
    icon: '🎯',
    title: 'Objectives & Progress',
    blurb: 'Goals that guide your growth',
    blocks: [
      { p: 'The game tracks **board objectives** that reward natural milestones as you grow. They\'re a useful checklist of what a healthy, expanding airline looks like.' },
      { p: 'Examples include: launch your first route (First Departure), achieve a profitable week (In the Black), operate 3+ then 10+ aircraft, serve 4+ airports and 5+ city pairs, string together profitable weeks, hit weekly revenue milestones ($500K, $1M, $2M), reach a 15%+ operating margin, and serve airports in 3+ countries (Going Global).' },
      { tip: 'Use objectives as soft goals, not a strict order. Chase the ones that fit your strategy and they\'ll fall into place as you expand.' },
    ],
  },
  {
    id: 'tips',
    icon: '💡',
    title: 'Tips & Survival',
    blurb: 'Stay solvent, grow smart',
    blocks: [
      { h: 'Cash discipline' },
      { ul: [
        'Always keep a buffer. Fuel spikes and random events can swing a profitable week into a loss.',
        'Idle aircraft and empty routes bleed cash, cut or fix them quickly.',
        'Borrow to fund growth that pays back, never to cover a route that structurally loses money.',
      ] },
      { h: 'Grow deliberately' },
      { ul: [
        'Right-size aircraft to routes; an over-large plane flies half-empty, a too-small one turns away demand.',
        'Build hub density before chasing far-flung routes, connections multiply the value of what you already fly.',
        'Differentiate clearly (Premium or Low-Cost). The undifferentiated middle is the toughest place to make money.',
      ] },
      { h: 'Read the market' },
      { ul: [
        'Check Competition before opening a contested route, undercutting a stronger rival can be a losing battle.',
        'Reputation and loyalty are slow to build but pay off everywhere; invest in them steadily, not in panic.',
      ] },
      { tip: 'You can reopen the quick tutorial any time with the ? button in the top bar. This wiki is here whenever you need the detail.' },
    ],
  },
];

// ─── Inline **bold** renderer ───────────────────────────────────────────────────
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: 'var(--text)', fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function Block({ block }) {
  if (block.h) {
    return (
      <h3 style={{
        fontSize: 15, fontWeight: 700, color: 'var(--text)',
        margin: '22px 0 8px', letterSpacing: '0.01em',
      }}>{block.h}</h3>
    );
  }
  if (block.p) {
    return (
      <p style={{ fontSize: 14, lineHeight: 1.75, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        {renderInline(block.p)}
      </p>
    );
  }
  if (block.ul) {
    return (
      <ul style={{ margin: '0 0 14px', paddingLeft: 0, listStyle: 'none' }}>
        {block.ul.map((item, i) => (
          <li key={i} style={{
            position: 'relative', paddingLeft: 20, marginBottom: 8,
            fontSize: 14, lineHeight: 1.7, color: 'var(--text-muted)',
          }}>
            <span style={{ position: 'absolute', left: 2, top: 1, color: 'var(--accent)' }}>›</span>
            {renderInline(item)}
          </li>
        ))}
      </ul>
    );
  }
  if (block.steps) {
    return (
      <ol style={{ margin: '0 0 14px', paddingLeft: 0, listStyle: 'none', counterReset: 'wiki-step' }}>
        {block.steps.map((item, i) => (
          <li key={i} style={{
            position: 'relative', paddingLeft: 34, marginBottom: 10,
            fontSize: 14, lineHeight: 1.7, color: 'var(--text-muted)',
          }}>
            <span style={{
              position: 'absolute', left: 0, top: 0,
              width: 22, height: 22, borderRadius: '50%',
              background: 'var(--accent-dim)', color: 'var(--accent)',
              border: '1px solid var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700,
            }}>{i + 1}</span>
            {renderInline(item)}
          </li>
        ))}
      </ol>
    );
  }
  if (block.tip) {
    return (
      <div style={{
        display: 'flex', gap: 10, padding: '12px 14px', margin: '0 0 14px',
        background: 'var(--accent-dim)', border: '1px solid var(--accent)',
        borderRadius: 10,
      }}>
        <span style={{ fontSize: 15, lineHeight: 1.4 }}><Glyph e="💡" /></span>
        <span style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--text)' }}>{renderInline(block.tip)}</span>
      </div>
    );
  }
  if (block.warn) {
    return (
      <div style={{
        display: 'flex', gap: 10, padding: '12px 14px', margin: '0 0 14px',
        background: 'rgba(255,93,108,0.10)', border: '1px solid var(--red)',
        borderRadius: 10,
      }}>
        <span style={{ fontSize: 15, lineHeight: 1.4 }}><Glyph e="⚠️" /></span>
        <span style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--text)' }}>{renderInline(block.warn)}</span>
      </div>
    );
  }
  return null;
}

export default function Wiki() {
  // Multiplayer (Headwinds): sections/blocks flagged soloOnly / remoteOnly /
  // solo / remote are filtered by mode. Solo renders exactly as before.
  const { remote } = useGame();
  const sections = useMemo(() => (
    WIKI
      .filter(s => (remote ? !s.soloOnly : !s.remoteOnly))
      .map(s => ({ ...s, blocks: s.blocks.filter(b => (remote ? b.solo !== true : b.remote !== true)) }))
  ), [remote]);

  const [activeId, setActiveId] = useState(sections[0].id);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter(s => {
      if (s.title.toLowerCase().includes(q) || s.blurb.toLowerCase().includes(q)) return true;
      return s.blocks.some(b => {
        const text = b.p || b.h || b.tip || b.warn || (b.ul || b.steps || []).join(' ') || '';
        return text.toLowerCase().includes(q);
      });
    });
  }, [query, sections]);

  // Keep the active section valid as the filter narrows results.
  const active = filtered.find(s => s.id === activeId) || filtered[0];

  return (
    <div className="page-content">
      <h2 className="page-title">Help & Wiki</h2>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 18px', lineHeight: 1.6 }}>
        Detailed how-to guides for every part of the game. Pick a topic, or search to jump to what you need.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 18, alignItems: 'start' }}>
        {/* ── Table of contents ── */}
        <div className="card" style={{ padding: 12, position: 'sticky', top: 12 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search the wiki…"
            style={{
              width: '100%', boxSizing: 'border-box', marginBottom: 10,
              padding: '8px 10px', fontSize: 13,
              background: 'var(--surface2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 8, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filtered.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-dim)', padding: '8px 6px' }}>
                No topics match “{query}”.
              </div>
            )}
            {filtered.map(s => {
              const isActive = active && s.id === active.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                    textAlign: 'left', cursor: 'pointer',
                    padding: '8px 10px', borderRadius: 8,
                    border: '1px solid', borderColor: isActive ? 'var(--accent)' : 'transparent',
                    background: isActive ? 'var(--accent-dim)' : 'transparent',
                    color: isActive ? 'var(--text)' : 'var(--text-muted)',
                    fontSize: 13, fontWeight: isActive ? 600 : 500,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  <span style={{ flexShrink: 0, display: 'inline-flex' }}><Glyph e={s.icon} size={15} /></span>
                  <span>{s.title}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Content pane ── */}
        <div className="card" style={{ padding: '24px 28px', minHeight: 400 }}>
          {active && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                <span style={{ lineHeight: 1, display: 'inline-flex', color: 'var(--accent)' }}><Glyph e={active.icon} size={28} /></span>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', lineHeight: 1.2 }}>
                    {active.title}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 2 }}>{active.blurb}</div>
                </div>
              </div>
              <div style={{ height: 1, background: 'var(--border)', margin: '16px 0 20px' }} />
              {active.blocks.map((b, i) => <Block key={i} block={b} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
