// Peak hours — what a timetable is worth (peak-hour games only).
//
// The tick stays weekly. This module boils an airline's timetable
// (models/schedule.js airlineWeeks) down to a few factors per route, and the
// weekly model consumes them:
//
//   demand  Every flight is scored by when it leaves and when it lands, local
//           time at each end, separately for business and leisure travellers.
//           A short sector is judged by its departure, a long one more and
//           more by its arrival (an overnight flight landing at 06:30 is a
//           good flight; one landing at 02:00 is not). A route's score is the
//           average over every flight its city pair gets from the player, both
//           directions, divided by what the automatic timetable scores, and
//           bounded to 0.80–1.04. It reaches the demand model as two appeal
//           terms (offer.timetableLeisure / timetableBusiness): a share term on
//           a contested pair, a pool term on a monopoly — the travel-partner
//           identity.
//   slots   Every landing is priced by the hour at that airport: peaks dearer,
//           nights cheaper, at mega and major airports (regional airports have
//           no slot pressure). Normalised so the automatic timetable pays what
//           every timetable paid before; tuning moves money between bands, it
//           adds no new cost.
//   parking An aircraft the player holds at the far end of a route
//           (route.schedule.hold) pays parking by the hour at mega and major
//           airports. The other cost of a hold is the tail's lost time.
//
// Principles (claude/timetable-rules-design.md §2): automatic is par, more
// downside than upside, rivals fly at par (they have no timetable), bounded,
// and behind a new-game flag — state.peakHours. Without it peakHoursOf
// returns null and nothing here runs.
//
// Pure and deterministic: same state, same factors on every device.

import { airlineWeeks, DAY_MIN } from './schedule.js';
import { routeStops, freighterLandingCategory } from '../utils/simulation.js';
import { getAirport } from '../data/airports.js';
import { getAircraftType } from '../data/aircraft.js';
import { utcOffsetMinutes } from '../data/timezones.js';
import { LANDING_FEE_PER_DEPARTURE, getEraCostScale } from '../data/overhead.js';

const H = 60;
/** Departure appeal by local time: [from, to, business, leisure], minutes. */
export const PEAK_DEPARTURE = [
  [0,          5.5 * H,  0.70, 0.80],
  [5.5 * H,    6.5 * H,  0.92, 0.90],
  [6.5 * H,    9 * H,    1.05, 1.00],
  [9 * H,      16 * H,   0.95, 1.02],
  [16 * H,     19.5 * H, 1.05, 1.00],
  [19.5 * H,   22.5 * H, 0.92, 0.96],
  [22.5 * H,   24 * H,   0.70, 0.80],
];
/** Arrival appeal by local time, for long sectors: [from, to, business, leisure]. */
export const PEAK_ARRIVAL = [
  [0,          5.5 * H,  0.70, 0.80],
  [5.5 * H,    10 * H,   1.05, 1.00],
  [10 * H,     17 * H,   0.97, 1.02],
  [17 * H,     21 * H,   1.02, 1.00],
  [21 * H,     23.5 * H, 0.92, 0.96],
  [23.5 * H,   24 * H,   0.70, 0.80],
];
/** Sector hours over which the arrival time takes over from the departure time. */
export const ARRIVAL_BLEND = { fromH: 3, toH: 8, max: 0.8 };
/** Bounds on a route's demand factor. */
export const PEAK_DEMAND_BOUNDS = [0.80, 1.04];

/** Landing price by local time and airport tier: [from, to, multiplier]. */
export const SLOT_BANDS = {
  mega: [
    [0,         6.5 * H, 0.60],
    [6.5 * H,   9.5 * H, 1.35],
    [9.5 * H,  16.5 * H, 0.90],
    [16.5 * H,  20 * H,  1.35],
    [20 * H,    23 * H,  0.85],
    [23 * H,    24 * H,  0.60],
  ],
  major: [
    [0,         6.5 * H, 0.75],
    [6.5 * H,   9.5 * H, 1.20],
    [9.5 * H,  16.5 * H, 0.95],
    [16.5 * H,  20 * H,  1.20],
    [20 * H,    23 * H,  0.90],
    [23 * H,    24 * H,  0.75],
  ],
};
/** Names of the slot bands, for the editor. */
export const SLOT_BAND_NAMES = ['Night', 'Peak', 'Day', 'Peak', 'Evening', 'Night'];

/** Parking for a held aircraft, an hour, as a share of that airport's landing
 *  fee for the type. Regional airports charge none. */
export const HOLD_PARKING_PER_HOUR = { mega: 0.025, major: 0.025, regional: 0 };

/** The landing-fee category for a type (freighters by payload). */
const feeCategoryOf = (type) => (type?.freighter
  ? freighterLandingCategory(type.payloadTonnes ?? 0) : (type?.category ?? 'Narrow Body'));

const tod = (m) => (((Math.round(m) % DAY_MIN) + DAY_MIN) % DAY_MIN);
const bandOf = (table, t) => table.find(b => t >= b[0] && t < b[1]) ?? table[table.length - 1];

