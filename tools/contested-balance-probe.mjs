// contested-balance-probe.mjs — @not-a-test: HUB_CONNECTIVITY_PLAN.md balance
// protocol for changes the golden master and the (no-rival) playbot cannot see.
// The Phase 0 network (JFK T2 + 20 spokes, ORD T1 + 10, 6 point-to-point) with
// the stock AI carriers, ticked N weeks; prints per-year player revenue / pax /
// profit and the AI bank's aggregate, plus how many player routes were
// capacity-capped vs demand-limited in the final week.
//
//   node --import ./tools/_register-loader.mjs tools/contested-balance-probe.mjs [weeks=104]
//   RIVAL_ITIN=1 … turns rival one-stop itineraries on (HUB_CONNECTIVITY_PLAN.md 1b)
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { defaultConfig, defaultClassPrices, distanceKm, referencePrice } from '../packages/engine/src/utils/simulation.js';
import { NWR_FARE_INDEX } from '../packages/engine/src/utils/market.js';

// FIXRAND=1 pins Math.random to 0.5 so two engines see identical events,
// failures and AI dice — the difference is then the model, not the path.
Math.random = process.env.FIXRAND ? () => 0.5
  : (() => { let s = 424242; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
const WEEKS = Number(process.argv[2]) || 104;

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
for (const s of ['LHR','CDG','FRA','LAX','SFO','MIA','ORD','BOS','ATL','DFW','DEN','SEA','YYZ','MEX','GRU','MAD','FCO','DUB','AMS','LAS']) addRoute('JFK', s, 14);
for (const s of ['DEN','MSP','DTW','STL','MCI','LAS','PHX','SEA','SFO','IAH']) addRoute('ORD', s, 14);
for (const [o, d] of [['LAX','SFO'],['MIA','ATL'],['BOS','DCA'],['SEA','PDX'],['DEN','SLC'],['LAX','LAS']]) addRoute(o, d, 21);
gates.JFK = 24; gates.ORD = 14;

let st = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe', hub: 'JFK', enableObjectives: false });
st = { ...st, cash: 500_000_000, fleet, routes, routePricing, gates,
  hubs: { JFK: { tier: 2, tierSince: 0 }, ORD: { tier: 1, tierSince: 0 } },
  fareIndex: NWR_FARE_INDEX, newWorldRestrictions: true,
  ...(process.env.RIVAL_ITIN ? { rivalItineraries: true } : {}) };

const years = [];
let acc = { rev: 0, pax: 0, profit: 0 };
for (let w = 1; w <= WEEKS; w++) {
  st = gameReducer(st, { type: 'ADVANCE_WEEK' });
  const r = st.lastReport ?? {};
  acc.rev += r.totalRevenue ?? r.revenue ?? 0; acc.pax += r.totalPassengers ?? 0; acc.profit += r.cashDelta ?? 0;
  if (w % 52 === 0) { years.push(acc); acc = { rev: 0, pax: 0, profit: 0 }; }
}
const r = st.lastReport ?? {};
const rr = r.routeResults ?? [];
const capped = rr.filter(x => x.capacityCapped || (x.loadFactor ?? 0) >= 0.949).length;
const aiCash = (st.competitors ?? []).reduce((s, c) => s + (c.cash ?? 0), 0);
console.log(`weeks ${WEEKS}  cash ${(st.cash / 1e6).toFixed(0)}M  AI carriers ${st.competitors.length}`);
years.forEach((y, i) => console.log(`  year ${i + 1}: revenue ${(y.rev / 1e6).toFixed(1)}M  pax ${Math.round(y.pax).toLocaleString()}  cashΔ ${(y.profit / 1e6).toFixed(1)}M`));
console.log(`  final week: ${rr.length} routes, ${capped} at ≥95% load, mean LF ${(rr.reduce((s, x) => s + (x.loadFactor ?? 0), 0) / Math.max(1, rr.length) * 100).toFixed(1)}%, AI bank cash ${(aiCash / 1e6).toFixed(0)}M`);
