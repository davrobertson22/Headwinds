// Freight and multi-stop routes must REFUSE OUT LOUD, like ADD_ROUTE already does.
//
// ADD_ROUTE's every rejection lives in addRouteBlockReason(), which
// routes/decisions.mjs pre-flights so a refused route comes back as a 400 with a
// sentence. ADD_CARGO_ROUTE (12 bare `return state`) and ADD_TAG_ROUTE (13) had
// no such helper: the reducer handed back the SAME state object, the endpoint
// still answered 201 { ok: true }, and the client's optimistic route simply
// vanished on the next poll with nothing said. That is the exact shape of the
// July "edits don't save / new routes don't save" reports, one network type over.
//
// This pins BOTH layers:
//   1. engine  — addCargoRouteBlockReason / addTagRouteBlockReason return a
//                player-facing sentence for every refusal class, and null for a
//                legal add; and the helper AGREES with the handler (reason ⇒ the
//                reducer leaves state untouched, null ⇒ it opens the route).
//   2. server  — lib/routeBlocks.mjs routeBlockReasonFor() is what decisions.mjs
//                pre-flights; it must map all three route actions to their
//                helper and nothing else.
//
//   node tools/route-block-reason-test.mjs

import assert from 'node:assert/strict';

let engine = null, engineErr = null;
try { engine = await import('../packages/engine/src/reducer.mjs'); }
catch (e) { engineErr = e; }

let blocks = null, blocksErr = null;
try { blocks = await import('../apps/headwinds-server/src/lib/routeBlocks.mjs'); }
catch (e) { blocksErr = e; }

const { gameReducer } = engine ?? {};
const addRouteBlockReason       = engine?.addRouteBlockReason;
const addCargoRouteBlockReason  = engine?.addCargoRouteBlockReason;
const addTagRouteBlockReason    = engine?.addTagRouteBlockReason;
const routeBlockReasonFor       = blocks?.routeBlockReasonFor;

