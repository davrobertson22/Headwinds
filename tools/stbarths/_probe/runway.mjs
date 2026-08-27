import { AIRPORTS } from '../../../packages/engine/src/data/airports.js';
import { AIRCRAFT_TYPES } from '../../../packages/engine/src/data/aircraft.js';
const AP=(Array.isArray(AIRPORTS)?AIRPORTS:Object.values(AIRPORTS));
const T=(Array.isArray(AIRCRAFT_TYPES)?AIRCRAFT_TYPES:Object.values(AIRCRAFT_TYPES));
console.log('airports:',AP.length);
for(const cut of [2500,3500,4500,5500,6500]){
  const n=AP.filter(a=>(a.runwayFt??99999)<cut).length;
  const types=T.filter(t=>(t.runwayFt??99999)<=cut).length;
  const seats=T.filter(t=>(t.runwayFt??99999)<=cut).map(t=>t.seats).sort((a,b)=>b-a)[0]??0;
  console.log(`  runway < ${cut}ft: ${String(n).padStart(4)} airports (${(100*n/AP.length).toFixed(1)}%) | ${types} aircraft types fit, biggest ${seats} seats`);
}
console.log('\njet reference runway requirements:');
for(const id of ['a320ceo','b738','crj200','a220100','dhc8q400','atr72','dhc6','bn2islander','saab2000','cv580'])
  { const t=T.find(x=>x.id===id); if(t) console.log('  ',id.padEnd(12),String(t.seats).padStart(4)+'s', 'needs', String(t.runwayFt).padStart(5)+'ft'); }
console.log('\nairports under 4500ft with real demand-bearing population:');
const short=AP.filter(a=>(a.runwayFt??99999)<4500);
console.log('  count',short.length,' median pop', short.map(a=>a.population??0).sort((x,y)=>x-y)[Math.floor(short.length/2)]);
console.log('  examples:', short.slice(0,14).map(a=>`${a.code}(${a.runwayFt}ft)`).join(' '));
