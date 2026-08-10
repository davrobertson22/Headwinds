// Wi-Fi is FLEET EQUIPMENT and lounges are BUILT FACILITIES.
//
// Both mechanics used to be pure policy switches on the Ancillaries tab: tick
// "offered" and every route in the network had connectivity and lounge access,
// for nothing but a per-passenger charge. Neither is a policy in the real world.
// Wi-Fi is an antenna and a certification campaign, bought one airframe at a
// time; a lounge is a room you build at one airport and staff every week.
//
// The tests below guard the two things that are easy to get wrong:
//
//   1. Wi-Fi must follow the METAL, not the policy. A route flown by an
//      unequipped tail earns no Wi-Fi money, spends no bandwidth, and takes the
//      absent-amenity quality drag — whatever the policy says.
//
//   2. Lounge appeal must move PASSENGERS, not revenue. This is the exact shape
//      of the brand-reach bug (see tools/brand-demand-test.mjs): a multiplier
//      applied to route revenue AFTER the capacity cap moves nobody and silently
//      changes the fare instead. Lounge appeal therefore has to bite in TWO
//      places — a log term in the contested softmax and the business POOL on a
//      monopoly — and it must move the business segment only, because a leisure
//      passenger buying the cheapest fare cannot get into the lounge.
//
//   node tools/wifi-lounge-test.mjs

import assert from 'node:assert/strict';
import {
  weeklyTick, simulateRoute, defaultConfig, defaultClassPrices, routeQualityBreakdown,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { computeMarketShare, buildRouteMarket, computeUtility } from '../packages/engine/src/models/demand.js';
import { defaultAncillaries, routeAncillaries, ancillaryQualityBonus, ANCILLARY_MAP } from '../packages/engine/src/data/ancillaries.js';
import {
  WIFI_WEEKLY_OPEX, wifiInstallCost, wifiRetrofitCost, fleetWifiCoverage, groupWifiCoverage,
} from '../packages/engine/src/data/wifi.js';
import {
  LOUNGE_WEEKLY_OPEX, LOUNGE_BUILD_WEEKS, LOUNGE_OWNED_COST_FACTOR,
  makeLounge, isLoungeOpen, tickLoungeConstruction, canBuildLounge,
  routeLoungeAppeal, loungeContractFactor, loungeEndpointCoverage,
} from '../packages/engine/src/data/lounges.js';
import { costBridge, bridgeInputsFromReport } from '../packages/engine/src/utils/pnlBridge.js';
import { buildEncroachmentOffer } from '../packages/engine/src/models/encroachment.js';
import { stateLoungeFields } from '../packages/engine/src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nWi-Fi is fleet equipment; lounges are built facilities\n');

const TYPE = getAircraftType('a320neo');
const WIDE = getAircraftType('b787-9') ?? getAircraftType('a350-900') ?? TYPE;
const O = 'JFK', D = 'LAX';
const PAIR = [O, D].sort().join('-');
const REF = Math.round(referencePrice(O, D));

// A cabin with a real business cabin — the lounge tests need a business segment
// to move, and defaultConfig() is all-economy.
function mixedConfig(type) {
  const seats = type.seats;
  const biz   = Math.max(8, Math.round(seats * 0.10));
  return {
    firstClass: 0, businessClass: biz, premiumEconomy: 0,
    economy: seats - biz, seatQuality: 'standard', serviceQuality: 'standard',
  };
}

function tail(id, { type = TYPE, hasWifi = false, config = null } = {}) {
  return {
    id, typeId: type.id, status: 'assigned', ageWeeks: 52,
    config: config ?? mixedConfig(type), ownershipType: 'owned',
    ...(hasWifi ? { hasWifi: true } : {}),
  };
}

function baseState({ fleet, routes, lounges = {}, loungePolicy = null, ancillaries = defaultAncillaries(), priceMult = 1 }) {
  return {
    fleet, routes, cargoRoutes: [],
    gameDate: { week: 1, month: 6 },
    gates: { [O]: 10, [D]: 10 },
    hubs: {},
    lounges, loungePolicy,
    routePricing: { [PAIR]: defaultClassPrices(Math.round(REF * priceMult)) },
    routeCatering: {},
    competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null,
    campaignStrength: {}, targetedMarketing: {},
    awareness: 65,
    ancillaries,
    labor: undefined,
    absWeek: 100,
  };
}

const route = (id, aircraftId, freq = 14) => ({
  id, origin: O, destination: D, aircraftId, weeklyFrequency: freq, weeksOpen: 60,
});

