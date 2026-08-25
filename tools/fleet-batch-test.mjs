// Moving one route, and doing fleet work in one decision instead of N.
//
// Two defects, one theme: an action the player thinks of as ONE thing was N
// things underneath, or was not available at all.
//
// C8. There was no way to move a single route to another aircraft.
//     TRANSFER_ROUTES moves a tail's WHOLE network onto an IDLE aircraft, so
//     up-gauging one hot pair meant CLOSE_ROUTE + ADD_ROUTE: the launch cost
//     charged twice and the pair fell back to week 0 of its 16-week maturity
//     ramp. These tests pin that REASSIGN_ROUTE keeps the route's identity.
//
// C9/C6b. Fleet's bulk sell / retire / check buttons looped one dispatch per
//     aircraft — in multiplayer, N authoritative round-trips behind a dialog
//     promising one outcome, and a failure partway leaving a partial result
//     with nothing to say so. The batch cases FOLD their single-aircraft case,
//     so the guards cannot drift, and report what actually applied.
//
//   node tools/fleet-batch-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const ENGINE = '../packages/engine/src/reducer.mjs';
const { gameReducer: reducer, freshState, reassignCompatibility } = await import(ENGINE);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// A small narrowbody and a bigger one that can also reach further, plus a
// freighter — enough to exercise type, range and block-hour refusals.
const small = AIRCRAFT_TYPES.filter(t => !t.freighter && t.range > 3000 && t.range < 7000)
  .sort((a, b) => a.seats - b.seats)[0];
const big   = AIRCRAFT_TYPES.filter(t => !t.freighter && t.range > 11000)
  .sort((a, b) => b.seats - a.seats)[0];
const tiny  = AIRCRAFT_TYPES.filter(t => !t.freighter && t.range < 2000)
  .sort((a, b) => a.range - b.range)[0];
const frtr  = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => b.range - a.range)[0];
assert.ok(small && big && tiny && frtr, 'fixture types missing from the catalogue');

const tail = (id, type, extra = {}) => ({
  id, typeId: type.id, name: id, tailNumber: id.toUpperCase(),
  status: 'idle', ageWeeks: 52, ownershipType: 'owned',
  config: type.freighter ? undefined : { economy: type.seats },
  ...extra,
});

function baseState(overrides = {}) {
  return {
    ...freshState(),
    phase: 'playing', week: 30, year: 1, hub: 'JFK', cash: 500_000_000,
    hubs: { JFK: { tier: 2, tierSince: 1 } },
    gates: { JFK: 20, LAX: 20, BOS: 20, LHR: 20 },
    fleet: [], routes: [], cargoRoutes: [],
    ...overrides,
  };
}

const paxRoute = (id, aircraftId, o = 'JFK', d = 'BOS', extra = {}) => ({
  id, origin: o, destination: d, aircraftId, weeklyFrequency: 4, weeksOpen: 30,
  hub: 'JFK', ticketPrice: 240, cateringLevel: 'full', ...extra,
});

// ── C8: moving one route ────────────────────────────────────────────────────

test('a route can move to another aircraft that is already flying', () => {
  // The common case, and the one TRANSFER_ROUTES refuses: the target is busy.
  const s0 = baseState({
    fleet: [tail('a1', small, { status: 'assigned' }), tail('a2', big, { status: 'assigned' })],
    routes: [paxRoute('r1', 'a1'), paxRoute('r2', 'a2', 'JFK', 'LAX')],
  });
  assert.equal(reassignCompatibility(s0, 'r1', 'a2').ok, true,
    reassignCompatibility(s0, 'r1', 'a2').reason);
  const s1 = reducer(s0, { type: 'REASSIGN_ROUTE', routeId: 'r1', toAircraftId: 'a2' });
  assert.equal(s1.routes.find(r => r.id === 'r1').aircraftId, 'a2');
  assert.equal(s1.routes.find(r => r.id === 'r2').aircraftId, 'a2', 'the other route must not move');
});

test('the moved route keeps its ramp, fares, season and id', () => {
  // The whole reason this action exists. Close-and-reopen made a new route at
  // weeksOpen 0 and charged the launch cost again.
  const s0 = baseState({
    fleet: [tail('a1', small, { status: 'assigned' }), tail('a2', big)],
    routes: [paxRoute('r1', 'a1', 'JFK', 'BOS', {
      weeksOpen: 61, season: 'summer', cateringLevel: 'premium',
      classPrices: { economy: 199 },
    })],
  });
  const cashBefore = s0.cash;
  const s1 = reducer(s0, { type: 'REASSIGN_ROUTE', routeId: 'r1', toAircraftId: 'a2' });
  const moved = s1.routes.find(r => r.id === 'r1');
  assert.equal(moved.weeksOpen, 61, 'the maturity ramp must not reset');
  assert.equal(moved.season, 'summer');
  assert.equal(moved.cateringLevel, 'premium');
  assert.deepEqual(moved.classPrices, { economy: 199 });
  assert.equal(s1.cash, cashBefore, 'moving equipment must not charge a launch cost');
  assert.equal(s1.routes.length, 1, 'it is the same route, not a new one');
});

