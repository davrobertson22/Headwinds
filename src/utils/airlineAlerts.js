// ── Airline alerts — one list for every screen that shows them ───────────────
//
// The Dashboard's alert strip ("2 idle aircraft", "3 loss-making city pairs",
// "a lease expiring within 8 weeks", a bad world event…) used to be built
// inline in Dashboard.jsx. The map view now shows the same alerts as a column of
// icons down the right edge with hover tooltips (Barca, Discord 2026-10-29), and
// two copies of these rules would drift — so both screens call this.
//
// Every alert names a problem that lives on ANOTHER tab, so every alert carries
// that tab (`to`, a classic tab id) and the filter it should arrive under.

import { useMemo } from 'react';
import { simulateRoute, currentGameDate, fleetAvgUtilization,
  stateLoungeFields, stateGroundHandlingFields, stateCateringFields, formatMoney,
} from './simulation.js';
import { projectWeek } from './financeProjection.js';
import { getAircraftType } from '../data/aircraft.js';
import { crewStatus, crewParkedAlertText } from '../data/labor.js';
import { isReserve } from '../data/reserve.js';
import { leasesAtRisk, idleFleetAlertText, leaseWarnPhrase, leaseAutoRenewSetting } from './leaseAlerts.js';
import { allocateFixedCosts, routeProfit, loadProfitBasis } from './routeEconomics.js';
import { AlertIcon, DotIcon, TrendDownIcon } from '../components/Icons.jsx';

// ── One projection per state ─────────────────────────────────────────────────
// projectWeek runs a full engine tick. In the map view the map, the alert
// column and an open Dashboard all want it for the same state object, so the
// last one is kept (states are immutable — a new action is a new object).
let lastState = null;
let lastProj = null;
export function projectWeekShared(state) {
  if (state !== lastState || !lastProj) {
    lastProj = projectWeek(state);
    lastState = state;
  }
  return lastProj;
}

/**
 * Per-route results read from the canonical engine projection. Prefer the
 * engine's routeResult; fall back to a standalone sim ONLY for routes the engine
 * skips (grounded / dormant-seasonal), using the same labor + fuel the engine
 * used. (Moved verbatim from Dashboard.jsx.)
 */
export function projectedRouteResults(state, proj) {
  const { fleet = [], routes = [] } = state;
  const gd = currentGameDate(state);
  const rrById = {};
  for (const rr of proj.report?.routeResults ?? []) rrById[rr.routeId] = rr;
  const avgUtil = fleetAvgUtilization(fleet, [...routes, ...(state.cargoRoutes ?? [])]);
  return routes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    const result = !aircraft ? null
      : (rrById[route.id] ?? simulateRoute(
          // Lounge fields — without them this fallback quotes the full
          // third-party premium ground rate on a route the tick discounts.
          { ...route, ...stateLoungeFields(state, route.origin, route.destination), ...stateGroundHandlingFields(state, route.origin, route.destination), ...stateCateringFields(state, route) },
          aircraft, gd, state.labor ?? null, proj.fuelMultiplier, null, [], avgUtil, state.satisfaction ?? null));
    return { route, result };
  });
}

/**
 * The alert list, in priority order.
 *
 * @param {object} state
 * @param {object} proj          projectWeek(state)
 * @param {Array}  routeResults  projectedRouteResults(state, proj)
 * @returns {Array<{id, level: 'red'|'yellow', color, icon, text, to, filter?}>}
 */
