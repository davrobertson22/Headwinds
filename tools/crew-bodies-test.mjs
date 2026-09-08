// Crew displayed as PEOPLE, and the forward requirement that counts deliveries.
//
// Discord 2026-09-07: "i also don't know how many staff are required per
// aircraft, so im just guessing how many I need to train before it arrives",
// and "it takes 0.9 for an a319 i think so it doesnt make sense". Two defects:
// the requirement was printed in narrowbody-equivalents (an index, not a
// headcount), and it ignored aircraft on order even though pilots take ten
// weeks to train.
//
//   node tools/crew-bodies-test.mjs
import assert from 'node:assert/strict';
import {
  LABOR_GROUPS, CREW_PER_UNIT, CREW_LEAD_WEEKS,
  crewBodies, crewUnitsForBodies, crewBodiesForAircraft, crewScaleFor,
  crewRequired, crewRequiredAhead, deliveriesWithinLeadTime,
  crewHiresNeeded, crewSurvival, crewExpectedLeavers, weeksToOrderBookComplete,
} from '../packages/engine/src/data/labor.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const A319 = getAircraftType('a319ceo');   // the real catalogue entry ASAS was looking at
const B739 = { category: 'Narrow Body', seats: 189 };
const DASH8 = { category: 'Turboprop', seats: 78 };
const B77W  = { category: 'Wide Body', seats: 396 };
const TYPES = { a319: A319, b739: B739, dash8: DASH8, b77w: B77W };
const typeOf = (a) => TYPES[a.typeId];

// ── The complaint, reproduced ────────────────────────────────────────────────
t('an A319 really does score 0.9 crew units — the number was never wrong', () => {
  const units = crewScaleFor('pilots', A319);
  assert.ok(units > 0.85 && units < 1.0, `expected ~0.9 for a ${A319.seats}-seat A319, got ${units}`);
});

t('… and converts to a headcount a player can read', () => {
  const bodies = crewBodiesForAircraft('pilots', A319);
  assert.ok(bodies >= 7 && bodies <= 10, `A319 pilots should read as a crew of people, got ${bodies}`);
  // The whole point: never 0.9, and never the 2 the player expected either —
  // one narrowbody needs enough pilots to fly it all week, not one deck's worth.
  assert.ok(bodies > 2, 'a tail needs more than one flight deck of pilots');
});

t('every group converts to whole people, and bigger aircraft need more of them', () => {
  for (const g of LABOR_GROUPS) {
    const b = crewBodiesForAircraft(g.id, A319);
    assert.equal(b, Math.round(b), `${g.id} headcount must be whole people`);
    assert.ok(crewBodiesForAircraft(g.id, B77W) >= b, `${g.id}: a 777 needs at least an A319's crew`);
  }
  assert.ok(crewBodiesForAircraft('pilots', B739) > crewBodiesForAircraft('pilots', A319),
    'a 737-900 needs more pilots than an A319 — the seat curve survives the conversion');
  assert.ok(crewBodiesForAircraft('cabinCrew', DASH8) < crewBodiesForAircraft('cabinCrew', A319),
    'a turboprop needs fewer cabin crew');
});

t('bodies and units round-trip', () => {
  for (const g of LABOR_GROUPS) {
    const per = CREW_PER_UNIT[g.id];
    assert.ok(per >= 1, `${g.id} needs a people-per-unit anchor`);
    assert.equal(crewBodies(g.id, 3), per * 3);
    assert.ok(Math.abs(crewUnitsForBodies(g.id, per * 3) - 3) < 1e-9);
  }
});

t('conversion is display-only — the engine unit is untouched', () => {
  const fleet = [{ typeId: 'a319' }, { typeId: 'b77w' }];
  // crewRequired must still return narrowbody-equivalents, because the wage
  // bill divides by the same number. If this ever returns people, labour cost
  // silently multiplies by nine.
  assert.ok(crewRequired('pilots', fleet, typeOf) < 3, 'requirement is still in units, not bodies');
});

// ── Forward requirement ──────────────────────────────────────────────────────
const ABS_WEEK = 100;
const ORDERS = [
  { typeId: 'a319', deliverAbsWeek: ABS_WEEK + 3 },    // inside every lead time
  { typeId: 'b77w', deliverAbsWeek: ABS_WEEK + 8 },    // inside pilots (10), outside ramp (2)
  { typeId: 'b739', deliverAbsWeek: ABS_WEEK + 40 },   // outside everything
];
const FLEET = [{ typeId: 'a319' }];

t('REGRESSION: the old call path ignores aircraft on order', () => {
  // The defect, on the pre-change API: an airline with three aircraft on order
  // is told it needs crew for the one it has, and pilots take ten weeks.
  assert.equal(
    crewRequired('pilots', FLEET, typeOf),
    crewRequired('pilots', [...FLEET], typeOf),
    'sanity',
  );
  const ahead = crewRequiredAhead('pilots', FLEET, ORDERS, typeOf, ABS_WEEK);
  assert.ok(ahead > crewRequired('pilots', FLEET, typeOf),
    'the forward requirement must exceed the fleet-only one when deliveries are due');
});

