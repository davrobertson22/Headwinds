// "Best aircraft for this route", ranked by the WHOLE YEAR rather than one month.
//
//   ASAS  "i like the new route planner's plane finder, although an average per
//          year feature would also be nice"  (Discord, 15 Sep 2026)
//
// The month picker (planner-season-test.mjs) prices every candidate at one
// month, and the strip beside each row shows the shape of its year. Neither
// RANKS by the year. On a lane with a real season the plane that wins the peak
// month is not always the plane that earns the most across the twelve — the big
// cabin buys its peak with a trough the small cabin never has — and the only
// way to find that out was to read five strips by eye.
//
// What is pinned here:
//
//   1. rankAircraftForYear exists and returns rows the planner's table can
//      render unchanged (same fields as rankAircraftForRoute);
//   2. its number IS the mean of the single-month ranking — the same function,
//      the same inputs, month by month — so the annual figure and the strip
//      beside it cannot part company;
//   3. dormant months are left out of the mean, not counted as zero, so a
//      summer-only route is not marked down for the schedule it asked for;
//   4. the planner offers the mode and labels the column for it.
//
//   node --import ./tools/_register-loader.mjs tools/planner-year-average-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { getSeasonalProfile } from '../src/models/demand.js';
import { currentGameDate } from '../src/utils/simulation.js';

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
const { rankAircraftForRoute, rankAircraftForYear, gameDateInMonth, ALL_MONTHS } = rec;
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

// ── Fixture — the same seasonal lane the month-picker suite uses ─────────────
const HUB = 'JFK', DEST = 'ZRH', SPOKE = 'ORD';
for (const c of [HUB, DEST, SPOKE]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const profile = getSeasonalProfile(HUB, DEST);
const PEAK   = ALL_MONTHS.reduce((a, m) => (profile[m] > profile[a] ? m : a), 1);
const TROUGH = ALL_MONTHS.reduce((a, m) => (profile[m] < profile[a] ? m : a), 1);
assert.ok(profile[PEAK] - profile[TROUGH] > 0.25, 'fixture needs a genuinely seasonal lane');

const jets = AIRCRAFT_TYPES
  .filter(t => !t.freighter && t.range >= 7000)
  .sort((a, b) => b.seats - a.seats);
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
  routes: [], cargoRoutes: [],
  awareness: 65,
};
const gameDate = currentGameDate(save);
const SPEC = {
  origin: HUB, destination: DEST, distKm: null, types: CANDIDATES,
  weeklyFrequency: 7, ticketPrice: 900, gameDate,
};

const monthRows = (month, spec = SPEC) =>
  rankAircraftForRoute(save, { ...spec, gameDate: gameDateInMonth(gameDate, month) });

console.log('\nRoute Planner — ranking the plane finder by the whole year\n');

console.log('── 0. The seam exists ───────────────────────────────────');

test('the recommender exports an annual ranking', () => {
  assert.equal(typeof rankAircraftForYear, 'function');
});

console.log('\n── 1. The annual figure is the mean of the monthly ones ──');

let year;
test('every candidate is ranked, with the fields the table renders', () => {
  year = rankAircraftForYear(save, SPEC);
  assert.equal(year.length, CANDIDATES.length, 'no candidate may go missing from the annual ranking');
  for (const r of year) {
    for (const k of ['type', 'typeId', 'owned', 'tail', 'ready', 'onReserve', 'weeklyLease', 'seats', 'weeklyFrequency', 'frequencyCapped', 'projection']) {
      assert.ok(k in r, `${r.typeId} row is missing "${k}"`);
    }
    assert.ok(r.projection, `${r.type.name} was not priced in any month`);
    assert.equal(r.projection.monthsPriced, 12, `${r.type.name} should average twelve months on a year-round route`);
    assert.equal(r.byMonth.length, 12);
    assert.deepEqual(r.flyingMonths, ALL_MONTHS);
  }
});

test('the average is exactly the mean of the single-month ranking', () => {
  for (const r of year) {
    const nets = ALL_MONTHS.map(m => monthRows(m).find(x => x.typeId === r.typeId).projection.netProfit);
    const mean = Math.round(nets.reduce((s, x) => s + x, 0) / nets.length);
    assert.equal(r.projection.netProfit, mean,
      `${r.type.name}: annual ${r.projection.netProfit} vs mean of months ${mean}`);
  }
});

test('the strip beside an annual row is the same pass, month for month', () => {
  for (const r of year) {
    for (const cell of r.byMonth) {
      const single = monthRows(cell.month).find(x => x.typeId === r.typeId).projection.netProfit;
      assert.equal(cell.netProfit, single, `${r.type.name} month ${cell.month}`);
    }
  }
});

test('the mean sits between the peak and the trough, and names them', () => {
  const top = year[0];
  assert.equal(top.best.month, PEAK);
  assert.equal(top.worst.month, TROUGH);
  assert.ok(top.projection.netProfit <= top.best.netProfit && top.projection.netProfit >= top.worst.netProfit);
  assert.ok(top.swing > 0);
});

