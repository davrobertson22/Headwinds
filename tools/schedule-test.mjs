// Weekly schedule — time zones, the per-aircraft timetable, the reducer action
// and the server guard. The schedule is cosmetic (board, editor, globe planes);
// these pin that it is complete, never overlaps, honours the player's pins and
// flows everything else around them.
//
//   node tools/schedule-test.mjs

import assert from 'node:assert/strict';
import { utcOffsetHours } from '../packages/engine/src/data/timezones.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import {
  WEEK_MIN, normalizeStarts, routeRotation, overlaps, aircraftWeek, canPlace,
  pinsAfterMove, pinsAfterUnpin, weekDepartures, airlineWeeks, wrapWeek,
  parseClock, clockLabel, snapClock, localDayTime, utcOfLocal, routeDays, routeFlights, timetableRows,
  pinsForTimetable, blockerFor,
} from '../packages/engine/src/models/schedule.js';
import { routeBlockHours } from '../packages/engine/src/utils/simulation.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const jet = AIRCRAFT_TYPES.find(t => t.category === 'Narrow Body' && !t.freighter);
const route = (id, stops, f, starts) => ({
  id, origin: stops[0], destination: stops.at(-1), stops, weeklyFrequency: f,
  ...(starts ? { schedule: { starts } } : {}),
});
const noOverlap = (blocks) => {
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    assert.ok(!overlaps(blocks[i].start, blocks[i].dur, blocks[j].start, blocks[j].dur),
      `${blocks[i].key} overlaps ${blocks[j].key}`);
  }
};

// ── Time zones ────────────────────────────────────────────────────────────────
test('standard offsets, including countries split across zones', () => {
  const want = { SYD: 10, PER: 8, ADL: 9.5, LHR: 0, CDG: 1, MAD: 1, JFK: -5, ORD: -6, DEN: -7,
    LAX: -8, HNL: -10, ANC: -9, YYC: -7, DEL: 5.5, SIN: 8, NRT: 9, SVO: 3, GRU: -3, CUN: -5, DPS: 8 };
  for (const [c, h] of Object.entries(want)) assert.equal(utcOffsetHours(getAirport(c)), h, c);
});

// ── Building blocks ───────────────────────────────────────────────────────────
test('pins are cleaned: whole minutes in the week, distinct, sorted, ≤ frequency', () => {
  assert.deepEqual(normalizeStarts([100, 100, 10085, -5, 'x', 7.4], 9), [5, 7, 100, 10075]);
  assert.deepEqual(normalizeStarts([1, 2, 3], 2), [1, 2]);
  assert.deepEqual(normalizeStarts(null, 3), []);
});

test('a rotation is the engine block time: every leg out and back, flight + turnaround', () => {
  const r = route('t', ['MCI', 'JFK', 'ORY'], 1);
  const rot = routeRotation(r, jet);
  assert.deepEqual(rot.legs.map(l => `${l.from}-${l.to}`), ['MCI-JFK', 'JFK-ORY', 'ORY-JFK', 'JFK-MCI']);
  assert.ok(Math.abs(rot.durMin / 60 - routeBlockHours(r, jet, 1)) < 0.1, `${rot.durMin / 60} h`);
});

test('cyclic overlap understands the week wrapping', () => {
  assert.ok(overlaps(WEEK_MIN - 60, 120, 30, 10), 'Sunday 23:00 + 2h covers Monday 00:30');
  assert.ok(!overlaps(WEEK_MIN - 60, 60, 0, 10), 'ends exactly at Monday 00:00');
  assert.ok(!overlaps(0, 60, 60, 60), 'back to back is fine');
});

// ── The automatic week ────────────────────────────────────────────────────────
test('no pins: every rotation placed, daily in the 06:00–09:00 local wave, no overlaps', () => {
  const w = aircraftWeek([route('a', ['SYD', 'MEL'], 7)], jet, 'tail-1');
  assert.equal(w.blocks.length, 7);
  assert.equal(w.blocks.every(b => !b.pinned), true);
  noOverlap(w.blocks);
  const locals = w.blocks.map(b => wrapWeek(b.start + 600) % 1440);   // SYD is UTC+10
  for (const l of locals) assert.ok(l >= 355 && l <= 545, `departs ${Math.floor(l / 60)}:${l % 60} local`);
  assert.ok(Math.max(...locals) - Math.min(...locals) <= 10, 'same time every day');
});

test('two tails on the same pair leave at different times', () => {
  const a = aircraftWeek([route('a', ['SYD', 'MEL'], 7)], jet, 'tail-1');
  const b = aircraftWeek([route('b', ['SYD', 'MEL'], 7)], jet, 'tail-2');
  assert.notEqual(a.blocks[0].start, b.blocks[0].start);
});

test('one tail on several routes: interleaved, never in two places at once', () => {
  const routes = [route('a', ['SYD', 'MEL'], 14), route('b', ['SYD', 'BNE'], 7), route('c', ['SYD', 'ADL'], 3)];
  const w = aircraftWeek(routes, jet);
  assert.equal(w.blocks.length, 24);
  noOverlap(w.blocks);
  const seq = w.blocks.map(b => b.routeId).join('');
  assert.ok(!/aaaa/.test(seq), `14× and 7× alternate rather than bunch: ${seq}`);
});

test('pins are honoured; the automatic rotations flow around them', () => {
  const w0 = aircraftWeek([route('a', ['SYD', 'MEL'], 7)], jet);
  const pin = wrapWeek(w0.blocks[2].start + 7 * 60);       // 7 hours later than auto
  const w = aircraftWeek([route('a', ['SYD', 'MEL'], 7, [pin])], jet);
  assert.equal(w.blocks.length, 7);
  assert.equal(w.blocks.filter(b => b.pinned).length, 1);
  assert.equal(w.blocks.find(b => b.pinned).start, pin);
  noOverlap(w.blocks);
  // The pin replaced the automatic flight nearest it, not one at random.
  const autoStarts = w.blocks.filter(b => !b.pinned).map(b => b.start);
  assert.ok(!autoStarts.includes(w0.blocks[2].start), 'its own automatic slot was taken over');
});

test('overlapping pins: the later one is demoted to automatic, never drawn on top', () => {
  const w = aircraftWeek([route('a', ['SYD', 'PER'], 7, [600]), route('b', ['SYD', 'MEL'], 7, [700])], jet);
  assert.deepEqual(w.demoted, [{ routeId: 'b', start: 700 }]);
  assert.equal(w.blocks.length, 14);
  noOverlap(w.blocks);
});

