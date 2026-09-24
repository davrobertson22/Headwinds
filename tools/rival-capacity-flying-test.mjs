// Rival capacity counts only what actually flies this week.
//
// A human rival's routes reach every other player twice — as a competitor
// (state.competitors[].routes / .cargoRoutes) and as a per-pair offer spec
// (state.humanRivals) — and the demand model splits each contested pair
// between them. Both views used to be built from EVERY route in the rival's
// blob. So a rival whose only jet was in a four-week AOG repair, whose seasonal
// route was dormant for the winter, or whose route its aircraft could no longer
// reach (range stranding) still took its full share of your passengers — and
// of your freight — for seats that never left the ground.
//
// The rule now mirrors the tick's own: a route counts when it is in season this
// month, its aircraft is in service (or back in service this week — the tick
// runs the downtime countdown before the revenue sim), and every leg is in range.
//
//   node tools/rival-capacity-flying-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { buildRivalViews, withRivals, pairKeyOf } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}
const realRandom = Math.random;
Math.random = () => 0.5;

const shortHaul = AIRCRAFT_TYPES.find((t) =>
  !t.freighter && t.range > 800 && t.range < 4000 && t.seats >= 50
  && !checkRouteRestrictions('JFK', 'BOS', 300, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(shortHaul, 'no short-haul type can legally fly JFK–BOS');
const freighter = AIRCRAFT_TYPES.find((t) => t.freighter && t.payloadTonnes > 10 && t.range > 1000);
assert.ok(freighter);

function makeAirline({ id, name, hub, dest, fare }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
  const aircraftId = s.fleet[0].id;
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId, origin: hub, destination: dest, weeklyFrequency: 14 });
  assert.equal(s.routes.length, 1, `${name}: route not created (${s.error ?? 'no error'})`);
  s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: s.routes[0].id, ticketPrice: fare });
  return { id, worldId: 'w1', name, hub, status: 'ACTIVE', state: s };
}
const alice = makeAirline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dest: 'BOS', fare: 170 });
const bob   = makeAirline({ id: 'a2', name: 'Bob Airways', hub: 'BOS', dest: 'JFK', fare: 150 });
const KEY = pairKeyOf('JFK', 'BOS');

// Bob with his one tail's status patched.
const bobWith = (patch, routePatch = {}) => ({
  ...bob,
  state: {
    ...bob.state,
    fleet: bob.state.fleet.map((a) => ({ ...a, ...patch })),
    routes: bob.state.routes.map((r) => ({ ...r, ...routePatch })),
  },
});
const aliceView = (rival) => buildRivalViews([alice, rival]).get('a1');
const seesBob = (view) => ({
  spec: (view.humanRivals[KEY] ?? []).length > 0,
  route: !!view.competitors[0]?.routes?.[KEY],
});

console.log('\n── rival capacity: only what flies ─────────────────────');

await test('control: an in-service rival is seen on the pair, in both views', () => {
  assert.deepEqual(seesBob(aliceView(bob)), { spec: true, route: true });
});

await test('a rival whose aircraft is in AOG repair for weeks puts no seats on the pair', () => {
  const v = aliceView(bobWith({ status: 'grounded', groundedWeeksLeft: 4, groundedReason: 'aog' }));
  assert.deepEqual(seesBob(v), { spec: false, route: false });
});

await test('a rival whose aircraft is in a heavy check puts no seats on the pair', () => {
  const v = aliceView(bobWith({ status: 'maintenance', checkWeeksLeft: 3, checkType: 'C' }));
  assert.deepEqual(seesBob(v), { spec: false, route: false });
});

await test('…but an aircraft whose downtime ends this week flies this week, so it counts', () => {
  assert.deepEqual(seesBob(aliceView(bobWith({ status: 'grounded', groundedWeeksLeft: 1 }))), { spec: true, route: true });
  assert.deepEqual(seesBob(aliceView(bobWith({ status: 'maintenance', checkWeeksLeft: 1, checkType: 'A' }))), { spec: true, route: true });
});

