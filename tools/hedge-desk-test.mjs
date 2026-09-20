// Fuel operations Phase 1 + 2 (FUEL_OPERATIONS_PLAN.md §4–5): the hedge desk
// repriced, a 52-week product, an early unwind, and a scoreboard that tells
// the player what each contract actually made.
//
// Why: at spot 1.38 the old 26-week lock was ~1.30 against an expected
// ~1.18 — a 10% premium on a walk whose stationary sigma is ~0.17. Nobody
// hedged (Heavy Landing: zero contracts across the top eight through a
// 30-week 1.25×+ stretch that outlasted the longest product), and the one
// player who tried reported "saves 3.5 mill" on a $62M/wk bill.
//
// Verified failing on HEAD (2026-09-19): 15 of the tests below fail before
// the engine change — the premiums are 3/6/10%, there is no 'year' product,
// UNWIND_HEDGE returns state unchanged, and no tick writes realizedSavings.
//
//   node tools/hedge-desk-test.mjs

import assert from 'node:assert/strict';
import {
  HEDGE_DURATIONS, UNWIND_HAIRCUT, expectedMeanIndex, hedgeLockedPrice,
  effectiveFuelMultiplier, hedgeWeights, hedgeWeekSavings, hedgeUnwindQuote,
  settleHedgeWeek, foldHedgeOutcome, hedgeOutcome, emptyHedgeStats, absoluteWeek,
} from '../packages/engine/src/utils/fuel.js';
import { hedgeUnwindDollars, hedgeScoreboard, fuelImpact } from '../packages/engine/src/utils/fuelImpact.js';
import { gameReducer } from '../packages/engine/index.mjs';
import { runScenario, makeRng } from './golden-master/harness.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const byId = (id) => HEDGE_DURATIONS.find(o => o.id === id);

// ── Phase 1: the desk ───────────────────────────────────────────────────────

test('premiums are the price of certainty, not a coin-toss entry fee', () => {
  assert.deepEqual(HEDGE_DURATIONS.map(o => [o.id, o.weeks, o.premium]), [
    ['short', 8, 0.015], ['medium', 13, 0.025], ['long', 26, 0.04], ['year', 52, 0.06],
  ]);
});

test('the 52-week product outlasts a Heavy-Landing-length excursion', () => {
  const year = byId('year');
  assert.ok(year && year.weeks === 52 && year.label === '52-week');
  // 30 game weeks at ≥1.25× is what nobody could hedge through in September.
  assert.ok(year.weeks > 30);
});

test('a 52-week lock at spot 1.38 prices off a year of reversion', () => {
  // decay(52) ≈ 0.289 → expected ≈ 1.110 → × 1.06 ≈ 1.177
  const lock = hedgeLockedPrice(1.38, byId('year'));
  assert.ok(near(lock, 1.177, 0.002), `got ${lock}`);
  assert.ok(lock < hedgeLockedPrice(1.38, byId('long')), 'a year reverts further than 26 weeks');
});

test("LtFrosty's 26-week lock at 1.38 is now a 4% bet, not a 10% one", () => {
  const spot = 1.38, opt = byId('long');
  const expected = expectedMeanIndex(spot, opt.weeks);
  const lock = hedgeLockedPrice(spot, opt);
  assert.ok(near(lock / expected, 1.04, 0.001));
  assert.ok(lock < 1.24, `lock ${lock} should sit well below the old ~1.30`);
});

// ── Phase 1: unwind ─────────────────────────────────────────────────────────

const contract = (over = {}) => ({
  id: 'c1', durationId: 'long', durationLabel: '26-week', coverage: 0.5,
  lockedPrice: 1.0, marketAtPurchase: 1.0, startAbsWeek: 10, expiryAbsWeek: 36, weeksTotal: 26,
  ...over,
});

