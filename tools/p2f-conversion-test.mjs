// Freighter conversions of a player's own passenger frames
// (claude/p2f-conversion.md; Discord: Barca, VodkaOnFire, 2026-11-03).
//
// The rules every assertion here serves:
//   • book value CARRIES FORWARD — the passenger airframe keeps its own
//     schedule and the conversion books on top, never repriced as the
//     freighter type (a 12-year-old 767-300 repriced as a 767-300F gained
//     $32M of collateral for a $17M conversion);
//   • the "+10 years" is an OPERATING-age credit: running cost, AOG repair
//     and the failure age term read real age − 10y; real age is untouched;
//   • the Fleet quote is what the reducer charges and books.
//
// Verified failing on HEAD (2026-11-05) via a probe on HEAD's own APIs: with
// the conversion done the only way HEAD could (swap typeId by hand), a
// 12-year-old 767-300's NAV and collateral went $25.2M → $57.6M (+$32.4M
// against a $17.3M conversion), and a 30-year-old A321P2F still paid the
// 30-year running-cost curve (5.5×). data/conversions.js did not exist.
//
//   node tools/p2f-conversion-test.mjs

import assert from 'node:assert/strict';
import {
  CONVERSIONS, conversionFor, conversionCost, conversionDowntimeWeeks, conversionRefusal,
  canConvertToFreighter, startConversion, completeConversion, P2F_AGE_CREDIT_WEEKS, CONVERSION_COST_PCT,
} from '../packages/engine/src/data/conversions.js';
import {
  tailBookValue, tailWeeklyDepreciation, valueRemaining, conversionCapexRemaining,
  CONVERSION_DEPRECIATION_YEARS, DEPRECIATION_YEARS, weeklyInsuranceCost, HULL_INSURANCE_ANNUAL_RATE,
  liabilityInsuranceWeekly,
} from '../packages/engine/src/data/overhead.js';
import {
  airframeNAV, saleQuote, aogAgeFactor, weeklyWearFailureProb, effectiveMaintAgeWeeks, operatingAgeWeeks,
} from '../packages/engine/src/data/maintenance.js';
import { aircraftBookValue } from '../packages/engine/src/data/credit.js';
import { balanceSheetBookValue } from '../packages/engine/src/utils/standings.js';
import { fleetWeeklyDepreciation } from '../packages/engine/src/utils/financeProjection.js';
import { maintenanceMultiplier } from '../packages/engine/src/utils/simulation.js';
import { getAircraftType, eraPurchasePrice, AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { AIRCRAFT_FAMILY } from '../packages/engine/src/data/families.js';
import {
  lineInfo, lineBookings, bookingsFromStates, capacityFor, lineGapWeeks, PRODUCTION_LINES,
} from '../packages/engine/src/data/productionLines.js';
import { absoluteWeek } from '../packages/engine/src/utils/fuel.js';
import { gameReducer } from '../packages/engine/index.mjs';
import { runScenario } from './golden-master/harness.mjs';
import { calcReputation } from '../packages/engine/src/models/reputation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const T = getAircraftType;
const W = (y) => Math.round(y * 52);
const tail = (typeId, years, extra = {}) => ({
  id: `t-${typeId}-${years}`, name: `${T(typeId).name} #1`, typeId, ageWeeks: W(years),
  ownershipType: 'owned', status: 'idle', config: { economy: 150 }, ...extra,
});
/** Run a tail through the hangar with no state around it. */
const convert = (a, absWeek = 100) => {
  const { toType } = conversionFor(a.typeId);
  const quote = { capex: conversionCost(toType), toTypeId: toType.id, lineId: null, doneAbsWeek: absWeek + 12 };
  return completeConversion(startConversion(a, quote, absWeek), absWeek + 12, false, { fleet: [] });
};

const base = runScenario({ weeks: 20 });
const absNow = absoluteWeek(base.year, base.week);

console.log('\nConversion table\n');

test('every pair: real types, a freighter of the same family, on a Conversion-class line', () => {
  for (const [from, def] of Object.entries(CONVERSIONS)) {
    const c = conversionFor(from);
    assert.ok(c, `${from} → ${def.to} does not resolve`);
    assert.ok(!c.fromType.freighter, `${from} is itself a freighter`);
    assert.equal(c.toType.freighter, true, `${def.to} is not a freighter`);
    assert.equal(AIRCRAFT_FAMILY[from], AIRCRAFT_FAMILY[def.to], `${from} and ${def.to} are different airframe families`);
    assert.ok(PRODUCTION_LINES[c.lineId], `${from}: line ${c.lineId} does not exist`);
    assert.equal(lineInfo(c.lineId).cls, 'Conversion', `${from}: ${c.lineId} is not a conversion line`);
    assert.ok(Number.isFinite(lineGapWeeks(c.lineId)) && lineGapWeeks(c.lineId) > 0, `${c.lineId} has no gap`);
  }
  assert.equal(conversionFor('b777300er'), null, 'the 777-300ER is out of v1 (the 777F is a different airframe)');
  assert.equal(conversionFor('a321p2f'), null, 'a freighter does not convert again');
});

test('cost is 18% of the freighter price; downtime steps by payload', () => {
  assert.equal(conversionCost(T('b737800bcf')), Math.round(eraPurchasePrice(T('b737800bcf')) * CONVERSION_COST_PCT));
  assert.equal(conversionDowntimeWeeks(T('e190f')), 10);
  assert.equal(conversionDowntimeWeeks(T('a321p2f')), 12);
  assert.equal(conversionDowntimeWeeks(T('b767300f')), 16);
  assert.equal(conversionDowntimeWeeks(T('b747400f')), 16);
});

console.log('\nBook value carries forward\n');

test('an UNCONVERTED tail books exactly as before, every type, every age', () => {
  for (const t of AIRCRAFT_TYPES) {
    for (const y of [0, 7, 19, 33]) {
      const a = { typeId: t.id, ageWeeks: W(y), ownershipType: 'owned' };
      assert.equal(tailBookValue(a, t), eraPurchasePrice(t) * valueRemaining(a.ageWeeks, t), `${t.id} at ${y}y`);
      assert.equal(conversionCapexRemaining(a), 0);
      if (t.purchasePrice) assert.equal(tailWeeklyDepreciation(a, t), Math.round(eraPurchasePrice(t) / (DEPRECIATION_YEARS * 52)));
    }
  }
});

test('767-300 → 767-300F at 12y: NAV = prior NAV + capex, not the freighter price', () => {
  const pax = tail('b767300', 12);
  const prior = airframeNAV(pax, T('b767300'));
  const conv = convert(pax);
  assert.equal(conv.typeId, 'b767300f');
  const capex = conversionCost(T('b767300f'));
  const nav = airframeNAV(conv, T('b767300f'));
  assert.ok(Math.abs(nav - (prior + capex)) <= 1, `NAV ${nav} vs prior ${prior} + capex ${capex}`);
  assert.ok(nav < eraPurchasePrice(T('b767300f')) * valueRemaining(conv.ageWeeks, T('b767300f')) - 10e6,
    'repriced as a 767-300F would have been far higher');
  assert.equal(aircraftBookValue(conv), Math.round(tailBookValue(conv, T('b767300f'))), 'collateral reads the same book');
});

test('no borrow-and-flip: sale and collateral never exceed what was spent', () => {
  for (const [from, y] of [['b767300', 12], ['a330200', 12], ['md11', 12], ['b737800', 20], ['b747400', 25]]) {
    const pax = tail(from, y);
    const spent = airframeNAV(pax, T(from)) + conversionCost(conversionFor(from).toType);
    const conv = convert(pax);
    const q = saleQuote(conv, T(conv.typeId));
    assert.ok(q.value <= spent + 1, `${from}: sale value ${q.value} > spent ${spent}`);
    assert.ok(aircraftBookValue(conv) <= spent + 1, `${from}: collateral above spent`);
    assert.ok(conv.costBasis <= spent + 1 && conv.costBasis >= spent - 1, `${from}: basis ${conv.costBasis} vs ${spent}`);
  }
});

test('a used-market tail keeps its old basis and adds the capex', () => {
  const pax = tail('a321ceo', 20, { costBasis: 9_000_000 });
  const conv = convert(pax);
  assert.equal(conv.costBasis, 9_000_000 + conversionCost(T('a321p2f')));
});

test('depreciation: airframe on its own line, capex over 15 years, then airframe only', () => {
  const conv = convert(tail('b737800', 20));
  const t = T(conv.typeId), from = T('b737800');
  const airframeWk = Math.round(eraPurchasePrice(from) / (DEPRECIATION_YEARS * 52));
  const capexWk = Math.round(conv.conversion.capex / (CONVERSION_DEPRECIATION_YEARS * 52));
  assert.equal(tailWeeklyDepreciation(conv, t), airframeWk + capexWk);
  assert.equal(fleetWeeklyDepreciation([conv]), airframeWk + capexWk);
  const later = { ...conv, ageWeeks: conv.ageWeeks + W(CONVERSION_DEPRECIATION_YEARS) + 1 };
  assert.equal(conversionCapexRemaining(later), 0);
  assert.equal(tailWeeklyDepreciation(later, t), airframeWk);
  const half = { ...conv, ageWeeks: conv.ageWeeks + W(7.5) };
  assert.ok(Math.abs(conversionCapexRemaining(half) - conv.conversion.capex / 2) < conv.conversion.capex * 0.01);
});

test('balance sheet and hull insurance read the same book', () => {
  const conv = convert(tail('a321ceo', 15));
  const t = T(conv.typeId);
  assert.equal(balanceSheetBookValue(conv, t), Math.round(tailBookValue(conv, t, { floor: false })));
  const hull = Math.round(tailBookValue(conv, t) * HULL_INSURANCE_ANNUAL_RATE / 52);
  assert.equal(weeklyInsuranceCost(conv, t), liabilityInsuranceWeekly(t) + hull, 'hull insured on airframe + conversion');
  assert.ok(tailBookValue(conv, t) > tailBookValue({ ...conv, conversion: undefined, typeId: 'a321ceo' }, T('a321ceo')));
});

console.log('\nThe +10 years: operating age\n');

test('30-year A321 with no D-check credit: running cost drops from the 30y to the 20y curve', () => {
  const pax = tail('a321ceo', 30);
  assert.equal(maintenanceMultiplier(effectiveMaintAgeWeeks(pax)), 5.5);
  const conv = convert(pax);
  assert.equal(conv.ageWeeks, pax.ageWeeks, 'real age untouched');
  assert.equal(conv.conversionAgeCreditWeeks, P2F_AGE_CREDIT_WEEKS);
  assert.equal(maintenanceMultiplier(effectiveMaintAgeWeeks(conv)), 3.0);
});

test('does not stack on D-check credit: a well-kept frame keeps its better figure, no more', () => {
  const kept = tail('a321ceo', 30, { maintAgeCredit: W(20) });
  assert.equal(effectiveMaintAgeWeeks(kept), W(30) - W(20));
  const conv = convert(kept);
  assert.equal(effectiveMaintAgeWeeks(conv), W(30) - W(20), 'min(D-credited, real − 10y), not both');
  const light = tail('a321ceo', 30, { maintAgeCredit: W(3) });
  assert.equal(effectiveMaintAgeWeeks(convert(light)), W(30) - P2F_AGE_CREDIT_WEEKS);
});

test('AOG repair factor and failure age term read real age − 10 years', () => {
  const pax = tail('a321ceo', 30);
  const conv = convert(pax);
  assert.equal(operatingAgeWeeks(conv), pax.ageWeeks - P2F_AGE_CREDIT_WEEKS);
  assert.equal(aogAgeFactor(conv), aogAgeFactor({ ageWeeks: W(30) - P2F_AGE_CREDIT_WEEKS }));
  assert.ok(aogAgeFactor(conv) < aogAgeFactor(pax));
  const clocks = { hoursSinceC: 0, hoursSinceD: 0 };
  assert.ok(weeklyWearFailureProb({ ...conv, ...clocks }) < weeklyWearFailureProb({ ...pax, ...clocks }));
  assert.equal(operatingAgeWeeks(pax), pax.ageWeeks, 'unconverted: real age');
});

test('the conversion includes a heavy check: C and D clocks reset', () => {
  const conv = convert(tail('b737800', 18, { hoursSinceC: 900, hoursSinceD: 9000, weeksSinceD: 300 }));
  assert.equal(conv.hoursSinceC, 0);
  assert.equal(conv.hoursSinceD, 0);
  assert.equal(conv.weeksSinceD, 0);
});

console.log('\nWho can convert\n');

const owned321 = (extra = {}) => tail('a321ceo', 20, { id: 'p2f-a', name: 'Airbus A321ceo #9', ...extra });
const withTail = (s, a) => ({ ...s, fleet: [...s.fleet, a] });

test('leased, retired, out of service, already a freighter, no pair: refused with a reason', () => {
  const s = base;
  assert.equal(conversionRefusal(s, owned321({ ownershipType: 'lease' })).code, 'leased');
  assert.equal(conversionRefusal(s, owned321({ status: 'retired' })).code, 'retired');
  assert.equal(conversionRefusal(s, owned321({ status: 'maintenance', checkType: 'C', checkWeeksLeft: 2 })).code, 'out_of_service');
  assert.equal(conversionRefusal(s, tail('a321p2f', 8)).code, 'freighter');
  assert.equal(conversionRefusal(s, tail('b777300er', 15)).code, 'no_conversion');
  assert.equal(conversionRefusal(s, owned321()), null);
});

test('a tail still flying routes is refused unless closeRoutes', () => {
  const a = owned321();
  const s = { ...withTail(base, a), routes: [...base.routes, { id: 'r-p2f', aircraftId: a.id, origin: 'JFK', destination: 'BOS', weeklyFrequency: 7 }] };
  const r = conversionRefusal(s, a);
  assert.equal(r.code, 'has_routes');
  assert.equal(r.routes, 1);
  assert.equal(conversionRefusal(s, a, { closeRoutes: true }), null);
});

test('era worlds: no A321P2F conversions before 2021', () => {
  const s = { ...base, startYear: 2015, year: 1 };
  assert.equal(conversionRefusal(s, owned321()).code, 'not_yet');
  assert.equal(conversionRefusal({ ...s, startYear: 2022 }, owned321()), null);
});

console.log('\nCONVERT_TO_FREIGHTER and the tick\n');

test('charges the quote, parks the tail, closes routes on request, and the tick hands back a freighter', () => {
  const a = owned321();
  let s = { ...withTail(base, a), cash: 50_000_000,
            routes: [...base.routes, { id: 'r-p2f', aircraftId: a.id, origin: 'JFK', destination: 'BOS', weeklyFrequency: 7 }] };
  const refused = gameReducer(s, { type: 'CONVERT_TO_FREIGHTER', aircraftIds: [a.id] });
  assert.equal(refused.cash, s.cash, 'refused while it flies a route');
  assert.equal(refused.fleet.find(x => x.id === a.id).status, 'idle');

  const quote = canConvertToFreighter(s, [a], { closeRoutes: true });
  assert.ok(quote.ok && quote.routesToClose === 1);
  s = gameReducer(s, { type: 'CONVERT_TO_FREIGHTER', aircraftIds: [a.id], closeRoutes: true });
  assert.equal(s.cash, 50_000_000 - quote.capex);
  assert.equal(s.routes.some(r => r.aircraftId === a.id), false, 'route closed');
  const parked = s.fleet.find(x => x.id === a.id);
  assert.equal(parked.status, 'maintenance');
  assert.equal(parked.checkType, 'P2F');
  assert.equal(parked.pendingConversion.toTypeId, 'a321p2f');
  assert.equal(parked.checkWeeksLeft, quote.byId[a.id].readyInWeeks);

  const again = gameReducer(s, { type: 'CONVERT_TO_FREIGHTER', aircraftIds: [a.id] });
  assert.equal(again.cash, s.cash, 'already converting');

  for (let i = 0; i < parked.checkWeeksLeft; i++) s = gameReducer({ ...s, cash: 1e9 }, { type: 'ADVANCE_WEEK' });
  const done = s.fleet.find(x => x.id === a.id);
  assert.equal(done.typeId, 'a321p2f');
  assert.equal(done.status, 'idle');
  assert.equal(done.pendingConversion, undefined);
  assert.equal(done.conversion.fromTypeId, 'a321ceo');
  assert.equal(done.conversion.capex, quote.capex);
  assert.equal(done.config.economy, 0, 'cabin removed');
  assert.match(done.name, /^Airbus A321P2F #\d+$/);
  assert.equal(done.conversionAgeCreditWeeks, P2F_AGE_CREDIT_WEEKS);
  assert.ok((s.pendingToasts ?? []).some(t => /Freighter conversion complete/.test(t.title ?? '')), 'completion toast');
});

test('broke: refused, untouched', () => {
  const a = owned321();
  const s = { ...withTail(base, a), cash: 10 };
  const r = gameReducer(s, { type: 'CONVERT_TO_FREIGHTER', aircraftIds: [a.id] });
  assert.equal(r.cash, 10);
  assert.equal(r.fleet.find(x => x.id === a.id).status, 'idle');
});

test('two conversions finishing the same week get different names', () => {
  const a = owned321({ id: 'p2f-a' }), b = owned321({ id: 'p2f-b', name: 'Airbus A321ceo #10' });
  let s = { ...base, fleet: [...base.fleet, a, b], cash: 1e9 };
  s = gameReducer(s, { type: 'CONVERT_TO_FREIGHTER', aircraftIds: [a.id, b.id] });
  for (let i = 0; i < 12; i++) s = gameReducer({ ...s, cash: 1e9 }, { type: 'ADVANCE_WEEK' });
  const names = s.fleet.filter(x => x.id === a.id || x.id === b.id).map(x => x.name);
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
});

console.log('\nProduction-line worlds\n');

test('a conversion holds a slot on its conversion line, visible to rivals', () => {
  const a = owned321();
  const s0 = { ...withTail(base, a), cash: 1e9, productionLinesWorld: true, lineBook: { scale: 1, bookings: {} } };
  const s = gameReducer(s0, { type: 'CONVERT_TO_FREIGHTER', aircraftIds: [a.id] });
  const p = s.fleet.find(x => x.id === a.id).pendingConversion;
  assert.equal(p.lineId, 'conv_a320');
  assert.equal(lineBookings(s, 'conv_a320', absNow).get(p.doneAbsWeek), 1);
  assert.equal(bookingsFromStates([s]).conv_a320?.[p.doneAbsWeek], 1, 'rivals see it through bookingsFromStates');
});

test('a full line pushes the conversion out; a classic world never queues', () => {
  const a = owned321();
  const absWeek = absNow;
  const minDone = absWeek + conversionDowntimeWeeks(T('a321p2f'));
  const cap = capacityFor({ lineBook: { scale: 1, bookings: {} } }, 'conv_a320', absWeek);
  const full = {};
  for (let w = minDone; w < minDone + 6; w++) full[w] = cap;
  const s = { ...withTail(base, a), cash: 1e9, productionLinesWorld: true, lineBook: { scale: 1, bookings: { conv_a320: full } } };
  const q = canConvertToFreighter(s, [a]);
  assert.ok(q.byId[a.id].doneAbsWeek >= minDone + 6, `booked ${q.byId[a.id].doneAbsWeek}, line full until ${minDone + 6}`);
  const classic = canConvertToFreighter({ ...s, productionLinesWorld: false }, [a]);
  assert.equal(classic.byId[a.id].doneAbsWeek, minDone);
  assert.equal(classic.byId[a.id].lineId, null);
});

test('one airline\'s conversions on a line are spaced by the line gap', () => {
  const tails = [1, 2, 3].map(i => owned321({ id: `p2f-${i}`, name: `Airbus A321ceo #${20 + i}` }));
  const s = { ...base, fleet: [...base.fleet, ...tails], cash: 1e9, productionLinesWorld: true, lineBook: { scale: 1, bookings: {} } };
  const q = canConvertToFreighter(s, tails);
  const weeks = tails.map(t => q.byId[t.id].doneAbsWeek).sort((x, y) => x - y);
  const gap = lineGapWeeks('conv_a320');
  for (let i = 1; i < weeks.length; i++) assert.ok(weeks[i] - weeks[i - 1] >= gap, `${weeks} not spaced by ${gap}`);
});

console.log('\nFleet-age reputation\n');

test('freighters and retired tails are out of the passenger fleet-age average', () => {
  const young = tail('a321neo', 2), oldF = tail('a321p2f', 25), gone = tail('a320ceo', 30, { status: 'retired' });
  const rep = (fleet) => calcReputation({ ...base, fleet }, null);
  assert.equal(rep([young, oldF, gone]).avgAgeYears, rep([young]).avgAgeYears);
  assert.equal(rep([young, oldF, gone]).fleet, rep([young]).fleet);
  assert.ok(Math.abs(rep([oldF]).avgAgeYears - 25) < 0.05, 'a cargo-only airline keeps its freighters\' age');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
