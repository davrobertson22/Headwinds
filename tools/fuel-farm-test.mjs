// Fuel operations Phase 5 (FUEL_OPERATIONS_PLAN.md §8): fuel farms — a
// consortium stake or an owned farm at a station, the discount on your own
// uplift there, the one-owner-per-airport race, and the throughput fee.
//
// Verified failing on HEAD (2026-09-20) via a probe on HEAD's own APIs:
// BUY_FUEL_STAKE / BUILD_FUEL_FARM / CLOSE_FUEL_FARM return state unchanged
// and the tick charges the same station factor whatever state.fuelFarms says.
//
//   node tools/fuel-farm-test.mjs

import assert from 'node:assert/strict';
import {
  FARM_LEVELS, FARM_HOST_FEE_PCT, FARM_ALLIANCE_SHARE, FARMS_PER_AIRCRAFT,
  farmCapex, farmWeeklyOpex, totalFarmWeeklyCost, farmCloseRefund, farmEfficiency, farmDiscount,
  ownDeparturesAt, ownedFarmCap, canTakeFarm, makeFarm, farmDiscountsOf, farmFeeOn, publicFarmsOf,
} from '../packages/engine/src/data/fuelFarm.js';
import {
  stationFuelBasis, effectiveStationBasis, setFuelStationsEnabled, setFuelStationDiscounts, FUEL_OPS_VERSION,
} from '../packages/engine/src/data/fuelStations.js';
import { costBridge } from '../packages/engine/src/utils/pnlBridge.js';
import { gameReducer } from '../packages/engine/index.mjs';
import { runScenario, makeRng } from './golden-master/harness.mjs';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const s60 = runScenario({ weeks: 60 });          // a v2 airline (START_GAME stamps it), JFK–LAX at 7×
// Enough departures at JFK for a farm, and the cash to pay for one.
const HUBBY = {
  ...s60, cash: 1_000_000_000,
  routes: s60.routes.map(r => ({ ...r, weeklyFrequency: 21 })),
};

console.log('\nThe data\n');

test('capex scales with the airport and a farm is four stakes', () => {
  assert.equal(farmCapex(1, 'JFK'), 80_000_000);
  assert.equal(farmCapex(2, 'JFK'), 320_000_000);
  assert.equal(farmCapex(1, 'BOS'), 30_000_000);
  assert.equal(farmCapex(1, 'FAT'), 8_000_000);
  const stake = makeFarm('JFK', 1, 10, farmCapex(1, 'JFK'));
  const farm  = makeFarm('JFK', 2, 10, farmCapex(2, 'JFK'));
  assert.equal(farmWeeklyOpex(stake), 80_000);
  assert.equal(farmWeeklyOpex(farm), 480_000);
  assert.equal(totalFarmWeeklyCost({ JFK: stake, BOS: makeFarm('BOS', 1, 10, 30e6) }), 80_000 + 30_000);
  assert.equal(farmCloseRefund(farm), 80_000_000);
});

test('a stake discounts at once; a farm ramps 60% → 100% over 26 weeks', () => {
  const stake = makeFarm('JFK', 1, 100, 80e6);
  assert.equal(farmEfficiency(stake, 100), 1);
  assert.equal(farmDiscount(stake, 100), 0.04);
  const farm = makeFarm('JFK', 2, 100, 320e6);
  assert.ok(near(farmEfficiency(farm, 100), 0.6, 1e-9));
  assert.ok(near(farmEfficiency(farm, 113), 0.8, 1e-9));
  assert.equal(farmEfficiency(farm, 126), 1);
  assert.equal(farmEfficiency(farm, 500), 1);
  assert.equal(farmDiscount(farm, 100), 0.06);
  assert.equal(farmDiscount(farm, 126), 0.10);
});

test('departures count every route touching the station, from both ends', () => {
  assert.equal(ownDeparturesAt(s60, 'JFK'), 7);
  assert.equal(ownDeparturesAt(s60, 'LAX'), 7);
  assert.equal(ownDeparturesAt(s60, 'BOS'), 0);
  assert.equal(ownDeparturesAt(HUBBY, 'JFK'), 21);
});

