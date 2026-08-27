// Fixed costs step with SEATS, not with the category boundary.
//
// CREW_SCALE_BY_CATEGORY and HQ_SCALE_BY_CATEGORY both keyed off `category`,
// which put a cliff at every boundary. The worst one:
//
//   757-300   Narrow Body  295 seats   labour $58,000  + HQ $38,000  = $96,000
//   767-200ER Wide Body    290 seats   labour $105,300 + HQ $59,658  = $164,958
//
// Five fewer seats, 72% more fixed cost — and the 757-300 came out with the
// lowest break-even load factor of any aircraft in the game as a result. A
// category is a shorthand for size; where the two disagree, size wins.
//
// The category tables are KEPT as the anchor points, so every calibrated number
// still holds exactly at its category's median seat count (the same medians the
// per-departure fee table in overhead.js was calibrated against). Only aircraft
// BETWEEN two anchors move, and they now interpolate instead of jumping.
//
// Freighters keep their payload bands — they have no cabin to count. Supersonic
// stays a category override: Concorde is 128 seats of extraordinary complexity
// and interpolating it against a regional jet would be wrong.
//
//   node tools/seat-scale-continuity-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  hqScaleFor, scaleBySeats, CATEGORY_MEDIAN_SEATS,
  HQ_SCALE_BY_CATEGORY, calcHQCost,
} from '../packages/engine/src/data/overhead.js';
import { crewScaleFor, LABOR_GROUPS, CREW_SCALE_BY_CATEGORY } from '../packages/engine/src/data/labor.js';
import { bestCaseProfit, sector } from './catalogue-deadweight-report.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}
// Double-deckers and Concorde are excluded from the SIZE comparisons below on
// purpose. Their cost is structural, not size-derived: a 747SP is a 747 with the
// fuselage cut short — four engines, an upper deck and 747 systems on 400 seats —
// so it legitimately costs more to crew and administer than a 406-seat A330-200.
// Interpolating them on seats would be the same mistake in the other direction.
const P = AIRCRAFT_TYPES.filter(t =>
  !t.freighter && t.seats > 0 && t.category !== 'Supersonic' && !t.doubleDeck);
const fixedOf = (t) => {
  let labour = 0;
  for (const g of LABOR_GROUPS) labour += g.baseWeeklyPerAircraft * crewScaleFor(g.id, t);
  return labour + calcHQCost(hqScaleFor(t));
};

console.log('\nthe cliff is gone');

test('the 767-200ER no longer pays 72% more fixed cost than a LARGER 757-300', () => {
  const wb = getAircraftType('b767200er'), nb = getAircraftType('b757300');
  assert.ok(wb.seats < nb.seats, 'precondition: the 767-200ER is the smaller aircraft');
  assert.ok(fixedOf(wb) < fixedOf(nb),
    `the smaller aircraft must not cost more: 767-200ER $${Math.round(fixedOf(wb))} vs 757-300 $${Math.round(fixedOf(nb))}`);
});

test('fixed cost never falls as seats rise, anywhere in the catalogue', () => {
  // Against the running MAXIMUM, not just the previous element: comparing
  // neighbours skips over ties, which is how the 747SP hid behind the L-1011 at
  // 400 seats the first time this was written.
  const sorted = [...P].sort((a, b) => a.seats - b.seats);
  let peak = { t: sorted[0], v: fixedOf(sorted[0]) };
  for (const cur of sorted.slice(1)) {
    const v = fixedOf(cur);
    if (cur.seats > peak.t.seats) {
      assert.ok(v >= peak.v - 1,
        `${cur.id} (${cur.seats} seats, $${Math.round(v)}) undercuts ${peak.t.id} (${peak.t.seats} seats, $${Math.round(peak.v)})`);
    }
    if (v > peak.v) peak = { t: cur, v };
  }
});

test('fixed cost PER SEAT never rises as the aircraft gets bigger', () => {
  // The scale-free way to say "no cliffs". An absolute threshold cannot work
  // across this range: ten seats is a rounding error on a 550-seater and a 111%
  // capacity increase between a 9-seat Islander and a 19-seat L-410, so the
  // first version of this test flagged a correct 1.65x as a cliff. What must
  // hold everywhere is the economy of scale itself — per-seat overhead falls
  // monotonically, currently $1,840/seat at 9 seats down to $351 at 550.
  const sorted = [...P].sort((a, b) => a.seats - b.seats);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (cur.seats <= prev.seats) continue;
    const perPrev = fixedOf(prev) / prev.seats, perCur = fixedOf(cur) / cur.seats;
    assert.ok(perCur <= perPrev * 1.0001,
      `${cur.id} (${cur.seats} seats, $${Math.round(perCur)}/seat) costs more per seat than ` +
      `${prev.id} (${prev.seats} seats, $${Math.round(perPrev)}/seat)`);
  }
});

console.log('\nthe calibrated anchors are untouched');

