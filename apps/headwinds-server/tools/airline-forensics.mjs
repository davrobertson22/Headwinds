// Forensic audit: could this airline have got where it is honestly?
//
//   node --env-file=.env tools/airline-forensics.mjs qantas
//   node --env-file=.env tools/airline-forensics.mjs qantas --world "heavy landing"
//   node --env-file=.env tools/airline-forensics.mjs qantas --weeks 80
//
// Read-only. Written 2026-10-15 after a Discord DM alleged that players on
// Heavy Landing were crafting API requests (Postman + a login token) to gift
// themselves cash and aircraft, citing a new airline with 59 A380s.
//
// The server never trusts a client-supplied balance or fleet: POST /decisions
// takes intents, allow-lists the type, bounds the payload (lib/decisionGuard.mjs)
// and re-runs the engine reducer over the SERVER's copy of the state. So the
// only ways money or aircraft can enter an airline are:
//
//   - the weekly tick (profit, objective bonuses)            -> statsHistory
//   - TAKE_LOAN, GO_PUBLIC, ISSUE_SHARES, SELL_AIRCRAFT,
//     CANCEL_ORDER, SELL_REFINERY, CLOSE_* refunds            -> Decision journal
//   - a gate sold to another player                            -> GateListing
//   - ORDER_AIRCRAFT / BUY_AIRCRAFT (frames)                   -> Decision journal
//   - a used-market purchase from another player's estate      -> UsedAircraftListing
//
// Everything above is journaled, so three tests settle the allegation:
//
//   1. FRAMES. Every aircraft in the fleet or on order must trace back to an
//      accepted ORDER_AIRCRAFT / BUY_AIRCRAFT or a used-market buy. Held frames
//      > journaled sources is impossible without writing to the database.
//   2. CASH. Week on week, cash(W) - cash(W-1) - profit(W) is the money that
//      arrived outside the tick. It must be explained by that week's journaled
//      inflows (loan, share issue, sale, gate sale, refund). A positive gap with
//      no inflow journaled in that week is money from nowhere.
//   3. COUNTERPARTIES. Player-to-player trades do not create money, but they
//      can concentrate it. Who sold them gates, and who is now bankrupt?
//
// If all three come back clean, the airline earned it (or borrowed/raised it)
// in-engine, and the story is a balance question, not a security one.
// src/db.mjs, not a bare `new PrismaClient()`: the client is rust-free over a
// pg driver adapter (schema.prisma engineType = "client"), and a bare
// constructor throws P2038 "Missing configured driver adapter". db.mjs also
// loads apps/headwinds-server/.env itself, so --env-file is optional.
import { prisma } from '../src/db.mjs';
import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
const args   = process.argv.slice(2);
const who    = (args[0] ?? '').toLowerCase();
const argAt  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const worldFilter = (argAt('--world') ?? '').toLowerCase();
const weeks       = Number(argAt('--weeks')) || 60;

if (!who || who.startsWith('--')) {
  console.error('Usage: node tools/airline-forensics.mjs <airline name or email fragment> [--world <name fragment>] [--weeks N]');
  process.exit(1);
}

const money = (n) => {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('en-US');
  return (v < 0 ? '-$' : '$') + s;
};
const yw   = (i) => `Y${Math.floor((i - 1) / 52) + 1}W${((i - 1) % 52) + 1}`;
const pad  = (s, n) => String(s ?? '').padEnd(n);
const rpad = (s, n) => String(s ?? '').padStart(n);
const typeName = (id) => getAircraftType(id)?.name ?? id ?? '?';

const airlines = (await prisma.airline.findMany({
  include: { account: { select: { id: true, email: true, displayName: true, createdAt: true } }, world: true },
})).filter((a) =>
  `${a.name} ${a.account?.email ?? ''} ${a.account?.displayName ?? ''}`.toLowerCase().includes(who)
  && (!worldFilter || (a.world?.name ?? '').toLowerCase().includes(worldFilter)));

if (!airlines.length) { console.error('No airline matched ' + who + (worldFilter ? ` in a world matching "${worldFilter}"` : '')); process.exit(1); }

