// Fuel operations Phase 3, the screens (FUEL_OPERATIONS_PLAN.md §6.4): the
// programme card on the Fuel tab, the P&L note, the Dashboard tile, the
// wingtip retrofit in Fleet — and the rule that a preview built on the
// projected multiplier moves by exactly what the tick moves.
//
// SSR of the REAL components against a flying fixture (three 737 routes out
// of a hub, the finance-bridge fixture), with a programme switched on. A
// helper tested in isolation can pass while the component that calls it
// fails — that is how the hydrated-`stops` bug was caught.
//
// Verified failing on HEAD (2026-09-19): no programme card, no note row, no
// wingtip button, and the Fleet detail forecast at par fuel.
//
//   node --import ./tools/_register-loader.mjs tools/fuel-programme-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice, defaultConfig, defaultClassPrices, simulateRoute } from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { FUEL_PROGRAMMES, programmeActivationCost } from '../packages/engine/src/data/fuelProgrammes.js';
import { wingtipRetrofitCost } from '../packages/engine/src/data/retrofits.js';

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
globalThis.window ??= { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { formatMoney } = await import('../src/utils/simulation.js');
const Finance   = (await import('../src/components/Finance.jsx')).default;
const Dashboard = (await import('../src/components/Dashboard.jsx')).default;
const { AircraftDetail } = await import('../src/components/Fleet.jsx');

const clean = (html) => html.replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

// ── Fixture: three 737 routes out of a hub at a 1.30× market ─────────────────
const jet = AIRCRAFT_TYPES.find(t => t.id === 'b737800') ?? AIRCRAFT_TYPES.filter(t => !t.freighter)[0];
const HUB = ['SFO', 'JFK', 'LAX'].find(c => getAirport(c));
const DESTS = ['LAX', 'SEA', 'DEN', 'ORD'].filter(c => c !== HUB && getAirport(c)).slice(0, 3);
const fleet = [], routes = [], routePricing = {};
DESTS.forEach((d, i) => {
  fleet.push({ id: `ac${i}`, typeId: jet.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
               status: 'assigned', ageWeeks: 150, ownershipType: 'leased', hasWingtips: false, fuelMod: 1.0, rangeMod: 1.0,
               weeklyLease: jet.weeklyLease, leaseRemainingWeeks: 200, config: defaultConfig(jet.seats) });
  routes.push({ id: `r${i}`, origin: HUB, destination: d, aircraftId: `ac${i}`, weeklyFrequency: 28, weeksOpen: 40, hub: HUB });
  routePricing[[HUB, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(HUB, d)));
});
const walk = [1.1, 1.2, 1.3];
const fin = walk.map((x, i) => ({ label: `W${i + 1}`, week: i + 1, year: 1, revenue: 9e6, fuel: Math.round(2e6 * x), fuelIndex: x,
  totalCost: 8e6, profit: 1e6, passengers: 20_000, cash: 1 }));
const BASE_SAVE = {
  ...freshState(),
  phase: 'playing', week: 4, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 0 } },
  gates: Object.fromEntries([[HUB, 20], ...DESTS.map(d => [d, 8])]),
  fleet, routes, routePricing, cargoRoutes: [], loans: [], competitors: [],
  fuelPrice: { index: 1.30, history: walk }, hedgeContracts: [], financialHistory: fin,
  lastReport: null,
};
const ON = { ...BASE_SAVE, fuelProgrammes: { cost_index: { active: true, sinceAbsWeek: 1 }, engine_wash: { active: true, sinceAbsWeek: 1 } } };

const render = (save, el) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return clean(renderToString(React.createElement(GameProvider, null, el)));
};

console.log('\nFuel tab: the programme card\n');

const fuelOff = render(BASE_SAVE, React.createElement(Finance, { initialView: 'fuel' }));
const fuelOn  = render(ON,        React.createElement(Finance, { initialView: 'fuel' }));

test('the card lists every programme with its burn, cost and trade-off', () => {
  assert.ok(fuelOff.includes('Fuel Efficiency Programme'), 'card missing');
  for (const p of FUEL_PROGRAMMES) {
    assert.ok(fuelOff.includes(`fuel-programme-${p.id}`), `${p.id} row missing`);
    assert.ok(fuelOff.includes(p.label), `${p.id} label`);
    assert.ok(fuelOff.includes(`−${(p.burn * 100).toFixed(1)}% burn`), `${p.id} burn`);
  }
  assert.ok(fuelOff.includes('Nothing running — burn at 100%'));
  assert.ok(fuelOff.includes('−1.5 pt on-time'), 'cost index trade-off');
  assert.ok(fuelOff.includes('+10% breakdown odds'), 'contingency trade-off');
  assert.ok(fuelOff.includes('−2% maintenance'), 'engine wash benefit');
  assert.ok(fuelOff.includes(`${formatMoney(programmeActivationCost('single_engine_taxi', fleet))} once`), 'one-off cost');
});

test('with two programmes on the header reports the compounded burn and the savings', () => {
  assert.ok(fuelOn.includes('2 running · burn −3%'), 'compounded 0.98 × 0.99 → 2.98% → −3%');
  assert.ok(fuelOn.includes('saving '), 'dollar saving stated');
  assert.ok(fuelOn.includes('costing '), 'engine wash opex stated');
  assert.ok(fuelOn.includes('>Stop<'), 'running programmes offer Stop');
  assert.ok(fuelOn.includes('>Start<'), 'the others offer Start');
});

