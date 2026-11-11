import { committedRoutesByAircraft } from '../../packages/engine/src/utils/simulation.js';

/**
 * One tail's own routes — the ones it flies or a reserve is covering for it —
 * without walking the route tables for every tail asked about.
 *
 * routesCommittedTo(id, routes, cargoRoutes) scans both tables for the one
 * tail it is given. A page that asks about every tail in turn (the Routes
 * page's "which aircraft have hours left", the planners' aircraft pickers, the
 * Fleet list) pays fleet × routes: 20 million steps a render at 4,900 tails
 * and 4,000 routes, half a second on the Routes page alone (measured
 * 2026-11-11). The tables are indexed once per pair of arrays instead and each
 * tail is handed only its own lists.
 *
 * Every engine helper that takes (aircraftId, …, routes, cargoRoutes) and
 * starts from routesCommittedTo gives the same answer on a tail's own lists
 * as on the whole tables — those are exactly the records it keeps, in table
 * order — so the call sites pass `mine.pax, mine.cargo` and nothing else
 * changes.
 */
const NONE = Object.freeze([]);
const NO_TAIL = Object.freeze({ pax: NONE, cargo: NONE });
const INDEX = new WeakMap();   // routes array -> WeakMap(cargo array -> Map(tailId -> { pax, cargo }))

function indexFor(routes, cargoRoutes) {
  let byCargo = INDEX.get(routes);
  if (!byCargo) { byCargo = new WeakMap(); INDEX.set(routes, byCargo); }
  let index = byCargo.get(cargoRoutes);
  if (!index) { index = committedRoutesByAircraft(routes, cargoRoutes); byCargo.set(cargoRoutes, index); }
  return index;
}

/** { pax, cargo } for one tail, in table order. Empty lists for a tail with nothing. */
export function tailRoutesIn(routes, cargoRoutes, aircraftId) {
  return indexFor(routes ?? NONE, cargoRoutes ?? NONE).get(aircraftId) ?? NO_TAIL;
}

/** The same from a game state. */
export function tailRoutesOf(state, aircraftId) {
  return tailRoutesIn(state?.routes, state?.cargoRoutes, aircraftId);
}

/** routesCommittedTo's list for one tail: passenger routes, then cargo. */
export function tailCommitted(routes, cargoRoutes, aircraftId) {
  const mine = tailRoutesIn(routes, cargoRoutes, aircraftId);
  return mine.cargo.length ? [...mine.pax, ...mine.cargo] : mine.pax;
}
