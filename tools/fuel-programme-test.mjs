// Fuel operations Phase 3 (FUEL_OPERATIONS_PLAN.md §6): the efficiency
// programme and winglet retrofits — burn levers for the players who won't
// trade hedges.
//
// The rule every assertion here serves: PRICE and BURN are separate factors.
// The sims get their product; the report, history and every hedge
// calculation keep the price alone. And a preview that reads the projected
// multiplier moves by exactly what the tick moves.
//
// Verified failing on HEAD (2026-09-19) via a probe on HEAD's own APIs:
// SET_FUEL_PROGRAMME and RETROFIT_WINGTIPS return state unchanged,
// prepareWeek has no fuelSimMultiplier, and projectRouteAddition defaults
// fuel to 1.0 whatever the index (state.fuelMultiplier is never written).
//
//   node tools/fuel-programme-test.mjs

import assert from 'node:assert/strict';
import {
  FUEL_PROGRAMMES, FUEL_PROGRAMME_MAP, fleetBurnMod, programmeMaintMod, programmeOtpDelta,
  programmeFailureMult, programmeWeeklyCost, programmeActivationCost, canActivateProgramme,
  programmeSavingsFromReport,
} from '../packages/engine/src/data/fuelProgrammes.js';
import {
  canRetrofitWingtips, wingtipRetrofitCost, fitWingtips, WINGTIP_RETROFIT_PREMIUM,
} from '../packages/engine/src/data/retrofits.js';
import { fuelSimMultiplierOf, fuelPriceMultiplierOf, resolveFuelForWeek } from '../packages/engine/src/utils/fuelOps.js';
import { prepareWeek } from '../packages/engine/src/utils/tickPrep.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { rollMechanicalFailures } from '../packages/engine/src/data/events.js';
import { isOutOfService } from '../packages/engine/src/data/maintenance.js';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { gameReducer } from '../packages/engine/index.mjs';
import { runScenario, makeRng } from './golden-master/harness.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const on = (state, ...ids) => ({
  ...state,
  fuelProgrammes: Object.fromEntries(ids.map(id => [id, { active: true, sinceAbsWeek: 1 }])),
});

const s60 = runScenario({ weeks: 60 });

console.log('\nThe programme catalogue\n');

test('every programme has a burn, a cost shape and at most one side effect', () => {
  assert.equal(FUEL_PROGRAMMES.length, 7);
  for (const p of FUEL_PROGRAMMES) {
    assert.ok(p.burn > 0 && p.burn <= 0.02, `${p.id} burn ${p.burn}`);
    assert.ok(p.oneOff && p.weekly, `${p.id} cost shape`);
    const effects = ['otpDelta', 'maintMod', 'failureMult', 'requires'].filter(k => p[k] != null);
    assert.ok(effects.length <= 1, `${p.id} has ${effects.length} side effects`);
  }
});

test('burn compounds to roughly eight percent with everything on', () => {
  const all = on(s60, ...FUEL_PROGRAMMES.map(p => p.id));
  const mod = fleetBurnMod(all);
  assert.ok(near(mod, 0.92, 0.005), `all on → ${mod}`);
  assert.equal(fleetBurnMod(s60), 1, 'nothing on is exactly 1');
  assert.equal(fleetBurnMod(on(s60, 'cost_index')), 0.98);
});

test('side effects read from the catalogue', () => {
  assert.equal(programmeOtpDelta(on(s60, 'cost_index')), 0.015);
  assert.equal(programmeOtpDelta(s60), 0);
  assert.equal(programmeMaintMod(on(s60, 'engine_wash')), 0.98);
  assert.ok(near(programmeMaintMod(on(s60, 'engine_wash', 'single_engine_taxi')), 0.98 * 1.01, 1e-6));
  assert.equal(programmeMaintMod(s60), 1);
  assert.equal(programmeFailureMult(on(s60, 'contingency_fuel')), 1.10);
  assert.equal(programmeFailureMult(s60), 1);
});

test('weekly and one-off costs scale with the fleet', () => {
  const tails = s60.fleet.filter(a => a.status !== 'retired').length;
  assert.ok(tails >= 1);
  assert.equal(programmeWeeklyCost(on(s60, 'flight_planning')), 400_000 + 1_500 * tails);
  assert.equal(programmeWeeklyCost(on(s60, 'engine_wash')), 6_000 * tails);
  assert.equal(programmeWeeklyCost(s60), 0);
  assert.equal(programmeActivationCost('weight_reduction', s60.fleet), 120_000 * tails);
  assert.equal(programmeActivationCost('single_engine_taxi', s60.fleet), 2_000_000);
  assert.equal(programmeActivationCost('cost_index', s60.fleet), 0);
});

