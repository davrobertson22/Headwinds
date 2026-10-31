// The stored weekly report must not carry every partner-fed itinerary.
//
// 2026-10-23: Ajax Air (Time Flies) stored 22,955 lastReport.partnerODRevenue
// entries — 5.7 MB of a 15 MB save. Its decisions took 8-20 s (every one reads
// and rewrites the whole blob) and kept reaching the 20 s transaction timeout
// whose failed rollback crashed the API 11 times (tools/db-rejection-crash-test.mjs).
// The only reader of the stored entries is AirportDetail's per-hub pax sum, so
// the tick now folds them to one per hub at the blob write.
//
// Run with: node --import ./tools/_register-loader.mjs tools/partner-od-storage-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { compactReportForStorage, foldPartnerEntries } from '../apps/headwinds-server/src/lib/reportStorage.mjs';
import { defaultConfig, referencePrice } from '../src/utils/simulation.js';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Entries in the shape production stores (one copied from Ajax Air, 2026-10-23),
// spread over a few hubs, plus a hub-less legacy row.
const HUBS = ['JFK', 'LAX', 'ATL', 'DEN'];
const entries = [];
for (let i = 0; i < 4000; i++) {
  entries.push({
    hub: HUBS[i % HUBS.length], pax: (i % 7) + 0.25 * (i % 3), dest: 'TLV', odKey: `X${i}-TLV`, origin: `X${i}`,
    partnerLeg: i % 2 ? 'leg1' : 'leg2', totalMileage: 7032, capacityScale: 0.456, capturedShare: 0.0072,
    playerRevenue: 3654 + i, partnershipType: 'alliance', playerLegMileage: 9117,
  });
}
entries.push({ pax: 5, playerRevenue: 100, origin: null, dest: null, hub: null });
const totalPax = entries.reduce((s, e) => s + e.pax, 0);
const totalRevenue = entries.reduce((s, e) => s + e.playerRevenue, 0);
const state = {
  cash: 1, routes: [{ id: 'r1' }],
  lastReport: { totalRevenue: 9, partnerODRevenue: { totalRevenue, totalPax, entries }, routeResults: [{ id: 'r1' }] },
};
// What AirportDetail computes from whatever is stored.
const screenSum = (report, code) => (report?.partnerODRevenue?.entries ?? [])
  .filter(e => e.hub === code).reduce((s, e) => s + (e.pax ?? 0), 0);

console.log('\nStored partner O&D report\n');

const stored = compactReportForStorage(state);

test('one entry per hub is stored instead of one per itinerary', () => {
  assert.equal(stored.lastReport.partnerODRevenue.entries.length, HUBS.length);
  const before = JSON.stringify(state.lastReport.partnerODRevenue).length;
  const after = JSON.stringify(stored.lastReport.partnerODRevenue).length;
  assert.ok(after * 100 < before, `${before} → ${after} bytes`);
});
test('every hub sums to the same pax the screen showed before', () => {
  for (const h of HUBS) assert.equal(screenSum(stored.lastReport, h), screenSum(state.lastReport, h), h);
});
test('report totals and everything else in the state are untouched', () => {
  assert.equal(stored.lastReport.partnerODRevenue.totalPax, totalPax);
  assert.equal(stored.lastReport.partnerODRevenue.totalRevenue, totalRevenue);
  assert.equal(stored.lastReport.routeResults, state.lastReport.routeResults);
  assert.equal(stored.routes, state.routes);
  assert.equal(state.lastReport.partnerODRevenue.entries.length, entries.length, 'input not mutated');
});
test('nothing to fold returns the same object; folding twice is a no-op', () => {
  const bare = { cash: 1, lastReport: null };
  assert.equal(compactReportForStorage(bare), bare);
  assert.equal(compactReportForStorage(stored), stored);
  assert.deepEqual(foldPartnerEntries(stored.lastReport.partnerODRevenue.entries), stored.lastReport.partnerODRevenue.entries);
});
test('the tick folds the report before every airline blob write', () => {
  const src = read('../apps/headwinds-server/src/lib/tickService.mjs');
  assert.match(src, /splitLogo\(compactReportForStorage\(stripRivals\(c\.next\)\)\)\.state/);
});

// ── The screen that reads it, rendered for real ─────────────────────────────
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AirportDetail = (await import('../src/components/AirportDetail.jsx')).default;
const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const spokes = ['SLC', 'PHX', 'OMA'];
function render(report) {
  const save = {
    ...freshState(),
    phase: 'playing', week: 30, year: 2, hub: 'DEN', homeCountry: 'US', cash: 250_000_000,
    gates: { DEN: 18, ...Object.fromEntries(spokes.map(s => [s, 2])) },
    hubs: { DEN: { tier: 2, tierSince: 0 } },
    fleet: [{ id: 'ac1', typeId: jet.id, name: 'T', tailNumber: 'N1T', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: defaultConfig(jet.seats) }],
    routes: spokes.map((s, i) => ({
      id: `r${i}`, origin: 'DEN', destination: s, stops: ['DEN', s], aircraftId: 'ac1', weeklyFrequency: 14, weeksOpen: 20, hub: 'DEN',
      ticketPrice: Math.round(referencePrice('DEN', s) ?? 200), cateringLevel: 'full',
    })),
    lastReport: {
      ...report, hubThroughput: { DEN: 1554 }, routeResults: [],
      ownMetalOD: { totalRevenue: 210_000, totalPax: 1483, byHub: { DEN: { pax: 1483, revenue: 210_000, markets: 3 } },
        entries: [{ od: 'SLC→PHX', hub: 'DEN', pax: 1483, revenue: 210_000, share: 0.1 }] },
    },
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null, React.createElement(AirportDetail, { code: 'DEN', onBack: () => {} })));
}
const partnerLine = (html) => (html.match(/\+(?:<!-- -->)?([\d,.]+)(?:<!-- -->)?\s*pax\/wk via partner-fed connections/) ?? [])[1] ?? null;

test('AirportDetail shows the same partner-fed pax from the stored (folded) report', () => {
  const full = render({ partnerODRevenue: { totalRevenue, totalPax, entries } });
  const folded = render({ partnerODRevenue: stored.lastReport.partnerODRevenue });
  assert.ok(partnerLine(full), "the full report renders a partner-fed line for DEN");
  assert.equal(partnerLine(folded), partnerLine(full));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
