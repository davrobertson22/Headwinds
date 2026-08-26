// Backfill: settle the estates of airlines that died before tombstones existed.
//
//   node tools/tombstone-dead-airlines.mjs            # dry run — report only
//   node tools/tombstone-dead-airlines.mjs --write    # actually shrink blobs
//
// As of 2026-08-25 the tick tombstones an airline the week it goes bankrupt and
// /leave tombstones on abandonment (lib/tombstone.mjs — heavy report/history
// keys collapse to their seed-state shapes; row, columns, careers and restart
// all untouched). This sweeps the corpses that predate that: measured 86 dead
// airlines against 65 active across all worlds, ~45MB of blob weight that the
// lobby standings query was detoasting on every poll.
//
// Idempotent: an already-tombstoned airline reports changed:false and is
// skipped. Safe on ACTIVE rows by construction — tombstoneAirline refuses them.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { tombstoneAirline } from '../apps/headwinds-server/src/lib/tombstone.mjs';

const WRITE = process.argv.includes('--write');
const prisma = new PrismaClient({ log: ['warn', 'error'] });

async function main() {
  const dead = await prisma.airline.findMany({
    where: { NOT: { status: 'ACTIVE' } },
    select: { id: true, name: true, status: true, worldId: true, world: { select: { name: true } } },
    orderBy: [{ worldId: 'asc' }],
  });
  console.log(`${dead.length} dead airline(s) found${WRITE ? '' : ' (dry run — pass --write to shrink)'}\n`);

  let changed = 0, savedBytes = 0;
  for (const a of dead) {
    if (!WRITE) {
      // Dry run sizes the estate without writing: read the blob, measure it.
      const row = await prisma.airline.findUnique({ where: { id: a.id }, select: { state: true } });
      const size = JSON.stringify(row?.state ?? null)?.length ?? 0;
      console.log(`  would settle ${a.world?.name ?? a.worldId} / ${a.name} (${a.status}) — ${Math.round(size / 1024)}kB`);
      continue;
    }
    const res = await tombstoneAirline(prisma, { airlineId: a.id, log: console });
    if (res.changed) { changed += 1; savedBytes += res.before - res.after; }
  }

  if (WRITE) {
    console.log(`\nsettled ${changed}/${dead.length} estate(s), ~${Math.round(savedBytes / 1024 / 1024 * 10) / 10}MB shed`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
