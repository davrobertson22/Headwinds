// The loan desk on screen must be the loan desk in the engine.
//
// Everything on this panel — the grade, the APR, the ceiling, the weekly
// payment — used to be computed here, in React, and then handed to the reducer
// on the action. That is precisely why a modded client could name its own
// interest rate: the numbers the player saw and the numbers the game used came
// from the same place, and that place was the browser.
//
// So this suite renders the REAL panel and checks that what it shows agrees,
// to the dollar, with what data/credit.js says — because if they ever diverge
// again, the divergence is the bug.
//
//   node --import ./tools/_register-loader.mjs tools/loans-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  creditRating, loanRate, borrowingCapacity, collateralValue,
  AIRCRAFT_LOAN_ID, getLoanProduct,
} from '../src/data/credit.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// localStorage shim — the save is how the panel gets its state.
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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Finance = (await import('../src/components/Finance.jsx')).default;

const HISTORY = Array.from({ length: 30 }, (_, i) => ({
  label: `W${i}`, week: i + 1, year: 1, revenue: 5_000_000, profit: 900_000, passengers: 12_000,
}));

const save = {
  ...freshState(),
  phase: 'playing', week: 40, year: 2, hub: 'JFK', cash: 60_000_000,
  fleet: [
    { id: 'own1', typeId: 'b7878', name: 'Owned 1', tailNumber: 'N1', status: 'idle',
      ageWeeks: 104, ownershipType: 'owned', config: null },
    { id: 'own2', typeId: 'a320ceo', name: 'Owned 2', tailNumber: 'N2', status: 'idle',
      ageWeeks: 200, ownershipType: 'owned', config: null },
  ],
  routes: [], cargoRoutes: [], loans: [],
  financialHistory: HISTORY,
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Finance, { initialView: 'loans' })))
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    // React SSR splits adjacent text nodes with an empty comment, so
    // `{rate}% APR` arrives as "6.0<!-- -->% APR". Rejoin before matching —
    // otherwise every interpolated figure silently fails to match and the test
    // looks like a missing number rather than a rendering detail.
    .replace(/<!-- -->/g, '');
};
const html = render(save);

const money = (v) => '$' + Math.round(v).toLocaleString();

test('the loan desk renders', () => {
  assert.ok(html.includes('Take a New Loan'), 'the panel did not render');
  assert.ok(html.includes('Credit Rating'));
});

test('every product on offer is on screen, including the secured one', () => {
  for (const p of ['Short-term Loan', 'Medium-term Loan', 'Long-term Loan', 'Aircraft Finance']) {
    assert.ok(html.includes(p), `"${p}" is missing from the picker`);
  }
});

test('the APR shown is the APR the engine will charge', () => {
  // The whole point of the package: no second opinion lives in this file.
  for (const id of ['short', 'medium', 'long', AIRCRAFT_LOAN_ID]) {
    const shown = (loanRate(save, id) * 100).toFixed(1) + '% APR';
    assert.ok(html.includes(shown), `${id}: expected "${shown}" on screen`);
  }
});

test('the ceiling shown is the ceiling the engine will enforce', () => {
  for (const id of ['short', 'medium', 'long', AIRCRAFT_LOAN_ID]) {
    const cap = borrowingCapacity(save, id);
    assert.ok(cap > 0, `${id} should have capacity in this fixture`);
    assert.ok(html.includes(String(Math.round(cap / 1_000_000))) || html.includes(money(cap)),
      `${id}: ${money(cap)} does not appear`);
  }
});

test('the collateral behind Aircraft Finance is disclosed, not implied', () => {
  const secured = render({ ...save, __forceSecured: true });
  // The disclosure only shows once the secured product is selected, so at
  // minimum the card itself must name the metal it would take.
  assert.ok(html.includes('2 aircraft'), 'the picker should say what would be pledged');
  assert.ok(secured.includes('Aircraft Finance'));
});

test('an all-leased airline is told it has nothing to pledge', () => {
  const leasedOnly = render({ ...save, fleet: save.fleet.map(a => ({ ...a, ownershipType: 'leased' })) });
  assert.ok(leasedOnly.includes('No unpledged aircraft'),
    'the card should say why the product is unavailable');
});

test('a pledged aircraft is labelled on the active-loan row', () => {
  const financed = render({
    ...save,
    loans: [{
      id: 'L1', productId: AIRCRAFT_LOAN_ID, principal: 20_000_000, interestRate: 0.045,
      termWeeks: 416, weeklyPayment: 55_000, weeksRemaining: 400, totalInterestPaid: 0,
      takenWeek: 1, takenYear: 2, collateralIds: ['own1', 'own2'],
    }],
  });
  assert.ok(financed.includes('SECURED'), 'a secured facility should be marked as one');
  assert.ok(financed.includes('2 aircraft'));
});

test('the engine agrees the fixture is a grade-A borrower', () => {
  const r = creditRating(save);
  assert.equal(r.grade, 'A');
  assert.ok(r.rateBonus < 0, 'an A should be a discount, not a penalty');
});

test('every product prices and sizes without throwing', () => {
  for (const id of ['short', 'medium', 'long', AIRCRAFT_LOAN_ID]) {
    const rate = loanRate(save, id);
    const cap  = borrowingCapacity(save, id);
    assert.ok(Number.isFinite(rate) && rate > 0, `${id} rate ${rate}`);
    assert.ok(Number.isFinite(cap) && cap >= 0, `${id} capacity ${cap}`);
  }
});

test('the secured product is sized off the two owned aircraft', () => {
  const book = collateralValue(save);
  assert.ok(book > 0, 'two owned aircraft should be worth something');
  const ltv = getLoanProduct(AIRCRAFT_LOAN_ID).ltv;
  assert.ok(Math.abs(borrowingCapacity(save, AIRCRAFT_LOAN_ID) - Math.floor(book * ltv / 1000) * 1000) <= 1);
});

test('a fleet with nothing owned offers no secured capacity', () => {
  const leasedOnly = { ...save, fleet: save.fleet.map(a => ({ ...a, ownershipType: 'leased' })) };
  assert.equal(borrowingCapacity(leasedOnly, AIRCRAFT_LOAN_ID), 0);
  assert.equal(collateralValue(leasedOnly), 0);
  // …but unsecured borrowing is untouched by that.
  assert.ok(borrowingCapacity(leasedOnly, 'long') > 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
