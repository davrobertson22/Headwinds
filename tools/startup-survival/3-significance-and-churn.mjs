import fs from 'node:fs';
const { airlines: A } = JSON.parse(fs.readFileSync('data.json','utf8'));
const bucket = a => a.openAvgSeats==null?null:a.openAvgSeats<80?'small':a.openAvgSeats<130?'rj':a.openAvgSeats<220?'nb':'wb';
const pct=(n,d)=>d?(100*n/d).toFixed(0)+'%':'—';

// Fisher exact (two-tailed) for small 2x2
function lfact(n){let s=0;for(let i=2;i<=n;i++)s+=Math.log(i);return s;}
function hyp(a,b,c,d){return Math.exp(lfact(a+b)+lfact(c+d)+lfact(a+c)+lfact(b+d)-lfact(a)-lfact(b)-lfact(c)-lfact(d)-lfact(a+b+c+d));}
function fisher(a,b,c,d){const p0=hyp(a,b,c,d);let p=0;const n=a+b+c+d;
  for(let i=0;i<=n;i++){const j=a+b-i,k=a+c-i,l=d-(a-i);if(j<0||k<0||l<0)continue;const q=hyp(i,j,k,l);if(q<=p0*1.0000001)p+=q;}
  return p;}

console.log('--- died within 52 weeks: small(<80) vs narrowbody ---');
const g=(b)=>A.filter(a=>bucket(a)===b&&(a.lifespan>=52||a.status!=='ACTIVE'));
const S=g('small'), N=g('nb');
const sd=S.filter(a=>a.status!=='ACTIVE'&&a.lifespan<52).length, nd=N.filter(a=>a.status!=='ACTIVE'&&a.lifespan<52).length;
console.log(`small ${sd}/${S.length} (${pct(sd,S.length)})  nb ${nd}/${N.length} (${pct(nd,N.length)})  fisher p=${fisher(sd,S.length-sd,nd,N.length-nd).toFixed(3)}`);

console.log('\n--- never had a profitable week (full-history airlines only) ---');
for (const b of ['small','rj','nb','wb']) {
  const c=A.filter(a=>bucket(a)===b&&a.histCovered);
  const np=c.filter(a=>a.weeksToProfit==null).length;
  console.log(b, `${np}/${c.length}`, pct(np,c.length));
}
const Sc=A.filter(a=>bucket(a)==='small'&&a.histCovered), Nc=A.filter(a=>bucket(a)==='nb'&&a.histCovered);
const snp=Sc.filter(a=>a.weeksToProfit==null).length, nnp=Nc.filter(a=>a.weeksToProfit==null).length;
console.log('fisher small-vs-nb p=', fisher(snp,Sc.length-snp,nnp,Nc.length-nnp).toFixed(4));

console.log('\n--- confound: are small-gauge starters first-timers? ---');
const perAcct=new Map(); for(const a of A){ if(!perAcct.has(a.account))perAcct.set(a.account,[]); perAcct.get(a.account).push(a); }
for (const b of ['small','rj','nb','wb']) {
  const gg=A.filter(a=>bucket(a)===b);
  const firstEver=gg.filter(a=>{const list=perAcct.get(a.account).slice().sort((x,y)=>new Date(x.genStart)-0-0);return perAcct.get(a.account).length===1;});
  const medWorlds=gg.map(a=>perAcct.get(a.account).length);
  console.log(b,'n',gg.length,'accounts w/ only ONE airline ever:',pct(firstEver.length,gg.length),
    'mean airlines per account', (medWorlds.reduce((x,y)=>x+y,0)/gg.length).toFixed(2));
}

console.log('\n--- churn: after a death, did the account ever act again? ---');
const now=new Date('2026-08-26T12:00:00Z');
const rows=[];
for (const b of ['small','rj','nb','wb']) {
  const dead=A.filter(a=>bucket(a)===b&&a.status!=='ACTIVE');
  const stillActive=dead.filter(a=>{
    const others=perAcct.get(a.account).filter(o=>o.id!==a.id);
    return others.some(o=>o.status==='ACTIVE') || a.restarts>0;
  });
  const goneQuiet=dead.filter(a=>a.lastDecision && (now-new Date(a.lastDecision))/864e5 > 14);
  rows.push({bucket:b,dead:dead.length,'has another live airline / restarted':pct(stillActive.length,dead.length),
    'no decision in 14+ days':pct(goneQuiet.length,dead.length)});
}
console.table(rows);

console.log('\n--- overall account churn ---');
const accts=[...perAcct.entries()];
const quiet=accts.filter(([id,l])=>l[0].lastDecision && (now-new Date(l[0].lastDecision))/864e5>14);
console.log('accounts', accts.length, 'silent 14+ days', quiet.length, pct(quiet.length,accts.length));
const everDied=accts.filter(([id,l])=>l.some(a=>a.status!=='ACTIVE'));
const diedThenQuit=everDied.filter(([id,l])=>!l.some(a=>a.status==='ACTIVE'));
console.log('accounts that lost an airline', everDied.length, 'of those with NO live airline now', diedThenQuit.length, pct(diedThenQuit.length,everDied.length));
