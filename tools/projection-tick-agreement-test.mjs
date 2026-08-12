// ─────────────────────────────────────────────────────────────────────────────
// THE PROJECTION MUST FORECAST A WEEK THAT CAN ACTUALLY HAPPEN.
//
// Reported 2026-08-12, from a screenshot of the Weekly P&L card: route operating
// profit +$674.27M last week against +$624.37M projected for this one, with the
// heavy-check row printing a dash.
//
//     "Idk how im going to suddenly lose 50 mil in income. I dont have any
//      major checks or anything"   …   "And I make more than it estimates"
//
// He was right on both counts, and they were the same bug. ADVANCE_WEEK does not
// hand weeklyTick the raw state — it first ages the grounding and heavy-check
// countdowns, dispatches reserve covers over the tails still down, expires the
// events whose last week has passed, folds any fuel shock INTO the price index
// so hedges cover it, and opens the bases and lounges that finished building.
// projectWeek() skipped every one of those and ran the tick over the raw state,
// so an aircraft on the FINAL week of a check was written off for a week it
// spends entirely in the air. Measured on a fixture: −$1.04M of $3.15M (−33%) on
// one week, and −$0.82M of $0.95M (−86%) on another.
//
// This suite is not an arithmetic check on the card — tools/pnl-reconcile-test.mjs
// already does that, and it passed throughout, because the column added up
// perfectly to the wrong number. This one pins the projection against the REAL
// reducer: same state, same pinned RNG, and the two must agree to the dollar.
//
//   node tools/projection-tick-agreement-test.mjs
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
function seedRandom(seed) {
  let x = seed >>> 0;
  Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
/**
 * Pin every probability gate OPEN-FAILED for the duration of `fn`.
 *
 * Every random draw in ADVANCE_WEEK is a `Math.random() < p` gate on something
 * the projection is deliberately blind to: a newly-rolled event, a mechanical
 * failure, an AI carrier deciding to contest a route. Holding the draw at ~1
 * fires none of them, which leaves ONLY the deterministic prep — exactly the
 * part the projection is supposed to reproduce. Without this the two runs would
 * differ for honest reasons and the assertion would have to be a loose band,
 * which is how a 33% error hides.
 */
function withNoRolls(fn) {
  const prev = Math.random;
  Math.random = () => 0.9999999;
  try { return fn(); } finally { Math.random = prev; }
}

const DESTS = ['ORD', 'LAX', 'MIA', 'BOS', 'SFO', 'ATL', 'DEN', 'SEA'];

/** A JFK carrier old enough that heavy checks and mechanical failures happen. */
function startedAirline({ seed = 12345, ageWeeks = 500, freq = 21, fare = 1.15 } = {}) {
  seedRandom(seed);
  let s = gameReducer(freshState(),
    { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e9 };
  for (let i = 0; i < 14; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of DESTS) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: d, weeklyFrequency: freq });
  }
  const routePricing = { ...s.routePricing };
  for (const d of DESTS) {
    routePricing[['JFK', d].sort().join('-')] =
      defaultClassPrices(Math.round(referencePrice('JFK', d) * fare));
  }
  return {
    ...s, routePricing, awareness: 70,
    hubs: { ...(s.hubs ?? {}), JFK: { tier: 2, tierSince: 0 } },
    fleet: s.fleet.map(a => ({ ...a, ageWeeks, ownershipType: 'owned' })),
  };
}

const money = v => (v < 0 ? '-' : '+') + '$' + (Math.abs(v) / 1e6).toFixed(3) + 'M';
/** The figure the card calls "Route operating profit", straight off a report. */
const routeOp = r => Math.round((r?.totalRevenue ?? 0) - (r?.totalPartnerRevenue ?? 0) - (r?.totalOpCost ?? 0));
const outOfService = fleet => (fleet ?? []).filter(a => a.status === 'maintenance' || a.status === 'grounded');

// ─────────────────────────────────────────────────────────────────────────────
// Walk a real airline and compare, week by week
// ─────────────────────────────────────────────────────────────────────────────