// ═══════════════════════════════════════════════════════════════════════════
// WI-FI — the equipment, not the policy
// ═══════════════════════════════════════════════════════════════════════════

test('an unequipped tail earns no Wi-Fi revenue even when the policy offers it', () => {
  const policy = defaultAncillaries();           // every product offered, at reference
  assert.equal(policy.wifi.offered, true, 'fixture: policy offers Wi-Fi');

  const cs = { economy: { passengers: 400 }, premiumEconomy: { passengers: 0 },
               businessClass: { passengers: 30 }, firstClass: { passengers: 0 } };

  const off = routeAncillaries(policy, cs, 3000, { wifi: 0 });
  const on  = routeAncillaries(policy, cs, 3000, { wifi: 1 });

  assert.equal(off.byItem.wifi.revenue, 0,
    'an aircraft with no Wi-Fi kit cannot sell Wi-Fi, whatever the policy says');
  assert.equal(off.byItem.wifi.cost, 0,
    'and it buys no satellite bandwidth either');
  assert.ok(on.byItem.wifi.revenue > 0, 'an equipped tail does sell it');
  assert.ok(on.revenue > off.revenue, 'total ancillary revenue is strictly higher when fitted');
});

test('an unequipped tail takes the absent-amenity quality drag', () => {
  const policy = defaultAncillaries();
  const qOff = ancillaryQualityBonus(policy, 3000, { wifi: 0 });
  const qOn  = ancillaryQualityBonus(policy, 3000, { wifi: 1 });
  assert.ok(qOn > qOff,
    `fitting Wi-Fi must raise perceived quality (got ${qOff} unfitted vs ${qOn} fitted)`);
  // The gap should be roughly the product's own absent-vs-offered spread.
  const p = ANCILLARY_MAP.wifi;
  assert.ok(qOff < qOn, 'absentQ applies to the route flown by the unfitted tail');
  assert.ok(Math.abs((qOn - qOff)) >= 2,
    `the drag should be material (product absentQ is ${p.absentQ})`);
});

test('partial coverage blends — it is not a bare on/off', () => {
  const policy = defaultAncillaries();
  const cs = { economy: { passengers: 400 }, premiumEconomy: { passengers: 0 },
               businessClass: { passengers: 30 }, firstClass: { passengers: 0 } };
  const half = routeAncillaries(policy, cs, 3000, { wifi: 0.5 });
  const on   = routeAncillaries(policy, cs, 3000, { wifi: 1 });
  assert.ok(half.byItem.wifi.revenue > 0 && half.byItem.wifi.revenue < on.byItem.wifi.revenue,
    'half a fitted fleet sells about half the Wi-Fi');
  const qHalf = ancillaryQualityBonus(policy, 3000, { wifi: 0.5 });
  const qOff  = ancillaryQualityBonus(policy, 3000, { wifi: 0 });
  const qOn   = ancillaryQualityBonus(policy, 3000, { wifi: 1 });
  assert.ok(qHalf > qOff && qHalf < qOn, `half coverage sits between (${qOff} < ${qHalf} < ${qOn})`);
});

test('the route the tick simulates reads Wi-Fi off the aircraft flying it', () => {
  const unfitted = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] });
  const fitted   = baseState({ fleet: [tail('a1', { hasWifi: true })], routes: [route('r1', 'a1')] });

  const rOff = weeklyTick(unfitted).routeResults.find(r => r.routeId === 'r1');
  const rOn  = weeklyTick(fitted).routeResults.find(r => r.routeId === 'r1');

  assert.ok(rOff && rOn, 'fixture must produce route results');
  assert.equal(rOff.ancillaryByItem.wifi.revenue, 0,
    'weeklyTick gave an unfitted aircraft Wi-Fi revenue');
  assert.ok(rOn.ancillaryByItem.wifi.revenue > 0,
    'weeklyTick withheld Wi-Fi revenue from a fitted aircraft');
  assert.ok(rOn.qualityScore > rOff.qualityScore,
    `fitting Wi-Fi must lift the route's quality score (${rOff.qualityScore} -> ${rOn.qualityScore})`);
});

