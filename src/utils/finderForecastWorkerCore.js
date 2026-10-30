/**
 * What a Route Finder forecast worker does with a message — kept free of any
 * worker API so a test can drive it in-process (tools/finder-worker-pool-test).
 *
 *   { type: 'state', id, state }        hold this state; later jobs name it by id
 *   { type: 'price', jobId, stateId, ctx, rows }
 *       → { type: 'result', jobId, results: [[key, projection|null], ...] }
 *       → { type: 'result', jobId, missing: true }   when stateId is not the one held
 *
 * `ctx` is finderForecastContext's INPUT ({ aircraftTypeId, aircraft,
 * weeklyFrequency, gameDate, capHours }); the context is rebuilt here so the
 * worker prices with the identical sum the main thread would.
 */
import { finderForecastContext, forecastCandidate } from '../models/routeFinder.js';
import { setDemandModel } from './market.js';
import { setMarketDev } from '../models/marketDev.js';

export function createForecastWorkerCore() {
  let heldId = null;
  let held = null;
  return function handle(msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.type === 'state') {
      heldId = msg.id;
      held = msg.state;
      return null;
    }
    if (msg.type === 'price') {
      if (msg.stateId !== heldId || !held) return { type: 'result', jobId: msg.jobId, missing: true };
      // A worker is its own module world: the page's demand knobs (demand
      // model, market development) never reach it, so set them from the held
      // state before pricing.
      setDemandModel(held.demandModel);
      setMarketDev(held);
      const ctx = finderForecastContext(msg.ctx);
      const results = (msg.rows ?? []).map((r) => {
        try { return [r.key, forecastCandidate(held, r, ctx)]; }
        catch { return [r.key, null]; }
      });
      return { type: 'result', jobId: msg.jobId, results };
    }
    return null;
  };
}