const WEEKS = 80;
const rows = [];
{
  let s = startedAirline();
  for (let i = 0; i < WEEKS; i++) {
    const down = outOfService(s.fleet);
    // Aircraft whose downtime ENDS this week: the reducer stands them up before
    // the tick, so they fly all week. These are the weeks the bug was worth
    // eight figures on.
    const recovering = down.filter(a => a.status === 'grounded'
      ? (a.groundedWeeksLeft ?? 1) <= 1
      : (a.checkWeeksLeft ?? 1) <= 1);
    const { proj, next } = withNoRolls(() => ({
      proj: projectWeek(s),
      next: gameReducer(s, { type: 'ADVANCE_WEEK' }),
    }));
    rows.push({
      week: s.week, year: s.year,
      down: down.length, recovering: recovering.length,
      projRouteOp: routeOp(proj.report), actRouteOp: routeOp(next.lastReport),
      projRevenue: Math.round(proj.report.totalRevenue), actRevenue: Math.round(next.lastReport.totalRevenue),
      projEbitda: proj.ebitda,
      actEbitda: Math.round(next.lastReport.totalRevenue - next.lastReport.totalCost),
    });
    s = next;
  }
  Math.random = realRandom;
}

const mismatched = rows.filter(r => r.projRouteOp !== r.actRouteOp);
const recoveryWeeks = rows.filter(r => r.recovering > 0);

const table = (rs) => rs.slice(0, 8).map(r =>
  `        Y${r.year} W${String(r.week).padStart(2)}  ${r.recovering} recovering  `
  + `projected ${money(r.projRouteOp).padStart(10)}  actual ${money(r.actRouteOp).padStart(10)}  `
  + `off by ${money(r.actRouteOp - r.projRouteOp).padStart(10)}`).join('\n');

console.log('\nProjection ↔ tick agreement\n');
console.log(`── ${WEEKS} simulated weeks, ${recoveryWeeks.length} of them with an aircraft due back ──────────`);

test('the fixture actually produced weeks with an aircraft coming back from downtime', () => {
  assert.ok(recoveryWeeks.length >= 3,
    `only ${recoveryWeeks.length} such weeks in ${WEEKS} — this suite would pass vacuously, `
    + 'which is exactly how the bug survived. Re-seed or age the fixture.');
});

test('with no dice thrown, projected route operating profit IS the week that happens', () => {
  assert.equal(mismatched.length, 0,
    `${mismatched.length} of ${WEEKS} weeks disagreed with the tick that followed them.\n`
    + table(mismatched)
    + '\n        The projection is running weeklyTick over a state the reducer never uses. '
    + 'See utils/tickPrep.js.');
});

test('a week with an aircraft due back is projected as accurately as a quiet one', () => {
  const bad = recoveryWeeks.filter(r => r.projRouteOp !== r.actRouteOp);
  assert.equal(bad.length, 0,
    `${bad.length} of ${recoveryWeeks.length} recovery weeks were mis-projected — the tail is `
    + 'written off for a week it spends entirely in the air.\n' + table(bad));
});

test('total revenue agrees too, not just the operating line', () => {
  const bad = rows.filter(r => r.projRevenue !== r.actRevenue);
  assert.equal(bad.length, 0, `${bad.length} of ${WEEKS} weeks projected the wrong revenue.`);
});

test('EBITDA agrees, so the disagreement cannot hide in the cost buckets', () => {
  const bad = rows.filter(r => r.projEbitda !== r.actEbitda);
  assert.equal(bad.length, 0, `${bad.length} of ${WEEKS} weeks projected the wrong EBITDA.`);
});

// ─────────────────────────────────────────────────────────────────────────────
// The three mechanisms, isolated
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── The individual mechanisms ──────────────────────────────────────────────');

/** Put one aircraft into a heavy check with `weeksLeft` to run. */
function withCheck(s, weeksLeft) {
  const flying = s.fleet.find(a => s.routes.some(r => r.aircraftId === a.id));
  return {
    ...s,
    fleet: s.fleet.map(a => a.id === flying.id
      ? { ...a, status: 'maintenance', checkType: 'C', checkWeeksLeft: weeksLeft, checkForced: false }
      : a),
  };
}

