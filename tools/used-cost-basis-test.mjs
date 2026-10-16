// A used aeroplane is never worth more than you paid for it — to the shop or
// to the bank.
//
// B9. Heavy Landing, Oct 2026. Estates list a failed airline's frames at 65% of
//     NAV (fireSaleService.AIRCRAFT_DISTRESS_FACTOR). Aircraft Finance lent 70%
//     of full book value, and SELL_AIRCRAFT paid NAV − 5% straight back to the
//     shop. So a frame bought from the void at 0.65 could be pledged for 0.70
//     (the loan more than repaid the purchase — the plane was free) or flipped
//     back to the void for 0.95. One airline bought 454 estate frames for
//     $26.6B, drew $31B of loans against them and flipped 149 for $5.6B, and
//     reached #1 forty weeks after founding. The Discord read it as API
//     tampering; the journal said it was all in-engine.
//
//     The fix is one fact and one rule. BUY_USED_AIRCRAFT records what was paid
//     as `costBasis` on the delivered tail, and anywhere the engine turns a tail
//     into cash — loan collateral, a sale to the shop, a hull write-off — it
//     values the tail at min(NAV, costBasis). NAV only ever falls, so a tail
//     bought at NAV behaves exactly as before; the cap bites only on the
//     discount, and only until depreciation has eaten it.
//
//     Factory orders carry no basis. The bulk-order discount tops out at 20% on
//     a 100-frame order paid in full up front — a leveraged bet, not a loop —
//     and recording a basis on every delivery would move the golden master.
//
//   node tools/used-cost-basis-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType, eraPurchasePrice } from '../packages/engine/src/data/aircraft.js';
import { valueRemaining, capAtCostBasis } from '../packages/engine/src/data/overhead.js';
import { airframeNAV, saleQuote, aogRepairCost, AOG_WRITE_OFF_PAYOUT_FRACTION } from '../packages/engine/src/data/maintenance.js';
import { collateralValue, borrowingCapacity, AIRCRAFT_LOAN_ID, AIRCRAFT_LOAN_LTV } from '../packages/engine/src/data/credit.js';
import { AIRCRAFT_DISTRESS_FACTOR, distressedNav } from '../apps/headwinds-server/src/lib/fireSaleService.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const absWeek = (s) => (s.year - 1) * 52 + s.week;
const TYPE_ID = 'a380';
const type    = getAircraftType(TYPE_ID);
assert.ok(type, 'need the A380 in the type table');

/** The snapshot an estate listing carries: a real tail minus its identity. */
const snapshot = (over = {}) => ({
  typeId: TYPE_ID, name: 'Airbus A380 #1', ageWeeks: 104, ownershipType: 'owned',
  config: { firstClass: 14, businessClass: 76, premiumEconomy: 0, economy: 400, seatQuality: 'standard' },
  ...over,
});

/** Buy one estate frame at the distressed price and take delivery (one tick). */
function boughtUsed(snapOver = {}) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 2_000_000_000 };
  const snap  = snapshot(snapOver);
  const price = distressedNav(snap);
  const before = s;
  s = gameReducer(s, { type: 'BUY_USED_AIRCRAFT', snapshot: snap, price });
  assert.notEqual(s, before, 'the buy must be accepted');
  assert.equal(s.pendingOrders.at(-1).used, true);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const tail = s.fleet.find((a) => a.typeId === TYPE_ID && a.ownershipType === 'owned');
  assert.ok(tail, 'the used tail must have been delivered');
  return { s, tail, price, snap };
}

const fullNav = (tail, s) => airframeNAV(tail, type, absWeek(s));

test('capAtCostBasis: no basis means no cap, a basis caps, and junk is ignored', () => {
  assert.equal(capAtCostBasis({}, 100), 100);
  assert.equal(capAtCostBasis({ costBasis: 60 }, 100), 60);
  assert.equal(capAtCostBasis({ costBasis: 160 }, 100), 100);
  assert.equal(capAtCostBasis({ costBasis: NaN }, 100), 100);
  assert.equal(capAtCostBasis({ costBasis: 'x' }, 100), 100);
  assert.equal(capAtCostBasis({ costBasis: -5 }, 100), 100);
});

test('the delivered used tail remembers what was paid for it', () => {
  const { tail, price } = boughtUsed();
  assert.equal(tail.costBasis, price);
  assert.ok(price < fullNav(tail, { year: 1, week: 2 }), 'an estate frame is bought below NAV, or the test proves nothing');
});

test('a snapshot carrying the previous owner\'s basis is re-based to this sale', () => {
  const { tail, price } = boughtUsed({ costBasis: 1 });
  assert.equal(tail.costBasis, price);
});

