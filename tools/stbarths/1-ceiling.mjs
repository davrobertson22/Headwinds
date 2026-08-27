// The revenue ceiling of an SBH-only airline, and what NWR lets it fly.
import { getAirport, AIRPORTS } from '../../packages/engine/src/data/airports.js';
import { getAircraftType, leasableTypes, LESSOR_EIS_CUTOFF, LESSOR_ALLOW, LESSOR_BLOCK } from '../../packages/engine/src/data/aircraft.js';
import { baseCityPairDemand, distanceKm, NWR_FARE_INDEX } from '../../packages/engine/src/utils/market.js';
import { referencePrice, routeDistanceKm, maxFrequency, effectiveRangeKm } from '../../packages/engine/src/utils/simulation.js';
import { HQ_BASE_WEEKLY, HQ_DEPARTURE_FEE, calcHQCost } from '../../packages/engine/src/data/overhead.js';

const AP = Array.isArray(AIRPORTS) ? AIRPORTS : Object.values(AIRPORTS);
const sbh = getAirport('SBH');
const CAND = ['dhc6','bn2islander'];

console.log('LESSOR_EIS_CUTOFF =', LESSOR_EIS_CUTOFF);
const leasable = leasableTypes ? leasableTypes() : null;
for (const id of CAND) {
  const t = getAircraftType(id);
  const inAllow = (LESSOR_ALLOW ?? []).includes?.(id) ?? (LESSOR_ALLOW?.has?.(id));
  const inBlock = (LESSOR_BLOCK ?? []).includes?.(id) ?? (LESSOR_BLOCK?.has?.(id));
  const nwrLeasable = Array.isArray(leasable) ? leasable.some(x => (x.id ?? x) === id) : 'n/a';
  console.log(`${id}: eis=${t.eis} allow=${inAllow} block=${inBlock} leasableUnderNWR=${nwrLeasable} lease=$${t.weeklyLease}/wk buy=$${(t.purchasePrice/1e6).toFixed(1)}M`);
}

for (const id of CAND) {
  const t = getAircraftType(id);
  const range = effectiveRangeKm({}, t);
  const dests = AP.filter(a => a.code !== 'SBH')
    .map(a => {
      const dist = Math.round(distanceKm(sbh, a));
      return { code:a.code, dist, rwy:a.runwayFt, demand: baseCityPairDemand('SBH', a.code) };
    })
    .filter(d => d.dist <= range && d.demand > 0 && (d.rwy ?? 0) >= (t.runwayFt ?? 0))
    .map(d => {
      const refNWR = referencePrice('SBH', d.code) * NWR_FARE_INDEX;
      const refLegacy = referencePrice('SBH', d.code);
      const maxF = maxFrequency(d.dist, t);
      const seatsWk = maxF * t.seats;
      const pax = Math.min(d.demand, seatsWk);
      return { ...d, refNWR, refLegacy, maxF, seatsWk, pax, revNWR: pax*refNWR, revLegacy: pax*refLegacy };
    })
    .sort((x,y)=>y.revNWR-x.revNWR);

  const totDemand = dests.reduce((s,d)=>s+d.demand,0);
  console.log(`\n=== ${id} (${t.seats} seats, ${range}km range) — ${dests.length} reachable markets`);
  console.log('total weekly O&D demand across the whole SBH network:', Math.round(totDemand).toLocaleString(), 'pax');
  console.log('\n  route   dist  demand  maxFreq  seats/wk  pax  refFare(NWR)  gross rev/wk (NWR)');
  for (const d of dests.slice(0,12)) {
    console.log('  SBH-'+d.code, String(d.dist).padStart(5), String(Math.round(d.demand)).padStart(7),
      String(d.maxF).padStart(8), String(d.seatsWk).padStart(9), String(Math.round(d.pax)).padStart(5),
      ('$'+Math.round(d.refNWR)).padStart(13), ('$'+Math.round(d.revNWR).toLocaleString()).padStart(20));
  }
  // Ceiling: 1 aircraft can only fly one route's worth of block hours. Report per-fleet.
  for (const n of [1,2,3,5,10]) {
    const top = dests.slice(0,n);
    const rev = top.reduce((s,d)=>s+d.revNWR,0);
    const deps = top.reduce((s,d)=>s+d.maxF,0)*2;
    const hqNWR = HQ_BASE_WEEKLY + deps*HQ_DEPARTURE_FEE[t.category];
    const hqLegacy = calcHQCost(n);
    const lease = n*t.weeklyLease;
    console.log(`  fleet ${String(n).padStart(2)}: gross rev/wk $${Math.round(rev).toLocaleString().padStart(9)}  | NWR HQ $${hqNWR.toLocaleString().padStart(7)} (${(100*hqNWR/rev).toFixed(0)}% of rev) | legacy HQ $${hqLegacy.toLocaleString().padStart(7)} (${(100*hqLegacy/rev).toFixed(0)}%) | lease $${lease.toLocaleString()}`);
  }
}
