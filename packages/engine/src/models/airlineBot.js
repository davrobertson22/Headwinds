// ── Airline bot — a rule-based manager that runs an airline with a player's actions ──
//
// Design: claude/background-competitors-plan.md ("AI Airlines (bot-run)", Dave,
// 2026-11-11). An AI airline in a Headwinds world is an ORDINARY airline: the
// same save, the same weekly tick, the same costs and demand as a player's. This
// module is the manager that sits where the player would. It reads the airline's
// state (with the rival view injected, the picture a player's screen has) and
// issues ordinary actions. It acts in its own interest: it opens routes that
// would make money, grows on its profits and cuts back when it loses.
//
// THREE RULES THIS FILE KEEPS
//
//   1. ONLY A PLAYER'S ACTIONS. The bot never writes to the state. Every change
//      goes through `apply(state, action)`, which the caller wires to the real
//      decision path (server: decisionGuard + the reducer; lab and tests: the
//      same pair). If the bot needs an advantage to survive, the bot is not good
//      enough yet — it does not get a rule of its own in the engine.
//
//   2. THE PLAYER'S OWN FORECAST. A candidate route is priced with
//      forecastLaunch (models/routeFinder.js), the number a Route Finder row
//      shows, itself the Route Planner's projectRouteAddition. CLAUDE.md:
//      previews must agree with the tick. A bot that judged routes by a
//      private model would open routes the tick then punishes.
//
//   3. BLIND TO WHO IS PLAYING. Its only inputs are its own airline and the rival
//      view. It is never given who is online, when anyone last played, or anyone's
//      rank, so it can neither avoid nor seek out an absent player's routes
//      (Dave, 2026-11-11: no protection for away players, and no targeting).
//      Do not add such an input.
//
// WHAT IT DOES EACH WEEK, in order (the CAUTIOUS tier — see BOT_TIERS):
//
//   1. cut      a mature route that loses money on its own flying and gates is
//               closed; an aircraft whose routes together do not cover its
//               rent, upkeep and crew for `lossWeeks` has its routes closed;
//   2. fares    a route that sells out puts its fare up a step, a mature route
//               flying half empty brings it down a step;
//   3. bridge   out of cash with a fleet that pays for itself: a loan to get
//               through it (never to fund growth);
//   4. upkeep   a heavy check that has come due is started;
//   5. staff    crew are hired ahead of deliveries (crew-pipeline worlds);
//   6. assign   an aircraft with flying hours to spare takes the best routes it
//               can fly from the hub, at the fare and frequency the forecast
//               likes best, with the gates they need;
//   7. shrink   an aircraft with nothing worth flying for `idleWeeksToReturn`
//               goes back to the lessor;
//   8. grow     another aircraft is leased only when the fleet is paying for
//               itself, a week of routes would more than pay for the new one,
//               and cash stays above a reserve.
//
// THREE LESSONS FROM THE LAB, all built in (tools/bot-lab.mjs reproduces them
// with --params):
//
//   Step 8 is the one that matters. The first prototype ordered whenever it
//   could afford the lease and every bot was bankrupt within 20 game weeks
//   (lease deposits, crew training and route launches land before the revenue
//   does) — the way most human newcomers go.
//
//   A route forecast is not an aircraft's profit. projectRouteAddition answers
//   "what would this route's flying earn"; it leaves out the aircraft's rent,
//   its maintenance, its salaried crew, its gates and what it adds to head
//   office. The second prototype leased 20-year-old A340s (cheap rent, $250K a
//   week of upkeep) onto 280 km hops, one route per aircraft at the reference
//   fare, and every airline failed with full aircraft. So a tail is judged on a
//   WEEK of routes against tailFixedCost(), a route carries its gates
//   (gateCostOf), and fares come from the forecast.
//
//   Heavy checks arrive in lumps. The third prototype survived a year on old
//   turboprops and then met their C and D checks together — unbooked, so the
//   regulator grounded them at half as much again. So checks are started when
//   due (step 4) and counted weekly in what a tail costs (heavyUpkeep).
//
// WHAT THE CAUTIOUS TIER DOES NOT DO: choose cabins or seat products, market,
// borrow to grow, open a second base, fly cargo, add a second aircraft to a route,
// answer codeshare or alliance requests. Those are the competent and expert tiers.
//
// PURE apart from `apply`: (state, memory) in, (state, memory, actions) out. The
// memory is plain JSON the caller persists between turns. No Math.random — the
// same state and memory always give the same decisions, so a retried tick
// repeats them.

import { AIRCRAFT_TYPES, getAircraftType, aircraftOrderable, lessorSupplies, eraWeeklyLease, eraDeliveredAgeWeeks, eraPurchasePrice } from '../data/aircraft.js';
import { checkRouteRestrictions } from '../data/airportRestrictions.js';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { weeklyFamilyBaseCost } from '../data/families.js';
import { LOAN_MIN_PRINCIPAL, borrowingCapacity, totalDebtOutstanding } from '../data/credit.js';
import { LABOR_GROUPS, crewAvailable, crewInTraining, crewRequiredAhead, crewScaleFor, reserveTarget,
         crewRequiredForOrderBook, crewBodies } from '../data/labor.js';
import {
  AOG_COST_PCT, C_COST_PCT, C_HOURS_DUE, C_WEEKS_DUE, D_COST_PCT, D_HOURS_DUE, D_WEEKS_DUE,
  aogAgeFactor, dueInfo, effectiveMaintAgeWeeks, isOutOfService, weeklyWearFailureProb,
} from '../data/maintenance.js';
import { calcHQCost, fleetHQScale } from '../data/overhead.js';
import { baseCityPairDemand, distanceKm, referencePrice, getDemandModel } from '../utils/market.js';
import {
  SLOTS_PER_GATE, calendarYear, defaultConfig, isMultiStop, maintenanceMultiplier, maxWeeklyBlockHoursFor,
  routeBlockHours, routePairKey, routesCommittedTo, weeklyGateFeeAt,
} from '../utils/simulation.js';
import { forecastLaunch } from './routeFinder.js';

export const BOT_MEMORY_VERSION = 2;

/**
 * Tier parameters. One bot, different appetites — the personalities and the
 * competent/expert tiers are further rows here, not further bots.
 */
