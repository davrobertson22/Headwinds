// Spill recapture — a capped carrier no longer destroys the demand it cannot carry.
//
// HUB_CONNECTIVITY_PLAN.md Phase 1a. Before this, computeMarketShare handed each
// offer softmax share × pool, then capped it at its seats and DISCARDED the
// excess: a rival with 10 seats and a great fare could "take" 3,000 pax of a
// market and carry 10, and the other 2,990 vanished from the world. Rival
// nonstops did this quietly for years; a connecting itinerary (seat-thin by
// construction) does it on every pair it touches — the Phase 0 probe measured
// 82% of the player's apparent loss to rival one-stops as evaporated demand.
//
// Now: capped offers' unserved demand is re-allocated among the uncapped offers
// pro rata to their raw allocation (share × fare choke), iterating until no new
// offer caps. Business spill stays in the business cabin; leisure spill fills
// whatever seats are left. Demand is lost only when every carrier is full.
//
//   node --import ./tools/_register-loader.mjs tools/spill-recapture-test.mjs

import assert from 'node:assert/strict';
import { computeMarketShare, BUSINESS_PRICE_MULTIPLIER } from '../packages/engine/src/models/demand.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nSpill recapture\n');

const MARKET = {
  origin: 'ATL', destination: 'DFW', referencePrice: 162, distanceKm: 1160,
  leisureDemand: 7600, businessDemand: 2100,
};
const offer = (id, over = {}) => ({
  airlineId: id, origin: 'ATL', destination: 'DFW',
  economyPrice: 150, businessPrice: Math.round(150 * BUSINESS_PRICE_MULTIPLIER),
  weeklyFrequency: 21, seatsPerFlight: 180,
  economySeats: 3000, businessSeats: 400, totalSeats: 3400,
  qualityScore: 65, connectivityBonus: 0, ...over,
});
const ROOMY = { economySeats: 1e6, businessSeats: 1e5, totalSeats: 1.1e6 };
const BIG   = offer('big',  { ...ROOMY, weeklyFrequency: 35 });
// Same fare as BIG — attractive on quality, not price, so the pool it generates
// is the pool BIG could carry alone (see "a cheap rival" below for the other case).
const TINY  = offer('tiny', { economySeats: 10, businessSeats: 2, totalSeats: 12, qualityScore: 85 });
const carried = (r) => r.reduce((s, x) => s + x.totalPax, 0);
// Shares never depend on seats, so the demand a market GENERATES for an offer
// set is what the same set carries when every offer has unlimited seats.
const roomy     = (o) => ({ ...o, economySeats: 1e9, businessSeats: 1e9, totalSeats: 2e9 });
const generated = (offers) => carried(computeMarketShare(MARKET, offers.map(roomy)));
const by = (r, id) => r.find(x => x.airlineId === id);
// "Conserved" means up to the receiver's own solo ceiling: the small residual is
// demand that only existed because of the capped carrier's product (its quality
// lifts the market's business capture, say) and has nowhere honest to go.
const conserved = (got, gen, tol = 0.02) => Math.abs(got - gen) <= Math.max(2, gen * tol);
const alone = (o) => computeMarketShare(MARKET, [roomy(o)])[0].totalPax;

test('a seat-thin rival with a great product no longer deletes the demand it cannot carry', () => {
  const res = computeMarketShare(MARKET, [BIG, TINY]);
  const tiny = by(res, 'tiny');
  assert.ok(tiny.capacityCapped, 'tiny should be capped');
  assert.equal(tiny.totalPax, 12);
  const gen = generated([BIG, TINY]);
  assert.ok(conserved(carried(res), gen),
    `carried ${carried(res)} vs generated ${gen} — ${gen - carried(res)} pax evaporated`);
});

test('the receiving offer reports the spill in its uncapped demand', () => {
  const bigAlone     = by(computeMarketShare(MARKET, [BIG, roomy(TINY)]), 'big');
  const bigWithSpill = by(computeMarketShare(MARKET, [BIG, TINY]), 'big');
  assert.ok(bigWithSpill.leisurePaxUncapped > bigAlone.leisurePaxUncapped,
    'uncapped demand on the receiver must include what spilled onto it (the load models read this)');
});

test('spill flows the other way too — a capped player hands its excess to the rival', () => {
  const player = offer('player', { economySeats: 50, businessSeats: 5, totalSeats: 55, qualityScore: 85 });
  const rival  = offer('rival',  ROOMY);
  const res = computeMarketShare(MARKET, [player, rival]);
  assert.equal(by(res, 'player').totalPax, 55);
  assert.ok(conserved(carried(res), generated([player, rival])),
    `rival absorbs the player's spill: ${carried(res)} vs ${generated([player, rival])}`);
});

