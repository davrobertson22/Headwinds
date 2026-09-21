// gate-pricing-test.mjs — Gate rent stays a curve, not a cliff.
//
// Gate fees escalate per additional gate at an airport, but the escalation is
// capped at GATE_FEE_CAP_MULTIPLE x the tier base. Unbounded, a 61-gate mega
// hub billed $100M/week while the same 61 gates at a regional airport billed
// $0.9M/week — a spread produced by the compounding rate alone. These tests
// pin the cap, pin the closed-form total against a brute-force sum, and pin
// the sub-cap fees so a future tweak cannot silently reprice ordinary play.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  gateMonthlyFee, totalGateMonthlyFee, getAirport,
  GATE_FEE_BY_TIER, GATE_COST_ESCALATION, GATE_FEE_CAP_MULTIPLE,
  gateCapacityOf, gateAirlineCapOf,
} from '../packages/engine/src/data/airports.js';
import { setEraCostScale } from '../packages/engine/src/data/overhead.js';

const NRT = getAirport('NRT');   // mega
const SFO = getAirport('SFO');   // major
const TIERS = Object.keys(GATE_FEE_BY_TIER);

function sampleAirport(tier) {
  return { code: `ZZ${tier[0].toUpperCase()}`, tier };
}

test('the first gate is the tier base rate, unescalated', () => {
  for (const tier of TIERS) {
    assert.equal(gateMonthlyFee(sampleAirport(tier), 1), GATE_FEE_BY_TIER[tier]);
  }
});

test('no single gate ever bills more than the cap multiple of its base', () => {
  for (const tier of TIERS) {
    const ceiling = GATE_FEE_BY_TIER[tier] * GATE_FEE_CAP_MULTIPLE;
    for (const n of [1, 5, 20, 50, 100, 500, 5000]) {
      assert.ok(
        gateMonthlyFee(sampleAirport(tier), n) <= ceiling,
        `${tier} gate ${n} exceeded the ceiling`,
      );
    }
    // And it actually reaches the ceiling rather than stopping short.
    assert.equal(gateMonthlyFee(sampleAirport(tier), 5000), ceiling);
  }
});

test('below the cap the fee is still the plain compounding curve', () => {
  for (const tier of TIERS) {
    const base = GATE_FEE_BY_TIER[tier];
    const rate = GATE_COST_ESCALATION[tier];
    for (let n = 1; n <= 15; n++) {
      const uncapped = Math.round(base * Math.pow(rate, n - 1));
      if (uncapped > base * GATE_FEE_CAP_MULTIPLE) continue;
      assert.equal(gateMonthlyFee(sampleAirport(tier), n), uncapped,
        `${tier} gate ${n} was repriced below the cap`);
    }
  }
});

test('the total matches a brute-force sum of the marginal fees', () => {
  for (const tier of TIERS) {
    const ap = sampleAirport(tier);
    for (const count of [1, 2, 7, 19, 20, 21, 37, 38, 61, 120, 400]) {
      let brute = 0;
      for (let n = 1; n <= count; n++) brute += gateMonthlyFee(ap, n);
      assert.ok(
        Math.abs(totalGateMonthlyFee(ap, count) - brute) <= count,
        `${tier} total at ${count} gates drifted from the summed marginals`,
      );
    }
  }
});

test('totals are monotonic and the capped tail grows linearly', () => {
  const ap = sampleAirport('mega');
  const flat = GATE_FEE_BY_TIER.mega * GATE_FEE_CAP_MULTIPLE;
  let prev = 0;
  for (let n = 1; n <= 200; n++) {
    const t = totalGateMonthlyFee(ap, n);
    assert.ok(t > prev, `total went backwards at gate ${n}`);
    prev = t;
  }
  // Past the cap every extra gate adds exactly the flat rate.
  assert.equal(totalGateMonthlyFee(ap, 101) - totalGateMonthlyFee(ap, 100), flat);
  assert.equal(totalGateMonthlyFee(ap, 61) - totalGateMonthlyFee(ap, 60), flat);
});

