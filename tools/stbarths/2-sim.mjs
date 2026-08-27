// ─────────────────────────────────────────────────────────────────────────────
// "Make an airline whose only hub is St Barths and we can see how long it lasts"
//
// Drives the REAL engine through the REAL multiplayer tick shape:
//   - state seeded by the server's own seedAirlineState() (so NWR flags, fare
//     index, calendar rebase and fuel backfill are exactly a joiner's)
//   - weeks advanced with the same ADVANCE_WEEK payload tickService sends
//     (world fuel index, world market index, shared world events)
//   - every player action goes through ALLOWED_PLAYER_ACTIONS-legal types, and
//     route opens are pre-checked with addRouteBlockReason so a refusal is
//     COUNTED, never silently swallowed.
//
// Usage: node 2-sim.mjs <scenario> <startSeed> <runs> <horizonWeeks> [outFile]
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync } from 'node:fs';
import { gameReducer, addRouteBlockReason } from '../../packages/engine/src/reducer.mjs';
import { seedAirlineState } from '../../apps/headwinds-server/src/lib/worldService.mjs';
import { worldFuelIndex, worldMarketIndex } from '../../apps/headwinds-server/src/lib/worldEconomy.mjs';
import { tickEvents, rollEvents } from '../../packages/engine/src/data/events.js';
import { AIRPORTS, getAirport } from '../../packages/engine/src/data/airports.js';
import { getAircraftType } from '../../packages/engine/src/data/aircraft.js';
import { baseCityPairDemand, distanceKm } from '../../packages/engine/src/utils/market.js';
import { checkRouteRestrictions } from '../../packages/engine/src/data/airportRestrictions.js';
import {
  referencePrice, routeDistanceKm, maxFrequency, effectiveRangeKm,
  MAX_WEEKLY_BLOCK_HOURS, NWR_MAX_WEEKLY_BLOCK_HOURS,
} from '../../packages/engine/src/utils/simulation.js';

const AP = Array.isArray(AIRPORTS) ? AIRPORTS : Object.values(AIRPORTS);

// ── Destination lists, per (hub, type) ───────────────────────────────────────
// Legal + in range + non-zero demand, ranked by revenue potential. Cached.
const destCache = new Map();
function destinations(hub, typeId, maxDist = 0, rankBy = 'rev') {
  const key = `${hub}|${typeId}|${maxDist}|${rankBy}`;
  if (destCache.has(key)) return destCache.get(key);
  const t = getAircraftType(typeId);
  const h = getAirport(hub);
  const range = effectiveRangeKm({}, t);
  const list = AP.filter(a => a.code !== hub)
    .map(a => {
      const dist = Math.round(distanceKm(h, a));
      return { code: a.code, dist, demand: baseCityPairDemand(hub, a.code) };
    })
    .filter(d => d.dist > 100 && d.dist <= range && d.demand > 0)
    .filter(d => !maxDist || d.dist <= maxDist)
    .filter(d => !checkRouteRestrictions(hub, d.code, d.dist, 7, t.category, { aircraftType: t }))
    .map(d => ({ ...d, revPotential: d.demand * referencePrice(hub, d.code) }))
    .sort((x, y) => rankBy === 'demand' ? y.demand - x.demand : y.revPotential - x.revPotential);
  destCache.set(key, list);
  return list;
}

