// Fleet renewal screens — SSR-rendered against a seeded save, so the real
// components (not just the engine helpers) are checked for agreement with
// replacementCompatibility. See tools/fleet-renewal-test.mjs for the engine.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-renewal-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

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
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('test bodies must be synchronous');
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Fleet = (await import('../src/components/Fleet.jsx')).default;
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;
const R = await import('../src/components/FleetRenewal.jsx').catch(() => ({}));
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');
const need = (k) => assert.ok(R[k], `FleetRenewal.jsx does not export ${k}`);

const tail = (id, name, typeId, extra = {}) => ({
  id, typeId, name, tailNumber: id.toUpperCase(), status: 'assigned', ageWeeks: 1400,
  ownershipType: 'owned', config: { economy: 150 }, ...extra,
});
const route = (id, aircraftId, o, d) => ({
  id, origin: o, destination: d, aircraftId, weeklyFrequency: 7, weeksOpen: 40,
  hub: 'JFK', ticketPrice: 240, cateringLevel: 'full', stops: [o, d],
});

function seed(extra = {}) {
  const save = {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 900_000_000,
    gates: { JFK: 20, BOS: 10, LAX: 10 },
    fleet: [
      tail('o1', 'Old Bird 1', 'a320ceo'),
      tail('o2', 'Old Bird 2', 'a320ceo', { ageWeeks: 1600 }),
      tail('w1', 'Fresh One', 'a321neo', { status: 'idle', ageWeeks: 0,
        replacing: { aircraftId: 'o2', name: 'Old Bird 2', disposal: 'dispose', waiting: 'Old Bird 2 is grounded' } }),
    ],
    routes: [route('r1', 'o1', 'JFK', 'BOS'), route('r2', 'o2', 'JFK', 'LAX')],
    pendingOrders: [{
      id: 'ord1', typeId: 'a321neo', ownershipType: 'owned', name: 'A321neo #7',
      deliverAbsWeek: 52 + 20 + 6, totalPrice: 1, leaseDeposit: 0, weeklyLease: 0,
      orderedWeek: 19, orderedYear: 2, fuelMod: 1, rangeMod: 1, maintMod: 1,
      replacesAircraftId: 'o1', replacesName: 'Old Bird 1', replaceDisposal: 'dispose',
    }],
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

const OLD_ONLY = [tail('o1', 'Old Bird 1', 'a320ceo'), tail('o2', 'Old Bird 2', 'a320ceo', { ageWeeks: 1600 })];

console.log('\n── Fleet renewal screens ─────────────────────────────');

test('an order in the queue says what it replaces and what happens to it', () => {
  need('OrderReplacementLine');
  const s = seed();
  const html = render(React.createElement(R.OrderReplacementLine, { order: s.pendingOrders[0] }));
  assert.match(html, /Replaces Old Bird 1/);
  assert.match(html, /sell/);
  assert.match(html, /Change/);
});

test('an order with no replacement offers to pick one', () => {
  need('OrderReplacementLine');
  const s = seed();
  const { replacesAircraftId, replacesName, replaceDisposal, ...plain } = s.pendingOrders[0];
  const html = render(React.createElement(R.OrderReplacementLine, { order: plain }));
  assert.match(html, /Replace an aircraft/);
});

test('the Fleet list marks both ends of a replacement', () => {
  seed();
  const html = render(React.createElement(Fleet));
  assert.match(html, /being replaced/, 'the old tail with an incoming replacement');
  assert.match(html, /replacing Old Bird 2/, 'the delivered tail still waiting');
});

test('the detail notice explains a wait and offers to stop it', () => {
  need('RenewalNotice');
  const s = seed();
  const html = render(React.createElement(R.RenewalNotice, { aircraft: s.fleet[2] }));
  assert.match(html, /Waiting to replace Old Bird 2/);
  assert.match(html, /grounded/);
  assert.match(html, /Stop waiting/);
});

test('the order form opens on the preset replacements, oldest first, with delivery timing', () => {
  seed({ pendingOrders: [], fleet: OLD_ONLY });
  const html = render(React.createElement(AircraftCheckout, {
    typeId: 'a321neo', mode: 'buy', replaceIds: ['o1', 'o2'], onClose() {},
  }));
  assert.match(html, /Replaces existing aircraft/);
  assert.match(html, /2 selected/);
  const i2 = html.indexOf('Old Bird 2'), i1 = html.indexOf('Old Bird 1');
  assert.ok(i2 > 0 && i1 > 0 && i2 < i1, 'the oldest tail is listed (and swapped) first');
  assert.match(html, /swapped in \d+w/);
  assert.match(html, /Sold \/ returned/);
});

test('the order form greys out a tail the type cannot fly, with the engine reason', () => {
  seed({ pendingOrders: [], fleet: OLD_ONLY });
  const html = render(React.createElement(AircraftCheckout, {
    typeId: 'atr72', mode: 'buy', replaceIds: ['o2'], onClose() {},
  }));
  assert.match(html, /Out of range: JFK–LAX/);
});

test('bulk replace lists types that fit and says how many', () => {
  need('BulkReplaceModal');
  seed({ pendingOrders: [], fleet: OLD_ONLY });
  const html = render(React.createElement(R.BulkReplaceModal, { aircraftIds: ['o1', 'o2'], onClose() {} }));
  assert.match(html, /Replace 2 aircraft/);
  assert.match(html, /Fits 2 of 2/);
  assert.match(html, /Buy 2/);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const atr = text.indexOf('ATR 72-600');
  assert.ok(atr > 0, 'a type that fits some of the selection is still offered');
  assert.match(text.slice(atr, atr + 200), /Fits 1 of 2/, 'an ATR can take JFK–BOS but not JFK–LAX');
  assert.ok(text.lastIndexOf('Fits 2 of 2') < atr, 'types that fit everything are listed first');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
