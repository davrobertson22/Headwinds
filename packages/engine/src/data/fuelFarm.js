/**
 * fuelFarm.js — owning the fuel at your airports (FUEL_OPERATIONS_PLAN.md §8).
 *
 * Most airport fuel farms are owned by consortia of the airlines that use
 * them, and a few carriers own the farm and hydrant outright at their
 * fortress hubs. So at any station where you have enough departures you can:
 *
 *   1  Consortium stake   a seat at the airport's fuel consortium — capex by
 *                         airport size, your uplift there 4% cheaper, forever.
 *   2  Owned farm         you run the tank farm and hydrant — four times the
 *                         stake, 10% cheaper ramping in over six months, and
 *                         ONE owner per airport per world: the owner collects a
 *                         throughput fee on every rival's uplift there.
 *
 * Because it is per airport it only pays where your uplift concentrates: a
 * hub carrier putting 40% of its fuel through one station gets ~4% off its
 * whole bill from one farm; a point-to-point carrier gets almost nothing.
 * That is the design — it rewards hub concentration, and at a shared mega hub
 * the ownership race is the multiplayer game.
 *
 * Fees never raise a rival's price: the 3% is the margin the consortium used
 * to keep, now captured by the owner (no griefing lever). Alliance members
 * pay half the fee and receive half the discount — the lounge / MRO
 * alliance-guest rule.
 *
 * The discount lands in data/fuelStations.js as a per-station discount map
 * (setFuelStationDiscounts), set from state at the same four sites as the
 * station knob, so the sims and every preview price your uplift the same way.
 * Depends on Phase 4: needs station pricing (state.fuelOpsV >= 2) and the
 * report's fuelByStation.
 */

import { getAirport } from './airports.js';

// The route's stations (routeStops in utils/simulation.js, inlined so a data
// module does not import the sim that imports it).
const stopsOf = (r) => (Array.isArray(r?.stops) && r.stops.length >= 2 ? r.stops : [r?.origin, r?.destination]);

export const FARM_LEVELS = {
  1: {
    level: 1, name: 'Consortium stake',
    blurb: 'A seat at the airport fuel consortium. Your uplift here is 4% cheaper, from the day you sign.',
    discount: 0.04,
    capexByTier: { regional: 8_000_000, major: 30_000_000, mega: 80_000_000 },
    opexPctPerWeek: 0.0010,
    minDepartures: 20,
    rampWeeks: 0,
  },
  2: {
    level: 2, name: 'Owned fuel farm',
    blurb: 'You run the tank farm and hydrant. Your uplift here is 10% cheaper once the operation has bedded in, and every rival who fuels here pays you a throughput fee.',
    discount: 0.10,
    capexMultOfStake: 4,
    opexPctPerWeek: 0.0015,
    minDepartures: 60,
    rampWeeks: 26,
    rampFloor: 0.60,
    exclusive: true,
  },
};
export const FARM_MAX_LEVEL = 2;
export const FARM_CLOSE_REFUND = 0.25;
export const FARM_HOST_FEE_PCT = 0.03;      // owner's cut of a rival's uplift $ at the station
export const FARM_ALLIANCE_SHARE = 0.5;     // allies: half the discount, half the fee
export const FARMS_PER_AIRCRAFT = 25;       // owned farms cap: max(1, floor(fleet / 25))

export function farmLevelDef(level) { return FARM_LEVELS[level] ?? null; }

/** Capex to hold `level` at this airport (an upgrade pays the difference). */
export function farmCapex(level, codeOrAirport) {
  const airport = typeof codeOrAirport === 'string' ? getAirport(codeOrAirport) : codeOrAirport;
  const stake = FARM_LEVELS[1].capexByTier[airport?.tier] ?? FARM_LEVELS[1].capexByTier.major;
  if (level === 1) return stake;
  if (level === 2) return stake * FARM_LEVELS[2].capexMultOfStake;
  return 0;
}

export function farmWeeklyOpex(farm) {
  const def = farmLevelDef(farm?.level);
  if (!def) return 0;
  return Math.round((farm.capex ?? 0) * def.opexPctPerWeek);
}

export function totalFarmWeeklyCost(farms = {}) {
  return Object.values(farms ?? {}).reduce((s, f) => s + farmWeeklyOpex(f), 0);
}

export function farmCloseRefund(farm) {
  return Math.round((farm?.capex ?? 0) * FARM_CLOSE_REFUND);
}

/** How much of the level's discount is live: stakes are instant, farms ramp 60% → 100% over 26 weeks. */
export function farmEfficiency(farm, absWeek) {
  const def = farmLevelDef(farm?.level);
  if (!def) return 0;
  if (!(def.rampWeeks > 0)) return 1;
  const weeks = Math.max(0, (absWeek ?? 0) - (farm.builtAbsWeek ?? absWeek ?? 0));
  const ramp  = Math.min(1, weeks / def.rampWeeks);
  return def.rampFloor + (1 - def.rampFloor) * ramp;
}

