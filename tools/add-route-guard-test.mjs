// Regression test for the "Open Route does nothing" dead click.
//
// Reported against the solo game: with no gate leased at the destination, the
// Network → Planner CTA silently did nothing. Headwinds ran the same reducer, so
// it had the same bug with a worse ending — the client applies ADD_ROUTE
// optimistically, the server re-runs the reducer, the reducer returns the SAME
// state, and the endpoint answers 201 with error:null. The optimistic route just
// disappeared on adoption and nothing told the player why.
//
// Verified failing on HEAD before the fix by driving the pre-fix reducer directly
// (tools/_to_delete probe): `gameReducer(s, ADD_ROUTE) === s`, no `state.error`,
// no `pendingToasts` — a refusal with no channel to reach the player.
//
// The fix put every ADD_ROUTE rejection in addRouteBlockReason(), which the
// reducer now calls as its single gate, the planner pre-flights to toast the
// reason, and decisions.mjs pre-flights to throw a 400. This pins:
//   1. every blocker returns a player-facing sentence;
//   2. a non-null reason ⇒ the reducer leaves state untouched, null ⇒ it opens;
//   3. slot/gate checks respect the alliance slot pool (slotCapAt/poolGrantAt),
//      so a member launching on a partner's granted slots is not refused.
//
//   node tools/add-route-guard-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, addRouteBlockReason } from '../packages/engine/reducer.mjs';
import { slotCapAt, poolGrantAt } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { SLOTS_PER_GATE, routeDistanceKm } from '../packages/engine/src/utils/simulation.js';
import { routeLaunchCost } from '../packages/engine/src/data/overhead.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const ORIGIN = 'AMS', DEST = 'LHR';
const TYPE = getAircraftType('a320neo') ?? getAircraftType('b737max8');
assert.ok(TYPE, 'fixture needs a narrowbody type');

function baseState(over = {}) {
  return {
    week: 1, cash: 50_000_000, hub: ORIGIN, hubs: { [ORIGIN]: { tier: 1 } },
    airlineName: 'Test Air',
    fleet: [{ id: 'ac1', typeId: TYPE.id, tailNumber: 'PH-TST', status: 'idle', ageWeeks: 0, reserveBase: null }],
    routes: [], cargoRoutes: [],
    gates: { [ORIGIN]: 2, [DEST]: 2 },
    routePricing: {}, routeCatering: {}, competitors: [], activeEvents: [],
    ...over,
  };
}
const addRoute = (over = {}) => ({
  type: 'ADD_ROUTE', origin: ORIGIN, destination: DEST, aircraftId: 'ac1',
  weeklyFrequency: 7, ticketPrice: 180, cateringLevel: 'standard', season: null, ...over,
});

console.log('\n── ADD_ROUTE guard ──────────────────────────────────────\n');

test('a fully-provisioned route has no blocker and opens', () => {
  const s = baseState();
  assert.equal(addRouteBlockReason(s, addRoute()), null);
  const next = gameReducer(s, addRoute());
  assert.notEqual(next, s, 'reducer returned the same state object');
  assert.equal(next.routes.length, 1);
  assert.equal(next.cash, s.cash - routeLaunchCost(routeDistanceKm(ORIGIN, DEST)));
});

// ── The reported bug ─────────────────────────────────────────────────────────
test('no gate at the DESTINATION is reported, not swallowed', () => {
  const s = baseState({ gates: { [ORIGIN]: 2 } });
  const reason = addRouteBlockReason(s, addRoute());
  assert.ok(reason, 'expected a reason — this is the dead-click bug');
  assert.match(reason, new RegExp(DEST), 'reason must name the airport at fault');
  assert.match(reason, /gate/i);
  assert.equal(gameReducer(s, addRoute()), s, 'reducer must still reject it');
});

test('no gate at the ORIGIN is reported too', () => {
  const s = baseState({ gates: { [DEST]: 2 } });
  const reason = addRouteBlockReason(s, addRoute());
  assert.ok(reason);
  assert.match(reason, new RegExp(ORIGIN));
  assert.match(reason, /gate/i);
});

// ── Headwinds-specific: the alliance slot pool must not read as "no gate" ────
test('an alliance slot-pool grant opens an airport you hold no gates at', () => {
  const s = baseState({
    gates: { [ORIGIN]: 2 },
    allianceSlotPool: { [DEST]: { grant: SLOTS_PER_GATE } },
  });
  assert.ok(poolGrantAt(s, DEST) > 0, 'fixture should grant slots at the destination');
  assert.equal(slotCapAt(s, DEST), SLOTS_PER_GATE);
  assert.equal(addRouteBlockReason(s, addRoute()), null,
    'borrowed slots are capacity — the guard must not claim there is no gate');
  assert.equal(gameReducer(s, addRoute()).routes.length, 1, 'and the route must actually open');
});

