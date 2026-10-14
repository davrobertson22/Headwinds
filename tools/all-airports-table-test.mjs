// Airports → All airports: every airport in one sortable, paged table.
// Ported from Tailwinds, plus the Headwinds gate-scarcity column and denials.
//
// Discord, 2026-10-12 (VodkaOnFire): "In gates, you can only see your own gates
// and/or search for any airport, name or country. But you can't sort ALL
// airports by PAX or anything like that, which is what I'd like." Plus number
// of airlines operating there and the longest runway.
//
//   node --import ./tools/_register-loader.mjs tools/all-airports-table-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ??= { localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {}, innerWidth: 1200 };
globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Airports = (await import('../src/components/Airports.jsx')).default;
const {
  loadAirportMarkets, airlinesByAirport, sortAllAirportRows, ALL_AIRPORTS_PAGE_SIZE,
} = await import('../src/components/AllAirportsTable.jsx');
const { AIRPORTS } = await import('../src/data/airports.js');
const { airportMarketNow } = await import('../src/utils/airportMarket.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const clean = (html) => html.replace(/<!-- -->/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const base = (over = {}) => ({
  ...freshState(), phase: 'playing', week: 1, year: 1, cash: 40_000_000, hub: 'JFK', airlineName: 'Test Air',
  routes: [], cargoRoutes: [], competitors: [], fleet: [], pendingOrders: [], objectives: [],
  objectivesEnabled: false, gates: { JFK: 3 }, ...over,
});
function render(save, view = 'all') {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  if (view) store.set('airports_browse_view', view);
  return clean(renderToString(React.createElement(GameProvider, null, React.createElement(Airports))));
}
const rowCodes = (html) => [...html.matchAll(/data-airport="([^"]+)"/g)].map(m => m[1]);
const rowHtml = (html, code) => {
  const i = html.indexOf(`data-airport="${code}"`);
  assert.notEqual(i, -1, `${code} row not rendered`);
  return html.slice(i, html.indexOf('</tr>', i));
};

const table = await loadAirportMarkets();   // the screen loads it on demand; SSR needs it ready

console.log('\nAirports → All airports\n');

section('1. Who flies where');

test('player routes count at every stop; competitors at both ends; each airline once', () => {
  const st = base({
    routes: [{ id: 'r1', origin: 'JFK', destination: 'ORY', stops: ['MCI', 'JFK', 'ORY'] },
             { id: 'r2', origin: 'JFK', destination: 'LHR' }],
    cargoRoutes: [{ id: 'c1', origin: 'MEM', destination: 'ANC' }],
    competitors: [{ id: 'aa', name: 'Rival One', routes: { 'JFK-LHR': {}, 'JFK-CDG': {} } },
                  { id: 'bb', name: 'Rival Two', routes: { 'LHR-CDG': {} } }],
  });
  const m = airlinesByAirport(st);
  assert.deepEqual(m.get('JFK').map(a => a.id).sort(), ['aa', 'player']);
  assert.deepEqual(m.get('MCI').map(a => a.id), ['player']);
  assert.deepEqual(m.get('LHR').map(a => a.id).sort(), ['aa', 'bb', 'player']);
  assert.deepEqual(m.get('ANC').map(a => a.id), ['player']);
  assert.equal(m.get('SYD'), undefined);
});

section('2. Sorting');

test('sorting by any column is stable and reversible', () => {
  const rows = [{ code: 'A', pax: 5 }, { code: 'B', pax: 5 }, { code: 'C', pax: 50 }];
  assert.deepEqual(sortAllAirportRows(rows, 'pax', 'desc').map(r => r.code), ['C', 'B', 'A']);
  assert.deepEqual(sortAllAirportRows(rows, 'pax', 'asc').map(r => r.code), ['A', 'B', 'C']);
});

section('3. The screen');

test('"By region" is still the default, and the toggle is offered', () => {
  const html = render(base(), null);
  assert.match(html, /Select a region to browse airports/);
  assert.match(html, /data-browse-view="all"/);
  assert.doesNotMatch(html, /data-all-airports=""/);
});

test('All airports: page one is the 50 biggest passenger markets, of every airport', () => {
  const html = render(base());
  const codes = rowCodes(html);
  assert.equal(codes.length, ALL_AIRPORTS_PAGE_SIZE);
  const ranked = AIRPORTS
    .map(a => [a.code, airportMarketNow(a.code, table.AIRPORT_MARKETS[a.code], table.GROWTH_BUCKETS, { absWeek: 1 }).pax])
    .sort((x, y) => (y[1] - x[1]) || y[0].localeCompare(x[0]))
    .slice(0, ALL_AIRPORTS_PAGE_SIZE).map(([c]) => c);
  assert.deepEqual(codes, ranked);
  assert.match(html, new RegExp(`1–50 of ${AIRPORTS.length.toLocaleString()}`));
});

test('a row shows runway, metro, airlines and your gates', () => {
  const html = render(base({
    gates: { JFK: 3, LHR: 2 },
    fleet: [{ id: 'ac1', typeId: 'b7879', name: 'One', tailNumber: 'N1TEST', status: 'assigned',
      ageWeeks: 52, ownershipType: 'owned', config: { economy: 420 } }],
    routes: [{ id: 'r2', origin: 'JFK', destination: 'LHR', stops: ['JFK', 'LHR'], aircraftId: 'ac1',
      weeklyFrequency: 7, weeksOpen: 40, hub: 'JFK', ticketPrice: 600 }],
    competitors: [{ id: 'aa', name: 'Rival One', routes: { 'JFK-LHR': {} } }],
  }));
  const jfk = rowHtml(html, 'JFK');
  assert.match(jfk, /14,511 ft/);
  assert.match(jfk, />20\.1M</, 'metro population');
  assert.match(jfk, /title="Test Air, Rival One"[^>]*>2/);
  assert.match(jfk, />3</, 'your 3 gates at JFK');
});

test('the market column follows the calendar: a 1960 world shows far smaller markets', () => {
  const now = rowHtml(render(base()), 'LHR');
  const era = rowHtml(render(base({ startYear: 1960 })), 'LHR');
  const pax = (h) => h.match(/font-weight:600">([\d.]+[KM]?)</)[1];
  const val = (s) => parseFloat(s) * (s.endsWith('M') ? 1e6 : s.endsWith('K') ? 1e3 : 1);
  assert.ok(val(pax(era)) < val(pax(now)) / 3, `1960 ${pax(era)} vs today ${pax(now)}`);
});

section('4. Headwinds: gate scarcity');

test('classic worlds have no "Gates taken" column', () => {
  assert.doesNotMatch(render(base()), />Gates taken/);
});

test('scarcity world: a sold-out airport reads FULL and its + button is refused, with the reason', () => {
  const html = render(base({
    gateScarcityWorld: true,
    gateMarket: { airports: { LHR: { capacity: 120, taken: 120 } } },
  }));
  assert.match(html, />Gates taken/);
  const lhr = rowHtml(html, 'LHR');
  assert.match(lhr, /120\/120 taken/);
  assert.match(lhr, />FULL</);
  assert.match(lhr, /<span title="[^"]+"[^>]*cursor:not-allowed[^>]*><button[^>]*disabled=""/, 'the + is disabled under a hover reason');
  const nrt = rowHtml(html, 'NRT');
  assert.doesNotMatch(nrt, /disabled=""/, 'an airport with free gates stays leasable');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
