// ─────────────────────────────────────────────────────────────────────────────
// FINANCE ▸ STATISTICS MUST NOT COUNT CARGO TWICE.
//
// report.totalRevenue is the airline's GRAND TOTAL operating revenue: the
// simulator adds every cargo route's revenue into it inside the freight loop
// (packages/engine/src/utils/simulation.js — `totalRevenue += result.revenue`
// in the cargo block) and then returns `totalRevenue + totalPartnerRevenue`.
// totalCargoRevenue is a BREAKDOWN of that same money, not an addition to it —
// the P&L card says so in as many words ("already inside totRev").
//
// The per-week KPI record that drives Finance ▸ Statistics added the two
// together anyway, so every cargo dollar landed in state.statsHistory twice.
// A cargo-heavy airline's "Weekly Revenue" tile printed nearly double the
// revenue its own P&L printed, and the Revenue-mix chart's Passenger band —
// derived as revenue − partner − cargo — silently absorbed the surplus and
// showed the freight business as passenger money.
//
// This suite drives the REAL reducer and server-renders the REAL Statistics
// tab, then reads the tile back out of the markup a browser would get. It never
// re-derives the number with the component's own arithmetic.
//
//   node --import ./tools/_register-loader.mjs tools/statistics-cargo-test.mjs
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { cargoReferenceYield, referencePrice } from '../packages/engine/src/utils/market.js';
import { defaultClassPrices, formatMoney } from '../packages/engine/src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

// ── Browser shims: GameProvider hydrates from localStorage ───────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k), clear: () => store.clear(),
  key: i => [...store.keys()][i] ?? null, get length() { return store.size; },
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const realRandom = Math.random;
Math.random = () => 0.5;   // deterministic jitter / AOG / events

const { GameProvider } = await import('../src/store/GameContext.jsx');
const Finance = (await import('../src/components/Finance.jsx')).default;

const renderStats = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Finance, { initialView: 'stats' })));
};

/** Read a `.stat-box` tile's printed value straight out of the markup. */
function readTile(html, label) {
  const at = html.indexOf(`>${label}<`);
  assert.notEqual(at, -1, `the Statistics tab rendered no "${label}" tile`);
  const valAt = html.indexOf('class="stat-value', at);
  assert.notEqual(valAt, -1, `"${label}" tile has no value cell`);
  const open = html.indexOf('>', valAt) + 1;
  const close = html.indexOf('</div>', open);
  return html.slice(open, close).replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '').trim();
}

// ── Fixture: one passenger route + one freighter, driven by the real reducer ─
// Deliberately cargo-heavy — freight is the larger half of this airline, which
// is what makes a double count impossible to mistake for rounding.
function cargoAirline({ withCargo = true } = {}) {
  const ac = (typeId, id) => ({
    id, typeId, status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
  });
  const base = freshState();
  return {
    ...base,
    phase: 'playing',
    airlineName: 'Freight Probe', hub: 'HKG',
    week: 30, year: 1, cash: 5e8, awareness: 60,
    objectivesEnabled: false,
    fleet: withCargo ? [ac('a320neo', 'p1'), ac('b777f', 'f1')] : [ac('a320neo', 'p1')],
    routes: [{
      id: 'r1', origin: 'HKG', destination: 'SIN', aircraftId: 'p1',
      weeklyFrequency: 7, weeksOpen: 30,
      ...defaultClassPrices(Math.round(referencePrice('HKG', 'SIN'))),
      ticketPrice: Math.round(referencePrice('HKG', 'SIN')),
    }],
    cargoRoutes: withCargo ? [{
      id: 'c1', origin: 'HKG', destination: 'FRA', aircraftId: 'f1', cargo: true,
      yieldPrice: cargoReferenceYield('HKG', 'FRA'), weeklyFrequency: 7, weeksOpen: 30,
    }] : [],
    gates: { HKG: 10, FRA: 6, SIN: 6 },
    financialHistory: [], statsHistory: [],
  };
}

