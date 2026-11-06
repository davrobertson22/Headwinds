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

export function prepareWorldKnobs(state) {
  syncEngineWorldState(state);
  setEraCalendarYear(calendarYear(state));
  pinEventBonusFrom(state);
}

export function createProjectionWorkerCore() {
  let heldId = null;
  let held = null;
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
      return { id: msg.id, proj: projectWeek(hydrateState(state)) };
    } catch (e) {
      return { id: msg.id, error: String(e?.message ?? e) };
    }
  };
}
