// Ground handling stations — self-handling is a fixed-cost bet at ONE airport.
//
// Ground handling used to be a pure per-passenger contract: every boarded
// passenger paid the handler, wherever they boarded, and the only discount was
// the small hub `stationDiscount`. A station turns that into capex plus payroll
// at one airport, covers a level-set number of weekly departures there, and
// lifts the airline-wide on-time rate by the share of departures it handles.
//
// The tests guard the things that are easy to get wrong:
//
//   1. Capacity is PRO-RATA, not a per-route on/off — otherwise the answer
//      depends on route order, and the pooling invariant exists precisely to
//      catch that kind of silent nondeterminism.
//   2. The discount is the BEST of the hub station discount and the station's
//      own, never the sum, and it touches ground handling only — catering keeps
//      the plain hub factor.
//   3. A station-less airline is byte-identical to before: no route field, no
//      labor field, no cost. (Headwinds' golden master depends on this.)
//   4. Previews agree with the tick: stateGroundHandlingFields resolves the
//      same factor weeklyTick attaches.
//   5. The reducer charges what the card quotes: canBuildStation is the single
//      source for price and eligibility; upgrades build in place; close refunds
//      a quarter (half that while building).
//
//   node tools/ground-station-test.mjs

import assert from 'node:assert/strict';
import {
  weeklyTick, defaultClassPrices, stateGroundHandlingFields, routeStops,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { HUB_TIERS } from '../packages/engine/src/models/demand.js';
import { laborEffects, DEFAULT_LABOR_STATE } from '../packages/engine/src/data/labor.js';
import { defaultAncillaries } from '../packages/engine/src/data/ancillaries.js';
import { costBridge, bridgeInputsFromReport } from '../packages/engine/src/utils/pnlBridge.js';
import { prepareWeek } from '../packages/engine/src/utils/tickPrep.js';
import {
  GROUND_STATION_LEVELS, GROUND_STATION_MAX_LEVEL, GROUND_STATION_DISCOUNT,
  GROUND_STATION_RAMP_WEEKS, GROUND_STATION_RAMP_FLOOR, GROUND_STATION_OTP_BONUS,
  GROUND_STATION_CLOSE_REFUND, GROUND_STATION_UPGRADE_PREMIUM,
  stationLevelDef, stationBuildCapex, stationUpgradeCapex, stationSunkCapex, stationCloseRefund,
  makeStation, isStationOpen, hasOpenStation, stationEfficiency, stationCapacity,
  stationWeeklyCost, totalStationWeeklyCost, tickStationConstruction, canBuildStation,
  airportDeparturesMap, stationCoverage, groundHandlingFactorAt,
  selfHandledDepartureShare, stationOtpBonus,
} from '../packages/engine/src/data/groundStation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nGround handling stations — self-handling at one airport\n');

const TYPE = getAircraftType('a320neo');
const O = 'JFK', D = 'LAX', X = 'ORD';
const PAIR = [O, D].sort().join('-');
const REF = Math.round(referencePrice(O, D));

function tail(id) {
  return {
    id, typeId: TYPE.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
    config: { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: TYPE.seats - 12,
              seatQuality: 'standard', serviceQuality: 'standard' },
  };
}
const route = (id, aircraftId, freq = 14, origin = O, destination = D) => ({
  id, origin, destination, stops: [origin, destination], aircraftId, weeklyFrequency: freq, weeksOpen: 60,
});

function baseState({ fleet, routes, groundStations = {}, hubs = {}, absWeek = 100 }) {
  return {
    fleet, routes, cargoRoutes: [],
    gameDate: { week: 1, month: 6 },
    gates: { [O]: 10, [D]: 10, [X]: 10 },
    hubs, groundStations,
    lounges: {}, loungePolicy: null,
    routePricing: {
      [PAIR]: defaultClassPrices(REF),
      [[O, X].sort().join('-')]: defaultClassPrices(Math.round(referencePrice(O, X))),
    },
    routeCatering: {},
    competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null,
    campaignStrength: {}, targetedMarketing: {},
    awareness: 65,
    ancillaries: defaultAncillaries(),
    labor: undefined,
    absWeek,
  };
}

