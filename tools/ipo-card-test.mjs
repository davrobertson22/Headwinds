// The IPO card — the offering builder in Stocks ▸ Your company.
//
// Server-renders the REAL CapitalActions component (no mocks) via the JSX loader.
// The engine-side rules live in capital-test.mjs; what this catches is the other
// half of the same defect: a card that crashes, or that stops offering the
// primary/secondary split at all, while every engine test still passes.
//
//   node --import ./tools/_register-loader.mjs tools/ipo-card-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { freshState } from '../packages/engine/src/reducer.mjs';
import { emptyEquity, migratedEquity } from '../packages/engine/src/utils/market.js';
import { CapitalActions } from '../src/components/StockMarket.jsx';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); failed++; } };

const history = (weeks) => Array.from({ length: weeks }, () => ({ profit: 2_000_000, totalCost: 5_000_000 }));

const base = (equity) => ({
  ...freshState(),
  cash: 500_000_000, week: 30, year: 1,
  marketCap: 100_000_000, fairValue: 100_000_000, sharePrice: 1,
  financialHistory: history(52),
  equity,
  stockPool: { poolCash: 750_000_000, seedCash: 750_000_000 },
});

const render = (state) => renderToString(
  React.createElement(CapitalActions, { state, dispatch: () => {} }),
);

console.log('\n── The IPO card ─────────────────────────────────────────');

test('a private airline is offered a listing it can build', () => {
  const html = render(base(emptyEquity()));
  assert.ok(html.includes('Go public'), 'the IPO card renders');
  assert.ok(html.includes('type="range"'), 'the new-shares / sell-down mix control is there');
  assert.ok(html.includes('New shares issued'), 'the dilutive half is broken out');
  assert.ok(html.includes('Sold from your holding'), 'and so is the non-dilutive half');
  assert.ok(html.includes('Estimated proceeds'));
});

test('the preview prices off fair value, not the smoothed pre-listing print', () => {
  // While private, the published cap is a SMOOTHED series and the listing is
  // priced off the unsmoothed fair value — so a card that previews from
  // state.sharePrice quotes a number the listing will not honour.
  const lagging = base(emptyEquity());
  const html = render({ ...lagging, sharePrice: 0.01, marketCap: 1_000_000 });
  assert.ok(!html.includes('$0.0095'), 'the offer price did not come off the stale print');
  assert.ok(html.includes('$0.95'), 'it came off fair value less the 5% IPO discount');
});

test('a listed airline gets the offering card instead, and still renders', () => {
  const html = render(base(migratedEquity()));
  assert.ok(html.includes('Share offering'), 'listed airlines see the secondary-offering card');
  assert.ok(!html.includes('Go public'), 'and not the IPO builder');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
