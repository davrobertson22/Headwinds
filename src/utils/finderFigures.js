/**
 * The Route Finder's last-known forecasts, kept in the browser between visits.
 *
 * Discord, 2026-10-21 (VodkaOnFire): "Can we keep a single file in cache of the
 * latest route calculation done for pax? It takes 4-8 seconds at this point every
 * time you load up the route finder and change the filter. [...] Sure, it'd not
 * be 100% accurate, but it's not like the numbers change millions of dollars
 * every week."
 *
 * The finder already keeps the previous figures as STALE while it re-prices
 * after a network change (components/RouteFinder.jsx) — they stand in, dimmed,
 * and the table keeps its order. That store died with the page and with every
 * week's tick. This file gives it a second life: what the finder priced is saved
 * per airline, panel and airframe, and the next visit opens on those figures
 * (marked with the week they are from) while the fresh ones are worked out.
 * "Plan →" always re-forecasts the route exactly, so a stale row can mislead
 * the ranking for a few seconds but never the route you open.
 *
 * localStorage, best-effort: any failure (private mode, quota, no storage in a
 * test) just means no saved figures. Bounded: MAX_ROWS per airframe and
 * MAX_CONTEXTS airframes in all, oldest dropped first.
 */

const PREFIX = 'finderFigures.v1:';
const INDEX  = 'finderFigures.v1.index';
export const MAX_ROWS = 600;
export const MAX_CONTEXTS = 10;

// The fields a finder row reads, in a fixed order — a row is an array, not an
// object, so 600 of them stay a few tens of KB.
const FIELDS = ['weeklyFrequency', 'passengers', 'loadFactor', 'revenue', 'netProfit',
                'connectingRevenue', 'lanePooled', 'siblingPairs', 'rivalCount'];

function storage() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch { return null; }
}

/** Parsed saves, so a re-render does not re-parse; cleared on save and by clearFinderFigureCache. */
const parsed = new Map();
export function clearFinderFigureCache() { parsed.clear(); }

/** Storage id for one airline's panel × airframe (ctxId is RouteFinder's ctxIdentity). */
export function figuresId(scope, ctxId) {
  return `${PREFIX}${scope}|${ctxId}`;
}

const pack   = (p) => (p ? FIELDS.map((f) => p[f] ?? null) : 0);
const unpack = (a) => {
  if (!Array.isArray(a)) return null;
  const p = {};
  FIELDS.forEach((f, i) => { p[f] = a[i]; });
  p.lanePooled   = !!p.lanePooled;
  p.siblingPairs = p.siblingPairs ?? [];
  p.rivalCount   = p.rivalCount ?? 0;
  return p;
};

/**
 * The saved figures for one airframe, or null.
 * @returns {{ asOf: {year:number, week:number}|null, map: Map<string, object|null> }|null}
 */
export function loadFigures(scope, ctxId) {
  if (!ctxId) return null;
  const id = figuresId(scope, ctxId);
  if (parsed.has(id)) return parsed.get(id);
  let out = null;
  try {
    const raw = storage()?.getItem(id);
    if (raw) {
      const doc = JSON.parse(raw);
      if (doc?.v === 1 && Array.isArray(doc.rows)) {
        out = { asOf: doc.asOf ?? null, map: new Map(doc.rows.map(([k, a]) => [k, unpack(a)])) };
      }
    }
  } catch { out = null; }
  parsed.set(id, out);
  return out;
}

function readIndex(s) {
  try {
    const ix = JSON.parse(s.getItem(INDEX) ?? '[]');
    return Array.isArray(ix) ? ix.filter((e) => typeof e?.id === 'string') : [];
  } catch { return []; }
}

/**
 * Save what the finder priced for one airframe. Rows already saved for other
 * searches (another origin, another filter) are kept behind the new ones, up to
 * MAX_ROWS. Returns true when it was written.
 */
export function saveFigures(scope, ctxId, map, asOf = null) {
  const s = storage();
  if (!s || !ctxId || !map || map.size === 0) return false;
  const id = figuresId(scope, ctxId);
  const rows = [];
  const seen = new Set();
  for (const [k, p] of map) {
    if (rows.length >= MAX_ROWS) break;
    rows.push([k, pack(p)]); seen.add(k);
  }
  const prev = loadFigures(scope, ctxId);
  if (prev) {
    for (const [k, p] of prev.map) {
      if (rows.length >= MAX_ROWS) break;
      if (!seen.has(k)) rows.push([k, pack(p)]);
    }
  }
  const body = JSON.stringify({ v: 1, asOf, rows });
  parsed.delete(id);

  let index = readIndex(s).filter((e) => e.id !== id);
  index.push({ id, at: Date.now() });
  // Oldest airframes out first: past the count cap, and again if the browser
  // says the storage is full.
  const evictOldest = () => {
    const victim = index.shift();
    if (!victim) return false;
    try { s.removeItem(victim.id); } catch { /* ignore */ }
    parsed.delete(victim.id);
    return true;
  };
  while (index.length > MAX_CONTEXTS) evictOldest();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      s.setItem(id, body);
      s.setItem(INDEX, JSON.stringify(index));
      return true;
    } catch {
      if (index.length <= 1 || index[0].id === id || !evictOldest()) break;
    }
  }
  return false;
}
