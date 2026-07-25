// Repair tool: sync each airline's DB `name` column to the in-game name stored
// in its save blob (`state.airlineName`).
//
// Renames done in-game (SET_BRANDING) used to only mutate the blob, so the world
// feed, standings and rival views — which read the top-level `name` column —
// kept showing an airline's ORIGINAL name. The decisions handler now heals this
// on the player's next action; this backfills airlines that already diverged.
//
//   node tools/reconcile-airline-names.mjs            # dry run + diagnostics
//   node tools/reconcile-airline-names.mjs --write    # apply fixes
//   node tools/reconcile-airline-names.mjs <worldId> [--write]   # scope to one world
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const write = args.includes('--write');
const worldId = args.find((a) => a !== '--write') ?? null;

const dbHost = (() => {
  try { return new URL(process.env.DATABASE_URL).host; } catch { return '(DATABASE_URL not set / unparseable)'; }
})();
console.log(`DB host: ${dbHost}`);
console.log(`Scope:   ${worldId ? `world ${worldId}` : 'ALL worlds'}\n`);

const airlines = await prisma.airline.findMany({
  where: worldId ? { worldId } : {},
  select: { id: true, worldId: true, name: true, state: true },
});
console.log(`Scanned ${airlines.length} airline(s).\n`);

let drift = 0;
let sampled = 0;
for (const a of airlines) {
  const stateType = a.state === null ? 'null' : Array.isArray(a.state) ? 'array' : typeof a.state;
  const raw = (a.state && typeof a.state === 'object') ? a.state.airlineName : undefined;
  const inGame = typeof raw === 'string' ? raw.trim().slice(0, 40) : '';

  if (inGame && inGame !== a.name) {
    drift++;
    console.log(`DRIFT  ${a.id}  name="${a.name}"  ->  state.airlineName="${inGame}"  (world ${a.worldId})`);
    if (write) await prisma.airline.update({ where: { id: a.id }, data: { name: inGame } });
  } else if (sampled < 5) {
    // Show a few in-sync rows so we can confirm the blob shape is being read.
    sampled++;
    console.log(`ok     ${a.id}  name="${a.name}"  state=${stateType}  state.airlineName=${raw === undefined ? '(missing)' : `"${raw}"`}`);
  }
}

console.log(`\n${drift} airline(s) with a stale name${write ? ' — updated.' : ' (dry run — pass --write to apply).'}`);
await prisma.$disconnect();
