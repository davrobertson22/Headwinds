// Custom catering — service plans built from an item menu.
//
// Guards the design locked with Dave on 2026-11-11 (project doc
// claude/custom-catering-design.md):
//
//   1. The Standard expected set costs exactly what classic Full Service costs.
//   2. One quality scale: −12 with nothing, +11 at the expected set, up to +17.
//   3. Tiers: Basic 60% of the cost for 70% of the value, Premium 150% for 125%.
//   4. Sold items: only buyers are served; dearer means fewer buyers and less
//      quality; an overpriced item is never worse than not offering it.
//   5. Short flights: the meal counts for half, the expected set still sums to 1.
//   6. Customising a classic level lands close to it.
//   7. Kitchens: a caterer leaves out what it cannot make, at the end it cooks for.
//   8. A world with no plan in use is byte-identical (golden master).
//   9. The tick, the previews and reputation all read the plan.
//  10. Reducer: save, assign, delete, load.
//  11. Headwinds: new worlds only (world flag, join stamp, server guard).
//
//   node tools/catering-plans-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  weeklyTick, defaultClassPrices, stateCateringFields, routeDistanceKm, hydrateRoute,
  routeQualityBreakdown, stateCateringCapReport, stateCateringKitchenReport, deliveredExperience,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { defaultAncillaries } from '../packages/engine/src/data/ancillaries.js';
import { routeCatering, cateringQualityBonus, CABIN_CLASSES, CATERING_LEVEL_ORDER } from '../packages/engine/src/data/catering.js';
import { makeCateringContract } from '../packages/engine/src/data/cateringContracts.js';
import {
  CATERING_ITEMS, CATERING_EXPECTED, CATERING_TIERS, MAX_CATERING_PLANS,
  CATERING_SCORE_NONE, CATERING_SCORE_FULL, CATERING_SCORE_CEILING, CATERING_SOLD_VALUE_AT_REF,
  itemCost, itemReferencePrice, itemMaxPrice, itemValue, itemTakeRate, soldValueFactor,
  cabinMenuEconomics, planCabinEconomics, cabinQualityWeights, planQualityBonus, planRouteCatering,
  classicTemplateCabins, sanitizeCateringPlan, cateringPlanSaveError, cateringPlanUsage,
  planRef, isPlanRef, planForRef, normalizeCateringRef, cateringRefName, cateringRefSummary,
  routeCateringEconomics, routeCateringQuality,
} from '../packages/engine/src/data/cateringPlans.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, expected ${b} ± ${tol}`);

console.log('\nCustom catering — service plans\n');

const free = (ids, tier = 'standard') => Object.fromEntries(ids.map(id => [id, { mode: 'free', tier }]));
const expected = (cabin, tier) => free(CATERING_EXPECTED[cabin], tier);
const plan = (id, cabins, extra = {}) => ({ id, name: `Plan ${id}`, cabins, ...extra });
const fullPlan = (id = 'std', tier = 'standard') => plan(id, Object.fromEntries(CABIN_CLASSES.map(c => [c, expected(c, tier)])));
const DISTS = [500, 2000, 6000, 12000];

// ═══════════════════════════════════════════════════════════════════════════
// The menu
// ═══════════════════════════════════════════════════════════════════════════

test('the Standard expected set costs exactly what classic Full Service costs, in every cabin at every distance', () => {
  for (const cabin of CABIN_CLASSES) for (const d of DISTS) {
    const classic = routeCatering('full', { [cabin]: { passengers: 50 } }, d).cost / 100;
    near(cabinMenuEconomics(expected(cabin), cabin, d).costPerPax, classic, 0.01, `${cabin} ${d} km`);
  }
});

test('one scale: nothing is the classic None, the expected set is the classic Full, and extras stop below the ceiling', () => {
  for (const cabin of CABIN_CLASSES) for (const d of DISTS) {
    assert.equal(cabinMenuEconomics({}, cabin, d).score, CATERING_SCORE_NONE);
    near(cabinMenuEconomics(expected(cabin), cabin, d).score, CATERING_SCORE_FULL, 1e-9, `${cabin} ${d}`);
    const everything = free(CATERING_ITEMS.map(i => i.id), 'premium');
    const top = cabinMenuEconomics(everything, cabin, d).score;
    assert.ok(top > CATERING_SCORE_FULL && top < CATERING_SCORE_CEILING, `${cabin} ${d}: ${top}`);
  }
  assert.equal(CATERING_SCORE_NONE, cateringQualityBonus('none', 2400), 'amp 1.0 at 2,400 km');
  assert.equal(CATERING_SCORE_FULL, cateringQualityBonus('full', 2400));
});

test('fine dining exists only up front; every other item is on every cabin\'s menu', () => {
  for (const it of CATERING_ITEMS) for (const cabin of CABIN_CLASSES) {
    const has = itemCost(it.id, cabin) != null;
    assert.equal(has, !(it.id === 'fineDining' && (cabin === 'economy' || cabin === 'premiumEconomy')), `${it.id} ${cabin}`);
  }
  assert.deepEqual(cabinMenuEconomics({ fineDining: { mode: 'free' } }, 'economy', 2000).rows, {});
});

