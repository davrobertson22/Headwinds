// Headless era playbot — HW engine, NWR + crew pipeline, NO rivals. Not a test:
// a balance probe. Leases the cheapest cost/seat type on the lessor books (or
// TYPE=<id>), hires crew ahead of each delivery, flies hub-and-spoke from JFK to
// the most profitable projected pair (projectRouteAddition, the same helper the
// planners use), adds gates as needed, fills the NWR 100h block-hour cap, prunes
// routes under 30% load for 8 weeks. Prints cash/fleet/revenue at each year end
// and return on the seed. Deterministic (seeded Math.random).
//
//   node --import ./tools/_register-loader.mjs tools/playbot-era.mjs 1950 4000000 104
//   TYPE=cv240 node --import ./tools/_register-loader.mjs tools/playbot-era.mjs 1950 4000000
//   node --import ./tools/_register-loader.mjs tools/playbot-era.mjs classic 15000000
//
// 2026-09-02 results (2 years, no rivals): classic/737-800 −24% then +18%;
// 1950/C-47 +370% then +1138%; 1950/CV-240 +612%; 1978/737-200 +259%. Lease and
// purchase prices are a rounding error against era route profit — the era's
// fare index (1950: 1.55×) on a monopoly pool is the lever, not the catalogue.
import { gameReducer, freshState, addRouteBlockReason } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES, getAircraftType, aircraftOrderable, lessorSupplies, eraWeeklyLease, eraPurchasePrice } from '../packages/engine/src/data/aircraft.js';
import { AIRPORTS, getAirport } from '../packages/engine/src/data/airports.js';
import { eraFuelMean, eraSeedCapital } from '../packages/engine/src/data/era.js';
import { seedCrewFor, crewRequired, crewAvailable, crewInTraining, crewScaleFor, DEFAULT_LABOR_STATE } from '../packages/engine/src/data/labor.js';
import { distanceKm, maxFrequency, calendarYear, defaultConfig, routeBlockHours, NWR_MAX_WEEKLY_BLOCK_HOURS } from '../packages/engine/src/utils/simulation.js';
import { referencePrice, NWR_FARE_INDEX } from '../packages/engine/src/utils/market.js';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';

Math.random = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

const startYear = process.argv[2] === 'classic' ? null : Number(process.argv[2]);
const seedCash  = Number(process.argv[3]) || (startYear ? eraSeedCapital(15_000_000, startYear) : 15_000_000);
const WEEKS     = Number(process.argv[4]) || 104;
const HUB = 'JFK';

let st = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Bot', hub: HUB, enableObjectives: true, objectiveSet: 'multiplayer' });
st = {
  ...st, cash: seedCash, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {},
  worldDemandMult: 1, foundedAbsWeek: 1,
  ...(startYear ? { startYear } : {}),
  newWorldRestrictions: true, fareIndex: NWR_FARE_INDEX,
  crewPipeline: true, labor: seedCrewFor(st.labor ?? DEFAULT_LABOR_STATE, st.fleet ?? [], (a) => getAircraftType(a.typeId)),
};
if (startYear) st = { ...st, fuelPrice: { ...(st.fuelPrice ?? {}), index: eraFuelMean(startYear) ?? 1, history: [] } };
const openingFleet = st.fleet.length;
const d = (action) => { st = gameReducer(st, action); };
const typeOf = (a) => getAircraftType(a.typeId);

