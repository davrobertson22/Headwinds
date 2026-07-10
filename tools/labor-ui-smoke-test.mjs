// React render smoke test for the labor-relations UI (strikes + negotiations).
//
// Server-renders the REAL Operations page with a seeded save that has an
// active strike, an open contract negotiation, and per-group unrest — catching
// render-time crashes in the new banners/bars that node logic suites can't.
//
//   node --import ./tools/_register-loader.mjs tools/labor-ui-smoke-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';

// Minimal browser shims for SSR.
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
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const P = ['JFK', 'ORD'].find(c => getAirport(c));

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { DEFAULT_LABOR_RELATIONS } = await import('../src/data/laborRelations.js');
const Operations = (await import('../src/components/Operations.jsx')).default;

const baseSave = {
  ...freshState(),
  phase: 'playing', week: 30, year: 2, hub: P, cash: 5_000_000,
  fleet: [{ id: 'ac1', typeId: jet.id, name: 'Spirit of Test', tailNumber: 'N1TEST', status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
  labor: {
    pilots:          { payMultiplier: 0.7, morale: 35 },
    cabinCrew:       { payMultiplier: 1.0, morale: 80 },
    groundStaff:     { payMultiplier: 1.0, morale: 80 },
    maintenanceTeam: { payMultiplier: 1.0, morale: 80 },
  },
};

const render = (save, el) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null, el));
};

console.log('\n── Operations page: labor relations UI ──────────────────');

test('renders with default (calm) labor relations', () => {
  const html = render(baseSave, React.createElement(Operations));
  assert.ok(html.includes('Labor Groups'), 'labor section present');
  assert.ok(!html.includes('picket line'), 'no strike banner when calm');
});

test('renders the strike banner + settle button during a walkout', () => {
  const html = render({
    ...baseSave,
    laborRelations: {
      ...DEFAULT_LABOR_RELATIONS,
      strike: { group: 'pilots', weeksLeft: 2, totalWeeks: 2, severity: 0.55 },
      unrest: { ...DEFAULT_LABOR_RELATIONS.unrest, pilots: 80 },
    },
  }, React.createElement(Operations));
  assert.ok(html.includes('STRIKE'), 'strike banner present');
  assert.ok(html.includes('Settle'), 'settle button present');
  assert.ok(html.includes('Union unrest'), 'unrest bar shown');
});

test('renders the negotiation banner with all three responses', () => {
  const html = render({
    ...baseSave,
    laborRelations: {
      ...DEFAULT_LABOR_RELATIONS,
      negotiation: { group: 'pilots', demandMultiplier: 1.2, weeksLeft: 3, totalWeeks: 4 },
    },
  }, React.createElement(Operations));
  assert.ok(html.includes('Contract talks'), 'negotiation banner present');
  assert.ok(html.includes('Accept'), 'accept option');
  assert.ok(html.includes('Counter'), 'counter option');
  assert.ok(html.includes('Refuse'), 'refuse option');
});

test('renders the last-outcome note after a recent resolution', () => {
  const html = render({
    ...baseSave,
    laborRelations: {
      ...DEFAULT_LABOR_RELATIONS,
      lastOutcome: { group: 'pilots', outcome: 'counterRejected', newPay: 1.1, demand: 1.2, absWeek: (2 - 1) * 52 + 29 },
    },
  }, React.createElement(Operations));
  assert.ok(html.includes('Last contract round'), 'outcome note present');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