test('buy-then-unwind round-trips to exactly −(premium + haircut) × notional', () => {
  // No arbitrage: the desk buys back on the same curve it sells on.
  const spot = 1.20, opt = byId('long');
  const locked = hedgeLockedPrice(spot, opt);
  const c = contract({ lockedPrice: locked, startAbsWeek: 10, expiryAbsWeek: 10 + opt.weeks });
  const q = hedgeUnwindQuote({ contract: c, marketIndex: spot, curAbsWeek: 10, baseBill: 10_000_000, hedges: [c] });
  const expected = expectedMeanIndex(spot, opt.weeks);
  const notional = 10_000_000 * 0.5 * opt.weeks;
  const predicted = -notional * (expected * opt.premium + UNWIND_HAIRCUT);
  assert.equal(q.remaining, opt.weeks);
  // The lock is stored to three decimals, so the closed form is met to
  // within half a thousandth of the notional — not to the dollar.
  assert.ok(near(q.settlement, predicted, notional * 0.0005 + 2),
    `settlement ${q.settlement} vs predicted ${predicted.toFixed(0)}`);
  assert.ok(q.settlement < 0, 'a round trip must lose money');
  // And it is the STORED lock the desk buys back, to the dollar.
  assert.ok(near(q.settlement, notional * (expected - locked) - notional * UNWIND_HAIRCUT, 2));
});

test('an in-the-money contract pays out when unwound into a spike', () => {
  const c = contract({ lockedPrice: 0.95 });
  const q = hedgeUnwindQuote({ contract: c, marketIndex: 1.40, curAbsWeek: 16, baseBill: 10_000_000, hedges: [c] });
  assert.equal(q.remaining, 20);
  assert.ok(q.mtm > 0 && q.settlement > 0, `mtm ${q.mtm}, settlement ${q.settlement}`);
  assert.ok(q.settlement < q.mtm, 'the haircut comes off the top');
});

test('an underwater contract costs cash to exit', () => {
  const c = contract({ lockedPrice: 1.30 });
  const q = hedgeUnwindQuote({ contract: c, marketIndex: 0.80, curAbsWeek: 16, baseBill: 10_000_000, hedges: [c] });
  assert.ok(q.settlement < 0);
});

test('an expired contract has nothing to unwind', () => {
  const c = contract();
  assert.equal(hedgeUnwindQuote({ contract: c, marketIndex: 1.0, curAbsWeek: 36, baseBill: 1e6, hedges: [c] }), null);
  assert.equal(hedgeUnwindQuote({ contract: c, marketIndex: 1.0, curAbsWeek: 99, baseBill: 1e6, hedges: [c] }), null);
});

test('effective coverage in the quote is the same share the blend charges', () => {
  // Stacked past 100%: 0.75 + 0.5 raw → each scaled by 1/1.25.
  const a = contract({ id: 'a', coverage: 0.75, lockedPrice: 1.1 });
  const b = contract({ id: 'b', coverage: 0.5,  lockedPrice: 0.9 });
  const w = hedgeWeights([a, b]);
  assert.ok(near(w.effOf(a), 0.6, 1e-9) && near(w.effOf(b), 0.4, 1e-9));
  const q = hedgeUnwindQuote({ contract: a, marketIndex: 1.0, curAbsWeek: 16, baseBill: 1e6, hedges: [a, b] });
  assert.ok(near(q.covEff, 0.6, 1e-9));
});

// A minimal state the dollar helpers can price against: one flown week.
function priceableState(over = {}) {
  return {
    year: 1, week: 20, cash: 50_000_000,
    fuelPrice: { index: 1.40, history: [] },
    financialHistory: [{ label: 'w19', week: 19, year: 1, fuel: 14_000_000, fuelIndex: 1.40, revenue: 50e6, profit: 1e6 }],
    hedgeContracts: [],
    ...over,
  };
}

test('UNWIND_HEDGE settles the quoted amount, removes the contract and records the outcome', () => {
  const c = contract({ lockedPrice: 0.95, startAbsWeek: 10, expiryAbsWeek: 36, realizedSavings: 1_200_000 });
  const s0 = priceableState({ hedgeContracts: [c] });
  const q = hedgeUnwindDollars(s0, 'c1');
  assert.ok(q && q.settlement > 0, 'in the money at 1.40 vs 0.95');
  const s1 = gameReducer(s0, { type: 'UNWIND_HEDGE', id: 'c1' });
  assert.equal(s1.cash, s0.cash + q.settlement, 'cash moves by exactly the quote');
  assert.equal(s1.hedgeContracts.length, 0);
  assert.equal(s1.hedgeStats.contractsClosed, 1);
  assert.equal(s1.hedgeStats.wins, 1);
  assert.equal(s1.hedgeStats.recent[0].reason, 'unwound');
  assert.equal(s1.hedgeStats.recent[0].total, 1_200_000 + q.settlement);
  assert.equal(s1.hedgeStats.lifetimeSavings, 1_200_000 + q.settlement);
});

