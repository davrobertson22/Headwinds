// ─────────────────────────────────────────────────────────────────────────────
// CAREER SNAPSHOT — the one moment a world's result is written down
//
// Called once, post-commit, on the tick that ends a world. Post-commit and not
// inside the transaction on purpose: the tick already holds row locks on every
// airline in the world for up to thirty seconds and is the thing player-facing
// 503s line up with. A hall-of-fame entry is not worth a single extra
// millisecond of that budget, and it is not worth rolling a committed week back
// if it fails.
//
// Which means it must be safe to run again. It is: see `withWorldRecord` — the
// record is keyed by world id and every total is recomputed from the map, so
// running this twice on the same world produces exactly the same account row.
// ─────────────────────────────────────────────────────────────────────────────

import { withWorldRecord, passengersFromState } from './career.mjs';

/**
 * Bank every airline's result in this world into its owner's career.
 *
 * @param {object} prisma
 * @param {object} world     the world row (already flipped to ENDED)
 * @param {object} opts
 * @param {number} opts.weekIndex          the final linear week
 * @param {Array}  [opts.ranked]           [{ airlineId, svpsScore }] final standings, best first
 * @param {Map}    [opts.passengersById]   airlineId → lifetime pax, from states already in memory
 * @param {object} [opts.log]
 * @returns {Promise<number>} accounts written
 */
export async function snapshotWorldCareers(prisma, world, {
  weekIndex, ranked = [], passengersById = new Map(), log = console,
} = {}) {
  // Every airline that ever flew here, bankrupt ones included — a season you
  // lost is still a season you played, and the Phoenix badge depends on it.
  // Scalar columns only: the `state` blob averages half a megabyte and there
  // can be forty of them.
  const airlines = await prisma.airline.findMany({
    where: { worldId: world.id },
    select: {
      id: true, accountId: true, name: true, hub: true, status: true,
      svps: true, marketCap: true, restarts: true, joinedWeek: true,
      restartedWeek: true, week: true,
    },
  });
  if (airlines.length === 0) return 0;

  const rankOf = new Map(ranked.map((r, i) => [r.airlineId, i + 1]));
  const rankedCount = ranked.length;

  // Best rank ever held, in one grouped query rather than one per airline.
  // `Standing` is indexed on [airlineId, week]; this is a small scan per
  // airline and it happens once in a world's lifetime.
  let bestRankOf = new Map();
  try {
    const grouped = await prisma.standing.groupBy({
      by: ['airlineId'],
      where: { worldId: world.id },
      _min: { rank: true },
    });
    bestRankOf = new Map(grouped.map((g) => [g.airlineId, g._min.rank]));
  } catch (err) {
    // A missing best-rank is a dash on a profile page, not a reason to lose the
    // whole season's record.
    log.warn?.(`[career] world ${world.id}: best-rank lookup failed (${err?.message ?? err})`);
  }

  const toNum = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0);
  let written = 0;

  for (const a of airlines) {
    const record = {
      worldId:     world.id,
      worldName:   world.name ?? null,
      lengthYears: world.lengthYears ?? null,
      endedAt:     (world.endedAt ?? new Date()).toISOString?.() ?? null,
      airlineId:   a.id,
      airlineName: a.name,
      hub:         a.hub,
      rank:        rankOf.get(a.id) ?? null,
      of:          rankedCount,
      bestRank:    bestRankOf.get(a.id) ?? null,
      svps:        toNum(a.svps),
      marketCap:   toNum(a.marketCap),
      status:      a.status,
      restarts:    a.restarts ?? 0,
      passengers:  passengersById.get(a.id) ?? 0,
      // Weeks this ACCOUNT was in the world — `joinedWeek` keeps that meaning
      // even across a re-founding, which is what a career wants to count.
      weeksPlayed: Math.max(0, (weekIndex ?? a.week ?? 0) - (a.joinedWeek ?? 1) + 1),
    };

    // Read-modify-write per account. There is no contention worth guarding
    // against — a world ends once, and nothing else writes this column.
    try {
      const account = await prisma.account.findUnique({
        where: { id: a.accountId },
        select: { careerStats: true },
      });
      if (!account) continue;
      await prisma.account.update({
        where: { id: a.accountId },
        data:  { careerStats: withWorldRecord(account.careerStats, record) },
      });
      written += 1;
    } catch (err) {
      log.error?.(`[career] world ${world.id} airline ${a.id}: ${err?.message ?? err}`);
    }
  }

  log.info?.(`[career] world ${world.name ?? world.id} ended — banked ${written} career record(s)`);
  return written;
}

/**
 * Lifetime passengers for every airline whose state we already hold in memory
 * at the final tick. Anything missing (a bankrupt airline is not ticked, so it
 * never appears in `computed`) records 0 rather than costing a blob read each.
 */
export function passengerTotalsFrom(computed = []) {
  const map = new Map();
  for (const c of computed) {
    const id = c?.airline?.id;
    if (!id) continue;
    map.set(id, passengersFromState(c.next));
  }
  return map;
}
