// The forecast for a route the weekly report SKIPPED (grounded tail, dormant
// season) — one version for every screen.
//
// Screens read route figures from the shared projection's routeResults. A route
// the tick did not fly has no row there, so each screen fell back to its own
// simulateRoute call, and the copies disagreed: Finance contested the pair's
// rivals and carried ancillaries; the Routes list, the Fleet panel, Route
// Detail and the alert scan passed no rivals at all, and none of them applied
// the world demand multiplier or the business cycle (audit 2026-11-09, A5). A
// grounded route on a contested pair therefore showed whole-market figures on
// one page and the split on another.
//
// Same inputs the tick hands simulateRoute: station/lounge/catering/loyalty/
// pricing fields from state, the pair's rival specs, fleet utilisation,
// satisfaction, the event × world × cycle demand multiplier, ancillaries.

import {
  simulateRoute, fleetAvgUtilization, currentGameDate,
  stateLoungeFields, stateGroundHandlingFields, stateCateringFields,
  stateLoyaltyFields, statePricingFields, stateTravelPartnerFields,
} from './simulation.js';
import { rivalSpecsFor, stateDemandMult } from '../../packages/engine/src/models/pairShare.js';
import { rivalIndexFor } from '../../packages/engine/src/models/network.js';

/**
 * @param {object} state
 * @param {object} route      a passenger route from state.routes
 * @param {object} aircraft   the tail assigned to it
 * @param {object} [opts]
 * @param {object} [opts.gameDate]        defaults to the state's current week
 * @param {number} [opts.fuelMultiplier]  the projection's (price × burn); default 1
 * @param {object} [opts.labor]           defaults to state.labor
 * @param {number} [opts.avgUtilization]  defaults to the fleet's
 * @param {number} [opts.eventMult]       event-only multiplier, if the caller has one
 * @param {object} [opts.demandOverride]  per-aircraft demand allocation, if any
 */
export function skippedRouteForecast(state, route, aircraft, opts = {}) {
  if (!state || !route || !aircraft) return null;
  const o = route.origin, d = route.destination;
  const gd = opts.gameDate ?? currentGameDate(state);
  const avgUtil = opts.avgUtilization
    ?? fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
  return simulateRoute(
    {
      ...route,
      ...stateLoungeFields(state, o, d),
      ...stateGroundHandlingFields(state, o, d),
      ...stateCateringFields(state, route),
      ...stateTravelPartnerFields(state, o, d),
      ...stateLoyaltyFields(state, o, d),
      ...statePricingFields(state, o, d),
    },
    aircraft, gd, opts.labor ?? state.labor ?? null, opts.fuelMultiplier ?? 1.0,
    opts.demandOverride ?? null,
    rivalSpecsFor(state, o, d), avgUtil, state.satisfaction ?? null,
    stateDemandMult(state, o, d, opts.eventMult),
    state.ancillaries ?? null, state.competitors ?? [], rivalIndexFor(state));
}
