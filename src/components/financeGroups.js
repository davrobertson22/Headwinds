// The Finance page's map-view groups (which classic Finance views each map-view
// tab shows). Its own module so the map view can ask without loading the whole
// Finance page, which now loads on first open like the other pages.
export const FINANCE_GROUP_VIEWS = {
  statements: ['pl', 'cashflow', 'bs'],
  planning:   ['forecast', 'loans'],
  analysis:   ['uniteco', 'trends', 'stats'],
  breakdown:  ['routes', 'airports'],
  fuel:       ['fuel'],
};

/** Which map-view Finance group shows `view` (the classic view ids). */
export function financeGroupOf(view) {
  for (const [g, views] of Object.entries(FINANCE_GROUP_VIEWS)) if (views.includes(view)) return g;
  return null;
}
