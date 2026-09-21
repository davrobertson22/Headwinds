// aircraft-generation-test.mjs — the generational ladder, and the propeller/jet
// fuel scale that sits under it (2026-09-20 aircraft market audit).
//
// WHY THIS EXISTS.
//
//   1. PROPELLER FUEL WAS ON A DIFFERENT SCALE TO JETS. Jets sit at 92-98% of
//      real-world burn by design. The whole Turboprop category sat at roughly
//      50-70%, which made a 1961 Vickers Vanguard the second most fuel-efficient
//      airframe in a 197-type catalogue — ahead of the A330neo, the A321XLR and
//      the 787-9 — and handed turboprops 7 of the top 10 win slots in the
//      mission sweep. Verified against engine cruise power x SFC (Ivchenko
//      AI-20, Rolls-Royce Tyne) and published trip fuel (Q400, ATR 72-600).
//
//   2. THE 777X DID NOT BEAT THE 777. A GE9X and a new composite wing bought
//      0.3% per seat over the 777-200ER and 1.4% over the 777-300ER, against a
//      real programme claiming ~10%. Measured in money the 777X-8 was WORSE than
//      the frame it replaces before a cent of capital.
//
// Neither failure was reachable by aircraft-consistency-test.mjs: its
// generational checks cover narrowbodies (every neo and E2) and compare fuel
// only, never the all-in cost of holding the aircraft.
//
//   node tools/aircraft-generation-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType, ERA_NEW_BUILD_PREMIUM } from '../src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}
const get = (id) => {
  const t = getAircraftType(id);
  assert.ok(t, `aircraft id '${id}' no longer exists — update this test`);
  return t;
};
const perSeat = (t) => t.fuelBurnPer100km / t.seats;

console.log('\nGenerational ladder and the propeller/jet fuel scale\n');

// ── 1. A propeller is efficient, not magic ───────────────────────────────────

test('no propeller airliner out-performs the best modern jet per seat', () => {
  // The symptom that exposed the whole miscalibration. A turboprop genuinely
  // beats a regional jet per seat — it does NOT beat a clean-sheet widebody.
  const bestJet = Math.min(...AIRCRAFT_TYPES
    .filter(t => !t.freighter && t.seats > 0 && t.eis >= 2010
              && ['Wide Body', 'Narrow Body'].includes(t.category))
    .map(perSeat));
  const offenders = AIRCRAFT_TYPES
    .filter(t => t.category === 'Turboprop' && t.seats > 0 && perSeat(t) < bestJet)
    .map(t => `${t.name} (${t.eis}) ${perSeat(t).toFixed(2)} L/100km/seat`);
  assert.deepEqual(offenders, [],
    `no turboprop may burn less per seat than the best post-2010 jet (${bestJet.toFixed(2)})`);
});

test('a turboprop beats a same-size regional jet by a plausible margin, not double', () => {
  // Real-world gap is roughly 20-35% per seat. 40-45% meant the propeller side
  // of the catalogue was simply on a cheaper scale than the jet side.
  const PAIRS = [['q400', 'e175'], ['atr72', 'crj700'], ['atr42', 'crj200'], ['q400', 'crj900']];
  for (const [tp, jet] of PAIRS) {
    const gain = 1 - perSeat(get(tp)) / perSeat(get(jet));
    assert.ok(gain > 0, `${tp} must still beat ${jet} per seat (got ${(100 * gain).toFixed(1)}%)`);
    assert.ok(gain < 0.40,
      `${tp} beats ${jet} by ${(100 * gain).toFixed(1)}% per seat — over 40% means the ` +
      `propeller fuel scale has drifted below the jet scale again`);
  }
});

// ── 2. Each replacement actually replaces ────────────────────────────────────

// [old, new] — the frame and the frame built to replace it.
const LADDER = [
  ['b737800', 'b737max8'], ['a320ceo', 'a320neo'], ['a319ceo', 'a319neo'],
  ['a321ceo', 'a321neo'], ['b737700', 'b737max7'], ['b737900er', 'b737max9'],
  ['e190', 'e190e2'], ['e195', 'e195e2'], ['e175', 'e175e2'],
  ['b767300', 'b7878'], ['a330300', 'a330neo'], ['a330200', 'a330800'],
  ['b777200er', 'b7778x'], ['b777300er', 'b7779x'], ['a340300', 'a350900'],
  ['b747400', 'b7478i'], ['a340600', 'a3501000'],
];

test('every replacement type beats the frame it replaces on fuel per seat', () => {
  const off = [];
  for (const [o, n] of LADDER) {
    const gain = 1 - perSeat(get(n)) / perSeat(get(o));
    if (gain < 0.05) off.push(`${o} -> ${n}: ${(100 * gain).toFixed(1)}% per seat`);
  }
  assert.deepEqual(off, [],
    'a new generation must buy at least 5% per seat — anything less is a reskin');
});

// ── 3. NOT YET A TEST: all-in cost across a generation ───────────────────────
//
// The invariant this file would most like to assert is that a replacement beats
// the frame it replaces on ALL-IN cost per seat-km, not just on fuel — that is
// what a player actually pays. It is deliberately NOT asserted here, because
// there is no sound way to compare the two sides yet:
//
//   A closed line's catalogue price is its SECOND-HAND 2026 value; an open
//   line's is new metal. Comparing them directly says a used 767-300 is cheaper
//   to hold than a new 787-8 — true, intended, and not a defect. Reconstructing
//   a "new" price for the older frame via ERA_NEW_BUILD_PREMIUM does not fix it
//   either: one global 2.5x multiplier cannot stand in for the very different
//   real depreciation of a 1989 747-400 and a 2012 747-8I, and the comparison
//   swings by tens of percent depending on which frame you lift.
//
// The 2026-09-20 audit measured the underlying seam directly instead: passenger
// widebody capital cost spans 15.2x per seat while operating cost spans 2.5x —
// the same shape as the freighter pricing bug already guarded in
// aircraft-consistency-test.mjs ("freighter $M-per-tonne spread stays under
// 10x"), which was 21.6x against 2.7x. The passenger mirror of that guard is
// the test to add here, and it needs the widebody capital band compressed
// first — otherwise it fails on day one. See docs/aircraft-market-audit.md.

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
