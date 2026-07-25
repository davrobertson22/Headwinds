// Repair tool: sync each airline's DB `name` column to the in-game name stored
// in its save blob (`state.airlineName`).
//
// Renames done in-game (SET_BRANDING) used to only mutate the blob, so the world
// feed, standings and rival views — which read the top-level `name` column —
// kept showing an airline's ORIGINAL name. The decisions handler now heals this
// on the player's next action, but this backfills airlines that already diverged.
//
//   node tools/reconcile-airline-names.mjs            # dry run (prints drift)
//   node tools/reconcile-airline-names.mjs --write    # apply fixes
//   node tools/reconcile-airline-names.mjs <worldId> [--write]   # scope to one world
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const write = args.includes('--write');
const worldId = args.find((a) => a !== '--write') ?? null;

const airlines = await prisma.airline.findMany({
  where: worldId ? { worldId } : {},
  select: { id: true, worldId: true, name: true, state: true },
});

let drift = 0;
for (const a of airlines) {
  const inGame = typeof a.state?.airlineName === 'string' ? a.state.airlineName.trim().slice(0, 40) : '';
  if (inGame && inGame !== a.name) {
    drift++;
    console.log(`${a.id}  "${a.name}"  ->  "${inGame}"  (world ${a.worldId})`);
    if (write) {
      await prisma.airline.update({ where: { id: a.id }, data: { name: inGame } });
    }
  }
}

console.log(`\n${drift} airline(s) with a stale name${write ? ' — updated.' : ' (dry run — pass --write to apply).'}`);
await prisma.$disconnect();
