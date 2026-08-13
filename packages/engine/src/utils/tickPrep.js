// ─────────────────────────────────────────────────────────────────────────────
// PRE-TICK PREP — the deterministic work that happens between "the state as the
// player left it" and "the state weeklyTick is actually run over".
//
// WHY THIS EXISTS
// ---------------
// ADVANCE_WEEK does not hand weeklyTick the raw state. It first ages the
// grounding and heavy-check countdowns, dispatches reserve aircraft over the
// tails that are still down, expires the events whose last week has passed,
// folds any fuel shock INTO the price index (so a hedge covers it), opens the
// bases and lounges that finished construction, and flips seasonal routes. Only
// then does the week run.
//
// projectWeek() used to skip all of it and call weeklyTick on the raw state, so
// the "THIS WEEK (PROJ.)" column was a forecast of a week that could not happen:
//
//   • An aircraft on the LAST week of a grounding or a C/D check is out of
//     service in the raw state, so the projection earns nothing on its routes —
//     but the reducer stands it back up before the tick and it flies all week.
//     Reported 2026-08-12: "Idk how im going to suddenly lose 50 mil in income.
//     I dont have any major checks or anything" — and, in the same breath, "I
//     make more than it estimates". Both symptoms, one cause. A reserve on
//     standby is the same story: the cover is dispatched inside ADVANCE_WEEK, so
//     the projection showed the covered route dead.
//
//   • An event in its final week is still in state.activeEvents. tickEvents
//     drops it before the tick, so the projection was forecasting a demand
//     shock the week would not have.
//
//   • Worse, the fuel shock: the reducer puts the event multiplier INSIDE the
//     price index and then blends hedges against it, which is the entire point
//     of holding a hedge. The projection multiplied it on AFTER the blend — the
//     exact bug the reducer fixed and left a comment about. A fully-hedged
//     airline was shown the unhedged spike, so a fuel event alone could knock
//     eight figures off the projected week (measured: fuel multiplier 1.381
//     projected against 1.156 actual).
//
// So the prep is ONE function now, and both callers run it. The projection still
// refuses to guess at anything genuinely random — newly-rolled events, the next
// fuel walk, AI encroachment, this week's mechanical failures — which is why
// `rollNewEvents` exists. Determinism is the design; forecasting a week that
// cannot happen was not.
//
// A projection that disagrees with the tick is a bug in one of them. Keeping the
// prep in one place is what stops them disagreeing again.
// ─────────────────────────────────────────────────────────────────────────────

import {
  weekToGameDate, applyReserveCovers, isRouteActive, routeDistanceKm,
} from './simulation.js';
import { completeCheck } from '../data/maintenance.js';
import { rollEvents, tickEvents } from '../data/events.js';
import { tickBaseConstruction } from '../data/mroBase.js';
import { tickLoungeConstruction } from '../data/lounges.js';
import { routeLaunchCost } from '../data/overhead.js';
import { clampFuelIndex, effectiveFuelMultiplier, absoluteWeek } from './fuel.js';

/**
 * Run every deterministic pre-tick transform ADVANCE_WEEK applies before it
 * calls weeklyTick, and return both the pieces the reducer needs downstream
 * (toasts, fees, persisted fuel series) and `tickInput` — the exact object to
 * hand weeklyTick.
 *
 * @param {object} state  the airline state as it stands BEFORE the week runs.
 * @param {object}  [opts]
 * @param {object[]|null} [opts.worldEvents]     multiplayer: the world's shared
 *   event set for this week (action.worldEvents). Ignored outside multiplayer.
 * @param {number|null}   [opts.worldFuelIndex]  multiplayer: the world's shared
 *   fuel index for this week (action.worldFuelIndex). Ignored outside multiplayer.
 * @param {boolean} [opts.rollNewEvents=true]  roll NEW events. The reducer does;
 *   a projection must not — a forecast has to be reproducible, and nobody can
 *   predict a die that has not been thrown. This is the ONLY random draw in this
 *   module, and it is the first one ADVANCE_WEEK makes, so the reducer's RNG
 *   sequence is unchanged by routing through here. Walking the fuel price for
 *   NEXT week stays in the reducer for the same reason: it is a draw the
 *   projection must not burn.
 * @returns {object}
 */
