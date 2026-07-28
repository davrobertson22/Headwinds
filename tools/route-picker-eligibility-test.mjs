// Route form: the Aircraft picker must offer only airframes the ADD_ROUTE
// reducer would actually accept.
//
// The reducer's connectivity rule: an aircraft that already flies somewhere can
// only pick up a route touching an airport it already serves — no teleporting.
// If the picker lists a plane that fails that rule, the player builds a whole
// route form and gets rejected on submit. This renders the REAL AddRouteForm and
// asserts the offending airframes never reach the <option> list.
//
//   node --import ./tools/_register-loader.mjs tools/route-picker-eligibility-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { MAX_WEEKLY_BLOCK_HOURS } from '../src/utils/simulation.js';

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

// A long-range jet (so range never becomes the reason a plane is excluded) and a
// freighter, which must never appear in a passenger picker at all.
const jet  = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const frtr = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => b.range - a.range)[0];

// HUB/SPOKE are where the player flies today. FAR1/FAR2 are an unrelated pair —
// nothing in the fleet touches them.
const [HUB, SPOKE, FAR1, FAR2] = ['GRR', 'DFW', 'SFO', 'FRA'];
for (const c of [HUB, SPOKE, FAR1, FAR2]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AddRouteForm } = await import('../src/components/Routes.jsx');

const plane = (id, name) => ({
  id, name, typeId: jet.id, tailNumber: id.toUpperCase(),
  status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
  config: { economy: jet.seats },
});

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 10, [SPOKE]: 10, [FAR1]: 10, [FAR2]: 10 },
  fleet: [
    plane('ac_hub',  'Hub Flyer'),      // flies HUB–SPOKE — eligible for that pair
    plane('ac_far',  'Far Flyer'),      // flies FAR1–FAR2 — cannot teleport to HUB
    { ...plane('ac_idle', 'Idle Bird'), status: 'idle' },  // no routes — goes anywhere
    { id: 'frt', name: 'Box Hauler', typeId: frtr.id, tailNumber: 'NF1',
      status: 'assigned', ageWeeks: 52, ownershipType: 'owned' },
  ],
  routes: [
    { id: 'r1', origin: HUB,  destination: SPOKE, aircraftId: 'ac_hub', weeklyFrequency: 7, weeksOpen: 20, hub: HUB, ticketPrice: 220, cateringLevel: 'full' },
    { id: 'r2', origin: FAR1, destination: FAR2,  aircraftId: 'ac_far', weeklyFrequency: 3, weeksOpen: 20, hub: HUB, ticketPrice: 480, cateringLevel: 'full' },
  ],
  cargoRoutes: [],
};

store.set('bbae_save_v2', JSON.stringify(save));

const clean = (h) => h.replace(/<!-- -->/g, '');
const render = (props) => clean(renderToString(
  React.createElement(GameProvider, null,
    React.createElement(AddRouteForm, { onClose: () => {}, ...props }))
));

// Pull just the Aircraft <select>, so a plane named elsewhere on the form (the
// warning line, a preview) can't be mistaken for an offered option.
const optionsOf = (html) => {
  const sel = html.match(/<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g) ?? [];
  const acSel = sel.find(s => /seats\)/.test(s));
  return acSel ?? '';
};

console.log('\n── 1. A plane whose network misses the pair is not offered ──');

let opts;
test('form renders', () => {
  opts = optionsOf(render({ initialOrigin: HUB, initialDest: SPOKE }));
  assert.ok(opts.length > 0, 'no aircraft <select> rendered');
});

test('the idle aircraft is offered (it can go anywhere)', () => {
  assert.ok(opts.includes('Idle Bird'), 'an idle airframe must always be selectable');
});

test('the aircraft already serving the pair is offered', () => {
  assert.ok(opts.includes('Hub Flyer'), 'a plane already on this pair must be selectable');
});

test('the aircraft based on an unrelated pair is NOT offered', () => {
  assert.ok(!opts.includes('Far Flyer'),
    'a plane whose network misses both endpoints would be rejected by ADD_ROUTE — hide it');
});

test('freighters are never offered on a passenger route', () => {
  assert.ok(!opts.includes('Box Hauler'), 'freighters belong to the cargo planner');
});

console.log('\n── 2. Eligibility follows the chosen pair ──────────────');

test('choosing the far pair flips which airframes are offered', () => {
  const o = optionsOf(render({ initialOrigin: FAR1, initialDest: FAR2 }));
  assert.ok(o.includes('Far Flyer'), 'the far-based plane serves this pair');
  assert.ok(o.includes('Idle Bird'), 'idle is eligible everywhere');
  assert.ok(!o.includes('Hub Flyer'), 'the hub plane cannot teleport to the far pair');
});

test('a pair touching one served airport keeps that aircraft eligible', () => {
  // SPOKE is an endpoint of the hub plane's existing route, so it may extend there.
  const o = optionsOf(render({ initialOrigin: SPOKE, initialDest: FAR1 }));
  assert.ok(o.includes('Hub Flyer'), 'extending from a served airport is allowed');
  assert.ok(o.includes('Far Flyer'), 'FAR1 is served by the far plane');
});

console.log('\n── 3. Out-of-hours airframes drop out ──────────────────');

test('a plane with no block hours left is not offered', () => {
  const t = AIRCRAFT_TYPES.find(x => x.id === jet.id);
  assert.ok(t, 'jet type missing');
  // Saturate the hub plane: enough frequency to blow past the weekly cap.
  const saturated = {
    ...save,
    routes: [
      { ...save.routes[0], weeklyFrequency: 21 },
      { id: 'r1b', origin: HUB, destination: FAR1, aircraftId: 'ac_hub', weeklyFrequency: 21, weeksOpen: 20, hub: HUB, ticketPrice: 300, cateringLevel: 'full' },
      save.routes[1],
    ],
  };
  store.set('bbae_save_v2', JSON.stringify(saturated));
  const o = optionsOf(render({ initialOrigin: HUB, initialDest: SPOKE }));
  store.set('bbae_save_v2', JSON.stringify(save));
  assert.ok(!o.includes('Hub Flyer'),
    `a plane past ${MAX_WEEKLY_BLOCK_HOURS}h block hours has nothing left to give`);
  assert.ok(o.includes('Idle Bird'), 'the idle plane should still be there');
});

console.log('\n── 4. An empty picker explains itself ──────────────────');

test('with no eligible aircraft the player is told why, not shown a blank list', () => {
  const only = { ...save, fleet: [save.fleet[1]], routes: [save.routes[1]] };  // far plane only
  store.set('bbae_save_v2', JSON.stringify(only));
  const html = render({ initialOrigin: HUB, initialDest: SPOKE });
  store.set('bbae_save_v2', JSON.stringify(save));
  assert.ok(html.includes('no eligible aircraft'), 'expected the empty-picker option label');
  assert.ok(html.includes('No aircraft is free for this pair'), 'expected the explanatory hint');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
