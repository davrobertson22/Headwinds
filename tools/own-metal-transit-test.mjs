// Own-metal transit reporting — every designated hub that actually carried
// connecting passengers must be able to SHOW them.
//
// The report trims ownMetalOD.entries for state size. A GLOBAL top-N trim sorted
// by revenue starves secondary hubs: a long-haul hub's markets outrank every
// market at a domestic hub, so the domestic hub keeps thousands of pax in
// byHub while owning zero entries — and AirportDetail, which reads entries,
// tells the player "No passengers connected over DEN last week".
//
// Run with: node --import ./tools/_register-loader.mjs tools/own-metal-transit-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { weeklyTick, defaultConfig, defaultClassPrices, referencePrice } from '../src/utils/simulation.js';
import { getAircraftType, AIRCRAFT_TYPES } from '../src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// ── 1. Engine: a secondary hub keeps its own itineraries ─────────────────────
console.log('\n── ownMetalOD.entries retention ─────────');

const wide   = getAircraftType('b7879');
const narrow = getAircraftType('a320neo');
let n = 0;
const mkAc = (t) => ({
  id: `a${n++}`, typeId: t.id, status: 'assigned', ageWeeks: 52,
  config: defaultConfig(t.seats), ownershipType: 'owned',
});

const fleet = [], routes = [], routePricing = {}, gates = {};
function addHub(code, spokes, tier, gateCount, freq, type) {
  gates[code] = gateCount;
  for (const s of spokes) {
    const ac = mkAc(type);
    fleet.push(ac);
    routes.push({ id: `r${routes.length}`, origin: code, destination: s, aircraftId: ac.id, weeklyFrequency: freq });
    routePricing[[code, s].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(code, s) * 1.4));
    gates[s] = (gates[s] ?? 0) + 2;
  }
  return { [code]: { tier, tierSince: 0 } };
}

// A long-haul mega-hub (high revenue per market) plus a busy regional hub whose
// markets are individually small — the shape that loses a global top-N race.
const hubs = {
  ...addHub('DXB', ['LHR','JFK','SIN','BKK','BOM','DEL','FRA','CDG','IST','HKG','SYD','NRT','LAX','ORD','MAD','FCO','ICN','PEK','JNB','GRU'], 3, 40, 10, wide),
  ...addHub('DEN', ['SLC','PHX','OMA','BOI','TUS','ABQ','MCI','OKC','SAT','MSY','PDX','SMF','RNO','ELP'], 2, 25, 28, narrow),
};

const report = weeklyTick({
  fleet, routes, cargoRoutes: [], gameDate: { week: 1, month: 6 },
  gates, hubs, routePricing, routeCatering: {}, competitors: [], labor: undefined,
});
const om = report.ownMetalOD ?? {};
const entries = om.entries ?? [];
const entriesFor = (code) => entries.filter(e => e.hub === code);

test('both hubs carry own-metal connecting pax', () => {
  assert.ok((om.byHub?.DXB?.pax ?? 0) > 0, 'DXB byHub pax');
  assert.ok((om.byHub?.DEN?.pax ?? 0) > 0, 'DEN byHub pax');
});
test('the mega-hub shows itineraries', () => {
  assert.ok(entriesFor('DXB').length > 0, 'DXB entries');
});
test('the secondary hub is NOT trimmed to zero itineraries', () => {
  assert.ok(entriesFor('DEN').length > 0,
    `DEN carried ${(om.byHub?.DEN?.pax ?? 0)} pax across ${(om.byHub?.DEN?.markets ?? 0)} markets but kept 0 of ${entries.length} entries`);
});
test('every hub with pax keeps enough entries for the UI lists', () => {
  for (const [code, h] of Object.entries(om.byHub ?? {})) {
    if ((h?.pax ?? 0) <= 0) continue;
    const kept = entriesFor(code).length;
    assert.ok(kept >= Math.min(5, h.markets ?? 0), `${code}: kept ${kept} of ${h.markets} markets`);
  }
});
test('entries stay bounded (state size)', () => {
  assert.ok(entries.length <= 160, `entries = ${entries.length}`);
});
test('entries stay sorted by revenue', () => {
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i - 1].revenue >= entries[i].revenue, `out of order at ${i}`);
  }
});

// ── 2. UI: AirportDetail must not deny traffic byHub reports ─────────────────
console.log('\n── AirportDetail transit card ───────────');

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AirportDetail = (await import('../src/components/AirportDetail.jsx')).default;

const denSpokes = ['SLC', 'PHX', 'OMA', 'BOI', 'TUS', 'ABQ'];
const uiSave = {
  ...freshState(),
  phase: 'playing', week: 30, year: 2, hub: 'DEN', homeCountry: 'US', cash: 250_000_000,
  gates: { DEN: 18, ...Object.fromEntries(denSpokes.map(s => [s, 2])) },
  hubs: { DEN: { tier: 2, tierSince: 0 } },
  fleet: [{ id: 'ac1', typeId: jet.id, name: 'T', tailNumber: 'N1T', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: defaultConfig(jet.seats) }],
  routes: denSpokes.map((s, i) => ({
    id: `r${i}`, origin: 'DEN', destination: s, stops: ['DEN', s], aircraftId: 'ac1',
    weeklyFrequency: 14, weeksOpen: 20, hub: 'DEN',
    ticketPrice: Math.round(referencePrice('DEN', s) ?? 200), cateringLevel: 'full',
  })),
  lastReport: {
    hubThroughput: { DEN: 1554 },
    // The shape this bug produces: real pax in byHub, no entries kept for DEN.
    ownMetalOD: {
      totalRevenue: 900_000, totalPax: 9_273,
      byHub: { DEN: { pax: 1483, revenue: 210_000, markets: 63 } },
      entries: [{ od: 'LHR→SIN', hub: 'DXB', pax: 300, revenue: 400_000, share: 0.1 }],
    },
    routeResults: [],
  },
};
store.set('bbae_save_v2', JSON.stringify(uiSave));

let html = '';
test('AirportDetail renders', () => {
  html = renderToString(React.createElement(GameProvider, null,
    React.createElement(AirportDetail, { code: 'DEN', onBack: () => {} })));
  assert.ok(html.length > 1000, 'expected substantial markup');
});
test('does not claim zero transit when byHub reports pax', () => {
  // The code is rendered in its own span, so match the sentence's fixed half.
  assert.ok(!html.includes('No passengers connected over'),
    'card denies traffic that ownMetalOD.byHub says it carried');
});
test('reports the hub pax figure byHub carries', () => {
  assert.ok(html.includes('1,483'), 'expected the byHub pax total on the card');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
