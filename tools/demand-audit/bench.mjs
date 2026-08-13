// Demand-model benchmark harness (2026-07 recalibration — see docs/DEMAND_MODEL_AUDIT.md)
// ---------------------------------------------------------------------------------------
// Compares baseCityPairDemand() against real-world one-way weekly O&D passengers for
// 47 city pairs. Real figures derived from OAG Busiest Routes 2025 (annual seats),
// Wikipedia busiest-routes pax counts, and schedule-based estimates:
//   annual pax = seats × lf;   one-way weekly O&D = annual pax × od / 2 / 52
// where lf = assumed load factor and od = O&D share of segment traffic (the game
// adds connecting demand separately, so segment counts must be stripped to O&D).
//
//   node tools/demand-audit/bench.mjs
//
// Healthy output: median & geo-mean ≈ 1.0, spread (max/min ratio) < ~10.
// Re-run after touching the gravity model, country tables, or airport mass data.

import { baseCityPairDemand, routeDistance } from '../../packages/engine/src/utils/market.js';

// 2026-08 metro rework: baseCityPairDemand now returns the METRO-pair total for
// any pair touching a multi-airport metro (JFK-LHR = all of New York-London;
// see data/metros.js). Rows touching such metros carry a `metroX` multiplier —
// the ratio of the metro-pair's real O&D to the benchmarked member pair's
// (e.g. BOS-LGA 2.0: LGA carries about half of Boston-NYC once JFK and EWR are
// added). These aggregation factors are schedule-derived estimates (low-to-med
// confidence) — the single-airport rows are the calibration anchors.
//
//        pair        category                 raw      unit    lf   od   confidence          metroX
const B = [
  ['GMP-CJU','captive short-haul',  14.4e6,'seats',.82,.98,'high (OAG25)',1.07],
  ['HND-CTS','captive short-haul',  12.1e6,'seats',.82,.95,'high (OAG25)',1.15],
  ['HND-FUK','captive short-haul',  11.5e6,'seats',.82,.95,'high (OAG25)',1.08],
  ['SGN-HAN','dom trunk',           10.0e6,'seats',.82,.95,'high (OAG25)'],
  ['JED-RUH','dom trunk',            9.8e6,'seats',.82,.95,'high (OAG25)'],
  ['SYD-MEL','dom trunk',            9.22e6,'pax', 1,  .95,'high (WIKI24)'],
  ['HND-OKA','captive short-haul',   4.5e6,'seats',.82,.95,'med (EST)',1.12],
  ['CGK-DPS','captive short-haul',   4.3e6,'seats',.82,.90,'med (EST)',1.1],
  ['JNB-CPT','dom trunk',            4.7e6,'pax',  1,  .95,'med (EST)'],
  ['MCO-SJU','captive',              1.2e6,'pax',  1,  .95,'med (EST)'],
  ['AKL-SYD','captive intl',         1.6e6,'pax',  1,  .85,'med (EST)'],
  ['HKG-TPE','intl short-haul',      6.8e6,'seats',.82,.85,'high (OAG25)'],
  ['CAI-JED','intl short-haul',      5.8e6,'seats',.82,.95,'high (OAG25)'],
  ['SIN-KUL','intl short-haul',      5.6e6,'seats',.82,.90,'high (OAG25)'],
  ['ICN-KIX','intl short-haul',      5.0e6,'seats',.82,.90,'high (OAG25)',1.15],
  ['BKK-HKG','intl short-haul',      3.4e6,'seats',.82,.75,'med (EST)'],
  ['PEK-SHA','dom trunk (HSR rival)',7.5e6,'seats',.82,.95,'high (OAG25)',1.5],
  ['DEL-BOM','dom trunk',            6.47e6,'pax', 1,  .90,'high (WIKI FY24)'],
  ['JFK-LAX','US trunk',             3.43e6,'seats',.82,.85,'high (OAG25)',1.4],
  ['ORD-LGA','US trunk',             3.33e6,'seats',.82,.90,'high (OAG25)',1.55],
  ['LAX-SFO','US trunk',             3.31e6,'seats',.82,.85,'high (OAG25)',1.9],
  ['ATL-MCO','US trunk',             2.3e6,'pax',  1,  .55,'low (EST)',1.05],
  ['DFW-LAX','US trunk',             1.9e6,'pax',  1,  .60,'low (EST)',1.15],
  ['ATL-LGA','US trunk',             1.7e6,'pax',  1,  .70,'low (EST)',1.7],
  ['BOS-LGA','US trunk',             1.05e6,'pax', 1,  .95,'med (EST)',2.0],
  ['ORD-MSP','US trunk',             1.5e6,'pax',  1,  .50,'low (EST)',1.05],
  ['MAD-BCN','intra-Europe',         2.2e6,'pax',  1,  .95,'med (WIKI22+recovery)'],
  ['LHR-DUB','intra-Europe',         2.0e6,'pax',  1,  .90,'med (EST)',1.35],
  ['LHR-AMS','intra-Europe',         1.8e6,'pax',  1,  .75,'med (EST)',1.75],
  ['LGW-BCN','intra-Europe',         0.95e6,'pax', 1,  .95,'med (EST)',2.05],
  ['LHR-ZRH','intra-Europe',         1.5e6,'pax',  1,  .80,'med (EST)',1.3],
  ['JFK-LHR','long-haul',            3.97e6,'seats',.85,.65,'high (OAG25)',1.65],
  ['LHR-LAX','long-haul',            1.9e6,'pax',  1,  .70,'med (EST)',1.2],
  ['JFK-CDG','long-haul',            2.0e6,'pax',  1,  .65,'med (EST)',1.45],
  ['LHR-DXB','long-haul',            3.0e6,'pax',  1,  .65,'med (EST)',1.15],
  ['SIN-LHR','long-haul',            1.35e6,'pax', 1,  .75,'med (EST)',1.1],
  ['LAX-NRT','long-haul',            1.0e6,'pax',  1,  .70,'med (EST)',1.15],
  ['LAX-SYD','long-haul',            1.0e6,'pax',  1,  .80,'med (EST)'],
  ['SFO-HKG','long-haul',            0.8e6,'pax',  1,  .65,'low (EST)',1.05],
  ['GRU-EZE','LatAm',                2.1e6,'pax',  1,  .85,'med (EST)',1.1],
  ['BOG-LIM','LatAm',                1.5e6,'pax',  1,  .75,'med (EST)'],
  ['SEA-YVR','cross-border',         0.8e6,'pax',  1,  .75,'med (EST)'],
  ['YYZ-ORD','cross-border',         0.85e6,'pax', 1,  .60,'low (EST)',1.25],
  ['IST-DXB','intl mid-haul',        1.1e6,'pax',  1,  .60,'low (EST)',1.25],
  ['DAC-DEL','thin intl',            0.28e6,'pax', 1,  .90,'med (EST)'],
  ['MEX-GRU','thin intl',            0.22e6,'pax', 1,  .85,'med (EST)'],
  ['LOS-ADD','thin intl',            0.16e6,'pax', 1,  .60,'low (EST)'],
];

const rows = [];
for (const [pair, cat, raw, unit, lf, od, conf, metroX = 1] of B) {
  const [o, d] = pair.split('-');
  const model = baseCityPairDemand(o, d);
  const annualPax = unit === 'seats' ? raw * lf : raw;
  const real = Math.round(annualPax * od / 2 / 52 * metroX);
  rows.push({ pair, cat, km: routeDistance(o, d), model, real, ratio: +(model / real).toFixed(2), conf });
}
rows.sort((a, b) => a.ratio - b.ratio);
console.table(rows);

const rs = rows.map(r => r.ratio).sort((a, b) => a - b);
const gm = Math.exp(rows.reduce((s, r) => s + Math.log(r.ratio), 0) / rows.length);
console.log('median:', rs[Math.floor(rs.length / 2)],
  ' geo-mean:', gm.toFixed(2),
  ' spread(max/min):', (rs[rs.length - 1] / rs[0]).toFixed(1));
