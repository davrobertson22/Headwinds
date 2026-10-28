// Brand marketing as a share of revenue — Discord ask 2026-10-27 ("Maintain
// marketing percentage of revenue").
//
// A player can pin brand spend to a percentage of weekly revenue instead of a
// fixed dollar figure, so the budget grows (and shrinks) with the airline and
// nobody has to keep re-typing it. Guards:
//
//   1. The tick charges pct × THIS week's reported revenue — the same basis as
//      the distribution line — so the P&L shows exactly the chosen share.
//   2. Targeted (per-airport) campaigns stay fixed dollars on top.
//   3. Awareness grows from what was actually spent, not the stale $ figure.
//   4. After the tick marketingBudget holds last week's actual brand spend, so
//      every screen that reads it shows a real number and switching back to a
//      fixed budget starts from there.
//   5. A fixed $ budget clears the percentage; the percentage is clamped.
//   6. An airline that never uses it is byte-identical (golden master): no
//      seeded key, no new report key.
//   7. The finance projection (weeklyTick under the hood) agrees with the tick.
//
//   node tools/marketing-pct-test.mjs

import assert from 'node:assert/strict';
import { weeklyTick, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { DEFAULT_LABOR_STATE } from '../packages/engine/src/data/labor.js';
import { marketingAwarenessGain } from '../packages/engine/src/data/overhead.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nBrand marketing as % of revenue\n');

const NB = getAircraftType('b737800');
const PAIRS = [['LAX', 47], ['SAN', 41], ['SEA', 19]];

function airline(extra = {}) {
  const fleet = [], routes = [], routePricing = {};
  PAIRS.forEach(([dest, freq], i) => {
    fleet.push({ id: `a${i}`, typeId: NB.id, status: 'assigned', ageWeeks: 150,
                 config: defaultConfig(NB.seats), ownershipType: 'leased',
                 weeklyLease: NB.weeklyLease, leaseRemainingWeeks: 200 });
    routes.push({ id: `r${i}`, origin: 'SFO', destination: dest, stops: ['SFO', dest],
                  aircraftId: `a${i}`, weeklyFrequency: freq, weeksOpen: 40 });
    routePricing[['SFO', dest].sort().join('-')] =
      defaultClassPrices(Math.round(referencePrice('SFO', dest)));
  });
  return {
    fleet, routes, cargoRoutes: [],
    week: 20, year: 1, cash: 5e7,
    gates: { SFO: 40, LAX: 8, SAN: 8, SEA: 8 },
    hubs: { SFO: { tier: 2, tierSince: 0 } },
    routePricing, routeCatering: {}, competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    marketingBudget: 123_456,
    targetedMarketing: { SFO: 50_000 },
    campaignStrength: {},
    allianceMembership: null,
    labor: DEFAULT_LABOR_STATE,
    awareness: 40,
    activeEvents: [],
    ...extra,
  };
}

// ── Tick ────────────────────────────────────────────────────────────────────

test('pct mode charges pct × this week\'s reported revenue, plus targeted campaigns', () => {
  const r = weeklyTick(airline({ marketingPctOfRevenue: 0.05 }));
  assert.ok(r.totalRevenue > 1_000_000, `airline earns something (${r.totalRevenue})`);
  const brand = Math.round(r.totalRevenue * 0.05);
  assert.equal(r.brandMarketingSpend, brand);
  assert.equal(r.totalMarketingSpend, brand + 50_000);
});

test('pct mode ignores the stale dollar figure', () => {
  const lo = weeklyTick(airline({ marketingPctOfRevenue: 0.03, marketingBudget: 1 }));
  const hi = weeklyTick(airline({ marketingPctOfRevenue: 0.03, marketingBudget: 9_999_999 }));
  assert.equal(lo.totalMarketingSpend, hi.totalMarketingSpend);
});

test('fixed mode is unchanged and adds no report key', () => {
  const r = weeklyTick(airline());
  assert.equal(r.totalMarketingSpend, 123_456 + 50_000);
  assert.ok(!('brandMarketingSpend' in r), 'golden parity: no new key in fixed mode');
});

test('0% is a real setting: no brand spend, campaigns still billed', () => {
  const r = weeklyTick(airline({ marketingPctOfRevenue: 0 }));
  assert.equal(r.brandMarketingSpend, 0);
  assert.equal(r.totalMarketingSpend, 50_000);
});

test('the cost is in totalCost (cash moves by exactly the difference)', () => {
  const a = weeklyTick(airline({ marketingPctOfRevenue: 0.02, targetedMarketing: {} }));
  const b = weeklyTick(airline({ marketingPctOfRevenue: 0.06, targetedMarketing: {} }));
  assert.equal(a.totalRevenue, b.totalRevenue, 'brand spend has no same-week demand effect (adstock)');
  assert.equal(b.totalCost - a.totalCost, b.brandMarketingSpend - a.brandMarketingSpend);
});