test('pins packed so tight the rest cannot fit report overflow instead of overlapping', () => {
  const rot = routeRotation(route('x', ['SYD', 'PER'], 1), jet);
  // Pin 4 of 5 rotations spread so no gap is left that's long enough.
  const step = Math.floor(WEEK_MIN / 4);
  const f = Math.floor((140 * 60) / rot.durMin);
  const w = aircraftWeek([route('a', ['SYD', 'PER'], f, [0, step, 2 * step, 3 * step])], jet);
  noOverlap(w.blocks);
  const placed = w.blocks.length + (w.overflow[0]?.count ?? 0);
  assert.equal(placed, f, 'every rotation is either placed or reported');
});

test('moves: only pins block a drop; pinning and unpinning edit one route', () => {
  const w = aircraftWeek([route('a', ['SYD', 'MEL'], 7, [600])], jet);
  const pinned = w.blocks.find(b => b.pinned);
  const auto = w.blocks.find(b => !b.pinned);
  assert.equal(canPlace(w, 'a', pinned.dur, pinned.start + 30, auto), false, 'onto a pin');
  assert.equal(canPlace(w, 'a', pinned.dur, pinned.start + 30, pinned), true, 'a pin may move over its old self');
  assert.equal(canPlace(w, 'a', auto.dur, auto.start + 10, auto), true, 'an automatic flight may move over its old self');
  // Editing a route pins it as shown, with only the moved flight changed.
  const all = w.blocks.map(b => b.start);
  const sorted = (xs) => [...xs].sort((x, y) => x - y);
  assert.deepEqual(pinsAfterMove(w, 'a', auto, 2000), sorted([...all.filter(s => s !== auto.start), 2000]));
  assert.deepEqual(pinsAfterMove(w, 'a', pinned, 2000), sorted([...all.filter(s => s !== 600), 2000]));
  assert.equal(pinsAfterMove(w, 'a', null, 3000).length, 7, 'a tray drop replaces one automatic flight');
  assert.ok(pinsAfterMove(w, 'a', null, 3000).includes(3000));
  assert.deepEqual(pinsAfterUnpin(w, 'a', 600), []);
});

test('departures: every leg of every rotation, timed from the block start', () => {
  const w = aircraftWeek([route('t', ['MCI', 'JFK', 'ORY'], 2)], jet);
  const deps = weekDepartures(w);
  assert.equal(deps.length, 8);
  const first = w.blocks[0];
  const legs = deps.filter(d => d.utcMin >= first.start && d.utcMin < first.start + first.dur);
  assert.deepEqual(legs.map(d => `${d.from}-${d.to}`), ['MCI-JFK', 'JFK-ORY', 'ORY-JFK', 'JFK-MCI']);
  assert.equal(legs[0].utcMin, first.start);
  assert.equal(legs[1].utcMin - legs[0].utcMin, first.legs[0].flightMin + first.legs[0].turnMin);
});

test('airline weeks: per tail, passenger and cargo, dormant seasonal routes take no time', () => {
  // A long-haul jet freighter (a 300 km/h C-46 can't fly HKG–NRT 3× a week).
  const fr = AIRCRAFT_TYPES.find(t => t.freighter && (t.cruiseKmh ?? 0) >= 800 && (t.range ?? 0) >= 9000);
  const st = {
    fleet: [{ id: 'p', typeId: jet.id }, { id: 'f', typeId: fr.id }],
    routes: [
      { ...route('a', ['SYD', 'MEL'], 7), aircraftId: 'p' },
      { ...route('s', ['SYD', 'HBA'], 3), aircraftId: 'p', season: { months: [12, 1, 2] } },
    ],
    cargoRoutes: [{ id: 'c', origin: 'HKG', destination: 'LAX', weeklyFrequency: 3, aircraftId: 'f' }],
  };
  const june = airlineWeeks(st, 6);
  assert.equal(june.get('p').blocks.length, 7);
  assert.equal(june.get('f').blocks.length, 3);
  assert.equal(airlineWeeks(st, 1).get('p').blocks.length, 10);
});

// ── Review fixes (2026-10-14) ────────────────────────────────────────────────
const startsOf = (w, id) => w.blocks.filter(b => b.routeId === id).map(b => b.start).sort((x, y) => x - y);
const applyPins = (routes, id, pins) => routes.map(r => (r.id === id ? { ...r, schedule: { starts: pins } } : r));

test('dragging an AUTOMATIC flight moves that flight — nothing else changes', () => {
  const routes = [route('a', ['LHR', 'CDG'], 7)];
  const w0 = aircraftWeek(routes, jet, 't');
  for (const k of [0, 3, 6]) {
    const from = w0.blocks[k];
    const to = wrapWeek(from.start + 2 * 1440 + 180);
    const w1 = aircraftWeek(applyPins(routes, 'a', pinsAfterMove(w0, 'a', from, to)), jet, 't');
    const want = [...startsOf(w0, 'a').filter(s => s !== from.start), to].sort((x, y) => x - y);
    assert.deepEqual(startsOf(w1, 'a'), want, `drag block ${k}`);
  }
});

test('nudging an automatic flight that had slid off its ideal slot still moves it', () => {
  const routes = [route('a', ['SYD', 'MEL'], 14), route('b', ['SYD', 'PER'], 4, [0, 2520, 5040, 7560])];
  const w0 = aircraftWeek(routes, jet, 't');
  const from = w0.blocks.find(b => b.routeId === 'a' && !b.pinned);
  const to = wrapWeek(from.start + 15);
  if (canPlace(w0, 'a', from.dur, to, null)) {
    const w1 = aircraftWeek(applyPins(routes, 'a', pinsAfterMove(w0, 'a', from, to)), jet, 't');
    assert.ok(startsOf(w1, 'a').includes(to));
    assert.ok(!startsOf(w1, 'a').includes(from.start), 'the old time is gone');
  }
});

