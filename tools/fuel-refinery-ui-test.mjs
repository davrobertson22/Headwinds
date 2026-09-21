// Fuel operations Phase 6, the screens (FUEL_OPERATIONS_PLAN.md §9): the
// refinery card on the Fuel tab and its P&L line. SSR of the real components.
//
// What the card has to do is make the BET legible: the crack spread, what the
// refinery is charging against the market, and — the part a card selling a
// feature would leave out — that the same machine loses money when the spread
// collapses. So the losing case is asserted here as hard as the winning one.
//
// Verified failing on HEAD (2026-09-20): no refinery card, no P&L line.
//
//   node --import ./tools/_register-loader.mjs tools/fuel-refinery-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { FUEL_OPS_VERSION } from '../packages/engine/src/data/fuelStations.js';
import {
  CRACK_BASE_INDEX, REFINERY_CAPEX, REFINERY_BUILD_WEEKS, REFINERY_MIN_WEEKLY_BILL,
  REFINERY_CAPACITY_SHARE, refineryPriceIndex, refinerySaleValue,
} from '../packages/engine/src/data/refinery.js';

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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { formatMoney } = await import('../src/utils/simulation.js');
const Finance = (await import('../src/components/Finance.jsx')).default;

const clean = (html) => html.replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const jet = AIRCRAFT_TYPES.find(t => t.id === 'b737800') ?? AIRCRAFT_TYPES.filter(t => !t.freighter)[0];
const HUB = 'JFK';
const DESTS = ['LAX', 'BOS'].filter(c => getAirport(c));
const fleet = [], routes = [], routePricing = {};
DESTS.forEach((d, i) => {
  fleet.push({ id: `ac${i}`, typeId: jet.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
               status: 'assigned', ageWeeks: 150, ownershipType: 'leased', fuelMod: 1.0, rangeMod: 1.0,
               weeklyLease: jet.weeklyLease, leaseRemainingWeeks: 200, config: defaultConfig(jet.seats) });
  routes.push({ id: `r${i}`, origin: HUB, destination: d, aircraftId: `ac${i}`, weeklyFrequency: 14, weeksOpen: 40, hub: HUB });
  routePricing[[HUB, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(HUB, d)));
});

// A mega airline: the report is what the refinery is sized and gated off.
const BILL = 250_000_000;
const mk = (over = {}) => ({
  ...freshState(),
  phase: 'playing', week: 9, year: 2, hub: HUB, cash: 6_000_000_000, fuelOpsV: FUEL_OPS_VERSION,
  hubs: { [HUB]: { tier: 2, tierSince: 0 } },
  gates: Object.fromEntries([[HUB, 20], ...DESTS.map(d => [d, 8])]),
  fleet, routes, routePricing, cargoRoutes: [], loans: [], competitors: [],
  fuelPrice: { index: 1.0, history: [1.0] }, hedgeContracts: [], financialHistory: [],
  lastReport: { totalFuel: BILL, fuelMultiplier: 1.0 },
  ...over,
});
const BIG = mk();
const abs = (2 - 1) * 52 + 9;   // year 2 week 9
const owned = (over = {}, stateOver = {}) => mk({
  refinery: { orderedAbsWeek: abs - 60, onlineAbsWeek: abs - 8, capacityLitres: (BILL / 1.45) * 0.4, capex: REFINERY_CAPEX, ...over },
  fuelPrice: { index: 1.0, history: [1.0], crack: CRACK_BASE_INDEX },
  ...stateOver,
});

const render = (save, view = 'fuel') => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(Finance, { initialView: view }))));
};

console.log('\nThe offer\n');

test('a mega airline is offered one, priced and timed by the engine', () => {
  const html = render(BIG);
  assert.ok(html.includes('fuel-refinery-card'), 'card');
  assert.ok(html.includes(`Buy a refinery · ${formatMoney(REFINERY_CAPEX)}`), 'priced button');
  assert.ok(html.includes(`${REFINERY_BUILD_WEEKS} weeks to commission`), 'build time stated');
  assert.ok(html.includes('Not owned'));
});

test('the card is honest about the downside before you buy', () => {
  const html = render(BIG);
  assert.ok(/lose when it collapses/.test(html), 'the card must say it can lose');
  assert.ok(html.includes('crude'), 'names what the exposure becomes');
});