// ── Scenarios ────────────────────────────────────────────────────────────────
// naive:  what a first-time player does — a daily round trip, fare at reference,
//         a small fleet, no marketing. (The profile the audit found dying.)
// max:    the ceiling — every airframe at the block-hour limit, fare marked up,
//         grow into every market cash allows.
const SCENARIOS = {
  'sbh-naive':   { hub: 'SBH', typeId: 'dhc6',        fleetTarget: 4,  freq: 7,     priceMult: 1.0, nwr: true },
  'sbh-max':     { hub: 'SBH', typeId: 'dhc6',        fleetTarget: 20, freq: 'max', priceMult: 1.7, nwr: true },
  'sbh-islander':{ hub: 'SBH', typeId: 'bn2islander', fleetTarget: 20, freq: 'max', priceMult: 1.7, nwr: true },
  'sbh-max-buy': { hub: 'SBH', typeId: 'dhc6',        fleetTarget: 20, freq: 'max', priceMult: 1.7, nwr: true, own: true },
  // control A — same tiny aircraft, a REAL Caribbean hub. Isolates gauge from hub.
  'sju-naive':   { hub: 'SJU', typeId: 'dhc6',        fleetTarget: 4,  freq: 7,     priceMult: 1.0, nwr: true },
  'sju-max':     { hub: 'SJU', typeId: 'dhc6',        fleetTarget: 20, freq: 'max', priceMult: 1.7, nwr: true },
  // control B — a "standard airline". Same world, same rules, narrowbody.
  'sju-narrow':  { hub: 'SJU', typeId: 'a320ceo',     fleetTarget: 12, freq: 'max', priceMult: 1.7, nwr: true },
  'jfk-narrow':  { hub: 'JFK', typeId: 'a320ceo',     fleetTarget: 12, freq: 'max', priceMult: 1.7, nwr: true },
  'jfk-naive':   { hub: 'JFK', typeId: 'a320ceo',     fleetTarget: 4,  freq: 7,     priceMult: 1.0, nwr: true },
  // legacy-overhead comparison for the headline case
  'sbh-max-legacy': { hub: 'SBH', typeId: 'dhc6',     fleetTarget: 20, freq: 'max', priceMult: 1.7, nwr: false },
  // ── best-effort play: demand-matched schedules, prudent growth, marketing ──
  'sbh-best':    { hub: 'SBH', typeId: 'dhc6',    fleetTarget: 12, freq: 'fit', priceMult: 0.8, nwr: true, prudent: true, marketing: 20_000 },
  'sju-best':    { hub: 'SJU', typeId: 'dhc6',    fleetTarget: 12, freq: 'fit', priceMult: 0.8, nwr: true, prudent: true, marketing: 20_000 },
  'sju-narrow-best': { hub: 'SJU', typeId: 'a320ceo', fleetTarget: 12, freq: 'fit', priceMult: 1.0, nwr: true, prudent: true, marketing: 40_000 },
  'jfk-narrow-best': { hub: 'JFK', typeId: 'a320ceo', fleetTarget: 12, freq: 'fit', priceMult: 1.0, nwr: true, prudent: true, marketing: 40_000 },
  'jfk-dhc6':    { hub: 'JFK', typeId: 'dhc6',    fleetTarget: 12, freq: 'fit', priceMult: 1.0, nwr: true, prudent: true, marketing: 20_000, maxDist: 1500, rankBy: 'demand' },
  'sju-narrow-short': { hub: 'SJU', typeId: 'a320ceo', fleetTarget: 12, freq: 'fit', priceMult: 1.0, nwr: true, prudent: true, marketing: 40_000, maxDist: 2500, rankBy: 'demand' },
  'sbh-spread':  { hub: 'SBH', typeId: 'dhc6', fleetTarget: 6, freq: 'fit', priceMult: 1.0, nwr: true, prudent: true, marketing: 20_000, spread: true, captureShare: 0.35 },
  // ── harness validation: reproduce the live profitable small operators ──
  'evn-cv580':   { hub: 'EVN', typeId: 'cv580', fleetTarget: 3, freq: 'fit', priceMult: 1.0, nwr: true, prudent: false, marketing: 20_000, spread: true, captureShare: 0.35, maxDist: 2500, rankBy: 'demand' },
  'svo-saab':    { hub: 'SVO', typeId: 'saab2000', fleetTarget: 2, freq: 'max', priceMult: 1.0, nwr: true, prudent: false, marketing: 20_000, maxDist: 1200, rankBy: 'demand' },
  'sbh-best-legacy': { hub: 'SBH', typeId: 'dhc6', fleetTarget: 12, freq: 'fit', priceMult: 0.8, nwr: false, prudent: true, marketing: 20_000 },
};

function activeFleet(state) { return state.fleet.filter(a => a.status !== 'retired'); }

