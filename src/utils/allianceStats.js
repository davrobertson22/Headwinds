// ─────────────────────────────────────────────────────────────────────────────
// ALLIANCE ARITHMETIC
//
// The server already computes an alliance graph every tick, and every member's
// full route map arrives on the client inside `state.competitors`. What was
// missing was anyone doing the sums: an alliance was a list of names and a
// benefits sentence. You could not see the bloc's combined network, which
// airports it reached that you did not, or where two members were flying the
// same pair against each other.
//
// All of it is one pass over data the client already holds, which is why this
// is a pure function file with no fetching in it.
// ─────────────────────────────────────────────────────────────────────────────

/** Pair key, matching the engine's `pairKeyOf` (sorted, hyphen-joined). */
export const pairKey = (a, b) => [a, b].sort().join('-');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Every airport a set of routes touches. */
export function servedAirportsOf(routes = []) {
  const set = new Set();
  for (const r of routes ?? []) {
    if (r?.origin) set.add(r.origin);
    if (r?.destination) set.add(r.destination);
    for (const s of r?.stops ?? []) if (s) set.add(s);
  }
  return set;
}

/** …and every pair they fly. */
export function servedPairsOf(routes = []) {
  const set = new Set();
  for (const r of routes ?? []) {
    if (r?.origin && r?.destination) set.add(pairKey(r.origin, r.destination));
  }
  return set;
}

/**
 * One member's contribution, read off the competitor object the server ships.
 * A partner's `routes` / `cargoRoutes` are keyed by pair, so both fold into one
 * loop — which is exactly why the server keys them that way.
 */
export function memberProfile(comp) {
  const pairs = new Set([
    ...Object.keys(comp?.routes ?? {}),
    ...Object.keys(comp?.cargoRoutes ?? {}),
  ]);
  const airports = new Set();
  let departures = 0;
  for (const key of pairs) {
    const [a, b] = key.split('-');
    if (a) airports.add(a);
    if (b) airports.add(b);
    departures += num(comp?.routes?.[key]?.frequency) + num(comp?.cargoRoutes?.[key]?.frequency);
  }
  const profits = Array.isArray(comp?.profitHistory) ? comp.profitHistory.map(num) : [];
  return {
    id:   comp?.id,
    name: comp?.name ?? 'Unknown',
    hub:  comp?.homeHub ?? null,
    human: !!comp?.human,
    og: !!comp?.og,
    tier: comp?.tier ?? 'legacy',
    logoId: comp?.logoId ?? null,
    quality: num(comp?.baseQualityScore),
    marketCap: num(comp?.marketCap),
    cash: num(comp?.cash),
    weeklyRevenue: num(comp?.weeklyStats?.weeklyRevenue),
    weeklyProfit:  num(comp?.weeklyStats?.weeklyProfit),
    positioning: comp?.positioning ?? null,
    pairs,
    airports,
    departures,
    // Recent form, so a member that is quietly collapsing is visible as one.
    profitTrend: profits.length >= 2 ? profits.at(-1) - profits.at(-2) : null,
  };
}

/**
 * The bloc, from the viewer's seat.
 *
 * @param {object[]} members  competitor objects for the OTHER members
 * @param {object}   you      { routes, cargoRoutes, marketCap, cash, name, hub }
 * @returns {object}
 */
export function buildAllianceStats(members = [], you = {}) {
  const profiles = (members ?? []).filter(Boolean).map(memberProfile);

  const yourPairs = new Set([
    ...servedPairsOf(you?.routes ?? []),
    ...servedPairsOf(you?.cargoRoutes ?? []),
  ]);
  const yourAirports = new Set([
    ...servedAirportsOf(you?.routes ?? []),
    ...servedAirportsOf(you?.cargoRoutes ?? []),
  ]);

  // Union across the whole bloc, you included.
  const blocPairs    = new Set(yourPairs);
  const blocAirports = new Set(yourAirports);
  let blocDepartures = 0;
  let blocMarketCap  = num(you?.marketCap);
  let blocCash       = num(you?.cash);
  let blocRevenue    = num(you?.weeklyRevenue);

  // Airports a PARTNER reaches and you do not: the connecting traffic the
  // alliance is actually buying you.
  const reachAdded = new Map();     // code → [member names]
  // Pairs flown by more than one member: the bloc competing with itself.
  const overlap    = new Map();     // pairKey → [member names]

  for (const p of profiles) {
    blocDepartures += p.departures;
    blocMarketCap  += p.marketCap;
    blocCash       += p.cash;
    blocRevenue    += p.weeklyRevenue;
    for (const code of p.airports) {
      blocAirports.add(code);
      if (!yourAirports.has(code)) {
        if (!reachAdded.has(code)) reachAdded.set(code, []);
        reachAdded.get(code).push(p.name);
      }
    }
    for (const key of p.pairs) {
      blocPairs.add(key);
      if (yourPairs.has(key)) {
        if (!overlap.has(key)) overlap.set(key, []);
        overlap.get(key).push(p.name);
      }
    }
  }

  // Pairs where a partner also flies — the routes your demand boost applies to.
  const boostedPairs = [...overlap.keys()];

  return {
    memberCount: profiles.length + 1,      // partners plus you
    members: profiles.sort((a, b) => b.marketCap - a.marketCap),
    blocMarketCap,
    blocCash,
    blocWeeklyRevenue: blocRevenue,
    blocDepartures,
    blocAirports: blocAirports.size,
    blocPairs: blocPairs.size,
    yourAirports: yourAirports.size,
    yourPairs: yourPairs.size,
    // Sorted so the biggest additions to your map surface first.
    reachAdded: [...reachAdded.entries()]
      .map(([code, names]) => ({ code, names }))
      .sort((a, b) => b.names.length - a.names.length || a.code.localeCompare(b.code)),
    overlap: [...overlap.entries()]
      .map(([key, names]) => ({ pair: key, names }))
      .sort((a, b) => b.names.length - a.names.length || a.pair.localeCompare(b.pair)),
    boostedPairs,
  };
}

/**
 * What the alliance is actually earning you this week.
 *
 * Prefers the engine's own figure from `lastReport` — the O&D-prorated number
 * that went through the P&L. The Alliances tab used to show an estimate from
 * the legacy flat per-adjacent-route model instead, which the tick stopped
 * using when partnership revenue moved to O&D proration: the KPI and the P&L
 * have disagreed ever since, on the same screen.
 *
 * @returns {{ revenue:number, fees:number, net:number, estimated:boolean }}
 */
export function partnershipActuals(state, estimate = 0, feesEstimate = 0) {
  const r = state?.lastReport;
  if (r && r.totalPartnerRevenue != null) {
    const revenue = num(r.totalPartnerRevenue);
    const fees    = num(r.totalPartnerFees);
    return { revenue, fees, net: revenue - fees, estimated: false };
  }
  return { revenue: num(estimate), fees: num(feesEstimate), net: num(estimate) - num(feesEstimate), estimated: true };
}