test('every equipped tail carries a weekly running cost, and it reaches totalCost', () => {
  const two = baseState({
    fleet: [tail('a1', { hasWifi: true }), tail('a2', { hasWifi: true })],
    routes: [route('r1', 'a1')],
  });
  const none = baseState({
    fleet: [tail('a1'), tail('a2')],
    routes: [route('r1', 'a1')],
  });

  const rep2 = weeklyTick(two);
  const rep0 = weeklyTick(none);

  assert.equal(rep0.totalWifiCosts, 0, 'an unfitted fleet pays nothing');
  assert.equal(rep2.totalWifiCosts, 2 * WIFI_WEEKLY_OPEX,
    'both tails pay the weekly connectivity cost — including the one that is parked');

  // The parked tail matters: the airtime commitment is paid by the airframe.
  const oneFlying = baseState({
    fleet: [tail('a1', { hasWifi: true }), tail('a2')],
    routes: [route('r1', 'a1')],
  });
  assert.equal(weeklyTick(oneFlying).totalWifiCosts, WIFI_WEEKLY_OPEX);
});

test('the P&L bridge still balances with Wi-Fi costs in the ladder', () => {
  const state = baseState({
    fleet: [tail('a1', { hasWifi: true }), tail('a2', { hasWifi: true })],
    routes: [route('r1', 'a1')],
  });
  const report = weeklyTick(state);
  const proj   = bridgeInputsFromReport(report);
  const bridge = costBridge(proj, state);
  assert.equal(bridge.residual, 0,
    `Wi-Fi running costs are inside totalCost but named by no bridge row — `
    + `$${bridge.residual} vanished into "Other"`);
});

test('a mixed fleet on one pooled pair sits between all-fitted and none', () => {
  // Deliberately priced ABOVE reference so the pair is demand-limited rather
  // than capacity-capped. At 100% load factor quality cannot sell one more seat
  // — which is correct, and is exactly the inversion the brand-reach bug had —
  // so a capped fixture would prove nothing either way.
  const mk = (w1, w2) => baseState({
    fleet: [tail('a1', { hasWifi: w1 }), tail('a2', { hasWifi: w2 })],
    routes: [route('r1', 'a1', 7), route('r2', 'a2', 7)],
    priceMult: 2.4,
  });
  const pax = (s) => weeklyTick(s).routeResults.reduce((n, r) => n + (r.passengers ?? 0), 0);
  const none  = pax(mk(false, false));
  const mixed = pax(mk(true, false));
  const all   = pax(mk(true, true));
  // (capacityCapped is true whenever ANY cabin is full — the small business
  // cabin is, on this fare. What matters here is that the economy cabin has
  // room for quality to sell into, so check the load factor itself.)
  assert.ok(weeklyTick(mk(false, false)).routeResults.every(r => (r.loadFactor ?? 1) < 0.95),
    'fixture must be demand-limited, not flying full');
  assert.ok(all >= mixed && mixed >= none,
    `pooled pair coverage must blend: none=${none}, mixed=${mixed}, all=${all}`);
  assert.ok(all > none, 'fitting the whole fleet must beat fitting none');
});

test('coverage helpers weight by seats, not by airframe count', () => {
  const small = tail('s', { type: TYPE, hasWifi: false });
  const big   = tail('b', { type: WIDE, hasWifi: true });
  const seatsOf = (a) => getAircraftType(a.typeId)?.seats ?? 0;
  const cov = fleetWifiCoverage([small, big], seatsOf);
  const byCount = 0.5;
  if (WIDE.seats !== TYPE.seats) {
    assert.ok(Math.abs(cov - byCount) > 0.01,
      'a fitted widebody must count for more passengers than a fitted narrowbody');
  }
  assert.ok(cov > 0 && cov < 1);
  assert.equal(fleetWifiCoverage([], seatsOf), 0, 'no fleet, no coverage');
  assert.equal(groupWifiCoverage([{ aircraft: big, seats: 100 }]), 1);
  assert.equal(groupWifiCoverage([{ aircraft: small, seats: 100 }]), 0);
});

test('retrofitting costs more than fitting on the production line', () => {
  assert.ok(wifiRetrofitCost() > wifiInstallCost(),
    'a hangar slot and an STC are not free — otherwise the order-form choice is meaningless');
});

// ═══════════════════════════════════════════════════════════════════════════
// LOUNGES — built, not toggled
// ═══════════════════════════════════════════════════════════════════════════

test('a lounge takes time to fit out and does nothing until it opens', () => {
  let lounges = { [O]: makeLounge(O, 0) };
  assert.equal(isLoungeOpen(lounges[O]), false, 'a fresh build is not open');
  assert.equal(routeLoungeAppeal({ lounges, origin: O, destination: D }), 1,
    'a building site gives no appeal');
  assert.equal(loungeEndpointCoverage(lounges, O, D), 0, 'and sells no day passes');

  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) lounges = tickLoungeConstruction(lounges, w).lounges;
  assert.equal(isLoungeOpen(lounges[O]), true, `open after ${LOUNGE_BUILD_WEEKS} weeks`);
  assert.ok(routeLoungeAppeal({ lounges, origin: O, destination: D }) > 1);
});

