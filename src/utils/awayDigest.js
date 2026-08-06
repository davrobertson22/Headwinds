// ─────────────────────────────────────────────────────────────────────────────
// WHILE YOU WERE AWAY
//
// The most common way to play Headwinds is to leave and come back. The world
// ticks every 30 seconds whether you are watching or not, so a lunch break is
// six weeks and an evening away is a season.
//
// The weekly debrief cannot describe any of that. It is built entirely from
// `state.lastReport`, which the tick overwrites wholesale — the moment week N
// lands, week N-1's report is gone. And the multiplayer client adopts ONE blob
// per poll, so returning after twelve weeks shows you the twelfth and silently
// discards the other eleven. The player's own read of what happened is "my cash
// is different now".
//
// What survives is the two ring buffers the engine already keeps: 52 weeks of
// `financialHistory` and 260 of `statsHistory` (in multiplayer). That is enough
// to say what the missed span cost, which week was the worst one, what the
// network did and where the share price went — without storing a single extra
// byte on the server.
//
// Deliberately NOT rebuilt: per-week events, mechanical failures, forced checks
// and coverage gaps. Those live only in `lastReport`, which is ~291 kB a week
// and already more than half the size of a stored airline. A twelve-week ring
// buffer of it would cost several megabytes per player to answer a question the
// world news feed already answers for free.
// ─────────────────────────────────────────────────────────────────────────────

/** Fewer weeks than this is just a normal tick — the debrief covers it. */
export const AWAY_MIN_WEEKS = 2;

/** Cap on how much history one digest will summarise. */
export const AWAY_MAX_WEEKS = 52;

/**
 * Linear week index. `state.week` is the week OF THE YEAR, so comparing raw
 * weeks reads 52 → 1 as going backwards — the same trap the multiplayer poll
 * guard exists to avoid.
 */
export function absWeekOf(state) {
  return (((state?.year ?? 1) - 1) * 52) + (state?.week ?? 0);
}

// ── "Last seen", per save ────────────────────────────────────────────────────
// Device-local by design. A server-side last-seen would be a column, a write on
// every poll, and a cross-device sync question; what it buys is remembering
// your place on a different machine. Not worth it for a summary you can always
// reconstruct from history that is already in the save.

const SEEN_PREFIX = 'hw_last_seen_week_v1';

export function seenKeyFor(scope) {
  return scope ? `${SEEN_PREFIX}:${scope}` : SEEN_PREFIX;
}

