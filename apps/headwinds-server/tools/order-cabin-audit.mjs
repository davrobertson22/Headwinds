// Incident diagnostic: are the cabins on an airline's orders the cabins it
// ordered, and are deliveries arriving with them?
//
//   node --env-file=.env tools/order-cabin-audit.mjs read2much
//   node --env-file=.env tools/order-cabin-audit.mjs read2much --weeks 26
//
// Read-only. Written 2026-11-11 for "the update cleared the configurations
// already set ... have to reconfigure everything immediately after each
// delivery" (Read2Much, Discord). The engine delivers `order.config ??
// newAircraftConfig(type)`, so the three questions are:
//
//   1. ORDER_AIRCRAFT decisions in the journal: what cabin was asked for
//   2. pendingOrders in the state blob: what cabin each order now carries
//      (null = delivered at the type's typical all-economy seating)
//   3. the fleet: which tails sit at exactly that default seating
//
// Journal cabin == order cabin == delivered cabin  -> nothing was lost; the
// player is refitting to ADD something (seat products), which orders on the
// queue can now take before delivery (SET_ORDER_CABIN).
// Journal cabin present, order cabin null/different -> a real loss: report it.
import { PrismaClient } from '@prisma/client';
import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
import { newAircraftConfig } from '@tailwinds/engine/utils/simulation.js';

const prisma = new PrismaClient();
const args   = process.argv.slice(2);
const who    = (args[0] ?? '').toLowerCase();
const weeks  = Number(args[args.indexOf('--weeks') + 1]) || 26;
if (!who) {
  console.error('Usage: node tools/order-cabin-audit.mjs <player name or email fragment> [--weeks N]');
  process.exit(1);
}

const cabin = (c) => {
  if (!c) return '(none: type default)';
  const seats = `F${c.firstClass ?? 0} J${c.businessClass ?? 0} W${c.premiumEconomy ?? 0} Y${c.economy ?? 0}`;
  const prods = c.products ? Object.entries(c.products)
    .filter(([, p]) => p && (p.tier || (p.extras ?? []).length))
    .map(([k, p]) => `${k}:${p.tier ?? ''}${(p.extras ?? []).length ? '+' + p.extras.join('+') : ''}`).join(' ') : '';
  return `${seats} seat:${c.seatQuality ?? 'basic'} svc:${c.serviceQuality ?? 'standard'}${prods ? ' ' + prods : ''}`;
};
const tally = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const airlines = (await prisma.airline.findMany({
  include: { account: { select: { email: true, displayName: true } }, world: true },
})).filter((a) =>
  `${a.name} ${a.account?.email ?? ''} ${a.account?.displayName ?? ''}`.toLowerCase().includes(who));
if (!airlines.length) { console.error('No airline matched ' + who); process.exit(1); }

for (const a of airlines) {
  const state   = a.state ?? {};
  const pending = (state.pendingOrders ?? []).filter((o) => !o.used);
  const fleet   = (state.fleet ?? []).filter((x) => x.status !== 'retired');
  const nowIdx  = (a.world.currentYear - 1) * 52 + a.world.currentWeek;
  console.log('\n' + '='.repeat(78));
  console.log(`${a.name} (${a.account?.displayName ?? '?'})  world "${a.world.name}"  ${a.world.status}`);
  console.log(`  fleet ${fleet.length}   factory orders on the queue ${pending.length}`);

  const decisions = await prisma.decision.findMany({
    where: { airlineId: a.id, type: { in: ['ORDER_AIRCRAFT', 'SET_ORDER_CABIN', 'CONFIGURE_AIRCRAFT', 'CONFIGURE_AIRCRAFT_BULK'] }, week: { gte: Math.max(0, nowIdx - weeks) } },
    orderBy: { createdAt: 'asc' },
  });
  const typeIds = new Set([...pending.map((o) => o.typeId), ...decisions.map((d) => d.payload?.typeId).filter(Boolean)]);

  for (const typeId of typeIds) {
    const t = getAircraftType(typeId);
    const def = t ? cabin(newAircraftConfig(t)) : '?';
    console.log(`\n  ── ${t?.name ?? typeId}  (type default: ${def})`);
    const asked = decisions.filter((d) => d.type === 'ORDER_AIRCRAFT' && d.payload?.typeId === typeId && d.payload?.noop !== true);
    console.log(`    ordered (journal, last ${weeks} wks):`);
    if (!asked.length) console.log('      (none in window)');
    for (const d of asked) console.log(`      ${d.createdAt.toISOString().slice(0, 16)}  ×${d.payload.quantity ?? 1}  ${cabin(d.payload.config)}`);
    const onOrder = pending.filter((o) => o.typeId === typeId);
    console.log(`    on the queue now (${onOrder.length}):`);
    for (const [k, n] of tally(onOrder.map((o) => cabin(o.config)))) console.log(`      ×${n}  ${k}`);
    const flying = fleet.filter((x) => x.typeId === typeId);
    console.log(`    in the fleet (${flying.length}):`);
    for (const [k, n] of tally(flying.map((x) => cabin(x.config) + (x.groundedReason === 'refit' ? '  [in refit]' : '')))) console.log(`      ×${n}  ${k}`);
    const askedKeys = new Set(asked.map((d) => cabin(d.payload.config)).filter((k) => !k.startsWith('(none')));
    const lost = onOrder.filter((o) => !o.config && askedKeys.size > 0).length;
    console.log(lost
      ? `    => ${lost} order(s) carry NO cabin although cabins were ordered: they will deliver at the default. Investigate.`
      : '    => the queue carries cabins as ordered (or none were asked for).');
  }
}
await prisma.$disconnect();