/** Local time of day (minutes) at `code` for a UTC week minute. */
export function localTod(code, utcMin) {
  return tod(utcMin + utcOffsetMinutes(getAirport(code)));
}

/** How much a flight's arrival time counts (0–0.8) by its block minutes. */
export function arrivalWeight(flightMin) {
  const h = (Number(flightMin) || 0) / 60;
  const { fromH, toH, max } = ARRIVAL_BLEND;
  return Math.max(0, Math.min(max, ((h - fromH) / (toH - fromH)) * max));
}

/** What a local departure time is to travellers, for the editor. */
export const DEPARTURE_BAND_NAMES = ['dead of night', 'early morning', 'morning peak', 'middle of the day', 'evening peak', 'late evening', 'dead of night'];
export function departureBandName(localMin) {
  const t = tod(localMin);
  const i = PEAK_DEPARTURE.findIndex(b => t >= b[0] && t < b[1]);
  return DEPARTURE_BAND_NAMES[i < 0 ? DEPARTURE_BAND_NAMES.length - 1 : i];
}
/** The slot price band of a landing at an airport tier, lower-case, or null
 *  where landings cost the same all day (regional airports). */
export function landingBandName(tier, localMin) {
  const t = SLOT_BANDS[tier];
  if (!t) return null;
  const i = t.findIndex(b => tod(localMin) >= b[0] && tod(localMin) < b[1]);
  return (SLOT_BAND_NAMES[i < 0 ? SLOT_BAND_NAMES.length - 1 : i] ?? '').toLowerCase();
}

/** One flight's appeal { business, leisure } by the tables. */
export function flightAppeal(depTod, arrTod, flightMin) {
  const d = bandOf(PEAK_DEPARTURE, tod(depTod));
  const a = bandOf(PEAK_ARRIVAL, tod(arrTod));
  const w = arrivalWeight(flightMin);
  return { business: (1 - w) * d[2] + w * a[2], leisure: (1 - w) * d[3] + w * a[3] };
}

/** The slot band multiplier for a landing at an airport tier (1 at regional airports). */
export function slotBand(tier, landTod) {
  const t = SLOT_BANDS[tier];
  return t ? bandOf(t, tod(landTod))[2] : 1;
}

const clampDemand = (x) => Math.max(PEAK_DEMAND_BOUNDS[0], Math.min(PEAK_DEMAND_BOUNDS[1], x));
const pairKey = (a, b) => (a < b ? `${a}~${b}` : `${b}~${a}`);

/** Every flown leg of a week, as { routeId, from, to, dep, arr, flightMin, holdMin }. */
function legsOf(week) {
  const out = [];
  for (const b of week?.blocks ?? []) {
    let t = b.start;
    for (const l of b.legs ?? []) {
      out.push({ routeId: b.routeId, from: l.from, to: l.to, dep: t, arr: t + l.flightMin,
        flightMin: l.flightMin, holdMin: l.holdMin ?? 0 });
      t += l.flightMin + l.turnMin;
    }
  }
  return out;
}

/** Is this route timed by the player (pins or a hold)? */
const isTimed = (r) => !!r?.schedule && ((r.schedule.starts?.length ?? 0) > 0 || r.schedule.hold != null);
const untimed = (r) => { if (!isTimed(r)) return r; const { schedule: _s, ...rest } = r; return rest; };

/**
 * The airline's timetable factors, or null outside a peak-hour game.
 *   state  the airline (needs routes, cargoRoutes, fleet, peakHours, …)
 *   month  the game month (seasonal routes)
 *
 * Par is the automatic timetable — exactly. Every factor is the timetable as
 * flown measured against the same airline with every pin and hold taken off
 * (the week the game would build itself), so a route the player never times
 * scores 1.0 on demand and pays the landing fees it always paid, whatever its
 * geography, and a route preview of a new route (automatic) agrees with the
 * tick to the dollar. Only the player's own timing moves anything: towards the
 * hours travellers want and the cheap slots, or away.
 *
 * Returns {
 *   pairs:  Map(pairKey → { business, leisure, flights })  demand factors, par 1
 *   routes: Map(routeId → { slotMult, parking, holdMin, business, leisure, flights })
 *   demandFor(o, d) → { business, leisure }   1s for a pair the timetable doesn't fly
 *   slotMultFor(routeId) → number              1 when unknown
 *   parkingFor(routeId) → $ a week             0 when nothing is held
 * }
 */
const PEAK_MEMO = new WeakMap();   // state → { month, out }: previews ask often

