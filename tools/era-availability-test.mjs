// era-availability-test.mjs — Phase 1 of ERA_MODE_PLAN.md: production windows.
//
// HEAD failure proof (before this phase): the engine had no concept of a
// production window at all — `orderDenial` did not exist, ORDER_AIRCRAFT in a
// startYear world accepted a 787 order in 1950, and `oop` appeared on no type:
//   node -e "import('./packages/engine/src/data/aircraft.js').then(m =>
//     console.log(m.AIRCRAFT_TYPES.filter(t => t.oop != null).length))"   // 0 on HEAD
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  AIRCRAFT_TYPES, getAircraftType, aircraftAvailability, aircraftOrderable, eraDeliveredAgeWeeks, lessorSupplies,
} from '../packages/engine/src/data/aircraft.js';
import { gameReducer, freshState, orderDenial, leaseDenial } from '../packages/engine/src/reducer.mjs';

// ── Catalogue data ───────────────────────────────────────────────────────────

test('every type carries eis; oop (when present) is a sane window', () => {
  for (const t of AIRCRAFT_TYPES) {
    assert.ok(Number.isInteger(t.eis), `${t.id} missing eis`);
    if (t.oop != null) {
      assert.ok(Number.isInteger(t.oop) && t.oop >= t.eis, `${t.id}: oop ${t.oop} before eis ${t.eis}`);
      assert.ok(t.oop <= 2026, `${t.id}: oop ${t.oop} in the future — an open line carries no oop`);
    }
  }
});

test('every banded passenger type has a real production-line closure', () => {
  // The delivered-age band means "arrives already used" — which is only
  // coherent for a line that has actually closed. Freighter conversions are
  // exempt: an active conversion line still delivers old airframes.
  const missing = AIRCRAFT_TYPES
    .filter(t => !t.freighter && (t.deliveredAgeWeeks ?? 0) > 0)
    .filter(t => t.oop == null || t.oop >= 2026)
    .map(t => t.id);
  assert.deepEqual(missing, []);
});

// ── Delivered age generalisation ─────────────────────────────────────────────

test('classic worlds reproduce the published table exactly (parity)', () => {
  for (const t of AIRCRAFT_TYPES) {
    assert.equal(eraDeliveredAgeWeeks(t, null), t.deliveredAgeWeeks ?? 0, t.id);
  }
});

test('an era world at 2026 also reproduces the published table exactly', () => {
  // The anchored interpolation's whole point: today's catalogue is the
  // calYear = 2026 case, so a 2000-start world 26 years in matches classic.
  for (const t of AIRCRAFT_TYPES) {
    assert.equal(eraDeliveredAgeWeeks(t, 2026), t.deliveredAgeWeeks ?? 0, t.id);
  }
});

test('in production means factory-fresh; age grows after the line closes', () => {
  const b707 = getAircraftType('b707320');            // eis 1962, oop 1978, band 832
  assert.equal(eraDeliveredAgeWeeks(b707, 1965), 0, 'in production: new');
  assert.equal(eraDeliveredAgeWeeks(b707, 1978), 0, 'last year of the line: new');
  const mid = eraDeliveredAgeWeeks(b707, 2002);
  assert.ok(mid > 0 && mid < 832, `halfway out of production: partially aged (got ${mid})`);
  assert.equal(eraDeliveredAgeWeeks(b707, 2060), 832, 'far past: capped at 16y');
  // Monotonic non-decreasing across the century for every type.
  for (const t of AIRCRAFT_TYPES) {
    let prev = -1;
    for (let y = 1950; y <= 2050; y += 10) {
      const a = eraDeliveredAgeWeeks(t, y);
      assert.ok(a >= 0 && a <= 832, `${t.id}@${y}: ${a} out of range`);
      if (aircraftAvailability(t, y) === 'used') {
        assert.ok(a >= prev, `${t.id}@${y}: age went backwards (${prev} -> ${a})`);
        prev = a;
      } else { prev = -1; }
    }
  }
});

test('active freighter conversion lines always deliver old airframes', () => {
  const bcf = getAircraftType('b737800bcf');          // conversion, no oop, band 312
  assert.equal(bcf.oop ?? null, null);
  assert.equal(eraDeliveredAgeWeeks(bcf, 2020), 312, 'a fresh conversion is an old airframe');
  assert.equal(eraDeliveredAgeWeeks(bcf, null), 312);
});

// ── Availability states ──────────────────────────────────────────────────────

test('aircraftAvailability walks future → new → used; classic short-circuits', () => {
  const t = getAircraftType('caravelle');             // eis 1959, oop 1972
  assert.equal(aircraftAvailability(t, 1950), 'future');
  assert.equal(aircraftAvailability(t, 1959), 'new');
  assert.equal(aircraftAvailability(t, 1972), 'new');
  assert.equal(aircraftAvailability(t, 1973), 'used');
  assert.equal(aircraftAvailability(t, null), 'available');
  const open = getAircraftType('a320neo');            // no oop: line open
  assert.equal(aircraftAvailability(open, 2050), 'new');
  // 30 years past the line's closure the market runs dry (phase 3):
  assert.equal(aircraftAvailability(t, 2002), 'used');
  assert.equal(aircraftAvailability(t, 2003), 'expired');
});

