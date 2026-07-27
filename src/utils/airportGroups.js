// ─── Grouping for airport <select> menus ──────────────────────────────────────
//
// One source of truth for how airports are bucketed in a dropdown. The player's
// own bases come first (you pick them constantly), then the world by region.
// Regions come from the shared airport data — NOT a hand-maintained list, which
// is how Bogotá, Lima, San José and ~190 other countries ended up under "Other".

import { AIRPORTS, getRegion, REGIONS } from '../data/airports.js';

const EMPTY = {};

// Alphabetical by city, then code — stable for cities that share a name.
const byCity = (x, y) => x.city.localeCompare(y.city) || x.code.localeCompare(y.code);

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Bucket airports for a grouped <select>.
 *
 *   groupAirports({ gates, hubs })
 *     → [{ label: 'Your Hubs', airports: [...] }, { label: 'Europe', ... }, ...]
 *
 * @param gates       { [code]: gateCount } — the player's gates
 * @param hubs        { [code]: { tier } }  — tier 0 = focus city, 1+ = hub
 * @param exclude     a code to leave out (the other end of the route)
 * @param requireGate only offer airports the player holds a gate at (default)
 */
export function groupAirports({
  airports = AIRPORTS, gates = EMPTY, hubs = EMPTY, exclude = null, requireGate = true,
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

  const rest = pool.filter(a => !pinned.has(a.code));
  for (const region of REGIONS) {
    const list = rest.filter(a => getRegion(a.country) === region).sort(byCity);
    if (list.length) groups.push({ label: region, airports: list, pinned: false });
  }

  // Safety net: a country the data forgot still has to go somewhere.
  const orphans = rest.filter(a => !REGIONS.includes(getRegion(a.country))).sort(byCity);
  if (orphans.length) groups.push({ label: 'Other', airports: orphans, pinned: false });

  return groups;
}

/** "JFK — New York (3 gates)" */
export function airportOptionLabel(a, gates = EMPTY, showGates = true) {
  const base = `${a.code} — ${a.city}`;
  if (!showGates) return base;
  const n = gates[a.code] ?? 0;
  return `${base} (${n} ${plural(n, 'gate', 'gates')})`;
}