test('the owned-farm cap is one per 25 aircraft, never below one', () => {
  assert.equal(ownedFarmCap({ fleet: [] }), 1);
  assert.equal(ownedFarmCap({ fleet: Array.from({ length: 24 }, () => ({})) }), 1);
  assert.equal(ownedFarmCap({ fleet: Array.from({ length: 50 }, () => ({})) }), 2);
  assert.equal(ownedFarmCap({ fleet: Array.from({ length: 200 }, () => ({})) }), 8);
  assert.equal(FARMS_PER_AIRCRAFT, 25);
});

console.log('\ncanTakeFarm: what the button says is what the reducer does\n');

test('a stake needs 20 departures, a farm 60; the reasons name the shortfall', () => {
  const st = canTakeFarm(HUBBY, 'JFK', 1);
  assert.ok(st.ok, st.reasons.join(' | '));
  assert.equal(st.capex, 80_000_000);
  const farm = canTakeFarm(HUBBY, 'JFK', 2);
  assert.equal(farm.ok, false);
  assert.match(farm.reasons[0], /60 weekly departures/);
  const none = canTakeFarm(HUBBY, 'BOS', 1);
  assert.match(none.reasons[0], /you fly 0/);
});

test('a classic save cannot take a farm at all', () => {
  const { fuelOpsV: _v, ...classic } = HUBBY;
  const r = canTakeFarm(classic, 'JFK', 1);
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /not on/);
});

test('cash, the rival owner and the cap all refuse', () => {
  const busy = { ...HUBBY, routes: HUBBY.routes.map(r => ({ ...r, weeklyFrequency: 60 })) };
  assert.ok(canTakeFarm(busy, 'JFK', 2).ok, 'fixture can build');
  const poor = { ...busy, cash: 1000 };
  assert.match(canTakeFarm(poor, 'JFK', 2).reasons[0], /Not enough cash/);
  const taken = { ...busy, competitors: [{ id: 'x', name: 'Bob Airways', fuelFarms: { JFK: 2 } }] };
  assert.match(canTakeFarm(taken, 'JFK', 2).reasons[0], /Bob Airways already owns/);
  assert.ok(canTakeFarm(taken, 'JFK', 1).ok, 'a stake is still allowed where a rival owns the farm');
  const capped = { ...busy, fuelFarms: { LAX: makeFarm('LAX', 2, 1, 320e6) } };   // 1 aircraft → cap 1
  assert.match(canTakeFarm(capped, 'JFK', 2).reasons[0], /capped/);
});

test('upgrading a stake to a farm pays only the difference', () => {
  const busy = { ...HUBBY, routes: HUBBY.routes.map(r => ({ ...r, weeklyFrequency: 60 })), fuelFarms: { JFK: makeFarm('JFK', 1, 1, 80e6) } };
  const up = canTakeFarm(busy, 'JFK', 2);
  assert.ok(up.ok, up.reasons.join(' | '));
  assert.equal(up.capex, 320e6 - 80e6);
  assert.equal(up.fullCapex, 320e6);
  assert.match(canTakeFarm(busy, 'JFK', 1).reasons[0], /already hold/);
});

console.log('\nThe reducer\n');

test('BUY_FUEL_STAKE takes the capex and records the farm; CLOSE refunds a quarter', () => {
  const a = gameReducer(HUBBY, { type: 'BUY_FUEL_STAKE', code: 'JFK' });
  assert.equal(a.cash, HUBBY.cash - 80e6);
  assert.deepEqual(a.fuelFarms.JFK, { code: 'JFK', level: 1, builtAbsWeek: 61, capex: 80e6 });
  const again = gameReducer(a, { type: 'BUY_FUEL_STAKE', code: 'JFK' });
  assert.equal(again.cash, a.cash, 'a second stake is refused');
  const c = gameReducer(a, { type: 'CLOSE_FUEL_FARM', code: 'JFK' });
  assert.equal(c.cash, a.cash + 20e6);
  assert.ok(!('JFK' in c.fuelFarms));
  assert.equal(gameReducer(a, { type: 'CLOSE_FUEL_FARM', code: 'BOS' }), a);
});

