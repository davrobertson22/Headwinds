// SSR-renders the REAL departure board against a seeded save, so the screen is
// proven to show the world's actual routes — mine and my rivals' — and not a
// prettily-formatted invention.
//
//   node --import ./tools/_register-loader.mjs tools/departures-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
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
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Departures = (await import('../src/components/Departures.jsx')).default;
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const FLEET = [{
  id: 'ac1', typeId: NB.id, name: 'Tail 1', tailNumber: 'N1TEST',
  status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats },
}];
const ROUTES = [
  { id: 'r1', origin: 'JFK', destination: 'LAX', aircraftId: 'ac1', weeklyFrequency: 14, active: true },
  { id: 'r2', origin: 'JFK', destination: 'ORD', aircraftId: 'ac1', weeklyFrequency: 7, active: true },
];
const COMPETITORS = [
  { id: 'velocity', name: 'Velocity Air', logoId: 'bolt', homeHub: 'ORD', baseQualityScore: 40,
    routes: { 'JFK-MIA': { frequency: 14, aircraftType: 'a320neo' } } },
  { id: 'faraway', name: 'Faraway Air', logoId: 'comet', homeHub: 'SIN', baseQualityScore: 70,
    routes: { 'SIN-HKG': { frequency: 21, aircraftType: 'b737800' } } },
];