/** An OPEN station at `code`, opened `weeksAgo` weeks before absWeek 100. */
const openStation = (code, level, weeksAgo = 52) => ({
  ...makeStation(code, level, 0), buildWeeksLeft: 0, openedWeek: 100 - weeksAgo,
});

// ═══════════════════════════════════════════════════════════════════════════
// The ladder
// ═══════════════════════════════════════════════════════════════════════════

test('three levels, each a superset of the one below', () => {
  assert.equal(GROUND_STATION_MAX_LEVEL, 3);
  let prev = null;
  for (let l = 1; l <= 3; l++) {
    const def = stationLevelDef(l);
    assert.ok(def, `level ${l} exists`);
    if (prev) {
      assert.ok(def.capex > prev.capex, 'capex rises');
      assert.ok(def.weeklyOpex > prev.weeklyOpex, 'opex rises');
      assert.ok(def.weeklyDepartures > prev.weeklyDepartures, 'capacity rises');
      assert.ok(def.gatesRequired >= prev.gatesRequired, 'gates never fall');
    }
    prev = def;
  }
  assert.equal(stationLevelDef(3).weeklyDepartures, Infinity, 'the top level has no ceiling');
  assert.equal(stationLevelDef(4), null);
});

test('a station pays for itself at a hub, not at an outstation', () => {
  // Blended economy/premium handling on a full A320 is about $12 per boarded
  // passenger. At 30% off, a level's break-even is opex / (0.30 × pax × $12).
  // The check: a Ramp Station at ~60% of capacity breaks even; at 10% it bleeds.
  const def = stationLevelDef(1);
  const paxPerDep = Math.round(TYPE.seats * 0.8);
  const perPax = 12;
  const at = (dep) => dep * paxPerDep * perPax * GROUND_STATION_DISCOUNT;
  assert.ok(at(def.weeklyDepartures * 0.6) >= def.weeklyOpex,
    `at 60% of capacity the saving (${Math.round(at(def.weeklyDepartures * 0.6))}) must cover opex (${def.weeklyOpex})`);
  assert.ok(at(def.weeklyDepartures * 0.1) < def.weeklyOpex,
    'at 10% of capacity it must not — a spoke station is a mistake, and the game should let you make it');
});

test('upgrade capex is the level gap plus a premium; sunk capex counts the upgrade being built', () => {
  const gap = stationLevelDef(2).capex - stationLevelDef(1).capex;
  assert.equal(stationUpgradeCapex(1, 2), Math.round(gap * (1 + GROUND_STATION_UPGRADE_PREMIUM)));
  assert.equal(stationUpgradeCapex(2, 1), 0, 'no such thing as a paid downgrade');
  assert.equal(stationUpgradeCapex(1, 1), 0);
  const st = { ...openStation(O, 1), upgradeTo: 2, upgradeWeeksLeft: 5 };
  assert.equal(stationSunkCapex(st), stationBuildCapex(1) + stationUpgradeCapex(1, 2));
});

