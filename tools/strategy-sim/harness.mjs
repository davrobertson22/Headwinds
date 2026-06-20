// ─────────────────────────────────────────────────────────────────────────────
// Headless strategy simulation harness
//
// Drives the REAL game engine (the gameReducer exported from store/GameContext.jsx)
// with scripted "bot" strategies, across many seeded Monte Carlo runs, and reports:
//   - % of runs that survive 2 years (week >= 104 without bankruptcy)
//   - % that survive 5 years   (week >= 260)
//   - % that WIN (acquire every competitor) within the horizon
//
// Determinism: the engine uses Math.random() for competitor sampling, events, fuel
// drift, and mechanical failures. We replace Math.random with a seeded PRNG per run
// so results are reproducible and strategies are compared on identical "worlds".
//
// Run via the bundled entry (tools/strategy-sim/run-bundled.mjs) which esbuild has
// pre-compiled (JSX/React stripped). This file is the pure logic.
// ─────────────────────────────────────────────────────────────────────────────

import { gameReducer } from '../../src/store/_engine.generated.mjs';
import { AIRPORTS } from '../../src/data/airports.js';
import { getAircraftType } from '../../src/data/aircraft.js';
import { baseCityPairDemand } from '../../src/utils/market.js';
import {
  routeDistanceKm, effectiveRangeKm, maxFrequency, referencePrice as simRefPrice,
} from '../../src/utils/simulation.js';

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── World setup helpers ──────────────────────────────────────────────────────
const AP_LIST = Array.isArray(AIRPORTS) ? AIRPORTS : Object.values(AIRPORTS);
const HUB = 'JFK';              // fixed hub: large US gateway, deep domestic demand
const HOME_COUNTRY = 'US';

// Candidate destinations: domestic airports ranked by REVENUE POTENTIAL
// (demand × reference fare). Long, dense routes earn far more per landing fee than
// short thin ones, so revenue potential — not raw demand — is what drives viability.
const DEST_CANDIDATES = AP_LIST
  .filter(a => a.country === HOME_COUNTRY && a.code !== HUB)
  .map(a => {
    const dist = routeDistanceKm(HUB, a.code);
    const demand = baseCityPairDemand(HUB, a.code);
    return { code: a.code, demand, dist, revPotential: demand * simRefPrice(HUB, a.code) };
  })
  .filter(a => a.demand > 0 && a.dist > 200)
  .sort((x, y) => y.revPotential - x.revPotential);

// Workhorse aircraft by mission. Narrow body for the bulk of the domestic network.
const WORKHORSE = 'a320ceo';    // 164 seats, 6150km range, $78k/wk lease
const REGIONAL  = 'a220100';    // 100 seats, cheaper for thinner routes

// ── Dispatch helper ──────────────────────────────────────────────────────────
function dispatch(state, action) { return gameReducer(state, action); }