export function prepareWeek(state, {
  worldEvents = null,
  worldFuelIndex = null,
  rollNewEvents = true,
} = {}) {
  const isMultiplayer = state?.multiplayer === true;

  // ── Events: tick existing, expire the spent, roll for new ──────────────────
  // Multiplayer injects ONE shared set per world-week so every airline faces the
  // same booms and crises. A projection has no way to know it in advance, so it
  // ages its own copy: strictly better than keeping an event whose last week has
  // already been served, which is what the raw state still shows.
  const injectedEvents = (isMultiplayer && Array.isArray(worldEvents)) ? worldEvents : null;
  let survivingEvents, expiredEvents, newEvents, allEvents;
  if (injectedEvents) {
    const prevIds = new Set((state.activeEvents ?? []).map(e => e.id));
    const nowIds  = new Set(injectedEvents.map(e => e.id));
    survivingEvents = injectedEvents.filter(e => prevIds.has(e.id));
    newEvents       = injectedEvents.filter(e => !prevIds.has(e.id));
    expiredEvents   = (state.activeEvents ?? []).filter(e => !nowIds.has(e.id));
    allEvents       = injectedEvents;
  } else {
    ({ updated: survivingEvents, expired: expiredEvents } = tickEvents(state.activeEvents ?? []));
    newEvents = rollNewEvents ? rollEvents(survivingEvents, { multiplayer: isMultiplayer }) : [];
    allEvents = [...survivingEvents, ...newEvents];
  }

  // ── Event effects on this week ─────────────────────────────────────────────
  // Demand shocks are applied INSIDE weeklyTick (they shrink each route's pool,
  // so load factors genuinely drop). Fuel shocks go into the index below.
  let fuelMult = 1.0;
  let eventOtpDelta = 0;
  for (const ev of allEvents) {
    const fx = ev.effects ?? {};
    if (fx.fuelMult) fuelMult *= fx.fuelMult;
    if (fx.otpDelta) eventOtpDelta += fx.otpDelta;
  }
  eventOtpDelta = Math.min(0.25, eventOtpDelta);

  // ── Fuel price + hedging ───────────────────────────────────────────────────
  // The shock belongs IN the index: a spike and a high index are the same
  // commodity move, so hedges must cover it. Multiplying it on after the hedge
  // blend makes being 100% hedged through a spike do nothing — the one moment
  // hedging exists for.
  const injectedFuel = (isMultiplayer
    && typeof worldFuelIndex === 'number' && Number.isFinite(worldFuelIndex))
    ? worldFuelIndex : null;
  const baseFuelIndex    = injectedFuel ?? state.fuelPrice?.index ?? 1.0;
  const currentFuelIndex = fuelMult === 1 ? baseFuelIndex : clampFuelIndex(baseFuelIndex * fuelMult);

  const curAbsWeek   = absoluteWeek(state.year, state.week);
  const allHedges    = state.hedgeContracts ?? [];
  const activeHedges = allHedges.filter(h => h.expiryAbsWeek > curAbsWeek);
  const liveHedges   = activeHedges;
  const fuelMultiplier = state.fuelPrice
    ? effectiveFuelMultiplier(currentFuelIndex, activeHedges)
    // Pre-fuelPrice saves carry a bare multiplier and no index to shock.
    : (state.fuelMultiplier ?? 1.0) * fuelMult;

  const fuelPriceHistory = [...(state.fuelPrice?.history ?? []), currentFuelIndex].slice(-52);

  // ── Calendar ───────────────────────────────────────────────────────────────
  // absWeek (absolute world week — year 1 week 1 → 1) drives demand growth over
  // game time (pairDemandGrowth in market.js). Fixtures that hand the tick a
  // bare { week, month } gameDate simply get no growth, so it is additive.
  const gameMonth = weekToGameDate(state.week).monthIndex;
  const gameDate  = { week: state.week, month: gameMonth,
                      absWeek: absoluteWeek(state.year ?? 1, state.week ?? 1) };

  // ── Fleet: age the grounding and heavy-check countdowns ────────────────────
  // Runs BEFORE the revenue sim so an airframe whose last week of downtime is
  // this one flies this week and earns. This is the line the projection was
  // missing: in the raw state that tail is still 'maintenance'/'grounded', so a
  // forecast built on it writes off every route the aircraft operates.
  const completedChecks = (state.fleet ?? [])
    .filter(a => a.status === 'maintenance' && (a.checkWeeksLeft ?? 1) <= 1)
    .map(a => ({ id: a.id, name: a.name, tailNumber: a.tailNumber ?? '', checkType: a.checkType ?? 'C', forced: !!a.checkForced }));

  const tickedFleetPre = (state.fleet ?? []).map(a => {
    const hasRoute = (state.routes ?? []).some(r => r.aircraftId === a.id)
      || (state.cargoRoutes ?? []).some(r => r.aircraftId === a.id);
    if (a.status === 'grounded') {
      const weeksLeft = (a.groundedWeeksLeft ?? 1) - 1;
      if (weeksLeft <= 0) return { ...a, status: hasRoute ? 'assigned' : 'idle', groundedWeeksLeft: 0 };
      return { ...a, groundedWeeksLeft: weeksLeft };
    }
    if (a.status === 'maintenance') {
      const left = (a.checkWeeksLeft ?? 1) - 1;
      if (left <= 0) return completeCheck(a, curAbsWeek, hasRoute);
      return { ...a, checkWeeksLeft: left };
    }
    return a;
  });

  // ── Reserve aircraft: return finished covers, dispatch new ones ─────────────
  // After the countdowns (an original that recovered takes its routes back) and
  // before the revenue sim (a new cover earns from its first week).
  const lastRouteRevenues = state.financialHistory?.[state.financialHistory.length - 1]?.routeRevenues ?? {};
  const coverPass = applyReserveCovers({
    fleet:         tickedFleetPre,
    routes:        state.routes ?? [],
    cargoRoutes:   state.cargoRoutes ?? [],
    hubs:          state.hubs ?? {},
    absWeek:       curAbsWeek,
    routeRevenues: lastRouteRevenues,
  });

  // ── Seasonal flights: dormant↔active transitions ───────────────────────────
  // Resuming service costs 1/3 of the route's launch cost, charged once per
  // season. Going dormant is free.
  let seasonalReactivationCost = 0;
  const seasonalReactivations  = [];
  const seasonAdjustedRoutes = coverPass.routes.map(r => {
    if (!r.season) return r;
    const shouldBeActive = isRouteActive(r, gameMonth);
    const prevState = r.seasonState ?? (shouldBeActive ? 'active' : 'dormant');
    if (shouldBeActive && prevState === 'dormant') {
      const fee = Math.round(routeLaunchCost(routeDistanceKm(r.origin, r.destination)) / 3);
      seasonalReactivationCost += fee;
      seasonalReactivations.push({ origin: r.origin, destination: r.destination, fee });
      return { ...r, seasonState: 'active' };
    }
    if (!shouldBeActive && prevState === 'active') return { ...r, seasonState: 'dormant' };
    return { ...r, seasonState: prevState };
  });

  // ── Jet bases and lounges: advance construction before the economics ───────
  // A hangar or a lounge that finishes this week earns its keep this week.
  const baseBuild    = tickBaseConstruction(state.mroBases ?? {}, curAbsWeek);
  const tickedBases  = baseBuild.bases;
  const loungeBuild  = tickLoungeConstruction(state.lounges ?? {}, curAbsWeek);
  const tickedLounges = loungeBuild.lounges;

  // Disruption reaches the schedule through a transient field on the labor
  // object the tick hands down (see laborEffects). state.labor is untouched.
  const laborThisWeek = eventOtpDelta > 0
    ? { ...(state.labor ?? {}), eventOtpDelta }
    : state.labor;

  return {
    gameMonth, gameDate, curAbsWeek,
    survivingEvents, expiredEvents, newEvents, allEvents, eventOtpDelta,
    baseFuelIndex, currentFuelIndex, fuelMultiplier, fuelPriceHistory, injectedFuel,
    activeHedges, liveHedges,
    completedChecks, tickedFleetPre, coverPass,
    seasonalReactivationCost, seasonalReactivations, seasonAdjustedRoutes,
    baseBuild, tickedBases, loungeBuild, tickedLounges,
    laborThisWeek,
    // The exact object weeklyTick should be run over. The reducer overrides
    // `encroachments` with this week's freshly-rolled challengers; a projection
    // leaves the state's own (rolling AI is a die throw, not a forecast).
    tickInput: {
      ...state,
      labor:        laborThisWeek,
      fleet:        coverPass.fleet,
      routes:       seasonAdjustedRoutes,
      cargoRoutes:  coverPass.cargoRoutes,
      fuelMultiplier,
      loyalty:      state.loyalty,
      gameDate,
      activeEvents: allEvents,
      mroBases:     tickedBases,
      lounges:      tickedLounges,
      loungePolicy: state.loungePolicy ?? null,
      absWeek:      curAbsWeek,
    },
  };
}
