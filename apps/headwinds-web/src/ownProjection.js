// The player's own edit, projected off the main thread.
//
// Every screen asks projectWeek(state) synchronously, and a click makes a new
// state. So after the rival polls and new weeks had moved to the projection
// worker, the player's own actions were the one thing that still ran the
// engine's week on the main thread: 0.2–0.7 s of frozen page per click on the
// biggest airlines, after everything else had been made cheap (2026-11-10).
//
// Now a click's state goes on screen at once carrying the PREVIOUS projection
// (the figures are one edit old for a moment), the worker projects it, and the
// same state is put up again with the real one. GamePlayScreen runs that; this
// module holds the two decisions it turns on:
//
//   • what the new state borrows. An edit that leaves the airline the same
//     SHAPE (the same routes, freight routes and aircraft, in the same order)
//     takes the old projection as it is. One that changes the shape (a route
//     opened or closed, an aircraft bought, sold, leased or returned) takes it
//     with the rows for routes and aircraft that no longer exist taken out
//     (projectionForShape): screens look every row up by id, so a row for
//     something gone would be read as real, while a route or aircraft with no
//     row yet gets the same stand-in figures a grounded route gets until the
//     worker's projection lands. Those used to project on the spot: a 0.7–1.2 s
//     freeze per click on a 4,900-tail airline, nearly all of it the projection
//     (2026-11-12). The totals stay one edit old for that moment, as they do
//     for a fare change.
//   • which states on screen are carrying a borrowed projection, so they are
//     never left that way.

import { hydrateState } from '../../../src/store/GameContext.jsx';
import { carryProjectWeek, peekProjectWeek, primeProjectWeek } from '../../../src/utils/financeProjection.js';

const sameIds = (a, b) => {
  if (a === b) return true;
  const x = a ?? [], y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i]?.id !== y[i]?.id) return false;
  return true;
};

/** Same week, and the same routes, freight routes and aircraft in the same order. */
export function sameShape(prev, next) {
  if (!prev || !next) return false;
  if (prev.week !== next.week || prev.year !== next.year) return false;
  return sameIds(prev.routes, next.routes)
    && sameIds(prev.cargoRoutes, next.cargoRoutes)
    && sameIds(prev.fleet, next.fleet);
}

// States whose cached projection was borrowed from the state before them.
const borrowed = new WeakSet();
/** Is this state on a borrowed (one edit old) projection? */
export function hasBorrowedProjection(state) {
  return !!state && typeof state === 'object' && borrowed.has(state);
}
/** The state has been replaced by one with its own projection (or is being). */
export function settleBorrowed(state) {
  if (state && typeof state === 'object') borrowed.delete(state);
}

/**
 * Let `next` (the reducer's result for an edit of `prev`) go on screen with
 * prev's projection. Returns true when it was arranged — the caller then owes
 * `next` a real projection. False means nothing was done and the screens will
 * project `next` themselves: prev had no projection yet, the edit changed the
 * airline's shape, or it changed nothing.
 */
export function borrowProjection(prev, next) {
  if (!prev || !next || prev === next) return false;
  if (prev.week !== next.week || prev.year !== next.year) return false;
  const from = hydrateState(prev), to = hydrateState(next);
  if (sameShape(prev, next)) {
    if (!carryProjectWeek(from, to)) return false;
  } else {
    const proj = peekProjectWeek(from);
    if (!proj || !primeProjectWeek(to, projectionForShape(proj, next))) return false;
  }
  borrowed.add(next);
  return true;
}

// The keyed-by-route and keyed-by-aircraft parts of a projection, with the
// rows for routes and aircraft `state` no longer has taken out. Everything
// else (the totals, the per-hub and per-pair tables) is carried as it is.
const keep = (rows, field, ids) => {
  if (!Array.isArray(rows)) return rows;
  const out = rows.filter(r => ids.has(r?.[field]));
  return out.length === rows.length ? rows : out;
};
const keepKeys = (obj, ids) => {
  if (!obj || typeof obj !== 'object') return obj;
  let out = null;
  for (const k of Object.keys(obj)) {
    if (ids.has(k)) continue;
    if (!out) out = { ...obj };
    delete out[k];
  }
  return out ?? obj;
};
/** A projection of an airline one edit ago, trimmed to the routes and aircraft it has now. */
export function projectionForShape(proj, state) {
  if (!proj || typeof proj !== 'object') return proj;
  const routeIds = new Set();
  for (const r of state?.routes ?? []) routeIds.add(r?.id);
  for (const r of state?.cargoRoutes ?? []) routeIds.add(r?.id);
  const tailIds = new Set();
  for (const a of state?.fleet ?? []) tailIds.add(a?.id);
  const rep = proj.report;
  const report = rep && typeof rep === 'object' ? {
    ...rep,
    routeResults:         keep(rep.routeResults, 'routeId', routeIds),
    cargoRouteResults:    keep(rep.cargoRouteResults, 'routeId', routeIds),
    fleetCosts:           keep(rep.fleetCosts, 'aircraftId', tailIds),
    reserveStandby:       keep(rep.reserveStandby, 'aircraftId', tailIds),
    mroFactorsByAircraft: keepKeys(rep.mroFactorsByAircraft, tailIds),
  } : rep;
  // A report the projection never had a field of keeps not having it.
  if (report && rep) for (const k of ['routeResults', 'cargoRouteResults', 'fleetCosts', 'reserveStandby', 'mroFactorsByAircraft']) {
    if (!(k in rep)) delete report[k];
  }
  return { ...proj, report, revById: keepKeys(proj.revById, routeIds) };
}

/**
 * A copy of a state for the same screen content (a screen-only change): if the
 * original was on a borrowed projection, so is the copy.
 */
export function inheritBorrowed(from, to) {
  if (hasBorrowedProjection(from) && to && typeof to === 'object') borrowed.add(to);
}
