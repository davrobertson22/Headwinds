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
import { VALUATION, svpsOf, svpsScore } from '@tailwinds/engine/utils/market.js';
import { tickEvents, rollEvents } from '@tailwinds/engine/data/events.js';
import { GATE_AUCTION_OPEN_WEEK, GATE_LOCKOUT_WEEKS } from '@tailwinds/engine/data/airports.js';
import { WEEKS_PER_YEAR, totalWeeks, tickIntervalMs, deriveEndsAt } from './worldConfig.mjs';
import { buildWorldRivalViews, withRivals, stripRivals } from './humanRivals.mjs';
import {
  isGateScarcity, reconcileForfeitures,
  openDueAuctions, resolveDueAuctions,
} from './gateService.mjs';
import { scrapStale } from './aircraftMarketService.mjs';
import { snapshotWorldCareers, passengerTotalsFrom } from './careerService.mjs';
import { expireStaleOffers } from './codeshareService.mjs';
import { fireSaleAirline } from './fireSaleService.mjs';
import { refillWorldMarket, splitDividend, holdersOf } from './marketService.mjs';
import { withTx } from './tx.mjs';
import { seededRand, worldFuelIndex, worldMarketIndex } from './worldEconomy.mjs';
import {
  NEWS_WINDOW_WEEKS, worldEventNewsRows, bankruptcyNewsRows, rankChangeNewsRows,
  gateForfeitureNewsRows,
} from './newsService.mjs';

// A commit that writes N airline blobs sequentially must not be capped by Prisma's
// default 5s interactive-transaction timeout — at scale that timed out and rolled
// the whole week back, so the world could never advance. Give it real headroom.
const TICK_TX_OPTS = { timeout: 30_000, maxWait: 15_000 };

// How many undrained toasts an airline's blob may carry between ticks. Only
// reached by an airline nobody has opened in weeks; the news feed is the
// durable record, so losing the oldest of a long backlog costs nothing.
const TOAST_CARRY_CAP = 40;