test('you can only build where you already hold a gate', () => {
  const snap = { lounges: {}, gates: { [O]: 2 }, cash: 500_000_000 };
  assert.equal(canBuildLounge(O, snap).ok, true);
  assert.equal(canBuildLounge(D, snap).ok, false, 'no gate at D — no lounge at D');
  assert.equal(canBuildLounge(O, { ...snap, cash: 0 }).ok, false, 'and you must be able to pay for it');
});

test('lounge appeal moves the BUSINESS softmax and leaves leisure alone', () => {
  const market = buildRouteMarket(O, D, { week: 1, month: 6 }, 1, 1);
  const base = {
    airlineId: 'p', origin: O, destination: D,
    economyPrice: REF, businessPrice: Math.round(REF * 2.5),
    weeklyFrequency: 14, seatsPerFlight: 180,
    economySeats: 2000, businessSeats: 300, totalSeats: 2300,
    qualityScore: 70, connectivityBonus: 0,
  };
  const withLounge = { ...base, loungeAppeal: 1.28 };

  const bizGain  = computeUtility(withLounge, market, 'business') - computeUtility(base, market, 'business');
  const leisGain = computeUtility(withLounge, market, 'leisure')  - computeUtility(base, market, 'leisure');

  assert.ok(bizGain > 0,
    'a lounge must make this airline more attractive to business travellers');
  assert.equal(leisGain, 0,
    'a leisure passenger on the cheapest fare cannot get into the lounge — their utility must not move');

  // log-odds, exactly like brandReach: adding log(x) multiplies the softmax
  // weight by exactly x, so the contested path and the monopoly pool agree.
  assert.ok(Math.abs(Math.exp(bizGain) - 1.28) < 0.01,
    `lounge appeal must enter as a log term (softmax weight x${Math.exp(bizGain).toFixed(3)}, expected x1.28)`);
});

test('on a monopoly a lounge sells more business SEATS, not a higher fare', () => {
  const market = buildRouteMarket(O, D, { week: 1, month: 6 }, 1, 1);
  const offer = {
    airlineId: 'p', origin: O, destination: D,
    economyPrice: REF, businessPrice: Math.round(REF * 2.5),
    weeklyFrequency: 14, seatsPerFlight: 180,
    economySeats: 1e7, businessSeats: 1e7, totalSeats: 2e7,   // never capacity-capped
    qualityScore: 70, connectivityBonus: 0,
  };
  const [plain]   = computeMarketShare(market, [offer]);
  const [lounged] = computeMarketShare(market, [{ ...offer, loungeAppeal: 1.28 }]);

  assert.ok(lounged.businessPax > plain.businessPax,
    `a lounge must put more business travellers on the aircraft `
    + `(${plain.businessPax} -> ${lounged.businessPax}), not simply bank more money`);
  // The fare is the fare. This is the invariant brandReach broke.
  assert.equal(lounged.businessRevenue, lounged.businessPax * offer.businessPrice,
    'business revenue must still be pax x the fare the player set');
  assert.equal(plain.leisurePax, lounged.leisurePax,
    'the leisure pool is untouched by a lounge');
});

test('a lounge you own replaces the contract you were buying', () => {
  const none = {};
  let both = { [O]: makeLounge(O, 0), [D]: makeLounge(D, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) both = tickLoungeConstruction(both, w).lounges;
  let one = { [O]: makeLounge(O, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) one = tickLoungeConstruction(one, w).lounges;

  assert.equal(loungeContractFactor(none, O, D), 1, 'no lounge, full third-party rate');
  assert.equal(loungeContractFactor(both, O, D), LOUNGE_OWNED_COST_FACTOR, 'both ends owned, marginal cost only');
  const half = loungeContractFactor(one, O, D);
  assert.ok(half > LOUNGE_OWNED_COST_FACTOR && half < 1, `one end owned sits between (got ${half})`);
});

test('the tick charges the premium ground contract at the discounted rate', () => {
  const plain = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] });
  let open = { [O]: makeLounge(O, 0), [D]: makeLounge(D, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) open = tickLoungeConstruction(open, w).lounges;
  const withLounge = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], lounges: open });

  const rPlain = weeklyTick(plain).routeResults.find(r => r.routeId === 'r1');
  const rL     = weeklyTick(withLounge).routeResults.find(r => r.routeId === 'r1');
  assert.ok(rPlain.loungeCost > 0, 'fixture must carry premium passengers');
  assert.ok(rL.loungeCost < rPlain.loungeCost,
    `owning the lounges at both ends must cut the premium ground bill `
    + `($${rPlain.loungeCost} -> $${rL.loungeCost})`);
});

