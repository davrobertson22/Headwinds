// Backfill tool: give every existing airline an equity block and an SVPS score.
//
// The capital-markets rework moved the share count out of a global constant
// (TOTAL_SHARES) and into per-airline state (`state.equity.shares`), and changed
// the world leaderboard from market cap to SVPS (per-share shareholder value).
//
// The SQL migration (20260727000000_capital_markets) adds and seeds the `shares`
// and `svps` COLUMNS. This tool seeds the matching block inside each save BLOB,
// so an airline is consistent before its next tick rather than after it. Both are
// idempotent and both reproduce the pre-rework share price exactly:
//
//   shares = 100,000,000  (the founder count every airline was implicitly on)
//   isPublic = true       (everyone was already listed pre-rework)
//   cumDividendsPerShare = 0  (no dividends have ever been paid)
//   svps = sharePrice + 0 = marketCap / 100,000,000
//
// Because every airline gets the SAME share count, ranking on SVPS is
// arithmetically identical to ranking on market cap at the moment of migration —
// so nobody's rank moves on deploy. Ranks only diverge once players start issuing
// or retiring shares.
//
//   node tools/backfill-equity.mjs            # dry run + diagnostics
//   node tools/backfill-equity.mjs --write    # apply
//   node tools/backfill-equity.mjs <worldId> [--write]   # scope to one world
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { migratedEquity, svpsOf, svpsScore, TOTAL_SHARES } from '@tailwinds/engine/utils/market.js';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const write = args.includes('--write');
const worldId = args.find((a) => a !== '--write') ?? null;

const dbHost = (() => {
  try { return new URL(process.env.DATABASE_URL).host; } catch { return '(DATABASE_URL not set / unparseable)'; }
})();
console.log(`DB host: ${dbHost}`);
console.log(`Scope:   ${worldId ? `world ${worldId}` : 'ALL worlds'}`);
console.log(`Mode:    ${write ? 'WRITE' : 'dry run'}\n`);

const airlines = await prisma.airline.findMany({
  where: worldId ? { worldId } : {},
  select: { id: true, worldId: true, name: true, state: true, marketCap: true, shares: true, svps: true },
});
console.log(`Scanned ${airlines.length} airline(s).\n`);

let seeded = 0, alreadyOk = 0, skipped = 0, sampled = 0;

for (const a of airlines) {
  if (!a.state || typeof a.state !== 'object' || Array.isArray(a.state)) {
    console.log(`SKIP   ${a.id}  unreadable state blob (${a.state === null ? 'null' : typeof a.state})`);
    skipped++;
    continue;
  }

  const existing = a.state.equity;
  const hasEquity = existing && typeof existing === 'object' && Number(existing.shares) > 0;

  // Merge rather than overwrite: a blob that already has an equity block (because
  // it ticked after the deploy) keeps its real share count and dividend history.
  const equity = hasEquity ? { ...migratedEquity(), ...existing } : migratedEquity();

  const sharePrice = Number.isFinite(a.state.sharePrice)
    ? a.state.sharePrice
    : Number(a.marketCap ?? 0) / (Number(equity.shares) || TOTAL_SHARES);
  const svps  = svpsOf({ sharePrice, equity });
  const score = svpsScore(svps);

  const blobNeedsWork = !hasEquity || !Number.isFinite(a.state.svps);
  const colsNeedWork  = Number(a.shares) !== Number(equity.shares) || Number(a.svps) !== score;

  if (!blobNeedsWork && !colsNeedWork) {
    alreadyOk++;
    if (sampled < 5) {
      sampled++;
      console.log(`OK     ${a.id}  ${a.name}  ${Number(equity.shares).toLocaleString()} sh  SVPS $${svps.toFixed(4)}`);
    }
    continue;
  }

  seeded++;
  console.log(
    `SEED   ${a.id}  ${a.name}  (world ${a.worldId})  ` +
    `${Number(equity.shares).toLocaleString()} sh  price $${sharePrice.toFixed(4)}  SVPS $${svps.toFixed(4)}` +
    `${hasEquity ? '  [blob already had equity — merged]' : ''}`,
  );

  if (write) {
    await prisma.airline.update({
      where: { id: a.id },
      data: {
        state:  { ...a.state, equity, svps },
        shares: BigInt(Number(equity.shares) || TOTAL_SHARES),
        svps:   BigInt(score),
      },
    });
  }
}

console.log(`\n${seeded} seeded, ${alreadyOk} already consistent, ${skipped} skipped.`);
if (!write && seeded > 0) console.log('Dry run — re-run with --write to apply.');

// Rank-neutrality check: while every airline shares one founder count, ordering by
// SVPS must reproduce ordering by market cap exactly. If this ever reports a
// difference, some airline's share count has genuinely moved (issuance/buyback) and
// the two orderings are legitimately allowed to differ.
const byWorld = new Map();
for (const a of airlines) {
  if (!byWorld.has(a.worldId)) byWorld.set(a.worldId, []);
  const equity = (a.state && typeof a.state === 'object' && a.state.equity) || {};
  const shares = Number(equity.shares) || TOTAL_SHARES;
  byWorld.get(a.worldId).push({
    id: a.id,
    cap: Number(a.marketCap ?? 0),
    svps: svpsOf({
      sharePrice: Number.isFinite(a.state?.sharePrice) ? a.state.sharePrice : Number(a.marketCap ?? 0) / shares,
      equity,
    }),
    shares,
  });
}
let diverged = 0;
for (const [wid, rows] of byWorld) {
  if (rows.length < 2) continue;
  const byCap  = [...rows].sort((x, y) => y.cap - x.cap).map((r) => r.id).join(',');
  const bySvps = [...rows].sort((x, y) => y.svps - x.svps).map((r) => r.id).join(',');
  if (byCap !== bySvps) {
    diverged++;
    const counts = [...new Set(rows.map((r) => r.shares))];
    console.log(
      `\nRANK DIVERGENCE in world ${wid}: market-cap order != SVPS order` +
      `\n  share counts in this world: ${counts.map((c) => c.toLocaleString()).join(', ')}` +
      `\n  ${counts.length > 1 ? 'Expected — share counts have moved, so per-share value is genuinely a different ranking.' : 'UNEXPECTED with a uniform share count — investigate before deploying.'}`,
    );
  }
}
if (diverged === 0) console.log('Rank neutrality: SVPS order matches market-cap order in every world. ✓');

await prisma.$disconnect();
