// Aircraft data consistency — guards the class of errors behind the 2026-07-28
// Discord reports ("744 is bigger than the 748 somehow", "ATR 72F is expensive
// as hell", the 767-200SF undercutting the 767-300F).
//
// Root causes these lock out:
//   1. A frame's fuelBurnPer100km entered at a fraction of its real burn. The
//      A380 (1197) and 747-8I (986) sat at ~65% of real burn while every other
//      type in the table sat at 92-98%, which made both read as impossibly
//      efficient and made the -8I's smaller exit limit look like a bug.
//   2. A freighter burning less than the identical passenger airframe it is
//      converted from (MD-11F 931 vs MD-11 1281; DC-10-30F 977 vs DC-10-30
//      1318; 747-400F 1150 vs 747-400 1608).
//   3. The 2026-06-17 expansion block priced used conversions on a different
//      scale to the original freighters and never gave them an old-airframe
//      maintenance penalty, so 40-year-old jets strictly beat new-builds.
//
//   node tools/aircraft-consistency-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, seatEfficiency } from '../src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const BY_ID = Object.fromEntries(AIRCRAFT_TYPES.map(t => [t.id, t]));
const get = (id) => {
  const t = BY_ID[id];
  assert.ok(t, `aircraft id '${id}' no longer exists — update this test`);
  return t;
};
const perSeat  = (id) => get(id).fuelBurnPer100km / get(id).seats;
const perTonne = (id) => get(id).fuelBurnPer100km / get(id).payloadTonnes;
const maintPerTonne = (id) => get(id).baseMaintenancePerWk / get(id).payloadTonnes;

console.log('\nAircraft data consistency\n');

// ── 1. Same airframe, converted to freight, burns roughly the same ───────────
// A P2F/SF/BCF conversion is the same tube and the same engines. Its burn may
// differ a little (no cabin fit, higher payload) but never by tens of percent.

const TWINS = [
  ['b747400', 'b747400f'],
  ['b7478i',  'b7478f'],
  ['md11',    'md11f'],
  ['dc1030',  'dc1030f'],
  ['b767200er', 'b767200sf'],
  ['a300600r', 'a300600f'],
  ['b757200', 'b757200pf'],
];

for (const [pax, frt] of TWINS) {
  test(`${get(frt).name} burns in line with the ${get(pax).name} it is converted from`, () => {
    const ratio = get(frt).fuelBurnPer100km / get(pax).fuelBurnPer100km;
    assert.ok(
      ratio >= 0.85 && ratio <= 1.20,
      `${get(frt).name} burns ${get(frt).fuelBurnPer100km} vs ${get(pax).fuelBurnPer100km} (ratio ${ratio.toFixed(2)}) — same airframe, expected 0.85-1.20`,
    );
  });
}

// ── 2. Four engines never beat two on fuel per seat ──────────────────────────
// The bug that started this: the A380 read 1.40 L/seat/100km, better than a
// 787-9 (1.71), because its burn was entered ~35% low.

test('no four-engine double-decker is more fuel-efficient per seat than a 787-9', () => {
  const ref = perSeat('b7879');
  for (const id of ['a380', 'b7478i', 'b747400', 'b747300', 'b747100']) {
    assert.ok(
      perSeat(id) > ref,
      `${get(id).name} shows ${perSeat(id).toFixed(2)} L/seat/100km vs the 787-9's ${ref.toFixed(2)} — a quad cannot beat a modern twin`,
    );
  }
});

test('the most efficient large aircraft is a twinjet, not a jumbo', () => {
  const QUADS = ['a380', 'b7478i', 'b747400', 'b747300', 'b747100', 'b747200', 'b747sp',
                 'a340300', 'a340600', 'il96300', 'il86', 'dc863', 'b707320b'];
  const best = AIRCRAFT_TYPES
    .filter(t => !t.freighter && t.seats >= 250)
    .sort((a, b) => seatEfficiency(a) - seatEfficiency(b))[0];
  assert.ok(
    !QUADS.includes(best.id),
    `most efficient large aircraft is ${best.name} — expected a modern twin, not a four-engine type`,
  );
});

// ── 3. The 747 exit-limit quirk is intentional, and explained in-game ────────
// Boeing never re-certified the -8I's exit limit, so it is placarded for 605
// against the -400's 660 despite being 5.6 m longer. That is real, so the seat
// numbers stay — but the -8I must actually earn its price on efficiency, and
// the description has to tell the player why the newest 747 looks smaller.

test('the 747-400D is the only 747 certified for the 660-seat exit limit', () => {
  // 2026-07-29: the 660-seat placard moved off the -400 and onto the new -400D,
  // which is the only 747 Boeing ever certified for it (domestic high-density,
  // strengthened for the cycles, range cut to 4,000 km). Every other 747 sits at
  // the standard 605. So the -8I is no LARGER than the -400 — the check that
  // used to be a strict "<" is now "<=", and the 660 figure is pinned to the -400D
  // so a later edit cannot quietly hand it back to a long-range frame.
  assert.equal(get('b747400d').seats, 660);
  assert.ok(get('b747400').seats < get('b747400d').seats,
    'the -400D exists precisely because the standard -400 is not certified for 660');
  assert.ok(get('b747400d').range < get('b747400').range,
    'the -400D trades range for seats — if it matched the -400 on range it would strictly dominate it');
  assert.ok(get('b7478i').seats <= get('b747400').seats);
});

