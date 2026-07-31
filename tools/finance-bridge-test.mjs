// Render smoke for the Finance cost bridge.
//
// tools/pnl-bridge-test.mjs proves the ARITHMETIC reconciles. This proves the
// card actually renders it: server-renders the real Finance P&L view over a
// seeded save and checks the ladder's anchor rows are on screen with both
// margins on them. Catches the class of break a pure-node suite cannot — a bad
// hook, a missing import, a prop mistake in the JSX.
//
//   node --import ./tools/_register-loader.mjs tools/finance-bridge-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice, defaultConfig, defaultClassPrices } from '../src/utils/simulation.js';

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
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nFinance cost bridge (render)\n');

const jet = AIRCRAFT_TYPES.find(t => t.id === 'b737800')
  ?? AIRCRAFT_TYPES.filter(t => !t.freighter)[0];
const HUB = ['SFO', 'JFK', 'LAX'].find(c => getAirport(c));
const DESTS = ['LAX', 'SEA', 'DEN', 'ORD'].filter(c => c !== HUB && getAirport(c)).slice(0, 3);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Finance = (await import('../src/components/Finance.jsx')).default;

const fleet = [], routes = [], routePricing = {};
DESTS.forEach((d, i) => {
  fleet.push({ id: `ac${i}`, typeId: jet.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
               status: 'assigned', ageWeeks: 150, ownershipType: 'leased',
               weeklyLease: jet.weeklyLease, leaseRemainingWeeks: 200,
               config: defaultConfig(jet.seats) });
  routes.push({ id: `r${i}`, origin: HUB, destination: d, aircraftId: `ac${i}`,
                weeklyFrequency: 28, weeksOpen: 40, hub: HUB });
  routePricing[[HUB, d].sort().join('-')] =
    defaultClassPrices(Math.round(referencePrice(HUB, d)));
});

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 20_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 0 } },
  gates: Object.fromEntries([[HUB, 20], ...DESTS.map(d => [d, 8])]),
  fleet, routes, routePricing,
  marketingBudget: 250_000,
  loyalty: { members: 30_000, weeklyInvestment: 100_000, maturity: 0.5 },
  awareness: 52,
};
store.set('bbae_save_v2', JSON.stringify(save));

// React SSR escapes ampersands, so "Staff & payroll" arrives as
// "Staff &amp; payroll". Decode before matching rather than asserting on
// entities — otherwise every label with an "&" in it silently fails to match
// and the test looks like a missing row.
const render = (el) =>
  renderToString(React.createElement(GameProvider, null, el)).replace(/&amp;/g, '&');

test('the Finance P&L view renders the cost bridge without throwing', () => {
  const html = render(React.createElement(Finance));
  assert.ok(html.includes('Cost Bridge'),
    'the card should be titled as a bridge, not a cost-category waterfall');
});

test('both anchor rows are on screen — route profit and net profit', () => {
  const html = render(React.createElement(Finance));
  assert.ok(html.includes('Route operating profit'),
    'the row a player is reconciling FROM (their Routes page figure) must appear');
  assert.ok(html.includes('Net profit'),
    'and the row they are reconciling TO');
  assert.ok(html.includes('Operating profit (EBITDA)'), 'with EBITDA between them');
});

test('the costs that explain the gap are itemised, not collapsed', () => {
  const html = render(React.createElement(Finance));
  for (const label of ['Staff & payroll', 'HQ, insurance & bases', 'Marketing, loyalty & hubs',
                       'Distribution & partner fees', 'Gates & slots']) {
    assert.ok(html.includes(label), `"${label}" should be visible by default`);
  }
});

test('the card states both margins up front', () => {
  const html = render(React.createElement(Finance));
  assert.ok(/Your routes run at/.test(html) && /The company runs at/.test(html),
    'the 52%-vs-28% question should be answered in the card\'s own subtitle');
});

test('no unattributed "Other" row appears on a normal save', () => {
  const html = render(React.createElement(Finance));
  assert.ok(!html.includes('>Other<'),
    'a visible Other row means a cost line exists that pnlBridge.js does not name');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
