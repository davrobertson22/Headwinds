// One-time backfill: bank the career record for every world that ENDED before
// the career layer existed.
//
// The snapshot is written by the tick that ends a world, so any world already
// concluded has no record and can never get one from the tick — every season
// played before this shipped would be invisible for ever. Fixable exactly once,
// here.
//
// Safe to run repeatedly: `withWorldRecord` keys by world id and recomputes
// every total from scratch, so a second pass rewrites identical rows. Pass
// --dry to see what it would touch.
//
// Run from apps/headwinds-server (so dotenv finds the .env):
//   node tools/backfill-careers.mjs [--dry]
import { prisma } from '../src/db.mjs';
import { snapshotWorldCareers } from '../src/lib/careerService.mjs';
import { totalWeeks } from '../src/lib/worldConfig.mjs';

const dry = process.argv.includes('--dry');

const ended = await prisma.world.findMany({
  where: { status: 'ENDED' },
  select: { id: true, name: true, lengthYears: true, endedAt: true, currentWeek: true, currentYear: true },
  orderBy: { endedAt: 'asc' },
});

if (ended.length === 0) {
  console.log('No ENDED worlds — nothing to backfill.');
} else {
  console.log(`${ended.length} ended world(s) to consider.`);
  let total = 0;
  for (const world of ended) {
    const weekIndex = totalWeeks(world.lengthYears);

    // Final standings, reconstructed from the last week that has any. A world
    // whose airlines were all private never produced a Standing row, which is a
    // rankless season rather than a missing one.
    const last = await prisma.standing.findFirst({
      where: { worldId: world.id },
      orderBy: { week: 'desc' },
      select: { week: true },
    });
    const ranked = last
      ? (await prisma.standing.findMany({
          where: { worldId: world.id, week: last.week },
          orderBy: { rank: 'asc' },
          select: { airlineId: true, score: true },
        })).map((s) => ({ airlineId: s.airlineId, svpsScore: Number(s.score) }))
      : [];

    if (dry) {
      const n = await prisma.airline.count({ where: { worldId: world.id } });
      console.log(`  [dry] ${world.name ?? world.id}: ${n} airline(s), ${ranked.length} ranked`);
      continue;
    }

    // No passenger totals: the states are on disk rather than in memory here,
    // and reading forty half-megabyte blobs per world to count passengers that
    // are already years stale is not a trade worth making. Historical seasons
    // record 0 lifetime passengers and every other figure in full.
    total += await snapshotWorldCareers(prisma, world, { weekIndex, ranked });
  }
  console.log(dry ? 'Dry run — nothing written.' : `Backfilled ${total} career record(s).`);
}

await prisma.$disconnect();
