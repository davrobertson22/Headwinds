import { client } from './db.mjs';
import fs from 'node:fs';
const { airlines: A } = JSON.parse(fs.readFileSync('data.json','utf8'));
const AM=new Map(A.map(a=>[a.id,a]));
const c=await client();
const r=await c.query(`select "airlineId", min("createdAt") first, max("createdAt") last, count(*)::int n from "Decision" group by 1`);
const D=new Map(r.rows.map(x=>[x.airlineId,x]));
const FIX=new Date('2026-08-13T00:00:00Z');
const bucket=a=>a.openAvgSeats==null?null:a.openAvgSeats<100?'small(<100)':'big(100+)';
const pct=(n,d)=>d?(100*n/d).toFixed(0)+'%':'—';
const rows=[];
for (const era of ['pre-fix (founded before 2026-08-13)','post-fix']) {
  for (const b of ['small(<100)','big(100+)']) {
    const g=A.filter(a=>{
      const d=D.get(a.id); if(!d) return false;
      const pre = new Date(d.first) < FIX;
      return bucket(a)===b && (era.startsWith('pre') ? pre : !pre);
    });
    if(!g.length) { rows.push({era,gauge:b,n:0}); continue; }
    const dead=g.filter(a=>a.status!=='ACTIVE');
    rows.push({era,gauge:b,n:g.length,dead:dead.length,deathRate:pct(dead.length,g.length)});
  }
}
console.table(rows);
console.log('\nairlines whose FIRST decision came after the fix:',
  A.filter(a=>D.get(a.id)&&new Date(D.get(a.id).first)>=FIX).length);
console.log('most recent decision anywhere:', String([...D.values()].map(x=>new Date(x.last)).sort((a,b)=>b-a)[0]));
await c.end();