test('the donor goes idle only if it gave up its last route', () => {
  const twoRoutes = baseState({
    fleet: [tail('a1', big, { status: 'assigned' }), tail('a2', big)],
    routes: [paxRoute('r1', 'a1'), paxRoute('r2', 'a1', 'JFK', 'LAX')],
  });
  const kept = reducer(twoRoutes, { type: 'REASSIGN_ROUTE', routeId: 'r1', toAircraftId: 'a2' });
  assert.equal(kept.fleet.find(a => a.id === 'a1').status, 'assigned', 'a1 still flies r2');

  const oneRoute = baseState({
    fleet: [tail('a1', big, { status: 'assigned' }), tail('a2', big)],
    routes: [paxRoute('r1', 'a1')],
  });
  const emptied = reducer(oneRoute, { type: 'REASSIGN_ROUTE', routeId: 'r1', toAircraftId: 'a2' });
  assert.equal(emptied.fleet.find(a => a.id === 'a1').status, 'idle');
  assert.equal(emptied.fleet.find(a => a.id === 'a2').status, 'assigned');
});

test('taking a route stands a reserve down from standby', () => {
  const s0 = baseState({
    fleet: [tail('a1', big, { status: 'assigned' }), tail('res', big, { reserveBase: 'JFK' })],
    routes: [paxRoute('r1', 'a1')],
  });
  const s1 = reducer(s0, { type: 'REASSIGN_ROUTE', routeId: 'r1', toAircraftId: 'res' });
  const res = s1.fleet.find(a => a.id === 'res');
  assert.equal(res.reserveBase, null, 'an aircraft flying a route is not standing by');
  assert.equal(res.status, 'assigned');
});

test('a route out of the target\'s range is refused, with the reason', () => {
  const s0 = baseState({
    fleet: [tail('a1', big, { status: 'assigned' }), tail('a2', tiny)],
    routes: [paxRoute('r1', 'a1', 'JFK', 'LHR')],
  });
  const verdict = reassignCompatibility(s0, 'r1', 'a2');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /range/i);
  assert.equal(reducer(s0, { type: 'REASSIGN_ROUTE', routeId: 'r1', toAircraftId: 'a2' }), s0,
    'a refused move must leave the state untouched, not half-apply');
});

test('passenger routes refuse freighters and cargo lanes refuse passenger jets', () => {
  const s0 = baseState({
    fleet: [tail('a1', big, { status: 'assigned' }), tail('f1', frtr, { status: 'assigned' })],
    routes: [paxRoute('r1', 'a1')],
    cargoRoutes: [{ id: 'c1', origin: 'JFK', destination: 'LAX', aircraftId: 'f1', weeklyFrequency: 3, yieldPrice: 0.35, weeksOpen: 30 }],
  });
  assert.equal(reassignCompatibility(s0, 'r1', 'f1').ok, false);
  assert.match(reassignCompatibility(s0, 'r1', 'f1').reason, /freighter/i);
  assert.equal(reassignCompatibility(s0, 'c1', 'a1').ok, false);
  assert.match(reassignCompatibility(s0, 'c1', 'a1').reason, /freighter/i);
});

test('a cargo lane can move between freighters', () => {
  const s0 = baseState({
    fleet: [tail('f1', frtr, { status: 'assigned' }), tail('f2', frtr)],
    cargoRoutes: [{ id: 'c1', origin: 'JFK', destination: 'LAX', aircraftId: 'f1', weeklyFrequency: 3, yieldPrice: 0.35, weeksOpen: 44 }],
  });
  const s1 = reducer(s0, { type: 'REASSIGN_ROUTE', routeId: 'c1', toAircraftId: 'f2' });
  assert.equal(s1.cargoRoutes[0].aircraftId, 'f2');
  assert.equal(s1.cargoRoutes[0].weeksOpen, 44, 'lane maturity must survive the move');
});