export function peakHoursOf(state, month) {
  if (state?.peakHours !== true) return null;
  const hit = PEAK_MEMO.get(state);
  if (hit && hit.month === month) return hit.out;
  const weeks = airlineWeeks(state, month);
  const timed = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])].some(isTimed);
  // Tails the player hasn't timed are their own par (and hit the week cache).
  const parWeeks = timed
    ? airlineWeeks({ ...state, routes: (state.routes ?? []).map(untimed), cargoRoutes: (state.cargoRoutes ?? []).map(untimed) }, month)
    : weeks;
  const paxRoutes = new Map((state.routes ?? []).map(r => [r.id, r]));
  const allRoutes = new Map([...(state.cargoRoutes ?? []), ...(state.routes ?? [])].map(r => [r.id, r]));
  const fleet = new Map((state.fleet ?? []).map(a => [a.id, a]));
  const eraScale = getEraCostScale();

  // [0] as flown, [1] the automatic par.
  const mkAcc = () => [{ b: 0, l: 0, n: 0, fee: 0, band: 0 }, { b: 0, l: 0, n: 0, fee: 0, band: 0 }];
  const pairAcc = new Map();
  const routeAcc = new Map();   // routeId → { s: mkAcc(), holdMin, parking }
  const accOf = (id) => {
    let a = routeAcc.get(id);
    if (!a) routeAcc.set(id, (a = { s: mkAcc(), holdMin: 0, parking: 0 }));
    return a;
  };
  const tally = (wks, side) => {
    for (const [acId, week] of wks) {
      const ac = fleet.get(acId);
      const fees = LANDING_FEE_PER_DEPARTURE[feeCategoryOf(ac ? getAircraftType(ac.typeId) : null)] ?? null;
      for (const leg of legsOf(week)) {
        if (!allRoutes.has(leg.routeId)) continue;   // a charter: its customer pays the airport
        const ra = accOf(leg.routeId);
        const x = ra.s[side];
        // Slots: each landing at the price of its hour.
        const tier = getAirport(leg.to)?.tier ?? 'major';
        const fee = fees?.[tier] ?? 1;
        x.fee += fee;
        x.band += fee * slotBand(tier, localTod(leg.to, leg.arr));
        // Parking for a hold, by the hour, where it is taken (as flown only).
        if (side === 0 && leg.holdMin > 0) {
          ra.holdMin += leg.holdMin;
          ra.parking += (leg.holdMin / 60) * fee * (HOLD_PARKING_PER_HOUR[tier] ?? 0) * eraScale;
        }
        // Demand: nonstop passenger routes, by city pair.
        const pr = paxRoutes.get(leg.routeId);
        if (!pr || routeStops(pr).length !== 2) continue;
        const ap = flightAppeal(localTod(leg.from, leg.dep), localTod(leg.to, leg.arr), leg.flightMin);
        x.b += ap.business; x.l += ap.leisure; x.n++;
        const k = pairKey(pr.origin, pr.destination);
        let pa = pairAcc.get(k);
        if (!pa) pairAcc.set(k, (pa = mkAcc()));
        pa[side].b += ap.business; pa[side].l += ap.leisure; pa[side].n++;
      }
    }
  };
  tally(weeks, 0);
  tally(parWeeks, 1);

  const ratio = (a, seg) => (a[0].n > 0 && a[1].n > 0 && a[1][seg] > 0
    ? clampDemand((a[0][seg] / a[0].n) / (a[1][seg] / a[1].n)) : 1);
  const pairs = new Map();
  for (const [k, a] of pairAcc) pairs.set(k, { business: ratio(a, 'b'), leisure: ratio(a, 'l'), flights: a[0].n });
  const routes = new Map();
  for (const [id, { s, holdMin, parking }] of routeAcc) {
    const slotMult = s[0].fee > 0 && s[1].fee > 0 && s[1].band > 0
      ? (s[0].band / s[0].fee) / (s[1].band / s[1].fee) : 1;
    routes.set(id, {
      slotMult, parking: Math.round(parking), holdMin,
      business: ratio(s, 'b'), leisure: ratio(s, 'l'), flights: s[0].n,
    });
  }
  const ONE = { business: 1, leisure: 1 };
  const out = {
    pairs, routes,
    demandFor: (o, d) => pairs.get(pairKey(o, d)) ?? ONE,
    slotMultFor: (id) => routes.get(id)?.slotMult ?? 1,
    parkingFor: (id) => routes.get(id)?.parking ?? 0,
  };
  PEAK_MEMO.set(state, { month, out });
  return out;
}

/** The demand fields a peak-hour game hands the demand model for a city pair
 *  (none when they are 1, so an offer at par is the offer it always was). */
export function timetableFieldsFor(peak, o, d) {
  if (!peak) return {};
  const f = peak.demandFor(o, d);
  return {
    ...(f.leisure !== 1 ? { timetableLeisure: f.leisure } : {}),
    ...(f.business !== 1 ? { timetableBusiness: f.business } : {}),
  };
}

/** A route's weekly airport charges in a peak-hour game: its landing fee at
 *  the price of each landing's hour, plus parking for any hold. `baseFee` is
 *  what it pays without peak hours. */
export function peakLandingFee(peak, routeId, baseFee) {
  if (!peak) return baseFee;
  return Math.round(baseFee * peak.slotMultFor(routeId)) + peak.parkingFor(routeId);
}

/** Bands for the editor's shading at an airport tier: [{ from, to, mult, name }]. */
export function slotBandsFor(tier) {
  const t = SLOT_BANDS[tier];
  if (!t) return [];
  return t.map((b, i) => ({ from: b[0], to: b[1], mult: b[2], name: SLOT_BAND_NAMES[i] }));
}