test('close refunds a quarter of sunk capex, half that while still building', () => {
  const open = openStation(O, 2);
  assert.equal(stationCloseRefund(open), Math.round(stationBuildCapex(2) * GROUND_STATION_CLOSE_REFUND));
  const building = makeStation(O, 2, 100);
  assert.ok(!isStationOpen(building));
  assert.equal(stationCloseRefund(building), Math.round(stationBuildCapex(2) * GROUND_STATION_CLOSE_REFUND * 0.5));
  assert.equal(stationCloseRefund(null), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

test('a new station is under construction and opens after buildWeeks', () => {
  const def = stationLevelDef(1);
  let stations = { [O]: makeStation(O, 1, 100) };
  assert.ok(!isStationOpen(stations[O]));
  assert.equal(stationWeeklyCost(stations[O]), 0, 'construction is capex, already paid — no opex yet');
  assert.equal(stationCapacity(stations[O]), 0);
  let opened = [];
  for (let w = 1; w <= def.buildWeeks; w++) {
    const r = tickStationConstruction(stations, 100 + w);
    stations = r.stations; opened = opened.concat(r.opened);
  }
  assert.ok(isStationOpen(stations[O]), 'open after buildWeeks ticks');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].code, O);
  assert.equal(stations[O].openedWeek, 100 + def.buildWeeks, 'openedWeek is the week it actually opened');
  assert.equal(stationWeeklyCost(stations[O]), def.weeklyOpex);
});

test('an upgrade builds IN PLACE: the old level keeps working until the new one lands', () => {
  const def2 = stationLevelDef(2);
  let stations = { [O]: { ...openStation(O, 1), upgradeTo: 2, upgradeWeeksLeft: def2.buildWeeks } };
  assert.equal(stationCapacity(stations[O]), stationLevelDef(1).weeklyDepartures, 'still a level 1 while upgrading');
  assert.equal(stationWeeklyCost(stations[O]), stationLevelDef(1).weeklyOpex, 'and bills as one');
  let upgraded = [];
  for (let w = 1; w <= def2.buildWeeks; w++) {
    const r = tickStationConstruction(stations, 100 + w);
    stations = r.stations; upgraded = upgraded.concat(r.upgraded);
  }
  assert.equal(stations[O].level, 2);
  assert.equal(stations[O].upgradeTo, null);
  assert.equal(upgraded.length, 1);
  assert.equal(stationCapacity(stations[O]), def2.weeklyDepartures);
  assert.equal(stations[O].openedWeek, 100 - 52, 'the efficiency ramp is NOT restarted by an upgrade');
});

test('efficiency ramps from the floor to 1.0 over GROUND_STATION_RAMP_WEEKS', () => {
  const st = openStation(O, 1, 0);
  assert.equal(stationEfficiency(st, 100), GROUND_STATION_RAMP_FLOOR, 'floor on opening week');
  assert.equal(stationEfficiency(st, 100 + GROUND_STATION_RAMP_WEEKS), 1);
  assert.equal(stationEfficiency(st, 100 + GROUND_STATION_RAMP_WEEKS * 3), 1, 'clamped');
  const mid = stationEfficiency(st, 100 + GROUND_STATION_RAMP_WEEKS / 2);
  assert.ok(mid > GROUND_STATION_RAMP_FLOOR && mid < 1);
  assert.equal(stationEfficiency(makeStation(O, 1, 100), 100), 0, 'nothing while building');
});

test('canBuildStation: gates, cash, one per airport, upgrade rules — one function for card and reducer', () => {
  const snap = (over = {}) => ({ stations: {}, gates: { [O]: 2 }, cash: 1e9, ...over });
  assert.ok(canBuildStation(O, 1, snap()).ok);
  assert.equal(canBuildStation(O, 1, snap()).capex, stationBuildCapex(1));
  assert.ok(!canBuildStation(O, 2, snap()).ok, 'level 2 needs 3 gates');
  assert.match(canBuildStation(O, 2, snap()).reasons[0], /gates/);
  assert.ok(!canBuildStation(O, 1, snap({ cash: 0 })).ok);
  assert.match(canBuildStation(O, 1, snap({ cash: 0 })).reasons[0], /cash/);
  assert.ok(!canBuildStation(O, 9, snap()).ok, 'unknown level');
  assert.ok(!canBuildStation('', 1, snap()).ok, 'no airport');

  const has1 = snap({ stations: { [O]: openStation(O, 1) }, gates: { [O]: 3 } });
  const up = canBuildStation(O, 2, has1);
  assert.ok(up.ok, 'upgrade 1→2 with 3 gates');
  assert.equal(up.capex, stationUpgradeCapex(1, 2), 'an existing station is quoted the UPGRADE price');
  assert.ok(!canBuildStation(O, 1, has1).ok, 'same level is not an upgrade');
  assert.ok(!canBuildStation(O, 2, snap({ stations: { [O]: makeStation(O, 1, 100) }, gates: { [O]: 3 } })).ok,
    'cannot upgrade a station still being built');
  assert.ok(!canBuildStation(O, 3, snap({ stations: { [O]: { ...openStation(O, 1), upgradeTo: 2, upgradeWeeksLeft: 3 } }, gates: { [O]: 9 } })).ok,
    'one upgrade at a time');
});

// ═══════════════════════════════════════════════════════════════════════════
// Departures, coverage, the factor
// ═══════════════════════════════════════════════════════════════════════════

test('departures: a round trip departs from each end; a tag route from every stop; dormant routes do not count', () => {
  const routes = [
    route('r1', 'a1', 14),
    route('r2', 'a2', 7, O, X),
    { id: 't1', origin: O, destination: D, stops: [O, X, D], aircraftId: 'a3', weeklyFrequency: 3, weeksOpen: 10 },
    { ...route('r3', 'a4', 21), seasonState: 'dormant' },
  ];
  const dep = airportDeparturesMap(routes, routeStops);
  assert.equal(dep[O], 14 + 7 + 3);
  assert.equal(dep[D], 14 + 3);
  assert.equal(dep[X], 7 + 3);
});

test('coverage is pro-rata: over capacity the share falls, the discount with it', () => {
  const st = openStation(O, 1);
  const cap = stationLevelDef(1).weeklyDepartures;
  const under = stationCoverage(st, cap / 2, 100);
  assert.equal(under.share, 1);
  assert.equal(under.discount, GROUND_STATION_DISCOUNT, 'full discount at full efficiency under capacity');
  const over = stationCoverage(st, cap * 2, 100);
  assert.equal(over.share, 0.5);
  assert.equal(over.discount, GROUND_STATION_DISCOUNT * 0.5, 'half the departures spill to the contractor');
  assert.equal(stationCoverage(st, 0, 100).share, 1, 'nothing scheduled — nothing to overflow');
  assert.equal(stationCoverage(makeStation(O, 1, 100), 10, 100).discount, 0, 'building → no discount');
  const fresh = stationCoverage(openStation(O, 1, 0), cap / 2, 100);
  assert.equal(fresh.discount, GROUND_STATION_DISCOUNT * GROUND_STATION_RAMP_FLOOR, 'ramp scales the discount');
});

test('the route factor is the BEST of hub and station at each end, averaged — never stacked', () => {
  const stations = { [O]: openStation(O, 3) };
  const dep = { [O]: 100, [D]: 100 };
  // No hub: station end gets 30%, the other end 0 → mean 15% off.
  assert.equal(groundHandlingFactorAt(HUB_TIERS, {}, stations, [O, D], dep, 100), +(1 - GROUND_STATION_DISCOUNT / 2).toFixed(4));
  // A T3 hub at the SAME end: best-of, so still 30% there, not 30 + 16.
  const hubs = { [O]: { tier: 3 } };
  assert.equal(groundHandlingFactorAt(HUB_TIERS, hubs, stations, [O, D], dep, 100), +(1 - GROUND_STATION_DISCOUNT / 2).toFixed(4));
  // A hub at the OTHER end still counts on its own.
  const hubsD = { [D]: { tier: 3 } };
  const f = groundHandlingFactorAt(HUB_TIERS, hubsD, stations, [O, D], dep, 100);
  assert.equal(f, +(1 - (GROUND_STATION_DISCOUNT + HUB_TIERS[3].stationDiscount) / 2).toFixed(4));
  // A station under the hub's own discount changes nothing (best-of).
  const weak = { [O]: openStation(O, 1, 0) };   // 60% × 30% × share
  const deps = { [O]: stationLevelDef(1).weeklyDepartures * 3, [D]: 0 };   // share 1/3 → 6% < 16%
  assert.equal(groundHandlingFactorAt(HUB_TIERS, hubs, weak, [O, D], deps, 100), +(1 - HUB_TIERS[3].stationDiscount / 2).toFixed(4));
  // No open station touched → null, so the tick attaches nothing.
  assert.equal(groundHandlingFactorAt(HUB_TIERS, hubs, {}, [O, D], dep, 100), null);
  assert.equal(groundHandlingFactorAt(HUB_TIERS, hubs, stations, [D, X], dep, 100), null);
  assert.equal(groundHandlingFactorAt(HUB_TIERS, hubs, { [O]: makeStation(O, 1, 100) }, [O, D], dep, 100), null, 'building is not open');
});

test('the on-time bonus is weighted by the self-handled share of departures', () => {
  const cap = stationLevelDef(1).weeklyDepartures;
  assert.equal(stationOtpBonus({}, { [O]: 50 }, 100), 0);
  const st = { [O]: openStation(O, 1) };
  assert.equal(selfHandledDepartureShare(st, { [O]: cap, [D]: cap }, 100), 0.5, 'half the network departs from the station');
  assert.equal(stationOtpBonus(st, { [O]: cap, [D]: cap }, 100), +(GROUND_STATION_OTP_BONUS * 0.5).toFixed(4));
  assert.equal(stationOtpBonus(st, { [O]: cap }, 100), GROUND_STATION_OTP_BONUS, 'everything self-handled → the full bonus');
  assert.equal(selfHandledDepartureShare(st, { [O]: cap * 2 }, 100), 0.5, 'overflow is not self-handled');
  const fresh = { [O]: openStation(O, 1, 0) };
  assert.equal(selfHandledDepartureShare(fresh, { [O]: cap }, 100), GROUND_STATION_RAMP_FLOOR, 'ramping crews count less');
});

test('laborEffects: the transient stationOtpBonus lifts the on-time rate and nothing else', () => {
  const base = laborEffects(DEFAULT_LABOR_STATE, 0.5, 70);
  const lifted = laborEffects({ ...DEFAULT_LABOR_STATE, stationOtpBonus: GROUND_STATION_OTP_BONUS }, 0.5, 70);
  assert.ok(Math.abs((lifted.onTimeRate - base.onTimeRate) - GROUND_STATION_OTP_BONUS) < 1e-9,
    `expected +${GROUND_STATION_OTP_BONUS}, got ${lifted.onTimeRate - base.onTimeRate}`);
  assert.equal(lifted.customerRating, base.customerRating);
  assert.equal(lifted.maintenanceCostMultiplier, base.maintenanceCostMultiplier);
  assert.equal(laborEffects({ ...DEFAULT_LABOR_STATE, stationOtpBonus: -1 }, 0.5, 70).onTimeRate, base.onTimeRate, 'never a penalty');
});

// ═══════════════════════════════════════════════════════════════════════════
// The tick
// ═══════════════════════════════════════════════════════════════════════════

test('a station-less airline is byte-identical: no route key, no report key, no labor field', () => {
  // This is the golden-master contract. Every station field is spread
  // CONDITIONALLY — an always-present key (even at 0) changes the serialized
  // state of every station-less world and costs a re-baseline for a change that
  // alters no behaviour. Readers all take `?? 0`, so absent and zero are the
  // same number downstream; only the bytes differ, and the bytes are the point.
  const state = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] });
  const rep = weeklyTick(state);
  const rr = rep.routeResults.find(r => r.routeId === 'r1');
  assert.ok(!('groundStationSavings' in rr), 'no savings key on a route with no station');
  assert.ok(!('totalGroundStationCosts' in rep), 'no opex key on a station-less report');
  assert.ok(!('totalGroundStationSavings' in rep), 'no savings key either');
  assert.equal(rep.totalGroundStationCosts ?? 0, 0, 'and every reader still sees zero');
  const prep = prepareWeek({ ...state, week: 1, year: 2, labor: DEFAULT_LABOR_STATE, fuelPrice: { index: 1, history: [] } }, { rollNewEvents: false });
  assert.ok(!('stationOtpBonus' in (prep.laborThisWeek ?? {})), 'no transient labor field without a station');
});

