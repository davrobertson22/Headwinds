// HQ overhead scales with the aeroplane, not the airframe count.
//
// Motivating case, from six live worlds (docs/startup-survival-audit-2026-08-26.md):
// airlines opening on sub-80-seat aircraft died at 70% against a narrowbody's
// 38%, and 11 of 13 whose history covered their whole life never recorded a
// single profitable week. The cause was arithmetic, not skill. calcHQCost
// counted AIRFRAMES, so two turboprops and two A320s were billed the same
// $68,495 a week — and a turboprop pair's entire GROSS revenue at one round
// trip a day is about $48,700 on the calibration table in overhead.js. Head
// office alone was 141% of revenue before fuel, crew or leases.
//
// Crew pay (CREW_SCALE_BY_CATEGORY) and liability insurance
// (LIABILITY_INSURANCE_WEEKLY_BY_CATEGORY) had the identical defect and both
// already step by category. HQ was the last fixed cost still counting frames.
//
// The load-bearing property is that Narrow Body is 1.00 BY CONSTRUCTION: this
// is a re-shape, not a rise, and an all-narrowbody airline's bill must not move
// by a single dollar. The first two blocks pin that in both directions.
//
//   node tools/hq-gauge-scale-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  calcHQCost, hqScaleFor, fleetHQScale, hqBaseWeekly,
  HQ_SCALE_BY_CATEGORY, HQ_SCALE_FREIGHTER,
  HQ_BASE_WEEKLY, HQ_BASE_MIN, HQ_DEPARTURE_FEE, CATEGORY_MEDIAN_SEATS,
} from '../packages/engine/src/data/overhead.js';
import { weeklyTick } from '../packages/engine/src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// Pick a real type per category rather than hard-coding ids, so a catalogue
// rename cannot quietly turn this suite into a no-op.
// Pick each category's ANCHOR aircraft — the median seat count the scale table
// was calibrated against — not merely the first of its category. Since the scale
// became a seat curve (scaleBySeats), only the anchor still returns the table
// value exactly; an arbitrary narrowbody no longer sits at 1.00.
const firstOf = (cat) => AIRCRAFT_TYPES.find(t =>
      t.category === cat && !t.freighter && !t.doubleDeck && t.seats === CATEGORY_MEDIAN_SEATS[cat])
   ?? AIRCRAFT_TYPES.find(t => t.category === cat && !t.freighter && !t.doubleDeck);
const TP = firstOf('Turboprop'), RJ = firstOf('Regional Jet');
const NB = firstOf('Narrow Body'), WB = firstOf('Wide Body');
for (const [n, t] of Object.entries({ TP, RJ, NB, WB })) {
  if (!t) throw new Error(`no catalogue type found for ${n} — fixture is broken`);
}

function tickWith(typeId, n, freq, restricted) {
  const fleet = [], routes = [];
  for (let i = 0; i < n; i++) {
    fleet.push({ id: 'a' + i, typeId, status: 'idle', ownershipType: 'owned', ageWeeks: 20, config: {} });
    routes.push({ id: 'r' + i, aircraftId: 'a' + i, origin: 'JFK', destination: 'LAX', weeklyFrequency: freq, ticketPrice: 300 });
  }
  return weeklyTick({
    fleet, routes, cargoRoutes: [], gates: { JFK: 20, LAX: 20 }, hubs: {},
    ...(restricted ? { newWorldRestrictions: true } : {}),
  });
}

// ── 1. Narrowbody is the anchor and must not move ────────────────────────────
console.log('\nNarrow Body is 1.00 by construction');

test('the narrowbody scale is exactly 1', () => {
  assert.equal(HQ_SCALE_BY_CATEGORY['Narrow Body'], 1);
  assert.equal(hqScaleFor(NB), 1);
});

test('an all-narrowbody fleet still bills the old fleet-count curve, to the dollar', () => {
  for (const n of [1, 2, 5, 10, 40]) {
    assert.equal(tickWith(NB.id, n, 3, false).totalHQCost, Math.round(38_000 * Math.pow(n, 0.85)),
      `${n} narrowbodies must be unchanged`);
  }
});

test('a narrowbody fleet keeps the full restricted-world base', () => {
  const fleet = [{ typeId: NB.id }, { typeId: NB.id }];
  assert.equal(hqBaseWeekly(fleet, a => getAircraftType(a.typeId)), HQ_BASE_WEEKLY);
});

// ── 2. Small gauge gets the relief the audit says it needs ───────────────────
console.log('\nsmall gauge pays a small-gauge head office');

test('a turboprop pair is billed on 0.7 narrowbody-equivalents, not 2 airframes', () => {
  const r = tickWith(TP.id, 2, 3, false);
  assert.equal(r.totalHQCost, calcHQCost(2 * HQ_SCALE_BY_CATEGORY['Turboprop']));
  assert.notEqual(r.totalHQCost, calcHQCost(2));
});

