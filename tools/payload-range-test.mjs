// payload-range-test.mjs — range depends on how many people you carry.
//
// WHY THIS EXISTS (2026-10-17). `range` is the maker's headline, and the maker
// quotes it at a TYPICAL cabin (575 on an A380, 396 on a 777-300ER) — but the
// engine used to read it as the range with EVERY seat filled (853 on an A380),
// then add up to 15% for a lighter cabin. So a fresh all-economy A380 flew 853
// people 15,200 km, and an A350-900ULR flew 440 people 18,000 km. Neither can.
//
// The model now anchors on `typicalSeats`:
//   • at the typical cabin the type flies its headline range;
//   • past it, each extra passenger (100 kg with bags) comes out of the fuel —
//     range lost = that mass / the type's own burn per km;
//   • below it, at most +5% (the tanks are already about full);
//   • a new aircraft arrives at its typical seats; AI carriers, on routes they
//     open, fly as many seats as the lane's distance allows (maxSeatsForRange);
//   • routes flying when this shipped keep the old rule on the aircraft flying
//     them (grandfatherRouteRanges); anything opened or moved since uses the new one.
//
//   node --import ./tools/_register-loader.mjs tools/payload-range-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES, getAircraftType, typicalSeatsOf, maxSeatsForRange } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import {
  effectiveRangeKm, legacyEffectiveRangeKm, routeReachKm, payloadRangeMod, newAircraftConfig,
  grandfatherRouteRanges, routeRangeShortfall, cabinRangeFix, fullCabinRangeKm, defaultConfig,
  distanceKm, LIGHT_CABIN_GAIN_MAX, PAX_PAYLOAD_KG, FUEL_KG_PER_L,
} from '../src/utils/simulation.js';
import { pickCompetitorAircraftType } from '../src/models/demand.js';
import { routeDistance } from '../src/utils/market.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); failed++; }
}

const T = (id) => getAircraftType(id);
const km = (a, b) => distanceKm(getAirport(a), getAirport(b));
const eco = (n) => ({ firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: n });
const reach = (id, config) => effectiveRangeKm({ typeId: id, config }, T(id));
const PAX = AIRCRAFT_TYPES.filter(t => !t.freighter);
const QANTAS_SUNRISE = { firstClass: 6, businessClass: 52, premiumEconomy: 40, economy: 140 };   // 238
const SINGAPORE_ULR  = { firstClass: 0, businessClass: 67, premiumEconomy: 94, economy: 0 };     // 161

// ── 1. The data ─────────────────────────────────────────────────────────────
test('every passenger type declares typicalSeats, within 1..seats', () => {
  const bad = PAX.filter(t => !(t.typicalSeats >= 1 && t.typicalSeats <= t.seats)).map(t => `${t.id} (${t.typicalSeats}/${t.seats})`);
  assert.deepEqual(bad, []);
});

// ── 2. The curve ────────────────────────────────────────────────────────────
test('at its typical cabin every passenger type flies exactly its headline range', () => {
  const off = PAX.filter(t => reach(t.id, eco(typicalSeatsOf(t))) !== t.range).map(t => t.id);
  assert.deepEqual(off, []);
});

test('packing past typical costs PAX_PAYLOAD_KG of fuel per extra passenger', () => {
  const t = T('b777300er');
  const extra = 50;
  const burnKgKm = t.fuelBurnPer100km * FUEL_KG_PER_L / 100;
  const expect = Math.round(t.range - extra * PAX_PAYLOAD_KG / burnKgKm);
  assert.equal(reach('b777300er', eco(typicalSeatsOf(t) + extra)), expect);
});

test('a lighter cabin gains at most LIGHT_CABIN_GAIN_MAX', () => {
  for (const t of PAX) {
    assert.ok(payloadRangeMod(0, t) <= 1 + LIGHT_CABIN_GAIN_MAX + 1e-9, t.id);
    assert.ok(payloadRangeMod(typicalSeatsOf(t), t) === 1, t.id);
  }
});

test('an A380 packed to all 853 seats cannot fly its headline range', () => {
  const t = T('a380');
  assert.ok(t.typicalSeats < t.seats, 'A380 typical seats below the exit limit');
  assert.ok(reach('a380', eco(t.seats)) < t.range - 1000, `packed reach ${reach('a380', eco(t.seats))}`);
  assert.equal(fullCabinRangeKm(t), Math.round(reach('a380', eco(t.seats)) / 100) * 100);
});

