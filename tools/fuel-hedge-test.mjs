// Fuel economy v2: hedging as insurance, events inside the index, disruptions
// that disrupt.
//
// Three defects that were really one — the fuel system had a price model, a
// hedging model and an event system that did not agree with each other.
//
// A2. `hedgeLockedPrice` = spot × (1 + premium). The walk mean-reverts to 1.0
//     in plain sight, so below ~0.93 a lock was guaranteed to beat the expected
//     path and above it guaranteed to lose. "Hedge to the cap when fuel is
//     cheap, otherwise never" is arithmetic, not a decision.
//
// A3. Event fuel shocks multiplied the blended rate AFTER hedging, so being
//     100% hedged through a +30% spike did nothing — the one moment a hedge
//     exists for — and the price paid disagreed with the fuel chart on screen.
//
// A11. Disruption events moved demand only. During a volcanic ash cloud the
//     airline ran a flawless schedule to 30% fewer passengers.
//
//   node tools/fuel-hedge-test.mjs

import assert from 'node:assert/strict';
import {
  tickFuelPrice, clampFuelIndex, expectedMeanIndex, hedgeLockedPrice,
  effectiveFuelMultiplier, HEDGE_DURATIONS,
  FUEL_MEAN_REVERSION, FUEL_BASE_INDEX, FUEL_MIN_INDEX, FUEL_MAX_INDEX,
} from '../packages/engine/src/utils/fuel.js';
import { laborEffects, DEFAULT_LABOR_STATE } from '../packages/engine/src/data/labor.js';
import { EVENT_TEMPLATES } from '../packages/engine/src/data/events.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** Average index actually realised over `weeks`, from many seeded walks. */
function simulateMeanIndex(spot, weeks, runs = 4000) {
  let total = 0;
  for (let r = 0; r < runs; r++) {
    let idx = spot, sum = 0;
    for (let w = 0; w < weeks; w++) { idx = tickFuelPrice(idx); sum += idx; }
    total += sum / weeks;
  }
  return total / runs;
}

// ── The expected path ───────────────────────────────────────────────────────

test('the expected-mean formula matches what the walk actually does', () => {
  // The whole model rests on this. If the closed form and the simulation
  // disagree, hedges are mispriced in a way no play-testing would surface.
  for (const [spot, weeks] of [[0.75, 26], [1.40, 13], [0.90, 8], [1.10, 26]]) {
    const closed = expectedMeanIndex(spot, weeks);
    const walked = simulateMeanIndex(spot, weeks);
    assert.ok(near(closed, walked, 0.02),
      `spot ${spot} over ${weeks}w: formula ${closed.toFixed(4)} vs simulated ${walked.toFixed(4)}`);
  }
});

test('the expected mean sits between today and the long-run mean', () => {
  assert.ok(expectedMeanIndex(0.70, 26) > 0.70 && expectedMeanIndex(0.70, 26) < FUEL_BASE_INDEX);
  assert.ok(expectedMeanIndex(1.50, 26) < 1.50 && expectedMeanIndex(1.50, 26) > FUEL_BASE_INDEX);
});

test('a longer horizon reverts further', () => {
  const short = expectedMeanIndex(0.70, 8);
  const long  = expectedMeanIndex(0.70, 26);
  assert.ok(long > short, `26w (${long}) should sit closer to 1.0 than 8w (${short})`);
});

test('at the long-run mean there is nothing to revert to', () => {
  assert.ok(near(expectedMeanIndex(FUEL_BASE_INDEX, 26), FUEL_BASE_INDEX, 1e-9));
});

test('a zero-week horizon is just today', () => {
  assert.equal(expectedMeanIndex(0.8, 0), 0.8);
});

// ── A2: hedging costs the premium, in both directions ───────────────────────

test('a hedge in cheap fuel is no longer free money', () => {
  // THE defect. At 0.75 the old lock was 0.825 against an expected average of
  // ~0.88 — a guaranteed win before the player made any judgement at all.
  const spot = 0.75;
  const opt  = HEDGE_DURATIONS.find(o => o.weeks === 26);
  const expected = expectedMeanIndex(spot, opt.weeks);
  const locked   = hedgeLockedPrice(spot, opt);
  assert.ok(locked > expected,
    `locking ${locked} against an expected ${expected.toFixed(3)} must cost, not pay`);
  assert.ok(near(locked, expected * (1 + opt.premium), 0.002),
    'the only gap should be the stated premium');
  const oldLock = spot * (1 + opt.premium);
  assert.ok(oldLock < expected, 'sanity: the old formula really was +EV here');
});

test('a hedge in expensive fuel is worth having', () => {
  // The mirror image, and the reason the old model made hedging pointless in a
  // crisis: spot × premium was always ABOVE the expected path, so the one time
  // an airline genuinely wants certainty was the one time it was a bad deal.
  const spot = 1.45;
  const opt  = HEDGE_DURATIONS.find(o => o.weeks === 26);
  const locked = hedgeLockedPrice(spot, opt);
  assert.ok(locked < spot, `a lock at ${locked} should undercut a spot of ${spot}`);
  assert.ok(locked > expectedMeanIndex(spot, opt.weeks), 'but still cost the premium');
});

test('every duration charges its premium over the expected path', () => {
  for (const opt of HEDGE_DURATIONS) {
    for (const spot of [0.6, 0.8, 1.0, 1.3, 1.8]) {
      const expected = expectedMeanIndex(spot, opt.weeks);
      const locked   = hedgeLockedPrice(spot, opt);
      assert.ok(locked >= expected,
        `${opt.label} at spot ${spot}: locked ${locked} < expected ${expected.toFixed(3)}`);
    }
  }
});

