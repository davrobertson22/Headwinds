// Reconcile each world's float-pool share inventory against reality.
//
// Two things could drift the WorldMarket holdings ledger before key
// normalisation shipped:
//
//   1. Trades keyed the ledger by the competitor id (`human:<dbId>`) while
//      capital actions keyed it by the raw DB id — one airline's inventory
//      could split across two entries, each seeded independently from the
//      free-float fallback (double-counting the float).
//   2. Any entry seeded from the fallback while the rival view lacked
//      founderShares assumed a 30% float even for private airlines.
//
// The pool's TRUE inventory is fully determined by a conservation identity —
// everything outside the founder block that players do not hold sits in the
// pool:
//
//   poolShares(X) = freeFloat(X) − Σ over all other airlines' portfolios of X
//
// This tool recomputes that per airline per world, reports drift, and with
// --write rewrites each WorldMarket.holdings under CANONICAL raw-id keys
// (version-bumped so any in-flight trade CAS safely loses and retries).
//
//   node tools/reconcile-pool-holdings.mjs            # dry run + diagnostics
//   node tools/reconcile-pool-holdings.mjs --write    # apply
//   node tools/reconcile-pool-holdings.mjs <worldId> [--write]
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { freeFloatOf } from '@tailwinds/engine/utils/market.js';
import { poolKeyOf } from '../src/lib/marketService.mjs';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const write = args.includes('--write');
const onlyWorld = args.find((a) => a !== '--write') ?? null;

const dbHost = (() => {
  try { return new URL(process.env.DATABASE_URL).host; } catch { return '(DATABASE_URL not set / unparseable)'; }
})();
console.log(`DB host: ${dbHost}`);
console.log(`Scope:   ${onlyWorld ? `world ${onlyWorld}` : 'ALL worlds with a pool'}`);
console.log(`Mode:    ${write ? 'WRITE' : 'dry run'}\n`);

const markets = await prisma.worldMarket.findMany({
  where: onlyWorld ? { worldId: onlyWorld } : {},
});
console.log(`Scanned ${markets.length} world pool(s).\n`);

let changed = 0, clean = 0;

for (const market of markets) {
  const airlines = await prisma.airline.findMany({
    where: { worldId: market.worldId, status: 'ACTIVE' },
    select: { id: true, name: true, state: true },
  });

  // Player-held shares of each airline, summed across every OTHER portfolio.
  // Portfolio keys are competitor ids (`human:<dbId>`) — normalise to raw ids.
  const heldByPlayers = {};
  for (const a of airlines) {
    const holdings = a.state?.portfolio?.holdings;
    if (!holdings || typeof holdings !== 'object') continue;
    for (const [key, h] of Object.entries(holdings)) {
      const id = poolKeyOf(key);
      if (id === a.id) continue;                // can't hold your own stock
      if (!(Number(h?.shares) > 0)) continue;
      heldByPlayers[id] = (heldByPlayers[id] ?? 0) + Number(h.shares);
    }
  }

  const next = {};
  const lines = [];
  for (const a of airlines) {
    const equity = a.state?.equity;
    const float = Math.max(0, Math.round(freeFloatOf(equity ? { equity } : a.state ?? {})));
    if (float <= 0 && !(heldByPlayers[a.id] > 0)) continue;   // private, untouched — no entry
    const expected = Math.max(0, float - Math.round(heldByPlayers[a.id] ?? 0));
    next[a.id] = expected;

    const cur = market.holdings && typeof market.holdings === 'object'
      ? Number(market.holdings[a.id] ?? market.holdings[`human:${a.id}`])
      : NaN;
    const curShown = Number.isFinite(cur) ? cur : `(unset → fallback ${float})`;
    const effective = Number.isFinite(cur) ? cur : float;
    if (effective !== expected) {
      lines.push(`  ${a.name ?? a.id}: ledger ${curShown} → ${expected} (float ${float}, players hold ${Math.round(heldByPlayers[a.id] ?? 0)})`);
    }
  }

  // Flag ledger entries for airlines that no longer exist / are inactive.
  const known = new Set(airlines.map((a) => a.id));
  const stray = Object.keys(market.holdings ?? {}).filter((k) => !known.has(poolKeyOf(k)));
  if (stray.length) lines.push(`  stray ledger keys dropped: ${stray.join(', ')}`);

  if (lines.length === 0) { clean++; continue; }
  changed++;
  console.log(`world ${market.worldId}:`);
  for (const l of lines) console.log(l);

  if (write) {
    const res = await prisma.worldMarket.updateMany({
      where: { id: market.id, version: market.version },
      data: { holdings: next, version: { increment: 1 } },
    });
    console.log(res.count === 1 ? '  → written' : '  → SKIPPED (version moved — a trade landed mid-reconcile; rerun)');
  }
}

console.log(`\n${changed} pool(s) with drift, ${clean} clean.${write ? '' : '  (dry run — nothing written)'}`);
await prisma.$disconnect();
