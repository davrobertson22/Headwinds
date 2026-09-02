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
  isVintage, VINTAGE_AFTER_YEARS, VINTAGE_AGE_FLOOR, VINTAGE_AGE_CAP,
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

test('classic worlds reproduce the published table exactly (parity) — except vintage lines', () => {
  for (const t of AIRCRAFT_TYPES) {
    if (isVintage(t)) continue;   // covered below
    assert.equal(eraDeliveredAgeWeeks(t, null), t.deliveredAgeWeeks ?? 0, t.id);
  }
});

// ── Vintage metal on the 2026 market (Discord 2026-09-01/02) ────────────────
// The 1950s propliners were briefly hidden from classic as "era-only" after they
// leaked in as the cheapest lease per seat on the books (Vanguard $114/seat-wk
// vs ATR 72 $564, same maintenance band). Dave: every aircraft belongs on the
// 2026 market. So instead: a line closed VINTAGE_AFTER_YEARS+ delivers old
// (VINTAGE_AGE_FLOOR → VINTAGE_AGE_CAP, i.e. 5.5× maintenance) and is buy-only.

test('vintage rule: lines closed 50+ years deliver 20–30 years old and are buy-only; everything younger is untouched', () => {
  const dc3 = getAircraftType('dc3'), van = getAircraftType('vanguard'), dc863 = getAircraftType('dc863');
  const b732 = getAircraftType('b737200'), il18 = getAircraftType('il18'), hs748 = getAircraftType('hs748');
  const conc = getAircraftType('concorde');
  assert.equal(VINTAGE_AFTER_YEARS, 50); assert.equal(VINTAGE_AGE_FLOOR, 20); assert.equal(VINTAGE_AGE_CAP, 30);
  assert.equal(isVintage(dc3), true);   assert.equal(eraDeliveredAgeWeeks(dc3, null), 30 * 52, '1946 line: capped at 30y');
  assert.equal(isVintage(van), true);   assert.equal(eraDeliveredAgeWeeks(van, null), 30 * 52, '1964 line: 62y closed → cap');
  assert.equal(isVintage(dc863), true); assert.equal(eraDeliveredAgeWeeks(dc863, null), 24 * 52, '1972 line: 54y closed → 20 + 4');
  assert.equal(isVintage(b732), false); assert.equal(eraDeliveredAgeWeeks(b732, null), b732.deliveredAgeWeeks, '1988 line: published band');
  assert.equal(isVintage(il18), false,  '1978 line (48y): not yet vintage — the June-block rule applies');
  assert.equal(isVintage(hs748), false, '1988 line: published band');
  assert.equal(isVintage(conc), false); assert.equal(eraDeliveredAgeWeeks(conc, null), 0, 'band-less classic conceit untouched');
  for (const t of AIRCRAFT_TYPES) {
    const v = isVintage(t);
    assert.equal(v, (t.deliveredAgeWeeks ?? 0) > 0 && t.oop != null && 2026 - t.oop >= VINTAGE_AFTER_YEARS, t.id);
    if (v) {
      const y = eraDeliveredAgeWeeks(t, null) / 52;
      assert.ok(y >= VINTAGE_AGE_FLOOR && y <= VINTAGE_AGE_CAP && y > (t.deliveredAgeWeeks ?? 0) / 52, `${t.id} ${y}y`);
      assert.equal(lessorSupplies(t, null), false, `${t.id} leasable in classic`);
      assert.equal(aircraftOrderable(t, null), t.withdrawnYear == null, `${t.id} orderable in classic`);
    }
    // Era worlds are untouched by the rule — their calendar IS the vintage rule.
    assert.equal(eraDeliveredAgeWeeks(t, 2026), t.deliveredAgeWeeks ?? 0, `${t.id} era@2026`);
  }
  const vintage = AIRCRAFT_TYPES.filter(isVintage).map(t => t.id);
  assert.ok(vintage.includes('c47') && vintage.includes('dc4') && vintage.includes('l188') && vintage.includes('cv580'), vintage.join(','));
});