test('a small airline is told the bar, not offered the button', () => {
  const html = render(mk({ lastReport: { totalFuel: 40_000_000, fuelMultiplier: 1.0 } }));
  assert.ok(html.includes('fuel-refinery-card'));
  assert.ok(!html.includes('Buy a refinery'), 'no button far below the bar');
  assert.ok(html.includes(`Sold only to airlines burning ${formatMoney(REFINERY_MIN_WEEKLY_BILL)}+`), 'states the bar');
});

test('an airline near the bar but short of cash sees the engine\'s own reason', () => {
  const html = render(mk({ cash: 1_000_000 }));
  assert.ok(html.includes('Buy a refinery'), 'the button is offered');
  assert.ok(html.includes('disabled'), 'but disabled');
  assert.ok(/Not enough cash/.test(html), 'with the reducer\'s reason');
});

test('a classic world has no refinery card at all', () => {
  const { fuelOpsV: _v, ...classic } = BIG;
  assert.ok(!render(classic).includes('fuel-refinery-card'));
});

console.log('\nOwning one\n');

test('a running refinery shows the spread, its price and what it covers', () => {
  const html = render(owned());
  assert.ok(html.includes('Crack spread'), 'spread row');
  assert.ok(html.includes(`${CRACK_BASE_INDEX.toFixed(2)}×`));
  const price = refineryPriceIndex(1.0, CRACK_BASE_INDEX);
  assert.ok(html.includes(`${price.toFixed(3)}×`), 'refinery price');
  assert.ok(html.includes('against the market'));
  assert.ok(html.includes(`${Math.round(REFINERY_CAPACITY_SHARE * 100)}% of this week's fuel`), 'coverage');
  assert.ok(html.includes(`Sell · ${formatMoney(refinerySaleValue({ capex: REFINERY_CAPEX }))}`), 'sell priced');
  assert.ok(!html.includes('Buy a refinery'), 'no second one');
});

test('a collapsed spread reads as the loss it is, not as a saving', () => {
  const html = render(owned({}, { fuelPrice: { index: 1.0, history: [1.0], crack: 1.0 } }));
  // At a crack of 1.00 the refinery price is 1.04 — above the market.
  assert.ok(html.includes(`${refineryPriceIndex(1.0, 1.0).toFixed(3)}×`), 'price above market shown');
  assert.ok(html.includes('+4.0% against the market'), 'the sign is against the owner');
});

test('commissioning and outage both say the refinery is doing nothing yet', () => {
  const building = render(owned({ onlineAbsWeek: abs + 12 }));
  assert.ok(building.includes('Commissioning'), 'header');
  assert.ok(building.includes('12 weeks to go'));
  const down = render(owned({ outageUntilAbsWeek: abs + 3 }));
  assert.ok(down.includes('Off line'), 'header');
  assert.ok(down.includes('every litre is on the jet market'));
});

console.log('\nThe P&L\n');

test('the refinery gets its own line, signed the right way', () => {
  const win = render(owned({}, {
    lastReport: { totalFuel: BILL, fuelMultiplier: 1.0, refineryShare: 0.4, refineryEdge: 0.067, refinerySavings: 6_700_000 },
    financialHistory: [{ label: 'W8', week: 8, year: 2, fuel: BILL, fuelIndex: 1.0, revenue: 9e8, profit: 1e7, totalCost: 8e8, refineryShare: 0.4, refinerySavings: 6_700_000 }],
  }), 'pl');
  assert.ok(win.includes('pl-refinery'), 'row');
  assert.ok(win.includes(`+${formatMoney(6_700_000)}`), 'a good week reads positive');
  assert.ok(win.includes('40% of your litres priced off crude'));
  const lose = render(owned({}, {
    lastReport: { totalFuel: BILL, fuelMultiplier: 1.0, refineryShare: 0.4, refineryEdge: -0.04, refinerySavings: -4_000_000 },
    financialHistory: [{ label: 'W8', week: 8, year: 2, fuel: BILL, fuelIndex: 1.0, revenue: 9e8, profit: 1e7, totalCost: 8e8, refineryShare: 0.4, refinerySavings: -4_000_000 }],
  }), 'pl');
  assert.ok(lose.includes(`−${formatMoney(4_000_000)}`), 'a bad week reads negative');
  assert.ok(!render(BIG, 'pl').includes('pl-refinery'), 'no refinery, no row');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