test('a tail with no spare hours is refused rather than overbooked', () => {
  // Load the target right up with long-haul flying, then try to add more.
  const s0 = baseState({
    fleet: [tail('a1', big, { status: 'assigned' }), tail('a2', big, { status: 'assigned' })],
    routes: [
      paxRoute('r1', 'a1', 'JFK', 'LHR', { weeklyFrequency: 4 }),
      paxRoute('r2', 'a2', 'JFK', 'LHR', { weeklyFrequency: 7 }),
      paxRoute('r3', 'a2', 'JFK', 'LAX', { weeklyFrequency: 7 }),
    ],
  });
  const verdict = reassignCompatibility(s0, 'r1', 'a2');
  assert.equal(verdict.ok, false, 'expected the block-hour budget to bite');
  assert.match(verdict.reason, /block hours/i);
});

test('a reserve cover cannot be moved by hand', () => {
  // The route belongs to the broken tail and goes home when it returns; moving
  // it would strand the marker.
  const s0 = baseState({
    fleet: [tail('a1', big, { status: 'grounded' }), tail('res', big, { status: 'assigned' }), tail('a3', big)],
    routes: [paxRoute('r1', 'res', 'JFK', 'BOS', { coverForAircraftId: 'a1' })],
  });
  const verdict = reassignCompatibility(s0, 'r1', 'a3');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /cover/i);
});

test('moving to the aircraft it already flies, or to a missing tail, is a no-op', () => {
  const s0 = baseState({
    fleet: [tail('a1', big, { status: 'assigned' })],
    routes: [paxRoute('r1', 'a1')],
  });
  assert.equal(reassignCompatibility(s0, 'r1', 'a1').ok, false);
  assert.equal(reassignCompatibility(s0, 'r1', 'ghost').ok, false);
  assert.equal(reassignCompatibility(s0, 'ghost', 'a1').ok, false);
  assert.equal(reducer(s0, { type: 'REASSIGN_ROUTE', routeId: 'r1', toAircraftId: 'ghost' }), s0);
});

test('an out-of-service tail cannot be handed a route', () => {
  const s0 = baseState({
    fleet: [tail('a1', big, { status: 'assigned' }), tail('a2', big, { status: 'maintenance' })],
    routes: [paxRoute('r1', 'a1')],
  });
  assert.equal(reassignCompatibility(s0, 'r1', 'a2').ok, false);
});

// ── C9: one decision, not N ─────────────────────────────────────────────────

test('a bulk sale removes every selected tail and pays for all of them', () => {
  const s0 = baseState({ fleet: [tail('o1', big), tail('o2', big), tail('o3', big)] });
  const one   = reducer(s0, { type: 'SELL_AIRCRAFT', aircraftId: 'o1' });
  const three = reducer(s0, { type: 'SELL_AIRCRAFT_BULK', aircraftIds: ['o1', 'o2', 'o3'] });
  assert.equal(three.fleet.length, 0);
  const perAircraft = one.cash - s0.cash;
  assert.ok(perAircraft > 0);
  assert.equal(three.cash - s0.cash, perAircraft * 3, 'the batch must pay the same as three sales');
  assert.equal(three.bulkResult.applied, 3);
  assert.equal(three.bulkResult.skipped, 0);
});

test('a bulk sale exposes EVERY sold tail, not just the last one', () => {
  // The multiplayer used-aircraft market lists from this. Reading `lastSale`
  // alone after a batch would quietly drop all but the final aircraft out of the
  // world market. Solo has no used market, so its SELL_AIRCRAFT records nothing
  // and there is nothing here to check.
  const s0 = baseState({ fleet: [tail('o1', big), tail('o2', small)] });
  const single = reducer(s0, { type: 'SELL_AIRCRAFT', aircraftId: 'o1' });
  if (!single.lastSale) return;   // solo build — no used market
  const s1 = reducer(s0, { type: 'SELL_AIRCRAFT_BULK', aircraftIds: ['o1', 'o2'] });
  assert.equal(s1.lastSales.length, 2);
  assert.deepEqual(s1.lastSales.map(x => x.aircraftId), ['o1', 'o2']);
  assert.ok(s1.lastSales.every(x => x.nav > 0));
  assert.equal(s1.lastSale.aircraftId, 'o2', 'the single-sale field stays populated for old readers');
});

test('a leased tail is skipped by a bulk SALE rather than aborting it', () => {
  // SELL_AIRCRAFT refuses leases (they go back via retire). One in the selection
  // must not stop the owned ones selling.
  const s0 = baseState({
    fleet: [tail('o1', big), tail('l1', big, { ownershipType: 'lease', weeklyLease: 50_000, leaseRemainingWeeks: 40 }), tail('o2', big)],
  });
  const s1 = reducer(s0, { type: 'SELL_AIRCRAFT_BULK', aircraftIds: ['o1', 'l1', 'o2'] });
  assert.deepEqual(s1.fleet.map(a => a.id), ['l1']);
  assert.equal(s1.bulkResult.applied, 2);
  assert.equal(s1.bulkResult.skipped, 1);
});

