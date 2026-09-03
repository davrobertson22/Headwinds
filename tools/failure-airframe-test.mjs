// Mechanical failures have to be possible on the airframe they ground.
//
// Discord 2026-09-02 (CorporalSimmons): a DC-4 — a 1946 piston airliner whose
// own catalogue entry calls it "cheap, slow and unpressurised" — was grounded
// two weeks with a "Pressurization fault". rollMechanicalFailures picked
// uniformly from one flat template table with no idea what it was breaking, so
// every airframe in the game could suffer every fault, including systems it
// does not carry: pressurization on an unpressurised propliner, an APU on an
// airframe built two decades before airliners had one.
//
//   node tools/failure-airframe-test.mjs
import assert from 'node:assert/strict';
import { rollMechanicalFailures } from '../packages/engine/src/data/events.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
const REAL_RANDOM = Math.random;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
  finally { Math.random = REAL_RANDOM; }
};

// Every aircraft fails, and the template draw sweeps the whole table across the
// fleet, so one roll of N tails visits every failure type the airframe allows.
// Per aircraft the sequence is: failure probability, template index, duration.
function sweep(typeId, n = 64) {
  const fleet = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, typeId, name: typeId, tailNumber: `N${i}`, status: 'assigned',
    ageWeeks: 1200, hoursSinceC: 4000, hoursSinceD: 20_000,
  }));
  let call = 0;
  Math.random = () => {
    const phase = call % 3;
    const idx   = Math.floor(call / 3);
    call++;
    if (phase === 0) return 0;                       // always fails
    if (phase === 1) return (idx % n) / n;           // sweep the template table
    return 0;                                        // shortest duration
  };
  const out = rollMechanicalFailures(fleet, 1.0);
  Math.random = REAL_RANDOM;
  return new Set(out.map(f => f.label));
}

// ── The reported bug ────────────────────────────────────────────────────────

t('an unpressurised propliner never suffers a pressurization fault', () => {
  const labels = sweep('dc4');
  assert.ok(labels.size > 0, 'the sweep produced no failures at all — the harness is wrong');
  assert.ok(!labels.has('Pressurization fault'),
    `DC-4 can still be grounded by: ${[...labels].join(', ')}`);
});

t('the same holds for every airframe flagged unpressurised', () => {
  const unpressurised = AIRCRAFT_TYPES.filter(a => a.pressurized === false);
  assert.ok(unpressurised.length >= 5, 'no airframes are flagged unpressurised in the catalogue');
  for (const type of unpressurised) {
    assert.ok(!sweep(type.id).has('Pressurization fault'), `${type.name} can lose pressurization`);
  }
});

t('an airframe built before airliners carried an APU never suffers an APU failure', () => {
  for (const id of ['dc3', 'dc4', 'l749', 'dc6b']) {
    assert.ok(!sweep(id).has('APU failure'), `${getAircraftType(id)?.name} has an APU it never had`);
  }
});

// ── The other half: don't over-filter ───────────────────────────────────────

t('a modern jet can still suffer every failure in the table', () => {
  const labels = sweep('b737800');
  for (const expected of ['Engine fault', 'Hydraulics leak', 'Avionics fault', 'Landing gear issue',
                          'APU failure', 'Pressurization fault', 'Fuel system anomaly',
                          'Structural crack found']) {
    assert.ok(labels.has(expected), `a 737-800 can no longer suffer: ${expected}`);
  }
});

t('every airframe in the catalogue keeps at least three possible failures', () => {
  for (const type of AIRCRAFT_TYPES) {
    const labels = sweep(type.id, 32);
    assert.ok(labels.size >= 3, `${type.name} has only ${labels.size} possible failure(s)`);
  }
});

t('an unknown typeId still breaks down (no crash, no empty table)', () => {
  assert.ok(sweep('not-a-real-aircraft').size >= 3, 'an unknown type lost its failure table');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
