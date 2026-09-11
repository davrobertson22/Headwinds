// ─────────────────────────────────────────────────────────────────────────────
// AIRCRAFT RECOMMENDER — "which of these planes should I put on this lane?"
//
// WHY THIS EXISTS
// ---------------
//   ASAS  "or like aircraft recommendations to route planner too"  (9/11/26)
//
// The planner has always PICKED a type for you — defaultTypeId prefers one with
// a tail free to fly the lane today — but it picks by availability, never by
// economics, and it shows none of its reasoning. On a long thin lane the type it
// lands on can be the worst earner you own: a 300-seat widebody that fills 40% of
// its cabin loses to a narrowbody that fills 85% of a smaller one, and the only
// way to find that out was to open the dropdown and read the card again for every
// entry in it.
//
// So: rank every type the lane can take by what it would actually clear, and say
// which ones you can fly today.
//
// AGREEING WITH THE CARD
// ----------------------
// This module is the reason the ranking and the card beside it cannot part
// company. Both go through projectRouteAddition — never a bare simulateRoute,
// which on a pair you already fly would hand each candidate the WHOLE demand
// pool and rank the biggest cabin top every time — and the net figure is built
// the same way in both places:
//
//     profitAfterLandingFees + connecting revenue − the lease on THAT tail
//
// The per-type inputs that move that figure are taken from the same places the
// planner takes them:
//
//   the tail       fleetOfType[0] — free idle first, reserves last: the plane
//                  Open Route will actually assign. Its age feeds cabin quality
//                  and its ownership decides the lease line (an owned tail costs
//                  the tick nothing; a leased one costs the rate IT signed at,
//                  not the catalogue rate).
//   the cabin      that tail's real layout when it has one, else the type's
//                  default fit. A caller editing a cabin passes `configFor` so
//                  the row for the type on screen matches the card exactly.
//   the reach      `reachKmFor`, so engine and wingtip mods count here the way
//                  the picker already quotes them.
//   the frequency  capped PER TYPE. One airframe has a fixed weekly block-hour
//                  budget, so a slower type fits fewer rotations on a long
//                  sector; ranking every candidate at a flat 7× would credit a
//                  turboprop with a transatlantic schedule it cannot fly. A
//                  capped row says so rather than quietly changing the question.
// ─────────────────────────────────────────────────────────────────────────────

import { getAircraftType } from '../data/aircraft.js';
import { normalizeCateringLevel } from '../data/catering.js';
import {
  defaultConfig, defaultClassPrices, effectiveRangeKm, maxFrequency,
} from '../utils/simulation.js';
import { projectRouteAddition } from './pairShare.js';

/** Ranking order for the tail a type would actually fly on: free idle, then in
 *  service, then reserves. The planner's `fleetOfType` sort, kept identical. */
const tailRank = (a) => (a.reserveBase ? 2 : (a.status === 'idle' ? 0 : 1));

/**
 * Every tail of `typeId` the player owns, best-first, matching the planner.
 */
export function tailsOfType(fleet, typeId) {
  if (!typeId) return [];
  return (fleet ?? [])
    .filter((a) => a.typeId === typeId)
    .sort((a, b) => tailRank(a) - tailRank(b));
}

/**
 * What the aircraft flying this route costs per week.
 *
 * An OWNED tail has no lease — the tick charges it nothing. A LEASED one pays
 * the rate it signed at, which may be nothing like today's catalogue rate. Only
 * a type with no tail behind it is priced at list, and that row is a quote for
 * an order, not a plan for this week.
 */
export function weeklyLeaseFor(tail, type) {
  if (!tail) return type.weeklyLease ?? 0;
  return tail.ownershipType === 'owned' ? 0 : (tail.weeklyLease ?? type.weeklyLease ?? 0);
}

/**
 * Rank `types` on one lane by forecast weekly net profit.
 *
 * Returns a new array, best first. A type the projection cannot price keeps
 * `projection: null` and sinks to the bottom rather than being dropped — a
 * candidate silently missing from a ranked list reads as "not worth flying".
 *
 * @returns {Array<{
 *   type: object, typeId: string, owned: boolean, tail: object|null,
 *   ready: number, onReserve: number, weeklyLease: number,
 *   weeklyFrequency: number, frequencyCapped: boolean, seats: number,
 *   projection: null | { passengers: number, loadFactor: number, revenue: number,
 *                        connectingRevenue: number, netProfit: number },
 * }>}
 */