// ── Shared world economy (fuel + events) ──────────────────────────────────────
// Without this, each airline rolled its OWN fuel price and its OWN events, so two
// rivals in the "same" world paid different fuel and saw different booms/crises —
// the leaderboard partly reflected private dice. We compute ONE fuel index and
// ONE event set per world-week and inject them into every airline's tick. The
// walks themselves live in worldEconomy.mjs, shared with joinWorld's backfill
// (a late joiner is seeded onto the same walk, not a fresh 1.0×).

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
  const rivalViews = await buildWorldRivalViews(prisma, world.id, { airlines, world });

  // Dividends owed to these airlines from previous weeks. Read BEFORE the
  // transaction and injected into each airline's tick, then consumed inside the
  // commit only for airlines whose write actually lands — so a skipped airline
  // collects next week instead of the money vanishing. See DividendCredit.
  const pendingCredits = await prisma.dividendCredit.findMany({
    where: { worldId: world.id, consumed: false },
    select: { id: true, airlineId: true, amount: true },
  });
  const creditsByAirline = new Map();
  for (const c of pendingCredits) {
    const entry = creditsByAirline.get(c.airlineId) ?? { total: 0, ids: [] };
    entry.total += Number(c.amount);
    entry.ids.push(c.id);
    creditsByAirline.set(c.airlineId, entry);
  }

  // Shared world economy for THIS week: one fuel index (seeded from worldSeed) and
  // one event set (aged from the world's own running list, stored in tickConfig).
  // Every airline ticks against the same fuel + events, so the leaderboard reflects
  // skill, not private RNG. Events roll ONCE here (not per airline).
  const worldFuel = worldFuelIndex(world.worldSeed ?? world.id, fromIndex);
  const worldMarket = worldMarketIndex(world.worldSeed ?? world.id, fromIndex);
  const prevWorldEvents = Array.isArray(world.tickConfig?.runtimeEvents)
    ? world.tickConfig.runtimeEvents : [];
  const { updated: survivingWorldEvents } = tickEvents(prevWorldEvents);
  const worldEvents = [...survivingWorldEvents, ...rollEvents(survivingWorldEvents, { multiplayer: true })];

  // One airline's week. Factored out because it has to be runnable a SECOND time,
  // inside the commit, against a state that changed under us — see the recompute
  // pass below.
  const computeOne = (airline) => {
    // Valuation noise: seeded per (world, week, airline) — deterministic, so a
    // retried tick reproduces the same print, but unknowable in advance, so
    // nobody can compute next week's exact price and arb the stock market.
    // Seeded on the airline ID, not on its state, so a recompute of the same
    // airline in the same week reproduces the identical print.
    const valuationNoise = (seededRand(world.worldSeed ?? world.id, `mcnoise:${toIndex}:${airline.id}`) * 2 - 1) * VALUATION.NOISE_PCT;
    const next = gameReducer(
      withRivals(airline.state, rivalViews.get(airline.id)),
      { type: 'ADVANCE_WEEK', worldFuelIndex: worldFuel, worldEvents, valuationNoise,
        marketIndex: worldMarket,
        incomingDividends: creditsByAirline.get(airline.id)?.total ?? 0 },
    );
    // ── Toast durability ─────────────────────────────────────────────────
    // ADVANCE_WEEK REPLACES state.pendingToasts (see reducer.mjs). In SOLO that
    // is correct and load-bearing: the app drains the queue the moment it
    // renders, so the array is always empty when the next week starts, and the
    // golden-master harness hashes a state that depends on the replace.
    //
    // Headwinds ticks server-side on a schedule with nobody watching, so the
    // replace silently destroyed the previous week's toasts — a player away for
    // two ticks only ever saw the most recent week. Carry the undrained ones
    // forward HERE instead of changing the engine: CLEAR_TOASTS is an allowed
    // player action (world.mjs), so the queue really is emptied server-side once
    // the player has seen it, and solo behaviour is untouched.
    //
    // Capped because an airline nobody logs into never drains: keep the most
    // recent TOAST_CARRY_CAP. Dropping the OLDEST is the right end to lose —
    // "your gates were forfeited" is followed by a lockout the player can still
    // see on the airport, and the durable record is the news feed either way.
    const carried = airline.state?.pendingToasts ?? [];
    if (carried.length > 0) {
      next.pendingToasts = [...carried, ...(next.pendingToasts ?? [])].slice(-TOAST_CARRY_CAP);
    }

    // Gate scarcity: rule-5 forfeitures happen inside ADVANCE_WEEK (gates
    // vanish from the blob). Diff pre/post so the world's gate ledger can be
    // reconciled after the commit — only for airlines whose write lands.
    let gateReleases = null;
    if (isGateScarcity(world)) {
      gateReleases = [];
      const pre = airline.state?.gates ?? {};
      const post = next.gates ?? {};
      for (const [code, count] of Object.entries(pre)) {
        const drop = (count ?? 0) - (post[code] ?? 0);
        if (drop > 0) gateReleases.push({ airlineId: airline.id, airportCode: code, count: drop });
      }
    }
    const svps = svpsOf(next);
    return {
      airline,
      next,
      // A dividend this airline just declared, for cross-player settlement below.
      dividend: next.lastReport?.dividend ?? null,
      consumedCreditIds: creditsByAirline.get(airline.id)?.ids ?? [],
      cash: safeInt(next.cash),
      marketCap: safeInt(next.marketCap),
      // Leaderboard metric: per-share value including lifetime dividends.
      // Packed to ten-thousandths of a dollar so it survives the BigInt column.
      svps,
      svpsScore: svpsScore(svps),
      shares: safeInt(next.equity?.shares),
      // A private airline has no traded share price, so it is not ranked (it
      // still ticks, still shows in the world, and starts ranking on listing).
      isPublic: next.equity?.isPublic !== false,
      bankrupt: next.phase === 'bankrupt',
      gateReleases,
    };
  };

  // Compute every airline's next state BEFORE touching the DB. An airline whose
  // reducer/serialization throws is skipped (logged) so one corrupt airline can
  // no longer abort the whole week.
  const computed = [];
  for (const airline of airlines) {
    try {
      computed.push(computeOne(airline));
    } catch (err) {
      log.error(`[tick] world ${world.id} airline ${airline.id} reducer threw — skipped this week:`, err?.message ?? err);
    }
  }

  // Last week's top 5, for the news feed's rank-change items. Read outside the
  // transaction: it is one tiny indexed query and the commit stays short.
  const prevTop5 = (await prisma.standing.findMany({
    where: { worldId: world.id, week: fromIndex, rank: { lte: 5 } },
    orderBy: { rank: 'asc' },
    select: { airlineId: true },
  })).map((r) => r.airlineId);

  // ── Atomic commit ───────────────────────────────────────────────────────────
  // Advance the clock (compare-and-set), write every airline, and snapshot the
  // standings in ONE transaction: either the whole week lands or nothing does, so
  // the world clock can never run ahead of the airline state it summarises.
  try {
    // Commit-duration observability (2026-08-04). The tick transaction holds
    // row locks on every airline it writes and squeezes the shared connection
    // pool while it runs; player-facing 503 bursts (P2024) line up with these
    // windows in the Railway logs. Until this line existed nobody could say
    // how long a given world's commit actually holds the world hostage, or
    // watch it grow as blobs age — the number that decides when the split-blob
    // rework stops being optional.
    const commitStartedAt = Date.now();
    const outcome = await withTx(prisma, async (tx) => {
      const claimed = await tx.world.updateMany({
        where: { id: world.id, currentWeek: world.currentWeek, currentYear: world.currentYear, status: 'RUNNING' },
        data: {
          currentWeek: newWeek,
          currentYear: newYear,
          // Persist the world's shared event list (preserving any other tickConfig
          // keys, e.g. scheduledStartAt) so next week ages from it.
          tickConfig: { ...(world.tickConfig ?? {}), runtimeEvents: worldEvents },
          ...(ended ? { status: 'ENDED', endedAt: new Date() } : {}),
        },
      });
      if (claimed.count === 0) return { lostRace: true };

      await tx.tickLog.create({
        data: { worldId: world.id, week: toIndex, status: 'ok', finishedAt: new Date() },
      });

      // Version compare-and-set: never clobber a player decision that landed
      // between our read and this write. Returns whether the row was taken.
      const writeAirline = async (c) => {
        const res = await tx.airline.updateMany({
          where: { id: c.airline.id, version: c.airline.version ?? 0 },
          data: {
            // Persist without the injected rival views (rebuilt every read/tick) —
            // stops each airline's blob from storing a copy of all its rivals.
            state: stripRivals(c.next),
            cash: BigInt(c.cash),
            marketCap: BigInt(c.marketCap),
            shares: BigInt(c.shares > 0 ? c.shares : 100_000_000),
            svps: BigInt(c.svpsScore),
            week: toIndex,
            version: { increment: 1 },
            ...(c.bankrupt ? { status: 'BANKRUPT' } : {}),
          },
        });
        return res.count > 0;
      };
      const writtenRow = (c) => ({
        airlineId: c.airline.id, name: c.airline.name,
        marketCap: c.marketCap, svpsScore: c.svpsScore, isPublic: c.isPublic,
        dividend: c.dividend, consumedCreditIds: c.consumedCreditIds,
      });

      const written = [];
      const conflicted = [];
      const recomputed = [];
      for (const c of computed) {
        if (await writeAirline(c)) written.push(writtenRow(c));
        else conflicted.push(c);
      }

      // ── Recompute pass ──────────────────────────────────────────────────────
      // A lost CAS means a player's decision committed between our read and this
      // write. Losing the race is fine; what was NOT fine was the old behaviour —
      // log the airline and move on, on the theory that it "catches up next pass".
      // It does not catch up. The world clock has already advanced in this same
      // transaction, so that airline simply does not trade the week: no revenue,
      // no costs, no financialHistory row, no standings entry. The player who is
      // punished is precisely the ACTIVE one — the only way to lose the race is to
      // have been adjusting your airline in the seconds before the tick.
      //
      // So re-read the airline (its blob now carries the decision that beat us),
      // run the SAME week over it, and try the CAS again on the new version.
      // Everything the week depends on — fuel, events, rival views, valuation
      // noise (seeded on the airline id, not on its state) — is unchanged, so
      // this is the same week, merely applied to a slightly newer starting state.
      //
      // The recomputed entry REPLACES its slot in `computed`, because the gate
      // forfeiture and bankruptcy hooks after the commit read gate releases and
      // bankruptcy flags from that array — stale ones would forfeit gates the
      // player no longer loses.
      //
      // The recompute takes the ROW LOCK first (SELECT ... FOR UPDATE), because
      // the optimistic version it shipped with in July was still losable: the
      // tick's own updateMany for this airline matched ZERO rows, so nothing
      // here was locked, and the player who beat us could land ANOTHER decision
      // between the plain re-read and the second CAS. Not theoretical — it
      // happened three times in two days on Scarce Assets ("changed under the
      // tick TWICE — skipped, loses this week", 2026-08-01/02, the same heavy
      // editors each time). With the lock held, any decision arriving now
      // blocks until this transaction commits, then loses ITS version CAS and
      // returns 409 version_conflict — the path the client already retries
      // silently onto the post-tick state. The lock wait itself is bounded:
      // whoever holds the row is a decision write past its own updateMany,
      // which finishes in milliseconds.
      //
      // Deadlock note: a decision transaction acquires (gate ledger?) → its own
      // airline row → (market pool?) and never touches a row this transaction
      // holds EXCEPT that airline row, so lock ordering cannot cycle; and if
      // Postgres ever does flag a deadlock (P2034), withTx retries the whole
      // tick, whose world-clock CAS makes the retry idempotent.
      for (const stale of conflicted) {
        const id = stale.airline.id;
        try {
          await tx.$queryRaw`SELECT id FROM "Airline" WHERE id = ${id} FOR UPDATE`;
          const fresh = await tx.airline.findUnique({
            where: { id },
            include: { account: { select: { isOG: true, email: true } } },
          });
          // Gone or no longer active (bankrupt/abandoned mid-tick): nothing to write.
          if (!fresh || fresh.status !== 'ACTIVE') continue;
          const redone = computeOne(fresh);
          if (await writeAirline(redone)) {
            written.push(writtenRow(redone));
            recomputed.push(id);
            const at = computed.indexOf(stale);
            if (at >= 0) computed[at] = redone;
            log.warn?.(`[tick] world ${world.id} airline ${id} changed under the tick — recomputed and written`);
          } else {
            // With the row locked and the version read under that lock, the CAS
            // cannot lose a race — a zero-count update here is structural
            // (schema drift, deleted row) and deserves a loud log, not a retry.
            log.error(`[tick] world ${world.id} airline ${id} recompute CAS failed UNDER LOCK — skipped, loses this week (investigate)`);
          }
        } catch (err) {
          log.error(`[tick] world ${world.id} airline ${id} recompute failed — skipped, loses this week:`, err?.message ?? err);
        }
      }

      // ── Dividend settlement ─────────────────────────────────────────────
      // Both halves happen here, inside the same transaction as the blob writes,
      // and BOTH are gated on the write having landed:
      //
      //   • consume the credits an airline just collected (its blob already has
      //     the cash, via action.incomingDividends)
      //   • issue new credits for a dividend an airline just declared (its blob
      //     has already been debited the full amount)
      //
      // A skipped airline consumes nothing and issues nothing, so it simply
      // re-collects or re-pays next week. Money is conserved on every path.
      const collectedIds = written.flatMap((r) => r.consumedCreditIds ?? []);
      if (collectedIds.length > 0) {
        await tx.dividendCredit.updateMany({
          where: { id: { in: collectedIds } },
          data: { consumed: true },
        });
      }

      const newCredits = [];
      for (const r of written) {
        const div = r.dividend;
        if (!div || !(div.total > 0)) continue;
        // Holders are read from the PRE-tick blobs, matching the tick-start prices
        // the portfolio is marked against — one consistent snapshot.
        const holders = holdersOf(airlines, r.airlineId);
        const { credits } = splitDividend({
          perShare: div.perShare, totalPaid: div.total, payerId: r.airlineId, holders,
        });
        for (const cr of credits) {
          newCredits.push({
            worldId: world.id,
            airlineId: cr.airlineId,
            fromId: r.airlineId,
            fromName: r.name ?? null,
            amount: BigInt(cr.amount),
            week: toIndex,
          });
        }
        // The remainder (`toOutside`) is the slice held by outside investors and by
        // rounding: it leaves the world entirely. Deliberately NOT credited to the
        // pool — a dividend must be able to destroy money, never create it.
      }
      if (newCredits.length > 0) await tx.dividendCredit.createMany({ data: newCredits });

      // Standings rank on SVPS (per-share shareholder value), not market cap.
      // Market cap measures size, so it rewarded raising capital and punished
      // returning it — every buyback and dividend was score-negative under it.
      // Private airlines are excluded: with no traded share price they have
      // nothing comparable to rank, and they start ranking when they list.
      const ranked = [...written].filter((r) => r.isPublic)
        .sort((a, b) => b.svpsScore - a.svpsScore);
      if (ranked.length > 0) {
        await tx.standing.createMany({
          data: ranked.map((r, i) => ({
            worldId: world.id,
            airlineId: r.airlineId,
            week: toIndex,
            rank: i + 1,
            score: BigInt(r.svpsScore),
          })),
        });
      }
      // ── World news ────────────────────────────────────────────────────────
      // Written HERE, inside the week's own transaction, because none of these
      // survive anywhere else: `tickConfig.runtimeEvents` keeps only the current
      // event set, and bankruptcies and rank changes are computed and discarded.
      // Same transaction = the news can never describe a week that rolled back.
      const nameOf = new Map(airlines.map((a) => [a.id, a.name]));
      const nextTop5 = ranked.slice(0, 5).map((r) => r.airlineId);
      const writtenIds = new Set(written.map((w) => w.airlineId));
      const newsRows = [
        ...worldEventNewsRows({
          worldId: world.id, week: toIndex,
          prevEvents: prevWorldEvents, nextEvents: worldEvents,
        }),
        ...bankruptcyNewsRows({
          worldId: world.id, week: toIndex,
          bankrupt: computed
            .filter((c) => c.bankrupt && writtenIds.has(c.airline.id))
            .map((c) => ({
              airlineId: c.airline.id,
              name: c.airline.name,
              routes: (c.next.routes ?? []).length,
              fleet: (c.next.fleet ?? []).length,
            })),
        }),
        ...rankChangeNewsRows({
          worldId: world.id, week: toIndex, prevTop5, nextTop5, nameOf,
        }),
        // Gate forfeitures, for the airlines whose write actually landed. The
        // toast that used to be the only record of this is perishable; this is
        // not.
        ...gateForfeitureNewsRows({
          worldId: world.id, week: toIndex, lockoutWeeks: GATE_LOCKOUT_WEEKS, nameOf,
          releases: computed
            .filter((c) => writtenIds.has(c.airline.id))
            .flatMap((c) => c.gateReleases ?? []),
        }),
      ];
      if (newsRows.length > 0) await tx.worldNews.createMany({ data: newsRows });

      // Retention sweep: news older than the readable window is unreachable, so
      // there is no reason to keep paying to store it. Player moves (Decision)
      // are NOT swept — rival profiles and audit depend on them.
      await tx.worldNews.deleteMany({
        where: { worldId: world.id, week: { lt: toIndex - NEWS_WINDOW_WEEKS } },
      });

      // `ranked` rides out of the transaction because the career snapshot runs
      // AFTER the commit and cannot recompute the final order from anything
      // else — Standing rows exist, but re-reading them would be a query to
      // re-derive something this scope already holds.
      return { lostRace: false, airlines: written.length, written, ranked, recomputed: recomputed.length };
    }, {
      ...TICK_TX_OPTS,
      // No client is waiting on the worker, so the player-request deadline in
      // lib/tx.mjs must not clamp the tick's 30s budget.
      deadlineMs: null,
      // The world-clock advance at the top is a compare-and-set, so a retried tick
      // that lost a deadlock re-claims the same week or bails as `lostRace` — never
      // double-advances. One retry is enough to ride out a colliding player write.
      retries: 1,
      onRetry: ({ attempt, code }) =>
        log.warn?.(`[tick] world ${world.id} transaction retry ${attempt} (${code ?? 'transient'})`),
    });

    if (outcome.lostRace) return { ok: false, reason: 'lost-race' };

    log.info?.(
      `[tick] ${world.name ?? world.id} week ${toIndex}: committed in ${Date.now() - commitStartedAt}ms `
      + `(${outcome.airlines} airline(s)${outcome.recomputed ? `, ${outcome.recomputed} recomputed` : ''})`,
    );

    // ── Float pool refill ───────────────────────────────────────────────────
    // Heals POOL_REFILL_PER_YEAR of the pool's seed per game year (spread weekly),
    // never above the seed — so the pool is a revolving facility, not a growing
    // faucet, and total lifetime injection into a world stays bounded.
    // Best-effort: a failed refill must never roll back the week.
    await refillWorldMarket(prisma, world.id, { log });

    // ── Gate scarcity post-commit hooks ─────────────────────────────────────
    // Best-effort (CAS-retried inside): a failure here must never roll back the
    // week — tools/reconcile-gates.mjs can repair any drift from blobs.
    if (isGateScarcity(world)) {
      try {
        const writtenIds = new Set((outcome.written ?? []).map((w) => w.airlineId));
        const releases = computed
          .filter((c) => writtenIds.has(c.airline.id))
          .flatMap((c) => c.gateReleases ?? []);
        if (releases.length > 0) await reconcileForfeitures(prisma, world.id, releases, { log });
        // Bankrupt airlines' gates used to be released back to the pool here,
        // in silence — the entire consequence of a carrier failing. They are
        // now listed as administrator's sales instead (see fireSaleService),
        // which is handled below for EVERY world rather than only scarcity
        // ones, so nothing is released here any more.
        const tickedWorld = { ...world, currentWeek: newWeek, currentYear: newYear };
        if (newWeek === GATE_AUCTION_OPEN_WEEK) await openDueAuctions(prisma, tickedWorld, { log });
        if (newWeek === 1 && toIndex > 1) await resolveDueAuctions(prisma, tickedWorld, { log });
      } catch (err) {
        log.error(`[tick] world ${world.id} gate hooks failed (week still committed):`, err?.message ?? err);
      }
    }

    // ── A season's result, banked ────────────────────────────────────────────
    // The final tick used to flip `status: 'ENDED'` and stop. Seven real months
    // of play left no trace on the account that played them, which is why the
    // only cross-world distinction anyone had was an admin-granted badge.
    //
    // Post-commit and best-effort, like everything else down here: the tick
    // transaction already holds row locks on every airline in the world for up
    // to thirty seconds, and a hall-of-fame entry is not worth a millisecond of
    // that — nor worth rolling back a committed week if it fails. Re-running it
    // is harmless by construction (see lib/career.mjs).
    if (ended) {
      try {
        await snapshotWorldCareers(prisma, { ...world, status: 'ENDED', endedAt: new Date() }, {
          weekIndex: toIndex,
          ranked: outcome.ranked ?? [],
          // Lifetime passengers come from states already in memory. Reading
          // forty half-megabyte blobs back out to count them would cost more
          // than the whole week's commit.
          passengersById: passengerTotalsFrom(computed),
          log,
        });
      } catch (err) {
        log.error(`[tick] world ${world.id} career snapshot failed (world still ENDED):`, err?.message ?? err);
      }
    }

    // ── Administration ───────────────────────────────────────────────────────
    // An airline that failed this week has an estate. Its owned fleet goes to
    // the used market at a distressed price and, on scarcity worlds, its gates
    // are listed with no seller. Post-commit and best-effort: a failure here
    // leaves a bankruptcy exactly as uneventful as it used to be, never a
    // rolled-back week.
    try {
      const writtenIds = new Set((outcome.written ?? []).map((w) => w.airlineId));
      const failed = computed.filter((c) => c.bankrupt && writtenIds.has(c.airline.id));
      for (const c of failed) {
        await fireSaleAirline(prisma, {
          world,
          airline: { id: c.airline.id, name: c.airline.name, fleet: c.next.fleet ?? [] },
          weekIndex: toIndex,
          log,
        });
      }
    } catch (err) {
      log.error(`[tick] world ${world.id} fire sale failed (week still committed):`, err?.message ?? err);
    }

    // Codeshare offers nobody answered. Unanswered proposals are not just
    // clutter: the unique constraint that stops duplicates also stops the same
    // pair ever offering again while a dead row sits between them.
    try {
      const expired = await expireStaleOffers(prisma, world.id, toIndex);
      if (expired > 0) log.info?.(`[tick] world ${world.id} expired ${expired} stale codeshare offer(s)`);
    } catch (err) {
      log.error(`[tick] world ${world.id} codeshare sweep failed (week still committed):`, err?.message ?? err);
    }

    // Used-aircraft market: scrap listings unsold for 2 game-years (best-effort;
    // never rolls back the committed week).
    try {
      const scrapped = await scrapStale(prisma, world.id, toIndex);
      if (scrapped > 0) log.info?.('[tick] world ' + world.id + ' scrapped ' + scrapped + ' stale used-aircraft listing(s)');
    } catch (err) {
      log.error('[tick] world ' + world.id + ' used-market scrap failed (week still committed):', err?.message ?? err);
    }

    // Return the new shared event list so a multi-week catch-up ages events from
    // week to week (the in-memory `world` is threaded forward in runDueTicks).
    return { ok: true, week: newWeek, year: newYear, ended, airlines: outcome.airlines, worldEvents };
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
        world = {
          ...world,
          currentWeek: res.week,
          currentYear: res.year,
          status: res.ended ? 'ENDED' : 'RUNNING',
          // Carry the just-persisted shared event list forward so the next
          // catch-up week ages from it instead of re-rolling the stale list.
          tickConfig: { ...(world.tickConfig ?? {}), runtimeEvents: res.worldEvents ?? world.tickConfig?.runtimeEvents ?? [] },
        };
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
