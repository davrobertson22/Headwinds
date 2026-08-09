// Fleet utilisation: the UTIL. column must agree with the tick, and the
// block-hour cap must hold on every path that can attach a route to a tail.
//
// Reported by a player whose Fleet list, sorted by UTIL. descending, showed
// eight airframes ABOVE the 140h/wk cap — the top one at 278h, which is more
// hours than a week has room for once turnarounds are counted. Two distinct
// defects were behind it:
//
//   1. DISPLAY. Fleet.jsx summed the tail's WHOLE-YEAR schedule — every route,
//      whether or not it operates this month — using the direct O&D distance,
//      and compared that total to a per-WEEK cap. The engine enforces the cap
//      as a per-MONTH PEAK (reducer.mjs), precisely so a summer route and a
//      winter route that never overlap can share one airframe. So a legal tail
//      flying 138h in its busiest month rendered as 264h, and the bar — a bare
//      Math.min(100, pct) — saturated, making 145h and 278h look identical.
//
//   2. ENGINE. Every "hours already committed to this tail" calculation looked
//      only at routes whose aircraftId IS the tail. A route temporarily covered
//      by a reserve has aircraftId pointing at the RESERVE (coverForAircraftId
//      remembers the original), so an out-of-service tail read as EMPTY: the
//      Routes-tab picker offered it as a free airframe and the reducer accepted
//      a second full 140h load. When the cover ended the routes came home and
//      the tail flew 271h/wk — for ever, because the tick never re-checks.
//
// The display half SSR-renders the real Fleet component and reads the hours
// back OUT of the markup; the expected value is computed with the engine's own
// routeBlockHours + isRouteActive — the pair the weekly tick charges
// maintenance from (reducer.mjs, "Heavy-maintenance: block-hours flown this
// week"). Recomputing with the component's own expression would pass vacuously.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-utilisation-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { AIRPORTS } from '../src/data/airports.js';
import {
  routeDistanceKm, routeBlockHours, isRouteActive, maxFrequency,
  MAX_WEEKLY_BLOCK_HOURS, applyReserveCovers, weekToGameDate,
} from '../src/utils/simulation.js';

// Minimal browser shims for SSR (effects don't run, but init reads localStorage).
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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { gameReducer } = await import('../packages/engine/src/reducer.mjs');
const Fleet = (await import('../src/components/Fleet.jsx')).default;

// ── The world ────────────────────────────────────────────────────────────────
const JET = AIRCRAFT_TYPES.filter(t => !t.freighter && (t.range ?? 0) > 9000)
  .sort((a, b) => (b.range ?? 0) - (a.range ?? 0))[0];
const FRT = AIRCRAFT_TYPES.filter(t => t.freighter && (t.range ?? 0) > 7000)
  .sort((a, b) => (b.range ?? 0) - (a.range ?? 0))[0];
assert.ok(JET && FRT, 'need a long-range passenger jet and a freighter in the type table');

const CODES = ['JFK', 'LAX', 'ORD', 'SFO', 'MIA', 'SEA', 'DFW', 'BOS'];
const WEEK  = 20;                                   // May
const MONTH = weekToGameDate(WEEK).monthIndex;      // 1-indexed month the page renders in

const cfgOf = (t) => ({ economy: t.seats ?? 150 });

// ── Truth, straight off the engine's own tick expression ─────────────────────
// reducer.mjs ADVANCE_WEEK: routes ACTIVE this month, legs-aware, and nothing at
// all for an aircraft that is out of service.
function tickBlockHours(state, aircraftId, type, month, { outOfService = false } = {}) {
  if (outOfService) return 0;
  return [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]
    .filter(r => r.aircraftId === aircraftId && isRouteActive(r, month))
    .reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0);
}

// Hours the tail is on the hook for at its busiest month, INCLUDING routes a
// reserve is currently covering for it — the quantity the cap governs.
function committedPeak(state, aircraftId, type) {
  const mine = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]
    .filter(r => r.aircraftId === aircraftId || r.coverForAircraftId === aircraftId);
  return Math.max(0, ...Array.from({ length: 12 }, (_, i) => i + 1).map(m =>
    mine.filter(r => isRouteActive(r, m))
        .reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0)));
}

