// Forensics: what happened to a gate auction, and why did each bid win or lose?
//
//   node tools/gate-auction-report.mjs <worldId>            # every auction
//   node tools/gate-auction-report.mjs <worldId> GRR        # one airport
//   node tools/gate-auction-report.mjs --list               # world ids + names
//
// Read-only. For a RESOLVED auction it prints the stored per-bidder outcomes
// (auctions resolved before those were recorded fall back to "winner / not a
// winner"). For an OPEN auction it REPLAYS the resolution rules against the
// live ledger and cash — a dry run of who would win if the year tick landed
// right now — which is the fastest way to spot a bid that is quietly doomed.
import { PrismaClient } from '@prisma/client';
import {
  gateAirlineCapOf, gateAllianceCapOf, GATE_BID_MAX_QTY,
} from '@tailwinds/engine/data/airports.js';

const prisma = new PrismaClient();
const args = process.argv.slice(2);

if (args[0] === '--list') {
  const worlds = await prisma.world.findMany({
    select: { id: true, name: true, status: true, currentYear: true, currentWeek: true, tickConfig: true },
    orderBy: { createdAt: 'desc' },
  });
  for (const w of worlds) {
    const gs = w.tickConfig?.gateScarcity === true ? ' ⛩ gate scarcity' : '';
    console.log(`${w.id}  ${w.name} — ${w.status} Y${w.currentYear}W${w.currentWeek}${gs}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

const [worldId, airportArg] = args;
if (!worldId) {
  console.error('Usage: node tools/gate-auction-report.mjs <worldId> [AIRPORT]   (or --list)');
  process.exit(1);
}
const airportCode = airportArg ? airportArg.toUpperCase() : null;

const world = await prisma.world.findUnique({ where: { id: worldId } });
if (!world) { console.error('No such world'); process.exit(1); }

const weekIdx = (world.currentYear - 1) * 52 + world.currentWeek;
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
const yw = (idx) => `Y${Math.floor((idx - 1) / 52) + 1}W${((idx - 1) % 52) + 1}`;

console.log(`\nWorld: ${world.name} (${world.id})`);
console.log(`Clock: ${yw(weekIdx)} — linear week ${weekIdx}, status ${world.status}`);
console.log(`Gate scarcity: ${world.tickConfig?.gateScarcity === true ? 'ON' : 'OFF — this world has no auctions'}\n`);

const auctions = await prisma.gateAuction.findMany({
  where: { worldId, ...(airportCode ? { airportCode } : {}) },
  include: { bids: true },
  orderBy: [{ year: 'desc' }, { airportCode: 'asc' }],
});
if (auctions.length === 0) {
  console.log(airportCode ? `No auction has ever run at ${airportCode}.` : 'This world has never opened a gate auction.');
  await prisma.$disconnect();
  process.exit(0);
}

const airlines = await prisma.airline.findMany({
  where: { worldId },
  select: { id: true, name: true, status: true, state: true },
});
const byId = new Map(airlines.map((a) => [a.id, a]));
const nameOf = (id) => byId.get(id)?.name ?? `(unknown airline ${id})`;

// Alliance roster, so the 80% cap can be replayed the way resolution sees it.
const members = await prisma.allianceMember.findMany({
  where: { status: 'ACTIVE', alliance: { worldId } },
  select: { airlineId: true, allianceId: true },
});
const allianceOf = new Map(members.map((m) => [m.airlineId, m.allianceId]));

const REASON_TEXT = {
  WON: 'won',
  OUTBID: 'outbid — the lots went to higher bids',
  NO_LOTS_LEFT: 'outbid — no lots left by the time this bid was reached',
  BELOW_RESERVE: 'below the reserve price',
  INSUFFICIENT_CASH: 'not enough cash at resolution (bids are not escrowed)',
  OWNERSHIP_CAP: 'blocked by the 60% single-airline ownership cap',
  ALLIANCE_CAP: 'blocked by the 80% alliance ownership cap',
  LOCKED_OUT: 'locked out of this airport (use-it-or-lose-it forfeit)',
  AIRLINE_INACTIVE: 'airline was bankrupt or had left the world',
  NO_LEDGER_ROW: 'the airport had no gate ledger row — nothing could be awarded',
  WRITE_CONFLICT: 'the airline record changed mid-award and the write was abandoned',
};

// A dry replay of resolveDueAuctions' per-bid checks, without writing anything.
function replay(auction, row) {
  const ranked = [...auction.bids]
    .filter((b) => b.amount >= auction.reserve)
    .sort((a, b) => b.amount - a.amount);
  const below = auction.bids.filter((b) => b.amount < auction.reserve)
    .map((b) => ({ airlineId: b.airlineId, amount: b.amount, quantity: b.quantity, reason: 'BELOW_RESERVE', gates: 0 }));

  let lotsLeft = auction.lots;
  let capacity = row?.capacity ?? 0;
  const holdings = JSON.parse(JSON.stringify(row?.holdings ?? {}));
  const out = [];

  for (const bid of ranked) {
    const airline = byId.get(bid.airlineId);
    const rec = { airlineId: bid.airlineId, amount: bid.amount, quantity: bid.quantity, gates: 0, reason: null };
    if (lotsLeft <= 0) { rec.reason = 'OUTBID'; out.push(rec); continue; }
    if (!airline || airline.status !== 'ACTIVE') { rec.reason = 'AIRLINE_INACTIVE'; out.push(rec); continue; }
    if (!row) { rec.reason = 'NO_LEDGER_ROW'; out.push(rec); continue; }

    let q = Math.min(Math.max(1, Math.min(GATE_BID_MAX_QTY, bid.quantity ?? 1)), lotsLeft);
    const mine = holdings[bid.airlineId]?.count ?? 0;
    let blocked = null;
    while (q > 0 && mine + q > gateAirlineCapOf(capacity + q)) { q--; blocked = 'OWNERSHIP_CAP'; }
    const allianceId = allianceOf.get(bid.airlineId);
    if (allianceId && q > 0) {
      let allianceTaken = 0;
      for (const [aid, alid] of allianceOf) {
        if (alid === allianceId) allianceTaken += holdings[aid]?.count ?? 0;
      }
      while (q > 0 && allianceTaken + q > gateAllianceCapOf(capacity + q)) { q--; blocked = 'ALLIANCE_CAP'; }
    }
    if (q <= 0) { rec.reason = blocked ?? 'OWNERSHIP_CAP'; out.push(rec); continue; }

    const lockedUntil = airline.state?.gateLockouts?.[auction.airportCode] ?? 0;
    if (lockedUntil > weekIdx) {
      rec.reason = 'LOCKED_OUT';
      rec.detail = `locked until ${yw(lockedUntil)}`;
      out.push(rec);
      continue;
    }
    const cash = airline.state?.cash ?? 0;
    if (cash < bid.amount * q) {
      rec.reason = 'INSUFFICIENT_CASH';
      rec.detail = `holds ${money(cash)}, needs ${money(bid.amount * q)}`;
      out.push(rec);
      continue;
    }

    rec.gates = q;
    rec.reason = 'WON';
    out.push(rec);
    lotsLeft -= q;
    capacity += q;
    holdings[bid.airlineId] = { count: mine + q };
  }
  return [...out, ...below];
}

for (const auction of auctions) {
  const row = await prisma.worldGate.findUnique({
    where: { worldId_airportCode: { worldId, airportCode: auction.airportCode } },
  });
  console.log('─'.repeat(72));
  console.log(`${auction.airportCode} — auction for year ${auction.year} [${auction.status}]`);
  console.log(`  ${auction.lots} lot(s), reserve ${money(auction.reserve)}/gate`);
  console.log(`  opened ${yw(auction.opensWeek)}, resolves ${yw(auction.resolvesWeek)}${auction.resolvedAt ? ` (resolved ${auction.resolvedAt.toISOString()})` : ''}`);
  if (row) {
    console.log(`  ledger now: ${row.taken}/${row.capacity} gates taken (base ${row.baseSize})`);
    const holders = Object.entries(row.holdings ?? {})
      .filter(([, h]) => (h?.count ?? 0) > 0)
      .sort((a, b) => b[1].count - a[1].count);
    for (const [id, h] of holders) console.log(`    ${nameOf(id)}: ${h.count}`);
  } else {
    console.log('  ledger now: NO WorldGate ROW (this is a bug — run reconcile-gates.mjs)');
  }

  if (auction.status === 'OPEN' && auction.resolvesWeek <= weekIdx) {
    console.log('  ⚠ OVERDUE: this auction should already have resolved. The post-tick');
    console.log('    hook either never ran or threw — check the tick logs for [tick] gate hooks failed.');
  }

  console.log(`  bids: ${auction.bids.length}`);
  if (auction.bids.length === 0) {
    console.log('    (none — nothing could be sold)');
  }
  for (const b of [...auction.bids].sort((x, y) => y.amount - x.amount)) {
    console.log(`    ${nameOf(b.airlineId)} — ${money(b.amount)}/gate × ${b.quantity}  (placed ${b.createdAt?.toISOString?.() ?? '?'})`);
  }

  if (auction.status === 'RESOLVED') {
    const results = Array.isArray(auction.results) ? auction.results : [];
    console.log(`  awarded: ${results.length === 0 ? 'NOTHING — no qualifying bids' : ''}`);
    for (const r of results) console.log(`    ${r.airline} won ${r.gates} at ${money(r.pricePerGate)}/gate`);
    const outcomes = Array.isArray(auction.outcomes) ? auction.outcomes : null;
    if (outcomes) {
      console.log('  per-bidder outcome (as recorded at resolution):');
      for (const o of outcomes) {
        console.log(`    ${nameOf(o.airlineId)} — ${REASON_TEXT[o.reason] ?? o.reason}${o.detail ? ` (${o.detail})` : ''}`);
      }
    } else if (auction.bids.length > 0) {
      console.log('  per-bidder outcome: NOT RECORDED (auction predates outcome tracking).');
      console.log('  Replaying the rules against TODAY\'s ledger/cash for a best guess:');
      for (const o of replay(auction, row)) {
        console.log(`    ${nameOf(o.airlineId)} — ${REASON_TEXT[o.reason] ?? o.reason}${o.detail ? ` (${o.detail})` : ''}`);
      }
      console.log('  (cash and holdings have moved since; treat as indicative, not proof)');
    }
  } else if (auction.status === 'OPEN') {
    console.log('  dry run — who would win if it resolved right now:');
    for (const o of replay(auction, row)) {
      console.log(`    ${nameOf(o.airlineId)} — ${o.reason === 'WON' ? `WOULD WIN ${o.gates}` : REASON_TEXT[o.reason] ?? o.reason}${o.detail ? ` (${o.detail})` : ''}`);
    }
  }
  console.log('');
}

await prisma.$disconnect();