export const BOT_TIERS = {
  cautious: {
    // ── cutting ──
    lossWeeks: 8,            // weeks of losses before a mature route (or tail) is cut
    rampWeeks: 16,           // a route still on its ramp is never judged
    skipWeeks: 26,           // a destination that lost money or was refused is left alone this long
    // ── fares ──
    fareGrid: [1, 1.5, 2],   // multiples of the reference fare every market is first forecast at
    fareStep: 0.05,          // weekly move on a route that sells out / flies empty
    fareUpLoad: 0.93,
    fareDownLoad: 0.6,
    fareMin: 0.8,            // floor and ceiling of the weekly moves, × reference fare
    fareMax: 2.5,
    fareFloor: 0.9,          // lowest opening fare tried, × reference fare
    // ── staff ──
    reserveLevel: 0.05,      // reserve staff held in every group, as a share of the requirement
    // ── cash ──
    bridgeBelowWeeks: 0.5,   // cash under this many weeks of costs, with a fleet that pays for itself: borrow …
    bridgeToWeeks: 1.5,      // … back up to this many weeks of costs
    bridgeEvery: 8,          // weeks between loans
    bridgeProducts: ['long', 'medium', 'short'],   // longest term first: the smallest weekly repayment
    // ── routes ──
    candidates: 24,          // markets forecast per aircraft type, biggest first
    rankWeeks: 4,            // how long a type's ranking of open markets is reused …
    rankKeep: 8,             // … unless fewer than this many of its markets are still open
    sweepMarkets: 8,         // markets looked at per type when every leasable type is compared
    houseFareRoutes: 80,     // with this many routes, a new market is first looked at at the airline's usual fare only
    effortRoutes: 80,        // candidates, refine and plans per turn halve at this many routes, and so on …
    effortFloor: 0.25,       // … down to this share
    firstFrequency: 14,      // flights a week every market is first forecast at
    refine: 4,               // routes per plan that get the frequency search
    fareRefineStep: 0.25,    // … then the leaders are tried a step either side, at each frequency
    frequencies: [7, 14, 21, 28],
    minFrequency: 3,         // long-haul: at least this many a week or not at all
    hoursMargin: 2,          // block hours kept free on every tail
    minSpareHours: 10,       // a tail with less spare than this is full
    maxRoutesPerTail: 6,
    maxAssignPerTurn: 4,     // routes opened per week
    recheckWeeks: 4,         // a tail that found nothing more to fly is asked again this often
    minDistKm: 250,
    rangeMargin: 0.9,        // fly to 90% of book range
    minDemand: 300,
    availability: 0.95,      // share of the year a tail is not in a hangar
    planHours: 95,           // block hours a week a planned tail is assumed to fly (for its check intervals)
    // ── fleet ──
    maxPending: 2,           // aircraft on order at once …
    pendingPerFleet: 0.15,   // … or this share of the fleet, whichever is more
    ordersPerFleet: 0.05,    // orders a week: one, plus this share of the fleet
    maxPlansPerTurn: 6,      // tails given a fresh week's plan per turn (the forecasts are the cost of a turn)
    minNetShare: 0.25,       // a new tail's week must clear its fixed costs by this share of them …
    trustStart: 0.8,         // … after its forecast is marked down by how its forecasts have turned out:
    trustMin: 0.3,           //   realised ÷ promised on its mature routes, inside these bounds,
    trustMax: 1.1,
    trustMinRoutes: 3,       //   once it has this many to judge by
    maxTypeAgeWeeks: Infinity,   // do not lease types the lessor delivers older than this
    reserveShare: 0.2,       // cash never ordered below this share of the founding capital …
    reserveCostWeeks: 1.5,   // … or this many weeks of total cost, whichever is more …
    reserveLossWeeks: 8,     // … plus this many weeks of the recent weekly loss, if it is losing
    earnWindow: 4,           // weeks the recent loss is averaged over
    earnFromFleet: 2,        // a start-up leases this many on its forecast; after that the fleet must be paying for itself
    proveWeeks: 8,           // a tail's routes must be this old before its results count as proof
    startupShare: 0.04,      // training + launch allowance per new aircraft, as a share of founding capital
    depositWeeks: 12,        // the lessor's deposit (aircraft.js LEASE_DEPOSIT_WEEKS)
    idleWeeksToReturn: 6,    // an aircraft idle this long with nothing to fly goes back
    typesEvery: 26,          // weeks between comparing every leasable type
    typeShortlist: 3,
    maxRentShare: 0.012,     // a type is affordable when a week's rent is at most this share of cash
    maxFixedShare: 0.035,    // … and its whole weekly fixed cost at most this share
  },
};

export function newBotMemory() {
  return { v: BOT_MEMORY_VERSION, started: false, loss: {}, tailLoss: {}, idle: {}, full: {}, skip: {}, optedOut: {}, types: null, typesAt: null, typesDue: null, typesCash: null, bridgeAt: null, ranks: {}, promised: {} };
}

const absWeekOf = (s) => (((Number(s?.year) || 1) - 1) * 52) + (Number(s?.week) || 1);
const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const typeOf = (a) => getAircraftType(a?.typeId);
const otherEnd = (r, hub) => (r.origin === hub ? r.destination : r.origin);

// How hard to look, by the size of the network. One forecast costs more the
// more routes there are (it re-works the connections through the hub: 0.4 ms
// at ten routes, 20 ms at two hundred), and a big airline has less to learn
// from each one, so it looks at fewer markets per question. At 135 aircraft the
// un-scaled bot took seconds a turn.
const effort = (state, P) => Math.max(P.effortFloor, Math.min(1, P.effortRoutes / ((state?.routes ?? []).length + P.effortRoutes)));
const scaled = (n, e, min) => Math.max(min, Math.round(n * e));
// The fare multiple this airline's routes actually sell at (median of fare ÷
// reference). A big airline first looks at a new market at that one fare, not
// three; the fare is still searched for the routes it picks. (Only a big one:
// switched on at five routes it cost young airlines 40% of their growth.)
function houseFare(state, P) {
  const ks = [];
  for (const r of state?.routes ?? []) {
    const ref = referencePrice(r.origin, r.destination); const fare = Number(state.routePricing?.[routePairKey(r.origin, r.destination)]?.economy);
    if (ref > 0 && fare > 0) ks.push(fare / ref);
  }
  if (ks.length < P.houseFareRoutes) return null;
  ks.sort((a, b) => a - b);
  return Math.min(P.fareMax, Math.max(P.fareFloor, Math.round(ks[Math.floor(ks.length / 2)] * 20) / 20));
}

// Markets from a hub, biggest first. Depends only on the hub and the world's
// demand model, so it is kept per process rather than in the bot's memory.
const _markets = new Map();
function marketsFrom(hubCode, P) {
  const key = `${hubCode}|${getDemandModel?.() ?? 1}|${P.minDemand}|${P.minDistKm}`;
  let list = _markets.get(key);
  if (!list) {
    const hub = getAirport(hubCode);
    list = !hub ? [] : AIRPORTS
      .filter((a) => a.code !== hubCode)
      .map((a) => ({ code: a.code, dist: distanceKm(hub, a), demand: baseCityPairDemand(hubCode, a.code) || 0 }))
      .filter((m) => m.dist >= P.minDistKm && m.demand >= P.minDemand)
      .sort((x, y) => y.demand - x.demand || (x.code < y.code ? -1 : 1));
    _markets.set(key, list);
    if (_markets.size > 400) _markets.delete(_markets.keys().next().value);
  }
  return list;
}

// Salaried staff one aircraft of `type` needs, a week (data/labor.js).
function labourFor(state, type) {
  return LABOR_GROUPS.reduce((s, g) => s + (g.baseWeeklyPerAircraft ?? 0) * crewScaleFor(g.id, type), 0);
}

