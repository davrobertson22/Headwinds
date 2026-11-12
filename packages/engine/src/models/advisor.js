// ── Airline Advisor — rule-based recommendations off the airline's own data ───
//
// PRD on Discord (2026-11-07): "an AI manager that looks at your airline's
// current situation and gives you tips and recommendations … new routes, fleet
// changes, or ways to improve profits". VodkaOnFire's reply was the design
// brief: the game already knows everything a good adviser would say, it just
// never says it out loud — idle and under-flown aircraft, routes that sell out
// or run empty, heavy checks nobody booked, crowded gates.
//
// This module is that adviser. It is DIFFERENT from the Dashboard's alert strip
// (src/utils/airlineAlerts.js): an alert names a problem ("2 idle aircraft",
// "3 loss-making city pairs"); a piece of advice names the lever, says why, and
// points at the screen that pulls it. Where an alert already covers a fact the
// advice adds the action the alert does not (idle tails → Route Finder for that
// type), it does not repeat the count.
//
// PURE: (state, report) in, a list out. No React, no DOM, no localStorage — the
// Headwinds server runs it for the read-only API (apps/headwinds-server
// routes/agentApi.mjs) on the stored weekly report, and the client runs it on
// the same projection the Dashboard's alerts use (projectWeekShared), so the
// in-game panel and the Dashboard read one set of route figures.
//
// NOTHING HERE FORECASTS A ROUTE. Every route figure is read off a report the
// tick (or projectWeek, which IS the tick) produced. Suggesting a new route
// means a market-share forecast, and those must go through the shared helpers
// in models/pairShare.js; the Route Finder already does exactly that, so the
// adviser deep-links into it with the aircraft type rather than guessing.

import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { isReserve, isCoverRoute } from '../data/reserve.js';
import { dueInfo, autoSchedulingActive, AUTO_SCHEDULE_PAY_MIN, AUTO_SCHEDULE_BUDGET_MIN } from '../data/maintenance.js';
import { crewStatus } from '../data/labor.js';
import { relativePay } from './talentMarket.js';
import { outstandingBalance } from '../data/credit.js';
import {
  routeStops, aircraftUtilization, committedRoutesByAircraft, maxWeeklyBlockHoursFor, currentGameDate, formatMoney,
} from '../utils/simulation.js';
import { slotUsageFor, slotCapAt } from '../reducer.mjs';

export const ADVISOR_VERSION = 1;

// ── Thresholds ───────────────────────────────────────────────────────────────
// Exported so the tests (and anyone tuning) read one set of numbers.
export const ADVISOR = {
  soldOutLF:        0.95,  // a pair this full that the demand model capped is turning people away
  fullButLosingLF:  0.85,  // full, yet losing money after lease + maintenance → fares under cost
  emptyLF:          0.50,  // Routes ▸ "Low load" uses the same line
  rampWeeks:        16,    // routeMaturityFactor reaches 1 at 16 weeks; younger routes are still building
  spareHoursMin:    30,    // a tail with this many block hours free a week can take real flying
  slotsTightPct:    0.90,  // above 90% of slots the gate fee carries the congestion surcharge
  lowAwareness:     35,    // brand awareness (0-100) below which unfunded marketing is costly
  fuelShareMin:     0.25,  // fuel at a quarter of costs or more is worth showing what a spike costs
  loanCashCover:    2,     // cash this many times the debt, while profitable, makes repaying worth a look
  maxItems:         5,     // names listed per piece of advice
};

const PRIORITY_LABEL = { 1: 'Act now', 2: 'Worth doing', 3: 'Consider' };
export const advicePriorityLabel = (p) => PRIORITY_LABEL[p] ?? 'Consider';

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const typeName = (id) => getAircraftType(id)?.name ?? id;
const absWeekOf = (s) => (((s?.year ?? 1) - 1) * 52) + (s?.week ?? 1);

/** "JFK–LHR" for a route, every stop of a tag flight included. */
export function routeLabel(route) {
  return routeStops(route).join('–');
}

/**
 * One row per city pair (or tag rotation): the routes flying it, summed.
 * Several tails on one pair are one market to the player, and the Routes tab
 * groups them the same way — listing JFK–LHR three times would read as three
 * problems.
 */