test('the 747-8I is meaningfully more efficient per seat than the -400', () => {
  const gain = 1 - perSeat('b7478i') / perSeat('b747400');
  assert.ok(
    gain > 0.03,
    `-8I is only ${(gain * 100).toFixed(1)}% better per seat than the -400 — it costs 3.5x as much, it has to earn that back`,
  );
});

test('the 747-8I description explains the exit limit', () => {
  assert.match(get('b7478i').description, /exit limit/i);
});

test('the 747-300 description explains why it matches the -400 on seats', () => {
  assert.match(get('b747300').description, /exit limit|-400 cabin/i);
});

// ── 4. Freighter pricing sits on one scale ───────────────────────────────────

test('the ATR 72-600F is priced off its passenger sibling, not 20% above it', () => {
  const ratio = get('atr72f').purchasePrice / get('atr72').purchasePrice;
  assert.ok(
    ratio <= 1.10,
    `ATR 72-600F is $${(get('atr72f').purchasePrice / 1e6).toFixed(0)}M against the -600's $${(get('atr72').purchasePrice / 1e6).toFixed(0)}M (${ratio.toFixed(2)}x) — same airframe, freight door`,
  );
});

test('the 767-200SF does not out-burn the newer 767-300F per tonne', () => {
  assert.ok(
    perTonne('b767200sf') > perTonne('b767300f'),
    `767-200SF ${perTonne('b767200sf').toFixed(2)} vs 767-300F ${perTonne('b767300f').toFixed(2)} L/tonne — the older, smaller conversion cannot be the efficient one`,
  );
});

// Old airframes are cheap to buy and cheap to lease. They must not also be
// cheap to maintain, or there is no reason to ever buy a new freighter.
const CLASSIC_FREIGHTERS = [
  'b727200f', 'dc873f', 'dc1030f', 'md11f', 'an12', 'an124',
  'b737300f', 'b737400f', 'b757200pf', 'a300600f', 'b767200sf', 'b747400f', 'an225',
];

test('every classic freighter conversion carries an old-airframe maintenance penalty', () => {
  const newBuildCeiling = Math.max(
    ...['b767300f', 'a330200f', 'b777f', 'b7478f', 'a350f', 'b7778f'].map(maintPerTonne),
  );
  for (const id of CLASSIC_FREIGHTERS) {
    assert.ok(
      maintPerTonne(id) >= newBuildCeiling,
      `${get(id).name} costs $${Math.round(maintPerTonne(id))}/tonne/wk to maintain, under the $${Math.round(newBuildCeiling)} worst new-build — a 40-year-old jet cannot be the cheap one to keep flying`,
    );
  }
});

// ── 5. Whole-table guards ────────────────────────────────────────────────────

test('every type leases for 8-15% of its purchase price a year', () => {
  const bad = AIRCRAFT_TYPES
    .map(t => ({ t, pct: (t.weeklyLease * 52) / t.purchasePrice * 100 }))
    .filter(({ pct }) => pct < 8 || pct > 15);
  assert.deepEqual(
    bad.map(({ t, pct }) => `${t.name} ${pct.toFixed(1)}%`), [],
  );
});

test('no freighter is strictly dominated by another', () => {
  const f = AIRCRAFT_TYPES.filter(t => t.freighter);
  const dominated = [];
  for (const b of f) {
    for (const a of f) {
      if (a.id === b.id) continue;
      const better = a.payloadTonnes >= b.payloadTonnes && a.range >= b.range
        && (a.runwayFt || 0) <= (b.runwayFt || 0)
        && a.purchasePrice <= b.purchasePrice && a.weeklyLease <= b.weeklyLease
        && a.baseMaintenancePerWk <= b.baseMaintenancePerWk
        && a.fuelBurnPer100km / a.payloadTonnes <= b.fuelBurnPer100km / b.payloadTonnes;
      if (better) dominated.push(`${b.name} < ${a.name}`);
    }
  }
  assert.deepEqual(dominated, []);
});

test('every aircraft carries the fields the market card renders', () => {
  const missing = AIRCRAFT_TYPES.filter(t =>
    !t.name || !t.description || !t.image || !t.category
    || !(t.range > 0) || !(t.purchasePrice > 0) || !(t.weeklyLease > 0)
    || !(t.fuelBurnPer100km > 0) || !(t.baseMaintenancePerWk > 0)
    || !(t.freighter ? t.payloadTonnes > 0 : t.seats > 0));
  assert.deepEqual(missing.map(t => t.id), []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
