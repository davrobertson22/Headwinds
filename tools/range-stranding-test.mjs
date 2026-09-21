// range-stranding-test.mjs — a route its aircraft can no longer reach is TOLD
// to the player, not silently zeroed.
//
// THE BUG. simulateRoute / simulateTagRoute / simulateCargoRoute return null for
// a leg beyond effectiveRangeKm, and weeklyTick `continue`s past a null. Right
// physics, silent failure: the route earned nothing, its aircraft kept billing
// lease and maintenance, and nothing anywhere said why. A cabin refit that cost
// range could always cause it; the 2026-09-20 aircraft audit then corrected six
// types whose range was wrong on the catalogue's own convention, which would
// have stranded live routes in any save flying them.
//
// THE FIX (applyRangeStranding, packages/engine/src/reducer.mjs): flag the
// route once, toast it, badge it on the Routes and cargo lists, and clear the
// flag the moment it is flyable again. Nothing is closed — REASSIGN_ROUTE and
// TRANSFER_ROUTES already move routes to a longer-range tail while keeping
// their ramp, which is the cheap fix the notice points at.
//
// HEADWINDS: no per-airline news log exists — the News tab is the world's
// shared feed and a stranded route is private — so the durable record is the
// flag/badge and the toast (tickService carries undrained toasts forward). The
// load-time pass is solo-only; here every world tick runs the pre-tick pass.
// Verified failing on HEAD 29e9be1 with a throwaway probe of the old call path:
// route out of range, tick refuses it, week advances, no flag and no toast.
// Ported from Tailwinds.
//
// The fixture opens a route the normal way, then shrinks the aircraft's reach
// through its own `rangeMod` field — exactly what a data correction does to a
// live save — so nothing here is coupled to any one type's numbers.
//
//   node --import ./tools/_register-loader.mjs tools/range-stranding-test.mjs

import assert from 'node:assert/strict';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  routeDistanceKm, effectiveRangeKm, routeRangeShortfall, rangeStrandedRoutes, simulateRoute,
} from '../packages/engine/src/utils/simulation.js';