test('an open station cuts THIS route\'s handling by the factor, bills its opex, and the bridge still reconciles', () => {
  const none = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] });
  const with1 = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], groundStations: { [O]: openStation(O, 1) } });
  const r0 = weeklyTick(none);
  const r1 = weeklyTick(with1);
  const a = r0.routeResults.find(r => r.routeId === 'r1');
  const b = r1.routeResults.find(r => r.routeId === 'r1');
  assert.equal(a.passengers, b.passengers, 'fixture: a station moves cost, not demand');
  // One end self-handled at full efficiency, 14 departures ≪ capacity → 15% off.
  const expectedFactor = 1 - GROUND_STATION_DISCOUNT / 2;
  assert.equal(b.groundHandlingCost, Math.round(a.groundHandlingCost * expectedFactor));
  assert.equal(b.groundStationSavings, a.groundHandlingCost - b.groundHandlingCost);
  assert.equal(b.cateringCost, a.cateringCost, 'catering is untouched — the station is a ramp, not a kitchen');
  assert.equal(r1.totalGroundStationCosts, stationLevelDef(1).weeklyOpex);
  assert.equal(r1.totalGroundStationSavings, b.groundStationSavings);
  assert.equal(r1.totalGroundHandling, r0.totalGroundHandling - b.groundStationSavings);
  assert.equal(r1.totalCost, r0.totalCost - b.groundStationSavings + stationLevelDef(1).weeklyOpex,
    'total cost moves by exactly the saving and the opex');
  const bridge = costBridge(bridgeInputsFromReport(r1), with1);
  assert.equal(bridge.residual, 0, `station opex is inside totalCost but named by no bridge row — $${bridge.residual} vanished`);
});

