// thin-network-probe.mjs — @not-a-test: HUB_CONNECTIVITY_PLAN.md balance
// protocol, the case the contested-balance probe is blind to.
//
// That probe flies 14×/week on every spoke and fills 25 of 35 routes past 95%,
// so its connections are seat-bound and preference terms (the connection
// penalty) barely register. This is the OTHER end of the game: a year-one
// carrier with one small hub and eight thin spokes, seats to spare, two
// static hub rivals. Here a connection wins or loses on preference, and a rival's
// one-stop over its hub competes with the player's half-empty nonstop. Prints
// the two-year cash, the connections won vs seated, and — the number this
// probe exists for — how much of the player's nonstop pairs rival one-stops
// take in the final week.
//
//   node tools/thin-network-probe.mjs [weeks=104]
//   FIXRAND=1 pins the dice; RIVAL_ITIN=1 turns the package on (off = legacy rules).
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { defaultConfig, defaultClassPrices, distanceKm, referencePrice, rivalOffersFor } from '../packages/engine/src/utils/simulation.js';
import { buildRouteMarket, computeMarketShare } from '../packages/engine/src/models/demand.js';
import { rivalIndexFor, isLegacy, RIVAL_CONN_PREFIX } from '../packages/engine/src/models/network.js';
import { NWR_FARE_INDEX } from '../packages/engine/src/utils/market.js';

Math.random = process.env.FIXRAND ? () => 0.5
  : (() => { let s = 424242; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
const WEEKS = Number(process.argv[2]) || 104;

const narrow = getAircraftType('a320neo');
let n = 0;
const mkAc = () => ({ id: `p${n++}`, typeId: narrow.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(narrow.seats), ownershipType: 'leased', tailNumber: `N${n}P`, name: narrow.name });
const fleet = [], routes = [], routePricing = {}, gates = {};
const addRoute = (o, d, freq) => {
  if (distanceKm(getAirport(o), getAirport(d)) > narrow.range) throw new Error(`${o}-${d} out of range`);
  const ac = mkAc(); fleet.push(ac);
  routes.push({ id: `r${routes.length}`, origin: o, destination: d, stops: [o, d], aircraftId: ac.id, weeklyFrequency: freq, weeksOpen: 8 });
  routePricing[[o, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(o, d)));
  gates[o] = (gates[o] ?? 0) + 1; gates[d] = (gates[d] ?? 0) + 1;
};
// A Raleigh hub with eight secondary-city spokes (1,100–1,900 pax/wk pairs)
// flown twice daily with 180 seats — 2,520 seats against ~1,500 travellers,
// so every flight leaves with room. This is where a rival's one-stop over
// Chicago or Atlanta competes on preference, not on who has a seat left.
for (const s of ['BUF', 'MKE', 'MSY', 'SDF', 'MEM', 'OMA', 'DSM', 'TUL']) addRoute('RDU', s, 14);
gates.RDU = 10;

// The stock AI carriers fly big cities only, so nothing of theirs connects
// over these spokes. The rivals here are Headwinds-shaped instead: two static
// hub carriers (multiplayer: true keeps the AI from touching them) that reach
// Raleigh AND every spoke over Chicago and Atlanta — so each player nonstop
// faces two one-stops, exactly what a small Headwinds airline sees.
const SPOKES = ['BUF', 'MKE', 'MSY', 'SDF', 'MEM', 'OMA', 'DSM', 'TUL'];
const hubRival = (id, name, hub, tier, quality) => {
  const rroutes = {};
  for (const s of ['RDU', ...SPOKES]) rroutes[[hub, s].sort().join('-')] = { frequency: 14, priceMultiplier: 1.0, aircraftType: 'a320neo', tails: 2 };
  return { id, name, homeHub: hub, tier, logoId: 'eagle', baseQualityScore: quality, cash: 200_000_000,
    routes: rroutes, fleet: [], human: true, hubs: { [hub]: { tier } }, profitHistory: [], allianceId: null };
};
let st = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Thin', hub: 'RDU', enableObjectives: false });
st = { ...st, cash: 300_000_000, fleet, routes, routePricing, gates,
  hubs: { RDU: { tier: 1, tierSince: 0 } },
  competitors: [hubRival('midwest', 'Midwest Air', 'ORD', 2, 62), hubRival('southern', 'Southern Sky', 'ATL', 2, 60)],
  multiplayer: true,
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
console.log(`weeks ${WEEKS}  cash ${(st.cash / 1e6).toFixed(0)}M  package ${st.rivalItineraries ? 'ON' : 'off'}  rivals ${st.competitors.length}`);
years.forEach((y, i) => console.log(`  year ${i + 1}: revenue ${(y.rev / 1e6).toFixed(1)}M  pax ${Math.round(y.pax).toLocaleString()}  cashΔ ${(y.profit / 1e6).toFixed(1)}M`));
console.log(`  final week: ${rr.length} routes, mean LF ${(rr.reduce((s, x) => s + (x.loadFactor ?? 0), 0) / Math.max(1, rr.length) * 100).toFixed(1)}%`);
const won    = r.ownMetalOD?.totalPax ?? 0;
const seated = rr.reduce((s, x) => s + (x.connecting?.itineraryPax ?? 0), 0);
console.log(`  connections: own-metal won ${won.toLocaleString()} pax/wk → seated ${seated.toLocaleString()} leg-boardings (seats are NOT the constraint here)`);

// Rival one-stops on the player's own pairs, final week: re-run the share
// fight the tick ran, and read what the via-hub offers took.
const idx = rivalIndexFor(st);
let pairs = 0, viaPairs = 0, viaShare = 0, viaPax = 0, playerPax = 0;
for (const route of st.routes) {
  const market = buildRouteMarket(route.origin, route.destination, { month: 6 }, 1);
  const res = rr.find(x => x.routeId === route.id || x.id === route.id);
  const comps = (st.competitors ?? []).filter(c => c?.routes?.[[route.origin, route.destination].sort().join('-')]);
  const rivals = rivalOffersFor(comps, [], market, idx);
  const vias = rivals.filter(o => String(o.airlineId).startsWith(RIVAL_CONN_PREFIX));
  pairs++;
  if (vias.length === 0) continue;
  const player = { airlineId: 'player', origin: route.origin, destination: route.destination,
    economyPrice: routePricing[[route.origin, route.destination].sort().join('-')].economy,
    businessPrice: routePricing[[route.origin, route.destination].sort().join('-')].business,
    weeklyFrequency: route.weeklyFrequency, seatsPerFlight: narrow.seats,
    economySeats: Math.round(narrow.seats * 0.9) * route.weeklyFrequency, businessSeats: Math.round(narrow.seats * 0.1) * route.weeklyFrequency,
    totalSeats: narrow.seats * route.weeklyFrequency, qualityScore: 60, connectivityBonus: 0 };
  const results = computeMarketShare(market, [player, ...rivals], { legacy: isLegacy(idx) });
  viaPairs++;
  for (const x of results) {
    if (String(x.airlineId).startsWith(RIVAL_CONN_PREFIX)) { viaShare += x.leisureShare ?? 0; viaPax += x.totalPax; }
    if (x.airlineId === 'player') playerPax += x.totalPax;
  }
}
console.log(`  rival one-stops: on ${viaPairs}/${pairs} player pairs; via-hub share ${(viaShare / Math.max(1, viaPairs) * 100).toFixed(1)}% per contested pair, ${viaPax.toLocaleString()} pax/wk vs player ${playerPax.toLocaleString()} on those pairs`);
