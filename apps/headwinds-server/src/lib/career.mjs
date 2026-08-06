// ─────────────────────────────────────────────────────────────────────────────
// CAREER — what survives a world ending
//
// A Headwinds season runs about seven real months and then stops. Until now it
// stopped completely: the final tick flipped the world to ENDED and that was
// the last anyone heard of it. Four seasons of play, a championship, a million
// passengers carried — none of it followed the account into the next world. The
// only cross-world distinction that existed was the admin-granted OG badge.
//
// Season games live on meta-progression, and it is also the only answer anyone
// has for the airline that is already #1 with three months to go.
//
// This module is the shape of that record and the rules for reading it. The
// storage was already waiting: `Account.careerStats Json @default("{}")` has
// been in the schema since the first migration and nothing has ever written to
// it.
//
// ── One design rule, and everything else follows ────────────────────────────
// TOTALS ARE DERIVED, NEVER ACCUMULATED. Every figure below is recomputed from
// the per-world map on every write. That makes the snapshot idempotent: a
// retried tick, a manual re-run, or the backfill script visiting a world twice
// all produce exactly the same record instead of double-counting a season. An
// incrementing counter would have been one line shorter and impossible to
// repair.
// ─────────────────────────────────────────────────────────────────────────────

export const CAREER_VERSION = 1;

/** Ranks that count as a podium finish. */
export const PODIUM_RANK = 3;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * One finished world, from the account's point of view.
 *
 * @param {object} row
 * @returns {object} the stored per-world record
 */
export function worldRecord(row) {
  return {
    worldId:     row.worldId,
    worldName:   row.worldName ?? null,
    lengthYears: num(row.lengthYears) || null,
    endedAt:     row.endedAt ?? null,
    airlineId:   row.airlineId,
    airlineName: row.airlineName ?? null,
    hub:         row.hub ?? null,
    // Final standing. Null for a private airline — with no traded share price
    // there is nothing to rank it against, which is not the same as last place.
    rank:        row.rank == null ? null : num(row.rank),
    of:          num(row.of) || null,
    bestRank:    row.bestRank == null ? null : num(row.bestRank),
    svps:        num(row.svps),
    marketCap:   num(row.marketCap),
    status:      row.status ?? null,
    restarts:    num(row.restarts),
    passengers:  num(row.passengers),
    weeksPlayed: num(row.weeksPlayed),
  };
}

/**
 * Everything the account has to show for itself, recomputed from scratch.
 *
 * @param {Record<string, object>} worlds  worldId → worldRecord
 */
export function careerTotals(worlds = {}) {
  const list = Object.values(worlds ?? {});
  let championships = 0, podiums = 0, bankruptcies = 0, refoundings = 0;
  let passengers = 0, weeks = 0;
  let bestFinish = null;

  for (const w of list) {
    if (w?.rank === 1) championships += 1;
    if (w?.rank != null && w.rank <= PODIUM_RANK) podiums += 1;
    if (w?.status === 'BANKRUPT') bankruptcies += 1;
    refoundings += num(w?.restarts);
    passengers  += num(w?.passengers);
    weeks       += num(w?.weeksPlayed);
    // A private airline never ranked, so it cannot improve — or spoil — a best
    // finish. Only ranked seasons are eligible.
    if (w?.rank != null && (bestFinish == null || w.rank < bestFinish)) bestFinish = w.rank;
  }

  return {
    worldsFinished: list.length,
    championships,
    podiums,
    bestFinish,
    bankruptcies,
    refoundings,
    lifetimePassengers: passengers,
    weeksPlayed: weeks,
  };
}

// ── Badges ───────────────────────────────────────────────────────────────────
// DERIVED at read time, not stored. The one badge that exists today (`isOG`) is
// a column an admin flips, and it propagates through six separate `include:
// { account }` joins — one of them a raw-SQL/JS twin pair that has to stay
// byte-identical. Earned badges do not need any of that: they are a pure
// function of totals the account already carries, so the rule can change
// without a migration and without a backfill, and the server and the client
// can never disagree about who has one.

