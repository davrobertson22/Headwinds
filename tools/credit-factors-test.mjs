// A credit grade a player cannot account for reads as a bug even when it is right.
//
// A player asked in Discord why their rating fell: largest airline in the world,
// most profitable by 3x, never missed a payment, never went cash-negative — and
// the grade dropped anyway. The model was correct. A string of world events put
// the four-week average net income below zero, which is -25, and the burn
// against cash was worth another -15 or -30 depending on the buffer. Every one
// of those deductions was invisible. The Finance panel showed a letter and a
// word ("B · Good") and nothing else, so the only way to find out what the
// lender objected to was to ask the developer.
//
// `creditFactors` publishes the line items behind the number: what was checked,
// what it cost, and why. `creditScore` is now the sum of them, so the panel and
// the rating can never drift apart — the explanation IS the calculation.
//
// Verified failing on HEAD before the fix: two airlines whose problems have
// nothing in common (one profitable-but-geared, one shocked-but-solvent) both
// scored exactly 75, and nothing in the public API could tell them apart.
//
//   node tools/credit-factors-test.mjs

import assert from 'node:assert/strict';
import {
  creditFactors, creditScore, creditRating, CREDIT_WINDOW_WEEKS,
} from '../packages/engine/src/data/credit.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const history = (n, revenue, profit) =>
  Array.from({ length: n }, (_, i) => ({ week: i + 1, year: 1, revenue, profit }));

const airline = (over = {}) => ({
  cash: 60_000_000, fleet: [], loans: [], paidInCapital: 10_000_000,
  financialHistory: history(30, 5_000_000, 900_000),
  ...over,
});

const by = (state, id) => creditFactors(state).factors.find(f => f.id === id);

console.log('\n── The breakdown reconciles ─────────────────────────────');

test('every factor list sums to exactly the published score', () => {
  const cases = [
    airline(),
    airline({ financialHistory: history(30, 5e6, -900_000), cash: 2e6 }),
    airline({ financialHistory: [] }),
    airline({ financialHistory: history(2, 5e6, 100_000) }),
    airline({ loans: [{ interestRate: 0.1, weeksRemaining: 400, weeklyPayment: 900_000 }] }),
    airline({ fleet: [{ ownershipType: 'leased', weeklyLease: 800_000 }] }),
  ];
  for (const state of cases) {
    const f = creditFactors(state);
    const summed = Math.max(0, Math.min(100, f.factors.reduce((s, x) => s + x.delta, 100)));
    assert.equal(summed, f.score, `factors sum to ${summed}, score says ${f.score}`);
    assert.equal(f.score, creditScore(state), 'creditScore disagrees with creditFactors');
    assert.equal(f.score, creditRating(state).score, 'creditRating disagrees with creditFactors');
  }
});

test('two airlines that score the same for different reasons are distinguishable', () => {
  const shockedButSolvent = airline({
    financialHistory: [...history(96, 300e6, 45e6), ...history(4, 275e6, -63.8e6)],
    cash: 800e6,
  });
  const youngButLevered = airline({
    financialHistory: history(8, 40e6, 6e6), cash: 50e6,
    loans: [{ interestRate: 0.10, weeksRemaining: 500, weeklyPayment: 500_000 }],
  });
  // Same grade — this is the collision that made the Discord question unanswerable.
  assert.equal(creditScore(shockedButSolvent), creditScore(youngButLevered));

  // …and now the reasons are legible, and they are different reasons.
  assert.equal(by(shockedButSolvent, 'earnings').delta, -25);
  assert.equal(by(shockedButSolvent, 'leverage').delta, 0);
  assert.equal(by(youngButLevered, 'earnings').delta, 0);
  assert.equal(by(youngButLevered, 'leverage').delta, -20);
  assert.equal(by(youngButLevered, 'history').delta, -5);
});

console.log('\n── The player\'s actual question ─────────────────────────');

test('a profitable giant knocked negative by world events loses exactly the earnings check', () => {
  const kat = airline({
    financialHistory: [...history(96, 300e6, 45e6), ...history(4, 275e6, -63.8e6)],
    cash: 800e6,
  });
  assert.equal(by(kat, 'earnings').delta, -25,
    'a negative four-week average is the deduction, and it must say so');
  assert.match(by(kat, 'earnings').detail, /negative/i);
  // Never missed a payment, never went cash-negative — and neither of those is
  // what the lender objected to. The breakdown has to make that visible.
  assert.equal(by(kat, 'leverage').delta, 0, 'no debt problem');
  assert.equal(by(kat, 'runway').delta, 0, '$800M against a $63.8M burn is 12.5 weeks');
  assert.equal(by(kat, 'history').delta, 0, '100 weeks of trading is a track record');
});

test('the same airline recovers in full once the window clears', () => {
  const shocked = [...history(96, 300e6, 45e6), ...history(4, 275e6, -63.8e6)];
  const recovered = { ...airline({ financialHistory: [...shocked, ...history(CREDIT_WINDOW_WEEKS, 320e6, 57e6)], cash: 600e6 }) };
  assert.equal(creditScore(recovered), 100, 'the rating must come all the way back');
  assert.equal(creditRating(recovered).grade, 'A');
  for (const f of creditFactors(recovered).factors) {
    assert.equal(f.delta, 0, `${f.label} still deducting after recovery`);
  }
});

test('a thin cash buffer is charged separately from the loss that caused it', () => {
  const burning = airline({
    financialHistory: [...history(96, 300e6, 45e6), ...history(4, 275e6, -63.8e6)],
    cash: 150e6,
  });
  assert.equal(by(burning, 'earnings').delta, -25);
  assert.equal(by(burning, 'runway').delta, -30, '$150M against a $63.8M burn is under 4 weeks');
  assert.equal(creditScore(burning), 45);
});

console.log('\n── The breakdown explains itself ────────────────────────');

test('every factor carries a label and a human-readable reason', () => {
  for (const state of [airline(), airline({ financialHistory: [] }), airline({ cash: 1e6, financialHistory: history(30, 5e6, -2e6) })]) {
    const f = creditFactors(state);
    assert.equal(f.factors.length, 4, 'leverage, earnings, runway, track record');
    for (const x of f.factors) {
      assert.ok(x.id && x.label, 'a factor needs an id and a label');
      assert.ok(typeof x.detail === 'string' && x.detail.length > 10, `no reason given for ${x.id}`);
      assert.ok(typeof x.delta === 'number' && x.delta <= 0, 'deductions only');
    }
  }
});

test('the window length is published, because that is what "when does it recover" means', () => {
  const f = creditFactors(airline());
  assert.equal(f.windowWeeks, CREDIT_WINDOW_WEEKS);
  assert.ok(f.inputs.weeksOps > 0 && Number.isFinite(f.inputs.weeklyNetIncome));
  assert.ok('debtToEquity' in f.inputs && 'runway' in f.inputs);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