test('UNWIND_HEDGE refuses to overdraw the airline', () => {
  const c = contract({ lockedPrice: 1.60, startAbsWeek: 10, expiryAbsWeek: 36 });
  const s0 = priceableState({ cash: 100_000, fuelPrice: { index: 0.80, history: [] }, hedgeContracts: [c] });
  const q = hedgeUnwindDollars(s0, 'c1');
  assert.ok(q && q.settlement < 0 && !q.canAfford);
  const s1 = gameReducer(s0, { type: 'UNWIND_HEDGE', id: 'c1' });
  assert.equal(s1, s0, 'state must be returned untouched');
});

test('UNWIND_HEDGE ignores an unknown id and an airline that has not flown', () => {
  const c = contract();
  const s0 = priceableState({ hedgeContracts: [c] });
  assert.equal(gameReducer(s0, { type: 'UNWIND_HEDGE', id: 'nope' }), s0);
  const unflown = priceableState({ financialHistory: [], hedgeContracts: [c] });
  assert.equal(gameReducer(unflown, { type: 'UNWIND_HEDGE', id: 'c1' }), unflown);
});

// ── Phase 2: scoreboard arithmetic ──────────────────────────────────────────

test('weekly savings sum to the gap between the unhedged and the paid bill', () => {
  // The accounting identity: Σ savings_i ≡ baseBill × totalCov × (index − weightedLocked).
  const a = contract({ id: 'a', coverage: 0.75, lockedPrice: 1.10 });
  const b = contract({ id: 'b', coverage: 0.50, lockedPrice: 0.90 });
  const index = 1.30, baseBill = 10_000_000;
  const savings = hedgeWeekSavings([a, b], index, baseBill);
  const paid   = baseBill * effectiveFuelMultiplier(index, [a, b]);
  const market = baseBill * index;
  const total  = savings.get('a') + savings.get('b');
  assert.ok(near(total, market - paid, 2000), `Σ ${total} vs ${(market - paid).toFixed(0)}`);
});

test('a contract locked below market saves; one locked above costs', () => {
  const lo = contract({ id: 'lo', lockedPrice: 0.9 });
  const hi = contract({ id: 'hi', lockedPrice: 1.3 });
  const s = hedgeWeekSavings([lo, hi], 1.1, 1e6);
  assert.ok(s.get('lo') > 0 && s.get('hi') < 0);
});

test('settleHedgeWeek credits live contracts and folds the expired ones', () => {
  const live    = contract({ id: 'live', lockedPrice: 1.0, realizedSavings: 500 });
  const expired = contract({ id: 'gone', lockedPrice: 0.9, realizedSavings: 2_000_000, expiryAbsWeek: 20 });
  const r = settleHedgeWeek({ prior: [live, expired], active: [live], marketIndex: 1.2, baseBill: 1e6, stats: null, closedAbsWeek: 20 });
  assert.equal(r.contracts.length, 1);
  assert.equal(r.contracts[0].realizedSavings, 500 + Math.round(1e6 * 0.5 * 0.2));
  assert.equal(r.closed.length, 1);
  assert.equal(r.stats.contractsClosed, 1);
  assert.equal(r.stats.wins, 1);
  assert.equal(r.stats.lifetimeSavings, 2_000_000);
  assert.equal(r.stats.recent[0].id, 'gone');
  assert.equal(r.stats.recent[0].reason, 'expired');
});

test('a save that has never hedged gains no scoreboard key', () => {
  const r = settleHedgeWeek({ prior: [], active: [], marketIndex: 1.2, baseBill: 1e6, stats: null, closedAbsWeek: 20 });
  assert.equal(r.stats, null);
  assert.deepEqual(r.contracts, []);
});

