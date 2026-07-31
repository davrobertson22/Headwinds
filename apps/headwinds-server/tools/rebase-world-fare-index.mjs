// Retune a live New World Restrictions world.
//
//   node tools/rebase-world-fare-index.mjs --list
//   node tools/rebase-world-fare-index.mjs <worldId>                  # dry run
//   node tools/rebase-world-fare-index.mjs <worldId> --write          # apply, uses NWR_FARE_INDEX
//   node tools/rebase-world-fare-index.mjs <worldId> --index 0.92 --write
//
// WHY THIS EXISTS
// `newWorldRestrictions` and `fareIndex` are copied into each airline's state
// blob at JOIN, and the engine reads them from the blob — never from the world
// row. That makes them cheap to read in a pure reducer, but it means:
//
//   1. Editing World.tickConfig.fareIndex does NOTHING for players already in
//      the world. They keep whatever index they were seeded with.
//   2. Anyone who joined while the API was mid-deploy — after the world was
//      created with the flag, but before joinWorld knew how to seed it — is
//      silently playing WITHOUT the restrictions the world advertises, badge and
//      all. That happened on 2026-07-29 and looked exactly like a broken rule.
//
// This repairs both: it rewrites tickConfig for future joiners AND every
// existing airline's blob, and it repairs a missing restrictions flag while it
// is in there.
//
// WHAT IT DOES NOT TOUCH
// Cash, fleet, routes, orders, the calendar — nothing. Only the two config
// values on the blob. Fares the PLAYER has set on their own routes are their
// own numbers and stay put; this moves the reference ladder those prices are
// judged against, so re-pricing after a change is the player's call.
//
// The airline `version` column is bumped so the change-stamp moves and clients
// pick the new state up on their next poll instead of sitting on a cached blob.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { NWR_FARE_INDEX } from '@tailwinds/engine/utils/market.js';

const prisma = new PrismaClient();
const args   = process.argv.slice(2);
const write  = args.includes('--write');
const worldId = args.find((a) => !a.startsWith('--') && !/^0?\.\d+$/.test(a)) ?? null;

const idxArg = args.indexOf('--index');
const target = idxArg >= 0 ? Number(args[idxArg + 1]) : NWR_FARE_INDEX;

if (args.includes('--list')) {
  const worlds = await prisma.world.findMany({
    select: { id: true, name: true, status: true, currentYear: true, currentWeek: true, tickConfig: true,
              _count: { select: { airlines: true } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const w of worlds) {
    const tc = w.tickConfig ?? {};
    const nwr = tc.newWorldRestrictions === true ? `🔒 nwr fareIndex=${tc.fareIndex ?? NWR_FARE_INDEX}` : '';
    console.log(`${w.id}  ${w.name} — ${w.status} Y${w.currentYear}W${w.currentWeek}  ${w._count.airlines} players  ${nwr}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

if (!worldId) {
  console.error('Usage: node tools/rebase-world-fare-index.mjs <worldId> [--index 0.95] [--write]   (or --list)');
  process.exit(1);
}
if (!Number.isFinite(target) || target <= 0.25 || target > 2) {
  console.error(`Refusing index ${target} — setFareIndex() clamps to (0.25, 2] and would silently fall back to 1.`);
  process.exit(1);
}

const world = await prisma.world.findUnique({
  where: { id: worldId },
  include: { airlines: { include: { account: { select: { email: true } } } } },
});
if (!world) { console.error('No such world'); process.exit(1); }

const tc = world.tickConfig ?? {};
if (tc.newWorldRestrictions !== true) {
  console.error(`"${world.name}" is not a New World Restrictions world — nothing to retune.`);
  console.error('(The fare index only applies to restricted worlds. Refusing to seed one into a classic world.)');
  process.exit(1);
}

console.log(`World:   ${world.name}  (${world.id})`);
console.log(`Current: tickConfig.fareIndex = ${tc.fareIndex ?? `(unset -> ${NWR_FARE_INDEX})`}`);
console.log(`Target:  ${target}`);
console.log(`Mode:    ${write ? 'WRITE' : 'dry run (pass --write to apply)'}\n`);

let changed = 0, repaired = 0;
for (const a of world.airlines) {
  const st   = a.state ?? {};
  const from = st.fareIndex ?? '(unset)';
  const missingFlag = st.newWorldRestrictions !== true;
  const needsIndex  = st.fareIndex !== target;
  // Airlines that joined before foundedAbsWeek existed have no age clock, so the
  // labour seniority scale would sit at x1.00 forever. Backfill it from the DB's
  // joinedWeek — the week they actually started.
  const missingFounded = st.foundedAbsWeek == null;
  if (!missingFlag && !needsIndex && !missingFounded) {
    console.log(`  = ${a.name.padEnd(24)} already at ${target}`);
    continue;
  }
  console.log(`  → ${a.name.padEnd(24)} ${a.account?.email ?? '?'}`);
  console.log(`      fareIndex ${from} -> ${target}${
    missingFlag ? '\n      *** restrictions flag MISSING from state — repairing (joined before the API knew how to seed it)' : ''}${
    missingFounded ? `\n      *** no founding week — backfilling from joinedWeek (${a.joinedWeek}) so labour seniority can age` : ''}`);
  if (missingFlag) repaired++;
  changed++;

  if (write) {
    await prisma.airline.update({
      where: { id: a.id },
      data: {
        state: {
          ...st,
          newWorldRestrictions: true,
          fareIndex: target,
          foundedAbsWeek: st.foundedAbsWeek ?? (a.joinedWeek ?? 1),
        },
        version: { increment: 1 },   // move the change stamp so clients refetch
      },
    });
  }
}

if (write) {
  await prisma.world.update({
    where: { id: world.id },
    data: { tickConfig: { ...tc, newWorldRestrictions: true, fareIndex: target } },
  });
}

console.log(`\n${write ? 'Updated' : 'Would update'} ${changed} of ${world.airlines.length} airline(s)` +
  (repaired ? `, ${repaired} of them missing the restrictions flag entirely` : '') +
  `, and the world's tickConfig for future joiners.`);
if (write) console.log('Players pick the new ladder up on their next poll. Tell them to re-check their fares.');

await prisma.$disconnect();
