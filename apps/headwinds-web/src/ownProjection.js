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
//   • which edits may borrow the old projection — only ones that leave the
//     airline the same SHAPE (the same routes, freight routes and aircraft, in
//     the same order). Screens read the projection row by row against the
//     state; a borrowed projection with a row for a route that no longer
//     exists, or none for one that now does, is not "slightly stale", it is
//     wrong. Opening or closing a route, buying or selling an aircraft: those
//     project on the spot, as before.
//   • which states on screen are carrying a borrowed projection, so they are
//     never left that way.

import { hydrateState } from '../../../src/store/GameContext.jsx';
import { carryProjectWeek } from '../../../src/utils/financeProjection.js';

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
  if (!sameShape(prev, next)) return false;
  if (!carryProjectWeek(hydrateState(prev), hydrateState(next))) return false;
  borrowed.add(next);
  return true;
}

/**
 * A copy of a state for the same screen content (a screen-only change): if the
 * original was on a borrowed projection, so is the copy.
 */
export function inheritBorrowed(from, to) {
  if (hasBorrowedProjection(from) && to && typeof to === 'object') borrowed.add(to);
}
