// Gate-ledger drift audit — READ ONLY.
//
//   node --env-file=.env tools/reconcile-gates.mjs
//   node --env-file=.env tools/reconcile-gates.mjs <world name or id fragment>
//
// tickService.mjs has always claimed "tools/reconcile-gates.mjs can repair any
// drift from blobs" in the comment above its gate hooks. The tool did not
// exist. This is the audit half of it.
//
// WHAT DRIFTS, AND WHY IT CANNOT SELF-HEAL
// ---------------------------------------
// In a scarcity world two records track the same gates:
//   • the LEDGER  — WorldGate.taken / WorldGate.holdings (availability arbiter)
//   • the BLOB    — airline.state.gates (what the engine bills and flies)
//
// Rule-5 forfeitures happen inside ADVANCE_WEEK: the engine drops the gates
// from the blob, and the ledger is corrected afterwards by reconcileForfeitures,
// which runs POST-COMMIT and BEST-EFFORT. Its release list is a pre/post diff of
// THIS tick's blobs. So if it fails — a lost compare-and-set (mutateWorldGate
// gives up after 5 attempts and only logs), or anything throwing inside the
// tick's `catch`-wrapped gate-hook block — the correction is lost for good:
// the next tick diffs a blob that has ALREADY dropped the gates, produces no
// release, and never retries.
//
// The residue is a GHOST holding: the ledger still credits an airline with
// gates it no longer has and no longer pays for. Ghosts are not cosmetic —
//   • `taken` stays inflated, so the airport reads fuller than it is and can
//     report FULL, surcharge at 90%, or trigger an auction early;
//   • `allianceTaken` is summed from ledger holdings over the alliance roster,
//     so a ghost can push an alliance over the 80% cap and block a partner;
//   • the gate-market view's `yours` reads the LEDGER while the engine's
//     gateLeaseDenial reads the BLOB, so Airport Details can show you holding
//     gates that your own Airports tab says you do not have.
//
// Note `taken` and `holdings` are mutated together inside one CAS, so they do
// not drift from EACH OTHER — both go stale together. Check A below is a
// cheap invariant check; check B is the one that finds real damage.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const filter = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? null;

const isScarcity = (w) => w?.tickConfig?.gateScarcity === true;

async function main() {
  const worlds = (await prisma.world.findMany({
    select: { id: true, name: true, status: true, tickConfig: true },
  })).filter(isScarcity)
    .filter((w) => !filter || w.id.includes(filter) || (w.name ?? '').toLowerCase().includes(filter.toLowerCase()));

  if (worlds.length === 0) {
    console.log(filter ? `No gate-scarcity world matches "${filter}".` : 'No gate-scarcity worlds.');
    return;
  }

  let totalGhosts = 0, totalPhantoms = 0, totalSumMismatch = 0;

  for (const world of worlds) {
    const [rows, airlines] = await Promise.all([
      prisma.worldGate.findMany({ where: { worldId: world.id } }),
      prisma.airline.findMany({
        where: { worldId: world.id },
        select: { id: true, name: true, status: true, hub: true, state: true },
      }),
    ]);
    const byId = new Map(airlines.map((a) => [a.id, a]));
    const findings = [];

    for (const row of rows) {
      const holdings = row.holdings ?? {};
      // ── Check A: ledger internal consistency ──────────────────────────────
      const sum = Object.values(holdings).reduce((s, h) => s + (h?.count ?? 0), 0);
      if (sum !== row.taken) {
        totalSumMismatch++;
        findings.push(`  ${row.airportCode.padEnd(4)} LEDGER INCONSISTENT — taken=${row.taken} but holdings sum to ${sum}`);
      }

      // ── Check B: ledger vs blob, per airline ──────────────────────────────
      for (const [airlineId, h] of Object.entries(holdings)) {
        const ledger = h?.count ?? 0;
        if (ledger <= 0) continue;
        const airline = byId.get(airlineId);
        if (!airline) {
          totalGhosts += ledger;
          findings.push(`  ${row.airportCode.padEnd(4)} GHOST ${ledger} gate(s) held by a MISSING airline ${airlineId}`);
          continue;
        }
        // A bankrupt/abandoned carrier is released by releaseAllFor, so any
        // remainder there is drift too — but flag it separately, it has a
        // different cause than a failed forfeiture reconcile.
        const blob = (airline.state?.gates ?? {})[row.airportCode] ?? 0;
        if (ledger > blob) {
          totalGhosts += ledger - blob;
          const why = airline.status !== 'ACTIVE' ? `${airline.status} carrier` : 'likely a failed forfeiture reconcile';
          findings.push(
            `  ${row.airportCode.padEnd(4)} GHOST ${ledger - blob} gate(s) — ledger says ${ledger}, `
            + `${airline.name} blob says ${blob} (${why})`,
          );
        } else if (blob > ledger) {
          totalPhantoms += blob - ledger;
          findings.push(
            `  ${row.airportCode.padEnd(4)} UNLEDGERED ${blob - ledger} gate(s) — ${airline.name} blob says ${blob}, `
            + `ledger says ${ledger} (billed for, but not counted against capacity)`,
          );
        }
      }

      // Gates in a blob at an airport with no ledger entry for that airline.
      for (const airline of airlines) {
        const blob = (airline.state?.gates ?? {})[row.airportCode] ?? 0;
        if (blob > 0 && !(holdings[airline.id]?.count > 0)) {
          totalPhantoms += blob;
          findings.push(
            `  ${row.airportCode.padEnd(4)} UNLEDGERED ${blob} gate(s) — ${airline.name} holds them in its blob, `
            + 'the ledger has no holding at all',
          );
        }
      }
    }

    console.log(`\n${world.name ?? world.id} (${world.status}) — ${rows.length} ledger row(s), ${airlines.length} airline(s)`);
    if (findings.length === 0) console.log('  ✓ ledger and blobs agree');
    else findings.forEach((f) => console.log(f));
  }

  console.log(
    `\nTotals: ${totalGhosts} ghost gate(s), ${totalPhantoms} unledgered gate(s), `
    + `${totalSumMismatch} inconsistent row(s).`,
  );
  if (totalGhosts > 0) {
    console.log(
      'Ghosts inflate `taken` and `allianceTaken`, so they can block leases for the\n'
      + 'airline itself and for its alliance partners. Repair is deliberately NOT\n'
      + 'automated here: writing to a live ledger needs a staging run first.',
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