// Heavy maintenance, as a weekly figure: the C and D checks a working aircraft
// comes due for (data/maintenance.js — a share of the airframe's price, every
// so many flying hours) and the repairs an airframe of this age can expect.
// It is billed in lumps, which is exactly why it has to be counted: a fleet of
// 20-year-old turboprops is cheap every week until the checks arrive together.
export function heavyUpkeep(state, type, ageWeeks, P = BOT_TIERS.cautious) {
  const price = eraPurchasePrice(type, calendarYear(state) ?? undefined);
  const cEvery = Math.min(C_WEEKS_DUE, C_HOURS_DUE / P.planHours);
  const dEvery = Math.min(D_WEEKS_DUE, D_HOURS_DUE / P.planHours);
  const midLife = { ageWeeks, hoursSinceC: C_HOURS_DUE / 2, hoursSinceD: D_HOURS_DUE / 2 };
  const repairs = weeklyWearFailureProb(midLife, type, Number(state?.maintenanceBudget) || 1) * AOG_COST_PCT.major * aogAgeFactor(midLife);
  return price * (C_COST_PCT / cEvery + D_COST_PCT / dEvery + repairs);
}

/**
 * What one MORE aircraft of `type` would cost a week whether or not it flies
 * well: rent, line and heavy maintenance at the age the lessor delivers it, its
 * salaried staff, and what it adds to head office and the maintenance-base
 * contracts. No route forecast carries any of these.
 */
export function tailFixedCost(state, type, P = BOT_TIERS.cautious) {
  if (!type) return Infinity;
  const fleet = state?.fleet ?? [];
  const cy = calendarYear(state);
  const plus = [...fleet, { typeId: type.id }];
  const age = eraDeliveredAgeWeeks(type, cy);
  const rent = eraWeeklyLease(type, cy);
  const maintenance = (Number(type.baseMaintenancePerWk) || 0) * maintenanceMultiplier(age) * (Number(state?.maintenanceBudget) || 1);
  const headOffice = Math.max(0, calcHQCost(fleetHQScale(plus, typeOf)) - calcHQCost(fleetHQScale(fleet, typeOf)));
  let bases = 0; try { bases = Math.max(0, weeklyFamilyBaseCost(plus) - weeklyFamilyBaseCost(fleet)); } catch { bases = 0; }
  return rent + maintenance + heavyUpkeep(state, type, age, P) + labourFor(state, type) + headOffice + bases;
}

/**
 * What an aircraft already in the fleet costs a week to keep: its rent, its
 * maintenance at its real age, its staff. (Head office is the airline's, not
 * the tail's: handing one aircraft back barely moves it.)
 */
export function tailCarryCost(state, aircraft, P = BOT_TIERS.cautious) {
  const type = typeOf(aircraft); if (!type) return 0;
  const rent = aircraft.ownershipType === 'owned' ? 0 : (aircraft.weeklyLease ?? type.weeklyLease ?? 0);
  const maintenance = (Number(type.baseMaintenancePerWk) || 0) * maintenanceMultiplier(effectiveMaintAgeWeeks(aircraft)) * (aircraft.maintMod ?? 1) * (Number(state?.maintenanceBudget) || 1);
  return rent + maintenance + heavyUpkeep(state, type, aircraft.ageWeeks ?? 0, P) + labourFor(state, type);
}

// Weekly departures already using gates at each airport.
function slotsUsed(state) {
  const used = {};
  for (const r of [...(state?.routes ?? []), ...(state?.cargoRoutes ?? [])]) {
    for (const code of new Set(r.stops ?? [r.origin, r.destination])) used[code] = (used[code] ?? 0) + (r.weeklyFrequency ?? 0);
  }
  return used;
}
const gatesHeld = (state, code) => (state?.gates ?? {})[code] ?? 0;
// Gates still to lease at `code` before `freq` more weekly flights fit.
const gatesShort = (state, used, code, freq) => Math.max(0, Math.ceil(((used[code] ?? 0) + freq) / SLOTS_PER_GATE) - gatesHeld(state, code));

/**
 * What `freq` more weekly flights to `code` would add to the gate bill. A route
 * forecast leaves gates out, and they are a young airline's biggest overhead
 * after fuel: a three-a-week route to a big airport can earn less than the gate
 * it needs. The far end pays for whole gates; the hub's are shared by every
 * route, so the route carries its share of the next one.
 */
export function gateCostOf(state, used, code, freq) {
  const hub = state?.hub;
  const there = gatesHeld(state, code); const short = gatesShort(state, used, code, freq);
  const far = short > 0 ? weeklyGateFeeAt(state, code, there + short) - weeklyGateFeeAt(state, code, there) : 0;
  const here = gatesHeld(state, hub);
  const home = (weeklyGateFeeAt(state, hub, here + 1) - weeklyGateFeeAt(state, hub, here)) * freq / SLOTS_PER_GATE;
  return far + home;
}

/** Block hours a week `aircraft` is already committed to. */
export function tailHoursUsed(state, aircraft) {
  const type = typeOf(aircraft); if (!type) return 0;
  return routesCommittedTo(aircraft.id, state?.routes ?? [], state?.cargoRoutes ?? [])
    .reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0);
}

/** How many forecasts the bot has asked for in this process — the lab reports it; nothing reads it to decide. */
export const botStats = { forecasts: 0, tag: 'other', by: {} };

// What a route would clear a week once mature, by the Route Finder's own sum
// (routeFinder.forecastLaunch): the Route Planner's forecast after landing
// fees, plus the connecting passengers it would feed through the hub, at the
// catering the airline's routes open with. The aircraft's rent is left out
// here — tailFixedCost and tailCarryCost count it once, per aircraft, not once
// per route. Null when it cannot be flown.
function forecast(state, aircraft, hub, code, freq, ticketPrice) {
  botStats.forecasts++; botStats.by[botStats.tag] = (botStats.by[botStats.tag] ?? 0) + 1;
  let f = null;
  try { f = forecastLaunch(state, { origin: hub, destination: code, aircraft, frameLease: 0, weeklyFrequency: freq, ticketPrice }); } catch { return null; }
  return Number.isFinite(f?.netProfit) ? f.netProfit : null;
}

/**
 * The open markets `aircraft` could fly from the hub, each at the fare the
 * Route Planner's forecast likes best for a full week's aircraft, ranked by
 * profit per block hour (hours are what a tail runs out of). Biggest unserved
 * markets in range only.
 *
 * The ranking is the expensive part of a turn — three forecasts a market — and
 * it barely moves from one week to the next, so it is kept in `memory.ranks`
 * per aircraft type for `rankWeeks` and reused: by every tail of that type, by
 * the aircraft on order, and by the decision to order another. Markets that
 * have since been opened or put on the leave-alone list are dropped on the way
 * out; the list is rebuilt when it runs short. (The first lab runs re-forecast
 * everything for every question: 240 forecasts a turn, 90% of them repeats.)
 *
 * @param {object} [opts]
 *   exclude     Set of destination codes to leave out (already planned)
 *   sweep       a short look (`sweepMarkets`), not kept: for comparing every leasable type
 * @returns {Array<{ code, freq, ticketPrice, profit, hours, perFlight, ref, k }>}
 */