test('expired lines are refused everywhere: order, lease, planners', () => {
  // A 2040-era world must not be able to buy DC-3s forever — the exact exploit
  // the sub-80-seat price floors and this market lifetime exist to close.
  const st = { ...freshState(), phase: 'playing', cash: 500_000_000, startYear: 1950, year: 91, week: 1 }; // calendar 2040
  const denied = orderDenial(st, 'dc3');            // oop 1946 — expired 1977
  assert.equal(denied?.code, 'no_airworthy_frames');
  const after = gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId: 'dc3', quantity: 1, ownershipType: 'owned' });
  assert.equal((after.pendingOrders ?? []).length, 0, 'the order must be rejected');
  assert.equal(lessorSupplies(getAircraftType('dc3'), 2040), false, 'lessors have none either');
  assert.equal(aircraftOrderable(getAircraftType('dc3'), 2040), false);
  assert.equal(aircraftOrderable(getAircraftType('dc3'), 1960), true, 'fine while frames exist');
  assert.equal(aircraftOrderable(getAircraftType('dc3'), null), true, 'classic worlds untouched');
});

test('the 1978 era opens with a real fleet and 1950 with only the DC-3', () => {
  const at = (y) => AIRCRAFT_TYPES.filter(t => aircraftAvailability(t, y) !== 'future').length;
  assert.equal(at(1950), 1);
  assert.ok(at(1978) >= 30, `1978 should field 30+ types, got ${at(1978)}`);
  assert.ok(at(2000) >= 95, `2000 should field 95+ types, got ${at(2000)}`);
});

// ── Reducer enforcement ──────────────────────────────────────────────────────

test('ORDER_AIRCRAFT refuses a type that has not entered service', () => {
  const base = { ...freshState(), phase: 'playing', cash: 500_000_000, startYear: 1950, year: 1, week: 1 };
  const denied = orderDenial(base, 'b747400');
  assert.equal(denied?.code, 'not_yet_flying');
  const after = gameReducer(base, { type: 'ORDER_AIRCRAFT', typeId: 'b747400', quantity: 1, ownershipType: 'owned' });
  assert.equal((after.pendingOrders ?? []).length, (base.pendingOrders ?? []).length, 'order must be rejected');
  assert.equal(after.cash, base.cash, 'no money may move');
});

test('ORDER_AIRCRAFT accepts an in-service type in an era world', () => {
  const base = { ...freshState(), phase: 'playing', cash: 500_000_000, startYear: 1978, year: 1, week: 1 };
  assert.equal(orderDenial(base, 'b727200'), null);
  const after = gameReducer(base, { type: 'ORDER_AIRCRAFT', typeId: 'b727200', quantity: 1, ownershipType: 'owned' });
  const added = (after.pendingOrders?.length ?? 0) + (after.fleet?.length ?? 0)
              - (base.pendingOrders?.length ?? 0) - (base.fleet?.length ?? 0);
  assert.ok(added >= 1, 'order (or instant delivery) must land');
});

test('classic worlds are untouched: orderDenial is always null', () => {
  const base = { ...freshState(), phase: 'playing', cash: 500_000_000 };
  assert.equal(orderDenial(base, 'b7779x'), null, 'even a 2027-eis type in a classic world');
});

// ── Lessor books ─────────────────────────────────────────────────────────────

test('era lessors carry anything in service; classic keeps the 2000 cutoff', () => {
  const dc6era = getAircraftType('l188');             // eis 1959
  assert.equal(lessorSupplies(dc6era, 1965), true, 'a 1965 lessor carries the Electra');
  assert.equal(lessorSupplies(dc6era, 1955), false, 'not before it flies');
  const neo = getAircraftType('a320neo');             // eis 2016 — blocked classically
  assert.equal(lessorSupplies(neo), false, 'classic: books stop at 2000');
  assert.equal(lessorSupplies(neo, 2020), true, 'era 2020: in service, leasable');
  const a380 = getAircraftType('a380');
  assert.equal(lessorSupplies(a380, 2015), false, 'double-deck exclusion survives the era rule');
  // NWR-flavoured leaseDenial agrees end to end.
  const st = { newWorldRestrictions: true, startYear: 1950, year: 1, week: 1, fleet: [], pendingOrders: [] };
  assert.equal(leaseDenial(st, 'a320ceo')?.code, 'not_stocked');
  assert.equal(leaseDenial({ ...st, year: 11 }, 'cv580'), null, '1960: the Convair is on the books');
});
