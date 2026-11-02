// A tail that only flies May–Oct is idle Nov–Apr, and the engine lets a
// counter-seasonal route take those months. The Route Planner said otherwise.
//
//   JackG207174  "If I have an aircraft that only operates May-Oct, how do I
//                 schedule flights on it Nov-Apr? Its saying it doesnt have the
//                 hours to operate for the months outside of it even though its
//                 dormant"  (Discord, 2 Nov 2026)
//
// ADD_ROUTE has measured block hours per month since seasonal routes shipped
// (blockHourFit with the new route's months). The pickers did not:
// deployableFleetForRoute summed every committed route whether or not it flies
// in the months asked about, so a tail full in summer read as full all year and
// the planner said "at full utilisation — lease another" about a plane the
// engine would have accepted. The Add Flights picker filtered on the year-round
// peak, which drops the same tail once its summer is completely booked.
//
//   node --import ./tools/_register-loader.mjs tools/seasonal-aircraft-picker-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import {
  deployableFleetForRoute, routeDistanceKm, routeBlockHours, maxWeeklyBlockHoursFor,
  ALL_MONTHS,
} from '../src/utils/simulation.js';

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
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { addRouteBlockReason } = await import('../packages/engine/src/reducer.mjs');
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

// ── Fixture ───────────────────────────────────────────────────────────────────
const TYPE = ['a320neo', 'a320', 'b738'].find(id => getAircraftType(id) && !getAircraftType(id).freighter);
assert.ok(TYPE, 'no narrowbody passenger type in the data');
const T = getAircraftType(TYPE);
const HUB = 'LAX', SUMMER_DEST = 'SFO', WINTER_DEST = 'PHX';
const SUMMER = [5, 6, 7, 8, 9, 10];
const WINTER = [11, 12, 1, 2, 3, 4];

const base = freshState();
const tail = { id: 'A1', typeId: TYPE, name: 'A1', tailNumber: 'N1JG', status: 'assigned',
  ageWeeks: 52, ownershipType: 'owned', config: { economy: T.seats } };
const summerRoute = { id: 'r1', origin: HUB, destination: SUMMER_DEST, aircraftId: 'A1',
  weeklyFrequency: 1, ticketPrice: 150, weeksOpen: 30, season: { months: SUMMER } };

const save = {
  ...base,
  phase: 'playing', week: 20, year: 2, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 12, [SUMMER_DEST]: 8, [WINTER_DEST]: 8 },
  fleet: [tail],
  routes: [summerRoute],
  cargoRoutes: [],
  awareness: 65,
};
const CAP = maxWeeklyBlockHoursFor(save);
// Book the summer as full as whole frequencies allow — under the cap, so the
// fixture is a schedule the guards themselves would have built.
summerRoute.weeklyFrequency = Math.floor(CAP / routeBlockHours(summerRoute, T, 1));
const summerHrs = routeBlockHours(summerRoute, T, summerRoute.weeklyFrequency);
const FREQ = 7;
const winterKm = routeDistanceKm(HUB, WINTER_DEST);

const pool = (months, routes = save.routes) => deployableFleetForRoute({
  fleet: save.fleet, existingRoutes: routes, cargoRoutes: [], typeId: TYPE,
  origin: HUB, dest: WINTER_DEST, distKm: winterKm, weeklyFrequency: FREQ, capHours: CAP, months,
});
const guard = (season, st = save) => addRouteBlockReason(st, {
  type: 'ADD_ROUTE', origin: HUB, destination: WINTER_DEST, aircraftId: 'A1',
  weeklyFrequency: FREQ, ticketPrice: 150, season,
});

console.log(`\nSeasonal tail — ${TYPE}, ${HUB}–${SUMMER_DEST} ${summerRoute.weeklyFrequency}×/wk May–Oct (${summerHrs.toFixed(1)} of ${CAP}h)\n`);

console.log('── 1. The engine already allows it ──────────────────────');

test('ADD_ROUTE accepts a Nov–Apr route on the summer tail', () => {
  assert.equal(guard({ months: WINTER }), null);
});
test('…and refuses the same route year-round (the summer is full)', () => {
  assert.match(guard(null) ?? '', /no spare flying hours/);
});

console.log('\n── 2. The picker agrees with it ─────────────────────────');