export function rankOpenRoutes(state, aircraft, memory, P = BOT_TIERS.cautious, { exclude = null, sweep = false } = {}) {
  const type = typeOf(aircraft);
  const hub = state?.hub;
  if (!type || !hub) return [];
  const now = absWeekOf(state);
  const served = new Set((state.routes ?? []).map((r) => pairKey(r.origin, r.destination)));
  const open = (code) => !served.has(pairKey(hub, code)) && !((memory?.skip?.[code] ?? 0) > now);
  const give = (rows) => rows.filter((r) => !exclude?.has(r.code)).map((r) => ({ ...r, hours: r.perFlight * r.freq }));
  const held = memory?.ranks?.[type.id];
  const e = effort(state, P);
  const limit = sweep ? scaled(P.sweepMarkets, e, 2) : scaled(P.candidates, e, P.rankKeep);
  const house = houseFare(state, P);
  const grid = house == null ? P.fareGrid : [house];
  if (held && now >= held.at && now - held.at < P.rankWeeks) {
    const rows = held.rows.filter((r) => open(r.code));
    if (held.all || rows.length >= P.rankKeep) return give(rows);
  }
  const spare = maxWeeklyBlockHoursFor(state) - P.hoursMargin;
  if (!(spare > 0)) return [];
  const used = slotsUsed(state);
  const ops = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])];
  const out = []; let looked = 0; let all = true;
  for (const m of marketsFrom(hub, P)) {
    if (m.dist > (type.range ?? 0) * P.rangeMargin) continue;
    if (!open(m.code)) continue;
    const perFlight = routeBlockHours({ origin: hub, destination: m.code }, type, 1);
    if (!(perFlight > 0)) continue;
    const fits = Math.floor(spare / perFlight);
    if (fits < P.minFrequency) continue;
    const freq = Math.min(fits, P.firstFrequency);
    // Runway too short, stand too small, a perimeter rule: the forecast does not
    // know, the reducer does. Ask the same question it will.
    let barred = null;
    try { barred = checkRouteRestrictions(hub, m.code, m.dist, freq, type.category ?? null, { routes: ops, aircraftType: type }); } catch { barred = null; }
    if (barred) continue;
    if (++looked > limit) { all = false; break; }
    const ref = referencePrice(hub, m.code);
    let top = null;
    for (const k of grid) {
      const ticketPrice = Math.max(1, Math.round(ref * k));
      const flying = forecast(state, aircraft, hub, m.code, freq, ticketPrice);
      if (flying == null) continue;
      const profit = Math.round(flying * P.availability - gateCostOf(state, used, m.code, freq));
      if (profit > 0 && (!top || profit > top.profit)) top = { code: m.code, freq, ticketPrice, profit, perFlight: Math.round(perFlight * 1000) / 1000, ref, k };
    }
    if (top) out.push(top);
  }
  out.sort((x, y) => y.profit / (y.perFlight * y.freq) - x.profit / (x.perFlight * x.freq) || (x.code < y.code ? -1 : 1));
  if (memory && !sweep) { memory.ranks = memory.ranks ?? {}; memory.ranks[type.id] = { at: now, all, rows: out }; }
  return give(out);
}

/**
 * A week of routes for one aircraft: the ranked open markets taken in order
 * until its hours are gone. What a tail is worth is this, not its single best
 * route. For the first few, the frequency is searched too — an hour is priced at
 * what the next-best market would earn with it, so a deep market gets more
 * flights and a thin one fewer.
 * @returns {{ routes: Array<{code, freq, ticketPrice, profit, hours}>, profit: number, hours: number }}
 */
export function planTailWeek(state, aircraft, memory, P = BOT_TIERS.cautious, { exclude = null, quick = false, sweep = false, spareHours = null } = {}) {
  const hub = state?.hub;
  const used = slotsUsed(state);
  let spare = (spareHours ?? (maxWeeklyBlockHoursFor(state) - tailHoursUsed(state, aircraft)));
  if (spare - P.hoursMargin < P.minSpareHours) return { routes: [], profit: 0, hours: 0 };
  const ranked = rankOpenRoutes(state, aircraft, memory, P, { exclude, sweep });
  const rate = (x) => x.profit / x.hours;
  const hourPrice = ranked.length > P.maxRoutesPerTail ? rate(ranked[P.maxRoutesPerTail]) : 0;
  const routes = []; let profit = 0; let hours = 0; let refined = 0;
  for (const c of ranked) {
    if (routes.length >= P.maxRoutesPerTail || spare - P.hoursMargin < P.minSpareHours) break;
    const fits = Math.floor((spare - P.hoursMargin) / c.perFlight);
    if (fits < P.minFrequency) continue;
    let best = c.freq <= fits ? c : null;
    if (!quick && refined < scaled(P.refine, effort(state, P), 1)) {
      refined++;
      const freqs = P.frequencies.filter((f) => f <= fits);
      if (fits < Math.min(...P.frequencies)) freqs.push(fits);
      const value = (x) => x.profit - x.hours * hourPrice;
      for (const f of freqs) {
        for (const k of [c.k - P.fareRefineStep, c.k, c.k + P.fareRefineStep]) {
          if (f === c.freq && k === c.k) continue;
          if (k < P.fareFloor || k > P.fareMax + 1e-9) continue;
          const ticketPrice = Math.max(1, Math.round(c.ref * k));
          const flying = forecast(state, aircraft, hub, c.code, f, ticketPrice);
          if (flying == null) continue;
          const p = flying * P.availability - gateCostOf(state, used, c.code, f);
          if (p <= 0) continue;
          const cand = { ...c, freq: f, ticketPrice, profit: p, hours: c.perFlight * f, k };
          if (!best || value(cand) > value(best) + 1) best = cand;
        }
      }
    } else if (!best) {
      // The first-pass frequency no longer fits: take what does, pro rata.
      best = { ...c, freq: fits, profit: c.profit * fits / c.freq, hours: c.perFlight * fits };
    }
    if (!best) continue;
    routes.push({ code: best.code, freq: best.freq, ticketPrice: best.ticketPrice, profit: best.profit, hours: best.hours });
    profit += best.profit; hours += best.hours; spare -= best.hours;
  }
  return { routes, profit, hours };
}

/**
 * Every type this airline could lease today, best first, by what one more of
 * it would clear in a week of routes after everything it costs to have.
 * Affordable types only — rent and whole fixed cost a small share of cash — so
 * a young airline starts on small aircraft and bigger ones unlock as it earns.
 * @returns {Array<{ id, score, weekly }>}  score = weekly ÷ fixed cost; only types that would pay
 */
