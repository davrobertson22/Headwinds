// deadweight-model-test.mjs — the catalogue report's fixed-cost model must
// agree with weeklyTick, not just its variable-cost model.
//
// tools/catalogue-deadweight-report.mjs has always reconciled its VARIABLE
// route cost (fuel, crew, landing) against the tick with --validate. Its FIXED
// cost was never checked, and it drifted: it charged every airframe age-0
// maintenance and put vintage metal on a lease no lessor offers. The tick charges
// maintenanceMultiplier(delivered age) — 2.28x at 16 years, up to 5.5x for
// vintage — and vintage is buy-only, so it carries hull insurance. The report
// therefore credited vintage types with 19.3% of all mission wins against 3.9%
// under the tick's own costs (2026-09-23 audit).
//
// This holds each part of fixedWeeklyParts() against a real weeklyTick for a
// new type, an aged type and a vintage type.
//
//   node tools/deadweight-model-test.mjs

import assert from 'node:assert/strict';
import { getAircraftType, eraDeliveredAgeWeeks, isVintage } from '../packages/engine/src/data/aircraft.js';
import { weeklyTick } from '../packages/engine/src/utils/simulation.js';
import { fixedWeeklyParts } from './catalogue-deadweight-report.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

/** One airframe of `id`, delivered as the market delivers it, flying nothing. */
function tickOne(id) {
  const t = getAircraftType(id);
  assert.ok(t, `fixture type ${id} missing`);
  const ownershipType = isVintage(t) ? 'owned' : 'leased';
  const state = {
    fleet: [{ id: 'a1', typeId: t.id, status: 'idle', ownershipType,
              ageWeeks: eraDeliveredAgeWeeks(t, null) }],
    routes: [], cargoRoutes: [], gates: {}, hubs: {}, cash: 500_000_000,
  };
  return { t, r: weeklyTick(state) };
}

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * tol);

console.log('\nDeadweight report fixed costs vs weeklyTick\n');

const CASES = [
  ['a320neo', 'a new build (delivered at 0 weeks)'],
  ['b737800', 'an aged type (delivered used, published band)'],
  ['vanguard', 'a vintage type (buy-only, lifted by the vintage rule)'],
];

for (const [id, what] of CASES) {
  test(`maintenance matches the tick for ${what}`, () => {
    const { t, r } = tickOne(id);
    const p = fixedWeeklyParts(t);
    assert.ok(near(p.maintenance, r.totalMaintenance),
      `${id}: report ${p.maintenance} vs tick ${r.totalMaintenance} at ${p.ageWeeks}w`);
  });
  test(`insurance matches the tick for ${what}`, () => {
    const { t, r } = tickOne(id);
    const p = fixedWeeklyParts(t);
    assert.ok(near(p.insurance, r.totalInsurance),
      `${id}: report ${p.insurance} vs tick ${r.totalInsurance}`);
  });
}

test('a vintage type is not charged a lease the market will not offer', () => {
  const t = getAircraftType('vanguard');
  assert.ok(isVintage(t), 'fixture: the Vanguard is expected to be vintage');
  const p = fixedWeeklyParts(t);
  assert.notEqual(p.ownership, t.weeklyLease, 'charged the catalogue lease for buy-only metal');
  assert.ok(p.ownership > 0, 'a bought airframe still ties up capital');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
