// Season awards — the end-of-world ceremony's data.
//
// A ~7-real-month season used to end with `status: 'ENDED'` and nothing else.
// This computes the honours roll from data the final tick already holds in
// memory (the ranked order, each airline's next state, the lifetime-passenger
// map) plus ONE cheap Standing scan for the weeks-at-#1 tenure. It is a pure
// function so it can be unit-tested without a database and so the tick can call
// it post-commit, best-effort, without widening the transaction.
//
// The result is stashed verbatim in a tier-1 `world_ended` WorldNews row
// (category 'world', or the feed never reads it) and served back to the
// end-of-season screen and the lobby hall of fame. No new table, no migration:
// an ENDED world never ticks again, so its news is never swept.

/** SVPS is stored as an integer score; standings show dollars = score / 1e4. */
const SVPS_SCALE = 10_000;
const toDollars = (score) => (Number(score) || 0) / SVPS_SCALE;

/**
 * @param {object}  opts
 * @param {Array<{airlineId,name,svpsScore,isPublic}>} opts.ranked  final order, best-first (public only)
 * @param {Array<{airline:{id,name,accountId,restarts},next:{routes,fleet}}>} opts.computed  per-airline final state
 * @param {Map<string,number>} opts.passengersById  lifetime passengers by airlineId
 * @param {Map<string,number>} opts.tenureById      weeks held at rank #1 by airlineId
 * @param {number} [opts.lengthYears]
 * @param {number} [opts.podiumSize=3]
 * @returns {{championId,championName,championAccountId,finishers,lengthYears,podium,awards}|null}
 */
export function computeSeasonAwards({
  ranked = [], computed = [], passengersById = new Map(),
  tenureById = new Map(), lengthYears = null, podiumSize = 3,
} = {}) {
  const finishers = ranked.filter((r) => r.isPublic !== false);
  if (finishers.length === 0) return null;

  // Enrich every finisher with the extra facts the awards need. `computed` is
  // keyed by the live airline row, so it carries accountId, restarts and the
  // route/fleet arrays; `ranked` carries the final placement and name.
  const byId = new Map(computed.map((c) => [c?.airline?.id, c]));
  const rows = finishers.map((r, i) => {
    const c = byId.get(r.airlineId);
    return {
      rank: i + 1,
      airlineId: r.airlineId,
      accountId: c?.airline?.accountId ?? null,
      name: r.name ?? c?.airline?.name ?? 'An airline',
      svps: toDollars(r.svpsScore),
      passengers: Math.round(passengersById.get(r.airlineId) ?? 0),
      routes: (c?.next?.routes ?? []).length,
      fleet: (c?.next?.fleet ?? []).length,
      restarts: Number(c?.airline?.restarts ?? 0) || 0,
      tenure: Number(tenureById.get(r.airlineId) ?? 0) || 0,
    };
  });

  const podium = rows.slice(0, podiumSize).map((r) => ({
    rank: r.rank, airlineId: r.airlineId, accountId: r.accountId, name: r.name, svps: r.svps,
  }));

  // ── Superlative awards ─────────────────────────────────────────────────────
  // Each celebrates a different way to play, so a champion does not necessarily
  // sweep them. A winner is only named when the metric is meaningfully non-zero
  // (nobody wins "biggest network" in a world where no one flew).
  const awards = [];
  const winnerBy = (score) => rows.reduce(
    (best, r) => (best == null || score(r) > score(best) ? r : best), null);
  const push = (id, icon, label, r, detail) => {
    if (r) awards.push({ id, icon, label, airlineId: r.airlineId, accountId: r.accountId, name: r.name, detail });
  };

  const throne = winnerBy((r) => r.tenure);
  if (throne && throne.tenure > 0) {
    push('iron_throne', '👑', 'Iron Throne', throne,
      `Held #1 for ${throne.tenure} week${throne.tenure === 1 ? '' : 's'}`);
  }
  const busiest = winnerBy((r) => r.passengers);
  if (busiest && busiest.passengers > 0) {
    push('busiest', '👥', 'Busiest Airline', busiest,
      `Carried ${busiest.passengers.toLocaleString('en-US')} passengers`);
  }
  const biggest = winnerBy((r) => r.routes * 1000 + r.fleet); // routes first, fleet breaks ties
  if (biggest && biggest.routes > 0) {
    push('biggest_network', '🗺️', 'Biggest Network', biggest,
      `${biggest.routes} route${biggest.routes === 1 ? '' : 's'}, ${biggest.fleet} aircraft`);
  }
  // Best comeback: the highest-finishing airline that was re-founded at least
  // once. `rows` is already best-first, so the first refounder is the answer.
  const comeback = rows.find((r) => r.restarts > 0);
  if (comeback) {
    push('best_comeback', '🔁', 'Best Comeback', comeback,
      `Re-founded and finished #${comeback.rank} of ${rows.length}`);
  }

  const champ = podium[0];
  return {
    championId: champ.airlineId,
    championName: champ.name,
    championAccountId: champ.accountId,
    finishers: rows.length,
    lengthYears: lengthYears ?? null,
    podium,
    awards,
  };
}