test('the Fuel tab still opens on the hedge desk below the card', () => {
  assert.ok(fuelOn.indexOf('Fuel Efficiency Programme') < fuelOn.indexOf('Buy Fuel Hedge'));
});

console.log('\nP&L and Dashboard\n');

test('the P&L carries a note: of which efficiency programmes saved', () => {
  const html = render(ON, React.createElement(Finance, { initialView: 'pl' }));
  assert.ok(html.includes('pl-fuel-programme-note'), 'note row missing');
  assert.ok(html.includes('of which efficiency programmes saved (3% burn)'), 'label carries the burn');
  const off = render(BASE_SAVE, React.createElement(Finance, { initialView: 'pl' }));
  assert.ok(!off.includes('pl-fuel-programme-note'), 'no programme → no note');
});

test('the P&L note is exactly the programme share of the Fuel & Oil line on the same page', () => {
  // The provider hydrates the save before projecting, so read both figures
  // off the rendered page rather than re-projecting the raw fixture: the
  // note must be fuel / burnMod − fuel of the bill printed two rows above it.
  const html = render(ON, React.createElement(Finance, { initialView: 'pl' }));
  const text = html.replace(/<[^>]+>/g, '|');
  const money = (str) => { const m = /([-+])?\$([\d.]+)([KMB])/.exec(str); return m ? parseFloat(m[2]) * { K: 1e3, M: 1e6, B: 1e9 }[m[3]] : NaN; };
  const noteAt  = text.indexOf('of which efficiency programmes saved');
  const fuelRow = text.slice(text.lastIndexOf('Fuel & Oil', noteAt), noteAt);
  const cells   = fuelRow.split('|').map(c => c.trim()).filter(Boolean);
  const projected = money(cells[3]);            // ['Fuel & Oil', '<n> routes · …', prior, projected, ytd, …]
  const noteCells = text.slice(noteAt).split('|').map(c => c.trim()).filter(Boolean);
  const note = money(noteCells[2]);             // [label, prior, projected, ytd]
  assert.ok(projected > 0 && note > 0, `could not read the rows: ${cells.slice(0, 5)} / ${noteCells.slice(0, 4)}`);
  const burnMod = 0.98 * 0.99;
  const expectedNote = projected / burnMod - projected;
  assert.ok(Math.abs(note - expectedNote) / expectedNote < 0.02,
    `note ${note} should be the programme share of the ${projected} bill (${expectedNote.toFixed(0)})`);
});

test('the Dashboard fuel tile names the programme slice after a tick', () => {
  const ticked = gameReducer(ON, { type: 'ADVANCE_WEEK' });
  assert.ok(ticked.lastReport.fuelProgrammeSavings > 0, 'the tick recorded savings');
  const html = render(ticked, React.createElement(Dashboard));
  assert.ok(html.includes(`programmes −${formatMoney(ticked.lastReport.fuelProgrammeSavings)}/wk`), 'tile subtitle');
});

console.log('\nPreviews agree with the tick\n');

test('a per-route preview built on proj.fuelMultiplier matches the tick\'s fuel for that route', () => {
  // What Fleet ▸ Aircraft Detail and the Dashboard do: simulateRoute with
  // the projected multiplier. It must equal the route's fuel in the tick's
  // own routeResults, with the programme on.
  const proj = projectWeek(ON);
  const rr = proj.report.routeResults.find(r => r.routeId === 'r0');
  assert.ok(rr, 'route result');
  const sim = simulateRoute(routes[0], fleet[0], proj.gameDate, ON.labor ?? null, proj.fuelMultiplier);
  assert.equal(sim.fuelCost, rr.fuelCost, `preview ${sim.fuelCost} vs tick ${rr.fuelCost}`);
  // And at the PRICE multiplier alone it would be wrong — which is the bug
  // this test exists to keep out.
  const wrong = simulateRoute(routes[0], fleet[0], proj.gameDate, ON.labor ?? null, proj.fuelPriceMultiplier);
  assert.notEqual(wrong.fuelCost, rr.fuelCost);
});

console.log('\nFleet: wingtip retrofit\n');

test('a bare tail offers a Fit button priced by the engine; a fitted one wears the badge', () => {
  const def = jet.configOptions?.wingtips;
  assert.ok(def, `fixture type ${jet.id} needs a wingtip option for this test to mean anything`);
  const detail = (save, ac) => render(save, React.createElement(AircraftDetail, { aircraft: ac, onClose() {} }));
  const html = detail(BASE_SAVE, fleet[0]);
  assert.ok(html.includes(`Fit ${def.label} · ${formatMoney(wingtipRetrofitCost(fleet[0]))}`), 'retrofit button with the engine price');
  const fitted = gameReducer(BASE_SAVE, { type: 'RETROFIT_WINGTIPS', aircraftIds: ['ac0'] });
  assert.equal(fitted.fleet[0].hasWingtips, true);
  assert.equal(fitted.cash, BASE_SAVE.cash - wingtipRetrofitCost(fleet[0]), 'charged the quoted price');
  const html2 = detail(fitted, fitted.fleet[0]);
  assert.ok(!html2.includes(`Fit ${def.label}`), 'no button once fitted');
  assert.ok(html2.includes(def.label), 'fitted badge');
  const html3 = detail(fitted, fitted.fleet[1]);
  assert.ok(html3.includes(`Fit ${def.label}`), 'the next tail still offers the retrofit');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