console.log('\nSET_FUEL_PROGRAMME\n');

test('switching on takes the one-off and records the week; off is free', () => {
  const rich = { ...s60, cash: 50_000_000 };
  const a = gameReducer(rich, { type: 'SET_FUEL_PROGRAMME', id: 'single_engine_taxi', active: true });
  assert.equal(a.cash, rich.cash - 2_000_000);
  assert.equal(a.fuelProgrammes.single_engine_taxi.active, true);
  assert.equal(a.fuelProgrammes.single_engine_taxi.paid, 2_000_000);
  const again = gameReducer(a, { type: 'SET_FUEL_PROGRAMME', id: 'single_engine_taxi', active: true });
  assert.equal(again, a, 'already on is a no-op');
  const off = gameReducer(a, { type: 'SET_FUEL_PROGRAMME', id: 'single_engine_taxi', active: false });
  assert.equal(off.cash, a.cash, 'off costs nothing');
  assert.ok(!('single_engine_taxi' in off.fuelProgrammes));
});

test('cannot afford, no hub, unknown id', () => {
  const poor = { ...s60, cash: 100 };
  const r = gameReducer(poor, { type: 'SET_FUEL_PROGRAMME', id: 'single_engine_taxi', active: true });
  assert.ok(!r.fuelProgrammes?.single_engine_taxi, 'no cash, not started');
  assert.equal(r.cash, 100);
  const noHub = { ...s60, cash: 1e9, hubs: {} };
  const c = canActivateProgramme(noHub, 'apu_policy');
  assert.equal(c.ok, false);
  assert.match(c.reason, /hub/i);
  const r2 = gameReducer(noHub, { type: 'SET_FUEL_PROGRAMME', id: 'apu_policy', active: true });
  assert.ok(!r2.fuelProgrammes?.apu_policy);
  assert.equal(gameReducer(s60, { type: 'SET_FUEL_PROGRAMME', id: 'nope', active: true }), s60);
});

console.log('\nThrough the tick: price and burn stay apart\n');

function tickWith(state, seed) {
  const orig = Math.random;
  Math.random = makeRng(seed);
  try { return gameReducer(state, { type: 'ADVANCE_WEEK' }); } finally { Math.random = orig; }
}

test('a 2% burn programme cuts the fuel bill by 2% and leaves the price multiplier alone', () => {
  const off = tickWith(s60, 0xA11CE);
  const onS = tickWith(on(s60, 'cost_index'), 0xA11CE);
  const ratio = onS.lastReport.totalFuel / off.lastReport.totalFuel;
  assert.ok(near(ratio, 0.98, 0.002), `fuel ratio ${ratio}`);
  assert.equal(onS.lastReport.fuelMultiplier, off.lastReport.fuelMultiplier, 'the PRICE multiplier is untouched');
  assert.equal(onS.lastReport.fuelBurnMod, 0.98);
  assert.ok(near(onS.lastReport.fuelProgrammeSavings, off.lastReport.totalFuel - onS.lastReport.totalFuel, 2));
  assert.equal(programmeSavingsFromReport(onS.lastReport), onS.lastReport.fuelProgrammeSavings);
  assert.ok(!('fuelBurnMod' in off.lastReport), 'a save with nothing on carries no burn fields');
  assert.ok(!('totalFuelProgrammeCosts' in off.lastReport));
});

test('the reduced-cruise-speed programme costs punctuality through the labor channel', () => {
  const prepOff = prepareWeek(s60, { rollNewEvents: false });
  const prepOn  = prepareWeek(on(s60, 'cost_index'), { rollNewEvents: false });
  assert.equal(prepOn.tickInput.labor.eventOtpDelta, (prepOff.tickInput.labor?.eventOtpDelta ?? 0) + 0.015);
  assert.equal(prepOn.eventOtpDelta, prepOff.eventOtpDelta + 0.015);
});

