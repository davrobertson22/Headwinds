// Repair tool: rebuild a world's WorldGate ledger from the airline blobs.
// The blobs are the engine's source of truth for who holds what; the ledger is
// the fast availability arbiter. If a post-tick reconcile ever lost every CAS
// retry (crash mid-loop), run this to resync:
//
//   node tools/reconcile-gates.mjs <worldId>          # dry run (prints drift)
//   node tools/reconcile-gates.mjs <worldId> --write  # apply fixes
//
// Capacity is NEVER derived from blobs (auction growth lives only in the
// ledger) — only `taken` and `holdings` counts are rebuilt. Cooldowns are kept.
import { PrismaClient } from '@prisma/client';
import { gateCapacityOf, getAirport } from '@tailwinds/engine/data/airports.js';

const prisma = new PrismaClient();
const [worldId, flag] = process.argv.slice(2);
const write = flag === '--write';

if (!worldId) {
  console.error('Usage: node tools/reconcile-gates.mjs <worldId> [--write]');
  process.exit(1);
}

const world = await prisma.world.findUnique({ where: { id: worldId } });
if (!world) { console.error('No such world'); process.exit(1); }
if (world.tickConfig?.gateScarcity !== true) {
  console.error('This world does not use gate scarcity — nothing to reconcile.');
  process.exit(1);
}

const airlines = await prisma.airline.findMany({
  where: { worldId, status: 'ACTIVE' },
  select: { id: true, name: true, state: true },
});

// True holdings from the blobs.
const truth = new Map(); // code → { taken, holdings: { airlineId: count } }
for (const a of airlines) {
  for (const [code, count] of Object.entries(a.state?.gates ?? {})) {
    if (!count) continue;
    if (!truth.has(code)) truth.set(code, { taken: 0, holdings: {} });
    const t = truth.get(code);
    t.taken += count;
    t.holdings[a.id] = count;
  }
}

const rows = await prisma.worldGate.findMany({ where: { worldId } });
const rowByCode = new Map(rows.map((r) => [r.airportCode, r]));
let drift = 0;

for (const [code, t] of truth) {
  const row = rowByCode.get(code);
  if (!row) {
    drift++;
    console.log(`MISSING row ${code}: blobs say taken=${t.taken}`);
    if (write) {
      const cap = gateCapacityOf(getAirport(code));
      await prisma.worldGate.create({
        data: {
          worldId, airportCode: code, baseSize: cap,
          capacity: Math.max(cap, t.taken), taken: t.taken,
          holdings: Object.fromEntries(Object.entries(t.holdings).map(([id, count]) => [id, { count }])),
        },
      });
    }
    continue;
  }
  const holdings = { ...(row.holdings ?? {}) };
  let changed = row.taken !== t.taken;
  for (const [id, count] of Object.entries(t.holdings)) {
    if ((holdings[id]?.count ?? 0) !== count) {
      changed = true;
      holdings[id] = { ...(holdings[id] ?? {}), count };
    }
  }
  for (const id of Object.keys(holdings)) {
    if (!t.holdings[id]) { changed = true; delete holdings[id]; }
  }
  if (changed) {
    drift++;
    console.log(`DRIFT ${code}: ledger taken=${row.taken} vs blobs=${t.taken}`);
    if (write) {
      await prisma.worldGate.update({
        where: { id: row.id },
        data: { taken: t.taken, holdings, version: { increment: 1 } },
      });
    }
  }
}
// Rows with holders no blob backs at all.
for (const row of rows) {
  if (truth.has(row.airportCode)) continue;
  if (row.taken === 0) continue;
  drift++;
  console.log(`GHOST ${row.airportCode}: ledger taken=${row.taken}, blobs say 0`);
  if (write) {
    await prisma.worldGate.update({
      where: { id: row.id },
      data: { taken: 0, holdings: {}, version: { increment: 1 } },
    });
  }
}

console.log(drift === 0 ? 'Ledger matches the blobs — no drift.' : `${drift} airport(s) ${write ? 'fixed' : 'drifted (re-run with --write to fix)'}`);
await prisma.$disconnect();
