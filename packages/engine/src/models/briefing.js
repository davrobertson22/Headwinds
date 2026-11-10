// ── Airline briefing — the player's own airline as text an AI can read ────────
//
// The other half of PRD's "AI manager" ask (Discord 2026-11-07), the half that
// costs nothing to run: VodkaOnFire's point was that players already have an AI
// of their own, so the game only has to make the airline legible to it. The
// in-game "Copy airline briefing" button puts this on the clipboard; the
// supporters' read-only API (apps/headwinds-server routes/agentApi.mjs) serves
// the same text to a connected Claude or ChatGPT.
//
// WHAT IT CONTAINS: only the player's OWN airline — figures every one of their
// own screens already shows them — plus the Advisor's list (models/advisor.js),
// so the AI starts from the game's diagnosis rather than re-deriving it. Rival
// airlines appear only as the per-route rival COUNT the route list shows; no
// rival's private figures go in.
//
// SIZE: an airline with 600 routes must still fit in a chat box, so every list
// is capped (top / bottom N) with a line saying how many were left out.
//
// PURE and DOM-free: the client and the server render byte-identical text for
// the same (state, report).

import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { isReserve, isCoverRoute } from '../data/reserve.js';
import { LABOR_GROUPS } from '../data/labor.js';
import { goingRate } from './talentMarket.js';
import { outstandingBalance } from '../data/credit.js';
import { referencePrice } from '../utils/market.js';
import {
  formatMoney, formatGameDate, routeStops, aircraftUtilization, maxWeeklyBlockHoursFor, currentGameDate,
} from '../utils/simulation.js';
import { slotUsageFor, slotCapAt } from '../reducer.mjs';
import { airlineAdvice, routeLabel } from './advisor.js';

export const BRIEFING_VERSION = 2;   // v2 (2026-11-09): "Where things are in the game" + exact screen paths on advice
export const BRIEFING_LIMITS = { topRoutes: 12, bottomRoutes: 8, cargoRoutes: 8, airports: 12, types: 20, history: 8 };

const HUB_TIER = { 0: 'focus city', 1: 'hub', 2: 'major hub', 3: 'gateway hub' };

// Where a tab lives, for a reader who is not in the game. The client passes
// src/navPath.js navPathFor; this fallback keeps the engine import-free of UI.
const FALLBACK_PATH = {
  routes: 'Network ▸ Routes', finder: 'Network ▸ Route Finder', planner: 'Network ▸ Route Planner',
  fleet: 'Fleet ▸ Fleet', maintenance: 'Company ▸ Maintenance', airports: 'Airports ▸ Gates',
  operations: 'Company ▸ Operations', finance: 'Finance', ancillaries: 'Company ▸ Ancillaries',
};

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
const money = (n) => formatMoney(Math.round(Number(n) || 0));
const cell = (v) => String(v ?? '').replace(/\|/g, '/');
const typeName = (id) => getAircraftType(id)?.name ?? id;

