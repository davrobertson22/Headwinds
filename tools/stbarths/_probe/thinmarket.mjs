// How much of the map would a thin-market yield premium touch?
import { AIRPORTS, getAirport } from '../../../packages/engine/src/data/airports.js';
import { baseCityPairDemand, distanceKm } from '../../../packages/engine/src/utils/market.js';
const AP=(Array.isArray(AIRPORTS)?AIRPORTS:Object.values(AIRPORTS));
// sample pairs: every airport against 40 spread partners
const sample=[]; const step=Math.max(1,Math.floor(AP.length/40));
const partners=AP.filter((_,i)=>i%step===0).slice(0,40);
for(const a of AP) for(const b of partners){ if(a.code===b.code)continue;
  const d=baseCityPairDemand(a.code,b.code); if(d>0) sample.push({a:a.code,b:b.code,d,dist:Math.round(distanceKm(a,b))}); }
sample.sort((x,y)=>x.d-y.d);
const q=(p)=>sample[Math.floor(sample.length*p)].d;
console.log('sampled pairs:',sample.length);
console.log('pair weekly demand percentiles:');
for(const p of [0.01,0.05,0.1,0.25,0.5,0.75,0.9,0.99]) console.log('  p'+String(p*100).padStart(4),Math.round(q(p)).toLocaleString());
console.log('\nSBH pairs for reference:');
for(const c of ['SJU','AUA','SDQ','PTP','EIS']) console.log('  SBH-'+c, Math.round(baseCityPairDemand('SBH',c)));
console.log('\ntrunk pairs for reference:');
for(const [x,y] of [['JFK','LAX'],['JFK','LHR'],['LAX','SFO'],['ATL','ORD'],['JFK','MIA']]) console.log(`  ${x}-${y}`, Math.round(baseCityPairDemand(x,y)).toLocaleString());
// what share of pairs sit under candidate thresholds
for(const D0 of [500,1000,2000,4000]){
  const n=sample.filter(s=>s.d<D0).length;
  console.log(`\npairs under ${D0}/wk: ${n} (${(100*n/sample.length).toFixed(1)}% of sampled pairs)`);
}
