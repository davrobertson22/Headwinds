// Cost bridge — guards the 2026-07-31 report ("52% route margin vs 28% company
// margin, with no bridge between them").
//
// The bridge must do two things and this file pins both:
//
//   1. START on the number the player is looking at. Dashboard's existing bridge
//      opened with the sum of routeResults.profit — which EXCLUDES lease and
//      maintenance — while the Routes page (and the Top Routes table beside it)
//      shows those deducted. So the row a player was meant to reconcile FROM
//      matched nothing on their screen.
//   2. RECONCILE EXACTLY. Every itemised row must add up to the canonical
//      projection's own EBITDA and net. `residual` is the money the breakdown
//      cannot explain; if someone adds a cost line to weeklyTick's totalCost and
//      forgets this module, residual goes non-zero and this test fails rather
//      than the money quietly disappearing into a rounding-shaped hole.
//
//   node tools/pnl-bridge-test.mjs

import assert from 'node:assert/strict';
import { costBridge } from '../packages/engine/src/utils/pnlBridge.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { DEFAULT_LABOR_STATE } from '../packages/engine/src/data/labor.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nCost bridge\n');

const NB = getAircraftType('b737800');
const PAIRS = [['LAX', 47], ['SAN', 41], ['BUR', 48], ['SEA', 19]];

/**
 * An SFO-hubbed carrier shaped like the reported save: several mature routes at
 * the reference fare, a T2 hub, staff, marketing and a loyalty programme running
 * — so every bucket in the ladder is non-zero and the reconciliation is actually
 * being exercised rather than trivially satisfied by a pile of empty rows.
 *
 * @param {object} [opts]
 * @param {number} [opts.idleAircraft]  extra tails that fly nothing
 */
function makeState({ idleAircraft = 0 } = {}) {
  const fleet = [], routes = [], routePricing = {};
  PAIRS.forEach(([dest, freq], i) => {
    fleet.push({ id: `a${i}`, typeId: NB.id, status: 'assigned', ageWeeks: 150,
                 config: defaultConfig(NB.seats), ownershipType: 'leased',
                 weeklyLease: NB.weeklyLease, leaseRemainingWeeks: 200 });
    routes.push({ id: `r${i}`, origin: 'SFO', destination: dest, aircraftId: `a${i}`,
                  weeklyFrequency: freq, weeksOpen: 40 });
    routePricing[['SFO', dest].sort().join('-')] =
      defaultClassPrices(Math.round(referencePrice('SFO', dest)));
  });
  for (let k = 0; k < idleAircraft; k++) {
    fleet.push({ id: `idle${k}`, typeId: NB.id, status: 'active', ageWeeks: 150,
                 config: defaultConfig(NB.seats), ownershipType: 'leased',
                 weeklyLease: NB.weeklyLease, leaseRemainingWeeks: 200 });
  }
  return {
    fleet, routes, cargoRoutes: [],
    week: 20, year: 1, cash: 5e7,
    gates: { SFO: 40, LAX: 8, SAN: 8, BUR: 8, SEA: 8 },
    hubs: { SFO: { tier: 2, tierSince: 0 } },
    routePricing, routeCatering: {}, competitors: [],
    loyalty: { members: 40_000, weeklyInvestment: 120_000, maturity: 0.6 },
    marketingBudget: 300_000,
    targetedMarketing: { SFO: 80_000 },
    campaignStrength: { SFO: 40 },
    allianceMembership: null,
    // weeklyTick skips payroll entirely when `labor` is absent, which would leave
    // the staff bucket empty and quietly weaken the reconciliation.
    labor: DEFAULT_LABOR_STATE,
    awareness: 52,
    activeEvents: [],
  };
}

// ── 1. Every row is exercised ────────────────────────────────────────────────

test('the fixture actually fills the buckets it claims to test', () => {
  const state = makeState();
  const b = costBridge(projectWeek(state), state);
  const has = (k) => b.rows.some(r => r.key === k && r.value !== 0);
  for (const k of ['revenue', 'direct', 'ownFlying', 'gates', 'labour', 'overhead', 'brand', 'distribution']) {
    assert.ok(has(k), `bucket "${k}" is empty — this test would pass vacuously`);
  }
});

// ── 2. It reconciles, to the cent ────────────────────────────────────────────

test('the itemised rows explain EBITDA exactly — nothing unattributed', () => {
  const state = makeState();
  const b = costBridge(projectWeek(state), state);
  assert.equal(b.residual, 0,
    `$${b.residual.toLocaleString()} of cost is not named by any row. A cost line `
    + 'was almost certainly added to weeklyTick without being added to pnlBridge.js');
});

test('the ladder sums to the projection\'s own net profit', () => {
  const state = makeState();
  const proj = projectWeek(state);
  const b = costBridge(proj, state);
  const walked = b.rows
    .filter(r => r.kind === 'income' || r.kind === 'cost')
    .reduce((s, r) => s + r.value, 0);
  assert.ok(Math.abs(walked - b.netProfit) <= 1,
    `walking every row lands on $${walked.toLocaleString()} but the projection `
    + `says $${b.netProfit.toLocaleString()} — the bridge disagrees with the P&L`);
  assert.equal(b.netProfit, Math.round(proj.netCash),
    'the bottom line must BE the projection\'s, not a second opinion');
});

// ── 3. The anchor row is the one on the Routes page ──────────────────────────

test('route operating profit has lease + maintenance already deducted', () => {
  // The defect this module replaces: Dashboard's bridge opened with
  // Σ routeResults.profit, which is BEFORE fleet ownership, and called it the
  // figure shown in the table beside it.
  const state = makeState();
  const proj  = projectWeek(state);
  const b     = costBridge(proj, state);
  const rawRouteProfit = (proj.report.routeResults ?? [])
    .reduce((s, rr) => s + (rr.profit ?? 0), 0) + (proj.report.totalCargoProfit ?? 0);
  assert.ok(b.routeOperating < rawRouteProfit,
    'the anchor must be the fully-loaded figure, not the pre-ownership one');
  const ownFlying = -b.rows.find(r => r.key === 'ownFlying').value;
  assert.ok(Math.abs((rawRouteProfit - ownFlying) - b.routeOperating) <= 2,
    'and the gap between them must be exactly the flying fleet\'s lease + maintenance');
});

test('route margin and net margin are both reported, off the same revenue', () => {
  const state = makeState();
  const b = costBridge(projectWeek(state), state);
  assert.ok(b.routeMargin > b.netMargin,
    'the whole point is that the route figure flatters the company figure');
  assert.equal(b.rows.find(r => r.key === 'routeOperating').margin, b.routeMargin);
  assert.equal(b.rows.find(r => r.key === 'net').margin, b.netMargin);
});

// ── 4. Parked aircraft are visible, not buried ───────────────────────────────

test('a parked aircraft shows as its own line, not smeared into overhead', () => {
  const flying = costBridge(projectWeek(makeState()), makeState());
  const s2 = makeState({ idleAircraft: 2 });
  const idle = costBridge(projectWeek(s2), s2);
  const row = idle.rows.find(r => r.key === 'ownParked');
  assert.ok(row && row.value < 0,
    'two leased aircraft flying nothing must appear somewhere a player can see');
  assert.ok(!flying.rows.some(r => r.key === 'ownParked'),
    'and the row must stay hidden when every aircraft is working');
  assert.ok(idle.netProfit < flying.netProfit,
    'idle tails cost real money');
  assert.equal(idle.residual, 0, 'still reconciles with parked aircraft in the fleet');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