test('tiers: Basic is cheaper and scores lower, Premium dearer and higher, with diminishing returns', () => {
  const at = (tier) => cabinMenuEconomics(expected('economy', tier), 'economy', 2000);
  const b = at('basic'), s = at('standard'), p = at('premium');
  near(b.costPerPax, 8, 0.001); near(s.costPerPax, 12, 0.001); near(p.costPerPax, 17, 0.001);
  assert.ok(b.score < s.score && s.score < p.score);
  assert.ok((s.score - b.score) / (s.costPerPax - b.costPerPax) > (p.score - s.score) / (p.costPerPax - s.costPerPax),
    'a dollar buys more quality going Basic → Standard than Standard → Premium');
  assert.equal(cabinMenuEconomics({ water: { mode: 'free', tier: 'premium' } }, 'economy', 2000).costPerPax, 0.5,
    'an untiered item ignores a tier');
  assert.equal(CATERING_TIERS.basic.cost, 0.6); assert.equal(CATERING_TIERS.premium.cost, 1.5); assert.equal(CATERING_TIERS.premium.value, 1.25);
});

test('cold and hot meals share a slot: only the better one counts, both are paid for', () => {
  const hot = cabinMenuEconomics(free(['hotMeal']), 'economy', 6000);
  const both = cabinMenuEconomics(free(['hotMeal', 'coldMeal']), 'economy', 6000);
  near(both.value, hot.value, 1e-9);
  assert.ok(both.costPerPax > hot.costPerPax);
  assert.equal(both.rows.coldMeal.shadowed, true);
  assert.equal(both.rows.coldMeal.points, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Free or sold
// ═══════════════════════════════════════════════════════════════════════════

test('sold: only buyers are served, and the hot meal example in the design holds', () => {
  const e = cabinMenuEconomics({ hotMeal: { mode: 'sold', price: 14 } }, 'economy', 2000).rows.hotMeal;
  near(e.take, 0.167, 0.001);
  near(e.revenuePerPax, 0.167 * 14, 0.02);
  near(e.netPerPax, 1.17, 0.01, 'net per passenger on board');
  near(cabinMenuEconomics(free(['hotMeal']), 'economy', 2000).netPerPax, -7, 1e-9);
});

test('sold: dearer means fewer buyers and less quality, all the way down to not offering it', () => {
  let lastTake = 2, lastPts = 1e9;
  for (const price of [0.01, 2, 7, 14, 20, 30, 60]) {
    const r = cabinMenuEconomics({ hotMeal: { mode: 'sold', price } }, 'economy', 2000);
    assert.ok(r.rows.hotMeal.take <= lastTake && r.rows.hotMeal.points <= lastPts, `at $${price}`);
    assert.ok(r.score >= CATERING_SCORE_NONE, 'never worse than nothing');
    lastTake = r.rows.hotMeal.take; lastPts = r.rows.hotMeal.points;
  }
  assert.equal(soldValueFactor('hotMeal', 'economy', 'standard', 14), CATERING_SOLD_VALUE_AT_REF);
  assert.equal(soldValueFactor('hotMeal', 'economy', 'standard', 60), 0);
});

test('sold: a price near zero sells to everyone and costs what free costs — no one-cent trick', () => {
  const cent = cabinMenuEconomics({ hotMeal: { mode: 'sold', price: 0.01 } }, 'economy', 2000);
  const fr = cabinMenuEconomics(free(['hotMeal']), 'economy', 2000);
  assert.equal(cent.rows.hotMeal.take, 1);
  near(cent.costPerPax, fr.costPerPax, 1e-9);
  assert.ok(cent.score <= fr.score);
});

test('sold with no price typed serves nothing: no cost, no sales, no quality', () => {
  const r = cabinMenuEconomics({ hotMeal: { mode: 'sold', price: null } }, 'economy', 2000);
  assert.deepEqual(r.rows, {});
  assert.equal(r.score, CATERING_SCORE_NONE);
});

test('pricing above twice cost gains a little, then loses: the profit peak is modest and interior', () => {
  const net = (p) => cabinMenuEconomics({ hotMeal: { mode: 'sold', price: p } }, 'economy', 2000).netPerPax;
  const best = Math.max(...[10, 12, 14, 16, 18, 20, 22, 26, 30, 40].map(net));
  assert.ok(best > net(14) && best < net(14) * 1.15, `peak ${best.toFixed(3)} vs ${net(14).toFixed(3)} at $14`);
  assert.ok(net(40) < net(14));
});

test('premium cabins buy more often; long flights sell a little more', () => {
  const t = (cabin, d) => itemTakeRate('softDrinks', cabin, 'standard', itemReferencePrice('softDrinks', cabin), d);
  assert.ok(t('firstClass', 2000) > t('businessClass', 2000) && t('businessClass', 2000) > t('economy', 2000));
  assert.ok(t('economy', 9000) > t('economy', 2000));
  assert.equal(itemMaxPrice('hotMeal', 'economy', 'standard'), 70);
});

// ═══════════════════════════════════════════════════════════════════════════
// Distance
// ═══════════════════════════════════════════════════════════════════════════

test('short flights: the meal counts for half, drinks and the snack for more, and the expected set still sums to 1', () => {
  near(itemValue('hotMeal', 'economy', 500), 0.275, 1e-9);
  near(itemValue('hotMeal', 'economy', 4000), 0.55, 1e-9);
  near(itemValue('hotMeal', 'economy', 12000), 0.55, 1e-9);
  assert.ok(itemValue('softDrinks', 'economy', 500) > itemValue('softDrinks', 'economy', 6000));
  assert.ok(itemValue('hotMeal', 'economy', 2500) > 0.275 && itemValue('hotMeal', 'economy', 2500) < 0.55, 'a straight blend between');
  const drinksAndSnack = free(['water', 'softDrinks', 'snack']);
  assert.ok(cabinMenuEconomics(drinksAndSnack, 'economy', 500).score > cabinMenuEconomics(drinksAndSnack, 'economy', 6000).score + 4,
    'a drink and a snack is decent service on a hop and thin on long haul');
});

test('the stakes rise with distance: same menu, bigger bill and bigger quality swing', () => {
  const p = fullPlan();
  const cfg = { economy: 150, businessClass: 12 };
  assert.ok(planQualityBonus(p, 9000, cfg) > planQualityBonus(p, 500, cfg));
  for (const d of DISTS) assert.equal(planQualityBonus(p, d, cfg), cateringQualityBonus('full', d), `Full-equivalent at ${d} km`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Cabins and the route number
// ═══════════════════════════════════════════════════════════════════════════

test('cabin weights: economy half, premium cabins the other half by seats; one cabin stands alone', () => {
  assert.deepEqual(cabinQualityWeights({ economy: 150, businessClass: 12 }), { economy: 0.5, businessClass: 0.5 });
  const w = cabinQualityWeights({ economy: 200, premiumEconomy: 30, businessClass: 20, firstClass: 10 });
  near(w.premiumEconomy, 0.25, 1e-9); near(w.firstClass, 0.5 / 6, 1e-9);
  assert.deepEqual(cabinQualityWeights({ economy: 180, businessClass: 0 }), { economy: 1 });
  assert.deepEqual(cabinQualityWeights({ economy: 0, businessClass: 40 }), { businessClass: 1 });
  assert.deepEqual(cabinQualityWeights(null), { economy: 0.5, businessClass: 0.5 });
});

test('customising a classic level lands close to it: None, Partial and Full on the money, Hybrid and Paid near', () => {
  const layouts = [{ economy: 150, businessClass: 12 }, { economy: 200, premiumEconomy: 28, businessClass: 40, firstClass: 8 }];
  for (const cfg of layouts) for (const d of [2000, 6000]) for (const lvl of CATERING_LEVEL_ORDER) {
    const p = plan('t', classicTemplateCabins(lvl));
    const a = cateringRefSummary(lvl, {}, d, cfg), b = cateringRefSummary('plan:t', { t: p }, d, cfg);
    const moneyTol = lvl === 'hybrid' ? Math.abs(a.netPerPax) * 0.10 : lvl === 'paid' ? a.netPerPax * 0.03 : 0.02;
    near(b.netPerPax, a.netPerPax, moneyTol + 0.011, `${lvl} ${d} km net/pax`);
    near(b.quality, a.quality, lvl === 'paid' ? 4 : 1, `${lvl} ${d} km quality`);
  }
});

test('copies of classic levels carry twice-cost prices and Standard tiers', () => {
  const c = classicTemplateCabins('paid');
  assert.equal(c.economy.hotMeal.price, 14);
  assert.equal(c.businessClass.hotMeal.price, 60);
  assert.equal(c.economy.hotMeal.tier, 'standard');
  assert.deepEqual(classicTemplateCabins('none').economy, {});
  assert.equal(classicTemplateCabins('hybrid').economy.coldMeal.mode, 'free');
});

// ═══════════════════════════════════════════════════════════════════════════
// Kitchens
// ═══════════════════════════════════════════════════════════════════════════

test('a snack-box kitchen leaves out hot meals and courses; a standard kitchen serves Premium as Standard', () => {
  const menu = { ...free(['water', 'softDrinks']), hotMeal: { mode: 'free', tier: 'premium' }, courses: { mode: 'free', tier: 'standard' } };
  const full = cabinMenuEconomics(menu, 'businessClass', 6000, 'full');
  const std = cabinMenuEconomics(menu, 'businessClass', 6000, 'hybrid');
  const box = cabinMenuEconomics(menu, 'businessClass', 6000, 'partial');
  assert.equal(std.rows.hotMeal.servedTier, 'standard');
  assert.ok(std.costPerPax < full.costPerPax && std.score < full.score, 'served, and charged, as Standard');
  assert.equal(box.rows.hotMeal.made, false);
  assert.equal(box.rows.hotMeal.costPerPax, 0);
  assert.ok(box.score < std.score);
});

test('each end caters its own departures: one weak kitchen means half the flights go without', () => {
  const p = plan('k', { economy: free(['water', 'hotMeal']) });
  const both = planCabinEconomics(p, 'economy', 6000, ['full', 'full']);
  const none = planCabinEconomics(p, 'economy', 6000, ['partial', 'partial']);
  const half = planCabinEconomics(p, 'economy', 6000, ['full', 'partial']);
  near(half.costPerPax, (both.costPerPax + none.costPerPax) / 2, 1e-9);
  near(half.score, (both.score + none.score) / 2, 1e-9);
  assert.deepEqual(half.missing, ['hotMeal']);
  assert.deepEqual(both.missing, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// The tick
// ═══════════════════════════════════════════════════════════════════════════

const TYPE = getAircraftType('a320neo');
const O = 'JFK', D = 'LAX';
const PAIR = [O, D].sort().join('-');
const REF = Math.round(referencePrice(O, D));
const WEEK = 100;
const DIST = routeDistanceKm(O, D);
const CFG = { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: TYPE.seats - 12, seatQuality: 'standard', serviceQuality: 'standard' };
const tail = (id) => ({ id, typeId: TYPE.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: CFG });
const route = (id, aircraftId, freq = 14) => ({ id, origin: O, destination: D, stops: [O, D], aircraftId, weeklyFrequency: freq, weeksOpen: 60 });
function baseState({ cateringPlans, cateringContracts, routeCatering: rc = {} } = {}) {
  return {
    fleet: [tail('a1')], routes: [route('r1', 'a1')], cargoRoutes: [],
    gameDate: { week: 1, month: 6 },
    gates: { [O]: 10, [D]: 10 }, hubs: {},
    ...(cateringPlans ? { cateringPlans } : {}),
    ...(cateringContracts ? { cateringContracts } : {}),
    lounges: {}, loungePolicy: null,
    routePricing: { [PAIR]: defaultClassPrices(REF) },
    routeCatering: rc,
    competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null, campaignStrength: {}, targetedMarketing: {},
    awareness: 65, ancillaries: defaultAncillaries(), labor: undefined, absWeek: WEEK,
  };
}
const STD = fullPlan('std');
const LUX = plan('lux', {
  economy: { ...expected('economy', 'premium'), ...free(['snack', 'spirits']) },
  businessClass: { ...expected('businessClass', 'premium'), fineDining: { mode: 'free' } },
});
const LEAN = plan('lean', {
  economy: { water: { mode: 'free' }, softDrinks: { mode: 'sold', price: 3 }, coldMeal: { mode: 'sold', tier: 'basic', price: 6 } },
  businessClass: free(['water', 'softDrinks', 'coldMeal'], 'basic'),
});
const PLANS = { std: STD, lux: LUX, lean: LEAN };
const tickRoute = (st) => weeklyTick(st).routeResults.find(r => r.routeId === 'r1');

test('a world whose plans are not in use is byte-identical to a world without any', () => {
  const a = weeklyTick(baseState());
  const b = weeklyTick(baseState({ cateringPlans: PLANS }));
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  const r = route('r1', 'a1');
  assert.equal(hydrateRoute(r, {}, {}, PLANS), r, 'no ref, no copy');
  assert.equal(hydrateRoute(r, {}, { [PAIR]: 'paid' }, PLANS).cateringPlan, undefined);
});

test('the Standard expected set, as a plan, runs the tick to the same numbers as classic Full', () => {
  const classic = tickRoute(baseState());
  const asPlan = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:std' } }));
  assert.equal(asPlan.cateringLevel, 'plan:std');
  assert.equal(asPlan.cateringPlanId, 'std');
  assert.equal(asPlan.qualityScore, classic.qualityScore);
  assert.equal(asPlan.passengers, classic.passengers);
  near(asPlan.cateringCost, classic.cateringCost, 2);
  assert.equal(asPlan.cateringRevenue, 0);
});

test('the tick charges and credits exactly what the plan says for the passengers flown', () => {
  for (const id of ['lux', 'lean']) {
    const rr = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: planRef(id) } }));
    const want = planRouteCatering(PLANS[id], rr.classSummary, DIST);
    near(rr.cateringCost, want.cost, Math.max(5, want.cost * 0.002), `${id} cost`);
    near(rr.cateringRevenue, want.revenue, Math.max(5, want.revenue * 0.002), `${id} revenue`);
    assert.equal(rr.cateringQuality, planQualityBonus(PLANS[id], DIST, CFG), `${id} quality points`);
  }
});

test('better food costs more and lifts quality; a lean sold menu earns money and costs quality', () => {
  const std = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:std' } }));
  const lux = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:lux' } }));
  const lean = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:lean' } }));
  assert.ok(lux.cateringCost > std.cateringCost && lux.qualityScore > std.qualityScore);
  assert.ok(lean.cateringCost < std.cateringCost && lean.qualityScore < std.qualityScore);
  assert.ok(lean.cateringRevenue > 0);
  assert.ok(lux.cateringQuality > cateringQualityBonus('full', DIST), 'a custom plan can beat classic Full');
});

test('the tick never writes the plan back onto the stored route', () => {
  const st = baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:lux' } });
  weeklyTick(st);
  assert.equal(st.routes[0].cateringPlan, undefined);
  assert.equal(st.routeCatering[PAIR], 'plan:lux');
});

test('previews read the plan: stateCateringFields attaches it, and the quality breakdown matches the tick', () => {
  const st = baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:lean' } });
  assert.equal(stateCateringFields(st, st.routes[0]).cateringPlan, LEAN, 'a stored route inherits its pair\'s plan');
  assert.equal(stateCateringFields(st, { ...st.routes[0], cateringLevel: 'plan:lux' }).cateringPlan, LUX, 'a draft names its own');
  assert.deepEqual(stateCateringFields(st, { ...st.routes[0], cateringLevel: 'paid' }), {}, 'a draft on a classic level gets none');
  const rr = tickRoute(st);
  const bd = routeQualityBreakdown(st.routes[0], st.fleet[0], st);
  assert.equal(bd.cateringPts, rr.cateringQuality);
  const h = hydrateRoute(st.routes[0], st.routePricing, st.routeCatering, st.cateringPlans);
  assert.equal(routeCateringQuality(h, DIST, CFG), rr.cateringQuality);
  near(routeCateringEconomics(h, rr.classSummary, DIST).cost, rr.cateringCost, 5);
});

test('a ref to a plan that is gone falls back to Full Service everywhere', () => {
  const rr = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:ghost' } }));
  const classic = tickRoute(baseState());
  assert.equal(rr.cateringCost, classic.cateringCost);
  assert.equal(normalizeCateringRef('plan:ghost', PLANS), 'full');
  assert.equal(normalizeCateringRef('plan:lux', PLANS), 'plan:lux');
  assert.equal(normalizeCateringRef('paid', PLANS), 'paid');
  assert.equal(cateringRefName('plan:lux', PLANS), 'Plan lux');
  assert.equal(cateringRefName('hybrid', PLANS), 'Hybrid Service');
});

test('reputation reads the plan: delivered experience moves with what is served', () => {
  const routesFor = (ref) => baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: ref } }).routes
    .map(r => hydrateRoute(r, {}, { [PAIR]: ref }, PLANS));
  const de = (ref) => deliveredExperience({ fleet: [tail('a1')], routes: routesFor(ref), labor: null, ancillaries: null, lounges: {} });
  const lux = de('plan:lux'), std = de('plan:std'), lean = de('plan:lean'), classic = de('full');
  const num = (x) => (typeof x === 'number' ? x : x.score ?? x.overall ?? x.total);
  assert.ok(num(lux) > num(std) && num(std) > num(lean), `${num(lux)} > ${num(std)} > ${num(lean)}`);
  assert.equal(num(std), num(classic));
});

// ═══════════════════════════════════════════════════════════════════════════
// Plans under a catering contract
// ═══════════════════════════════════════════════════════════════════════════

test('under a snack-box caterer a plan is not level-capped: it loses the items that kitchen cannot make', () => {
  const c = makeCateringContract('bigsky', 1, WEEK);   // US, cap partial
  const contracts = { [c.id]: c };
  const st = baseState({ cateringPlans: PLANS, cateringContracts: contracts, routeCatering: { [PAIR]: 'plan:std' } });
  const f = stateCateringFields(st, st.routes[0]);
  assert.deepEqual(f.cateringKitchens, ['partial', 'partial']);
  assert.ok(!f.cateringCapped, 'no level cap on a plan');
  const rr = tickRoute(st);
  assert.equal(rr.cateringLevel, 'plan:std');
  const open = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:std' } }));
  assert.ok(rr.cateringQuality < open.cateringQuality, 'no hot meal, lower quality');
  assert.equal(rr.cateringQuality, planQualityBonus(STD, DIST, CFG, ['partial', 'partial']) + c.qualityDelta);
  assert.equal(stateCateringCapReport(st, O, D, 'plan:std'), null);
  const rep = stateCateringKitchenReport(st, O, D, 'plan:std');
  assert.equal(rep.gaps.length, 1);
  assert.deepEqual(rep.gaps[0].codes, [O, D]);
  assert.ok(rep.gaps[0].missing.includes('Hot meal') && rep.gaps[0].missing.includes('Extra courses'));
  assert.equal(stateCateringKitchenReport(st, O, D, 'full'), null, 'classic levels keep the level cap report');
  assert.ok(stateCateringCapReport(st, O, D, 'full'));
});

test('a full-kitchen caterer changes the rate and nothing on the menu', () => {
  const c = makeCateringContract('orbital', 1, WEEK);
  const st = baseState({ cateringPlans: PLANS, cateringContracts: { [c.id]: c }, routeCatering: { [PAIR]: 'plan:lux' } });
  const f = stateCateringFields(st, st.routes[0]);
  assert.equal(f.cateringKitchens, undefined);
  assert.equal(stateCateringKitchenReport(st, O, D, 'plan:lux'), null);
  const rr = tickRoute(st), open = tickRoute(baseState({ cateringPlans: PLANS, routeCatering: { [PAIR]: 'plan:lux' } }));
  assert.equal(rr.cateringQuality, open.cateringQuality);
  near(rr.cateringCost / open.cateringCost, f.cateringCostFactor, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════════
// Sanitising and the reducer
// ═══════════════════════════════════════════════════════════════════════════

test('sanitise: unknown items and cabins dropped, prices clamped, names trimmed', () => {
  const p = sanitizeCateringPlan({
    id: 'a b!c', name: '   ' + 'x'.repeat(80), basedOn: 'nope',
    cabins: {
      economy: { hotMeal: { mode: 'sold', price: 9999, tier: 'premium' }, caviar: { mode: 'free' },
                 fineDining: { mode: 'free' }, water: { mode: 'maybe' }, snack: { mode: 'sold', price: -3 },
                 softDrinks: { mode: 'free', tier: 'premium' } },
      cockpit: { water: { mode: 'free' } },
    },
  });
  assert.equal(p.id, 'abc');
  assert.equal(p.name.length, 32);
  assert.ok(!('basedOn' in p));
  assert.deepEqual(Object.keys(p.cabins).sort(), [...CABIN_CLASSES].sort());
  assert.deepEqual(Object.keys(p.cabins.economy).sort(), ['hotMeal', 'snack', 'softDrinks']);
  assert.equal(p.cabins.economy.hotMeal.price, itemMaxPrice('hotMeal', 'economy', 'premium'));
  assert.equal(p.cabins.economy.snack.price, null);
  assert.equal(p.cabins.economy.softDrinks.tier, 'standard', 'an untiered item is always Standard');
  assert.equal(sanitizeCateringPlan({ name: 'no id' }), null);
  assert.equal(sanitizeCateringPlan(null), null);
});

const { gameReducer, freshState, reconcileState } = await import('../packages/engine/src/reducer.mjs');
const { hydrateState } = await import('../src/store/GameContext.jsx');
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { validateWorldConfig } = await import('../apps/headwinds-server/src/lib/worldConfig.mjs');
const playing = (extra = {}) => ({ ...freshState(), phase: 'playing', week: 10, year: 3, cash: 500_000_000, cateringPlansWorld: true,
  fleet: [tail('a1')], routes: [route('r1', 'a1')], routePricing: { [PAIR]: defaultClassPrices(REF) }, routeCatering: { [PAIR]: 'full' }, ...extra });

test('freshState carries no plans key (golden parity)', () => {
  assert.ok(!('cateringPlans' in freshState()));
});

test('SAVE creates and replaces a plan; a duplicate name and a thirteenth plan are refused', () => {
  let s = gameReducer(playing(), { type: 'SAVE_CATERING_PLAN', plan: LUX });
  assert.deepEqual(Object.keys(s.cateringPlans), ['lux']);
  s = gameReducer(s, { type: 'SAVE_CATERING_PLAN', plan: { ...LUX, name: 'Flagship' } });
  assert.equal(s.cateringPlans.lux.name, 'Flagship');
  const clash = gameReducer(s, { type: 'SAVE_CATERING_PLAN', plan: { ...LEAN, name: 'flagship' } });
  assert.match(clash.error, /already have a plan called/);
  assert.equal(Object.keys(clash.cateringPlans).length, 1);
  for (let i = 0; i < MAX_CATERING_PLANS - 1; i++) s = gameReducer(s, { type: 'SAVE_CATERING_PLAN', plan: plan(`p${i}`, {}) });
  assert.equal(Object.keys(s.cateringPlans).length, MAX_CATERING_PLANS);
  const over = gameReducer(s, { type: 'SAVE_CATERING_PLAN', plan: plan('one-more', {}) });
  assert.match(over.error, /up to 12/);
  assert.equal(cateringPlanSaveError(sanitizeCateringPlan({ ...LUX, name: 'Flagship' }), s.cateringPlans), null, 'editing an existing plan at the limit is fine');
});

test('assigning: SET_ROUTE_CATERING takes a plan ref, SAVE can assign as it saves, an unknown plan reads as Full', () => {
  let s = gameReducer(playing(), { type: 'SAVE_CATERING_PLAN', plan: LUX });
  s = gameReducer(s, { type: 'SET_ROUTE_CATERING', routeIds: ['r1'], level: 'plan:lux' });
  assert.equal(s.routeCatering[PAIR], 'plan:lux');
  assert.equal(hydrateState(s).routes[0].cateringPlan, s.cateringPlans.lux, 'screens see the resolved plan');
  s = gameReducer(s, { type: 'SET_ROUTE_CATERING', routeIds: ['r1'], level: 'plan:ghost' });
  assert.equal(s.routeCatering[PAIR], 'full');
  s = gameReducer(s, { type: 'SAVE_CATERING_PLAN', plan: LEAN, routeIds: ['r1'] });
  assert.equal(s.routeCatering[PAIR], 'plan:lean');
  s = gameReducer(s, { type: 'SET_DEFAULT_CATERING', level: 'plan:lean' });
  assert.equal(s.defaultCateringLevel, 'plan:lean');
  assert.deepEqual(cateringPlanUsage('lean', s), { pairs: [PAIR], routes: [], isDefault: true, count: 1 });
});

test('DELETE: refused while routes use the plan; otherwise removed, the default reset, the key cleared with the last', () => {
  let s = gameReducer(playing(), { type: 'SAVE_CATERING_PLAN', plan: { ...LEAN, basedOn: 'paid' }, routeIds: ['r1'] });
  s = gameReducer(s, { type: 'SET_DEFAULT_CATERING', level: 'plan:lean' });
  const refused = gameReducer(s, { type: 'DELETE_CATERING_PLAN', id: 'lean' });
  assert.match(refused.error, /still used on 1 route/);
  assert.ok(refused.cateringPlans.lean);
  s = gameReducer(s, { type: 'SET_ROUTE_CATERING', routeIds: ['r1'], level: 'hybrid' });
  s = gameReducer(s, { type: 'DELETE_CATERING_PLAN', id: 'lean' });
  assert.ok(!('cateringPlans' in s), 'no empty container left behind');
  assert.equal(s.defaultCateringLevel, 'paid', 'the default goes back to the level the plan was based on');
});

test('ADVANCE_WEEK runs a plan route and reports its catering', () => {
  let s = gameReducer(playing(), { type: 'SAVE_CATERING_PLAN', plan: LEAN, routeIds: ['r1'] });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(s.cateringPlans.lean, 'plans survive the tick');
  assert.equal(s.routeCatering[PAIR], 'plan:lean');
  const rr = s.lastReport.routeResults.find(r => r.routeId === 'r1');
  assert.equal(rr.cateringPlanId, 'lean');
  assert.ok(rr.cateringRevenue > 0);
  assert.equal(s.routes[0].cateringPlan, undefined, 'the stored route stays clean');
});

test('saves: plans and their refs survive a load; a save without plans stays keyless', () => {
  let s = gameReducer(playing(), { type: 'SAVE_CATERING_PLAN', plan: LUX, routeIds: ['r1'] });
  s = gameReducer(s, { type: 'SET_DEFAULT_CATERING', level: 'plan:lux' });
  const loaded = reconcileState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(loaded.cateringPlans, s.cateringPlans);
  assert.equal(loaded.routeCatering[PAIR], 'plan:lux');
  assert.equal(loaded.defaultCateringLevel, 'plan:lux');
  assert.ok(!('cateringPlans' in reconcileState(playing())));
  const orphan = reconcileState({ ...JSON.parse(JSON.stringify(s)), cateringPlans: undefined });
  assert.equal(orphan.defaultCateringLevel, 'full', 'a default pointing at a missing plan reads as Full');
});

// ═══════════════════════════════════════════════════════════════════════════
// Headwinds: new worlds only
// ═══════════════════════════════════════════════════════════════════════════

const { createWorld, seedAirlineState } = await import('../apps/headwinds-server/src/lib/worldService.mjs');
const { serializeWorld } = await import('../apps/headwinds-server/src/lib/worldConfig.mjs');
const fakePrisma = () => { const calls = []; return { calls, world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } }; };
const WORLD_BASE = { name: 'T', lengthYears: 50, weeksPerDay: 24, maxPlayers: 20 };
const tickConfigOf = async (opts) => { const p = fakePrisma(); await createWorld(p, opts); return p.calls[0].tickConfig; };
const worldRow = (tickConfig) => ({ id: 'w', worldSeed: 's', currentYear: 1, currentWeek: 1, lengthYears: 40, maxPlayers: 20,
  tickConfig: { startingCapital: 15_000_000, demandMultiplier: 1, ...tickConfig } });
const oldWorld = (extra = {}) => { const { cateringPlansWorld: _drop, ...rest } = playing(extra); return rest; };

test('an airline in a world without the flag cannot save a plan, and nothing about it changes', () => {
  const s0 = oldWorld();
  const s1 = gameReducer(s0, { type: 'SAVE_CATERING_PLAN', plan: LUX, routeIds: ['r1'] });
  assert.match(s1.error, /not part of this world/);
  assert.ok(!('cateringPlans' in s1));
  assert.equal(s1.routeCatering[PAIR], 'full');
  const s2 = gameReducer(s0, { type: 'SET_ROUTE_CATERING', routeIds: ['r1'], level: 'plan:lux' });
  assert.equal(s2.routeCatering[PAIR], 'full', 'with no plans a plan ref is just an unknown level');
  assert.equal(gameReducer(s0, { type: 'SET_DEFAULT_CATERING', level: 'plan:lux' }).defaultCateringLevel, 'full');
});

test('an old world ticks exactly as before: the same week with and without the engine knowing about plans', () => {
  const a = gameReducer(oldWorld(), { type: 'ADVANCE_WEEK' });
  const rr = a.lastReport.routeResults.find(r => r.routeId === 'r1');
  assert.equal(rr.cateringLevel, 'full');
  assert.ok(!('cateringPlanId' in rr));
  assert.ok(!('cateringPlans' in a));
});

await (async () => {
  let tcOn, tcOff, tcDefault;
  try {
    tcDefault = await tickConfigOf(WORLD_BASE);
    tcOn = await tickConfigOf({ ...WORLD_BASE, customCatering: true });
    tcOff = await tickConfigOf({ ...WORLD_BASE, customCatering: false });
  } catch (e) { tcDefault = tcOn = tcOff = { error: e }; }
  test('a new world has custom catering unless its creator turns it off', () => {
    if (tcDefault.error) throw tcDefault.error;
    assert.equal(tcDefault.customCatering, true, 'on by default');
    assert.equal(tcOn.customCatering, true);
    assert.ok(!('customCatering' in tcOff), 'off is keyless, like a world created before it existed');
  });
})();

test('a bad customCatering is refused', () => {
  for (const bad of [0, 1, 'yes', {}]) assert.throws(() => validateWorldConfig({ ...WORLD_BASE, customCatering: bad }), /customCatering/, String(bad));
  validateWorldConfig({ ...WORLD_BASE, customCatering: false });
});

test('the flag is baked into an airline at join, and only in a world that has it', () => {
  const on = seedAirlineState(worldRow({ customCatering: true }), { hub: 'JFK', airlineName: 'A', airlineId: 'a1' });
  const off = seedAirlineState(worldRow({}), { hub: 'JFK', airlineName: 'A', airlineId: 'a1' });
  assert.equal(on.cateringPlansWorld, true);
  assert.ok(!('cateringPlansWorld' in off));
  assert.ok(!('cateringPlans' in on), 'no plans until the airline saves one');
});

test('the world JSON says whether a world has it (keyless = no)', () => {
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: { customCatering: true } }, { playerCount: 0 }).customCatering, true);
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: {} }, { playerCount: 0 }).customCatering, false);
});

