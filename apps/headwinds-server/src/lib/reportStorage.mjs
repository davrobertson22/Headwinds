// What of the weekly report is worth storing.
//
// `lastReport.partnerODRevenue.entries` is one row per partner-fed itinerary
// (origin, hub, destination, fare share, mileage…). Measured 2026-10-23: Ajax
// Air on Time Flies carried 22,955 of them — 5.7 MB of a 15 MB save, and
// 18 MB of the 182 MB of live Airline.state. Every decision that airline makes
// reads and rewrites the whole blob, every changed poll ships it, and its
// decisions had grown to 8-20 s — long enough to reach the 20 s transaction
// timeout that crashed the API 11 times that day (lib/processGuard.mjs).
//
// One screen reads the stored entries: AirportDetail, which sums `pax` over the
// entries whose `hub` is the airport on screen ("+N pax/wk via partner-fed
// connections"). The engine's projections read partner feed from a FRESH
// network tick (models/pairShare.js), never from lastReport. So the stored
// entries are folded to one per hub — the same per-hub sums, in the same field
// AirportDetail already reads — and the totals are kept as they are.
//
// Server-side, at the blob write, so the engine's output (and the golden
// master) is unchanged and the solo game is unaffected.

/** Fold partner O&D entries to one { hub, pax, playerRevenue } per hub. */
export function foldPartnerEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  const byHub = new Map();
  for (const e of entries) {
    if (!e || !e.hub) continue;            // no hub: no screen can attribute it
    const cur = byHub.get(e.hub) ?? { hub: e.hub, pax: 0, playerRevenue: 0 };
    cur.pax += Number(e.pax) || 0;
    cur.playerRevenue += Number(e.playerRevenue) || 0;
    byHub.set(e.hub, cur);
  }
  return [...byHub.values()];
}

/**
 * The state as it should be stored. Returns the SAME object when there is
 * nothing to fold, so a caller can compare by identity.
 */
export function compactReportForStorage(state) {
  const p = state?.lastReport?.partnerODRevenue;
  if (!p || !Array.isArray(p.entries) || p.folded === true) return state;
  return {
    ...state,
    lastReport: {
      ...state.lastReport,
      partnerODRevenue: { ...p, entries: foldPartnerEntries(p.entries), folded: true },
    },
  };
}
