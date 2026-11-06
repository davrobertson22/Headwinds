// Seat products (data/seatProducts.js): what is bolted into each cabin.
//
// Economy pitch gives floor back or takes it; lie-flats and suites take more
// and lift quality; screens, bars and showers are extras. The points a cabin
// earns reach the segment that sits in it — economy's reach leisure, the
// premium cabins' reach business — through qualityScoreLeisure/Business on
// the offer. A config with no products is byte-identical to before.
//
//   node tools/seat-products-test.mjs

import assert from 'node:assert/strict';
import {
  SEAT_PRODUCTS, productOf, hasProducts, productSpaceMul, productQualityPts, cabinProductPoints,
  productWeeklyCost, productFittingCost, productAvailability, productDenial, defaultProducts, compactProducts,
} from '../packages/engine/src/data/seatProducts.js';
import {
  CLASS_SPACE_MULTIPLIERS, classSpaceUnits, configSeatUnits, calcReconfCost, refitWeeks, defaultConfig,
  simulateRoute, SEAT_QUALITY_COST_PER_ROUTE, SERVICE_QUALITY_COST_PER_ROUTE,
  SEAT_QUALITY_FITTING_FEE, CABIN_INSTALL_FEE_PER_SEAT, REFIT_SEAT_COST, REFIT_MIN_COST,
} from '../packages/engine/src/utils/simulation.js';
import { cabinQualityPoints, cabinSegmentQualityDelta, computeMarketShare, SEAT_QUALITY_POINTS, SERVICE_QUALITY_POINTS, leisureQ, businessQ } from '../packages/engine/src/models/demand.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { routeQualityBreakdown } from '../packages/engine/src/utils/simulation.js';
import { buildPlayerPairOffer } from '../packages/engine/src/models/pairShare.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const A320 = getAircraftType('a320neo'), B789 = getAircraftType('b7879'), A380 = getAircraftType('a380');
const CLS = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];
const legacy = (cfg) => ({ firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: 0, seatQuality: 'standard', serviceQuality: 'standard', ...cfg });
const withProducts = (cfg, products) => ({ ...legacy(cfg), products: { ...defaultProducts(), ...products } });
const flatJ = { businessClass: { tier: 'flat', extras: [] } };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Legacy configs are untouched ──────────────────────────');

test('no products: floor, points, costs and refit price are the old numbers', () => {
  for (const cfg of [legacy({ economy: 180 }), legacy({ firstClass: 8, businessClass: 42, premiumEconomy: 28, economy: 220, seatQuality: 'luxury', serviceQuality: 'premium' }), { economy: 150 }]) {
    for (const c of CLS) assert.equal(classSpaceUnits(cfg, c), CLASS_SPACE_MULTIPLIERS[c]);
    assert.equal(cabinProductPoints(cfg).blended, 0);
    assert.deepEqual(cabinSegmentQualityDelta(cfg), { leisure: 0, business: 0 });
    assert.equal(cabinQualityPoints(cfg), (SEAT_QUALITY_POINTS[cfg.seatQuality ?? 'standard'] ?? 0) + (SERVICE_QUALITY_POINTS[cfg.serviceQuality ?? 'standard'] ?? 0));
    assert.equal(productWeeklyCost(cfg), 0);
    assert.equal(productFittingCost(defaultConfig(200), cfg), 0);
    assert.equal(hasProducts(cfg), false);
  }
  const cur = legacy({ economy: 180, seatQuality: 'basic' }), nxt = legacy({ businessClass: 12, economy: 162, seatQuality: 'standard' });
  const expected = Math.max(REFIT_MIN_COST, 12 * REFIT_SEAT_COST + 12 * CABIN_INSTALL_FEE_PER_SEAT.businessClass + SEAT_QUALITY_FITTING_FEE.standard);
  assert.equal(calcReconfCost(cur, nxt), expected);
  assert.equal(calcReconfCost(cur, cur), 0);
});