test('zero and negative gate counts cost nothing', () => {
  assert.equal(totalGateMonthlyFee(NRT, 0), 0);
  assert.equal(totalGateMonthlyFee(NRT, -3), 0);
  assert.equal(totalGateMonthlyFee(NRT, undefined), 0);
});

test('a 61-gate mega hub is expensive, not ruinous', () => {
  // The bug report: NRT at 61 gates billed $100.18M/week. Gate rent per weekly
  // departure was $41K — more than the fare on the flight using the gate.
  const weekly = totalGateMonthlyFee(NRT, 61) / 4;
  assert.ok(weekly < 12_000_000, `61-gate mega hub still bills ${Math.round(weekly)}/wk`);
  assert.ok(weekly > 5_000_000,  'a 61-gate mega hub should still be a serious commitment');
});

test('tier ordering survives at hub scale', () => {
  const at = (tier, n) => totalGateMonthlyFee(sampleAirport(tier), n);
  assert.ok(at('mega', 61) > at('major', 61));
  assert.ok(at('major', 61) > at('regional', 61));
  // ...and the spread stays modest — about 10x at 61 gates, against the 114x
  // gap the uncapped curve produced, most of which is the 4x base-rate
  // difference the tiers are meant to have rather than runaway compounding.
  assert.ok(at('mega', 61) / at('regional', 61) < 15);
});

test('an unknown tier falls back to the generic rate and is still capped', () => {
  const odd = { code: 'ZZZ', tier: 'unknown-tier' };
  assert.equal(gateMonthlyFee(odd, 1), 50_000);
  assert.equal(gateMonthlyFee(odd, 9999), 50_000 * GATE_FEE_CAP_MULTIPLE);
  assert.equal(gateMonthlyFee(undefined, 1), 50_000);
});

test('the era cost scale still applies on both sides of the cap', () => {
  try {
    const classicBelow = gateMonthlyFee(NRT, 3);
    const classicAbove = gateMonthlyFee(NRT, 80);
    const classicTotal = totalGateMonthlyFee(NRT, 61);
    setEraCostScale(0.289);
    assert.ok(Math.abs(gateMonthlyFee(NRT, 3)  - classicBelow * 0.289) <= 1);
    assert.ok(Math.abs(gateMonthlyFee(NRT, 80) - classicAbove * 0.289) <= 1);
    assert.ok(Math.abs(totalGateMonthlyFee(NRT, 61) - classicTotal * 0.289) <= 1);
  } finally {
    setEraCostScale(1);
  }
});

test('a mid-size major hub is unchanged by the cap', () => {
  // SFO at 10 gates sits well below the major tier's ceiling, so its bill must
  // match the original compounding curve to the dollar.
  const base = GATE_FEE_BY_TIER.major, rate = GATE_COST_ESCALATION.major;
  assert.equal(SFO.tier, 'major');
  assert.equal(
    totalGateMonthlyFee(SFO, 10),
    Math.round(base * (Math.pow(rate, 10) - 1) / (rate - 1)),
  );
});

test('the largest holding gate scarcity allows is still a finite bill', () => {
  // Under scarcity one airline may hold GATE_AIRLINE_CAP of an airport's gates.
  // At a mega airport that is 300, a count the uncapped curve priced at roughly
  // $3e18 a month — past the point where the number means anything at all.
  const NRT_CAP = gateAirlineCapOf(gateCapacityOf(NRT));
  assert.equal(NRT_CAP, 300);
  const weekly = totalGateMonthlyFee(NRT, NRT_CAP) / 4;
  assert.ok(Number.isFinite(weekly));
  assert.ok(weekly < 100_000_000, `max mega holding bills ${Math.round(weekly)}/wk`);
  // The tail is exactly linear, and the whole holding stays cheaper than it
  // would be if every gate billed the ceiling — the first nineteen never do.
  const flat = GATE_FEE_BY_TIER.mega * GATE_FEE_CAP_MULTIPLE;
  assert.equal(totalGateMonthlyFee(NRT, 300) - totalGateMonthlyFee(NRT, 299), flat);
  assert.ok(totalGateMonthlyFee(NRT, 300) < 300 * flat);
});
