// Ground handling stations — self-handling at the airports where you have the
// volume to justify it.
//
// Ground handling today is a pure per-passenger contract (overhead.js §5): every
// boarded passenger pays a handler $10–$55 by cabin, wherever they board, and
// the only discount is the small hub `stationDiscount` a T1+ hub earns for free.
// That is what an airline with no ramp presence of its own pays, and it is the
// right default — self-handling is a fixed-cost bet that only a hub can win.
//
// A STATION turns that per-head contract into capex plus a weekly payroll at ONE
// airport. It handles up to a level-set number of weekly departures there; the
// departures it covers pay GROUND_STATION_DISCOUNT less, the rest spill to the
// contractor at the full rate. Three levels, each a superset of the one below,
// and — like a jet base — an upgrade builds in place, so the existing station
// keeps working throughout.
//
// Two effects, both proportional to how much of the airport you actually cover:
//
//   1. Cost. Ground handling at that endpoint is discounted by
//      GROUND_STATION_DISCOUNT × efficiency × covered share. Taken as the BEST
//      of this and the hub station discount, never stacked, so a T3 hub with a
//      station is not double-counted and nothing already earned is taken away.
//   2. On-time rate. Your own ramp crews turn your own aircraft first. Up to
//      GROUND_STATION_OTP_BONUS airline-wide, weighted by the share of your
//      weekly departures that are self-handled — so one station at a 40-route
//      hub moves the number and a station at a two-route outstation does not.
//
// Deliberately NOT modelled: cargo. Freighter handling is priced per tonne on
// its own line (CARGO_HANDLING_PER_TONNE) and a passenger ramp crew is not a
// cargo terminal; cargo departures neither consume station capacity nor earn
// the discount. A cargo terminal is a separate build, if it is ever wanted.
//
// State shape, keyed by airport code like mroBases and lounges:
//   groundStations: { [code]: { code, level, openedWeek, buildWeeksLeft,
//                               upgradeTo, upgradeWeeksLeft } }
//
// Shared by the reducer (enforcement), the tick (effects) and the UI (display),
// exactly as mroBase.js and lounges.js are — the UI never prices anything the
// reducer will not charge.

// ─── Levels ──────────────────────────────────────────────────────────────────

export const GROUND_STATION_LEVELS = {
  1: {
    level: 1,
    name: 'Ramp Station',
    blurb: 'Your own ramp agents, bag handlers and a pushback tug. Turns a mid-sized station; overflow goes to the contractor.',
    capex: 8_000_000,
    weeklyOpex: 60_000,
    buildWeeks: 8,
    gatesRequired: 2,
    weeklyDepartures: 250,
  },
  2: {
    level: 2,
    name: 'Handling Base',
    blurb: 'A full ground operation with its own GSE fleet and check-in staff. Covers a busy hub.',
    capex: 18_000_000,
    weeklyOpex: 130_000,
    buildWeeks: 12,
    gatesRequired: 3,
    weeklyDepartures: 600,
  },
  3: {
    level: 3,
    name: 'Hub Operation',
    blurb: 'A terminal-scale ground operation. Handles every departure you can schedule here.',
    capex: 40_000_000,
    weeklyOpex: 260_000,
    buildWeeks: 16,
    gatesRequired: 4,
    weeklyDepartures: Infinity,
  },
};

export const GROUND_STATION_MAX_LEVEL = 3;

/** Discount on per-passenger ground handling for a self-handled departure, at full efficiency. */
export const GROUND_STATION_DISCOUNT = 0.30;

/** Premium on the capex gap when upgrading in place (rebuilding around a live operation). */
export const GROUND_STATION_UPGRADE_PREMIUM = 0.15;

/** Fraction of cumulative capex refunded on close. Half that while still building. */
export const GROUND_STATION_CLOSE_REFUND = 0.25;

/** Weeks from opening until a station runs at full efficiency; starts at the floor. */
export const GROUND_STATION_RAMP_WEEKS = 12;
export const GROUND_STATION_RAMP_FLOOR = 0.60;