function table(headers, rows) {
  if (rows.length === 0) return '_none_';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

/**
 * The briefing as Markdown.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {object} [opts.report]      weekly report to read route figures from
 *                                    (default state.lastReport — last week as flown)
 * @param {string} [opts.reportLabel] how to describe that report ('last week')
 * @param {Array}  [opts.advice]      precomputed airlineAdvice(state, report)
 * @param {object} [opts.world]       { name, pace } — multiplayer context, optional
 * @param {(tab: string) => string} [opts.pathFor] tab id → "Group ▸ Page" (fallback when no actionPath)
 * @param {(action: object) => string} [opts.actionPath] an advice action → its exact
 *                                    screen, sub-page and filter (src/screenGuide.js actionPathText)
 * @param {Array<{classic, map, what}>} [opts.screens] where every page is
 *                                    (src/screenGuide.js screenGuide). vrt1ty, Discord
 *                                    2026-11-09: an AI that is only told "Finance" cannot
 *                                    tell a beginner where fuel hedging is.
 */
export function airlineBriefing(state, opts = {}) {
  if (!state || state.phase !== 'playing') return 'This airline has not started flying yet.';
  const report = opts.report ?? state.lastReport ?? null;
  const reportLabel = opts.reportLabel ?? 'last week';
  const advice = opts.advice ?? airlineAdvice(state, report);
  const pathFor = (tab) => opts.pathFor?.(tab) ?? FALLBACK_PATH[tab] ?? tab;
  const whereIs = (action) => opts.actionPath?.(action) ?? pathFor(action.to);
  const screens = opts.screens ?? null;
  const L = BRIEFING_LIMITS;
  const out = [];

  const dateText = (() => { try { return formatGameDate(state); } catch { return `Week ${state.week}, Year ${state.year}`; } })();
  out.push(`# Airline briefing: ${state.airlineName || 'Unnamed airline'}`);
  out.push('');
  out.push(`Game date: ${dateText}${opts.world?.name ? ` · World: ${opts.world.name}` : ''}${opts.world?.pace ? ` (${opts.world.pace})` : ''}`);
  out.push('');
  out.push(`_This is a snapshot of the player's own airline in Headwinds/Tailwinds, an airline-management game. `
    + `All money is in-game dollars; flows are per game week. Route figures are ${reportLabel}'s, as simulated by the game. `
    + `"Profit" on a route is after its fuel, crew, fees, lease and maintenance but before airline-wide overheads. `
    + `Load factor (LF) is seats filled. The "Advisor" section is the game's own rule-based diagnosis. `
    + `Changes are made by the player in the game. Screen paths use the game's own names, "Group ▸ Page"`
    + `${screens ? `; the last section says where every page is, in both the classic layout and the map view, so you can tell the player exactly where to click` : ''}._`);
  out.push('');

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const fleet = (state.fleet ?? []).filter(a => a.status !== 'retired');
  const routes = (state.routes ?? []).filter(r => !isCoverRoute(r));
  const cargo = state.cargoRoutes ?? [];
  const hubs = Object.entries(state.hubs ?? {});
  const loans = (state.loans ?? []).filter(l => (l?.weeksRemaining ?? 0) > 0);
  const owed = loans.reduce((s, l) => s + outstandingBalance(l), 0);
  const hist = (state.financialHistory ?? []).slice(-L.history);
  const last = hist[hist.length - 1] ?? null;

  out.push('## Snapshot');
  out.push(`- Cash: ${money(state.cash)}${owed > 0 ? ` · Loans outstanding: ${money(owed)} (${loans.length})` : ' · No loans'}`);
  if (last) {
    out.push(`- Last completed week: revenue ${money((last.revenue ?? 0) + (last.cargoRevenue ?? 0))}, costs ${money(last.totalCost)}, `
      + `net profit ${money(last.profit)}, passengers ${Math.round(last.passengers ?? 0).toLocaleString('en-US')}`);
  }
  if (hist.length >= 2) out.push(`- Net profit, last ${hist.length} weeks (oldest first): ${hist.map(h => money(h.profit)).join(', ')}`);
  out.push(`- Hubs: ${hubs.length ? hubs.map(([c, h]) => `${c} (${HUB_TIER[h?.tier] ?? 'hub'})`).join(', ') : (state.hub || 'none')}`);
  out.push(`- Network: ${routes.length} passenger route${routes.length === 1 ? '' : 's'}, ${cargo.length} freight route${cargo.length === 1 ? '' : 's'}`);
  const idle = fleet.filter(a => a.status === 'idle' && !isReserve(a)).length;
  const down = fleet.filter(a => a.status === 'maintenance' || a.status === 'grounded').length;
  out.push(`- Fleet: ${fleet.length} aircraft (${idle} idle, ${down} in maintenance or grounded), ${(state.pendingOrders ?? []).length} on order`);
  if (state.awareness != null) out.push(`- Brand awareness: ${Math.round(state.awareness)}/100${state.satisfaction != null ? ` · Passenger satisfaction: ${Math.round(state.satisfaction)}/100` : ''}`);
  out.push('');

  // ── Advisor ───────────────────────────────────────────────────────────────
  out.push('## Advisor');
  if (advice.length === 0) out.push('_Nothing flagged this week._');
  for (const a of advice) {
    out.push(`- **[${a.priorityLabel}] ${a.title}.** ${a.detail}${a.action ? ` (Where: ${whereIs(a.action)})` : ''}`);
    for (const it of a.items ?? []) out.push(`  - ${it.label}: ${it.value}`);
  }
  out.push('');

  // ── Routes ────────────────────────────────────────────────────────────────
  const byId = new Map((report?.routeResults ?? []).map(rr => [rr.routeId, rr]));
  const fleetById = new Map(fleet.map(a => [a.id, a]));
  const rows = routes.map(r => ({ r, rr: byId.get(r.id) ?? null }));
  const flown = rows.filter(x => x.rr).sort((a, b) => (b.rr.trueProfit ?? b.rr.profit ?? 0) - (a.rr.trueProfit ?? a.rr.profit ?? 0));
  const routeRow = ({ r, rr }) => {
    const ac = fleetById.get(r.aircraftId);
    const single = (r.stops?.length ?? 2) <= 2;
    const key = [r.origin, r.destination].sort().join('-');
    const fare = state.routePricing?.[key]?.economy;
    let ref = null;
    if (single) { try { ref = referencePrice(r.origin, r.destination); } catch { ref = null; } }
    return [
      routeLabel(r),
      ac ? typeName(ac.typeId) : '—',
      r.weeklyFrequency ?? 0,
      pct(rr.loadFactor),
      money(rr.revenue),
      money(rr.trueProfit ?? rr.profit),
      fare != null ? `${money(fare)}${ref ? ` (ref ${money(ref)})` : ''}` : '—',
      rr.competitorCount ?? 0,
      r.weeksOpen ?? '—',
    ];
  };
  const H = ['Route', 'Aircraft', 'Flights/wk', 'LF', 'Revenue/wk', 'Profit/wk', 'Economy fare', 'Rivals', 'Weeks open'];
  out.push(`## Passenger routes (${reportLabel})`);
  if (flown.length <= L.topRoutes + L.bottomRoutes) {
    out.push(table(H, flown.map(routeRow)));
  } else {
    out.push(`Best ${L.topRoutes} by profit:`);
    out.push(table(H, flown.slice(0, L.topRoutes).map(routeRow)));
    out.push('');
    out.push(`Worst ${L.bottomRoutes} by profit:`);
    out.push(table(H, flown.slice(-L.bottomRoutes).map(routeRow)));
    out.push(`_${flown.length - L.topRoutes - L.bottomRoutes} routes in between left out._`);
  }
  const notFlown = rows.length - flown.length;
  if (notFlown > 0) out.push(`_${notFlown} route${notFlown === 1 ? '' : 's'} did not fly ${reportLabel} (seasonal, grounded aircraft or no crew)._`);
  out.push('');

  if (cargo.length > 0) {
    const cById = new Map((report?.cargoRouteResults ?? []).map(rr => [rr.routeId, rr]));
    const cRows = cargo.map(r => ({ r, rr: cById.get(r.id) })).filter(x => x.rr)
      .sort((a, b) => (b.rr.profit ?? 0) - (a.rr.profit ?? 0)).slice(0, L.cargoRoutes)
      .map(({ r, rr }) => [routeLabel(r), typeName(fleetById.get(r.aircraftId)?.typeId), r.weeklyFrequency ?? 0, pct(rr.loadFactor), money(rr.revenue), money(rr.profit)]);
    out.push(`## Freight routes (${reportLabel}, best ${L.cargoRoutes})`);
    out.push(table(['Route', 'Freighter', 'Flights/wk', 'LF', 'Revenue/wk', 'Profit/wk'], cRows));
    out.push('');
  }

  // ── Fleet ─────────────────────────────────────────────────────────────────
  const types = new Map();
  for (const a of fleet) {
    const t = types.get(a.typeId) ?? { n: 0, idle: 0, leased: 0, age: 0, expiring: 0 };
    t.n++; t.age += a.ageWeeks ?? 0;
    if (a.status === 'idle' && !isReserve(a)) t.idle++;
    if (a.ownershipType === 'lease') {
      t.leased++;
      if (typeof a.leaseRemainingWeeks === 'number' && a.leaseRemainingWeeks > 0 && a.leaseRemainingWeeks <= 26) t.expiring++;
    }
    types.set(a.typeId, t);
  }
  out.push('## Fleet by type');
  out.push(table(['Type', 'Aircraft', 'Idle', 'Leased', 'Leases ending ≤26 wks', 'Avg age (yrs)', 'Range (km)', 'Seats (max)'],
    [...types.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, L.types).map(([id, t]) => {
      const ty = getAircraftType(id);
      return [typeName(id), t.n, t.idle, t.leased, t.expiring, (t.age / t.n / 52).toFixed(1), ty?.range ?? '—', ty?.seats ?? ty?.payloadTonnes ?? '—'];
    })));
  const orders = state.pendingOrders ?? [];
  if (orders.length) {
    const byType = new Map();
    for (const o of orders) byType.set(o.typeId, (byType.get(o.typeId) ?? 0) + 1);
    out.push(`On order: ${[...byType.entries()].map(([id, n]) => `${n}× ${typeName(id)}`).join(', ')}`);
  }
  out.push('');

  // ── Airports ──────────────────────────────────────────────────────────────
  const usage = slotUsageFor(state);
  const ap = Object.keys(state.gates ?? {}).map(code => ({ code, cap: slotCapAt(state, code), used: usage.get(code) ?? 0 }))
    .filter(x => x.cap > 0).sort((a, b) => b.used - a.used);
  out.push(`## Airports with gates (busiest ${Math.min(L.airports, ap.length)} of ${ap.length})`);
  out.push(table(['Airport', 'City', 'Gates', 'Weekly slots used'],
    ap.slice(0, L.airports).map(x => [x.code, getAirport(x.code)?.city ?? '', state.gates?.[x.code] ?? 0, `${x.used}/${x.cap} (${pct(x.used / x.cap)})`])));
  out.push('');

  // ── Settings ──────────────────────────────────────────────────────────────
  out.push('## Settings');
  const pay = LABOR_GROUPS
    .filter(g => state.labor?.[g.id])
    .map(g => `${g.name} ${(state.labor[g.id].payMultiplier ?? 1).toFixed(2)}× (market ${goingRate(state, g.id).toFixed(2)}×)`);
  if (pay.length) out.push(`- Pay: ${pay.join(', ')}`);
  out.push(`- Maintenance budget: ${(state.maintenanceBudget ?? 1).toFixed(2)}×`);
  out.push(`- Brand marketing: ${state.marketingPctOfRevenue != null ? `${pct(state.marketingPctOfRevenue)} of revenue` : `${money(state.marketingBudget ?? 0)}/wk`}`);
  out.push(`- Default catering: ${state.defaultCateringLevel ?? 'full'} · Ancillaries: ${state.ancillaries ? 'configured' : 'not set'}`);
  if (state.loyalty) out.push(`- Loyalty programme: ${money(state.loyalty.weeklyInvestment ?? 0)}/wk, ${Math.round(state.loyalty.members ?? 0).toLocaleString('en-US')} members`);
  if (state.allianceMembership?.allianceId) out.push(`- Alliance: ${state.allianceMembership.allianceName ?? state.allianceMembership.allianceId}`);
  out.push('');
  // ── Where things are ──────────────────────────────────────────────────────
  if (screens?.length) {
    out.push('## Where things are in the game');
    out.push('Classic layout: the menu bar along the top. Map view (opt-in): the dock along the bottom. Use these exact names when telling the player where to go.');
    out.push(table(['Classic layout', 'Map view', "What's there"],
      screens.map(sc => [sc.classic, sc.map ?? '—', sc.what])));
    out.push('');
  }
  out.push(`_Briefing format v${BRIEFING_VERSION}._`);
  return out.join('\n');
}

// ── Structured rows (the read-only API's list tools) ─────────────────────────
// The same figures the briefing's tables print, as JSON, uncapped but paged by
// the caller. Kept here so the table and the API can never disagree.

/** One row per passenger route, with its report figures (null when it did not fly). */
export function routeRows(state, report = state?.lastReport ?? null) {
  const byId = new Map((report?.routeResults ?? []).map(rr => [rr.routeId, rr]));
  const fleetById = new Map((state?.fleet ?? []).map(a => [a.id, a]));
  return (state?.routes ?? []).filter(r => !isCoverRoute(r)).map(r => {
    const rr = byId.get(r.id) ?? null;
    const ac = fleetById.get(r.aircraftId);
    const key = [r.origin, r.destination].sort().join('-');
    const single = (r.stops?.length ?? 2) <= 2;
    let ref = null;
    if (single) { try { ref = Math.round(referencePrice(r.origin, r.destination)); } catch { ref = null; } }
    return {
      routeId: r.id,
      route: routeLabel(r),
      stops: routeStops(r),
      aircraft: ac ? { id: ac.id, name: ac.name ?? null, type: typeName(ac.typeId) } : null,
      weeklyFrequency: r.weeklyFrequency ?? 0,
      weeksOpen: r.weeksOpen ?? null,
      fares: state?.routePricing?.[key] ?? null,
      referenceEconomyFare: ref,
      flew: !!rr,
      loadFactor: rr ? +(rr.loadFactor ?? 0).toFixed(3) : null,
      passengersOneWay: rr?.passengers ?? null,
      revenue: rr ? Math.round(rr.revenue ?? 0) : null,
      profit: rr ? Math.round(rr.trueProfit ?? rr.profit ?? 0) : null,
      soldOut: rr ? rr.capacityCapped === true : null,
      rivals: rr?.competitorCount ?? null,
    };
  });
}

/** One row per aircraft: what it is, what it flies, and how much of its week is used. */
export function fleetRows(state) {
  const cap = maxWeeklyBlockHoursFor(state);
  const month = currentGameDate(state)?.month ?? null;
  return (state?.fleet ?? []).filter(a => a.status !== 'retired').map(a => {
    let u = null;
    try { u = aircraftUtilization({ aircraft: a, routes: state.routes ?? [], cargoRoutes: state.cargoRoutes ?? [], month, capHours: cap }); } catch { u = null; }
    return {
      aircraftId: a.id,
      name: a.name ?? null,
      type: typeName(a.typeId),
      status: a.status,
      reserve: isReserve(a),
      ageYears: +((a.ageWeeks ?? 0) / 52).toFixed(1),
      ownership: a.ownershipType ?? null,
      leaseWeeksLeft: a.ownershipType === 'lease' && typeof a.leaseRemainingWeeks === 'number' ? a.leaseRemainingWeeks : null,
      routes: u ? u.routes.length : null,
      blockHoursUsed: u ? Math.round(u.peakHours) : null,
      blockHoursCap: cap,
    };
  });
}
