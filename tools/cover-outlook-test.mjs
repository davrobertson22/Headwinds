// "No cover" must mean the tick is about to leave routes on the ground.
//
// Reported on Discord (Knightmare, 2026-08-25), screenshot: two tails reading
// "Grounded (1w) · no cover — 1 route idle" with a stationed, same-type reserve
// sitting at the routes' own origin. "Im assuming this will update next week?"
//
// The badge was reading the route table: no route carrying coverForAircraftId
// meant "no cover", flagged whenever any same-type reserve existed. Both halves
// of that are wrong about how the tick works:
//
//   1. Covers are DISPATCHED BY THE TICK and breakdowns are rolled at the END
//      of one, so a tail that broke this week cannot have been covered yet.
//   2. tickPrep runs the downtime countdown BEFORE the reserve pass, so a tail
//      with one week left comes back and flies its own routes — no cover is
//      dispatched, and none is needed.
//
// coverOutlookByAircraft answers by running the real pass against the projected
// fleet. These tests hold it to the tick: whatever it predicts, ADVANCE_WEEK
// then has to do.
//
//   node --import ./tools/_register-loader.mjs tools/cover-outlook-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { coverOutlookByAircraft, advanceDowntimeOneWeek } from '../packages/engine/src/utils/simulation.js';
import { isOutOfService } from '../packages/engine/src/data/maintenance.js';
import { absoluteWeek } from '../packages/engine/src/utils/fuel.js';

let _rng = 0;
Math.random = () => 0.90 + ((_rng++ % 97) / 1000);

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const TYPE = 'crj200';
const OTHER = 'e175';
const find  = (s, id) => s.fleet.find(a => a.id === id);
const outlookFor = (s, id) => coverOutlookByAircraft({
  fleet: s.fleet, routes: s.routes, cargoRoutes: s.cargoRoutes ?? [],
  hubs: s.hubs ?? {}, absWeek: absoluteWeek(s.year, s.week),
  routeRevenues: s.financialHistory?.[s.financialHistory.length - 1]?.routeRevenues ?? {},
})[id] ?? null;

function newGame() {
  return gameReducer(freshState(), { type: 'START_GAME', airlineName: 'RSV', hub: 'JFK', enableObjectives: false });
}
function buyJet(s, typeId = TYPE) {
  const before = s.fleet.length;
  s = gameReducer({ ...s, cash: Math.max(s.cash, 500_000_000) }, { type: 'BUY_AIRCRAFT', typeId });
  if (s.fleet.length === before) throw new Error('buy failed, cash=' + s.cash);
  return { s, id: s.fleet[s.fleet.length - 1].id };
}
/** Jet A flying JFK–ORD; jet B stationed as a reserve at JFK. */
function rig({ reserveType = TYPE, reserveBase = 'JFK' } = {}) {
  let s = newGame();
  let a, b;
  ({ s, id: a } = buyJet(s));
  ({ s, id: b } = buyJet(s, reserveType));
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: a, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  if (s.routes.length === 0) throw new Error('route did not attach');
  if (reserveBase) s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: reserveBase });
  return { s, a, b };
}
/** Ground a tail by hand, the way a failure roll leaves it at the end of a tick. */
const ground = (s, id, weeks) => ({
  ...s,
  fleet: s.fleet.map(x => x.id === id ? { ...x, status: 'grounded', groundedWeeksLeft: weeks } : x),
});

console.log('\n── The countdown runs before the reserve pass ───────────');

test('a tail on its LAST week of downtime is returning, not uncovered', () => {
  let { s, a } = rig();
  s = ground(s, a, 1);
  const ol = outlookFor(s, a);
  assert.ok(ol, 'an out-of-service tail with routes should have an outlook');
  assert.equal(ol.returning, true, 'one week left means it flies again next week');
  assert.equal(ol.coversNext, 0, 'nothing to cover — it takes its own routes back');
  assert.equal(ol.reason, null, 'that is not a cover gap');
});

test('and the tick agrees: it comes back and flies its own routes', () => {
  let { s, a, b } = rig();
  s = ground(s, a, 1);
  const ol   = outlookFor(s, a);
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(isOutOfService(find(next, a)), false, 'the countdown should have returned it');
  assert.equal(ol.returning, !isOutOfService(find(next, a)));
  assert.equal(next.routes[0].aircraftId, a, 'the route stayed with its own tail');
  assert.equal(next.routes[0].coverForAircraftId ?? null, null, 'no cover was dispatched');
});