test('business spill stays in the business cabin', () => {
  const a = offer('a', { businessSeats: 5, economySeats: 1e6, totalSeats: 1e6 + 5, qualityScore: 90 });
  const b = offer('b', ROOMY);
  const res = computeMarketShare(MARKET, [a, b]);
  const totalBiz = res.reduce((s, x) => s + x.businessPax, 0);
  const genBiz   = computeMarketShare(MARKET, [a, b].map(roomy)).reduce((s, x) => s + x.businessPax, 0);
  assert.equal(by(res, 'a').businessPax, 5);
  assert.ok(conserved(totalBiz, genBiz, 0.05), `business demand conserved: ${totalBiz} vs ${genBiz}`);
});

test('when every carrier is full the demand is genuinely lost — never negative, never NaN', () => {
  const a = offer('a', { economySeats: 100, businessSeats: 10, totalSeats: 110 });
  const b = offer('b', { economySeats: 100, businessSeats: 10, totalSeats: 110 });
  const res = computeMarketShare(MARKET, [a, b]);
  for (const r of res) {
    assert.ok(Number.isFinite(r.totalPax) && r.totalPax >= 0);
    assert.ok(r.capacityCapped);
    assert.equal(r.totalPax, 110);
  }
});

test('an offer choked out by its own fare receives no spill', () => {
  const gouger = offer('gouger', { ...ROOMY, economyPrice: 162 * 4, businessPrice: 162 * 4 * BUSINESS_PRICE_MULTIPLIER });
  const res = computeMarketShare(MARKET, [BIG, TINY, gouger]);
  assert.equal(by(res, 'gouger').totalPax, 0, 'no raw demand → no share of the spill either');
  assert.ok(conserved(carried(res), generated([BIG, TINY, gouger])), 'big still absorbs it all');
});

// ── The ceiling: a full rival never makes you better off than a monopoly ───

test('a cheap rival that fills up cannot hand a pricier carrier more than it would carry alone', () => {
  // TINY at $110 grows the pool (elasticity on the average fare); when it caps,
  // BIG at $150 takes only what $150 would sell alone — the rest stays home.
  const cheap = offer('cheap', { economySeats: 10, businessSeats: 2, totalSeats: 12, economyPrice: 110 });
  const big = by(computeMarketShare(MARKET, [BIG, cheap]), 'big');
  assert.ok(big.totalPax <= alone(BIG) + 1,
    `big carried ${big.totalPax} with a full cheap rival, but only ${alone(BIG)} alone`);
  assert.ok(!big.capacityCapped, 'big has seats — it is bounded by its fare, not its cabin');
});

test('an unknown brand picks up a full rival\'s spill only from travellers who consider it', () => {
  const startUp = offer('startup', { ...ROOMY, brandReach: 0.45 });
  const known   = offer('known',   { economySeats: 100, businessSeats: 10, totalSeats: 110 });  // reach 1, tiny
  const res = computeMarketShare(MARKET, [startUp, known]);
  assert.ok(by(res, 'startup').totalPax <= alone(startUp) + 1,
    `start-up carried ${by(res, 'startup').totalPax} beside a full known rival, ${alone(startUp)} alone`);
});

test('two unknown brands do not between them reach the whole market', () => {
  const a = offer('a', { ...ROOMY, brandReach: 0.45 });
  const b = offer('b', { ...ROOMY, brandReach: 0.45 });
  const both = carried(computeMarketShare(MARKET, [a, b]));
  const full = carried(computeMarketShare(MARKET, [{ ...a, brandReach: 1 }, { ...b, brandReach: 1 }]));
  const expect = 1 - 0.55 * 0.55;   // offersBrandCapture
  assert.ok(Math.abs(both / full - expect) < 0.03,
    `two 45%-reach brands should reach ${(expect * 100).toFixed(0)}% of the pair, got ${(both / full * 100).toFixed(0)}%`);
});

test('a monopoly result is untouched', () => {
  const [solo] = computeMarketShare(MARKET, [TINY]);
  assert.equal(solo.totalPax, 12);
  assert.ok(solo.capacityCapped);
});

test('with room everywhere, results are identical to a plain softmax split', () => {
  const a = offer('a', ROOMY);
  const b = offer('b', { ...ROOMY, economyPrice: 140 });
  const res = computeMarketShare(MARKET, [a, b]);
  for (const r of res) {
    assert.ok(!r.capacityCapped);
    assert.equal(r.leisurePax, r.leisurePaxUncapped);
    assert.equal(r.businessPax, r.businessPaxUncapped);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
