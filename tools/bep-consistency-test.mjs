// The BEP column must agree with the CASK/RASK columns beside it.
//
// 2026-08-11, Kat the Fox (Discord), with a screenshot of the Unit Economics
// table: "either BEP is wrong or the CASK/RASK is wrong. If im not making a
// profit why isnt it showing that Im losing money on said route because of its
// CASK". Ten routes, every one grade A with RASK above CASK (spread up to
// +$0.041), every one stamped "✗ Below BEP" at break-even load factors of
// 130% to 412%.
//
// CASK/RASK were right. The BEP column never read the engine — it rebuilt a
// 100%-load revenue from `type.seats × frequency × 2 × route.ticketPrice ×
// DEFAULT cabin ladder`, so it missed the per-class fares the player had set,
// the supersonic ticket premium, ancillary/catering income, and the
// connecting-feed revenue the RASK next to it was computed from. Kat's A380 was
// booking ~$500 per seat-leg while the formula priced all 853 seats off a $60
// economy ticket: BEP 393% on a route earning $2.4m a week.
//
// Break-even now comes from breakEvenLoadFactor() in the engine, off the same
// revenue and cost lines RASK and CASKfull are divided out of:
//
//     contributionPerPax = (revenue − paxVariableCost) / pax
//     breakEvenLF        = (fixedCost / contributionPerPax) / seats
//
//   node tools/bep-consistency-test.mjs

