// Fuel in dollars, on the screens a player actually reads.
//
// tools/fuel-impact-test.mjs proves the arithmetic. This renders the real
// components and checks the dollars reach the page: the Fuel tab's readout,
// the hedge preview, the Dashboard tile, the P&L note under Fuel & Oil, and
// the away digest's fuel line — and that each of them prints the number the
// engine helper computes, not a second derivation.
//
// Verified failing on HEAD (2026-09-16): none of the four screens printed a
// dollar figure for the fuel price level; the Fuel tab was index-only.
//
//   node --import ./tools/_register-loader.mjs tools/fuel-impact-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { fuelImpact, hedgeQuoteDollars } from '../packages/engine/src/utils/fuelImpact.js';
import { HEDGE_DURATIONS } from '../packages/engine/src/utils/fuel.js';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';

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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { formatMoney } = await import('../src/utils/simulation.js');
const Finance    = (await import('../src/components/Finance.jsx')).default;
const Dashboard  = (await import('../src/components/Dashboard.jsx')).default;
const AwayDigest = (await import('../src/components/AwayDigest.jsx')).default;
const { seenKeyFor } = await import('../src/utils/awayDigest.js');

const clean = (html) => html.replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

// Heavy Landing in round numbers: a $200M base fuel bill, the index climbing
// 0.80 → 1.30 over 30 weeks, revenue flat, everything else flat. No hedge.
const BASE = 200_000_000, OTHER = 560_000_000, REV = 820_000_000;
const walk = Array.from({ length: 30 }, (_, i) => +(0.80 + (0.50 * i) / 29).toFixed(3));
const fin = walk.map((x, i) => {
  const fuel = Math.round(BASE * x);
  return { label: `W${i + 1}`, week: i + 1, year: 1, revenue: REV, fuel, fuelIndex: x,
           totalCost: fuel + OTHER, profit: REV - fuel - OTHER + 24_000_000, passengers: 1_000_000, cash: 1 };
});
const SAVE = {
  ...freshState(),
  phase: 'playing', week: 30, year: 1, hub: 'JFK', cash: 500_000_000,
  fleet: [], routes: [], cargoRoutes: [], loans: [], competitors: [],
  fuelPrice: { index: 1.30, history: walk },
  hedgeContracts: [],
  financialHistory: fin,
  statsHistory: fin.map((h, i) => ({ label: h.label, absWeek: i + 1, week: h.week, year: 1, fleet: 400, routes: 390, destinations: 100, sharePrice: 9, svps: 11, loadFactor: 0.9 })),
};
const expected = fuelImpact(SAVE);

const render = (el) => {
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  return clean(renderToString(React.createElement(GameProvider, null, el)));
};

console.log('\nFuel tab\n');

const fuelHtml = render(React.createElement(Finance, { initialView: 'fuel' }));

test('the readout card is on the Fuel tab, above the gauge', () => {
  assert.ok(fuelHtml.includes('WHAT FUEL IS COSTING YOU'), 'card missing');
  assert.ok(fuelHtml.indexOf('WHAT FUEL IS COSTING YOU') < fuelHtml.indexOf('JET FUEL PRICE INDEX'),
    'the dollars should come before the index');
});

test('it prints this week\'s bill, the 1.0x bill and the excess from the helper', () => {
  assert.equal(expected.bill, 260_000_000);
  assert.ok(fuelHtml.includes(formatMoney(260_000_000)), 'bill');
  assert.ok(fuelHtml.includes(formatMoney(200_000_000)), 'base bill');
  assert.ok(fuelHtml.includes(`${formatMoney(60_000_000)}<span`), 'excess $60M');
  assert.ok(fuelHtml.includes('Above-normal fuel costs you'));
});

test('the excess is put against profit, and the per-0.1 sensitivity is stated', () => {
  assert.ok(fuelHtml.includes('2.5× this week\'s profit'), 'excess $60M on $24M profit is 2.5x');
  assert.ok(fuelHtml.includes(`${formatMoney(20_000_000)}<span`), 'per 0.1 = $20M');
  assert.ok(fuelHtml.includes('unhedged'));
});

