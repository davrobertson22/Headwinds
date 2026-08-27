// Crew cost that scales with the aeroplane, a union that remembers, and a
// strike that doesn't burn fuel it never used.
//
// A1. `baseWeeklyPerAircraft × fleet.length` charged a Dash 8 an A380's crew
//     bill. A turboprop's whole weekly revenue is around $49k against a $58k
//     labour line, so regional flying could not be made to work at any fare,
//     while a widebody paid about half a percent of revenue for its crews.
//
// A6. Refusing a pay demand cost −10 morale and +30 unrest ONCE. Morale healed
//     to whatever the money bought and unrest decays whenever morale ≥ 50, so
//     an airline paying 1.25× could refuse every demand forever and never see a
//     strike. The negotiation system had teeth only against airlines already
//     underpaying — the ones least able to settle.
//
// A8. A strike cancelled the revenue and still charged every variable cost of
//     flying the full schedule: fuel for departures that never pushed back,
//     landing fees at airports never reached.
//
//   node tools/labor-cost-test.mjs

import assert from 'node:assert/strict';
import { CATEGORY_MEDIAN_SEATS } from '../packages/engine/src/data/overhead.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import {
  LABOR_GROUPS, crewScaleFor, fleetCrewScale, moraleTarget,
  CREW_SCALE_BY_CATEGORY, CREW_SCALE_FREIGHTER,
} from '../packages/engine/src/data/labor.js';
import {
  tickUnrest, tickGrievance, grievedMoraleTarget,
  DEFAULT_LABOR_RELATIONS, UNREST_STRIKE_THRESHOLD,
  GRIEVANCE_REFUSE, GRIEVANCE_SETTLED, GRIEVANCE_MORALE_PENALTY, unrestFloor,
} from '../packages/engine/src/data/laborRelations.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const typeOf = (a) => getAircraftType(a.typeId);
const first = (pred) => AIRCRAFT_TYPES.find(pred);
const TP = first(t => t.category === 'Turboprop');
const RJ = first(t => t.category === 'Regional Jet');
const NB = first(t => t.category === 'Narrow Body');
const WB = first(t => t.category === 'Wide Body');
const DD = first(t => t.category === 'Double Deck');
assert.ok(TP && RJ && NB && WB && DD, 'fixture categories missing');

/** Total weekly labour bill for a fleet of one type, at market pay. */
function weeklyLabour(type, count = 1) {
  const fleet = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, typeId: type.id }));
  return LABOR_GROUPS.reduce(
    (s, g) => s + Math.round(g.baseWeeklyPerAircraft * fleetCrewScale(g.id, fleet, typeOf)), 0);
}
const FLAT = LABOR_GROUPS.reduce((s, g) => s + g.baseWeeklyPerAircraft, 0);   // the old number

// ── A1: crew cost tracks the aeroplane ──────────────────────────────────────

test('a narrowbody at the calibration anchor pays exactly what it always did', () => {
  // The calibration promise: this is a re-shape, not a rise. It is pinned at the
  // ANCHOR — 186 seats, the median narrowbody the whole table was calibrated
  // against — because the scale became a seat curve rather than a category step
  // (see scaleBySeats in overhead.js). A 136-seat 737-200 now pays less than a
  // 220-seat 737-900ER, which is the entire point; what must not move is the
  // aircraft the calibration was built on.
  const anchor = AIRCRAFT_TYPES.find(t =>
    t.category === 'Narrow Body' && !t.freighter && t.seats === CATEGORY_MEDIAN_SEATS['Narrow Body']);
  assert.ok(anchor, 'the catalogue must still contain a narrowbody at the anchor seat count');
  assert.equal(weeklyLabour(anchor), FLAT);
  assert.equal(weeklyLabour(anchor, 12), FLAT * 12);
});

