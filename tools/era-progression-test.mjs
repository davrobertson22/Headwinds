// era-progression-test.mjs — Phase 3 of ERA_MODE_PLAN.md: the anti-degeneration
// layer. Era-scaled progression (objectives, starting capital, cost floors),
// the airframe market lifetime, and the yearly stats rollup.
//
// HEAD failure proof (before this phase): a 1950 world seeded the full $15M
// (eraCapitalScale did not exist), objective checks compared raw 2026 literals
// (`revenue_500k` demanded $500K/wk from an airline whose whole market was 8%
// of modern), routeLaunchCost(1000) returned 62_000 whatever the era, and 106
// era ticks produced no statsHistoryYearly.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { eraRevenueScale, eraPaxScale, eraCapitalScale, eraOverheadScale } from '../packages/engine/src/data/era.js';
import { routeLaunchCost, setEraCostScale, getEraCostScale, liabilityInsuranceWeekly } from '../packages/engine/src/data/overhead.js';
import { OBJECTIVE_TEMPLATES, MULTIPLAYER_OBJECTIVE_TEMPLATES, objectiveDesc } from '../packages/engine/src/data/objectives.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { gateMonthlyFee, totalGateMonthlyFee, getAirport } from '../packages/engine/src/data/airports.js';
import { weeklyFamilyBaseCost } from '../packages/engine/src/data/families.js';
import { seedAirlineState } from '../apps/headwinds-server/src/lib/worldService.mjs';

test('the era money scales: null in classic, ramping through the century', () => {
  assert.equal(eraRevenueScale(null), null);
  assert.equal(eraCapitalScale(null), null);
  assert.ok(Math.abs(eraRevenueScale(1950) - 0.084) < 0.01);
  assert.ok(Math.abs(eraCapitalScale(1950) - 0.289) < 0.01);
  assert.ok(eraCapitalScale(1978) > 0.55 && eraCapitalScale(1978) < 0.70);
  assert.equal(eraCapitalScale(2026), 1, 'a 2026 era year is exactly the modern game');
  assert.equal(eraCapitalScale(2050), 1, 'capital never scales ABOVE modern');
  assert.ok(eraPaxScale(1950) < eraRevenueScale(1950), 'pax scale is the deeper cut (no fare premium)');
});

test('cost floors scale through the module knob and reset cleanly', () => {
  const classic = routeLaunchCost(1000);
  assert.equal(classic, 62_000);
  try {
    setEraCostScale(0.289);
    assert.equal(routeLaunchCost(1000), Math.round(62_000 * 0.289));
    assert.equal(liabilityInsuranceWeekly(getAircraftType('dc3')), Math.round(6_000 * 0.289));
    // Fixed overheads too (found in the 1950 playtest: a 62-seat Constellation
    // cannot carry $150K/wk of modern-dollar gate rent, wages and MRO contracts).
    const jfk = getAirport('JFK');
    assert.equal(gateMonthlyFee(jfk, 1), Math.round(gateMonthlyFee(jfk, 1) / 0.289 * 0.289));
    assert.ok(totalGateMonthlyFee(jfk, 2) < 0.3 * (() => { setEraCostScale(1); const v = totalGateMonthlyFee(jfk, 2); setEraCostScale(0.289); return v; })());
    const fleet = [{ id: 'a', typeId: 'dc3', status: 'idle' }];
    setEraCostScale(1); const famClassic = weeklyFamilyBaseCost(fleet);
    setEraCostScale(0.289);
    assert.ok(famClassic > 0 && Math.abs(weeklyFamilyBaseCost(fleet) - famClassic * 0.289) < 1, 'family MRO base scales');
  } finally {
    setEraCostScale(1);
  }
  assert.equal(routeLaunchCost(1000), classic, 'reset restores classic byte-identically');
});

