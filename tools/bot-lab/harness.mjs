// Bot lab harness — worlds of bot-run airlines, run through the real engine.
//
// Design: claude/background-competitors-plan.md §10 phase 1. This is the lab the
// airline bot (packages/engine/src/models/airlineBot.js) is developed and
// measured in. It is NOT the server's runner: nothing here touches a database.
// What it shares with production is everything that decides the numbers:
//
//   • airlines are founded with the server's own seedAirlineState();
//   • every bot action goes through guardDecision() and then the reducer, the
//     pair the decisions route runs;
//   • rival views come from buildWorldRivalViews() over a stub of the few tables
//     it reads, so bots see each other exactly as players see rivals;
//   • the week is the tick's own ADVANCE_WEEK with the world's fuel, market and
//     crack indices and the same per-world stamps tickService applies.
//
// Randomness is seeded per (week, airline), so two runs of the same lab agree
// to the dollar and a changed rule is the only difference between two reports.
//
// Imported by tools/bot-lab.mjs (the report) and tools/airline-bot-test.mjs.

import { performance } from 'node:perf_hooks';

globalThis.window ??= { matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
process.env.DATABASE_URL ??= 'postgresql://lab:lab@localhost:5432/lab';   // never dialled: the pool opens on first query

const { gameReducer, leaseDenial, addRouteBlockReason } = await import('../../packages/engine/src/reducer.mjs');
const { runBotTurn, newBotMemory, botStats } = await import('../../packages/engine/src/models/airlineBot.js');
const { AIRPORTS } = await import('../../packages/engine/src/data/airports.js');
const { COMPETITOR_AIRLINES } = await import('../../packages/engine/src/models/demand.js');
const { collectWorldService, advanceMarketDevPairs } = await import('../../packages/engine/src/models/marketDev.js');
const { applyScheduleTrimMigration, weekToGameDate } = await import('../../packages/engine/src/utils/simulation.js');
const { isDemandModel } = await import('../../packages/engine/src/utils/market.js');
const { netProfitOf } = await import('../../packages/engine/src/utils/standings.js');
const { buildWorldRivalViews, withRivals, stripRivals } = await import('../../apps/headwinds-server/src/lib/humanRivals.mjs');
const { seedAirlineState } = await import('../../apps/headwinds-server/src/lib/worldService.mjs');
const { guardDecision } = await import('../../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { rivalItinerariesOf, fuelOpsVOf, eventRulesOfWorld } = await import('../../apps/headwinds-server/src/lib/worldConfig.mjs');
const { worldFuelIndex, worldMarketIndex, worldCrackIndex } = await import('../../apps/headwinds-server/src/lib/worldEconomy.mjs');

/** World rule sets, modelled on worlds that have really run. */
export const LAB_WORLDS = {
  // Cobalt Meridian: the original rules.
  classic:  { startingCapital: 15_000_000, demandMultiplier: 1 },
  // 737 MAX Effort without its aircraft rule: everything a new world gets today.
  modern:   { stage: 'live', fuelOpsV: 2, marketDev: true, demandModel: 3, crewPipeline: true, gateScarcity: true, loyaltyPools: true, partnerships: true,
              startingCapital: 10_000_000, demandMultiplier: 1, rivalItineraries: true, newWorldRestrictions: true },
  // 737 MAX Effort as it ran.
  event737: { stage: 'live', fuelOpsV: 2, marketDev: true, demandModel: 3, crewPipeline: true, gateScarcity: true, loyaltyPools: true, partnerships: true,
              startingCapital: 10_000_000, demandMultiplier: 1, rivalItineraries: true, newWorldRestrictions: true,
              event: { name: null, rules: { aircraft: { families: ['boeing_737'] } } } },
  // Timely Takeoff: an era world from 1950.
  era1950:  { stage: 'alpha', fuelOpsV: 2, startYear: 1950, crewPipeline: true, gateScarcity: true, startingCapital: 2_000_000, demandMultiplier: 1, rivalItineraries: true },
  // Time Flies: shared production lines.
  lines:    { fuelOpsV: 2, crewPipeline: true, gateScarcity: true, productionLines: true, productionLineScale: 0.6, startingCapital: 10_000_000,
              demandMultiplier: 1, rivalItineraries: true, newWorldRestrictions: true },
};

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const seedRandom = (s) => { Math.random = mulberry(hash(s)); };

/** The decision path a bot's action takes: the server's guard, then the reducer. */
export function applyDecision(state, action) {
  const { type, ...payload } = action;
  const guarded = guardDecision(type, payload, state) ?? payload;
  return gameReducer(state, { type, ...guarded });
}

/** Hubs for `n` bots: the biggest airports, one per country, in a fixed order. */
export function labHubs(n, taken = new Set()) {
  const hubs = []; const countries = new Set();
  for (const ap of [...AIRPORTS].filter((a) => a.tier === 'mega').sort((x, y) => y.population - x.population || (x.code < y.code ? -1 : 1))) {
    if (hubs.length >= n) break;
    if (taken.has(ap.code) || countries.has(ap.country)) continue;
    countries.add(ap.country); hubs.push(ap.code);
  }
  return hubs;
}

/**
 * A new world with `bots` bot-run airlines and nobody else.
 * @param {object} o  world: a LAB_WORLDS key or a tickConfig; bots; tier; params (bot overrides); seed (fuel
 *                    and market cycles); skipHubs (start further down the list of big airports)
 */
export function createLab({ world = 'modern', bots = 8, tier = 'cautious', params = null, seed = 'bot-lab', weeksPerDay = 24, skipHubs = 0 } = {}) {
  const tickConfig = typeof world === 'string' ? LAB_WORLDS[world] : world;
  if (!tickConfig) throw new Error(`unknown lab world "${world}" — one of ${Object.keys(LAB_WORLDS).join(', ')}`);
  const w = { id: `lab-${seed}`, name: typeof world === 'string' ? world : 'custom', status: 'RUNNING', visibility: 'PRIVATE', lengthYears: 100, weeksPerDay,
              currentWeek: 1, currentYear: 1, maxPlayers: 50, worldSeed: seed, tickConfig: { ...tickConfig } };
  const airlines = labHubs(bots + skipHubs).slice(skipHubs).map((hub, i) => {
    const name = COMPETITOR_AIRLINES[i % COMPETITOR_AIRLINES.length].name;
    return { id: `bot${i + 1}`, worldId: w.id, name, hub, homeCountry: null, status: 'ACTIVE', account: {}, isBot: true, joinedWeek: 1, restarts: 0, restartedWeek: null,
             week: 1, version: 0, state: seedAirlineState(w, { airlineName: name, hub }) };
  });
  return { world: w, airlines, tier, params, memory: Object.fromEntries(airlines.map((a) => [a.id, newBotMemory()])), marketDevPairs: {}, series: [], journal: [], refusals: {}, weeks: 0 };
}

const stubPrisma = (lab) => ({
  alliance: { findMany: async () => [] },
  worldMarket: { findUnique: async () => null },
  worldMarketDev: { findUnique: async () => ({ pairs: lab.marketDevPairs }) },
  worldGate: { findMany: async () => lab.gates ?? [] },
  gateAuction: { findMany: async () => [] }, gateListing: { findMany: async () => [] }, gateSlotShare: { findMany: async () => [] },
});

/** The stamps tickService puts on every airline before its week (computeOne). */
function stamped(state, world) {
  const tc = world.tickConfig ?? {};
  return {
    ...applyScheduleTrimMigration(state),
    rivalItineraries: rivalItinerariesOf(tc),
    ...(world.weeksPerDay > 0 ? { weeksPerDay: world.weeksPerDay } : {}),
    ...(fuelOpsVOf(tc) >= 2 ? { fuelOpsV: fuelOpsVOf(tc) } : {}),
    ...(eventRulesOfWorld(tc) ? { eventRules: eventRulesOfWorld(tc) } : {}),
    ...(tc.partnerships === true ? { partnershipsWorld: true } : {}),
    ...(isDemandModel(tc.demandModel) ? { demandModel: tc.demandModel } : {}),
    ...(tc.marketDev === true ? { marketDevWorld: true } : {}),
    ...(tc.loyaltyPools === true ? { loyaltyPoolsWorld: true } : {}),
    ...(tc.hubBanks === true ? { hubBanksWorld: true } : {}),
  };
}

/** What runBotTurn is wired to, here and (phase 3) on the server: the real decision path and the reducer's own rules. */
export const botDeps = { apply: applyDecision, canLease: (s, id) => !leaseDenial(s, id, 1), explain: addRouteBlockReason };

/** The state a bot is handed for `airline` this week: stamped as the tick stamps it, with the rival view a player's screen has. */
export async function botView(lab, airline) {
  const rows = lab.airlines.filter((a) => a.status === 'ACTIVE');
  const views = await buildWorldRivalViews(stubPrisma(lab), lab.world.id, { airlines: rows, world: lab.world });
  return withRivals(stamped(airline.state, lab.world), views.get(airline.id));
}

/** One world week: every bot takes its turn, then every airline ticks. */
export async function stepLab(lab, { onTurn = null } = {}) {
  const { world } = lab; const tc = world.tickConfig ?? {};
  const fromIndex = (world.currentYear - 1) * 52 + world.currentWeek; const toIndex = fromIndex + 1;
  const rows = lab.airlines.filter((a) => a.status === 'ACTIVE');
  const views = await buildWorldRivalViews(stubPrisma(lab), world.id, { airlines: rows, world });
  const eraStart = Number.isInteger(tc.startYear) ? tc.startYear : null;
  const seedOf = world.worldSeed ?? world.id;
  const action = { type: 'ADVANCE_WEEK', worldFuelIndex: worldFuelIndex(seedOf, fromIndex, eraStart), worldCrackIndex: worldCrackIndex(seedOf, fromIndex), worldEvents: [],
                   valuationNoise: 0, marketIndex: worldMarketIndex(seedOf, fromIndex), incomingDividends: 0, incomingFarmFees: 0 };
  const pre = rows.map((a) => a.state);
  const week = { week: lab.weeks + 1, absWeek: toIndex, airlines: {} };
  for (const a of rows) {
    let st = withRivals(stamped(a.state, world), views.get(a.id)); let botMs = 0; let turn = null;
    if (a.isBot) {
      seedRandom(`bot:${toIndex}:${a.id}`);
      const t0 = performance.now(); const f0 = botStats.forecasts;
      turn = runBotTurn(st, lab.memory[a.id], { ...botDeps, tier: lab.tier, params: lab.params });
      botMs = performance.now() - t0; lab.forecasts = (lab.forecasts ?? 0) + botStats.forecasts - f0;
      st = turn.state; lab.memory[a.id] = turn.memory;
      for (const x of turn.actions) lab.journal.push({ week: lab.weeks + 1, airline: a.id, ...x });
      for (const r of turn.refused) { const k = String(r.why).replace(/\b[A-Z]{3}\b/g, 'XXX').replace(/[A-Z]{1,2}-[A-Z0-9]+/g, 'TAIL').replace(/\$?\d[\d,.]*[KMh]?/g, '#').slice(0, 70); lab.refusals[k] = (lab.refusals[k] ?? 0) + 1; }
      onTurn?.(a, turn);
    }
    seedRandom(`tick:${toIndex}:${a.id}`);
    const t1 = performance.now();
    a.state = stripRivals(gameReducer(st, action));
    const tickMs = performance.now() - t1;
    const rep = a.state.lastReport ?? {}; let pax = 0, cap = 0;
    for (const x of rep.routeResults ?? []) { pax += x.passengers ?? 0; cap += x.loadFactor > 0 ? x.passengers / x.loadFactor : 0; }
    const view = views.get(a.id);
    week.airlines[a.id] = { name: a.name, hub: a.hub, fleet: (a.state.fleet ?? []).length, routes: (a.state.routes ?? []).length, pending: (a.state.pendingOrders ?? []).length,
      revenue: Math.round(rep.totalRevenue ?? 0), net: netProfitOf((a.state.financialHistory ?? []).at(-1)), cash: Math.round(a.state.cash ?? 0), loadFactor: cap ? +(pax / cap).toFixed(3) : null,
      contested: new Set((a.state.routes ?? []).map((r) => (r.origin < r.destination ? `${r.origin}-${r.destination}` : `${r.destination}-${r.origin}`)).filter((k) => (view.humanRivals?.[k] ?? []).length > 0)).size,
      actions: turn?.actions.length ?? 0, botMs: Math.round(botMs), tickMs: Math.round(tickMs), phase: a.state.phase };
    if (a.state.phase === 'bankrupt') { a.status = 'BANKRUPT'; a.bankruptWeek = lab.weeks + 1; }   // the server tombstones it; here it just stops flying
  }
  if (tc.marketDev === true) { try { lab.marketDevPairs = advanceMarketDevPairs(lab.marketDevPairs, collectWorldService(pre, { month: weekToGameDate(world.currentWeek).monthIndex })); } catch { /* table held, as the tick does */ } }
  world.currentWeek += 1; if (world.currentWeek > 52) { world.currentWeek = 1; world.currentYear += 1; }
  lab.series.push(week); lab.weeks += 1;
  return week;
}

/** A lab as JSON, to pick up again later (a long run in several sittings). The journal keeps only who did what when. */
export function saveLab(lab) {
  return JSON.stringify({ ...lab, journal: lab.journal.map((j) => ({ week: j.week, airline: j.airline, type: j.type })), series: lab.series.slice(-52) });
}
export function loadLab(json) { return JSON.parse(json); }

export async function runLab(lab, weeks) { for (let i = 0; i < weeks; i++) await stepLab(lab); return lab; }
