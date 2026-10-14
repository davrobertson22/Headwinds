// Airport market size: every O&D market touching an airport, summed.
//
// Discord, 2026-10-12 (VodkaOnFire): "you can't sort ALL airports by PAX or
// anything like that, which is what I'd like." The Airports tab's All airports
// table sorts the world by the passenger and freight markets each airport sits
// in — the same pools the Route Planner and Cargo Planner price, added up over
// every other airport in the game.
//
// Summing every airport against each other is ~2.3M pair evaluations (~3.5 s),
// far too slow for opening a tab, so tools/generate-airport-markets.mjs does it
// once into packages/engine/src/data/airportMarkets.js. Re-run it whenever airports or the
// demand model change; tools/airport-markets-test.mjs fails when it is stale.
//
// What is stored, per airport:
//   * cargo — Σ cargoCityPairDemand(o, d), the annual-average tonnes/week.
//     Freight does not grow with the calendar, so this is the in-game figure.
//   * passengers — Σ baseCityPairDemand(o, d), split into one bucket per
//     destination demand-growth rate. Passenger demand grows per pair
//     (pairDemandGrowth): one world-wide factor in an era game, and in a classic
//     game √((1+gO)(1+gD))^years, capped. Within one bucket gD is constant, so
//     the grown market is Σ_k bucket_k × growth(gO, g_k) — exact, not an
//     estimate. Seasonality is left out on purpose: the column is a typical
//     week, so a sort doesn't reshuffle every month.

import { AIRPORTS, getAirport } from '../data/airports.js';
import { metroPrimary } from '../data/metros.js';
import { eraDemandGrowthFactor } from '../data/era.js';
import {
  baseCityPairDemand, cargoCityPairDemand,
  COUNTRY_DEMAND_GROWTH, DEFAULT_DEMAND_GROWTH, DEMAND_GROWTH_CAP,
} from './market.js';

/** The classic-world demand growth rate pairDemandGrowth uses for this airport. */
export function demandGrowthRateFor(code) {
  const a = getAirport(metroPrimary(code));
  if (!a) return DEFAULT_DEMAND_GROWTH;
  return COUNTRY_DEMAND_GROWTH[a.country] ?? DEFAULT_DEMAND_GROWTH;
}

/** Every distinct growth rate an airport can have, ascending. */
export function growthBuckets() {
  return [...new Set([...Object.values(COUNTRY_DEMAND_GROWTH), DEFAULT_DEMAND_GROWTH])].sort((a, b) => a - b);
}

/**
 * Market rows for `codes` against every airport in the game:
 * { [code]: [cargoTonnesWk, paxBucket0, paxBucket1, …] }, integers.
 * Pair demand is symmetric, so each pair is evaluated once.
 */
export function computeAirportMarkets(codes = AIRPORTS.map(a => a.code), buckets = growthBuckets()) {
  const all = AIRPORTS.map(a => a.code);
  const rate = new Map(all.map(c => [c, demandGrowthRateFor(c)]));
  const bucketOf = new Map(buckets.map((g, i) => [g, i]));
  const want = new Set(codes);
  const acc = new Map([...want].map(c => [c, { cargo: 0, pax: new Array(buckets.length).fill(0) }]));
  const add = (o, d) => {
    const row = acc.get(o);
    if (!row) return;
    row.pax[bucketOf.get(rate.get(d))] += baseCityPairDemand(o, d);
    row.cargo += cargoCityPairDemand(o, d);
  };
  if (want.size === all.length) {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const o = all[i], d = all[j];
        const pax = baseCityPairDemand(o, d), cargo = cargoCityPairDemand(o, d);
        const ro = acc.get(o), rd = acc.get(d);
        ro.pax[bucketOf.get(rate.get(d))] += pax; ro.cargo += cargo;
        rd.pax[bucketOf.get(rate.get(o))] += pax; rd.cargo += cargo;
      }
    }
  } else {
    for (const o of want) for (const d of all) if (d !== o) add(o, d);
  }
  const out = {};
  for (const [code, { cargo, pax }] of acc) out[code] = [Math.round(cargo), ...pax.map(Math.round)];
  return out;
}

/**
 * Passenger growth factor for one bucket, as pairDemandGrowth computes it.
 * @param {number} gO      origin airport's growth rate
 * @param {number} gD      destination bucket's growth rate
 * @param {number|null} absWeek
 * @param {number|null} eraStartYear  state.startYear (null in a classic world)
 */
export function bucketGrowth(gO, gD, absWeek, eraStartYear) {
  if (Number.isInteger(eraStartYear)) return eraDemandGrowthFactor(eraStartYear, absWeek);
  if (absWeek == null || !(absWeek > 1)) return 1;
  const years = (absWeek - 1) / 52;
  return Math.min(DEMAND_GROWTH_CAP, Math.pow(Math.sqrt((1 + gO) * (1 + gD)), years));
}

/**
 * { pax, cargo } weekly market for an airport at a point in the game.
 * @param {string} code
 * @param {Array<number>} row       [cargo, ...paxBuckets] from the table
 * @param {Array<number>} buckets   the table's growth buckets
 * @param {{absWeek?: number, eraStartYear?: number|null}} when
 */
export function airportMarketNow(code, row, buckets, { absWeek = null, eraStartYear = null } = {}) {
  if (!row) return { pax: 0, cargo: 0 };
  const gO = demandGrowthRateFor(code);
  let pax = 0;
  for (let k = 0; k < buckets.length; k++) {
    const s = row[k + 1] ?? 0;
    if (s) pax += s * bucketGrowth(gO, buckets[k], absWeek, eraStartYear);
  }
  return { pax: Math.round(pax), cargo: row[0] ?? 0 };
}