test('finance projection charges the same share of ITS revenue', () => {
  // projectWeek preps the state (season, events…) before calling weeklyTick,
  // so its revenue can differ from a bare tick — the share must not.
  const p = projectWeek(airline({ marketingPctOfRevenue: 0.04 }));
  assert.ok(p.report.totalRevenue > 0);
  assert.equal(p.report.brandMarketingSpend, Math.round(0.04 * p.report.totalRevenue));
  assert.equal(p.report.totalMarketingSpend, p.report.brandMarketingSpend + 50_000);
});

// ── Reducer ─────────────────────────────────────────────────────────────────

const { gameReducer, freshState, reconcileState } = await import('../packages/engine/src/reducer.mjs');
const playing = (extra = {}) => ({ ...freshState(), phase: 'playing', ...airline(), ...extra });

test('freshState seeds no pct key (golden parity)', () => {
  assert.ok(!('marketingPctOfRevenue' in freshState()));
});

test('SET_MARKETING_PCT sets the share; clamps to 0–25%; junk is refused', () => {
  const s = playing();
  assert.equal(gameReducer(s, { type: 'SET_MARKETING_PCT', pct: 0.045 }).marketingPctOfRevenue, 0.045);
  assert.equal(gameReducer(s, { type: 'SET_MARKETING_PCT', pct: 3 }).marketingPctOfRevenue, 0.25);
  assert.equal(gameReducer(s, { type: 'SET_MARKETING_PCT', pct: -1 }).marketingPctOfRevenue, 0);
  const junk = gameReducer(s, { type: 'SET_MARKETING_PCT', pct: 'abc' });
  assert.ok(!('marketingPctOfRevenue' in junk), 'NaN never reaches state');
});

test('SET_MARKETING_PCT with null switches back to fixed $', () => {
  const s = gameReducer(playing(), { type: 'SET_MARKETING_PCT', pct: 0.04 });
  const back = gameReducer(s, { type: 'SET_MARKETING_PCT', pct: null });
  assert.ok(!('marketingPctOfRevenue' in back));
  assert.equal(back.marketingBudget, s.marketingBudget, 'keeps the dollar figure');
});

test('a fixed $ budget clears the percentage', () => {
  const s = gameReducer(playing(), { type: 'SET_MARKETING_PCT', pct: 0.04 });
  const fixed = gameReducer(s, { type: 'SET_MARKETING_BUDGET', amount: 75_000 });
  assert.equal(fixed.marketingBudget, 75_000);
  assert.ok(!('marketingPctOfRevenue' in fixed));
});

test('ADVANCE_WEEK: awareness grows from the actual spend, and marketingBudget follows it', () => {
  const s0 = gameReducer(playing({ marketingBudget: 1 }), { type: 'SET_MARKETING_PCT', pct: 0.05 });
  const s1 = gameReducer(s0, { type: 'ADVANCE_WEEK' });
  const r  = s1.lastReport;
  assert.ok(r && r.totalRevenue > 0, 'the week ran');
  assert.equal(r.brandMarketingSpend, Math.round(r.totalRevenue * 0.05));
  assert.equal(s1.marketingBudget, r.brandMarketingSpend, 'the $ figure is last week\'s actual');
  assert.equal(s1.marketingPctOfRevenue, 0.05, 'and the mode persists');

  // Same week in fixed mode at $1: the pct airline must have gained more awareness.
  const f1 = gameReducer(playing({ marketingBudget: 1 }), { type: 'ADVANCE_WEEK' });
  assert.ok(s1.awareness > f1.awareness + 0.01,
    `awareness from real spend (${s1.awareness}) beats $1/wk (${f1.awareness})`);
  const diminishing = 1 - 40 / 100;
  const expectedGap = (marketingAwarenessGain(r.brandMarketingSpend, r.totalRevenue)
    - marketingAwarenessGain(1, f1.lastReport.totalRevenue)) * diminishing;
  // Stored awareness is rounded to 0.1 each side, so allow one step of slack.
  assert.ok(Math.abs((s1.awareness - f1.awareness) - expectedGap) <= 0.1 + 1e-9,
    `gap ${s1.awareness - f1.awareness} ≈ ${expectedGap}`);
});

test('a save with a pct loads it; a save without stays keyless', () => {
  assert.equal(reconcileState({ ...playing(), marketingPctOfRevenue: 0.03 }).marketingPctOfRevenue, 0.03);
  assert.ok(!('marketingPctOfRevenue' in reconcileState(playing())));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
