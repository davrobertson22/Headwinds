/**
 * Route Finder presets — named searches a player saves and brings back in one click.
 *
 * Discord, 2026-11-05 (Barca): "It would be handy to be able to create presets
 * in route finder. So like I could have a preset for Embraer-195 with range 0 to
 * 1500 and sorting by largest market, and another with 350-1000 with range more
 * than 13000 sorting by most profitable and no competitors."
 *
 * The finder already remembers the LAST search while the page is open
 * (utils/finderMemory.js). A preset is a search worth keeping past that: the
 * aircraft, the distance band, the region, the sort and the filter ticks. The
 * origin is deliberately not part of it — a preset is "how I hunt with an E195",
 * and it should work from whichever airport you are standing at, in any world.
 *
 * Stored per browser in localStorage (like routes_view_prefs_v1), not per
 * airline: aircraft ids and sorts mean the same thing in every world, so a
 * preset made in one Headwinds world is there in the next.
 */

const KEY = 'finder_presets_v1';
export const MAX_PRESETS = 12;
export const MAX_NAME = 48;

/** What a preset holds, per finder panel, and each field's type. */
export const PRESET_FIELDS = {
  passenger: {
    typeId: 'string', minDist: 'dist', maxDist: 'dist', region: 'string', sortBy: 'string',
    soloOnly: 'bool', showUnflyable: 'bool', showServed: 'bool', splitMetros: 'bool',
  },
  freight: {
    rangeTypeId: 'string', minDist: 'dist', maxDist: 'dist', sortBy: 'string', showServed: 'bool',
  },
};

const storage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/** A distance box's value as the finder reads it: a whole number of km, or '' for none. */
function normDist(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

/** Just the preset fields of a search, normalised so equal searches compare equal. */
export function pickSearch(panel, values) {
  const fields = PRESET_FIELDS[panel];
  if (!fields || !values || typeof values !== 'object') return null;
  const out = {};
  for (const [f, kind] of Object.entries(fields)) {
    const v = values[f];
    if (kind === 'bool') out[f] = !!v;
    else if (kind === 'dist') out[f] = normDist(v);
    else out[f] = typeof v === 'string' ? v : '';
  }
  return out;
}

export function sameSearch(panel, a, b) {
  const x = pickSearch(panel, a), y = pickSearch(panel, b);
  if (!x || !y) return false;
  return Object.keys(PRESET_FIELDS[panel]).every(f => x[f] === y[f]);
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function readAll() {
  try {
    const raw = storage()?.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeAll(all) {
  try { storage()?.setItem(KEY, JSON.stringify(all)); } catch { /* full or blocked: presets are a convenience */ }
}

/** The saved presets for one panel, oldest first. Junk entries are dropped, not shown. */
export function loadPresets(panel) {
  const list = readAll()[panel];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const name = cleanName(p?.name);
    const search = pickSearch(panel, p?.search);
    if (!name || !search || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, search });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/**
 * Save `values` as `name`. The same name (any case) is overwritten in place — that
 * is how a preset is updated. Returns the new list, or null when there is no name
 * or the list is full.
 */
export function savePreset(panel, name, values) {
  const n = cleanName(name);
  const search = pickSearch(panel, values);
  if (!n || !search) return null;
  const list = loadPresets(panel);
  const i = list.findIndex(p => p.name.toLowerCase() === n.toLowerCase());
  if (i >= 0) list[i] = { name: n, search };
  else if (list.length >= MAX_PRESETS) return null;
  else list.push({ name: n, search });
  writeAll({ ...readAll(), [panel]: list });
  return list;
}

export function deletePreset(panel, name) {
  const n = cleanName(name).toLowerCase();
  const list = loadPresets(panel).filter(p => p.name.toLowerCase() !== n);
  writeAll({ ...readAll(), [panel]: list });
  return list;
}

/**
 * What applying a preset actually sets, given what this world offers.
 *
 *   typeOk(id)  — the aircraft can be picked here (owned, or orderable this year).
 *                 A preset for a type this world doesn't have yet keeps the
 *                 current aircraft and says so, rather than selecting a blank.
 *   sortOk(id, typeId) — the sort is valid with that aircraft (a profit sort
 *                 needs one); otherwise the finder's default sort.
 *
 * Returns { search, missingType } where `search` is the full set of fields to write.
 */
export function resolvePreset(panel, preset, { current, typeOk = () => true, sortOk = () => true, defaultSort = 'demand' } = {}) {
  const search = pickSearch(panel, preset?.search ?? preset);
  if (!search) return { search: null, missingType: null };
  const typeField = panel === 'freight' ? 'rangeTypeId' : 'typeId';
  let missingType = null;
  if (search[typeField] && !typeOk(search[typeField])) {
    missingType = search[typeField];
    search[typeField] = current?.[typeField] ?? '';
  }
  if (!sortOk(search.sortBy, search[typeField])) search.sortBy = defaultSort;
  return { search, missingType };
}

/** "Embraer E195" → "E195", "Airbus A350-1000" → "A350-1000"; "ATR 72-600" and "Boeing 737-800" stay whole. */
export function shortTypeName(name) {
  const m = /^\S+\s+([A-Za-z]\S*\d.*)$/.exec(name ?? '');
  return m ? m[1] : (name ?? '');
}

/** A distance band as a name part: "0–1,500 km", "13,000+ km", or null for none. */
export function distPart(minDist, maxDist) {
  const lo = parseInt(minDist, 10) || 0, hi = parseInt(maxDist, 10) || 0;
  if (!lo && !hi) return null;
  return hi ? `${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')} km` : `${lo.toLocaleString('en-US')}+ km`;
}

/** Join name parts with " · ", dropping trailing parts until it fits MAX_NAME. */
export function presetName(parts) {
  const ps = parts.filter(Boolean);
  while (ps.length > 1 && ps.join(' · ').length > MAX_NAME) ps.pop();
  return ps.join(' · ').slice(0, MAX_NAME);
}
