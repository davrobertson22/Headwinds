// How OFTEN aircraft break, and for how long.
//
// Dave, 2026-11-09: "the maintenance/random groundings of aircraft are a bit
// too often in both games". Measured on the engine as it stood: a normally
// flown tail (90 block-hours a week, every C and D check done on time, default
// maintenance budget) failed about 1.6-2.2 times a year and lost 4-6 weeks a
// year to repairs BEFORE any heavy check — roughly 10-14% of the fleet out of
// service, against the 3-5% a real airline runs. Two causes:
//
//   1. the wear terms (0.03 x wearC^2 + 0.06 x wearD^2) dominated the curve, so
//      even a brand-new airframe broke 1.5 times a year;
//   2. every failure cost 1-5 whole weeks (mean 2.5), where most real faults
//      are fixed in days.
//
// The targets asserted here are the balance intent: under one failure a year
// and about 1-1.5 weeks lost a year across an airframe's first decade, with age
// and a starved maintenance budget still hurting.
//
//   node tools/failure-frequency-test.mjs
import assert from 'node:assert/strict';
import { rollMechanicalFailures, failureTypesFor } from '../packages/engine/src/data/events.js';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import {
  weeklyWearFailureProb, C_HOURS_DUE, C_WEEKS_DUE, D_HOURS_DUE, D_WEEKS_DUE,
} from '../packages/engine/src/data/maintenance.js';

let passed = 0, failed = 0;
const REAL_RANDOM = Math.random;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
  finally { Math.random = REAL_RANDOM; }
};

/**
 * Expected failures per year over an airframe's life, in 5-year bands, with
 * every check taken the week it falls due. Pure expectation — no dice.
 */
function failuresPerYear(blockHoursPerWeek, budget = 1.0) {
  const a = { ageWeeks: 0, hoursSinceC: 0, hoursSinceD: 0, weeksSinceC: 0, weeksSinceD: 0 };
  const bands = [];
  let expected = 0;
  for (let w = 1; w <= 52 * 20; w++) {
    expected += weeklyWearFailureProb(a, null, budget);
    a.ageWeeks++; a.weeksSinceC++; a.weeksSinceD++;
    a.hoursSinceC += blockHoursPerWeek; a.hoursSinceD += blockHoursPerWeek;
    if (a.hoursSinceD >= D_HOURS_DUE || a.weeksSinceD >= D_WEEKS_DUE) {
      a.hoursSinceD = a.weeksSinceD = a.hoursSinceC = a.weeksSinceC = 0;
    } else if (a.hoursSinceC >= C_HOURS_DUE || a.weeksSinceC >= C_WEEKS_DUE) {
      a.hoursSinceC = a.weeksSinceC = 0;
    }
    if (w % 260 === 0) { bands.push(expected / 5); expected = 0; }
  }
  return bands;   // [years 1-5, 6-10, 11-15, 16-20]
}

/** An airframe that can suffer every fault in the table. */
const FULL_TYPE = AIRCRAFT_TYPES.reduce((best, ty) =>
  (failureTypesFor(ty).length > failureTypesFor(best).length ? ty : best));
const POOL = failureTypesFor(FULL_TYPE);

/** Longest and shortest grounding each fault can produce, through the real roll. */
function durationBounds() {
  const n = POOL.length;
  const roll = (durDraw) => {
    const fleet = Array.from({ length: n }, (_, i) => ({
      id: `t${i}`, typeId: FULL_TYPE.id, name: FULL_TYPE.name, tailNumber: `N${i}`, status: 'assigned',
      ageWeeks: 520, hoursSinceC: 2000, hoursSinceD: 10_000,
    }));
    let call = 0;
    Math.random = () => {
      const phase = call % 3, idx = Math.floor(call / 3);
      call++;
      if (phase === 0) return 0;                 // always fails
      if (phase === 1) return (idx + 0.5) / n;   // one tail per template
      return durDraw;
    };
    const out = rollMechanicalFailures(fleet, 1.0);
    Math.random = REAL_RANDOM;
    return out;
  };
  const lo = roll(0), hi = roll(0.999999);
  assert.equal(lo.length, n, 'the sweep did not fail every tail — the harness is wrong');
  return lo.map((f, i) => ({ label: f.label, severity: f.severity, min: f.weeksGrounded, max: hi[i].weeksGrounded }));
}