function cheapestType() {
  const cy = calendarYear(st);
  const cands = AIRCRAFT_TYPES.filter(t => !t.freighter && !t.doubleDeck && aircraftOrderable(t, cy) && lessorSupplies(t, cy ?? undefined))
    .filter(t => t.seats >= 20);
  cands.sort((a, b) => eraWeeklyLease(a, cy) / a.seats - eraWeeklyLease(b, cy) / b.seats);
  if (process.env.TYPE) return cands.find(t => t.id === process.env.TYPE) ?? null;
  return cands[0];
}
function served() { return new Set(st.routes.map(r => `${r.origin}-${r.destination}`)); }
function bestRoute(aircraft) {
  const type = typeOf(aircraft); const hub = getAirport(HUB); const s = served();
  const cands = AIRPORTS.filter(a => a.code !== HUB && (a.tier === 'mega' || a.tier === 'major'))
    .map(a => ({ a, dist: distanceKm(hub, a) }))
    .filter(x => x.dist >= 250 && x.dist <= (type.range ?? 0) * 0.9 && !s.has(`${HUB}-${x.a.code}`))
    .sort((x, y) => y.a.population - x.a.population).slice(0, 25);
  let best = null;
  for (const { a, dist } of cands) {
    let freq = Math.min(28, Math.max(1, maxFrequency(dist, type)));
    while (freq > 1 && routeBlockHours({ origin: HUB, destination: a.code }, type, freq) > NWR_MAX_WEEKLY_BLOCK_HOURS - 2) freq--;
    const ticketPrice = referencePrice(HUB, a.code);
    const p = projectRouteAddition(st, { origin: HUB, destination: a.code, aircraft, weeklyFrequency: freq, ticketPrice });
    const profit = p?.mature?.profit ?? -Infinity;
    if (profit > (best?.profit ?? 0)) best = { code: a.code, freq, ticketPrice, profit };
  }
  return best;
}
function ensureCrew(extraType = null) {
  for (const g of ['pilots', 'cabinCrew']) {
    const fleetPlus = extraType ? [...st.fleet, { typeId: extraType.id }] : st.fleet;
    const need = crewRequired(g, fleetPlus, typeOf);
    const have = crewAvailable(st.labor, g) + crewInTraining(st.labor, g);
    if (need > have + 1e-9) d({ type: 'HIRE_CREW', group: g, count: Math.ceil(need - have) });
  }
}
const lf = new Map();
const log = [];
for (let w = 0; w < WEEKS; w++) {
  // prune
  for (const rr of (st.lastReport?.routeResults ?? [])) {
    const n = (lf.get(rr.routeId) ?? 0) + (rr.loadFactor < 0.30 ? 1 : -1);
    lf.set(rr.routeId, Math.max(0, n));
    if (n >= 8) { d({ type: 'CLOSE_ROUTE', routeId: rr.routeId }); lf.delete(rr.routeId); }
  }
  ensureCrew();
  // assign idle
  for (const a of st.fleet.filter(a => a.status !== 'retired' && !st.routes.some(r => r.aircraftId === a.id))) {
    const r = bestRoute(a);
    if (r && r.profit > 0) { if (!(st.gates ?? {})[r.code]) d({ type: 'ADD_GATE', airportCode: r.code }); const act = { type: 'ADD_ROUTE', origin: HUB, destination: r.code, aircraftId: a.id, weeklyFrequency: r.freq, ticketPrice: r.ticketPrice }; const before = st.routes.length; d(act); if (st.routes.length === before) { d({ type: 'ADD_GATE', airportCode: HUB }); d(act); } if (process.env.DBG && st.routes.length === before) console.error('ADD_ROUTE refused', addRouteBlockReason(st, act)); }
  }
  // grow: lease one more if cash covers 12 weeks of the whole lease book + the deposit and a profitable route exists
  const t = cheapestType();
  if (t && st.pendingOrders.length === 0 && st.fleet.every(a => st.routes.some(r => r.aircraftId === a.id))) {
    const cy = calendarYear(st);
    const rent = eraWeeklyLease(t, cy);
    const book = st.fleet.reduce((s, a) => s + (a.weeklyLease ?? 0), 0) + rent;
    const probe = { id: 'probe', typeId: t.id, config: defaultConfig(t.seats), ageWeeks: 0 };
    const r = bestRoute(probe);
    if (process.env.DBG && w < 3) console.error('w', w, 'type', t.id, 'rent', rent, 'cash', st.cash, 'r', JSON.stringify(r));
    if (st.cash > book * 12 + rent * 12 && r && r.profit > rent * 1.5) {
      ensureCrew(t);
      d({ type: 'LEASE_AIRCRAFT', typeId: t.id });
    }
  }
  d({ type: 'ADVANCE_WEEK' });
  if ((w + 1) % 52 === 0) {
    const yr = (w + 1) / 52;
    const rev = st.lastReport?.revenue ?? st.lastReport?.totalRevenue ?? 0;
    log.push({ yr, cash: Math.round(st.cash), fleet: st.fleet.length, routes: st.routes.length, wkRevenue: Math.round(rev), wkProfit: Math.round(st.lastReport?.profit ?? st.lastReport?.netProfit ?? 0) });
  }
}
const cy0 = startYear ?? 'classic';
const t0 = cheapestType();
console.log(JSON.stringify({ era: cy0, seed: seedCash, openingFleet, cheapest: t0 ? `${t0.id} $${eraWeeklyLease(t0, startYear)}/wk buy $${eraPurchasePrice(t0, startYear)}` : null,
  years: log, fleetTypes: [...new Set(st.fleet.map(a => a.typeId))], roc: log.map(y => ((y.cash - seedCash) / seedCash).toFixed(2)) }, null, 1));
