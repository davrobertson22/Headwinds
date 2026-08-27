import fs from 'node:fs';
const HW=new URL('../../', import.meta.url).pathname.replace(/\/$/,'');
const { AIRCRAFT_TYPES } = await import(HW+'/packages/engine/src/data/aircraft.js');
const { calcHQCost, HQ_DEPARTURE_FEE, HQ_BASE_WEEKLY } = await import(HW+'/packages/engine/src/data/overhead.js');
const AC=new Map(AIRCRAFT_TYPES.map(t=>[t.id,t]));
const { airlines: A } = JSON.parse(fs.readFileSync('data.json','utf8'));
const S=new Map(JSON.parse(fs.readFileSync('states.json','utf8')).map(r=>[r.id,r]));

console.log('--- sanity: calcHQCost vs observed hqCost ---');
console.log(' legacy fleet-count curve:', [1,2,3,5,10,40].map(n=>n+':$'+calcHQCost(n).toLocaleString()).join('  '));
console.log(' NWR base $'+HQ_BASE_WEEKLY.toLocaleString()+' + per-departure', JSON.stringify(HQ_DEPARTURE_FEE));

console.log('\n--- zero-revenue first year ---');
const zero=[];
for (const a of A) {
  const fh=S.get(a.id)?.fh||[];
  const first=fh.filter(h=>{const abs=(h.year-1)*52+h.week;return abs>=a.genStart&&abs<=a.genStart+52;});
  if(first.length<4) continue;
  if(first.reduce((s,h)=>s+(h.revenue||0),0)===0)
    zero.push({name:a.name.slice(0,22),world:a.world.slice(0,14),status:a.status,addRoutes:a.totalRoutes,orders:a.totalOrders,lifespanWks:a.lifespan});
}
console.log('airlines with $0 revenue across their entire first year:',zero.length);
console.table(zero);

console.log('\n--- does ANY small operator make money? (<=6 frames, avg <100 seats, last 12 wks) ---');
const rows=[];
for (const a of A) {
  const st=S.get(a.id); const fleet=st?.fleet||[];
  if(!fleet.length||fleet.length>6) continue;
  const seats=fleet.map(f=>AC.get(f.typeId)?.seats??0);
  const avg=seats.reduce((s,x)=>s+x,0)/seats.length;
  if(avg>=100) continue;
  const fh=(st.fh||[]).slice(-12); if(!fh.length) continue;
  const m=k=>fh.reduce((s,h)=>s+(h[k]||0),0)/fh.length;
  rows.push({airline:a.name.slice(0,20),world:a.world.slice(0,14),status:a.status,frames:fleet.length,
    avgSeats:Math.round(avg),nwr:st.nwr?'NWR':'legacy',wklyRev:Math.round(m('revenue')),wklyHQ:Math.round(m('hqCost')),wklyProfit:Math.round(m('profit'))});
}
console.table(rows.map(r=>({...r,wklyRev:r.wklyRev.toLocaleString(),wklyHQ:r.wklyHQ.toLocaleString(),wklyProfit:r.wklyProfit.toLocaleString()})));
console.log('profitable:',rows.filter(r=>r.wklyProfit>0).length,'/',rows.length);

console.log('\n--- island-hopper profile: opening gauge <100 seats AND median route <1200km ---');
const hop=A.filter(a=>a.openAvgSeats!=null&&a.openAvgSeats<100&&a.openMedianKm!=null&&a.openMedianKm<1200);
const main=A.filter(a=>a.openAvgSeats!=null&&a.openAvgSeats>=130);
const d=x=>x.filter(a=>a.status!=='ACTIVE').length;
console.log(`hopper  n=${hop.length} dead=${d(hop)} (${(100*d(hop)/hop.length).toFixed(0)}%)  never-profitable ${hop.filter(a=>a.histCovered&&a.weeksToProfit==null).length}/${hop.filter(a=>a.histCovered).length}`);
console.log(`mainline n=${main.length} dead=${d(main)} (${(100*d(main)/main.length).toFixed(0)}%)  never-profitable ${main.filter(a=>a.histCovered&&a.weeksToProfit==null).length}/${main.filter(a=>a.histCovered).length}`);
console.table(hop.map(a=>({airline:a.name.slice(0,20),world:a.world.slice(0,14),hub:a.hub,openSeats:a.openAvgSeats,openKm:a.openMedianKm,status:a.status,lifespan:a.lifespan,peakFleet:a.peakFleet})));
