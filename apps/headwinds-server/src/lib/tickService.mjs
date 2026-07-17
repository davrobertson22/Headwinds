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
import { WEEKS_PER_YEAR, totalWeeks, tickIntervalMs, deriveEndsAt } from './worldConfig.mjs';
import { buildWorldRivalViews, withRivals } from './humanRivals.mjs';

// A reducer bug that yields NaN/Infinity for cash or marketCap must not take down
// the whole tick (BigInt(NaN) throws): coerce to a finite integer so the world
// keeps advancing. The caller's catch logs any world that misbehaves.
const safeInt = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
};

// Linear week index (1-based) of a world's clock.
export const weekIndex = (world) =>
  (world.currentYear - 1) * WEEKS_PER_YEAR + world.currentWeek;

// When the NEXT week lands for this world (null when not RUNNING or complete).
// Week toIndex = weekIndex+1 becomes due once elapsed ≥ weekIndex × interval —
// the same derived schedule ticksDue() uses, exposed for client countdowns.
export function nextTickAt(world) {
  if (world.status !== 'RUNNING' || !world.startedAt) return null;
  if (weekIndex(world) >= totalWeeks(world.lengthYears)) return null;
  return new Date(
    new Date(world.startedAt).getTime() + weekIndex(world) * tickIntervalMs(world.weeksPerDay),
  );
}

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

  // Reads first (outside the transaction): active airlines + their rival views.
  // Humans-only competition — each airline ticks against the OTHER players'
  // current states plus the world's alliance graph. No AI airlines exist.
  const airlines = await prisma.airline.findMany({
    where: { worldId: world.id, status: 'ACTIVE' },
    include: { account: { select: { isOG: true, email: true } } }, // OG + DEV badges (email stays server-side)
  });
  const rivalViews = await buildWorldRivalViews(prisma, world.id, { airlines });

  // Compute every airline's next state BEFORE touching the DB. An airline whose
  // reducer/serialization throws is skipped (logged) so one corrupt airline can
  // no longer abort the whole week.
  const computed = [];
  for (const airline of airlines) {
    try {
      const next = gameReducer(withRivals(airline.state, rivalViews.get(airline.id)), { type: 'ADVANCE_WEEK' });
      computed.push({
        airline,
        next,
        cash: safeInt(next.cash),
        marketCap: safeInt(next.marketCap),
        bankrupt: next.phase === 'bankrupt',
      });
    } catch (err) {
      log.error(`[tick] world ${world.id} airline ${airline.id} reducer threw — skipped this week:`, err?.message ?? err);
    }
  }

  // ── Atomic commit ───────────────────────────────────────────────────────────
  // Advance the clock (compare-and-set), write every airline, and snapshot the
  // standings in ONE transaction: either the whole week lands or nothing does, so
  // the world clock can never run ahead of the airline state it summarises.
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const claimed = await tx.world.updateMany({
        where: { id: world.id, currentWeek: world.currentWeek, currentYear: world.currentYear, status: 'RUNNING' },
        data: {
          currentWeek: newWeek,
          currentYear: newYear,
          ...(ended ? { status: 'ENDED', endedAt: new Date() } : {}),
        },
      });
      if (claimed.count === 0) return { lostRace: true };

      await tx.tickLog.create({
        data: { worldId: world.id, week: toIndex, status: 'ok', finishedAt: new Date() },
      });

      const written = [];
      for (const c of computed) {
        // Version compare-and-set: if a player decision changed this airline since
        // we read it, skip it here (it catches up next pass) rather than clobber
        // the just-committed decision.
        const res = await tx.airline.updateMany({
          where: { id: c.airline.id, version: c.airline.version ?? 0 },
          data: {
            state: c.next,
            cash: BigInt(c.cash),
            marketCap: BigInt(c.marketCap),
            week: toIndex,
            version: { increment: 1 },
            ...(c.bankrupt ? { status: 'BANKRUPT' } : {}),
          },
        });
        if (res.count > 0) written.push({ airlineId: c.airline.id, name: c.airline.name, marketCap: c.marketCap });
        else log.error(`[tick] world ${world.id} airline ${c.airline.id} changed under the tick — skipped, catches up next pass`);
      }

      const ranked = [...written].sort((a, b) => b.marketCap - a.marketCap);
      if (ranked.length > 0) {
        await tx.standing.createMany({
          data: ranked.map((r, i) => ({
            worldId: world.id,
            airlineId: r.airlineId,
            week: toIndex,
            rank: i + 1,
            score: BigInt(r.marketCap),
          })),
        });
      }
      return { lostRace: false, airlines: written.length };
    });

    if (outcome.lostRace) return { ok: false, reason: 'lost-race' };
    return { ok: true, week: newWeek, year: newYear, ended, airlines: outcome.airlines };
  } catch (err) {
    log.error(`[tick] world ${world.id} week ${toIndex} failed:`, err);
    // The transaction rolled back — record the failure separately for the audit
    // trail (best-effort; never masks the original error).
    await prisma.tickLog.create({
      data: { worldId: world.id, week: toIndex, status: 'error', error: String(err?.message ?? err), finishedAt: new Date() },
    }).catch(() => {});
    throw err;
  }
}

// Tick every RUNNING world that's due, catching up at most `maxCatchUp` weeks per
// world per call (so a long worker outage streams back gradually instead of
// slamming the DB in one pass — the next scheduler run continues the catch-up).
// Flip any LOBBY world whose scheduled start time has arrived to RUNNING. A world
// created with tickConfig.scheduledStartAt sits open for joining but its clock is
// parked until here — joining never starts it. startedAt is set to the SCHEDULED
// instant (not "now") so the tick cadence lines up with the announced time even if
// the worker fires a little late; a long outage just means the world owes weeks and
// runDueTicks catches it up (bounded by maxCatchUp). Empty worlds start too — the
// countdown is a promise; a late joiner simply joins mid-season.
export async function startDueWorlds(prisma, { now = new Date(), log = console } = {}) {
  const lobby = await prisma.world.findMany({ where: { status: 'LOBBY' } });
  let started = 0;
  for (const w of lobby) {
    const at = w.tickConfig?.scheduledStartAt;
    if (!at) continue;
    const startAt = new Date(at);
    if (Number.isNaN(startAt.getTime()) || startAt.getTime() > now.getTime()) continue;
    const claimed = await prisma.world.updateMany({
      where: { id: w.id, status: 'LOBBY' },
      data: {
        status: 'RUNNING',
        startedAt: startAt,
        endsAt: deriveEndsAt(startAt, w.lengthYears, w.weeksPerDay),
      },
    });
    if (claimed.count) {
      started++;
      log.info?.(`[tick] scheduled world "${w.name}" (${w.id}) started — due ${startAt.toISOString()}`);
    }
  }
  return { started };
}

export async function runDueTicks(prisma, { maxCatchUp = 12, log = console, now = new Date() } = {}) {
  // Start any scheduled worlds that have come due, then tick everything RUNNING —
  // so a world that starts this pass also advances its first due week(s) here.
  await startDueWorlds(prisma, { now, log });
  const worlds = await prisma.world.findMany({ where: { status: 'RUNNING' } });
  let ticked = 0;
  for (let world of worlds) {
    try {
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
    } catch (err) {
      // One world failing (e.g. a corrupt airline state) must not wedge the whole
      // scheduler pass — log it and move on so the other worlds still tick.
      log.error(`[tick] world ${world.id} aborted this pass:`, err?.message ?? err);
    }
  }
  return { ticked };
}
