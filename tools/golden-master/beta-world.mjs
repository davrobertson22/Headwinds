// Golden master #2 — the "beta world" parity lock.
// ----------------------------------------------------------------------------
// HUB_CONNECTIVITY_PLAN.md rollout rule (Dave, 2026-09-07): the alpha worlds and
// every new world get the hub-connectivity package; the existing BETA worlds
// — the standard ruleset players are mid-game in — get nothing. Not "nothing
// visible": nothing. A world whose `rivalItineraries` is off must tick
// byte-for-byte as the engine did before the package existed.
//
// This scenario is what the first golden master cannot see: a two-hub network
// with connecting traffic, contested by static rivals (multiplayer: true keeps
// the AI from moving them, exactly as a Headwinds world does), flag OFF. Its
// baseline hash was captured by running THIS file against the engine at
// 818c2ff — the last commit before the package's first engine change — so a
// match here is a proof, not a promise.
//
//   node tools/golden-master/beta-world.mjs            → compare (CI mode)
//   node tools/golden-master/beta-world.mjs --update   → re-capture baseline
//
// Re-baseline ONLY for a change that is meant to reach the beta worlds, and say
// so in the commit. A mismatch after a hub-connectivity change means something
// leaked past the flag.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gameReducer, freshState } from '../../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../../packages/engine/src/data/aircraft.js';
import { getAirport } from '../../packages/engine/src/data/airports.js';
import { defaultConfig, defaultClassPrices, distanceKm, referencePrice } from '../../packages/engine/src/utils/simulation.js';
import { NWR_FARE_INDEX } from '../../packages/engine/src/utils/market.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(__dirname, 'golden-beta-world.json');
const update = process.argv.includes('--update');
const WEEKS = 30;

// Determinism: pinned dice and a stepping clock, as harness.mjs does.
Math.random = () => 0.5;
let clock = 1_700_000_000_000;
Date.now = () => (clock += 1000);

function buildScenario() {
  const wide = getAircraftType('b7879'), narrow = getAircraftType('a320neo');
  let n = 0;
  const mkAc = (t) => ({ id: `p${n++}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `N${n}P`, name: t.name });
  const fleet = [], routes = [], routePricing = {}, gates = {};
  const addRoute = (o, d, freq) => {
    const t = distanceKm(getAirport(o), getAirport(d)) > 4000 ? wide : narrow;
    const ac = mkAc(t); fleet.push(ac);
    routes.push({ id: `r${routes.length}`, origin: o, destination: d, stops: [o, d], aircraftId: ac.id, weeklyFrequency: freq, weeksOpen: 30 });
    routePricing[[o, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(o, d)));
    gates[o] = (gates[o] ?? 0) + 1; gates[d] = (gates[d] ?? 0) + 1;
  };
  for (const s of ['LHR', 'CDG', 'FRA', 'LAX', 'SFO', 'MIA', 'ORD', 'BOS', 'ATL', 'DFW', 'DEN', 'SEA', 'YYZ', 'MEX', 'GRU', 'MAD', 'FCO', 'DUB', 'AMS', 'LAS']) addRoute('JFK', s, 14);
  for (const s of ['DEN', 'MSP', 'DTW', 'STL', 'MCI', 'LAS', 'PHX', 'SEA', 'SFO', 'IAH']) addRoute('ORD', s, 14);
  for (const [o, d] of [['LAX', 'SFO'], ['MIA', 'ATL'], ['BOS', 'DCA'], ['SEA', 'PDX'], ['DEN', 'SLC'], ['LAX', 'LAS']]) addRoute(o, d, 21);
  gates.JFK = 24; gates.ORD = 14;

  let st = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'BetaAir', hub: 'JFK', enableObjectives: false });
  return {
    ...st, cash: 500_000_000, fleet, routes, routePricing, gates,
    hubs: { JFK: { tier: 2, tierSince: 0 }, ORD: { tier: 1, tierSince: 0 } },
    fareIndex: NWR_FARE_INDEX, newWorldRestrictions: true,
    multiplayer: true,          // rivals are static, as they are in a Headwinds world
    rivalItineraries: false,    // a beta world
  };
}

function canonical(obj) {
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

let st = buildScenario();
let cashByWeek = [];
for (let w = 1; w <= WEEKS; w++) {
  st = gameReducer(st, { type: 'ADVANCE_WEEK' });
  cashByWeek.push(Math.round(st.cash));
}
const r = st.lastReport ?? {};
const projection = {
  week: st.week, year: st.year, cash: Math.round(st.cash),
  revenue: Math.round(r.totalRevenue ?? r.revenue ?? 0),
  passengers: Math.round(r.totalPassengers ?? 0),
  ownMetalPax: r.ownMetalOD?.totalPax ?? null,
  partnerPax: r.partnerODRevenue?.totalPax ?? null,
  routes: (r.routeResults ?? []).length,
  cashWeek10: cashByWeek[9], cashWeek20: cashByWeek[19],
};
const fullHash = crypto.createHash('sha256').update(canonical(st)).digest('hex');
const snapshot = { fullHash, projection, capturedWith: 'tools/golden-master/beta-world.mjs', scenario: `${WEEKS}w / JFK T2 + ORD T1 / static rivals / rivalItineraries false` };

if (update || !fs.existsSync(GOLDEN)) {
  fs.writeFileSync(GOLDEN, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`[beta-world] WROTE baseline → ${path.relative(process.cwd(), GOLDEN)}`);
  console.log('[beta-world] projection:', JSON.stringify(projection));
  process.exit(0);
}
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
if (golden.fullHash === fullHash) {
  console.log('[beta-world] ✓ PARITY OK — a flag-off world ticks byte-identically to the pre-package engine.');
  process.exit(0);
}
console.error('[beta-world] ✗ MISMATCH — something reached a flag-off world.');
console.error('  expected hash:', golden.fullHash);
console.error('  actual   hash:', fullHash);
console.error('  baseline projection:', JSON.stringify(golden.projection));
console.error('  current  projection:', JSON.stringify(projection));
process.exit(1);
