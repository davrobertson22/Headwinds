// missing-aircraft-test.mjs — the 13 types from Dunno23's Discord list
// (2026-11-10, "Some missing aircraft") exist and are wired everywhere a type
// has to be: catalogue, maintenance family, production line, real build count,
// cabin planform. Then the point of each one: a non-ER is the cheaper,
// shorter-ranged sibling of the ER the catalogue already had, never a free
// upgrade over it.
//
//   node tools/missing-aircraft-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType, lessorSupplies, payloadRangeMod } from '../packages/engine/src/data/aircraft.js';
import { aircraftFamily } from '../packages/engine/src/data/families.js';
import { lineOf } from '../packages/engine/src/data/productionLines.js';
import { realBuilt } from '../packages/engine/src/data/realBuilds.js';
import { pickCompetitorAircraftType, pickLargerCompetitorAircraftType } from '../packages/engine/src/models/demand.js';
import { setEraCalendarYear, getEraCalendarYear } from '../packages/engine/src/utils/market.js';
import { PLANFORMS } from '../src/utils/planform.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}
const T = (id) => { const t = getAircraftType(id); assert.ok(t, `aircraft id '${id}' is not in the catalogue`); return t; };

// [new type, the sibling it sits beside, shared family, shared production line]
const ADDED = [
  ['a340200', 'a340300'], ['a340500', 'a340600'], ['b737600', 'b737700'], ['b737700er', 'b737700'],
  ['b777200', 'b777200er'], ['b777300', 'b777300er'], ['b767200', 'b767200er'], ['b767300base', 'b767300'],
  ['dc1010', 'dc1030'], ['a320100', 'a320ceo'], ['a321100', 'a321ceo'], ['b747400er', 'b747400'],
];

console.log('\nMissing aircraft (Discord, 2026-11-10)\n');

