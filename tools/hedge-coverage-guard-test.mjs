// Hedge coverage is a fraction, and every layer now says so.
//
// BUY_HEDGE is on the multiplayer allow-list, costs no cash, and stored
// `action.coverage` verbatim. The only screen it passed through was
// assertFinitePayload, which rejects non-finite NUMBERS and anything over 1e10 —
// so -1000 and 1000.1 were both accepted, 201, free.
//
// effectiveFuelMultiplier divides the coverage-weighted locked price by the
// SIGNED sum of coverages, and its `rawCoverage <= 0` guard never fires when the
// signed sum is a small positive. Two contracts of DIFFERENT durations (so their
// locked prices differ) at -1000 and +1000.1 produced a fuel multiplier of
// -68.997: every passenger, tag and cargo route booked a large NEGATIVE fuel
// cost, week after week, for the life of the longer contract.
//
// Three layers, because a world that has already been exploited carries the
// poisoned contracts in its saved blob — guarding only the entry point would
// leave those airlines minting money forever:
//   1. reducer  — refuses a coverage that is not a finite fraction in (0, 1]
//   2. guard    — multiplayer payloads must name a coverage the game offers
//   3. fuel.js  — sanitises stored contracts, so a poisoned blob self-heals
//
//   node tools/hedge-coverage-guard-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  effectiveFuelMultiplier, hedgeLockedPrice, HEDGE_DURATIONS, HEDGE_COVERAGES,
} from '../packages/engine/src/utils/fuel.js';
import { prepareWeek } from '../packages/engine/src/utils/tickPrep.js';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;

function baseState() {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Hedge Air', hub: 'JFK', enableObjectives: false });
  return { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
}

const short = HEDGE_DURATIONS.find(o => o.id === 'short');
const long  = HEDGE_DURATIONS.find(o => o.id === 'long');

// ── 1. The reducer refuses a coverage that is not a fraction ──────────────────

for (const bad of [-1000, 1000.1, 0, -0.5, 1.5, NaN, Infinity, null, undefined, {}, '', 'abc']) {
  test(`BUY_HEDGE refuses coverage ${JSON.stringify(bad)}`, () => {
    const s = baseState();
    const n = gameReducer(s, { type: 'BUY_HEDGE', durationId: 'long', coverage: bad });
    assert.equal((n.hedgeContracts ?? []).length, 0,
      `stored a contract at coverage ${JSON.stringify(bad)}`);
  });
}

test('a numeric string coverage is coerced, not stored as a string', () => {
  // Not a rejection case: '0.75' is a legal fraction once coerced, and what the
  // blob must never hold is a non-number. assertFinitePayload only inspects
  // values that are already numbers, so this is the shape that used to walk in.
  const n = gameReducer(baseState(), { type: 'BUY_HEDGE', durationId: 'long', coverage: '0.75' });
  assert.equal(n.hedgeContracts.length, 1);
  assert.strictEqual(n.hedgeContracts[0].coverage, 0.75);
});

test('BUY_HEDGE still accepts every coverage the game offers', () => {
  for (const cov of HEDGE_COVERAGES) {
    const n = gameReducer(baseState(), { type: 'BUY_HEDGE', durationId: 'medium', coverage: cov });
    assert.equal((n.hedgeContracts ?? []).length, 1, `legit coverage ${cov} was refused`);
    assert.equal(n.hedgeContracts[0].coverage, cov);
  }
});

// ── 2. The multiplayer guard bounds the payload at the API boundary ───────────

test('guardDecision rejects a forged BUY_HEDGE coverage', () => {
  for (const bad of [-1000, 1000.1, 0, 2, NaN]) {
    assert.throws(
      () => guardDecision('BUY_HEDGE', { durationId: 'long', coverage: bad }, baseState()),
      GuardError,
      `guard let coverage ${bad} through`);
  }
});

test('guardDecision rejects an unknown hedge duration', () => {
  assert.throws(
    () => guardDecision('BUY_HEDGE', { durationId: 'forever', coverage: 0.75 }, baseState()),
    GuardError);
});

test('guardDecision passes a legitimate hedge through unchanged', () => {
  const out = guardDecision('BUY_HEDGE', { durationId: 'long', coverage: 0.75 }, baseState());
  assert.equal(out.durationId, 'long');
  assert.equal(out.coverage, 0.75);
});

// ── 3. The fuel model sanitises contracts already sitting in a blob ───────────

test('the two-contract exploit cannot drive the multiplier negative', () => {
  const poisoned = [
    { coverage: -1000,  lockedPrice: hedgeLockedPrice(1.0, long) },
    { coverage: 1000.1, lockedPrice: hedgeLockedPrice(1.0, short) },
  ];
  const mult = effectiveFuelMultiplier(1.0, poisoned);
  assert.ok(mult > 0, `fuel multiplier went non-positive: ${mult}`);
  assert.ok(mult <= 1.2, `fuel multiplier is implausibly high: ${mult}`);
});

test('a poisoned contract cannot produce a negative fuel multiplier at any index', () => {
  for (const index of [0.7, 1.0, 1.35, 1.6]) {
    for (const cov of [-1000, -0.5, 1e9, NaN, Infinity, null, undefined]) {
      const mult = effectiveFuelMultiplier(index, [
        { coverage: cov, lockedPrice: 1.03 },
        { coverage: 0.5, lockedPrice: 0.98 },
      ]);
      assert.ok(Number.isFinite(mult) && mult > 0,
        `index ${index}, coverage ${cov} → ${mult}`);
    }
  }
});

test('legitimate hedges are unchanged', () => {
  // The number this file must not move: 25% at market 1.35, 75% locked at 1.00.
  assert.equal(effectiveFuelMultiplier(1.35, [{ coverage: 0.75, lockedPrice: 1.0 }]), 1.0875);
  assert.equal(effectiveFuelMultiplier(1.0, []), 1.0);
  // Stacking past 100% still normalises the weighted average and caps coverage.
  const stacked = effectiveFuelMultiplier(1.4, [
    { coverage: 0.75, lockedPrice: 1.0 },
    { coverage: 0.5,  lockedPrice: 1.2 },
  ]);
  assert.equal(stacked, 1.08);
});

// ── 4. End to end: the week's fuel bill stays positive ────────────────────────

test('a poisoned blob books a positive fuel bill on the next tick', () => {
  const s = {
    ...baseState(),
    hedgeContracts: [
      { id: 'h1', durationId: 'long',  coverage: -1000,  lockedPrice: hedgeLockedPrice(1.0, long),
        startAbsWeek: 0, expiryAbsWeek: 9999, weeksTotal: 26 },
      { id: 'h2', durationId: 'short', coverage: 1000.1, lockedPrice: hedgeLockedPrice(1.0, short),
        startAbsWeek: 0, expiryAbsWeek: 9999, weeksTotal: 8 },
    ],
  };
  const prep = prepareWeek(s);
  assert.ok(prep.fuelMultiplier > 0,
    `prepareWeek handed the tick a negative fuel multiplier: ${prep.fuelMultiplier}`);
});

Math.random = realRandom;
console.log(`\nhedge coverage guard: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
