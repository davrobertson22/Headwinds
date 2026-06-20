// Functional test for the Route Planner cabin-configuration feature.
//
// Proves two things:
//   1. The planner's preset/floor helpers (makePreset, configSummary) produce
//      valid layouts that never exceed an airframe's floor space.
//   2. A chosen cabin config actually flows through simulateRoute and changes the
//      forecast (capacity, revenue, load factor) — which is the whole point of
//      letting players pick a configuration before launching a route.
//
//   node --import ./tools/_register-loader.mjs tools/route-config-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import {
  simulateRoute, defaultConfig, configBodies, defaultClassPrices,
  CLASS_SPACE_MULTIPLIERS, distanceKm,
} from '../src/utils/simulation.js';

// Import the REAL helpers from the planner (loader handles the .jsx).
const { makePreset, configSummary } = await import('../src/components/RoutePlanner.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

function seatUnits(cfg) {
  return (cfg.firstClass ?? 0) * CLASS_SPACE_MULTIPLIERS.firstClass
       + (cfg.businessClass ?? 0) * CLASS_SPACE_MULTIPLIERS.businessClass
       + (cfg.premiumEconomy ?? 0) * CLASS_SPACE_MULTIPLIERS.premiumEconomy
       + (cfg.economy ?? 0) * CLASS_SPACE_MULTIPLIERS.economy;
}

const PRESETS = ['economy', 'twoClass', 'threeClass', 'premiumHeavy'];

console.log('\n── 1. Preset layouts respect floor space ────────────────');
// Sample a spread of airframes: small turboprop → superjumbo.
const sample = ['atr72', 'a320neo', 'b7879', 'a350900', 'a380']
  .map(getAircraftType).filter(Boolean);
assert.ok(sample.length >= 4, 'sample aircraft resolved');

for (const type of sample) {
  for (const kind of PRESETS) {
    test(`${type.id} · ${kind}: fits floor & has seats`, () => {
      const cfg = makePreset(kind, type.seats);
      const units = seatUnits(cfg);
      assert.ok(units <= type.seats + 1e-9, `seat units ${units.toFixed(2)} exceed floor ${type.seats}`);
      assert.ok(configBodies(cfg) > 0, 'has at least one seat');
      for (const k of ['firstClass', 'businessClass', 'premiumEconomy', 'economy']) {
        assert.ok((cfg[k] ?? 0) >= 0, `${k} non-negative`);
      }
      if (kind === 'economy') {
        assert.equal(cfg.economy, type.seats, 'all-economy preset fills every seat');
        assert.equal(cfg.businessClass, 0, 'all-economy has no business');
      }
      if (kind === 'twoClass')      assert.ok(cfg.businessClass > 0 && cfg.economy > 0, 'two-class has both cabins');
      if (kind === 'premiumHeavy')  assert.ok(cfg.firstClass > 0 && cfg.businessClass > 0, 'premium-heavy has F + J');
    });
  }
}

test('configSummary formats cabins', () => {
  assert.equal(configSummary({ firstClass: 8, businessClass: 24, economy: 200 }), '8F/24J/200Y');
  assert.equal(configSummary({ economy: 180 }), '180Y');
  assert.equal(configSummary(null), '—');
});

console.log('\n── 2. Config changes the forecast via simulateRoute ─────');
// A long-haul widebody on a real, in-range route.
const type = getAircraftType('a350900');
const O = getAirport('JFK'), D = getAirport('LHR');
assert.ok(O && D && type, 'fixtures resolved');
assert.ok(distanceKm(O, D) < type.range, 'route within range');

// Mirror the planner: a flat economy price PLUS the derived per-class fares that
// ADD_ROUTE assigns on launch (defaultClassPrices). This is what makes premium
// cabins earn their real fares in the forecast.
const PRICE = 600;
const route = {
  id: 'p', origin: 'JFK', destination: 'LHR', aircraftId: 'p',
  weeklyFrequency: 7, ticketPrice: PRICE, classPrices: defaultClassPrices(PRICE), hub: 'JFK',
};
const sim = (config) => simulateRoute(route, { id: 'p', typeId: type.id, ageWeeks: 0, config }, { week: 20, month: 6 });

const allEco   = makePreset('economy', type.seats);
const twoClass = makePreset('twoClass', type.seats);
const premium  = makePreset('premiumHeavy', type.seats);

test('no config defaults to the all-economy result', () => {
  const a = sim(undefined);            // planner passes undefined when unset
  const b = sim(defaultConfig(type.seats));
  assert.ok(a && b, 'both simulate');
  assert.equal(a.revenue, b.revenue, 'revenue matches default config');
  assert.equal(a.configuredSeatsOneWay, b.configuredSeatsOneWay, 'capacity matches');
});

test('explicit all-economy equals makePreset("economy")', () => {
  const a = sim(allEco);
  const b = sim(defaultConfig(type.seats));
  assert.equal(a.revenue, b.revenue, 'same revenue');
  assert.equal(a.configuredSeatsOneWay, b.configuredSeatsOneWay, 'same seats');
});

test('premium-heavy carries fewer bodies than all-economy', () => {
  assert.ok(configBodies(premium) < configBodies(allEco),
    `premium bodies ${configBodies(premium)} should be < ${configBodies(allEco)}`);
});

test('two-class forecast differs from all-economy', () => {
  const eco = sim(allEco), two = sim(twoClass);
  assert.ok(eco && two, 'both simulate');
  // Different cabin mix → different capacity and a different revenue figure.
  assert.notEqual(eco.configuredSeatsOneWay, two.configuredSeatsOneWay, 'capacity should change');
  assert.notEqual(eco.revenue, two.revenue, 'revenue should change');
});

test('premium-heavy lifts revenue per passenger carried (higher avg fare)', () => {
  const eco = sim(allEco), prem = sim(premium);
  // Per seat, a premium cabin can fly emptier if the route lacks premium demand;
  // the dependable invariant is that each passenger carried pays more on average.
  const ecoYield  = eco.revenue  / Math.max(1, eco.passengers);
  const premYield = prem.revenue / Math.max(1, prem.passengers);
  assert.ok(premYield > ecoYield,
    `premium yield/pax ${premYield.toFixed(1)} should beat economy ${ecoYield.toFixed(1)}`);
});

test('class pricing makes a premium cabin out-earn a flat economy fare', () => {
  // The accuracy fix: with per-class fares (what the route actually uses once
  // opened) a premium-heavy cabin earns materially more than if every cabin were
  // charged the flat economy price.
  const withClassPrices = simulateRoute(route, { id: 'p', typeId: type.id, ageWeeks: 0, config: premium }, { week: 20, month: 6 });
  const flat = simulateRoute(
    { ...route, classPrices: undefined },
    { id: 'p', typeId: type.id, ageWeeks: 0, config: premium }, { week: 20, month: 6 });
  assert.ok(withClassPrices.revenue > flat.revenue * 1.1,
    `class-priced revenue ${withClassPrices.revenue} should clearly beat flat ${flat.revenue}`);
});

test('seat-quality upgrade is reflected in op cost', () => {
  const base = sim(allEco);
  const lux  = sim({ ...allEco, seatQuality: 'luxury', serviceQuality: 'luxury' });
  assert.ok(lux.totalOpCost > base.totalOpCost, 'luxury fittings cost more to run');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