test('a drag cannot land on the same route\u2019s other flights (they become pins); other routes\u2019 automatic flights move aside', () => {
  const routes = [route('a', ['SYD', 'PER'], 7), route('b', ['SYD', 'MEL'], 7)];
  const w0 = aircraftWeek(routes, jet, 't');
  const a0 = w0.blocks.find(b => b.routeId === 'a'), a2 = w0.blocks.filter(b => b.routeId === 'a')[2];
  const onto = wrapWeek(a2.start - 60);   // overlaps a2
  assert.equal(canPlace(w0, 'a', a0.dur, onto, a0), false, 'onto its own route');
  const b1 = w0.blocks.find(b => b.routeId === 'b');
  const ontoB = wrapWeek(b1.start + 5);
  if (w0.blocks.filter(b => b.routeId === 'a' && b !== a0).every(b => !overlaps(ontoB, a0.dur, b.start, b.dur))) {
    assert.equal(canPlace(w0, 'a', a0.dur, ontoB, a0), true, 'onto an automatic flight of another route');
    const w1 = aircraftWeek(applyPins(routes, 'a', pinsAfterMove(w0, 'a', a0, ontoB)), jet, 't');
    assert.ok(startsOf(w1, 'a').includes(ontoB) && !startsOf(w1, 'a').includes(a0.start));
    noOverlap(w1.blocks);
    assert.equal(startsOf(w1, 'b').length, 7, 'route b moved aside, nothing lost');
  }
});

test('every accepted move lands exactly where it was dropped (fuzz)', () => {
  const routes = [route('a', ['SYD', 'PER'], 7), route('b', ['SYD', 'MEL'], 10), route('c', ['SYD', 'BNE'], 5, [300, 3000])];
  const w0 = aircraftWeek(routes, jet, 't');
  let accepted = 0;
  for (let k = 0; k < 400; k++) {
    const from = w0.blocks[k % w0.blocks.length];
    const to = wrapWeek(from.start + ((k * 397) % WEEK_MIN));
    if (!canPlace(w0, from.routeId, from.dur, to, from)) continue;
    accepted++;
    const w1 = aircraftWeek(applyPins(routes, from.routeId, pinsAfterMove(w0, from.routeId, from, to)), jet, 't');
    assert.ok(startsOf(w1, from.routeId).includes(to), `landed at ${to}`);
    assert.deepEqual(w1.demoted, []);
    noOverlap(w1.blocks);
  }
  assert.ok(accepted > 20, `${accepted} moves tried`);
});

test('dropping from the tray replaces the automatic flight nearest the drop', () => {
  const routes = [route('a', ['LHR', 'CDG'], 7)];
  const w0 = aircraftWeek(routes, jet, 't');
  const target = w0.blocks[4];
  const to = wrapWeek(target.start + 60);
  const w1 = aircraftWeek(applyPins(routes, 'a', pinsAfterMove(w0, 'a', null, to)), jet, 't');
  const want = [...startsOf(w0, 'a').filter(s => s !== target.start), to].sort((x, y) => x - y);
  assert.deepEqual(startsOf(w1, 'a'), want);
});

test('route order is by code point, not the browser locale (same timetable everywhere)', () => {
  // 'B' < 'a' by code point; localeCompare says the opposite. The first route
  // sets the anchor zone, so the order changes every time on the week.
  const w = aircraftWeek([route('a', ['SYD', 'MEL'], 7), route('B', ['LHR', 'CDG'], 7)], jet, '');
  const lhrSix = wrapWeek(6 * 60 - 0);
  assert.ok(wrapWeek(w.anchor - lhrSix) <= 180, `anchored on LHR (route 'B' first), got ${w.anchor}`);
});

test('several tails on one pair never leave at the same minute', () => {
  const ids = ['mg7x2k1', 'mg7x2k9', 'mh01aa', 'mh01ab', 'q9', 'zz3'];
  const st = {
    fleet: ids.map(id => ({ id, typeId: jet.id })),
    routes: ids.map((id, i) => ({ ...route(`r${i}`, ['SYD', 'MEL'], 7), aircraftId: id })),
  };
  const firsts = [...airlineWeeks(st, 3).values()].map(w => w.blocks[0].start % 1440).sort((x, y) => x - y);
  for (let i = 1; i < firsts.length; i++) assert.ok(firsts[i] - firsts[i - 1] >= 5, `departures ${firsts}`);
});

test('more time zones: Boise (Mountain), Las Vegas, Spokane, Yakutsk, Vladivostok', () => {
  const want = { BOI: -7, LAS: -8, GEG: -8, YKS: 9, VVO: 10, KHV: 10, IKT: 8 };
  for (const [c, h] of Object.entries(want)) assert.equal(utcOffsetHours(getAirport(c)), h, c);
});

// ── Audit round 2 (2026-10-14) ───────────────────────────────────────────────
test('a dragged block that is a stale copy (state replaced mid-drag) still moves the right flight', () => {
  const routes = [route('a', ['SYD', 'MEL'], 7)];
  const w0 = aircraftWeek(routes, jet, 't');
  const stale = { ...w0.blocks[0], legs: [...w0.blocks[0].legs] };   // same flight, new object
  const wNow = aircraftWeek(routes, jet, 't');                         // the "new state" week
  const to = wrapWeek(stale.start + 2 * 1440 + 120);
  assert.equal(canPlace(wNow, 'a', stale.dur, wrapWeek(stale.start + 30), stale), true, 'a short move is not blocked by its own old copy');
  const pins = pinsAfterMove(wNow, 'a', stale, to);
  assert.equal(pins.length, 7, `never more pins than flights: ${pins}`);
  assert.ok(pins.includes(to) && !pins.includes(stale.start));
});

test('a move whose flight no longer exists is refused, not guessed', () => {
  const w = aircraftWeek([route('a', ['SYD', 'MEL'], 7)], jet, 't');
  const ghost = { ...w.blocks[0], start: wrapWeek(w.blocks[0].start + 7) };
  assert.equal(pinsAfterMove(w, 'a', ghost, 100), null);
  const full = aircraftWeek([route('b', ['SYD', 'MEL'], 2, [0, 5000])], jet, 't');
  assert.equal(pinsAfterMove(full, 'b', null, 3000), null, 'a tray drop with nothing automatic left');
});

