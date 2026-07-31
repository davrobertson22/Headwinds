// Reserve aircraft (hub-based standby covers) engine test — no DB, no network.
//   node tools/reserve-cover-test.mjs
// Design doc: docs/reserve-aircraft-design.md
import assert from 'node:assert/strict';
import { gameReducer, freshState, reconcileState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import * as R from '../packages/engine/src/data/reserve.js';
import { planCovers, applyReserveCovers, deployableFleetForRoute } from '../packages/engine/src/utils/simulation.js';

// Determinism: keep RNG high (no failures, no events) but VARYING — uid() builds
// ids from Math.random, and a constant stub makes two aircraft bought in the
// same millisecond collide on id.
let _rng = 0;
Math.random = () => 0.90 + ((_rng++ % 97) / 1000);

const TYPE = 'crj200';
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}
function newGame() {
  return gameReducer(freshState(), { type: 'START_GAME', airlineName: 'RSV', hub: 'JFK', enableObjectives: false });
}
function buyJet(s, typeId = TYPE) {
  const before = s.fleet.length;
  s = gameReducer({ ...s, cash: Math.max(s.cash, 500_000_000) }, { type: 'BUY_AIRCRAFT', typeId });
  if (s.fleet.length === before) throw new Error('buy failed, cash=' + s.cash);
  return { s, id: s.fleet[s.fleet.length - 1].id };
}
const find = (s, id) => s.fleet.find(a => a.id === id);

// Standard rig: jet A flying JFK–ORD, jet B stationed as a reserve at JFK.
function rig() {
  let s = newGame();
  let a, b;
  ({ s, id: a } = buyJet(s));
  ({ s, id: b } = buyJet(s));
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: a, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  if (s.routes.length === 0) throw new Error('route did not attach');
  s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'JFK' });
  return { s, a, b };
}

t('SET_RESERVE stations an idle tail at an own hub only', () => {
  let s = newGame();
  let b; ({ s, id: b } = buyJet(s));
  const denied = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'ORD' }); // not a hub
  assert.equal(find(denied, b).reserveBase ?? null, null, 'non-hub base refused');
  s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'JFK' });
  assert.equal(find(s, b).reserveBase, 'JFK');
  s = gameReducer(s, { type: 'CLEAR_RESERVE', aircraftId: b });
  assert.equal(find(s, b).reserveBase ?? null, null);
});

t('SET_RESERVE refused for assigned or out-of-service tails', () => {
  let { s, a, b } = rig();
  const onAssigned = gameReducer(s, { type: 'SET_RESERVE', aircraftId: a, baseCode: 'JFK' });
  assert.equal(find(onAssigned, a).reserveBase ?? null, null, 'assigned tail refused');
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: b, checkType: 'C', startNow: true });
  const onShop = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'JFK' });
  assert.equal(find(onShop, b).status, 'maintenance');
});

t('manually assigning a route to a reserve clears its station', () => {
  let { s, b } = rig();
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'BOS' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: b, origin: 'JFK', destination: 'BOS', weeklyFrequency: 7 });
  assert.equal(find(s, b).reserveBase ?? null, null);
});

t('a D check dispatches the reserve onto the routes the first lost week', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true }); // RJ D = 3 wks
  assert.equal(find(s, a).status, 'maintenance');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const r = s.routes[0];
  assert.equal(r.aircraftId, b, 'route flown by the reserve');
  assert.equal(r.coverForAircraftId, a, 'marker remembers the original');
  assert.equal(find(s, b).status, 'assigned');
  assert.equal(find(s, b).reserveBase, 'JFK', 'still stationed while covering');
  assert.equal((s.lastReport.coverage?.started ?? []).length, 1);
  const rr = (s.lastReport.routeResults ?? []).find(x => x.routeId === r.id);
  assert.ok(rr && rr.revenue > 0, 'covered route earned revenue');
});

