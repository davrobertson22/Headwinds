// Demand growth over game time — guards the 2026-08-13 rework (Dave: "if there
// are more factors we could add in to make demand more realistic, let me know"
// → chose country-level demand growth as a world ages).
//
// Air travel demand compounds as incomes rise, and it compounds fastest in
// emerging markets: India/SE Asia at 7–8%/yr, the mature US/EU/Japan at 1–2%.
// COUNTRY_DEMAND_GROWTH (market.js) carries the annual rates; pairDemandGrowth
// compounds them from the world's first week (absWeek 1) and buildRouteMarket
// multiplies the pair's demand pool by the result. gameDate.absWeek is attached
// by tickPrep's calendar block and currentGameDate — callers with a bare
// { week, month } gameDate get exactly 1, so historical fixtures are unchanged.
//
//   node tools/demand-growth-test.mjs
//
// VERIFIED FAILING ON HEAD: pairDemandGrowth / gameDate.absWeek do not exist on
// the pre-rework engine — a probe of the old call path shows buildRouteMarket
// returning identical demand for a year-1 and a year-10 world.

import assert from 'node:assert/strict';
import {
  pairDemandGrowth, COUNTRY_DEMAND_GROWTH, DEMAND_GROWTH_CAP,
} from '../packages/engine/src/utils/market.js';
import { buildRouteMarket } from '../packages/engine/src/models/demand.js';
import { currentGameDate } from '../packages/engine/src/utils/simulation.js';
import { prepareWeek } from '../packages/engine/src/utils/tickPrep.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nDemand growth over game time\n');

const YEARS = (n) => n * 52 + 1;   // absWeek at the start of year n+1

test('week one of a world is factor 1, everywhere', () => {
  for (const [a, b] of [['DEL', 'BOM'], ['JFK', 'LHR'], ['SGN', 'HAN'], ['CAI', 'DXB']]) {
    assert.equal(pairDemandGrowth(a, b, 1), 1);
    assert.equal(pairDemandGrowth(a, b, null), 1, 'no calendar → no growth');
    assert.equal(pairDemandGrowth(a, b, undefined), 1);
  }
});

test('emerging markets outgrow mature ones, at the table rates', () => {
  const india5 = pairDemandGrowth('DEL', 'BOM', YEARS(5));
  const us5    = pairDemandGrowth('JFK', 'LAX', YEARS(5));
  const gIN = COUNTRY_DEMAND_GROWTH.IN, gUS = COUNTRY_DEMAND_GROWTH.US;
  assert.ok(Math.abs(india5 - Math.pow(1 + gIN, 5)) < 0.01,
    `DEL-BOM at 5 years should be ~${Math.pow(1 + gIN, 5).toFixed(3)}, got ${india5.toFixed(3)}`);
  assert.ok(Math.abs(us5 - Math.pow(1 + gUS, 5)) < 0.01);
  assert.ok(india5 > us5 * 1.2, 'India must visibly outpace the US inside 5 years');
  // A mixed pair compounds the geometric mean of its two ends.
  const mixed = pairDemandGrowth('JFK', 'DEL', YEARS(5));
  assert.ok(mixed > us5 && mixed < india5, 'US–India sits between the two domestic rates');
});

test('growth is capped so old worlds stay playable', () => {
  assert.equal(pairDemandGrowth('DEL', 'BOM', YEARS(100)), DEMAND_GROWTH_CAP);
});

test('buildRouteMarket applies growth only when the calendar carries absWeek', () => {
  const now   = buildRouteMarket('DEL', 'BOM', { week: 1, month: 6 });
  const grown = buildRouteMarket('DEL', 'BOM', { week: 1, month: 6, absWeek: YEARS(5) });
  assert.equal(now.demandGrowth, 1);
  const expect = pairDemandGrowth('DEL', 'BOM', YEARS(5));
  assert.equal(grown.demandGrowth, expect);
  const totalNow   = now.leisureDemand + now.businessDemand;
  const totalGrown = grown.leisureDemand + grown.businessDemand;
  assert.ok(Math.abs(totalGrown - totalNow * expect) <= 2,
    `year-5 India pool should be ~${Math.round(totalNow * expect)}, got ${totalGrown}`);
});

test('metro member pairs still price identically under growth', () => {
  const gd = { week: 1, month: 6, absWeek: YEARS(7) };
  const a = buildRouteMarket('JFK', 'LHR', gd);
  const b = buildRouteMarket('EWR', 'LGW', gd);
  assert.equal(a.baseWeeklyDemand, b.baseWeeklyDemand);
  assert.equal(a.demandGrowth, b.demandGrowth);
});

test('the real calendar plumbs absWeek through: currentGameDate and prepareWeek agree', () => {
  const state = { week: 9, year: 3 };
  const cgd = currentGameDate(state);
  assert.equal(cgd.absWeek, 2 * 52 + 9, 'currentGameDate must expose the absolute week');
  const prepped = prepareWeek({
    week: 9, year: 3, fleet: [], routes: [], cargoRoutes: [], events: [],
  });
  assert.equal(prepped.gameDate.absWeek, 2 * 52 + 9,
    'tickPrep must stamp the same absolute week the previews use');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
