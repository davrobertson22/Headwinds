// Freighter conversions, the screens (claude/p2f-conversion.md): SSR of the
// REAL Fleet aircraft detail against a flying fixture. The button carries the
// engine's quote; a leased tail says why not; a tail in the hangar reads as a
// conversion, not a "P2F check"; a converted tail shows where it came from.
//
// Verified failing on HEAD (2026-11-05): no ConvertToFreighter export, no
// button, and a tail in conversion would have rendered "P2F check".
//
//   node --import ./tools/_register-loader.mjs tools/p2f-conversion-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { canConvertToFreighter } from '../packages/engine/src/data/conversions.js';

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
const { AircraftDetail } = await import('../src/components/Fleet.jsx');
const Maintenance = (await import('../src/components/Maintenance.jsx')).default;

const clean = (html) => html.replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#x2014;/g, '—');

const jet = getAircraftType('b737800');
const HUB = 'JFK', DEST = 'BOS';
const tail = (id, extra = {}) => ({
  id, typeId: 'b737800', name: `Boeing 737-800 #${id}`, tailNumber: `N${id}P2F`, status: 'idle', ageWeeks: 20 * 52,
  ownershipType: 'owned', fuelMod: 1.0, rangeMod: 1.0, config: defaultConfig(jet.seats), ...extra,
});
const BASE = {
  ...freshState(),
  phase: 'playing', week: 4, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 0 } }, gates: { [HUB]: 20, [DEST]: 8 },
  fleet: [tail('1', { status: 'assigned' }), tail('2'), tail('3', { ownershipType: 'lease', weeklyLease: jet.weeklyLease, leaseRemainingWeeks: 100 })],
  routes: [{ id: 'r1', origin: HUB, destination: DEST, aircraftId: '1', weeklyFrequency: 14, weeksOpen: 20, hub: HUB }],
  routePricing: { [[HUB, DEST].sort().join('-')]: defaultClassPrices(Math.round(referencePrice(HUB, DEST))) },
  cargoRoutes: [], loans: [], competitors: [], financialHistory: [], lastReport: null,
};
const render = (save, el) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return clean(renderToString(React.createElement(GameProvider, null, el)));
};
const detail = (save, ac) => render(save, React.createElement(AircraftDetail, { aircraft: ac, onClose() {} }));

test('an owned 737-800 offers the conversion at the engine price', () => {
  const q = canConvertToFreighter(BASE, [BASE.fleet[1]]);
  const html = detail(BASE, BASE.fleet[1]);
  assert.ok(html.includes(`Convert to freighter · ${formatMoney(q.capex)}`), 'button with the engine price');
  assert.ok(html.includes(`back in ${q.byId['2'].readyInWeeks} weeks`), 'ready week in the tooltip');
});

test('a tail still flying is offered too (the confirm closes its route)', () => {
  const html = detail(BASE, BASE.fleet[0]);
  assert.ok(html.includes('Convert to freighter ·'));
  assert.ok(!/disabled=""[^>]*>[^<]*<[^>]*>[^<]*Convert to freighter/.test(html), 'not disabled');
});

test('a leased tail is refused with the reason', () => {
  const html = detail(BASE, BASE.fleet[2]);
  assert.ok(html.includes('the lessor owns this one'), 'lease reason in the tooltip');
});

test('in the hangar it reads as a conversion; out of it, as converted — and Maintenance agrees', () => {
  let s = gameReducer(BASE, { type: 'CONVERT_TO_FREIGHTER', aircraftIds: ['2'] });
  const parked = s.fleet.find(a => a.id === '2');
  assert.equal(parked.checkType, 'P2F');
  const html = detail(s, parked);
  assert.ok(html.includes(`Freighter conversion (${parked.checkWeeksLeft}w)`), 'status badge');
  assert.ok(html.includes('In freighter conversion to the Boeing 737-800BCF'), 'maintenance section');
  assert.ok(!html.includes('P2F check'), 'never "P2F check"');
  assert.ok(!html.includes('Convert to freighter ·'), 'no second conversion');
  const maint = render(s, React.createElement(Maintenance));
  assert.ok(!maint.includes('P2F check'), 'Maintenance never says "P2F check"');

  for (let i = 0; i < parked.checkWeeksLeft; i++) s = gameReducer({ ...s, cash: 1e9 }, { type: 'ADVANCE_WEEK' });
  const done = s.fleet.find(a => a.id === '2');
  assert.equal(done.typeId, 'b737800bcf');
  const html2 = detail(s, done);
  assert.ok(html2.includes('Converted'), 'converted badge');
  assert.ok(html2.includes('Converted from a Boeing 737-800'), 'where it came from');
  assert.ok(!html2.includes('Convert to freighter ·'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
