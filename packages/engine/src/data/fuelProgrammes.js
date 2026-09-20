/**
 * fuelProgrammes.js — the fuel-efficiency programme (FUEL_OPERATIONS_PLAN.md §6).
 *
 * Airline-wide operational levers that cut BURN, as opposed to hedges, which
 * fix the PRICE. Real airlines run dozens of these (single-engine taxi, cost
 * index, weight reduction, engine washing…); each is worth a percent or two,
 * and together they are the difference between a fuel-disciplined carrier and
 * one that just pays. Five to eight percent off a $62M/wk bill beats the hedge
 * that started the Discord thread, and it reads as progression.
 *
 * Every programme has a cost and a side effect that hooks an EXISTING system,
 * so a player has to choose rather than tick every box:
 *
 *   burn        fraction of fuel burn removed while active (compounds)
 *   oneOff      capex charged at activation ($, or $ per tail)
 *   weekly      opex charged every week while active ($ flat + $ per tail)
 *   otpDelta    punctuality points given up (through labor.eventOtpDelta)
 *   maintMod    multiplier on fleet maintenance cost
 *   failureMult multiplier on the weekly mechanical-failure odds
 *   requires    'hub' — needs a designated hub (ground power lives at hubs)
 *
 * Where the burn lands: tickPrep multiplies the fleet burn modifier into the
 * multiplier the route sims receive (`fuelSimMultiplier`), while the PRICE
 * multiplier (`fuelMultiplier`, what hedges blend) is untouched — so the base
 * bill fuelImpact.js reconstructs is "this flying, with these programmes, at
 * 1.0×", and hedge accounting stays exact. Every preview reads the same
 * projected multiplier, so a programme moves the launch form by precisely
 * what it moves the tick.
 *
 * Tuning constants live here and nowhere else.
 */

export const FUEL_PROGRAMMES = [
  {
    id: 'single_engine_taxi',
    label: 'Single-engine taxi',
    description: 'Taxi out and in on one engine. Cheap fuel; uneven engine cycles cost a little maintenance.',
    burn: 0.008,
    oneOff: { flat: 2_000_000, perTail: 0 },
    weekly: { flat: 0, perTail: 0 },
    maintMod: 1.01,
  },
  {
    id: 'cost_index',
    label: 'Reduced cruise speed',
    description: 'Fly a lower cost index. The biggest single saving, paid for in punctuality: block times stretch and the schedule absorbs less.',
    burn: 0.020,
    oneOff: { flat: 0, perTail: 0 },
    weekly: { flat: 0, perTail: 0 },
    otpDelta: 0.015,
  },
  {
    id: 'weight_reduction',
    label: 'Weight reduction',
    description: 'Lighter seats and galley carts, less potable water, electronic flight bags. Capex per tail, then it is free.',
    burn: 0.010,
    oneOff: { flat: 0, perTail: 120_000 },
    weekly: { flat: 0, perTail: 0 },
  },
  {
    id: 'flight_planning',
    label: 'Optimised flight planning',
    description: 'Licensed routing and continuous-descent planning. No trade-off — you simply pay for it every week.',
    burn: 0.015,
    oneOff: { flat: 0, perTail: 0 },
    weekly: { flat: 400_000, perTail: 1_500 },
  },
  {
    id: 'apu_policy',
    label: 'Ground power at hubs',
    description: 'Shut the APU down and plug into the gate. Only pays where you have a hub to plug into.',
    burn: 0.005,
    oneOff: { flat: 0, perTail: 0 },
    weekly: { flat: 0, perTail: 0 },
    requires: 'hub',
  },
  {
    id: 'contingency_fuel',
    label: 'Statistical contingency fuel',
    description: 'Carry the contingency the data says you need, not the rule of thumb. Lighter aircraft; a little less margin when something goes wrong.',
    burn: 0.015,
    oneOff: { flat: 0, perTail: 0 },
    weekly: { flat: 0, perTail: 0 },
    failureMult: 1.10,
  },
  {
    id: 'engine_wash',
    label: 'Engine wash programme',
    description: 'Regular core washes. Costs per tail every week, and helps the engines as well as the fuel bill.',
    burn: 0.010,
    oneOff: { flat: 0, perTail: 0 },
    weekly: { flat: 0, perTail: 6_000 },
    maintMod: 0.98,
  },
];

