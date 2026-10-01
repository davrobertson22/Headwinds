// Route Finder demand must be the demand the Route Planner shows.
//
//   Dunno23  "in the world 'timely takeoff' the route finder function will say
//            that a route has, for example, 6000 weekly demand, but then when
//            you put it into the route planner, it says there's only a weekly
//            demand of 300, and it appears that that one is correct"
//                                                        (Discord, 2026-09-29)
//
// The finder printed baseCityPairDemand — the classic, modern-day pool — while
// the planner prints buildRouteMarket: that pool × the month's seasonality × the
// world's demand growth. In an era world growth IS the era traffic index (1950
// plays at ~5% of today), which is the 20× gap he saw; in a long-running classic
// world it runs the other way (growth compounds up to 3×). Same pair, same week,
// two numbers — so the finder now prints the planner's.
//
//   node --import ./tools/_register-loader.mjs tools/route-finder-demand-test.mjs

import assert from 'node:assert/strict';
import { findCandidates } from '../src/models/routeFinder.js';
import { buildRouteMarket } from '../src/models/demand.js';
import { currentGameDate, baseCityPairDemand } from '../src/utils/simulation.js';
import { setEraStartYear } from '../src/utils/market.js';

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const plannerDemand = (state, o, d) => {
  const m = buildRouteMarket(o, d, currentGameDate(state));
  return m.leisureDemand + m.businessDemand;
};
const rowsFor = (state) => findCandidates(state, { origin: 'JFK', groupMetros: false, hideServedLanes: false });
const SAMPLE = ['LAX', 'ORD', 'LHR', 'MIA', 'SFO'];

function check(state, label) {
  const rows = rowsFor(state);
  for (const code of SAMPLE) {
    const row = rows.find((r) => r.code === code);
    assert.ok(row, `${label}: JFK–${code} missing from the finder`);
    assert.equal(row.demand, plannerDemand(state, 'JFK', code), `${label}: JFK–${code} finder vs planner`);
  }
}

console.log('\n── Route Finder demand = Route Planner demand ──────────');

test('a 1950 era world: the finder prints the era-scaled market, not the modern pool', () => {
  setEraStartYear(1950);
  try {
    const st = { week: 10, year: 1, routes: [], competitors: [], startYear: 1950 };
    check(st, '1950');
    const row = rowsFor(st).find((r) => r.code === 'LAX');
    assert.ok(row.demand < baseCityPairDemand('JFK', 'LAX') * 0.2,
      `1950 demand should be a small fraction of today's (${row.demand} vs ${baseCityPairDemand('JFK', 'LAX')})`);
  } finally { setEraStartYear(null); }
});

test('a classic world twenty years in: growth is counted too', () => {
  check({ week: 30, year: 21, routes: [], competitors: [] }, 'classic y21');
});

test('seasonality matches the month the planner prices', () => {
  check({ week: 2, year: 1, routes: [], competitors: [] }, 'January');
  check({ week: 30, year: 1, routes: [], competitors: [] }, 'July');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
