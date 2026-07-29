// Incident diagnostic: did this airline's aircraft orders actually happen?
//
//   node --env-file=.env tools/airline-order-audit.mjs kat
//   node --env-file=.env tools/airline-order-audit.mjs kat --weeks 8
//
// Read-only. Written 2026-07-29 for "it just ate 2 orders I put in for 767-300s
// / it stole my deposit / 8 mil wtdf".
//
// THE DECISIVE TEST: the server journals a row to `Decision` only AFTER it has
// accepted and applied an action. So for every ORDER_AIRCRAFT in the log, the
// money WAS taken and the order SHOULD be sitting in the airline's state blob
// (or already delivered into the fleet). Cross-referencing the two answers the
// question outright:
//
//   decisions present + orders in state      -> nothing was lost; UI/display issue
//   decisions present + orders NOT in state  -> REAL data loss, money taken for
//                                               orders that no longer exist
//   no decisions at all                      -> the server REJECTED the action;
//                                               no money moved, the client just
//                                               reverted its optimistic apply
import { PrismaClient } from '@prisma/client';
import { getAircraftType, LEASE_DEPOSIT_WEEKS, leaseTermRateMultiplier } from '@tailwinds/engine/data/aircraft.js';

const prisma = new PrismaClient();
const args   = process.argv.slice(2);
const who    = (args[0] ?? '').toLowerCase();
const weeks  = Number(args[args.indexOf('--weeks') + 1]) || 12;

if (!who) {
  console.error('Usage: node tools/airline-order-audit.mjs <player name or email fragment> [--weeks N]');
  process.exit(1);
}

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
const yw    = (i) => `Y${Math.floor((i - 1) / 52) + 1}W${((i - 1) % 52) + 1}`;

const airlines = (await prisma.airline.findMany({
  include: { account: { select: { email: true, displayName: true } }, world: true },
})).filter((a) =>
  `${a.name} ${a.account?.email ?? ''} ${a.account?.displayName ?? ''}`.toLowerCase().includes(who));

if (!airlines.length) { console.error('No airline matched ' + who); process.exit(1); }

for (const a of airlines) {
  const tc      = a.world?.tickConfig ?? {};
  const state   = a.state ?? {};
  const pending = state.pendingOrders ?? [];
  const fleet   = (state.fleet ?? []).filter((x) => x.status !== 'retired');
  const nowIdx  = (a.world.currentYear - 1) * 52 + a.world.currentWeek;

  console.log('\n' + '='.repeat(78));
  console.log(`${a.name}  —  ${a.account?.email ?? '?'}`);
  console.log(`world "${a.world.name}"  ${a.world.status}  now ${yw(nowIdx)}`);
  console.log(`  gateScarcity=${tc.gateScarcity === true}   newWorldRestrictions=${tc.newWorldRestrictions === true}   fareIndex=${tc.fareIndex ?? state.fareIndex ?? '(unset)'}`);
  console.log(`  state flags: newWorldRestrictions=${state.newWorldRestrictions === true}  fareIndex=${state.fareIndex ?? '(unset)'}`);
  console.log(`  cash (column) ${money(a.cash)}   cash (state blob) ${money(state.cash)}${
    String(a.cash) !== String(Math.round(state.cash ?? 0)) ? '   *** COLUMN AND BLOB DISAGREE ***' : ''}`);
  console.log(`  fleet ${fleet.length} active   pendingOrders ${pending.length}`);

  if (pending.length) {
    console.log('\n  PENDING ORDERS IN STATE:');
    for (const o of pending) {
      const t = getAircraftType(o.typeId);
      console.log(`    ${(t?.name ?? o.typeId).padEnd(24)} ${String(o.ownershipType).padEnd(6)} due ${yw(o.deliverAbsWeek)}  deposit ${money(o.leaseDeposit ?? 0)}  price ${money(o.totalPrice ?? 0)}`);
    }
  }

  const since = Math.max(0, nowIdx - weeks);
  const decisions = await prisma.decision.findMany({
    where: { airlineId: a.id, type: { in: ['ORDER_AIRCRAFT', 'BUY_AIRCRAFT', 'CANCEL_ORDER'] }, week: { gte: since } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n  ACCEPTED DECISIONS (last ${weeks} wks) — the server only journals these AFTER applying them:`);
  if (!decisions.length) {
    console.log('    (none)');
    console.log('    => the server never accepted an order in this window.');
    console.log('       No money was taken. The client reverted its optimistic apply.');
  }

  let expectedSpend = 0, orderedFrames = 0;
  for (const d of decisions) {
    const p   = d.payload ?? {};
    const t   = getAircraftType(p.typeId);
    const qty = Math.max(1, Math.min(100, Number(p.quantity) || 1));
    let note  = '';
    if (d.type !== 'CANCEL_ORDER' && t) {
      orderedFrames += qty;
      if (p.ownershipType === 'lease') {
        const wk = Math.round((t.weeklyLease ?? 0) * leaseTermRateMultiplier(p.leaseTermWeeks));
        const dep = wk * LEASE_DEPOSIT_WEEKS * qty;
        expectedSpend += dep;
        note = `deposits ~${money(dep)}`;
      } else {
        expectedSpend += (t.purchasePrice ?? 0) * qty;
        note = `~${money((t.purchasePrice ?? 0) * qty)}`;
      }
    }
    console.log(`    ${yw(d.week).padEnd(8)} ${d.createdAt.toISOString().slice(11, 19)}  ${d.type.padEnd(15)} ${qty}x ${(t?.name ?? p.typeId ?? '').padEnd(22)} ${String(p.ownershipType ?? '').padEnd(6)} ${note}`);
  }

  if (decisions.length) {
    console.log(`\n  Frames ordered per the decision log: ${orderedFrames}`);
    console.log(`  Implied spend (if every one applied in full): ~${money(expectedSpend)}`);
    console.log(`  Orders actually sitting in state: ${pending.length}`);
    const delivered = fleet.filter((f) => decisions.some((d) => d.payload?.typeId === f.typeId)).length;
    console.log(`  Aircraft in the fleet of an ordered type (may have delivered): ${delivered}`);
    if (orderedFrames > pending.length + delivered) {
      console.log('\n  *** GAP: more frames were accepted than exist as orders or aircraft.');
      console.log('      Either the reducer clamped the order (New World Restrictions order book');
      console.log('      trims an oversized lease order to the free slots) or frames were dropped.');
      console.log('      A clamp does NOT charge for the trimmed frames — check cash against');
      console.log('      "implied spend" above: if cash only fell by the delivered share, the');
      console.log('      clamp worked and nothing was stolen.');
    }
  }
}

await prisma.$disconnect();