export function pairRollup(state, report) {
  const byId = new Map();
  for (const rr of report?.routeResults ?? []) byId.set(rr.routeId, rr);
  const groups = new Map();
  for (const route of state?.routes ?? []) {
    if (isCoverRoute(route)) continue;
    const rr = byId.get(route.id);
    if (!rr) continue;                       // grounded, dormant or uncrewed this week — nothing to judge
    const key = routeLabel(route);
    const g = groups.get(key) ?? {
      key, label: key, routeIds: [], revenue: 0, profit: 0, trueProfit: 0,
      pax: 0, seats: 0, capped: false, youngest: Infinity,
    };
    g.routeIds.push(route.id);
    g.revenue    += rr.revenue ?? 0;
    g.profit     += rr.profit ?? 0;
    g.trueProfit += rr.trueProfit ?? rr.profit ?? 0;
    const seats = rr.configuredSeatsOneWay ?? 0;
    g.seats += seats;
    g.pax   += seats > 0 ? (rr.loadFactor ?? 0) * seats : (rr.passengers ?? 0);
    g.capped = g.capped || rr.capacityCapped === true;
    g.youngest = Math.min(g.youngest, route.weeksOpen ?? Infinity);
    groups.set(key, g);
  }
  return [...groups.values()].map(g => ({
    ...g,
    loadFactor: g.seats > 0 ? g.pax / g.seats : 0,
    ramping: Number.isFinite(g.youngest) && g.youngest < ADVISOR.rampWeeks,
  }));
}

// ── The rules ────────────────────────────────────────────────────────────────
// Each returns zero or more advice objects:
//   { id, priority 1-3, category, title, detail, items?: [{label, value}],
//     impact?: signed weekly $ (an estimate, labelled as such), action?: {label, to, filter?, focus?} }
// `to` is a classic tab id (src/navPath.js) so the client can deep-link with
// requestNav; the server's briefing prints the matching path instead.

function adviceFullButLosing(pairs) {
  const hits = pairs
    .filter(p => !p.ramping && p.loadFactor >= ADVISOR.fullButLosingLF && p.trueProfit < 0)
    .sort((a, b) => a.trueProfit - b.trueProfit);
  if (hits.length === 0) return [];
  const loss = hits.reduce((s, p) => s + p.trueProfit, 0);
  return [{
    id: 'full-but-losing', priority: 1, category: 'network',
    title: `${plural(hits.length, 'route')} ${hits.length === 1 ? 'is' : 'are'} full but losing money`,
    detail: `Loads of ${pct(ADVISOR.fullButLosingLF)} or more and still in the red after lease and maintenance: `
      + `the fares are below what the seats cost to fly. Raising fares in small steps loses a few passengers `
      + `and gains margin on every one who stays; if the pair is contested, check the fare cliff on Route Detail first.`,
    items: hits.slice(0, ADVISOR.maxItems).map(p => ({ label: p.label, value: `${pct(p.loadFactor)} full · ${formatMoney(p.trueProfit)}/wk` })),
    impact: loss,
    action: { label: 'Open loss-making routes', to: 'routes', filter: { filterTab: 'unprofitable' } },
  }];
}

function adviceSoldOut(pairs) {
  const hits = pairs
    .filter(p => p.capped && p.loadFactor >= ADVISOR.soldOutLF && p.trueProfit >= 0)
    .sort((a, b) => b.revenue - a.revenue);
  if (hits.length === 0) return [];
  return [{
    id: 'sold-out', priority: 2, category: 'network',
    title: `${plural(hits.length, 'route')} ${hits.length === 1 ? 'is' : 'are'} selling out`,
    detail: `More people want these seats than you fly. Either charge more (a sold-out flight is the cheapest `
      + `place to find margin) or add capacity: more frequency if the aircraft has hours free, or a bigger aircraft.`,
    items: hits.slice(0, ADVISOR.maxItems).map(p => ({ label: p.label, value: `${pct(p.loadFactor)} full · ${formatMoney(p.trueProfit)}/wk` })),
    action: { label: 'Open Routes', to: 'routes', filter: { filterTab: 'profitable' } },
  }];
}