test('the lifetime record keeps the last five closed contracts', () => {
  let s = emptyHedgeStats();
  for (let i = 0; i < 8; i++) {
    s = foldHedgeOutcome(s, hedgeOutcome(contract({ id: `c${i}`, realizedSavings: i % 2 ? 1 : -1 }), { closedAbsWeek: 36 }));
  }
  assert.equal(s.contractsClosed, 8);
  assert.equal(s.wins, 4);
  assert.equal(s.losses, 4);
  assert.equal(s.recent.length, 5);
  assert.equal(s.recent[4].id, 'c7');
});

// ── Phase 2: through the real tick ──────────────────────────────────────────

test('ADVANCE_WEEK accumulates realizedSavings and records the blended multiplier', () => {
  // The golden scenario, then a hedge, then one more week — under the same
  // determinism the golden master uses.
  const s60 = runScenario({ weeks: 60 });
  const origRandom = Math.random;
  Math.random = makeRng(0xBEEF);
  try {
    const bought = gameReducer(s60, { type: 'BUY_HEDGE', durationId: 'year', coverage: 0.5 });
    assert.equal(bought.hedgeContracts.length, 1);
    const c = bought.hedgeContracts[0];
    assert.equal(c.weeksTotal, 52);
    assert.ok(!('realizedSavings' in c), 'nothing is realized at purchase');

    const s = gameReducer(bought, { type: 'ADVANCE_WEEK' });
    const h = s.hedgeContracts[0];
    assert.ok(Number.isFinite(h.realizedSavings), 'the tick wrote realizedSavings');

    // Reproduce the tick's own arithmetic from what it recorded.
    const rep = s.lastReport;
    const baseBill = rep.totalFuel / rep.fuelMultiplier;
    const predicted = Math.round(baseBill * 0.5 * (rep.fuelIndex - c.lockedPrice));
    assert.equal(h.realizedSavings, predicted, `realized ${h.realizedSavings} vs predicted ${predicted}`);

    const entry = s.financialHistory[s.financialHistory.length - 1];
    assert.ok(Number.isFinite(entry.fuelMultiplier), 'hedged week records its blended multiplier');
    assert.ok(near(entry.fuelMultiplier, rep.fuelMultiplier, 1e-9));
    assert.ok(entry.fuelMultiplier !== entry.fuelIndex, 'and it differs from the market index');

    // fuelImpact's reconstruction agrees with the tick.
    const fi = fuelImpact(s, { lookbacks: [] });
    assert.ok(near(fi.hedgeSaved, h.realizedSavings, 2), `fuelImpact ${fi.hedgeSaved} vs tick ${h.realizedSavings}`);

    // The scoreboard reads it back.
    const sb = hedgeScoreboard(s);
    assert.equal(sb.active.length, 1);
    assert.equal(sb.active[0].realized, h.realizedSavings);
    assert.equal(sb.openSavings, h.realizedSavings);
    assert.ok(!('hedgeStats' in s), 'nothing closed yet, so no scoreboard key');
  } finally {
    Math.random = origRandom;
  }
});

test('an unhedged week records no fuelMultiplier (golden-master hygiene)', () => {
  const s = runScenario({ weeks: 3 });
  for (const e of s.financialHistory) assert.ok(!('fuelMultiplier' in e), 'unhedged entries stay as they were');
  assert.ok(!('hedgeStats' in s));
});

test('a contract that expires is folded into hedgeStats by the tick', () => {
  const s60 = runScenario({ weeks: 60 });
  const origRandom = Math.random;
  Math.random = makeRng(0xF00D);
  try {
    let s = gameReducer(s60, { type: 'BUY_HEDGE', durationId: 'short', coverage: 0.25 });
    const bought = s.hedgeContracts[0];
    for (let w = 0; w < 9; w++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    assert.equal(s.hedgeContracts.length, 0, 'the 8-week contract has left the live list');
    assert.ok(s.hedgeStats, 'the scoreboard exists once something closed');
    assert.equal(s.hedgeStats.contractsClosed, 1);
    assert.equal(s.hedgeStats.recent[0].id, bought.id);
    assert.equal(s.hedgeStats.wins + s.hedgeStats.losses, s.hedgeStats.recent[0].total === 0 ? 0 : 1);
    assert.equal(s.hedgeStats.lifetimeSavings, s.hedgeStats.recent[0].total);
    assert.equal(absoluteWeek(s.year, s.week) >= bought.expiryAbsWeek, true);
  } finally {
    Math.random = origRandom;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