test('the server guard: refused outside a custom-catering world, cleaned inside one', () => {
  const st = playing();
  assert.throws(() => guardDecision('SAVE_CATERING_PLAN', { plan: LUX }, oldWorld()), /not part of this world/);
  assert.throws(() => guardDecision('DELETE_CATERING_PLAN', { id: 'lux' }, oldWorld()), /not part of this world/);
  assert.throws(() => guardDecision('SAVE_CATERING_PLAN', { plan: { name: 'no id' } }, st), /not valid/);
  const g = guardDecision('SAVE_CATERING_PLAN', {
    plan: { ...LUX, cabins: { economy: { hotMeal: { mode: 'sold', price: 1e9 }, caviar: { mode: 'free' } } }, junk: 1 },
    routeIds: ['r1', 'someone-elses', 7], extra: true,
  }, st);
  assert.deepEqual(Object.keys(g).sort(), ['plan', 'routeIds']);
  assert.deepEqual(g.routeIds, ['r1'], 'only this airline\'s routes');
  assert.equal(g.plan.cabins.economy.hotMeal.price, itemMaxPrice('hotMeal', 'economy', 'standard'));
  assert.ok(!('caviar' in g.plan.cabins.economy) && !('junk' in g.plan));
  assert.throws(() => guardDecision('DELETE_CATERING_PLAN', { id: 'ghost' }, st), /Unknown service plan/);
  const withPlan = gameReducer(st, { type: 'SAVE_CATERING_PLAN', plan: LUX });
  assert.deepEqual(guardDecision('DELETE_CATERING_PLAN', { id: 'lux', x: 1 }, withPlan), { id: 'lux' });
});

test('the server allow-list carries both plan actions, and the create form sends the switch', async () => {
  const world = fs.readFileSync(new URL('../apps/headwinds-server/src/world.mjs', import.meta.url), 'utf8');
  assert.ok(world.includes("'SAVE_CATERING_PLAN', 'DELETE_CATERING_PLAN'"));
  const app = fs.readFileSync(new URL('../apps/headwinds-web/src/App.jsx', import.meta.url), 'utf8');
  assert.ok(/const \[customCatering, setCustomCatering\] = useState\(true\)/.test(app), 'the checkbox defaults to on');
  assert.ok(/hubBanks,\n\s+\/\/ Always explicit[^\n]*\n\s+customCatering,/.test(app), 'the form sends it explicitly');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
