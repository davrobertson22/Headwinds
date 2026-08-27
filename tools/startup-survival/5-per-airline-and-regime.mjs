import fs from 'node:fs';
import { client } from './db.mjs';
const { airlines: A } = JSON.parse(fs.readFileSync('data.json','utf8'));
const bucket=a=>a.openAvgSeats==null?null:a.openAvgSeats<80?'small':a.openAvgSeats<130?'rj':a.openAvgSeats<220?'nb':'wb';
const med=a=>a.length?[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]:null;
const c=await client();
const recs=[];
for (const a of A) {
  const b=bucket(a); if(!b) continue;
  const st=(await c.query('select state from "Airline" where id=$1',[a.id])).rows[0].state;
  const fh=Array.isArray(st.financialHistory)?st.financialHistory:[];
  const first=fh.filter(h=>{const abs=(h.year-1)*52+h.week;return abs>=a.genStart&&abs<=a.genStart+52;});
  if(first.length<4) continue;
  const s=k=>first.reduce((t,h)=>t+(h[k]||0),0);
  recs.push({b,name:a.name,world:a.world,status:a.status,restr:a.newWorldRestrictions,
    wks:first.length,rev:s('revenue')/first.length,hq:s('hqCost')/first.length,
    fuel:s('fuel')/first.length,crew:(s('crew')+s('labor'))/first.length,
    maint:s('maintenance')/first.length,land:s('landingFees')/first.length,
    lease:s('leases')/first.length,profit:s('profit')/first.length,peak:a.peakFleet});
}
console.log('--- SMALL-GAUGE STARTUPS, first year weekly averages ---');
console.table(recs.filter(r=>r.b==='small').sort((x,y)=>x.rev-y.rev).map(r=>({
  airline:r.name.slice(0,22), world:r.world.slice(0,14), restr:r.restr?'NWR':'legacy', status:r.status, peakFleet:r.peak,
  revenue:Math.round(r.rev).toLocaleString(), HQ:Math.round(r.hq).toLocaleString(),
  'HQ/rev':r.rev>0?(100*r.hq/r.rev).toFixed(0)+'%':'∞', profit:Math.round(r.profit).toLocaleString()})));

console.log('\n--- HQ/revenue by bucket AND overhead regime (median of per-airline ratios) ---');
const rows=[];
for (const b of ['small','rj','nb','wb']) for (const r of [false,true]) {
  const g=recs.filter(x=>x.b===b&&x.restr===r&&x.rev>0);
  if(!g.length) continue;
  rows.push({bucket:b, regime:r?'per-departure (NWR)':'fleet-count (legacy)', n:g.length,
    'median HQ/rev':(100*med(g.map(x=>x.hq/x.rev))).toFixed(0)+'%',
    'median wkly rev':Math.round(med(g.map(x=>x.rev))).toLocaleString(),
    'median wkly HQ':Math.round(med(g.map(x=>x.hq))).toLocaleString(),
    'median margin':(100*med(g.map(x=>x.profit/x.rev))).toFixed(0)+'%'});
}
console.table(rows);
await c.end();