test('bulk retire charges every early-termination penalty, and closes the routes', () => {
  const leased = (id) => tail(id, big, { ownershipType: 'lease', weeklyLease: 100_000, leaseRemainingWeeks: 10, status: 'assigned' });
  const s0 = baseState({
    fleet: [leased('l1'), leased('l2')],
    routes: [paxRoute('r1', 'l1'), paxRoute('r2', 'l2', 'JFK', 'LAX')],
  });
  const one = reducer(s0, { type: 'RETIRE_AIRCRAFT', aircraftId: 'l1' });
  const two = reducer(s0, { type: 'RETIRE_AIRCRAFT_BULK', aircraftIds: ['l1', 'l2'] });
  const penaltyOne = s0.cash - one.cash;
  assert.ok(penaltyOne > 0);
  assert.equal(s0.cash - two.cash, penaltyOne * 2);
  assert.equal(two.fleet.length, 0);
  assert.equal(two.routes.length, 0, 'removing the aircraft closes its routes');
});

test('bulk checks start every affordable check and report the ones money ran out on', () => {
  // The honest outcome when a fleet-wide check bill exceeds the balance is
  // "some started" — with a count, not silence.
  const c = (id) => tail(id, big, { status: 'assigned', ageWeeks: 900 });
  const rich = baseState({ fleet: [c('a1'), c('a2'), c('a3')], cash: 500_000_000 });
  const all = reducer(rich, { type: 'SCHEDULE_CHECKS', aircraftIds: ['a1', 'a2', 'a3'], checkType: 'C', startNow: true });
  assert.equal(all.bulkResult.applied, 3);
  assert.equal(all.fleet.filter(a => a.status === 'maintenance').length, 3);

  const oneCheckCost = rich.cash - reducer(rich, { type: 'SCHEDULE_CHECK', aircraftId: 'a1', checkType: 'C', startNow: true }).cash;
  assert.ok(oneCheckCost > 0);
  const poor = baseState({ fleet: [c('a1'), c('a2'), c('a3')], cash: Math.floor(oneCheckCost * 1.5) });
  const some = reducer(poor, { type: 'SCHEDULE_CHECKS', aircraftIds: ['a1', 'a2', 'a3'], checkType: 'C', startNow: true });
  assert.equal(some.bulkResult.applied, 1);
  assert.equal(some.bulkResult.skipped, 2);
  assert.ok(!some.error, 'a partly-applied batch must not leave a sticky error banner');
});

test('bulk lease extension adds a year to each, leaving owned aircraft alone', () => {
  const s0 = baseState({
    fleet: [
      tail('l1', big, { ownershipType: 'lease', leaseRemainingWeeks: 6, leaseTermWeeks: 104 }),
      tail('l2', big, { ownershipType: 'lease', leaseRemainingWeeks: 3, leaseTermWeeks: 104 }),
      tail('o1', big),
    ],
  });
  const s1 = reducer(s0, { type: 'EXTEND_LEASES', aircraftIds: ['l1', 'l2', 'o1'], addWeeks: 52 });
  assert.equal(s1.fleet.find(a => a.id === 'l1').leaseRemainingWeeks, 58);
  assert.equal(s1.fleet.find(a => a.id === 'l2').leaseRemainingWeeks, 55);
  assert.equal(s1.fleet.find(a => a.id === 'o1').leaseRemainingWeeks, undefined);
  // EXTEND_LEASE returns a new object even for an owned tail, so `applied`
  // counts it; what matters is that nothing about the owned aircraft moved.
  assert.ok(s1.bulkResult.applied >= 2);
});

test('an empty or duplicate-laden id list is handled without side effects', () => {
  const s0 = baseState({ fleet: [tail('o1', big)] });
  assert.equal(reducer(s0, { type: 'SELL_AIRCRAFT_BULK', aircraftIds: [] }), s0);
  assert.equal(reducer(s0, { type: 'SELL_AIRCRAFT_BULK' }), s0);
  const dup = reducer(s0, { type: 'SELL_AIRCRAFT_BULK', aircraftIds: ['o1', 'o1', 'o1'] });
  assert.equal(dup.bulkResult.applied, 1, 'a repeated id must not sell one aircraft three times');
});

