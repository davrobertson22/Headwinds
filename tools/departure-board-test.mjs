// Departure board — synthesised times and flight numbers must be DETERMINISTIC.
//
// Discord 2026-09-07 ("Departure Board at the airports screen"). The game has
// weekly frequencies, not a timetable, so times and flight numbers are hashed
// from the world seed. In a multiplayer world two players read the same board;
// if it differed per client, or shuffled on reload, it would read as a bug.
//
//   node tools/departure-board-test.mjs
import assert from 'node:assert/strict';
import {
  buildDepartureBoard, departuresOnDay, departureTimes, formatClock,
  flightStatus, assignAirlineCodes, hash32, DAY_NAMES,
} from '../packages/engine/src/models/departureBoard.js';

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const CARRIERS = [
  { id: 'p', name: 'Southern Cross', isPlayer: true, onTimeRate: 0.9, legs: [
    { to: 'MEL', weeklyFrequency: 14, typeId: 'a320neo', typeName: 'A320neo' },
    { to: 'BNE', weeklyFrequency: 3,  typeId: 'e190',    typeName: 'E190' },
  ] },
  { id: 'c1', name: 'Velocity Air', onTimeRate: 0.6, legs: [
    { to: 'MEL', weeklyFrequency: 7, typeId: 'b738', typeName: '737-800' },
  ] },
];
const build = (day = 0) => buildDepartureBoard({ airport: 'SYD', day, worldSeed: 'world-42', carriers: CARRIERS });

t('the same world, airport and day give byte-identical boards', () => {
  assert.deepEqual(build(0), build(0));
  assert.deepEqual(build(3), build(3));
});

t('a different world seed gives a different timetable', () => {
  const other = buildDepartureBoard({ airport: 'SYD', day: 0, worldSeed: 'world-43', carriers: CARRIERS });
  assert.notDeepEqual(build(0).map(r => r.timeLabel), other.map(r => r.timeLabel));
});

t('rows are sorted by departure time', () => {
  const times = build(0).map(r => r.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

t('a daily route flies every day; a 3x route flies on exactly three of them', () => {
  const seed = 'world-42|SYD|p|BNE';
  const week = DAY_NAMES.map((_, d) => departuresOnDay(3, d, seed));
  assert.equal(week.reduce((s, n) => s + n, 0), 3, 'a 3x/week route flies three times a week');
  assert.equal(week.filter(n => n > 0).length, 3, 'on three distinct days');
  assert.deepEqual(DAY_NAMES.map((_, d) => departuresOnDay(7, d, seed)), [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(DAY_NAMES.map((_, d) => departuresOnDay(14, d, seed)), [2, 2, 2, 2, 2, 2, 2]);
});

t('the whole week adds up to the weekly frequency, for any frequency', () => {
  for (let f = 0; f <= 28; f++) {
    const total = DAY_NAMES.reduce((s, _, d) => s + departuresOnDay(f, d, `seed-${f}`), 0);
    assert.equal(total, f, `frequency ${f} did not sum across the week`);
  }
});

t('departure times sit inside the operating day and are spread across it', () => {
  const times = departureTimes(4, 'x');
  assert.equal(times.length, 4);
  for (const m of times) {
    assert.ok(m >= 5 * 60 && m <= 23 * 60, `${formatClock(m)} is outside the operating day`);
    assert.equal(m % 5, 0, 'timetables round to five minutes');
  }
  assert.ok(times[3] - times[0] > 240, 'four daily rotations should not bunch into one hour');
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

t('flight numbers are unique on a board and stable across rebuilds', () => {
  const rows = build(2);
  assert.ok(rows.length > 0);
  const nos = rows.map(r => r.flightNo);
  assert.equal(new Set(nos).size, nos.length, 'duplicate flight number on one board');
  assert.deepEqual(build(2).map(r => r.flightNo), nos);
  for (const n of nos) assert.match(n, /^[A-Z]{2}\d{3,4}$/);
});

t('a busy hub board still prints no duplicate flight number', () => {
  // ~3,800 hashable numbers: a 60-row board collides more often than not
  // without de-duplication, and a repeated flight number is the tell.
  const busy = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`, name: `Carrier ${String.fromCharCode(65 + i)} Air`, onTimeRate: 0.85,
    legs: Array.from({ length: 6 }, (_, j) => ({ to: `X${i}${j}`, weeklyFrequency: 14 })),
  }));
  const rows = buildDepartureBoard({ airport: 'ORD', day: 0, worldSeed: 'w9', carriers: busy });
  assert.ok(rows.length > 100, `expected a busy board, got ${rows.length} rows`);
  const nos = rows.map(r => r.flightNo);
  assert.equal(new Set(nos).size, nos.length, 'duplicate flight number on a busy board');
});

t('two airlines never share a code', () => {
  const codes = assignAirlineCodes([
    { id: 'a', name: 'Aurora Air' }, { id: 'b', name: 'Antipodes Air' },
    { id: 'c', name: 'Adriatic Air' }, { id: 'd', name: 'Aurora Air' },
  ]);
  const vals = Object.values(codes);
  assert.equal(new Set(vals).size, vals.length);
  for (const v of vals) assert.match(v, /^[A-Z]{2}$/);
});

t('a punctual airline runs on time and a shambolic one does not', () => {
  const rate = (otp) => {
    let ok = 0;
    for (let i = 0; i < 400; i++) if (flightStatus(otp, `s${i}`).key === 'ontime') ok++;
    return ok / 400;
  };
  assert.ok(Math.abs(rate(0.95) - 0.95) < 0.06, 'a 95% OTP operator should show ~95% on time');
  assert.ok(Math.abs(rate(0.5) - 0.5) < 0.08, 'a 50% OTP operator should show ~50% on time');
  assert.ok(rate(0.95) > rate(0.5), 'understaffing must be visible on the board');
});

t('an unknown on-time rate still produces a sane status', () => {
  const s = flightStatus(undefined, 'z');
  assert.ok(['ontime', 'delayed', 'cancelled'].includes(s.key));
});

t('carriers with no departures that day simply do not appear', () => {
  const rows = buildDepartureBoard({
    airport: 'SYD', day: 0, worldSeed: 'w',
    carriers: [{ id: 'x', name: 'Ghost Air', legs: [{ to: 'MEL', weeklyFrequency: 0 }] }],
  });
  assert.equal(rows.length, 0);
});

t('every row carries what the board has to print', () => {
  for (const r of build(1)) {
    assert.match(r.timeLabel, /^\d{2}:\d{2}$/);
    assert.ok(r.destination && r.airlineName && r.gate && r.label);
    assert.match(r.gate, /^[A-D]\d{1,2}$/);
    assert.equal(typeof r.isPlayer, 'boolean');
  }
});

t('hash32 is the stable primitive everything rests on', () => {
  assert.equal(hash32('SYD|p|MEL'), hash32('SYD|p|MEL'));
  assert.notEqual(hash32('SYD|p|MEL'), hash32('SYD|p|BNE'));
  assert.ok(Number.isInteger(hash32('x')) && hash32('x') >= 0);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
