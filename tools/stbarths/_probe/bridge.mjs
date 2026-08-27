// Full P&L bridge for the best-case SBH airline at week 26, every line.
import { gameReducer, addRouteBlockReason } from '../../../packages/engine/src/reducer.mjs';
import { seedAirlineState } from '../../../apps/headwinds-server/src/lib/worldService.mjs';
import { worldFuelIndex, worldMarketIndex } from '../../../apps/headwinds-server/src/lib/worldEconomy.mjs';
import { tickEvents, rollEvents } from '../../../packages/engine/src/data/events.js';
import { getAircraftType } from '../../../packages/engine/src/data/aircraft.js';
import { getAirport, AIRPORTS } from '../../../packages/engine/src/data/airports.js';
import { baseCityPairDemand, distanceKm } from '../../../packages/engine/src/utils/market.js';
import { checkRouteRestrictions } from '../../../packages/engine/src/data/airportRestrictions.js';
import { referencePrice, maxFrequency, effectiveRangeKm, NWR_MAX_WEEKLY_BLOCK_HOURS } from '../../../packages/engine/src/utils/simulation.js';
const HUB=process.env.HUB??'SBH', TYPE=process.env.TYPE??'dhc6', FLEET=parseInt(process.env.FLEET??'1',10);
const AP=Array.isArray(AIRPORTS)?AIRPORTS:Object.values(AIRPORTS);
const t=getAircraftType(TYPE),h=getAirport(HUB),range=effectiveRangeKm({},t);
const dests=AP.filter(a=>a.code!==HUB).map(a=>({code:a.code,dist:Math.round(distanceKm(h,a)),demand:baseCityPairDemand(HUB,a.code)}))
 .filter(d=>d.dist>100&&d.dist<=range&&d.demand>0).filter(d=>!checkRouteRestrictions(HUB,d.code,d.dist,7,t.category,{aircraftType:t}))
 .map(d=>({...d,rp:d.demand*referencePrice(HUB,d.code)})).sort((a,b)=>b.rp-a.rp);
const world={id:'b',worldSeed:'b',currentYear:1,currentWeek:1,tickConfig:{startingCapital:15e6,demandMultiplier:1,newWorldRestrictions:true}};
let s=seedAirlineState(world,{airlineName:'G',hub:HUB});let ev=[];
for(let w=1;w<=26;w++){
  const pend=(s.pendingOrders??[]).reduce((a,o)=>a+(o.quantity??1),0);
  const idle=s.fleet.filter(a=>a.status!=='retired'&&!s.routes.some(r=>r.aircraftId===a.id)).length;
  if(idle===0&&pend===0&&s.fleet.filter(a=>a.status!=='retired').length<FLEET&&s.cash>1.2e6)
    s=gameReducer(s,{type:'ORDER_AIRCRAFT',typeId:TYPE,quantity:1,ownershipType:'lease'});
  for(const ac of s.fleet.filter(a=>a.status!=='retired')){
    for(let k=0;k<8;k++){
      const mine=s.routes.filter(r=>r.aircraftId===ac.id).length; if(mine>k)continue;
      const sv=new Set(s.routes.map(r=>r.origin===HUB?r.destination:r.origin));
      const d=dests.find(x=>!sv.has(x.code)); if(!d)break;
      const capF=Math.max(1,maxFrequency(d.dist,t,NWR_MAX_WEEKLY_BLOCK_HOURS));
      const f=Math.max(1,Math.min(capF,Math.ceil((d.demand*0.35)/(t.seats*0.75))));
      if(!(s.gates?.[d.code]>0))s=gameReducer(s,{type:'ADD_GATE',airportCode:d.code});
      let g=0;while(g++<60){const hs=s.routes.filter(r=>r.origin===HUB||r.destination===HUB).reduce((a,r)=>a+r.weeklyFrequency,0);
        if(hs+f<=(s.gates?.[HUB]??0)*50)break;const g0=s.gates?.[HUB]??0;s=gameReducer(s,{type:'ADD_GATE',airportCode:HUB});if((s.gates?.[HUB]??0)===g0)break;}
      const a={type:'ADD_ROUTE',origin:HUB,destination:d.code,aircraftId:ac.id,weeklyFrequency:f,ticketPrice:Math.max(1,Math.round(referencePrice(HUB,d.code)))};
      if(addRouteBlockReason(s,a))break;
      const rb=s.routes.length; s=gameReducer(s,a); if(s.routes.length===rb)break;
    }
  }
  if(s.routes.length>=1&&(s.marketingBudget??0)<20000&&s.cash>2e6)s=gameReducer(s,{type:'SET_MARKETING_BUDGET',amount:20000});
  const {updated}=tickEvents(ev);ev=[...updated,...rollEvents(updated,{multiplayer:true})];
  s=gameReducer(s,{type:'ADVANCE_WEEK',worldFuelIndex:worldFuelIndex('b',w),worldEvents:ev,valuationNoise:0,marketIndex:worldMarketIndex('b',w),incomingDividends:0});
}
const F=(s.financialHistory??[]).slice(-1)[0]??{};
console.log(`=== ${HUB} / ${TYPE} / fleet ${FLEET} — week 26 ===`);
console.log('gates held:',JSON.stringify(s.gates),' routes:',s.routes.length,' freqs:',s.routes.map(r=>r.weeklyFrequency).join(','));
const skip=new Set(['label','week','year','cash']);
const rows=Object.entries(F).filter(([k,v])=>typeof v==='number'&&!skip.has(k)&&Math.abs(v)>=1).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
for(const [k,v] of rows) console.log('  ',k.padEnd(24),('$'+Math.round(v).toLocaleString()).padStart(13), (F.revenue?((100*v/F.revenue).toFixed(0)+'% of rev'):''));
