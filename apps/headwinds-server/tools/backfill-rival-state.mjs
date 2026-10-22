// Backfill: fill Airline."rivalState" (migration 20261022000000_airline_rival_state)
// for airlines whose `state` has not been written since the migration.
//
// The trigger fills the column on every `state` write, so a world that ticks
// fills itself within one world-week. Until a row is filled, loadRivalRows
// falls back to rival_state_of(state) for it — i.e. the old, expensive read —
// so this closes that gap without waiting for ticks.
//
// One row per statement, with a pause between rows: each statement detoasts a
// single airline's blob, never a whole world's (whole-world detoasting is the
// memory spike this column exists to remove). It writes ONLY "rivalState": not
// `state` (so the trigger does not fire), not `version` (so no player decision
// in flight is invalidated). `"rivalState" IS NULL` in the WHERE makes it safe
// to re-run and keeps it from overwriting a value the trigger just wrote.
//
// ACTIVE airlines first (they are the only rows the rival query reads), then
// the rest. Run from apps/headwinds-server (so dotenv finds .env):
//   node tools/backfill-rival-state.mjs                      dry run (counts)
//   node tools/backfill-rival-state.mjs --write              apply, all worlds
//   node tools/backfill-rival-state.mjs <worldId> [--write]  one world
//   --pause=<ms>   delay between rows (default 150)
import { prisma } from '../src/db.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const pauseMs = Number(args.find((a) => a.startsWith('--pause='))?.slice(8) ?? 150);
const onlyWorld = args.find((a) => !a.startsWith('--')) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const worlds = await prisma.world.findMany({
  where: onlyWorld ? { id: onlyWorld } : {},
  select: { id: true, name: true, status: true },
  orderBy: { createdAt: 'asc' },
});
console.log(`${write ? 'WRITE' : 'Dry run'}: ${worlds.length} world(s), ${pauseMs} ms between rows\n`);

let filled = 0, skipped = 0;
for (const world of worlds) {
  const pending = await prisma.$queryRaw`
    SELECT id, name, status::text AS status
      FROM "Airline"
     WHERE "worldId" = ${world.id} AND "rivalState" IS NULL
     ORDER BY (status = 'ACTIVE') DESC, id`;
  const active = pending.filter((r) => r.status === 'ACTIVE').length;
  console.log(`${world.name} (${world.id}, ${world.status}) · ${pending.length} to fill (${active} ACTIVE)`);
  if (!write) continue;
  for (const row of pending) {
    const n = await prisma.$executeRaw`
      UPDATE "Airline" SET "rivalState" = public.rival_state_of(state)
       WHERE id = ${row.id} AND "rivalState" IS NULL`;
    if (n) filled++; else skipped++;
    await sleep(pauseMs);
  }
}

const [left] = await prisma.$queryRaw`
  SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active, count(*)::int AS total
    FROM "Airline" WHERE "rivalState" IS NULL`;
console.log(write
  ? `\nFilled ${filled} row(s); ${skipped} already filled by the trigger meanwhile. Still empty: ${left.total} (${left.active} ACTIVE).`
  : `\nDry run — nothing written. Still empty: ${left.total} (${left.active} ACTIVE). Add --write to apply.`);
await prisma.$disconnect();