test('deployableFleetForRoute: a Nov–Apr ask finds the summer tail eligible', () => {
  const [d] = pool(WINTER);
  assert.ok(d, 'tail missing from the pool');
  assert.equal(d.usedBlockHrs, 0, `charged ${d.usedBlockHrs.toFixed(1)}h for months the tail is dormant`);
  assert.equal(d.hoursOk, true);
  assert.equal(d.eligible, true);
});
test('deployableFleetForRoute: a year-round ask still finds it full', () => {
  const [d] = pool(ALL_MONTHS);
  assert.equal(d.hoursOk, false);
  assert.ok(Math.abs(d.usedBlockHrs - summerHrs) < 1e-6);
});
test('deployableFleetForRoute: counter-seasonal halves are a PEAK, not a sum', () => {
  // 70h in summer + 70h in winter is 70h in any month. Summing them called the
  // tail full against a year-round route the engine accepts.
  const half = Math.floor(summerRoute.weeklyFrequency / 2);
  const routes = [
    { ...summerRoute, weeklyFrequency: half },
    { ...summerRoute, id: 'r2', season: { months: WINTER }, weeklyFrequency: half },
  ];
  const st = { ...save, routes };
  assert.equal(guard(null, st), null, 'fixture: the engine should accept this year-round');
  const [d] = pool(ALL_MONTHS, routes);
  assert.equal(d.eligible, true, `picker charged ${d.usedBlockHrs.toFixed(1)}h`);
});
test('deployableFleetForRoute: no months → the old whole-schedule reading (cargo guard)', () => {
  const [d] = deployableFleetForRoute({
    fleet: save.fleet, existingRoutes: save.routes, typeId: TYPE,
    origin: HUB, dest: WINTER_DEST, distKm: winterKm, weeklyFrequency: FREQ, capHours: CAP,
  });
  assert.ok(Math.abs(d.usedBlockHrs - summerHrs) < 1e-6);
});

console.log('\n── 3. The Route Planner offers the tail ─────────────────');

// Same slot-seeding harness as tools/planner-season-test.mjs: RoutePlanner keeps
// its inputs in local useState, so seed the leading slots to render the panel a
// player sees after picking the lane, the type and the Nov–Apr window.
const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
assert.ok(RCD, 'React 18 hook dispatcher not reachable — this harness needs updating');
let seed = null, lastSeed = null;
let rawDispatcher = RCD.current, liveDispatcher = null;
function wrapDispatcher(d) {
  if (!d) return d;
  const w = Object.create(Object.getPrototypeOf(d));
  Object.assign(w, d);
  w.useState = function (initial) {
    if (seed) {
      const i = seed.i++;
      if (i < seed.slots.length) {
        seed.seen[i] = typeof initial === 'function' ? initial() : initial;
        const slot = seed.slots[i];
        if (slot) return d.useState(slot.value);
      }
      if (seed.i >= seed.slots.length) seed = null;
    }
    return d.useState(initial);
  };
  return w;
}
Object.defineProperty(RCD, 'current', {
  configurable: true,
  get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;
function Seed({ slots, children }) {
  seed = { i: 0, slots, seen: [] };
  lastSeed = seed;
  return children;
}

const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId', 'frequency', 'fares', 'cateringLevel', 'season'];
const render = (season) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots: [null, { value: HUB }, { value: WINTER_DEST }, { value: TYPE },
        { value: FREQ }, null, null, { value: season }] },
        React.createElement(RoutePlanner)))).replaceAll('<!-- -->', '');
};

const winterHtml = render({ months: WINTER });
test('the harness is seeding the slots it thinks it is', () => {
  assert.ok(lastSeed, 'seed wrapper never ran');
  const seen = lastSeed.seen;
  assert.equal(seen[0], 'passenger');
  assert.equal(seen[1], '');
  assert.equal(seen[2], '');
  assert.equal(seen[4], 7, `slot 4 should be frequency — saw ${JSON.stringify(seen[4])} (${SLOT_NAMES})`);
  assert.equal(seen[7], null, `slot 7 should be season — saw ${JSON.stringify(seen[7])} (${SLOT_NAMES})`);
});
test('Nov–Apr: the planner offers to open it on the summer tail', () => {
  assert.ok(!winterHtml.includes('at full utilisation'),
    'the planner still calls the summer tail full for a Nov–Apr route');
  assert.ok(winterHtml.includes('Open Route with N1JG'), 'no Open Route button for the summer tail');
});
const yearHtml = render(null);
test('year-round: no Open Route — the summer really is full', () => {
  assert.ok(!yearHtml.includes('Open Route with N1JG'));
});
test('year-round: the refusal names the months the tail IS free, not "lease another"', () => {
  assert.ok(yearHtml.includes('has the hours for this route in Nov–Apr'),
    'the planner should point at the operating window when the tail is only full part of the year');
  assert.ok(!yearHtml.includes('at full utilisation'));
});

console.log('\n── 4. Month runs read as a player says them ─────────────');
const { monthRunsLabel } = await import('../src/components/RoutePlanner.jsx');
test('monthRunsLabel wraps the year and splits gaps', () => {
  assert.equal(monthRunsLabel(WINTER), 'Nov–Apr');
  assert.equal(monthRunsLabel(SUMMER), 'May–Oct');
  assert.equal(monthRunsLabel([1, 2, 6]), 'Jan–Feb, Jun');
  assert.equal(monthRunsLabel([12]), 'Dec');
  assert.equal(monthRunsLabel(ALL_MONTHS), 'all year');
  assert.equal(monthRunsLabel([]), '');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
