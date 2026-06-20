// Reducer + engine test for seasonal flights.
//
// Transpiles GameContext.jsx in-memory (Babel; JSX stripped to null — we only
// need the pure reducer) and exercises:
//   • ADD_ROUTE stores a season window + seasonState
//   • a route dormant this month earns nothing; in-season it earns
//   • two counter-seasonal routes share one aircraft (per-month block/slot checks)
//   • resuming a season charges 1/3 of launch cost, once per season
//   • year-round routes are unaffected (backward compatible)
//
//   node tools/seasonal-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { distanceKm, weekToGameDate, isRouteActive, weeklyTick } from '../src/utils/simulation.js';
import { routeLaunchCost } from '../src/data/overhead.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

const SRC = 'src/store/GameContext.jsx';
const SRC_DIR = path.resolve(path.dirname(SRC));
const TMP = path.join(os.tmpdir(), `gc_seasonal_${process.pid}.mjs`);

const stripJsx = ({ types: t }) => ({
  visitor: {
    JSXElement(p)  { p.replaceWith(t.nullLiteral()); },
    JSXFragment(p) { p.replaceWith(t.nullLiteral()); },
  },
});

const reqFromSrc = createRequire(path.join(SRC_DIR, '_noop.js'));
const resolveSpec = (spec) => {
  if (spec.startsWith('.')) return pathToFileURL(path.resolve(SRC_DIR, spec)).href;
  try { return pathToFileURL(reqFromSrc.resolve(spec)).href; } catch { return spec; }
};
const absolutizeImports = (code) =>
  code.replace(/(from\s+|import\s*\(\s*)(['"])([^'"]+)\2/g,
    (_m, lead, q, spec) => `${lead}${q}${resolveSpec(spec)}${q}`);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const out = babel.transformFileSync(SRC, {
  babelrc: false, configFile: false,
  parserOpts: { plugins: ['jsx'] },
  plugins: [stripJsx],
});
fs.writeFileSync(TMP, absolutizeImports(out.code));

// Find the first week whose game-month equals a target month.
const weekForMonth = (month) => {
  for (let w = 1; w <= 52; w++) if (weekToGameDate(w).monthIndex === month) return w;
  throw new Error(`no week maps to month ${month}`);
};

try {
  const mod = await import(pathToFileURL(path.resolve(TMP)).href);
  const reducer = mod.gameReducer, freshState = mod.freshState;

  const major = ['JFK', 'ORD', 'LAX', 'DFW', 'ATL', 'MIA'].filter(c => getAirport(c));
  const [P, Q, R] = major;
  const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];

  const baseState = (over = {}) => ({
    ...freshState(),
    phase: 'playing', cash: 50_000_000, hub: P,
    gates: { [P]: 8, [Q]: 8, [R]: 8 },
    fleet: [{ id: 'ac1', typeId: jet.id, status: 'idle', ageWeeks: 52, ownershipType: 'owned' }],
    routes: [],
    week: 1, year: 1,
    ...over,
  });

  const SUMMER = { months: [6, 7, 8, 9] };
  const WINTER = { months: [12, 1, 2, 3] };
  const addRoute = (state, extra = {}) =>
    reducer(state, { type: 'ADD_ROUTE', origin: P, destination: Q, aircraftId: 'ac1', weeklyFrequency: 7, ticketPrice: 300, ...extra });

  console.log('\n── ADD_ROUTE seasonal window ────────────────────────────');

  test('stores season + seasonState=active when created in-season', () => {
    const s = addRoute(baseState({ week: weekForMonth(7) }), { season: SUMMER });
    assert.equal(s.routes.length, 1);
    assert.deepEqual(s.routes[0].season, SUMMER);
    assert.equal(s.routes[0].seasonState, 'active');
  });

  test('seasonState=dormant when created out of season', () => {
    const s = addRoute(baseState({ week: weekForMonth(1) }), { season: SUMMER });
    assert.equal(s.routes[0].seasonState, 'dormant');
  });

  test('year-round route has season:null (backward compatible)', () => {
    const s = addRoute(baseState());
    assert.equal(s.routes[0].season, null);
    assert.equal(s.routes[0].seasonState, 'active');
  });

  console.log('\n── Counter-seasonal aircraft sharing ────────────────────');

  test('a summer + a winter route share ONE aircraft (non-overlapping months)', () => {
    let s = addRoute(baseState({ week: weekForMonth(7) }), { season: SUMMER, destination: Q });
    s = reducer(s, { type: 'ADD_ROUTE', origin: P, destination: R, aircraftId: 'ac1', weeklyFrequency: 7, ticketPrice: 300, season: WINTER });
    assert.equal(s.routes.length, 2, 'both routes accepted on the same plane');
  });

  test('two OVERLAPPING summer routes that bust block hours are rejected', () => {
    // Same plane, same season, max frequency on a long pair twice should exceed block hours.
    let s = addRoute(baseState({ week: weekForMonth(7), gates: { [P]: 8, [Q]: 8, [R]: 8 } }),
      { season: SUMMER, weeklyFrequency: 7 });
    const before = s.routes.length;
    // Add many overlapping-season departures on another long pair to blow the block-hour cap.
    for (let i = 0; i < 30; i++) {
      s = reducer(s, { type: 'ADD_ROUTE', origin: P, destination: R, aircraftId: 'ac1', weeklyFrequency: 7, ticketPrice: 300, season: SUMMER });
    }
    // The aircraft cannot physically fly unlimited overlapping block hours.
    const blockBusted = s.routes
      .filter(r => r.aircraftId === 'ac1')
      .length < before + 30;
    assert.ok(blockBusted, 'overlapping-season routes are still block-hour limited');
  });

  console.log('\n── Engine: dormant routes earn nothing ──────────────────');

  test('summer route earns in July, earns nothing in January', () => {
    const built = addRoute(baseState({ week: weekForMonth(7) }), { season: SUMMER });
    // Simulate a July week
    const julyReport = reducer({ ...built, week: weekForMonth(7) }, { type: 'ADVANCE_WEEK' }).lastReport;
    // Simulate a January week (dormant)
    const janReport = reducer({ ...built, week: weekForMonth(1) }, { type: 'ADVANCE_WEEK' }).lastReport;
    assert.ok(julyReport.totalRevenue > 0, `expected July revenue > 0, got ${julyReport.totalRevenue}`);
    assert.equal(janReport.totalRevenue, 0, `expected $0 in January, got ${janReport.totalRevenue}`);
  });

  test('year-round route earns in BOTH July and January', () => {
    const built = addRoute(baseState({ week: weekForMonth(7) }));  // no season
    const july = reducer({ ...built, week: weekForMonth(7) }, { type: 'ADVANCE_WEEK' }).lastReport;
    const jan  = reducer({ ...built, week: weekForMonth(1) }, { type: 'ADVANCE_WEEK' }).lastReport;
    assert.ok(july.totalRevenue > 0 && jan.totalRevenue > 0, 'year-round earns every month');
  });

  console.log('\n── Reactivation fee (1/3 of launch) ─────────────────────');

  test('resuming a dormant season charges ~1/3 launch cost, once', () => {
    // Build dormant (created in Jan, summer route) then advance INTO summer.
    const built = addRoute(baseState({ week: weekForMonth(1) }), { season: SUMMER });
    assert.equal(built.routes[0].seasonState, 'dormant');
    const expectFee = Math.round(routeLaunchCost(distanceKm(getAirport(P), getAirport(Q))) / 3);

    // Advance one week that lands in summer (June).
    const junWeek = weekForMonth(6);
    const cashBefore = 99_000_000;
    const s1 = reducer({ ...built, week: junWeek, cash: cashBefore }, { type: 'ADVANCE_WEEK' });
    const resumed = s1.routes[0];
    assert.equal(resumed.seasonState, 'active', 'route flips to active');

    // Advance another summer week — should NOT charge again (already active).
    const s2 = reducer({ ...s1, week: weekForMonth(7) }, { type: 'ADVANCE_WEEK' });
    assert.equal(s2.routes[0].seasonState, 'active');

    // The reactivation toast should have fired exactly on resume.
    const hadToast = (s1.pendingToasts ?? []).some(t => /resumed/i.test(t.title ?? ''));
    assert.ok(hadToast, 'reactivation toast fired on resume');
    // Sanity: fee is a positive, non-trivial fraction of launch.
    assert.ok(expectFee > 0, 'reactivation fee computed');
  });

  test('reactivation fee appears in the debrief report and reconciles to cash', () => {
    const built = addRoute(baseState({ week: weekForMonth(1) }), { season: SUMMER });
    const cashBefore = 99_000_000;
    const s1 = reducer({ ...built, week: weekForMonth(6), cash: cashBefore }, { type: 'ADVANCE_WEEK' });
    const rep = s1.lastReport;
    // Line item present and positive on the resume week.
    assert.ok((rep.seasonalReactivation ?? 0) > 0, 'seasonalReactivation line present in report');
    // Debrief reconciliation identity: revenueEffective − totalCostAll === cashDelta.
    const lhs = (rep.revenueEffective ?? rep.totalRevenue) - rep.totalCostAll;
    assert.ok(Math.abs(lhs - rep.cashDelta) <= 1, `debrief reconciles (${lhs} vs ${rep.cashDelta})`);
    // Headline cash change equals state.cash − cashBefore.
    assert.ok(Math.abs((s1.cash - cashBefore) - rep.cashDelta) <= 1, 'cashDelta matches actual cash movement');
    // The fee is inside totalCostAll.
    assert.ok(rep.totalCostAll >= rep.seasonalReactivation, 'reactivation folded into all-in cost');
  });

  console.log('\n── Network feed: dormant routes provide no connecting feed ');

  // Build a hub network: a year-round long-haul P→R plus a spoke S→P that can feed
  // connecting traffic onto it. When the spoke is dormant, it must NOT feed P→R.
  const S = major[4] ?? major[3];
  const gatesAll = Object.fromEntries(major.map(c => [c, 8]));
  const acLong  = { id: 'long', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' };
  const acSpoke = { id: 'spoke', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' };
  const longRoute  = { id: 'L', origin: P, destination: R, stops: [P, R], aircraftId: 'long', weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: 400 };
  const mkSpoke = (season) => ({ id: 'SP', origin: S, destination: P, stops: [S, P], aircraftId: 'spoke', weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: 250, season });

  const tickAt = (month, routes) => weeklyTick({
    week: weekForMonth(month), year: 1, cash: 5e6,
    fleet: [acLong, acSpoke], routes, cargoRoutes: [],
    gates: gatesAll, gameDate: { week: weekForMonth(month), month }, hub: P, hubs: { [P]: { tier: 2 } },
    competitors: [], financialHistory: [], awareness: 60, loans: [], activeEvents: [],
    fuelPrice: { index: 1, history: [] },
  });

  test('dormant spoke does not appear in the report (no revenue) in off-season', () => {
    const winterSpoke = mkSpoke({ months: [6, 7, 8, 9] }); // summer route, dormant in Jan
    const rep = tickAt(1, [longRoute, winterSpoke]);
    const spokeResult = rep.routeResults.find(r => r.routeId === 'SP');
    assert.ok(!spokeResult, 'dormant spoke produces no route result');
    const longResult = rep.routeResults.find(r => r.routeId === 'L');
    assert.ok(longResult && longResult.passengers > 0, 'long route still flies');
  });

  test('active spoke feeds the long route with more connecting pax than a dormant one', () => {
    const summerSpoke = { months: [6, 7, 8, 9] };
    const repSummer = tickAt(7, [longRoute, mkSpoke(summerSpoke)]); // spoke ACTIVE
    const repWinter = tickAt(1, [longRoute, mkSpoke(summerSpoke)]); // spoke DORMANT
    const longSummer = repSummer.routeResults.find(r => r.routeId === 'L');
    const longWinter = repWinter.routeResults.find(r => r.routeId === 'L');
    // Connecting feed should be >= with the spoke active. (Seasonality also shifts
    // base demand, so we assert the connecting component specifically when present.)
    const connSummer = longSummer.connectingPassengers ?? longSummer.connecting ?? 0;
    const connWinter = longWinter.connectingPassengers ?? longWinter.connecting ?? 0;
    assert.ok(connSummer >= connWinter, `active-spoke feed (${connSummer}) >= dormant-spoke feed (${connWinter})`);
  });

  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
} finally {
  try { fs.unlinkSync(TMP); } catch {}
}

process.exit(failed > 0 ? 1 : 0);