const advance = (s, n) => {
  for (let i = 0; i < n; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  return s;
};

// Statistics needs >= 2 weeks of history before it renders anything at all.
const flown  = advance(cargoAirline(), 3);
const noFrgt = advance(cargoAirline({ withCargo: false }), 3);

const report = flown.lastReport;
const stats  = flown.statsHistory.at(-1);
const pnl    = flown.financialHistory.at(-1);

const paxRev   = (report.totalRevenue ?? 0) - (report.totalCargoRevenue ?? 0) - (report.totalPartnerRevenue ?? 0);
const cargoRev = report.totalCargoRevenue ?? 0;
const money = v => '$' + Math.round(v).toLocaleString();

console.log('\nFinance ▸ Statistics — cargo double-count\n');
console.log('── Fixture ───────────────────────────────────────────────────────────────');
console.log(`  passenger route revenue   ${money(paxRev)}`);
console.log(`  cargo route revenue       ${money(cargoRev)}`);
console.log(`  partner (interline)       ${money(report.totalPartnerRevenue ?? 0)}`);
console.log(`  ENGINE grand total        ${money(report.totalRevenue)}   (report.totalRevenue)`);
console.log(`  P&L history revenue       ${money(pnl.revenue)}`);
console.log(`  statsHistory revenue      ${money(stats.revenue)}\n`);

console.log('── The KPI record ────────────────────────────────────────────────────────');

test('the fixture actually flies both a passenger route and a freighter', () => {
  assert.equal((report.routeResults ?? []).length, 1, 'no passenger route flew');
  assert.equal((report.cargoRouteResults ?? []).length, 1, 'no cargo route flew');
  assert.ok(paxRev > 0, 'passenger route earned nothing — the test would be vacuous');
  assert.ok(cargoRev > 0, 'cargo route earned nothing — the test would be vacuous');
});

test('statsHistory revenue IS the engine grand total, counted once', () => {
  assert.equal(stats.revenue, report.totalRevenue,
    `Statistics recorded ${money(stats.revenue)} of weekly revenue; the engine earned `
    + `${money(report.totalRevenue)}. Surplus ${money(stats.revenue - report.totalRevenue)} `
    + `vs cargo revenue ${money(cargoRev)} — cargo is in there twice.`);
});

test('statsHistory revenue matches the P&L history for the same week', () => {
  assert.equal(stats.revenue, pnl.revenue,
    `Statistics says ${money(stats.revenue)}, the P&L says ${money(pnl.revenue)} — `
    + 'the same week cannot have two revenues.');
});

test('cargo is recorded as a breakdown of revenue, never on top of it', () => {
  assert.ok(stats.cargoRevenue <= stats.revenue, 'cargo exceeds total revenue');
  assert.equal(stats.cargoRevenue, cargoRev, 'cargo breakdown line drifted from the engine');
  // The Revenue-mix chart derives its Passenger band exactly this way.
  const band = Math.max(0, stats.revenue - stats.partnerRevenue - stats.cargoRevenue);
  assert.equal(band, paxRev,
    `Revenue-mix "Passenger" band would plot ${money(band)}; the passenger network earned `
    + `${money(paxRev)}. It is absorbing ${money(band - paxRev)} of freight money.`);
});

test('a cargo-free airline records the same revenue either way (control)', () => {
  const s = noFrgt.statsHistory.at(-1);
  assert.equal(s.revenue, noFrgt.lastReport.totalRevenue);
  assert.equal(s.cargoRevenue, 0);
});

console.log('\n── The rendered tab ──────────────────────────────────────────────────────');

const html = renderStats(flown);

test('the Statistics tab renders (not the "need 2 weeks" empty state)', () => {
  assert.equal(html.includes('Statistics appear once you have'), false,
    'fixture produced too little history to render the charts');
  assert.ok(html.includes('Weekly Revenue'), 'no Weekly Revenue tile in the markup');
});

test('the "Weekly Revenue" tile prints the airline’s real weekly revenue', () => {
  const shown = readTile(html, 'Weekly Revenue');
  assert.equal(shown, formatMoney(Math.round(report.totalRevenue)),
    `Statistics prints ${shown} of weekly revenue; the airline earned `
    + `${formatMoney(Math.round(report.totalRevenue))} `
    + `(P&L: ${formatMoney(Math.round(pnl.revenue))}).`);
});

// ─────────────────────────────────────────────────────────────────────────────
// The same mistake, one screen over: the Away Digest summed financialHistory as
// `revenue + cargoRevenue`. h.revenue on a financialHistory row IS
// report.totalRevenue — cargo included — so the digest's Revenue stat billed a
// freight operator for its own tonnage twice. Every fixture in the existing away
// suites happens to set cargoRevenue: 0, which is why it survived.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── The Away Digest ───────────────────────────────────────────────────────');

const { buildAwayDigest } = await import('../src/utils/awayDigest.js');

const digestWeeks = 4;
const digestState = advance(cargoAirline(), digestWeeks);
const digest = buildAwayDigest(digestState, digestWeeks);
const digestExpected = digestState.financialHistory
  .slice(-digestWeeks)
  .reduce((s, h) => s + (h.revenue ?? 0), 0);

test('the away-digest fixture actually carries cargo revenue', () => {
  assert.ok(digest, 'no digest was built');
  const cargoSum = digestState.financialHistory.slice(-digestWeeks)
    .reduce((s, h) => s + (h.cargoRevenue ?? 0), 0);
  assert.ok(cargoSum > 0, 'no cargo in the window — the assertion below would be vacuous');
});

test('away-digest revenue is the P&L revenue over the span, cargo counted once', () => {
  assert.equal(digest.revenue, digestExpected,
    `the digest reports ${money(digest.revenue)} of revenue over ${digestWeeks} weeks; `
    + `the P&L booked ${money(digestExpected)}. `
    + `Surplus ${money(digest.revenue - digestExpected)} — cargo counted twice.`);
});

Math.random = realRandom;
console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
