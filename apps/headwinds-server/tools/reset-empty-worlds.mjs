// One-time maintenance: park empty RUNNING worlds back in LOBBY at Year 1.
//
// Before worlds idled in LOBBY, the spawner started their clocks at creation,
// so public worlds aged with zero players in them — a "fresh" blitz world could
// be at year 3 before its first player arrived. This resets every RUNNING world
// that has NO airlines to LOBBY @ Y1W1 (clock parked, tick history cleared).
// Worlds with any airline in them — active, bankrupt, or abandoned — are left
// untouched.
//
// Run from apps/headwinds-server (so dotenv finds the .env):
//   node tools/reset-empty-worlds.mjs
import { prisma } from '../src/db.mjs';

const empties = await prisma.world.findMany({
  where: { status: 'RUNNING', airlines: { none: {} } },
  select: { id: true, name: true, currentYear: true, currentWeek: true },
});

if (empties.length === 0) {
  console.log('No empty RUNNING worlds — nothing to reset.');
} else {
  for (const w of empties) {
    await prisma.$transaction([
      prisma.tickLog.deleteMany({ where: { worldId: w.id } }),
      prisma.world.update({
        where: { id: w.id },
        data: {
          status: 'LOBBY',
          currentWeek: 1,
          currentYear: 1,
          startedAt: null,
          endsAt: null,
          endedAt: null,
        },
      }),
    ]);
    console.log(`reset "${w.name}" (was Y${w.currentYear} W${w.currentWeek}) → LOBBY @ Y1W1`);
  }
  console.log(`Reset ${empties.length} world(s).`);
}
await prisma.$disconnect();