test('a turboprop no longer costs an A380 to crew', () => {
  const tp = weeklyLabour(TP);
  assert.ok(tp < FLAT * 0.6, `turboprop still pays ${tp} against the old flat ${FLAT}`);
  // The defect in one number: the old bill more than ate a turboprop's whole
  // weekly revenue (~$49k on overhead.js's own calibration table).
  assert.ok(FLAT > 49_000 && tp < 49_000,
    `old ${FLAT} vs new ${tp} against ~$49k of turboprop revenue`);
});

test('crew cost rises monotonically with the size of the aeroplane', () => {
  const bills = [TP, RJ, NB, WB, DD].map(t => weeklyLabour(t));
  for (let i = 1; i < bills.length; i++) {
    assert.ok(bills[i] > bills[i - 1],
      `${[TP, RJ, NB, WB, DD][i].category} (${bills[i]}) should cost more than the size below (${bills[i - 1]})`);
  }
});

test('the flight deck scales least and the cabin most', () => {
  // Two pilots is two pilots; cabin crew is one per fifty seats by regulation.
  // If these ever invert, the model has stopped describing an airline.
  const pilotRatio = crewScaleFor('pilots', WB) / crewScaleFor('pilots', NB);
  const cabinRatio = crewScaleFor('cabinCrew', WB) / crewScaleFor('cabinCrew', NB);
  assert.ok(cabinRatio > pilotRatio,
    `cabin ${cabinRatio} should outscale flight deck ${pilotRatio}`);
  assert.ok(pilotRatio < 2, 'a widebody does not carry twice the flight deck');
});

test('a freighter carries no cabin crew and heavy ground labour', () => {
  const frtr = first(t => t.freighter);
  assert.equal(crewScaleFor('cabinCrew', frtr), 0, 'there is no cabin to crew');
  assert.ok(crewScaleFor('groundStaff', frtr) >= 0.7,
    'palletising and loading is most of what a freight operation does');
});

test('freighters step by payload, not by their one shared category', () => {
  const small = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => (a.payloadTonnes ?? 0) - (b.payloadTonnes ?? 0))[0];
  const large = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => (b.payloadTonnes ?? 0) - (a.payloadTonnes ?? 0))[0];
  assert.ok((large.payloadTonnes ?? 0) > (small.payloadTonnes ?? 0) * 2, 'fixture spread too narrow');
  assert.ok(crewScaleFor('pilots', large) > crewScaleFor('pilots', small),
    'an An-124 and an ATR-72F cannot crew identically');
});

test('an unknown category with no seat count is charged the common rate, not zero', () => {
  // A new aircraft type must never fly its crews for free.
  assert.equal(crewScaleFor('pilots', { category: 'Blimp' }), 1);
  assert.equal(crewScaleFor('pilots', null), 1);
  assert.equal(crewScaleFor('nonsenseGroup', NB), 1);
});

test('every passenger category is priced for every group', () => {
  const cats = [...new Set(AIRCRAFT_TYPES.filter(t => !t.freighter).map(t => t.category))];
  for (const g of LABOR_GROUPS) {
    for (const c of cats) {
      assert.ok(CREW_SCALE_BY_CATEGORY[g.id]?.[c] != null,
        `${g.id} has no scale for ${c} — it would silently fall back to narrowbody`);
    }
  }
});

test('a mixed fleet is the sum of its parts', () => {
  const fleet = [{ id: '1', typeId: TP.id }, { id: '2', typeId: WB.id }];
  const mixed = LABOR_GROUPS.reduce(
    (s, g) => s + Math.round(g.baseWeeklyPerAircraft * fleetCrewScale(g.id, fleet, typeOf)), 0);
  assert.ok(near(mixed, weeklyLabour(TP) + weeklyLabour(WB), 4));
});

// ── A6: a union that remembers ──────────────────────────────────────────────

test('grievance lowers the morale ceiling money alone would buy', () => {
  const paid = moraleTarget(1.25);          // 100 — the best money can do
  assert.equal(grievedMoraleTarget(paid, 0), paid);
  assert.equal(grievedMoraleTarget(paid, 1), paid - GRIEVANCE_MORALE_PENALTY);
  assert.ok(grievedMoraleTarget(paid, 0.5) < paid);
});