test('no duration is a free lunch at any index in the band', () => {
  // Sweep the whole legal range: there must be no index where locking beats the
  // expected path. That is what "solved arbitrage" meant.
  let freeLunches = 0;
  for (let spot = FUEL_MIN_INDEX; spot <= FUEL_MAX_INDEX; spot += 0.01) {
    for (const opt of HEDGE_DURATIONS) {
      if (hedgeLockedPrice(spot, opt) < expectedMeanIndex(spot, opt.weeks)) freeLunches++;
    }
  }
  assert.equal(freeLunches, 0, `${freeLunches} (index, duration) pairs still pay to hedge`);
});

// ── A3: the shock is in the index, so a hedge covers it ─────────────────────

test('a fully hedged airline is insulated from a fuel spike', () => {
  const hedge = [{ coverage: 1.0, lockedPrice: 0.95 }];
  const calm  = effectiveFuelMultiplier(clampFuelIndex(1.0), hedge);
  const spike = effectiveFuelMultiplier(clampFuelIndex(1.0 * 1.30), hedge);
  assert.equal(calm, spike, 'full coverage must not feel a spike at all');
  // Under the old arrangement the event multiplied the blended rate AFTER the
  // hedge, which is what this reproduces:
  const oldWay = effectiveFuelMultiplier(1.0, hedge) * 1.30;
  assert.ok(oldWay > spike, 'sanity: the old path charged the hedged airline the spike');
});

test('an unhedged airline feels the whole spike', () => {
  const bare = effectiveFuelMultiplier(clampFuelIndex(1.0 * 1.30), []);
  assert.ok(near(bare, 1.30, 0.001));
});

test('a half-hedged airline feels half of it', () => {
  const hedge = [{ coverage: 0.5, lockedPrice: 1.0 }];
  const shocked = effectiveFuelMultiplier(clampFuelIndex(1.0 * 1.40), hedge);
  assert.ok(near(shocked, 0.5 * 1.0 + 0.5 * 1.40, 0.002), `got ${shocked}`);
});

test('a shocked index still cannot leave the model\'s band', () => {
  assert.equal(clampFuelIndex(1.8 * 1.35), FUEL_MAX_INDEX);
  assert.equal(clampFuelIndex(0.6 * 0.5), FUEL_MIN_INDEX);
});

test('the walk itself is clamped by the same helper', () => {
  for (let i = 0; i < 200; i++) {
    const v = tickFuelPrice(1.89);
    assert.ok(v >= FUEL_MIN_INDEX && v <= FUEL_MAX_INDEX, `walked out of band: ${v}`);
  }
});

// ── A11: a disruption disrupts ──────────────────────────────────────────────

test('an on-time rate falls when the week is disrupted', () => {
  const calm      = laborEffects(DEFAULT_LABOR_STATE, 0.6, 70);
  const disrupted = laborEffects({ ...DEFAULT_LABOR_STATE, eventOtpDelta: 0.18 }, 0.6, 70);
  assert.ok(disrupted.onTimeRate < calm.onTimeRate,
    `${disrupted.onTimeRate} should trail ${calm.onTimeRate}`);
  assert.ok(near(calm.onTimeRate - disrupted.onTimeRate, 0.18, 0.001));
});

test('a disrupted week never drives punctuality below the model floor', () => {
  const wrecked = laborEffects({ ...DEFAULT_LABOR_STATE, eventOtpDelta: 0.9 }, 1.0, 10);
  assert.ok(wrecked.onTimeRate >= 0.35);
});

test('no delta, no change — every existing caller is unaffected', () => {
  const a = laborEffects(DEFAULT_LABOR_STATE, 0.6, 70);
  const b = laborEffects({ ...DEFAULT_LABOR_STATE, eventOtpDelta: 0 }, 0.6, 70);
  assert.deepEqual(a, b);
  const c = laborEffects({ ...DEFAULT_LABOR_STATE, eventOtpDelta: undefined }, 0.6, 70);
  assert.deepEqual(a, c);
});

test('a negative or junk delta cannot be used to BUY punctuality', () => {
  const calm = laborEffects(DEFAULT_LABOR_STATE, 0.6, 70);
  for (const junk of [-0.5, 'lots', NaN, null]) {
    assert.equal(laborEffects({ ...DEFAULT_LABOR_STATE, eventOtpDelta: junk }, 0.6, 70).onTimeRate,
      calm.onTimeRate, `eventOtpDelta ${junk} moved the on-time rate`);
  }
});

// The `disruption` type tag is broader than "delays flights": a pandemic scare
// and a travel advisory are demand shocks that happen to be filed under it.
// These are the events where aeroplanes genuinely do not depart on time.
const OPERATIONAL = ['lhr_strike', 'weather_us', 'tech_outage', 'volcanic_ash', 'natural_disaster'];

test('the events that ground aeroplanes carry an operational hit', () => {
  for (const id of OPERATIONAL) {
    const t = EVENT_TEMPLATES.find(x => x.id === id);
    assert.ok(t, `${id} is missing from the catalogue`);
    const { effects } = t.generate();
    assert.ok((effects.otpDelta ?? 0) > 0, `${id} still only touches demand`);
    assert.ok(effects.otpDelta <= 0.25, `${id}'s otpDelta is out of proportion`);
  }
});

test('events that only scare passengers away do NOT delay flights', () => {
  // A recession, a pandemic scare and a travel advisory all cut bookings
  // without making a single departure late. If everything got an otpDelta the
  // field would stop meaning anything.
  for (const t of EVENT_TEMPLATES) {
    if (OPERATIONAL.includes(t.id)) continue;
    const { effects } = t.generate();
    assert.ok(!effects.otpDelta, `${t.id} (${t.type}) should not move punctuality`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
