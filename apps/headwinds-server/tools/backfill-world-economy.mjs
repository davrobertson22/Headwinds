// Repair tool: put every airline in a world onto the world's own fuel/market walk.
//
// THE BUG THIS FIXES
// The world-shared fuel and market indices are replayed deterministically from
// worldSeed each tick, but they're STORED per-airline — and an airline's blob
// used to be seeded at fuel 1.000× with an empty history whenever that player
// joined, no matter how long the world had been running. A late joiner therefore
// saw a flat 1.000 index and a one-point price chart, and (worse) could buy
// hedges locked at 1.0× while the rest of the world paid the real price.
//
// Joining is fixed at the source (worldService.joinWorld backfills from
// worldEconomyAt). This backfills airlines that already joined stale.
//
// WHAT IT DOES NOT DO
// It does not touch cash, hedge contracts already bought, or anything else in
// the blob — only fuelPrice { index, history } and marketIndex, both of which
// are world-derived values the next tick would overwrite the index of anyway.
// Airlines already carrying the correct walk are left untouched (their write
// is skipped entirely, so versions don't churn).
//
//   node tools/backfill-world-economy.mjs                      # dry run
//   node tools/backfill-world-economy.mjs --write              # apply
//   node tools/backfill-world-economy.mjs <worldId> [--write]  # one world
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { worldEconomyAt } from '../src/lib/worldEconomy.mjs';

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
  select: { id: true, name: true, status: true, currentWeek: true, currentYear: true, worldSeed: true },
});

const sameSeries = (a, b) =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

let scanned = 0;
let backfilled = 0;
let skipped = 0;

for (const w of worlds) {
  const linearWeek = (w.currentYear - 1) * 52 + w.currentWeek;
  const economy = worldEconomyAt(w.worldSeed ?? w.id, linearWeek);
  const airlines = await prisma.airline.findMany({
    where: { worldId: w.id },
    select: { id: true, name: true, state: true, version: true },
  });
  if (airlines.length === 0) continue;

  console.log(`World "${w.name}" (${w.id}) — ${w.status}, Y${w.currentYear} W${w.currentWeek} (linear week ${linearWeek}), fuel ${economy.fuelPrice.index.toFixed(3)}, ${airlines.length} airline(s)`);

  for (const a of airlines) {
    scanned++;
    if (!a.state || typeof a.state !== 'object' || Array.isArray(a.state)) {
      console.log(`  SKIP     ${a.name} — unreadable state blob`);
      skipped++;
      continue;
    }
    const cur = a.state.fuelPrice ?? { index: 1.0, history: [] };
    const upToDate = cur.index === economy.fuelPrice.index
      && sameSeries(cur.history ?? [], economy.fuelPrice.history)
      && a.state.marketIndex === economy.marketIndex;
    if (upToDate) {
      console.log(`  OK       ${a.name} — already on the world walk`);
      continue;
    }

    console.log(
      `  BACKFILL ${a.name} — fuel ${(cur.index ?? 1).toFixed(3)} (${(cur.history ?? []).length}w history) -> ` +
      `${economy.fuelPrice.index.toFixed(3)} (${economy.fuelPrice.history.length}w), ` +
      `market ${(a.state.marketIndex ?? 1).toFixed(3)} -> ${economy.marketIndex.toFixed(3)}`,
    );

    if (write) {
      // Compare-and-set on version so the backfill can never clobber a decision
      // or a tick that landed between the read above and this write. A loser is
      // simply reported — re-run the tool to catch it.
      const res = await prisma.airline.updateMany({
        where: { id: a.id, version: a.version ?? 0 },
        data: {
          state: { ...a.state, fuelPrice: economy.fuelPrice, marketIndex: economy.marketIndex },
          version: { increment: 1 },
        },
      });
      if (res.count === 0) {
        console.log('           ...changed under the tool — skipped, re-run to catch it');
        skipped++;
        continue;
      }
    }
    backfilled++;
  }
  console.log('');
}

console.log(`Scanned ${scanned} airline(s): ${backfilled} ${write ? 'backfilled' : 'would be backfilled'}, ${skipped} skipped.`);
if (!write && backfilled > 0) console.log('Re-run with --write to apply.');

await prisma.$disconnect();