test('advanceDowntimeOneWeek matches what the tick does to the tail', () => {
  for (const weeks of [1, 2, 3]) {
    let { s, a } = rig();
    s = ground(s, a, weeks);
    const predicted = advanceDowntimeOneWeek(find(s, a), true);
    const actual    = find(gameReducer(s, { type: 'ADVANCE_WEEK' }), a);
    assert.equal(isOutOfService(predicted), isOutOfService(actual),
      `${weeks}w grounding: predicted out-of-service ${isOutOfService(predicted)}, tick says ${isOutOfService(actual)}`);
  }
});

console.log('\n── A cover that is coming is not "no cover" ─────────────');

test('two weeks down with a matching reserve reads as a cover starting next week', () => {
  let { s, a, b } = rig();
  s = ground(s, a, 2);
  const ol = outlookFor(s, a);
  assert.equal(ol.returning, false);
  assert.equal(ol.coveredNow, 0, 'nothing is covered yet — the tick has not run');
  assert.equal(ol.coversNext, 1, 'the reserve should be predicted onto the route');
  assert.deepEqual(ol.reserves, [find(s, b).name]);
  assert.equal(ol.reason, null);
});

test('and the tick agrees: the reserve is on the route next week', () => {
  let { s, a, b } = rig();
  s = ground(s, a, 2);
  const ol   = outlookFor(s, a);
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const covered = next.routes.filter(r => r.coverForAircraftId === a);
  assert.equal(covered.length, ol.coversNext, 'prediction and tick disagree on covered routes');
  assert.equal(covered[0].aircraftId, b, 'the predicted reserve is the one that flew');
});

test('a cover already flying is still reported as flying', () => {
  let { s, a } = rig();
  s = ground(s, a, 3);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });          // cover dispatched here
  const ol = outlookFor(s, a);
  assert.equal(ol.coveredNow, 1);
  assert.equal(ol.ownRoutes, 0);
  assert.equal(ol.reason, null);
});

console.log('\n── A real gap still reads as a gap, with a reason ───────');

test('no reserve stationed at all → no-reserve', () => {
  let { s, a } = rig({ reserveBase: null });
  s = ground(s, a, 3);
  const ol = outlookFor(s, a);
  assert.equal(ol.coversNext, 0);
  assert.equal(ol.reason, 'no-reserve');
  assert.equal(ol.ownRoutes, 1);
});

test('a reserve of the wrong type is not a cover', () => {
  let { s, a } = rig({ reserveType: OTHER });
  s = ground(s, a, 3);
  const ol = outlookFor(s, a);
  assert.equal(ol.coversNext, 0);
  assert.equal(ol.reason, 'no-reserve');
});

test('a reserve whose base the routes never touch is not a cover', () => {
  let { s, a, b } = rig();
  // Move the reserve to a second hub that the JFK–ORD route does not touch.
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'MIA' });
  s = { ...s, hubs: { ...s.hubs, MIA: { tier: 0 } } };
  s = gameReducer(s, { type: 'CLEAR_RESERVE', aircraftId: b });
  s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'MIA' });
  assert.equal(find(s, b).reserveBase, 'MIA', 'reserve should have moved');
  s = ground(s, a, 3);
  const ol = outlookFor(s, a);
  assert.equal(ol.coversNext, 0);
  assert.equal(ol.reason, 'no-reserve');
});

console.log('\n── What the fleet row actually prints ──────────────────');

const { GameProvider } = await import('../src/store/GameContext.jsx');
const Fleet = (await import('../src/components/Fleet.jsx')).default;
const renderFleet = (s) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Fleet)))
    .replace(/<!-- -->/g, '');
};

test('a tail on its last week is not accused of having no cover', () => {
  let { s, a } = rig();
  s = ground(s, a, 1);
  const html = renderFleet(s);
  assert.ok(!html.includes('no cover'), 'the row still cries "no cover" on the last week of downtime');
  assert.ok(html.includes('back in service next week'), 'the row should say it is coming back');
});

test('a tail that a reserve is about to cover says so', () => {
  let { s, a, b } = rig();
  s = ground(s, a, 2);
  const html = renderFleet(s);
  assert.ok(!html.includes('no cover'), '"no cover" printed while a cover is queued for next week');
  assert.ok(html.includes('cover starts next week'), 'the row should name the incoming cover');
  assert.ok(html.includes(find(s, b).name), 'and name the reserve flying it');
});

test('a genuine gap still warns, and says why', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'MIA' });
  s = { ...s, hubs: { ...s.hubs, MIA: { tier: 0 } } };
  s = gameReducer(s, { type: 'CLEAR_RESERVE', aircraftId: b });
  s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'MIA' });
  s = ground(s, a, 3);
  const html = renderFleet(s);
  assert.ok(html.includes('no cover'), 'a real gap should still be flagged');
  assert.ok(html.includes('none in range'), 'and should say why it is a gap');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