const INFLOW_TYPES  = new Set(['TAKE_LOAN', 'GO_PUBLIC', 'ISSUE_SHARES', 'SELL_AIRCRAFT', 'SELL_AIRCRAFT_BULK',
                               'CANCEL_ORDER', 'SELL_REFINERY', 'CLOSE_LOUNGE', 'CLOSE_GROUND_STATION',
                               'CLOSE_MRO_BASE', 'CLOSE_FUEL_FARM', 'DOWNGRADE_HUB', 'SELL_STOCK', 'UNWIND_HEDGE']);
const OUTFLOW_TYPES = new Set(['ORDER_AIRCRAFT', 'BUY_AIRCRAFT', 'REPAY_LOAN', 'BUY_BACK_SHARES', 'BUY_OUT_LEASE',
                               'BUY_OUT_LEASES', 'BUY_REFINERY', 'BUILD_LOUNGE', 'BUILD_GROUND_STATION',
                               'UPGRADE_GROUND_STATION', 'BUILD_MRO_BASE', 'UPGRADE_MRO_BASE', 'BUILD_FUEL_FARM',
                               'BUY_FUEL_STAKE', 'UPGRADE_HUB', 'ADD_GATE', 'BUY_STOCK', 'BUY_HEDGE',
                               'CONFIGURE_AIRCRAFT', 'CONFIGURE_AIRCRAFT_BULK', 'INSTALL_WIFI', 'RETROFIT_WINGTIPS',
                               'ADD_ROUTE', 'ADD_CARGO_ROUTE', 'ADD_TAG_ROUTE']);

