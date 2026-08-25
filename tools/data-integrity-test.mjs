// Data-integrity guards for the airport table and same-metro suppression (P4).
//   H4  — no exurban field carries a whole metro's population (HPN/SWF were 20.1)
//   H18 — different-city pairs a road/rail run apart carry no air O&D; genuine
//         water/island hops in the same band keep their demand (allow-list)
//   DKR/DSS — a duplicate-coordinate airport can't be flown between
//
// Run: node tools/data-integrity-test.mjs
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import {
  distanceKm, baseCityPairDemand, cargoCityPairDemand,
  isSameMetro, isSurfaceConnected, isSameLocation,
  WATER_HOP_PAIRS, SAME_METRO_MAX_KM, SURFACE_CONNECTED_MAX_KM, SAME_LOCATION_MAX_KM,
} from '../src/utils/market.js';

let passed = 0, failed = 0;
const ok  = (m) => { passed++; };
const bad = (m) => { failed++; console.log('  FAIL:', m); };
const eq  = (a, b, m) => (a === b ? ok(m) : bad(`${m} — got ${a}, expected ${b}`));
const truthy = (v, m) => (v ? ok(m) : bad(m));

// ── H4: exurban New York fields no longer carry the whole metro's 20.1 M ──────
truthy(getAirport('HPN').population < 2, 'HPN (White Plains) resident mass < 2 M');
truthy(getAirport('SWF').population < 2, 'SWF (Newburgh) resident mass < 2 M');

// ── DKR/DSS duplicate location ────────────────────────────────────────────────
eq(isSameLocation(getAirport('DKR'), getAirport('DSS')), true,  'DKR/DSS flagged same location');
eq(isSameLocation(getAirport('JFK'), getAirport('LAX')), false, 'JFK/LAX not same location');
const dupPairs = [];
for (let i = 0; i < AIRPORTS.length; i++) for (let j = i + 1; j < AIRPORTS.length; j++) {
  const a = AIRPORTS[i], b = AIRPORTS[j];
  if (a.code !== b.code && distanceKm(a, b) < SAME_LOCATION_MAX_KM) dupPairs.push(`${a.code}-${b.code}`);
}
eq(dupPairs.sort().join(','), 'DKR-DSS', 'the only sub-2 km distinct-airport pair is DKR/DSS');

// ── H18: road/rail pairs suppressed, water/island hops spared ─────────────────
const SUPPRESSED_TARGETS = [
  ['HKG','SZX'], ['SIN','JHB'], ['MCO','SFB'], ['FUK','KKJ'], ['SUB','MLG'],
  ['AMS','RTM'], ['VIE','BTS'], ['DUS','CGN'], ['SEA','PAE'], ['MAN','LPL'],
];
for (const [o, d] of SUPPRESSED_TARGETS) {
  eq(baseCityPairDemand(o, d), 0, `pax demand suppressed ${o}-${d}`);
  eq(cargoCityPairDemand(o, d), 0, `cargo demand suppressed ${o}-${d}`);
}
const WATER_HOPS = [
  ['ACK','HYA'], ['SAB','SXM'], ['YCD','YVR'], ['YVR','YYJ'], ['EFL','ZTH'],
  ['CUN','CZM'], ['SJU','VQS'], ['ACE','FUE'], ['GIB','TTU'],
];
for (const [o, d] of WATER_HOPS) {
  truthy(baseCityPairDemand(o, d) > 0, `water-hop demand preserved ${o}-${d}`);
}

// ── Allow-list hygiene: every entry is two real airports, in the 35–65 km band ─
for (const key of WATER_HOP_PAIRS) {
  const [x, y] = key.split('|');
  const ax = getAirport(x), ay = getAirport(y);
  if (!ax || !ay) { bad(`allow-list entry ${key} references an unknown airport`); continue; }
  const km = distanceKm(ax, ay);
  truthy(km >= SAME_METRO_MAX_KM && km < SURFACE_CONNECTED_MAX_KM,
    `allow-list ${key} is in the ${SAME_METRO_MAX_KM}-${SURFACE_CONNECTED_MAX_KM} km band (${km.toFixed(1)} km)`);
}

// ── Coverage canary: the in-band split is pinned, so a NEW short different-city
//    pair added to airports.js trips this test for review (classify it: leave it
//    suppressed if road/rail links the cities, or add it to WATER_HOP_PAIRS). ──
let suppressed = 0, spared = 0;
for (let i = 0; i < AIRPORTS.length; i++) for (let j = i + 1; j < AIRPORTS.length; j++) {
  const a = AIRPORTS[i], b = AIRPORTS[j];
  const km = distanceKm(a, b);
  if (km < SAME_METRO_MAX_KM || km >= SURFACE_CONNECTED_MAX_KM) continue;
  if (a.city === b.city || isSameMetro(a, b, km)) continue;
  if (isSurfaceConnected(a, b, km)) suppressed++; else spared++;
}
eq(suppressed, 125, 'in-band suppressed pair count (re-pin after a reviewed airport-data change)');
eq(spared, 28, 'in-band spared (water-hop) pair count');

console.log(`\ndata-integrity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