test('reassigning a route onto a busy tail returns it to automatic; transferring a whole week keeps it', () => {
  const st = {
    ...freshState(),
    fleet: [{ id: 'p', typeId: jet.id, status: 'assigned' }, { id: 'q', typeId: jet.id, status: 'assigned' }, { id: 'z', typeId: jet.id, status: 'idle' }],
    routes: [
      { ...route('a', ['SYD', 'MEL'], 3, [100, 2000, 4000]), aircraftId: 'p' },
      { ...route('b', ['SYD', 'BNE'], 3, [150, 2050, 4050]), aircraftId: 'q' },
    ],
    cargoRoutes: [],
  };
  const re = gameReducer(st, { type: 'REASSIGN_ROUTE', routeId: 'a', toAircraftId: 'q' });
  if (re !== st) {
    assert.equal(re.routes.find(r => r.id === 'a').schedule, undefined, 'its pins would clash with the tail it joined');
    assert.deepEqual(re.routes.find(r => r.id === 'b').schedule, { starts: [150, 2050, 4050] }, 'the incumbent keeps its times');
  }
  const tr = gameReducer(st, { type: 'TRANSFER_ROUTES', fromAircraftId: 'p', toAircraftId: 'z' });
  if (tr !== st) assert.deepEqual(tr.routes.find(r => r.id === 'a').schedule, { starts: [100, 2000, 4000] });
});

test('time-zone corrections for airports a longitude rule gets wrong', () => {
  const want = { AMA: -6, LBB: -6, MAF: -6, YUM: -7, DHN: -6, ESC: -5, ADK: -10, YQR: -6, YXE: -6, YLW: -8,
    YXY: -7, TPQ: -7, CTM: -5, IGU: -3, STM: -3, TBT: -4, FEN: -2, AMQ: 9, TTE: 9, ASF: 4, IJK: 4, SCW: 3,
    VKT: 3, SGC: 5, NJC: 5, NUX: 5, DYR: 12, TKK: 10, PUQ: -3 };
  for (const [c, h] of Object.entries(want)) {
    const a = getAirport(c);
    if (a) assert.equal(utcOffsetHours(a), h, c);
  }
});

test('adding a tail to a busy pair leaves the other tails’ automatic times alone', () => {
  const ids = ['mg7x2k1', 'mg7x2k9', 'mh01aa', 'mh01ab', 'q9'];
  const mk = (list) => ({
    fleet: list.map(id => ({ id, typeId: jet.id })),
    routes: list.map(id => ({ ...route(`r-${id}`, ['SYD', 'MEL'], 7), aircraftId: id })),
  });
  const before = airlineWeeks(mk(ids), 3), after = airlineWeeks(mk([...ids, 'n3w']), 3);
  const moved = ids.filter(id => before.get(id).blocks[0].start !== after.get(id).blocks[0].start);
  assert.ok(moved.length <= 1, `moved: ${moved}`);
});

// ── Reducer + server ──────────────────────────────────────────────────────────
const base = () => ({
  ...freshState(),
  fleet: [{ id: 'p', typeId: jet.id, status: 'assigned' }],
  routes: [{ ...route('a', ['SYD', 'MEL'], 3), aircraftId: 'p' }],
  cargoRoutes: [{ id: 'c', origin: 'HKG', destination: 'LAX', weeklyFrequency: 2, aircraftId: 'p' }],
});

test('SET_ROUTE_SCHEDULES pins, clamps to frequency, clears, and reaches cargo', () => {
  let s = gameReducer(base(), { type: 'SET_ROUTE_SCHEDULES', schedules: { a: [900, 100, 5000, 7000], c: [60] } });
  assert.deepEqual(s.routes[0].schedule, { starts: [100, 900, 5000] });
  assert.deepEqual(s.cargoRoutes[0].schedule, { starts: [60] });
  s = gameReducer(s, { type: 'SET_ROUTE_SCHEDULES', schedules: { a: null } });
  assert.equal('schedule' in s.routes[0], false, 'null → back to automatic');
  assert.deepEqual(s.cargoRoutes[0].schedule, { starts: [60] }, 'untouched routes keep their pins');
});

test('SET_ROUTE_SCHEDULES changes nothing else (cash, frequency) and ignores unknown routes', () => {
  const b = base();
  const s = gameReducer(b, { type: 'SET_ROUTE_SCHEDULES', schedules: { a: [100] } });
  assert.equal(s.cash, b.cash);
  assert.equal(s.routes[0].weeklyFrequency, 3);
  assert.equal(gameReducer(b, { type: 'SET_ROUTE_SCHEDULES', schedules: { nope: [1] } }), b);
  assert.equal(gameReducer(b, { type: 'SET_ROUTE_SCHEDULES' }), b);
});

test('SET_ROUTE_SCHEDULES that changes nothing returns the same state', () => {
  const b = base();
  assert.equal(gameReducer(b, { type: 'SET_ROUTE_SCHEDULES', schedules: { a: null } }), b, 'clearing nothing');
  const s1 = gameReducer(b, { type: 'SET_ROUTE_SCHEDULES', schedules: { a: [100, 900] } });
  assert.equal(gameReducer(s1, { type: 'SET_ROUTE_SCHEDULES', schedules: { a: [900, 100] } }), s1, 'same pins');
});

test('server: a stale route id is skipped, not a reason to reject the batch; big airlines can reset', () => {
  const st = base();
  assert.deepEqual(guardDecision('SET_ROUTE_SCHEDULES', { schedules: { a: [5], gone: [1] } }, st), { schedules: { a: [5] } });
  const many = { ...st, routes: Array.from({ length: 1200 }, (_, i) => ({ id: `r${i}`, weeklyFrequency: 7 })) };
  const all = Object.fromEntries(many.routes.map(r => [r.id, null]));
  assert.equal(Object.keys(guardDecision('SET_ROUTE_SCHEDULES', { schedules: all }, many).schedules).length, 1200);
});

test('server: allowed, own routes only, cleaned lists', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_ROUTE_SCHEDULES'));
  const st = base();
  assert.deepEqual(guardDecision('SET_ROUTE_SCHEDULES', { schedules: { a: [5, 5, -1, 20000] } }, st),
    { schedules: { a: [5, 9920, 10079] } });
  assert.deepEqual(guardDecision('SET_ROUTE_SCHEDULES', { schedules: { a: null } }, st), { schedules: { a: null } });
  assert.throws(() => guardDecision('SET_ROUTE_SCHEDULES', { schedules: { zz: [1] } }, st), /Unknown route/);
  assert.throws(() => guardDecision('SET_ROUTE_SCHEDULES', { schedules: { a: 'x' } }, st), /list/);
  assert.throws(() => guardDecision('SET_ROUTE_SCHEDULES', {}, st));
});