test('a grant too small for the frequency is reported as a SLOT shortfall', () => {
  const s = baseState({
    gates: { [ORIGIN]: 2 },
    allianceSlotPool: { [DEST]: { grant: 3 } },
  });
  const reason = addRouteBlockReason(s, addRoute({ weeklyFrequency: 7 }));
  assert.ok(reason);
  assert.match(reason, /slot/i, 'capacity exists, it is just too small — not a "no gate" message');
  assert.match(reason, /3/, 'reason should show the real cap from slotCapAt');
});

test('running out of gate SLOTS is reported with the numbers', () => {
  const used = SLOTS_PER_GATE - 2;
  const s = baseState({
    gates: { [ORIGIN]: 4, [DEST]: 1 },
    fleet: [
      { id: 'ac1', typeId: TYPE.id, tailNumber: 'PH-TST', status: 'idle', ageWeeks: 0, reserveBase: null },
      { id: 'ac2', typeId: TYPE.id, tailNumber: 'PH-OLD', status: 'assigned', ageWeeks: 0, reserveBase: null },
    ],
    routes: [{ id: 'r0', origin: DEST, destination: ORIGIN, stops: [DEST, ORIGIN], aircraftId: 'ac2', weeklyFrequency: used, weeksOpen: 10, season: null, seasonState: 'active', hub: ORIGIN }],
  });
  const reason = addRouteBlockReason(s, addRoute());
  assert.ok(reason, 'expected a slot blocker');
  assert.match(reason, /slot/i);
  assert.match(reason, new RegExp(String(used)));
  assert.equal(gameReducer(s, addRoute()), s);
});

test('insufficient cash is reported', () => {
  const s = baseState({ cash: 1 });
  const reason = addRouteBlockReason(s, addRoute());
  assert.ok(reason);
  assert.match(reason, /cash/i);
  assert.equal(gameReducer(s, addRoute()), s);
});

test('an aircraft that serves neither endpoint is reported (no teleporting)', () => {
  const far = 'JFK';
  const s = baseState({
    gates: { [ORIGIN]: 2, [DEST]: 2, [far]: 2 },
    routes: [{ id: 'r0', origin: far, destination: 'LAX', stops: [far, 'LAX'], aircraftId: 'ac1', weeklyFrequency: 3, weeksOpen: 5, season: null, seasonState: 'active', hub: ORIGIN }],
  });
  const reason = addRouteBlockReason(s, addRoute());
  assert.ok(reason);
  assert.match(reason, /network|serve/i);
});

test("a lane beyond the aircraft's range is reported with both distances", () => {
  const s = baseState({ gates: { [ORIGIN]: 2, SYD: 2 } });
  const a = addRoute({ destination: 'SYD' });
  const reason = addRouteBlockReason(s, a);
  assert.ok(reason, 'AMS–SYD is far beyond a narrowbody');
  assert.match(reason, /range|reach/i);
  assert.equal(gameReducer(s, a), s);
});

test('adding frequency to an identical existing route needs no launch cash', () => {
  const s1 = gameReducer(baseState(), addRoute());
  const poor = { ...s1, cash: 0 };
  assert.equal(addRouteBlockReason(poor, addRoute({ weeklyFrequency: 1 })), null);
  const s2 = gameReducer(poor, addRoute({ weeklyFrequency: 1 }));
  assert.equal(s2.routes.length, 1, 'should merge, not add a second route');
  assert.equal(s2.routes[0].weeklyFrequency, 8);
  assert.equal(s2.cash, 0, 'merging must not charge a launch cost');
});

test('every rejection the reducer makes now carries a reason', () => {
  const cases = [
    baseState({ gates: { [ORIGIN]: 2 } }),
    baseState({ gates: { [DEST]: 2 } }),
    baseState({ gates: {} }),
    baseState({ cash: 0 }),
    baseState({ fleet: [] }),
  ];
  for (const s of cases) {
    const reason = addRouteBlockReason(s, addRoute());
    const next   = gameReducer(s, addRoute());
    assert.ok(reason, 'a rejected route with no reason string');
    assert.equal(next, s, `reason "${reason}" but the reducer accepted the route`);
    assert.ok(reason.length > 10, `reason too terse to help a player: "${reason}"`);
  }
});

test('the server can import the guard from the package entrypoint', () => {
  // decisions.mjs does `import { addRouteBlockReason } from '@tailwinds/engine/reducer'`
  // — if the entrypoint stops re-exporting it, every ADD_ROUTE 400 silently stops.
  assert.equal(typeof addRouteBlockReason, 'function');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
