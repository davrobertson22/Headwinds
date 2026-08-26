// The aircraft card's Route Performance section must show a FREIGHTER'S routes.
//
// Reported on Discord (Knightmare, 2026-08-25) with a screenshot of a Boeing
// 767-300F whose utilisation box read "UTILISATION (10 ROUTES) · 137.7h / 140h"
// and whose Route Performance section, four inches below it on the same card,
// read "Aircraft is idle — assign it to a route to start earning."
//
// Both readings came from the same component. The utilisation box asks the
// engine (aircraftUtilization, routes + cargoRoutes); the route breakdown
// filtered `state.routes` alone, which for a freighter is always empty — every
// freight lane lives in `state.cargoRoutes`. The engine's report was innocent:
// it had the rows all along, in `report.cargoRouteResults`.
//
// The test SSR-renders the real AircraftDetail card and reads the rendered
// markup, because that is where the two readings met and disagreed.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-cargo-panel-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { routeDistanceKm, maxFrequency, weekToGameDate, aircraftUtilization } from '../src/utils/simulation.js';
import { getAircraftType } from '../src/data/aircraft.js';

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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AircraftDetail } = await import('../src/components/Fleet.jsx');

const FRT = AIRCRAFT_TYPES.filter(t => t.freighter && (t.range ?? 0) > 5000)
  .sort((a, b) => (b.range ?? 0) - (a.range ?? 0))[0];
const JET = AIRCRAFT_TYPES.filter(t => !t.freighter && (t.range ?? 0) > 5000)
  .sort((a, b) => (b.range ?? 0) - (a.range ?? 0))[0];
assert.ok(FRT && JET, 'need a freighter and a passenger jet in the type table');

const WEEK  = 20;
const MONTH = weekToGameDate(WEEK).monthIndex;
const CODES = ['MIA', 'JFK', 'ORD', 'LAX', 'DFW'];

const freighter = { id: 'frt', typeId: FRT.id, name: 'Freight One', tailNumber: 'NFRT01',
  status: 'assigned', ageWeeks: 120, ownershipType: 'owned', config: {} };
const jet = { id: 'jet', typeId: JET.id, name: 'Pax One', tailNumber: 'NPAX01',
  status: 'assigned', ageWeeks: 120, ownershipType: 'owned', config: { economy: JET.seats ?? 180 } };

const cargoLane = (id, o, d) => ({
  id, origin: o, destination: d, aircraftId: 'frt', cargo: true,
  weeklyFrequency: Math.max(1, Math.min(3, Math.floor(maxFrequency(routeDistanceKm(o, d), FRT) / 2))),
  weeksOpen: 40, hub: 'MIA', yieldPrice: 0.42,
});

const save = {
  ...freshState(),
  phase: 'playing', week: WEEK, year: 3, hub: 'MIA', cash: 200_000_000,
  homeCountry: 'US',
  gates: Object.fromEntries(CODES.map(c => [c, 20])),
  hubs: { MIA: { tier: 1 } },
  fleet: [freighter, jet],
  routes: [
    { id: 'r-pax', origin: 'MIA', destination: 'JFK', stops: ['MIA', 'JFK'], aircraftId: 'jet',
      weeklyFrequency: 6, weeksOpen: 40, hub: 'MIA', ticketPrice: 220 },
  ],
  cargoRoutes: [cargoLane('c-1', 'MIA', 'JFK'), cargoLane('c-2', 'MIA', 'ORD')],
};

const render = (aircraft) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(AircraftDetail, { aircraft, onClose(){}, onConfigure(){}, onRetire(){}, onSell(){} })));
};

const strip = (html) => html.replace(/<!-- -->/g, '');

console.log('\n── A freighter is not idle ───────────────────────────────');

const frtHtml = strip(render(freighter));

test('the card does not call a freighter with freight routes idle', () => {
  assert.ok(!frtHtml.includes('Aircraft is idle'),
    'Route Performance rendered the idle empty state for a freighter flying 2 cargo lanes');
});

test('every cargo lane the tick flies is listed in Route Performance', () => {
  for (const r of save.cargoRoutes) {
    assert.ok(frtHtml.includes(`${r.origin} → ${r.destination}`),
      `cargo lane ${r.origin}→${r.destination} is missing from the route breakdown`);
  }
});

test('the route breakdown and the utilisation box count the same routes', () => {
  const util = aircraftUtilization({
    aircraft: freighter, type: getAircraftType(FRT.id),
    routes: save.routes, cargoRoutes: save.cargoRoutes, month: MONTH,
    capHours: undefined,
  });
  const m = frtHtml.match(/Route Performance\s*\((\d+) routes\)/);
  assert.ok(m, 'Route Performance printed no route count');
  assert.equal(Number(m[1]), util.routes.length,
    `utilisation says ${util.routes.length} routes, the breakdown lists ${m[1]}`);
});

test('freight rows read in tonnes and $/t-km, not seats and tickets', () => {
  assert.ok(frtHtml.includes('Tonnes/wk'), 'a freight row should report tonnes, not passengers');
  assert.ok(frtHtml.includes('/t-km'), 'a freight row should report the yield per tonne-km, not a ticket price');
  assert.ok(!/Pax\/wk/.test(frtHtml), 'a pure-freighter card should not print a Pax/wk cell');
  assert.ok(!/undefined|NaN/.test(frtHtml), 'a freight row rendered undefined/NaN');
});

test('the weekly net is a number, not "Idle"', () => {
  const i = frtHtml.indexOf('Net / wk');
  assert.ok(i >= 0);
  const box = frtHtml.slice(i, i + 400);
  assert.ok(!box.includes('>Idle<'), 'the freighter still reports Idle net/wk while flying');
});

console.log('\n── The passenger card is unchanged ───────────────────────');

const paxHtml = strip(render(jet));

test('a passenger tail still shows pax and ticket cells', () => {
  assert.ok(paxHtml.includes('MIA → JFK'));
  assert.ok(paxHtml.includes('Pax/wk'));
  assert.ok(!paxHtml.includes('Tonnes/wk'), 'a passenger row must not report tonnes');
  assert.ok(!paxHtml.includes('Aircraft is idle'));
});

test('an idle tail still gets the empty state', () => {
  const idle = { ...jet, id: 'idle', name: 'Spare', tailNumber: 'NIDLE1', status: 'idle' };
  const html = strip(renderToString(React.createElement(GameProvider, null,
    React.createElement(AircraftDetail, { aircraft: idle, onClose(){}, onConfigure(){}, onRetire(){}, onSell(){} }))));
  assert.ok(html.includes('Aircraft is idle'), 'a tail with no routes should still say so');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
