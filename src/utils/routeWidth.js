// Route line width by passengers — the Network map's "Width" toggle.
//
// With the toggle on, each passenger line is drawn thicker the more people it
// carried last week, so the network's trunks stand out from its thin spokes
// at a glance. Width scales with the SQUARE ROOT of passengers against the
// network's busiest line: linear widths let one trunk flatten everything else
// to a hairline, and the eye reads a line's thickness, not its area.
//
// The factor multiplies the line's usual weight in every state (normal,
// dimmed, hovered, focused), so hover and focus still read the same way. A
// line with no result yet (opened this week) draws at the thinnest width —
// it has carried no one. React-free: tools/route-width-test.mjs imports it.

export const ROUTE_WIDTH_KEY = 'headwinds.routeWidthByPax';

/** Thinnest and thickest multiple of a line's normal weight. */
export const WIDTH_MIN = 0.45;
export const WIDTH_MAX = 2.4;

/** Width multiple for `pax` passengers on a network whose busiest line carries `maxPax`. */
export function paxWidthFactor(pax, maxPax) {
  const p = Number(pax) || 0;
  const m = Number(maxPax) || 0;
  if (m <= 0 || p <= 0) return WIDTH_MIN;
  // Rounded to 0.01: the globe re-sends its route source whenever a drawn
  // property changes, and float noise must not count as a change.
  return Math.round((WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * Math.sqrt(Math.min(p, m) / m)) * 100) / 100;
}

/**
 * Map<group key, factor> for the map's route groups ({ key, passengers,
 * hasResult }). Off → an empty map, which every caller reads as 1.
 */
export function routeWidthFactors(groups, on) {
  const out = new Map();
  if (!on || !Array.isArray(groups) || groups.length === 0) return out;
  const maxPax = Math.max(0, ...groups.map(g => (g?.hasResult ? Number(g.passengers) || 0 : 0)));
  for (const g of groups) {
    if (!g?.key) continue;
    out.set(g.key, paxWidthFactor(g.hasResult ? g.passengers : 0, maxPax));
  }
  return out;
}
