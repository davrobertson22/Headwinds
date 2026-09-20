// Fuel operations Phase 4, the screens (FUEL_OPERATIONS_PLAN.md §7.3): the
// rule is that ANY surface naming an airport shows its fuel basis — and only
// in a world that is charged it. SSR of the real components against a v2
// save and the same save on the classic rules.
//
// Verified failing on HEAD (2026-09-20): no chip anywhere, no Fuel column,
// no Stations card, no tankering control.
//
//   node --import ./tools/_register-loader.mjs tools/fuel-stations-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { stationFuelBasis, FUEL_OPS_VERSION } from '../packages/engine/src/data/fuelStations.js';

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
const Airports      = (await import('../src/components/Airports.jsx')).default;
const AirportDetail = (await import('../src/components/AirportDetail.jsx')).default;
const HubManagement = (await import('../src/components/HubManagement.jsx')).default;
const RouteDetail   = (await import('../src/components/RouteDetail.jsx')).default;

const clean = (html) => html.replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

// ── Fixture: a JFK hub flying to LAX, BOS and a Pacific island ──────────────
const jet = AIRCRAFT_TYPES.find(t => t.id === 'b737800') ?? AIRCRAFT_TYPES.filter(t => !t.freighter)[0];
const wide = AIRCRAFT_TYPES.find(t => t.id === 'b787-9') ?? AIRCRAFT_TYPES.filter(t => !t.freighter && t.range > 12000)[0];
const HUB = 'JFK';
const DESTS = [['LAX', jet], ['BOS', jet], ['HNL', wide]].filter(([c]) => getAirport(c));
const fleet = [], routes = [], routePricing = {};
DESTS.forEach(([d, type], i) => {
  fleet.push({ id: `ac${i}`, typeId: type.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
               status: 'assigned', ageWeeks: 150, ownershipType: 'leased', fuelMod: 1.0, rangeMod: 1.0,
               weeklyLease: type.weeklyLease, leaseRemainingWeeks: 200, config: defaultConfig(type.seats) });
  routes.push({ id: `r${i}`, origin: HUB, destination: d, aircraftId: `ac${i}`, weeklyFrequency: 14, weeksOpen: 40, hub: HUB, tankering: 'auto' });
  routePricing[[HUB, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(HUB, d)));
});
const CLASSIC = {
  ...freshState(),
  phase: 'playing', week: 4, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 0 } },
  gates: Object.fromEntries([[HUB, 20], ...DESTS.map(([d]) => [d, 8])]),
  fleet, routes, routePricing, cargoRoutes: [], loans: [], competitors: [],
  fuelPrice: { index: 1.10, history: [1.0, 1.05, 1.10] }, hedgeContracts: [], financialHistory: [], lastReport: null,
};
const V2 = { ...CLASSIC, fuelOpsV: FUEL_OPS_VERSION };

const render = (save, el) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return clean(renderToString(React.createElement(GameProvider, null, el)));
};
const chip = (code) => `fuel-basis-${code}`;

console.log('\nThe chip is on every airport surface — and nowhere in a classic world\n');

test('Airports: the gates table gains a sortable Fuel column with a chip per station', () => {
  const html = render(V2, React.createElement(Airports));
  assert.ok(html.includes('>Fuel<') || html.includes('>Fuel ▾<') || html.includes('>Fuel ▴<'), 'Fuel header');
  for (const [d] of DESTS) assert.ok(html.includes(chip(d)), `chip for ${d}`);
  assert.ok(html.includes(chip(HUB)));
  assert.ok(html.includes(`${stationFuelBasis('JFK').toFixed(2)}×`), 'JFK basis printed');
  const classic = render(CLASSIC, React.createElement(Airports));
  assert.ok(!classic.includes('fuel-basis-'), 'no chip in a classic world');
  assert.ok(!/>Fuel[ ▾▴]*</.test(classic), 'no Fuel column in a classic world');
});

test('Airport Detail: basis beside runway and gates, with the driver and your uplift', () => {
  const html = render(V2, React.createElement(AirportDetail, { code: 'HNL', onBack() {} }));
  assert.ok(html.includes(chip('HNL')), 'chip');
  assert.ok(html.includes('stated for HNL') || html.includes('island'), 'driver text');
  assert.ok(html.includes('ft runway'), 'the runway pill is still there');
  const classic = render(CLASSIC, React.createElement(AirportDetail, { code: 'HNL', onBack() {} }));
  assert.ok(!classic.includes('fuel-basis-'));
});

test('Hub Management: the basis sits on the hub card before any capex is committed', () => {
  const html = render(V2, React.createElement(HubManagement));
  assert.ok(html.includes(chip(HUB)), 'hub card chip');
  const classic = render(CLASSIC, React.createElement(HubManagement));
  assert.ok(!classic.includes('fuel-basis-'));
});

test('Route Detail: chips on both endpoints, a Fuel/wk stat and the tankering control', () => {
  const html = render(V2, React.createElement(RouteDetail, { origin: HUB, dest: 'BOS', onBack() {} }));
  assert.ok(html.includes(chip(HUB)) && html.includes(chip('BOS')), 'endpoint chips');
  assert.ok(html.includes('Fuel/wk'), 'fuel stat');
  assert.ok(html.includes('tankering-control'), 'tankering control');
  assert.ok(html.includes('>Auto<') && html.includes('>Off<'));
  const classic = render(CLASSIC, React.createElement(RouteDetail, { origin: HUB, dest: 'BOS', onBack() {} }));
  assert.ok(!classic.includes('tankering-control') && !classic.includes('fuel-basis-'));
});

console.log('\nThe Stations card reads the tick\n');

test('after a tick the Fuel tab lists uplift by station from the report, summing to the bill', () => {
  const ticked = gameReducer(V2, { type: 'ADVANCE_WEEK' });
  const by = ticked.lastReport.fuelByStation;
  assert.ok(by && Object.keys(by).length >= 3, 'report has fuel by station');
  const html = render(ticked, React.createElement(Finance, { initialView: 'fuel' }));
  assert.ok(html.includes('fuel-stations-card'), 'card');
  for (const code of Object.keys(by)) assert.ok(html.includes(`fuel-station-row-${code}`), `row for ${code}`);
  const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  assert.ok(html.includes(formatMoney(top[1])), 'the biggest uplift is printed');
  const sum = Object.values(by).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - ticked.lastReport.totalFuel) <= 2, `by-station ${sum} vs bill ${ticked.lastReport.totalFuel}`);
  assert.ok(html.includes('network basis'), 'network basis header');
});

test('a classic save shows no Stations card', () => {
  const ticked = gameReducer(CLASSIC, { type: 'ADVANCE_WEEK' });
  assert.ok(!('fuelByStation' in ticked.lastReport));
  const html = render(ticked, React.createElement(Finance, { initialView: 'fuel' }));
  assert.ok(!html.includes('fuel-stations-card'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
