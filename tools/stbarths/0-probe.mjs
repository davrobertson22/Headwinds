// What can actually operate out of SBH, and where can it go?
import { AIRPORTS, getAirport } from '../../packages/engine/src/data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../../packages/engine/src/data/aircraft.js';
import { baseCityPairDemand, distanceKm } from '../../packages/engine/src/utils/market.js';
import { checkRouteRestrictions } from '../../packages/engine/src/data/airportRestrictions.js';

const AP = Array.isArray(AIRPORTS) ? AIRPORTS : Object.values(AIRPORTS);
const TYPES = Array.isArray(AIRCRAFT_TYPES) ? AIRCRAFT_TYPES : Object.values(AIRCRAFT_TYPES);
const sbh = getAirport('SBH');
console.log('SBH:', JSON.stringify(sbh));

const fits = TYPES.filter(t => (t.runwayFt ?? 99999) <= (sbh.runwayFt ?? 0));
console.log('\nTypes that clear a', sbh.runwayFt, 'ft runway:', fits.length, 'of', TYPES.length);
for (const t of fits) {
  console.log(' ', t.id.padEnd(16), (t.name||'').padEnd(28), String(t.seats).padStart(4)+'seats',
    String(t.range).padStart(6)+'km', 'rwy'+String(t.runwayFt).padStart(5),
    'lease $'+Math.round(t.weeklyLease||0).toLocaleString().padStart(9)+'/wk',
    'price $'+Math.round((t.price||0)/1e6)+'M', t.category, 'eis'+t.eis, t.doubleDeck?'DD':'');
}

const best = fits.sort((a,b)=>b.seats-a.seats)[0];
if (!best) { console.log('\nNOTHING can operate SBH.'); process.exit(0); }
console.log('\nBiggest fitting type:', best.id, best.seats, 'seats,', best.range, 'km');

for (const t of fits) {
  const dests = AP.filter(a => a.code !== 'SBH')
    .map(a => ({ code:a.code, city:a.city, country:a.country, rwy:a.runwayFt,
      dist: Math.round(distanceKm(sbh, a)), demand: baseCityPairDemand('SBH', a.code) }))
    .filter(d => d.dist <= t.range && d.demand > 0 && (d.rwy ?? 0) >= (t.runwayFt ?? 0))
    .filter(d => !checkRouteRestrictions('SBH', d.code, d.dist, 7, t.category, { aircraftType: t }))
    .sort((x,y)=>y.demand-x.demand);
  console.log(`\n--- ${t.id} (${t.seats}s, ${t.range}km, rwy ${t.runwayFt}) : ${dests.length} legal destinations`);
  for (const d of dests.slice(0,15)) {
    console.log('   ', d.code, String(d.dist).padStart(5)+'km', 'demand/wk', String(Math.round(d.demand)).padStart(6), d.city, d.country, 'rwy'+d.rwy);
  }
}
