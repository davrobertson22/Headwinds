// Repair tool: put every airline in a world onto the world's own calendar.
//
// THE BUG THIS FIXES
// An airline's save blob carries its own { week, year }, and it used to be
// seeded at Year 1 Week 1 whenever that player joined — while the world clock
// kept advancing on its own. Every player therefore ran a private calendar
// offset by however long the world had been open when they joined: one player's
// top bar read "December W4 Y1" while their rival's, in the SAME world, read
// "April W2 Y1". Because the engine derives seasonality from state.week, they
// were also simulating different seasons against the same demand pool.
//
// Joining is fixed at the source (worldService.joinWorld rebases the seeded
// blob onto the world clock). This backfills airlines that already diverged.
//
// WHAT IT DOES NOT DO
// It does not fast-forward anyone's game. Cash, fleet, routes and every relative
// counter (aircraft age, lease weeks remaining, weeks-since-check, construction
// weeks left) are untouched. Only the calendar moves, and everything scheduled
// in ABSOLUTE weeks — pending deliveries, booked heavy checks, hub tierSince,
// fuel hedges, labor negotiation dates — moves with it by the same delta, so an
// order that was 3 weeks out is still exactly 3 weeks out afterwards.
//
//   node tools/rebase-airline-calendars.mjs                     # dry run
//   node tools/rebase-airline-calendars.mjs --write             # apply
//   node tools/rebase-airline-calendars.mjs <worldId> [--write]  # one world
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { rebaseStateCalendar, absWeekOf } from '../src/lib/calendar.mjs';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const write = args.includes('--write');
const worldId = args.find((a) => !a.startsWith('--')) ?? null;

const dbHost = (() => {
  try { return new URL(process.env.DATABASE_URL).host; } catch { return '(DATABASE_URL not set / unparseable)'; }
})();
console.log(`DB host: ${dbHost}`);
console.log(`Scope:   ${worldId ? `world ${worldId}` : 'ALL non-archived worlds'}`);
console.log(`Mode:    ${write ? 'WRITE' : 'dry run (pass --write to apply)'}\n`);

const worlds = await prisma.world.findMany({
  where: {
    ...(worldId ? { id: worldId } : {}),
    status: { in: ['LOBBY', 'RUNNING', 'ENDED'] },
  },
  select: { id: true, name: true, status: true, currentWeek: true, currentYear: true },
});

let scanned = 0;
let rebased = 0;
let skipped = 0;

for (const w of worlds) {
  const worldAbs = absWeekOf(w.currentYear, w.currentWeek);
  const airlines = await prisma.airline.findMany({
    where: { worldId: w.id },
    select: { id: true, name: true, state: true, week: true, joinedWeek: true, version: true },
  });
  if (airlines.length === 0) continue;

  console.log(`World "${w.name}" (${w.id}) — ${w.status}, Y${w.currentYear} W${w.currentWeek} (abs week ${worldAbs}), ${airlines.length} airline(s)`);

  for (const a of airlines) {
    scanned++;
    if (!a.state || typeof a.state !== 'object' || Array.isArray(a.state)) {
      console.log(`  SKIP   ${a.name} — unreadable state blob`);
      skipped++;
      continue;
    }
    const airlineAbs = absWeekOf(a.state.year, a.state.week);
    const { state: next, delta } = rebaseStateCalendar(a.state, {
      year: w.currentYear,
      week: w.currentWeek,
    });
    if (delta === 0) {
      console.log(`  OK     ${a.name} — already on the world calendar`);
      continue;
    }

    // How many weeks this airline has actually played (its own 1-based clock).
    // The world week it joined is therefore worldAbs - playedWeeks + 1.
    const playedWeeks = airlineAbs;
    const joinedAbs = Math.max(1, worldAbs - playedWeeks + 1);

    console.log(
      `  REBASE ${a.name} — Y${a.state.year} W${a.state.week} -> Y${w.currentYear} W${w.currentWeek} ` +
      `(${delta > 0 ? '+' : ''}${delta}w; played ${playedWeeks}w, joined world week ${joinedAbs})`,
    );

    if (write) {
      // Compare-and-set on version so a rebase can never clobber a decision or a
      // tick that landed between the read above and this write. A loser is simply
      // reported — re-run the tool to catch it.
      const res = await prisma.airline.updateMany({
        where: { id: a.id, version: a.version ?? 0 },
        data: {
          state: next,
          week: worldAbs,
          joinedWeek: joinedAbs,
          version: { increment: 1 },
        },
      });
      if (res.count === 0) {
        console.log('         ...changed under the tool — skipped, re-run to catch it');
        skipped++;
        continue;
      }
    }
    rebased++;
  }
  console.log('');
}

console.log(`Scanned ${scanned} airline(s): ${rebased} ${write ? 'rebased' : 'would be rebased'}, ${skipped} skipped.`);
if (!write && rebased > 0) console.log('Re-run with --write to apply.');

await prisma.$disconnect();
