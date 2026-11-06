// Earned pricing headroom — demand model v4 (docs/game-audit-2026-11-06.md R2).
//
// WHY. Restricted (NWR) worlds put an exponential yield choke on any fare above
// ~1.10x reference (utils/market.js nwrYieldChokeFactor). It stands in for the
// rival who would undercut a monopoly, and it worked as a WALL: on a route
// nobody else flew, a 40% premium lost 82% of the passengers, so the best fare
// was always at or under reference and a protected market or a fortress hub
// bought no pricing power at all (a fortress's +2 quality was invisible next
// to the cliff). In a multiplayer world the undercutting rival is real, so the
// synthetic one should only bite where a real one could plausibly turn up.
//
// WHAT. In demand model v4 the choke threshold rises by the headroom an airline
// has EARNED on the pair, and falls off less steeply past it
// (NWR_CHOKE_STEEPNESS_V4). Two things earn it, the two real airlines use:
//   • a protected market: nobody else flies the pair AND no rival airline flies
//     to both of its airports — there is no credible entrant who could open it
//     next week. A rival present at both ends takes this away whether or not
//     it flies the pair yet;
//   • hub strength: your own hub at either end, scaled by tier — a fortress
//     sells at a premium (focus city +2 pts, hub +4, major hub +6, gateway +8).
// Quality keeps its own headroom (nwrChokeThreshold) on top. Contested pairs
// only ever get the hub term, for every carrier on them alike.
//
// Pure functions of a state blob. weeklyTick, the pairShare previews, Route
// Detail, the fare-cliff warnings and the server's rival specs all read these,
// so a preview cannot quote a cliff the tick will not apply.

export const PRICING_HEADROOM = {
  protectedMarket: 0.10,
  hubByTier: { 0: 0.02, 1: 0.04, 2: 0.06, 3: 0.08 },
  max: 0.18,
};

/** Demand model v4 in a restricted world — the only place headroom exists. */
export function pricingHeadroomWorld(state) {
  return (Number(state?.demandModel) || 1) >= 4 && state?.newWorldRestrictions === true;
}

function hubsOf(state) {
  return state?.hubs ?? (state?.hub ? { [state.hub]: { tier: 1 } } : {});
}

/** The hub term: the stronger of the airline's hubs at either endpoint. */
export function hubHeadroom(state, origin, destination) {
  const hubs = hubsOf(state);
  let best = 0;
  for (const code of [origin, destination]) {
    const h = hubs[code];
    if (!h) continue;
    const v = PRICING_HEADROOM.hubByTier[h.tier ?? 1] ?? 0;
    if (v > best) best = v;
  }
  return best;
}

const _stationMemo = new WeakMap();

/**
 * Airports each rival airline serves, from the rival data the state carries:
 * Map<airport, Set<rivalId>>. Multiplayer: state.humanRivals is keyed by EVERY
 * pair any rival flies ("AAA-BBB"), each with that pair's rival specs. Solo:
 * state.competitors[].routes keyed the same way.
 */
export function rivalStations(state) {
  const hr = state?.humanRivals ?? null;
  const comps = state?.competitors ?? null;
  const memoKey = hr ?? comps;
  if (memoKey && typeof memoKey === 'object') {
    const hit = _stationMemo.get(memoKey);
    if (hit && hit.comps === comps && hit.hr === hr) return hit.index;
  }
  const index = new Map();
  const add = (code, id) => {
    if (!code) return;
    let set = index.get(code);
    if (!set) { set = new Set(); index.set(code, set); }
    set.add(id);
  };
  for (const [key, specs] of Object.entries(hr ?? {})) {
    const [a, b] = key.split('-');
    for (const spec of specs ?? []) {
      const id = spec?.competitorId ?? spec?.airlineId ?? spec?.name ?? key;
      add(a, id); add(b, id);
    }
  }
  for (const c of comps ?? []) {
    if (!c || c.bankrupt) continue;
    for (const key of Object.keys(c.routes ?? {})) {
      const [a, b] = key.split('-');
      add(a, c.id); add(b, c.id);
    }
  }
  if (memoKey && typeof memoKey === 'object') _stationMemo.set(memoKey, { comps, hr, index });
  return index;
}

/** Whether some rival airline already flies to both of the pair's airports. */
export function credibleEntrant(state, origin, destination) {
  const idx = rivalStations(state);
  const a = idx.get(origin), b = idx.get(destination);
  if (!a || !b) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (big.has(id)) return true;
  return false;
}

/** Whether any rival flies the pair itself (nonstop). */
function rivalFliesPair(state, origin, destination) {
  const key = [origin, destination].sort().join('-');
  if ((state?.humanRivals?.[key] ?? []).length > 0) return true;
  for (const c of state?.competitors ?? []) {
    if (!c || c.bankrupt) continue;
    if (c.routes?.[key]) return true;
  }
  return false;
}

/**
 * The pricing headroom this airline has earned on a pair (added to the choke
 * threshold, as a fraction of reference). 0 outside demand model v4 / NWR.
 * `{ contested }` forces the contested reading (hub term only) — the rival-spec
 * path uses it, since a rival's offer only exists on a pair someone else flies.
 */
export function pricingHeadroomFor(state, origin, destination, { contested = null } = {}) {
  if (!pricingHeadroomWorld(state)) return 0;
  let h = hubHeadroom(state, origin, destination);
  const isContested = contested ?? rivalFliesPair(state, origin, destination);
  if (!isContested && !credibleEntrant(state, origin, destination)) h += PRICING_HEADROOM.protectedMarket;
  return Math.min(PRICING_HEADROOM.max, +h.toFixed(4));
}

/**
 * The pricing offer field for a pair, resolved from STATE. Returns {} outside
 * demand model v4 / NWR or when nothing is earned, so spreading it changes
 * nothing for anyone else. Spread it next to stateLoyaltyFields.
 */
export function statePricingFields(state, origin, destination, opts) {
  const h = pricingHeadroomFor(state, origin, destination, opts);
  return h > 0 ? { pricingHeadroom: h } : {};
}

/** Why the headroom is what it is — for the fare editor / Route Detail. */
export function pricingHeadroomBreakdown(state, origin, destination) {
  if (!pricingHeadroomWorld(state)) return null;
  const hub = hubHeadroom(state, origin, destination);
  const contested = rivalFliesPair(state, origin, destination);
  const entrant = !contested && credibleEntrant(state, origin, destination);
  const prot = !contested && !entrant ? PRICING_HEADROOM.protectedMarket : 0;
  return {
    hub, protectedMarket: prot, contested, credibleEntrant: entrant,
    total: Math.min(PRICING_HEADROOM.max, +(hub + prot).toFixed(4)),
  };
}