// One week of player decisions. Returns { state, refusals }.
function act(state, cfg, tally) {
  const capHours = cfg.nwr ? NWR_MAX_WEEKLY_BLOCK_HOURS : MAX_WEEKLY_BLOCK_HOURS;
  const type = getAircraftType(cfg.typeId);
  const dests = destinations(cfg.hub, cfg.typeId, cfg.maxDist ?? 0, cfg.rankBy ?? 'rev');

  // 1. Order an airframe when we have an unserved market, room to grow and cash.
  const pending = (state.pendingOrders ?? []).reduce((s, o) => s + (o.quantity ?? 1), 0);
  const fleetNow = activeFleet(state).length + pending;
  const served = new Set(state.routes.map(r => (r.origin === cfg.hub ? r.destination : r.origin)));
  const nextDest = dests.find(d => !served.has(d.code));
  const buffer = cfg.own ? 3_000_000 : 1_200_000;
  const idle = activeFleet(state).filter(a => !state.routes.some(r => r.aircraftId === a.id)).length;
  const fh = state.financialHistory ?? [];
  const lastProfit = fh.length ? (fh[fh.length - 1].profit ?? 0) : 0;
  const prudentOk = !cfg.prudent || fh.length < 6 || lastProfit > 0;
  if (nextDest && prudentOk && idle === 0 && pending === 0 && fleetNow < cfg.fleetTarget && state.cash > buffer) {
    const before = (state.pendingOrders ?? []).length + state.fleet.length;
    state = gameReducer(state, {
      type: 'ORDER_AIRCRAFT', typeId: cfg.typeId, quantity: 1,
      ownershipType: cfg.own ? 'owned' : 'lease',
    });
    if ((state.pendingOrders ?? []).length + state.fleet.length === before) tally.orderRefused++;
  }

  // 2. Put every under-used airframe to work. In 'spread' mode an aircraft keeps
  //    taking on further markets until its block hours are gone — the way a real
  //    small operator uses one airframe across several thin routes — instead of
  //    being parked on a single route it cannot fill.
  const perAircraft = cfg.spread ? 8 : 1;
  for (const ac of activeFleet(state)) {
   for (let slot = 0; slot < perAircraft; slot++) {
    const mine = state.routes.filter(r => r.aircraftId === ac.id).length;
    if (mine > slot) continue;
    if (mine >= perAircraft) break;
    if (!cfg.spread && mine >= 1) break;
    const servedNow = new Set(state.routes.map(r => (r.origin === cfg.hub ? r.destination : r.origin)));
    const dest = dests.find(d => !servedNow.has(d.code));
    if (!dest) break;
    const capF = Math.max(1, maxFrequency(dest.dist, type, capHours));
    // 'fit': size the schedule to the share of the market a new entrant can
    // realistically win, instead of flying the airframe into the block-hour
    // ceiling and burning fuel on empty seats.
    const freq = cfg.freq === 'max' ? capF
      : cfg.freq === 'fit'
        ? Math.max(1, Math.min(capF, Math.ceil((dest.demand * (cfg.captureShare ?? 0.15)) / (type.seats * 0.75))))
        : cfg.freq;
    // gates: one at the destination, enough at the hub for the slots
    if (!(state.gates?.[dest.code] > 0)) state = gameReducer(state, { type: 'ADD_GATE', airportCode: dest.code });
    let guard = 0;
    while (guard++ < 60) {
      const hubSlots = state.routes.filter(r => r.origin === cfg.hub || r.destination === cfg.hub)
        .reduce((s, r) => s + r.weeklyFrequency, 0);
      if (hubSlots + freq <= (state.gates?.[cfg.hub] ?? 0) * 50) break;
      const g0 = state.gates?.[cfg.hub] ?? 0;
      state = gameReducer(state, { type: 'ADD_GATE', airportCode: cfg.hub });
      if ((state.gates?.[cfg.hub] ?? 0) === g0) break;
    }
    const price = Math.max(1, Math.round(referencePrice(cfg.hub, dest.code) * cfg.priceMult));
    const action = {
      type: 'ADD_ROUTE', origin: cfg.hub, destination: dest.code,
      aircraftId: ac.id, weeklyFrequency: freq, ticketPrice: price,
    };
    // Never let a refusal pass silently — that is exactly the bug class that
    // produced 22 airlines with $0 lifetime revenue in the live data.
    const block = addRouteBlockReason(state, action);
    if (block) {
      tally.routeRefused++;
      const rk = block.short ?? block.reason ?? block.kind ?? JSON.stringify(block).slice(0, 60);
      tally.reasons[rk] = (tally.reasons[rk] ?? 0) + 1;
      break;
    }
    const rBefore = state.routes.length;
    state = gameReducer(state, action);
    if (state.routes.length === rBefore) { tally.routeSilent++; break; }
   }
  }
  // A competent player markets. Awareness starts at 5/100 and gates demand.
  if (cfg.marketing && state.routes.length >= 1 && state.cash > 2_000_000
      && (state.marketingBudget ?? 0) < cfg.marketing) {
    state = gameReducer(state, { type: 'SET_MARKETING_BUDGET', amount: cfg.marketing });
  }
  return state;
}

