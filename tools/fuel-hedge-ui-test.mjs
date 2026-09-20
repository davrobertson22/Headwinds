// The hedge you are shown is the hedge you are sold.
//
// tools/fuel-hedge-test.mjs proves the PRICING model: hedgeLockedPrice quotes
// the expected average over the term plus the duration premium, so a lock is
// never free money and never pointless. Every assertion in it calls the engine
// helper directly — which is exactly why it kept passing while the screen the
// player actually uses was quoting a different formula.
//
// The reported break: at a market index of 0.794 the Contract Preview offered a
// 26-week lock at 0.873x (spot x 1.10, the formula retired in "Fuel economy v2")
// and the contract that appeared afterwards read 0.991x (expected x 1.10, the
// formula the reducer actually uses). Two pricing models, one screen, and the
// player charged the one they were never shown.
//
// So this suite renders the REAL Fuel tab and checks that every number quoted
// before the click equals the number BUY_HEDGE stores after it. If the preview
// and the reducer ever disagree again, the disagreement is the bug.
//
//   node --import ./tools/_register-loader.mjs tools/fuel-hedge-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  HEDGE_DURATIONS, hedgeLockedPrice, expectedMeanIndex,
} from '../packages/engine/src/utils/fuel.js';
import { formatMoney } from '../packages/engine/src/utils/simulation.js';

// The index from the bug report. Well away from 1.0 on purpose: at 1.0 spot and
// the expected path coincide and both formulas agree, so a fixture near the
// mean would let the defect straight back through.
const SPOT = 0.794;

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

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const Finance = (await import('../src/components/Finance.jsx')).default;

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: 'JFK', cash: 50_000_000,
  fleet: [], routes: [], cargoRoutes: [], loans: [],
  fuelPrice: { index: SPOT, history: [0.93, 0.90, 0.87, 0.84, 0.81, SPOT] },
  hedgeContracts: [],
};

const render = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Finance, { initialView: 'fuel' })))
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    // React SSR splits adjacent text nodes with an empty comment, so
    // `{locked}x` arrives as "0.868<!-- -->x". Rejoin before matching —
    // otherwise every interpolated figure silently fails to match and the test
    // looks like a missing row rather than a rendering detail.
    .replace(/<!-- -->/g, '');
};

console.log('\nFuel hedge desk (render)\n');

const html = render(save);

// The selected duration on first render. The preview and the buy button quote
// this one, so it is the row the reported bug was actually read off.
const DEFAULT_OPT = HEDGE_DURATIONS.find(o => o.id === 'short');

test('the fuel hedge desk renders at all', () => {
  assert.ok(html.includes('Buy Fuel Hedge'), 'the panel did not render');
  assert.ok(html.includes('Contract Preview'), 'the preview card is missing');
  assert.ok(html.includes(`${SPOT.toFixed(3)}×`), 'the market index is not on screen');
});

test('the fixture really does separate the two formulas', () => {
  // Guard the guard: if spot-priced and curve-priced locks ever coincided at
  // this index the rest of the suite would pass vacuously.
  for (const opt of HEDGE_DURATIONS) {
    const curve = hedgeLockedPrice(SPOT, opt).toFixed(3);
    const spotPriced = (SPOT * (1 + opt.premium)).toFixed(3);
    assert.notEqual(curve, spotPriced,
      `${opt.label}: the fixture cannot tell the formulas apart`);
  }
});

test('every duration row quotes the price the engine will actually lock', () => {
  for (const opt of HEDGE_DURATIONS) {
    const shown = `+${Math.round(opt.premium * 100)}% → ${hedgeLockedPrice(SPOT, opt).toFixed(3)}×`;
    assert.ok(html.includes(shown), `${opt.label}: expected "${shown}" on the duration row`);
  }
});

test('no duration row still quotes the retired spot-times-premium price', () => {
  // Matched on the whole row, not the bare figure: at this index the 8-week
  // EXPECTED AVERAGE (0.842×) happens to round to the same three decimals as
  // the retired 13-week quote (0.794 × 1.06), and a bare-number search reads
  // that legitimate row as a relapse.
  for (const opt of HEDGE_DURATIONS) {
    const retired = `+${Math.round(opt.premium * 100)}% → ${(SPOT * (1 + opt.premium)).toFixed(3)}×`;
    assert.ok(!html.includes(retired),
      `${opt.label}: "${retired}" is spot x (1 + premium), the formula Fuel economy v2 removed`);
  }
});

test('the Contract Preview quotes the engine price for the selected duration', () => {
  const expected = `${hedgeLockedPrice(SPOT, DEFAULT_OPT).toFixed(3)}× (${Math.round(DEFAULT_OPT.premium * 100)}% premium for certainty)`;
  assert.ok(html.includes(expected), `expected "${expected}" as the Locked price`);
});