test('every category still returns its calibrated value at its median seat count', () => {
  for (const [cat, seats] of Object.entries(CATEGORY_MEDIAN_SEATS)) {
    assert.ok(Math.abs(scaleBySeats(HQ_SCALE_BY_CATEGORY, seats) - HQ_SCALE_BY_CATEGORY[cat]) < 1e-9,
      `HQ ${cat} at ${seats} seats`);
    for (const g of LABOR_GROUPS) {
      assert.ok(Math.abs(scaleBySeats(CREW_SCALE_BY_CATEGORY[g.id], seats) - CREW_SCALE_BY_CATEGORY[g.id][cat]) < 1e-9,
        `${g.id} ${cat} at ${seats} seats`);
    }
  }
});

test('narrowbody at its median is still exactly 1.00 — the whole calibration hangs on it', () => {
  assert.equal(scaleBySeats(HQ_SCALE_BY_CATEGORY, CATEGORY_MEDIAN_SEATS['Narrow Body']), 1);
  for (const g of LABOR_GROUPS) {
    assert.equal(scaleBySeats(CREW_SCALE_BY_CATEGORY[g.id], CATEGORY_MEDIAN_SEATS['Narrow Body']), 1);
  }
});

test('the ends clamp rather than extrapolate, so the A380 does not silently reprice', () => {
  const a380 = getAircraftType('a380');
  assert.ok(a380.seats > CATEGORY_MEDIAN_SEATS['Double Deck']);
  assert.equal(hqScaleFor(a380), HQ_SCALE_BY_CATEGORY['Double Deck']);
});

console.log('\nthe exceptions stay exceptional');

test('freighters still step by payload, not by a cabin they do not have', () => {
  const small = AIRCRAFT_TYPES.find(t => t.freighter && (t.payloadTonnes ?? 0) <= 20);
  const large = AIRCRAFT_TYPES.find(t => t.freighter && (t.payloadTonnes ?? 0) > 130);
  assert.ok(hqScaleFor(large) > hqScaleFor(small));
  assert.ok(crewScaleFor('cabinCrew', large) === 0, 'a freighter has no cabin crew');
});

test('Concorde keeps its category override rather than interpolating as a regional jet', () => {
  const c = getAircraftType('concorde');
  assert.equal(hqScaleFor(c), HQ_SCALE_BY_CATEGORY['Supersonic']);
  assert.ok(hqScaleFor(c) > scaleBySeats(HQ_SCALE_BY_CATEGORY, c.seats),
    'interpolating 128 seats would under-price it badly');
});

test('an unknown category with a real seat count still interpolates, never returns free', () => {
  assert.ok(hqScaleFor({ category: 'Orbital Shuttle', seats: 200 }) > 0);
  assert.equal(hqScaleFor(null), 1);
});

// ── 5. The bottom of the curve ───────────────────────────────────────────────
console.log('\nthe curve reaches the bottom of the catalogue');

test('the anchor table extends below the 39-seat turboprop', () => {
  const seats = Object.values(CATEGORY_MEDIAN_SEATS).sort((a, b) => a - b);
  assert.ok(seats[0] <= 9,
    `the smallest anchor is ${seats[0]} seats, so everything below it is charged as a ${seats[0]}-seater`);
});

test('scale keeps falling below 39 seats, for HQ and every crew group', () => {
  for (const table of [HQ_SCALE_BY_CATEGORY, ...LABOR_GROUPS.map(g => CREW_SCALE_BY_CATEGORY[g.id])]) {
    const at = (n) => scaleBySeats(table, n);
    assert.ok(at(9) < at(19), `9 seats (${at(9)}) must cost less than 19 (${at(19)})`);
    assert.ok(at(19) < at(39), `19 seats (${at(19)}) must cost less than 39 (${at(39)})`);
  }
});

test('the 39-seat turboprop anchor is untouched — the calibration still holds', () => {
  assert.equal(scaleBySeats(HQ_SCALE_BY_CATEGORY, 39), HQ_SCALE_BY_CATEGORY['Turboprop']);
  for (const g of LABOR_GROUPS) {
    assert.equal(scaleBySeats(CREW_SCALE_BY_CATEGORY[g.id], 39), CREW_SCALE_BY_CATEGORY[g.id]['Turboprop']);
  }
});

test('the shortest fields in the game can be served by something that makes money', () => {
  // 25 airports sit under 4,000ft and SBH (Gustaf III) is 2,119ft. If nothing
  // that can land there can clear zero with every seat sold at its best
  // frequency, those airports are dead content and so are the aircraft built
  // for them.
  const s = sector('SBH', 'SXM');
  assert.ok(s, 'the SBH-SXM fixture needs both airports in the catalogue');
  const viable = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats > 0)
    .map(t => ({ t, p: bestCaseProfit(t, s) }))
    .filter(x => x.p != null && x.p > 0);
  assert.ok(viable.length > 0,
    'no aircraft can profitably serve a 2,119ft field even with every seat sold');
});

test('cheap small aircraft do not become the answer to everything', () => {
  // The counter-risk of opening the bottom: a 9-seater at 28 rotations a week is
  // structurally the same shape as any other high-frequency exploit. On a route
  // with real demand, a proper regional aircraft must still win.
  const s = sector('BOI', 'SLC');
  const tiny = bestCaseProfit(getAircraftType('bn2islander'), s);
  const real = bestCaseProfit(getAircraftType('dhc8300'), s);
  assert.ok(real > tiny, `a 56-seat Dash 8 (${Math.round(real)}) must beat a 9-seat Islander (${Math.round(tiny)}) where demand supports it`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