test('BUILD_FUEL_FARM refuses where a rival owns, and upgrades a stake for the difference', () => {
  const busy = { ...HUBBY, routes: HUBBY.routes.map(r => ({ ...r, weeklyFrequency: 60 })) };
  const taken = { ...busy, competitors: [{ id: 'x', name: 'Bob Airways', fuelFarms: { JFK: 2 } }] };
  const r = gameReducer(taken, { type: 'BUILD_FUEL_FARM', code: 'JFK' });
  assert.equal(r.cash, taken.cash);
  assert.ok(!r.fuelFarms?.JFK);
  assert.match(r.pendingToasts.at(-1).message, /already owns/);
  const staked = gameReducer(busy, { type: 'BUY_FUEL_STAKE', code: 'JFK' });
  const farm = gameReducer(staked, { type: 'BUILD_FUEL_FARM', code: 'JFK' });
  assert.equal(farm.cash, staked.cash - (320e6 - 80e6));
  assert.equal(farm.fuelFarms.JFK.level, 2);
  assert.equal(farm.fuelFarms.JFK.capex, 320e6);
});

console.log('\nThrough the tick\n');

function tickWith(state, seed, extra = {}) {
  const orig = Math.random;
  Math.random = makeRng(seed);
  try { return gameReducer(state, { type: 'ADVANCE_WEEK', ...extra }); } finally { Math.random = orig; }
}

test('a stake at JFK lowers the JFK half of every route out of JFK by 4%, and charges its opex', () => {
  const bare = tickWith(HUBBY, 0xFA12);
  const staked = tickWith(gameReducer(HUBBY, { type: 'BUY_FUEL_STAKE', code: 'JFK' }), 0xFA12);
  const f0 = bare.lastReport.routeResults[0].fuelStationFactor;
  const f1 = staked.lastReport.routeResults[0].fuelStationFactor;
  const bJ = stationFuelBasis('JFK'), bL = stationFuelBasis('LAX');
  assert.ok(near(f0, (bJ + bL) / 2, 1e-4));
  assert.ok(near(f1, (bJ * 0.96 + bL) / 2, 1e-4), `factor ${f1}`);
  assert.equal(staked.lastReport.totalFuelFarmCosts, 80_000);
  assert.ok(!('totalFuelFarmCosts' in bare.lastReport));
  assert.ok(staked.lastReport.fuelByStation.JFK < bare.lastReport.fuelByStation.JFK);
  // The price multiplier and the LAX half are untouched.
  assert.equal(staked.lastReport.fuelMultiplier, bare.lastReport.fuelMultiplier);
  assert.ok(near(staked.lastReport.fuelByStation.LAX, bare.lastReport.fuelByStation.LAX, 1), 'LAX half unchanged (to the rounding dollar)');
});

test('the discount knob is set from state, so a foreign preview cannot inherit it', () => {
  gameReducer(gameReducer(HUBBY, { type: 'BUY_FUEL_STAKE', code: 'JFK' }), { type: 'CLEAR_TOASTS' });
  assert.ok(near(effectiveStationBasis('JFK'), stationFuelBasis('JFK') * 0.96, 1e-4), 'knob set by the last reducer call');
  gameReducer(HUBBY, { type: 'CLEAR_TOASTS' });
  assert.equal(effectiveStationBasis('JFK'), stationFuelBasis('JFK'), 'and cleared by a state with no farms');
});