export function airlineAlerts(state, proj, routeResults = projectedRouteResults(state, proj)) {
  const { cash = 0, fleet = [], routes = [], cargoRoutes = [], activeEvents = [] } = state;
  const typeOf = (a) => getAircraftType(a.typeId);
  const alerts = [];
  const add = (id, level, icon, text, to, filter) =>
    alerts.push({ id, level, color: level === 'red' ? 'var(--red)' : 'var(--yellow)', icon, text, to, ...(filter ? { filter } : {}) });

  // Crew FIRST. A parked aircraft is the one problem whose symptom (routes earning
  // less than the planner said) points everywhere except at its cause — "Why am I
  // not getting the full revenue from my routes?" was this (Discord 2026-09-29).
  const crewSt = crewStatus(state, typeOf);
  const crewAlert = crewParkedAlertText(crewSt);
  if (crewAlert) add('crew', crewSt.level === 'grounding' ? 'red' : 'yellow', AlertIcon, crewAlert, 'operations');

  // Reserves are parked deliberately — they don't belong in the idle-aircraft
  // alert (they have their own chip on the Fleet tab).
  const idleFleet = fleet.filter(a => a.status === 'idle' && !isReserve(a));
  if (idleFleet.length > 0) add('idle', 'yellow', AlertIcon, idleFleetAlertText(idleFleet), 'fleet', { filterChip: 'idle' });

  // True cash runway: only meaningful when you're burning cash. Matches Finance.
  const projectedProfit = proj.netIncomeAccrual;
  const weeksOfCash = projectedProfit < 0 && cash > 0 ? Math.floor(cash / -projectedProfit) : Infinity;
  if (isFinite(weeksOfCash) && weeksOfCash < 4)
    add('runway', 'red', DotIcon, `Only ${weeksOfCash} weeks of cash runway remaining`, 'finance');

  // The silent killer: routes are in the black, but fixed costs, financing and
  // tax flip the bottom line negative. Same figures as the Dashboard's P&L card:
  // route operating profit from the projection's routes + cargo, net = netCash.
  const r = proj.report;
  if (r) {
    const routeOp = (r.routeResults ?? []).reduce((s, rr) => s + (rr.profit ?? 0), 0) + (r.totalCargoProfit ?? 0);
    const net = proj.netCash;
    if (routeOp > 0 && net < 0)
      add('fixed', 'red', TrendDownIcon,
        `Routes earn +${formatMoney(routeOp)}/wk, but fixed costs, financing & tax turn that into ${formatMoney(net)}/wk · see Weekly P&L`,
        'finance');
  }

  // Count what the Routes tab's "losing" filter counts: CITY PAIRS, on the
  // profit basis the player has chosen, fixed costs included by default.
  const resultsById = {};
  for (const { route, result } of routeResults) if (result) resultsById[route.id] = result;
  const fixedByRoute = allocateFixedCosts({ routes, cargoRoutes, fleet, resultsById });
  const basis = loadProfitBasis();
  const byPair = {};
  for (const { route, result } of routeResults) {
    if (!result) continue;
    const key = `${route.origin}→${route.destination}`;
    byPair[key] = (byPair[key] ?? 0) + routeProfit(result, fixedByRoute[route.id] ?? 0, basis);
  }
  const losing = Object.values(byPair).filter(v => v < 0).length;
  if (losing > 0)
    add('losing', 'red', TrendDownIcon, `${losing} loss-making city pair${losing !== 1 ? 's' : ''} · consider repricing`,
      'routes', { filterTab: 'unprofitable' });

  // Lease expiry is the only recurring event that deletes revenue-producing
  // routes without the player doing anything.
  const expiring = leasesAtRisk(state, fleet);
  if (expiring.length > 0) {
    const soonest = expiring[0];
    add('leases', 'yellow', AlertIcon,
      `${expiring.length} lease${expiring.length !== 1 ? 's' : ''} expiring within ${leaseWarnPhrase(state)} (soonest ${soonest.name}, ${soonest.leaseRemainingWeeks}w) · ${leaseAutoRenewSetting(state).enabled ? 'marked let-expire — extend or buy out to keep them' : 'extend, buy out, turn on auto-renew, or their routes close'}`,
      'fleet', { filterChip: 'expiring' });
  }

  const bad = activeEvents.filter(e =>
    (e.effects?.fuelMult ?? 1) > 1 ||
    (e.effects?.globalDemandMult ?? 1) < 1 ||
    (e.effects?.regionDemandMult ?? 1) < 1);
  if (bad.length > 0) add('event', 'yellow', bad[0].icon, `${bad[0].name} active. Check Finance for impact`, 'finance');

  return alerts;
}

/** Alerts for the current state, off the shared projection. */
export function useAirlineAlerts(state) {
  return useMemo(() => {
    if (!state || state.phase !== 'playing') return [];
    try {
      return airlineAlerts(state, projectWeekShared(state));
    } catch {
      return [];   // an alert column is never worth the page
    }
  }, [state]);
}