test('the slope: 13 and 26 weeks ago, and the year low, with the dollars they imply', () => {
  const a26 = expected.ago.find(a => a.weeks === 26);
  assert.ok(fuelHtml.includes('26 weeks ago (W4)'), '26-week lookback');
  assert.ok(fuelHtml.includes(`+${formatMoney(a26.dBill)}/wk`), 'fuel delta since W4');
  assert.ok(fuelHtml.includes('Year low 0.80× (W1, 29 wks ago)'), 'the low anchor');
  assert.ok(fuelHtml.includes(formatMoney(expected.low.bill)), 'bill at the low');
});

test('the hedge preview quotes the lock in dollars, priced by hedgeQuoteDollars', () => {
  const q = hedgeQuoteDollars(SAVE, HEDGE_DURATIONS.find(o => o.id === 'short'), 0.25);
  assert.ok(fuelHtml.includes(`${formatMoney(q.baseBillCovered)}/wk of flying, fixed at ${formatMoney(q.billCovered)}/wk`), 'covered bill');
  assert.ok(fuelHtml.includes(`${q.vsSpot >= 0 ? 'saves' : 'costs'} ${formatMoney(Math.abs(q.vsSpot))}/wk`), 'vs spot');
  assert.ok(fuelHtml.includes(`above ${q.breakevenIndex.toFixed(3)}×`), 'breakeven');
});

test('a fresh airline with no history gets no card, not a card of zeros', () => {
  const html = clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(Finance, { initialView: 'fuel' }))));
  // GameProvider reads the parked save; park one with no history first.
  store.set('bbae_save_v2', JSON.stringify({ ...SAVE, financialHistory: [] }));
  const html2 = clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(Finance, { initialView: 'fuel' }))));
  assert.ok(html.includes('WHAT FUEL IS COSTING YOU'));
  assert.ok(!html2.includes('WHAT FUEL IS COSTING YOU'));
  assert.ok(html2.includes('JET FUEL PRICE INDEX'), 'the rest of the tab still renders');
});

console.log('\nDashboard\n');

const dashHtml = render(React.createElement(Dashboard, { onNavigate: () => {} }));

test('a Fuel KPI tile shows the index and the weekly dollars above normal', () => {
  assert.ok(dashHtml.includes('>Fuel</div>'), 'tile label');
  assert.ok(dashHtml.includes('1.30×'), 'index');
  assert.ok(dashHtml.includes(`+${formatMoney(60_000_000)}/wk above normal`), 'excess');
  assert.ok(dashHtml.includes(`${formatMoney(20_000_000)} per 0.1`), 'sensitivity');
});

test('the tile is coloured by the fuel status band (1.30 = High → yellow)', () => {
  const i = dashHtml.indexOf('>Fuel</div>');
  const slice = dashHtml.slice(i, i + 400);
  assert.ok(slice.includes('stat-value yellow'), slice);
});

test('at a normal price the tile states the bill and stops there', () => {
  const flat = { ...SAVE, fuelPrice: { index: 1.0, history: [1.0] },
    financialHistory: SAVE.financialHistory.map(h => ({ ...h, fuel: BASE, fuelIndex: 1.0 })) };
  store.set('bbae_save_v2', JSON.stringify(flat));
  const html = clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(Dashboard, { onNavigate: () => {} }))));
  assert.ok(html.includes('at normal price'));
  assert.ok(!html.includes('above normal'));
});

console.log('\nP&L\n');

test('an airline with no flying (no projected fuel) gets no note row', () => {
  const html = render(React.createElement(Finance, { initialView: 'pl' }));
  assert.ok(html.includes('Fuel & Oil'));
  assert.ok(!html.includes('pl-fuel-price-note'), 'no routes → no fuel → no note');
});

