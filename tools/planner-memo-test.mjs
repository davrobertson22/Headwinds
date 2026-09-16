// The Route Planner's projections remember the network tick per state (see
// memoNetworkTick in models/pairShare.js). A memo that changed an answer would
// be a bug wearing a speed-up's clothes, so this suite asks the same question
// warm and cold and insists on identical numbers — and checks that a NEW state
// (a route added) is not answered from the old one's cache.
//
//   node --import ./tools/_register-loader.mjs tools/planner-memo-test.mjs

import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem:k=>store.get(k)??null, setItem:(k,v)=>store.set(k,String(v)), removeItem:k=>store.delete(k), clear:()=>store.clear() };

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const { AIRCRAFT_TYPES } = await import('../packages/engine/src/data/aircraft.js');
const { rankAircraftForRoute } = await import('../packages/engine/src/models/aircraftRecommender.js');
const { projectRouteAddition } = await import('../packages/engine/src/models/pairShare.js');
const { routeDistanceKm, effectiveRangeKm, currentGameDate } = await import('../packages/engine/src/utils/simulation.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// A hub-and-spoke network big enough for connections to matter.
let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Memo Air', hub: 'LGW' });
s = { ...s, cash: 5e11 };
let opened = 0;
for (const d of AIRPORTS.map(a => a.code).filter(c => c !== 'LGW' && c !== 'JFK')) {
  const before = s.fleet.length;
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'a320ceo' });
  if (s.fleet.length === before) continue;
  const ac = s.fleet[s.fleet.length - 1];
  s = { ...s, cash: 5e11, gates: { ...s.gates, LGW: 200, [d]: 8 } };
  const rb = s.routes.length;
  s = gameReducer(s, { type: 'ADD_ROUTE', origin: 'LGW', destination: d, aircraftId: ac.id, weeklyFrequency: 7 });
  if (s.routes.length > rb) opened++;
  if (opened >= 40) break;
}
assert.ok(opened >= 40, `fixture: only ${opened} routes opened`);

const origin = 'LGW', destination = 'JFK';
const distKm = routeDistanceKm(origin, destination);
const gameDate = currentGameDate(s);
const types = AIRCRAFT_TYPES.filter(t => !t.freighter && effectiveRangeKm({ typeId: t.id }, t) >= distKm).slice(0, 12);
const spec = { origin, destination, distKm, types, weeklyFrequency: 7, ticketPrice: 300, gameDate };

// Strip the type objects (shared references) so deepEqual compares numbers.
const flat = (rows) => rows.map(r => ({ ...r, type: r.type?.id, tail: r.tail?.id }));

console.log('\n── The memo changes no answer ───────────────────────────');

test('a warm ranking equals a cold one on a state the cache has never seen', () => {
  const warm1 = rankAircraftForRoute(s, spec);
  const warm2 = rankAircraftForRoute(s, spec);            // served from the memo
  const cold  = rankAircraftForRoute({ ...s }, spec);     // new identity → recomputed
  assert.deepEqual(flat(warm2), flat(warm1));
  assert.deepEqual(flat(cold),  flat(warm1));
});

test('every month of the year is the same warm and cold', () => {
  // Headwinds has no seasonal strip yet; this is the shape of its query — the
  // same lane at every calendar month — so the port carries the same guarantee.
  const ac = { id: 'p', typeId: 'a320ceo', ageWeeks: 0 };
  for (let m = 1; m <= 12; m++) {
    const gd = { ...gameDate, month: m };
    const warm1 = projectRouteAddition(s, { origin, destination, aircraft: ac, weeklyFrequency: 7, ticketPrice: 300, gameDate: gd });
    const warm2 = projectRouteAddition(s, { origin, destination, aircraft: ac, weeklyFrequency: 7, ticketPrice: 300, gameDate: gd });
    const cold  = projectRouteAddition({ ...s }, { origin, destination, aircraft: ac, weeklyFrequency: 7, ticketPrice: 300, gameDate: gd });
    assert.deepEqual(warm2, warm1, `month ${m}: warm vs warm`);
    assert.deepEqual(cold,  warm1, `month ${m}: cold vs warm`);
  }
});

test('a different fare or frequency is a different question, not a cache hit', () => {
  const a = projectRouteAddition(s, { origin, destination, aircraft: { id: 'p', typeId: 'a320ceo', ageWeeks: 0 }, weeklyFrequency: 7, ticketPrice: 300, gameDate });
  const b = projectRouteAddition(s, { origin, destination, aircraft: { id: 'p', typeId: 'a320ceo', ageWeeks: 0 }, weeklyFrequency: 3, ticketPrice: 300, gameDate });
  const c = projectRouteAddition(s, { origin, destination, aircraft: { id: 'p', typeId: 'a320ceo', ageWeeks: 0 }, weeklyFrequency: 7, ticketPrice: 900, gameDate });
  assert.notDeepEqual(a.connecting, b.connecting, 'frequency feeds the network tick');
  assert.notEqual(a.mature.revenue, c.mature.revenue, 'fare moves the forecast');
});

test('a new state (one more route) is not answered from the old state\'s cache', () => {
  const before = projectRouteAddition(s, { origin, destination, aircraft: { id: 'p', typeId: 'a320ceo', ageWeeks: 0 }, weeklyFrequency: 7, ticketPrice: 300, gameDate });
  // One more spoke at the hub, so the LGW–JFK probe has one more market to feed.
  let s2 = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'a320ceo' });
  const ac = s2.fleet[s2.fleet.length - 1];
  const spoke = AIRPORTS.map(a => a.code).find(c => c !== 'LGW' && c !== 'JFK' && !s.routes.some(r => r.origin === c || r.destination === c) && routeDistanceKm('LGW', c) > 500 && routeDistanceKm('LGW', c) < 3000);
  s2 = { ...s2, cash: 5e11, gates: { ...s2.gates, [spoke]: 8, LGW: 200 } };
  s2 = gameReducer(s2, { type: 'ADD_ROUTE', origin: 'LGW', destination: spoke, aircraftId: ac.id, weeklyFrequency: 7 });
  assert.ok(s2.routes.length === s.routes.length + 1, `fixture: LGW–${spoke} did not open`);
  const after = projectRouteAddition(s2, { origin, destination, aircraft: { id: 'p', typeId: 'a320ceo', ageWeeks: 0 }, weeklyFrequency: 7, ticketPrice: 300, gameDate });
  const cold  = projectRouteAddition({ ...s2 }, { origin, destination, aircraft: { id: 'p', typeId: 'a320ceo', ageWeeks: 0 }, weeklyFrequency: 7, ticketPrice: 300, gameDate });
  assert.deepEqual(after, cold, 'the new state must be computed fresh — a cached tick from the old one would differ from a cold run');
  assert.ok(before, 'fixture: the old state still projects');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
