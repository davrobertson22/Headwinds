
/**
 * One definition of what a route earns.
 *
 * Before this module the same route could show four different profits on four
 * screens, under near-identical labels:
 *
 *   Routes table   revenue − op − landing − fixed, fixed split by FREQUENCY
 *                  share across that tail's PASSENGER routes only
 *   Routes cards   revenue − op − landing            ("Op Profit / wk")
 *   Dashboard      engine profit − fixed, split by BLOCK-HOUR share (cargo in)
 *   Finance        block-hour share again, but over passenger routes only, and
 *                  costed from the TYPE's list lease rather than the rate this
 *                  tail actually signed at
 *
 * They disagreed by the whole fixed-cost slice, so the Routes health strip
 * could say "3 losing" over a screen of green cards, and the Dashboard's
 * "N loss-making routes" alert counted a different N than the filter it linked
 * to. Close-or-keep is the most consequential judgement a player makes, and
 * every screen was answering it differently.
 *
 * Two numbers, named once:
 *
 *   CONTRIBUTION   revenue − direct cost. What the route adds THIS week if the
 *                  aircraft is already paid for. The right number for "should I
 *                  keep flying this with the plane I already have".
 *   FULLY LOADED   contribution − the route's share of the aircraft's lease and
 *                  maintenance. The right number for "is this route worth the
 *                  aeroplane", and the honest one for a network-wide total.
 *
 * ── Why block-hours ──────────────────────────────────────────────────────────
 * Lease and maintenance are bought by TIME, not by departure count. Splitting a
 * tail's fixed cost by frequency charges a 1h shuttle the same as a 12h
 * long-haul on the same airframe, which quietly makes short routes look
 * unprofitable and long ones look free. Block-hours is also what Finance and the
 * Dashboard already used, so this is the majority convention, not a new one.
 *
 * ── Why cargo counts in the denominator ──────────────────────────────────────
 * A freighter's lease belongs to the freight lanes that consume its hours. Split
 * over passenger routes only, a mixed-use tail dumped its entire ownership cost
 * on the passenger side and freight flew for free.
 */

export const BASIS_CONTRIBUTION = 'contribution';
export const BASIS_FULL         = 'full';

/** Long labels — column headers, view toggles, tooltips. */
export const PROFIT_LABELS = {
  [BASIS_CONTRIBUTION]: 'Contribution',
  [BASIS_FULL]:         'Fully-loaded profit',
};

/** Short labels for tight spots (table headers, card stats). */
export const PROFIT_SHORT = {
  [BASIS_CONTRIBUTION]: 'Contribution / wk',
  [BASIS_FULL]:         'Full profit / wk',
};

export const PROFIT_HELP = {
  [BASIS_CONTRIBUTION]:
    'Revenue minus this route’s own operating cost and landing fees. What the route adds each week ' +
    'if you already own or lease the aircraft — the number to judge "keep flying it?" by.',
  [BASIS_FULL]:
    'Contribution minus this route’s share of the aircraft’s weekly lease and maintenance, split by ' +
    'block-hours across every route that tail flies (freight included). The number to judge ' +
    '"is this route worth the aeroplane?" by, and the one that adds up to your network total.',
};

/** Persisted so every screen answers with the same number, not just its own. */
const BASIS_KEY = 'hw_profit_basis_v1';

export function loadProfitBasis() {
  try {
    const v = localStorage.getItem(BASIS_KEY);
    return v === BASIS_CONTRIBUTION ? BASIS_CONTRIBUTION : BASIS_FULL;
  } catch (_) {
    return BASIS_FULL;
  }
}

export function saveProfitBasis(basis) {
  try { localStorage.setItem(BASIS_KEY, basis); } catch (_) {}
}

/** Direct cost of a route result: what flying it costs, landing fees included. */
export function directCostOf(result) {
  if (!result) return 0;
  return (result.totalOpCost ?? 0) + (result.landingFee ?? 0);
}

// The split itself lives in the engine so the Advisor and briefing use it too.
export { aircraftFixedWeekly, allocateFixedCosts } from '../../packages/engine/src/models/routeFixedCost.js';

/**
 * Profit for one route result under the chosen basis.
 * `fixedShare` comes from allocateFixedCosts(); it is ignored for contribution.
 */
export function routeProfit(result, fixedShare = 0, basis = BASIS_FULL) {
  if (!result) return 0;
  const contribution = (result.revenue ?? 0) - directCostOf(result);
  return basis === BASIS_CONTRIBUTION ? contribution : contribution - (fixedShare ?? 0);
}

/**
 * Totals for a city pair (every tail on it), both bases, so a caller can show
 * one and reconcile with the other without recomputing.
 */
export function pairEconomics(entries, fixedByRoute = {}) {
  let revenue = 0, direct = 0, fixed = 0;
  for (const { route, result } of entries) {
    if (!result) continue;
    revenue += result.revenue ?? 0;
    direct  += directCostOf(result);
    fixed   += fixedByRoute[route.id] ?? 0;
  }
  const contribution = revenue - direct;
  return {
    revenue, direct, fixed,
    contribution,
    full: contribution - fixed,
    profitFor: (basis) => (basis === BASIS_CONTRIBUTION ? contribution : contribution - fixed),
    marginFor: (basis) => {
      if (revenue <= 0) return 0;
      return (basis === BASIS_CONTRIBUTION ? contribution : contribution - fixed) / revenue;
    },
  };
}

/**
 * Load factor at which a route covers its costs on the given basis.
 *
 * Revenue is close to linear in passengers at a fixed fare, so the revenue at a
 * full aircraft is today's revenue divided by today's load. Returns null when
 * that cannot be inferred (nothing flying yet), rather than a confident zero.
 */
export function breakEvenLoad(result, fixedShare = 0, basis = BASIS_FULL) {
  if (!result) return null;
  const lf = result.loadFactor ?? 0;
  const revenue = result.revenue ?? 0;
  if (lf <= 0 || revenue <= 0) return null;
  const fullRevenue = revenue / lf;
  const cost = directCostOf(result) + (basis === BASIS_CONTRIBUTION ? 0 : (fixedShare ?? 0));
  if (fullRevenue <= 0) return null;
  return cost / fullRevenue;
}