t('routes hand back the week the original returns; reserve stands by again', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' }); // covering, 2 wks left
  s = gameReducer(s, { type: 'ADVANCE_WEEK' }); // covering, 1 wk left
  assert.equal(s.routes[0].aircraftId, b, 'still covering mid-check');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' }); // check completes at tick top -> return
  const r = s.routes[0];
  assert.equal(r.aircraftId, a, 'route back on the original');
  assert.equal(r.coverForAircraftId ?? null, null, 'marker cleared');
  assert.equal(find(s, a).status, 'assigned');
  assert.equal(find(s, b).status, 'idle');
  assert.equal(find(s, b).reserveBase, 'JFK', 'reserve still stationed');
  assert.equal((s.lastReport.coverage?.ended ?? []).length, 1);
});

t('hub scope: a reserve based elsewhere never covers, and the gap is reported once', () => {
  let { s, a, b } = rig();
  // Restation the reserve at a focus city the route does not touch.
  s = { ...s, hubs: { ...s.hubs, LGA: { tier: 0, tierSince: 0 } } };
  s = gameReducer(s, { type: 'CLEAR_RESERVE', aircraftId: b });
  s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'LGA' });
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.routes[0].aircraftId, a, 'no cover — wrong base');
  const gaps = s.lastReport.coverage?.gaps ?? [];
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, 'no-reserve');
  const gapToasts1 = (s.pendingToasts ?? []).filter(x => (x.title ?? '').includes('No cover'));
  assert.equal(gapToasts1.length, 1, 'gap toast fires');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const gapToasts2 = (s.pendingToasts ?? []).filter(x => (x.title ?? '').includes('No cover'));
  assert.equal(gapToasts2.length, 0, 'gap toast does not repeat while the incident persists');
});

t('identical-type rule: a different type never covers', () => {
  let s = newGame();
  let a, b;
  ({ s, id: a } = buyJet(s, TYPE));
  ({ s, id: b } = buyJet(s, 'q400')); // different type, same size class
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: a, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'JFK' });
  if (find(s, b).reserveBase !== 'JFK') throw new Error('setup: reserve not stationed');
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.routes[0].aircraftId, a, 'no cross-type cover');
  assert.equal((s.lastReport.coverage?.gaps ?? [])[0]?.reason, 'no-reserve');
});

t('standby costs: parking + readiness while idle, parking suspended while covering', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const type = getAircraftType(TYPE);
  const expParking = R.reserveParkingFee(type.category, 'mega'); // JFK is a mega airport
  assert.equal(s.lastReport.totalReserveParking, expParking, 'parking billed at base tier');
  const sb = (s.lastReport.reserveStandby ?? []).find(x => x.aircraftId === b);
  assert.ok(sb, 'standby breakdown present');
  assert.equal(sb.parking, expParking);
  assert.ok(sb.readinessPremium > 0, 'readiness premium charged');
  // Now send A to the shop — while covering, parking suspends but premium stays.
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const sb2 = (s.lastReport.reserveStandby ?? []).find(x => x.aircraftId === b);
  assert.equal(sb2.parking, 0, 'no parking while out covering');
  assert.ok(sb2.readinessPremium > 0, 'premium continues');
});

t('wear follows the covering metal; the broken tail is frozen', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  const hoursA0 = find(s, a).hoursSinceC ?? 0;
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(find(s, a).hoursSinceC ?? 0, hoursA0, 'original accrues nothing in the shop');
  assert.ok((find(s, b).hoursSinceC ?? 0) > 0, 'reserve wears while covering');
});

t('selling the original mid-cover makes the transfer permanent', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.routes[0].aircraftId, b, 'setup: covering');
  // Sell requires the tail in service — settle path is exercised via RETIRE (leased/owned both allowed).
  s = gameReducer(s, { type: 'RETIRE_AIRCRAFT', aircraftId: a });
  const r = s.routes[0];
  assert.ok(r, 'route survives the removal of its original');
  assert.equal(r.aircraftId, b, 'routes stay with the ex-reserve');
  assert.equal(r.coverForAircraftId ?? null, null, 'marker cleared');
  assert.equal(find(s, b).reserveBase ?? null, null, 'ex-reserve is a line aircraft now');
});

t('retiring the covering reserve hands the routes back first', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  s = gameReducer(s, { type: 'RETIRE_AIRCRAFT', aircraftId: b });
  const r = s.routes[0];
  assert.ok(r, 'route not deleted with the reserve');
  assert.equal(r.aircraftId, a, 'route back on the (still broken) original');
  assert.equal(r.coverForAircraftId ?? null, null);
  assert.equal(find(s, a).status, 'maintenance', 'original still in the shop');
});