/** The discount this farm gives its owner this week (fraction of the station basis). */
export function farmDiscount(farm, absWeek) {
  const def = farmLevelDef(farm?.level);
  if (!def) return 0;
  return parseFloat((def.discount * farmEfficiency(farm, absWeek)).toFixed(4));
}

/** Weekly departures the airline flies FROM this station (each route departs from both ends). */
export function ownDeparturesAt(state, code) {
  let n = 0;
  for (const r of [...(state?.routes ?? []), ...(state?.cargoRoutes ?? [])]) {
    if (!r || (r.status && r.status !== 'active' && r.seasonState === 'dormant')) continue;
    const stops = stopsOf(r);
    if (stops.includes(code)) n += r.weeklyFrequency ?? 0;
  }
  return n;
}

export function ownedFarmCap(state) {
  const fleet = (state?.fleet ?? []).filter(a => a && a.status !== 'retired').length;
  return Math.max(1, Math.floor(fleet / FARMS_PER_AIRCRAFT));
}

export function ownedFarmCount(state) {
  return Object.values(state?.fuelFarms ?? {}).filter(f => f?.level === 2).length;
}

/** The rival (from state.competitors, the world's injected views) that owns the farm here, or null. */
export function rivalFarmOwnerAt(state, code) {
  for (const c of state?.competitors ?? []) {
    if (c?.fuelFarms?.[code] === 2) return c;
  }
  return null;
}

/**
 * Whether the airline can take `level` at `code`, and the capex it would pay
 * now (an upgrade from a stake pays the difference). Mirrors what the reducer
 * checks, so the button says what the reducer does.
 */
export function canTakeFarm(state, code, level) {
  const def = farmLevelDef(level);
  const airport = getAirport(code);
  const reasons = [];
  const current = state?.fuelFarms?.[code] ?? null;
  const fullCapex = farmCapex(level, airport);
  const capex = Math.max(0, fullCapex - (current?.capex ?? 0));
  if (!def || !airport) return { ok: false, reasons: ['No such airport.'], capex: 0, def, current };
  if ((Number(state?.fuelOpsV) || 0) < 2) reasons.push('Station fuel pricing is not on in this world.');
  if (current && current.level >= level) reasons.push(`You already hold ${FARM_LEVELS[current.level].name.toLowerCase()} at ${code}.`);
  const deps = ownDeparturesAt(state, code);
  if (deps < def.minDepartures) reasons.push(`Needs ${def.minDepartures} weekly departures from ${code}; you fly ${deps}.`);
  if (def.exclusive) {
    const rival = rivalFarmOwnerAt(state, code);
    if (rival) reasons.push(`${rival.name ?? 'A rival'} already owns the fuel farm at ${code} — one owner per airport.`);
    if (ownedFarmCount(state) >= ownedFarmCap(state) && current?.level !== 2) {
      reasons.push(`Owned farms are capped at one per ${FARMS_PER_AIRCRAFT} aircraft (you may own ${ownedFarmCap(state)}).`);
    }
  }
  if ((Number(state?.cash) || 0) < capex) reasons.push(`Not enough cash: ${level === 2 ? 'the farm' : 'the stake'} costs ${Math.round(capex / 1e6)}M.`);
  return { ok: reasons.length === 0, reasons, capex, fullCapex, def, current, departures: deps };
}

export function makeFarm(code, level, absWeek, capex) {
  return { code, level, builtAbsWeek: absWeek, capex };
}

/**
 * Per-station discount map for the airline this week: own farms at their
 * live discount, plus allied rivals' owned farms at half. Consumed by
 * data/fuelStations.js through setFuelStationDiscounts.
 */
export function farmDiscountsOf(state, absWeek) {
  const out = {};
  for (const [code, f] of Object.entries(state?.fuelFarms ?? {})) {
    const d = farmDiscount(f, absWeek);
    if (d > 0) out[code] = d;
  }
  const myAlliance = state?.allianceMembership?.allianceId ?? null;
  if (myAlliance) {
    for (const c of state?.competitors ?? []) {
      if (!c?.fuelFarms || c.allianceId !== myAlliance) continue;
      for (const [code, level] of Object.entries(c.fuelFarms)) {
        if (level !== 2 || out[code] != null) continue;
        out[code] = parseFloat((FARM_LEVELS[2].discount * FARM_ALLIANCE_SHARE).toFixed(4));
      }
    }
  }
  return out;
}

/** The fee an owner collects on one payer's uplift $ at the station. */
export function farmFeeOn(upliftUsd, { allied = false } = {}) {
  const usd = Math.max(0, Number(upliftUsd) || 0);
  return Math.round(usd * FARM_HOST_FEE_PCT * (allied ? FARM_ALLIANCE_SHARE : 1));
}

/** Public shape for the rival view: { [code]: level }. */
export function publicFarmsOf(state) {
  const out = {};
  for (const [code, f] of Object.entries(state?.fuelFarms ?? {})) if (f?.level) out[code] = f.level;
  return out;
}