function adviceEmptyAndLosing(pairs) {
  const hits = pairs
    .filter(p => !p.ramping && p.loadFactor < ADVISOR.emptyLF && p.trueProfit < 0)
    .sort((a, b) => a.trueProfit - b.trueProfit);
  if (hits.length === 0) return [];
  const loss = hits.reduce((s, p) => s + p.trueProfit, 0);
  return [{
    id: 'empty-and-losing', priority: 2, category: 'network',
    title: `${plural(hits.length, 'route')} ${hits.length === 1 ? 'flies' : 'fly'} mostly empty at a loss`,
    detail: `Under ${pct(ADVISOR.emptyLF)} full and losing money: too many seats for the market. Cut frequency, `
      + `move a smaller aircraft onto it, or close it and put the tail somewhere better. `
      + `Routes younger than ${ADVISOR.rampWeeks} weeks are left out — they are still building demand.`,
    items: hits.slice(0, ADVISOR.maxItems).map(p => ({ label: p.label, value: `${pct(p.loadFactor)} full · ${formatMoney(p.trueProfit)}/wk` })),
    impact: loss,
    action: { label: 'Open low-load routes', to: 'routes', filter: { filterTab: 'lowload' } },
  }];
}

function adviceIdleTypes(state) {
  const idle = (state?.fleet ?? []).filter(a => a.status === 'idle' && !isReserve(a));
  if (idle.length === 0) return [];
  const byType = new Map();
  for (const a of idle) byType.set(a.typeId, [...(byType.get(a.typeId) ?? []), a]);
  return [...byType.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([typeId, tails]) => ({
      id: `idle-${typeId}`, priority: 1, category: 'fleet',
      title: `Find routes for ${tails.length === 1 ? 'your idle' : `your ${tails.length} idle`} ${typeName(typeId)}${tails.length === 1 ? '' : 's'}`,
      detail: `A parked aircraft still bills its lease or ownership costs. The Route Finder opens on this type, `
        + `already filtered to what it can reach and land at, with a profit forecast per market.`,
      items: tails.slice(0, ADVISOR.maxItems).map(a => ({ label: a.name ?? a.id, value: a.ownershipType === 'lease' ? 'leased' : 'owned' })),
      action: { label: `Find routes for the ${typeName(typeId)}`, to: 'finder', filter: { typeId } },
    }));
}

function adviceSpareHours(state) {
  const cap = maxWeeklyBlockHoursFor(state);
  const month = currentGameDate(state)?.month ?? null;
  const hits = [];
  // Each tail's own routes, indexed once: utilisation walks the tables it is
  // given, and the whole tables for every tail is fleet × routes.
  const committed = committedRoutesByAircraft(state?.routes ?? [], state?.cargoRoutes ?? []);
  const NONE = [];
  for (const a of state?.fleet ?? []) {
    if (a.status !== 'assigned') continue;
    if (isReserve(a)) continue;
    const mine = committed.get(a.id);
    const u = aircraftUtilization({ aircraft: a, routes: mine?.pax ?? NONE, cargoRoutes: mine?.cargo ?? NONE, month, capHours: cap });
    if (u.routes.length === 0 || u.grounded) continue;
    const spare = cap - u.peakHours;
    if (spare >= ADVISOR.spareHoursMin) hits.push({ a, spare, used: u.peakHours });
  }
  if (hits.length === 0) return [];
  hits.sort((x, y) => y.spare - x.spare);
  return [{
    id: 'spare-hours', priority: 2, category: 'fleet',
    title: `${plural(hits.length, 'aircraft', 'aircraft')} ${hits.length === 1 ? 'has' : 'have'} ${ADVISOR.spareHoursMin}+ block hours a week to spare`,
    detail: `These tails are paid for all week but fly part of it (the cap is ${cap}h). Add frequency on `
      + `their best route, or give them a second route — the Route Planner shows what fits in the hours left.`,
    items: hits.slice(0, ADVISOR.maxItems).map(h => ({ label: `${h.a.name ?? h.a.id} (${typeName(h.a.typeId)})`, value: `${Math.round(h.used)}h used · ${Math.round(h.spare)}h free` })),
    action: { label: 'Open Fleet', to: 'fleet' },
  }];
}