const { gameReducer, freshState, applyRangeStranding } =
  await import('../packages/engine/src/reducer.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const ORIGIN = 'JFK', DEST = 'LAX';
const TYPE = getAircraftType('a320neo');
assert.ok(TYPE, 'fixture needs the A320neo');
const LEG_KM = routeDistanceKm(ORIGIN, DEST);
assert.ok(TYPE.range > LEG_KM * 1.1, 'fixture lane must be comfortably in range to start');

const tail = (id, over = {}) => ({
  id, typeId: TYPE.id, tailNumber: `N${id.toUpperCase()}`, name: `Test ${id}`,
  status: 'idle', ageWeeks: 0, ownershipType: 'owned', reserveBase: null, ...over,
});

/** A freshly started airline flying one JFK–LAX route on tail a1. */
function flying() {
  let s = {
    ...freshState(), cash: 500_000_000, hub: ORIGIN,
    hubs: { [ORIGIN]: { tier: 1 } },
    gates: { [ORIGIN]: 4, [DEST]: 4 },
    fleet: [tail('a1'), tail('a2')],
    routes: [], cargoRoutes: [], newsLog: [], pendingToasts: [],
  };
  s = gameReducer(s, {
    type: 'ADD_ROUTE', origin: ORIGIN, destination: DEST, aircraftId: 'a1',
    weeklyFrequency: 7, ticketPrice: 380, cateringLevel: 'standard', season: null,
  });
  assert.equal(s.routes.length, 1, 'fixture: ADD_ROUTE did not open the route');
  return s;
}

/** Shrink tail a1's reach below the leg — what a range correction does to a save. */
const REACH_KM = Math.round(LEG_KM * 0.75);
function shortOf(s, id = 'a1') {
  const f = s.fleet.find(a => a.id === id);
  const nominal = effectiveRangeKm({ ...f, rangeMod: 1 }, TYPE);
  return { ...s, fleet: s.fleet.map(a => (a.id === id ? { ...a, rangeMod: REACH_KM / nominal } : a)) };
}

console.log('\nRoutes an aircraft can no longer reach\n');

// ── 1. The detector ─────────────────────────────────────────────────────────

test('a route in range has no shortfall; the same route out of range names its leg', () => {
  const s = flying();
  const route = s.routes[0];
  assert.equal(routeRangeShortfall(route, s.fleet[0]), null);
  const short = routeRangeShortfall(route, shortOf(s).fleet[0]);
  assert.ok(short, 'expected a shortfall once the tail cannot reach the leg');
  assert.deepEqual([short.from, short.to].sort(), [ORIGIN, DEST].sort());
  assert.ok(short.sectorKm > short.rangeKm);
  assert.ok(Math.abs(short.rangeKm - REACH_KM) <= 2, `reach ${short.rangeKm}, expected ~${REACH_KM}`);
});

test('a multi-stop route reports the leg that fails, not the first leg', () => {
  const s = shortOf(flying());
  // BOS–JFK is short; JFK–LAX is the leg the shrunk tail cannot make.
  const tag = { id: 'tag1', origin: 'BOS', destination: DEST, stops: ['BOS', ORIGIN, DEST], aircraftId: 'a1' };
  const short = routeRangeShortfall(tag, s.fleet[0]);
  assert.ok(short, 'the long leg was missed');
  assert.deepEqual([short.from, short.to], [ORIGIN, DEST]);
});

test('cargo routes are covered too', () => {
  const s = shortOf(flying());
  const withCargo = { ...s, cargoRoutes: [{ id: 'c1', origin: ORIGIN, destination: DEST, aircraftId: 'a1' }] };
  const hits = rangeStrandedRoutes(withCargo);
  assert.ok(hits.some(h => h.routeId === 'c1' && h.cargo === true), 'cargo route not detected');
  assert.ok(hits.some(h => h.routeId === withCargo.routes[0].id && h.cargo === false), 'pax route not detected');
});

test('the detector agrees with the tick: flagged if and only if the tick will not fly it', () => {
  // The whole contract. If these ever disagree, the badge lies — either a
  // flying route shows "out of range", or a dead one shows nothing.
  const ok = flying(), bad = shortOf(flying());
  for (const [s, expectStranded] of [[ok, false], [bad, true]]) {
    const route = s.routes[0], aircraft = s.fleet[0];
    const detector = routeRangeShortfall(route, aircraft) != null;
    const tickRefuses = simulateRoute(route, aircraft) == null;
    assert.equal(detector, expectStranded, 'detector verdict');
    assert.equal(tickRefuses, expectStranded, 'tick verdict');
  }
});

// ── 2. applyRangeStranding ──────────────────────────────────────────────────

test('a stranded route is flagged once, with one toast that points at the route list', () => {
  const s = shortOf(flying());
  const next = applyRangeStranding(s);
  assert.notEqual(next, s);
  const r = next.routes[0];
  assert.ok(r.rangeStranded, 'route was not flagged');
  assert.equal(r.rangeStranded.sectorKm > r.rangeStranded.rangeKm, true);
  assert.equal((next.pendingToasts ?? []).length, (s.pendingToasts ?? []).length + 1, 'expected one toast');
  const toast = next.pendingToasts.at(-1);
  assert.match(toast.message, /route list/, 'multiplayer toast must point at the route list, not News');
  assert.doesNotMatch(toast.message, /News/, 'there is no per-airline news row in Headwinds to point at');
  assert.equal(next.newsLog, s.newsLog, 'must not write to a news log');
});

test('it is idempotent — a second pass changes nothing and reports nothing', () => {
  const once = applyRangeStranding(shortOf(flying()));
  assert.equal(applyRangeStranding(once), once,
    'must return the SAME object when nothing changed — ADVANCE_WEEK re-enters on a change');
});

test('the flag clears when the aircraft can reach the route again', () => {
  const stranded = applyRangeStranding(shortOf(flying()));
  const repaired = { ...stranded, fleet: stranded.fleet.map(a => ({ ...a, rangeMod: 1 })) };
  const next = applyRangeStranding(repaired);
  assert.equal(next.routes[0].rangeStranded, undefined, 'flag survived a repair');
});

test('an untouched airline is returned as the same object', () => {
  const s = flying();
  assert.equal(applyRangeStranding(s), s);
});

test('{ toast: false } flags the route without queueing a toast', () => {
  const s = shortOf(flying());
  const next = applyRangeStranding(s, { toast: false });
  assert.ok(next.routes[0].rangeStranded);
  assert.equal((next.pendingToasts ?? []).length, (s.pendingToasts ?? []).length);
});

// ── 3. Wired into the game ──────────────────────────────────────────────────

test('ADVANCE_WEEK flags the route, reports it once, and still advances exactly one week', () => {
  let s = shortOf(flying());
  const w0 = s.week, y0 = s.year;
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(s.routes[0].rangeStranded, 'not flagged by the weekly tick');
  const advanced = (s.year - y0) * 52 + (s.week - w0);
  assert.equal(advanced, 1, `advanced ${advanced} weeks — the pre-tick re-entry must not double-tick`);
  const since = s.routes[0].rangeStranded.since;
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.routes[0].rangeStranded.since, since, 'the flag was re-stamped the following week');
});