function playOne(scenario, seed, horizon) {
  const cfg = SCENARIOS[scenario];
  const world = {
    id: `sim-${scenario}-${seed}`,
    worldSeed: `sim-${scenario}-${seed}`,
    currentYear: 1, currentWeek: 1,
    tickConfig: {
      startingCapital: 15_000_000,
      demandMultiplier: 1,
      ...(cfg.nwr ? { newWorldRestrictions: true } : {}),
      // Bench knob: move the whole fare ladder for this world. Used to SIZE the
      // yield lever, not as a proposal — see 4-rebalance.mjs.
      ...(process.env.FARE_INDEX ? { fareIndex: parseFloat(process.env.FARE_INDEX) } : {}),
    },
  };
  let state = seedAirlineState(world, { airlineName: 'Gustavia Air', hub: cfg.hub });
  const tally = { orderRefused: 0, routeRefused: 0, routeSilent: 0, reasons: {} };

  let worldEvents = [];
  let bankruptWeek = null, peakCash = state.cash, firstProfitWeek = null;
  let profitableWeeks = 0, revenueWeeks = 0;
  const cashTrace = [];
  const weekly = [];

  for (let w = 1; w <= horizon; w++) {
    state = act(state, cfg, tally);
    const fuel = worldFuelIndex(world.worldSeed, w);
    const mkt  = worldMarketIndex(world.worldSeed, w);
    const { updated } = tickEvents(worldEvents);
    worldEvents = [...updated, ...rollEvents(updated, { multiplayer: true })];
    state = gameReducer(state, {
      type: 'ADVANCE_WEEK', worldFuelIndex: fuel, worldEvents,
      valuationNoise: 0, marketIndex: mkt, incomingDividends: 0,
    });
    const fh = state.financialHistory ?? [];
    const rep = fh[fh.length - 1];
    if (rep) {
      if ((rep.revenue ?? 0) > 0) revenueWeeks++;
      const net = rep.profit ?? null;
      if (net != null && net > 0) { profitableWeeks++; if (firstProfitWeek == null) firstProfitWeek = w; }
      weekly.push({ w, rev: Math.round(rep.revenue ?? 0), profit: Math.round(rep.profit ?? 0),
        hq: Math.round(state.lastReport?.totalHQCost ?? 0), cost: Math.round(rep.totalCost ?? 0) });
    }
    peakCash = Math.max(peakCash, state.cash);
    if (w % 13 === 0) cashTrace.push(Math.round(state.cash));
    if (process.env.VERBOSE && seed === 1) {
      const R = state.lastReport ?? {};
      const m = (x) => '$' + Math.round(x ?? 0).toLocaleString();
      console.error(`w${String(w).padStart(3)} fl ${activeFleet(state).length} rt ${state.routes.length} cash ${m(state.cash).padStart(13)} rev ${m(rep?.revenue).padStart(11)} pax ${Math.round(R.totalPassengers ?? 0)} cost ${m(rep?.totalCost).padStart(11)} profit ${m(rep?.profit).padStart(11)} | fuel ${m(R.totalFuel)} crew ${m(R.totalCrew)} labor ${m(R.totalLaborCosts)} lease ${m(R.totalLeases)} maint ${m(R.totalMaintenance)} gates ${m(R.totalGateFees)} HQ ${m(R.totalHQCost)} ins ${m(R.totalInsurance)} hub ${m(R.totalHubInvestment)}`);
    }
    if (state.phase === 'bankrupt') { bankruptWeek = w; break; }
  }

  const last = weekly[weekly.length - 1] ?? {};
  const mid  = weekly[Math.floor(weekly.length / 2)] ?? {};
  return {
    scenario, seed, bankruptWeek,
    survived: bankruptWeek == null,
    finalCash: Math.round(state.cash), peakCash: Math.round(peakCash),
    routes: state.routes.length, fleet: activeFleet(state).length,
    firstProfitWeek, profitableWeeks, revenueWeeks,
    lastRevenue: last.rev ?? 0, lastNet: last.profit ?? 0, lastHQ: last.hq ?? 0,
    lastCost: last.cost ?? 0,
    midRevenue: mid.rev ?? 0, midNet: mid.profit ?? 0, midHQ: mid.hq ?? 0,
    matureRevenue: (weekly.find(x => x.w === 26) ?? {}).rev ?? 0,
    matureNet: (weekly.find(x => x.w === 26) ?? {}).profit ?? 0,
    matureHQ: (weekly.find(x => x.w === 26) ?? {}).hq ?? 0,
    tally, cashTrace,
  };
}

