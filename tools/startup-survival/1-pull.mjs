import fs from 'node:fs';
import { client } from './db.mjs';
const HW=new URL('../../', import.meta.url).pathname.replace(/\/$/,'');
const { AIRCRAFT_TYPES } = await import(HW + '/packages/engine/src/data/aircraft.js');
const { AIRPORTS } = await import(HW + '/packages/engine/src/data/airports.js');
const AC = new Map(AIRCRAFT_TYPES.map(t => [t.id, t]));
const AP = new Map(AIRPORTS.map(a => [a.code, a]));
const km = (a, b) => {
  const A = AP.get(a), B = AP.get(b); if (!A || !B) return null;
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(B.lat - A.lat), dLon = r(B.lon - A.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(r(A.lat))*Math.cos(r(B.lat))*Math.sin(dLon/2)**2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
};
const c = await client();
const q = async (s, p=[]) => (await c.query(s, p)).rows;

const worlds = await q('select id,name,status,"lengthYears","weeksPerDay","currentWeek","currentYear","maxPlayers","startedAt" from "World"');
const W = new Map(worlds.map(w => [w.id, { ...w, absWeek: (w.currentYear-1)*52 + w.currentWeek }]));

const airlines = await q(`select id,"worldId","accountId",name,hub,status,"joinedWeek",restarts,"restartedWeek",week,cash,svps,"createdAt" from "Airline"`);
const accounts = await q('select id,email,"displayName","createdAt" from "Account"');
const ACC = new Map(accounts.map(a => [a.id, a]));

// opening decisions only — keep the payload small
const decs2 = await q(`select "airlineId","worldId",week,type,payload,"createdAt" from "Decision"
  where type in ('ORDER_AIRCRAFT','ADD_ROUTE','ADD_CARGO_ROUTE') order by week asc`);
const byAirline = new Map();
for (const d of decs2) { if (!byAirline.has(d.airlineId)) byAirline.set(d.airlineId, []); byAirline.get(d.airlineId).push(d); }

// last real-world activity per account (any decision at all)
const act = await q(`select a."accountId", max(d."createdAt") last_dec, count(*)::int n
  from "Decision" d join "Airline" a on a.id = d."airlineId" group by 1`);
const ACT = new Map(act.map(r => [r.accountId, r]));

// history blobs, one at a time to stay small
const out = [];
for (const a of airlines) {
  const w = W.get(a.worldId);
  const genStart = a.restartedWeek ?? a.joinedWeek;
  const ds = (byAirline.get(a.id) || []).filter(d => d.week >= genStart);
  const orders = ds.filter(d => d.type === 'ORDER_AIRCRAFT');
  const routes = ds.filter(d => d.type === 'ADD_ROUTE' || d.type === 'ADD_CARGO_ROUTE');
  const openOrders = orders.filter(d => d.week <= genStart + 26);
  const openRoutes = routes.filter(d => d.week <= genStart + 26).slice(0, 8);
  const firstType = openOrders[0] ? AC.get(openOrders[0].payload.typeId) : null;
  // seat-weighted opening gauge
  let seats = 0, frames = 0;
  for (const o of openOrders) {
    const t = AC.get(o.payload.typeId); if (!t) continue;
    const n = o.payload.quantity || 1; seats += t.seats * n; frames += n;
  }
  const dists = openRoutes.map(d => km(d.payload.origin, d.payload.destination)).filter(Boolean);
  const st = (await q('select state from "Airline" where id=$1', [a.id]))[0].state;
  const hist = Array.isArray(st.statsHistory) ? st.statsHistory : [];
  const covered = hist.length && (hist[0].absWeek ?? 1e9) <= genStart + 1;
  let firstProfitWeek = null, weeksToProfit = null, peakFleet = 0;
  for (const h of hist) { if (h.fleet > peakFleet) peakFleet = h.fleet; }
  if (covered) {
    const p = hist.find(h => h.absWeek >= genStart && h.profit > 0);
    if (p) { firstProfitWeek = p.absWeek; weeksToProfit = p.absWeek - genStart; }
  }
  out.push({
    id: a.id, world: w.name, worldId: a.worldId, account: a.accountId,
    name: a.name, hub: a.hub, status: a.status, restarts: a.restarts,
    genStart, lastWeek: a.week, worldAbsWeek: w.absWeek,
    lifespan: a.week - genStart,
    newWorldRestrictions: !!st.newWorldRestrictions,
    bankruptcyReason: st.bankruptcyReason ?? null,
    openFirstType: firstType?.id ?? null,
    openFirstCat: firstType?.category ?? null,
    openFirstSeats: firstType?.seats ?? null,
    openAvgSeats: frames ? Math.round(seats / frames) : null,
    openFrames: frames, openOrderCount: openOrders.length,
    openRouteCount: openRoutes.length,
    openMedianKm: dists.length ? dists.sort((x,y)=>x-y)[Math.floor(dists.length/2)] : null,
    totalOrders: orders.length, totalRoutes: routes.length,
    peakFleet, weeksToProfit, histCovered: covered,
    cash: Number(a.cash), svps: Number(a.svps),
    lastDecision: ACT.get(a.accountId)?.last_dec ?? null,
    accountDecisions: ACT.get(a.accountId)?.n ?? 0,
    email: ACC.get(a.accountId)?.email ?? null,
  });
}
fs.writeFileSync('data.json', JSON.stringify({ worlds: [...W.values()], airlines: out }, null, 1));
console.log('rows', out.length, 'with opening order', out.filter(o=>o.openFirstType).length, 'hist covered', out.filter(o=>o.histCovered).length);
await c.end();