function seed(extra = {}) {
  const save = {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000,
    airlineName: 'Southern Cross', logoId: 'horizon',
    gates: { JFK: 8 }, fleet: FLEET, routes: ROUTES, competitors: COMPETITORS, ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

console.log('\n── Operations: departure board ─────────────────────────');

test('the board defaults to the airport the player flies most, and names it', () => {
  seed();
  const html = render(React.createElement(Departures));
  assert.ok(html.includes('DEPARTURES'), 'board header missing');
  assert.ok(html.includes('(JFK)'), 'should open on the busiest airport, JFK');
});

test('it lists the player\'s real destinations and their real aircraft', () => {
  seed();
  const html = render(React.createElement(Departures));
  assert.ok(html.includes('LAX'), 'a route the player actually flies is missing');
  assert.ok(html.includes('ORD'), 'a second player route is missing');
  assert.ok(html.includes(NB.name), 'the aircraft actually assigned to the route is missing');
  assert.ok(html.includes('Southern Cross'), 'the player airline is not named on its own flights');
});

test('rivals flying the same airport appear; rivals elsewhere do not', () => {
  seed();
  const html = render(React.createElement(Departures));
  assert.ok(html.includes('Velocity Air'), 'a rival at this airport is missing from the board');
  // The airport picker lists every airport in the world, so match the BOARD's
  // own destination cells rather than the raw page.
  const destCells = [...html.matchAll(/>([A-Z]{3})<\/span><\/td>/g)].map(m => m[1]);
  assert.ok(destCells.includes('MIA'), 'the rival\'s destination is missing from the board');
  assert.ok(!html.includes('Faraway Air'), 'an airline that does not serve JFK must not appear');
  assert.ok(!destCells.includes('HKG'), 'a destination nobody serves from here must not appear');
});

test('an airport nobody serves renders an empty board, not a crash', () => {
  // Keep a competitor in the save: an empty competitor list makes the provider
  // generate a fresh AI field, which can put a rival at the airport under test.
  seed({ routes: [], competitors: [COMPETITORS[1]] });
  const html = render(React.createElement(Departures, { initialAirport: 'AKL' }));
  assert.ok(html.includes('Nothing departs AKL'), 'empty state missing');
});

test('flights show a clock time, a flight number, a gate and a status', () => {
  seed();
  const html = render(React.createElement(Departures));
  assert.ok(/\d{2}:\d{2}/.test(html), 'no departure times rendered');
  assert.ok(/[A-Z]{2}\d{3,4}/.test(html), 'no flight numbers rendered');
  assert.ok(/On Time|Delayed|Cancelled/.test(html), 'no status column rendered');
});

test('the same save renders the same board twice — no reshuffle on re-render', () => {
  seed();
  assert.equal(render(React.createElement(Departures)), render(React.createElement(Departures)));
});

test('a grounded tail with no reserve prints its departures as Cancelled, with the reason (Discord 2026-09-10)', () => {
  seed({ fleet: [{ ...FLEET[0], status: 'grounded', groundedWeeksLeft: 2, groundedReason: 'failure' }] });
  const html = render(React.createElement(Departures));
  const cancelled = (html.match(/Cancelled/g) ?? []).length;
  const mine = (html.match(/Southern Cross/g) ?? []).length;
  assert.ok(cancelled >= 2, `every one of the player's ${mine} departures should be cancelled (saw ${cancelled})`);
  assert.ok(html.includes('Aircraft grounded'), 'reason names the grounding');
  assert.ok(!/On Time|Delayed/.test(html.split('Velocity Air')[0]), 'no on-time roll for a plane in the hangar');
});

test('a tail in a C check reads the same way, naming the check', () => {
  seed({ fleet: [{ ...FLEET[0], status: 'maintenance', checkType: 'C', checkWeeksLeft: 1 }] });
  const html = render(React.createElement(Departures));
  assert.ok(html.includes('Aircraft in C check'));
});

test('a covered route (reserve flying it) is NOT cancelled', () => {
  const reserve = { ...FLEET[0], id: 'res1', name: 'Reserve', tailNumber: 'N2RES', status: 'assigned' };
  seed({
    fleet: [{ ...FLEET[0], status: 'grounded', groundedWeeksLeft: 2, groundedReason: 'failure' }, reserve],
    routes: ROUTES.map(r => ({ ...r, aircraftId: 'res1', coverForAircraftId: 'ac1' })),
  });
  const html = render(React.createElement(Departures));
  assert.ok(!html.includes('Aircraft grounded'), 'the reserve is flying these');
});

// Discord 2026-09-24: "You're not able to see departures from airports which
// aren't your hub … only happens with your own airline". Every route is a round
// trip, but the board read only the outbound direction of the player's routes.
const destCellsOf = (html) => [...html.matchAll(/>([A-Z]{3})<\/span><\/td>/g)].map(m => m[1]);

test('your return flights show at the outstation, not just at the airport the route opened from', () => {
  seed();
  const html = render(React.createElement(Departures, { initialAirport: 'LAX' }));
  assert.ok(html.includes('Southern Cross'), 'the player flies LAX–JFK, so it departs LAX too');
  assert.ok(destCellsOf(html).includes('JFK'), 'the LAX→JFK return flight is missing');
  assert.ok(!html.includes('Nothing departs LAX'), 'LAX is not empty — the player flies out of it');
});

test('a tag rotation departs its intermediate stop in both directions', () => {
  seed({ routes: [{ id: 'r3', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'ORD', 'LAX'],
                    aircraftId: 'ac1', weeklyFrequency: 7, active: true }] });
  const html = render(React.createElement(Departures, { initialAirport: 'ORD' }));
  const dests = destCellsOf(html);
  assert.ok(dests.includes('LAX'), 'outbound ORD→LAX missing');
  assert.ok(dests.includes('JFK'), 'return ORD→JFK missing');
});

// Discord 2026-09-26: "I can't see rival stopover routes, they just show up as
// a direct route". A Headwinds rival's tag rotation is keyed by its endpoints;
// the stops travel in cfg.rotations.
test('a rival tag rotation departs its stop, and leaves its origin for the stop — not the endpoint', () => {
  const rival = { id: 'hopper', name: 'Hopper Air', logoId: 'bolt', homeHub: 'JFK', baseQualityScore: 50,
    routes: { 'JFK-LHR': { frequency: 7, aircraftType: 'b737800',
                           rotations: [{ stops: ['JFK', 'KEF', 'LHR'], frequency: 7 }] } } };
  seed({ competitors: [rival, COMPETITORS[1]] });
  const atKef = render(React.createElement(Departures, { initialAirport: 'KEF' }));
  assert.ok(atKef.includes('Hopper Air'), 'the rival stops at KEF, so it departs KEF');
  assert.ok(destCellsOf(atKef).includes('LHR') && destCellsOf(atKef).includes('JFK'), 'KEF→LHR and KEF→JFK both fly');
  const atJfk = render(React.createElement(Departures, { initialAirport: 'JFK' }));
  const jfkRival = atJfk.split('Hopper Air').length - 1;
  assert.ok(jfkRival > 0, 'the rival departs JFK');
  assert.ok(destCellsOf(atJfk).includes('KEF'), 'JFK departure goes to the first stop, KEF');
  assert.ok(!destCellsOf(atJfk).includes('LHR'), 'JFK does not fly nonstop to LHR — the rotation stops at KEF');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
