// Travel partnerships — the demand-model half.
//
// A travel partner lifts ONE segment: cruise lines and tour operators the
// leisure segment, hotels and ride share the business segment
// (PARTNERSHIPS_PLAN.md §4). It rides in on two offer fields with the same
// log identity lounges use for the business segment:
//
//   contested pair  + log(appeal) in that segment's utility → the offer's
//                   softmax weight is multiplied by exactly `appeal`
//   monopoly        that segment's pool is multiplied by `appeal`
//   solo ceiling    the same multiplier, or spill can never reach the lift
//
// An offer without the fields (AI rivals, old previews, tests) sits at parity
// and is scored exactly as before.
//
//   node tools/travel-partner-demand-test.mjs

import assert from 'node:assert/strict';
import { buildRouteMarket, computeMarketShare, computeUtility } from '../packages/engine/src/models/demand.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nTravel partnerships — segment appeal in the demand model\n');

const market = buildRouteMarket('JFK', 'MCO', { month: 1, week: 3 }, 1, 1);
const ref = market.referencePrice;

function offer(id, extra = {}) {
  return {
    airlineId: id, origin: 'JFK', destination: 'MCO',
    economyPrice: Math.round(ref), businessPrice: Math.round(ref * 3),
    weeklyFrequency: 14, seatsPerFlight: 180,
    economySeats: 1e9, businessSeats: 1e9, totalSeats: 2e9,
    qualityScore: 60, connectivityBonus: 0,
    ...extra,
  };
}

test('identity: no fields and appeal 1 score the same', () => {
  const a = computeMarketShare(market, [offer('p')])[0];
  const b = computeMarketShare(market, [offer('p', { travelLeisureAppeal: 1, travelBusinessAppeal: 1 })])[0];
  assert.deepEqual(a, b);
  const c = computeMarketShare(market, [offer('p'), offer('r')]);
  const d = computeMarketShare(market, [offer('p', { travelLeisureAppeal: 1 }), offer('r')]);
  assert.deepEqual(c, d);
});

test('monopoly: leisure appeal grows the leisure pool only', () => {
  const base = computeMarketShare(market, [offer('p')])[0];
  const lift = computeMarketShare(market, [offer('p', { travelLeisureAppeal: 1.1 })])[0];
  assert.ok(base.leisurePaxUncapped > 100, 'pair has leisure demand');
  const ratio = lift.leisurePaxUncapped / base.leisurePaxUncapped;
  assert.ok(Math.abs(ratio - 1.1) < 0.01, `leisure ×${ratio.toFixed(4)}, want ×1.1`);
  assert.equal(lift.businessPaxUncapped, base.businessPaxUncapped, 'business untouched');
});

test('monopoly: business appeal grows the business pool only', () => {
  const base = computeMarketShare(market, [offer('p')])[0];
  const lift = computeMarketShare(market, [offer('p', { travelBusinessAppeal: 1.1 })])[0];
  assert.ok(base.businessPaxUncapped > 10, 'pair has business demand');
  const ratio = lift.businessPaxUncapped / base.businessPaxUncapped;
  assert.ok(Math.abs(ratio - 1.1) < 0.02, `business ×${ratio.toFixed(4)}, want ×1.1`);
  assert.equal(lift.leisurePaxUncapped, base.leisurePaxUncapped, 'leisure untouched');
});

test('monopoly, no business cabin: folded business travellers keep the business appeal', () => {
  const eco = { businessPrice: null, businessSeats: 0 };
  const base = computeMarketShare(market, [offer('p', eco)])[0];
  const biz  = computeMarketShare(market, [offer('p', { ...eco, travelBusinessAppeal: 1.1 })])[0];
  const lei  = computeMarketShare(market, [offer('p', { ...eco, travelLeisureAppeal: 1.1 })])[0];
  // Both grow the folded economy pool, by their segment's share of it.
  const L = market.leisureDemand, B = market.businessDemand;
  const wantBiz = (L + 1.1 * B) / (L + B);
  const wantLei = (1.1 * L + B) / (L + B);
  assert.ok(Math.abs(biz.leisurePaxUncapped / base.leisurePaxUncapped - wantBiz) < 0.01);
  assert.ok(Math.abs(lei.leisurePaxUncapped / base.leisurePaxUncapped - wantLei) < 0.01);
});

test('contested: appeal multiplies the softmax weight of that segment exactly', () => {
  const a = offer('p', { travelLeisureAppeal: 1.2 });
  const b = offer('r');
  const uA = computeUtility(a, market, 'leisure'), uB = computeUtility(b, market, 'leisure');
  assert.ok(Math.abs(Math.exp(uA - uB) - 1.2) < 1e-9, 'leisure weight ×1.2');
  assert.equal(computeUtility(a, market, 'business'), computeUtility(b, market, 'business'), 'business untouched');
  const c = offer('p', { travelBusinessAppeal: 1.2 });
  assert.ok(Math.abs(Math.exp(computeUtility(c, market, 'business') - computeUtility(b, market, 'business')) - 1.2) < 1e-9);
  assert.equal(computeUtility(c, market, 'leisure'), uB, 'leisure untouched');
});

test('contested: a lifted carrier out-carries an identical rival', () => {
  const [p, r] = computeMarketShare(market, [offer('p', { travelLeisureAppeal: 1.1 }), offer('r')]);
  assert.ok(p.leisurePax > r.leisurePax * 1.05, `${p.leisurePax} vs ${r.leisurePax}`);
  assert.equal(p.businessPax, r.businessPax);
});

test('shared partner: both carriers lifted equally → shares unchanged', () => {
  const [p0, r0] = computeMarketShare(market, [offer('p'), offer('r')]);
  const [p1, r1] = computeMarketShare(market, [
    offer('p', { travelLeisureAppeal: 1.07 }), offer('r', { travelLeisureAppeal: 1.07 })]);
  assert.equal(p1.leisurePax, r1.leisurePax);
  assert.ok(Math.abs(p1.leisurePax - p0.leisurePax) <= 1, 'contested pool not grown');
  assert.equal(r1.leisurePax, r0.leisurePax);
});

test('solo ceiling carries the lift: a ceiling-bound carrier still gets it', () => {
  // A cheap rival with almost no seats wins the share fight and spills nearly
  // everyone to the player, who is then held to its solo ceiling (what it
  // would carry ALONE at the compressed fare). With the lift only in the
  // utility term, that ceiling swallowed it whole: lifted and un-lifted
  // carried exactly the same (22,347 both, measured against HEAD's ceiling).
  const tiny = offer('r', { economyPrice: Math.round(ref * 0.6), economySeats: 50, totalSeats: 50,
    businessSeats: 0, businessPrice: null });
  const [plain]  = computeMarketShare(market, [offer('p'), tiny]);
  const [lifted] = computeMarketShare(market, [offer('p', { travelLeisureAppeal: 1.12 }), tiny]);
  const ratio = lifted.leisurePax / plain.leisurePax;
  assert.ok(Math.abs(ratio - 1.12) < 0.01, `lifted/plain = ${ratio.toFixed(4)}, want ≈1.12`);
  const mono = computeMarketShare(market, [offer('p', { travelLeisureAppeal: 1.12 })])[0];
  assert.ok(lifted.leisurePax <= mono.leisurePax, 'never more than the lifted monopoly');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