test('a station still under construction changes nothing but is carried through the tick', () => {
  const none = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] });
  const bld  = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], groundStations: { [O]: makeStation(O, 2, 100) } });
  const r0 = weeklyTick(none), r1 = weeklyTick(bld);
  assert.equal(r1.totalGroundHandling, r0.totalGroundHandling);
  assert.equal(r1.totalGroundStationCosts ?? 0, 0, 'no opex until it opens');
  assert.equal(r1.totalCost, r0.totalCost);
});

test('over capacity, only the covered share is discounted', () => {
  const cap = stationLevelDef(1).weeklyDepartures;
  // Two routes out of O totalling 2× capacity.
  const routes = [route('r1', 'a1', cap), route('r2', 'a2', cap, O, X)];
  const none  = baseState({ fleet: [tail('a1'), tail('a2')], routes });
  const with1 = baseState({ fleet: [tail('a1'), tail('a2')], routes, groundStations: { [O]: openStation(O, 1) } });
  const r0 = weeklyTick(none), r1 = weeklyTick(with1);
  for (const id of ['r1', 'r2']) {
    const a = r0.routeResults.find(r => r.routeId === id);
    const b = r1.routeResults.find(r => r.routeId === id);
    const f = 1 - (GROUND_STATION_DISCOUNT * 0.5) / 2;   // share ½ at O, other end 0
    assert.equal(b.groundHandlingCost, Math.round(a.groundHandlingCost * f), `${id} discounted by the covered share only`);
  }
  // Upgrading to level 3 (unlimited) covers everything.
  const with3 = baseState({ fleet: [tail('a1'), tail('a2')], routes, groundStations: { [O]: openStation(O, 3) } });
  const r3 = weeklyTick(with3);
  const a = r0.routeResults.find(r => r.routeId === 'r1');
  const c = r3.routeResults.find(r => r.routeId === 'r1');
  assert.equal(c.groundHandlingCost, Math.round(a.groundHandlingCost * (1 - GROUND_STATION_DISCOUNT / 2)));
});