// ── Frequency ───────────────────────────────────────────────────────────────

t('a normally flown tail fails less than once a year in its first decade', () => {
  for (const bh of [50, 90, 120]) {
    const [y1to5, y6to10] = failuresPerYear(bh);
    assert.ok(y1to5 < 1.0,  `${bh} bh/wk, years 1-5: ${y1to5.toFixed(2)} failures a year`);
    assert.ok(y6to10 < 1.0, `${bh} bh/wk, years 6-10: ${y6to10.toFixed(2)} failures a year`);
  }
});

t('failures are still a real part of the game, not a rounding error', () => {
  const [y1to5] = failuresPerYear(90);
  assert.ok(y1to5 > 0.4, `90 bh/wk, years 1-5: only ${y1to5.toFixed(2)} failures a year`);
});

t('an old airframe still breaks more than a young one, but under 1.5 times a year', () => {
  const bands = failuresPerYear(90);
  assert.ok(bands[3] > bands[0] * 1.5, `years 16-20 ${bands[3].toFixed(2)} vs years 1-5 ${bands[0].toFixed(2)}`);
  assert.ok(bands[3] < 1.5, `years 16-20: ${bands[3].toFixed(2)} failures a year`);
});

t('a hard-flown tail still breaks more than a lightly flown one', () => {
  assert.ok(failuresPerYear(90)[0] > failuresPerYear(50)[0] * 1.3);
});

t('the maintenance budget still divides the odds', () => {
  const base = failuresPerYear(90, 1.0)[1];
  assert.ok(Math.abs(failuresPerYear(90, 2.0)[1] - base / 2) < 0.01, 'a doubled budget should halve failures');
  assert.ok(Math.abs(failuresPerYear(90, 0.5)[1] - base * 2) < 0.01, 'a halved budget should double failures');
});

// ── Duration ────────────────────────────────────────────────────────────────

t('the test airframe can suffer the whole fault table', () => {
  assert.ok(POOL.length >= 8, `${FULL_TYPE.name} only has ${POOL.length} possible faults`);
});

t('a minor fault is back in a week; nothing grounds a tail longer than four', () => {
  for (const d of durationBounds()) {
    assert.ok(d.min >= 1, `${d.label} can ground for ${d.min} weeks`);
    if (d.severity === 'minor') assert.equal(d.max, 1, `${d.label} (minor) can ground for ${d.max} weeks`);
    if (d.severity === 'major') assert.ok(d.max <= 2, `${d.label} (major) can ground for ${d.max} weeks`);
    assert.ok(d.max <= 4, `${d.label} can ground for ${d.max} weeks`);
  }
});

t('a severe fault is still the longest grounding', () => {
  const b = durationBounds();
  const worst = (sev) => Math.max(...b.filter(d => d.severity === sev).map(d => d.max));
  assert.ok(worst('severe') > worst('major') && worst('major') > worst('minor'));
});

t('a normally flown tail loses about 1-1.5 weeks a year to repairs in its first decade', () => {
  const b = durationBounds();
  const meanWeeks = b.reduce((s, d) => s + (d.min + d.max) / 2, 0) / b.length;
  for (const bh of [90, 120]) {
    const [y1to5, y6to10] = failuresPerYear(bh);
    for (const perYear of [y1to5, y6to10]) {
      const lost = perYear * meanWeeks;
      assert.ok(lost > 0.7 && lost < 1.6, `${bh} bh/wk: ${lost.toFixed(1)} weeks a year lost to repairs`);
    }
  }
});

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
