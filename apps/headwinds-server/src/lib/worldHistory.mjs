// A world's season so far, from the Standing table — the one record of the
// rankings that is kept for a world's whole life (news is swept after 52 game
// weeks, tickService.mjs). Serves GET /worlds/:id/history, which the public
// "season so far" page and the hall of fame are built from.
//
// `assembleHistory` is pure (tools/world-history-test.mjs); `loadWorldHistory`
// does the reads: three indexed Standing queries and one airline name lookup,
// never a state blob.
export const WEEKS_PER_YEAR = 52;
export const PODIUM_SIZE = 3;
/** How far back the "weeks at #1" count looks. Twenty game years is plenty to call a dynasty. */
export const REIGN_LOOKBACK_WEEKS = 1040;

/**
 * The week whose Standing rows close game year `year`: the tick that lands on
 * week 1 of the next year ranks the airlines on the year just flown (it is the
 * tick that writes the `year_in_review` news row).
 */
export const yearEndWeek = (year) => year * WEEKS_PER_YEAR + 1;

/** Every finished year's closing week, oldest first, for a world whose clock is at `thisWeek`. */
export function yearEndWeeks(thisWeek) {
  const out = [];
  for (let y = 1; yearEndWeek(y) <= thisWeek; y++) out.push(yearEndWeek(y));
  return out;
}

/**
 * @param {object} p
 * @param {number} p.thisWeek      the world's linear week
 * @param {number|null} p.rankingSince  first week ranked on average profit (null: never reworked)
 * @param {Array} p.podiumRows     Standing rows { week, rank, airlineId, score } at year-end weeks, rank ≤ 3
 * @param {Array} p.leaderRows     Standing rows { week, airlineId } with rank 1, newest first
 * @param {Array} p.yearAgoRows    Standing rows { airlineId, rank } from 52 weeks ago
 * @param {Array} p.airlines       { id, name, hub, status, joinedWeek, restartedWeek }
 */
export function assembleHistory({ thisWeek, rankingSince = null, podiumRows = [], leaderRows = [], yearAgoRows = [], airlines = [] }) {
  const byId = new Map(airlines.map((a) => [a.id, a]));
  // A re-founded airline reuses its row (and its id), so a podium from before
  // the restart belongs to the company it replaced. Its name is gone; say so
  // rather than credit the new airline with the old one's year.
  const who = (airlineId, week) => {
    const a = byId.get(airlineId);
    if (!a) return { airlineId, name: null, hub: null, gone: true };
    const before = a.restartedWeek != null && week < a.restartedWeek;
    return {
      airlineId,
      name: before ? null : a.name,
      hub: before ? null : a.hub,
      gone: before,
      active: a.status === 'ACTIVE',
    };
  };
  const scoreOf = (row) => {
    const legacy = rankingSince == null || row.week < rankingSince;
    const n = Number(row.score);
    return legacy
      ? { metric: 'svps', score: Number.isFinite(n) ? n / 10_000 : null }
      : { metric: 'avgWeeklyNetProfit', score: Number.isFinite(n) ? n : null };
  };

  const byWeek = new Map();
  for (const r of podiumRows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week).push(r);
  }
  const years = [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, rows]) => {
    const podium = rows.filter((r) => r.rank <= PODIUM_SIZE).sort((a, b) => a.rank - b.rank)
      .map((r) => ({ rank: r.rank, ...who(r.airlineId, week), ...scoreOf(r) }));
    return { year: Math.round((week - 1) / WEEKS_PER_YEAR), week, metric: podium[0]?.metric ?? null, podium };
  }).filter((y) => y.year >= 1 && y.podium.length > 0);

  // Years led, per airline — only years whose leader still carries its name.
  const tally = new Map();
  for (const y of years) {
    const lead = y.podium[0];
    if (!lead || lead.gone || !lead.name) continue;
    const t = tally.get(lead.airlineId) ?? { airlineId: lead.airlineId, name: lead.name, hub: lead.hub, years: 0, lastYear: 0 };
    t.years += 1; t.lastYear = y.year;
    tally.set(lead.airlineId, t);
  }
  const yearsLed = [...tally.values()].sort((a, b) => b.years - a.years || b.lastYear - a.lastYear);

  // Weeks at #1: the unbroken run back from the newest ranked week.
  let reign = null;
  const leaders = [...leaderRows].sort((a, b) => b.week - a.week);
  if (leaders.length > 0) {
    const top = leaders[0];
    let weeks = 0, expect = top.week;
    for (const r of leaders) {
      if (r.airlineId !== top.airlineId || r.week !== expect) break;
      weeks += 1; expect -= 1;
    }
    const w = who(top.airlineId, top.week);
    reign = {
      ...w, weeks, since: top.week - weeks + 1,
      // The run reached the edge of what was read: it is "at least" this long.
      capped: weeks === leaders.length && leaders.length >= REIGN_LOOKBACK_WEEKS,
    };
  }

  const yearAgoWeek = thisWeek - WEEKS_PER_YEAR;
  const yearAgo = yearAgoWeek >= 1 && (rankingSince == null || yearAgoWeek >= rankingSince) && yearAgoRows.length > 0
    ? { week: yearAgoWeek, airlines: yearAgoRows.length, ranks: yearAgoRows.map((r) => ({ airlineId: r.airlineId, rank: r.rank })) }
    : null;

  return { thisWeek, rankingSince, years, yearsLed, reign, yearAgo };
}

export async function loadWorldHistory(prisma, world, { rankingSince = null } = {}) {
  const thisWeek = (world.currentYear - 1) * WEEKS_PER_YEAR + world.currentWeek;
  const weeks = yearEndWeeks(thisWeek);
  const [podiumRows, leaderRows, yearAgoRows] = await Promise.all([
    weeks.length === 0 ? [] : prisma.standing.findMany({
      where: { worldId: world.id, week: { in: weeks }, rank: { lte: PODIUM_SIZE } },
      select: { week: true, rank: true, airlineId: true, score: true },
    }),
    prisma.standing.findMany({
      where: { worldId: world.id, rank: 1, week: { gt: thisWeek - REIGN_LOOKBACK_WEEKS } },
      select: { week: true, airlineId: true },
      orderBy: { week: 'desc' },
      take: REIGN_LOOKBACK_WEEKS,
    }),
    thisWeek - WEEKS_PER_YEAR < 1 ? [] : prisma.standing.findMany({
      where: { worldId: world.id, week: thisWeek - WEEKS_PER_YEAR },
      select: { airlineId: true, rank: true },
    }),
  ]);
  const ids = [...new Set([...podiumRows, ...leaderRows.slice(0, 1)].map((r) => r.airlineId))];
  const airlines = ids.length === 0 ? [] : await prisma.airline.findMany({
    where: { worldId: world.id, id: { in: ids } },
    select: { id: true, name: true, hub: true, status: true, joinedWeek: true, restartedWeek: true },
  });
  return assembleHistory({ thisWeek, rankingSince, podiumRows, leaderRows, yearAgoRows, airlines });
}