test('vintage rule in the reducer: a classic world buys a DC-4 at 30y old, cannot lease it, and never sees the Comet 1', () => {
  const classic = { ...freshState(), phase: 'playing', cash: 500_000_000, year: 1, week: 1 };
  assert.equal(orderDenial(classic, 'dc4'), null, 'on the market');
  assert.equal(leaseDenial(classic, 'dc4')?.code, 'vintage', 'buy-only, restrictions or not');
  assert.equal(leaseDenial({ ...classic, newWorldRestrictions: true }, 'dc4')?.code, 'vintage');
  assert.equal(leaseDenial(classic, 'b737200'), null, 'June block still leases in an open world');
  const bought = gameReducer(classic, { type: 'BUY_AIRCRAFT', typeId: 'dc4' });
  assert.equal(bought.fleet.length, 1);
  assert.equal(bought.fleet[0].ageWeeks, 30 * 52, 'delivered at the vintage age');
  for (const action of [{ type: 'LEASE_AIRCRAFT', typeId: 'dc4' }, { type: 'ORDER_AIRCRAFT', typeId: 'dc4', quantity: 1, ownershipType: 'lease' }]) {
    const after = gameReducer(classic, action);
    assert.equal((after.fleet ?? []).length + (after.pendingOrders ?? []).length, 0, `${action.type}: no lease of vintage metal`);
  }
  const ordered = gameReducer(classic, { type: 'ORDER_AIRCRAFT', typeId: 'dc4', quantity: 1, ownershipType: 'owned' });
  assert.equal((ordered.pendingOrders ?? []).length, 1, 'owned order goes through');
  assert.equal(orderDenial(classic, 'comet1')?.code, 'withdrawn', 'grounded type has no market at any date');
  assert.equal(aircraftOrderable(getAircraftType('comet1'), null), false);
  const comet = gameReducer(classic, { type: 'BUY_AIRCRAFT', typeId: 'comet1' });
  assert.equal(comet.fleet.length, 0);
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

test('a band-less classic conceit ages in an era world: the 1990 Concorde is a used 1979 frame', () => {
  const c = getAircraftType('concorde');
  assert.equal(eraDeliveredAgeWeeks(c, null), 0, 'classic still sells it new');
  assert.equal(eraDeliveredAgeWeeks(c, 1978), 0, 'in production: new');
  const w1990 = eraDeliveredAgeWeeks(c, 1990);
  assert.ok(w1990 > 100 && w1990 < 300, `1990: ${w1990}w — a few years old, not factory fresh`);
  assert.ok(eraDeliveredAgeWeeks(c, 2005) > w1990, 'and older as the years pass');
  assert.equal(eraDeliveredAgeWeeks(c, 2026), 0, 'at 2026 the era market IS the classic market (invariant above)');
  // Recent closures without a band (the 2005+ rule) still deliver new through 2026.
  const recent = AIRCRAFT_TYPES.find(t => t.oop != null && t.oop >= 2005 && !(t.deliveredAgeWeeks > 0));
  if (recent) assert.equal(eraDeliveredAgeWeeks(recent, 2020), 0, `${recent.id} still new in 2020`);
});

test('every era opens with a real fleet — the propliner catalogue is in', () => {
  const at = (y) => AIRCRAFT_TYPES.filter(t => aircraftOrderable(t, y)).length;
  assert.equal(at(1950), 6, 'C-47, DC-3, DC-4, L-749, CV-240, Stratocruiser');
  assert.ok(at(1955) >= 10, `1955 should field 10+ types, got ${at(1955)}`);
  assert.ok(at(1958) >= 18, `1958 (jet age dawn) should field 18+, got ${at(1958)}`);
  assert.ok(at(1978) >= 48, `1978 should field 48+ types, got ${at(1978)}`);
  assert.ok(at(2000) >= 95, `2000 should field 95+ ORDERABLE types (expiry has removed the propliners by now), got ${at(2000)}`);
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

test('LEASE_AIRCRAFT and BUY_AIRCRAFT are gated too — the old actions are no back door', () => {
  const base = { ...freshState(), phase: 'playing', cash: 500_000_000, startYear: 1950, year: 1, week: 1 };
  for (const action of [{ type: 'LEASE_AIRCRAFT', typeId: 'b747400' }, { type: 'BUY_AIRCRAFT', typeId: 'b747400' }]) {
    const after = gameReducer(base, action);
    assert.equal((after.fleet ?? []).length, (base.fleet ?? []).length, `${action.type}: nothing may land`);
    assert.equal(after.cash, base.cash, `${action.type}: no money may move`);
  }
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