for (const a of airlines) {
  const tc      = a.world?.tickConfig ?? {};
  const state   = a.state ?? {};
  const pending = state.pendingOrders ?? [];
  const fleet   = (state.fleet ?? []).filter((x) => x.status !== 'retired');
  const nowIdx  = (a.world.currentYear - 1) * 52 + a.world.currentWeek;
  const genStart = a.restartedWeek ?? a.joinedWeek ?? 1;

  console.log('\n' + '='.repeat(96));
  console.log(`${a.name}  —  ${a.account?.email ?? '?'}  (${a.account?.displayName ?? '?'})`);
  console.log(`world "${a.world.name}"  ${a.world.status}  now ${yw(nowIdx)}  pace=${tc.pace ?? a.world.pace ?? '?'}`);
  console.log(`  gateScarcity=${tc.gateScarcity === true}  newWorldRestrictions=${tc.newWorldRestrictions === true}  era=${tc.era?.enabled === true}`);
  console.log(`  account created ${a.account?.createdAt?.toISOString().slice(0, 16) ?? '?'}   airline row created ${a.createdAt.toISOString().slice(0, 16)}`);
  console.log(`  joined ${yw(a.joinedWeek)}   restarts ${a.restarts}${a.restartedWeek ? `  (this generation since ${yw(a.restartedWeek)})` : ''}   status ${a.status}`);
  console.log(`  cash (column) ${money(a.cash)}   cash (blob) ${money(state.cash)}${
    String(a.cash) !== String(Math.round(state.cash ?? 0)) ? '   *** COLUMN AND BLOB DISAGREE ***' : ''}`);
  console.log(`  svps ${a.svps}   shares ${a.shares}   public=${state.equity?.isPublic ?? '?'}   marketCap ${money(a.marketCap)}`);
  const loans = state.loans ?? [];
  console.log(`  loans outstanding: ${loans.length}  principal ${money(loans.reduce((s, l) => s + (l.principal ?? 0), 0))}`);

  // ── 1. FRAMES ─────────────────────────────────────────────────────────────
  const allDecisions = await prisma.decision.findMany({
    where: { airlineId: a.id, week: { gte: genStart } },
    orderBy: { createdAt: 'asc' },
  });
  const usedBuys = await prisma.usedAircraftListing.findMany({
    where: { worldId: a.worldId, buyerId: a.id, status: 'SOLD' },
  });

  const byType = new Map();
  const slot = (id) => {
    if (!byType.has(id)) byType.set(id, { owned: 0, leased: 0, pending: 0, ordered: 0, bought: 0, used: 0, sold: 0, retired: 0 });
    return byType.get(id);
  };
  for (const f of fleet)   slot(f.typeId)[f.ownershipType === 'lease' ? 'leased' : 'owned']++;
  for (const o of pending) slot(o.typeId).pending++;
  for (const u of usedBuys) slot(u.typeId).used++;
  for (const d of allDecisions) {
    const p = d.payload ?? {};
    if (d.type === 'ORDER_AIRCRAFT' && p.typeId) slot(p.typeId).ordered += Math.max(1, Math.min(100, Number(p.quantity) || 1));
    if (d.type === 'BUY_AIRCRAFT'   && p.typeId) slot(p.typeId).bought++;
    if (d.type === 'SELL_AIRCRAFT' || d.type === 'RETIRE_AIRCRAFT') {
      const f = (state.fleet ?? []).find((x) => x.id === p.aircraftId);
      if (f) slot(f.typeId)[d.type === 'SELL_AIRCRAFT' ? 'sold' : 'retired']++;
    }
  }

  console.log('\n  1. FRAMES — held (fleet + on order) vs journaled sources, this generation');
  console.log('     ' + pad('type', 26) + rpad('owned', 6) + rpad('leased', 7) + rpad('pending', 8) + ' | ' + rpad('ordered', 8) + rpad('bought', 7) + rpad('used', 5) + ' | ' + rpad('sold', 5) + rpad('retired', 8));
  let unexplained = 0;
  for (const [id, s] of [...byType.entries()].sort((x, y) => (y[1].owned + y[1].leased + y[1].pending) - (x[1].owned + x[1].leased + x[1].pending))) {
    const held = s.owned + s.leased + s.pending;
    const src  = s.ordered + s.bought + s.used;
    const flag = held > src ? '   *** ' + (held - src) + ' FRAMES WITH NO ACCEPTED ORDER' : '';
    if (held > src) unexplained += held - src;
    console.log('     ' + pad(typeName(id), 26) + rpad(s.owned, 6) + rpad(s.leased, 7) + rpad(s.pending, 8) + ' | ' + rpad(s.ordered, 8) + rpad(s.bought, 7) + rpad(s.used, 5) + ' | ' + rpad(s.sold, 5) + rpad(s.retired, 8) + flag);
  }
  console.log(`     total held ${fleet.length + pending.length}   ` + (unexplained
    ? `*** ${unexplained} frame(s) exist that the journal never accepted an order for. Only a direct DB write can do that.`
    : 'every held frame traces to an accepted order or a used-market buy. (ordered > held is normal: cancellations, sales, order-book clamps.)'));
  if (a.restarts > 0) console.log('     note: this airline was re-founded; sales/retirements counted only where the tail is still in the blob.');

  // ── 2. CASH ───────────────────────────────────────────────────────────────
  const stats = (state.statsHistory ?? []).filter((s) => s.absWeek >= genStart);
  const since = Math.max(genStart, nowIdx - weeks);
  const decByWeek = new Map();
  for (const d of allDecisions) {
    if (!INFLOW_TYPES.has(d.type) && !OUTFLOW_TYPES.has(d.type)) continue;
    if (!decByWeek.has(d.week)) decByWeek.set(d.week, []);
    decByWeek.get(d.week).push(d);
  }
  const gateSales = await prisma.gateListing.findMany({
    where: { worldId: a.worldId, sellerId: a.id, status: 'SOLD', distressed: false },
  });
  const gateBuys = await prisma.gateListing.findMany({
    where: { worldId: a.worldId, buyerId: a.id, status: 'SOLD' },
  });
  // GateListing carries no week; place each sale by soldAt against the TickLog.
  const ticks = await prisma.tickLog.findMany({
    where: { worldId: a.worldId, status: 'ok', week: { gte: since - 1 } },
    orderBy: { week: 'asc' },
    select: { week: true, finishedAt: true },
  });
  const weekOfTime = (t) => {
    // The week a timestamp fell in: the first tick that finished AFTER it.
    const tk = ticks.find((x) => x.finishedAt && x.finishedAt > t);
    return tk ? tk.week : (ticks.length ? ticks[ticks.length - 1].week + 1 : null);
  };
  const gateSaleWeeks = new Map();
  for (const g of gateSales) {
    const w = g.soldAt ? weekOfTime(g.soldAt) : null;
    if (w == null) continue;
    if (!gateSaleWeeks.has(w)) gateSaleWeeks.set(w, []);
    gateSaleWeeks.get(w).push(g);
  }

  const summarise = (ds) => ds.map((d) => {
    const p = d.payload ?? {};
    switch (d.type) {
      case 'TAKE_LOAN':      return `LOAN +${money(p.principal)}`;
      case 'ISSUE_SHARES':   return `ISSUE ${Number(p.shares ?? 0).toLocaleString()}sh`;
      case 'GO_PUBLIC':      return `IPO ${Number(p.shares ?? 0).toLocaleString()}sh`;
      case 'ORDER_AIRCRAFT': return `ORDER ${Math.max(1, Math.min(100, Number(p.quantity) || 1))}x ${typeName(p.typeId)} ${p.ownershipType ?? ''}`;
      case 'BUY_AIRCRAFT':   return `BUY ${typeName(p.typeId)}`;
      case 'SELL_STOCK':
      case 'BUY_STOCK':      return `${d.type === 'BUY_STOCK' ? 'BUYSTK' : 'SELLSTK'} ${p.targetName ?? p.targetId ?? ''} ${money(p.value ?? 0)}`;
      default:               return d.type;
    }
  });

  console.log(`\n  2. CASH — week on week, last ${weeks} weeks (statsHistory keeps ${stats.length} of this generation)`);
  console.log('     cash is the end-of-tick balance; "outside tick" = Δcash − profit = money that moved between ticks');
  console.log('     ' + pad('week', 8) + rpad('cash', 18) + rpad('profit', 16) + rpad('outside tick', 16) + '  decisions that week');
  let unexplainedWeeks = 0;
  for (let i = 1; i < stats.length; i++) {
    const cur = stats[i], prev = stats[i - 1];
    if (cur.absWeek < since) continue;
    const delta   = (cur.cash ?? 0) - (prev.cash ?? 0);
    const outside = delta - (cur.profit ?? 0);
    const ds      = decByWeek.get(cur.absWeek) ?? [];
    const gs      = gateSaleWeeks.get(cur.absWeek) ?? [];
    const inflows = ds.filter((d) => INFLOW_TYPES.has(d.type)).length + gs.length;
    const notes   = [...summarise(ds), ...gs.map((g) => `GATE SOLD ${g.airportCode} +${money(g.askPrice)}`)];
    // Objective board rewards are paid outside profit but cap at $750k each;
    // anything bigger than that with no journaled inflow is unexplained.
    const flag = outside > 1_000_000 && inflows === 0 ? '   *** INFLOW WITH NO JOURNALED SOURCE' : '';
    if (flag) unexplainedWeeks++;
    const quiet = Math.abs(outside) < 50_000 && ds.length === 0 && gs.length === 0;
    if (quiet) continue;
    console.log('     ' + pad(yw(cur.absWeek), 8) + rpad(money(cur.cash), 18) + rpad(money(cur.profit), 16) + rpad(money(outside), 16) + '  ' + notes.slice(0, 6).join('; ') + (notes.length > 6 ? ` … +${notes.length - 6}` : '') + flag);
  }
  console.log('     ' + (unexplainedWeeks
    ? `*** ${unexplainedWeeks} week(s) where more than $1m arrived outside the tick with nothing journaled to explain it.`
    : 'every week where money arrived outside the tick has a journaled loan, issue, sale, refund or gate sale in it.'));
  if (stats.length) {
    const first = stats[0], last = stats[stats.length - 1];
    const totalProfit = stats.slice(1).reduce((s, x) => s + (x.profit ?? 0), 0);
    const loanTotal   = allDecisions.filter((d) => d.type === 'TAKE_LOAN').reduce((s, d) => s + (Number(d.payload?.principal) || 0), 0);
    const gateTotal   = gateSales.reduce((s, g) => s + g.askPrice, 0);
    console.log(`     cash ${yw(first.absWeek)} ${money(first.cash)} → ${yw(last.absWeek)} ${money(last.cash)}   cumulative operating profit ${money(totalProfit)}   loans drawn ${money(loanTotal)}   gates sold ${money(gateTotal)}   share issues ${allDecisions.filter((d) => d.type === 'ISSUE_SHARES' || d.type === 'GO_PUBLIC').length}`);
  }

  // ── 3. RANK ───────────────────────────────────────────────────────────────
  const standings = await prisma.standing.findMany({
    where: { airlineId: a.id, week: { gte: genStart } },
    orderBy: { week: 'asc' },
    select: { week: true, rank: true, score: true },
  });
  console.log(`\n  3. RANK — ${standings.length} weekly standings this generation`);
  if (standings.length) {
    const step = Math.max(1, Math.floor(standings.length / 12));
    const line = standings.filter((s, i) => i % step === 0 || i === standings.length - 1)
      .map((s) => `${yw(s.week)}:#${s.rank}`).join('  ');
    console.log('     ' + line);
    const firstTop = standings.find((s) => s.rank === 1);
    if (firstTop) console.log(`     first reached #1 at ${yw(firstTop.week)} — ${firstTop.week - genStart} weeks after founding`);
  }

  // ── 4. COUNTERPARTIES ─────────────────────────────────────────────────────
  console.log('\n  4. COUNTERPARTIES — player-to-player money (does not create cash, can concentrate it)');
  const ids = new Set([...gateSales.map((g) => g.buyerId), ...gateBuys.map((g) => g.sellerId)].filter(Boolean));
  const others = ids.size ? await prisma.airline.findMany({
    where: { id: { in: [...ids] } },
    include: { account: { select: { email: true, createdAt: true } } },
  }) : [];
  const byId = new Map(others.map((o) => [o.id, o]));
  const flows = new Map();
  for (const g of gateSales) { const k = g.buyerId;  flows.set(k, (flows.get(k) ?? 0) + g.askPrice); }
  for (const g of gateBuys)  { const k = g.sellerId; flows.set(k, (flows.get(k) ?? 0) - g.askPrice); }
  if (!flows.size) console.log('     no gate trades with other players.');
  for (const [id, net] of [...flows.entries()].sort((x, y) => y[1] - x[1])) {
    const o = byId.get(id);
    const sameDay = o?.account?.createdAt && a.account?.createdAt
      && Math.abs(o.account.createdAt - a.account.createdAt) < 48 * 3600 * 1000;
    console.log(`     ${pad(o?.name ?? id, 28)} ${rpad((net >= 0 ? 'received ' : 'paid ') + money(Math.abs(net)), 24)}   ${o?.status ?? '?'}${
      o?.status !== 'ACTIVE' ? '  <- not active' : ''}${sameDay ? '  <- account created within 48h of this one' : ''}`);
  }
  const stockTrades = allDecisions.filter((d) => (d.type === 'BUY_STOCK' || d.type === 'SELL_STOCK') && (d.payload?.shares ?? 0) > 0);
  if (stockTrades.length) {
    const net = new Map();
    for (const d of stockTrades) {
      const k = d.payload.targetName ?? d.payload.targetId;
      net.set(k, (net.get(k) ?? 0) + (d.type === 'SELL_STOCK' ? 1 : -1) * (d.payload.value ?? 0));
    }
    console.log('     stock (settles against the world pool, not the rival): ' + [...net.entries()].map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${money(v)}`).join(', '));
  }
  console.log('     IPs are not stored; Supabase Auth → Logs shows sign-in IPs per auth user id if an alt check is needed.');
}

await prisma.$disconnect();
