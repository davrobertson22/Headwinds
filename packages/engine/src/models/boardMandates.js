// Board mandates — a fresh goal every quarter (docs/game-audit-2026-11-06.md F2).
//
// WHY. The multiplayer starter board is ten objectives that retire themselves
// once met; after that, ranks 6–40 had nothing framing the next fifty hours
// but the title race they are not in. A real board sets the airline a target
// every quarter. Demand model v4 worlds (and solo games on v4) do too.
//
// WHAT. At the start of each game quarter the board issues ONE mandate, chosen
// for this airline from where it stands (so it is never already met), to be
// hit in any week before the quarter ends: grow passengers, lift the margin,
// fill the aircraft, please the passengers, reach a new country or open new
// routes. Hitting it pays a flat board bonus — flat on purpose, so it matters
// most to the airlines furthest behind. Missing it costs nothing but the bonus.
// Deterministic (no random draw): the pick is a hash of the airline and the
// quarter, so a retried tick issues the same mandate.

export const MANDATE = {
  quarterWeeks: 13,
  firstQuarter: 2,          // nothing in the first quarter — the starter board has it
  reward: 1_500_000,
  historyCap: 8,
};

// Network load factor exactly as the Dashboard tile prints it (networkStatsOf):
// passengers over seats across the nonstop routes, so a 400-seat trunk counts
// for more than a 50-seat spoke and a tag rotation's seat-legs stay out. It
// used to be a plain average of every route's own load factor, so the tile
// could show the target met while the mandate stayed open (audit 2026-11-09).
const lf = (report) => {
  let pax = 0, seats = 0;
  for (const r of report?.routeResults ?? []) {
    if (!r || r.tag || r.configuredSeatsOneWay == null) continue;
    pax += r.passengers ?? 0;
    seats += r.configuredSeatsOneWay ?? 0;
  }
  return seats > 0 ? pax / seats : 0;
};
const margin = (report) => {
  const rev = Number(report?.totalRevenue) || 0;
  return rev > 0 ? (rev - (Number(report?.totalCost) || 0)) / rev : -1;
};
const countries = (routes, getCountry) => {
  const set = new Set();
  for (const r of routes ?? []) for (const c of [r.origin, r.destination]) { const k = getCountry(c); if (k) set.add(k); }
  return set.size;
};

/** The mandate kinds: how to set the target from today, and how to test it. */
export const MANDATE_KINDS = {
  pax_growth: {
    icon: '👥',
    title: 'Grow the traffic',
    target: (s) => Math.max(100, Math.round((Number(s.report?.totalPassengers) || 0) * 1.10)),
    desc: (t) => `Fly ${t.toLocaleString('en-US')} passengers in a week`,
    met: (s, t) => (Number(s.report?.totalPassengers) || 0) >= t,
  },
  margin: {
    icon: '📈',
    title: 'Widen the margin',
    target: (s) => +Math.min(0.25, Math.max(0.08, margin(s.report) + 0.03)).toFixed(3),
    desc: (t) => `Post a ${Math.round(t * 100)}% operating margin in a week`,
    met: (s, t) => margin(s.report) >= t,
  },
  load_factor: {
    icon: '💺',
    title: 'Fill the aircraft',
    target: (s) => +Math.min(0.92, Math.max(0.80, lf(s.report) + 0.03)).toFixed(3),
    desc: (t) => `Average a ${Math.round(t * 100)}% load factor across your routes in a week`,
    met: (s, t) => lf(s.report) >= t,
  },
  satisfaction: {
    icon: '😊',
    title: 'Win back the passengers',
    target: (s) => Math.round(Math.min(92, Math.max(75, (Number(s.satisfaction) || 0) + 3))),
    desc: (t) => `Lift passenger satisfaction to ${t}`,
    met: (s, t) => (Number(s.satisfaction) || 0) >= t,
  },
  new_country: {
    icon: '🌍',
    title: 'Plant a new flag',
    target: (s) => countries(s.routes, s.getCountry) + 1,
    desc: (t) => `Serve ${t} countries`,
    met: (s, t) => countries(s.routes, s.getCountry) >= t,
  },
  new_routes: {
    icon: '🧭',
    title: 'Open new markets',
    target: (s) => (s.routes?.length ?? 0) + 2,
    desc: (t) => `Fly ${t} routes`,
    met: (s, t) => (s.routes?.length ?? 0) >= t,
  },
};
const ORDER = Object.keys(MANDATE_KINDS);

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Quarter number (1-based) of an absolute week. */
export const quarterOf = (absWeek) => Math.floor((Math.max(1, absWeek) - 1) / MANDATE.quarterWeeks) + 1;

/**
 * Issue this quarter's mandate. `snap` = { report, routes, satisfaction,
 * getCountry, airlineName }. Returns null in the first quarter.
 */
export function issueMandate(snap, absWeek, rewardScale = 1) {
  const q = quarterOf(absWeek);
  if (q < MANDATE.firstQuarter) return null;
  const start = hash(`${snap.airlineName ?? ''}|${q}`) % ORDER.length;
  for (let i = 0; i < ORDER.length; i++) {
    const kind = ORDER[(start + i) % ORDER.length];
    const k = MANDATE_KINDS[kind];
    const target = k.target(snap);
    if (k.met(snap, target)) continue;           // never hand out a goal already met
    return {
      kind, target, quarter: q,
      endAbsWeek: q * MANDATE.quarterWeeks,
      reward: Math.round(MANDATE.reward * rewardScale),
      status: 'open',
    };
  }
  return null;
}

/** Whether an open mandate is met by this week's snapshot. */
export function mandateMet(mandate, snap) {
  const k = MANDATE_KINDS[mandate?.kind];
  return !!(k && mandate.status === 'open' && k.met(snap, mandate.target));
}

/** "Fly 12,400 passengers in a week" — card and toast copy. */
export function mandateDesc(mandate) {
  const k = MANDATE_KINDS[mandate?.kind];
  return k ? k.desc(mandate.target) : '';
}
export function mandateTitle(mandate) { return MANDATE_KINDS[mandate?.kind]?.title ?? 'Board mandate'; }
export function mandateIcon(mandate) { return MANDATE_KINDS[mandate?.kind]?.icon ?? '🎯'; }
