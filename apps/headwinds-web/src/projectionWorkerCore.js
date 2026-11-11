/**
 * What the projection worker does with a message — kept free of any worker API
 * so a test can drive it in a worker thread or in-process
 * (tools/projection-worker-test.mjs).
 *
 *   { id, op: 'project', state }            hold `state`, project it
 *   { id, op: 'overlay', baseId, overlay }  hold { ...held, ...overlay }, project it
 *       → { id, proj }
 *       → { id, missing: true }   overlay against a state this worker doesn't hold
 *       → { id, error }
 *
 * `state` is the RAW state the client is about to adopt (what GamePlayScreen
 * passes to RemoteGameProvider). The projection is of hydrateState(state) —
 * the object every screen calls projectWeek with — after the same world knobs
 * the page sets (syncEngineWorldState) and the reducer sets on every action
 * (era calendar year, event bonus airports). A worker is its own module world:
 * none of the page's module-level engine settings reach it otherwise.
 */
import { hydrateState, syncEngineWorldState } from '../../../src/store/GameContext.jsx';
import { projectWeek } from '../../../src/utils/financeProjection.js';
import { setEraCalendarYear } from '../../../src/utils/market.js';
import { calendarYear } from '../../../src/utils/simulation.js';
import { pinEventBonusFrom } from '../../../src/data/eventRules.js';
import { recordOwnMetalCuts, takeOwnMetalCuts } from '../../../packages/engine/src/models/network.js';

export function prepareWorldKnobs(state) {
  syncEngineWorldState(state);
  setEraCalendarYear(calendarYear(state));
  pinEventBonusFrom(state);
}

export function createProjectionWorkerCore() {
  let heldId = null;
  let held = null;
  // The hub cuts this thread works out go back with each projection, so the
  // page does not have to enumerate the same hubs again on the player's first
  // click (engine: models/network.js, "Handing cuts from one thread to another").
  recordOwnMetalCuts(true);
  return function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.id == null) return null;
    let state;
    if (msg.op === 'project') state = msg.state;
    else if (msg.op === 'overlay') {
      if (msg.baseId !== heldId || !held) return { id: msg.id, missing: true };
      state = { ...held, ...msg.overlay };
    } else return null;
    heldId = msg.id;
    held = state;
    try {
      prepareWorldKnobs(state);
      const proj = projectWeek(hydrateState(state));
      const cuts = takeOwnMetalCuts();
      return cuts.length > 0 ? { id: msg.id, proj, cuts } : { id: msg.id, proj };
    } catch (e) {
      return { id: msg.id, error: String(e?.message ?? e) };
    }
  };
}
