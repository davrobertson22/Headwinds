// What to tell the player when a reserve could not cover a route.
//
// One wording for the Weekly Debrief, the Operations panel and the toast, from
// a coverGaps entry (utils/simulation.js applyReserveCovers). The old line was
// "1 route uncovered — no same-type reserve based there", printed directly
// under "Fokker F27 Friendship #12 dispatched — covering 3 routes for The Bee
// #2" (Discord, Nilla_wafer 2026-11-17). Both were true: a reserve only takes
// routes that touch the airport it is based at, and the fourth route touched
// neither end. But read together they look like a bug. So the notice now
// names the route and says where the reserve is.
//
// Entries saved before 2026-11-20 have none of the detail fields; they get the
// old wording.

const listOf = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "BUF → IAD", "2 routes (BUF → IAD, BUF → ORD)" or "5 routes". */
export function coverGapSubject(g) {
  const n = g?.routes ?? 0;
  const labels = g?.routeLabels ?? [];
  if (n === 1 && labels.length === 1) return labels[0];
  const head = `${n} route${n !== 1 ? 's' : ''}`;
  return labels.length === n && n <= 3 ? `${head} (${labels.join(', ')})` : head;
}

/** Why it is uncovered, as a clause: "Fokker F27 #12 is based at PIT, and a reserve only takes routes that touch its base". */
export function coverGapReason(g) {
  const one = (g?.routes ?? 0) === 1;
  if (g?.reason === 'hours-full') {
    const full = g.fullReserves ?? [];
    if (full.length) return `${listOf(full)} ${full.length === 1 ? 'is' : 'are'} already at the weekly block-hour cap`;
    return 'your matching reserve is out of weekly block hours';
  }
  const bases = g?.bases ?? [];
  const covering = g?.coveredBy ?? [];
  const type = g?.typeName;
  if (!g?.routeLabels) return 'no same-type reserve is based at an airport these routes touch';
  if (bases.length) {
    // Name the covering reserve only when the base is unambiguously its own.
    const who = covering.length === 1 && bases.length === 1
      ? `${covering[0]} is`
      : `your ${type ?? 'same-type'} reserve${bases.length === 1 ? ' is' : 's are'}`;
    return `${who} based at ${listOf(bases)}, and a reserve only takes routes that touch its base`;
  }
  return `no ${type ?? 'same-type'} reserve is on standby at an airport ${one ? 'it touches' : 'they touch'}`;
}

/** The whole line: "BUF → IAD uncovered (~$255.5K/wk) — …". money formats the weekly figure. */
export function coverGapLine(g, money) {
  return `${coverGapSubject(g)} uncovered (~${money(g?.revenueAtRisk ?? 0)}/wk) — ${coverGapReason(g)}`;
}