const [scenario, seedS = '1', runsS = '10', horizonS = '104', priceS = '', fleetS = '', outFile] = process.argv.slice(2);
if (priceS) SCENARIOS[scenario].priceMult = parseFloat(priceS);
if (fleetS) SCENARIOS[scenario].fleetTarget = parseInt(fleetS, 10);
if (process.env.CAPTURE) SCENARIOS[scenario].captureShare = parseFloat(process.env.CAPTURE);
if (process.env.FREQ) SCENARIOS[scenario].freq = /^\d+$/.test(process.env.FREQ) ? parseInt(process.env.FREQ,10) : process.env.FREQ;
if (process.env.PRUDENT === '0') SCENARIOS[scenario].prudent = false;
if (!SCENARIOS[scenario]) {
  console.error('scenarios:', Object.keys(SCENARIOS).join(', '));
  process.exit(1);
}
const startSeed = parseInt(seedS, 10), runs = parseInt(runsS, 10), horizon = parseInt(horizonS, 10);
const results = [];
for (let i = 0; i < runs; i++) results.push(playOne(scenario, startSeed + i, horizon));

const deaths = results.filter(r => !r.survived).map(r => r.bankruptWeek).sort((a, b) => a - b);
const summary = {
  scenario, priceMult: SCENARIOS[scenario].priceMult, fleetTarget: SCENARIOS[scenario].fleetTarget, runs, horizon,
  survivalRate: +(results.filter(r => r.survived).length / runs).toFixed(3),
  deaths: deaths.length,
  medianDeathWeek: deaths.length ? deaths[Math.floor(deaths.length / 2)] : null,
  earliestDeath: deaths[0] ?? null,
  everProfitable: results.filter(r => r.firstProfitWeek != null).length,
  medianRoutes: results.map(r => r.routes).sort((a,b)=>a-b)[Math.floor(runs/2)],
  medianFleet:  results.map(r => r.fleet).sort((a,b)=>a-b)[Math.floor(runs/2)],
  medianLastRevenue: results.map(r => r.lastRevenue).sort((a,b)=>a-b)[Math.floor(runs/2)],
  medianLastNet: results.map(r => r.lastNet).sort((a,b)=>a-b)[Math.floor(runs/2)],
  medianLastHQ: results.map(r => r.lastHQ).sort((a,b)=>a-b)[Math.floor(runs/2)],
  routeRefusals: results.reduce((s,r)=>s+r.tally.routeRefused,0),
  silentRouteFailures: results.reduce((s,r)=>s+r.tally.routeSilent,0),
  orderRefusals: results.reduce((s,r)=>s+r.tally.orderRefused,0),
  refusalReasons: results.reduce((acc,r)=>{for(const[k,v]of Object.entries(r.tally.reasons))acc[k]=(acc[k]??0)+v;return acc;},{}),
  medianMatureRevenue: results.map(r=>r.matureRevenue).sort((a,b)=>a-b)[Math.floor(runs/2)],
  medianMatureNet: results.map(r=>r.matureNet).sort((a,b)=>a-b)[Math.floor(runs/2)],
  medianMatureHQ: results.map(r=>r.matureHQ).sort((a,b)=>a-b)[Math.floor(runs/2)],
  hqPctOfRev: null,
  sampleTrace: results[0].cashTrace,
};
console.log(JSON.stringify(summary, null, 1));
if (outFile) appendFileSync(outFile, JSON.stringify({ summary, results }) + '\n');
