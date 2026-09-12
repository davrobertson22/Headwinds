// ─── Grouping for airport <select> menus ──────────────────────────────────────
//
// One source of truth for how airports are bucketed in a dropdown. The player's
// own bases come first (you pick them constantly), then the world by region.
// Regions come from the shared airport data — NOT a hand-maintained list, which
// is how Bogotá, Lima, San José and ~190 other countries ended up under "Other".
//
// The region ORDER is not fixed either, and that is the second bug report:
//
//   "Would it be possible to chose which airports come up first? I am mostly
//    flying Asian routes but I have to go all the way down to select them."
//    (Barca, Discord 2026-09-10)
//
// He was right, and the fixed order was the whole problem: REGIONS lists Asia
// sixth of seven, so an Asian carrier scrolled past all of North America, South
// America, Europe, the Middle East and Africa to reach its own network — every
// single time. Nothing about that order was ever meaningful; it is just the
// order somebody typed the continents in.
//
// So regions are now ordered by where the player's airline actually IS, most
// gates first. An Asian carrier opens the dropdown on Asia, a US carrier on
// North America, and neither of them has to be asked or to configure anything.
// A player with no gates at all (the re-founding screen) still gets the
// canonical order, because there is nothing yet to sort by.

import { AIRPORTS, getRegion, REGIONS } from '../data/airports.js';

const EMPTY = {};
const NONE  = [];

// Alphabetical by city, then code — stable for cities that share a name.
const byCity = (x, y) => x.city.localeCompare(y.city) || x.code.localeCompare(y.code);

const plural = (n, one, many) => (n === 1 ? one : many);

export const RECENT_GROUP_LABEL  = 'Recently Used';
export const NETWORK_GROUP_LABEL = 'Your Airports';

const NO_PRESENCE = { gates: 0, airports: 0 };

/**
 * How much of the player's airline sits in each region.
 *
 *   → Map('Asia' → { gates: 22, airports: 9 }, …)
 *
 * Counted over the WHOLE network, including the hubs and focus cities that get
 * pinned out of their region group below. A carrier whose only Asian gates are
 * at its Tokyo hub is still an Asian carrier, and its region ought to sort like
 * one.
 */
export function regionPresence({ airports = AIRPORTS, gates = EMPTY, hubs = EMPTY } = {}) {
  const presence = new Map();
  for (const a of airports) {
    const n = gates[a.code] ?? 0;
    if (n <= 0 && !hubs[a.code]) continue;
    const region = getRegion(a.country);
    const cur = presence.get(region) ?? { gates: 0, airports: 0 };
    cur.gates    += n;
    cur.airports += 1;
    presence.set(region, cur);
  }
  return presence;
}

/**
 * REGIONS, re-ordered so the player's own part of the world is on top.
 *
 * Gates first (they weight a hub properly — 12 gates at NRT should outrank four
 * one-gate outstations scattered across Europe), then airport count, then the
 * canonical order as the tie-break. That last fallback is what keeps the list
 * stable and predictable for a player with a balanced network, and what makes
 * an airline with no gates anywhere see exactly what it used to.
 */
export function orderRegionsByPresence(presence = new Map(), regions = REGIONS) {
  const rank = new Map(regions.map((r, i) => [r, i]));
  return [...regions].sort((x, y) => {
    const px = presence.get(x) ?? NO_PRESENCE;
    const py = presence.get(y) ?? NO_PRESENCE;
    return (py.gates - px.gates)
        || (py.airports - px.airports)
        || (rank.get(x) - rank.get(y));
  });
}

/**
 * Bucket airports for a grouped <select>.
 *
 *   groupAirports({ gates, hubs, recent })
 *     → [{ label: 'Your Hubs', airports: [...] }, { label: 'Asia', ... }, ...]
 *
 * @param gates       { [code]: gateCount } — the player's gates
 * @param hubs        { [code]: { tier } }  — tier 0 = focus city, 1+ = hub
 * @param recent      codes the player picked lately, most recent first
 * @param exclude     a code to leave out (the other end of the route)
 * @param requireGate only offer airports the player holds a gate at (default)
 */