test('the toast survives the weekly tick in a classic world', () => {
  // ADVANCE_WEEK REPLACES state.pendingToasts with the week's own list. The
  // stranding pass runs pre-tick and re-enters the reducer, so a toast queued
  // there is thrown away by the very tick it announces — the Comet 1 grounding
  // hit the same wall and only preserves pre-tick toasts in ERA games. Shipped
  // in 5e1e818 with exactly that hole: news row and badge worked, the toast
  // never reached a classic player (same replace in reducer.mjs). The toast has to come from ADVANCE_WEEK's
  // own list.
  let s = shortOf(flying());
  assert.equal(s.startYear ?? null, null, 'fixture must be a classic game — era games keep pre-tick toasts');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const toasts = (s.pendingToasts ?? []).filter(t => /out of range/i.test(t.title ?? ''));
  assert.equal(toasts.length, 1, `expected one out-of-range toast after the tick, got ${toasts.length}`);
  s = gameReducer({ ...s, pendingToasts: [] }, { type: 'ADVANCE_WEEK' });
  assert.equal((s.pendingToasts ?? []).filter(t => /out of range/i.test(t.title ?? '')).length, 0,
    'the toast repeated the following week');
});

test('REASSIGN_ROUTE to a tail that reaches it clears the flag immediately', () => {
  const s = applyRangeStranding(shortOf(flying()));
  const next = gameReducer(s, { type: 'REASSIGN_ROUTE', routeId: s.routes[0].id, toAircraftId: 'a2' });
  assert.equal(next.routes[0].aircraftId, 'a2', 'reassign was refused');
  assert.equal(next.routes[0].rangeStranded, undefined, 'the badge should go the moment it is fixed');
});

test('TRANSFER_ROUTES to a tail that reaches them clears the flag immediately', () => {
  // Swapping a longer-range tail in for the whole aircraft is the other natural
  // fix, and transferCompatibility range-checks every leg. Without the clear
  // the badge would linger a week after the problem was solved.
  const s = applyRangeStranding(shortOf(flying()));
  assert.ok(s.routes[0].rangeStranded, 'fixture: route should start flagged');
  const next = gameReducer(s, { type: 'TRANSFER_ROUTES', fromAircraftId: 'a1', toAircraftId: 'a2' });
  assert.equal(next.routes[0].aircraftId, 'a2', 'transfer was refused');
  assert.equal(next.routes[0].rangeStranded, undefined, 'the badge should go the moment it is fixed');
});

test('REASSIGN_ROUTE still refuses a tail that cannot reach it', () => {
  const s = shortOf(applyRangeStranding(shortOf(flying())), 'a2');
  const next = gameReducer(s, { type: 'REASSIGN_ROUTE', routeId: s.routes[0].id, toAircraftId: 'a2' });
  assert.equal(next, s, 'moved a stranded route onto another tail that cannot fly it either');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
