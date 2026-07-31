// Is the load-factor model moving MONEY on a live airline, or just the LF badge?
//
//   node --env-file=.env tools/lf-econ-report.mjs <player name or email fragment>
//
// Read-only. Written 2026-07-31 for "my load factor is now 87% but it has
// barely affected my profits".
//
// THE TEST: take the airline's CURRENT state blob and run one weeklyTick twice —
// once with newWorldRestrictions stripped (the old flat min(demand, seats) fill)
// and once as-is. Everything else — fares, fleet, fuel, seniority inputs — is
// identical, so the delta between the two columns is exactly what the load
// model contributes to this airline's economics this week. If the "delta"
// column shows revenue down and profit down, the model is driving money. If it
// shows ~0 while the LF column moved, THAT would be a display-only bug.
//
// Context for reading the result: at demand ≈ capacity the model books ~87%
// (the parity bite is ~-13% of revenue); deeply oversubscribed routes sit at
// 93-97%. And remember the drop happened ONCE, at deploy — week-over-week
// comparisons between two post-deploy ticks will look flat because both weeks
// are already on the new model.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { weeklyTick, weekToGameDate } from '@tailwinds/engine/utils/simulation.js';
import { setFareIndex } from '@tailwinds/engine/utils/market.js';

const prisma = new PrismaClient();
const who = (process.argv[2] ?? '').toLowerCase();
if (!who) { console.error('Usage: node tools/lf-econ-report.mjs <player name or email fragment>'); process.exit(1); }

const M   = (n) => '$' + ((Number(n) || 0) / 1e6).toFixed(2) + 'M';
const pct = (a, b) => (a ? ((100 * (b - a)) / a).toFixed(1) + '%' : '—');

const airlines = (await prisma.airline.findMany({
  include: { account: { select: { email: true, displayName: true } }, world: true },
})).filter((a) =>
  `${a.name} ${a.account?.email ?? ''} ${a.account?.displayName ?? ''}`.toLowerCase().includes(who));
if (!airlines.length) { console.error('No airline matched ' + who); process.exit(1); }

for (const a of airlines) {
  const st = a.state ?? {};
  if (st.newWorldRestrictions !== true) {
    console.log(`\n${a.name} (${a.world?.name}) — not a restricted world, skipping`);
    continue;
  }
  const absWeek  = (a.world.currentYear - 1) * 52 + a.world.currentWeek;
  const gameDate = st.gameDate ?? weekToGameDate(a.world.currentWeek);

  setFareIndex(st.fareIndex ?? 1);
  const common = { ...st, gameDate, absWeek, fuelMultiplier: st.fuelPrice?.index ?? 1 };
  const off = weeklyTick({ ...common, newWorldRestrictions: false });
  const on  = weeklyTick({ ...common });   // as-is: flag on, load model live

  const lfOf = (r) => r.routeResults?.length
    ? r.routeResults.reduce((s, x) => s + (x.loadFactor ?? 0), 0) / r.routeResults.length : 0;

  console.log('\n' + '='.repeat(74));
  console.log(`${a.name} — world "${a.world.name}"  Y${a.world.currentYear}W${a.world.currentWeek}`);
  console.log(`fareIndex ${st.fareIndex ?? '(unset)'}  routes ${(st.routes ?? []).length}  fleet ${(st.fleet ?? []).length}`);
  console.log(`\n                        old fill      load model    delta   <- one identical week`);
  console.log(`avg load factor         ${(lfOf(off) * 100).toFixed(1).padEnd(13)} ${(lfOf(on) * 100).toFixed(1).padEnd(12)}`);
  for (const [label, k] of [
    ['pax+cargo revenue', 'totalRevenue'],
    ['catering revenue',  'totalCateringRevenue'],
    ['ancillary revenue', 'totalAncillaryRevenue'],
    ['fuel (fixed/flt)',  'totalFuel'],
    ['crew (fixed/flt)',  'totalCrew'],
    ['catering cost',     'totalCatering'],
    ['ground handling',   'totalGroundHandling'],
    ['distribution',      'totalDistributionCost'],
    ['NET CASH DELTA',    'cashDelta'],
  ]) {
    console.log(`${label.padEnd(23)} ${M(off[k]).padEnd(13)} ${M(on[k]).padEnd(12)} ${pct(off[k], on[k])}`);
  }

  // The five routes where the model bites hardest — where the padlock actually sits.
  const byId = new Map((off.routeResults ?? []).map((r) => [r.routeId ?? `${r.origin}-${r.destination}`, r]));
  const bites = (on.routeResults ?? [])
    .map((r) => {
      const o = byId.get(r.routeId ?? `${r.origin}-${r.destination}`);
      return o ? { r, o, d: (o.revenue ?? 0) - (r.revenue ?? 0) } : null;
    })
    .filter(Boolean).sort((x, y) => y.d - x.d).slice(0, 5);
  if (bites.length) {
    console.log('\n  biggest weekly bites:');
    for (const { r, o, d } of bites) {
      console.log(`    ${(r.origin + '-' + r.destination).padEnd(10)} LF ${(o.loadFactor * 100).toFixed(0)}% -> ${(r.loadFactor * 100).toFixed(0)}%   revenue -${M(d)}`);
    }
  }

  // What the REAL ticks recorded, so week-over-week reads have context.
  const hist = (st.financialHistory ?? []).slice(-4);
  if (hist.length) {
    console.log('\n  last real ticks (world history, newest last):');
    for (const h of hist) {
      console.log(`    ${(h.label ?? `W${h.week}`).padEnd(14)} revenue ${M(h.revenue ?? 0)}  profit ${M(h.profit ?? h.weekProfit ?? h.cashDelta ?? 0)}`);
    }
  }
}

await prisma.$disconnect();