test('grievance cannot drive the ceiling below the model floor', () => {
  assert.ok(grievedMoraleTarget(moraleTarget(0.5), 1) >= 10);
});

test('unrest recovery stalls under grievance — the half that mattered', () => {
  // The exact mechanism that made serial refusal safe: at morale ≥ 50 unrest
  // decays, so a +30 bump was always gone before the next round.
  const labor = { pilots: { morale: 100 } };
  const start = { pilots: 60 };
  const calm    = tickUnrest(labor, start, { pilots: 0 }).pilots;
  const grieved = tickUnrest(labor, start, { pilots: 1 }).pilots;
  assert.ok(grieved > calm, `grieved ${grieved} should outlast calm ${calm}`);
  assert.ok(calm < start.pilots, 'with no grievance it must still decay');
});

test('refusing as a policy eventually gets a well-paid airline struck', () => {
  // Play it out at 1.25× pay — the case the old model could not touch. Refuse,
  // wait a year for the union to come back, refuse again, and so on. Under the
  // old rules unrest was back to ZERO long before each new demand, so the
  // threshold of 60 was mathematically unreachable however many times you said
  // no. A year is long: slowing the decay alone would not have done it either.
  const play = (withGrievance) => {
    let unrest = { pilots: 0 }, griev = { pilots: 0 };
    const atRound = [];
    for (let round = 0; round < 3; round++) {
      unrest = { pilots: Math.min(100, unrest.pilots + 30) };           // refuse
      if (withGrievance) griev = { pilots: Math.min(1, griev.pilots + GRIEVANCE_REFUSE) };
      atRound.push(unrest.pilots);
      for (let w = 0; w < 52; w++) {                                     // a year of quiet
        const ceiling = grievedMoraleTarget(moraleTarget(1.25), withGrievance ? griev.pilots : 0);
        unrest = tickUnrest({ pilots: { morale: ceiling } }, unrest, withGrievance ? griev : null);
        if (withGrievance) griev = tickGrievance(griev);
      }
    }
    return { peak: Math.max(...atRound), settled: unrest.pilots };
  };
  const before = play(false);
  const after  = play(true);
  assert.equal(before.peak, 30,
    'sanity: the old model reset to zero between rounds, so three refusals peaked at one');
  assert.ok(before.peak < UNREST_STRIKE_THRESHOLD, 'sanity: unreachable before');
  assert.ok(after.peak >= UNREST_STRIKE_THRESHOLD,
    `three refusals should now be strikeable (peaked at ${after.peak})`);
  assert.ok(after.settled > 0, 'and the dispute does not simply evaporate');
});

test('one refusal is still free — this is a policy cost, not a hair trigger', () => {
  let unrest = { pilots: 30 }, griev = { pilots: GRIEVANCE_REFUSE };
  for (let w = 0; w < 52; w++) {
    const ceiling = grievedMoraleTarget(moraleTarget(1.25), griev.pilots);
    unrest = tickUnrest({ pilots: { morale: ceiling } }, unrest, griev);
    griev = tickGrievance(griev);
  }
  assert.ok(unrest.pilots < UNREST_STRIKE_THRESHOLD * 0.5,
    `a single refusal left unrest at ${unrest.pilots} — too punishing`);
  assert.ok(unrest.pilots > 0, 'but it is not forgotten either');
});

test('the standing-dispute floor scales with the grievance', () => {
  assert.equal(unrestFloor(0), 0);
  assert.ok(unrestFloor(GRIEVANCE_REFUSE) > 10 && unrestFloor(GRIEVANCE_REFUSE) < 25);
  assert.ok(unrestFloor(1) < UNREST_STRIKE_THRESHOLD,
    'a grievance alone must never be a strike — it takes a fresh refusal on top');
});

test('settling clears most of the grievance at once', () => {
  const after = Math.max(0, Math.min(1, GRIEVANCE_REFUSE * 2 - GRIEVANCE_SETTLED));
  assert.ok(after < GRIEVANCE_REFUSE, 'a deal has to be worth doing');
});