function adviceChecks(state) {
  if (autoSchedulingActive(state?.labor, state?.maintenanceBudget)) return [];
  const absWeek = absWeekOf(state);
  const hits = [];
  for (const a of state?.fleet ?? []) {
    if (a.status === 'maintenance' || a.status === 'retired' || a.scheduledCheck) continue;
    const type = getAircraftType(a.typeId);
    if (!type) continue;
    const d = dueInfo(a, type, absWeek);
    if (d.state === 'ok') continue;
    hits.push({ a, d });
  }
  if (hits.length === 0) return [];
  const rank = { overdue: 0, due: 1, soon: 2 };
  hits.sort((x, y) => rank[x.d.state] - rank[y.d.state]);
  const overdue = hits.filter(h => h.d.state === 'overdue').length;
  return [{
    id: 'checks-due', priority: overdue > 0 ? 1 : 2, category: 'maintenance',
    title: overdue > 0
      ? `${plural(overdue, 'aircraft', 'aircraft')} past the grace period on a heavy check`
      : `${plural(hits.length, 'heavy check')} coming due with nothing booked`,
    detail: `An unbooked check past its grace period gets the aircraft parked by the regulator: longer downtime, `
      + `a costlier check and a reputation hit. Book them on the Maintenance page — or let the airline book them itself: `
      + `pay the maintenance team at least ${AUTO_SCHEDULE_PAY_MIN}× market and set the maintenance budget to at least `
      + `${AUTO_SCHEDULE_BUDGET_MIN}×, and every check that comes due is started automatically at the planned cost.`,
    items: hits.slice(0, ADVISOR.maxItems).map(h => ({
      label: `${h.a.name ?? h.a.id} (${typeName(h.a.typeId)})`,
      value: h.d.state === 'overdue' ? `${h.d.forcedType} check overdue`
        : h.d.state === 'due' ? `${h.d.primaryDue} check due`
        : `${h.d.soonType} check due soon`,
    })),
    action: { label: 'Open Maintenance', to: 'maintenance' },
  }];
}

function adviceSlots(state) {
  const usage = slotUsageFor(state);
  const hits = [];
  for (const code of Object.keys(state?.gates ?? {})) {
    const cap = slotCapAt(state, code);
    if (cap <= 0) continue;
    const used = usage.get(code) ?? 0;
    if (used / cap >= ADVISOR.slotsTightPct) hits.push({ code, used, cap });
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => (b.used / b.cap) - (a.used / a.cap));
  const full = hits.filter(h => h.used >= h.cap).length;
  return [{
    id: 'slots-tight', priority: full > 0 ? 2 : 3, category: 'gates',
    title: `${plural(hits.length, 'airport')} at ${pct(ADVISOR.slotsTightPct)}+ of your slots`,
    detail: `Above ${pct(ADVISOR.slotsTightPct)} the gate fee carries a congestion surcharge, and at 100% you cannot add `
      + `a single flight there. Another gate lifts both — usually worth it at a hub you are still growing.`,
    items: hits.slice(0, ADVISOR.maxItems).map(h => ({ label: `${h.code}${getAirport(h.code)?.city ? ` (${getAirport(h.code).city})` : ''}`, value: `${h.used}/${h.cap} slots` })),
    action: { label: 'Open Gates', to: 'airports' },
  }];
}

function adviceCrewPay(state) {
  const st = crewStatus(state, (a) => getAircraftType(a.typeId));
  if (!st || st.level === 'ok') return [];
  const low = st.groups
    .map(g => ({ g, rel: relativePay(state, g.id, state?.labor?.[g.id]?.payMultiplier) }))
    .filter(x => x.rel < 1);
  if (low.length === 0) return [];
  return [{
    id: 'crew-pay', priority: st.level === 'grounding' ? 1 : 2, category: 'crew',
    title: `You are short of crew and paying under the going rate`,
    detail: `Recruits go to whoever pays best: below the market rate your hiring queue clears slowly while `
      + `aircraft sit short-handed. Bringing pay up to the market rate speeds up recruiting for these groups.`,
    items: low.map(x => ({ label: x.g.name, value: `${x.g.missing.toLocaleString()} short · pay ${Math.round(x.rel * 100)}% of market` })),
    action: { label: 'Open Crew', to: 'operations' },
  }];
}

function adviceMarketing(state) {
  const routes = (state?.routes ?? []).length;
  if (routes < 3) return [];
  const awareness = Number(state?.awareness ?? 0);
  const funded = (Number(state?.marketingBudget) || 0) > 0 || state?.marketingPctOfRevenue != null;
  if (funded || awareness >= ADVISOR.lowAwareness) return [];
  return [{
    id: 'marketing', priority: 2, category: 'marketing',
    title: `Brand awareness is ${Math.round(awareness)}/100 with no marketing budget`,
    detail: `Awareness gates how many travellers consider you at all, on every route. Brand marketing builds it `
      + `slowly and it decays without spend — setting it as a share of revenue keeps it growing with the airline.`,
    action: { label: 'Open Marketing', to: 'reputation', focus: 'marketing-budget' },
  }];
}

