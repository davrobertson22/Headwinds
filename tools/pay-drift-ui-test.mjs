// The pay drift must be visible on the staff card, with the number the tick
// will actually reach.
//
// Pay above 1.0× erodes ~6% a year toward market (labor.js erodePayPremium) —
// including a rate the player set by hand. A slider that moves on its own with
// no explanation reads as a bug, and its knock-on (morale following pay down)
// reads as a worse one. So the card says where this group's pay will be in a
// year, computed by the same function the weekly tick runs.
//
//   node --import ./tools/_register-loader.mjs tools/pay-drift-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations = (await import('../src/components/Operations.jsx')).default;
const { DEFAULT_LABOR_STATE, erodePayPremium } = await import('../src/data/labor.js');
const { getAircraftType } = await import('../src/data/aircraft.js');
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
function seed(pilotPay, extra = {}) {
  const labor = { ...DEFAULT_LABOR_STATE, pilots: { ...DEFAULT_LABOR_STATE.pilots, payMultiplier: pilotPay, ...extra } };
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 4e8, gates: { JFK: 8 },
    fleet: [{ id: 'a1', typeId: NB.id, status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats } }],
    routes: [], labor,
  }));
}

console.log('\n── Pay drift on the staff card ─────────────────────────');

test('pay above market shows where it will be in a year — the tick\'s own number', () => {
  seed(1.5);
  const html = render(React.createElement(Operations));
  const expected = erodePayPremium(1.5, 52).toFixed(2);
  assert.ok(html.includes(`1.50× → about ${expected}× in a year`), `expected "1.50× → about ${expected}× in a year"`);
  assert.ok(html.includes('Hold this rate'), 'must offer the lock that stops it');
});

test('a held (indexed) group shows the lock ticked and no drift note', () => {
  seed(1.5, { indexed: true });
  const html = render(React.createElement(Operations));
  assert.ok(!html.includes('Market catching up'), 'no drift note for a held rate');
  // The pilots card comes first; its lock is the first one on the page.
  assert.ok(/<input type="checkbox" checked=""\/>🔒 Hold this rate/.test(html), 'pilot lock shows as ticked');
  seed(1.5);
  assert.ok(!/<input type="checkbox" checked=""\/>🔒 Hold this rate/.test(render(React.createElement(Operations))), 'and unticked when not held');
});

test('a year of weekly ticks lands where the card said', () => {
  let p = 1.5;
  for (let w = 0; w < 52; w++) p = erodePayPremium(p);
  assert.ok(Math.abs(p - erodePayPremium(1.5, 52)) < 0.005, `${p} vs ${erodePayPremium(1.5, 52)}`);
});

test('pay at market shows no drift note', () => {
  seed(1.0);
  const html = render(React.createElement(Operations));
  assert.ok(!html.includes('Market catching up'));
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