test('a station at BOTH ends earns the full discount on the route', () => {
  const none  = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] });
  const both  = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')],
    groundStations: { [O]: openStation(O, 1), [D]: openStation(D, 1) } });
  const a = weeklyTick(none).routeResults[0];
  const b = weeklyTick(both).routeResults[0];
  assert.equal(b.groundHandlingCost, Math.round(a.groundHandlingCost * (1 - GROUND_STATION_DISCOUNT)));
  assert.equal(weeklyTick(both).totalGroundStationCosts, 2 * stationLevelDef(1).weeklyOpex);
});

test('the tick takes best-of with the hub discount on handling, and keeps the hub discount on catering', () => {
  const hubs = { [O]: { tier: 3 } };
  const hubOnly = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], hubs });
  const hubPlus = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], hubs, groundStations: { [O]: openStation(O, 1) } });
  const plain   = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] });
  const p = weeklyTick(plain).routeResults[0];
  const h = weeklyTick(hubOnly).routeResults[0];
  const s = weeklyTick(hubPlus).routeResults[0];
  assert.equal(h.groundHandlingCost, Math.round(p.groundHandlingCost * (1 - HUB_TIERS[3].stationDiscount / 2)), 'fixture: the hub discount alone');
  assert.equal(s.groundHandlingCost, Math.round(p.groundHandlingCost * (1 - GROUND_STATION_DISCOUNT / 2)), 'station wins at that end; not summed');
  assert.equal(s.cateringCost, h.cateringCost, 'catering keeps the hub factor');
  assert.equal(s.groundStationSavings, h.groundHandlingCost - s.groundHandlingCost, 'savings are measured against what the hub already gave');
});

