// Fuel operations Phase 5, the screens (FUEL_OPERATIONS_PLAN.md §8): the
// farm controls on the Stations card and Airport Detail — what you hold,
// what a rival holds, the buttons priced by the engine, and the P&L row for
// throughput fees. SSR of the real components.
//
// Verified failing on HEAD (2026-09-20): no farm controls, no fee row.
//
//   node --import ./tools/_register-loader.mjs tools/fuel-farm-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { FUEL_OPS_VERSION } from '../packages/engine/src/data/fuelStations.js';
import { farmCapex, makeFarm } from '../packages/engine/src/data/fuelFarm.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window ??= { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { formatMoney } = await import('../src/utils/simulation.js');
const Finance       = (await import('../src/components/Finance.jsx')).default;
const AirportDetail = (await import('../src/components/AirportDetail.jsx')).default;

const clean = (html) => html.replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const jet = AIRCRAFT_TYPES.find(t => t.id === 'b737800') ?? AIRCRAFT_TYPES.filter(t => !t.freighter)[0];
const HUB = 'JFK';
const DESTS = ['LAX', 'BOS', 'ORD'].filter(c => getAirport(c));
const fleet = [], routes = [], routePricing = {};
DESTS.forEach((d, i) => {
  fleet.push({ id: `ac${i}`, typeId: jet.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
               status: 'assigned', ageWeeks: 150, ownershipType: 'leased', fuelMod: 1.0, rangeMod: 1.0,
               weeklyLease: jet.weeklyLease, leaseRemainingWeeks: 200, config: defaultConfig(jet.seats) });
  routes.push({ id: `r${i}`, origin: HUB, destination: d, aircraftId: `ac${i}`, weeklyFrequency: 21, weeksOpen: 40, hub: HUB, tankering: 'auto' });
  routePricing[[HUB, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(HUB, d)));
});
const V2 = {
  ...freshState(),
  phase: 'playing', week: 4, year: 1, hub: HUB, cash: 900_000_000, fuelOpsV: FUEL_OPS_VERSION,
  hubs: { [HUB]: { tier: 2, tierSince: 0 } },
  gates: Object.fromEntries([[HUB, 20], ...DESTS.map(d => [d, 8])]),
  fleet, routes, routePricing, cargoRoutes: [], loans: [], competitors: [],
  fuelPrice: { index: 1.10, history: [1.0, 1.05, 1.10] }, hedgeContracts: [], financialHistory: [], lastReport: null,
};
const render = (save, el) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return clean(renderToString(React.createElement(GameProvider, null, el)));
};

console.log('\nAirport Detail\n');

test('a station you fly 63 departures from offers both a stake and a farm, priced by the engine', () => {
  const html = render(V2, React.createElement(AirportDetail, { code: HUB, onBack() {} }));
  assert.ok(html.includes(`fuel-farm-${HUB}`), 'controls');
  assert.ok(html.includes(`Buy stake · ${formatMoney(farmCapex(1, HUB))}`), 'stake priced');
  assert.ok(html.includes(`Build farm · ${formatMoney(farmCapex(2, HUB))}`), 'farm priced');
});

test('a station with too few departures shows the button disabled with the reason', () => {
  const html = render(V2, React.createElement(AirportDetail, { code: 'LAX', onBack() {} }));
  assert.ok(html.includes(`fuel-farm-LAX`));
  assert.ok(/Build farm[^<]*<\/button>/.test(html));
  assert.ok(html.includes('disabled') && html.includes('60 weekly departures'), 'reason in the title');
});

test('what you hold and what a rival holds both read on the page', () => {
  const mine = { ...V2, fuelFarms: { [HUB]: makeFarm(HUB, 1, 1, farmCapex(1, HUB)) } };
  const a = render(mine, React.createElement(AirportDetail, { code: HUB, onBack() {} }));
  assert.ok(a.includes('stake −4%'), 'stake badge');
  assert.ok(a.includes('Upgrade to farm'), 'upgrade path');
  assert.ok(a.includes('>Sell<'), 'sell');
  const taken = { ...V2, competitors: [{ id: 'x', name: 'Bob Airways', human: true, fuelFarms: { [HUB]: 2 }, routes: {}, cargoRoutes: {}, tier: 'legacy' }] };
  const b = render(taken, React.createElement(AirportDetail, { code: HUB, onBack() {} }));
  assert.ok(b.includes('Bob Airways owns the farm'), 'rival owner named');
  assert.ok(!b.includes('Build farm'), 'no build button where a rival owns');
  assert.ok(b.includes('Buy stake'), 'a stake is still on offer');
});

console.log('\nFuel tab and P&L\n');

test('the Stations card carries a Fuel farm column with the controls per station', () => {
  const ticked = gameReducer(V2, { type: 'ADVANCE_WEEK' });
  const html = render(ticked, React.createElement(Finance, { initialView: 'fuel' }));
  assert.ok(html.includes('>Fuel farm<'), 'column header');
  for (const code of Object.keys(ticked.lastReport.fuelByStation)) assert.ok(html.includes(`fuel-farm-${code}`), `controls for ${code}`);
});

test('a farm shows its live discount and opex on the Fuel tab, and the report charges the opex', () => {
  const withFarm = gameReducer(V2, { type: 'BUILD_FUEL_FARM', code: HUB });
  assert.equal(withFarm.fuelFarms[HUB].level, 2, 'fixture built the farm');
  const ticked = gameReducer(withFarm, { type: 'ADVANCE_WEEK' });
  assert.equal(ticked.lastReport.totalFuelFarmCosts, Math.round(farmCapex(2, HUB) * 0.0015));
  const html = render(ticked, React.createElement(Finance, { initialView: 'fuel' }));
  assert.ok(html.includes('your farm −6%'), 'farm badge at the 60% ramp floor');
});

test('throughput fees appear as their own income row on the P&L', () => {
  const ticked = gameReducer(V2, { type: 'ADVANCE_WEEK', incomingFarmFees: 750_000 });
  assert.equal(ticked.lastReport.totalFarmFeeIncome, 750_000);
  const html = render(ticked, React.createElement(Finance, { initialView: 'pl' }));
  assert.ok(html.includes('pl-farm-fees'), 'row present');
  assert.ok(html.includes(`+${formatMoney(750_000)}`), 'prior-week figure');
  const plain = render(gameReducer(V2, { type: 'ADVANCE_WEEK' }), React.createElement(Finance, { initialView: 'pl' }));
  assert.ok(!plain.includes('pl-farm-fees'), 'no row without fees');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