export const CAREER_BADGES = [
  {
    id: 'champion',
    label: 'Champion',
    icon: '🏆',
    describe: (t) => t.championships > 1 ? `Won ${t.championships} seasons` : 'Won a season',
    earned: (t) => t.championships >= 1,
  },
  {
    id: 'podium',
    label: 'Podium',
    icon: '🥉',
    describe: (t) => `Top three in ${t.podiums} season${t.podiums === 1 ? '' : 's'}`,
    earned: (t) => t.podiums >= 1,
  },
  {
    id: 'veteran',
    label: 'Veteran',
    icon: '🎖',
    describe: (t) => `Finished ${t.worldsFinished} seasons`,
    earned: (t) => t.worldsFinished >= 3,
  },
  {
    id: 'million-pax',
    label: 'Million flyer',
    icon: '👥',
    describe: (t) => `${Math.round(t.lifetimePassengers / 1e6)}M passengers carried`,
    earned: (t) => t.lifetimePassengers >= 1_000_000,
  },
  {
    id: 'phoenix',
    label: 'Phoenix',
    icon: '🔥',
    // Going bankrupt and coming back to finish the season is the best story a
    // persistent world produces, and nothing has ever marked it.
    describe: () => 'Re-founded an airline and saw the season out',
    earned: (t) => t.refoundings >= 1 && t.worldsFinished >= 1,
  },
];

/** @returns {{id,label,icon,description}[]} */
export function careerBadges(totals) {
  const t = totals ?? careerTotals({});
  return CAREER_BADGES
    .filter((b) => { try { return !!b.earned(t); } catch { return false; } })
    .map((b) => ({ id: b.id, label: b.label, icon: b.icon, description: b.describe(t) }));
}

// ── The stored blob ──────────────────────────────────────────────────────────

/** An account that has never finished a season. */
export function emptyCareer() {
  return { v: CAREER_VERSION, worlds: {}, totals: careerTotals({}) };
}

/** Tolerant read — the column defaults to `{}` and predates any writer. */
export function normalizeCareer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCareer();
  const worlds = (raw.worlds && typeof raw.worlds === 'object' && !Array.isArray(raw.worlds))
    ? raw.worlds : {};
  return { v: CAREER_VERSION, worlds, totals: careerTotals(worlds) };
}

/**
 * Fold one finished world into an account's career.
 *
 * Keyed by world id and idempotent by construction: writing the same season
 * twice replaces its entry and recomputes the totals, so nothing can be
 * double-counted no matter how many times a retry or a backfill runs.
 */
export function withWorldRecord(raw, record) {
  const career = normalizeCareer(raw);
  const rec = worldRecord(record);
  if (!rec.worldId) return career;
  const worlds = { ...career.worlds, [rec.worldId]: rec };
  return { v: CAREER_VERSION, worlds, totals: careerTotals(worlds) };
}

/** Has this account already banked this season? */
export function hasWorldRecord(raw, worldId) {
  return !!normalizeCareer(raw).worlds[worldId];
}

/** Read shape for /me and the profile screen — newest season first. */
export function serializeCareer(raw) {
  const career = normalizeCareer(raw);
  const worlds = Object.values(career.worlds).sort((a, b) => {
    const ta = a.endedAt ? Date.parse(a.endedAt) : 0;
    const tb = b.endedAt ? Date.parse(b.endedAt) : 0;
    return tb - ta;
  });
  return { totals: career.totals, badges: careerBadges(career.totals), worlds };
}

/**
 * Lifetime passengers from an airline's own KPI series.
 *
 * `statsHistory` is capped at 260 entries in multiplayer, which is exactly a
 * five-year season — so for a standard world this is the whole life of the
 * airline. A longer world silently loses its earliest weeks, which is the right
 * trade against reading every 500 kB blob back out of the database to count
 * them.
 */
export function passengersFromState(state) {
  const stats = Array.isArray(state?.statsHistory) ? state.statsHistory : [];
  let total = 0;
  for (const s of stats) {
    total += num(s?.paxOrganic) + num(s?.paxConnecting) + num(s?.paxInterline);
  }
  if (total > 0) return Math.round(total);
  // Old saves predate statsHistory. financialHistory only keeps 52 weeks, so
  // this undercounts — but an undercount beats a zero for an airline that
  // demonstrably flew.
  const fin = Array.isArray(state?.financialHistory) ? state.financialHistory : [];
  return Math.round(fin.reduce((t, h) => t + num(h?.passengers), 0));
}