test('farm fee income books as operating revenue and the bridge still reconciles', () => {
  const without = tickWith(HUBBY, 0xFEE5);
  const withFee = tickWith(HUBBY, 0xFEE5, { incomingFarmFees: 1_000_000 });
  assert.equal(withFee.lastReport.totalFarmFeeIncome, 1_000_000);
  assert.equal(withFee.lastReport.totalRevenue - without.lastReport.totalRevenue, 1_000_000);
  assert.equal(withFee.financialHistory.at(-1).farmFees, 1_000_000);
  assert.ok(!('farmFees' in without.financialHistory.at(-1)));
  // The week's cash movement grows by the fee less tax on it (21% on positive
  // EBT, if any). Compared on the report's own cashDelta rather than state.cash:
  // the golden scenario runs with objectives on, and a revenue milestone can
  // pay a bonus the moment the fee tips it over.
  const dCash = withFee.lastReport.cashDelta - without.lastReport.cashDelta;
  assert.ok(dCash >= 790_000 && dCash <= 1_000_000, `cashDelta moved ${dCash}`);
  // The bridge, over the same shape projectWeek hands it (report + EBITDA):
  // the fee has its own income row and nothing falls into "Other".
  const rep = withFee.lastReport;
  const bridge = costBridge({ report: rep, ebitda: Math.round(rep.totalRevenue - rep.totalCost) }, withFee);
  const farmRow = bridge.rows.find(r => r.key === 'farmFees');
  assert.ok(farmRow && farmRow.value === 1_000_000, 'bridge has the farm-fee income row');
  assert.ok(Math.abs(bridge.residual) <= 2, `unattributed residual ${bridge.residual}`);
  const bare = costBridge({ report: without.lastReport, ebitda: Math.round(without.lastReport.totalRevenue - without.lastReport.totalCost) }, without);
  assert.ok(!bare.rows.some(r => r.key === 'farmFees'));
});

console.log('\nAlliances and fees\n');

test('allied rivals\' farms give half the discount; own farms win over an ally\'s', () => {
  const st = {
    fuelOpsV: 2, year: 2, week: 10,
    allianceMembership: { allianceId: 'A' },
    fuelFarms: { JFK: makeFarm('JFK', 1, 1, 80e6) },
    competitors: [
      { id: 'a', allianceId: 'A', fuelFarms: { LAX: 2, JFK: 2 } },
      { id: 'b', allianceId: 'B', fuelFarms: { BOS: 2 } },
    ],
  };
  const d = farmDiscountsOf(st, 62);
  assert.equal(d.JFK, 0.04, 'own stake, not the ally\'s farm');
  assert.equal(d.LAX, 0.05, 'ally\'s farm at half');
  assert.ok(!('BOS' in d), 'a stranger\'s farm gives nothing');
});

test('the fee is 3% of a rival\'s uplift, half for an ally, never negative', () => {
  assert.equal(FARM_HOST_FEE_PCT, 0.03);
  assert.equal(farmFeeOn(1_000_000), 30_000);
  assert.equal(farmFeeOn(1_000_000, { allied: true }), 15_000);
  assert.equal(farmFeeOn(-5), 0);
  assert.equal(farmFeeOn(NaN), 0);
  assert.equal(FARM_ALLIANCE_SHARE, 0.5);
});

test('the public view carries levels only', () => {
  assert.deepEqual(publicFarmsOf({ fuelFarms: { JFK: makeFarm('JFK', 2, 1, 320e6), BOS: makeFarm('BOS', 1, 1, 30e6) } }), { JFK: 2, BOS: 1 });
  assert.deepEqual(publicFarmsOf({}), {});
});

console.log('\nServer guard\n');

test('the guard admits a real airport code and nothing else', () => {
  assert.deepEqual(guardDecision('BUY_FUEL_STAKE', { code: 'JFK' }, {}), { code: 'JFK' });
  assert.deepEqual(guardDecision('BUILD_FUEL_FARM', { code: 'LAX' }, {}), { code: 'LAX' });
  assert.deepEqual(guardDecision('CLOSE_FUEL_FARM', { code: 'BOS' }, {}), { code: 'BOS' });
  assert.throws(() => guardDecision('BUILD_FUEL_FARM', { code: 'ZZZ' }, {}), GuardError);
  assert.throws(() => guardDecision('BUILD_FUEL_FARM', { code: 42 }, {}), GuardError);
});

setFuelStationsEnabled(false); setFuelStationDiscounts(null);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