test("head office no longer exceeds a turboprop pair's gross weekly revenue", () => {
  // $3,481 revenue per turboprop departure (overhead.js calibration), 14
  // departures a week for a pair at one round trip a day.
  const grossAtOneRotationADay = 14 * 3_481;
  const before = calcHQCost(2);
  const after  = tickWith(TP.id, 3, 3, false).totalHQCost;
  assert.ok(before > grossAtOneRotationADay, 'precondition: the old bill was above gross revenue');
  assert.ok(after  < grossAtOneRotationADay, `head office ${after} must sit below gross ${grossAtOneRotationADay}`);
});

test('the restricted-world base scales down for a turboprop operator', () => {
  const fleet = [{ typeId: TP.id }, { typeId: TP.id }];
  const base = hqBaseWeekly(fleet, a => getAircraftType(a.typeId));
  assert.ok(base < HQ_BASE_WEEKLY, 'a turboprop operator must not pay a narrowbody base');
  assert.ok(base > HQ_BASE_MIN, 'it still runs a real corporate structure');
  assert.equal(base, Math.round(HQ_BASE_MIN + (HQ_BASE_WEEKLY - HQ_BASE_MIN) * HQ_SCALE_BY_CATEGORY['Turboprop']));
});

test('a fleetless airline keeps the FULL base, so a dying airline still dies', () => {
  // Deliberately not HQ_BASE_MIN. That state is either momentary (the starter
  // fleet lands the same week) or terminal, and an airline whose metal has all
  // gone should bleed out and free the player to re-found, not linger cheaply.
  assert.equal(hqBaseWeekly([], () => null), HQ_BASE_WEEKLY);
  assert.equal(hqBaseWeekly(undefined, () => null), HQ_BASE_WEEKLY);
  assert.ok(HQ_BASE_MIN < HQ_BASE_WEEKLY, 'the floor is only the decay target');
});

// ── 3. The top of the range pays its way ─────────────────────────────────────
console.log('\nupgauging cannot dodge overhead');

test('the scale table is ordered by aircraft size', () => {
  const order = ['Turboprop', 'Regional Jet', 'Narrow Body', 'Wide Body', 'Double Deck'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(HQ_SCALE_BY_CATEGORY[order[i]] > HQ_SCALE_BY_CATEGORY[order[i - 1]],
      `${order[i]} should administer for more than ${order[i - 1]}`);
  }
});

test('ten widebodies cost more head office than ten narrowbodies', () => {
  assert.ok(tickWith(WB.id, 10, 3, false).totalHQCost > tickWith(NB.id, 10, 3, false).totalHQCost);
});

test('the restricted-world base is capped at narrowbody — nobody pays more than today', () => {
  for (const t of [NB, WB]) {
    const fleet = [{ typeId: t.id }, { typeId: t.id }];
    assert.equal(hqBaseWeekly(fleet, a => getAircraftType(a.typeId)), HQ_BASE_WEEKLY,
      `${t.category} base must be unchanged`);
  }
});

// ── 4. The awkward types ─────────────────────────────────────────────────────
console.log('\nfreighters, unknowns and double-deckers');

test('freighters step by payload, not by their single shared category', () => {
  const small = AIRCRAFT_TYPES.find(t => t.freighter && (t.payloadTonnes ?? 0) <= 20);
  const large = AIRCRAFT_TYPES.find(t => t.freighter && (t.payloadTonnes ?? 0) > 130);
  if (!small || !large) throw new Error('catalogue has no small/large freighter pair to compare');
  assert.ok(hqScaleFor(large) > hqScaleFor(small),
    'an An-124 cannot administer for what an ATR-72F does');
  assert.equal(hqScaleFor(small), HQ_SCALE_FREIGHTER[0].scale);
});

test('a double-decker is priced as one even if its category says otherwise', () => {
  assert.equal(hqScaleFor({ category: 'Wide Body', doubleDeck: true }), HQ_SCALE_BY_CATEGORY['Double Deck']);
});

test('an unknown category is charged the common rate, never zero', () => {
  assert.equal(hqScaleFor({ category: 'Orbital Shuttle' }), 1);
  assert.equal(hqScaleFor(null), 1);
  assert.equal(hqScaleFor(undefined), 1);
});

test('fleetHQScale sums, and an all-narrowbody fleet returns its own count', () => {
  const fleet = [{ typeId: NB.id }, { typeId: NB.id }, { typeId: NB.id }];
  assert.equal(fleetHQScale(fleet, a => getAircraftType(a.typeId)), 3);
  assert.equal(fleetHQScale([], () => null), 0);
  assert.equal(fleetHQScale(null, () => null), 0);
});

// ── 5. The departure model is untouched ──────────────────────────────────────
console.log('\nthe per-departure layer is unchanged');

test('restricted worlds still charge the scaled base plus the same departure fees', () => {
  const n = 4, freq = 3;
  const r = tickWith(TP.id, n, freq, true);
  const fleet = Array.from({ length: n }, () => ({ typeId: TP.id }));
  const expected = hqBaseWeekly(fleet, a => getAircraftType(a.typeId))
    + n * freq * 2 * HQ_DEPARTURE_FEE['Turboprop'];
  assert.equal(r.totalHQCost, expected);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