// ── Reading the rendered markup ──────────────────────────────────────────────
// The UTIL. cell is the 4th <td> after the tail number inside the aircraft's row.
function rowFor(html, tailNumber) {
  const i = html.indexOf(tailNumber);
  assert.ok(i >= 0, `tail ${tailNumber} is not in the rendered fleet table`);
  const end = html.indexOf('</tr>', i);
  return html.slice(i, end < 0 ? html.length : end);
}
function utilCell(html, tailNumber) {
  const parts = rowFor(html, tailNumber).split('<td');
  assert.ok(parts.length > 4, `could not locate the UTIL. cell for ${tailNumber}`);
  return parts[4];
}
/** Hours the column actually prints for this tail (null when it prints a dash). */
function renderedUtilHours(html, tailNumber) {
  const cell = utilCell(html, tailNumber);
  const m = cell.match(/>\s*([\d.]+)(?:<!-- -->)?h/);
  if (!m) return null;
  return Number(m[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. The UTIL. column agrees with the weekly tick ────────');

const seasonalSave = (() => {
  const yearProto = { origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'] };
  const sumrProto = { origin: 'JFK', destination: 'SFO', stops: ['JFK', 'SFO'] };
  const tagProto  = { origin: 'JFK', destination: 'SEA', stops: ['JFK', 'ORD', 'SEA'] };
  const fYear = Math.max(1, Math.floor(maxFrequency(routeDistanceKm('JFK', 'LAX'), JET) / 2));
  const fTag  = 2;
  // Size the summer route so the BUSIEST month still fits under the cap — the
  // schedule has to be legal for the display bug to be the only thing on trial.
  const busyRoom = MAX_WEEKLY_BLOCK_HOURS
    - routeBlockHours(yearProto, JET, fYear)
    - routeBlockHours(tagProto,  JET, fTag);
  const fSumr = Math.max(1, Math.floor(busyRoom / routeBlockHours(sumrProto, JET, 1)));
  return {
    ...freshState(),
    phase: 'playing', week: WEEK, year: 4, hub: 'JFK', cash: 400_000_000,
    gates: Object.fromEntries(CODES.map(c => [c, 40])),
    hubs: { JFK: { tier: 2 } },
    fleet: [
      { id: 'ac1', typeId: JET.id, name: 'Seasonal Tail', tailNumber: 'NSEAS1', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'ac2', typeId: FRT.id, name: 'Freight Tail',  tailNumber: 'NFRGT1', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: {} },
    ],
    routes: [
      // Year-round, operating in May.
      { id: 'r-year', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'ac1',
        weeklyFrequency: fYear, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
      // Summer-only: DORMANT in May, so the tick charges it nothing.
      { id: 'r-summer', origin: 'JFK', destination: 'SFO', stops: ['JFK', 'SFO'], aircraftId: 'ac1',
        weeklyFrequency: fSumr, weeksOpen: 60, hub: 'JFK', season: { months: [6, 7, 8, 9] }, seasonState: 'dormant' },
      // Multi-stop tag route: THREE legs of block time, not the direct O&D hop.
      { id: 'r-tag', origin: 'JFK', destination: 'SEA', stops: ['JFK', 'ORD', 'SEA'], aircraftId: 'ac1',
        weeklyFrequency: fTag, weeksOpen: 60, hub: 'JFK', segmentPrices: {}, cateringLevel: 'full' },
    ],
    cargoRoutes: [
      { id: 'c-1', origin: 'JFK', destination: 'MIA', aircraftId: 'ac2', cargo: true,
        weeklyFrequency: 4, weeksOpen: 60, hub: 'JFK', yieldPrice: 0.4 },
    ],
  };
})();

const seasonalHtml = (() => {
  store.set('bbae_save_v2', JSON.stringify(seasonalSave));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Fleet)));
})();

test('a tail with a dormant seasonal route is not billed for it in the column', () => {
  const truth    = tickBlockHours(seasonalSave, 'ac1', JET, MONTH);
  const rendered = renderedUtilHours(seasonalHtml, 'NSEAS1');
  assert.ok(rendered != null, 'UTIL. column printed no hours at all');
  assert.equal(Math.round(rendered), Math.round(truth),
    `UTIL. shows ${rendered}h but the tick flies ${truth.toFixed(1)}h this month`);
});

test('a multi-stop tag route is costed by its legs, not the direct O&D hop', () => {
  const tag = seasonalSave.routes.find(r => r.id === 'r-tag');
  const legs   = routeBlockHours(tag, JET, tag.weeklyFrequency);
  const direct = routeDistanceKm('JFK', 'SEA');
  assert.ok(legs > 0 && direct > 0);
  // The scenario is only meaningful if the two differ.
  const rendered = renderedUtilHours(seasonalHtml, 'NSEAS1');
  const truth    = tickBlockHours(seasonalSave, 'ac1', JET, MONTH);
  assert.equal(Math.round(rendered), Math.round(truth),
    `tag legs are worth ${legs.toFixed(1)}h; the column is off by ${(rendered - truth).toFixed(1)}h`);
});

test('a freighter’s cargo routes reach the column at their true cost', () => {
  const truth    = tickBlockHours(seasonalSave, 'ac2', FRT, MONTH);
  const rendered = renderedUtilHours(seasonalHtml, 'NFRGT1');
  assert.ok(truth > 0, 'scenario should give the freighter real hours');
  assert.equal(Math.round(rendered), Math.round(truth));
});

test('no legally-scheduled tail ever renders above the cap', () => {
  for (const [tail, id, type] of [['NSEAS1', 'ac1', JET], ['NFRGT1', 'ac2', FRT]]) {
    const peak = committedPeak(seasonalSave, id, type);
    assert.ok(peak <= MAX_WEEKLY_BLOCK_HOURS + 1e-6,
      `scenario is invalid: ${id} is scheduled at ${peak.toFixed(1)}h`);
    const rendered = renderedUtilHours(seasonalHtml, tail);
    assert.ok(rendered <= MAX_WEEKLY_BLOCK_HOURS,
      `${tail} renders ${rendered}h against a ${MAX_WEEKLY_BLOCK_HOURS}h cap`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. Out of service means it is not flying ──────────────');

const coverSave = (() => {
  const d = routeDistanceKm('JFK', 'LAX');
  const f = Math.max(1, Math.floor(maxFrequency(d, JET) / 2));
  return {
    ...freshState(),
    phase: 'playing', week: WEEK, year: 4, hub: 'JFK', cash: 400_000_000,
    gates: Object.fromEntries(CODES.map(c => [c, 40])),
    hubs: { JFK: { tier: 2 } },
    fleet: [
      { id: 'brk', typeId: JET.id, name: 'Broken Tail',  tailNumber: 'NBROKE', status: 'grounded', groundedWeeksLeft: 2, ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'res', typeId: JET.id, name: 'Reserve Tail', tailNumber: 'NRESRV', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET), reserveBase: 'JFK' },
    ],
    routes: [
      { id: 'r-cov', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'res',
        coverForAircraftId: 'brk', weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
    ],
    cargoRoutes: [],
  };
})();

const coverHtml = (() => {
  store.set('bbae_save_v2', JSON.stringify(coverSave));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Fleet)));
})();

test('a grounded tail reports the hours it flies this week: none', () => {
  const rendered = renderedUtilHours(coverHtml, 'NBROKE');
  assert.ok(rendered === null || rendered === 0,
    `a grounded aircraft reported ${rendered}h of utilisation`);
});

test('the reserve actually covering the route carries the hours', () => {
  const truth    = tickBlockHours(coverSave, 'res', JET, MONTH);
  const rendered = renderedUtilHours(coverHtml, 'NRESRV');
  assert.ok(truth > 0);
  assert.equal(Math.round(rendered), Math.round(truth));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. An over-cap tail is unmistakable, not a full bar ─────');

const overSave = (() => {
  const f = maxFrequency(routeDistanceKm('JFK', 'LAX'), JET);
  // 'just' sits a whisker over the cap, 'way' at roughly twice it.
  const bosProto = { origin: 'JFK', destination: 'BOS', stops: ['JFK', 'BOS'] };
  const laxProto = { origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'] };
  const fJust = Math.max(1, Math.ceil(
    (MAX_WEEKLY_BLOCK_HOURS + 1 - routeBlockHours(laxProto, JET, f)) / routeBlockHours(bosProto, JET, 1)));
  return {
    ...freshState(),
    phase: 'playing', week: WEEK, year: 4, hub: 'JFK', cash: 400_000_000,
    gates: Object.fromEntries(CODES.map(c => [c, 40])),
    hubs: { JFK: { tier: 2 } },
    fleet: [
      // Two legacy tails already over the cap by very different amounts, and a
      // healthy one for contrast. All three must be told apart at a glance.
      { id: 'way',   typeId: JET.id, name: 'Way Over',     tailNumber: 'NWAYOV', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'just',  typeId: JET.id, name: 'Just Over',    tailNumber: 'NJUSTO', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'light', typeId: JET.id, name: 'Healthy Tail', tailNumber: 'NLIGHT', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
    ],
    routes: [
      { id: 'w1', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'way',
        weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
      { id: 'w2', origin: 'JFK', destination: 'SFO', stops: ['JFK', 'SFO'], aircraftId: 'way',
        weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
      { id: 'j1', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'just',
        weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
      { id: 'j2', origin: 'JFK', destination: 'BOS', stops: ['JFK', 'BOS'], aircraftId: 'just',
        weeklyFrequency: fJust, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
      { id: 'l1', origin: 'JFK', destination: 'BOS', stops: ['JFK', 'BOS'], aircraftId: 'light',
        weeklyFrequency: 3, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
    ],
    cargoRoutes: [],
  };
})();

const overHtml = (() => {
  store.set('bbae_save_v2', JSON.stringify(overSave));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Fleet)));
})();

test('scenario sanity: two tails over the cap by very different margins', () => {
  const way  = tickBlockHours(overSave, 'way',  JET, MONTH);
  const just = tickBlockHours(overSave, 'just', JET, MONTH);
  assert.ok(just > MAX_WEEKLY_BLOCK_HOURS && way > just * 1.3,
    `expected a big gap: just=${just.toFixed(1)}h way=${way.toFixed(1)}h`);
});

test('an over-cap tail prints the limit it is breaking', () => {
  const cell = utilCell(overHtml, 'NWAYOV').replace(/<!-- -->/g, '');
  assert.match(cell, new RegExp(`${MAX_WEEKLY_BLOCK_HOURS}h`),
    'the over-cap cell must show the figure against the cap, e.g. "278h / 140h"');
});

test('two tails over the cap by different margins do not render identically', () => {
  // Math.min(100, pct) saturation: the one visual that should scream flatlines,
  // so 145h and 278h draw the same bar. Whatever the fix, they must differ.
  const bar = (tail) => {
    const cell = utilCell(overHtml, tail);
    const m = cell.match(/width:\s*[\d.]+%[^"]*/g);
    return (m ? m.join('|') : '') + '::' + (cell.match(/background:[^;"]+/g) || []).join('|');
  };
  assert.notEqual(bar('NWAYOV'), bar('NJUSTO'),
    'a tail at 2× the cap draws exactly the same bar as one barely over it');
});

test('an over-cap tail is visually distinct from a healthy one', () => {
  const colours = (tail) => (utilCell(overHtml, tail).match(/background:[^;"]+/g) || []).join('|');
  assert.notEqual(colours('NWAYOV'), colours('NLIGHT'));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. The reducer refuses every route past the cap ────────');

const world = (fleet, routes = [], cargoRoutes = []) => ({
  ...freshState(),
  phase: 'playing', week: WEEK, year: 4, hub: 'JFK', cash: 900_000_000,
  gates: Object.fromEntries(CODES.map(c => [c, 40])),
  hubs: { JFK: { tier: 2 } },
  fleet, routes, cargoRoutes,
});

test('ADD_ROUTE cannot load a tail whose routes a reserve is covering', () => {
  const d = routeDistanceKm('JFK', 'LAX');
  const f = maxFrequency(d, JET);
  let st = world(
    [
      { id: 'brk', typeId: JET.id, name: 'Broken', tailNumber: 'NB1', status: 'grounded', groundedWeeksLeft: 2, ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'res', typeId: JET.id, name: 'Reserve', tailNumber: 'NR1', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET), reserveBase: 'JFK' },
    ],
    [{ id: 'r-cov', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'res',
       coverForAircraftId: 'brk', weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' }],
  );
  assert.ok(committedPeak(st, 'brk', JET) > MAX_WEEKLY_BLOCK_HOURS * 0.9,
    'scenario should leave the broken tail nearly full');
  const before = st;
  st = gameReducer(st, { type: 'ADD_ROUTE', origin: 'JFK', destination: 'SFO', aircraftId: 'brk', weeklyFrequency: maxFrequency(routeDistanceKm('JFK', 'SFO'), JET), ticketPrice: 400 });
  assert.equal(st, before, 'the reducer took a second full load onto an already-committed tail');
  assert.ok(committedPeak(st, 'brk', JET) <= MAX_WEEKLY_BLOCK_HOURS + 1e-6);
});

test('the cover coming home never leaves the tail over the cap', () => {
  const d = routeDistanceKm('JFK', 'LAX');
  const f = maxFrequency(d, JET);
  let st = world(
    [
      { id: 'brk', typeId: JET.id, name: 'Broken', tailNumber: 'NB2', status: 'grounded', groundedWeeksLeft: 1, ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'res', typeId: JET.id, name: 'Reserve', tailNumber: 'NR2', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET), reserveBase: 'JFK' },
    ],
    [{ id: 'r-cov', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'res',
       coverForAircraftId: 'brk', weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' }],
  );
  st = gameReducer(st, { type: 'ADD_ROUTE', origin: 'JFK', destination: 'SFO', aircraftId: 'brk', weeklyFrequency: maxFrequency(routeDistanceKm('JFK', 'SFO'), JET), ticketPrice: 400 });
  // Broken tail recovers; the cover ends and the route goes home.
  const healed = { ...st, fleet: st.fleet.map(a => a.id === 'brk' ? { ...a, status: 'assigned', groundedWeeksLeft: 0 } : a) };
  const back = applyReserveCovers({ fleet: healed.fleet, routes: healed.routes, cargoRoutes: healed.cargoRoutes ?? [], hubs: healed.hubs, absWeek: 200, routeRevenues: {} });
  const after = { ...healed, fleet: back.fleet, routes: back.routes, cargoRoutes: back.cargoRoutes };
  const flying = tickBlockHours(after, 'brk', JET, MONTH);
  assert.ok(flying <= MAX_WEEKLY_BLOCK_HOURS + 1e-6,
    `the tail came back flying ${flying.toFixed(1)}h against a ${MAX_WEEKLY_BLOCK_HOURS}h cap`);
});

test('ADD_CARGO_ROUTE counts every hour already committed to the freighter', () => {
  const d = routeDistanceKm('JFK', 'LAX');
  const f = maxFrequency(d, FRT);
  let st = world(
    [
      { id: 'brk', typeId: FRT.id, name: 'Broken Freighter', tailNumber: 'NB3', status: 'grounded', groundedWeeksLeft: 2, ageWeeks: 260, ownershipType: 'owned', config: {} },
      { id: 'res', typeId: FRT.id, name: 'Reserve Freighter', tailNumber: 'NR3', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: {}, reserveBase: 'JFK' },
    ],
    [],
    [{ id: 'c-cov', origin: 'JFK', destination: 'LAX', aircraftId: 'res', cargo: true,
       coverForAircraftId: 'brk', weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', yieldPrice: 0.4 }],
  );
  const before = st;
  st = gameReducer(st, { type: 'ADD_CARGO_ROUTE', origin: 'JFK', destination: 'SFO', aircraftId: 'brk', weeklyFrequency: maxFrequency(routeDistanceKm('JFK', 'SFO'), FRT) });
  assert.equal(st, before, 'a freighter took a second full cargo load while its own network was covered');
});

test('ADD_TAG_ROUTE counts hours already committed to the tail', () => {
  const d = routeDistanceKm('JFK', 'LAX');
  const f = maxFrequency(d, JET);
  let st = world(
    [
      { id: 'brk', typeId: JET.id, name: 'Broken', tailNumber: 'NB4', status: 'grounded', groundedWeeksLeft: 2, ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'res', typeId: JET.id, name: 'Reserve', tailNumber: 'NR4', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET), reserveBase: 'JFK' },
    ],
    [{ id: 'r-cov', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'res',
       coverForAircraftId: 'brk', weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' }],
  );
  const before = st;
  st = gameReducer(st, { type: 'ADD_TAG_ROUTE', stops: ['JFK', 'ORD', 'SEA'], aircraftId: 'brk', weeklyFrequency: 7 });
  assert.equal(st, before, 'a tag route was added on top of a full committed schedule');
});

test('counter-seasonal routes still share one airframe (the cap is a per-month peak)', () => {
  let st = world([
    { id: 'ac', typeId: JET.id, name: 'Seasonal', tailNumber: 'NS9', status: 'idle', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
  ]);
  const fW = maxFrequency(routeDistanceKm('JFK', 'LAX'), JET);
  const fS = maxFrequency(routeDistanceKm('JFK', 'SFO'), JET);
  let next = gameReducer(st, { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'ac', weeklyFrequency: fW, ticketPrice: 400, season: { months: [11, 12, 1, 2, 3, 4] } });
  assert.notEqual(next, st, 'the winter route should open');
  const after = gameReducer(next, { type: 'ADD_ROUTE', origin: 'JFK', destination: 'SFO', aircraftId: 'ac', weeklyFrequency: fS, ticketPrice: 400, season: { months: [5, 6, 7, 8, 9, 10] } });
  assert.notEqual(after, next, 'the counter-seasonal summer route must still be allowed to share the airframe');
  assert.ok(committedPeak(after, 'ac', JET) <= MAX_WEEKLY_BLOCK_HOURS + 1e-6);
});

test('REASSIGN_ROUTE respects hours a reserve is covering for the target', () => {
  const d = routeDistanceKm('JFK', 'LAX');
  const f = maxFrequency(d, JET);
  let st = world(
    [
      { id: 'brk',   typeId: JET.id, name: 'Broken', tailNumber: 'NB5', status: 'grounded', groundedWeeksLeft: 2, ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
      { id: 'res',   typeId: JET.id, name: 'Reserve', tailNumber: 'NR5', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET), reserveBase: 'JFK' },
      { id: 'donor', typeId: JET.id, name: 'Donor', tailNumber: 'ND5', status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(JET) },
    ],
    [
      { id: 'r-cov', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'res',
        coverForAircraftId: 'brk', weeklyFrequency: f, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
      { id: 'r-move', origin: 'JFK', destination: 'SFO', stops: ['JFK', 'SFO'], aircraftId: 'donor',
        weeklyFrequency: maxFrequency(routeDistanceKm('JFK', 'SFO'), JET), weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active' },
    ],
  );
  const before = st;
  st = gameReducer(st, { type: 'REASSIGN_ROUTE', routeId: 'r-move', toAircraftId: 'brk' });
  assert.equal(st, before, 'a route was moved onto a tail whose own network is out on cover');
});

// ─────────────────────────────────────────────────────────────────────────────
// The one-off migration that trims saves ALREADY over the physical cap.
//
// Closing the guards stopped new breaches; it did nothing for the eight tails
// the reporter already had above 140h. This section drives the migration the
// way a save actually reaches it — through LOAD_STATE / reconcileState — and
// asserts the four things that make an automatic edit to a player's paid-for
// schedule acceptable: it trims rather than deletes, it gives up the cheapest
// flying first, it never touches a legal schedule, and it says exactly what it
// did in a durable record.
console.log('\n── 5. Over-cap saves are trimmed back, once, and on the record ──');

const { compose } = await import('../src/components/News.jsx');
const serverNews  = await import('../apps/headwinds-server/src/lib/newsService.mjs');

const load = (payload) => gameReducer(freshState(), { type: 'LOAD_STATE', payload });

const saveWith = (fleet, routes, cargoRoutes = [], revenues = {}) => ({
  ...freshState(),
  phase: 'playing', week: WEEK, year: 4, hub: 'JFK', cash: 200_000_000,
  gates: Object.fromEntries(CODES.map(c => [c, 40])),
  hubs: { JFK: { tier: 2 } },
  competitors: [{ id: 'stub', name: 'Stub Air', routes: {}, fleet: [] }],
  fleet, routes, cargoRoutes,
  lastReport: {
    routeResults: routes.map(r => ({ routeId: r.id, revenue: revenues[r.id] ?? 0 })),
    cargoRouteResults: cargoRoutes.map(r => ({ routeId: r.id, revenue: revenues[r.id] ?? 0 })),
  },
});

const tail = (id, num, type = JET) => ({
  id, typeId: type.id, name: `Tail ${num}`, tailNumber: num,
  status: 'assigned', ageWeeks: 260, ownershipType: 'owned', config: cfgOf(type),
});
const leg = (id, acId, o, d, freq, extra = {}) => ({
  id, origin: o, destination: d, stops: [o, d], aircraftId: acId,
  weeklyFrequency: freq, weeksOpen: 60, hub: 'JFK', season: null, seasonState: 'active', ...extra,
});
const findRoute = (st, id) => (st.routes ?? []).find(r => r.id === id)
                           ?? (st.cargoRoutes ?? []).find(r => r.id === id);

// ── 5a. Trimmed to at-or-under the cap, measured at the PEAK month ──────────
test('a tail flying past the physical cap is trimmed back under it', () => {
  const fMax = maxFrequency(routeDistanceKm('JFK', 'LAX'), JET);
  const before = saveWith(
    [tail('t1', 'NOVER1')],
    [leg('rich', 't1', 'JFK', 'LAX', fMax), leg('cheap', 't1', 'JFK', 'SFO', fMax)],
    [],
    { rich: 900_000, cheap: 50_000 },
  );
  assert.ok(committedPeak(before, 't1', JET) > MAX_WEEKLY_BLOCK_HOURS,
    'scenario should start over the cap');
  const after = load(before);
  const peak = committedPeak(after, 't1', JET);
  assert.ok(peak <= MAX_WEEKLY_BLOCK_HOURS + 1e-6,
    `still scheduled at ${peak.toFixed(1)}h against a ${MAX_WEEKLY_BLOCK_HOURS}h cap`);
  assert.ok(peak > 0, 'the tail was emptied instead of trimmed');
});

// ── 5b. The cheapest hour goes first ────────────────────────────────────────
test('the lowest revenue-per-block-hour route is the one cut', () => {
  // Two identical lanes, one earning 18× the other, and an overrun small enough
  // that a single flight off the cheap route clears it. A correct migration
  // therefore leaves the earning route completely alone.
  const fRich = maxFrequency(routeDistanceKm('JFK', 'LAX'), JET) - 1;
  const before = saveWith(
    [tail('t1', 'NPICK1')],
    [leg('rich', 't1', 'JFK', 'LAX', fRich), leg('cheap', 't1', 'JFK', 'LAX', 2)],
    [],
    { rich: 900_000, cheap: 50_000 },
  );
  const perFlight = routeBlockHours(before.routes[1], JET, 1);
  const excess = committedPeak(before, 't1', JET) - MAX_WEEKLY_BLOCK_HOURS;
  assert.ok(excess > 0 && excess <= perFlight,
    `scenario must be over the cap by no more than one flight (${excess.toFixed(1)}h vs ${perFlight.toFixed(1)}h)`);
  const after = load(before);
  const rich  = findRoute(after, 'rich');
  const cheap = findRoute(after, 'cheap');
  assert.ok(rich, 'the earning route must survive');
  assert.equal(rich.weeklyFrequency, fRich,
    'the highest-earning route was cut while a cheaper one still had frequency to give');
  assert.equal(cheap.weeklyFrequency, 1, 'the cheap route should have absorbed the whole cut');
});

// ── 5c. A legal fleet is left completely alone ──────────────────────────────
test('a schedule already within the cap is byte-identical afterwards', () => {
  const fW = maxFrequency(routeDistanceKm('JFK', 'LAX'), JET);
  const fS = maxFrequency(routeDistanceKm('JFK', 'SFO'), JET);
  // Counter-seasonal routes sharing one airframe: legal, and the annual sum is
  // way over the cap. If the migration measured the year instead of the peak
  // month it would gut this player's network.
  const before = saveWith(
    [tail('t1', 'NLEGAL')],
    [
      leg('winter', 't1', 'JFK', 'LAX', fW, { season: { months: [11, 12, 1, 2, 3, 4] } }),
      leg('summer', 't1', 'JFK', 'SFO', fS, { season: { months: [5, 6, 7, 8, 9, 10] }, seasonState: 'active' }),
    ],
    [],
    { winter: 400_000, summer: 400_000 },
  );
  assert.ok(committedPeak(before, 't1', JET) <= MAX_WEEKLY_BLOCK_HOURS, 'scenario must be legal');
  const after = load(before);
  const shape = (rs) => rs.map(r => `${r.id}:${r.weeklyFrequency}`).sort().join('|');
  assert.equal(shape(after.routes), shape(before.routes),
    'a legal schedule was modified by the migration');
  assert.equal((after.scheduleTrimNotices ?? []).length, 0,
    'a legal schedule produced a trim notice');
});

// ── 5d. Runs once, never twice ──────────────────────────────────────────────
test('the migration is idempotent — a second load changes nothing', () => {
  const fMax = maxFrequency(routeDistanceKm('JFK', 'LAX'), JET);
  const before = saveWith(
    [tail('t1', 'NONCE1')],
    [leg('rich', 't1', 'JFK', 'LAX', fMax), leg('cheap', 't1', 'JFK', 'SFO', fMax)],
    [],
    { rich: 900_000, cheap: 50_000 },
  );
  const once  = load(before);
  const twice = load(once);
  const shape = (st) => (st.routes ?? []).map(r => `${r.id}:${r.weeklyFrequency}`).sort().join('|');
  assert.equal(shape(twice), shape(once), 'a second load trimmed the schedule again');
  assert.equal((twice.scheduleTrimNotices ?? []).length, (once.scheduleTrimNotices ?? []).length,
    'a second load produced duplicate notices');
  assert.ok((once.scheduleTrimNotices ?? []).length > 0, 'the first load should have recorded a notice');
});

// ── 5e. Zero closes the route; it never goes negative ───────────────────────
test('a route driven to zero closes instead of going negative', () => {
  // Enough ultra-long lanes at ONE weekly flight each that the tail is still
  // over the cap with nothing left to reduce. Closing whole routes is then the
  // only way down — the last resort, and the thing that must not go negative.
  const lanes = AIRPORTS
    .filter(a => a.code !== 'JFK' && routeDistanceKm('JFK', a.code) <= (JET.range ?? 0))
    .map(a => ({ code: a.code, d: routeDistanceKm('JFK', a.code) }))
    .sort((x, y) => y.d - x.d || x.code.localeCompare(y.code));
  const routes = [];
  let hrs = 0;
  for (const l of lanes) {
    if (hrs > MAX_WEEKLY_BLOCK_HOURS * 1.4) break;
    const r = leg(`r${routes.length}`, 't1', 'JFK', l.code, 1);
    routes.push(r);
    hrs += routeBlockHours(r, JET, 1);
  }
  const revenues = Object.fromEntries(routes.map((r, i) => [r.id, (i + 1) * 100_000]));
  const before = saveWith([tail('t1', 'NZERO1')], routes, [], revenues);
  const t = JET;
  assert.ok(committedPeak(before, 't1', t) > MAX_WEEKLY_BLOCK_HOURS, 'scenario must start over the cap');
  assert.ok(before.routes.every(r => r.weeklyFrequency === 1), 'every route must already be at minimum');
  const after = load(before);
  for (const r of [...(after.routes ?? []), ...(after.cargoRoutes ?? [])]) {
    assert.ok(r.weeklyFrequency >= 1, `route ${r.id} survived at ${r.weeklyFrequency} flights/wk`);
  }
  assert.ok((after.routes ?? []).length < before.routes.length, 'nothing was closed');
  assert.ok(committedPeak(after, 't1', t) <= MAX_WEEKLY_BLOCK_HOURS + 1e-6);
  const notice = (after.scheduleTrimNotices ?? [])[0];
  assert.ok(notice && notice.cuts.some(c => c.closed), 'the closure was not recorded as a closure');
});

// ── 5f. The player is told, in a durable record, with the real numbers ──────
test('the trim produces a news entry naming the aircraft, route and frequencies', () => {
  const fMax = maxFrequency(routeDistanceKm('JFK', 'LAX'), JET);
  const before = saveWith(
    [tail('t1', 'N1RSV')],
    [leg('rich', 't1', 'JFK', 'LAX', fMax), leg('cheap', 't1', 'JFK', 'BOS', 40)],
    [],
    { rich: 900_000, cheap: 20_000 },
  );
  assert.ok(committedPeak(before, 't1', JET) > MAX_WEEKLY_BLOCK_HOURS, 'scenario sanity');
  const after  = load(before);
  const notice = (after.scheduleTrimNotices ?? [])[0];
  assert.ok(notice, 'the migration left no durable record of what it changed');
  assert.equal(notice.tailNumber, 'N1RSV');
  assert.ok(notice.peakBefore > MAX_WEEKLY_BLOCK_HOURS, 'the notice must state the hours it was flying');
  assert.ok(notice.peakAfter <= MAX_WEEKLY_BLOCK_HOURS + 1e-6);
  const cut = notice.cuts.find(c => c.origin === 'JFK' && c.destination === 'BOS');
  assert.ok(cut, 'the cut route is not named');
  assert.equal(cut.fromFrequency, 40, 'the old frequency is not recorded');
  assert.ok(cut.toFrequency < 40, 'the new frequency is not recorded');

  // The server turns one notice into ONE news row per aircraft...
  assert.equal(typeof serverNews.scheduleTrimNewsRows, 'function',
    'the server has no builder for the schedule-trim news row');
  const rows = serverNews.scheduleTrimNewsRows({
    worldId: 'w1', week: 40, notices: [{ ...notice, airlineId: 'a1' }],
  });
  assert.equal(rows.length, 1, 'one row per aircraft, not one per frequency decrement');
  assert.equal(rows[0].kind, 'schedule_trim');
  assert.equal(rows[0].airlineId, 'a1');

  // ...and the client renders it as a sentence carrying the real figures.
  const { headline, sub } = compose({ kind: 'schedule_trim', data: rows[0].payload });
  const text = `${headline} ${sub}`;
  assert.match(text, /N1RSV/, 'the sentence does not name the aircraft');
  assert.match(text, new RegExp(`${MAX_WEEKLY_BLOCK_HOURS}h`), 'the sentence does not state the limit');
  assert.match(text, /JFK–BOS/, 'the sentence does not name the route');
  assert.match(text, new RegExp(`40\\s*→\\s*${cut.toFrequency}`), 'the sentence does not give both frequencies');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
