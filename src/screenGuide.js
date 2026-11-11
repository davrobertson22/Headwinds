/**
 * Where everything is in the game, in words an AI can relay to a player.
 *
 * vrt1ty (Discord, 2026-11-09), testing the airline briefing with an AI: "the
 * AI doesn't always know where to find something; for example, fuel, which is
 * in the finance section". The Advisor's tips named a top-level tab at best
 * ("Finance"), and an AI that knows nothing else cannot tell a beginner that
 * hedging is on Finance ▸ Planning ▸ Fuel — or, in the map view, Operations ▸
 * Fuel. This module is the answer: every page, where it is in BOTH layouts, and
 * what lives there. The briefing prints it; the read-only API's briefing too.
 *
 * Paths are BUILT, not typed:
 *   classic   navPathFor() from navPath.js (which nav-hints-test pins to
 *             App.jsx), plus the page's own sub-tab names
 *   map view  MAP_VIEW_PATHS below, which tools/screen-guide-test.mjs pins to
 *             MapShell.jsx's MAP_GROUPS / MAP_PAGES
 * so a tab that moves cannot quietly send an AI to the wrong place.
 *
 * Pure: no React, no DOM. The Headwinds server imports it for the Agent API.
 */
import { navPathFor, NAV_SEP } from './navPath.js';

const S = ` ${NAV_SEP} `;

// Map view: page id → "Dock group ▸ Page", as MapShell labels them. Dashboard
// and the guide are buttons in the top chrome, and the map itself is the
// background, so they get a description instead of a path.
export const MAP_VIEW_PATHS = {
  dashboard:        'the Dashboard button at the top',
  wiki:             'the Guide button at the top',
  finder:           `Search${S}Route Finder`,
  planner:          `Search${S}Route Planner`,
  routes:           `Network${S}Routes`,
  airports:         `Network${S}Gates`,
  hubs:             `Network${S}Hubs`,
  departures:       `Network${S}Departures`,
  fleet:            `Fleet${S}Fleet`,
  market:           `Fleet${S}Market`,
  used:             `Fleet${S}Used Market`,
  competition:      `World${S}Competition`,
  alliances:        `World${S}Alliances`,
  stocks:           `World${S}Stocks`,
  news:             `World${S}News`,
  advisor:          `Operations${S}Advisor`,
  operations:       `Operations${S}Crew`,
  maintenance:      `Operations${S}Maintenance`,
  fuel:             `Operations${S}Fuel`,
  marketing:        `Service${S}Marketing`,
  catering:         `Service${S}Catering`,
  ancillaries:      `Service${S}Ancillaries`,
  reputation:       `Service${S}Reputation`,
  loyalty:          `Service${S}Loyalty`,
  partners:         `Service${S}Partnerships`,
  'fin-statements': `Finance${S}Statements`,
  'fin-planning':   `Finance${S}Loans & Forecast`,
  'fin-analysis':   `Finance${S}Analysis`,
  'fin-breakdown':  `Finance${S}Breakdown`,
};

