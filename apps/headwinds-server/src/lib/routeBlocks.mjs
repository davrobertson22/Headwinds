// Route pre-flight: turn an engine refusal into a sentence the player reads.
//
// The engine reducer refuses a route it cannot open by returning the SAME state
// object and setting nothing. In the solo game that is a dead click; in
// Headwinds it is worse — routes/decisions.mjs re-runs the reducer, gets an
// unchanged state, and answers 201 { ok: true }, so the client's optimistic
// route disappears on the next poll with nothing said anywhere. That is the
// multiplayer face of the reported "Open Route does nothing" and
// "edits don't save / new routes don't save" complaints.
//
// ADD_ROUTE has had addRouteBlockReason() as its single gate for a while, and
// decisions.mjs pre-flights it. ADD_CARGO_ROUTE and ADD_TAG_ROUTE had no
// equivalent — twelve and thirteen bare `return state`s respectively, every one
// of them silent. The engine now exports a helper for each; this module is the
// one place that knows which action maps to which, so the endpoint has a single
// call site and a new route type cannot be added without passing through here.
//
// Deliberately free of prisma/env imports so it can be unit-tested directly
// (tools/route-block-reason-test.mjs) — importing routes/decisions.mjs would
// instantiate the Prisma client and require a DATABASE_URL.
//
// NOTE ON THE IMPORT PATH: the `@tailwinds/engine/reducer` entrypoint is a thin
// barrel that re-exports a fixed list of names, and the two new helpers are not
// on it. Importing the canonical module directly resolves to the same file (npm
// workspaces symlink packages/engine, and Node resolves symlinks by default), so
// there is exactly one module instance either way. Move this to the barrel when
// that file is next touched.
import {
  addRouteBlockReason,
  addCargoRouteBlockReason,
  addTagRouteBlockReason,
} from '../../../../packages/engine/src/reducer.mjs';

/**
 * Why the engine would refuse this route-opening action, or null if it would
 * accept it. Any action type that is not a route open returns null — this must
 * never speak for a decision it does not understand.
 *
 * @param {string} type    the validated action type
 * @param {object} state   the rival-injected state the reducer will run on
 * @param {object} action  the guarded action ({ type, ...payload })
 * @returns {string|null}
 */
export function routeBlockReasonFor(type, state, action) {
  switch (type) {
    case 'ADD_ROUTE':       return addRouteBlockReason(state, action);
    case 'ADD_CARGO_ROUTE': return addCargoRouteBlockReason(state, action);
    case 'ADD_TAG_ROUTE':   return addTagRouteBlockReason(state, action);
    default:                return null;
  }
}
