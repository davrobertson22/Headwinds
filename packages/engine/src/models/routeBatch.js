// ─────────────────────────────────────────────────────────────────────────────
// ROUTE BATCH — open several finder rows at once, one idle aircraft each.
//
// Discord, 2026-10-14 ("Tired of finding routes for the same aircraft many
// times", Brabus-G-Wagon / Kadicuss): "I have had times when I had like 50
// aircraft arrived at the same time, and it was a pain to get them all on
// routes." The ask was an auto-deploy to random routes. What it costs today is
// not the choosing but the loop — Finder → Plan → Planner → Open → Finder, once
// per tail. So the player still picks every route; this module lets the picks
// go in one sitting.
//
// The one thing a batch must not do is preview each pick against TODAY's state.
// Five picks share one cash balance, one set of gate slots, one pool of idle
// tails, and sometimes one metro market. So the plan is built the way the
// engine would build it: each pick is checked and forecast against the state
// the picks above it leave behind, by running the real reducer on a copy. A
// pick the engine would refuse is reported with the reducer's own sentence and
// leaves the state untouched for the picks below it.
//
// Forecasts come from routeFinder.forecastLaunch — the sum the finder row was
// ranked by — on the actual tail the batch will assign.
// ─────────────────────────────────────────────────────────────────────────────

import { gameReducer, addRouteBlockReason } from '../reducer.mjs';
import { getAircraftType } from '../data/aircraft.js';
import { isOutOfService } from '../data/maintenance.js';
import { isReserve } from '../data/reserve.js';
import { routeLaunchCost } from '../data/overhead.js';
import { normalizeCateringLevel } from '../data/catering.js';
import { referencePrice } from '../utils/market.js';
import {
  defaultClassPrices, maxFrequency, maxWeeklyBlockHoursFor, routeDistanceKm,
  routePairKey, effectiveRangeKm, currentGameDate,
} from '../utils/simulation.js';
import { forecastLaunch } from './routeFinder.js';

/** The frequency a finder row is forecast at, and the batch's default. */
export const BATCH_DEFAULT_FREQUENCY = 7;

/**
 * Most picks one batch opens. Each launch is its own decision write in
 * Headwinds (serialized, 60 per 10s per account), and a review table longer
 * than a finder page stops being something a player actually reads.
 */
export const MAX_BATCH = 25;

/** Stable id for a pick: one row per origin/destination pair. */
export const pickKey = (origin, destination) => `${origin}>${destination}`;

/**
 * Idle, in-service, non-reserve tails of a type. Reserves are parked on purpose
 * (a standby cover), so a batch never reaches for one; the Route Planner is
 * where a player deploys a reserve deliberately.
 */
export function idleTailsOfType(fleet = [], typeId) {
  return fleet.filter(a => a.typeId === typeId && a.status === 'idle'
    && !isReserve(a) && !isOutOfService(a));
}

/**
 * Choose the idle tail for a lane: the shortest-legged one that still reaches
 * it, so a modded long-range airframe is kept back for a lane only it can fly.
 */
function pickTail(state, typeId, distKm) {
  const type = getAircraftType(typeId);
  const idle = idleTailsOfType(state.fleet, typeId);
  if (idle.length === 0) return { tail: null, idleCount: 0, why: 'none-idle' };
  const fits = idle
    .map(a => ({ a, reach: effectiveRangeKm(a, type) }))
    .filter(x => distKm <= x.reach)
    .sort((x, y) => x.reach - y.reach);
  if (fits.length === 0) return { tail: null, idleCount: idle.length, why: 'out-of-range' };
  // Hours, gates, slots, cash and regulation are the reducer's guard's to name.
  return { tail: fits[0].a, idleCount: idle.length, why: null };
}