test('the preview shows the expected path it is priced against', () => {
  const expectedAvg = `${expectedMeanIndex(SPOT, DEFAULT_OPT.weeks).toFixed(3)}×`;
  assert.ok(html.includes('Expected average over term'), 'the forward-curve row is missing');
  assert.ok(html.includes(expectedAvg), `expected "${expectedAvg}" as the expected average`);
});

test('the buy button offers the same number the preview does', () => {
  const label = `Lock in ${hedgeLockedPrice(SPOT, DEFAULT_OPT).toFixed(3)}× for ${DEFAULT_OPT.label}`;
  assert.ok(html.includes(label), `expected the button to read "${label}"`);
});

test('what the preview promises is what the contract stores — the reported bug', () => {
  // THE defect. Quote it, buy it, read it back off the Active Contracts row.
  for (const opt of HEDGE_DURATIONS) {
    const after = gameReducer(save, { type: 'BUY_HEDGE', durationId: opt.id, coverage: 0.75 });
    const contract = (after.hedgeContracts ?? []).at(-1);
    assert.ok(contract, `${opt.label}: BUY_HEDGE stored no contract`);

    const stored = `${contract.lockedPrice.toFixed(3)}×`;
    assert.ok(html.includes(`+${Math.round(opt.premium * 100)}% → ${stored}`),
      `${opt.label}: the desk quoted something other than the ${stored} the reducer stores`);

    const afterHtml = render(after);
    assert.ok(afterHtml.includes('Active Contracts (1)'), `${opt.label}: the contract did not appear`);
    assert.ok(afterHtml.includes(stored),
      `${opt.label}: the Active Contracts row does not read ${stored}`);
  }
});

test('the preview for the selected duration survives the round trip verbatim', () => {
  // The exact sequence from the report: read the Locked price off the SCREEN,
  // click buy, read the row. Deliberately no engine call on the quote side —
  // recomputing it with hedgeLockedPrice would just be asking the engine twice
  // and could never catch a screen that disagrees with it.
  const m = html.match(/Locked price<\/span>.*?([0-9]+\.[0-9]{3})×/s);
  assert.ok(m, 'could not find the Locked price row in the render');
  const quoted = m[1];

  const after = gameReducer(save, { type: 'BUY_HEDGE', durationId: DEFAULT_OPT.id, coverage: 0.75 });
  const contract = after.hedgeContracts.at(-1);
  assert.equal(quoted, contract.lockedPrice.toFixed(3),
    `previewed ${quoted}x, was sold ${contract.lockedPrice.toFixed(3)}x`);
  assert.ok(render(after).includes(`${quoted}×`),
    'the Active Contracts row shows a different figure again');
});

test('vs Market is a relative percentage, not a difference of index points', () => {
  // 0.991 against a 0.794 market is 24.8% over it. The row used to subtract the
  // two index values and print the gap as a percentage — 19.7% — which is a
  // percentage of nothing.
  const opt = HEDGE_DURATIONS.find(o => o.weeks === 26);
  const after = gameReducer(save, { type: 'BUY_HEDGE', durationId: opt.id, coverage: 0.75 });
  const locked = after.hedgeContracts.at(-1).lockedPrice;
  assert.ok(locked > SPOT, 'this fixture needs a lock above spot to have a gap at all');

  const relative = (((locked - SPOT) / SPOT) * 100).toFixed(1);
  const points   = ((locked - SPOT) * 100).toFixed(1);
  assert.notEqual(relative, points, 'the fixture cannot tell the two readings apart');

  const afterHtml = render(after);
  assert.ok(afterHtml.includes(`${relative}% over market`),
    `expected "${relative}% over market" (${locked}x vs ${SPOT}x)`);
  assert.ok(!afterHtml.includes(`${points}% over market`),
    `"${points}% over market" is the index-point gap, not a percentage of the market`);
});

test('a lock below market reads as a saving, on the same relative scale', () => {
  // The mirror image, so the fix cannot be a sign trick that only works one way.
  const crisis = { ...save, fuelPrice: { index: 1.45, history: [1.2, 1.3, 1.45] } };
  const opt = HEDGE_DURATIONS.find(o => o.weeks === 26);
  const after = gameReducer(crisis, { type: 'BUY_HEDGE', durationId: opt.id, coverage: 0.5 });
  const locked = after.hedgeContracts.at(-1).lockedPrice;
  assert.ok(locked < 1.45, 'a 26-week lock in a spike should undercut spot');
  const relative = (((1.45 - locked) / 1.45) * 100).toFixed(1);
  assert.ok(render(after).includes(`${relative}% below market`),
    `expected "${relative}% below market"`);
});

