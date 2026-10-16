// The live standings columns on Airline (rankings rework, 2026-10-15).
//
// One mapping from a save blob to the six columns the world page's player list
// sorts on, shared by every writer — the tick, joining, re-founding and the
// backfill tool — so they can never disagree about what a column means. The
// numbers themselves come from @tailwinds/engine utils/standings.js.
import { liveStatsOf } from '@tailwinds/engine/utils/standings.js';

const safeInt = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
};

/** Prisma `data` for the live-stat columns, from engine liveStatsOf() output. */
export function liveStatColumnsFrom(live) {
  return {
    rankScore: BigInt(safeInt(live?.rankScore)),
    weeklyProfit: BigInt(safeInt(live?.weeklyProfit)),
    netAssets: BigInt(safeInt(live?.netAssets)),
    paxWeek: safeInt(live?.paxWeek),
    flightsWeek: safeInt(live?.flightsWeek),
    fleetSize: safeInt(live?.fleetSize),
  };
}

/**
 * Prisma `data` for the live-stat columns of one airline state.
 * @param {object} state       the airline's save blob
 * @param {number} weeksFlown  weeks the WORLD has completed (sets the ranking window)
 */
export function liveStatColumns(state, weeksFlown) {
  return liveStatColumnsFrom(liveStatsOf(state, { weeksFlown }));
}

/** The world's completed weeks, from its clock (which points at the week about to be flown). */
export function weeksFlownOf(world) {
  return Math.max(0, ((world?.currentYear ?? 1) - 1) * 52 + (world?.currentWeek ?? 1) - 1);
}