t('the horizon is the group\'s own training lead time', () => {
  const pilots = crewRequiredAhead('pilots', FLEET, ORDERS, typeOf, ABS_WEEK);
  const ramp   = crewRequiredAhead('groundStaff', FLEET, ORDERS, typeOf, ABS_WEEK);
  // Pilots (10wk) must staff the A319 and the 777; the ramp (2wk) staffs neither.
  assert.equal(deliveriesWithinLeadTime('pilots', ORDERS, ABS_WEEK).length, 2);
  assert.equal(deliveriesWithinLeadTime('groundStaff', ORDERS, ABS_WEEK).length, 0);
  assert.ok(pilots > crewRequired('pilots', FLEET, typeOf));
  assert.equal(ramp, crewRequired('groundStaff', FLEET, typeOf),
    'a ramp agent trains in two weeks and is not asked to staff a delivery two months out');
});

t('an order landing beyond every lead time is never counted', () => {
  const far = [{ typeId: 'b77w', deliverAbsWeek: ABS_WEEK + 200 }];
  for (const g of LABOR_GROUPS) {
    assert.equal(crewRequiredAhead(g.id, FLEET, far, typeOf, ABS_WEEK),
                 crewRequired(g.id, FLEET, typeOf), `${g.id} counted a distant order`);
    assert.ok(CREW_LEAD_WEEKS[g.id] < 200);
  }
});

t('no orders, no change — the forward requirement degrades to the current one', () => {
  for (const g of LABOR_GROUPS) {
    assert.equal(crewRequiredAhead(g.id, FLEET, [], typeOf, ABS_WEEK), crewRequired(g.id, FLEET, typeOf));
    assert.equal(crewRequiredAhead(g.id, FLEET, undefined, typeOf, ABS_WEEK), crewRequired(g.id, FLEET, typeOf));
  }
});

// ── Attrition-aware hiring ───────────────────────────────────────────────────
t('the requirement does NOT scale with age — the workforce shrinks instead', () => {
  // The player's question: "does staff required scale with age". It does not;
  // crewScaleFor reads seats and category only. An old airframe and a new one of
  // the same type need identical crew.
  const young = { typeId: 'a319', ageWeeks: 0 };
  const old   = { typeId: 'a319', ageWeeks: 52 * 25 };
  for (const g of LABOR_GROUPS) {
    assert.equal(crewRequired(g.id, [young], typeOf), crewRequired(g.id, [old], typeOf),
      `${g.id}: aircraft age must not change the crew requirement`);
  }
});

t('hiring for a distant delivery covers the crew who will leave first', () => {
  // Hire exactly the gap for an order ten weeks out and attrition eats into it
  // before the aircraft lands — the reported "it ends up needing more by the
  // time my order finishes".
  const now  = crewHiresNeeded('pilots', { need: 10, onLine: 8, weeksToTarget: 0 });
  const later = crewHiresNeeded('pilots', { need: 10, onLine: 8, weeksToTarget: 20 });
  assert.ok(later > now, 'a delivery 20 weeks out must ask for more than today\'s gap');
  assert.equal(now, 2, 'with no wait it is exactly the gap');
});

t('underpaying costs you more hires, because more of them leave', () => {
  const market = crewHiresNeeded('pilots', { need: 10, onLine: 10, payMultiplier: 1.0, weeksToTarget: 20 });
  const cheap  = crewHiresNeeded('pilots', { need: 10, onLine: 10, payMultiplier: 0.8, weeksToTarget: 20 });
  assert.ok(cheap > market, 'cut-rate pay must demand more replacement hiring');
  assert.ok(market > 0, 'even at market pay, holding a headcount for 20 weeks needs hires');
});

t('crew already in training count, but only from the week they graduate', () => {
  const bare    = crewHiresNeeded('pilots', { need: 10, onLine: 5, inTraining: 0, weeksToTarget: 12 });
  const pipeline = crewHiresNeeded('pilots', { need: 10, onLine: 5, inTraining: 3, weeksToTarget: 12 });
  assert.ok(pipeline < bare, 'people already training must reduce what you hire now');
  assert.ok(pipeline > 0);
});

t('a fully staffed airline with nothing on order is asked to hire nothing', () => {
  assert.equal(crewHiresNeeded('pilots', { need: 10, onLine: 10, weeksToTarget: 0 }), 0);
  assert.equal(weeksToOrderBookComplete([], 100), 0);
  assert.equal(crewSurvival(1.0, 80, 0), 1);
});

t('survival and leavers are consistent with each other', () => {
  const leavers = crewExpectedLeavers(100, 1.0, 80, 10);
  assert.ok(Math.abs((100 - leavers) - 100 * crewSurvival(1.0, 80, 10)) < 1e-9);
  assert.ok(leavers > 0 && leavers < 100);
});

t('the order-book horizon is the LAST delivery, not the first', () => {
  const orders = [{ deliverAbsWeek: 105 }, { deliverAbsWeek: 130 }, { deliverAbsWeek: 112 }];
  assert.equal(weeksToOrderBookComplete(orders, 100), 30);
  assert.ok(CREW_LEAD_WEEKS.pilots > 0);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
