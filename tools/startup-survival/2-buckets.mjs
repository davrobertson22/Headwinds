import fs from 'node:fs';
const { worlds, airlines: A } = JSON.parse(fs.readFileSync('data.json','utf8'));
const pct = (n,d) => d ? (100*n/d).toFixed(0)+'%' : '—';
const med = a => a.length ? [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)] : null;

console.log('=== no opening order ===');
const none = A.filter(a=>!a.openFirstType);
console.log('count', none.length, 'status:', JSON.stringify(none.reduce((m,a)=>(m[a.status]=(m[a.status]||0)+1,m),{})));
console.log('median lifespan', med(none.map(a=>a.lifespan)), 'median totalOrders', med(none.map(a=>a.totalOrders)));
console.log('by world', JSON.stringify(none.reduce((m,a)=>(m[a.world]=(m[a.world]||0)+1,m),{})));

console.log('\n=== opening category × outcome (all worlds) ===');
const cats = ['Turboprop','Regional Jet','Narrow Body','Wide Body','Double Deck','Supersonic'];
const rows = [];
for (const c of cats) {
  const g = A.filter(a=>a.openFirstCat===c);
  if (!g.length) continue;
  const dead = g.filter(a=>a.status!=='ACTIVE');
  rows.push({ cat:c, n:g.length, dead:dead.length, deathRate:pct(dead.length,g.length),
    medLifeDead: med(dead.map(a=>a.lifespan)), medLifeAll: med(g.map(a=>a.lifespan)),
    medWeeksToProfit: med(g.filter(a=>a.weeksToProfit!=null).map(a=>a.weeksToProfit)),
    neverProfit: g.filter(a=>a.histCovered && a.weeksToProfit==null).length,
    covered: g.filter(a=>a.histCovered).length,
    medPeakFleet: med(g.map(a=>a.peakFleet)) });
}
console.table(rows);

console.log('\n=== opening gauge buckets (seat-weighted first 26wk) ===');
const bucket = a => a.openAvgSeats==null ? null : a.openAvgSeats<80?'<80 (props/small RJ)': a.openAvgSeats<130?'80-129 (RJ)': a.openAvgSeats<220?'130-219 (NB)':'220+ (WB)';
const bs = ['<80 (props/small RJ)','80-129 (RJ)','130-219 (NB)','220+ (WB)'];
console.table(bs.map(b=>{
  const g=A.filter(a=>bucket(a)===b); const dead=g.filter(a=>a.status!=='ACTIVE');
  return { bucket:b, n:g.length, dead:dead.length, deathRate:pct(dead.length,g.length),
    medLifespan: med(g.map(a=>a.lifespan)), medLifeDead: med(dead.map(a=>a.lifespan)),
    medWeeksToProfit: med(g.filter(a=>a.weeksToProfit!=null).map(a=>a.weeksToProfit)),
    neverProfit: g.filter(a=>a.histCovered&&a.weeksToProfit==null).length+'/'+g.filter(a=>a.histCovered).length,
    medPeak: med(g.map(a=>a.peakFleet)) };
}));

console.log('\n=== death within first 52 weeks of life (uncensored view) ===');
console.table(bs.map(b=>{
  const g=A.filter(a=>bucket(a)===b && (a.lifespan>=52 || a.status!=='ACTIVE'));
  const early=g.filter(a=>a.status!=='ACTIVE'&&a.lifespan<52);
  return { bucket:b, atRisk:g.length, diedBefore52:early.length, rate:pct(early.length,g.length) };
}));

console.log('\n=== opening route length ===');
const db=['<800km','800-2500km','2500-6000km','6000km+'];
const dbucket=a=>a.openMedianKm==null?null:a.openMedianKm<800?db[0]:a.openMedianKm<2500?db[1]:a.openMedianKm<6000?db[2]:db[3];
console.table(db.map(b=>{const g=A.filter(a=>dbucket(a)===b);const dead=g.filter(a=>a.status!=='ACTIVE');
  return {bucket:b,n:g.length,deathRate:pct(dead.length,g.length),medLifespan:med(g.map(a=>a.lifespan)),medWeeksToProfit:med(g.filter(a=>a.weeksToProfit!=null).map(a=>a.weeksToProfit))};}));

console.log('\n=== bankruptcy reasons ===');
console.table(Object.entries(A.filter(a=>a.bankruptcyReason).reduce((m,a)=>(m[a.bankruptcyReason]=(m[a.bankruptcyReason]||0)+1,m),{})));

console.log('\n=== restrictions regime ===');
for (const flag of [true,false]) {
  const g=A.filter(a=>a.newWorldRestrictions===flag);
  console.log('newWorldRestrictions',flag,'n',g.length,'deathRate',pct(g.filter(a=>a.status!=='ACTIVE').length,g.length),
    'worlds',[...new Set(g.map(a=>a.world))].join('|'));
}