function adviceFuel(state, report) {
  const fuel = Number(report?.totalFuel) || 0;
  const cost = Number(report?.totalCost) || 0;
  if (fuel <= 0 || cost <= 0) return [];
  const share = fuel / cost;
  const now = absWeekOf(state);
  const hedged = (state?.hedgeContracts ?? []).some(h => (h?.expiryAbsWeek ?? Infinity) > now);
  if (share < ADVISOR.fuelShareMin || hedged) return [];
  return [{
    id: 'fuel-exposure', priority: 3, category: 'finance',
    title: `Fuel is ${pct(share)} of your costs, unhedged`,
    detail: `Every 10% rise in the fuel index costs you about ${formatMoney(Math.round(fuel * 0.1))} a week at today's flying. `
      + `A hedge locks part of your burn at a known price; the Fuel page shows the index, your burn and the contracts on offer.`,
    impact: -Math.round(fuel * 0.1),
    action: { label: 'Open Fuel', to: 'finance', filter: { view: 'fuel' } },
  }];
}

function adviceDebt(state) {
  const loans = (state?.loans ?? []).filter(l => (l?.weeksRemaining ?? 0) > 0);
  if (loans.length === 0) return [];
  const owed = loans.reduce((s, l) => s + outstandingBalance(l), 0);
  const cash = Number(state?.cash) || 0;
  const recent = (state?.financialHistory ?? []).slice(-4);
  const profitable = recent.length >= 4 && recent.every(h => (h?.profit ?? 0) > 0);
  if (owed <= 0 || !profitable || cash < owed * ADVISOR.loanCashCover) return [];
  const weeklyInterest = loans.reduce((s, l) => s + outstandingBalance(l) * (Number(l.interestRate) || 0) / 52, 0);
  return [{
    id: 'repay-debt', priority: 3, category: 'finance',
    title: `You could clear ${formatMoney(owed)} of loans from cash`,
    detail: `You hold ${formatMoney(cash)} and have been profitable for four straight weeks. Early repayment costs a 2% `
      + `fee on what is left but stops about ${formatMoney(Math.round(weeklyInterest))} a week of interest — unless the cash `
      + `has a better job (aircraft, gates, a hub).`,
    impact: Math.round(weeklyInterest),
    action: { label: 'Open Loans', to: 'finance', filter: { view: 'loans' } },
  }];
}

function adviceAncillaries(state) {
  if (state?.ancillaries != null) return [];
  if ((state?.routes ?? []).length < 3) return [];
  return [{
    id: 'ancillaries', priority: 3, category: 'network',
    title: `No ancillaries policy set`,
    detail: `Bags, seat selection and the rest are revenue on top of the fare. Until you choose a policy you collect none of it.`,
    action: { label: 'Open Ancillaries', to: 'ancillaries' },
  }];
}

/**
 * Every piece of advice for this airline, most urgent first.
 *
 * @param {object} state   the airline's state blob
 * @param {object} report  a weekly report — projectWeek(state).report in the
 *                         client (what the Dashboard reads), the stored
 *                         lastReport on the server. May be null; the
 *                         route-figure rules then simply say nothing.
 */
export function airlineAdvice(state, report = state?.lastReport ?? null) {
  if (!state || state.phase !== 'playing') return [];
  const pairs = pairRollup(state, report);
  const out = [];
  const rules = [
    () => adviceIdleTypes(state),
    () => adviceChecks(state),
    () => adviceCrewPay(state),
    () => adviceFullButLosing(pairs),
    () => adviceEmptyAndLosing(pairs),
    () => adviceSoldOut(pairs),
    () => adviceSpareHours(state),
    () => adviceSlots(state),
    () => adviceMarketing(state),
    () => adviceFuel(state, report),
    () => adviceDebt(state),
    () => adviceAncillaries(state),
  ];
  for (const rule of rules) {
    // One broken rule (an odd old save) must never cost the player the rest.
    try { out.push(...rule()); } catch { /* skip this rule */ }
  }
  // Stable: priority first, then the order the rules are listed in.
  return out
    .map((a, i) => ({ ...a, priorityLabel: advicePriorityLabel(a.priority), _i: i }))
    .sort((a, b) => a.priority - b.priority || a._i - b._i)
    .map(({ _i, ...a }) => a);
}
