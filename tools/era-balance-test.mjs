// era-balance-test.mjs — Phase 2 of ERA_MODE_PLAN.md: the era economy.
//
// HEAD failure proof: before this phase, setEraStartYear did not exist and
// pairDemandGrowth ignored the era entirely — a "1950" world ran at the full
// modern demand pool (probe: JFK-ORD week-20 pool was ~35,500/wk with the era
// active, identical to classic; it must be ~1,900).
//
// This file IS the calibration surface the plan calls for. The anchors in
// data/era.js are tuned until this passes; changing them without re-running
// this is flying blind. Two checks per decade, per the plan:
//   1. LEVEL — the demand pool an era year supports must sit in a historically
//      plausible band (the load-factor check in pool form: pools size the
//      capacity the market can absorb).
//   2. RETURN ON CAPITAL — the era flagship must be profitable at the
//      reference fare, and the early-era RoC premium over the modern game is
//      capped. The ceiling is 8x today (γ_yield already softened from 0.31 to
//      0.20 to hold it); the phase-3 capital-pricing work (ERA_MODE_PLAN.md §6
//      — era new-build pricing, airframe life limits) is what ratchets it
//      further down. Tighten the ceiling there, don't loosen it here.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { simulateRoute, maintenanceMultiplier } from '../packages/engine/src/utils/simulation.js';
import { setFareIndex, setEraStartYear, referencePrice, pairDemandGrowth } from '../packages/engine/src/utils/market.js';
import { eraFareIndex, eraFuelMean, eraDemandIndex } from '../packages/engine/src/data/era.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';

const START = 1950;
const wk = (y) => (y - START) * 52 + 20;                  // week 20 of the given year

function eraOn(y) { setEraStartYear(START); setFareIndex(eraFareIndex(y)); }
function eraOff() { setEraStartYear(null); setFareIndex(1); }

