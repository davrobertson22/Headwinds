// Forensics: who ordered what, when, and could they afford to fly it?
//
//   node tools/fleet-order-report.mjs                      # top 30 largest orders, every world
//   node tools/fleet-order-report.mjs --type a380          # only that aircraft type
//   node tools/fleet-order-report.mjs --player kat         # airline name / account email substring
//   node tools/fleet-order-report.mjs --world <worldId>    # one world
//   node tools/fleet-order-report.mjs --min 25             # only orders of >= 25 frames
//   node tools/fleet-order-report.mjs --list               # world ids + names
//
// Read-only — opens no transaction and writes nothing.
//
// Why this exists: a screenshot of a 196-frame A380 order gave the week but not
// the year, the world, or whether it was a purchase or a lease. Those three
// facts change the reading completely, so this answers them from the Decision
// log rather than from inference.
//
// The SOLVENCY block is the interesting half. Loans are credit-checked
// (guardTakeLoan caps principal at 16x recent weekly revenue); leases are not
// checked at all beyond per-unit cash for the deposit. This prints, for every
// order, the loan ceiling that WOULD have applied to the same amount of money,
// so a lease commitment can be read against the bar its debt-financed
// equivalent has to clear.
import { PrismaClient } from '@prisma/client';
import {
  AIRCRAFT_TYPES, getAircraftType, orderDiscount,
  leaseTermRateMultiplier, LEASE_DEPOSIT_WEEKS, DEFAULT_LEASE_TERM_WEEKS,
} from '@tailwinds/engine/data/aircraft.js';

// Mirrors decisionGuard.mjs — keep in step if the loan rules move.
const LOAN_MAX_MULTIPLE    = 16;
const LOAN_MULTIPLE_BUFFER = 1.5;
const LOAN_BASE_MAX        = 20_000_000;

const prisma = new PrismaClient();
const args = process.argv.slice(2);

const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};