// Grow the network: for each new route, lease ONE aircraft and immediately fly it
// (never leave an aircraft idle — idle airframes bleed ~$200k/wk in lease+labor).
// Adds gates as needed, picks the best unserved revenue-potential destination in range,
// flies at high frequency, and prices `priceMult`× the reference fare.
//
//   fleetTarget   stop growing once the network reaches this many routes
//   addPerCall    max new routes to add this week (throttles capital burn / pacing)
//   typeId        aircraft to lease for new routes
//   priceMult     economy fare = reference × priceMult (demand ≫ capacity, so price high)
//   freqCap       max weekly frequency per route (block-hours permitting)
//   minCash       only grow while cash stays above this buffer
function growNetwork(state, { fleetTarget, addPerCall, typeId, priceMult, freqCap = 14, minCash = 1_000_000 }) {
  const served = new Set();
  for (const r of state.routes) { served.add(r.origin); served.add(r.destination); }
  const type = getAircraftType(typeId);
  if (!type) return state;
  const range = effectiveRangeKm({}, type);

  let added = 0;
  for (const dest of DEST_CANDIDATES) {
    if (state.routes.length >= fleetTarget || added >= addPerCall) break;
    if (state.cash < minCash) break;
    if (served.has(dest.code)) continue;
    if (dest.dist > range) continue;

    // lease the airframe for this route
    const before = state.fleet.length;
    state = dispatch(state, { type: 'LEASE_AIRCRAFT', typeId });
    if (state.fleet.length === before) break;
    const ac = state.fleet[state.fleet.length - 1];

    // gates: one at the destination, enough at the hub to cover slots
    if (!(state.gates?.[dest.code] > 0)) state = dispatch(state, { type: 'ADD_GATE', airportCode: dest.code });
    const freq = Math.min(freqCap, Math.max(1, maxFrequency(dest.dist, type)));
    let guard = 0;
    while (true) {
      const hubSlots = state.routes.filter(r => r.origin === HUB || r.destination === HUB)
        .reduce((s, r) => s + r.weeklyFrequency, 0);
      if (hubSlots + freq <= (state.gates?.[HUB] ?? 0) * 50 || guard++ > 50) break;
      state = dispatch(state, { type: 'ADD_GATE', airportCode: HUB });
    }

    const price = Math.max(1, Math.round(simRefPrice(HUB, dest.code) * priceMult));
    const rbefore = state.routes.length;
    state = dispatch(state, {
      type: 'ADD_ROUTE', origin: HUB, destination: dest.code,
      aircraftId: ac.id, weeklyFrequency: freq, ticketPrice: price,
    });
    if (state.routes.length > rbefore) { served.add(dest.code); added++; }
  }
  return state;
}

export { growNetwork, STRATEGIES, dispatch, DEST_CANDIDATES };
function fleetCount(state) { return state.fleet.filter(a => a.status !== 'retired').length; }

// ── Strategy bots ────────────────────────────────────────────────────────────
// Each bot receives the current state at the start of a week (before ADVANCE_WEEK)
// and returns the state after taking its actions.

// Destinations ranked by RAW demand (what a new player intuitively picks — the
// obvious big-traffic city pairs). Excludes same-metro / ultra-short hops (<250km,
// e.g. JFK→EWR/LGA) that no real player would launch as a first route.
const DEST_BY_DEMAND = [...DEST_CANDIDATES]
  .filter(d => d.dist >= 250)
  .sort((a, b) => b.demand - a.demand);