/**
 * Plan a batch of launches.
 *
 * @param {object} state  the live game state
 * @param {Array<{origin, destination, typeId, weeklyFrequency?}>} picks  in order
 * @returns {{ items: Array, openable: Array, totals: object, finalState: object }}
 *
 * Each item: { key, origin, destination, typeId, distKm, weeklyFrequency,
 *   maxFrequency, aircraft, action, reason, projection, launchCost, cashAfter }.
 * `reason` is null when the pick will open; `action` is the exact ADD_ROUTE to
 * dispatch. `openable` is the actions to dispatch, in order.
 */
export function planRouteBatch(state, picks = [], { gameDate = currentGameDate(state) } = {}) {
  const capHours = maxWeeklyBlockHoursFor(state);
  let s = state;
  const items = [];
  const openable = [];
  let launchTotal = 0, profitTotal = 0;

  for (const [n, pick] of picks.entries()) {
    const { origin, destination, typeId } = pick;
    const type = getAircraftType(typeId);
    const distKm = routeDistanceKm(origin, destination);
    const freqCap = type ? Math.max(1, maxFrequency(distKm, type, capHours)) : 1;
    const weeklyFrequency = Math.max(1, Math.min(
      Math.round(Number(pick.weeklyFrequency) || BATCH_DEFAULT_FREQUENCY), freqCap));
    const base = {
      key: pickKey(origin, destination), origin, destination, typeId, distKm,
      weeklyFrequency, maxFrequency: freqCap, aircraft: null, action: null,
      reason: null, projection: null, launchCost: routeLaunchCost(distKm), cashAfter: s.cash,
    };

    if (!type) { items.push({ ...base, reason: 'Unknown aircraft type' }); continue; }
    if (n >= MAX_BATCH) { items.push({ ...base, reason: `A batch opens up to ${MAX_BATCH} routes — open these, then the rest` }); continue; }

    const { tail, idleCount, why } = pickTail(s, typeId, distKm);
    if (!tail) {
      const name = type.name;
      const idleAtStart = idleTailsOfType(state.fleet, typeId).length;
      const reason = why === 'none-idle'
        ? (idleAtStart > 0
            ? `No idle ${name} left — the picks above take all ${idleAtStart}`
            : `No idle ${name} to fly it`)
        : `Your ${idleCount} idle ${name}${idleCount !== 1 ? 's' : ''} can't reach ${distKm.toLocaleString()} km as configured`;
      items.push({ ...base, reason });
      continue;
    }

    // A pair already priced (another tail on it) keeps its fares and catering —
    // ADD_ROUTE inherits them — so the forecast must too.
    const pk = routePairKey(origin, destination);
    const fares = s.routePricing?.[pk] ?? defaultClassPrices(referencePrice(origin, destination));
    const cateringLevel = normalizeCateringLevel(s.routeCatering?.[pk] ?? s.defaultCateringLevel);
    const action = {
      type: 'ADD_ROUTE', origin, destination, aircraftId: tail.id, weeklyFrequency,
      ticketPrice: fares.economy, classPrices: { ...fares }, cateringLevel, season: null,
    };

    const reason = addRouteBlockReason(s, action);
    const projection = reason ? null : forecastLaunch(s, {
      origin, destination, aircraft: tail, weeklyFrequency,
      ticketPrice: fares.economy, classPrices: fares, cateringLevel, gameDate,
    });
    const item = { ...base, aircraft: tail, action, reason, projection };

    if (!reason) {
      const next = gameReducer(s, action);
      // The guard and the reducer share one source of truth, but never trust a
      // preview that the reducer silently refused.
      if (next === s) { items.push({ ...item, reason: 'The engine refused this route', projection: null }); continue; }
      s = next;
      item.cashAfter = s.cash;
      launchTotal += base.launchCost;
      profitTotal += projection?.netProfit ?? 0;
      openable.push(action);
    }
    items.push(item);
  }

  return {
    items,
    openable,
    totals: {
      count: openable.length,
      blocked: items.length - openable.length,
      launchCost: launchTotal,
      weeklyProfit: profitTotal,
      cashAfter: s.cash,
    },
    finalState: s,
  };
}
