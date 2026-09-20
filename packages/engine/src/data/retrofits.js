/**
 * retrofits.js — winglet retrofits on the existing fleet
 * (FUEL_OPERATIONS_PLAN.md §6.2).
 *
 * Wingtip devices were an ORDER-TIME choice only: ORDER_AIRCRAFT folds the
 * type's `configOptions.wingtips` (fuelMod, rangeMod, cost) into the tail and
 * sets `hasWingtips`. Real airlines retrofit them by the hundred — it is the
 * single most common fuel-efficiency capex there is — so a tail that was
 * ordered bare, or arrived used, can now be fitted.
 *
 * Same shape as the Wi-Fi retrofit (data/wifi.js): a line-fit at the factory
 * is the cheap path; a retrofit means a hangar slot and an STC, so it carries
 * the same 40% premium, and the preview helper is the number the reducer
 * charges (RETROFIT_WINGTIPS calls canRetrofitWingtips too).
 */

import { getAircraftType } from './aircraft.js';

export const WINGTIP_RETROFIT_PREMIUM = 0.40;

/** The type's wingtip option for this tail, or null when the type has none. */
export function wingtipDefFor(aircraft) {
  const type = aircraft?.typeId ? getAircraftType(aircraft.typeId) : null;
  return type?.configOptions?.wingtips ?? null;
}

export function hasWingtips(aircraft) {
  return aircraft?.hasWingtips === true;
}

/** What fitting this one tail costs now. 0 when it cannot be fitted. */
export function wingtipRetrofitCost(aircraft) {
  const def = wingtipDefFor(aircraft);
  if (!def) return 0;
  return Math.round((def.cost ?? 0) * (1 + WINGTIP_RETROFIT_PREMIUM));
}

/** Why a tail cannot take the retrofit, or null when it can. */
export function wingtipRefusal(aircraft) {
  if (!aircraft) return 'No such aircraft.';
  if (aircraft.status === 'retired') return 'That aircraft has been retired.';
  if (hasWingtips(aircraft)) return 'Already fitted with wingtip devices.';
  if (!wingtipDefFor(aircraft)) return `No wingtip device exists for the ${getAircraftType(aircraft.typeId)?.name ?? aircraft.typeId}.`;
  return null;
}

/**
 * Quote a retrofit for a selection. `eligible` are the tails that will be
 * fitted; `capex` is exactly what the reducer will take.
 *
 * @returns {{ ok, reasons: string[], eligible: object[], unfittable: object[], capex: number, byId: Object<string, number> }}
 */
export function canRetrofitWingtips(aircraftList = [], cash = 0) {
  const candidates = (aircraftList ?? []).filter(a => a && !hasWingtips(a) && a.status !== 'retired');
  const unfittable = candidates.filter(a => !wingtipDefFor(a));
  const eligible   = candidates.filter(a =>  wingtipDefFor(a));
  const byId = Object.fromEntries(eligible.map(a => [a.id, wingtipRetrofitCost(a)]));
  const capex = eligible.reduce((s, a) => s + byId[a.id], 0);
  const reasons = [];
  if (eligible.length === 0) {
    reasons.push(unfittable.length > 0 && candidates.length === unfittable.length
      ? (unfittable.length === 1
          ? wingtipRefusal(unfittable[0])
          : 'None of these types has a wingtip device to fit.')
      : 'Every aircraft selected already has wingtip devices.');
  } else if ((Number(cash) || 0) < capex) {
    reasons.push('Not enough cash to fit wingtips to this many aircraft.');
  }
  return { ok: reasons.length === 0, reasons, eligible, unfittable, capex, byId };
}

/** The tail after fitting: burn and range modifiers folded in, flag set. */
export function fitWingtips(aircraft) {
  const def = wingtipDefFor(aircraft);
  if (!def || hasWingtips(aircraft)) return aircraft;
  return {
    ...aircraft,
    hasWingtips: true,
    fuelMod:  Math.round((aircraft.fuelMod  ?? 1.0) * (def.fuelMod  ?? 1.0) * 10000) / 10000,
    rangeMod: Math.round((aircraft.rangeMod ?? 1.0) * (def.rangeMod ?? 1.0) * 10000) / 10000,
  };
}