export function compareTypes(state, memory, P = BOT_TIERS.cautious, canLease = () => true) {
  const cy = calendarYear(state); const cash = Math.max(0, Number(state?.cash) || 0); const cap = maxWeeklyBlockHoursFor(state);
  return AIRCRAFT_TYPES
    .filter((t) => !t.freighter && !t.doubleDeck && (t.seats ?? 0) >= 20
      && aircraftOrderable(t, cy) && lessorSupplies(t, cy ?? undefined) && canLease(state, t.id)
      && eraDeliveredAgeWeeks(t, cy) <= P.maxTypeAgeWeeks
      && eraWeeklyLease(t, cy) <= cash * P.maxRentShare && tailFixedCost(state, t, P) <= cash * P.maxFixedShare)
    .map((t) => {
      const fixed = tailFixedCost(state, t, P);
      const probe = { id: '__bot_probe__', typeId: t.id, config: defaultConfig(t.seats), ageWeeks: eraDeliveredAgeWeeks(t, cy) };
      const weekly = planTailWeek(state, probe, memory, P, { quick: true, sweep: true, spareHours: cap }).profit - fixed;
      return { id: t.id, score: weekly / fixed, weekly: Math.round(weekly) };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
}

/**
 * How promising a start this airline has where it stands: the best first
 * aircraft and what it would clear a week. For choosing a hub before an AI
 * airline is founded (phase 3) — in the lab the one airline that keeps failing
 * is the one given the weakest hub, and no amount of care afterwards saves it.
 * Null when nothing leasable would pay its way from here.
 * @returns {{ typeId, score, weekly }|null}
 */
export function startProspect(state, { canLease = () => true, tier = 'cautious', params = null } = {}) {
  const P = { ...(BOT_TIERS[tier] ?? BOT_TIERS.cautious), ...(params ?? {}) };
  const best = compareTypes(state, newBotMemory(), P, canLease)[0];
  return best ? { typeId: best.id, score: best.score, weekly: best.weekly } : null;
}

/**
 * One turn of the bot.
 *
 * @param {object} state    the airline's state, rival view injected
 * @param {object} memory   what runBotTurn returned last week (or newBotMemory())
 * @param {object} deps
 *   apply(state, action) → state   the real decision path; may throw to refuse
 *   canLease(state, typeId) → bool the world's lease rules (reducer leaseDenial)
 *   explain(state, action) → string|null   why an ADD_ROUTE was refused (optional)
 *   tier                           a key of BOT_TIERS
 *   params                         overrides on top of the tier (the lab and the tests)
 * @returns {{ state, memory, actions: object[], refused: Array<{action, why}> }}
 */
export function runBotTurn(state, memory, { apply, canLease = () => true, explain = null, tier = 'cautious', params = null } = {}) {
  if (typeof apply !== 'function') throw new Error('runBotTurn needs apply(state, action)');
  const P = { ...(BOT_TIERS[tier] ?? BOT_TIERS.cautious), ...(params ?? {}) };
  const mem = { ...newBotMemory(), ...JSON.parse(JSON.stringify(memory ?? {})), v: BOT_MEMORY_VERSION };
  const actions = []; const refused = [];
  let st = state;
  if (!st || st.phase === 'bankrupt') return { state: st, memory: mem, actions, refused };
  const now = absWeekOf(st);

  // Apply one action and report whether it took, judged by `took(before, after)`.
  // The reducer refuses in two ways — the same reference, or a new state that
  // only carries a warning — so "did the state change" is not the test.
  const act = (action, took, whyFallback) => {
    const before = st; let next;
    try { next = apply(st, action); } catch (err) { refused.push({ action, why: err?.message ?? String(err) }); return false; }
    if (next == null) { refused.push({ action, why: whyFallback ?? 'refused' }); return false; }
    if (took && !took(before, next)) {
      let why = whyFallback ?? 'refused';
      if (action.type === 'ADD_ROUTE' && explain) { try { why = explain(before, action) ?? why; } catch { /* keep the fallback */ } }
      refused.push({ action, why });
      st = next;                       // keep the toast the reducer raised; nothing else changed
      return false;
    }
    st = next; actions.push(action); return true;
  };
  const gatesAt = (s, code) => (s.gates ?? {})[code] ?? 0;
  const routesOf = (id) => (st.routes ?? []).filter((r) => r.aircraftId === id);
  const flyingIds = () => new Set([...(st.routes ?? []), ...(st.cargoRoutes ?? [])].map((r) => r.aircraftId));
  const passengerTails = () => (st.fleet ?? []).filter((a) => !isOutOfService(a) && a.status !== 'retired' && !typeOf(a)?.freighter);
  const closeRoute = (r) => {
    const other = otherEnd(r, st.hub);
    if (!act({ type: 'CLOSE_ROUTE', routeId: r.id }, (b, a) => a.routes.length < b.routes.length)) return false;
    delete mem.loss[r.id];
    mem.skip[other] = now + P.skipWeeks;          // it lost money; do not walk straight back in
    if (!(st.routes ?? []).some((x) => x.origin === other || x.destination === other)) {
      act({ type: 'REMOVE_GATE', airportCode: other }, (b, a) => gatesAt(a, other) < gatesAt(b, other), 'gate kept');
    }
    return true;
  };

  // 0. Standing orders, once: leases renew themselves (a tail is handed back by
  //    step 7, on purpose, not by a term running out unnoticed).
  if (!mem.started) {
    act({ type: 'SET_LEASE_AUTO_RENEW', enabled: true, addWeeks: 104 }, (b, a) => a.leaseAutoRenew?.enabled === true);
    mem.started = true;
  }

  // 1. Cut. A route's own line in the weekly report (`profit`: its flying, after
  //    landing fees) says whether the ROUTE is worth flying. Whether the
  //    AIRCRAFT is worth keeping is its routes together against its rent,
  //    upkeep and crew — the report's per-route trueProfit charges the whole
  //    aircraft to every route it flies, so it cannot be used for a tail that
  //    flies several.
  const resultOf = new Map((st.lastReport?.routeResults ?? []).map((rr) => [rr.routeId, rr]));
  const liveIds = new Set((st.routes ?? []).map((r) => r.id));
  const usedNow = slotsUsed(st);
  for (const id of Object.keys(mem.loss)) if (!liveIds.has(id)) delete mem.loss[id];
  for (const r of [...(st.routes ?? [])]) {
    if (isMultiStop(r) || (r.weeksOpen ?? 0) < P.rampWeeks) continue;
    const rr = resultOf.get(r.id); if (!rr) continue;
    // … less the gates it keeps at the far end (its share, if routes share them).
    const far = otherEnd(r, st.hub);
    const gateShare = weeklyGateFeeAt(st, far, gatesAt(st, far)) * (r.weeklyFrequency ?? 0) / Math.max(1, usedNow[far] ?? 0);
    const n = (rr.profit ?? 0) - gateShare < 0 ? (mem.loss[r.id] ?? 0) + 1 : Math.max(0, (mem.loss[r.id] ?? 0) - 1);
    if (n < P.lossWeeks) { mem.loss[r.id] = n; continue; }
    closeRoute(r);
  }
  const tailIds = new Set((st.fleet ?? []).map((a) => a.id));
  for (const m of [mem.tailLoss, mem.idle, mem.full, mem.optedOut]) for (const id of Object.keys(m)) if (!tailIds.has(id)) delete m[id];
  for (const a of passengerTails()) {
    const mine = routesOf(a.id);
    if (!mine.length || mine.some((r) => (r.weeksOpen ?? 0) < P.rampWeeks || !resultOf.has(r.id))) { if (!mine.length) delete mem.tailLoss[a.id]; continue; }
    const earned = mine.reduce((s, r) => s + (resultOf.get(r.id).profit ?? 0), 0);
    const n = earned < tailCarryCost(st, a, P) ? (mem.tailLoss[a.id] ?? 0) + 1 : Math.max(0, (mem.tailLoss[a.id] ?? 0) - 1);
    mem.tailLoss[a.id] = n;
    if (n < P.lossWeeks) continue;
    // It has had its chance on these routes. Close them; step 6 gives it one more
    // week's plan elsewhere, and step 7 hands it back if there is none.
    for (const r of mine) closeRoute(r);
    delete mem.tailLoss[a.id]; delete mem.full[a.id];
  }

  // 2. Fares. A flight that sells out is under-priced; a mature one flying half
  //    empty is over-priced. One step a week each way, inside a band around the
  //    reference fare. The fare belongs to the city pair (UPDATE_TICKET_PRICE).
  //    (Tried and dropped: also raising every well-filled route while the airline
  //    is losing money, to pass a fuel spike on. Over 16 airline-lifetimes in
  //    the lab it cost three airlines instead of saving any — a young airline
  //    is always "losing money", so it priced itself out of its own ramp.)
  const up = []; const down = []; const pairsSeen = new Set();
  for (const r of st.routes ?? []) {
    if (isMultiStop(r)) continue;
    const rr = resultOf.get(r.id); if (!rr || !Number.isFinite(rr.loadFactor)) continue;
    const key = routePairKey(r.origin, r.destination);
    if (pairsSeen.has(key)) continue; pairsSeen.add(key);
    const ref = referencePrice(r.origin, r.destination);
    const price = Number(st.routePricing?.[key]?.economy) || ref;
    if (rr.loadFactor >= P.fareUpLoad && price * (1 + P.fareStep) <= ref * P.fareMax) up.push(r.id);
    else if ((r.weeksOpen ?? 0) >= P.rampWeeks && rr.loadFactor < P.fareDownLoad && price * (1 - P.fareStep) >= ref * P.fareMin) down.push(r.id);
  }
  // One decision each way, however many routes move (BULK_ADJUST_PRICING shifts
  // every cabin on the pair by a percentage) — the journal gets two lines a
  // week from fares, not one per route.
  const pct = (v) => ({ economy: v, premiumEconomy: v, businessClass: v, firstClass: v });
  const repriced = (b, a) => a.routePricing !== b.routePricing;
  if (up.length) act({ type: 'BULK_ADJUST_PRICING', routeIds: up, pct: pct(P.fareStep * 100) }, repriced, 'fares unchanged');
  if (down.length) act({ type: 'BULK_ADJUST_PRICING', routeIds: down, pct: pct(-P.fareStep * 100) }, repriced, 'fares unchanged');

  // Is the fleet paying for itself? Judged on the aircraft whose routes have had
  // time to fill: what they earned against what they cost to keep. (Not on the
  // airline's bottom line — a small airline's head office outweighs it, and the
  // cure for that is more aircraft that pay, not fewer.)
  const fleetProof = () => {
    const tails = passengerTails();
    const proven = tails.filter((a) => { const mine = routesOf(a.id); return mine.length > 0 && mine.every((r) => (r.weeksOpen ?? 0) >= P.proveWeeks && resultOf.has(r.id)); });
    // … and the gates their routes use: the hub's and the far ends', by flights.
    const flights = (st.routes ?? []).reduce((n, r) => n + (r.weeklyFrequency ?? 0), 0);
    const provenFlights = proven.reduce((n, a) => n + routesOf(a.id).reduce((m, r) => m + (r.weeklyFrequency ?? 0), 0), 0);
    const gates = (Number(st.lastReport?.totalGateFees) || 0) * (flights > 0 ? provenFlights / flights : 0);
    const margin = proven.reduce((s, a) => s + routesOf(a.id).reduce((t, r) => t + (resultOf.get(r.id).profit ?? 0), 0) - tailCarryCost(st, a, P), 0) - gates;
    return { tails, proven, margin };
  };
  // How far to trust its own forecasts: what its mature routes actually earn
  // against what the forecast promised when each was opened. A hub where the
  // forecast keeps over-promising (thin markets, a long ramp) earns less trust,
  // and a new aircraft there has to look that much better on paper.
  for (const id of Object.keys(mem.promised)) if (!liveIds.has(id)) delete mem.promised[id];
  const trust = (() => {
    let got = 0; let said = 0; let n = 0;
    for (const r of st.routes ?? []) {
      const promise = mem.promised[r.id]; const rr = resultOf.get(r.id);
      if (!(promise > 0) || !rr || (r.weeksOpen ?? 0) < P.rampWeeks) continue;
      const far = otherEnd(r, st.hub);
      got += (rr.profit ?? 0) - weeklyGateFeeAt(st, far, gatesAt(st, far)) * (r.weeklyFrequency ?? 0) / Math.max(1, usedNow[far] ?? 0);
      said += promise; n++;
    }
    return n >= P.trustMinRoutes && said > 0 ? Math.min(P.trustMax, Math.max(P.trustMin, got / said)) : P.trustStart;
  })();
  const costWeek = Number(st.lastReport?.totalCostAll) || 0;

  // 3. Bridge: an airline whose aircraft earn their keep but which is out of
  //    cash (a fuel spike, a cluster of heavy checks) borrows to get through
  //    it, as any airline would. Never to buy growth: step 8 counts every
  //    dollar owed against the cash it may spend.
  if (costWeek > 0 && st.cash < costWeek * P.bridgeBelowWeeks && (mem.bridgeAt == null || now - mem.bridgeAt >= P.bridgeEvery)) {
    const { proven, margin } = fleetProof();
    if (proven.length > 0 && margin > 0) {
      const want = Math.ceil(costWeek * P.bridgeToWeeks - st.cash);
      for (const productId of P.bridgeProducts) {
        let room = 0; try { room = borrowingCapacity(st, productId); } catch { room = 0; }
        const principal = Math.floor(Math.min(want, room));
        if (principal < Math.max(LOAN_MIN_PRINCIPAL, want * 0.25)) continue;
        if (act({ type: 'TAKE_LOAN', productId, principal }, (b, a) => a.cash > b.cash, 'loan refused')) { mem.bridgeAt = now; break; }
      }
    }
  }

  // 4. Upkeep: a heavy check that has come due is started now. Left alone the
  //    regulator grounds the aircraft anyway, for longer and at half as much again.
  for (const a of st.fleet ?? []) {
    if (isOutOfService(a) || a.status === 'retired' || a.scheduledCheck) continue;
    const due = dueInfo(a, typeOf(a), now).primaryDue;
    if (due) act({ type: 'SCHEDULE_CHECK', aircraftId: a.id, checkType: due, startNow: true }, (b, x) => x.cash < b.cash, 'could not pay for the check');
  }

  // 5. Staff: hire ahead of the aircraft that will arrive inside each group's
  //    training time (crew-pipeline worlds; a no-op elsewhere).
  //    A bot staffs the way a player is expected to: "Keep me fully staffed" on,
  //    and a reserve in every group, which it pays for like anyone else (half a
  //    wage) and which lets its next aircraft fly on arrival. Both are buttons a
  //    player has. The hand hire below is then only for an airline that could
  //    not switch it on.
  if (st.crewPipeline) {
    if (!st.crewAutoStaff) act({ type: 'SET_AUTO_STAFF', enabled: true }, (b, a) => a.crewAutoStaff === true, 'could not switch on staffing');
    const level = Number(P.reserveLevel) || 0;
    for (const g of LABOR_GROUPS) {
      if (Math.abs(reserveTarget(st.labor, g.id) - level) > 1e-9) {
        act({ type: 'SET_RESERVE_TARGET', group: g.id, target: level }, (b, a) => Math.abs(reserveTarget(a.labor, g.id) - level) < 1e-9, 'could not set a reserve level');
      }
    }
  }
  //    Staff it no longer needs — after cutting a tail — are let go rather than
  //    carried on reserve pay for years: everyone above the reserve level once
  //    every aircraft on order is crewed. Severance is four weeks' pay, which
  //    half pay overtakes in eight.
  if (st.crewPipeline) {
    const level = Number(P.reserveLevel) || 0;
    for (const g of LABOR_GROUPS) {
      if (st.labor?.[g.id]?.headcount == null) continue;
      const keep = crewRequiredForOrderBook(g.id, st.fleet ?? [], st.pendingOrders ?? [], typeOf) * (1 + level);
      const over = crewBodies(g.id, crewAvailable(st.labor, g.id) - keep) - 1;   // a person of slack: no churn at the margin
      if (over >= 1) act({ type: 'RELEASE_CREW', group: g.id, bodies: over }, (b, a) => crewAvailable(a.labor, g.id) < crewAvailable(b.labor, g.id), 'could not release staff');
    }
  }
  if (st.crewPipeline && !st.crewAutoStaff) {
    for (const g of LABOR_GROUPS) {
      const need = crewRequiredAhead(g.id, st.fleet ?? [], st.pendingOrders ?? [], typeOf, now + 1);
      const have = crewAvailable(st.labor, g.id) + crewInTraining(st.labor, g.id);
      const short = Math.ceil(need - have - 1e-9);
      if (short > 0) act({ type: 'HIRE_CREW', group: g.id, count: short }, (b, a) => a.cash < b.cash, 'could not fund crew training');
    }
  }

  // 6. Assign: fill each aircraft's week. An aircraft flies as many routes as its
  //    hours allow; a parked one must first show a week's plan that covers what
  //    it costs to keep, or it is left for step 7.
  const cap = maxWeeklyBlockHoursFor(st);
  const openRoute = (a, r) => {
    const used = slotsUsed(st);
    for (const code of [st.hub, r.code]) {
      for (let n = Math.min(3, gatesShort(st, used, code, r.freq)); n > 0; n--) {
        if (!act({ type: 'ADD_GATE', airportCode: code }, (b, x) => gatesAt(x, code) > gatesAt(b, code), `no gate available at ${code}`)) break;
      }
    }
    const add = { type: 'ADD_ROUTE', origin: st.hub, destination: r.code, aircraftId: a.id, weeklyFrequency: r.freq, ticketPrice: r.ticketPrice };
    const added = (b, x) => x.routes.length > b.routes.length;
    let ok = act(add, added, 'route refused');
    if (!ok && /gate|slot/i.test(refused.at(-1)?.why ?? '')) {
      // Out of slots at one end: one more gate each side, then one retry.
      for (const code of [st.hub, r.code]) act({ type: 'ADD_GATE', airportCode: code }, (b, x) => gatesAt(x, code) > gatesAt(b, code), `no gate available at ${code}`);
      ok = act(add, added, 'route refused');
    }
    if (!ok) mem.skip[r.code] = now + P.skipWeeks;
    else { const made = (st.routes ?? []).at(-1); if (made?.aircraftId === a.id) mem.promised[made.id] = Math.round(r.profit); }
    return ok;
  };
  let opened = 0; let plans = 0; let moreToPlace = false; const stuck = [];
  const nothingFor = {};       // typeId → most spare hours a tail of it had and still found nothing, this turn
  for (const a of passengerTails()) {
    if (opened >= P.maxAssignPerTurn) { moreToPlace = true; break; }
    const parked = routesOf(a.id).length === 0;
    if (!parked && (mem.full[a.id] ?? 0) > now) continue;
    const spare = cap - tailHoursUsed(st, a);
    if (spare - P.hoursMargin < P.minSpareHours || routesOf(a.id).length >= P.maxRoutesPerTail) { mem.full[a.id] = now + P.recheckWeeks; continue; }
    if (plans >= scaled(P.maxPlansPerTurn, effort(st, P), 2)) { moreToPlace = moreToPlace || parked; continue; }
    const known = spare <= (nothingFor[a.typeId] ?? -1);
    if (!known) plans++;
    botStats.tag = 'assign';
    const plan = known ? { routes: [], profit: 0 } : planTailWeek(st, a, mem, P);
    if (!plan.routes.length) nothingFor[a.typeId] = Math.max(nothingFor[a.typeId] ?? -1, spare);
    if (!plan.routes.length || (parked && !(plan.profit * trust > tailCarryCost(st, a, P)))) {
      if (parked) { mem.idle[a.id] = (mem.idle[a.id] ?? 0) + 1; stuck.push(a); } else mem.full[a.id] = now + P.recheckWeeks;
      continue;
    }
    let any = false; let left = plan.routes.length;
    for (const r of plan.routes) {
      if (opened >= P.maxAssignPerTurn || routesOf(a.id).length >= P.maxRoutesPerTail) break;
      left--;
      if (openRoute(a, r)) { opened++; any = true; }
    }
    if (any) delete mem.idle[a.id];
    else if (parked) { mem.idle[a.id] = (mem.idle[a.id] ?? 0) + 1; stuck.push(a); }
    if (left > 0) moreToPlace = true; else mem.full[a.id] = now + P.recheckWeeks;
  }

  // 7. Shrink: an aircraft with nothing worth flying goes back. Returning a
  //    leased tail early costs half the rent still owed and returns the deposit
  //    (reducer RETIRE_AIRCRAFT), which is always cheaper than paying all of it
  //    to keep an aircraft parked.
  for (const a of stuck) {
    if ((mem.idle[a.id] ?? 0) < P.idleWeeksToReturn || a.ownershipType !== 'lease') continue;
    const rate = a.weeklyLease ?? typeOf(a)?.weeklyLease ?? 0;
    const penalty = Math.round(rate * (a.leaseRemainingWeeks ?? 0) * 0.5);
    if (st.cash + (a.leaseDeposit ?? 0) - penalty > 0) {
      if (act({ type: 'RETIRE_AIRCRAFT', aircraftId: a.id }, (b, x) => x.fleet.length < b.fleet.length)) { delete mem.idle[a.id]; delete mem.optedOut[a.id]; }
    } else if (!mem.optedOut[a.id]) {
      // Cannot afford to hand it back today: at least stop it renewing.
      if (act({ type: 'SET_LEASE_AUTO_RENEW_OPT_OUT', aircraftIds: [a.id], optOut: true }, () => true)) mem.optedOut[a.id] = true;
    }
  }

  // 8. Grow: only an airline that is earning, into a week of routes that more
  //    than pays for the aircraft, with cash to spare. One order a week. The
  //    cheap tests come first — the forecasts are the expensive part of a turn.
  grow: {
    const cy = calendarYear(st);
    const tails = passengerTails();
    const fleetSize = (st.fleet ?? []).length;
    const maxPending = Math.max(P.maxPending, Math.ceil(fleetSize * P.pendingPerFleet));
    let room = Math.min(maxPending - (st.pendingOrders ?? []).length, 1 + Math.floor(fleetSize * P.ordersPerFleet));
    if (room <= 0) break grow;
    const flying = flyingIds();
    if (moreToPlace || stuck.length || tails.some((a) => !flying.has(a.id))) break grow;   // use what you have first
    const { proven, margin } = fleetProof();
    const earning = fleetSize < P.earnFromFleet || (proven.length * 2 >= tails.length && margin > 0);
    if (!earning) { refused.push({ action: { type: 'ORDER_AIRCRAFT' }, why: proven.length * 2 >= tails.length ? 'the fleet is not paying for itself' : 'waiting to see how the newest routes do' }); break grow; }
    const fh = (st.financialHistory ?? []).slice(-P.earnWindow);
    const avgCash = fh.length ? fh.reduce((s, h) => s + (Number(h?.profit) || 0), 0) / fh.length : 0;
    const founding = Number(st.paidInCapital) || 10_000_000;
    // Borrowed money is not money to grow on: everything owed is set aside too.
    const reserve = Math.max(founding * P.reserveShare, costWeek * P.reserveCostWeeks) + P.reserveLossWeeks * Math.max(0, -avgCash) + totalDebtOutstanding(st);
    const upfrontFor = (t) => eraWeeklyLease(t, cy) * P.depositWeeks + founding * P.startupShare;
    let committed = (st.pendingOrders ?? []).reduce((s, o) => { const t = getAircraftType(o.typeId); return s + (t ? founding * P.startupShare : 0); }, 0);
    const affordable = (t) => st.cash - committed - upfrontFor(t) > reserve;
    const probe = (t) => ({ id: '__bot_probe__', typeId: t.id, config: defaultConfig(t.seats), ageWeeks: eraDeliveredAgeWeeks(t, cy) });

    // Which types are worth leasing, re-ranked every few weeks by what a tail
    // would earn in a week of routes after everything it costs to have.
    // (Not every airline in the same week: a world's AI airlines are founded
    // together, and the re-rank is the heaviest thing a turn does.)
    //  Sooner if the last look found nothing, or cash has doubled since (types
    //  it could not afford then are within reach now).
    const stale = !Array.isArray(mem.types) || mem.typesAt == null || now >= (mem.typesDue ?? mem.typesAt + P.typesEvery)
      || (now - mem.typesAt >= P.recheckWeeks && (mem.types.length === 0 || st.cash > 2 * Math.max(1, mem.typesCash ?? Infinity)));
    if (stale) {
      botStats.tag = 'types';
      mem.types = compareTypes(st, mem, P, canLease).slice(0, P.typeShortlist).map((x) => x.id);
      mem.typesDue = now + P.typesEvery + (mem.typesAt == null ? [...String(st.hub ?? '')].reduce((n, c) => n + c.charCodeAt(0), 0) % P.typesEvery : 0);
      mem.typesAt = now; mem.typesCash = Math.round(st.cash);
    }
    const shortlist = mem.types.map((id) => getAircraftType(id)).filter((t) => t && canLease(st, t.id));
    if (!shortlist.length) { refused.push({ action: { type: 'ORDER_AIRCRAFT' }, why: 'nothing leasable would pay its way' }); break grow; }
    if (!shortlist.some(affordable)) { refused.push({ action: { type: 'ORDER_AIRCRAFT' }, why: 'cash would fall below the reserve' }); break grow; }
    // Aircraft already on order will take the best open routes first.
    botStats.tag = 'grow';
    const spoken = new Set();
    for (const o of st.pendingOrders ?? []) { const t = getAircraftType(o.typeId); if (!t || t.freighter) continue; for (const r of planTailWeek(st, probe(t), mem, P, { quick: true, spareHours: cap, exclude: spoken }).routes) spoken.add(r.code); }
    const size = (s) => (s.fleet ?? []).length + (s.pendingOrders ?? []).length;
    while (room-- > 0) {
      const pending = st.pendingOrders ?? [];
      let pick = null;
      for (const t of shortlist) {
        if (!affordable(t) || !canLease(st, t.id)) continue;
        const fixed = tailFixedCost(st, t, P);
        const plan = planTailWeek(st, probe(t), mem, P, { quick: true, spareHours: cap, exclude: spoken });
        if (!(plan.profit * trust > fixed)) continue;
        const cand = { t, fixed, plan, score: (plan.profit * trust - fixed) / fixed, queued: pending.filter((o) => o.typeId === t.id).length };
        // Shortest delivery queue first (frames of one type arrive one after another), then best return.
        if (!pick || cand.queued < pick.queued || (cand.queued === pick.queued && cand.score > pick.score)) pick = cand;
      }
      if (!pick) { refused.push({ action: { type: 'ORDER_AIRCRAFT' }, why: shortlist.some(affordable) ? 'no week of routes would pay for another aircraft' : 'cash would fall below the reserve' }); break; }
      if (!(pick.score > P.minNetShare)) { refused.push({ action: { type: 'ORDER_AIRCRAFT', typeId: pick.t.id }, why: 'the best week of routes does not clear the aircraft\'s costs with room to spare' }); break; }
      if (!act({ type: 'ORDER_AIRCRAFT', typeId: pick.t.id, quantity: 1, ownershipType: 'lease' }, (b, a) => size(a) > size(b), 'order refused')) break;
      committed += upfrontFor(pick.t);
      for (const r of pick.plan.routes) spoken.add(r.code);
    }
  }

  for (const [code, until] of Object.entries(mem.skip)) if (until <= now) delete mem.skip[code];
  for (const [id, held] of Object.entries(mem.ranks ?? {})) if (!(now - held.at < P.rankWeeks)) delete mem.ranks[id];
  return { state: st, memory: mem, actions, refused };
}