export function loadLastSeen(scope) {
  try {
    const raw = window.localStorage.getItem(seenKeyFor(scope));
    const n = raw == null ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export function saveLastSeen(scope, absWeek) {
  try {
    if (Number.isFinite(absWeek)) window.localStorage.setItem(seenKeyFor(scope), String(absWeek));
  } catch { /* private mode — the digest simply won't remember */ }
}

/**
 * How many weeks passed unseen. 0 when this is the first sighting of a save
 * (there is nothing to summarise on week one) or when nothing moved.
 */
export function weeksAway(state, lastSeen) {
  const now = absWeekOf(state);
  if (!Number.isFinite(now) || now <= 0) return 0;
  if (lastSeen == null) return 0;
  return Math.max(0, Math.min(AWAY_MAX_WEEKS, now - lastSeen));
}

// ── The digest ───────────────────────────────────────────────────────────────

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Everything the away screen shows, derived from history already in the save.
 *
 * @param {object} state
 * @param {number} weeks  span to summarise (from weeksAway)
 * @returns {object|null} null when there is nothing worth showing
 */
export function buildAwayDigest(state, weeks) {
  const span = Math.max(0, Math.min(AWAY_MAX_WEEKS, Math.round(Number(weeks) || 0)));
  if (span < AWAY_MIN_WEEKS) return null;

  const fin = Array.isArray(state?.financialHistory) ? state.financialHistory : [];
  const window = fin.slice(-span);
  if (window.length === 0) return null;

  const first = window[0];
  const last  = window[window.length - 1];

  let cashDelta = 0, revenue = 0, cost = 0, passengers = 0;
  let best = null, worst = null, profitable = 0, losing = 0;
  const series = [];
  // Cost lines worth naming when one of them dominates the span.
  const COST_LINES = [
    ['fuel', 'Fuel'], ['labor', 'Staff'], ['leases', 'Leases'],
    ['maintenance', 'Maintenance'], ['landingFees', 'Landing fees'],
    ['marketing', 'Marketing'], ['loanPayments', 'Loan repayments'],
    ['corporateTax', 'Tax'], ['gates', 'Gates'], ['insurance', 'Insurance'],
  ];
  const costTotals = Object.fromEntries(COST_LINES.map(([k]) => [k, 0]));

  for (const h of window) {
    const profit = num(h.profit);
    cashDelta  += profit;
    revenue    += num(h.revenue) + num(h.cargoRevenue);
    cost       += num(h.totalCost);
    passengers += num(h.passengers);
    if (profit >= 0) profitable += 1; else losing += 1;
    if (!best  || profit > best.profit)  best  = { label: h.label ?? '', profit, week: h.week, year: h.year };
    if (!worst || profit < worst.profit) worst = { label: h.label ?? '', profit, week: h.week, year: h.year };
    for (const [k] of COST_LINES) costTotals[k] += num(h[k]);
    series.push({ label: h.label ?? '', profit });
  }

  const biggestCost = COST_LINES
    .map(([k, label]) => ({ key: k, label, amount: costTotals[k] }))
    .filter(c => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0] ?? null;

  // Network and market movement come from statsHistory, which carries the
  // things financialHistory does not (fleet, destinations, share price, SVPS).
  // It may be shorter, sparser or entirely absent on an old save — every read
  // below tolerates that rather than assuming the two series line up.
  const stats = Array.isArray(state?.statsHistory) ? state.statsHistory : [];
  const nowAbs = absWeekOf(state);
  const fromAbs = nowAbs - span;
  const statsWindow = stats.filter(s => num(s.absWeek) > fromAbs);
  const statsBefore = stats.filter(s => num(s.absWeek) <= fromAbs).at(-1) ?? null;
  const statsNow    = statsWindow.at(-1) ?? stats.at(-1) ?? null;

  const delta = (key) => (statsBefore && statsNow && statsBefore[key] != null && statsNow[key] != null)
    ? num(statsNow[key]) - num(statsBefore[key]) : null;

  const lfWindow = statsWindow.map(s => num(s.loadFactor)).filter(v => v > 0);

  return {
    weeks: span,
    fromLabel: first?.label ?? '',
    toLabel:   last?.label  ?? '',
    cashDelta,
    revenue,
    cost,
    passengers,
    profitableWeeks: profitable,
    losingWeeks: losing,
    best,
    worst,
    biggestCost,
    series,
    cashNow: num(state?.cash),
    // Nulls mean "the save cannot answer this", which the UI renders as a dash
    // rather than a confident zero.
    fleetChange:       delta('fleet'),
    routeChange:       delta('routes'),
    destinationChange: delta('destinations'),
    sharePriceFrom: statsBefore?.sharePrice ?? null,
    sharePriceNow:  statsNow?.sharePrice ?? null,
    svpsFrom:       statsBefore?.svps ?? null,
    svpsNow:        statsNow?.svps ?? null,
    avgLoadFactor:  lfWindow.length ? lfWindow.reduce((a, b) => a + b, 0) / lfWindow.length : null,
  };
}

// ── Cross-component handshake ────────────────────────────────────────────────
// The away screen and the weekly debrief are both position:fixed modals mounted
// side by side in App.jsx. Exactly one may be on screen, and the decision is
// made from localStorage — which does not re-render anything on its own. Same
// module-store shape as utils/navIntent.js, for the same reason.

let pendingWeeks = 0;
const listeners = new Set();

export function subscribeAwayDigest(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setPendingAwayWeeks(weeks) {
  const next = Math.max(0, Math.round(Number(weeks) || 0));
  if (next === pendingWeeks) return;
  pendingWeeks = next;
  for (const fn of [...listeners]) fn(pendingWeeks);
}

export function pendingAwayWeeks() {
  return pendingWeeks;
}

/** Test seam — module state outlives a component tree, so suites must reset it. */
export function resetAwayDigest() {
  pendingWeeks = 0;
  listeners.clear();
}