test('the desk no longer promises to lock in today\'s price', () => {
  // It never did, since Fuel economy v2 — the copy was describing the retired
  // model, which is what made a lock above spot look like a bug to the player.
  assert.ok(!/today's fuel price/i.test(html),
    'the blurb still claims the lock is at today\'s price');
  assert.ok(/expected to average/i.test(html),
    'the blurb should say the rate is priced off where fuel is expected to average');
});

// ── Fuel operations Phase 1+2: the desk repriced, unwind, scoreboard ─────────
// Verified failing on HEAD (2026-09-19): no 52-week row, no "Saved so far"
// column, no Unwind control, no scoreboard tiles, no Closed Contracts card.

console.log('\nHedge desk: 52-week, unwind, scoreboard (render)\n');

test('the 52-week product is on the duration list', () => {
  const year = HEDGE_DURATIONS.find(o => o.id === 'year');
  assert.ok(year, 'engine has no 52-week product');
  assert.ok(html.includes('52-week'), 'the 52-week row is missing');
  assert.ok(html.includes(`+6% → ${hedgeLockedPrice(SPOT, year).toFixed(3)}×`));
});

test('the blurb tells the player contracts can be unwound', () => {
  assert.ok(html.includes('unwound early'), 'nothing says a contract can be exited');
});

// A hedged airline that has flown a week, so there is a bill to score against.
const flown = {
  ...save,
  week: 30,
  financialHistory: [
    { label: 'Jan W1 Y1', week: 29, year: 1, fuel: 12_000_000, fuelIndex: SPOT, revenue: 60e6, profit: 4e6, totalCost: 56e6 },
  ],
  lastReport: { totalFuel: 12_000_000, fuelMultiplier: SPOT, fuelIndex: SPOT },
};
const hedged = gameReducer(flown, { type: 'BUY_HEDGE', durationId: 'long', coverage: 0.5 });
hedged.hedgeContracts[0].realizedSavings = 750_000;   // as a tick would have written it
const hedgedHtml = render(hedged);

test('the Active Contracts table shows what each contract has saved so far', () => {
  assert.ok(hedgedHtml.includes('Saved so far'), 'the column is missing');
  assert.ok(hedgedHtml.includes(`+${formatMoney(750_000)}`),
    `the realized figure (+${formatMoney(750_000)}) is not on the row`);
});

test('the scoreboard tiles render for a hedged airline', () => {
  assert.ok(hedgedHtml.includes('Open contracts, saved so far'));
  assert.ok(hedgedHtml.includes('Lifetime hedge P&L'));
  assert.ok(hedgedHtml.includes('Record (closed)'));
});

test('every active contract offers an Unwind control', () => {
  assert.ok(hedgedHtml.includes('>Unwind<'), 'no Unwind button on the row');
});

test('a 52-week contract expires in the right calendar week', () => {
  // Week 20 + 52 = absolute 72 → W20 of year 2. The old label clamped to W52.
  const after = gameReducer(save, { type: 'BUY_HEDGE', durationId: 'year', coverage: 0.25 });
  const c = after.hedgeContracts.at(-1);
  assert.equal(c.expiryAbsWeek, 20 + 52);
  // The preview quotes the selected (8-week) row: week 20 + 8 → W28 of year 1.
  assert.ok(html.includes('W28, 1'), 'the 8-week expiry should read W28, 1');
  // And a year-boundary crossing renders as the next year, not a clamped W52:
  // from week 50, 8 weeks → absolute 58 → W6 of year 2.
  const late = render({ ...save, week: 50 });
  assert.ok(late.includes('W6, 2'), 'expiry across the year boundary should read W6, 2');
  assert.ok(!late.includes('W52, 1'), 'the old clamp is back');
});

test('an unwound contract moves to Closed Contracts with its settlement', () => {
  const id = hedged.hedgeContracts[0].id;
  const after = gameReducer(hedged, { type: 'UNWIND_HEDGE', id });
  assert.equal(after.hedgeContracts.length, 0, 'the reducer did not unwind');
  assert.equal(after.hedgeStats.contractsClosed, 1);
  const afterHtml = render(after);
  assert.ok(afterHtml.includes('Closed Contracts'), 'the closed card is missing');
  assert.ok(afterHtml.includes('unwound ('), 'the row should say how it ended');
  assert.ok(afterHtml.includes('Active Contracts (0)'));
  assert.ok(afterHtml.includes('1 closed'), 'the record tile should count it');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