// ── Typed departure times ─────────────────────────────────────────────────────
// A route's week is typed as a few rows — a clock time and the days it leaves
// at that time — so a 14×/week route is two times typed once, not fourteen
// moves; single days can then be changed alone.
const SYD = 600;   // UTC+10
const ALL = Array(7).fill(true);
const onDays = (...ds) => Array.from({ length: 7 }, (_, d) => ds.includes(d));
const localTimes = (w, id, off = SYD) => w.blocks.filter(b => b.routeId === id).map(b => localDayTime(b.start, off));
const rebuilt = (routes, id, pins, seed) => aircraftWeek(routes.map(r => (r.id === id ? { ...r, schedule: { starts: pins } } : r)), jet, seed);
const ceil5 = (m) => Math.ceil(m / 5) * 5;   // typed times sit on the five-minute grid

test('typed times: what people type is read as a clock time, and nothing else is', () => {
  for (const [text, want] of [['7:30', 450], ['07:30', 450], ['0730', 450], ['730', 450], ['07.30', 450], ['7', 420],
    ['19', 1140], ['7pm', 1140], ['7:30 PM', 1170], ['12am', 0], ['12:15pm', 735], ['0:00', 0], ['23:59', 1439], [' 6:05 ', 365]]) {
    assert.equal(parseClock(text), want, text);
  }
  for (const bad of ['', '24:00', '25', '7:60', '7:5', 'noon', '13pm', '0pm', '7:30:00', '-7', '7 30 x']) {
    assert.equal(parseClock(bad), null, JSON.stringify(bad));
  }
  assert.equal(clockLabel(450), '07:30');
  assert.equal(clockLabel(0), '00:00');
  assert.equal(clockLabel(1439), '23:59');
  assert.equal(snapClock(452), 450);
  assert.equal(snapClock(1438), 0, '23:58 rounds to midnight, not to minute 1440');
});

test('typed times: a local day and time is one minute of the UTC week, both ways', () => {
  // Mon 08:00 in Sydney is Sun 22:00 UTC.
  assert.equal(utcOfLocal(0, 480, SYD), 9960);
  assert.deepEqual(localDayTime(9960, SYD), { day: 0, tod: 480 });
  for (const off of [-600, -210, 0, 345, 600, 765]) for (const day of [0, 3, 6]) for (const tod of [0, 5, 725, 1435]) {
    assert.deepEqual(localDayTime(utcOfLocal(day, tod, off), off), { day, tod }, `${off}/${day}/${tod}`);
  }
});