test('the reducer sets the cost scale from state on every action', () => {
  const era = { ...freshState(), phase: 'playing', startYear: 1950, year: 1, week: 1 };
  gameReducer(era, { type: 'NOOP_UNKNOWN_ACTION' });
  assert.ok(Math.abs(getEraCostScale() - eraOverheadScale(1950)) < 1e-9, 'overheads run at the OVERHEAD scale (sqrt of capital)');
  assert.ok(Math.abs(eraOverheadScale(1950) - 0.537) < 0.01, `1950 overhead scale ${eraOverheadScale(1950)}`);
  assert.equal(eraOverheadScale(null), null);
  gameReducer({ ...freshState(), phase: 'playing' }, { type: 'NOOP_UNKNOWN_ACTION' });
  assert.equal(getEraCostScale(), 1, 'a classic action resets it — worlds cannot leak into each other');
});

test('objective thresholds, descriptions and rewards scale with the era', () => {
  const rev = OBJECTIVE_TEMPLATES.find(t => t.id === 'revenue_500k');
  const Mfn = (x) => Math.max(1_000, Math.round(x * 0.084 / 1_000) * 1_000);
  const Pfn = (x) => Math.max(100, Math.round(x * 0.054 / 100) * 100);
  assert.equal(rev.check({ lastReport: { totalRevenue: 450_000 } }), false, 'classic: literal holds');
  assert.equal(rev.check({ lastReport: { totalRevenue: 42_000 }, M: Mfn }), true, 'era: scaled target');
  assert.equal(objectiveDesc(rev), 'Generate $500K in a single week');
  assert.equal(objectiveDesc(rev, Mfn), 'Generate $42K in a single week');
  const pax = MULTIPLAYER_OBJECTIVE_TEMPLATES.find(t => t.id === 'mp_pax_1m');
  assert.equal(pax.check({ paxAllTime: 54_000, P: Pfn }), true);
  assert.equal(pax.check({ paxAllTime: 54_000 }), false);
  // Every scaled template can still complete in classic form — no desc drift.
  for (const t of [...OBJECTIVE_TEMPLATES, ...MULTIPLAYER_OBJECTIVE_TEMPLATES]) {
    if (t.descTemplate) {
      assert.ok(t.money != null || t.pax != null, `${t.id}: descTemplate without a threshold`);
      assert.ok(objectiveDesc(t).length > 0);
    }
  }
});

test('starting capital scales at seed; the admin knob stays modern-equivalent', () => {
  const mk = (sy) => ({
    id: 'w', worldSeed: 's', currentYear: 1, currentWeek: 1, lengthYears: 40,
    tickConfig: { startingCapital: 15_000_000, demandMultiplier: 1, ...(sy ? { startYear: sy } : {}) },
  });
  assert.equal(seedAirlineState(mk(null), { airlineName: 'A', hub: 'JFK' }).cash, 15_000_000);
  const c1950 = seedAirlineState(mk(1950), { airlineName: 'A', hub: 'JFK' }).cash;
  assert.equal(c1950, 4_000_000, `1950 capital ${c1950} — $4.34M floored to a whole million`);
  const c1978 = seedAirlineState(mk(1978), { airlineName: 'A', hub: 'JFK' }).cash;
  assert.equal(c1978, 9_000_000, `1978 capital ${c1978}`);
});

test('era worlds keep a yearly rollup; classic worlds never grow the field', () => {
  let era = { ...freshState(), phase: 'playing', cash: 50_000_000, startYear: 1950, multiplayer: true, fleet: [], routes: [], competitors: [] };
  for (let i = 0; i < 106; i++) era = gameReducer(era, { type: 'ADVANCE_WEEK' });
  assert.equal(era.statsHistoryYearly?.length, 2, 'two completed years → two rows');
  assert.deepEqual(era.statsHistoryYearly.map(r => r.label), ['1950', '1951']);
  assert.ok(era.statsHistoryYearly.every(r => 'revenue' in r && 'profit' in r && 'fleet' in r));
  let classic = { ...freshState(), phase: 'playing', cash: 50_000_000, multiplayer: true, fleet: [], routes: [], competitors: [] };
  for (let i = 0; i < 106; i++) classic = gameReducer(classic, { type: 'ADVANCE_WEEK' });
  assert.ok(!('statsHistoryYearly' in classic), 'classic blobs stay byte-identical');
});
