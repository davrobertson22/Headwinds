// An all-economy carrier's solo ceiling counts the business travellers who
// would fly it in economy — guards the 2026-10-21 Discord report (Betterthanu):
// "60% load on JFK–MCO with only 1 other competitor flying a lot less than I
// am. My prices are $20 below average, quality is 90, and I fly 4x as often in a
// bigger jet."
//
// computeMarketShare caps every contested offer at what it would carry ALONE at
// its own fare (_soloCeiling) — the monopoly rule. But the monopoly rule
// (_monopolyResult) folds the business pool into economy when the offer sells
// no business cabin, and _soloCeiling did not: its leisure ceiling was sized on
// market.leisureDemand alone and its business ceiling was 0. An economy-only
// carrier's ceiling was therefore ~1/(1 + B/L) of the real one — on JFK–MCO
// (B/L ≈ 0.23) about 19% short. It applies when nobody on the pair sells
// business — the case where the contested fight itself folds the business pool
// into economy (computeMarketShare's `anyBiz`).
//
// The ceiling binds whenever a carrier's brand reach is below parity and a rival
// spills to it, or when it wins most of a pair — exactly the report: a young
// airline flying 112/wk next to a full 28/wk rival was pinned at 16.5k pax
// (60% load) while its monopoly figure at the same fare was 23k. Adding ONE
// 150-seat weekly rival cut an established all-economy carrier's traffic from
// 44,185 to 32,089.
//
//   node tools/solo-ceiling-business-fold-test.mjs

import assert from 'node:assert/strict';
import { buildRouteMarket, computeMarketShare } from '../packages/engine/src/models/demand.js';

const market = buildRouteMarket('JFK', 'MCO', { week: 40, month: 10 });
assert.ok(market.businessDemand > 0.15 * market.leisureDemand,
  'fixture: JFK–MCO must carry a real business pool for this test to bite');

const ecoOnly = (id, { freq, seats, price, reach = 1, quality = 70 }) => ({
  airlineId: id, origin: 'JFK', destination: 'MCO',
  economyPrice: price, businessPrice: null,
  weeklyFrequency: freq, economySeats: freq * seats, businessSeats: 0, totalSeats: freq * seats,
  qualityScore: quality, connectivityBonus: 0, brandReach: reach,
});

const ref = market.referencePrice;
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

for (const reach of [1, 0.52]) {
  const player = ecoOnly('player', { freq: 200, seats: 244, price: ref - 20, reach, quality: 90 });
  const mono = computeMarketShare(market, [player])[0].totalPax;

  check(`reach ${reach}: a 1x/wk 150-seat rival doesn't cut an all-economy carrier's traffic by a quarter`, () => {
    const tiny = ecoOnly('rival', { freq: 1, seats: 150, price: ref, quality: 62 });
    const [p, r] = computeMarketShare(market, [player, tiny]);
    // A second carrier legitimately compresses the pair's fare reference (−5%),
    // which shrinks the elastic pool a little; it must not remove the whole
    // business segment from what this carrier can carry.
    assert.ok(p.totalPax >= 0.88 * mono,
      `contested ${p.totalPax} vs monopoly ${mono} (${(p.totalPax / mono * 100).toFixed(1)}%), rival ${r.totalPax}`);
    assert.ok(p.totalPax <= mono, `contested ${p.totalPax} exceeds monopoly ${mono}`);
  });

  check(`reach ${reach}: a full rival's spill isn't lost to an all-economy carrier with empty seats`, () => {
    const full = ecoOnly('rival', { freq: 28, seats: 150, price: ref, quality: 62 });
    const [p, r] = computeMarketShare(market, [player, full]);
    assert.equal(r.totalPax, 28 * 150, 'fixture: the rival must be full');
    if (reach < 1) {
      // Brand-limited: the player's solo ceiling is what binds, so it should sit
      // at (nearly) its own monopoly figure — the report's case.
      assert.ok(p.totalPax >= 0.88 * mono,
        `player ${p.totalPax} vs its monopoly ${mono} (${(p.totalPax / mono * 100).toFixed(1)}%)`);
    } else {
      // At parity the pool binds: the rival keeps its 4,200 and the player gets
      // the rest of a pair whose fares compressed 5%. Nothing else goes missing.
      const both = p.totalPax + r.totalPax;
      assert.ok(both >= 0.85 * mono,
        `lane carried ${both} (player ${p.totalPax} + rival ${r.totalPax}) vs ${mono} for the player alone (${(both / mono * 100).toFixed(1)}%)`);
    }
  });
}

check('when a rival sells business, an economy-only carrier\'s ceiling stays leisure-only', () => {
  // Those business travellers stay in the business segment (the rival's J
  // cabin), which an economy-only offer never draws from, so folding them into
  // its ceiling would let leisure spill fill seats the leisure market alone
  // would never have bought (tools/rival-itinerary-test.mjs pins the effect).
  const player = ecoOnly('player', { freq: 200, seats: 244, price: ref - 20, reach: 0.52, quality: 90 });
  const fullJ = { ...ecoOnly('rival', { freq: 28, seats: 150, price: ref, quality: 62 }),
    businessPrice: Math.round(ref * 3.5), businessSeats: 28 * 12 };
  const [p] = computeMarketShare(market, [player, fullJ]);
  const leisureOnlyAlone = computeMarketShare({ ...market, businessDemand: 0 }, [player])[0].totalPax;
  assert.ok(p.totalPax <= leisureOnlyAlone,
    `player ${p.totalPax} exceeds what the leisure market alone gives it (${leisureOnlyAlone})`);
});

check('a carrier WITH a business cabin keeps separate leisure / business ceilings', () => {
  const withJ = { ...ecoOnly('player', { freq: 200, seats: 244, price: ref - 20, quality: 90 }),
    businessPrice: Math.round(ref * 3.5), businessSeats: 200 * 16 };
  const tiny = ecoOnly('rival', { freq: 1, seats: 150, price: ref, quality: 62 });
  const [p] = computeMarketShare(market, [withJ, tiny]);
  const mono = computeMarketShare(market, [withJ])[0];
  assert.ok(p.businessPax > 0, 'business cabin sells');
  assert.ok(p.totalPax <= mono.totalPax, `contested ${p.totalPax} exceeds monopoly ${mono.totalPax}`);
});

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nsolo-ceiling-business-fold: all passed');