test('engine washing trims maintenance by 2% and is charged per tail per week', () => {
  const off = tickWith(s60, 0xB0B);
  const onS = tickWith(on(s60, 'engine_wash'), 0xB0B);
  const ratio = onS.lastReport.totalMaintenance / off.lastReport.totalMaintenance;
  assert.ok(near(ratio, 0.98, 0.003), `maintenance ratio ${ratio}`);
  const tails = s60.fleet.filter(a => a.status !== 'retired').length;
  assert.equal(onS.lastReport.totalFuelProgrammeCosts, 6_000 * tails);
  assert.equal(onS.lastReport.totalCost - off.lastReport.totalCost,
    (onS.lastReport.totalMaintenance - off.lastReport.totalMaintenance)
    + (onS.lastReport.totalFuel - off.lastReport.totalFuel)
    + 6_000 * tails, 'the cost line reconciles');
});

test('statistical contingency fuel scales the failure odds, not the RNG sequence', () => {
  const fleet = s60.fleet;
  const orig = Math.random;
  try {
    Math.random = () => 0.999;   // above any weekly probability → never fails
    assert.equal(rollMechanicalFailures(fleet, 1.0, 1.1).length, 0);
    Math.random = () => 0.0;     // below any → every in-service tail fails
    assert.equal(rollMechanicalFailures(fleet, 1.0, 1.1).length,
      rollMechanicalFailures(fleet, 1.0, 1.0).length);
    // At a middling draw, the multiplier alone decides: 0 kills the odds,
    // a huge one makes every in-service tail fail.
    Math.random = () => 0.5;
    assert.equal(rollMechanicalFailures(fleet, 1.0, 0).length, 0);
    assert.equal(rollMechanicalFailures(fleet, 1.0, 1e9).length, fleet.filter(a => !isOutOfService(a)).length);
  } finally { Math.random = orig; }
});

console.log('\nPreviews agree with the tick\n');

test('the projected multiplier is price × burn, and the price is still there for the market note', () => {
  const proj = projectWeek(on(s60, 'cost_index', 'engine_wash'));
  assert.ok(near(proj.fuelMultiplier, proj.fuelPriceMultiplier * 0.98 * 0.99, 1e-6));
  assert.ok(near(proj.fuelBurnMod, 0.98 * 0.99, 1e-6));
  const bare = projectWeek(s60);
  assert.equal(bare.fuelMultiplier, bare.fuelPriceMultiplier, 'nothing on: one number');
  assert.equal(bare.fuelBurnMod, 1);
});

test('fuelSimMultiplierOf reproduces the prep for a state with no pending events', () => {
  const st = { ...on(s60, 'flight_planning'), activeEvents: [] };
  const prep = prepareWeek(st, { rollNewEvents: false });
  assert.equal(fuelSimMultiplierOf(st), prep.fuelSimMultiplier);
  assert.equal(fuelPriceMultiplierOf(st), prep.fuelMultiplier);
  assert.equal(fuelSimMultiplierOf(s60), prepareWeek(s60, { rollNewEvents: false }).fuelSimMultiplier);
});

test('the shared resolver is the prep, byte for byte, with a fuel shock in play', () => {
  const shocked = { ...s60, activeEvents: [{ id: 'x', name: 'x', weeksLeft: 3, effects: { fuelMult: 1.25 } }] };
  const prep = prepareWeek(shocked, { rollNewEvents: false });
  const r = resolveFuelForWeek(shocked, { fuelMult: 1.25 });
  assert.equal(r.currentFuelIndex, prep.currentFuelIndex);
  assert.equal(r.fuelMultiplier, prep.fuelMultiplier);
  assert.equal(fuelSimMultiplierOf(shocked), prep.fuelSimMultiplier, 'the preview ages the event and applies the same shock');
});

test('projectRouteAddition no longer forecasts fuel at par — the pre-existing planner bug', () => {
  // A fixture where the market is far from 1.0, so par and the truth differ.
  const dear = { ...s60, fuelPrice: { index: 1.45, history: [] }, activeEvents: [] };
  const aircraft = dear.fleet[0];
  const spec = { origin: 'JFK', destination: 'BOS', aircraft, weeklyFrequency: 7 };
  const p = projectRouteAddition(dear, spec);
  const atPar = projectRouteAddition(dear, { ...spec, fuelMultiplier: 1.0 });
  assert.ok(p && atPar, 'projection returned null');
  const fuelOf = (x) => x.mature?.fuelCost;
  assert.ok(Number.isFinite(fuelOf(p)) && Number.isFinite(fuelOf(atPar)), `no fuelCost on the projection (${Object.keys(p).join(', ')})`);
  assert.ok(near(fuelOf(p) / fuelOf(atPar), fuelSimMultiplierOf(dear), 0.002),
    `planner fuel ${fuelOf(p)} vs par ${fuelOf(atPar)}: ratio should be the live multiplier ${fuelSimMultiplierOf(dear)}`);
  assert.ok(fuelOf(p) > fuelOf(atPar) * 1.3, 'at a 1.45× index the planner must not quote par');
});

