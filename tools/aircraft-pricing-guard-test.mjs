// aircraft-pricing-guard-test.mjs — passenger-side price consistency
// (2026-09-23, aircraft market audit Addendum 7).
//
// WHY THIS EXISTS.
//
//   A closed line's catalogue price is what a USED frame of that type fetches in
//   2026, `deliveredAgeWeeks` old; an era world multiplies it by
//   ERA_NEW_BUILD_PREMIUM while the line is open to get new metal. Four closed
//   widebodies broke that convention — they carried new-build prices:
//
//     747-8I   $190M at 9y old   — never won a mission, worst return on capital
//                                  in the cohort; in an era world a new one cost
//                                  $475M, 1.8x the dearest open-line widebody
//     777-200LR 13y old at $85M — its 777-200ER sibling, off the same line in the
//                                  same year, arrived 6y old at $48M
//     A380, 777-300ER            — kept at new-metal level on purpose (cheaper,
//                                  they take every long-haul trunk), but era
//                                  worlds still added the premium: a 2010 A380
//                                  was $762M
//
//   And within a family, the A310-300 — younger and longer-ranged — sold for
//   $11M against the A310-200's $15M, the single best return on capital in the
//   game.
//
// None of this was reachable by aircraft-consistency-test.mjs, whose price
// checks are freighter-only ($M-per-tonne spread).
//
//   node tools/aircraft-pricing-guard-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, getAircraftType, eraPurchasePrice, eraPriceScale } from '../packages/engine/src/data/aircraft.js';

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
const perSeat = (t) => t.purchasePrice / t.seats;
const isOpen = (t) => t.oop == null || t.oop > 2026;
const WIDE = (t) => !t.freighter && t.seats > 0 && (t.category === 'Wide Body' || t.category === 'Double Deck');

console.log('\nPassenger price consistency\n');

// [older, newer] — the same family, where the newer frame is younger when
// delivered, flies further or carries more. Used frames of the newer variant
// never sell for less per seat.
const SIBLINGS = [
  ['a310200', 'a310300'], ['a300b4', 'a300600r'], ['b767200er', 'b767300'],
  ['b747300', 'b747400'], ['b747400', 'b7478i'], ['dc1030', 'md11'],
  ['a340300', 'a340600'], ['b777200er', 'b777200lr'],
];

test('within a family, the newer variant never sells for less per seat', () => {
  const off = [];
  for (const [o, n] of SIBLINGS) {
    const a = perSeat(get(o)), b = perSeat(get(n));
    if (b < a) off.push(`${n} $${Math.round(b / 1e3)}k/seat < ${o} $${Math.round(a / 1e3)}k/seat`);
  }
  assert.deepEqual(off, []);
});

test('siblings off the same line in the same year arrive at the same age', () => {
  const er = get('b777200er'), lr = get('b777200lr');
  assert.equal(er.oop, lr.oop, 'the 777-200ER and -200LR lines no longer close together — revisit');
  assert.equal(lr.deliveredAgeWeeks, er.deliveredAgeWeeks ?? 0);
});

test('a used frame never costs more per seat than new metal of the type that replaces it', () => {
  const REPLACED = [
    ['b777300er', 'b7779x'], ['b777200lr', 'b7778x'], ['b777200er', 'b7778x'],
    ['a330300', 'a330neo'], ['a330200', 'a330800'], ['a340300', 'a350900'],
    ['a340600', 'a3501000'], ['b767300', 'b7878'],
  ];
  const off = [];
  for (const [o, n] of REPLACED) {
    const a = perSeat(get(o)), b = perSeat(get(n));
    if (a > b) off.push(`${o} $${Math.round(a / 1e3)}k/seat used > ${n} $${Math.round(b / 1e3)}k/seat new`);
  }
  assert.deepEqual(off, []);
});

test('in an era world, no closed widebody is dearer new than 1.5x the dearest open-line widebody', () => {
  const open = AIRCRAFT_TYPES.filter(t => WIDE(t) && isOpen(t));
  const ceiling = Math.max(...open.map(perSeat));
  const off = [];
  for (const t of AIRCRAFT_TYPES.filter(t => WIDE(t) && !isOpen(t) && t.eis <= 2026)) {
    // the year its line was open and the era premium was at its full height
    const newBuild = eraPurchasePrice(t, t.oop) / t.seats;
    if (newBuild > 1.5 * ceiling) off.push(`${t.id} new in ${t.oop}: $${Math.round(newBuild / 1e3)}k/seat vs ceiling $${Math.round(ceiling / 1e3)}k`);
  }
  assert.deepEqual(off, [],
    'a closed line whose catalogue price is already a new-build figure needs pricedAsNew, or a used price');
});

test('pricedAsNew is reserved for closed lines, and adds no era premium', () => {
  const flagged = AIRCRAFT_TYPES.filter(t => t.pricedAsNew);
  assert.deepEqual(flagged.map(t => t.id).sort(), ['a380', 'b777300er']);
  for (const t of flagged) {
    assert.ok(!isOpen(t), `${t.id} is an open line — its price is new already, the flag is meaningless`);
    assert.equal(eraPriceScale(t, t.eis), 1, t.id);
    assert.equal(eraPriceScale(t, t.oop + 3), 1, t.id);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