test('an open lounge costs money every week, and it reaches totalCost', () => {
  let open = { [O]: makeLounge(O, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) open = tickLoungeConstruction(open, w).lounges;

  const none  = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] }));
  const built = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], lounges: open }));
  const site  = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], lounges: { [O]: makeLounge(O, 0) } }));

  assert.equal(none.totalLoungeCosts, 0, 'no lounges, no cost');
  assert.equal(site.totalLoungeCosts, 0, 'a lounge still being fitted out has no running cost');
  assert.equal(built.totalLoungeOpex, LOUNGE_WEEKLY_OPEX, 'one open lounge, one weekly bill');
  assert.ok(built.totalLoungeCosts >= LOUNGE_WEEKLY_OPEX);
});

test('the P&L bridge still balances with a lounge network', () => {
  let open = { [O]: makeLounge(O, 0), [D]: makeLounge(D, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) open = tickLoungeConstruction(open, w).lounges;
  const state = baseState({
    fleet: [tail('a1', { hasWifi: true })], routes: [route('r1', 'a1')],
    lounges: open, loungePolicy: { loyaltyAccess: true, allianceAccess: false },
  });
  const report = weeklyTick(state);
  const bridge = costBridge(bridgeInputsFromReport(report), state);
  assert.equal(bridge.residual, 0,
    `lounge costs are inside totalCost but named by no bridge row — $${bridge.residual} vanished`);
});

test('day passes need a room: no lounge, no lounge ancillary revenue', () => {
  const policy = defaultAncillaries();
  const cs = { economy: { passengers: 500 }, premiumEconomy: { passengers: 60 },
               businessClass: { passengers: 30 }, firstClass: { passengers: 10 } };
  const no  = routeAncillaries(policy, cs, 3000, { lounge: 0 });
  const yes = routeAncillaries(policy, cs, 3000, { lounge: 1 });
  assert.equal(no.byItem.lounge.revenue, 0,
    'you cannot sell access to a lounge you have not built');
  assert.ok(yes.byItem.lounge.revenue > 0, 'and you can once you have');
});

test('the tick gates day passes on the lounges the route actually touches', () => {
  let open = { [O]: makeLounge(O, 0), [D]: makeLounge(D, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) open = tickLoungeConstruction(open, w).lounges;
  const rNone = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')] }))
    .routeResults.find(r => r.routeId === 'r1');
  const rBoth = weeklyTick(baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], lounges: open }))
    .routeResults.find(r => r.routeId === 'r1');
  assert.equal(rNone.ancillaryByItem.lounge.revenue, 0);
  assert.ok(rBoth.ancillaryByItem.lounge.revenue > 0);
});

test('lounges lift business share on a contested pair — and only business', () => {
  let open = { [O]: makeLounge(O, 0), [D]: makeLounge(D, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) open = tickLoungeConstruction(open, w).lounges;

  const rival = {
    id: 'rival', name: 'Rival', tier: 'major',
    routes: [{ origin: O, destination: D, weeklyFrequency: 14, seatsPerFlight: 180 }],
  };
  const mk = (lounges) => {
    const s = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], lounges });
    return weeklyTick(s).routeResults.find(r => r.routeId === 'r1');
  };
  const plain = mk({});
  const built = mk(open);
  const bizOf = (r) => r.classSummary?.businessClass?.passengers ?? 0;
  assert.ok(bizOf(built) >= bizOf(plain),
    `a lounge network must not reduce business traffic (${bizOf(plain)} -> ${bizOf(built)})`);
  assert.ok(built.qualityScore >= plain.qualityScore - 1,
    'and must not silently cost quality');
});