t('removals elsewhere no longer yank tails out of the shop (status preservation)', () => {
  let { s, a } = rig();
  let c; ({ s, id: c } = buyJet(s));
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'RETIRE_AIRCRAFT', aircraftId: c });
  assert.equal(find(s, a).status, 'maintenance', 'check survives an unrelated retirement');
});

t('CLEAR_RESERVE mid-cover: the cover runs to its natural end', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  s = gameReducer(s, { type: 'CLEAR_RESERVE', aircraftId: b });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.routes[0].aircraftId, b, 'still covering after CLEAR_RESERVE');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' }); // check completes
  assert.equal(s.routes[0].aircraftId, a, 'handed back');
  assert.equal(find(s, b).reserveBase ?? null, null, 'not restationed');
});

t('planCovers is deterministic and prioritises by last-week revenue', () => {
  const type = getAircraftType(TYPE);
  const mk = (id, extra = {}) => ({ id, typeId: TYPE, status: 'idle', ...extra });
  const fleet = [
    mk('brk', { status: 'maintenance', checkWeeksLeft: 2 }),
    mk('res1', { reserveBase: 'JFK' }),
    mk('res2', { reserveBase: 'JFK' }),
  ];
  const routes = [
    { id: 'r-low',  origin: 'JFK', destination: 'ORD', aircraftId: 'brk', weeklyFrequency: 21 },
    { id: 'r-high', origin: 'JFK', destination: 'BOS', aircraftId: 'brk', weeklyFrequency: 21 },
  ];
  const args = { fleet, routes, cargoRoutes: [], hubs: { JFK: { tier: 1 } }, absWeek: 10, routeRevenues: { 'r-high': 900_000, 'r-low': 100_000 } };
  const p1 = planCovers(args);
  const p2 = planCovers(args);
  assert.deepEqual(p1, p2, 'same inputs, same plan');
  assert.equal(p1.assignments[0].routeId, 'r-high', 'highest revenue first');
  assert.equal(p1.assignments[0].reserveId, 'res1', 'reserves scan in id order');
  assert.ok(type, 'type exists');
});

t('block-hours cap: one reserve cannot absorb more than it can fly', () => {
  const fleet = [
    { id: 'brk', typeId: TYPE, status: 'grounded', groundedWeeksLeft: 4 },
    { id: 'res', typeId: TYPE, status: 'idle', reserveBase: 'JFK' },
  ];
  // Three ~60h rotations: individually fine, together far over 140 h/wk.
  const routes = ['r1', 'r2', 'r3'].map(id => ({
    id, origin: 'JFK', destination: 'ORD', aircraftId: 'brk', weeklyFrequency: 14,
  }));
  const { assignments, gaps } = planCovers({ fleet, routes, cargoRoutes: [], hubs: { JFK: { tier: 1 } }, absWeek: 0, routeRevenues: {} });
  assert.ok(assignments.length >= 1, 'covers what it can');
  assert.ok(gaps.length >= 1, 'reports what it cannot');
  assert.ok(gaps.every(g => g.reason === 'hours-full'));
});

t('a reserve with its own check booked soon is not dispatched', () => {
  const fleet = [
    { id: 'brk', typeId: TYPE, status: 'grounded', groundedWeeksLeft: 4 },
    { id: 'res', typeId: TYPE, status: 'idle', reserveBase: 'JFK', scheduledCheck: { type: 'C', startWeek: 11 } },
  ];
  const routes = [{ id: 'r1', origin: 'JFK', destination: 'ORD', aircraftId: 'brk', weeklyFrequency: 7 }];
  const { assignments } = planCovers({ fleet, routes, cargoRoutes: [], hubs: { JFK: { tier: 1 } }, absWeek: 10, routeRevenues: {} });
  assert.equal(assignments.length, 0, 'held back for its own check');
});

