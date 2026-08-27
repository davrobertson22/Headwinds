// Clamp live cargo yields to the new freight price ceiling.
//
//   node tools/clamp-cargo-yields.mjs --list
//   node tools/clamp-cargo-yields.mjs <worldId>            # dry run
//   node tools/clamp-cargo-yields.mjs <worldId> --write    # apply + post news
//   node tools/clamp-cargo-yields.mjs --all --write        # every running world
//
// WHY THIS EXISTS
// Until 2026-08-27 the cargo path applied no price choke at all — freight
// demand shrank with a bare power law that never reaches zero, so on a lane
// whose gravity pool runs 3-7x one freighter's weekly payload, pricing at two
// or three times the going rate cost nothing: the aeroplane stayed full and the
// inflated rate was banked on every tonne. The profit-maximising yield sat at
// 2.6x-4.0x reference and 32% of live cargo routes had drifted above 1.25x.
// See docs/cargo-yield-choke-audit-2026-08-27.md.
//
// cargoPriceChokeFactor() closes that. It is also savage where it bites: at
// 2.56x reference in a restricted world the multiplier is exp(-15 x 1.46), or
// 3e-10. Deployed cold, an airline that had priced up there would find its
// freight network carrying ZERO tonnes on the very next tick — for a strategy
// that was legal in the model we shipped. In Heavy Landing that is one player's
// entire airline: freight is 74% of their revenue.
//
// So: clamp first, deploy second. This walks every cargo route in a world and
// pulls any yield above the ceiling back DOWN to it, leaving everything at or
// below the ceiling untouched. Nobody's network dies overnight; rates normalise
// over a few ticks; the fix reads as a market correction rather than a
// punishment. Players keep every dollar they have already banked.
//
// THE CEILING
//   restricted worlds — NWR_CHOKE_THRESHOLD_BASE (1.10x reference), the point
//     where nwrYieldChokeFactor starts biting at the default quality of 50.
//   classic worlds    — CARGO_PRICE_CAP_MULTIPLE (3x) is where demand reaches
//     zero, so clamp just below it. Classic keeps its arcade headroom on
//     purpose; this only rescues routes that would otherwise carry nothing.
//
// WHAT IT DOES NOT TOUCH
// Cash, fleet, frequencies, passenger fares, gates, orders — nothing. Only
// cargoRoutes[].yieldPrice, and only where it is above the ceiling.
//
// The airline `version` column is bumped so clients refetch instead of sitting
// on a cached blob, exactly as rebase-world-fare-index.mjs does.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { cargoReferenceYield, NWR_CHOKE_THRESHOLD_BASE, setFareIndex } from '@tailwinds/engine/utils/market.js';
import { CARGO_PRICE_CAP_MULTIPLE } from '@tailwinds/engine/models/demand.js';

const prisma = new PrismaClient();
const args   = process.argv.slice(2);
const write  = args.includes('--write');
const all    = args.includes('--all');
const worldId = args.find((a) => !a.startsWith('--')) ?? null;

// Classic worlds clamp a hair under the hard zero rather than at it, so a
// clamped route still carries freight instead of landing exactly on 0 demand.
const CLASSIC_CEILING_MULTIPLE = +(CARGO_PRICE_CAP_MULTIPLE * 0.8).toFixed(2);

if (args.includes('--list')) {
  const worlds = await prisma.world.findMany({
    where: { status: { in: ['RUNNING', 'LOBBY'] } },
    select: { id: true, name: true, status: true, currentYear: true, currentWeek: true, tickConfig: true,
              _count: { select: { airlines: true } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const w of worlds) {
    const nwr = (w.tickConfig ?? {}).newWorldRestrictions === true ? '🔒 nwr' : 'classic';
    console.log(`${w.id}  ${w.name} — ${w.status} Y${w.currentYear}W${w.currentWeek}  ${w._count.airlines} players  ${nwr}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

if (!worldId && !all) {
  console.error('Usage: node tools/clamp-cargo-yields.mjs <worldId> [--write]   (or --all, or --list)');
  process.exit(1);
}

const worlds = await prisma.world.findMany({
  where: all ? { status: { in: ['RUNNING', 'LOBBY'] } } : { id: worldId },
  include: { airlines: { include: { account: { select: { email: true } } } } },
});
if (!worlds.length) { console.error('No such world'); process.exit(1); }

console.log(`Mode: ${write ? 'WRITE' : 'dry run (pass --write to apply)'}\n`);

let grandRoutes = 0, grandAirlines = 0;

for (const world of worlds) {
  const restricted = (world.tickConfig ?? {}).newWorldRestrictions === true;
  const ceilingMult = restricted ? NWR_CHOKE_THRESHOLD_BASE : CLASSIC_CEILING_MULTIPLE;
  console.log(`\n═══ ${world.name}  (${world.id})  ${restricted ? '🔒 restricted' : 'classic'} — ceiling ${ceilingMult}× reference`);

  const newsRows = [];
  for (const a of world.airlines) {
    const st = a.state ?? {};
    const routes = st.cargoRoutes ?? [];
    if (!routes.length) continue;
    // The reference ladder is per-world: score each airline's lanes against the
    // index its own blob carries, exactly as the tick does.
    setFareIndex(st.fareIndex ?? 1);

    const clamped = [];
    const next = routes.map((r) => {
      const ref = cargoReferenceYield(r.origin, r.destination);
      if (!ref) return r;
      const ceiling = +(ref * ceilingMult).toFixed(3);
      const current = r.yieldPrice ?? ref;
      if (current <= ceiling) return r;
      clamped.push({ origin: r.origin, destination: r.destination, from: current, to: ceiling,
                     wasMultiple: +(current / ref).toFixed(2) });
      return { ...r, yieldPrice: ceiling };
    });
    if (!clamped.length) continue;

    grandAirlines++; grandRoutes += clamped.length;
    console.log(`  → ${a.name.padEnd(24)} ${a.account?.email ?? '?'}  — ${clamped.length} of ${routes.length} route(s)`);
    for (const c of clamped) {
      console.log(`      ${c.origin}–${c.destination}  $${c.from.toFixed(3)} (${c.wasMultiple}× ref) → $${c.to.toFixed(3)}`);
    }

    newsRows.push({
      worldId: world.id, week: world.currentWeek, category: 'world',
      kind: 'freight_rate_correction', tier: 1, airlineId: a.id,
      payload: { ceilingMultiple: ceilingMult, routes: clamped },
    });

    if (write) {
      await prisma.airline.update({
        where: { id: a.id },
        data: { state: { ...st, cargoRoutes: next }, version: { increment: 1 } },
      });
    }
  }

  if (write && newsRows.length) {
    await prisma.worldNews.createMany({ data: newsRows });
  }
  if (!newsRows.length) console.log('  (nothing above the ceiling)');
}

console.log(`\n${write ? 'Clamped' : 'Would clamp'} ${grandRoutes} cargo route(s) across ${grandAirlines} airline(s).`);
if (write) console.log('Deploy the engine change now — every remaining yield is at or below the ceiling.');
else console.log('Re-run with --write once the numbers look right. Run this BEFORE deploying the engine change.');

await prisma.$disconnect();