const STRATEGIES = {
  // 0. Casual / struggling player — the profile that's going bankrupt. Picks the
  //    obvious high-demand (short, low-fare) routes, prices at the reference fare
  //    (doesn't know to mark up), flies one daily frequency, keeps a thin buffer,
  //    and does no marketing/loyalty/hub investment. Represents an ordinary player.
  casual(state) {
    const TARGET_FLEET = 5;
    if (fleetCount(state) < TARGET_FLEET && state.cash > 1_500_000) {
      // grow only when there's an unserved route to fly, then open it immediately
      const served = new Set();
      for (const r of state.routes) { served.add(r.origin); served.add(r.destination); }
      const type = getAircraftType(WORKHORSE);
      const range = effectiveRangeKm({}, type);
      const dest = DEST_BY_DEMAND.find(d => !served.has(d.code) && d.dist <= range);
      if (dest) {
        state = dispatch(state, { type: 'LEASE_AIRCRAFT', typeId: WORKHORSE });
        const ac = state.fleet[state.fleet.length - 1];
        if (!(state.gates?.[dest.code] > 0)) state = dispatch(state, { type: 'ADD_GATE', airportCode: dest.code });
        let guard = 0;
        while (true) {
          const hubSlots = state.routes.filter(r => r.origin === HUB || r.destination === HUB)
            .reduce((s, r) => s + r.weeklyFrequency, 0);
          if (hubSlots + 7 <= (state.gates?.[HUB] ?? 0) * 50 || guard++ > 50) break;
          state = dispatch(state, { type: 'ADD_GATE', airportCode: HUB });
        }
        const price = Math.max(1, Math.round(simRefPrice(HUB, dest.code) * 1.0)); // at reference
        state = dispatch(state, {
          type: 'ADD_ROUTE', origin: HUB, destination: dest.code,
          aircraftId: ac.id, weeklyFrequency: 7, ticketPrice: price,
        });
      }
    }
    return state;
  },

  // 1. Lean & cautious — a small, premium-priced network and a deliberately large
  //    cash buffer. No extra debt beyond the mandatory startup loan. Grows slowly
  //    (one route at a time) and stops early. Optimises for survival over scale.
  lean(state) {
    state = growNetwork(state, {
      fleetTarget: 6, addPerCall: 1, typeId: WORKHORSE,
      priceMult: 2.0, freqCap: 14, minCash: 3_000_000,
    });
    return state;
  },

  // 2. Aggressive expansion — a big growth loan up front, then add routes fast
  //    (3/week) to a large network, priced moderately to keep volume high, with
  //    ongoing marketing. High burn early, big network late.
  aggressive(state) {
    if (!state._tookLoan && state.year === 1 && state.week >= 2) {
      state = dispatch(state, { type: 'TAKE_LOAN', principal: 20_000_000, interestRate: 0.10, termWeeks: 312 });
      state = { ...state, _tookLoan: true };
    }
    state = growNetwork(state, {
      fleetTarget: 45, addPerCall: 3, typeId: WORKHORSE,
      priceMult: 1.55, freqCap: 14, minCash: 3_500_000,
    });
    if (state.routes.length >= 3 && (state.marketingBudget ?? 0) < 60_000 && state.cash > 4_000_000) {
      state = dispatch(state, { type: 'SET_MARKETING_BUDGET', amount: 60_000 });
    }
    return state;
  },

  // 3. Hub-focused — a medium network all through JFK, then invest the profits back
  //    into the hub: build gates to the tier-2/3 thresholds (15/20), upgrade the hub
  //    for its quality + connecting-traffic bonuses, and run loyalty + marketing.
  hub(state) {
    state = growNetwork(state, {
      fleetTarget: 22, addPerCall: 2, typeId: WORKHORSE,
      priceMult: 1.7, freqCap: 14, minCash: 2_000_000,
    });
    const hubGates = state.gates?.[HUB] ?? 0;
    const hubTier  = state.hubs?.[HUB]?.tier ?? 1;
    // Build a couple of extra hub gates beyond what routes strictly need, to reach
    // the tier thresholds (15 for tier 2, 20 for tier 3).
    const gateTarget = hubTier >= 2 ? 20 : 15;
    if (hubGates < gateTarget && state.cash > 5_000_000) {
      state = dispatch(state, { type: 'ADD_GATE', airportCode: HUB });
    }
    const g = state.gates?.[HUB] ?? 0;
    if (hubTier < 2 && g >= 15 && state.cash > 4_000_000) {
      state = dispatch(state, { type: 'UPGRADE_HUB', airportCode: HUB });
    } else if (hubTier === 2 && g >= 20 && state.cash > 8_000_000) {
      state = dispatch(state, { type: 'UPGRADE_HUB', airportCode: HUB });
    }
    if (state.routes.length >= 5 && state.cash > 4_000_000) {
      if ((state.loyalty?.weeklyInvestment ?? 0) < 60_000)
        state = dispatch(state, { type: 'SET_LOYALTY_INVESTMENT', amount: 60_000 });
      if ((state.marketingBudget ?? 0) < 40_000)
        state = dispatch(state, { type: 'SET_MARKETING_BUDGET', amount: 40_000 });
    }
    return state;
  },

  // 4. Acquisition / win-the-game — build a solid profitable base, then plough cash
  //    into buying out rivals (cheapest first; cost = target.marketCap × 1.25, and you
  //    inherit their cash, fleet, routes, and gates). Keep acquiring every week any
  //    rival you can afford while holding a safety buffer — the only path to victory.
  acquire(state) {
    // Take a growth loan up front, build the biggest cash engine we can (a large,
    // high-priced network), then spend almost everything on buyouts. Acquired rivals
    // bring cash + routes that compound the cash engine further.
    if (!state._tookLoan && state.year === 1 && state.week >= 2) {
      state = dispatch(state, { type: 'TAKE_LOAN', principal: 20_000_000, interestRate: 0.10, termWeeks: 312 });
      state = { ...state, _tookLoan: true };
    }
    // Grow only while cash is comfortably positive — this throttles the early ramp
    // so immature routes don't all burn cash at once, while still reaching a large
    // base over time. priceMult 2.0 maximises the cash engine for buyouts.
    state = growNetwork(state, {
      fleetTarget: 45, addPerCall: 2, typeId: WORKHORSE,
      priceMult: 2.0, freqCap: 14, minCash: 5_000_000,
    });
    if (state.routes.length >= 20) {
      // buy as many affordable rivals as possible this week, cheapest first,
      // keeping a $2M operating buffer.
      let guard = 0;
      while (guard++ < 20) {
        const comps = (state.competitors ?? [])
          .filter(c => c.marketCap != null && c.marketCap > 0)
          .sort((a, b) => a.marketCap - b.marketCap);
        if (comps.length === 0) break;
        const target = comps[0];
        const cost = Math.round(target.marketCap * 1.25);
        if (state.cash - cost < 3_000_000) break;
        const before = (state.competitors ?? []).length;
        state = dispatch(state, { type: 'ACQUIRE_COMPETITOR', competitorId: target.id });
        if ((state.competitors ?? []).length >= before) break; // didn't take — stop
      }
    }
    return state;
  },
};

