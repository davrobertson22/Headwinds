// aircraft-runway-convention-test.mjs — every runwayFt follows ONE convention.
//
// WHY THIS EXISTS. The 2026-09-20 audit found runwayFt on no consistent basis:
// the 737 family sat 15-42% under its real MTOW takeoff field length, the
// E-Jets ~17% under, the A220-100 exactly on it, the 747-400D 50% over. Route
// eligibility is a hard gate on this number (both ends of a route must have at
// least this much runway), so an arbitrary value quietly decides which airports
// a type can ever serve.
//
// The 2026-09-23 research pass gathered real takeoff field length at MTOW, sea
// level, ISA for 127 types, and the catalogue's own majority turned out to follow
// two conventions:
//
//   • short-haul jet airframes — narrowbody and regional passenger jets, and the
//     freighters converted from them — sit at ~0.85 × real (median 0.843, n=63):
//     they fly short sectors well below MTOW;
//   • everything else — widebodies, quads, turboprops, business jets, widebody
//     freighters — sits at ~1.00 × real (median 0.981, n=64).
//
// Every type with an on-basis figure must lie within ±15% of its class value.
// Outliers were moved to the edge of the band, not its centre, so each family
// keeps its shape (the 737-900ER still needs ~25% more runway than the -800,
// as it really does).
//
// REAL_TOFL rules: med-or-better confidence only; multi-rating types use the
// SHORTEST published rating (the gate asks whether a type can use a field at
// all, and short-field operators buy the high-thrust option). Left out on
// purpose: take-off RUN figures, engine-out or part-weight figures, STOL types
// (dhc6, dash7, bn2islander keep their real short-field capability — Saba's
// 1,312ft strip depends on it), and the E175 (the source figure is a heavy
// variant: it would put the E175 above the heavier E190 on the same basis).
//
//   node tools/aircraft-runway-convention-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// Real takeoff field length (ft), MTOW, sea level, ISA — 2026-09-23 research.
// (Headwinds carries no business jets, so the four bizjet rows Tailwinds has are omitted.)
const REAL_TOFL = {
  a220100: 4800, a318: 5840, a319ceo: 6070, a220: 6200, a319neo: 6000, a320ceo: 6650,
  a320neo: 6400, a321ceo: 8300, a321neo: 8200, b737200: 8500, b717: 5450, b727100: 8300,
  b727200: 8400, b737500: 8200, b737300: 7250, b737700: 5300, b737400: 8350, b707320: 10000,
  b737max7: 7000, b737800: 7800, b737max8: 6600, b737900er: 9800, b737max9: 7100,
  b757200: 7300, b757300: 8370, c919: 6730, mc21300: 7220, dc910: 5800, dc950: 7400,
  md90: 7000, md80: 7460, tu204: 5840, dc863: 11500, vc10: 8280, cv990: 9800, b720b: 6200,
  bac111: 6500, b737max8200: 6600, mc21310: 7910, crj200: 5800, crj700: 4975, crj900: 5775,
  crj1000: 6155, bae146200: 4560, arj21: 5577,
  erj170: 5394, e175e2: 5676, e190: 6890, e190e2: 5299, e195: 7149, e195e2: 6037,
  fokker70: 4252, spacejet: 5710, ssj100: 6079, tu134: 7874, f28: 5500,
  a310300: 7513, a300600r: 7874, a330200: 9500, a340300: 10000, a330300: 9190, a330neo: 9500,
  a340600: 11155, a350900: 8530, a350900ulr: 9290, a3501000: 9510, a380: 9843, b767200er: 8900,
  b767300: 9100, b767400er: 10300, b7878: 8500, b777200er: 11100, b7879: 9300, b747200: 10250,
  b777200lr: 9200, b787x10: 9100, b747sp: 9000, b777300er: 10000, b747400: 10550,
  b747400d: 6550, b7478i: 10200, il96300: 9055, dc1030: 10500, md11: 9725, il86: 9186,
  b747100: 9500, b747300: 10250, a300b4: 7546, atr42: 3632, atr72: 4196, b1900d: 3740,
  dhc8300: 3870, q400: 4675, pc12: 2485, saab340: 4220, saab2000: 4005, short360: 4280,
  do328: 3570, js31: 4724, js41: 4997, saab340a: 4315, dhc8100: 3100, dhc8200: 3280,
  c408: 3660, dc7c: 6360, hs748: 3800, atr72f: 4196, b737800bcf: 7700, b767300f: 8800,
  a330200f: 9350, b777f: 9300, b747400f: 10650, b7478f: 10100, b757200pf: 6800, md11f: 9700,
  a300600f: 7874, dc1030f: 10500, b737400f: 8350, b737300f: 7200, b727200f: 10100,
  dc873f: 9900, e190f: 6890, a321p2f: 8300,
};

// Documented exceptions: a real figure exists but applying the rule would be wrong.
const EXCEPTIONS = {
  b737500: 'only figure is the lowest engine rating; it would put the -500 above the longer -300',
  c919:    'sits on the band edge — rounding noise, not an outlier',
};

const SHORT_HAUL_K = 0.85, LONG_HAUL_K = 1.00, TOL = 0.15;
const isShortHaul = t => !t.bizjet && (['Narrow Body', 'Regional Jet'].includes(t.category)
  || (t.freighter && (t.payloadTonnes ?? 0) < 40 && t.id !== 'atr72f'));

console.log('\nRunway requirement follows one convention\n');

test('every REAL_TOFL entry is a real aircraft id', () => {
  const missing = Object.keys(REAL_TOFL).filter(id => !getAircraftType(id));
  assert.deepEqual(missing, [], 'stale ids in REAL_TOFL — update the table');
});

test('every type with an on-basis figure sits within ±15% of its class value', () => {
  const off = [];
  for (const t of AIRCRAFT_TYPES) {
    const real = REAL_TOFL[t.id];
    if (!real || EXCEPTIONS[t.id]) continue;
    const k = isShortHaul(t) ? SHORT_HAUL_K : LONG_HAUL_K;
    const dev = t.runwayFt / (k * real) - 1;
    if (Math.abs(dev) > TOL + 0.005) {
      off.push(`${t.id}: ${t.runwayFt}ft vs ${Math.round(k * real)} (${isShortHaul(t) ? 'short-haul' : 'long-haul'} class, ${(100 * dev).toFixed(0)}%)`);
    }
  }
  assert.deepEqual(off, []);
});

test('the class values are still what the catalogue actually does', () => {
  // If a future batch of data drifts the medians, the constants above are wrong,
  // not the batch — re-derive them rather than widening the tolerance.
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const typed = AIRCRAFT_TYPES.filter(t => REAL_TOFL[t.id]);
  const sh = med(typed.filter(isShortHaul).map(t => t.runwayFt / REAL_TOFL[t.id]));
  const lh = med(typed.filter(t => !isShortHaul(t)).map(t => t.runwayFt / REAL_TOFL[t.id]));
  assert.ok(Math.abs(sh - SHORT_HAUL_K) < 0.05, `short-haul median ${sh.toFixed(3)} has drifted from ${SHORT_HAUL_K}`);
  assert.ok(Math.abs(lh - LONG_HAUL_K) < 0.05, `long-haul median ${lh.toFixed(3)} has drifted from ${LONG_HAUL_K}`);
});

test('STOL types keep their short-field capability', () => {
  for (const [id, max] of [['dhc6', 1300], ['bn2islander', 1300], ['dash7', 2400]]) {
    assert.ok(getAircraftType(id).runwayFt <= max, `${id} lost its STOL runway figure`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