test('a batch of nothing-applies leaves the state identical', () => {
  const s0 = baseState({ fleet: [tail('l1', big, { ownershipType: 'lease', leaseRemainingWeeks: 20 })] });
  assert.equal(reducer(s0, { type: 'SELL_AIRCRAFT_BULK', aircraftIds: ['l1'] }), s0);
});

// ── The client and the server actually use them ─────────────────────────────

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the Fleet page dispatches one batched action, not a loop', () => {
  const src = read('../src/components/Fleet.jsx');
  assert.ok(!/for \(const a of checkedOwned\) dispatch/.test(src), 'bulk sell still loops');
  assert.ok(!/for \(const a of checkedAircraft\) dispatch/.test(src), 'bulk retire still loops');
  assert.ok(!/for \(const a of list\) dispatch/.test(src), 'bulk checks still loop');
  assert.ok(/SELL_AIRCRAFT_BULK/.test(src) && /RETIRE_AIRCRAFT_BULK/.test(src) && /SCHEDULE_CHECKS/.test(src));
  assert.ok(/EXTEND_LEASES/.test(src), 'no bulk lease renewal');
});

test('the route row offers a move instead of only a remove', () => {
  const src = read('../src/components/Routes.jsx');
  assert.ok(/ReassignRouteButton/.test(src));
});

test('multiplayer allows the new intents and sanitizes their payloads', () => {
  const world = read('../apps/headwinds-server/src/world.mjs');
  for (const t of ['REASSIGN_ROUTE', 'SELL_AIRCRAFT_BULK', 'RETIRE_AIRCRAFT_BULK', 'SCHEDULE_CHECKS', 'EXTEND_LEASES']) {
    assert.ok(world.includes(`'${t}'`), `${t} is not on the multiplayer allow-list — the client would 403`);
  }
  const guard = read('../apps/headwinds-server/src/lib/decisionGuard.mjs');
  assert.ok(/guardAircraftIds/.test(guard), 'batch id lists are not sanitized');
  assert.ok(/Too many aircraft in one batch/.test(guard),
    'an unbounded batch holds row locks for as long as it takes to fold');
});

test('the used-market hook lists every tail a batch sold', () => {
  const src = read('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.ok(/lastSales/.test(src),
    'a bulk sale would list only its final aircraft in the world market');
});




// ── C-new-2: atomic bulk cabin reconfigure ──────────────────────────────────
test('CONFIGURE_AIRCRAFT_BULK applies one layout to N tails and charges the summed cost once', () => {
  const cfg = { economy: 100 };
  const s0  = baseState({ fleet: [tail('o1', big), tail('o2', big), tail('o3', big)] });
  const bulk = reducer(s0, { type: 'CONFIGURE_AIRCRAFT_BULK', aircraftIds: ['o1', 'o2', 'o3'], config: cfg, reconfCost: 900 });
  assert.equal(s0.cash - bulk.cash, 900, 'charged the summed cost exactly once');
  assert.ok(bulk.fleet.every(a => JSON.stringify(a.config) === JSON.stringify(cfg)), 'every tail got the new layout');
  assert.equal(bulk.bulkResult.applied, 3);
  assert.equal(bulk.bulkResult.skipped, 0);
  // Same final layouts as the old per-tail loop it replaces.
  let seq = s0;
  for (const id of ['o1', 'o2', 'o3']) seq = reducer(seq, { type: 'CONFIGURE_AIRCRAFT', aircraftId: id, config: cfg, reconfCost: 300 });
  assert.deepEqual(bulk.fleet.map(a => a.config), seq.fleet.map(a => a.config), 'same layouts as three single configures');
});

test('CONFIGURE_AIRCRAFT_BULK ignores unknown ids and an empty batch is a no-op', () => {
  const s0 = baseState({ fleet: [tail('o1', big)] });
  assert.equal(reducer(s0, { type: 'CONFIGURE_AIRCRAFT_BULK', aircraftIds: [], config: { economy: 50 }, reconfCost: 100 }), s0);
  const partial = reducer(s0, { type: 'CONFIGURE_AIRCRAFT_BULK', aircraftIds: ['o1', 'ghost'], config: { economy: 50 }, reconfCost: 100 });
  assert.equal(partial.fleet.length, 1);
  assert.deepEqual(partial.fleet[0].config, { economy: 50 });
});

test('the Fleet config modal dispatches one batched reconfigure, not a loop', () => {
  const src = read('../src/components/FleetConfig.jsx');
  assert.ok(/CONFIGURE_AIRCRAFT_BULK/.test(src), 'no bulk reconfigure action');
  assert.ok(!/type:\s*[\x27"]CONFIGURE_AIRCRAFT[\x27"]/.test(src), 'still dispatches the per-aircraft action (loop not removed)');
});


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
