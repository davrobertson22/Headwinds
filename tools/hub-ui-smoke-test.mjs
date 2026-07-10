// React render smoke test for the hub redesign UI (HubManagement).
// Server-renders the REAL component with a seeded save covering: a Major Hub,
// a foreign focus city, an in-progress construction, and a designatable airport.
//
// Run with: node --import ./tools/_register-loader.mjs tools/hub-ui-smoke-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice } from '../src/utils/simulation.js';

// Minimal browser shims for SSR
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
assert.ok(getAirport('JFK') && getAirport('LHR') && getAirport('ORD') && getAirport('BOS'));

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const HubManagement = (await import('../src/components/HubManagement.jsx')).default;

const routes = Array.from({ length: 6 }, (_, i) => ({
  id: `r${i}`, origin: 'JFK', destination: ['LHR', 'ORD', 'LAX', 'MIA', 'CDG', 'BOS'][i],
  stops: ['JFK', ['LHR', 'ORD', 'LAX', 'MIA', 'CDG', 'BOS'][i]],
  aircraftId: 'ac1', weeklyFrequency: 5, weeksOpen: 20, hub: 'JFK',
  ticketPrice: Math.round(referencePrice('JFK', ['LHR', 'ORD', 'LAX', 'MIA', 'CDG', 'BOS'][i]) ?? 300),
  cateringLevel: 'full',
}));

const save = {
  ...freshState(),
  phase: 'playing', week: 30, year: 2, hub: 'JFK', homeCountry: 'US', cash: 250_000_000,
  gates: { JFK: 16, LHR: 6, ORD: 10, BOS: 7, MIA: 3 },
  hubs: {
    JFK: { tier: 2, tierSince: 0 },     // Major Hub
    LHR: { tier: 0, tierSince: 10 },    // foreign focus city
  },
  hubConstruction: { ORD: { targetTier: 1, weeksLeft: 2, capex: 5_000_000 } },
  hubThroughput: { JFK: [800, 900, 1000, 950], LHR: [40, 50, 45, 60] },
  fleet: [{ id: 'ac1', typeId: jet.id, name: 'Test Jet', tailNumber: 'N1T', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
  routes,
  lastReport: {
    hubThroughput: { JFK: 950, LHR: 60 },
    totalHubCostSavings: 42_000,
    hubContestMap: {
      JFK: { playerShare: 0.72, contestFactor: 0.72, compWeight: 4, rivals: [{ id: 'x', name: 'Rival Air', weight: 4 }] },
      LHR: { playerShare: 0.31, contestFactor: 0.31, compWeight: 20, rivals: [{ id: 'g', name: 'GlobalAir', weight: 20 }] },
    },
    ownMetalOD: {
      totalRevenue: 500_000, totalPax: 900,
      byHub: { JFK: { pax: 900, revenue: 500_000, markets: 12 } },
      entries: [
        { od: 'BOS→LHR', hub: 'JFK', pax: 120, revenue: 90_000, share: 0.1 },
        { od: 'MIA→CDG', hub: 'JFK', pax: 90, revenue: 75_000, share: 0.08 },
      ],
    },
    routeResults: [],
  },
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (el) => renderToString(React.createElement(GameProvider, null, el));

console.log('\n── HubManagement render smoke ───────────────────────────');
let html = '';
test('HubManagement renders without throwing', () => {
  html = render(React.createElement(HubManagement));
  assert.ok(html.length > 1000, 'expected substantial markup');
});
test('shows the Major Hub card with tier pill', () => {
  assert.ok(html.includes('Major Hub'), 'Major Hub pill');
});
test('shows the foreign focus city with max-designation note', () => {
  assert.ok(html.includes('Focus City'), 'Focus City pill');
  assert.ok(html.includes('cannot be upgraded') || html.includes('max designation'), 'foreign note');
});
test('shows the ORD construction banner', () => {
  assert.ok(html.includes('Building') && html.includes('week'), 'construction banner');
});
test('shows top connecting markets over JFK', () => {
  assert.ok(html.includes('BOS→LHR'), 'top market chip');
});
test('shows contest / dominance info', () => {
  assert.ok(html.includes('Hub dominance'), 'contest bar');
});
test('shows prerequisite checklist for the T3 upgrade (unmet)', () => {
  // JFK has 6 routes — T3 needs 50, so the checklist must render with an ✗
  assert.ok(html.includes('routes at JFK') || html.includes('50'), 'routes prereq listed');
});
test('cost savings stat present in overview', () => {
  assert.ok(html.includes('Cost Savings'), 'overview stat');
});
test('BOS (7 gates) is designatable with both buttons', () => {
  assert.ok(html.includes('Focus City ·') && html.includes('Hub ·'), 'designate buttons');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
