// Code-F stands — demand model v4 worlds (docs/game-audit-2026-11-06.md R3).
//
//   node tools/code-f-stands-test.mjs
//
// An A380 or a 747-8I spans more than 65 m and needs a code-F stand; only the
// big international gateways have them. Before v4 the A380 could fly Boise–Salt
// Lake on any 9,800 ft runway. New worlds only: v3 worlds keep every route.
import assert from 'node:assert/strict';
import { gameReducer, freshState, addRouteBlockReason } from '../packages/engine/src/reducer.mjs';
import { setDemandModel } from '../packages/engine/src/utils/market.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import fs from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

function airline(model, hub = 'JFK') {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'F', hub, enableObjectives: false });
  s = { ...s, cash: 5e9, newWorldRestrictions: true, ...(model ? { demandModel: model } : {}) };
  return s;
}
function openWith(s, typeId, o, d, freq = 3) {
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId });
  const ac = s.fleet[s.fleet.length - 1];
  for (const c of [o, d]) s = gameReducer(s, { type: 'ADD_GATE', airportCode: c });
  const before = s.routes.length;
  const next = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac.id, origin: o, destination: d, weeklyFrequency: freq });
  return { opened: next.routes.length > before, next, ac };
}

console.log('\nCode-F stands\n');

test('v4: an A380 cannot open a route to an airport without a code-F stand', () => {
  const { opened, next, ac } = openWith(airline(4, 'BOI'), 'a380', 'BOI', 'SLC');
  assert.equal(opened, false, 'BOI–SLC A380 opened in a v4 world');
  const why = addRouteBlockReason(next, { type: 'ADD_ROUTE', aircraftId: ac.id, origin: 'BOI', destination: 'SLC', weeklyFrequency: 3 });
  assert.match(String(why ?? ''), /code-F/, `block reason: ${why}`);
});

test('v4: an A380 still flies between gateways (JFK–LHR)', () => {
  const { opened, next } = openWith(airline(4), 'a380', 'JFK', 'LHR');
  assert.equal(opened, true, `JFK–LHR A380 refused: ${next.error ?? ''}`);
});

test('v4: the restriction says why, in the words the planner shows', () => {
  setDemandModel(4);
  const hit = checkRouteRestrictions('BOI', 'SLC', 470, 3, 'Double Deck', { routes: [], aircraftType: getAircraftType('a380') });
  setDemandModel(1);
  assert.ok(hit, 'no restriction returned');
  assert.equal(hit.restriction.type, 'code_f_stand');
  assert.match(hit.reason, /code-F/);
});

test('v4: a 747-400 (code E) and a 777-300ER are unaffected', () => {
  for (const t of ['b747400', 'b777300er']) {
    const { opened, next } = openWith(airline(4, 'BOI'), t, 'BOI', 'SLC');
    assert.equal(opened, true, `${t} refused on BOI–SLC: ${next.error ?? ''}`);
  }
});

test('v3 and classic worlds keep the old rule: runway only', () => {
  for (const model of [3, null]) {
    const { opened, next } = openWith(airline(model, 'BOI'), 'a380', 'BOI', 'SLC');
    assert.equal(opened, true, `v${model ?? 1} refused an A380 on BOI–SLC: ${next.error ?? ''}`);
  }
});

test('v4: moving an A380 onto a non-gateway route is refused', () => {
  let s = airline(4, 'BOI');
  const r = openWith(s, 'b737800', 'BOI', 'SLC', 7);
  assert.ok(r.opened);
  s = gameReducer(r.next, { type: 'BUY_AIRCRAFT', typeId: 'a380' });
  const big = s.fleet[s.fleet.length - 1];
  const route = s.routes[s.routes.length - 1];
  const moved = gameReducer(s, { type: 'REASSIGN_ROUTE', routeId: route.id, toAircraftId: big.id });
  assert.equal(moved.routes.find(x => x.id === route.id).aircraftId, route.aircraftId, 'the A380 took the BOI–SLC route');
});

test('the route planners leave superjumbos out where they cannot park', () => {
  for (const f of ['../src/components/RoutePlanner.jsx', '../src/components/TagRoutePlanner.jsx']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(/standShortfall\(/.test(src), `${f} does not consult standShortfall`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