if (args.includes('--list')) {
  const worlds = await prisma.world.findMany({
    select: { id: true, name: true, status: true, currentYear: true, currentWeek: true },
    orderBy: { createdAt: 'desc' },
  });
  for (const w of worlds) {
    console.log(`${w.id}  ${w.name} — ${w.status} Y${w.currentYear}W${w.currentWeek}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

const typeArg   = (flag('--type')   ?? '').toLowerCase();
const playerArg = (flag('--player') ?? '').toLowerCase();
const worldArg  = flag('--world');
const minQty    = Number(flag('--min', '1')) || 1;
const limit     = Number(flag('--limit', '30')) || 30;

const money = (n) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${v}`;
};
const yw = (idx) => `Y${Math.floor((idx - 1) / 52) + 1}W${((idx - 1) % 52) + 1}`;

// decisionGuard.recentWeeklyRevenue — best of the last 6 recorded weeks.
function recentWeeklyRevenue(state) {
  let max = 0;
  for (const h of (state?.financialHistory ?? []).slice(-6)) {
    const rev = Number(h?.revenue) || 0;
    if (rev > max) max = rev;
  }
  return max;
}

const decisions = await prisma.decision.findMany({
  where: {
    type: { in: ['ORDER_AIRCRAFT', 'BUY_AIRCRAFT'] },
    ...(worldArg ? { worldId: worldArg } : {}),
  },
  orderBy: { createdAt: 'desc' },
  take: 20000,
});

const airlineIds = [...new Set(decisions.map(d => d.airlineId))];
const airlines = await prisma.airline.findMany({
  where: { id: { in: airlineIds } },
  include: { account: { select: { email: true, displayName: true, isOG: true } } },
});
const worlds = await prisma.world.findMany({
  where: { id: { in: [...new Set(decisions.map(d => d.worldId))] } },
  select: { id: true, name: true, status: true, currentYear: true, currentWeek: true },
});
const airlineById = new Map(airlines.map(a => [a.id, a]));
const worldById   = new Map(worlds.map(w => [w.id, w]));

const rows = [];
for (const d of decisions) {
  const p   = d.payload ?? {};
  const qty = Math.max(1, Math.min(100, Math.floor(Number(p.quantity) || 1)));
  if (qty < minQty) continue;

  const type = getAircraftType(p.typeId);
  if (!type) continue;
  if (typeArg && !(`${type.id} ${type.name}`.toLowerCase().includes(typeArg))) continue;

  const air = airlineById.get(d.airlineId);
  if (!air) continue;
  if (playerArg && !(`${air.name} ${air.account?.email ?? ''} ${air.account?.displayName ?? ''}`
        .toLowerCase().includes(playerArg))) continue;

  const isLease = p.ownershipType === 'lease';
  const termWks = isLease ? (p.leaseTermWeeks ?? DEFAULT_LEASE_TERM_WEEKS) : null;
  const unitWeeklyLease = isLease
    ? Math.round((type.weeklyLease ?? 0) * leaseTermRateMultiplier(termWks))
    : 0;

  const unitUpfront = isLease
    ? unitWeeklyLease * LEASE_DEPOSIT_WEEKS
    : Math.round(type.purchasePrice * (1 - orderDiscount(qty)));

  rows.push({
    d, air, type, qty, isLease, termWks,
    upfront:    unitUpfront * qty,
    weeklyRent: unitWeeklyLease * qty,
  });
}

rows.sort((a, b) => b.upfront - a.upfront);
const shown = rows.slice(0, limit);

console.log(`\n${rows.length} matching order(s); showing ${shown.length} by upfront cost.\n`);

for (const r of shown) {
  const w     = worldById.get(r.d.worldId);
  const state = r.air.state ?? {};
  const rev   = recentWeeklyRevenue(state);
  const loanCeiling = Math.max(LOAN_BASE_MAX, Math.floor(rev * LOAN_MAX_MULTIPLE * LOAN_MULTIPLE_BUFFER));
  const og    = r.air.account?.isOG ? ' [OG]' : '';

  console.log(`${r.qty}x ${r.type.name} — ${r.isLease ? 'LEASE' : 'BUY'}`);
  console.log(`  world    ${w?.name ?? r.d.worldId} (${w?.status}, now Y${w?.currentYear}W${w?.currentWeek})`);
  console.log(`  ordered  ${yw(r.d.week)}  [linear week ${r.d.week}]  ${r.d.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`);
  console.log(`  airline  ${r.air.name}${og} — ${r.air.account?.email ?? '?'}`);
  console.log(`  upfront  ${money(r.upfront)}${r.isLease ? `  (${LEASE_DEPOSIT_WEEKS}-wk deposits, ${r.termWks}-wk term)` : `  (incl ${Math.round(orderDiscount(r.qty) * 100)}% bulk discount)`}`);

  if (r.isLease) {
    console.log(`  commits  ${money(r.weeklyRent)}/wk  =  ${money(r.weeklyRent * 52)}/yr of rent`);
  }

  console.log(`  SOLVENCY`);
  console.log(`    cash now             ${money(r.air.cash)}`);
  console.log(`    best weekly revenue  ${money(rev)} (last 6 recorded weeks)`);
  if (r.isLease) {
    const cover = rev > 0 ? (r.weeklyRent / rev) : Infinity;
    console.log(`    new rent vs revenue  ${rev > 0 ? `${(cover * 100).toFixed(0)}% of weekly revenue` : 'no recorded revenue'}`);
    console.log(`    ${cover > 1 ? '*** rent EXCEEDS all recorded revenue ***' : cover > 0.4 ? '(heavy: rent is a large share of revenue)' : '(comfortable)'}`);
  }
  console.log(`    loan ceiling for this airline  ${money(loanCeiling)}  (16x rev x1.5, floor $20M)`);
  console.log(`    ${r.upfront > loanCeiling
    ? `*** this order cost ${money(r.upfront)} — MORE than they could legally borrow ***`
    : `(order was within what they could have borrowed)`}`);
  console.log('');
}

const leaseRows = rows.filter(r => r.isLease);
if (leaseRows.length) {
  const overCommitted = leaseRows.filter(r => {
    const rev = recentWeeklyRevenue(r.air.state ?? {});
    return rev > 0 && r.weeklyRent > rev;
  });
  console.log(`Summary: ${leaseRows.length} lease order(s) matched; ${overCommitted.length} committed to weekly rent exceeding the airline's best recorded weekly revenue.`);
}

await prisma.$disconnect();