test('tickPrep attaches the on-time bonus as a transient labor field, from the SEASON-ADJUSTED schedule', () => {
  const cap = stationLevelDef(1).weeklyDepartures;
  const state = {
    ...baseState({ fleet: [tail('a1'), tail('a2')], routes: [route('r1', 'a1', cap), route('r2', 'a2', cap, D, X)],
      // prepareWeek derives the absolute week from year/week (year 2, week 1 →
      // 53), not from the fixture's absWeek — so open the station at week 0 to
      // be past the ramp.
      groundStations: { [O]: { ...openStation(O, 1), openedWeek: 0 } } }),
    week: 1, year: 2, labor: DEFAULT_LABOR_STATE, fuelPrice: { index: 1, history: [] },
  };
  const prep = prepareWeek(state, { rollNewEvents: false });
  // O has cap departures out of 4×cap... r1 departs O and D (cap each); r2 departs D and X.
  // Self-handled = cap of 4cap = ¼.
  assert.equal(prep.laborThisWeek.stationOtpBonus, +(GROUND_STATION_OTP_BONUS * 0.25).toFixed(4));
  assert.equal(prep.stationOtpBonus, prep.laborThisWeek.stationOtpBonus);
  assert.ok(prep.tickInput.groundStations, 'stations ride into the tick');
  assert.equal(state.labor.stationOtpBonus, undefined, 'state.labor is untouched');
  // And the tick's compensation line moves with it.
  const rep = weeklyTick(prep.tickInput);
  const repNo = weeklyTick({ ...prep.tickInput, labor: DEFAULT_LABOR_STATE, groundStations: {} });
  assert.ok(rep.totalCompensation < repNo.totalCompensation, 'a better on-time rate pays less compensation');
});

test('previews agree with the tick: stateGroundHandlingFields resolves the factor weeklyTick attached', () => {
  const cap = stationLevelDef(1).weeklyDepartures;
  const routes = [route('r1', 'a1', cap), route('r2', 'a2', cap, O, X)];
  const state = { ...baseState({ fleet: [tail('a1'), tail('a2')], routes, groundStations: { [O]: openStation(O, 1) } }), year: 2, week: 48 };
  delete state.absWeek;   // a UI caller has year/week, not absWeek
  const fields = stateGroundHandlingFields(state, O, D);
  assert.ok('groundHandlingFactor' in fields);
  const tickState = { ...state, absWeek: 100 };
  const rep = weeklyTick(tickState);
  const rr = rep.routeResults.find(r => r.routeId === 'r1');
  const tickFactor = rr.groundHandlingCost / (rr.groundHandlingCost + rr.groundStationSavings);
  assert.ok(Math.abs(tickFactor - fields.groundHandlingFactor) < 0.002,
    `preview factor ${fields.groundHandlingFactor} vs tick ${tickFactor.toFixed(4)}`);
  assert.deepEqual(stateGroundHandlingFields({ ...state, groundStations: {} }, O, D), {}, 'no station → nothing spread');
  // A projection that adds a route counts it against capacity.
  const more = stateGroundHandlingFields(state, O, D, [route('new', 'a3', cap * 4)]);
  assert.ok(more.groundHandlingFactor > fields.groundHandlingFactor, 'launching a big route at a full station dilutes the discount');
});