test('the bank lends against what was paid, not against full book', () => {
  const { s, tail, price } = boughtUsed();
  assert.equal(collateralValue(s), price);
  assert.equal(borrowingCapacity(s, AIRCRAFT_LOAN_ID), Math.floor(price * AIRCRAFT_LOAN_LTV / 1000) * 1000);
  // The loop that started this: the loan must no longer cover the purchase.
  assert.ok(borrowingCapacity(s, AIRCRAFT_LOAN_ID) < price,
    `a secured loan (${borrowingCapacity(s, AIRCRAFT_LOAN_ID)}) still covers the distressed price (${price})`);
  assert.ok(AIRCRAFT_LOAN_LTV > AIRCRAFT_DISTRESS_FACTOR, 'the constants still make the loop possible without the basis cap — keep this test honest');
  void tail;
});

test('selling a used tail back to the shop pays basis − 5%, not NAV − 5%', () => {
  const { s, tail, price } = boughtUsed();
  const nav  = fullNav(tail, s);
  const sold = gameReducer(s, { type: 'SELL_AIRCRAFT', aircraftId: tail.id });
  const got  = sold.cash - s.cash;
  assert.equal(got, price - Math.round(price * 0.05));
  assert.ok(got < nav - Math.round(nav * 0.05), 'the sale must pay less than an uncapped NAV sale');
});

test('…but the shop relists it at its true NAV, not at the discount', () => {
  const { s, tail } = boughtUsed();
  const sold = gameReducer(s, { type: 'SELL_AIRCRAFT', aircraftId: tail.id });
  assert.equal(sold.lastSale.nav, fullNav(tail, s));
});

test('a tail with no basis (factory order, old save) sells exactly as before', () => {
  const { s, tail } = boughtUsed();
  const { costBasis: _drop, ...legacy } = tail;
  const legacyState = { ...s, fleet: s.fleet.map((a) => a.id === tail.id ? legacy : a) };
  const nav  = fullNav(legacy, legacyState);
  const sold = gameReducer(legacyState, { type: 'SELL_AIRCRAFT', aircraftId: tail.id });
  assert.equal(sold.cash - legacyState.cash, nav - Math.round(nav * 0.05));
  assert.equal(collateralValue(legacyState), Math.round(eraPurchasePrice(type) * valueRemaining(legacy.ageWeeks, type)));
});

test('once depreciation has eaten the discount the cap is moot', () => {
  const { s, tail } = boughtUsed();
  const old = { ...tail, ageWeeks: 52 * 25 };
  const oldState = { ...s, fleet: s.fleet.map((a) => a.id === tail.id ? old : a) };
  const nav = fullNav(old, oldState);
  assert.ok(nav < old.costBasis, 'the aged frame must book below its basis for this test');
  const sold = gameReducer(oldState, { type: 'SELL_AIRCRAFT', aircraftId: tail.id });
  assert.equal(sold.cash - oldState.cash, nav - Math.round(nav * 0.05));
});

test('saleQuote is what the reducer pays — the Fleet dialog must agree with the tick', () => {
  const { s, tail } = boughtUsed();
  for (const t of [tail, { ...tail, costBasis: undefined }, { ...tail, ageWeeks: 52 * 25 }]) {
    const st = { ...s, fleet: s.fleet.map((a) => a.id === tail.id ? t : a) };
    const q  = saleQuote(t, type, absWeek(st));
    const sold = gameReducer(st, { type: 'SELL_AIRCRAFT', aircraftId: tail.id });
    assert.equal(sold.cash - st.cash, q.proceeds);
    assert.equal(q.nav, fullNav(t, st));
    assert.equal(q.value - q.fee, q.proceeds);
    assert.equal(q.fee, Math.round(q.value * 0.05));
  }
});

test('a hull write-off pays out on the basis, not on full NAV', () => {
  // Old enough, with a bad enough engine option, that a severe fault costs more
  // than 60% of a hull already sitting on the 10% floor.
  const base = { id: 't', typeId: TYPE_ID, ownershipType: 'owned', ageWeeks: 52 * 36 };
  const opts = { maintMod: 1.5 };
  const plain = aogRepairCost(base, type, 'severe', opts);
  assert.equal(plain.writeOff, true, 'this frame must write off for the test to mean anything');
  const basis = Math.round(plain.nav * 0.5);
  const capped = aogRepairCost({ ...base, costBasis: basis }, type, 'severe', opts);
  assert.equal(capped.writeOff, true);
  assert.equal(capped.payout, Math.round(basis * AOG_WRITE_OFF_PAYOUT_FRACTION));
  assert.equal(plain.payout, Math.round(plain.nav * AOG_WRITE_OFF_PAYOUT_FRACTION));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
