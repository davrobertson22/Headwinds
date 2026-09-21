/**
 * fuelOps.js — the one place the per-week fuel factors are derived
 * (FUEL_OPERATIONS_PLAN.md §10.2).
 *
 * Three things multiply into what a route sim charges for fuel:
 *
 *   price   the market index with this week's event shock folded in, blended
 *           with the live hedges — `fuelMultiplier`, what hedges cover and
 *           what the report, history and fuelImpact.js reason about
 *   burn    the fleet-wide efficiency programme — `fuelBurnMod`
 *   (later) the station basis and tankering — Phase 4
 *
 * The sims receive `fuelSimMultiplier` = price × burn. The tick derives it
 * through resolveFuelForWeek (called by tickPrep), and every preview that
 * does not go through prepareWeek — the Route Planner, the route finder, the
 * aircraft recommender, projectRouteAddition — derives it through
 * fuelSimMultiplierOf, which is the same function over the same state. A
 * bare `1.0` default is how the planner used to forecast every route at par
 * whatever fuel was doing (`state.fuelMultiplier` is never written).
 */

import { ERA_FUEL_MIN_INDEX } from '../data/era.js';
import { tickEvents } from '../data/events.js';
import { clampFuelIndex, effectiveFuelMultiplier, absoluteWeek } from './fuel.js';
import { fleetBurnMod } from '../data/fuelProgrammes.js';
import { refineryStatus, tickCrackIndex, CRACK_BASE_INDEX } from '../data/refinery.js';

/** The combined fuel shock of a set of live events (1 when none). */
export function eventFuelMult(events = []) {
  let m = 1.0;
  for (const ev of events ?? []) if (ev?.effects?.fuelMult) m *= ev.effects.fuelMult;
  return m;
}

/**
 * Price, hedges and burn for the week about to run. Byte-for-byte the logic
 * tickPrep used to inline, so the golden master does not move.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {number} [opts.fuelMult=1]         this week's event fuel shock
 * @param {number|null} [opts.worldFuelIndex] multiplayer: the world's shared
 *   index for this week; ignored outside multiplayer
 */
export function resolveFuelForWeek(state, { fuelMult = 1.0, worldFuelIndex = null, worldCrackIndex = null } = {}) {
  const isMultiplayer = state?.multiplayer === true;
  const injectedFuel = (isMultiplayer
    && typeof worldFuelIndex === 'number' && Number.isFinite(worldFuelIndex))
    ? worldFuelIndex : null;
  const baseFuelIndex    = injectedFuel ?? state.fuelPrice?.index ?? 1.0;
  const currentFuelIndex = fuelMult === 1 ? baseFuelIndex : clampFuelIndex(baseFuelIndex * fuelMult, state.startYear != null ? ERA_FUEL_MIN_INDEX : undefined);

  const curAbsWeek   = absoluteWeek(state.year, state.week);
  const allHedges    = state.hedgeContracts ?? [];
  const activeHedges = allHedges.filter(h => h.expiryAbsWeek > curAbsWeek);
  const fuelMultiplier = state.fuelPrice
    ? effectiveFuelMultiplier(currentFuelIndex, activeHedges)
    // Pre-fuelPrice saves carry a bare multiplier and no index to shock.
    : (state.fuelMultiplier ?? 1.0) * fuelMult;

  // ── Refinery (data/refinery.js) ──────────────────────────────────────────
  // A refinery swaps a fixed slice of the week's litres off the jet index and
  // onto crude + a refining cost. Hedges cover only what it does NOT: you
  // cannot hedge the crack spread away, which is the exposure you bought.
  // `hedgeableShare` is what the hedge scoreboard must charge its contracts
  // against, or a hedged refinery owner would be credited twice for the same
  // litres. Every field is inert for a save with no refinery.
  const crackIndex = (isMultiplayer
    && typeof worldCrackIndex === 'number' && Number.isFinite(worldCrackIndex))
    ? worldCrackIndex
    : (state.fuelPrice?.crack ?? CRACK_BASE_INDEX);
  const refinery = refineryStatus(state, { absWeek: curAbsWeek, jetIndex: currentFuelIndex, crackIndex });
  const hedgeableShare = 1 - refinery.share;
  const pricedMultiplier = refinery.share > 0
    ? parseFloat((refinery.share * refinery.price + hedgeableShare * fuelMultiplier).toFixed(6))
    : fuelMultiplier;

  const fuelBurnMod       = fleetBurnMod(state);
  const fuelSimMultiplier = fuelBurnMod === 1 ? pricedMultiplier : parseFloat((pricedMultiplier * fuelBurnMod).toFixed(6));

  return {
    injectedFuel, baseFuelIndex, currentFuelIndex, curAbsWeek, activeHedges,
    // `fuelMultiplier` is what the airline actually pays per unit of fuel:
    // hedges blended, and the refinery's slice priced off crude. The
    // hedges-only figure stays available as `hedgedMarketMultiplier` for the
    // hedge accounting and the market-facing notes.
    fuelMultiplier: pricedMultiplier,
    hedgedMarketMultiplier: fuelMultiplier,
    crackIndex, refinery, hedgeableShare,
    fuelBurnMod, fuelSimMultiplier,
  };
}

/**
 * What the sims will multiply fuel by if the week ran now, from state alone —
 * for previews that do not run prepareWeek. Ages the active events the way
 * the tick does (an event on its last week has already been served), takes
 * the fuel shock of the survivors, and applies hedges and burn exactly as
 * resolveFuelForWeek does.
 */
export function fuelSimMultiplierOf(state) {
  if (!state) return 1.0;
  const { updated } = tickEvents(state.activeEvents ?? []);
  return resolveFuelForWeek(state, { fuelMult: eventFuelMult(updated) }).fuelSimMultiplier;
}

/** The price-only counterpart of fuelSimMultiplierOf (hedges blended, no burn). */
export function fuelPriceMultiplierOf(state) {
  if (!state) return 1.0;
  const { updated } = tickEvents(state.activeEvents ?? []);
  return resolveFuelForWeek(state, { fuelMult: eventFuelMult(updated) }).fuelMultiplier;
}
