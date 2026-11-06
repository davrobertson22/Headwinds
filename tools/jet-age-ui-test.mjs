// Server-renders the REAL Route Detail screen in an era world with a Vanguard
// on a long sector (tools/jet-age-test.mjs proves the model). The quality panel
// is where a player goes to ask why a route is losing passengers, and the jet
// age is not a quality term, so it gets its own line — and only when it bites.
//
//   node --import ./tools/_register-loader.mjs tools/jet-age-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { referencePrice } from '../src/utils/simulation.js';
import { setEraCalendarYear } from '../packages/engine/src/utils/market.js';

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
  finally { setEraCalendarYear(null); }
}

console.log('\nThe jet age — Route Detail\n');

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteDetail = (await import('../src/components/RouteDetail.jsx')).default;

const P = 'LHR', Q = 'ATH';
function seed(typeId, extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: 10, year: 17, startYear: 1950, hub: P, cash: 50_000_000,
    gates: { [P]: 8, [Q]: 8 },
    fleet: [{ id: 'ac1', typeId, name: 'One', tailNumber: 'G-APEA', status: 'assigned',
      ageWeeks: 52, ownershipType: 'owned' }],
    routes: [{ id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'ac1',
      weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: Math.round(referencePrice(P, Q)) }],
    lastReport: { reputationScore: 58, routeResults: [{ routeId: 'r1', passengers: 700, qualityScore: 61 }] },
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  setEraCalendarYear(1950 + save.year - 1);   // what the reducer publishes for this save
  return save;
}
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!--.*?-->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('a Vanguard on LHR–ATH in 1966 shows the jet-age line', () => {
  seed('vanguard');
  const html = render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} }));
  assert.ok(html.includes('data-jet-age'), 'no jet-age row');
  assert.match(text(html), /Jet age .*Vickers Vanguard is a propeller airliner.*−35% demand/);
});

test('a Caravelle on the same sector shows none', () => {
  seed('caravelle');
  const html = render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} }));
  assert.ok(!html.includes('data-jet-age'));
});

test('a classic world shows none', () => {
  seed('vanguard', { startYear: undefined, year: 2 });
  setEraCalendarYear(null);
  const html = render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} }));
  assert.ok(!html.includes('data-jet-age'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