test('grievance fades on its own, so an airline can change course', () => {
  let g = { pilots: 1 };
  for (let w = 0; w < 260; w++) g = tickGrievance(g);   // five years
  assert.ok(g.pilots < 0.6, `barely moved in five years (${g.pilots})`);
  for (let w = 0; w < 300; w++) g = tickGrievance(g);   // and then some
  assert.equal(g.pilots, 0, 'a decade of good behaviour should clear it entirely');
});

test('grievance is bounded, and junk values are ignored', () => {
  assert.equal(tickGrievance({ pilots: 5 }).pilots <= 1, true);
  assert.equal(tickGrievance({ pilots: -3 }).pilots, 0);
  assert.equal(tickGrievance({}).pilots, 0);
  assert.equal(tickGrievance(null).pilots, 0);
  assert.equal(grievedMoraleTarget(80, 'lots'), 80);
});

test('the default relations carry a grievance ledger', () => {
  for (const g of LABOR_GROUPS) {
    assert.equal(DEFAULT_LABOR_RELATIONS.grievance[g.id], 0);
  }
});

test('an old save with no grievance behaves exactly as before', () => {
  const labor = { pilots: { morale: 100 } };
  assert.deepEqual(tickUnrest(labor, { pilots: 40 }, null),
                   tickUnrest(labor, { pilots: 40 }, { pilots: 0 }));
});

// ── A8: a strike does not burn fuel it never used ───────────────────────────

const { gameReducer: reducer, freshState } = await import('../packages/engine/src/reducer.mjs');

function struckWorld(severity) {
  return {
    ...freshState(),
    phase: 'playing', week: 20, year: 1, hub: 'JFK', cash: 300_000_000,
    hubs: { JFK: { tier: 2, tierSince: 1 } }, gates: { JFK: 20, LAX: 20 },
    fleet: [{ id: 'a1', typeId: NB.id, name: 'J', tailNumber: 'N1', status: 'assigned',
              ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats } }],
    routes: [{ id: 'r1', origin: 'JFK', destination: 'LAX', aircraftId: 'a1',
               weeklyFrequency: 6, weeksOpen: 30, hub: 'JFK', ticketPrice: 260, cateringLevel: 'full' }],
    cargoRoutes: [],
    laborRelations: severity > 0
      ? { ...DEFAULT_LABOR_RELATIONS,
          strike: { group: 'pilots', weeksLeft: 2, totalWeeks: 2, severity } }
      : DEFAULT_LABOR_RELATIONS,
  };
}

test('a strike refunds the variable cost of the flights it cancelled', () => {
  const calm    = reducer(struckWorld(0),    { type: 'ADVANCE_WEEK' }).lastReport;
  const struck  = reducer(struckWorld(0.55), { type: 'ADVANCE_WEEK' }).lastReport;
  assert.ok(struck.strikeLoss > 0, 'the fixture must actually be on strike');
  assert.ok((struck.strikeVariableSaved ?? 0) > 0,
    'cancelled flights still burned fuel and paid landing fees');
  // The refund has to be proportionate: 55% of the schedule did not operate.
  assert.ok(struck.strikeVariableSaved < struck.strikeLoss,
    'a strike must still hurt — fixed costs keep running');
  void calm;
});

test('the walkout costs materially less than it used to, but is still bad', () => {
  const calm   = reducer(struckWorld(0),    { type: 'ADVANCE_WEEK' });
  const struck = reducer(struckWorld(0.55), { type: 'ADVANCE_WEEK' });
  const hit    = calm.cash - struck.cash;
  const oldHit = struck.lastReport.strikeLoss;   // what the old model charged
  assert.ok(hit > 0, 'a strike is still a loss');
  assert.ok(hit < oldHit, `the hit (${hit}) should now be below the revenue loss alone (${oldHit})`);
});

test('no strike, no refund', () => {
  const calm = reducer(struckWorld(0), { type: 'ADVANCE_WEEK' }).lastReport;
  assert.equal(calm.strikeLoss, 0);
  assert.equal(calm.strikeVariableSaved ?? 0, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
