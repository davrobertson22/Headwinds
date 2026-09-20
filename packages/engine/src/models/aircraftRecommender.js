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
  defaultConfig, defaultClassPrices, effectiveRangeKm, maxFrequency, routeActiveMonths,
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


// ─────────────────────────────────────────────────────────────────────────────
// THE SAME QUESTION, ASKED ABOUT ANOTHER SEASON
//
//   ASAS  "for the best plane finder for each route, you should make it so we
//          can customize which season the planner is looking at"  (13/9/26)
//
// Every figure above is priced at ONE month — buildRouteMarket multiplies the
// pool by getSeasonalProfile[gameDate.month], so the ranking a player reads in
// February on an Alpine lane and the one they would read in June are different
// questions. The recommender could always answer either; nothing ever let them
// ask, and nothing said which one was on screen.
// ─────────────────────────────────────────────────────────────────────────────

/** 1–12, the months a year has. */
export const ALL_MONTHS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

/**
 * The same calendar, read at a different month.
 *
 * `absWeek` is deliberately untouched. It is what pairDemandGrowth keys on, so
 * winding it forward to "get to August" would fold months of world demand growth
 * into what is supposed to be a seasonal comparison, and every month ahead of
 * today would read better than it is for a reason that has nothing to do with
 * the season. The question is "which plane in August", not "which plane in four
 * months' time".
 *
 * Returns a new object — the caller's date is never mutated.
 */
export function gameDateInMonth(gameDate, month) {
  const m = Math.round(Number(month));
  if (!gameDate || !Number.isFinite(m) || m < 1 || m > 12) return gameDate;
  return { ...gameDate, month: m };
}

/**
 * Net profit per month, per candidate type — the seasonal SHAPE of a ranking.
 *
 * A month picker alone answers "best plane in August" and hides the thing that
 * actually decides the purchase: whether that plane also survives February. This
 * runs the identical ranking once per month so a row can carry its whole year.
 *
 * Months outside the route's operating window are not priced at all. A
 * summer-only route does not lose money in January — it does not fly, and a
 * January loss printed against it describes a route the player did not ask for.
 *
 * Cost is one full `rankAircraftForRoute` pass per flying month, so callers are
 * expected to hand in a SHORTLIST of types rather than the whole catalogue.
 *
 * @returns {{
 *   months: number[],
 *   byType: Map<string, {
 *     typeId: string, type: object,
 *     byMonth: Array<{ month: number, dormant: boolean, netProfit: number|null }>,
 *     best:  { month: number, netProfit: number }|null,
 *     worst: { month: number, netProfit: number }|null,
 *     swing: number,
 *   }>,
 * }}
 */
export function seasonalProfitByType(state, spec = {}, { months = ALL_MONTHS } = {}) {
  const flying = new Set(routeActiveMonths({ season: spec.season }));
  const monthList = [...months];

  const priced = new Map();   // typeId -> Map<month, netProfit|null>
  const types  = new Map();   // typeId -> type (ranking order of the first flying month)

  for (const month of monthList) {
    if (!flying.has(month)) continue;
    const ranked = rankAircraftForRoute(state, {
      ...spec,
      gameDate: gameDateInMonth(spec.gameDate, month),
    });
    for (const r of ranked) {
      if (!types.has(r.typeId)) { types.set(r.typeId, r.type); priced.set(r.typeId, new Map()); }
      priced.get(r.typeId).set(month, r.projection ? r.projection.netProfit : null);
    }
  }

  const byType = new Map();
  for (const [typeId, type] of types) {
    const got = priced.get(typeId);
    const byMonth = monthList.map((month) => ({
      month,
      dormant: !flying.has(month),
      netProfit: flying.has(month) ? (got.get(month) ?? null) : null,
    }));
    const live = byMonth.filter((c) => !c.dormant && c.netProfit != null);
    const best  = live.reduce((a, c) => (a == null || c.netProfit > a.netProfit ? c : a), null);
    const worst = live.reduce((a, c) => (a == null || c.netProfit < a.netProfit ? c : a), null);
    byType.set(typeId, {
      typeId, type, byMonth,
      best:  best  ? { month: best.month,  netProfit: best.netProfit }  : null,
      worst: worst ? { month: worst.month, netProfit: worst.netProfit } : null,
      swing: best && worst ? best.netProfit - worst.netProfit : 0,
    });
  }

  return { months: monthList, byType };
}