const { AIRCRAFT_TYPES, getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { routeDistanceKm, SLOTS_PER_GATE } = await import('../packages/engine/src/utils/simulation.js');
const { routeLaunchCost } = await import('../packages/engine/src/data/overhead.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\n── the helpers must exist at all ────────────────────────\n');

test('engine module loads', () => {
  assert.equal(engineErr, null, `engine import failed: ${engineErr?.message}`);
});
test('lib/routeBlocks.mjs exists and loads', () => {
  assert.equal(blocksErr, null, `server import failed: ${blocksErr?.message}`);
  assert.equal(typeof routeBlockReasonFor, 'function', 'routeBlockReasonFor is not exported');
});
test('engine exports addCargoRouteBlockReason', () => {
  assert.equal(typeof addCargoRouteBlockReason, 'function',
    'ADD_CARGO_ROUTE has no block-reason helper — freight refusals are silent');
});
test('engine exports addTagRouteBlockReason', () => {
  assert.equal(typeof addTagRouteBlockReason, 'function',
    'ADD_TAG_ROUTE has no block-reason helper — multi-stop refusals are silent');
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Short European lanes so a narrowbody / narrowbody freighter is legal on all of
// them, and no perimeter rule bites.
const A = 'AMS', B = 'LHR', C = 'CDG', D = 'FRA';

const FREIGHTER = getAircraftType('b737800bcf');
const PAX = getAircraftType('a320neo') ?? getAircraftType('b737max8');
assert.ok(FREIGHTER && PAX, 'fixture needs a narrowbody freighter and a narrowbody');

function cargoState(over = {}) {
  return {
    week: 1, cash: 50_000_000, hub: A, hubs: { [A]: { tier: 1 } },
    airlineName: 'Freight Air',
    fleet: [{ id: 'f1', typeId: FREIGHTER.id, tailNumber: 'PH-CGO', status: 'idle', ageWeeks: 0, reserveBase: null }],
    routes: [], cargoRoutes: [],
    gates: { [A]: 2, [B]: 2, [C]: 2, [D]: 2 },
    routePricing: {}, routeCatering: {}, competitors: [], activeEvents: [],
    ...over,
  };
}
const addCargo = (over = {}) => ({
  type: 'ADD_CARGO_ROUTE', origin: A, destination: B, aircraftId: 'f1',
  weeklyFrequency: 4, yieldPrice: 0.4, ...over,
});

function tagState(over = {}) {
  return {
    week: 1, cash: 50_000_000, hub: A, hubs: { [A]: { tier: 1 } },
    airlineName: 'Tag Air',
    fleet: [{ id: 'p1', typeId: PAX.id, tailNumber: 'PH-TAG', status: 'idle', ageWeeks: 0, reserveBase: null }],
    routes: [], cargoRoutes: [],
    gates: { [A]: 2, [B]: 2, [C]: 2, [D]: 2 },
    routePricing: {}, routeCatering: {}, competitors: [], activeEvents: [],
    ...over,
  };
}
const addTag = (over = {}) => ({
  type: 'ADD_TAG_ROUTE', aircraftId: 'p1', stops: [A, B, C], weeklyFrequency: 4,
  cateringLevel: 'standard', ...over,
});

// Every case below asserts the SAME invariant the ADD_ROUTE guard carries:
// a non-null reason means the reducer must refuse, null means it must accept.
function agrees(reasonFn, state, action, { expect }) {
  const reason = reasonFn(state, action);
  const next = gameReducer(state, action);
  if (expect === 'blocked') {
    assert.ok(reason, 'expected a player-facing reason — this is the silent-refusal bug');
    assert.equal(typeof reason, 'string');
    assert.ok(reason.length > 8, `reason too terse to show a player: ${reason}`);
    assert.equal(next, state, 'reducer accepted an action the helper said was blocked');
  } else {
    assert.equal(reason, null, `helper refused a legal route: ${reason}`);
    assert.notEqual(next, state, 'reducer refused a route the helper called legal');
  }
  return reason;
}

console.log('\n── ADD_CARGO_ROUTE: every refusal carries a sentence ────\n');

test('a fully-provisioned cargo lane has no blocker and opens', () => {
  const s = cargoState();
  agrees(addCargoRouteBlockReason, s, addCargo(), { expect: 'open' });
  const next = gameReducer(s, addCargo());
  assert.equal(next.cargoRoutes.length, 1);
  assert.equal(next.cash, s.cash - routeLaunchCost(routeDistanceKm(A, B)));
});

test('an unknown aircraft is reported', () => {
  const r = agrees(addCargoRouteBlockReason, cargoState(), addCargo({ aircraftId: 'nope' }), { expect: 'blocked' });
  assert.match(r, /aircraft/i);
});

test('a PASSENGER aircraft on a cargo lane is reported', () => {
  const s = cargoState({
    fleet: [{ id: 'f1', typeId: PAX.id, tailNumber: 'PH-PAX', status: 'idle', ageWeeks: 0, reserveBase: null }],
  });
  const r = agrees(addCargoRouteBlockReason, s, addCargo(), { expect: 'blocked' });
  assert.match(r, /freight/i);
});

test('origin === destination is reported', () => {
  const r = agrees(addCargoRouteBlockReason, cargoState(), addCargo({ destination: A }), { expect: 'blocked' });
  assert.match(r, /same airport/i);
});

test('out of range is reported, and names the lane', () => {
  const short = AIRCRAFT_TYPES.find((t) => t.freighter && t.range < 2000);
  assert.ok(short, 'fixture needs a short-range freighter');
  const s = cargoState({
    fleet: [{ id: 'f1', typeId: short.id, tailNumber: 'PH-SML', status: 'idle', ageWeeks: 0, reserveBase: null }],
    gates: { [A]: 2, JFK: 2 },
  });
  const r = agrees(addCargoRouteBlockReason, s, addCargo({ destination: 'JFK' }), { expect: 'blocked' });
  assert.match(r, /reach|range/i);
});

// ── The reported bug, freight edition ────────────────────────────────────────
test('no gate at the DESTINATION is reported, not swallowed', () => {
  const s = cargoState({ gates: { [A]: 2 } });
  const r = agrees(addCargoRouteBlockReason, s, addCargo(), { expect: 'blocked' });
  assert.match(r, new RegExp(B), 'reason must name the airport at fault');
  assert.match(r, /gate/i);
});

test('no gate at the ORIGIN is reported too', () => {
  const s = cargoState({ gates: { [B]: 2 } });
  const r = agrees(addCargoRouteBlockReason, s, addCargo(), { expect: 'blocked' });
  assert.match(r, new RegExp(A));
  assert.match(r, /gate/i);
});

test('a full slot table is reported with the numbers', () => {
  // One gate at the destination = SLOTS_PER_GATE departures a week, all taken.
  const s = cargoState({
    gates: { [A]: 20, [B]: 1 },
    cargoRoutes: [{
      id: 'c0', origin: A, destination: B, aircraftId: 'f0',
      weeklyFrequency: SLOTS_PER_GATE, yieldPrice: 0.4, weeksOpen: 4, cargo: true,
    }],
    fleet: [
      { id: 'f1', typeId: FREIGHTER.id, tailNumber: 'PH-CGO', status: 'idle', ageWeeks: 0, reserveBase: null },
      { id: 'f0', typeId: FREIGHTER.id, tailNumber: 'PH-OLD', status: 'assigned', ageWeeks: 0, reserveBase: null },
    ],
  });
  const r = agrees(addCargoRouteBlockReason, s, addCargo({ aircraftId: 'f1' }), { expect: 'blocked' });
  assert.match(r, /slot/i);
});

test('too little cash to launch is reported with the price', () => {
  const s = cargoState({ cash: 1000 });
  const r = agrees(addCargoRouteBlockReason, s, addCargo(), { expect: 'blocked' });
  assert.match(r, /cash|afford/i);
});

test('a MERGE onto an identical lane is free, and never blamed on cash', () => {
  // Consolidation happens BEFORE the launch-cost check in the handler, so an
  // airline with no money may still add frequency to a lane it already flies.
  const s0 = cargoState();
  const s1 = gameReducer(s0, addCargo());
  const broke = { ...s1, cash: 0 };
  agrees(addCargoRouteBlockReason, broke, addCargo(), { expect: 'open' });
  const merged = gameReducer(broke, addCargo());
  assert.equal(merged.cargoRoutes.length, 1, 'merge must not create a second lane');
  assert.equal(merged.cargoRoutes[0].weeklyFrequency, 8);
});

test('a freighter cannot teleport: off-network extension is reported', () => {
  const s0 = cargoState();
  const s1 = gameReducer(s0, addCargo());
  const r = agrees(addCargoRouteBlockReason, s1, addCargo({ origin: C, destination: D }), { expect: 'blocked' });
  assert.match(r, /network|serve/i);
});

console.log('\n── ADD_TAG_ROUTE: every refusal carries a sentence ──────\n');

test('a fully-provisioned multi-stop route has no blocker and opens', () => {
  const s = tagState();
  agrees(addTagRouteBlockReason, s, addTag(), { expect: 'open' });
  const next = gameReducer(s, addTag());
  assert.equal(next.routes.length, 1);
  assert.equal(next.routes[0].stops.length, 3);
});

test('fewer than three stops is reported', () => {
  const r = agrees(addTagRouteBlockReason, tagState(), addTag({ stops: [A, B] }), { expect: 'blocked' });
  assert.match(r, /stop|airport/i);
});

test('a repeated airport is reported', () => {
  const r = agrees(addTagRouteBlockReason, tagState(), addTag({ stops: [A, B, A] }), { expect: 'blocked' });
  assert.match(r, /twice|repeat|same/i);
});

test('an unknown airport code is reported', () => {
  const s = tagState({ gates: { [A]: 2, [B]: 2, ZZZ: 2 } });
  const r = agrees(addTagRouteBlockReason, s, addTag({ stops: [A, B, 'ZZZ'] }), { expect: 'blocked' });
  assert.match(r, /ZZZ/);
});

test('a freighter on a passenger multi-stop is reported', () => {
  const s = tagState({
    fleet: [{ id: 'p1', typeId: FREIGHTER.id, tailNumber: 'PH-CGO', status: 'idle', ageWeeks: 0, reserveBase: null }],
  });
  const r = agrees(addTagRouteBlockReason, s, addTag(), { expect: 'blocked' });
  assert.match(r, /freighter/i);
});

test('an unknown aircraft is reported', () => {
  const r = agrees(addTagRouteBlockReason, tagState(), addTag({ aircraftId: 'nope' }), { expect: 'blocked' });
  assert.match(r, /aircraft/i);
});

test('no gate at an intermediate STOP is reported, and names it', () => {
  const s = tagState({ gates: { [A]: 2, [C]: 2 } });   // nothing at B, the middle stop
  const r = agrees(addTagRouteBlockReason, s, addTag(), { expect: 'blocked' });
  assert.match(r, new RegExp(B));
  assert.match(r, /gate/i);
});

test('too little cash to launch is reported', () => {
  const s = tagState({ cash: 1000 });
  const r = agrees(addTagRouteBlockReason, s, addTag(), { expect: 'blocked' });
  assert.match(r, /cash|afford/i);
});

test('out of range on the LONGEST leg is reported', () => {
  const s = tagState({ gates: { [A]: 2, [B]: 2, SYD: 2 } });
  const r = agrees(addTagRouteBlockReason, s, addTag({ stops: [A, B, 'SYD'] }), { expect: 'blocked' });
  assert.match(r, /reach|range/i);
});

console.log('\n── server wiring: what decisions.mjs pre-flights ────────\n');

test('routeBlockReasonFor dispatches all three route actions', () => {
  const cs = cargoState({ gates: { [A]: 2 } });
  assert.ok(routeBlockReasonFor('ADD_CARGO_ROUTE', cs, addCargo()),
    'ADD_CARGO_ROUTE is not pre-flighted — the endpoint still replies 201 on a refusal');
  const ts = tagState({ gates: { [A]: 2, [C]: 2 } });
  assert.ok(routeBlockReasonFor('ADD_TAG_ROUTE', ts, addTag()),
    'ADD_TAG_ROUTE is not pre-flighted — the endpoint still replies 201 on a refusal');
  const ps = tagState({ gates: { [A]: 2 } });
  assert.ok(routeBlockReasonFor('ADD_ROUTE', ps,
    { type: 'ADD_ROUTE', origin: A, destination: B, aircraftId: 'p1', weeklyFrequency: 7, ticketPrice: 180 }),
    'ADD_ROUTE lost its pre-flight');
});

test('routeBlockReasonFor is null for a legal add of each kind', () => {
  assert.equal(routeBlockReasonFor('ADD_CARGO_ROUTE', cargoState(), addCargo()), null);
  assert.equal(routeBlockReasonFor('ADD_TAG_ROUTE', tagState(), addTag()), null);
  assert.equal(routeBlockReasonFor('ADD_ROUTE', tagState(),
    { type: 'ADD_ROUTE', origin: A, destination: B, aircraftId: 'p1', weeklyFrequency: 7, ticketPrice: 180 }), null);
});

test('routeBlockReasonFor never speaks for an unrelated action', () => {
  assert.equal(routeBlockReasonFor('CLOSE_ROUTE', cargoState(), { type: 'CLOSE_ROUTE', routeId: 'x' }), null);
  assert.equal(routeBlockReasonFor('BUY_HEDGE', cargoState(), { type: 'BUY_HEDGE' }), null);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