export function groupAirports({
  airports = AIRPORTS, gates = EMPTY, hubs = EMPTY, recent = NONE,
  exclude = null, requireGate = true,
} = {}) {
  const pool = airports.filter(a =>
    a.code !== exclude && (!requireGate || (gates[a.code] ?? 0) > 0));

  const tierOf    = (a) => (hubs[a.code] ? (hubs[a.code].tier ?? 0) : null);
  const hubList   = pool.filter(a => (tierOf(a) ?? -1) >= 1).sort(byCity);
  const focusList = pool.filter(a => tierOf(a) === 0).sort(byCity);
  const pinned    = new Set([...hubList, ...focusList].map(a => a.code));

  const groups = [];
  if (hubList.length)   groups.push({ label: plural(hubList.length,   'Your Hub',        'Your Hubs'),        airports: hubList,   pinned: true });
  if (focusList.length) groups.push({ label: plural(focusList.length, 'Your Focus City', 'Your Focus Cities'), airports: focusList, pinned: true });

  // Recently used — in recency order, NOT alphabetical. The point of the group
  // is "the one you just had", so re-sorting it by city would destroy it.
  const byCode = new Map(pool.map(a => [a.code, a]));
  const recentList = [];
  for (const code of recent) {
    if (pinned.has(code)) continue;               // already on top, don't say it twice
    const a = byCode.get(code);
    if (a && !recentList.includes(a)) recentList.push(a);
  }
  if (recentList.length) {
    groups.push({ label: RECENT_GROUP_LABEL, airports: recentList, pinned: true });
    for (const a of recentList) pinned.add(a.code);
  }

  // Airports you hold gates at but that are neither a base nor recent. Only
  // worth a group when the pool is the whole world — with requireGate on, every
  // airport in the list is already one of yours and this would swallow it.
  if (!requireGate) {
    const mine = pool
      .filter(a => !pinned.has(a.code) && (gates[a.code] ?? 0) > 0)
      .sort(byCity);
    if (mine.length) {
      groups.push({ label: NETWORK_GROUP_LABEL, airports: mine, pinned: true });
      for (const a of mine) pinned.add(a.code);
    }
  }

  const rest = pool.filter(a => !pinned.has(a.code));
  for (const region of orderRegionsByPresence(regionPresence({ airports, gates, hubs }))) {
    const list = rest.filter(a => getRegion(a.country) === region).sort(byCity);
    if (list.length) groups.push({ label: region, airports: list, pinned: false });
  }

  // Safety net: a country the data forgot still has to go somewhere.
  const orphans = rest.filter(a => !REGIONS.includes(getRegion(a.country))).sort(byCity);
  if (orphans.length) groups.push({ label: 'Other', airports: orphans, pinned: false });

  return groups;
}

/**
 * A flat, ordered shortlist of the airports this player actually uses — for the
 * compact search pickers (Route Finder, Cargo Route Finder), which have no
 * optgroups to put a hierarchy in.
 *
 * Order: recent, then hubs, then focus cities, then everywhere else you hold a
 * gate (biggest presence first). Each entry carries WHY it is there so the row
 * can say so — an unexplained ordering reads as random.
 *
 * `fallback` tops the list up for an airline that holds nothing yet, so a brand
 * new player still opens the picker on something rather than on emptiness.
 */
export function networkAirports({
  airports = AIRPORTS, gates = EMPTY, hubs = EMPTY, recent = NONE,
  exclude = null, limit = 8, fallback = true,
} = {}) {
  const byCode = new Map(airports.map(a => [a.code, a]));
  const out  = [];
  const seen = new Set(exclude ? [exclude] : []);
  const push = (a, why) => {
    if (!a || seen.has(a.code)) return;
    seen.add(a.code);
    out.push({ airport: a, why, gates: gates[a.code] ?? 0 });
  };

  for (const code of recent) push(byCode.get(code), 'recent');

  const tierOf = (code) => (hubs[code] ? (hubs[code].tier ?? 0) : null);
  const mine = Object.entries(gates)
    .filter(([, n]) => n > 0)
    .map(([code, n]) => ({ code, n, airport: byCode.get(code) }))
    .filter(x => x.airport)
    .sort((x, y) => y.n - x.n || byCity(x.airport, y.airport));

  for (const x of mine) if ((tierOf(x.code) ?? -1) >= 1) push(x.airport, 'hub');
  for (const x of mine) if (tierOf(x.code) === 0)        push(x.airport, 'focus');
  for (const x of mine) push(x.airport, 'gates');

  // A hub you somehow hold no gate at (mid-relocation, a seeded save) is still
  // a base and still belongs above the filler.
  for (const code of Object.keys(hubs)) push(byCode.get(code), (tierOf(code) ?? -1) >= 1 ? 'hub' : 'focus');

  if (fallback) for (const a of airports) { if (out.length >= limit) break; push(a, null); }

  return out.slice(0, limit);
}

/**
 * Rank search matches so the player's own airports surface first.
 *
 * Typing "SIN" should not make you hunt for your own Singapore gates among
 * three other airports that happen to contain those letters. Ties keep the
 * order they came in, so the caller's own relevance sort still shows through.
 */
export function rankByNetwork(list, { gates = EMPTY, hubs = EMPTY, recent = NONE } = {}) {
  const recentRank = new Map(recent.map((code, i) => [code, i]));
  const score = (a) => {
    if (recentRank.has(a.code)) return -1000 + recentRank.get(a.code);
    const tier = hubs[a.code] ? (hubs[a.code].tier ?? 0) : null;
    if (tier != null && tier >= 1) return -300;
    if (tier === 0)                return -200;
    if ((gates[a.code] ?? 0) > 0)  return -100;
    return 0;
  };
  return list
    .map((a, i) => ({ a, i, s: score(a) }))
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map(x => x.a);
}

/** "JFK — New York (3 gates)" */
export function airportOptionLabel(a, gates = EMPTY, showGates = true) {
  const base = `${a.code} — ${a.city}`;
  if (!showGates) return base;
  const n = gates[a.code] ?? 0;
  return `${base} (${n} ${plural(n, 'gate', 'gates')})`;
}
