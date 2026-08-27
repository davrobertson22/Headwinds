// One SBH run, week by week, with the full cost bridge — so the sim's numbers
// can be checked against the game's own P&L instead of trusted.
import { gameReducer, addRouteBlockReason } from '../../packages/engine/src/reducer.mjs';
import { seedAirlineState } from '../../apps/headwinds-server/src/lib/worldService.mjs';
import { worldFuelIndex, worldMarketIndex } from '../../apps/headwinds-server/src/lib/worldEconomy.mjs';
import { tickEvents, rollEvents } from '../../packages/engine/src/data/events.js';
import { getAircraftType } from '../../packages/engine/src/data/aircraft.js';
import { getAirport, AIRPORTS } from '../../packages/engine/src/data/airports.js';
import { baseCityPairDemand, distanceKm } from '../../packages/engine/src/utils/market.js';
import { checkRouteRestrictions } from '../../packages/engine/src/data/airportRestrictions.js';
import { referencePrice, maxFrequency, effectiveRangeKm, NWR_MAX_WEEKLY_BLOCK_HOURS } from '../../packages/engine/src/utils/simulation.js';

const HUB = process.argv[2] ?? 'SBH';
const TYPE = process.argv[3] ?? 'dhc6';
const FREQ = process.argv[4] ?? '7';
const TARGET = parseInt(process.argv[5] ?? '4', 10);
const PRICE = parseFloat(process.argv[6] ?? '1.0');
const AP = Array.isArray(AIRPORTS) ? AIRPORTS : Object.values(AIRPORTS);
const t = getAircraftType(TYPE), h = getAirport(HUB);
const range = effectiveRangeKm({}, t);
const dests = AP.filter(a=>a.code!==HUB).map(a=>({code:a.code,dist:Math.round(distanceKm(h,a)),demand:baseCityPairDemand(HUB,a.code)}))
  .filter(d=>d.dist>100&&d.dist<=range&&d.demand>0)
  .filter(d=>!checkRouteRestrictions(HUB,d.code,d.dist,7,t.category,{aircraftType:t}))
  .map(d=>({...d,rp:d.demand*referencePrice(HUB,d.code)})).sort((a,b)=>b.rp-a.rp);

const world={id:'insp',worldSeed:'insp',currentYear:1,currentWeek:1,tickConfig:{startingCapital:15e6,demandMultiplier:1,newWorldRestrictions:true}};
let s = seedAirlineState(world,{airlineName:'Gustavia Air',hub:HUB});
let events=[];
console.log(`hub ${HUB}  type ${TYPE} (${t.seats} seats)  freq ${FREQ}  fleetTarget ${TARGET}  priceMult ${PRICE}`);
console.log('reachable markets:', dests.length);
for(let w=1;w<=104;w++){
  const pend=(s.pendingOrders??[]).reduce((a,o)=>a+(o.quantity??1),0);
  const served=new Set(s.routes.map(r=>r.origin===HUB?r.destination:r.origin));
  const next=dests.find(d=>!served.has(d.code));
  if(next && s.fleet.filter(a=>a.status!=='retired').length+pend<TARGET && s.cash>1_200_000)
    s=gameReducer(s,{type:'ORDER_AIRCRAFT',typeId:TYPE,quantity:1,ownershipType:'lease'});
  for(const ac of s.fleet.filter(a=>a.status!=='retired')){
    if(s.routes.some(r=>r.aircraftId===ac.id))continue;
    const sv=new Set(s.routes.map(r=>r.origin===HUB?r.destination:r.origin));
    const d=dests.find(x=>!sv.has(x.code)); if(!d)break;
    const f=FREQ==='max'?Math.max(1,maxFrequency(d.dist,t,NWR_MAX_WEEKLY_BLOCK_HOURS)):parseInt(FREQ,10);
    if(!(s.gates?.[d.code]>0))s=gameReducer(s,{type:'ADD_GATE',airportCode:d.code});
    let g=0; while(g++<60){const hs=s.routes.filter(r=>r.origin===HUB||r.destination===HUB).reduce((a,r)=>a+r.weeklyFrequency,0);
      if(hs+f<=(s.gates?.[HUB]??0)*50)break; const g0=s.gates?.[HUB]??0; s=gameReducer(s,{type:'ADD_GATE',airportCode:HUB}); if((s.gates?.[HUB]??0)===g0)break;}
    const act={type:'ADD_ROUTE',origin:HUB,destination:d.code,aircraftId:ac.id,weeklyFrequency:f,ticketPrice:Math.max(1,Math.round(referencePrice(HUB,d.code)*PRICE))};
    const b=addRouteBlockReason(s,act); if(b){console.log(`  w${w} REFUSED ${HUB}-${d.code}: ${b.reason??b.short}`);continue;}
    s=gameReducer(s,act);
  }
  const {updated}=tickEvents(events); events=[...updated,...rollEvents(updated,{multiplayer:true})];
  s=gameReducer(s,{type:'ADVANCE_WEEK',worldFuelIndex:worldFuelIndex('insp',w),worldEvents:events,valuationNoise:0,marketIndex:worldMarketIndex('insp',w),incomingDividends:0});
  const R=s.lastReport, F=(s.financialHistory??[]).slice(-1)[0]??{};
  if([1,4,8,13,26,39,52,65,78,91,104].includes(w)||s.phase==='bankrupt'){
    const money=(x)=>'$'+Math.round(x??0).toLocaleString();
    console.log(`w${String(w).padStart(3)} fleet ${s.fleet.filter(a=>a.status!=='retired').length} routes ${s.routes.length} cash ${money(s.cash).padStart(12)} | rev ${money(F.revenue).padStart(10)} pax ${Math.round(R.totalPassengers??0)} LF? | cost ${money(F.totalCost).padStart(10)} profit ${money(F.profit).padStart(11)}`);
    console.log(`      breakdown: fuel ${money(R.totalFuel)} crew ${money(R.totalCrew)} labor ${money(R.totalLaborCosts)} lease ${money(R.totalLeases)} maint ${money(R.totalMaintenance)} landing ${money(R.totalLandingFees)} gates ${money(R.totalGateFees)} HQ ${money(R.totalHQCost)} ins ${money(R.totalInsurance)} hubInv ${money(R.totalHubInvestment)} ground ${money(R.totalGroundHandling)} distrib ${money(R.totalDistributionCost)} catering ${money(R.totalCatering)}`);
  }
  if(s.phase==='bankrupt'){console.log(`BANKRUPT week ${w} (${s.bankruptcyReason})`);break;}
}