test('typed times: one time on a daily route puts all seven flights at it, a day each', () => {
  const routes = [route('a', ['SYD', 'MEL'], 7)];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const r = pinsForTimetable(w, 'a', [{ tod: 450, days: ALL }], SYD);
  assert.equal(r.flights, 7);
  assert.equal(r.timed, 7);
  assert.equal(r.set, 7);
  assert.deepEqual(r.bumped, []);
  assert.deepEqual(r.auto, []);
  const after = rebuilt(routes, 'a', r.pins, 'tail-1');
  assert.equal(after.blocks.filter(b => b.pinned).length, 7);
  assert.deepEqual(after.demoted, []);
  assert.deepEqual(localTimes(after, 'a').map(x => x.tod), Array(7).fill(450));
  assert.deepEqual(localTimes(after, 'a').map(x => x.day).sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('typed times: fourteen flights a week are two times typed once', () => {
  const routes = [route('a', ['SYD', 'MEL'], 14)];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const r = pinsForTimetable(w, 'a', [{ tod: 1110, days: ALL }, { tod: 390, days: ALL }], SYD);   // typed out of order
  assert.equal(r.set, 14);
  assert.equal(r.pins.length, 14);
  const after = rebuilt(routes, 'a', r.pins, 'tail-1');
  assert.deepEqual(after.demoted, []);
  noOverlap(after.blocks);
  for (const day of routeDays(after, 'a', SYD)) assert.deepEqual(day.map(x => x.tod), [390, 1110]);
});

test('typed times: each time has its own days — ten a week is a daily flight and a three-day one', () => {
  const routes = [route('a', ['SYD', 'MEL'], 10)];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const r = pinsForTimetable(w, 'a', [{ tod: 420, days: ALL }, { tod: 1080, days: onDays(0, 2, 4) }], SYD);
  assert.equal(r.set, 10);
  const days = routeDays(rebuilt(routes, 'a', r.pins, 'tail-1'), 'a', SYD);
  assert.deepEqual(days.map(d => d.map(x => x.tod)), [[420, 1080], [420], [420, 1080], [420], [420, 1080], [420], [420]]);
});

test('typed times: a time unticked on a day moves that day’s flight off it', () => {
  // The automatic week of a 3×/week route sits on three days; the player picks different ones.
  const routes = [route('a', ['SYD', 'PER'], 3)];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const r = pinsForTimetable(w, 'a', [{ tod: parseClock('9:15'), days: onDays(1, 3, 6) }], SYD);
  const after = rebuilt(routes, 'a', r.pins, 'tail-1');
  assert.deepEqual(localTimes(after, 'a'), [{ day: 1, tod: 555 }, { day: 3, tod: 555 }, { day: 6, tod: 555 }]);
});

test('typed times: fewer departures than flights leaves the rest automatic; more is refused', () => {
  const routes = [route('a', ['SYD', 'MEL'], 7)];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const five = pinsForTimetable(w, 'a', [{ tod: 600, days: onDays(0, 1, 2, 3, 4) }], SYD);
  assert.equal(five.timed, 5);
  assert.equal(five.pins.length, 5);
  const after = rebuilt(routes, 'a', five.pins, 'tail-1');
  assert.equal(after.blocks.filter(b => b.pinned).length, 5);
  assert.equal(after.blocks.filter(b => !b.pinned).length, 2, 'the weekend flights are still flown, placed automatically');
  noOverlap(after.blocks);
  assert.deepEqual(pinsForTimetable(w, 'a', [{ tod: 600, days: ALL }, { tod: 1000, days: onDays(5) }], SYD),
    { error: 'too-many', timed: 8, flights: 7 });
  // Nothing typed, or no day ticked: nothing to do.
  assert.equal(pinsForTimetable(w, 'a', [{ tod: null, days: ALL }], SYD), null);
  assert.equal(pinsForTimetable(w, 'a', [{ tod: 600, days: onDays() }], SYD), null);
  assert.equal(pinsForTimetable(w, 'a', [], SYD), null);
  // The same time typed on two rows is one departure a day, not two.
  assert.equal(pinsForTimetable(w, 'a', [{ tod: 600, days: ALL }, { tod: 601, days: ALL }], SYD).timed, 7);
});

test('typed times: two departures nearer than one round trip are refused, with the numbers to say why', () => {
  const routes = [route('a', ['SYD', 'MEL'], 14)];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const dur = w.blocks[0].dur;
  const r = pinsForTimetable(w, 'a', [{ tod: 420, days: ALL }, { tod: 420 + ceil5(dur) - 5, days: ALL }], SYD);
  assert.equal(r.error, 'too-close');
  assert.equal(r.dur, dur);
  assert.deepEqual([r.a.tod, r.b.tod], [420, 420 + ceil5(dur) - 5]);
  assert.equal(r.a.day, r.b.day);
  assert.equal(pinsForTimetable(w, 'a', [{ tod: 420, days: ALL }, { tod: 420 + ceil5(dur), days: ALL }], SYD).set, 14, 'one round trip apart is fine');
  // Across midnight too: the late flight is still out when the early one is due to leave.
  const late = pinsForTimetable(w, 'a', [{ tod: 1410, days: onDays(0) }, { tod: 30, days: onDays(1) }], SYD);
  assert.equal(late.error, 'too-close');
  assert.deepEqual([late.a, late.b], [{ day: 0, tod: 1410 }, { day: 1, tod: 30 }]);
  // A rotation longer than a day cannot leave daily.
  const far = [route('f', ['SYD', 'LAX'], 3)];
  const wf = aircraftWeek(far, jet, 'tail-1');
  if (wf.blocks[0].dur > 1440) {
    assert.equal(pinsForTimetable(wf, 'f', [{ tod: 600, days: onDays(0, 1, 2) }], SYD).error, 'too-close');
    assert.equal(pinsForTimetable(wf, 'f', [{ tod: 600, days: onDays(0, 2, 4) }], SYD).set, 3);
  }
});

test('typed times: a flight you set on another route is never moved — that day leaves at the nearest free time', () => {
  // Route b's Wednesday 07:00 is the player's; route a then asks for 07:30 daily.
  const bPin = utcOfLocal(2, 420, SYD);
  const routes = [route('a', ['SYD', 'MEL'], 7), route('b', ['SYD', 'BNE'], 7, [bPin])];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const r = pinsForTimetable(w, 'a', [{ tod: 450, days: ALL }], SYD);
  assert.equal(r.set, 6);
  assert.deepEqual(r.auto, []);
  const bDur = w.blocks.find(b => b.routeId === 'b').dur;
  // Nearest: straight after b's round trip, not somewhere across the day.
  assert.deepEqual(r.bumped, [{ day: 2, tod: 450, at: utcOfLocal(2, 420 + ceil5(bDur), SYD), by: { routeId: 'b', start: bPin } }]);
  const after = rebuilt(routes, 'a', r.pins, 'tail-1');
  noOverlap(after.blocks);
  assert.deepEqual(after.demoted, []);
  assert.ok(after.blocks.some(b => b.routeId === 'b' && b.pinned && b.start === bPin), 'b keeps its time');
  assert.equal(after.blocks.filter(b => b.routeId === 'a' && b.pinned).length, 7, 'all seven are still set');
  assert.deepEqual(routeDays(after, 'a', SYD).map(d => d.length), Array(7).fill(1), 'still one a day');
});

test('typed times: no room within twelve hours leaves that flight automatic rather than forcing it', () => {
  // Route b's flights are all the player's and run from Wednesday 08:00 for a
  // day and a half. Asking a for 20:00 daily leaves Wednesday with nowhere to go.
  const perth = routeRotation(route('x', ['SYD', 'PER'], 1), jet).durMin;
  const from = utcOfLocal(2, 480, SYD);
  const bPins = [];
  for (let t = 0; t + perth <= 36 * 60; t += perth) bPins.push(wrapWeek(from + t));
  const routes = [route('a', ['SYD', 'MEL'], 7), route('b', ['SYD', 'PER'], bPins.length, bPins)];
  const w = aircraftWeek(routes, jet, 'tail-1');
  assert.equal(w.demoted.length, 0, 'fixture: every pin stands');
  assert.ok(bPins.length * perth >= 24 * 60, 'fixture: b runs unbroken past Thursday 08:00, twelve hours after the typed time');
  const r = pinsForTimetable(w, 'a', [{ tod: 1200, days: ALL }], SYD);
  assert.deepEqual(r.auto.map(x => [x.day, x.tod, x.by.routeId]), [[2, 1200, 'b']]);
  assert.equal(r.pins.length, 6);
  assert.equal(r.set + r.bumped.length, 6);
  const after = rebuilt(routes, 'a', r.pins, 'tail-1');
  noOverlap(after.blocks);
  assert.deepEqual(after.demoted, []);
  assert.equal(routeFlights(after, 'a'), 7, 'the seventh flight is still flown, placed automatically');
});

test('typed times: one day can then be changed on its own', () => {
  const routes = [route('a', ['SYD', 'MEL'], 7)];
  const w0 = aircraftWeek(routes, jet, 'tail-1');
  const daily = pinsForTimetable(w0, 'a', [{ tod: 450, days: ALL }], SYD);
  const w = rebuilt(routes, 'a', daily.pins, 'tail-1');
  const sat = routeDays(w, 'a', SYD)[5][0].b;
  const to = utcOfLocal(5, parseClock('10:00'), SYD);
  assert.equal(blockerFor(w, 'a', sat.dur, to, sat), null);
  assert.equal(canPlace(w, 'a', sat.dur, to, sat), true);
  const after = rebuilt(routes, 'a', pinsAfterMove(w, 'a', sat, to), 'tail-1');
  assert.deepEqual(routeDays(after, 'a', SYD).map(d => d[0].tod), [450, 450, 450, 450, 450, 600, 450]);
  // …and the editor reads the week back as the player left it: 07:30 on six days, 10:00 on Saturday.
  assert.deepEqual(timetableRows(after, 'a', SYD, 0), [
    { tod: 450, days: onDays(0, 1, 2, 3, 4, 6) },
    { tod: 600, days: onDays(5) },
  ]);
});

test('typed times: a single flight that cannot go where typed names what is in the way', () => {
  const bPin = utcOfLocal(2, 420, SYD);
  const routes = [route('a', ['SYD', 'MEL'], 7), route('b', ['SYD', 'BNE'], 7, [bPin])];
  const w = aircraftWeek(routes, jet, 'tail-1');
  const a = w.blocks.filter(b => b.routeId === 'a');
  const by = blockerFor(w, 'a', a[0].dur, utcOfLocal(2, 450, SYD), a[0]);
  assert.equal(by?.routeId, 'b');
  assert.equal(by?.start, bPin);
  assert.equal(canPlace(w, 'a', a[0].dur, utcOfLocal(2, 450, SYD), a[0]), false, 'and canPlace agrees');
  // Its own other flights block it as well (a move sets them all).
  assert.equal(blockerFor(w, 'a', a[0].dur, a[1].start, a[0])?.start, a[1].start);
});

test('typed times: the rows offered for an untouched route are the tidy timetable its frequency implies', () => {
  const tods = (rows) => rows.map(r => r.tod);
  // Daily on its own tail: one row, every day, at the time it leaves now.
  const w7 = aircraftWeek([route('a', ['SYD', 'MEL'], 7)], jet, 'tail-1');
  const now = snapClock(localDayTime(w7.blocks[0].start, SYD).tod);
  assert.deepEqual(timetableRows(w7, 'a', SYD, localDayTime(w7.blocks[0].start, SYD).day), [{ tod: now, days: ALL }]);
  // Fourteen: two rows, every day.
  const w14 = aircraftWeek([route('a', ['SYD', 'MEL'], 14)], jet, 'tail-1');
  const r14 = timetableRows(w14, 'a', SYD, 3);
  assert.deepEqual(r14.map(r => r.days), [ALL, ALL]);
  assert.ok(tods(r14).every(Number.isFinite) && r14[0].tod < r14[1].tod);
  // Ten: a daily row and a three-day row.
  const w10 = aircraftWeek([route('a', ['SYD', 'MEL'], 10)], jet, 'tail-1');
  const r10 = timetableRows(w10, 'a', SYD, 0);
  assert.deepEqual(r10.map(r => r.days.filter(Boolean).length), [7, 3]);
  // …with a time on both rows whichever day is being looked at, one-flight days included.
  for (let d = 0; d < 7; d++) assert.ok(tods(timetableRows(w10, 'a', SYD, d)).every(Number.isFinite), `day ${d}`);
  // Three a week: one row on the three days it flies now.
  const w3 = aircraftWeek([route('a', ['SYD', 'PER'], 3)], jet, 'tail-1');
  const r3 = timetableRows(w3, 'a', SYD, localDayTime(w3.blocks[0].start, SYD).day);
  assert.equal(r3.length, 1);
  assert.deepEqual(r3[0].days, onDays(...localTimes(w3, 'a').map(x => x.day)));
  // Sharing a tail, the automatic week bunches (two on one day, none on another) — still offered as one daily row.
  const mixed = [route('a', ['SYD', 'MEL'], 7), route('b', ['SYD', 'PER'], 5)];
  const wm = aircraftWeek(mixed, jet, 'tail-1');
  assert.deepEqual(timetableRows(wm, 'a', SYD, 0).map(r => r.days), [ALL]);
  // Whatever is offered can be set as it stands (once any blank time is filled in).
  for (const [w, id] of [[w7, 'a'], [w14, 'a'], [w10, 'a'], [w3, 'a'], [wm, 'a'], [wm, 'b']]) {
    const dur = w.blocks.find(b => b.routeId === id).dur;
    const rows = timetableRows(w, id, SYD, 0).map((r, i) => ({ ...r, tod: 300 + i * ceil5(dur) }));
    const res = pinsForTimetable(w, id, rows, SYD);
    assert.equal(res.error, undefined, `${id}: ${JSON.stringify(res)}`);
    assert.equal(res.timed, routeFlights(w, id), 'the offered rows cover every flight, no more and no fewer');
  }
});

test('typed times: whatever is typed, the result never overlaps and never unseats a set flight (fuzz)', () => {
  let seed = 20261110;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const dests = ['MEL', 'BNE', 'ADL', 'CBR', 'OOL', 'PER', 'AKL'];
  let ok = 0, bumped = 0, auto = 0, refused = 0;
  for (let n = 0; n < 600; n++) {
    const picks = [...dests].sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * 3));
    let hours = 0;
    const routes = picks.map((d, i) => {
      const rot = routeRotation(route('x', ['SYD', d], 1), jet).durMin / 60;
      const f = Math.max(1, Math.min(Math.floor((90 - hours) / rot / (picks.length - i)), 1 + Math.floor(rnd() * 16)));
      hours += f * rot;
      return route(`r${i}`, ['SYD', d], f);
    });
    // Some of the other routes' flights are the player's already.
    const w0 = aircraftWeek(routes, jet, `t${n}`);
    for (const r of routes.slice(1)) {
      const keep = w0.blocks.filter(b => b.routeId === r.id).filter(() => rnd() < 0.4).map(b => b.start);
      if (keep.length) r.schedule = { starts: keep };
    }
    const w = aircraftWeek(routes, jet, `t${n}`);
    const fixedBefore = w.blocks.filter(b => b.pinned).map(b => `${b.routeId}@${b.start}`).sort();
    const off = [600, 0, -300, 345][n % 4];
    // Start from the offered rows, then scribble on them: random times, a few days flipped.
    const rows = timetableRows(w, 'r0', off, Math.floor(rnd() * 7)).map(r => ({
      tod: Math.floor(rnd() * 288) * 5,
      days: r.days.map(on => (rnd() < 0.15 ? !on : on)),
    }));
    const r = pinsForTimetable(w, 'r0', rows, off);
    if (!r || r.error) { refused++; continue; }
    ok++; bumped += r.bumped.length; auto += r.auto.length;
    assert.equal(r.set + r.bumped.length + r.auto.length, r.timed, 'every departure is set, moved aside or left automatic');
    assert.equal(r.pins.length, r.set + r.bumped.length);
    assert.ok(r.timed <= r.flights);
    const after = rebuilt(routes, 'r0', r.pins, `t${n}`);
    noOverlap(after.blocks);
    assert.deepEqual(after.demoted, [], `run ${n}`);
    assert.deepEqual(after.blocks.filter(b => b.routeId === 'r0' && b.pinned).map(b => b.start), r.pins,
      `run ${n}: every pin stands exactly where it was put`);
    assert.deepEqual(after.blocks.filter(b => b.pinned && b.routeId !== 'r0').map(b => `${b.routeId}@${b.start}`).sort(), fixedBefore,
      `run ${n}: the other routes' set flights did not move`);
    assert.equal(routeFlights(after, 'r0'), r.flights, `run ${n}: the route still flies as often`);
    const want = new Set(rows.flatMap(row => row.days.map((on, d) => (on ? utcOfLocal(d, snapClock(row.tod), off) : null))).filter(x => x != null));
    assert.equal(r.pins.filter(p => want.has(p)).length, r.set, `run ${n}: ${r.set} flights leave exactly when typed`);
  }
  assert.ok(ok > 250, `enough accepted runs (${ok} of 600, ${refused} refused)`);
  assert.ok(bumped > 20, `the fuzz reaches the clash path (${bumped})`);
});

test('typed times: the pins go through SET_ROUTE_SCHEDULES like any others, and the server takes them as sent', () => {
  const st = base();
  const w = airlineWeeks(st, 6).get('p');
  const r = pinsForTimetable(w, 'a', [{ tod: 450, days: onDays(0, 2, 4) }], SYD);
  assert.equal(r.set, 3);
  assert.deepEqual(guardDecision('SET_ROUTE_SCHEDULES', { schedules: { a: r.pins } }, st), { schedules: { a: r.pins } });
  const next = gameReducer(st, { type: 'SET_ROUTE_SCHEDULES', schedules: { a: r.pins } });
  assert.deepEqual(next.routes.find(x => x.id === 'a').schedule.starts, r.pins);
  assert.equal(next.cash, st.cash, 'still costs nothing');
});

// Hub-bank worlds: a rotation through a banked hub may wait for the next wave,
// so its length depends on when it leaves. Typed times have to ask the week.
const bankedState = (routes) => ({
  hubBanksWorld: true, hubs: { SYD: { tier: 2, tierSince: 0 } },
  fleet: [{ id: 'p', typeId: jet.id }],
  routes: routes.map(r => ({ ...r, aircraftId: 'p' })), cargoRoutes: [],
});
const bankedWeekOf = (routes) => airlineWeeks(bankedState(routes), 6).get('p');

test('typed times in a hub-bank world: lengths come from the week, so set flights never overlap', () => {
  const routes = [route('a', ['SYD', 'MEL'], 14), route('b', ['SYD', 'BNE'], 7)];
  const w = bankedWeekOf(routes);
  assert.equal(w.banked, true, 'fixture: a banked week');
  // Fixture: somewhere in the day this rotation is longer than its bare block time (it waits for a bank).
  const bare = routeRotation(routes[0], jet).durMin;
  const lens = Array.from({ length: 288 }, (_, k) => w.durAt('a', utcOfLocal(0, k * 5, SYD)));
  assert.ok(Math.max(...lens) > bare, 'fixture: a wait somewhere in the day');
  const longAt = lens.indexOf(Math.max(...lens)) * 5;
  // Two times one BARE round trip apart, the first where the wait is longest: too close here.
  const tight = pinsForTimetable(w, 'a', [{ tod: longAt, days: ALL }, { tod: longAt + ceil5(bare), days: ALL }], SYD);
  assert.equal(tight.error, 'too-close');
  assert.equal(tight.dur, Math.max(...lens), 'and the length quoted is the real one, wait included');
  // A full round trip apart, waits included, is fine.
  const fine = pinsForTimetable(w, 'a', [{ tod: longAt, days: ALL }, { tod: (longAt + ceil5(Math.max(...lens)) + 240) % 1440, days: ALL }], SYD);
  if (!fine.error) {
    const after = bankedWeekOf(routes.map(x => (x.id === 'a' ? { ...x, schedule: { starts: fine.pins } } : x)));
    noOverlap(after.blocks);
    assert.deepEqual(after.demoted, []);
  }
});

test('typed times in a hub-bank world: never overlap, never unseat a set flight (fuzz)', () => {
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const dests = ['MEL', 'BNE', 'ADL', 'CBR', 'OOL', 'HBA'];
  let ok = 0, bumped = 0, waits = 0;
  for (let n = 0; n < 300; n++) {
    const picks = [...dests].sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * 2));
    const routes = picks.map((d, i) => route(`r${i}`, ['SYD', d], 3 + Math.floor(rnd() * (i ? 5 : 12))));
    const w0 = bankedWeekOf(routes);
    for (const r of routes.slice(1)) {
      const keep = w0.blocks.filter(b => b.routeId === r.id).filter(() => rnd() < 0.5).map(b => b.start);
      if (keep.length) r.schedule = { starts: keep };
    }
    const w = bankedWeekOf(routes);
    if (!w.blocks.some(b => b.routeId === 'r0')) continue;
    const fixedBefore = w.blocks.filter(b => b.pinned).map(b => `${b.routeId}@${b.start}`).sort();
    const rows = timetableRows(w, 'r0', SYD, Math.floor(rnd() * 7)).map(r => ({
      tod: Math.floor(rnd() * 288) * 5,
      days: r.days.map(on => (rnd() < 0.15 ? !on : on)),
    }));
    const r = pinsForTimetable(w, 'r0', rows, SYD);
    if (!r || r.error) continue;
    ok++; bumped += r.bumped.length;
    const after = bankedWeekOf(routes.map(x => (x.id === 'r0' ? { ...x, schedule: { starts: r.pins } } : x)));
    noOverlap(after.blocks);
    assert.deepEqual(after.demoted, [], `run ${n}`);
    assert.deepEqual(after.blocks.filter(b => b.routeId === 'r0' && b.pinned).map(b => b.start), r.pins, `run ${n}: every pin stands`);
    assert.deepEqual(after.blocks.filter(b => b.pinned && b.routeId !== 'r0').map(b => `${b.routeId}@${b.start}`).sort(), fixedBefore, `run ${n}`);
    waits += after.blocks.filter(b => b.routeId === 'r0' && b.pinned && b.waitMin).length;
    // One flight retimed on its own, through the same rule the editor uses.
    const one = after.blocks.find(b => b.routeId === 'r0' && b.pinned);
    const to = utcOfLocal(localDayTime(one.start, SYD).day, Math.floor(rnd() * 288) * 5, SYD);
    if (to !== one.start) {
      assert.equal(blockerFor(after, 'r0', one.dur, to, one) === null, canPlace(after, 'r0', one.dur, to, one), `run ${n}: blockerFor and canPlace agree`);
    }
  }
  assert.ok(ok > 100, `enough accepted runs (${ok})`);
  assert.ok(bumped > 10, `the fuzz reaches the clash path (${bumped})`);
  assert.ok(waits > 50, `and flights that wait for a bank (${waits})`);
});

console.log(`\nschedule-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
