// The hedge desk prices off the same history the fuel walk follows.
//
// Why. In an era world the weekly fuel walk reverts to the HISTORICAL mean
// for the calendar year (data/era.js eraFuelMean) — 0.45x through the 1950s
// and 60s, the 1973 and 1979 shocks, the 1986-99 glut. The hedge desk did
// not know that: expectedMeanIndex always reverted to the classic 1.0x. So
// in every cheap decade a 52-week lock cost roughly double the fuel it
// covered (1998, spot 0.45 → locked ~0.89), and nobody could hedge — while a
// player who knew a shock was scheduled could buy a lock priced against the
// classic mean instead of the history the walk was about to follow
// (Discord, 2026-11-19: "if you know when it's coming, easy to hedge?").
//
// The fix: in an era world the forward curve steps the walk's own expected
// path, E[x_{t+1}] = x_t + θ(μ_{t+1} − x_t), with μ taken from the era curve
// week by week. Classic worlds (no startYear) and era worlds past 2026 keep
// the closed form — byte-identical, golden master PARITY OK.
//
// Verified failing on HEAD (2026-11-19): the cheap-decade, glut, preview and
// round-trip-in-era assertions fail; HEAD quotes the classic 1.0x curve.
//
//   node --import ./tools/_register-loader.mjs tools/era-hedge-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  HEDGE_DURATIONS, UNWIND_HAIRCUT, expectedMeanIndex, hedgeLockedPrice,
  FUEL_MEAN_REVERSION, FUEL_BASE_INDEX,
} from '../packages/engine/src/utils/fuel.js';
import { eraFuelMean } from '../packages/engine/src/data/era.js';
import { hedgeQuoteDollars, hedgeUnwindDollars } from '../packages/engine/src/utils/fuelImpact.js';
import { calendarYearFrac } from '../packages/engine/src/utils/simulation.js';
import { gameReducer } from '../packages/engine/index.mjs';
import { runScenario } from './golden-master/harness.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const byId = (id) => HEDGE_DURATIONS.find(o => o.id === id);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// A flown airline (so there is a fuel bill to price an unwind against),
// moved onto a real calendar: calendar year = startYear + (year − 1) + …
const s60 = runScenario({ weeks: 60 });
function inYear(calYear, spot) {
  const whole = Math.floor(calYear);
  return {
    ...s60,
    startYear: whole - ((s60.year ?? 1) - 1),
    week: Math.round((calYear - whole) * 52) + 1,
    fuelPrice: { ...(s60.fuelPrice ?? {}), index: spot },
    hedgeContracts: [],
  };
}
// The walk's expected path, written out independently of the engine: no
// shock, mean taken from the era curve for each future week.
function eraPathAverage(spot, weeks, calYear) {
  let x = spot, sum = 0;
  for (let t = 1; t <= weeks; t++) {
    const mu = eraFuelMean(calYear + t / 52) ?? FUEL_BASE_INDEX;
    x += FUEL_MEAN_REVERSION * (mu - x);
    sum += x;
  }
  return sum / weeks;
}
const buy = (s, id, cov = 0.5) => gameReducer(s, { type: 'BUY_HEDGE', durationId: id, coverage: cov }).hedgeContracts.at(-1);

console.log('\nEra hedge desk\n');

test('the fixture really is an era world on the intended calendar year', () => {
  const s = inYear(1998, 0.45);
  assert.equal(calendarYearFrac(s), 1998);
  assert.ok(near(calendarYearFrac(inYear(1973.5, 0.62)), 1973.5, 1e-9));
});

test('in a cheap decade a 52-week lock prices near the era, not near 1.0x', () => {
  // 1998: the era mean is 0.45x. HEAD sold this at ~0.89x.
  const s = inYear(1998, 0.45);
  const c = buy(s, 'year');
  const cy = calendarYearFrac(s);
  const fair = eraPathAverage(0.45, 52, cy) * (1 + byId('year').premium);
  assert.ok(near(c.lockedPrice, fair, 0.002), `locked ${c.lockedPrice}, era-fair ${fair.toFixed(3)}`);
  assert.ok(c.lockedPrice < 0.65, `a 1998 lock at ${c.lockedPrice}x costs more than the decade's fuel`);
});

test('a 1960 lock is roughly the 1960 price plus the premium', () => {
  const s = inYear(1960, 0.45);
  for (const opt of HEDGE_DURATIONS) {
    const c = buy(s, opt.id);
    assert.ok(c.lockedPrice < 0.45 * (1 + opt.premium) + 0.03,
      `${opt.label}: locked ${c.lockedPrice}x in a flat 0.45x decade`);
  }
});

test('the 1986 glut: a late-1985 lock prices the collapse that is coming', () => {
  // Era mean 1.10 at Jan 1985 → 0.60 at Jan 1986. A 52-week lock bought in
  // late 1985 at a 1.10 spot should sit well under spot; HEAD priced it as a
  // drift toward 1.0 only.
  const s = inYear(1985.75, 1.10);
  const c = buy(s, 'year');
  const fair = eraPathAverage(1.10, 52, calendarYearFrac(s)) * 1.06;
  assert.ok(near(c.lockedPrice, fair, 0.002), `locked ${c.lockedPrice}, era-fair ${fair.toFixed(3)}`);
  assert.ok(c.lockedPrice < 0.95, `a lock into the glut at ${c.lockedPrice}x ignores it`);
});