console.log('\nWinglet retrofits\n');

test('a bare a320ceo can be fitted at a 40% premium and its burn falls', () => {
  const tail = s60.fleet.find(a => a.typeId === 'a320ceo');
  assert.ok(tail, 'fixture has an a320ceo');
  const bare = { ...tail, hasWingtips: false, fuelMod: 1.0, rangeMod: 1.0 };
  const def = getAircraftType('a320ceo').configOptions.wingtips;
  assert.equal(wingtipRetrofitCost(bare), Math.round(def.cost * (1 + WINGTIP_RETROFIT_PREMIUM)));
  const q = canRetrofitWingtips([bare], 1e9);
  assert.ok(q.ok && q.eligible.length === 1 && q.capex === wingtipRetrofitCost(bare));
  const fitted = fitWingtips(bare);
  assert.equal(fitted.hasWingtips, true);
  assert.ok(near(fitted.fuelMod, def.fuelMod, 1e-6));
  assert.ok(near(fitted.rangeMod, def.rangeMod, 1e-6));
  assert.equal(fitWingtips(fitted), fitted, 'fitting twice is a no-op');
});

test('RETROFIT_WINGTIPS charges the quote, folds the modifiers, and refuses the impossible', () => {
  const tail = s60.fleet.find(a => a.typeId === 'a320ceo');
  const st = { ...s60, cash: 50_000_000, fleet: s60.fleet.map(a => a.id === tail.id ? { ...a, hasWingtips: false, fuelMod: 1.0, rangeMod: 1.0 } : a) };
  const after = gameReducer(st, { type: 'RETROFIT_WINGTIPS', aircraftIds: [tail.id] });
  const cost = wingtipRetrofitCost(st.fleet.find(a => a.id === tail.id));
  assert.equal(after.cash, st.cash - cost);
  const t2 = after.fleet.find(a => a.id === tail.id);
  assert.equal(t2.hasWingtips, true);
  assert.ok(t2.fuelMod < 1, 'burn modifier folded');
  // Again: nothing to fit.
  const again = gameReducer(after, { type: 'RETROFIT_WINGTIPS', aircraftIds: [tail.id] });
  assert.equal(again.cash, after.cash);
  assert.equal(again.fleet.find(a => a.id === tail.id).fuelMod, t2.fuelMod);
  // Broke: refused, untouched.
  const broke = { ...st, cash: 10 };
  const r = gameReducer(broke, { type: 'RETROFIT_WINGTIPS', aircraftIds: [tail.id] });
  assert.equal(r.cash, 10);
  assert.equal(r.fleet.find(a => a.id === tail.id).hasWingtips, false);
  // Unknown ids: no-op.
  assert.equal(gameReducer(st, { type: 'RETROFIT_WINGTIPS', aircraftIds: ['nope'] }), st);
});

test('a fitted tail burns less through the real tick', () => {
  const tail = s60.fleet.find(a => a.typeId === 'a320ceo');
  const bareState = { ...s60, fleet: s60.fleet.map(a => a.id === tail.id ? { ...a, hasWingtips: false, fuelMod: 1.0, rangeMod: 1.0 } : a) };
  const fittedState = { ...bareState, fleet: bareState.fleet.map(a => a.id === tail.id ? fitWingtips(a) : a) };
  const a = tickWith(bareState, 0xC0DE), b = tickWith(fittedState, 0xC0DE);
  const def = getAircraftType('a320ceo').configOptions.wingtips;
  assert.ok(near(b.lastReport.totalFuel / a.lastReport.totalFuel, def.fuelMod, 0.003),
    `fuel ratio ${b.lastReport.totalFuel / a.lastReport.totalFuel} vs ${def.fuelMod}`);
  assert.equal(a.lastReport.fuelMultiplier, b.lastReport.fuelMultiplier, 'a retrofit is burn, never price');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