await test('a dormant seasonal route puts no seats on the pair; an in-season one does', () => {
  // freshState is week 1 — January.
  assert.deepEqual(seesBob(aliceView(bobWith({}, { season: { months: [6, 7, 8] } }))), { spec: false, route: false });
  assert.deepEqual(seesBob(aliceView(bobWith({}, { season: { months: [12, 1, 2] } }))), { spec: true, route: true });
});

await test('a route its aircraft can no longer reach puts no seats on the pair', () => {
  const far = { ...bob, state: { ...bob.state,
    routes: bob.state.routes.map((r) => ({ ...r, origin: 'BOS', destination: 'LHR', stops: ['BOS', 'LHR'] })) } };
  assert.ok(shortHaul.range < 5000, 'fixture: the short-haul type must not reach BOS–LHR');
  const v = aliceView(far);
  assert.equal((v.humanRivals[pairKeyOf('BOS', 'LHR')] ?? []).length, 0);
  assert.equal(!!v.competitors[0]?.routes?.[pairKeyOf('BOS', 'LHR')], false);
});

await test('two tails on one pair: only the flying one counts toward frequency and seats', () => {
  const second = { ...bob.state.fleet[0], id: 'bob-2', status: 'grounded', groundedWeeksLeft: 4 };
  const r2 = { ...bob.state.routes[0], id: 'bob-r2', aircraftId: 'bob-2', weeklyFrequency: 7 };
  const two = { ...bob, state: { ...bob.state, fleet: [...bob.state.fleet, second], routes: [...bob.state.routes, r2] } };
  const v = aliceView(two);
  assert.equal(v.humanRivals[KEY][0].frequency, 14);
  assert.equal(v.competitors[0].routes[KEY].frequency, 14);
});

await test('a grounded rival freighter adds no tonnes to the lane', () => {
  const f = { ...bob.state.fleet[0], id: 'bob-f', typeId: freighter.id, config: null, status: 'grounded', groundedWeeksLeft: 4 };
  const lane = { id: 'bob-c1', aircraftId: 'bob-f', origin: 'BOS', destination: 'JFK', weeklyFrequency: 5, yieldPrice: 1 };
  const withLane = (fa) => ({ ...bob, state: { ...bob.state, fleet: [...bob.state.fleet, fa], cargoRoutes: [lane] } });
  assert.equal(aliceView(withLane(f)).competitors[0].cargoRoutes?.[KEY], undefined);
  assert.ok(aliceView(withLane({ ...f, status: 'idle', groundedWeeksLeft: 0 })).competitors[0].cargoRoutes?.[KEY]?.tonnesPerWeek > 0,
    'control: the same lane flown in service must be visible');
});

// The baseline is a rival that flies NOTHING, not an empty world: a rival airline
// reaches you through more than its seats (marketing share of voice, brand), and
// that is not what this file is about. A grounded rival's SEATS must cost you
// exactly what no seats cost you.
await test('end to end: a grounded rival takes no more of your revenue than a rival that flies nothing', () => {
  const solo = gameReducer(withRivals(alice.state,
    aliceView({ ...bob, state: { ...bob.state, routes: [] } })), { type: 'ADVANCE_WEEK' });
  const vsGrounded = gameReducer(withRivals(alice.state,
    aliceView(bobWith({ status: 'grounded', groundedWeeksLeft: 4 }))), { type: 'ADVANCE_WEEK' });
  const vsFlying = gameReducer(withRivals(alice.state, aliceView(bob)), { type: 'ADVANCE_WEEK' });
  const rev = (s) => s.lastReport?.totalRevenue ?? 0;
  assert.ok(rev(vsFlying) < rev(solo), 'control: a flying rival must take a share');
  assert.equal(rev(vsGrounded), rev(solo), `a grounded rival's seats still took ${rev(solo) - rev(vsGrounded)} of revenue`);
});

Math.random = realRandom;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
