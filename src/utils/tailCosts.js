// What ONE aircraft's line maintenance costs this week — the tick's figure.
//
// weeklyTick charges base × age curve × maintenance budget × the maintenance
// team's labour multiplier × the tail's own mod × the fleet mod × the best hub
// or jet-base discount, plus a reserve's readiness premium, and reports it per
// tail in report.fleetCosts. The Fleet page printed base × age alone, so with
// the budget at 1.30× (the setting that books checks automatically) every row,
// card and tile on it read about 23% under what Finance showed for the same
// aeroplane (audit 2026-11-09, A3).
//
// Read from the shared projection (projectWeek is memoised per state object,
// so this costs nothing extra). A tail the report does not carry falls back to
// the same product without the facility discount.

import { projectWeek } from './financeProjection.js';
import { maintenanceMultiplier } from './simulation.js';
import { getAircraftType } from '../data/aircraft.js';
import { effectiveMaintAgeWeeks } from '../data/maintenance.js';
import { laborEffects } from '../data/labor.js';

const _memo = new WeakMap();

/** The fallback: the tick's product for a tail it did not report. */
export function estimatedTailMaintenance(state, aircraft) {
  const type = getAircraftType(aircraft?.typeId);
  if (!type) return 0;
  const { maintenanceCostMultiplier = 1 } = laborEffects(state?.labor ?? null);
  return Math.round((type.baseMaintenancePerWk ?? 0)
    * maintenanceMultiplier(effectiveMaintAgeWeeks(aircraft))
    * (state?.maintenanceBudget ?? 1.0) * maintenanceCostMultiplier * (aircraft.maintMod ?? 1.0));
}

/** (aircraft) => weekly line maintenance in dollars, as the tick bills it. */
export function tailMaintenanceFn(state) {
  if (state && typeof state === 'object') {
    const hit = _memo.get(state);
    if (hit) return hit;
  }
  let byId = null;
  const fn = (aircraft) => {
    if (!aircraft) return 0;
    if (byId === null) {
      byId = new Map();
      let costs = [];
      try { costs = projectWeek(state)?.report?.fleetCosts ?? []; } catch { costs = []; }
      for (const c of costs) if (c?.aircraftId != null) byId.set(c.aircraftId, c.maintenance ?? 0);
    }
    const v = byId.get(aircraft.id);
    return v != null ? v : estimatedTailMaintenance(state, aircraft);
  };
  if (state && typeof state === 'object') _memo.set(state, fn);
  return fn;
}
