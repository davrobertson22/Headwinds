// A decision answered with what it changed, not with the whole airline.
//
// The whole state is 19–22 MB for the largest airlines and a fare change
// alters one route in it (engine utils/statePatch.js has the measurements). A
// client that says which version of its airline it holds, and holds the
// version the action was applied to, is sent the difference instead: the keys
// and table rows the reducer replaced.
//
// The difference is cut against the state the CLIENT was given — what GET
// /airline serves, own half only (stored state, report and logo back in place,
// withRivals' two seeded fields) — not against the reducer's input, which also
// carries things the server put there for the reducer alone (event rules, the
// trade ticket's market view). Those reach the client exactly as they did when
// the whole state was sent: as keys it does not have yet.
//
// The rival overlay is left out unless the reducer replaced part of it: the
// client keeps the overlay it has and its next poll brings the current one.
import { diffState } from '@tailwinds/engine/utils/statePatch.js';
import { withRivals, rivalOverlay } from './humanRivals.mjs';
import { joinReport } from './reportColumn.mjs';
import { injectLogo } from './logoColumn.mjs';

/** Does this request ask for a lean reply the server can give? */
export function wantsLeanReply(query, airline) {
  return query?.lean === '1' && query?.base === String(airline.version);
}

/**
 * @param airline   the row the action was applied to (state, report, logo, version)
 * @param injected  the state the reducer was handed
 * @param next      the state it returned
 * @param view      the rival view injected into `injected`
 * @returns {{ base: number, version: number, patch: object }}
 */
export function leanReply({ airline, injected, next, view }) {
  const held = withRivals(injectLogo(joinReport(airline.state, airline.report), airline.customLogo, airline.customTail), null);
  // Overlay keys start from what the reducer was handed, so only one it
  // actually replaced is sent.
  for (const k of Object.keys(rivalOverlay(view))) held[k] = injected[k];
  const full = injectLogo(next, airline.customLogo, airline.customTail);
  return { base: airline.version, version: airline.version + 1, patch: diffState(held, full) };
}