// One entry per thing a player looks for. `tab` is the classic tab, `sub` the
// sub-tab path inside it, `map` the map-view page (MAP_VIEW_PATHS key) or
// `mapText` when the map view has no page of its own for it.
export const SCREEN_GUIDE = [
  { key: 'dashboard', tab: 'dashboard', map: 'dashboard',
    what: 'Weekly health check: cash, profit, alerts, the Advisor line, key figures and where the money went.' },
  { key: 'advisor', tab: 'advisor', map: 'advisor',
    what: 'The Advisor\'s tips and the alerts in one list, and the Copy airline briefing button.' },
  { key: 'news', tab: 'news', map: 'news', remoteOnly: true,
    what: 'Every public move in the world: routes opened, orders, gates, share deals, standings.' },
  { key: 'map', tab: 'map', mapText: 'the map behind everything',
    what: 'Your network on a map or globe; route width by passengers, colour by profit or load factor.' },
  { key: 'finder', tab: 'finder', map: 'finder',
    what: 'Markets you don\'t serve yet from any airport, filtered to what a chosen aircraft can fly, with a forecast per market. The place to look for new routes.' },
  { key: 'planner', tab: 'planner', map: 'planner',
    what: 'Model one route before opening it: aircraft, frequency and fares, with forecast load and profit; then open it.' },
  { key: 'routes', tab: 'routes', map: 'routes',
    what: 'Every route with load, revenue, profit, fares and frequency. Filters: Profit, Losing, Low Load. Change fares and frequency, bulk-edit, close routes.' },
  { key: 'fleet', tab: 'fleet', map: 'fleet',
    what: 'Your aircraft: status, routes, block hours used; leases (extend, buy out, auto-renew); cabin layout; the order queue; livery, logo and tail.' },
  { key: 'market', tab: 'market', map: 'market',
    what: 'Buy or lease new aircraft and see delivery slots.' },
  { key: 'used', tab: 'used', map: 'used',
    what: 'Second-hand aircraft for sale.' },
  { key: 'airports', tab: 'airports', map: 'airports',
    what: 'Gates and weekly slots at every airport you use; lease more gates (gate auctions in gate-scarcity worlds).' },
  { key: 'airport-detail', classicText: 'click any airport code', mapText: 'click any airport code',
    what: 'An airport\'s own page: lease a gate there, build a lounge or a fuel farm.' },
  { key: 'hubs', tab: 'hubs', map: 'hubs',
    what: 'Hubs and focus cities: designate and upgrade them for connecting traffic.' },
  { key: 'crew', tab: 'operations', sub: 'Labour & Costs', map: 'operations',
    what: 'Staff pay rates against the market rate, hiring crew, crew shortfalls, unions and strikes.' },
  { key: 'marketing', tab: 'operations', sub: 'Labour & Costs', map: 'marketing',
    what: 'Brand marketing budget (fixed, or a share of revenue) and targeted airport campaigns.' },
  { key: 'catering', tab: 'operations', sub: 'Labour & Costs', map: 'catering',
    what: 'Default catering, your own service plans, and catering contracts.' },
  { key: 'departures', tab: 'operations', sub: 'Departure Board', map: 'departures',
    what: 'The departure board for any airport.' },
  { key: 'schedule', tab: 'operations', sub: 'Schedule', mapText: `Network${S}Departures${S}Schedule`,
    what: 'Each aircraft\'s weekly timeline; hub banks at your hubs.' },
  { key: 'maintenance', tab: 'maintenance', map: 'maintenance',
    what: 'Heavy C and D checks (book them), the maintenance budget and jet bases.' },
  { key: 'ancillaries', tab: 'ancillaries', map: 'ancillaries',
    what: 'Bags, seat selection and other extras sold on top of the fare.' },
  { key: 'reputation', tab: 'reputation', map: 'reputation',
    what: 'Reputation and what drives it, staff morale, market positioning.' },
  { key: 'loyalty', tab: 'loyalty', map: 'loyalty',
    what: 'The loyalty programme: budget, members, elite status, city loyalty.' },
  { key: 'partners', tab: 'partners', map: 'partners', when: (s) => s?.partnershipsWorld === true,
    what: 'Travel partnerships with hotels, cruise lines, ride share and tour operators.' },
  { key: 'alliances', tab: 'alliances', map: 'alliances',
    what: 'Alliances and codeshares.' },
  { key: 'competition', tab: 'competition', map: 'competition',
    what: 'The other airlines: standings, airline profiles, contested routes.' },
  { key: 'stocks', tab: 'stocks', map: 'stocks',
    what: 'Your share price and listing, issuing or buying back shares, dividends, trading other airlines\' shares.' },
  { key: 'statements', tab: 'finance', sub: 'Statements', map: 'fin-statements',
    what: 'P&L, cash flow and balance sheet.' },
  { key: 'loans', tab: 'finance', sub: `Planning${S}Loans / Forecast`, map: 'fin-planning',
    what: 'Take out or repay loans; the cash forecast.' },
  { key: 'fuel', tab: 'finance', sub: `Planning${S}Fuel`, map: 'fuel',
    what: 'The fuel price index and what fuel costs you; hedges, fuel farms and refineries.' },
  { key: 'analysis', tab: 'finance', sub: 'Analysis', map: 'fin-analysis',
    what: 'Unit economics, trends and long-run statistics.' },
  { key: 'breakdown', tab: 'finance', sub: 'Breakdown', map: 'fin-breakdown',
    what: 'Profit by route and by airport.' },
  { key: 'wiki', tab: 'wiki', map: 'wiki',
    what: 'The in-game guide to every system.' },
];

const BY_KEY = Object.fromEntries(SCREEN_GUIDE.map(e => [e.key, e]));

function classicPath(e, remote) {
  if (e.classicText) return e.classicText;
  const base = navPathFor(e.tab, { remote });
  return e.sub ? `${base}${S}${e.sub}` : base;
}

function mapPath(e, remote) {
  if (e.mapText) return e.mapText;
  const p = MAP_VIEW_PATHS[e.map] ?? null;
  // The map view labels the Competition page by its classic tab label.
  return p && remote && e.map === 'competition' ? `World${S}Rivals` : p;
}

/**
 * The guide for one airline: every page it can actually see (News only in
 * multiplayer, Partnerships only in partnership worlds).
 * @returns {Array<{ key, classic, map, what }>}
 */
export function screenGuide(state = null, { remote = false } = {}) {
  return SCREEN_GUIDE
    .filter(e => (remote || !e.remoteOnly) && (!e.when || e.when(state)))
    .map(e => ({ key: e.key, classic: classicPath(e, remote), map: mapPath(e, remote), what: e.what }));
}

// Routes' filter chips, as the Routes page labels them.
const ROUTE_FILTER_LABEL = { profitable: 'Profit', unprofitable: 'Losing', lowload: 'Low Load' };

/**
 * Where an Advisor action really goes, down to the sub-page and filter:
 * { to: 'finance', filter: { view: 'fuel' } } is Finance ▸ Planning ▸ Fuel,
 * not "Finance". Returns { classic, map } or null for an unknown tab.
 */
export function actionPaths(action, { remote = false } = {}) {
  if (!action?.to) return null;
  const f = action.filter ?? {};
  let key = action.to;
  if (action.to === 'finance') key = f.view === 'fuel' ? 'fuel' : (f.view === 'loans' || f.view === 'forecast') ? 'loans' : 'statements';
  else if (action.to === 'operations') key = f.section === 'marketing' ? 'marketing' : f.section === 'catering' ? 'catering' : 'crew';
  const e = BY_KEY[key];
  if (!e) return null;
  let classic = classicPath(e, remote);
  let map = mapPath(e, remote);
  if (action.to === 'routes' && ROUTE_FILTER_LABEL[f.filterTab]) {
    const chip = ` (the ${ROUTE_FILTER_LABEL[f.filterTab]} filter)`;
    classic += chip; map = map ? map + chip : map;
  }
  return { classic, map };
}

/** One line for a briefing: "Finance ▸ Planning ▸ Fuel (map view: Operations ▸ Fuel)". */
export function actionPathText(action, opts) {
  const p = actionPaths(action, opts);
  if (!p) return null;
  return p.map && p.map !== p.classic ? `${p.classic} (map view: ${p.map})` : p.classic;
}