export function rankAircraftForRoute(state, {
  origin,
  destination,
  distKm,
  types = [],
  weeklyFrequency = 7,
  ticketPrice,
  classPrices = null,
  cateringLevel = null,
  season = null,
  gameDate,
  eventDemandMult,
  capHours,
  // (type) => km. Defaults to the catalogue figure; the planner passes its own
  // so a modded tail's extra reach is credited here exactly as the picker quotes it.
  reachKmFor = null,
  // (type) => cabin config, for the type whose cabin the player is editing.
  configFor = null,
  // (typeId) => { ready, onReserve }. Availability is not economics, so it never
  // moves a row's rank — it is what turns a ranking into a decision.
  availabilityFor = null,
  limit = 0,
} = {}) {
  if (!origin || !destination || origin === destination) return [];
  const fleet = state.fleet ?? [];
  const catering = normalizeCateringLevel(cateringLevel ?? state.defaultCateringLevel);
  const fares = classPrices ?? defaultClassPrices(ticketPrice);

  const out = [];
  for (const t0 of types) {
    const type = typeof t0 === 'string' ? getAircraftType(t0) : t0;
    if (!type) continue;

    const tails = tailsOfType(fleet, type.id);
    const tail  = tails[0] ?? null;
    const owned = tails.length > 0;

    // The reach the picker credits this type with, reproduced on the forecast
    // frame. rangeMod feeds effectiveRangeKm and nothing else — fuel burn rides
    // on the separate fuelMod — so this moves the range guard and no part of the
    // economics, which is exactly what the planner's own simulation does.
    const quotedReach = reachKmFor ? reachKmFor(type) : effectiveRangeKm({ typeId: type.id }, type);
    if (distKm != null && distKm > quotedReach) continue;

    const cfg = (configFor && configFor(type))
      || tails.find((a) => a.config)?.config
      || defaultConfig(type.seats);

    // Per-type frequency ceiling. Asking for 14× on a type that fits 6 rotations
    // a week is not a forecast, it is a different route.
    const cap  = Math.max(1, maxFrequency(distKm, type, capHours));
    const freq = Math.max(1, Math.min(weeklyFrequency, cap));

    const avail = availabilityFor ? (availabilityFor(type.id) ?? {}) : {};
    const row = {
      type,
      typeId: type.id,
      owned,
      tail,
      ready:     avail.ready ?? 0,
      onReserve: avail.onReserve ?? 0,
      weeklyLease: weeklyLeaseFor(tail, type),
      weeklyFrequency: freq,
      frequencyCapped: freq < weeklyFrequency,
      seats: type.seats,
      projection: null,
    };

    const frame = {
      id: '__rec__',
      typeId: type.id,
      ageWeeks: tail?.ageWeeks ?? 0,
      rangeMod: type.range > 0 ? quotedReach / type.range : 1.0,
      config: cfg,
    };

    const p = projectRouteAddition(state, {
      origin,
      destination,
      aircraft: frame,
      weeklyFrequency: freq,
      ticketPrice,
      classPrices: fares,
      cateringLevel: catering,
      season,
      gameDate,
      ...(eventDemandMult != null ? { eventDemandMult } : {}),
    });
    const mature = p?.mature ?? null;
    if (mature) {
      const connecting = p.connecting ?? { totalRevenue: 0, totalPax: 0 };
      row.projection = {
        passengers:  mature.passengers,
        loadFactor:  mature.loadFactor,
        revenue:     Math.round(mature.revenue + (connecting.totalRevenue ?? 0)),
        connectingRevenue: Math.round(connecting.totalRevenue ?? 0),
        // The same arithmetic the Route Finder does and the planner card prints:
        // profitAfterLandingFees already nets the landing fee, connecting revenue
        // is credited by weeklyTick, and the lease is the one THIS tail signed.
        netProfit: Math.round((mature.profitAfterLandingFees ?? mature.profit)
          + (connecting.totalRevenue ?? 0) - row.weeklyLease),
      };
    }
    out.push(row);
  }

  out.sort((x, y) =>
    (y.projection?.netProfit ?? -Infinity) - (x.projection?.netProfit ?? -Infinity)
    // Ties (and unpriceable rows) keep a stable, explainable order: a plane you
    // can fly today above one you would have to lease, then the bigger cabin.
    || (Number(y.owned) - Number(x.owned))
    || (y.seats - x.seats)
    || x.type.name.localeCompare(y.type.name));

  return limit > 0 ? out.slice(0, limit) : out;
}
