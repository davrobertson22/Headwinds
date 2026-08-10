/**
 * Where every tab actually lives in the grouped nav bar.
 *
 * The nav bar shows eight controls: Dashboard, News, Network, Fleet, Airports,
 * Company, Finance, Help. Everything else is a child of one of the four
 * dropdown groups and has NO visible button of its own. Any screen that tells
 * the player where to click therefore has to name a PATH ("Fleet > Market"),
 * not a tab ("Market") — the onboarding tour named tabs, and its very first
 * instruction ("Open the Market tab") pointed at a control that has not existed
 * since the nav was grouped.
 *
 * App.jsx owns the rendered nav; this module owns the answer to "where do I
 * click to reach X", so the tour, contextual hints and empty states all quote
 * the same path. tools/nav-path-test.mjs asserts the two agree, so adding a tab
 * or moving one between groups without updating this file fails the suite.
 */

// Tab id -> the label printed on its nav entry.
export const TAB_LABELS = {
  dashboard:    'Dashboard',
  map:          'Map',
  finder:       'Route Finder',
  planner:      'Route Planner',
  routes:       'Routes',
  fleet:        'Fleet',
  market:       'Market',
  used:         'Used Market',
  airports:     'Gates',
  hubs:         'Hubs',
  operations:   'Operations',
  maintenance:  'Maintenance',
  ancillaries:  'Ancillaries',
  reputation:   'Reputation',
  loyalty:      'Loyalty',
  alliances:    'Alliances',
  competition:  'Competition',
  stocks:       'Stocks',
  finance:      'Finance',
  news:         'News',
  wiki:         'Help',
};

// Tab id -> the dropdown group that contains it. A tab missing from this map is
// a top-level button and needs no path prefix.
export const TAB_GROUP = {
  map:          'Network',
  finder:       'Network',
  planner:      'Network',
  routes:       'Network',
  fleet:        'Fleet',
  market:       'Fleet',
  used:         'Fleet',
  airports:     'Airports',
  hubs:         'Airports',
  operations:   'Company',
  maintenance:  'Company',
  ancillaries:  'Company',
  reputation:   'Company',
  loyalty:      'Company',
  alliances:    'Company',
  competition:  'Company',
  stocks:       'Company',
};

// The separator the nav path is drawn with.
export const NAV_SEP = '\u25b8';

/**
 * Human-readable click path for a tab id, e.g. 'Fleet ▸ Market'.
 *
 * In multiplayer the Competition tab is labelled 'Rivals', matching App.jsx's
 * tabLabel() — pass { remote: true } so the tour quotes what the player sees.
 *
 * Returns null for an unknown id, so a caller quoting a tab that no longer
 * exists renders nothing rather than a broken instruction.
 */
export function navPathFor(id, { remote = false } = {}) {
  const label = (remote && id === 'competition') ? 'Rivals' : TAB_LABELS[id];
  if (!label) return null;
  const group = TAB_GROUP[id];
  return group ? `${group} ${NAV_SEP} ${label}` : label;
}
