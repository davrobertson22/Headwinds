// SSR-renders the real Fleet page and aircraft card for lease auto-renew:
// the rule panel, the extend-all button on the expiring chip, the per-tail
// opt-out, and that a covered lease is not counted as expiring.
//
//   node --import ./tools/_register-loader.mjs tools/lease-auto-renew-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';

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
const FleetMod = await import('../src/components/Fleet.jsx');
const Fleet = FleetMod.default;
const { AircraftDetail } = FleetMod;

const JET = AIRCRAFT_TYPES.find(t => !t.freighter && t.range > 4000 && t.seats > 100 && t.seats < 200);
const leased = (id, remaining, extra = {}) => ({
  id, typeId: JET.id, name: id, tailNumber: id.toUpperCase(), status: 'idle', ageWeeks: 52,
  ownershipType: 'lease', weeklyLease: 50_000, leaseDeposit: 0, leaseTermWeeks: 104,
  leaseRemainingWeeks: remaining, config: { economy: JET.seats }, ...extra,
});

const save = (extra) => ({
  ...freshState(),
  phase: 'playing', week: 20, year: 3, hub: 'JFK', cash: 200_000_000, homeCountry: 'US',
  gates: { JFK: 20 }, hubs: { JFK: { tier: 1 } }, routes: [], cargoRoutes: [],
  ...extra,
});
const strip = (h) => h.replace(/<!-- -->/g, '');
const renderWith = (s, el) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return strip(renderToString(React.createElement(GameProvider, null, el)));
};

test('rule off: the panel says leases will go back, and extend-all counts the 24-week window', () => {
  const s = save({ weeksPerDay: 24, fleet: [leased('a', 6), leased('b', 20), leased('c', 60)] });
  const html = renderWith(s, React.createElement(Fleet));
  assert.ok(html.includes('Auto-renew leases'), 'no auto-renew panel');
  assert.ok(/will go back/.test(html), 'off-state explanation missing');
  assert.ok(html.includes('Extend all 2 expiring'), 'extend-all should count a and b (both within 24 weeks)');
});

test('rule on: covered leases are not "expiring"; an opted-out one still is', () => {
  const s = save({ weeksPerDay: 24, leaseAutoRenew: { enabled: true, addWeeks: 104 },
    fleet: [leased('a', 6), leased('b', 20, { leaseAutoRenewOff: true }), leased('c', 60)] });
  const html = renderWith(s, React.createElement(Fleet));
  assert.ok(html.includes('Extend all 1 expiring'), 'only the let-expire tail is at risk');
  assert.ok(html.includes('1 tail marked “let expire”'));
  assert.ok(/<option[^>]*value="104"[^>]*selected/.test(html) || /value="104"/.test(html));
});

test('the aircraft card offers the per-tail toggle', () => {
  const on  = save({ leaseAutoRenew: { enabled: true, addWeeks: 52 }, fleet: [leased('a', 30)] });
  const off = save({ fleet: [leased('a', 30)] });
  const a = on.fleet[0];
  assert.ok(renderWith(on, React.createElement(AircraftDetail, { aircraft: a, onClose(){}, onConfigure(){}, onRetire(){}, onSell(){} })).includes('Auto-renew'));
  assert.ok(renderWith(off, React.createElement(AircraftDetail, { aircraft: a, onClose(){}, onConfigure(){}, onRetire(){}, onSell(){} })).includes('off airline-wide'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