// ── 3. The ULRs fall out of the same model ──────────────────────────────────
test("Qantas' 238-seat A350-1000ULR reaches Sydney–London and Sydney–New York", () => {
  const r = reach('a3501000ulr', QANTAS_SUNRISE);
  for (const [a, b] of [['SYD', 'LHR'], ['SYD', 'JFK']]) assert.ok(r >= km(a, b), `${r} vs ${a}-${b} ${Math.round(km(a, b))}`);
});
test("Singapore's 161-seat A350-900ULR reaches Singapore–New York", () => {
  const r = reach('a350900ulr', SINGAPORE_ULR);
  for (const [a, b] of [['SIN', 'EWR'], ['SIN', 'JFK']]) assert.ok(r >= km(a, b), `${r} vs ${a}-${b} ${Math.round(km(a, b))}`);
});
test('a ULR packed to the exit limit cannot fly Sydney–London', () => {
  for (const id of ['a350900ulr', 'a3501000ulr']) {
    assert.ok(reach(id, eco(T(id).seats)) < km('SYD', 'LHR'), `${id} packed ${reach(id, eco(T(id).seats))}`);
  }
});

// ── 4. New aircraft and probes use the typical cabin ────────────────────────
test('a new aircraft arrives at typical seats; a type probe is measured that way', () => {
  for (const id of ['a380', 'b777300er', 'a320neo']) {
    assert.equal(newAircraftConfig(T(id)).economy, typicalSeatsOf(T(id)));
    assert.equal(effectiveRangeKm({ typeId: id }, T(id)), T(id).range);
  }
});

const ctx = await import('../src/store/GameContext.jsx');
const { gameReducer, freshState } = ctx;

test('leasing an aircraft delivers it at typical seats', () => {
  let s = { ...freshState(), airlineName: 'Test', hub: 'SYD', homeCountry: 'AU', cash: 5e9 };
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'a380' });
  const a = (s.fleet ?? []).find(x => x.typeId === 'a380');
  assert.ok(a, 'leased');
  assert.equal(a.config.economy, typicalSeatsOf(T('a380')));
});

// ── 5. Grandfathering ───────────────────────────────────────────────────────
const tail = (id, typeId, config) => ({ id, typeId, name: id, tailNumber: id, status: 'assigned',
  ownershipType: 'leased', ageWeeks: 0, rangeMod: 1.0, config: { ...config, seatQuality: 'standard', serviceQuality: 'standard' } });
// A 777-300ER packed to 550 on a lane between its packed reach and its old reach.
const packed = tail('old', 'b777300er', eco(550));
const newReach = effectiveRangeKm(packed, T('b777300er'));
const oldReach = legacyEffectiveRangeKm(packed, T('b777300er'));
const LANE = [['DXB', 'LAX'], ['DOH', 'LAX'], ['SIN', 'SFO'], ['JFK', 'HKG'], ['SYD', 'DFW'], ['LHR', 'PER']]
  .find(([a, b]) => km(a, b) > newReach && km(a, b) <= oldReach);
const routeOn = (id, aircraftId) => ({ id, origin: LANE[0], destination: LANE[1], stops: [LANE[0], LANE[1]], aircraftId });
const oldSave = () => ({ year: 3, week: 10, fleet: [packed, tail('other', 'b777300er', eco(550))],
  routes: [routeOn('r1', 'old')], cargoRoutes: [] });

test('a lane exists between the packed 777-300ER\'s new and old reach', () => {
  assert.ok(LANE, `new ${newReach} km, old ${oldReach} km`);
});

test('a save from before the change keeps its route flying on the same aircraft', () => {
  const s = grandfatherRouteRanges(oldSave());
  assert.equal(s.payloadRangeV2, true);
  assert.deepEqual(s.routes[0].legacyRangeAircraftIds, ['old']);
  assert.equal(routeRangeShortfall(s.routes[0], packed), null, 'grandfathered route still in range');
  assert.equal(grandfatherRouteRanges(s), s, 'idempotent');
});