// ═══════════════════════════════════════════════════════════════════════════
// Reducer
// ═══════════════════════════════════════════════════════════════════════════

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');

function playing(extra = {}) {
  return { ...freshState(), phase: 'playing', week: 10, year: 3, cash: 500_000_000, gates: { [O]: 4, [D]: 1 }, ...extra };
}

test('BUILD_GROUND_STATION charges the quoted capex and starts construction; refuses what the card refuses', () => {
  const s0 = playing();
  const s1 = gameReducer(s0, { type: 'BUILD_GROUND_STATION', code: O, level: 1 });
  assert.equal(s1.cash, s0.cash - stationBuildCapex(1));
  assert.ok(s1.groundStations[O]);
  assert.ok(!isStationOpen(s1.groundStations[O]));
  assert.equal(s1.groundStations[O].buildWeeksLeft, stationLevelDef(1).buildWeeks);
  const dup = gameReducer(s1, { type: 'BUILD_GROUND_STATION', code: O, level: 1 });
  assert.equal(dup, s1, 'one station per airport');
  const noGates = gameReducer(s0, { type: 'BUILD_GROUND_STATION', code: D, level: 1 });
  assert.equal(noGates.cash, s0.cash, 'not charged');
  assert.match(noGates.error, /gates/);
  const broke = gameReducer({ ...s0, cash: 1000 }, { type: 'BUILD_GROUND_STATION', code: O, level: 1 });
  assert.match(broke.error, /cash/);
  assert.equal(gameReducer(s0, { type: 'BUILD_GROUND_STATION', code: O, level: 7 }).groundStations[O].level, 3, 'level is clamped');
});

test('UPGRADE_GROUND_STATION builds in place; CLOSE refunds and removes', () => {
  const s0 = playing({ groundStations: { [O]: openStation(O, 1) } });
  const s1 = gameReducer(s0, { type: 'UPGRADE_GROUND_STATION', code: O, level: 2 });
  assert.equal(s1.cash, s0.cash - stationUpgradeCapex(1, 2));
  assert.equal(s1.groundStations[O].level, 1, 'still level 1 until it lands');
  assert.equal(s1.groundStations[O].upgradeTo, 2);
  assert.equal(s1.groundStations[O].upgradeWeeksLeft, stationLevelDef(2).buildWeeks);
  const again = gameReducer(s1, { type: 'UPGRADE_GROUND_STATION', code: O, level: 3 });
  assert.equal(again.cash, s1.cash, 'one upgrade at a time');
  const s2 = gameReducer(s1, { type: 'CLOSE_GROUND_STATION', code: O });
  assert.equal(s2.cash, s1.cash + stationCloseRefund(s1.groundStations[O]));
  assert.ok(!s2.groundStations[O]);
  assert.equal(gameReducer(s2, { type: 'CLOSE_GROUND_STATION', code: O }), s2, 'nothing to close');
});

test('ADVANCE_WEEK advances construction and persists the ticked stations', () => {
  const s0 = gameReducer(playing({ fleet: [], routes: [] }), { type: 'BUILD_GROUND_STATION', code: O, level: 1 });
  const s1 = gameReducer(s0, { type: 'ADVANCE_WEEK' });
  assert.equal(s1.groundStations[O].buildWeeksLeft, stationLevelDef(1).buildWeeks - 1);
  assert.equal(s1.financialHistory.at(-1).groundStations ?? 0, 0, 'no opex while building');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
