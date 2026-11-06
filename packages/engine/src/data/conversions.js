// ─────────────────────────────────────────────────────────────────────────────
// Freighter conversions (P2F / BCF / SF) of a player's own passenger frames.
//
// Design: claude/p2f-conversion.md (Discord: Barca, VodkaOnFire, 2026-11-03).
//
// An owned passenger tail goes into the hangar and comes out as its family's
// freighter. What the player buys:
//   • a second career for metal the cabin has outgrown — cargo routes do not
//     score cabin quality or airframe age at all;
//   • an OPERATING-age credit of 10 years (P2F_AGE_CREDIT_WEEKS): the
//     conversion includes a heavy structural check, so running cost, AOG
//     repair bills and the failure age term all read real age − 10 years.
//
// What it does NOT buy is book value. The tail keeps its real age, its
// airframe keeps depreciating as the PASSENGER type it was built as, and the
// conversion capex books on top on its own 15-year line (data/overhead.js
// tailBookValue). Repricing it as the freighter type would hand a 12-year-old
// 767-300 $32M of collateral for a $17M conversion.
//
// One quote, two callers: canConvertToFreighter is what the Fleet screen
// shows AND what CONVERT_TO_FREIGHTER charges and books.
//
// Production-line worlds: each conversion holds a slot on its family's
// conversion line (data/productionLines.js counts tails in conversion as
// bookings), so a busy line queues them. Classic worlds: flat downtime.
// ─────────────────────────────────────────────────────────────────────────────

import { getAircraftType, eraPurchasePrice, aircraftAvailability } from './aircraft.js';
import { isOutOfService } from './maintenance.js';
import { tailBookValue } from './overhead.js';
import { eventAircraftDenial } from './eventRules.js';
import { lineOf, makeLineSlotAllocator } from './productionLines.js';
import { newAircraftConfig, calendarYear } from '../utils/simulation.js';
import { absoluteWeek } from '../utils/fuel.js';

/** Operating-age credit a conversion earns (weeks). Flat for every type. */
export const P2F_AGE_CREDIT_WEEKS = 520;

/** Conversion price as a share of the freighter type's (era) catalogue price. */
export const CONVERSION_COST_PCT = 0.18;

/** Hangar time by the freighter's payload — real programmes run 3–5 months. */
export const CONVERSION_DOWNTIME_WEEKS = [
  { maxTonnes: 15,       weeks: 10 },
  { maxTonnes: 45,       weeks: 12 },
  { maxTonnes: 130,      weeks: 16 },
  { maxTonnes: Infinity, weeks: 20 },
];

/**
 * Passenger type → freighter it converts to, and the conversion line that
 * does the work. `standIn` marks pairs where the catalogue only has the
 * factory freighter standing in for the real conversion (767-300BCF etc).
 * Not here (v1): the 777-300ER (the 777F is a different airframe), the
 * factory convertibles (707-320C, 727-100C, DC-8-63CF) and anything with no
 * freighter in the catalogue.
 */
export const CONVERSIONS = {
  b737800:   { to: 'b737800bcf' },
  b737400:   { to: 'b737400f' },
  b737300:   { to: 'b737300f' },
  a321ceo:   { to: 'a321p2f' },
  e190:      { to: 'e190f' },
  b767200er: { to: 'b767200sf' },
  dc863:     { to: 'dc873f' },
  l188:      { to: 'l188f' },
  b767300:   { to: 'b767300f',  lineId: 'conv_b767', standIn: true },
  a330200:   { to: 'a330200f',  lineId: 'conv_a330', standIn: true },
  a300600r:  { to: 'a300600f',  lineId: 'conv_a300', standIn: true },
  md11:      { to: 'md11f',     lineId: 'conv_dc10', standIn: true },
  dc1030:    { to: 'dc1030f',   lineId: 'conv_dc10', standIn: true },
  b747400:   { to: 'b747400f',  lineId: 'conv_b747', standIn: true },
  b747200:   { to: 'b747200f',  lineId: 'conv_b747', standIn: true },
  b757200:   { to: 'b757200pf', lineId: 'conv_b757', standIn: true },
  b727200:   { to: 'b727200f',  lineId: 'conv_b727', standIn: true },
};

