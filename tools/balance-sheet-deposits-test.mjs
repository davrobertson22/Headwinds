// Lease deposits and prepaid aircraft are ASSETS on the Balance Sheet.
//
// Time Flies (Discord, 2026-10-18: "why are almost everyone losing lol?").
// Every airline leased, each lease order took a 12-week-rent security deposit,
// and the Balance Sheet counted only cash + owned metal + shares − loans — so
// the deposits vanished from Net Assets. Vodkair had earned $12.7M in ten weeks
// and showed $9.4M, under its $10M start, because $12.4M sat with the lessors.
// The deposit comes back on every path (redelivery, early return, buy-out
// credit, cancellation), so it is the airline's money: a receivable. A purchase
// order is the same story at full price — paid at order time, nothing on the
// sheet until delivery.
//
// The lender's view (credit.js bookEquity) deliberately stays WITHOUT them: a
// bank does not lend against cash a lessor is holding.
//
//   node --import ./tools/_register-loader.mjs tools/balance-sheet-deposits-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window ??= { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };

const { gameReducer } = await import('../packages/engine/src/reducer.mjs');
const { balanceSheetOf, netAssetsOf, liveStatsOf } = await import('../packages/engine/src/utils/standings.js');
const { bookEquity } = await import('../packages/engine/src/data/credit.js');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Finance = (await import('../src/components/Finance.jsx')).default;
const { formatMoney } = await import('../src/utils/simulation.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

function airline(over = {}) {
  const s = gameReducer(undefined, { type: 'START_GAME', airlineName: 'Vodkair', hub: 'PVG', enableObjectives: false });
  // Classic solo rules: no starter instant deliveries, no production lines,
  // basic seats — so an order's upfront cost is exactly its deposit/price.
  return { ...s, cash: 500_000_000, fleet: [], pendingOrders: [], loans: [], ...over };
}
const order = (s, ownershipType, quantity) => gameReducer(s, {
  type: 'ORDER_AIRCRAFT', typeId: 'b737800', quantity, ownershipType, leaseTermWeeks: 104,
});

console.log('\nBalance Sheet: deposits and prepaid aircraft are assets\n');

test('a lease order moves cash into deposits — net assets do not drop', () => {
  const s0 = airline();
  const s1 = order(s0, 'lease', 3);
  const paid = s0.cash - s1.cash;
  assert.ok(paid > 0 && s1.pendingOrders.length === 3, 'fixture: three lease frames on order');
  const bs = balanceSheetOf(s1);
  assert.equal(bs.leaseDeposits, paid);
  assert.equal(netAssetsOf(s1), netAssetsOf(s0), `net assets fell by ${netAssetsOf(s0) - netAssetsOf(s1)}`);
});

test('a purchase order moves cash into aircraft on order — net assets do not drop', () => {
  const s0 = airline();
  const s1 = order(s0, 'owned', 2);
  const paid = s0.cash - s1.cash;
  assert.ok(paid > 0 && s1.pendingOrders.length === 2);
  assert.equal(balanceSheetOf(s1).aircraftOnOrder, paid);
  assert.equal(netAssetsOf(s1), netAssetsOf(s0));
});

test('handing a lease back early costs exactly the termination penalty', () => {
  const tail = {
    id: 'L1', typeId: 'b737800', name: 'L1', status: 'idle', ownershipType: 'lease', ageWeeks: 10,
    weeklyLease: 100_000, leaseDeposit: 1_200_000, leaseTermWeeks: 104, leaseRemainingWeeks: 10,
  };
  const s0 = airline({ fleet: [tail] });
  const s1 = gameReducer(s0, { type: 'RETIRE_AIRCRAFT', aircraftId: 'L1' });
  assert.equal(s1.cash - s0.cash, 1_200_000 - 500_000, 'fixture: deposit back, half the remaining rent charged');
  assert.equal(netAssetsOf(s1) - netAssetsOf(s0), -500_000,
    'the returned deposit is an asset swap, not a windfall');
});

test('retired and owned tails carry no deposit on the sheet', () => {
  const s = airline({ fleet: [
    { id: 'R', typeId: 'b737800', status: 'retired', ownershipType: 'lease', ageWeeks: 1, leaseDeposit: 9e6 },
    { id: 'O', typeId: 'b737800', status: 'idle', ownershipType: 'owned', ageWeeks: 1, leaseDeposit: 9e6 },
  ] });
  assert.equal(balanceSheetOf(s).leaseDeposits, 0);
});

test('the lender still does not count them (credit.js bookEquity)', () => {
  const s0 = airline();
  const s1 = order(s0, 'lease', 3);
  assert.equal(bookEquity(s1), bookEquity(s0) - (s0.cash - s1.cash));
});

test('the standings "Net assets" is the same figure', () => {
  const s = order(airline(), 'lease', 2);
  assert.equal(liveStatsOf(s).netAssets, netAssetsOf(s));
});

test('Finance ▸ Balance Sheet shows both lines and the same equity', () => {
  let s = { ...freshState(), phase: 'playing', week: 10, year: 1, hub: 'PVG', cash: 500_000_000,
    fleet: [], pendingOrders: [], routes: [], cargoRoutes: [], loans: [], financialHistory: [] };
  s = order(order(s, 'lease', 2), 'owned', 1);
  store.set('bbae_save_v2', JSON.stringify(s));
  const html = renderToString(React.createElement(GameProvider, null,
    React.createElement(Finance, { initialView: 'bs' })))
    .replace(/&amp;/g, '&').replace(/<!-- -->/g, '');
  const bs = balanceSheetOf(s);
  assert.match(html, /Lease deposits/);
  assert.match(html, /Aircraft on order/);
  assert.ok(html.includes(formatMoney(bs.leaseDeposits)), 'deposit total is printed');
  assert.ok(html.includes(formatMoney(bs.aircraftOnOrder)), 'prepaid total is printed');
  assert.ok(html.includes(formatMoney(netAssetsOf(s))), 'the sheet’s equity is the standings figure');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