t('applyReserveCovers: a broken reserve hands routes home for re-dispatch', () => {
  const fleet = [
    { id: 'brk',  typeId: TYPE, status: 'maintenance', checkWeeksLeft: 3 },
    { id: 'res1', typeId: TYPE, status: 'grounded', groundedWeeksLeft: 2, reserveBase: 'JFK' },
    { id: 'res2', typeId: TYPE, status: 'idle', reserveBase: 'JFK' },
  ];
  const routes = [{ id: 'r1', origin: 'JFK', destination: 'ORD', aircraftId: 'res1', coverForAircraftId: 'brk', weeklyFrequency: 7 }];
  const out = applyReserveCovers({ fleet, routes, cargoRoutes: [], hubs: { JFK: { tier: 1 } }, absWeek: 0, routeRevenues: {} });
  assert.equal(out.routes[0].aircraftId, 'res2', 'second reserve picked it up');
  assert.equal(out.routes[0].coverForAircraftId, 'brk');
});

t('reconcileState: old saves default cleanly; orphaned covers go home', () => {
  const parsed = {
    fleet: [
      { id: 'a1', typeId: TYPE, status: 'idle' },
    ],
    routes: [
      { id: 'r1', origin: 'JFK', destination: 'ORD', aircraftId: 'ghost-reserve', coverForAircraftId: 'a1', weeklyFrequency: 7 },
    ],
    cargoRoutes: [],
  };
  const s = reconcileState(parsed);
  const a1 = s.fleet.find(a => a.id === 'a1');
  assert.equal(a1.reserveBase, null, 'reserveBase defaulted');
  const r1 = s.routes.find(r => r.id === 'r1');
  assert.ok(r1, 'covered route survived its missing reserve');
  assert.equal(r1.aircraftId, 'a1', 'went home to the original');
  assert.equal(r1.coverForAircraftId ?? null, null);
});


// ─── Route pickers: reserves are listed, flagged, and sorted last ────────────

t('deployableFleetForRoute: flags reserves and never hides them', () => {
  const fleet = [
    { id: 'free', typeId: TYPE, status: 'idle' },
    { id: 'res',  typeId: TYPE, status: 'idle', reserveBase: 'JFK' },
  ];
  const pool = deployableFleetForRoute({
    fleet, existingRoutes: [], typeId: TYPE,
    origin: 'JFK', dest: 'ORD', distKm: 1180, weeklyFrequency: 7,
  });
  assert.equal(pool.length, 2, 'a stationed reserve stays selectable');
  const res = pool.find(d => d.aircraft.id === 'res');
  assert.equal(res.reserve, true, 'reserve flagged');
  assert.equal(res.eligible, true, 'reserve still deployable');
  assert.equal(pool.find(d => d.aircraft.id === 'free').reserve, false);
});

t('deployableFleetForRoute: free tails outrank reserves in the picker', () => {
  const fleet = [
    { id: 'res',  typeId: TYPE, status: 'idle', reserveBase: 'JFK' },
    { id: 'free', typeId: TYPE, status: 'idle' },
  ];
  const pool = deployableFleetForRoute({
    fleet, existingRoutes: [], typeId: TYPE,
    origin: 'JFK', dest: 'ORD', distKm: 1180, weeklyFrequency: 7,
  });
  assert.equal(pool[0].aircraft.id, 'free', 'reserve must not be the default pick');
  assert.equal(pool[pool.length - 1].aircraft.id, 'res');
});

t('deployableFleetForRoute: a reserve also sorts behind a busy tail with spare hours', () => {
  const fleet = [
    { id: 'res',  typeId: TYPE, status: 'idle', reserveBase: 'JFK' },
    { id: 'busy', typeId: TYPE, status: 'assigned' },
  ];
  const existingRoutes = [{ id: 'r1', origin: 'JFK', destination: 'ORD', aircraftId: 'busy', weeklyFrequency: 4 }];
  const pool = deployableFleetForRoute({
    fleet, existingRoutes, typeId: TYPE,
    origin: 'JFK', dest: 'ORD', distKm: 1180, weeklyFrequency: 3,
  });
  assert.equal(pool[0].aircraft.id, 'busy', 'spare hours beat a standby cover');
  assert.equal(pool[1].reserve, true);
});

console.log(`\nreserve-cover-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
