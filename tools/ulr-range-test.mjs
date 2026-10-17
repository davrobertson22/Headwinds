// ulr-range-test.mjs — ultra-long-range types trade seats for range, steeply.
//
// WHY THIS EXISTS (2026-10-17). The A350-900ULR and A350-1000ULR carried their
// headline range (18,000 km) as `range`, and the engine reads `range` as the reach
// with every seat filled. So a fresh ULR, delivered with an all-economy cabin, flew
// 440 or 480 passengers 18,000 km. The real aircraft can't: the headline is for a
// light premium cabin (Singapore 161 seats, Qantas 238), and a full cabin is
// weight-limited to roughly the standard model's range, with the extra tank empty.
//
// The ULRs now carry their sibling's range for a full cabin and a steep per-type
// `payloadRangeGain`, so taking seats out buys the range back:
//   • full cabin  → exactly the standard model (no free upgrade);
//   • operator cabin → the missions they were built for (SIN–New York, SYD–London);
//   • same light cabin → further than the standard model gets with it.
//
//   node --import ./tools/_register-loader.mjs tools/ulr-range-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { effectiveRangeKm, defaultConfig, configRangeMod, distanceKm, CONFIG_RANGE_GAIN_MAX, lightCabinRange, cabinRangeFix } from '../src/utils/simulation.js';

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

const km = (a, b) => distanceKm(getAirport(a), getAirport(b));
const reach = (id, config) => {
  const t = getAircraftType(id);
  return effectiveRangeKm({ typeId: id, config: config ?? defaultConfig(t.seats) }, t);
};
// Real operator cabins.
const QANTAS_SUNRISE = { firstClass: 6, businessClass: 52, premiumEconomy: 40, economy: 140 };   // 238
const SINGAPORE_ULR  = { firstClass: 0, businessClass: 67, premiumEconomy: 94, economy: 0 };     // 161
const PAIRS = [['a350900ulr', 'a350900', SINGAPORE_ULR], ['a3501000ulr', 'a3501000', QANTAS_SUNRISE]];

test('a full cabin flies exactly as far as the standard model', () => {
  for (const [ulr, std] of PAIRS) {
    assert.equal(reach(ulr), reach(std), `${ulr} all-economy reach should equal ${std}`);
  }
});

test('a fresh all-economy A350-1000ULR cannot fly Sydney–London', () => {
  assert.ok(reach('a3501000ulr') < km('SYD', 'LHR'),
    `all-economy reach ${reach('a3501000ulr')} km vs SYD-LHR ${Math.round(km('SYD', 'LHR'))} km`);
});

test("Qantas' 238-seat cabin reaches Sydney–London and Sydney–New York", () => {
  const r = reach('a3501000ulr', QANTAS_SUNRISE);
  for (const [a, b] of [['SYD', 'LHR'], ['SYD', 'JFK']]) {
    assert.ok(r >= km(a, b), `${r} km vs ${a}-${b} ${Math.round(km(a, b))} km`);
  }
});

test("Singapore's 161-seat cabin reaches Singapore–New York", () => {
  const r = reach('a350900ulr', SINGAPORE_ULR);
  for (const [a, b] of [['SIN', 'EWR'], ['SIN', 'JFK']]) {
    assert.ok(r >= km(a, b), `${r} km vs ${a}-${b} ${Math.round(km(a, b))} km`);
  }
});

test('with the same light cabin, a ULR out-ranges its standard sibling', () => {
  for (const [ulr, std, cabin] of PAIRS) {
    assert.ok(reach(ulr, cabin) > reach(std, cabin), `${ulr} ${reach(ulr, cabin)} vs ${std} ${reach(std, cabin)}`);
  }
});

test('the steep curve is ULR-only, and every other type keeps the standard one', () => {
  const steep = AIRCRAFT_TYPES.filter(t => t.payloadRangeGain != null).map(t => t.id).sort();
  assert.deepEqual(steep, ['a3501000ulr', 'a350900ulr']);
  for (const t of AIRCRAFT_TYPES.filter(t => t.payloadRangeGain != null)) {
    assert.ok(t.payloadRangeGain > CONFIG_RANGE_GAIN_MAX && t.payloadRangeGain <= 0.5, `${t.id} gain ${t.payloadRangeGain}`);
  }
  const a359 = getAircraftType('a350900');
  assert.equal(configRangeMod({ economy: 0, businessClass: 0 }, a359), 1 + CONFIG_RANGE_GAIN_MAX);
});

