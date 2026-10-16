// Backfill: fill the live standings columns (rankings rework, 2026-10-15) for
// every active airline in every world that has not been archived.
//
// Migration 20261016000000_live_standings_stats adds the columns empty. The
// tick fills them every week, so this only matters for the gap between the
// deploy and each world's next tick: without it the player list shows dashes
// until then. Values come from the same mapping the tick uses
// (src/lib/liveStats.mjs), so a backfilled row and a ticked row are identical.
//
// It writes ONLY the six live-stat columns. It never touches `state`, the
// `version` counter (so no player decision in flight is invalidated), or the
// rank order: a world keeps its SVPS order until its first post-rework tick
// stamps tickConfig.rankingSince and posts the "how the standings work now"
// news item. Ended worlds get their columns filled too, so their final
// standings show the stats, but their order and result stay exactly as they
// were decided (SVPS) — nothing here can re-rank a finished season.
//
// Safe to run repeatedly. Run from apps/headwinds-server (so dotenv finds .env):
//   node tools/backfill-live-stats.mjs              dry run
//   node tools/backfill-live-stats.mjs --write      apply
//   node tools/backfill-live-stats.mjs <worldId> [--write]
import { prisma } from '../src/db.mjs';
import { liveStatColumns, weeksFlownOf } from '../src/lib/liveStats.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const onlyWorld = args.find((a) => !a.startsWith('--')) ?? null;

const worlds = await prisma.world.findMany({
  where: { status: { in: ['LOBBY', 'RUNNING', 'ENDED'] }, ...(onlyWorld ? { id: onlyWorld } : {}) },
  select: { id: true, name: true, currentWeek: true, currentYear: true },
  orderBy: { createdAt: 'asc' },
});
console.log(`${write ? 'WRITE' : 'Dry run'}: ${worlds.length} world(s)\n`);

let total = 0;
for (const world of worlds) {
  const weeksFlown = weeksFlownOf(world);
  // One world at a time: every blob is up to half a megabyte.
  const airlines = await prisma.airline.findMany({
    where: { worldId: world.id, status: 'ACTIVE' },
    select: { id: true, name: true, state: true },
  });
  const rows = airlines.map((a) => ({ a, cols: liveStatColumns(a.state ?? {}, weeksFlown) }))
    .sort((x, y) => Number(y.cols.rankScore - x.cols.rankScore));
  console.log(`${world.name} (${world.id}) · ${weeksFlown} weeks flown · ${rows.length} airline(s)`);
  rows.forEach(({ a, cols }, i) => {
    console.log(`  #${String(i + 1).padStart(2)} ${a.name.padEnd(28).slice(0, 28)}`
      + ` avg ${Number(cols.rankScore).toLocaleString('en-US').padStart(13)}/wk`
      + ` · last ${Number(cols.weeklyProfit).toLocaleString('en-US').padStart(13)}`
      + ` · net assets ${Number(cols.netAssets).toLocaleString('en-US').padStart(15)}`
      + ` · ${cols.paxWeek} pax · ${cols.flightsWeek} flights · ${cols.fleetSize} aircraft`);
  });
  if (write) {
    for (const { a, cols } of rows) {
      await prisma.airline.update({ where: { id: a.id }, data: cols });
      total++;
    }
  }
  console.log('');
}
console.log(write ? `Wrote ${total} airline(s).` : 'Dry run — nothing written. Add --write to apply.');
await prisma.$disconnect();
