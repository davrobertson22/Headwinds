// "Best aircraft for this route", asked about a month other than this one.
//
//   ASAS  "for the best plane finder for each route, you should make it so we
//          can customize which season the planner is looking at"  (Discord, 13 Sep 2026)
//
// The recommender has always priced every candidate at the CURRENT calendar
// month — buildRouteMarket multiplies the pool by getSeasonalProfile[month], so
// a ranking run in February on a ski lane and the same ranking run in June are
// different questions with different answers. The planner never let the player
// ask the second one, and never said which one it was answering.
//
// Two things are proven here, and they are not the same thing:
//
//   1. asking about a month actually moves the ranking (gameDateInMonth), and
//      moves ONLY the season — absWeek stays put, so the answer is "this plane
//      in August", not "this plane after four more months of demand growth";
//   2. the seasonal shape of a candidate is derivable in one pass
//      (seasonalProfitByType), which is what turns "best in August" into "wins
//      the peak, strands you in the trough" — the part a dropdown alone hides.
//
//   node --import ./tools/_register-loader.mjs tools/planner-season-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { getSeasonalProfile } from '../src/models/demand.js';
import { currentGameDate } from '../src/utils/simulation.js';

// Minimal browser shims for SSR (effects don't run; init reads localStorage).
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
const rec = await import('../src/models/aircraftRecommender.js');
const { rankAircraftForRoute, gameDateInMonth, seasonalProfitByType, ALL_MONTHS } = rec;
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

// ── Fixture ───────────────────────────────────────────────────────────────────
// A transatlantic lane into an Alpine country: ZRH carries the `ski` seasonal
// archetype, so the pair profile swings hard between its peak and its trough.
// Peak and trough are READ from the engine's own profile rather than hard-coded,
// so re-authoring the curve re-points this suite instead of breaking it.

const HUB = 'JFK', DEST = 'ZRH', SPOKE = 'ORD';
for (const c of [HUB, DEST, SPOKE]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const profile = getSeasonalProfile(HUB, DEST);
const months  = Array.from({ length: 12 }, (_, i) => i + 1);
const PEAK   = months.reduce((a, m) => (profile[m] > profile[a] ? m : a), 1);
const TROUGH = months.reduce((a, m) => (profile[m] < profile[a] ? m : a), 1);
assert.ok(profile[PEAK] - profile[TROUGH] > 0.25,
  `fixture needs a genuinely seasonal lane — ${HUB}-${DEST} swings only ${(profile[PEAK] - profile[TROUGH]).toFixed(2)}`);

const jets = AIRCRAFT_TYPES
  .filter(t => !t.freighter && t.range >= 7000)
  .sort((a, b) => b.seats - a.seats);
assert.ok(jets.length >= 2, 'need two long-range passenger types in the data');
const CANDIDATES = jets.slice(0, 6);

const tail = (id, typeId) => ({
  id, typeId, name: id, tailNumber: `N${id}`,
  status: 'idle', ageWeeks: 52, ownershipType: 'owned',
  config: { economy: AIRCRAFT_TYPES.find(t => t.id === typeId).seats },
});

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 12, [DEST]: 8, [SPOKE]: 8 },
  fleet: CANDIDATES.map((t, i) => tail(`ac${i}`, t.id)),
  routes: [],
  cargoRoutes: [],
  awareness: 65,
};

const gameDate = currentGameDate(save);
const SPEC = {
  origin: HUB,
  destination: DEST,
  distKm: null,
  types: CANDIDATES,
  weeklyFrequency: 7,
  ticketPrice: 900,
  gameDate,
};

const netAt = (month) => {
  const rows = rankAircraftForRoute(save, { ...SPEC, gameDate: gameDateInMonth(gameDate, month) });
  const top = rows.find(r => r.projection);
  assert.ok(top, `nothing priced on ${HUB}-${DEST} in month ${month}`);
  return { typeId: top.typeId, net: top.projection.netProfit };
};

console.log('\nRoute Planner — asking the recommender about another season\n');

console.log('── 0. The seam exists ───────────────────────────────────');

test('the recommender exports a month override and a seasonal pass', () => {
  assert.equal(typeof gameDateInMonth, 'function');
  assert.equal(typeof seasonalProfitByType, 'function');
  assert.deepEqual(ALL_MONTHS, months);
});

console.log('\n── 1. The override moves the season and nothing else ─────');

test('gameDateInMonth replaces the month', () => {
  assert.equal(gameDateInMonth(gameDate, PEAK).month, PEAK);
});

test('it leaves absWeek alone — season is not time travel', () => {
  // absWeek drives pairDemandGrowth. Advancing it to "get to August" would fold
  // months of world demand growth into what is supposed to be a seasonal
  // comparison, and every month ahead of today would look better than it is.
  const moved = gameDateInMonth(gameDate, PEAK);
  assert.equal(moved.absWeek, gameDate.absWeek);
  assert.equal(moved.week, gameDate.week);
});