test('an aircraft on the LAST week of a C check is flying in the projection', () => {
  const base = startedAirline();
  const s = withCheck(base, 1);
  const grounded = s.fleet.find(a => a.status === 'maintenance');
  const routeId  = s.routes.find(r => r.aircraftId === grounded.id).id;
  const proj = withNoRolls(() => projectWeek(s));
  const flown = (proj.report.routeResults ?? []).find(r => r.routeId === routeId);
  assert.ok(flown && (flown.passengers ?? flown.pax ?? 0) > 0,
    'its route earned nothing in the forecast, but the reducer stands the aircraft up '
    + 'before the tick and it flies the whole week — this is the $50M cliff on the card');
});

test('an aircraft with TWO weeks of check left is still grounded in the projection', () => {
  // The mirror image, and the reason the fix is "run the same prep" and not
  // "ignore downtime": a tail that is genuinely out must stay out.
  const s = withCheck(startedAirline(), 2);
  const grounded = s.fleet.find(a => a.status === 'maintenance');
  const routeId  = s.routes.find(r => r.aircraftId === grounded.id).id;
  const proj = withNoRolls(() => projectWeek(s));
  assert.ok(!(proj.report.routeResults ?? []).some(r => r.routeId === routeId),
    'the forecast flew an aircraft that will spend the week in the hangar');
});

test('an event in its FINAL week is not in the projected week', () => {
  const base = startedAirline();
  const slump = { id: 'test-slump', name: 'Demand slump', weeksLeft: 1, effects: { globalDemandMult: 0.7 } };
  const withEvent = { ...base, activeEvents: [slump] };
  const clean = withNoRolls(() => projectWeek(base));
  const spent = withNoRolls(() => projectWeek(withEvent));
  assert.equal(routeOp(spent.report), routeOp(clean.report),
    `tickEvents drops an event with weeksLeft <= 1 before the week runs, so this shock is `
    + `already over — the projection charged ${money(routeOp(clean.report) - routeOp(spent.report))} for it anyway`);
});

test('an event with weeks still to run IS in the projected week', () => {
  const base = startedAirline();
  const slump = { id: 'test-slump', name: 'Demand slump', weeksLeft: 3, effects: { globalDemandMult: 0.7 } };
  const clean = withNoRolls(() => projectWeek(base));
  const live  = withNoRolls(() => projectWeek({ ...base, activeEvents: [slump] }));
  assert.ok(routeOp(live.report) < routeOp(clean.report),
    'a live demand slump has to show up in the forecast');
});

test('a fully hedged airline is not shown the unhedged fuel spike', () => {
  // The reducer folds the shock into the INDEX and then blends hedges against
  // it, because a spike and a high index are the same commodity move. The
  // projection used to multiply it on AFTER the blend, so holding a hedge
  // through the one event it exists for did nothing to the forecast.
  const base = startedAirline();
  const spike = { id: 'test-spike', name: 'Fuel spike', weeksLeft: 3, effects: { fuelMult: 1.5 } };
  const hedged = {
    ...base,
    activeEvents: [spike],
    hedgeContracts: [{
      id: 'h1', coverage: 1.0, lockedPrice: base.fuelPrice?.index ?? 1.0,
      startAbsWeek: 0, expiryAbsWeek: 9999,
    }],
  };
  const unhedged = { ...base, activeEvents: [spike] };
  const h = withNoRolls(() => projectWeek(hedged));
  const u = withNoRolls(() => projectWeek(unhedged));
  assert.ok(h.fuelMultiplier < u.fuelMultiplier,
    `the hedge did nothing to the projected fuel price (${h.fuelMultiplier.toFixed(3)} vs `
    + `${u.fuelMultiplier.toFixed(3)}) — the shock is being applied after the hedge blend`);
  const s = withNoRolls(() => gameReducer(hedged, { type: 'ADVANCE_WEEK' }));
  assert.equal(routeOp(h.report), routeOp(s.lastReport),
    'and the hedged projection must equal the hedged week the reducer actually runs');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