test('the same lane opened now, or moved to another aircraft, uses the new rule', () => {
  const s = grandfatherRouteRanges(oldSave());
  const fresh = routeOn('r2', 'old');               // a new route: never marked
  assert.ok(routeRangeShortfall(fresh, packed), 'new route on the packed tail is out of range');
  const moved = { ...s.routes[0], aircraftId: 'other' };
  assert.ok(routeRangeShortfall(moved, s.fleet[1]), 'moved to another tail: new rule');
  assert.equal(routeReachKm(s.routes[0], packed, T('b777300er')), oldReach);
});

// ── 5b. A corrected headline never strands a route already flying ───────────
test('corrected types keep their old figure for grandfathered routes only', () => {
  const sp = T('b747sp');
  assert.ok(sp.legacyRange > sp.range, '747SP headline corrected down, old figure kept');
  const tailSP = tail('sp', 'b747sp', eco(sp.seats));
  const lane = { id: 'rsp', origin: 'JFK', destination: 'HKG', stops: ['JFK', 'HKG'], aircraftId: 'sp' };
  assert.ok(km('JFK', 'HKG') > effectiveRangeKm(tailSP, sp) && km('JFK', 'HKG') <= legacyEffectiveRangeKm(tailSP, sp));
  const old = grandfatherRouteRanges({ year: 2, week: 1, fleet: [tailSP], routes: [lane], cargoRoutes: [] });
  assert.equal(routeRangeShortfall(old.routes[0], tailSP), null, 'the 747SP route flying before the fix keeps flying');
  assert.ok(routeRangeShortfall(lane, tailSP), 'the same lane opened now is out of range');
  for (const t of AIRCRAFT_TYPES.filter(x => x.legacyRange != null)) {
    assert.equal(legacyEffectiveRangeKm({ typeId: t.id, config: eco(t.seats) }, t), t.legacyRange, t.id);
  }
});

test('a new game starts on the new rule (nothing to grandfather)', () => {
  assert.equal(freshState().payloadRangeV2, true);
});

test('the out-of-range notice offers the typical cabin when it fixes the lane', () => {
  const fix = cabinRangeFix(packed, T('b777300er'), km(LANE[0], LANE[1]));
  assert.ok(fix && fix.cabinFixSeats === typicalSeatsOf(T('b777300er')), JSON.stringify(fix));
});

// ── 6. AI carriers fly what the lane allows on routes they open ─────────────
test('maxSeatsForRange: every seat on short haul, fewer near the range, never below typical', () => {
  const t = T('b777300er');
  assert.equal(maxSeatsForRange(t, 5_000), t.seats);
  const near = maxSeatsForRange(t, t.range - 500);
  assert.ok(near > typicalSeatsOf(t) && near < t.seats, `near-range seats ${near}`);
  assert.ok(effectiveRangeKm({ typeId: t.id, config: eco(near) }, t) >= t.range - 500);
  assert.equal(maxSeatsForRange(t, t.range), typicalSeatsOf(t));
});

test('new AI routes record the seats they fly, within what the lane allows', () => {
  const s = freshState();
  const routes = (s.competitors ?? []).flatMap(c => Object.entries(c.routes ?? {})).filter(([, r]) => r.aircraftType);
  assert.ok(routes.length > 0, 'the sample world has AI routes');
  const bad = routes.filter(([k, r]) => r.seats !== maxSeatsForRange(T(r.aircraftType), routeDistance(...k.split('-'))));
  assert.equal(bad.length, 0, `${bad.length} AI routes off maxSeatsForRange`);
  const t = pickCompetitorAircraftType(12_000, 'major');
  assert.ok(t && t.range >= 12_000);
});

// ── 7. The screen ───────────────────────────────────────────────────────────
const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
for (const layout of ['cards', 'table']) {
  test(`the marketplace (${layout}) says which cabin the headline range is quoted at`, () => {
    store.set('market_layout', layout);
    const html = renderToString(React.createElement(ctx.GameProvider, null, React.createElement(Marketplace)))
      .replaceAll('<!-- -->', '');
    for (const id of ['a380', 'a3501000ulr']) {
      assert.ok(html.includes(`at ${typicalSeatsOf(T(id))} seats`), `${id}: "at ${typicalSeatsOf(T(id))} seats"`);
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
