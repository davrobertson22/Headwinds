// era-competitor-fleet-test.mjs — AI carriers shop the era catalogue.
//
// Discord 2026-09-08 (wj): a 1962 world had an AI airline flying A321neos.
// Route launches went through pickCompetitorAircraftType, which is era-gated,
// but the UP-GAUGE path (pickLargerCompetitorAircraftType) evaluated the 2026
// market unconditionally — so the moment a rival filled a Vanguard it stepped
// straight onto a modern narrowbody.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  pickCompetitorAircraftType, pickLargerCompetitorAircraftType,
  healAnachronisticCompetitorFleets,
} from '../packages/engine/src/models/demand.js';
import { setEraCalendarYear } from '../packages/engine/src/utils/market.js';

function inEra(t, year) {
  return t == null || ((t.eis ?? 0) <= year && (t.withdrawnYear == null || year < t.withdrawnYear));
}

test('up-gauge picks stay inside the era catalogue', () => {
  try {
    setEraCalendarYear(1962);
    for (const dist of [600, 1500, 3200, 6000]) {
      for (const minSeats of [80, 140, 200, 300]) {
        const t = pickLargerCompetitorAircraftType(dist, minSeats);
        assert.ok(inEra(t, 1962), `${dist}km/${minSeats}seats: ${t?.id} is not on the 1962 market`);
      }
    }
  } finally { setEraCalendarYear(null); }
});

test('up-gauge honours a profit preference without leaving the era', () => {
  try {
    setEraCalendarYear(1962);
    const t = pickLargerCompetitorAircraftType(2000, 120, {
      prefer: (x) => (x.seats ?? 0),          // biggest wins — a modern jet if the gate is open
    });
    assert.ok(inEra(t, 1962), `prefer-path returned ${t?.id}`);
  } finally { setEraCalendarYear(null); }
});

test('route launches were already era-gated (regression guard)', () => {
  try {
    setEraCalendarYear(1962);
    assert.ok(inEra(pickCompetitorAircraftType(1500, 'budget'), 1962));
    assert.ok(inEra(pickCompetitorAircraftType(6000, 'legacy'), 1962));
  } finally { setEraCalendarYear(null); }
});

test('classic worlds are untouched: the 2026 market still up-gauges', () => {
  setEraCalendarYear(null);
  const t = pickLargerCompetitorAircraftType(2000, 180);
  assert.ok(t, 'classic: something bigger exists');
  assert.ok((t.seats ?? 0) >= 180);
  assert.equal(getAircraftType(t.id).id, t.id);
});

// ── Healing worlds that already went wrong ───────────────────────────────────

function sickCarrier() {
  return {
    id: 'sick', tier: 'budget',
    routes: {
      'JFK-LAX': { frequency: 14, aircraftType: 'a321neo', tails: 3 },
      'JFK-BOS': { frequency: 21, aircraftType: 'vanguard', tails: 2 },
    },
    fleet: [
      { id: 't1', typeId: 'a321neo', routeKey: 'JFK-LAX', ageWeeks: 120 },
      { id: 't2', typeId: 'a321neo', routeKey: 'JFK-LAX', ageWeeks: 40 },
      { id: 't3', typeId: 'vanguard', routeKey: 'JFK-BOS', ageWeeks: 200 },
    ],
  };
}

test('heal re-equips out-of-era routes and re-types their tails, ages kept', () => {
  const [c] = healAnachronisticCompetitorFleets([sickCarrier()], 1962);
  const swapped = c.routes['JFK-LAX'].aircraftType;
  assert.notEqual(swapped, 'a321neo');
  assert.ok(inEra(getAircraftType(swapped), 1962), `healed onto ${swapped}`);
  assert.ok((getAircraftType(swapped).seats ?? 0) <= getAircraftType('a321neo').seats,
    'a heal must never hand out more seats than the illegal frame carried');
  const lax = c.fleet.filter(t => t.routeKey === 'JFK-LAX');
  assert.ok(lax.length > 0);
  for (const t of lax) assert.equal(t.typeId, swapped);
  assert.deepEqual(lax.map(t => t.ageWeeks).sort((a, b) => a - b), [40, 120], 'tail ages survive');
});

test('heal leaves era-legal routes — including old metal — alone', () => {
  const [c] = healAnachronisticCompetitorFleets([sickCarrier()], 1962);
  assert.deepEqual(c.routes['JFK-BOS'], sickCarrier().routes['JFK-BOS']);
  assert.equal(c.fleet.find(t => t.id === 't3').typeId, 'vanguard');
});

test('heal is a no-op in classic worlds and for clean carriers', () => {
  const pool = [sickCarrier()];
  assert.equal(healAnachronisticCompetitorFleets(pool, null), pool, 'classic: same array back');
  const clean = [{ id: 'ok', tier: 'legacy', routes: { 'JFK-BOS': { frequency: 7, aircraftType: 'vanguard', tails: 1 } }, fleet: [] }];
  assert.equal(healAnachronisticCompetitorFleets(clean, 1962), clean, 'nothing to do: same array back');
});