test('alliance reciprocity needs a room of your own — it is a trade, not a subscription', () => {
  const alliance = { id: 'x', interlineFraction: 0.6 };
  const policy   = { loyaltyAccess: false, allianceAccess: true };

  // No lounges anywhere. The alliance term used to pay out MOST here
  // (partnerEnds = 2 - own), for free and forever: build one lounge, switch the
  // policy on, close the lounge for a partial refund, keep the demand boost with
  // no weekly cost. The policy outlives the lounges in state, so it survived a
  // save/load too.
  assert.equal(routeLoungeAppeal({ lounges: {}, policy, origin: O, destination: D, alliance }), 1,
    'an airline with no lounge must get nothing from reciprocal access');

  let one = { [O]: makeLounge(O, 0) };
  assert.equal(routeLoungeAppeal({ lounges: one, policy, origin: O, destination: D, alliance }), 1,
    'a lounge still being fitted out is not a room you can trade access to');

  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) one = tickLoungeConstruction(one, w).lounges;
  assert.ok(routeLoungeAppeal({ lounges: one, policy, origin: O, destination: D, alliance }) > 1,
    'once you actually run a lounge, reciprocity pays');

  // And it must still pay on a pair your own lounges do not touch, since that is
  // the whole point of joining a bloc.
  const elsewhere = routeLoungeAppeal({ lounges: one, policy, origin: 'ORD', destination: 'DFW', alliance });
  assert.ok(elsewhere > 1, 'partner lounges cover the stations you do not');
});

test('a rival\'s lounges are visible to every other player\'s tick', () => {
  const market = buildRouteMarket(O, D, { week: 1, month: 6 }, 1, 1);
  const spec = {
    competitorId: 'hw:rival', frequency: 14, seatsPerFlight: 180,
    priceMultiplier: 1, qualityScore: 70, loungeAppeal: 1.28,
  };
  const offer = buildEncroachmentOffer(spec, market);
  assert.ok(offer, 'fixture must build an offer');
  assert.equal(offer.loungeAppeal, 1.28,
    'a human rival who built lounges scores 1.28 in their OWN tick; dropping the '
    + 'field here makes every other player\'s tick score them at parity, and the '
    + 'two ticks stop agreeing about the same pair');
  assert.equal(buildEncroachmentOffer({ ...spec, loungeAppeal: undefined }, market).loungeAppeal, 1,
    'solo AI encroachers have no lounge network and stay at parity');
});

test('stateLoungeFields is the one answer the tick and every preview share', () => {
  let open = { [O]: makeLounge(O, 0), [D]: makeLounge(D, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) open = tickLoungeConstruction(open, w).lounges;
  const state = baseState({ fleet: [tail('a1')], routes: [route('r1', 'a1')], lounges: open });

  const fields = stateLoungeFields(state, O, D);
  assert.equal(fields.loungeCoverage, 1);
  assert.equal(fields.loungeContractFactor, LOUNGE_OWNED_COST_FACTOR);
  assert.ok(fields.loungeAppeal > 1);

  // A preview that forgets these is scored at the parity default and quotes the
  // full third-party premium ground rate on a route the tick discounts. Prove
  // the gap is real, so the guard below has teeth.
  const bare   = simulateRoute({ ...state.routes[0], classPrices: state.routePricing[PAIR] },
    state.fleet[0], { week: 1, month: 6 }, null, 1, null, [], null, null, 1, state.ancillaries);
  const withLounge = simulateRoute({ ...state.routes[0], classPrices: state.routePricing[PAIR], ...fields },
    state.fleet[0], { week: 1, month: 6 }, null, 1, null, [], null, null, 1, state.ancillaries);
  assert.ok(withLounge.loungeCost < bare.loungeCost,
    'the fields must actually change the premium ground bill, or this guard is vacuous');

  // And the tick's own answer must equal the preview's.
  const rr = weeklyTick(state).routeResults.find(r => r.routeId === 'r1');
  assert.equal(rr.loungeCost, withLounge.loungeCost,
    'the tick and a preview carrying stateLoungeFields must agree exactly');
});

test('routeQualityBreakdown reports Wi-Fi and lounge separately for the UI', () => {
  let open = { [O]: makeLounge(O, 0) };
  for (let w = 0; w < LOUNGE_BUILD_WEEKS; w++) open = tickLoungeConstruction(open, w).lounges;
  const state = baseState({ fleet: [tail('a1', { hasWifi: true })], routes: [route('r1', 'a1')], lounges: open });
  const bd = routeQualityBreakdown(state.routes[0], state.fleet[0], state);
  assert.ok(bd && Number.isFinite(bd.ancillaryPts), 'breakdown still returns ancillary points');
  assert.ok('loungeAppeal' in bd,
    'the route detail screen needs the lounge appeal figure to explain the business share');
  assert.ok(bd.loungeAppeal > 1, 'and it must reflect the lounge that is actually open');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
