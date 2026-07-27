// Routes page: airport filter + cargo table view.
//
// Server-renders the REAL Routes page against a seeded save that has passenger
// routes out of two different airports, a hub, and freight routes — then asserts
// the airport scoping actually narrows what's rendered and that cargo comes out
// as a sortable table rather than a stack of cards.
//
//   node --import ./tools/_register-loader.mjs tools/routes-filter-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';

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

const jet    = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const frtr   = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => b.range - a.range)[0];
assert.ok(frtr, 'expected at least one freighter type in the catalogue');

// HUB is the player's hub; AWAY is a second, unrelated base. No route touches both.
const [HUB, SPOKE, AWAY, AWAY2] = ['JFK', 'ORD', 'LAX', 'SFO'];
for (const c of [HUB, SPOKE, AWAY, AWAY2]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Routes = (await import('../src/components/Routes.jsx')).default;

function saveWith(overrides = {}) {
  return {
    ...freshState(),
    phase: 'playing', week: 20, year: 1, hub: HUB, cash: 50_000_000,
    hubs: { [HUB]: { tier: 2, tierSince: 1 } },
    gates: { [HUB]: 12, [SPOKE]: 12, [AWAY]: 12, [AWAY2]: 12 },
    fleet: [
      { id: 'ac1', typeId: jet.id,  name: 'Hub Jet',   tailNumber: 'N1', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
      { id: 'ac2', typeId: jet.id,  name: 'Away Jet',  tailNumber: 'N2', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
      { id: 'f1',  typeId: frtr.id, name: 'Hub Frtr',  tailNumber: 'N3', status: 'assigned', ageWeeks: 52, ownershipType: 'owned' },
      { id: 'f2',  typeId: frtr.id, name: 'Away Frtr', tailNumber: 'N4', status: 'assigned', ageWeeks: 52, ownershipType: 'owned' },
    ],
    routes: [
      { id: 'r1', origin: HUB,  destination: SPOKE, aircraftId: 'ac1', weeklyFrequency: 7, weeksOpen: 20, hub: HUB, ticketPrice: 320, cateringLevel: 'full' },
      { id: 'r2', origin: AWAY, destination: AWAY2, aircraftId: 'ac2', weeklyFrequency: 7, weeksOpen: 20, hub: HUB, ticketPrice: 280, cateringLevel: 'full' },
    ],
    cargoRoutes: [
      { id: 'c1', origin: HUB,  destination: SPOKE, aircraftId: 'f1', weeklyFrequency: 4, yieldPrice: 0.35, weeksOpen: 20 },
      { id: 'c2', origin: AWAY, destination: AWAY2, aircraftId: 'f2', weeklyFrequency: 3, yieldPrice: 0.40, weeksOpen: 20 },
    ],
    ...overrides,
  };
}

store.set('bbae_save_v2', JSON.stringify(saveWith()));
// React SSR separates adjacent text expressions with `<!-- -->` comments, so
// `{a} → {b}` comes out as `JFK<!-- --> → <!-- -->ORD`. Strip them so the
// assertions below can match the text a player actually sees.
const clean = (h) => h.replace(/<!-- -->/g, '');
const render = (el) => clean(renderToString(React.createElement(GameProvider, null, el)));

console.log('\n── 1. Routes page renders with the new controls ─────────');

let html;
test('page renders without throwing', () => {
  html = render(React.createElement(Routes));
  assert.ok(html.length > 1000, 'expected a substantial render');
});

test('airport dropdown lists every airport the network touches', () => {
  for (const c of [HUB, SPOKE, AWAY, AWAY2]) {
    assert.ok(html.includes(`value="${c}"`), `${c} missing an <option> in the airport filter`);
  }
  assert.ok(html.includes('Airport: All'), 'default "Airport: All" option missing');
});

test('the hub gets a quick-select chip, non-hubs do not', () => {
  // The chip bar labels itself "Hubs" and the hub code appears as a chip button.
  assert.ok(html.includes('Hubs'), 'hub chip bar heading missing');
  // A hub is marked with a star in the dropdown; spokes are not.
  const hubOpt  = html.match(new RegExp(`<option value="${HUB}"[^>]*>([^<]*)</option>`));
  const awayOpt = html.match(new RegExp(`<option value="${AWAY}"[^>]*>([^<]*)</option>`));
  assert.ok(hubOpt && hubOpt[1].includes('★'), 'hub option should be starred');
  assert.ok(awayOpt && !awayOpt[1].includes('★'), 'non-hub option should not be starred');
});

console.log('\n── 2. Cargo renders as a table, not a stack of cards ────');

test('cargo section renders table headers', () => {
  for (const label of ['Tonnes/wk', 'Yield $/t-km', 'Var. profit']) {
    assert.ok(html.includes(label), `cargo table column "${label}" missing`);
  }
  assert.ok(html.includes('<table'), 'expected a <table> element');
});

test('every cargo route appears as a row', () => {
  assert.ok(html.includes(`${HUB} → ${SPOKE}`), 'hub freight row missing');
  assert.ok(html.includes(`${AWAY} → ${AWAY2}`), 'away freight row missing');
});

test('the Table/Cards toggle is offered', () => {
  assert.ok(html.includes('⊟ Table') && html.includes('⊞ Cards'), 'cargo view toggle missing');
});

console.log('\n── 3. Per-airport counts come from the real page code ───');

// The dropdown label carries the count the filter will actually produce, so it
// is the page's own arithmetic — not a re-implementation of it in the test.
const optionFor = (h, code) => {
  const m = h.match(new RegExp(`<option value="${code}"[^>]*>([^<]*)</option>`));
  assert.ok(m, `no <option> rendered for ${code}`);
  return m[1];
};

test('an airport on one passenger + one freight route counts 2', () => {
  // HUB→SPOKE passenger and HUB→SPOKE freight both touch the hub.
  assert.match(optionFor(html, HUB), /\(2\)/, `expected ${HUB} to count 2 routes`);
});

test('counts are direction-agnostic — the far end counts too', () => {
  // SPOKE is only ever a destination, and should still count both its routes.
  assert.match(optionFor(html, SPOKE), /\(2\)/, `expected ${SPOKE} to count its inbound routes`);
});

test('an airport the network never touches is absent from the list', () => {
  assert.ok(!html.includes('value="ATL"'), 'ATL has no routes and should not be offered');
});

test('the hub sorts to the top of the dropdown, ahead of busier spokes', () => {
  const order = [...html.matchAll(/<option value="([A-Z]{3})"/g)].map(m => m[1]);
  assert.equal(order[0], HUB, `expected the hub first, got ${order.join(', ')}`);
});

console.log('\n── 4. CargoRoutesList honours the airportFilter prop ────');

const CargoRoutesList = (await import('../src/components/CargoRoutesList.jsx')).default;

test('unfiltered, both freight routes render', () => {
  const h = render(React.createElement(CargoRoutesList));
  assert.ok(h.includes(`${HUB} → ${SPOKE}`) && h.includes(`${AWAY} → ${AWAY2}`), 'expected both rows');
});

test('filtered to the hub, only the hub freight route renders', () => {
  const h = render(React.createElement(CargoRoutesList, { airportFilter: HUB }));
  assert.ok(h.includes(`${HUB} → ${SPOKE}`), 'hub freight row should survive the filter');
  assert.ok(!h.includes(`${AWAY} → ${AWAY2}`), 'the away freight route should be filtered out');
  assert.ok(h.includes('of 2'), 'summary should show the scoped count out of the total');
});

test('filtered to an airport with no freight, an empty state explains why', () => {
  const h = render(React.createElement(CargoRoutesList, { airportFilter: 'ATL' }));
  assert.ok(h.includes('No cargo routes touch ATL'), 'expected the scoped empty state');
  assert.ok(!h.includes(`${HUB} → ${SPOKE}`), 'no rows should render');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