test('it does not mutate the calendar it was handed', () => {
  const before = gameDate.month;
  gameDateInMonth(gameDate, PEAK === 1 ? 7 : 1);
  assert.equal(gameDate.month, before);
});

console.log('\n── 2. The ranking actually answers the question ─────────');

test(`the same lane earns more at its peak (month ${PEAK}) than its trough (month ${TROUGH})`, () => {
  const peak = netAt(PEAK), trough = netAt(TROUGH);
  assert.ok(peak.net > trough.net,
    `expected month ${PEAK} to beat month ${TROUGH}, got ${peak.net} vs ${trough.net}`);
});

console.log('\n── 3. The whole year in one pass ────────────────────────');

let year;
test('seasonalProfitByType prices every month for every candidate', () => {
  year = seasonalProfitByType(save, SPEC);
  assert.deepEqual(year.months, months);
  for (const t of CANDIDATES) {
    const row = year.byType.get(t.id);
    assert.ok(row, `${t.name} missing from the seasonal pass`);
    assert.equal(row.byMonth.length, 12, `${t.name} should carry 12 cells`);
  }
});

test('its per-month figures are the ranking run at that month', () => {
  // The strip and the table must not be able to disagree: same function, same
  // inputs, same number.
  const top = netAt(PEAK);
  const cell = year.byType.get(top.typeId).byMonth.find(c => c.month === PEAK);
  assert.equal(cell.netProfit, top.net);
});

test('it names the best and worst month of each candidate', () => {
  const row = year.byType.get(netAt(PEAK).typeId);
  assert.equal(row.best.month, PEAK);
  assert.equal(row.worst.month, TROUGH);
  assert.ok(row.swing > 0, 'a seasonal lane has a swing');
});

test('months outside an operating window are marked dormant, not quoted', () => {
  // A summer-only route does not lose money in January; it does not fly. A
  // ranking that prints a January loss for it is describing a route the player
  // did not ask for.
  const summer = seasonalProfitByType(save, { ...SPEC, season: { months: [6, 7, 8, 9] } });
  const row = summer.byType.get(CANDIDATES[0].id);
  const jan = row.byMonth.find(c => c.month === 1);
  const jul = row.byMonth.find(c => c.month === 7);
  assert.equal(jan.dormant, true, 'January is outside a Jun–Sep window');
  assert.equal(jan.netProfit, null, 'a dormant month has no profit to quote');
  assert.equal(jul.dormant, false);
  assert.ok(jul.netProfit != null, 'an in-window month is still priced');
  assert.ok([6, 7, 8, 9].includes(row.best.month),
    'best month must come from the months the route actually flies');
});

console.log('\n── 4. The planner offers it ─────────────────────────────');

// RoutePlanner keeps origin/dest/type in local state and renderToString fires no
// onChange, so the only way to render the panel a player sees is to substitute
// the initial values of its leading useState slots. Same dispatcher wrapper as
// tools/route-planner-render-test.mjs, and it asserts the slot order too, so
// re-ordering that state block fails loudly here rather than silently rendering
// the empty-route path.
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

const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId'];
const EXPECTED_INITIALS = ['passenger', '', '', ''];

store.set('bbae_save_v2', JSON.stringify(save));
const html = renderToString(
  React.createElement(GameProvider, null,
    React.createElement(Seed, { slots: [null, { value: HUB }, { value: DEST }, { value: CANDIDATES[0].id }] },
      React.createElement(RoutePlanner)))).replaceAll('<!-- -->', '');

test('the harness is seeding the slots it thinks it is', () => {
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, SLOT_NAMES.length), EXPECTED_INITIALS,
    `RoutePlanner's leading useState block changed — expected [${SLOT_NAMES}] to start as ` +
    `${JSON.stringify(EXPECTED_INITIALS)} but saw ${JSON.stringify(lastSeed.seen.slice(0, 4))}.`);
});

test('the recommendation panel rendered at all', () => {
  assert.ok(html.includes('Best aircraft for this route'),
    'the panel is missing — seeding did not take, and the assertions below would be vacuous');
});

test('the panel says which month it is ranking for, and lets you change it', () => {
  assert.ok(html.includes('Ranked for'),
    'nothing on screen says which season these numbers describe');
  for (const label of ['January', 'July', 'December']) {
    assert.ok(html.includes(label), `month ${label} should be selectable`);
  }
});

test('the default is the calendar the player is actually in', () => {
  assert.ok(/This month/.test(html),
    'the default option should read as "now", not as a bare month name');
});

test('each candidate carries its profit across the year', () => {
  assert.ok(html.includes('Profit by month'),
    'no seasonal strip — the dropdown alone still hides the plane that only wins in August');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