test('rows are sorted by the average, best first', () => {
  for (let i = 1; i < year.length; i++) {
    assert.ok(year[i - 1].projection.netProfit >= year[i].projection.netProfit,
      `${year[i - 1].type.name} (${year[i - 1].projection.netProfit}) should not sit above ${year[i].type.name} (${year[i].projection.netProfit})`);
  }
});

test('it answers a different question from the peak month', () => {
  // Not "the order flips" — that depends on the catalogue — but the NUMBER
  // must: a seasonal lane's peak-month figure is not its annual average.
  const peakTop = monthRows(PEAK)[0];
  const annual  = year.find(r => r.typeId === peakTop.typeId);
  assert.notEqual(annual.projection.netProfit, peakTop.projection.netProfit,
    'the annual average of a seasonal lane must differ from its peak month');
  assert.ok(annual.projection.netProfit < peakTop.projection.netProfit,
    'the average of a year cannot beat its best month');
});

console.log('\n── 2. Dormant months are not counted as zero ────────────');

test('a summer-only route averages its summer, not its twelve months', () => {
  const WINDOW = [6, 7, 8, 9];
  const summer = rankAircraftForYear(save, { ...SPEC, season: { months: WINDOW } });
  const r = summer.find(x => x.typeId === CANDIDATES[0].id);
  assert.deepEqual(r.flyingMonths, WINDOW);
  assert.equal(r.projection.monthsPriced, WINDOW.length);
  const nets = WINDOW.map(m => monthRows(m, { ...SPEC, season: { months: WINDOW } })
    .find(x => x.typeId === r.typeId).projection.netProfit);
  const mean = Math.round(nets.reduce((s, x) => s + x, 0) / nets.length);
  assert.equal(r.projection.netProfit, mean);
  const jan = r.byMonth.find(c => c.month === 1);
  assert.equal(jan.dormant, true);
  assert.equal(jan.netProfit, null, 'a dormant month has no figure to fold into the mean');
});

console.log('\n── 3. The planner offers it ─────────────────────────────');

// Same dispatcher shim as planner-season-test.mjs: seed the initial values of
// RoutePlanner's leading useState slots so the panel a player sees renders.
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

store.set('bbae_save_v2', JSON.stringify(save));

// Slot 11 is rankMonth — the twelfth useState in RoutePlanner. Its default is
// asserted below so a slot inserted above it fails here rather than silently
// seeding the wrong piece of state.
const RANK_MONTH_SLOT = 11;
const slotsFor = (rankMonth) => {
  const slots = new Array(RANK_MONTH_SLOT + 1).fill(null);
  slots[1] = { value: HUB };
  slots[2] = { value: DEST };
  slots[3] = { value: CANDIDATES[0].id };
  if (rankMonth !== undefined) slots[RANK_MONTH_SLOT] = { value: rankMonth };
  return slots;
};
const render = (rankMonth) => renderToString(
  React.createElement(GameProvider, null,
    React.createElement(Seed, { slots: slotsFor(rankMonth) },
      React.createElement(RoutePlanner)))).replaceAll('<!-- -->', '');

const monthly = render(undefined);
test('the harness is seeding the slots it thinks it is', () => {
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, 4), ['passenger', '', '', ''],
    'RoutePlanner\'s leading useState block changed');
  assert.equal(lastSeed.seen[RANK_MONTH_SLOT], null,
    `slot ${RANK_MONTH_SLOT} should be rankMonth (default null) — the useState order above it changed`);
  assert.equal(lastSeed.seen[RANK_MONTH_SLOT - 1], false,
    `slot ${RANK_MONTH_SLOT - 1} should be showAllRecs (default false)`);
});

test('the month picker offers the whole year', () => {
  assert.ok(monthly.includes('Best aircraft for this route'), 'panel missing — seeding did not take');
  assert.ok(monthly.includes('Average over the year'), 'no way to ask for the annual ranking');
  assert.ok(monthly.includes('Net / wk') && !monthly.includes('Avg net / wk'),
    'the default view is still one month, and says so');
});

const annual = render('year');
test('asking for the year relabels the column and says what the rows are', () => {
  assert.ok(annual.includes('Best aircraft for this route'), 'panel missing in annual mode');
  assert.ok(annual.includes('Avg net / wk'), 'the Net column must say it is an average');
  assert.ok(annual.includes('average week across all twelve months'),
    'nothing on screen says the rows are averaged over the year');
});

test('the annual table is a different table, not the monthly one relabelled', () => {
  const cells = (html) => [...html.matchAll(/font-weight:600"><span style="color:var\(--(?:green|red)\)">([^<]+)<\/span>/g)].map(m => m[1]);
  const m = cells(monthly), a = cells(annual);
  assert.ok(m.length >= 2 && a.length >= 2, `expected priced Net cells in both renders (got ${m.length} / ${a.length})`);
  assert.notDeepEqual(a, m, 'the annual Net column printed this month\'s figures');
});

test('the strip stops underlining a month once no single month is on screen', () => {
  const underlined = (html) => (html.match(/border-bottom:2px solid var\(--accent\)/g) ?? []).length;
  assert.ok(underlined(monthly) > 0, 'the monthly strip should mark the month being ranked');
  assert.equal(underlined(annual), 0, 'an annual ranking has no single month to underline');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
