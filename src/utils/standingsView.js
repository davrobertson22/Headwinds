// The live player list: which stats it sorts on and how (rankings rework,
// 2026-10-15). Shared by the world page's standings table
// (apps/headwinds-web/src/App.jsx) and the in-game Rivals leaderboard
// (src/components/Competition.jsx) so the two always sort the same way.
//
// A row is { rank, avgProfit, weeklyProfit, netAssets, paxWeek, flightsWeek,
// fleetSize, name }. `rank` is the OFFICIAL standing (average weekly net
// profit over the last 52 weeks); sorting by any other stat reorders the
// rows but never renumbers them.

export const STANDINGS_SORTS = [
  { key: 'rank',         label: 'Avg profit',    long: 'Average weekly profit (52 wks)', money: true, field: 'avgProfit',
    tip: 'Average weekly net profit over the last 52 weeks — what the standings rank on. When the world ends, the best average over the final 52 weeks wins.' },
  { key: 'weeklyProfit', label: 'Weekly profit', long: 'Weekly profit', money: true, field: 'weeklyProfit',
    tip: "Last week's net profit: EBIT less interest and tax. Depreciation is charged; loan principal is not." },
  { key: 'netAssets',    label: 'Net assets',    long: 'Net assets',    money: true, field: 'netAssets',
    tip: 'Assets less liabilities: cash, owned aircraft at book value and shares held, less loans outstanding.' },
  { key: 'paxWeek',      label: 'Pax / wk',      long: 'Passengers a week', field: 'paxWeek',
    tip: 'Passengers carried last week.' },
  { key: 'flightsWeek',  label: 'Flights / wk',  long: 'Flights a week', field: 'flightsWeek',
    tip: 'Weekly departures.' },
  { key: 'fleetSize',    label: 'Fleet',         long: 'Fleet size',    field: 'fleetSize',
    tip: 'Aircraft on the books, leased and owned.' },
];

export const STANDINGS_SORT_KEYS = STANDINGS_SORTS.map((s) => s.key);
export const sortSpec = (key) => STANDINGS_SORTS.find((s) => s.key === key) ?? STANDINGS_SORTS[0];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Rows in display order. `dir` 'desc' is best-first for every key (for rank
 * that means #1 first); 'asc' flips it. Missing values always sort last, and
 * ties fall back to the official rank.
 */
export function sortStandings(rows, key = 'rank', dir = 'desc') {
  const spec = sortSpec(key);
  const flip = dir === 'asc' ? -1 : 1;
  const byRank = (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity);
  return [...(rows ?? [])].sort((a, b) => {
    if (spec.key === 'rank') return flip * byRank(a, b);
    const av = a?.[spec.field], bv = b?.[spec.field];
    if (!isNum(av) && !isNum(bv)) return byRank(a, b);
    if (!isNum(av)) return 1;
    if (!isNum(bv)) return -1;
    if (bv !== av) return flip * (bv - av);
    return byRank(a, b);
  });
}

/** Clicking a header: same column flips direction, a new column starts best-first. */
export function nextSort(current, key) {
  if (current?.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  return { key, dir: 'desc' };
}

// The chosen sort is remembered per browser — a light convenience, so every
// access is guarded (private windows and blocked storage throw).
const SORT_STORAGE_KEY = 'standings_sort_v1';
export const DEFAULT_STANDINGS_SORT = { key: 'rank', dir: 'desc' };

export function loadStandingsSort() {
  try {
    const raw = globalThis.localStorage?.getItem(SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_STANDINGS_SORT;
    const v = JSON.parse(raw);
    if (STANDINGS_SORT_KEYS.includes(v?.key) && (v?.dir === 'asc' || v?.dir === 'desc')) return { key: v.key, dir: v.dir };
  } catch { /* fall through */ }
  return DEFAULT_STANDINGS_SORT;
}

export function saveStandingsSort(sort) {
  try { globalThis.localStorage?.setItem(SORT_STORAGE_KEY, JSON.stringify({ key: sort.key, dir: sort.dir })); }
  catch { /* storage blocked — the sort just isn't remembered */ }
}

/** One-line description of where the season is, for the list's header. */
export function finalStretchLine(ranking) {
  if (!ranking) return null;
  if (ranking.ended) return null;
  if (ranking.inFinalStretch) {
    const n = ranking.weeksLeft;
    return `Final stretch: ${n} week${n === 1 ? '' : 's'} left. Every week now counts toward the title.`;
  }
  const n = ranking.weeksUntilFinalStretch;
  if (!isNum(n)) return null;
  return `The final 52 weeks, the ones that decide the title, start in ${n.toLocaleString('en-US')} week${n === 1 ? '' : 's'}.`;
}
