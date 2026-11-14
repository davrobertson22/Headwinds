// ── A route's share of its aircraft's lease and maintenance ─────────────────
//
// The engine's per-route `trueProfit` charges the WHOLE aircraft's weekly lease
// and maintenance to every route the tail flies, so a plane on two routes is
// charged twice. Every screen that shows a fully-loaded profit splits the cost
// instead, by block hours (src/utils/routeEconomics.js explains why block hours
// and why freight counts). This module is that split, moved into the engine so
// the Advisor and the airline briefing (both engine, both run on the server
// too) answer with the same number as the Routes screen they point at.
//
// Discord (Kat the Fox, 2026-11-14): the Advisor said "routes are full but
// losing money" on routes the Routes screen showed in profit.
//
// PURE: no React, no DOM.

import { getAircraftType } from '../data/aircraft.js';
import { maintenanceMultiplier, weeklyBlockHours, routeDistanceKm } from '../utils/simulation.js';
import { effectiveMaintAgeWeeks } from '../data/maintenance.js';

/**
 * A tail's weekly lease + maintenance.
 *
 * Prefers the engine's own figures off any route result for that aircraft —
 * those already carry the rate the tail SIGNED at (leases lock their rate on
 * delivery; the table's rate has since moved) and maintenance at its real age.
 * The fallback exists for aircraft the tick skips entirely: grounded tails and
 * dormant seasonal routes still owe rent.
 */
export function aircraftFixedWeekly(aircraft, resultForAircraft = null) {
  if (!aircraft) return 0;
  if (resultForAircraft &&
      (resultForAircraft.weeklyLeaseCost != null || resultForAircraft.weeklyMaintCost != null)) {
    return (resultForAircraft.weeklyLeaseCost ?? 0) + (resultForAircraft.weeklyMaintCost ?? 0);
  }
  const type  = getAircraftType(aircraft.typeId);
  const lease = aircraft.ownershipType === 'owned' ? 0 : (aircraft.weeklyLease ?? type?.weeklyLease ?? 0);
  const maint = Math.round((type?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(effectiveMaintAgeWeeks(aircraft)));
  return lease + maint;
}

/**
 * Split every aircraft's weekly fixed cost across the routes it flies.
 *
 * @param {object}  args
 * @param {array}   args.routes       passenger routes
 * @param {array}   args.cargoRoutes  freight routes — in the DENOMINATOR only;
 *                                    they consume the aircraft's hours, so they
 *                                    carry their share of its cost
 * @param {array}   args.fleet
 * @param {object}  args.resultsById  routeId -> engine result (optional)
 * @returns {object} routeId -> allocated weekly fixed cost (passenger AND cargo
 *                   route ids; the slices for one tail sum to that tail's cost)
 */
export function allocateFixedCosts({ routes = [], cargoRoutes = [], fleet = [], resultsById = {} }) {
  const all = [...routes, ...cargoRoutes];
  const byAircraft = new Map();   // aircraftId -> { fixed, totalBh, entries: [{id, bh}] }

  // First record per id, as fleet.find gave — one pass, not one per route.
  const tailById = new Map();
  for (const a of fleet) if (!tailById.has(a.id)) tailById.set(a.id, a);
  for (const r of all) {
    const ac = tailById.get(r.aircraftId);
    if (!ac) continue;
    let rec = byAircraft.get(ac.id);
    if (!rec) {
      rec = { fixed: aircraftFixedWeekly(ac, resultsById[r.id] ?? null), totalBh: 0, entries: [] };
      byAircraft.set(ac.id, rec);
    } else if (rec.fixed === 0 && resultsById[r.id]) {
      // A later route may carry engine figures the first one lacked.
      rec.fixed = aircraftFixedWeekly(ac, resultsById[r.id]);
    }
    const type = getAircraftType(ac.typeId);
    const bh   = type
      ? weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency ?? 0, type)
      : 0;
    rec.totalBh += bh;
    rec.entries.push({ id: r.id, bh });
  }

  const out = {};
  for (const rec of byAircraft.values()) {
    // A grounded tail, or one whose every route is dormant, flies zero hours —
    // but still owes its lease. Spread it evenly rather than dropping it, or the
    // cost silently leaves the network total the moment a plane stops flying.
    const even = rec.entries.length > 0 ? rec.fixed / rec.entries.length : 0;
    for (const e of rec.entries) {
      out[e.id] = rec.totalBh > 0 ? (rec.fixed * e.bh) / rec.totalBh : even;
    }
  }
  return out;
}
