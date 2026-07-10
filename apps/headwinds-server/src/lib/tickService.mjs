// The authoritative weekly tick — Phase 2.
// ----------------------------------------------------------------------------
// Advances every airline in a world one game-week, in lockstep, by running the
// SHARED engine reducer server-side. Schedule is derived, not stored: a world at
// pace `weeksPerDay` owes week N at `startedAt + N × (24h / weeksPerDay)`, so a
// restarted worker knows exactly how many ticks each world is behind.
//
// Concurrency/idempotency: the world-clock advance is a compare-and-set
// (`updateMany` guarded on the current week). If two workers race, exactly one
// wins; the loser abandons the tick without touching airline state.
import { gameReducer } from '@tailwinds/engine/reducer';
import { WEEKS_PER_YEAR, totalWeeks, tickIntervalMs } from './worldConfig.mjs';

// Linear week index (1-based) of a world's clock.
export const weekIndex = (world) =>
  (world.currentYear - 1) * WEEKS_PER_YEAR + world.currentWeek;

// How many ticks this world owes right now (0 for non-RUNNING worlds).
// Never exceeds the world's total length.
export function ticksDue(world, now = new Date()) {
  if (world.status !== 'RUNNING' || !world.startedAt) return 0;
  const elapsed = now.getTime() - new Date(world.startedAt).getTime();
  const target = Math.min(
    1 + Math.floor(elapsed / tickIntervalMs(world.weeksPerDay)),
    totalWeeks(world.lengthYears),
  );
  return Math.max(0, target - weekIndex(world));
}

// Run ONE tick for one world. Returns { ok, week, year, ended, airlines } or
// { ok: false, reason } when the compare-and-set loses or the world is done.
export async function tickWorldOnce(prisma, world, { log = console } = {}) {
  const fromIndex = weekIndex(world);
  const toIndex = fromIndex + 1;
  if (world.status !== 'RUNNING') return { ok: false, reason: 'not-running' };
  if (fromIndex >= totalWeeks(world.lengthYears)) return { ok: false, reason: 'complete' };

  const newYear = Math.floor((toIndex - 1) / WEEKS_PER_YEAR) + 1;
  const newWeek = ((toIndex - 1) % WEEKS_PER_YEAR) + 1;
  const ended = toIndex >= totalWeeks(world.lengthYears);

  // ── Claim the tick (compare-and-set on the world clock) ─────────────────────
  const claimed = await prisma.world.updateMany({
    where: { id: world.id, currentWeek: world.currentWeek, currentYear: world.currentYear, status: 'RUNNING' },
    data: {
      currentWeek: newWeek,
      currentYear: newYear,
      ...(ended ? { status: 'ENDED', endedAt: new Date() } : {}),
    },
  });
  if (claimed.count === 0) return { ok: false, reason: 'lost-race' };

  const tickLog = await prisma.tickLog.create({
    data: { worldId: world.id, week: toIndex, status: 'running' },
  });

  try {
    // ── Advance every active airline through the shared engine ───────────────
    const airlines = await prisma.airline.findMany({
      where: { worldId: world.id, status: 'ACTIVE' },
    });

    const results = [];
    for (const airline of airlines) {
      const next = gameReducer(airline.state, { type: 'ADVANCE_WEEK' });
      const bankrupt = next.phase === 'bankrupt';
      await prisma.airline.update({
        where: { id: airline.id },
        data: {
          state: next,
          cash: BigInt(Math.round(next.cash ?? 0)),
          marketCap: BigInt(Math.round(next.marketCap ?? 0)),
          week: toIndex,
          ...(bankrupt ? { status: 'BANKRUPT' } : {}),
        },
      });
      results.push({ airlineId: airline.id, name: airline.name, cash: Math.round(next.cash ?? 0), marketCap: Math.round(next.marketCap ?? 0), bankrupt });
    }

    // ── Standings snapshot for this week ─────────────────────────────────────
    const ranked = [...results].sort((a, b) => b.marketCap - a.marketCap);
    if (ranked.length > 0) {
      await prisma.standing.createMany({
        data: ranked.map((r, i) => ({
          worldId: world.id,
          airlineId: r.airlineId,
          week: toIndex,
          rank: i + 1,
          score: BigInt(r.marketCap),
        })),
      });
    }

    await prisma.tickLog.update({
      where: { id: tickLog.id },
      data: { status: 'ok', finishedAt: new Date() },
    });
    return { ok: true, week: newWeek, year: newYear, ended, airlines: results.length };
  } catch (err) {
    log.error(`[tick] world ${world.id} week ${toIndex} failed:`, err);
    await prisma.tickLog.update({
      where: { id: tickLog.id },
      data: { status: 'error', error: String(err?.message ?? err), finishedAt: new Date() },
    }).catch(() => {});
    throw err;
  }
}

// Tick every RUNNING world that's due, catching up at most `maxCatchUp` weeks per
// world per call (so a long worker outage streams back gradually instead of
// slamming the DB in one pass — the next scheduler run continues the catch-up).
export async function runDueTicks(prisma, { maxCatchUp = 12, log = console, now = new Date() } = {}) {
  const worlds = await prisma.world.findMany({ where: { status: 'RUNNING' } });
  let ticked = 0;
  for (let world of worlds) {
    let due = Math.min(ticksDue(world, now), maxCatchUp);
    if (due > 0) log.info(`[tick] ${world.name} (${world.id}): ${due} week(s) due`);
    while (due > 0) {
      const res = await tickWorldOnce(prisma, world, { log });
      if (!res.ok) break; // lost a race or world completed — stop, next run resolves
      ticked++;
      due--;
      // Refresh the in-memory clock for the next compare-and-set.
      world = { ...world, currentWeek: res.week, currentYear: res.year, status: res.ended ? 'ENDED' : 'RUNNING' };
      if (res.ended) { log.info(`[tick] ${world.name} reached its final week — ENDED`); break; }
    }
  }
  return { ticked };
}