function fly(y, typeId, o, d, freq) {
  const type = getAircraftType(typeId);
  const fuel = eraFuelMean(y) ?? 1;
  const r = simulateRoute(
    { origin: o, destination: d, aircraftId: 'x', weeklyFrequency: freq, ticketPrice: referencePrice(o, d), weeksOpen: 52 },
    { typeId, ageWeeks: 0 }, { week: 20, month: 5, absWeek: wk(y) }, null, fuel);
  if (!r) return null;
  const frames = Math.max(1, Math.ceil(freq / 14));
  const net = r.profit - (type.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(0) * frames;
  return { ...r, net, roc: net / (type.purchasePrice * frames) };
}

// Fit frequency to the pool so every decade is measured at comparable capacity.
function fitFly(y, typeId, o, d) {
  const probe = fly(y, typeId, o, d, 7);
  if (!probe) return null;
  const seats = getAircraftType(typeId).seats;
  const freq = Math.max(2, Math.min(70, Math.round(probe.marketDemand * 0.75 / seats)));
  return fly(y, typeId, o, d, freq);
}

const DECADES = [
  { y: 1950, type: 'dc3' }, { y: 1958, type: 'f27' }, { y: 1962, type: 'b707320' },
  { y: 1972, type: 'b727200' }, { y: 1980, type: 'b737200' }, { y: 1990, type: 'b737400' },
  { y: 2000, type: 'b737800' }, { y: 2010, type: 'b737800' }, { y: 2020, type: 'a320neo' },
];

test('era demand pools sit in plausible bands and rise monotonically', () => {
  // JFK-ORD as the reference trunk. 1950's busiest US routes moved a couple of
  // thousand passengers a week; the classic (2026-scale) pool is ~35K.
  const pools = [];
  for (const { y } of DECADES) {
    eraOn(y);
    const r = fly(y, 'b737800', 'JFK', 'ORD', 7) ?? fly(y, 'dc3', 'JFK', 'ORD', 7);
    pools.push({ y, pool: r.marketDemand });
  }
  eraOff();
  const at = (y) => pools.find(p => p.y === y).pool;
  assert.ok(at(1950) > 1000 && at(1950) < 4500, `1950 trunk pool ${Math.round(at(1950))}/wk`);
  assert.ok(at(1980) > 8000 && at(1980) < 18000, `1980 trunk pool ${Math.round(at(1980))}/wk`);
  assert.ok(at(2020) > 25000 && at(2020) < 50000, `2020 trunk pool ${Math.round(at(2020))}/wk`);
  for (let i = 1; i < pools.length; i++) {
    assert.ok(pools[i].pool > pools[i - 1].pool,
      `pool must rise with the era: ${pools[i - 1].y} ${Math.round(pools[i - 1].pool)} -> ${pools[i].y} ${Math.round(pools[i].pool)}`);
  }
});

test('the era demand factor is the absolute index, never the ratio-from-start', () => {
  setEraStartYear(1950);
  const g1950 = pairDemandGrowth('JFK', 'ORD', wk(1950));
  const g2020 = pairDemandGrowth('JFK', 'ORD', wk(2020));
  setEraStartYear(null);
  assert.ok(Math.abs(g1950 - eraDemandIndex(1950)) < 0.01, `1950 factor ${g1950} must be ~${eraDemandIndex(1950)}`);
  assert.ok(Math.abs(g2020 - eraDemandIndex(2020)) < 0.02, `2020 factor ${g2020} must be ~${eraDemandIndex(2020)}`);
  assert.ok(g2020 / g1950 > 10, 'the century still spans an order of magnitude of growth');
});

test('every era flagship clears its costs at the reference fare', () => {
  for (const { y, type } of DECADES) {
    eraOn(y);
    const r = fitFly(y, type, 'JFK', 'ORD');
    eraOff();
    assert.ok(r, `${y} ${type}: JFK-ORD must be in range`);
    assert.ok(r.net > 0, `${y} ${type}: net ${Math.round(r.net / 1000)}K must be positive`);
    assert.ok(r.loadFactor > 0.5, `${y} ${type}: LF ${(r.loadFactor * 100).toFixed(0)}%`);
  }
});

test('the early-era return-on-capital premium stays inside the ceiling', () => {
  // Route-level RoC per week on the reference trunk, era flagship vs the
  // modern game. Fixed overheads (marketing floor, HQ, insurance — all
  // constant-dollar) weigh far heavier on a 1950 revenue base, so the played
  // premium is materially below this route-level ratio; the ceiling still
  // guards against the "propliners print money" failure the consistency test
  // fought once already. Phase-3 capital pricing ratchets it down further.
  const CEILING = 8;
  eraOn(2020);
  const modern = fitFly(2020, 'a320neo', 'JFK', 'ORD');
  const rocs = [];
  for (const { y, type } of DECADES.slice(0, 6)) {
    eraOn(y);
    const r = fitFly(y, type, 'JFK', 'ORD');
    rocs.push({ y, roc: r.roc });
  }
  eraOff();
  for (const { y, roc } of rocs) {
    assert.ok(roc / modern.roc < CEILING,
      `${y}: RoC ${(roc * 100).toFixed(2)}%/wk is ${(roc / modern.roc).toFixed(1)}x modern (ceiling ${CEILING}x)`);
  }
});

test('the fare ladder is derived from the calendar and fits under the clamp', () => {
  for (let y = 1930; y <= 2100; y += 5) {
    const fi = eraFareIndex(y);
    assert.ok(fi > 0.25 && fi <= 2.0, `${y}: fareIndex ${fi} must survive setFareIndex's clamp`);
  }
  assert.equal(eraFareIndex(null), null, 'classic worlds never see an era fare');
  assert.ok(eraFareIndex(1950) > eraFareIndex(1990), 'real yield declines across the era');
});

test('the fuel century: cheap fifties, the 1973 and 1979 shocks, the glut, 2008', () => {
  assert.ok(eraFuelMean(1960) < 0.5, 'the fifties and sixties are cheap');
  assert.ok(eraFuelMean(1974) > eraFuelMean(1972) * 1.8, '1973 doubles the price of fuel');
  assert.ok(eraFuelMean(1981) > 1.4, 'the second shock peaks higher');
  assert.ok(eraFuelMean(1987) < 0.7, 'the glut deflates it');
  assert.ok(eraFuelMean(2008) > 1.8, '2008 is the all-time spike');
  assert.equal(eraFuelMean(2027), null, 'history ends at 2026 — the future is procedural');
  assert.equal(eraFuelMean(null), null, 'classic worlds never see the script');
});