test('all 13 are in the catalogue with the fields the market card renders', () => {
  for (const id of [...ADDED.map(a => a[0]), 'tu144']) {
    const t = T(id);
    for (const k of ['name', 'description', 'image', 'category', 'eis', 'oop']) assert.ok(t[k], `${id} has no ${k}`);
    for (const k of ['seats', 'typicalSeats', 'range', 'runwayFt', 'weeklyLease', 'purchasePrice', 'fuelBurnPer100km', 'crewCostPerKm', 'baseMaintenancePerWk']) {
      assert.ok(t[k] > 0, `${id} has no ${k}`);
    }
    assert.ok(t.typicalSeats <= t.seats, `${id}: typical cabin above the exit limit`);
    assert.match(t.image, /^https:\/\/upload\.wikimedia\.org\//, id);
  }
});

test('each shares its sibling\'s maintenance family and production line', () => {
  for (const [id, sib] of ADDED) {
    assert.equal(aircraftFamily(id), aircraftFamily(sib), `${id} family`);
    assert.ok(aircraftFamily(id), `${id} has no family`);
    assert.equal(lineOf(id), lineOf(sib), `${id} production line`);
    assert.equal(T(id).category, T(sib).category, `${id} category`);
  }
});

test('each has a real build count and its own cabin planform', () => {
  for (const id of [...ADDED.map(a => a[0]), 'tu144']) {
    assert.ok(realBuilt(id) > 0, `${id} missing from REAL_BUILDS`);
    assert.ok(Array.isArray(PLANFORMS[id]), `${id} missing from PLANFORMS`);
  }
});

test('a non-ER gives up range to the ER beside it, and costs less', () => {
  for (const [base, er] of [['b777200', 'b777200er'], ['b777300', 'b777300er'], ['b767200', 'b767200er'],
    ['b767300base', 'b767300'], ['dc1010', 'dc1030'], ['a320100', 'a320ceo'], ['a321100', 'a321ceo']]) {
    const b = T(base), e = T(er);
    assert.ok(b.range < e.range, `${base} must not out-range ${er}`);
    assert.ok(b.purchasePrice < e.purchasePrice, `${base} must be cheaper than ${er}`);
    assert.ok(b.fuelBurnPer100km <= e.fuelBurnPer100km * 1.01, `${base} is the lighter airframe`);
    assert.equal(b.seats <= e.seats, true, `${base} seats`);
    assert.ok(b.eis <= e.eis, `${base} came first`);
  }
});

test('an ER or long-range variant buys its range with fuel and money', () => {
  for (const [er, base] of [['b747400er', 'b747400'], ['b737700er', 'b737700'], ['a340500', 'a340300']]) {
    const e = T(er), b = T(base);
    assert.ok(e.range > b.range, `${er} range`);
    assert.ok(e.fuelBurnPer100km > b.fuelBurnPer100km, `${er} burn`);
    assert.ok(e.purchasePrice / e.seats > b.purchasePrice / b.seats, `${er} price per seat`);
  }
});

test('the shrinks carry fewer seats and out-range the airframe they shrink', () => {
  for (const [shrink, base] of [['a340200', 'a340300'], ['b737600', 'b737700']]) {
    const s = T(shrink), b = T(base);
    assert.ok(s.seats < b.seats && s.range > b.range && s.purchasePrice < b.purchasePrice, shrink);
    assert.ok(s.fuelBurnPer100km < b.fuelBurnPer100km, `${shrink} burns less per km`);
    assert.ok(s.fuelBurnPer100km / s.seats > b.fuelBurnPer100km / b.seats, `${shrink} burns more per seat`);
  }
});

test('the 737-700ER only keeps its range with a premium cabin', () => {
  const er = T('b737700er'), xlr = T('a321xlr');
  assert.equal(er.deliveredAgeWeeks, T('b737700').deliveredAgeWeeks, 'arrives with the NG cohort');
  const full = er.range * payloadRangeMod(er.seats, er);
  assert.ok(full < xlr.range, `a full 737-700ER reaches ${Math.round(full)} km: it must not beat the A321XLR`);
  assert.ok(full > T('b737700').range, 'but it still out-ranges the standard -700');
});

test('the Tu-144 is a supersonic type that loses to Concorde on range and fuel', () => {
  const tu = T('tu144'), c = T('concorde');
  assert.equal(tu.category, 'Supersonic');
  assert.equal(tu.supersonic, true);
  assert.ok(tu.ticketPremium > 1);
  assert.ok(tu.range < c.range / 2);
  assert.ok(tu.fuelBurnPer100km / tu.seats > c.fuelBurnPer100km / c.seats);
  assert.ok(tu.purchasePrice < c.purchasePrice);
  assert.ok(aircraftFamily('tu144') && aircraftFamily('tu144') !== aircraftFamily('concorde'));
  assert.ok(lineOf('tu144') && lineOf('tu144') !== lineOf('concorde'));
  assert.equal(lessorSupplies(tu), false, 'no lessor carries one, as with Concorde');
});

test('AI carriers never choose a prestige or tiny-run type, in any year', () => {
  // The AI sizes a route on seat count alone. Unflagged, the 150-seat Tu-144
  // became the budget tier's short-haul aircraft from 1977, the 737-700ER its
  // 7,100-10,700 km aircraft (flown a third full to make the range), and the
  // A340-500 every tier's ultra-long-hauler in place of the A350. The other ten
  // are flagged so that adding them moved no AI fleet in a live world (premium
  // carriers went to the 767-300 and both golden masters broke without it).
  const skip = AIRCRAFT_TYPES.filter(t => t.aiSkip).map(t => t.id).sort();
  assert.deepEqual(skip, [...ADDED.map(a => a[0]), 'tu144'].sort());
  const was = getEraCalendarYear();
  const picked = new Set();
  try {
    for (const year of [null, 1978, 1985, 2004, 2010, 2020]) {
      setEraCalendarYear(year);
      for (const tier of ['budget', 'legacy', 'premium']) {
        for (let km = 300; km <= 17000; km += 100) {
          const t = pickCompetitorAircraftType(km, tier);
          if (t?.aiSkip) picked.add(`${t.id} (${tier}, ${km} km, ${year ?? 'classic'})`);
          const up = pickLargerCompetitorAircraftType(km, 100);
          if (up?.aiSkip) picked.add(`${up.id} (up-gauge, ${km} km, ${year ?? 'classic'})`);
        }
      }
    }
  } finally { setEraCalendarYear(was); }
  assert.deepEqual([...picked].slice(0, 6), []);
  for (const id of skip) assert.ok(T(id).purchasePrice > 0 && T(id).weeklyLease > 0, `${id} must stay buyable`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
