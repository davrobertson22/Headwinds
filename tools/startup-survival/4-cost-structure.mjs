import fs from 'node:fs';
import { client } from './db.mjs';
const { airlines: A } = JSON.parse(fs.readFileSync('data.json','utf8'));
const bucket = a => a.openAvgSeats==null?null:a.openAvgSeats<80?'small':a.openAvgSeats<130?'rj':a.openAvgSeats<220?'nb':'wb';
const pct=(n,d)=>d?(100*n/d).toFixed(0)+'%':'—';
const med=a=>a.length?[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]:null;
const perAcct=new Map(); for(const a of A){if(!perAcct.has(a.account))perAcct.set(a.account,[]);perAcct.get(a.account).push(a);}

console.log('--- FIRST-TIMERS ONLY (accounts with exactly one airline ever) ---');
for (const b of ['small','rj','nb','wb']) {
  const g=A.filter(a=>bucket(a)===b&&perAcct.get(a.account).length===1);
  const dead=g.filter(a=>a.status!=='ACTIVE');
  const cov=g.filter(a=>a.histCovered);
  console.log(b.padEnd(6),'n',String(g.length).padStart(2),' dead',pct(dead.length,g.length).padStart(4),
    ' neverProfit',(cov.filter(a=>a.weeksToProfit==null).length+'/'+cov.length).padStart(6),
    ' medLifespan',med(g.map(a=>a.lifespan)));
}

console.log('\n--- REAL COST STRUCTURE, first year of life (from financialHistory) ---');
const c = await client();
const out={};
for (const a of A) {
  const b=bucket(a); if(!b) continue;
  const st=(await c.query('select state from "Airline" where id=$1',[a.id])).rows[0].state;
  const fh=Array.isArray(st.financialHistory)?st.financialHistory:[];
  if(!fh.length) continue;
  const first=fh.filter(h=>{const abs=(h.year-1)*52+h.week; return abs>=a.genStart && abs<=a.genStart+52;});
  if(first.length<4) continue;
  const sum=k=>first.reduce((s,h)=>s+(h[k]||0),0);
  const rev=sum('revenue'), hq=sum('hqCost'), prof=sum('profit');
  (out[b] ||= []).push({ n:first.length, rev, hq, prof, hqShare: rev>0?hq/rev:null,
     margin: rev>0?prof/rev:null, fleet:a.peakFleet, name:a.name, status:a.status });
}
const rows=[];
for (const b of ['small','rj','nb','wb']) {
  const g=out[b]||[]; if(!g.length){rows.push({bucket:b,n:0});continue;}
  rows.push({ bucket:b, n:g.length,
    'median wkly revenue': Math.round(med(g.map(x=>x.rev/x.n))).toLocaleString(),
    'median wkly HQ cost': Math.round(med(g.map(x=>x.hq/x.n))).toLocaleString(),
    'HQ as % of revenue': (100*med(g.filter(x=>x.hqShare!=null).map(x=>x.hqShare))).toFixed(0)+'%',
    'median margin': (100*med(g.filter(x=>x.margin!=null).map(x=>x.margin))).toFixed(0)+'%',
    'loss-making yr1': pct(g.filter(x=>x.prof<0).length,g.length) });
}
console.table(rows);
await c.end();