/** Airline-wide on-time bonus (rate points) when EVERY departure is self-handled at full efficiency. */
export const GROUND_STATION_OTP_BONUS = 0.03;

export function stationLevelDef(level) {
  return GROUND_STATION_LEVELS[level] ?? null;
}

// ─── Capex ───────────────────────────────────────────────────────────────────

export function stationBuildCapex(level) {
  return stationLevelDef(level)?.capex ?? 0;
}

/** Capex to upgrade an existing station from `fromLevel` to `toLevel`. */
export function stationUpgradeCapex(fromLevel, toLevel) {
  const from = stationLevelDef(fromLevel);
  const to   = stationLevelDef(toLevel);
  if (!from || !to || to.level <= from.level) return 0;
  return Math.round((to.capex - from.capex) * (1 + GROUND_STATION_UPGRADE_PREMIUM));
}

/**
 * Cumulative capex sunk into a station: the level it is AT plus any upgrade
 * paid for and still building. Drives the close refund.
 */
export function stationSunkCapex(station) {
  if (!station) return 0;
  let sunk = stationBuildCapex(station.level);
  if (station.upgradeTo) sunk += stationUpgradeCapex(station.level, station.upgradeTo);
  return sunk;
}

/** Cash back when a station is closed. Half rate while it is still being built. */
export function stationCloseRefund(station) {
  if (!station) return 0;
  const rate = isStationOpen(station) ? GROUND_STATION_CLOSE_REFUND : GROUND_STATION_CLOSE_REFUND * 0.5;
  return Math.round(stationSunkCapex(station) * rate);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Record factory. A brand-new station is under construction, not open. */
export function makeStation(code, level, absWeek = 0) {
  const def = stationLevelDef(level);
  return {
    code,
    level,
    openedWeek:     (absWeek ?? 0) + (def?.buildWeeks ?? 0),
    buildWeeksLeft: def?.buildWeeks ?? 0,
  };
}

/** True once construction has finished and the station is actually working. */
export function isStationOpen(station) {
  return !!station && (station.buildWeeksLeft ?? 0) <= 0;
}

/** Any open station in the network? Cheap gate for the tick's per-route work. */
export function hasOpenStation(stations = {}) {
  return Object.values(stations ?? {}).some(isStationOpen);
}

/**
 * Efficiency of a station this week: 0 while building, then ramping from
 * GROUND_STATION_RAMP_FLOOR to 1.0 over GROUND_STATION_RAMP_WEEKS from the week
 * it opened. An in-place upgrade does not restart the ramp — the crews are the
 * same crews.
 */
export function stationEfficiency(station, absWeek) {
  if (!isStationOpen(station)) return 0;
  const opened = station?.openedWeek ?? absWeek;
  const weeks  = Math.max(0, (absWeek ?? 0) - opened);
  const ramp   = Math.min(1, weeks / GROUND_STATION_RAMP_WEEKS);
  return GROUND_STATION_RAMP_FLOOR + (1 - GROUND_STATION_RAMP_FLOOR) * ramp;
}

/** Weekly departures this station can self-handle at its CURRENT level. */
export function stationCapacity(station) {
  if (!isStationOpen(station)) return 0;
  return stationLevelDef(station?.level)?.weeklyDepartures ?? 0;
}

/**
 * Weekly opex of one station. Only an OPEN station bills — construction is
 * capex, already paid — and an upgrade under way bills at the level it is
 * still operating, not the one it is building.
 */
export function stationWeeklyCost(station) {
  if (!isStationOpen(station)) return 0;
  return stationLevelDef(station?.level)?.weeklyOpex ?? 0;
}

/** Total weekly opex of every station an airline owns. */
export function totalStationWeeklyCost(stations = {}) {
  let total = 0;
  for (const s of Object.values(stations ?? {})) total += stationWeeklyCost(s);
  return total;
}

/**
 * Advance construction one week. Pure — returns a NEW map plus what finished
 * this week, so the reducer can toast it. Mirrors tickBaseConstruction.
 */
export function tickStationConstruction(stations = {}, absWeek = 0) {
  const out = {};
  const opened = [];
  const upgraded = [];
  for (const [code, station] of Object.entries(stations ?? {})) {
    if (!station) continue;
    const left = station.buildWeeksLeft ?? 0;
    if (left > 0) {
      const next = Math.max(0, left - 1);
      out[code] = { ...station, buildWeeksLeft: next, openedWeek: next === 0 ? absWeek : station.openedWeek };
      if (next === 0) opened.push({ code, level: station.level });
      continue;
    }
    const upLeft = station.upgradeWeeksLeft ?? 0;
    if (upLeft > 0) {
      const next = Math.max(0, upLeft - 1);
      if (next === 0) {
        const newLevel = station.upgradeTo ?? station.level;
        out[code] = { ...station, level: newLevel, upgradeTo: null, upgradeWeeksLeft: 0 };
        upgraded.push({ code, level: newLevel });
      } else {
        out[code] = { ...station, upgradeWeeksLeft: next };
      }
      continue;
    }
    out[code] = station;
  }
  return { stations: out, opened, upgraded };
}

/**
 * Can a station be built (or upgraded) here, and what does it cost?
 *
 * Shared by the reducer (enforcement) and the UI (display), so the player is
 * always shown exactly what the reducer will check.
 *
 * @param {string} code    airport
 * @param {number} level   target level (a build if no station here, else an upgrade)
 * @param {{stations: object, gates: object, cash: number}} snap
 */
export function canBuildStation(code, level, snap = {}) {
  const { stations = {}, gates = {}, cash = 0 } = snap;
  const def = stationLevelDef(level);
  const reasons = [];
  if (!def) return { ok: false, reasons: ['Unknown station level'], capex: 0, gatesNeeded: 0, def: null };
  if (!code) return { ok: false, reasons: ['Pick an airport.'], capex: def.capex, gatesNeeded: def.gatesRequired, def };

  const existing = stations[code] ?? null;
  const upgrade  = !!existing;
  const capex    = upgrade ? stationUpgradeCapex(existing.level, level) : stationBuildCapex(level);

  if (upgrade) {
    if (!isStationOpen(existing)) reasons.push('This station is still being built.');
    if (existing.upgradeTo) reasons.push('An upgrade is already under way here.');
    if (level <= existing.level) reasons.push(`Already a ${stationLevelDef(existing.level)?.name ?? 'station'} — pick a higher level.`);
  }

  const held = gates?.[code] ?? 0;
  if (held < def.gatesRequired) {
    reasons.push(`Needs ${def.gatesRequired} gates at ${code} (you hold ${held}).`);
  }
  if (cash < capex) {
    reasons.push(`Needs ${capex.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} in cash.`);
  }
  return { ok: reasons.length === 0, reasons, capex, gatesNeeded: def.gatesRequired, def };
}

// ─── Departures and coverage ─────────────────────────────────────────────────

/**
 * Weekly PASSENGER departures at every airport, from the route list. A round
 * trip departs once from each end per frequency; a multi-stop rotation departs
 * once from every stop it touches. `stopsOf(route)` is supplied by the caller
 * (simulation.js's routeStops) so this module stays free of simulation imports.
 *
 * Only ACTIVE passenger routes count: a dormant seasonal route has no
 * departures this week, so it neither fills the station nor earns anything
 * from it.
 */
export function airportDeparturesMap(routes = [], stopsOf) {
  const out = {};
  for (const r of routes ?? []) {
    if (!r) continue;
    if (r.seasonState === 'dormant') continue;
    const freq = Math.max(0, Number(r.weeklyFrequency) || 0);
    if (freq === 0) continue;
    const stops = typeof stopsOf === 'function' ? stopsOf(r) : [r.origin, r.destination];
    for (const code of new Set(stops.filter(Boolean))) {
      out[code] = (out[code] ?? 0) + freq;
    }
  }
  return out;
}

/**
 * How much of an airport's departures this station covers, and the effective
 * discount that earns, this week.
 *
 *   share     0–1: min(capacity / departures, 1). Nothing scheduled → 1 (a
 *             station with nothing to handle is fully "covering" nothing; the
 *             discount is then applied to zero passengers and costs zero).
 *   discount  GROUND_STATION_DISCOUNT × efficiency × share.
 *
 * Pro-rata by design: overflow departures pay the contractor. The alternative
 * (a hard "covered / not covered" per route) would make the answer depend on
 * route ORDER, which is exactly the kind of silent nondeterminism the pooling
 * invariant exists to catch.
 */
export function stationCoverage(station, departures, absWeek) {
  if (!isStationOpen(station)) return { share: 0, discount: 0, efficiency: 0, capacity: 0 };
  const capacity   = stationCapacity(station);
  const efficiency = stationEfficiency(station, absWeek);
  const dep        = Math.max(0, Number(departures) || 0);
  const share      = dep === 0 ? 1 : Math.min(1, capacity / dep);
  return { share, efficiency, capacity, discount: GROUND_STATION_DISCOUNT * efficiency * share };
}

/**
 * Per-endpoint ground handling discount for a route, as the BEST of the hub
 * station discount and the self-handling discount — never the sum. Returns the
 * route-level factor (mean over endpoints, the same shape hubCostFactorsAt uses
 * for `station`), or null when no open station touches the route, so a route
 * object in a station-less airline is byte-identical to before (golden parity).
 *
 * @param {object} hubTiers     HUB_TIERS (passed in, not imported — keeps data/ free of models/)
 * @param {object} hubs         state.hubs
 * @param {object} stations     state.groundStations
 * @param {string[]} codes      the airports the route touches
 * @param {object} departures   airportDeparturesMap(...)
 * @param {number} absWeek
 */
export function groundHandlingFactorAt(hubTiers, hubs, stations, codes, departures, absWeek) {
  if (!codes?.length) return null;
  let anyStation = false;
  let sum = 0;
  for (const c of codes) {
    const t = hubs?.[c]?.tier;
    const hubDisc = t != null ? (hubTiers?.[t]?.stationDiscount ?? 0) : 0;
    const st = stations?.[c];
    let stDisc = 0;
    if (isStationOpen(st)) {
      anyStation = true;
      stDisc = stationCoverage(st, departures?.[c] ?? 0, absWeek).discount;
    }
    sum += Math.max(hubDisc, stDisc);
  }
  if (!anyStation) return null;
  return +(1 - sum / codes.length).toFixed(4);
}

/**
 * Share of the airline's weekly passenger departures that are self-handled,
 * efficiency-weighted — the input to the on-time bonus. 0 with no stations.
 */
export function selfHandledDepartureShare(stations = {}, departures = {}, absWeek = 0) {
  let total = 0, covered = 0;
  for (const [code, dep] of Object.entries(departures ?? {})) {
    total += dep;
    const st = stations?.[code];
    if (!isStationOpen(st)) continue;
    const cov = stationCoverage(st, dep, absWeek);
    covered += dep * cov.share * cov.efficiency;
  }
  return total > 0 ? Math.min(1, covered / total) : 0;
}

/** Airline-wide on-time bonus from self-handling this week (rate points, ≥ 0). */
export function stationOtpBonus(stations = {}, departures = {}, absWeek = 0) {
  if (!hasOpenStation(stations)) return 0;
  return +(GROUND_STATION_OTP_BONUS * selfHandledDepartureShare(stations, departures, absWeek)).toFixed(4);
}

/** Total gates consumed by an airline's station at a given airport. */
export function stationGatesConsumedAt(stations = {}, code) {
  const st = stations?.[code];
  return st ? (stationLevelDef(st.level)?.gatesRequired ?? 0) : 0;
}