export const FUEL_PROGRAMME_MAP = Object.fromEntries(FUEL_PROGRAMMES.map(p => [p.id, p]));

/** Ids of the programmes currently switched on. Absent state → none. */
export function activeProgrammeIds(state) {
  const fp = state?.fuelProgrammes ?? {};
  return FUEL_PROGRAMMES.filter(p => fp[p.id]?.active === true).map(p => p.id);
}

/** Tails a per-tail charge applies to: everything not retired. */
export function chargeableFleetSize(fleet = []) {
  return (fleet ?? []).filter(a => a && a.status !== 'retired').length;
}

/**
 * The fleet-wide burn modifier: Π (1 − burn_i) over active programmes.
 * Exactly 1 when nothing is on, so a save with no programmes multiplies the
 * sims' fuel multiplier by 1 and the golden master does not move.
 */
export function fleetBurnMod(state) {
  let mod = 1;
  for (const id of activeProgrammeIds(state)) mod *= 1 - FUEL_PROGRAMME_MAP[id].burn;
  return mod === 1 ? 1 : parseFloat(mod.toFixed(6));
}

/** Multiplier on fleet maintenance cost from active programmes (1 when none). */
export function programmeMaintMod(state) {
  let mod = 1;
  for (const id of activeProgrammeIds(state)) mod *= FUEL_PROGRAMME_MAP[id].maintMod ?? 1;
  return mod === 1 ? 1 : parseFloat(mod.toFixed(6));
}

/** Punctuality given up by active programmes, as an otpDelta (0 when none). */
export function programmeOtpDelta(state) {
  let d = 0;
  for (const id of activeProgrammeIds(state)) d += FUEL_PROGRAMME_MAP[id].otpDelta ?? 0;
  return d;
}

/** Multiplier on weekly mechanical-failure odds (1 when none). */
export function programmeFailureMult(state) {
  let m = 1;
  for (const id of activeProgrammeIds(state)) m *= FUEL_PROGRAMME_MAP[id].failureMult ?? 1;
  return m;
}

/** This week's opex for the active programmes ($, rounded; 0 when none). */
export function programmeWeeklyCost(state, fleet = state?.fleet) {
  const tails = chargeableFleetSize(fleet);
  let total = 0;
  for (const id of activeProgrammeIds(state)) {
    const w = FUEL_PROGRAMME_MAP[id].weekly;
    total += (w?.flat ?? 0) + (w?.perTail ?? 0) * tails;
  }
  return Math.round(total);
}

/** Capex to switch a programme on now, for this fleet. */
export function programmeActivationCost(id, fleet = []) {
  const p = FUEL_PROGRAMME_MAP[id];
  if (!p) return 0;
  return Math.round((p.oneOff?.flat ?? 0) + (p.oneOff?.perTail ?? 0) * chargeableFleetSize(fleet));
}

/**
 * Whether a programme can be switched on, and why not. Mirrors what
 * SET_FUEL_PROGRAMME checks, so the toggle the player sees is the toggle the
 * reducer honours.
 */
export function canActivateProgramme(state, id) {
  const p = FUEL_PROGRAMME_MAP[id];
  if (!p) return { ok: false, reason: 'Unknown programme.', capex: 0 };
  if (state?.fuelProgrammes?.[id]?.active) return { ok: false, reason: 'Already running.', capex: 0 };
  const capex = programmeActivationCost(id, state?.fleet ?? []);
  if (p.requires === 'hub') {
    const hasHub = Object.values(state?.hubs ?? {}).some(h => h && h.tier != null);
    if (!hasHub) return { ok: false, reason: 'Needs a designated hub — ground power lives at the gate.', capex };
  }
  if ((Number(state?.cash) || 0) < capex) {
    return { ok: false, reason: 'Not enough cash for the one-off cost.', capex };
  }
  return { ok: true, reason: null, capex };
}

/**
 * What the programme set is doing for the airline this week, in dollars, from
 * a tick report: fuel at burn 1.0 would have been totalFuel / burnMod.
 */
export function programmeSavingsFromReport(report) {
  const mod = Number(report?.fuelBurnMod);
  if (!(mod > 0) || mod === 1) return 0;
  const fuel = Number(report?.totalFuel) || 0;
  return Math.round(fuel / mod - fuel);
}