import assert from 'node:assert/strict';
import {
  simulateRoute, defaultConfig, defaultClassPrices,
  breakEvenLoadFactor, routeCostSplit, PAX_VARIABLE_COST_KEYS,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nBreak-even load factor agrees with RASK − CASK\n');

const REF = (o, d) => Math.round(referencePrice(o, d));

/**
 * Fly one route and return everything the Unit Economics table shows for it.
 * `allocatedFleet` stands in for the lease + maintenance share the real screen
 * gets from allocateFixedCosts().
 */
function economics({ typeId, origin, destination, freq, config, ticketPrice,
                     classPrices = null, ancillaries = null, allocatedFleet = 0,
                     revenueOverride = null }) {
  const type = getAircraftType(typeId);
  assert.ok(type, `unknown aircraft type ${typeId}`);
  const cfg   = config ?? defaultConfig(type.seats);
  const route = {
    id: 'r1', origin, destination, aircraftId: 'a1',
    weeklyFrequency: freq, ticketPrice, weeksOpen: 200,
    ...(classPrices ? { classPrices } : {}),
  };
  const raw = simulateRoute(route, { id: 'a1', typeId, config: cfg },
    { month: 6 }, null, 1.0, null, [], null, null, 1.0, ancillaries);
  assert.ok(raw, 'simulateRoute returned null');
  // The screen substitutes the tick's booked revenue (proj.revById) here.
  const result = revenueOverride == null ? raw : { ...raw, revenue: revenueOverride };

  const ASK       = result.configuredSeatsOneWay * 2 * result.distance;
  const RASK      = result.revenue / ASK;
  const CASKfull  = (result.totalOpCost + allocatedFleet) / ASK;
  const bep       = breakEvenLoadFactor(result, allocatedFleet);
  const profit    = result.revenue - result.totalOpCost - allocatedFleet;
  return { type, route, result, ASK, RASK, CASKfull, spread: RASK - CASKfull, bep, profit,
           allocatedFleet };
}

/** The invariant the whole screen rests on. */
function assertConsistent(e, label) {
  const aboveBEP = e.bep != null && e.bep !== Infinity && e.result.loadFactor >= e.bep;
  assert.equal(aboveBEP, e.spread >= 0,
    `${label}: LF ${(e.result.loadFactor * 100).toFixed(1)}% vs BEP ` +
    `${e.bep === Infinity ? 'never' : (e.bep * 100).toFixed(1) + '%'} says ` +
    `${aboveBEP ? 'ABOVE' : 'BELOW'}, but spread $${e.spread.toFixed(4)} says ` +
    `${e.spread >= 0 ? 'PROFITABLE' : 'LOSS-MAKING'}`);
  assert.equal(aboveBEP, e.profit >= 0,
    `${label}: BEP verdict disagrees with profit ${Math.round(e.profit).toLocaleString()}`);
}

// ── The exact shape Kat was flying ────────────────────────────────────────────
// A cheap economy cabin to fill the aeroplane, real money charged up front.
// Reproduces the screenshot's ASK of 63.9M on DXB–LHR.
const KAT_CONFIG = {
  firstClass: 14, businessClass: 76, premiumEconomy: 60, economy: 577,
  seatQuality: 'standard', serviceQuality: 'standard',
};
const KAT_PRICES = { economy: 60, premiumEconomy: 900, businessClass: 2600, firstClass: 6000 };

test('cheap economy + priced front cabins: a profitable A380 is not "Below BEP"', () => {
  const e = economics({
    typeId: 'a380', origin: 'DXB', destination: 'LHR', freq: 8,
    config: KAT_CONFIG, ticketPrice: KAT_PRICES.economy, classPrices: KAT_PRICES,
  });
  assert.ok(e.spread > 0, 'fixture should be profitable');
  assert.ok(e.bep < 1, `BEP should be a sane load factor, got ${(e.bep * 100).toFixed(1)}%`);
  assertConsistent(e, 'Kat A380 DXB–LHR');
});

test('supersonic ticket premium counts towards break-even', () => {
  // Kat's ATL–CDG row: a 74-seat all-premium Concorde, 13×/wk, ASK 13.6M.
  // Concorde bills type.ticketPremium× whatever fare is set; pricing break-even
  // off the un-premiumed fare stamped "Below BEP" on a route clearing $0.117/ASK.
  assert.ok(getAircraftType('concorde').ticketPremium > 1, 'fixture assumes a premium');
  const e = economics({
    typeId: 'concorde', origin: 'ATL', destination: 'CDG', freq: 13,
    config: { firstClass: 24, businessClass: 50, premiumEconomy: 0, economy: 0,
              seatQuality: 'standard', serviceQuality: 'standard' },
    ticketPrice: 600,
    classPrices: { economy: 600, premiumEconomy: 840, businessClass: 1800, firstClass: 3600 },
  });
  assert.ok(e.spread > 0, 'fixture should be profitable');
  assert.ok(e.bep < 1, `BEP should be a sane load factor, got ${(e.bep * 100).toFixed(1)}%`);
  assertConsistent(e, 'Concorde ATL–CDG');
});

test('ancillary income counts towards break-even', () => {
  const base = { typeId: 'a320neo', origin: 'CAI', destination: 'DXB', freq: 14,
                 ticketPrice: REF('CAI', 'DXB') };
  const bare = economics(base);
  const sell = economics({ ...base, ancillaries: {
    active: true, checkedBag: { offered: true, price: 45 }, seatSelection: { offered: true, price: 18 },
  } });
  assertConsistent(bare, 'A320neo no ancillaries');
  assertConsistent(sell, 'A320neo selling ancillaries');
  // Not asserting a direction — a policy can cost more than it earns. What must
  // hold is that whatever it does to the spread, it does to BEP.
  if (sell.spread !== bare.spread) {
    assert.equal(sell.spread > bare.spread, sell.bep < bare.bep,
      'ancillaries moved the spread and BEP in opposite directions');
  }
});

test('booked revenue the tick added (connecting feed) moves BEP with RASK', () => {
  const base = { typeId: 'b777300er', origin: 'PHX', destination: 'LHR', freq: 6,
                 ticketPrice: REF('PHX', 'LHR') };
  const own  = economics(base);
  const fed  = economics({ ...base, revenueOverride: Math.round(own.result.revenue * 1.6) });
  assertConsistent(own, 'PHX–LHR own metal');
  assertConsistent(fed, 'PHX–LHR with feed');
  assert.ok(fed.bep < own.bep, 'feed revenue should lower break-even, not leave it untouched');
});

test('a genuinely loss-making route reads Below BEP', () => {
  const e = economics({
    typeId: 'a380', origin: 'DXB', destination: 'LHR', freq: 8,
    ticketPrice: 25,                       // far under cost
  });
  assert.ok(e.spread < 0, 'fixture should be loss-making');
  assertConsistent(e, 'underpriced A380');
});

test('lease and maintenance allocation raises break-even', () => {
  const base = { typeId: 'b777300er', origin: 'PHX', destination: 'LHR', freq: 6,
                 ticketPrice: REF('PHX', 'LHR') };
  const noFleet = economics(base);
  const withFleet = economics({ ...base, allocatedFleet: 900_000 });
  assertConsistent(noFleet, 'PHX–LHR op-cost only');
  assertConsistent(withFleet, 'PHX–LHR all-in');
  assert.ok(withFleet.bep > noFleet.bep, 'ownership cost must raise break-even');
});

test('BEP is the load factor where profit is exactly zero', () => {
  // Walk the fare down until the route is marginal, then check the arithmetic:
  // at LF = BEP the route should book exactly its costs.
  const e = economics({ typeId: 'b777300er', origin: 'PHX', destination: 'LHR', freq: 6,
                        ticketPrice: REF('PHX', 'LHR'), allocatedFleet: 400_000 });
  const { fixed, variable, total } = routeCostSplit(e.result, e.allocatedFleet);
  assert.equal(fixed + variable, total, 'split must reconstruct the total exactly');

  const pax   = e.result.passengers;
  const perPax = { rev: e.result.revenue / pax, varCost: variable / pax };
  const bePax = e.bep * e.result.configuredSeatsOneWay;
  const profitAtBE = bePax * (perPax.rev - perPax.varCost) - fixed;
  assert.ok(Math.abs(profitAtBE) < 1e-6 * Math.max(1, total),
    `profit at break-even should be 0, got ${profitAtBE}`);
});

test('a route that loses money on every passenger never breaks even', () => {
  // Contribution per passenger negative → no load factor saves it. It must say
  // so, not report a tidy percentage.
  const e = economics({
    typeId: 'a380', origin: 'DXB', destination: 'LHR', freq: 8,
    ticketPrice: 1,
  });
  const { variable } = routeCostSplit(e.result, 0);
  if (e.result.revenue <= variable) {
    assert.equal(e.bep, Infinity, 'should report "never", not a number');
    assert.ok(e.spread < 0);
  }
});

test('every pax-variable key is a real cost line simulateRoute returns', () => {
  const e = economics({ typeId: 'a320neo', origin: 'CAI', destination: 'DXB', freq: 14,
                        ticketPrice: REF('CAI', 'DXB') });
  for (const k of PAX_VARIABLE_COST_KEYS) {
    assert.ok(k in e.result, `simulateRoute no longer returns ${k} — the split is stale`);
  }
  // Anything unnamed lands on the fixed side; the identity must still hold.
  const { fixed, variable, total } = routeCostSplit(e.result, 12_345);
  assert.equal(fixed + variable, total);
  assert.equal(total, e.result.totalOpCost + 12_345);
});

test('no seats flying reports no break-even rather than 0%', () => {
  const e = economics({ typeId: 'a320neo', origin: 'CAI', destination: 'DXB', freq: 14,
                        ticketPrice: REF('CAI', 'DXB') });
  assert.equal(breakEvenLoadFactor({ ...e.result, configuredSeatsOneWay: 0 }, 0), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