// ── The screen: a ULR's headline is now a FULL-cabin figure, so the market must
//    say what a light cabin reaches, or the ULR reads as a worse A350. ──────────
const { GameProvider } = await import('../src/store/GameContext.jsx');
const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
const render = (layout) => {
  store.set('market_layout', layout);
  return renderToString(React.createElement(GameProvider, null, React.createElement(Marketplace)))
    .replaceAll('<!-- -->', '');
};

test('lightCabinRange quotes a third of the seats, ULRs only', () => {
  assert.deepEqual(lightCabinRange(getAircraftType('a350900ulr')), { seats: 147, km: 18000 });
  assert.deepEqual(lightCabinRange(getAircraftType('a3501000ulr')), { seats: 160, km: 19300 });
  assert.equal(lightCabinRange(getAircraftType('a350900')), null);
});

for (const layout of ['cards', 'table']) {
  test(`the marketplace (${layout}) quotes both ULRs' light-cabin range`, () => {
    const html = render(layout);
    for (const id of ['a350900ulr', 'a3501000ulr']) {
      const lc = lightCabinRange(getAircraftType(id));
      const text = `${lc.km.toLocaleString()} km at ${lc.seats} seats`;
      assert.ok(html.includes(text), `${id}: expected "${text}"`);
    }
    assert.equal((html.match(/ km at \d+ seats/g) ?? []).length, 2, 'only the two ULRs carry a light-cabin line');
  });
}

// ── An existing dense-cabin ULR on a long route: the notice offers the refit ──
// Tailwinds keeps the reducer in the store; Headwinds in the shared engine.
const ctx = await import('../src/store/GameContext.jsx');
const applyRangeStranding = ctx.applyRangeStranding
  ?? (await import('../packages/engine/src/reducer.mjs')).applyRangeStranding;
const OutOfRangeBadge = (await import('../src/components/OutOfRangeBadge.jsx')).default;

const tail = (id, config) => ({ id, typeId: 'a350900ulr', name: id, tailNumber: id, status: 'active',
  ownershipType: 'leased', ageWeeks: 0, rangeMod: 1.0, config: { ...config, seatQuality: 'standard', serviceQuality: 'standard' } });
const strandState = () => ({
  year: 1, week: 1, cash: 0, pendingToasts: [], newsLog: [],
  fleet: [tail('dense', defaultConfig(440)), tail('light', SINGAPORE_ULR)],
  routes: [
    { id: 'r-dense', origin: 'SIN', destination: 'EWR', stops: ['SIN', 'EWR'], aircraftId: 'dense' },
    { id: 'r-light', origin: 'SIN', destination: 'EWR', stops: ['SIN', 'EWR'], aircraftId: 'light' },
  ],
  cargoRoutes: [],
});

test('cabinRangeFix: a dense -900ULR short of SIN–EWR is fixed by a 147-seat cabin', () => {
  const t = getAircraftType('a350900ulr');
  const fix = cabinRangeFix(tail('x', defaultConfig(440)), t, km('SIN', 'EWR'));
  assert.ok(fix && fix.cabinFixSeats === 147 && fix.cabinFixKm >= km('SIN', 'EWR'), JSON.stringify(fix));
  assert.equal(cabinRangeFix(tail('x', defaultConfig(440)), t, 25_000), null, 'no cabin reaches 25,000 km');
});

test('the out-of-range flag carries the cabin fix; the light tail keeps flying', () => {
  const next = applyRangeStranding(strandState(), { toast: false });
  const dense = next.routes.find(r => r.id === 'r-dense');
  const light = next.routes.find(r => r.id === 'r-light');
  assert.ok(dense.rangeStranded, 'dense all-economy ULR is out of range on SIN-EWR');
  assert.equal(dense.rangeStranded.cabinFixSeats, 147);
  assert.equal(light.rangeStranded, undefined, 'Singapore cabin still reaches SIN-EWR');
});

test('the badge tells the player a lighter cabin brings it back', () => {
  const next = applyRangeStranding(strandState(), { toast: false });
  const html = renderToString(React.createElement(OutOfRangeBadge, { route: next.routes.find(r => r.id === 'r-dense') }))
    .replaceAll('<!-- -->', '');
  assert.ok(html.includes('A lighter cabin brings it back in range') && html.includes('147 seats'), html.slice(0, 400));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
