// Loyalty pools — contested frequent flyers per city (loyalty v2, new worlds only).
//
// Guards the decisions locked with Dave on 2026-10-30
// (claude/loyalty-rework-design.md, "As built"):
//
//   1. ZERO-SUM. Loyalty moves passengers between the carriers on a pair; it
//      never adds travellers to a market. A monopoly is untouched by it.
//   2. Members live in CITIES (a metro, or a lone airport), each a fixed pool of
//      frequent flyers that every program there competes for, with a "no
//      program" option so a lone carrier with a thin program enrols a minority.
//   3. A STATUS YEAR: elites requalify every December against the service the
//      airline kept up; elites whose routes went away leave.
//   4. Elites care about RELIABILITY: poor on-time drives them off first, and
//      lowers the requalification pass rate.
//   5. Travel partners are places to EARN: they add to the program's value in
//      the cities they work in.
//   6. No co-brand card. No budget: one dial (generosity), and cutting it is a
//      devaluation. Outstanding points are never repriced.
//   7. New worlds only (tickConfig.loyaltyPools → state.loyaltyPoolsWorld);
//      every other world is byte-identical (golden master).
//
//   node tools/loyalty-pools-test.mjs

import assert from 'node:assert/strict';
import {
  isLoyaltyPoolsWorld, loyaltyPoolOf, loyaltyPoolSize, loyaltyPoolCodes, programValueParts,
  loyaltyPoolWeight, loyaltyTargetShare, LP_NONE_WEIGHT, advanceLoyaltyPools, poolEntry,
  pairLoyaltyStanding, loyaltyOfferFields, loyaltyFieldsForSegment, loyaltyStandingAt,
  generosityChange, devaluationRepPenalty, loyaltyPoolFlows, loyaltyBreakage, normalizeGenerosity,
  requalPassRate, eliteDefectionRate, eliteFraction, bagsIncluded, reliabilityValue,
  LP_GEN_MIN, LP_GEN_MAX, LP_VALUE, LP_APPEAL_CAP, LP_REQUAL_WEEK, LP_DRIFT,
  statusMatchOffer, applyStatusMatch, devaluationNotice, LP_MATCH_WINDOW_WEEKS, LP_MATCH_COST_PER_MEMBER,
} from '../packages/engine/src/models/loyaltyPools.js';
import { computeMarketShare, buildRouteMarket } from '../packages/engine/src/models/demand.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  stateLoyaltyFields, loyaltySeatsByPool, loyaltyPresence, loyaltyRivalWeights, loyaltyCityTable,
  loyaltyMatchOffers, stateDevaluationNotice,
} from '../packages/engine/src/utils/simulation.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { pairMarketShare } from '../packages/engine/src/models/pairShare.js';
import { createWorld, seedAirlineState } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { loyaltyNewsRows } from '../apps/headwinds-server/src/lib/newsService.mjs';
import fs from 'node:fs';
import { serializeWorld, validateWorldConfig } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { toHumanCompetitor, toRivalSpecs, buildRivalViews, withRivals } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { ALLOWED_PLAYER_ACTIONS as ALLOWED_ACTIONS } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);
const realRandom = Math.random;
function seedRandom(seed) {
  let x = seed >>> 0;
  Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

console.log('\nLoyalty pools\n');
console.log('── 1. Cities ─────────────────────────────────────────────────');

await t('a metro is one pool; a lone airport is its own; pool size comes from residents', () => {
  assert.equal(loyaltyPoolOf('JFK'), loyaltyPoolOf('EWR'));
  assert.equal(loyaltyPoolOf('JFK'), loyaltyPoolOf('LGA'));
  assert.equal(loyaltyPoolOf('DEN'), 'DEN');
  assert.ok(loyaltyPoolCodes(loyaltyPoolOf('JFK')).includes('EWR'));
  assert.ok(loyaltyPoolSize(loyaltyPoolOf('JFK')) > 5 * loyaltyPoolSize('DEN'), 'New York ≫ Denver');
  assert.ok(loyaltyPoolSize('DEN') > 3 * loyaltyPoolSize('BOI'), 'Denver ≫ Boise');
  assert.ok(loyaltyPoolSize('KTN') >= 2000, 'a floor for tiny towns');
});

await t('the "no program" option: a lone carrier with a thin program enrols a minority', () => {
  const F = loyaltyPoolSize('BOI');
  const thin = loyaltyTargetShare(loyaltyPoolWeight(F, F, 0.15));
  const rich = loyaltyTargetShare(loyaltyPoolWeight(F, F, 0.85));
  assert.ok(thin < 0.4, `thin ${thin}`);
  assert.ok(rich > 0.75, `rich ${rich}`);
  assert.ok(loyaltyTargetShare(loyaltyPoolWeight(F * 0.05, F, 0.85)) < 0.15, 'a token service enrols few, however rich');
});

await t('two carriers split what both together are worth; the better program takes more', () => {
  const F = loyaltyPoolSize('DEN');
  const a = loyaltyPoolWeight(F * 0.5, F, 0.6), b = loyaltyPoolWeight(F * 0.5, F, 0.4);
  const sa = loyaltyTargetShare(a, b), sb = loyaltyTargetShare(b, a);
  near(sa + sb, (a + b) / (LP_NONE_WEIGHT + a + b), 1e-12);
  assert.ok(sa > sb * 1.4, `${sa} vs ${sb}`);
  assert.equal(loyaltyTargetShare(0, b), 0, 'no seats, no members');
});

console.log('── 2. Value is what the airline already is ───────────────────');

const ctx0 = { generosity: 0.06, lounges: {}, loungePolicy: null, ancillaries: null, premiumShare: 0,
  allianceMember: false, destinations: {}, travelPartners: {}, onTime: 0.75 };
const val = (extra, pool = 'DEN') => programValueParts({ ...ctx0, ...extra }, pool).value;

await t('generosity is worth 0 at 3% and the full slice at 12%', () => {
  near(val({ generosity: LP_GEN_MIN, ancillaries: { bags: { offered: true, price: 40 } } }), 0, 1e-9);
  near(val({ generosity: LP_GEN_MAX, ancillaries: { bags: { offered: true, price: 40 } } }), LP_VALUE.generosity, 1e-9);
});

await t('a lounge counts only where it is, and only if members get in', () => {
  const lounges = { DEN: { level: 1 } };
  const base = val({});
  near(val({ lounges, loungePolicy: { loyaltyAccess: true } }) - base, LP_VALUE.lounge, 1e-9);
  near(val({ lounges, loungePolicy: { loyaltyAccess: false } }) - base, 0, 1e-9);
  near(val({ lounges, loungePolicy: { loyaltyAccess: true } }, 'BOI') - val({}, 'BOI'), 0, 1e-9);
  assert.equal(val({ lounges: { DEN: { level: 1, buildWeeksLeft: 3 } }, loungePolicy: { loyaltyAccess: true } }), base, 'still fitting out');
});

await t('free bags, premium cabins, an alliance and a wide network each add their slice', () => {
  const fee = { bags: { offered: true, price: 40 } };
  assert.equal(bagsIncluded(null), true, 'no à la carte policy = bundled fares');
  assert.equal(bagsIncluded(fee), false);
  near(val({}) - val({ ancillaries: fee }), LP_VALUE.bags, 1e-9);
  near(val({ premiumShare: 0.12 }) - val({}), LP_VALUE.premium, 1e-9);
  near(val({ allianceMember: true }) - val({}), LP_VALUE.alliance, 1e-9);
  near(val({ destinations: { DEN: 15 } }) - val({}), LP_VALUE.network, 1e-9);
});

await t('travel partners are places to earn: they add value in the cities they work in', () => {
  const hotel = { aldgate: { partnerId: 'aldgate', happiness: 70 } };
  const parts = programValueParts({ ...ctx0, travelPartners: hotel }, loyaltyPoolOf('LHR')).parts;
  const p = parts.find(x => x.id === 'partners');
  assert.ok(p.got > 0, `partner value in its city: ${p.got}`);
  assert.equal(programValueParts({ ...ctx0, travelPartners: hotel }, 'DEN').parts.find(x => x.id === 'partners').got, 0);
  const sour = programValueParts({ ...ctx0, travelPartners: { aldgate: { partnerId: 'aldgate', happiness: 10 } } }, loyaltyPoolOf('LHR'))
    .parts.find(x => x.id === 'partners').got;
  assert.equal(sour, 0, 'a partner that has gone sour stops being worth anything');
});

await t('reliability is on the checklist: punctual airlines gain, late ones lose', () => {
  assert.ok(reliabilityValue(0.90) > 0 && reliabilityValue(0.60) < 0);
  assert.ok(val({ onTime: 0.90 }) > val({ onTime: 0.75 }) && val({ onTime: 0.75 }) > val({ onTime: 0.60 }));
});

console.log('── 3. Zero-sum ───────────────────────────────────────────────');

const gd = { week: 20, month: 5, absWeek: 20 };
const offerOf = (id, extra = {}) => {
  const ref = referencePrice('DEN', 'ORD');
  return { airlineId: id, origin: 'DEN', destination: 'ORD', economyPrice: ref, businessPrice: ref * 3,
    weeklyFrequency: 14, seatsPerFlight: 160, economySeats: 150 * 14, businessSeats: 10 * 14, totalSeats: 160 * 14,
    qualityScore: 65, connectivityBonus: 0, ...extra };
};
const pax = (r) => (r.leisurePax ?? 0) + (r.businessPax ?? 0);

await t('a monopoly is untouched by loyalty (no pool term)', () => {
  const m = buildRouteMarket('DEN', 'ORD', gd);
  const a = computeMarketShare(m, [offerOf('player')])[0];
  const b = computeMarketShare(m, [offerOf('player', { loyaltyAppeal: 1.5, loyaltySensReduction: 0.15 })])[0];
  assert.deepEqual(b, a);
});

await t('on a contested pair it moves passengers between carriers, never into the market', () => {
  const m = buildRouteMarket('DEN', 'ORD', gd);
  // Big aircraft so nobody is capacity-bound: the split is pure demand.
  const big = { economySeats: 1e6, businessSeats: 1e6, totalSeats: 2e6 };
  const plain = computeMarketShare(m, [offerOf('player', big), offerOf('rival', big)]);
  const loyal = computeMarketShare(m, [offerOf('player', { ...big, loyaltyAppeal: 1.4, loyaltySensReduction: 0.1 }), offerOf('rival', big)]);
  const tot0 = pax(plain[0]) + pax(plain[1]), tot1 = pax(loyal[0]) + pax(loyal[1]);
  near(tot1, tot0, tot0 * 0.002, 'total travellers on the pair');
  assert.ok(pax(loyal[0]) > pax(plain[0]) * 1.05, `player ${pax(plain[0])} → ${pax(loyal[0])}`);
  assert.ok(pax(loyal[1]) < pax(plain[1]), 'the rival loses what the player gains');
  assert.ok(loyal[0].businessPax / plain[0].businessPax > loyal[0].leisurePax / plain[0].leisurePax,
    'frequent flyers are mostly business travellers');
});

await t('equal programs cancel: two carriers with the same standing split as with none', () => {
  const m = buildRouteMarket('DEN', 'ORD', gd);
  const big = { economySeats: 1e6, businessSeats: 1e6, totalSeats: 2e6 };
  const f = { loyaltyAppeal: 1.3 };
  const plain = computeMarketShare(m, [offerOf('player', big), offerOf('rival', big)]);
  const both = computeMarketShare(m, [offerOf('player', { ...big, ...f }), offerOf('rival', { ...big, ...f })]);
  near(pax(both[0]), pax(plain[0]), 1);
});

console.log('── 4. Members, elites, the status year ───────────────────────');

const step = (pools, extra = {}) => advanceLoyaltyPools(pools, {
  on: true, maturity: 1, seats: { DEN: 30_000 }, values: { DEN: 0.5 }, rivals: {},
  onTime: 0.85, onTimeEma: 0.85, requal: false, devaluation: null, absWeek: 100, ...extra });
const settle = (n, extra) => { let p = {}; for (let i = 0; i < n; i++) p = step(p, extra).pools; return p; };

await t('members drift to target over months, not weeks', () => {
  const one = step({}).pools.DEN[0];
  const F = loyaltyPoolSize('DEN');
  const target = F * loyaltyTargetShare(loyaltyPoolWeight(30_000, F, 0.5));
  near(one, target * LP_DRIFT, 2);
  const yr = settle(52).DEN[0];
  assert.ok(yr > target * 0.8 && yr < target * 1.01, `${yr} of ${target}`);
});

await t('a rival program at the same city takes members off you', () => {
  // Both carriers fly enough to cover the city: two small carriers barely
  // touch each other (most flyers hold no card at all), two big ones do.
  const F = loyaltyPoolSize('DEN');
  const alone = settle(80, { seats: { DEN: F } }).DEN[0];
  const contested = settle(80, { seats: { DEN: F }, rivals: { DEN: loyaltyPoolWeight(F, F, 0.6) } }).DEN[0];
  assert.ok(contested < alone * 0.75, `${alone} → ${contested}`);
});

await t('elites build with maturity toward the elite share', () => {
  assert.ok(eliteFraction(1) > eliteFraction(0) * 3);
  const p = settle(150);
  near(p.DEN[1] / p.DEN[0], eliteFraction(1), 0.01);
});

await t('unreliable flying: elites leave first, ordinary members a quarter as fast', () => {
  assert.equal(eliteDefectionRate(0.85), 0);
  assert.ok(eliteDefectionRate(0.60) > eliteDefectionRate(0.70));
  const p = settle(150);
  const late = advanceLoyaltyPools(p, { on: true, maturity: 1, seats: { DEN: 30_000 }, values: { DEN: 0.5 }, rivals: {},
    onTime: 0.60, onTimeEma: 0.85, absWeek: 100 });
  const good = step(p);
  const eDrop = 1 - late.pools.DEN[1] / good.pools.DEN[1];
  const bDrop = 1 - (late.pools.DEN[0] - late.pools.DEN[1]) / (good.pools.DEN[0] - good.pools.DEN[1]);
  assert.ok(eDrop > 0.03, `elites ${eDrop}`);
  assert.ok(bDrop > 0 && bDrop < eDrop / 2, `members ${bDrop}`);
});

await t('December requalification: kept service keeps elites; cut routes lose them for good', () => {
  const p = settle(150);
  const kept = step(p, { requal: true });
  const cut = step(p, { requal: true, seats: { DEN: 7_500 } });   // three quarters of the flying gone
  assert.ok(kept.requal.kept > kept.requal.dropped * 4, JSON.stringify(kept.requal));
  assert.equal(kept.requal.left, 0, 'nobody leaves when the routes are still there');
  assert.ok(cut.requal.left > 0 && cut.requal.kept < kept.requal.kept / 2, JSON.stringify(cut.requal));
  assert.ok(cut.pools.DEN[0] < kept.pools.DEN[0], 'the leavers leave the program');
  assert.ok(kept.pools.DEN[3] > 100, 'the city shops around afterwards');
});

await t('requalification passes fewer elites on an unreliable airline', () => {
  assert.ok(requalPassRate(1, 1, 0.90).pass > requalPassRate(1, 1, 0.65).pass * 1.25);
});

await t('program off: members and elites lapse', () => {
  const p = settle(150);
  const off = advanceLoyaltyPools(p, { on: false, maturity: 1, seats: {}, values: {}, rivals: {}, onTime: 0.85, absWeek: 100 });
  assert.ok(off.pools.DEN[0] < p.DEN[0] * 0.95 && off.pools.DEN[1] < p.DEN[1] * 0.9);
});

console.log('── 5. Standing → the demand model ────────────────────────────');

await t('standing is pool-weighted: a big city counts for more than a small one', () => {
  const F = (c) => loyaltyPoolSize(loyaltyPoolOf(c));
  const pools = { DEN: [F('DEN') * 0.2, 0, 0], BOI: [F('BOI') * 1.0, 0, 0] };
  const L = pairLoyaltyStanding(pools, 'DEN', 'BOI');
  near(L, (F('DEN') * 0.2 + F('BOI')) / (F('DEN') + F('BOI')), 1e-9);
  assert.ok(L < 0.5, 'owning Boise does not make up for 20% of Denver');
});

await t('fields scale with maturity and cap; nothing to carry → {}', () => {
  assert.deepEqual(loyaltyOfferFields(0, 1), {});
  const young = loyaltyOfferFields(0.3, 0), old = loyaltyOfferFields(0.3, 1);
  assert.ok(old.loyaltyAppeal > young.loyaltyAppeal && old.loyaltySensReduction > young.loyaltySensReduction);
  assert.ok(loyaltyOfferFields(1, 1).loyaltyAppeal <= 1 + LP_APPEAL_CAP + 1e-9);
});

await t('tag routes resolve each segment from its own two stops', () => {
  const lo = { members: 1, maturity: 1, pools: { DEN: [50_000, 5_000, 0], BOI: [0, 0, 0] } };
  const at = loyaltyStandingAt(lo, ['BOI', 'DEN', 'ORD']);
  assert.ok(loyaltyFieldsForSegment(at, 'BOI', 'DEN').loyaltyAppeal > 1);
  assert.deepEqual(loyaltyFieldsForSegment(at, 'ORD', 'XXX'), {});
});

console.log('── 6. Generosity, devaluation, money ─────────────────────────');

await t('the dial snaps to 0.5-point steps inside 3–12%; 0 is off', () => {
  assert.equal(normalizeGenerosity(0), 0);
  assert.equal(normalizeGenerosity(0.5), LP_GEN_MAX);
  assert.equal(normalizeGenerosity(0.01), LP_GEN_MIN);
  near(normalizeGenerosity(0.0612), 0.06, 1e-9);
});

await t('raising is free; a cut is a devaluation; a promo can be taken back inside 4 weeks', () => {
  const lo = { generosity: 0.06 };
  assert.equal(generosityChange(lo, 0.08, 10).cut, 0);
  near(generosityChange(lo, 0.04, 10).cut, 0.02, 1e-9);
  const promo = { generosity: 0.08, promo: { from: 0.06, until: 14 } };
  assert.equal(generosityChange(promo, 0.06, 12).cut, 0, 'back to where the promo started');
  assert.equal(generosityChange(promo, 0.06, 12).graced, true);
  near(generosityChange(promo, 0.05, 12).cut, 0.01, 1e-9, 'below the start is still a cut');
  near(generosityChange(promo, 0.06, 20).cut, 0.02, 1e-9, 'after the window, a cut');
});

await t('points: earn on member revenue, breakage falls with maturity, admin per member', () => {
  const f = loyaltyPoolFlows({ liability: 1e6, revenue: 1e6, memberShare: 0.5, generosity: 0.06, maturity: 0, members: 10_000 });
  assert.equal(f.earned, 30_000);
  assert.equal(f.admin, 3_000);
  assert.ok(loyaltyBreakage(0) > loyaltyBreakage(1));
  const g = loyaltyPoolFlows({ liability: 1e6, revenue: 1e6, memberShare: 0.5, generosity: 0.06, maturity: 1, members: 10_000 });
  assert.ok(g.redeemedCost > f.redeemedCost, 'engaged members redeem more');
});

await t('a devaluation costs members and elites, and reputation for 12 weeks', () => {
  const p = settle(150);
  const d = step(p, { devaluation: { cut: 0.03 } });
  assert.ok(d.pools.DEN[0] < step(p).pools.DEN[0] * 0.93);
  assert.ok(d.pools.DEN[3] > 100, 'shopping');
  assert.ok(devaluationRepPenalty({ devaluation: { cut: 0.03, until: 112, maturity: 1 } }, 105) <= -6);
  assert.equal(devaluationRepPenalty({ devaluation: { cut: 0.03, until: 112, maturity: 1 } }, 113), 0);
});

console.log('── 7. The reducer and the tick ───────────────────────────────');

const AC = (id) => ({ id, typeId: 'a320neo', name: `AC ${id}`, status: 'assigned', ageWeeks: 104, ownershipType: 'owned',
  config: { economy: 150, businessClass: 12 } });
const flying = (name, extra = {}) => {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub: 'DEN', enableObjectives: false });
  return { ...s, competitors: [], encroachments: {}, cash: 5e8, fleet: [AC('a1'), AC('a2')], gates: { DEN: 4, ORD: 2, BOI: 2 },
    routes: [
      { id: 'r1', origin: 'DEN', destination: 'ORD', stops: ['DEN', 'ORD'], aircraftId: 'a1', weeklyFrequency: 14, weeksOpen: 60,
        ticketPrice: Math.round(referencePrice('DEN', 'ORD')) },
      { id: 'r2', origin: 'DEN', destination: 'BOI', stops: ['DEN', 'BOI'], aircraftId: 'a2', weeklyFrequency: 21, weeksOpen: 60,
        ticketPrice: Math.round(referencePrice('DEN', 'BOI')) },
    ], ...extra };
};
const run = (s, n) => { for (let i = 0; i < n; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' }); return s; };

await t('classic worlds ignore the dial; pools worlds ignore the old budget', () => {
  const classic = flying('C');
  assert.equal(isLoyaltyPoolsWorld(classic), false);
  assert.equal(gameReducer(classic, { type: 'SET_LOYALTY_GENEROSITY', generosity: 0.06 }), classic);
  const pw = flying('P', { loyaltyPoolsWorld: true });
  assert.equal(gameReducer(pw, { type: 'SET_LOYALTY_INVESTMENT', amount: 400_000 }), pw);
});

await t('open the program: members join in the cities flown; cost is points + admin, no budget', () => {
  seedRandom(3);
  let s = gameReducer(flying('P', { loyaltyPoolsWorld: true }), { type: 'SET_LOYALTY_GENEROSITY', generosity: 0.06 });
  assert.equal(s.loyalty.generosity, 0.06);
  s = run(s, 30);
  Math.random = realRandom;
  assert.ok(s.loyalty.members > 0 && s.loyalty.pools.DEN[0] > s.loyalty.pools.BOI[0] * 0.5);
  assert.ok(s.loyalty.maturity > 0.3);
  const r = s.lastReport;
  assert.ok(r.loyaltyAdminCost > 0 && r.loyaltyPointsEarned > 0);
  assert.equal(r.totalLoyaltyCost, r.loyaltyAdminCost + r.loyaltyPointsCost);
  assert.equal(r.loyaltyMultiplier, 1, 'no old-style demand lift');
  assert.ok(Number.isFinite(r.loyaltyOnTime));
  assert.equal(s.loyalty.weeklyInvestment ?? 0, 0);
});

await t('zero-sum in the tick: a monopoly network carries the same with or without members', () => {
  const base = flying('P', { loyaltyPoolsWorld: true });
  seedRandom(9);
  const a = gameReducer(base, { type: 'ADVANCE_WEEK' });
  seedRandom(9);
  const loyal = { ...base, loyalty: { ...base.loyalty, generosity: 0.12, maturity: 1, members: 200_000, elites: 30_000,
    pools: { DEN: [150_000, 20_000, 0], ORD: [20_000, 5_000, 0], BOI: [30_000, 5_000, 0] } } };
  const b = gameReducer(loyal, { type: 'ADVANCE_WEEK' });
  Math.random = realRandom;
  assert.equal(b.lastReport.totalPassengers, a.lastReport.totalPassengers);
  assert.ok(Object.keys(stateLoyaltyFields(loyal, 'DEN', 'ORD')).length === 2, 'the fields were there to carry');
});

await t('the December tick requalifies once and toasts it', () => {
  const p = { DEN: [40_000, 6_000, 6_000], BOI: [10_000, 1_500, 4_000] };
  const s0 = { ...flying('P', { loyaltyPoolsWorld: true }), week: LP_REQUAL_WEEK,
    loyalty: { generosity: 0.06, maturity: 1, members: 50_000, elites: 7_500, pools: p, pointsLiability: 0 } };
  seedRandom(4);
  const s1 = gameReducer(s0, { type: 'ADVANCE_WEEK' });
  Math.random = realRandom;
  assert.equal(s1.loyalty.requalYear, s0.year);
  assert.ok(s1.loyalty.lastRequal && s1.loyalty.lastRequal.kept > 0);
  assert.ok((s1.pendingToasts ?? []).some(x => x.title === 'Elite requalification'));
});

await t('cutting generosity is applied at the next tick as a backlash', () => {
  const s0 = { ...flying('P', { loyaltyPoolsWorld: true }),
    loyalty: { generosity: 0.10, maturity: 1, members: 50_000, elites: 7_500, pools: { DEN: [40_000, 6_000, 30_000], BOI: [10_000, 1_500, 30_000] }, pointsLiability: 5e6 } };
  const cut = gameReducer(s0, { type: 'SET_LOYALTY_GENEROSITY', generosity: 0.07 });
  assert.equal(cut.loyalty.devaluation.applied, false);
  near(cut.loyalty.devaluation.cut, 0.03, 1e-9);
  assert.equal(cut.loyalty.pointsLiability, 5e6, 'outstanding points keep their value');
  seedRandom(2);
  const after = gameReducer(cut, { type: 'ADVANCE_WEEK' });
  seedRandom(2);
  const control = gameReducer(s0, { type: 'ADVANCE_WEEK' });
  Math.random = realRandom;
  assert.equal(after.loyalty.devaluation.applied, true);
  assert.ok(after.loyalty.members < control.loyalty.members * 0.95);
  assert.ok(after.lastReport.reputationScore < control.lastReport.reputationScore, 'the outcry');
});

await t('era worlds: no frequent-flyer programs before 1981', () => {
  const s = { ...flying('P', { loyaltyPoolsWorld: true }), startYear: 1975, year: 1 };
  const r = gameReducer(s, { type: 'SET_LOYALTY_GENEROSITY', generosity: 0.06 });
  assert.equal(r.loyalty?.generosity ?? 0, 0);
  assert.match(r.error ?? '', /1981/);
});

console.log('── 8. Previews agree with the tick; rivals see each other ─────');

await t('stateLoyaltyFields is {} outside a pools world and without members', () => {
  assert.deepEqual(stateLoyaltyFields(flying('C'), 'DEN', 'ORD'), {});
  assert.deepEqual(stateLoyaltyFields(flying('P', { loyaltyPoolsWorld: true }), 'DEN', 'ORD'), {});
});

const withMembers = (s) => ({ ...s, loyalty: { generosity: 0.08, maturity: 1, members: 60_000, elites: 8_000,
  pools: { DEN: [50_000, 7_000, 30_000], ORD: [10_000, 1_000, 2_000] } } });

await t('pairMarketShare previews the share the loyalty term buys against a rival', () => {
  // A rival with seats to spare: a full rival spills its overflow to the player
  // up to the player's solo ceiling, and then nothing moves the split.
  const rivalSpec = { competitorId: 'human:r', name: 'R', tier: 'legacy', qualityScore: 65, frequency: 28,
    seatsPerFlight: 400, economyFare: Math.round(referencePrice('DEN', 'ORD')), businessFare: null, businessSeatsPerWeek: 0 };
  // Priced well over reference so the player is demand-limited, not seat-limited.
  const f0 = flying('P', { loyaltyPoolsWorld: true });
  const routes = f0.routes.map(r => ({ ...r, ticketPrice: Math.round(referencePrice(r.origin, r.destination) * 1.6) }));
  const base = { ...f0, routes, humanRivals: { 'DEN-ORD': [rivalSpec] }, multiplayer: true };
  const plain = pairMarketShare(base, 'DEN', 'ORD');
  const loyal = pairMarketShare(withMembers(base), 'DEN', 'ORD');
  const p = (x) => (x?.playerResult?.leisurePax ?? 0) + (x?.playerResult?.businessPax ?? 0);
  assert.ok(p(plain) > 0);
  assert.ok(p(loyal) > p(plain), `${p(plain)} → ${p(loyal)}`);
});

await t('the server publishes a rival\'s presence and pair standing; the engine weighs it', () => {
  const s = withMembers(flying('R', { loyaltyPoolsWorld: true }));
  const row = { id: 'r1', name: 'R', hub: 'DEN', status: 'ACTIVE', state: s };
  const comp = toHumanCompetitor(row, { allianceId: null });
  assert.ok(comp.loyaltyPools?.DEN?.[0] > 0 && comp.loyaltyPools.DEN[1] > 0, JSON.stringify(comp.loyaltyPools));
  assert.equal(comp.loyaltyPools.DEN[2], 50_000);
  const specs = toRivalSpecs(row);
  assert.ok(specs['DEN-ORD'].loyaltyAppeal > 1, 'the spec carries their standing on the pair');
  assert.deepEqual(stateLoyaltyFields(s, 'DEN', 'ORD'),
    { loyaltyAppeal: specs['DEN-ORD'].loyaltyAppeal, loyaltySensReduction: specs['DEN-ORD'].loyaltySensReduction });
  const w = loyaltyRivalWeights([comp]);
  assert.ok(w.DEN > 0);
  const classic = toHumanCompetitor({ ...row, state: { ...s, loyaltyPoolsWorld: undefined } });
  assert.equal('loyaltyPools' in classic, false);
});

await t('two humans at one city: each airline\'s tick sees the other\'s program and enrols less', () => {
  const mk = (id, name) => ({ id, name, hub: 'DEN', status: 'ACTIVE', worldId: 'w1', week: 1,
    state: withMembers(flying(name, { loyaltyPoolsWorld: true })) });
  const a = mk('a1', 'A'), b = mk('a2', 'B');
  const views = buildRivalViews([a, b]);
  const seen = views.get('a1').competitors.find(c => c.name === 'B');
  assert.ok(seen?.loyaltyPools?.DEN?.[0] > 0, 'A sees B\'s presence at Denver');
  seedRandom(6);
  const contested = gameReducer(withRivals(a.state, views.get('a1')), { type: 'ADVANCE_WEEK' });
  seedRandom(6);
  const alone = gameReducer(withRivals(a.state, buildRivalViews([a]).get('a1')), { type: 'ADVANCE_WEEK' });
  Math.random = realRandom;
  assert.ok(contested.loyalty.pools.DEN[0] < alone.loyalty.pools.DEN[0],
    `${alone.loyalty.pools.DEN[0]} alone vs ${contested.loyalty.pools.DEN[0]} contested`);
});

await t('the city table lists rivals and the checklist', () => {
  const s = { ...withMembers(flying('P', { loyaltyPoolsWorld: true })),
    competitors: [{ id: 'human:r', name: 'R', loyaltyPools: { DEN: [20_000, 500, 30_000, 3_000] } }] };
  const rows = loyaltyCityTable(s);
  const den = rows.find(r => r.pool === 'DEN');
  assert.equal(den.members, 50_000);
  assert.equal(den.rivals[0].members, 30_000);
  assert.ok(den.parts.some(p => p.id === 'lounge') && den.parts.some(p => p.id === 'partners'));
  assert.ok(loyaltySeatsByPool(s).DEN > 0);
});

console.log('── 8b. Status match ──────────────────────────────────────────');

const rivalDev = (extra = {}) => ({ id: 'human:r', name: 'Rival Air', devaluation: { cut: 0.02, absWeek: 100 },
  pools: { DEN: [20_000, 500, 40_000, 4_000], BOI: [2_000, 400, 6_000, 600], ORD: [5_000, 400, 9_000, 900] }, ...extra });
const mineAt = (extra = {}) => ({ on: true, seats: { DEN: 10_000, ORD: 3_000 }, values: { DEN: 0.5, ORD: 0.2 },
  matched: {}, absWeek: 101, costScale: 1, ...extra });

await t('the offer: half the walk-outs, only at cities you fly, priced by your value there', () => {
  const o = statusMatchOffer(rivalDev(), mineAt());
  assert.ok(o);
  assert.deepEqual(o.cities.map(c => c.pool), ['DEN', 'ORD'], 'no Boise: you do not fly it');
  const walk = 3 * 0.02 * 0.5;
  assert.equal(o.cities[0].members, Math.round(40_000 * walk));
  assert.equal(o.cities[0].cost, Math.round(o.cities[0].members * LP_MATCH_COST_PER_MEMBER * 1.5));
  assert.equal(o.members, o.cities.reduce((a, c) => a + c.members, 0));
});

await t('the window closes, and each devaluation can be matched once', () => {
  assert.ok(statusMatchOffer(rivalDev(), mineAt({ absWeek: 100 + LP_MATCH_WINDOW_WEEKS })));
  assert.equal(statusMatchOffer(rivalDev(), mineAt({ absWeek: 101 + LP_MATCH_WINDOW_WEEKS })), null);
  assert.equal(statusMatchOffer(rivalDev(), mineAt({ matched: { 'human:r': 100 } })), null);
  assert.ok(statusMatchOffer(rivalDev({ devaluation: { cut: 0.01, absWeek: 120 } }), mineAt({ absWeek: 121, matched: { 'human:r': 100 } })),
    'a later devaluation opens a new window');
  assert.equal(statusMatchOffer(rivalDev(), mineAt({ on: false })), null, 'no program, nothing to match into');
});

await t('a devaluation is public for the window only', () => {
  assert.deepEqual(devaluationNotice({ devaluation: { cut: 0.02, absWeek: 100, until: 112 } }, 102), { cut: 0.02, absWeek: 100 });
  assert.equal(devaluationNotice({ devaluation: { cut: 0.02, absWeek: 100, until: 112 } }, 104), null);
  assert.equal(devaluationNotice({}, 100), null);
});

await t('matched members join as members; your own are not set shopping', () => {
  const out = applyStatusMatch({ DEN: [1_000, 100, 900] }, { cities: [{ pool: 'DEN', members: 500 }, { pool: 'ORD', members: 50 }] });
  assert.deepEqual(out.DEN, [1_500, 100, 900]);
  assert.equal(out.ORD[0], 50);
});

const absNow = (s) => ((s.year ?? 1) - 1) * 52 + (s.week ?? 1);
const matcher = () => {
  const s = withMembers(flying('B', { loyaltyPoolsWorld: true }));
  return { ...s, cash: 5e8, multiplayer: true, competitors: [{ id: 'human:r', name: 'Rival Air', routes: {}, cargoRoutes: {},
    loyaltyDevaluation: { cut: 0.03, absWeek: absNow(s) }, loyaltyPools: { DEN: [20_000, 500, 40_000, 4_000] } }] };
};

await t('reducer: the tick tells you once; the match is priced by the engine, paid and delivered next tick', () => {
  const s0 = matcher();
  const offers = loyaltyMatchOffers(s0);
  assert.equal(offers.length, 1);
  seedRandom(5);
  const s1 = gameReducer(s0, { type: 'ADVANCE_WEEK' });
  assert.ok((s1.pendingToasts ?? []).some(x => x.title === 'Rival Air devalued its program'));
  const s1b = gameReducer({ ...s1, pendingToasts: [] }, { type: 'ADVANCE_WEEK' });
  assert.ok(!(s1b.pendingToasts ?? []).some(x => x.title === 'Rival Air devalued its program'), 'told once');
  const offer = loyaltyMatchOffers(s1)[0];
  const forged = gameReducer(s1, { type: 'LOYALTY_STATUS_MATCH', rivalId: 'human:r', cost: 1, members: 1e9 });
  assert.equal(forged.loyalty.pendingMatch.cost, offer.cost, 'the payload never sets the price');
  assert.equal(forged.loyalty.pendingMatch.members, offer.members);
  assert.match(gameReducer(forged, { type: 'LOYALTY_STATUS_MATCH', rivalId: 'human:r' }).error ?? '', /no longer on offer|already/);
  seedRandom(5);
  const control = gameReducer(s1, { type: 'ADVANCE_WEEK' });
  seedRandom(5);
  const s2 = gameReducer(forged, { type: 'ADVANCE_WEEK' });
  Math.random = realRandom;
  assert.equal(s2.lastReport.loyaltyStatusMatchCost, offer.cost);
  assert.equal(s2.lastReport.totalLoyaltyCost - control.lastReport.totalLoyaltyCost, offer.cost);
  assert.ok(s2.loyalty.pools.DEN[0] > control.loyalty.pools.DEN[0] + offer.members * 0.8, 'the members arrive');
  assert.equal(s2.loyalty.pendingMatch, undefined);
  assert.equal(s2.loyalty.lastMatch.members, offer.members);
  assert.ok((s2.lastReport.loyaltyNews ?? []).some(n => n.type === 'matched' && n.rival === 'Rival Air'));
});

await t('refused without cash, without a program, or outside a pools world', () => {
  const s = matcher();
  assert.match(gameReducer({ ...s, cash: 10 }, { type: 'LOYALTY_STATUS_MATCH', rivalId: 'human:r' }).error ?? '', /not enough cash/);
  assert.match(gameReducer({ ...s, loyalty: { ...s.loyalty, generosity: 0 } }, { type: 'LOYALTY_STATUS_MATCH', rivalId: 'human:r' }).error ?? '', /no longer on offer/);
  const classic = { ...s, loyaltyPoolsWorld: undefined };
  assert.equal(gameReducer(classic, { type: 'LOYALTY_STATUS_MATCH', rivalId: 'human:r' }), classic);
});

await t('end to end: A devalues, the server tells B, B matches, both make the news', () => {
  const a0 = withMembers(flying('A', { loyaltyPoolsWorld: true }));
  const a1 = gameReducer({ ...a0, loyalty: { ...a0.loyalty, generosity: 0.10 } }, { type: 'SET_LOYALTY_GENEROSITY', generosity: 0.07 });
  assert.deepEqual(stateDevaluationNotice(a1), { cut: 0.03, absWeek: absNow(a1) });
  const b0 = withMembers(flying('B', { loyaltyPoolsWorld: true }));
  const rows = [
    { id: 'a1', name: 'A', hub: 'DEN', status: 'ACTIVE', worldId: 'w1', state: a1 },
    { id: 'b1', name: 'B', hub: 'DEN', status: 'ACTIVE', worldId: 'w1', state: b0 },
  ];
  const views = buildRivalViews(rows);
  const seenA = views.get('b1').competitors.find(c => c.name === 'A');
  assert.deepEqual(seenA.loyaltyDevaluation, { cut: 0.03, absWeek: absNow(a1) });
  const bView = withRivals(b0, views.get('b1'));
  const offer = loyaltyMatchOffers(bView)[0];
  assert.ok(offer && offer.name === 'A' && offer.members > 0, JSON.stringify(offer));
  seedRandom(8);
  const aNext = gameReducer(withRivals(a1, views.get('a1')), { type: 'ADVANCE_WEEK' });
  const bNext = gameReducer(gameReducer(bView, { type: 'LOYALTY_STATUS_MATCH', rivalId: offer.rivalId }), { type: 'ADVANCE_WEEK' });
  Math.random = realRandom;
  const items = [
    ...(aNext.lastReport.loyaltyNews ?? []).map(e => ({ ...e, airlineId: 'a1' })),
    ...(bNext.lastReport.loyaltyNews ?? []).map(e => ({ ...e, airlineId: 'b1' })),
  ];
  const news = loyaltyNewsRows({ worldId: 'w1', week: 5, items, nameOf: new Map([['a1', 'A'], ['b1', 'B']]) });
  assert.deepEqual(news.map(n => n.kind).sort(), ['loyalty_devalued', 'status_match']);
  assert.equal(news.find(n => n.kind === 'status_match').payload.rival, 'A');
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const f of ['../apps/headwinds-web/src/Feed.jsx', '../src/components/News.jsx']) {
    assert.ok(read(f).includes("case 'loyalty_devalued'") && read(f).includes("case 'status_match'"), `${f} renders both`);
  }
});

await t('the match is an allowed decision', () => {
  assert.ok((ALLOWED_ACTIONS instanceof Set ? ALLOWED_ACTIONS : new Set(ALLOWED_ACTIONS)).has('LOYALTY_STATUS_MATCH'));
});

console.log('── 9. Headwinds: new worlds only ─────────────────────────────');

const BASE = { name: 'T', lengthYears: 50, weeksPerDay: 24, maxPlayers: 20 };
const tcOf = async (opts) => {
  const calls = [];
  await createWorld({ world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } }, opts);
  return calls[0].tickConfig;
};
const worldRow = (tickConfig) => ({ id: 'w', worldSeed: 's', currentYear: 1, currentWeek: 1, lengthYears: 40, maxPlayers: 20,
  tickConfig: { startingCapital: 15_000_000, demandMultiplier: 1, ...tickConfig } });

await t('a new world is a loyalty-pools world; false creates one without (no key)', async () => {
  assert.equal((await tcOf({ ...BASE })).loyaltyPools, true);
  assert.equal((await tcOf({ ...BASE, loyaltyPools: false })).loyaltyPools, undefined);
  assert.throws(() => validateWorldConfig({ ...BASE, loyaltyPools: 'yes' }), /loyaltyPools/);
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: { loyaltyPools: true } }, { playerCount: 0 }).loyaltyPools, true);
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: {} }, { playerCount: 0 }).loyaltyPools, false);
});

await t('joining bakes the flag; a classic world bakes nothing; the dial is an allowed decision', () => {
  assert.equal(seedAirlineState(worldRow({ loyaltyPools: true }), { airlineName: 'A', hub: 'JFK' }).loyaltyPoolsWorld, true);
  assert.equal(seedAirlineState(worldRow({}), { airlineName: 'B', hub: 'JFK' }).loyaltyPoolsWorld, undefined);
  const allowed = ALLOWED_ACTIONS instanceof Set ? ALLOWED_ACTIONS : new Set(ALLOWED_ACTIONS);
  assert.ok(allowed.has('SET_LOYALTY_GENEROSITY'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