// A real projection needs real flying: three 737 routes out of a hub, the
// finance-bridge fixture, at a 1.30x market.
const jet = AIRCRAFT_TYPES.find(t => t.id === 'b737800') ?? AIRCRAFT_TYPES.filter(t => !t.freighter)[0];
const HUB = ['SFO', 'JFK', 'LAX'].find(c => getAirport(c));
const DESTS = ['LAX', 'SEA', 'DEN', 'ORD'].filter(c => c !== HUB && getAirport(c)).slice(0, 3);
const fleet = [], routes = [], routePricing = {};
DESTS.forEach((d, i) => {
  fleet.push({ id: `ac${i}`, typeId: jet.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
               status: 'assigned', ageWeeks: 150, ownershipType: 'leased',
               weeklyLease: jet.weeklyLease, leaseRemainingWeeks: 200, config: defaultConfig(jet.seats) });
  routes.push({ id: `r${i}`, origin: HUB, destination: d, aircraftId: `ac${i}`, weeklyFrequency: 28, weeksOpen: 40, hub: HUB });
  routePricing[[HUB, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(HUB, d)));
});
const FLYING = { ...SAVE, hub: HUB, hubs: { [HUB]: { tier: 2, tierSince: 0 } },
  gates: Object.fromEntries([[HUB, 20], ...DESTS.map(d => [d, 8])]), fleet, routes, routePricing };

test('Fuel & Oil carries a note row: of which fuel price above normal, tied to the projected bill', () => {
  store.set('bbae_save_v2', JSON.stringify(FLYING));
  const html = clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(Finance, { initialView: 'pl' }))));
  assert.ok(html.includes('pl-fuel-price-note'), 'note row missing');
  assert.ok(html.includes('of which fuel price above normal (1.30×)'), 'label carries the projection multiplier');
  // The provider hydrates the save before projecting, so read the projected
  // Fuel & Oil figure off the page and check the note is exactly the price
  // level's share of it: bill − bill / 1.30.
  const text = html.replace(/<[^>]+>/g, '|');
  const money = (str) => { const m = /-\$([\d.]+)([KMB])/.exec(str); return m ? parseFloat(m[1]) * { K: 1e3, M: 1e6, B: 1e9 }[m[2]] : NaN; };
  // The statement's Fuel & Oil line is the one immediately before the note
  // (the weekly-comparison table above it prints the same label first).
  const noteAt  = text.indexOf('of which fuel price above normal');
  const fuelRow = text.slice(text.lastIndexOf('Fuel & Oil', noteAt), noteAt);
  const cells = fuelRow.split('|').map(c => c.trim()).filter(Boolean);
  // cells: ['Fuel & Oil', '<n> routes · $x/route avg', prior, projected, ytd]
  const projected = money(cells[3]);
  const noteRow = text.slice(noteAt);
  const noteCells = noteRow.split('|').map(c => c.trim()).filter(Boolean);
  const note = money(noteCells[2]);   // [label, prior, projected, ytd]
  assert.ok(projected > 0 && note > 0, `could not read the rows: ${cells.slice(0, 6)} / ${noteCells.slice(0, 4)}`);
  const expectedNote = projected - projected / 1.30;
  assert.ok(Math.abs(note - expectedNote) / expectedNote < 0.02,
    `note ${note} should be the 1.30x share of the ${projected} bill (${expectedNote})`);
  // Prior-week column: last history entry was $260M at 1.30x → $60M of it is price.
  assert.equal(noteCells[1], '-$60.00M');
});

console.log('\nAway digest\n');

test('the digest names the fuel move and what it did to the bill', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  store.set(seenKeyFor(null), '18');   // away 12 weeks: W18 → W30
  const html = clean(renderToString(React.createElement(GameProvider, null, React.createElement(AwayDigest))));
  assert.ok(html.includes('While you were away'));
  assert.ok(html.includes('away-fuel'), 'fuel line missing');
  assert.ok(html.includes(`${walk[17].toFixed(2)}× → 1.30×`), 'from → to');
  const dBill = Math.round(BASE * 1.30) - Math.round(BASE * walk[17]);
  assert.ok(html.includes(`+${formatMoney(dBill)}/wk`), 'bill delta');
  assert.ok(html.includes(`above-normal fuel now costs ${formatMoney(60_000_000)}/wk`));
});

test('a gap in which fuel barely moved says nothing about fuel', () => {
  const flat = { ...SAVE, financialHistory: SAVE.financialHistory.map(h => ({ ...h, fuel: BASE, fuelIndex: 1.0 })) };
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(flat));
  store.set(seenKeyFor(null), '18');
  const html = clean(renderToString(React.createElement(GameProvider, null, React.createElement(AwayDigest))));
  assert.ok(html.includes('While you were away'));
  assert.ok(!html.includes('away-fuel'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