test('an all-default products object is the legacy config in every number', () => {
  const a = legacy({ businessClass: 20, economy: 150 });
  const b = { ...a, products: defaultProducts() };
  assert.equal(configSeatUnits(b), configSeatUnits(a));
  assert.equal(cabinQualityPoints(b), cabinQualityPoints(a));
  assert.equal(productWeeklyCost(b), 0);
  assert.equal(calcReconfCost(a, b), 0, 'no refit for choosing the defaults');
  assert.equal(compactProducts(b.products), undefined);
});

const ROUTE = { origin: 'JFK', destination: 'LAX', weeklyFrequency: 14, ticketPrice: 300, classPrices: { economy: 300, businessClass: 900, premiumEconomy: 450, firstClass: 1800 } };
const tail = (typeId, config) => ({ id: 't1', typeId, name: 'T', status: 'idle', ageWeeks: 52, ownershipType: 'owned', config });

test('a legacy cabin scores both segments at its single quality (breakdown and pair offer)', () => {
  const t = tail('b7879', legacy({ firstClass: 8, businessClass: 42, premiumEconomy: 28, economy: 220 }));
  const state = { ...freshState(), phase: 'playing', fleet: [t], routes: [{ id: 'r1', ...ROUTE, aircraftId: 't1' }] };
  const qb = routeQualityBreakdown(state.routes[0], t, state);
  assert.ok(qb.total > 0);
  assert.equal(qb.totalLeisure, qb.total);
  assert.equal(qb.totalBusiness, qb.total);
  assert.deepEqual(qb.segmentDelta, { leisure: 0, business: 0 });
  const offer = buildPlayerPairOffer(state, state.routes);
  if (offer) {
    assert.equal(offer.qualityScoreLeisure, offer.qualityScore);
    assert.equal(offer.qualityScoreBusiness, offer.qualityScore);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Floor ─────────────────────────────────────────────────');

test('28" pitch fits seven per cent more seats on the same floor; 34" an eighth fewer', () => {
  const dense = withProducts({ economy: 208 }, { economy: { tier: '28', extras: [] } });
  assert.ok(configSeatUnits(dense) <= A320.seats + 1e-9, `${configSeatUnits(dense)} over ${A320.seats}`);
  assert.ok(configSeatUnits({ ...dense, economy: 209 }) > A320.seats);
  const roomy = withProducts({ economy: 170 }, { economy: { tier: '34', extras: [] } });
  assert.ok(configSeatUnits(roomy) <= A320.seats && configSeatUnits({ ...roomy, economy: 171 }) > A320.seats);
});

test('a lie-flat with aisle access takes 1.5 × 1.18 × 1.12 economy seats of floor', () => {
  const cfg = withProducts({ businessClass: 1 }, { businessClass: { tier: 'flat', extras: ['aisle'] } });
  assert.ok(Math.abs(classSpaceUnits(cfg, 'businessClass') - 1.5 * 1.18 * 1.12) < 1e-9);
  assert.equal(classSpaceUnits(cfg, 'economy'), 1, 'other cabins keep their own floor');
});

test('the server guard rejects a cabin that only fits because the client ignored the products', () => {
  const state = { ...freshState(), fleet: [tail('a320neo', legacy({ economy: 180 }))] };
  const ok = withProducts({ businessClass: 20, economy: 150 }, flatJ);          // 20×1.77 + 150 = 185.4
  const over = withProducts({ businessClass: 29, economy: 150 }, flatJ);        // 29×1.77 + 150 = 201.3 > 194
  assert.doesNotThrow(() => guardDecision('CONFIGURE_AIRCRAFT', { aircraftId: 't1', config: ok }, state));
  assert.throws(() => guardDecision('CONFIGURE_AIRCRAFT', { aircraftId: 't1', config: over }, state), /capacity/);
  assert.ok(29 * 1.5 + 150 <= A320.seats, 'the same seats fit as recliners — it is the lie-flats that overflow');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Quality, by segment ───────────────────────────────────');

test('flat beds reach the business segment and not leisure', () => {
  const cfg = withProducts({ businessClass: 42, economy: 240 }, flatJ);
  const d = cabinSegmentQualityDelta(cfg);
  const p = cabinProductPoints(cfg);
  assert.equal(p.business, 15);
  assert.equal(p.leisure, 0);
  assert.ok(Math.abs(p.blended - (42 * 15) / 282) < 1e-9);
  assert.ok(d.business > 0 && d.leisure < 0 && Math.abs(d.business - d.leisure - 15) < 1e-9);
});

test('a dense 28" economy hurts leisure and leaves business alone', () => {
  const cfg = withProducts({ businessClass: 42, economy: 258 }, { economy: { tier: '28', extras: [] } });
  const p = cabinProductPoints(cfg);
  assert.equal(p.leisure, -5);
  assert.equal(p.business, 0);
});

test('an all-economy aircraft shows business travellers the economy product', () => {
  const p = cabinProductPoints(withProducts({ economy: 180 }, { economy: { tier: '34', extras: ['screens'] } }));
  assert.equal(p.leisure, 11);
  assert.equal(p.business, 11);
});

test('the breakdown carries the split, whole and one-sided, and the route sells more business seats', () => {
  const mk = (products) => {
    const t = tail('b7879', withProducts({ businessClass: 42, economy: 240 }, products));
    const state = { ...freshState(), phase: 'playing', fleet: [t], routes: [{ id: 'r1', ...ROUTE, aircraftId: 't1' }] };
    return { qb: routeQualityBreakdown(state.routes[0], t, state), r: simulateRoute(ROUTE, t, { month: 6 }) };
  };
  const recl = mk({}), flat = mk(flatJ);
  assert.ok(Number.isInteger(flat.qb.totalLeisure) && Number.isInteger(flat.qb.totalBusiness), 'whole numbers, like the score');
  assert.ok(flat.qb.totalBusiness > flat.qb.totalLeisure, 'business sees the beds');
  assert.ok(flat.qb.totalBusiness > recl.qb.totalBusiness);
  assert.equal(flat.qb.totalLeisure, recl.qb.totalLeisure, 'a business product leaves the leisure score exactly where it was');
  const bizPax = (x) => x.r.classSummary.businessClass.passengers;
  assert.ok(bizPax(flat) >= bizPax(recl), `business pax ${bizPax(flat)} < ${bizPax(recl)}`);
  assert.ok(leisureQ({ qualityScore: 50 }) === 50 && businessQ({ qualityScore: 50, qualityScoreBusiness: 70 }) === 70);
  assert.equal(flat.r.qualityScoreLeisure, undefined, 'the stored route result keeps its old shape (golden master)');
});

test('on a contested pair, lie-flats take business share and leave leisure share alone', () => {
  const market = { leisureDemand: 4000, businessDemand: 1200, referencePrice: 300, distanceKm: 3900 };
  const base = { origin: 'JFK', destination: 'LAX', economyPrice: 300, businessPrice: 900, weeklyFrequency: 14, seatsPerFlight: 300, economySeats: 1e9, businessSeats: 1e9, totalSeats: 1e9, qualityScore: 60, connectivityBonus: 0 };
  const rival = { ...base, airlineId: 'rival' };
  const me0 = { ...base, airlineId: 'player' };
  const me1 = { ...base, airlineId: 'player', qualityScoreLeisure: 60, qualityScoreBusiness: 75 };
  const s0 = computeMarketShare(market, [me0, rival]);
  const s1 = computeMarketShare(market, [me1, rival]);
  assert.ok(s1[0].businessShare > s0[0].businessShare, 'more business share with the beds');
  assert.equal(s1[0].leisureShare, s0[0].leisureShare, 'leisure share untouched');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Era and airframe ──────────────────────────────────────');

test('products arrive on their dates; classic worlds have everything', () => {
  const flat = SEAT_PRODUCTS.businessClass.tiers.find(t => t.key === 'flat');
  assert.equal(productAvailability(flat, { calYear: 1985 })?.code, 'not_yet_invented');
  assert.equal(productAvailability(flat, { calYear: 2000 }), null);
  assert.equal(productAvailability(flat, { calYear: null }), null);
  const cfg = withProducts({ businessClass: 10, economy: 100 }, flatJ);
  assert.equal(productDenial(cfg, { calYear: 1985, type: A320 })?.item, 'flat');
  assert.equal(productDenial(cfg, { calYear: 2026, type: A320 }), null);
});

test('apartments need a widebody, showers a double-decker', () => {
  const apt = withProducts({ firstClass: 4, economy: 100 }, { firstClass: { tier: 'apartment', extras: [] } });
  assert.equal(productDenial(apt, { type: A320 })?.code, 'airframe');
  assert.equal(productDenial(apt, { type: B789 }), null);
  const shower = withProducts({ firstClass: 4, economy: 100 }, { firstClass: { tier: 'suite', extras: ['shower'] } });
  assert.equal(productDenial(shower, { type: B789 })?.item, 'shower');
  assert.equal(productDenial(shower, { type: A380 }), null);
});

test('the reducer refuses a lie-flat in 1985 and takes it in 2026', () => {
  const mk = (startYear) => ({ ...freshState(), phase: 'playing', startYear, year: 1, week: 1, cash: 1e9, fleet: [tail('a320neo', legacy({ economy: 180 }))] });
  const cfg = withProducts({ businessClass: 10, economy: 170 }, flatJ);
  const old = gameReducer(mk(1985), { type: 'CONFIGURE_AIRCRAFT', aircraftId: 't1', config: cfg });
  assert.match(old.error ?? '', /does not exist yet/);
  assert.equal(old.fleet[0].config.products, undefined, 'nothing changed');
  const now = gameReducer(mk(2020), { type: 'CONFIGURE_AIRCRAFT', aircraftId: 't1', config: cfg });
  assert.equal(now.error, undefined);
  assert.equal(now.fleet[0].config.products.businessClass.tier, 'flat');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Money ─────────────────────────────────────────────────');

test('fitting: a tier change pays every seat, new seats pay their own, downgrades are free', () => {
  const recl = withProducts({ businessClass: 42, economy: 240 }, {});
  const flat = withProducts({ businessClass: 42, economy: 240 }, flatJ);
  assert.equal(productFittingCost(recl, flat), 42 * 40_000);
  assert.equal(productFittingCost(flat, { ...flat, businessClass: 52 }), 10 * 40_000);
  assert.equal(productFittingCost(flat, recl), 0);
  const bar = withProducts({ firstClass: 8, economy: 240 }, { firstClass: { tier: 'suite', extras: ['bar'] } });
  assert.equal(productFittingCost(legacy({ firstClass: 8, economy: 240 }), bar), 8 * 90_000 + 400_000);
  assert.equal(productFittingCost(bar, { ...bar, firstClass: 10 }), 2 * 90_000, 'the bar is per aircraft, paid once');
});

test('the refit price and downtime include the products', () => {
  const recl = withProducts({ businessClass: 42, economy: 240 }, {});
  const flat = withProducts({ businessClass: 42, economy: 240 }, flatJ);
  assert.equal(calcReconfCost(recl, flat), 42 * 40_000);
  assert.ok(refitWeeks(B789, recl, flat) > 0, 'fitting beds is shop work');
  assert.equal(calcReconfCost(flat, flat), 0);
});

test('weekly upkeep per route: seats × tier + extras, bar flat', () => {
  const cfg = withProducts({ businessClass: 42, economy: 240 }, { businessClass: { tier: 'flat', extras: ['screens'] }, economy: { tier: '30', extras: ['power'] } });
  assert.equal(productWeeklyCost(cfg), 42 * (35 + 5) + 240 * 1);
  const r = simulateRoute(ROUTE, tail('b7879', cfg), { month: 6 });
  assert.equal(r.qualityCost, SEAT_QUALITY_COST_PER_ROUTE.standard + SERVICE_QUALITY_COST_PER_ROUTE.standard + productWeeklyCost(cfg));
});

test('an order pays for the products on the line', () => {
  const base = { ...freshState(), phase: 'playing', cash: 5e8, year: 1, week: 1 };
  const plain = gameReducer(base, { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'buy', quantity: 1, config: legacy({ businessClass: 12, economy: 150 }) });
  const beds  = gameReducer(base, { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'buy', quantity: 1, config: withProducts({ businessClass: 12, economy: 150 }, flatJ) });
  assert.ok(plain.cash < base.cash, 'the order went through');
  assert.equal(plain.cash - beds.cash, 12 * 40_000, 'the beds cost exactly their fitting');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