/** { fromType, toType, lineId, standIn } for a passenger type id, or null. */
export function conversionFor(typeId) {
  const def = CONVERSIONS[typeId];
  if (!def) return null;
  const fromType = getAircraftType(typeId);
  const toType   = getAircraftType(def.to);
  if (!fromType || !toType) return null;
  return { fromType, toType, lineId: def.lineId ?? lineOf(toType), standIn: def.standIn === true };
}

/** What converting one frame to `toType` costs ($). */
export function conversionCost(toType) {
  return Math.round(eraPurchasePrice(toType) * CONVERSION_COST_PCT);
}

/** Weeks in the hangar (the minimum — a busy line can add a wait). */
export function conversionDowntimeWeeks(toType) {
  const t = Number(toType?.payloadTonnes) || 0;
  return CONVERSION_DOWNTIME_WEEKS.find(b => t <= b.maxTonnes).weeks;
}

/** Routes (passenger and cargo) this tail operates, covers included. */
export function routesFlownBy(state, aircraftId) {
  return [...(state?.routes ?? []), ...(state?.cargoRoutes ?? [])].filter(r => r?.aircraftId === aircraftId);
}

/**
 * Why this tail cannot be converted, or null. `closeRoutes` waives the
 * "still flying routes" refusal (the Fleet screen's one-click "close its
 * routes and convert").
 */
export function conversionRefusal(state, aircraft, { closeRoutes = false } = {}) {
  if (!aircraft) return { code: 'missing', message: 'No such aircraft.' };
  const type = getAircraftType(aircraft.typeId);
  if (aircraft.status === 'retired') return { code: 'retired', message: 'That aircraft has been retired.' };
  if (aircraft.pendingConversion) return { code: 'converting', message: 'Already in conversion.' };
  if (type?.freighter) return { code: 'freighter', message: 'Already a freighter.' };
  const conv = conversionFor(aircraft.typeId);
  if (!conv) return { code: 'no_conversion', message: `No freighter conversion exists for the ${type?.name ?? aircraft.typeId}.` };
  if (aircraft.ownershipType !== 'owned') {
    return { code: 'leased', message: 'Only aircraft you own can be converted — the lessor owns this one. Buy out the lease first.' };
  }
  if (isOutOfService(aircraft)) {
    return { code: 'out_of_service', message: 'In maintenance or grounded — convert it once it is back in service.' };
  }
  const cy = calendarYear(state);
  const avail = aircraftAvailability(conv.toType, cy);
  if (avail === 'future') {
    return { code: 'not_yet', message: `${conv.toType.name} conversions start in ${conv.toType.eis}.` };
  }
  if (avail === 'expired' || conv.toType.withdrawnYear != null && cy != null && cy >= conv.toType.withdrawnYear) {
    return { code: 'closed', message: `The ${conv.toType.name} conversion programme has closed.` };
  }
  const ev = eventAircraftDenial(state, conv.toType.id);
  if (ev) return { code: ev.code, message: ev.message };
  if (!closeRoutes) {
    const n = routesFlownBy(state, aircraft.id).length;
    if (n > 0) {
      return { code: 'has_routes', routes: n,
               message: `Still flies ${n} route${n === 1 ? '' : 's'} — close ${n === 1 ? 'it' : 'them'} to convert.` };
    }
  }
  return null;
}

/**
 * Quote converting a selection. `eligible` will be converted; `refused` says
 * why the rest won't. `byId[id]` is each tail's { capex, toTypeId, lineId,
 * downtimeWeeks, doneAbsWeek, readyInWeeks } — the exact booking the reducer
 * makes. `capex` is the total the reducer takes.
 *
 * @returns {{ ok, reasons: string[], eligible: object[], refused: {aircraft, code, message}[],
 *             capex: number, byId: object, routesToClose: number }}
 */