test('a lock before the 1973 shock costs what the shock costs', () => {
  // The Discord question: knowing it is coming must not be a free lunch.
  // The desk's price follows the same curve the walk does, so the lock
  // carries the scheduled rise plus the premium — no better than fair.
  const s = inYear(1973.5, 0.62);
  const c = buy(s, 'year');
  const fair = eraPathAverage(0.62, 52, calendarYearFrac(s));
  assert.ok(c.lockedPrice >= fair, `locked ${c.lockedPrice} under the era path ${fair.toFixed(3)}`);
  assert.ok(near(c.lockedPrice, fair * 1.06, 0.002));
});

test('the dollar quote on the buy card is the price BUY_HEDGE stores', () => {
  const s = inYear(1998, 0.45);
  for (const opt of HEDGE_DURATIONS) {
    const q = hedgeQuoteDollars(s, opt, 0.5);
    assert.equal(q.locked, buy(s, opt.id).lockedPrice, `${opt.label}: card ${q.locked} vs stored`);
  }
});

test('buy-then-unwind still round-trips to exactly −(premium + haircut) in an era world', () => {
  for (const [yr, spot] of [[1998, 0.45], [1973.5, 0.62], [1985.75, 1.10]]) {
    const s = inYear(yr, spot);
    for (const opt of HEDGE_DURATIONS) {
      const bought = gameReducer(s, { type: 'BUY_HEDGE', durationId: opt.id, coverage: 0.5 });
      const c = bought.hedgeContracts.at(-1);
      const q = hedgeUnwindDollars(bought, c.id);
      assert.ok(q, `${yr} ${opt.label}: no unwind quote`);
      const perUnit = q.mtm / q.notional;                         // = expected − locked
      assert.ok(near(perUnit, q.expectedIndex - c.lockedPrice, 1e-3));
      // locked = expected × (1 + premium) at the same instant, so the round trip
      // loses premium × expected + haircut per unit of notional — never gains.
      const loss = -q.settlement / q.notional;
      assert.ok(near(loss, opt.premium * q.expectedIndex + UNWIND_HAIRCUT, 2e-3),
        `${yr} ${opt.label}: round trip loses ${loss.toFixed(4)}, expected ${(opt.premium * q.expectedIndex + UNWIND_HAIRCUT).toFixed(4)}`);
    }
  }
});

test('classic worlds are untouched: the closed form, to the digit', () => {
  const s = { ...s60, startYear: undefined, fuelPrice: { ...(s60.fuelPrice ?? {}), index: 0.794 }, hedgeContracts: [] };
  assert.equal(calendarYearFrac(s), null);
  for (const opt of HEDGE_DURATIONS) {
    const want = parseFloat((expectedMeanIndex(0.794, opt.weeks) * (1 + opt.premium)).toFixed(3));
    assert.equal(buy(s, opt.id).lockedPrice, want, opt.label);
    assert.equal(hedgeLockedPrice(0.794, opt), want, `${opt.label}: default call`);
  }
});

test('an era world past 2026 reverts to the classic curve', () => {
  const s = inYear(2031, 0.80);
  for (const opt of HEDGE_DURATIONS) {
    const want = parseFloat((expectedMeanIndex(0.80, opt.weeks) * (1 + opt.premium)).toFixed(3));
    assert.equal(buy(s, opt.id).lockedPrice, want, opt.label);
  }
});

// ── The real Fuel tab ───────────────────────────────────────────────────────

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

// Away from the 1998 era mean (0.45) so spot, the era path and the classic
// path all print differently — at 0.45 the expected average equals the
// market index already on screen and the preview check passes vacuously.
const SPOT = 0.55;
const eraSave = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, startYear: 1998, hub: 'JFK', cash: 50_000_000,
  fleet: [], routes: [], cargoRoutes: [], loans: [],
  fuelPrice: { index: SPOT, history: [0.50, 0.52, 0.54, SPOT] },
  hedgeContracts: [],
};
const render = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(
    React.createElement(GameProvider, null, React.createElement(Finance, { initialView: 'fuel' })))
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/<!-- -->/g, '');
};
const html = render(eraSave);

test('every duration row in an era world quotes the price BUY_HEDGE stores', () => {
  assert.ok(html.includes('Buy Fuel Hedge'), 'the panel did not render');
  for (const opt of HEDGE_DURATIONS) {
    const after = gameReducer(eraSave, { type: 'BUY_HEDGE', durationId: opt.id, coverage: 0.75 });
    const stored = after.hedgeContracts.at(-1).lockedPrice.toFixed(3);
    const row = `+${Math.round(opt.premium * 100)}% → ${stored}×`;
    assert.ok(html.includes(row), `${opt.label}: expected "${row}" on the duration row`);
  }
});

test('the Contract Preview and its expected average follow the era curve', () => {
  const opt = byId('short');
  const after = gameReducer(eraSave, { type: 'BUY_HEDGE', durationId: opt.id, coverage: 0.75 });
  const stored = after.hedgeContracts.at(-1).lockedPrice.toFixed(3);
  const m = html.match(/Locked price<\/span>.*?([0-9]+\.[0-9]{3})×/s);
  assert.ok(m, 'no Locked price row');
  assert.equal(m[1], stored, `previewed ${m[1]}x, sold ${stored}x`);
  const avg = eraPathAverage(SPOT, opt.weeks, calendarYearFrac(eraSave)).toFixed(3);
  const row = html.match(/Expected average over term<\/span>.*?([0-9]+\.[0-9]{3})×/s);
  assert.ok(row, 'no Expected average row');
  assert.equal(row[1], avg, `expected average shows ${row[1]}x, era path is ${avg}x`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