// ── Single game ──────────────────────────────────────────────────────────────
export function playGame(strategyName, seed, horizonWeeks) {
  const rng = makeRng(seed);
  const origRandom = Math.random;
  Math.random = rng;
  try {
    let state = gameReducer(undefined, { type: 'START_GAME', airlineName: 'SimAir', hub: HUB, enableObjectives: true });
    // gameReducer(undefined, ...) won't work (state undefined); START_GAME ignores prior state, but
    // switch reads state only inside cases. START_GAME builds from freshState, so pass {}.
    const bot = STRATEGIES[strategyName];

    let survived2 = false, survived5 = false, won = false, bankruptWeek = null;

    for (let w = 1; w <= horizonWeeks; w++) {
      // bot acts, then time advances
      state = bot(state);
      state = dispatch(state, { type: 'ADVANCE_WEEK' });

      const absWeek = (state.year - 1) * 52 + state.week - 1; // weeks elapsed
      if (state.gameWon) { won = true; if (absWeek >= 104) survived2 = true; if (absWeek >= 260) survived5 = true; break; }
      if (state.phase === 'bankrupt') { bankruptWeek = absWeek; break; }
      if (absWeek >= 104) survived2 = true;
      if (absWeek >= 260) survived5 = true;
    }
    // if we ran the full horizon without bankruptcy, both survival flags are set above
    return { survived2, survived5, won, bankruptWeek, finalCash: state.cash, routes: state.routes.length };
  } finally {
    Math.random = origRandom;
  }
}

// ── Monte Carlo over a strategy ───────────────────────────────────────────────
export function runStrategy(strategyName, { runs, horizonWeeks, baseSeed = 1000 }) {
  let s2 = 0, s5 = 0, wins = 0;
  const deathWeeks = [];
  for (let i = 0; i < runs; i++) {
    const r = playGame(strategyName, baseSeed + i, horizonWeeks);
    if (r.survived2) s2++;
    if (r.survived5) s5++;
    if (r.won) wins++;
    if (r.bankruptWeek != null) deathWeeks.push(r.bankruptWeek);
  }
  const medianDeath = deathWeeks.length
    ? deathWeeks.sort((a, b) => a - b)[Math.floor(deathWeeks.length / 2)] : null;
  return {
    strategy: strategyName, runs,
    survive2yr: s2 / runs, survive5yr: s5 / runs, winRate: wins / runs,
    bankruptcies: deathWeeks.length, medianDeathWeek: medianDeath,
  };
}