export function canConvertToFreighter(state, aircraftList = [], { closeRoutes = false } = {}) {
  const absWeek = absoluteWeek(state?.year ?? 1, state?.week ?? 1);
  const lineWorld = state?.productionLinesWorld === true;
  const allocators = new Map();
  const eligible = [];
  const refused = [];
  const byId = {};
  let capex = 0;
  let routesToClose = 0;
  for (const a of aircraftList ?? []) {
    const why = conversionRefusal(state, a, { closeRoutes });
    if (why) { refused.push({ aircraft: a, ...why }); continue; }
    const { toType, lineId } = conversionFor(a.typeId);
    const downtimeWeeks = conversionDowntimeWeeks(toType);
    let doneAbsWeek = absWeek + downtimeWeeks;
    if (lineWorld) {
      if (!allocators.has(lineId)) allocators.set(lineId, makeLineSlotAllocator(state, lineId, absWeek));
      doneAbsWeek = allocators.get(lineId).take(doneAbsWeek);
    }
    const cost = conversionCost(toType);
    byId[a.id] = {
      capex: cost, toTypeId: toType.id, lineId: lineWorld ? lineId : null,
      downtimeWeeks, doneAbsWeek, readyInWeeks: doneAbsWeek - absWeek,
    };
    capex += cost;
    routesToClose += routesFlownBy(state, a.id).length;
    eligible.push(a);
  }
  const reasons = [];
  if (eligible.length === 0) {
    reasons.push(refused.length === 1 ? refused[0].message
      : refused.length > 1 ? 'None of these aircraft can be converted.' : 'No aircraft selected.');
  } else if ((Number(state?.cash) || 0) < capex) {
    reasons.push(eligible.length === 1
      ? 'Not enough cash for the conversion.'
      : `Not enough cash to convert ${eligible.length} aircraft.`);
  }
  return { ok: reasons.length === 0, reasons, eligible, refused, capex, byId, routesToClose };
}

/** The tail as it goes into the hangar. `quote` is its byId entry. */
export function startConversion(aircraft, quote, absWeek) {
  return {
    ...aircraft,
    status:         'maintenance',
    checkType:      'P2F',
    checkForced:    false,
    checkWeeksLeft: Math.max(1, quote.doneAbsWeek - absWeek),
    scheduledCheck: null,
    reserveBase:    null,
    pendingConversion: {
      toTypeId: quote.toTypeId, lineId: quote.lineId ?? null, capex: quote.capex,
      doneAbsWeek: quote.doneAbsWeek, startedAbsWeek: absWeek,
    },
  };
}

/** "Airbus A321P2F #3": one past the highest number in use for the type. */
export function convertedName(toType, fleet = [], pendingOrders = []) {
  const ofType = [...fleet, ...pendingOrders].filter(x => x && x.typeId === toType.id);
  let max = ofType.length;
  for (const item of ofType) {
    const m = /#(\d+)\s*$/.exec(item.name ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${toType.name} #${max + 1}`;
}

/**
 * The tail coming out of the hangar: freighter type, empty cabin, fresh
 * C/D clocks (the conversion included a heavy check), the age credit, and
 * the book-value record. `fleet` names it; the caller passes the fleet as it
 * stands so two conversions finishing the same week get different numbers.
 */
export function completeConversion(aircraft, absWeek, hasRoute, { fleet = [], pendingOrders = [] } = {}) {
  const p = aircraft?.pendingConversion;
  const fromType = getAircraftType(aircraft?.typeId);
  const toType = getAircraftType(p?.toTypeId);
  if (!p || !fromType || !toType) return aircraft;
  const capex = Math.max(0, Math.round(Number(p.capex) || 0));
  const basis = Number(aircraft.costBasis);
  const priorBook = tailBookValue(aircraft, fromType);
  const { pendingConversion, ...rest } = aircraft;
  return {
    ...rest,
    typeId:         toType.id,
    name:           convertedName(toType, fleet, pendingOrders),
    status:         hasRoute ? 'assigned' : 'idle',
    checkType:      null,
    checkForced:    false,
    checkWeeksLeft: 0,
    config:         newAircraftConfig(toType),
    hasWifi:        false,
    hoursSinceC: 0, weeksSinceC: 0, cDueAtWeek: null,
    hoursSinceD: 0, weeksSinceD: 0, dDueAtWeek: null,
    conversionAgeCreditWeeks: P2F_AGE_CREDIT_WEEKS,
    // Never worth more than was paid for it, conversion included.
    costBasis: Math.round((Number.isFinite(basis) && basis >= 0 ? basis : priorBook) + capex),
    conversion: {
      fromTypeId: fromType.id,
      fromName:   aircraft.name ?? null,
      capex,
      ageWeeksAtConversion: aircraft.ageWeeks ?? 0,
      completedAbsWeek: absWeek,
    },
  };
}

/** What a tail in the hangar is in for: "C check", "D check" or "Freighter conversion". */
export function inShopLabel(aircraft) {
  return aircraft?.checkType === 'P2F' ? 'Freighter conversion' : `${aircraft?.checkType || 'C'} check`;
}