// ─────────────────────────────────────────────────────────────────────────────
// THE SAME QUESTION, ASKED ABOUT THE WHOLE YEAR
//
//   ASAS  "i like the new route planner's plane finder, although an average
//          per year feature would also be nice"  (15/9/26)
//
// A month picker answers "which plane in August". The strip beside each row
// shows the shape of its year. Neither RANKS by the year — and on a lane with a
// real season the plane that wins the peak month is not always the plane that
// earns the most across the twelve, because the big cabin's peak is bought with
// a trough the small cabin never sees. This ranks by the mean over the months
// the route actually flies.
//
// It is one `rankAircraftForRoute` pass per flying month over the whole
// candidate list, so it costs roughly twelve times the single-month ranking.
// That is why the planner only runs it when the player asks for the year.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rank `types` on one lane by AVERAGE forecast weekly net profit across the
 * months the route operates.
 *
 * Rows carry the same fields as `rankAircraftForRoute`, so the planner can
 * render them with the same table. `projection` holds the per-week averages
 * over the months that priced; `byMonth`, `best`, `worst` and `swing` are the
 * same seasonal shape `seasonalProfitByType` returns, so the strip beside an
 * annual row comes from the same pass as the number it sits next to.
 *
 * A month outside the route's operating window is dormant, not a zero: a
 * summer-only route averaged over twelve months would look half as good as it
 * is for flying exactly the schedule the player asked for.
 *
 * @returns {Array<{
 *   type, typeId, owned, tail, ready, onReserve, weeklyLease, seats,
 *   weeklyFrequency, frequencyCapped,
 *   projection: null | { passengers, loadFactor, revenue, connectingRevenue, netProfit, monthsPriced },
 *   byMonth: Array<{ month, dormant, netProfit }>,
 *   best, worst, swing,
 *   flyingMonths: number[],
 * }>}
 */
export function rankAircraftForYear(state, spec = {}, { months = ALL_MONTHS, limit = 0 } = {}) {
  const flying = new Set(routeActiveMonths({ season: spec.season }));
  const monthList = [...months];
  const flyingMonths = monthList.filter((m) => flying.has(m));

  const acc = new Map();   // typeId -> { row, byMonth: Map<month, projection|null>, sums }

  for (const month of flyingMonths) {
    const ranked = rankAircraftForRoute(state, {
      ...spec,
      limit: 0,
      gameDate: gameDateInMonth(spec.gameDate, month),
    });
    for (const r of ranked) {
      let a = acc.get(r.typeId);
      if (!a) {
        a = { row: r, byMonth: new Map(), n: 0, net: 0, lf: 0, pax: 0, rev: 0, conn: 0 };
        acc.set(r.typeId, a);
      }
      a.byMonth.set(month, r.projection);
      if (r.projection) {
        a.n   += 1;
        a.net += r.projection.netProfit;
        a.lf  += r.projection.loadFactor;
        a.pax += r.projection.passengers;
        a.rev += r.projection.revenue;
        a.conn += r.projection.connectingRevenue;
      }
    }
  }

  const out = [];
  for (const a of acc.values()) {
    const byMonth = monthList.map((month) => {
      const dormant = !flying.has(month);
      const p = dormant ? null : (a.byMonth.get(month) ?? null);
      return { month, dormant, netProfit: p ? p.netProfit : null };
    });
    const live  = byMonth.filter((c) => !c.dormant && c.netProfit != null);
    const best  = live.reduce((b, c) => (b == null || c.netProfit > b.netProfit ? c : b), null);
    const worst = live.reduce((b, c) => (b == null || c.netProfit < b.netProfit ? c : b), null);
    out.push({
      ...a.row,
      // The frequency cap is a property of the type and the sector, not the
      // month, so the first month's figure stands for the year.
      projection: a.n > 0 ? {
        passengers:        Math.round(a.pax / a.n),
        loadFactor:        a.lf / a.n,
        revenue:           Math.round(a.rev / a.n),
        connectingRevenue: Math.round(a.conn / a.n),
        netProfit:         Math.round(a.net / a.n),
        monthsPriced:      a.n,
      } : null,
      byMonth,
      best:  best  ? { month: best.month,  netProfit: best.netProfit }  : null,
      worst: worst ? { month: worst.month, netProfit: worst.netProfit } : null,
      swing: best && worst ? best.netProfit - worst.netProfit : 0,
      flyingMonths,
    });
  }

  // Same order as the single-month ranking, so switching modes re-sorts the
  // rows for one reason only: the number in the Net column changed.
  out.sort((x, y) =>
    (y.projection?.netProfit ?? -Infinity) - (x.projection?.netProfit ?? -Infinity)
    || (Number(y.owned) - Number(x.owned))
    || (y.seats - x.seats)
    || x.type.name.localeCompare(y.type.name));

  return limit > 0 ? out.slice(0, limit) : out;
}
