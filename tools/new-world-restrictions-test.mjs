// New World Restrictions — lessor stock + lease order book.
//
// Motivating case, from the live world "Scarce Assets": Otter Air (43 aircraft,
// rank #6) placed two ORDER_AIRCRAFT decisions two minutes apart for 100 and 96
// A380 LEASES — 196 frames, ~$856M of deposits, an 8.8x expansion of a
// 19,027-seat airline, committing $71.3M/wk of rent against $199.4M/wk of
// revenue. Nothing in the game asked whether they could service it.
//
// Two rules answer that, and BOTH are load-bearing:
//   1. Lessors carry single-deck, previous-generation aircraft only. This is
//      deliberately not just a year test — `eis <= 2000` blocks the A380 (2007)
//      but leaves every other double-decker open, and they are all older and
//      CHEAPER (747-400: 71% of the seats for 30% of the rent; 747-300 cheaper
//      still). A year rule alone would have made the strategy ~6x cheaper
//      rather than stopping it. The `doubleDeck` flag covers the freighter 747s
//      too, because those sit in category 'Freighter' and a category test would
//      hand the same play straight to cargo.
//   2. The lease order book is capped at max(5, 25% of the operating fleet), so
//      growth happens in waves with deliveries and P&L in between.
//
// Everything is gated on state.newWorldRestrictions: classic worlds and
// Tailwinds solo must be byte-identical, which the last block asserts directly.
//
//   node tools/new-world-restrictions-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, leaseDenial, transferCompatibility } from '../packages/engine/src/reducer.mjs';
import {
  AIRCRAFT_TYPES, getAircraftType, lessorSupplies, leasableTypes,
  leaseOrderBookCap, LESSOR_ALLOW, LESSOR_BLOCK, LESSOR_EIS_CUTOFF,
  LEASE_ORDER_BOOK_MIN, LEASE_ORDER_BOOK_PCT,
} from '../packages/engine/src/data/aircraft.js';
import { HQ_DEPARTURE_FEE, HQ_BASE_WEEKLY, calcHQCost, HQ_SCALE_BY_CATEGORY } from '../packages/engine/src/data/overhead.js';
import { seniorityMultiplier, SENIORITY_CAP, SENIORITY_ANNUAL_RISE } from '../packages/engine/src/data/labor.js';
import {
  weeklyTick, simulateRoute, simulateCargoRoute, weeklyBlockHours, routeDistanceKm, maxFrequency,
  MAX_WEEKLY_BLOCK_HOURS, NWR_MAX_WEEKLY_BLOCK_HOURS, maxWeeklyBlockHoursFor,
} from '../packages/engine/src/utils/simulation.js';
import {
  referencePrice, cargoReferenceYield, setFareIndex, getFareIndex, NWR_FARE_INDEX,
  expectedCarried, weeklyLoadJitter, nwrDemandScale,
  NWR_LF_CEILING, NWR_LF_JITTER,
  setNwrYieldChoke, nwrYieldChokeFactor,
  NWR_CHOKE_THRESHOLD_BASE, NWR_CHOKE_THRESHOLD_MAX, NWR_CHOKE_STEEPNESS,
} from '../packages/engine/src/utils/market.js';
import { priceChokeFactor, PRICE_CAP_MULTIPLE,
         cargoPriceChokeFactor, CARGO_PRICE_CAP_MULTIPLE } from '../packages/engine/src/models/demand.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
function baseState(overrides = {}) {
  const s = gameReducer(undefined, {
    type: 'START_GAME', airlineName: 'Test Air', hub: 'JFK', enableObjectives: false,
  });
  return {
    ...s,
    // Never the binding constraint in these tests — they are about the LEASE
    // ORDER BOOK, not affordability. Sized well clear of 20 × the priciest
    // airframe so a catalogue reprice can't silently turn these into cash tests
    // (the A380 going $150M → $305M did exactly that, and this fixture started
    // clamping a 20-frame purchase to 17).
    cash: 50_000_000_000,
    newWorldRestrictions: true,
    fleet: [],
    pendingOrders: [],
    ...overrides,
  };
}
const fleetOf = (n, typeId = 'b737800') =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i}`, typeId, status: 'idle', ownershipType: 'owned', ageWeeks: 10,
  }));
const order = (state, typeId, quantity, ownershipType = 'lease') =>
  gameReducer(state, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType, leaseTermWeeks: 104 });
const orderCount = (s) => (s.pendingOrders ?? []).length;

// ── 1. Data integrity ────────────────────────────────────────────────────────
console.log('\nData integrity');

test('every aircraft type carries a plausible entry-into-service year', () => {
  const bad = AIRCRAFT_TYPES.filter(t => !Number.isInteger(t.eis) || t.eis < 1930 || t.eis > 2035);
  assert.deepEqual(bad.map(t => t.id), [], 'types with missing/implausible eis');
});

test('every id in LESSOR_ALLOW and LESSOR_BLOCK actually exists', () => {
  const ids = new Set(AIRCRAFT_TYPES.map(t => t.id));
  const ghosts = [...LESSOR_ALLOW, ...LESSOR_BLOCK].filter(id => !ids.has(id));
  assert.deepEqual(ghosts, [], 'override sets reference non-existent type ids');
});

test('the doubleDeck flag covers the whole 747 family, the A380 and the Stratocruiser', () => {
  const flagged = AIRCRAFT_TYPES.filter(t => t.doubleDeck).map(t => t.id).sort();
  // b377: the Boeing 377 Stratocruiser (era worlds phase 4) genuinely was a
  // double-decker — lower-deck lounge — and the flag correctly keeps it off
  // lessor books like every other two-deck airframe.
  const expected = ['a380', 'b377', 'b747100', 'b747200', 'b747300', 'b7478f', 'b7478i',
    'b747400', 'b747400d', 'b747400f', 'b747sp'].sort();
  assert.deepEqual(flagged, expected);
});

test('the freighter 747s are flagged despite sitting in category Freighter', () => {
  for (const id of ['b747400f', 'b7478f']) {
    const t = getAircraftType(id);
    assert.equal(t.category, 'Freighter', `${id} should still be categorised as a freighter`);
    assert.equal(t.doubleDeck, true, `${id} must carry the doubleDeck flag`);
  }
});

// ── 2. Eligibility ───────────────────────────────────────────────────────────
console.log('\nLessor stock');

test('current-generation aircraft are not on lessor books', () => {
  for (const id of ['b7878', 'b7879', 'b787x10', 'a350900', 'a3501000', 'b737max8',
    'b737max9', 'a320neo', 'a321neo', 'b777300er', 'a220', 'a220100',
    'e190e2', 'e195e2', 'b7779x', 'a330neo', 'c919']) {
    assert.equal(lessorSupplies(getAircraftType(id)), false, `${id} should NOT be leasable`);
  }
});

test('NO double-decker is leasable at any age — the 747 substitution is closed', () => {
  for (const id of ['a380', 'b7478i', 'b747400', 'b747400d', 'b747300', 'b747200',
    'b747100', 'b747sp']) {
    const t = getAircraftType(id);
    assert.equal(lessorSupplies(t), false,
      `${id} (eis ${t.eis}) must not be leasable — a pure year rule would allow it`);
  }
});

test('the freight version of the same substitution is closed too', () => {
  assert.equal(lessorSupplies(getAircraftType('b747400f')), false);
  assert.equal(lessorSupplies(getAircraftType('b7478f')), false);
});

test('previous-generation single-deck workhorses remain leasable', () => {
  for (const id of ['b737800', 'b737700', 'a320ceo', 'a319ceo', 'a321ceo', 'b757200',
    'b767300', 'b777200er', 'a330200', 'a330300', 'crj200', 'erj145',
    'md80', 'q400']) {
    assert.equal(lessorSupplies(getAircraftType(id)), true, `${id} should be leasable`);
  }
});

test('the curated allow list rescues the real regional lease market', () => {
  for (const id of ['e190', 'e175', 'erj170', 'crj700', 'crj900', 'crj1000', 'a318',
    'b737900er', 'atr72', 'atr42']) {
    const t = getAircraftType(id);
    assert.ok(t.eis > LESSOR_EIS_CUTOFF, `${id} should be a post-cutoff override case`);
    assert.equal(lessorSupplies(t), true, `${id} must be leasable via LESSOR_ALLOW`);
  }
});

test('unremarketable one-offs stay off lessor books despite passing the year rule', () => {
  for (const id of ['concorde', 'an124', 'an225']) {
    const t = getAircraftType(id);
    assert.ok(t.eis <= LESSOR_EIS_CUTOFF, `${id} should pass the year test`);
    assert.equal(lessorSupplies(t), false, `${id} must be blocked by LESSOR_BLOCK`);
  }
});

test('freighters face the full rule — modern freight is buy-only', () => {
  for (const id of ['b777f', 'b7778f', 'a350f', 'atr72f', 'a330200f', 'e190f', 'a321p2f']) {
    assert.equal(lessorSupplies(getAircraftType(id)), false, `${id} should NOT be leasable`);
  }
  for (const id of ['md11f', 'b767300f', 'b757200pf', 'b727200f']) {
    assert.equal(lessorSupplies(getAircraftType(id)), true, `${id} should be leasable`);
  }
});

test('a meaningful market survives — neither everything nor nothing is leasable', () => {
  const n = leasableTypes().length;
  assert.ok(n > 60 && n < AIRCRAFT_TYPES.length - 30,
    `${n} of ${AIRCRAFT_TYPES.length} leasable — expected a substantial but partial market`);
});

// ── 3. Order book maths ──────────────────────────────────────────────────────
console.log('\nOrder book');

test('the cap is max(5, 25% of fleet), crossing over at 20 aircraft', () => {
  assert.equal(leaseOrderBookCap(0), 5);
  assert.equal(leaseOrderBookCap(10), 5);
  assert.equal(leaseOrderBookCap(19), 5);
  assert.equal(leaseOrderBookCap(20), 5, '25% of 20 is exactly the floor');
  assert.equal(leaseOrderBookCap(24), 6);
  assert.equal(leaseOrderBookCap(43), 10, "Otter Air's fleet");
  assert.equal(leaseOrderBookCap(100), 25);
  assert.equal(LEASE_ORDER_BOOK_MIN, 5);
  assert.equal(LEASE_ORDER_BOOK_PCT, 0.25);
});

test('the cap never goes negative or NaN on junk input', () => {
  for (const v of [-5, NaN, undefined, null, 'x']) {
    assert.equal(leaseOrderBookCap(v), 5, `cap(${String(v)}) should fall back to the floor`);
  }
});

// ── 4. The reducer, against the real case ────────────────────────────────────
console.log('\nReducer — the Otter Air order');

test('196 A380 leases against a 43-aircraft fleet place ZERO orders', () => {
  const s = baseState({ fleet: fleetOf(43) });
  const r = order(s, 'a380', 196);
  assert.equal(orderCount(r), 0);
  assert.match(r.pendingToasts.at(-1).message, /double-deck/i);
});

test('the 747-400 substitution places zero orders too', () => {
  const s = baseState({ fleet: fleetOf(43) });
  assert.equal(orderCount(order(s, 'b747400', 196)), 0);
  assert.equal(orderCount(order(s, 'b747300', 196)), 0);
});

test('the 747-400F freight substitution places zero orders', () => {
  const s = baseState({ fleet: fleetOf(43) });
  assert.equal(orderCount(order(s, 'b747400f', 196)), 0);
});

test('an oversized order of a LEGAL type is clamped, not rejected', () => {
  const s = baseState({ fleet: fleetOf(43) });          // cap 10
  const r = order(s, 'b737800', 196);
  assert.equal(orderCount(r), 10, 'should place exactly the free slots');
  assert.match(r.pendingToasts.at(-1).message, /order-book/i);
});

test('a full order book blocks the next lease outright', () => {
  const s = baseState({ fleet: fleetOf(43) });
  const full = order(s, 'b737800', 196);               // fills 10/10
  const again = order(full, 'b737800', 5);
  assert.equal(orderCount(again), orderCount(full), 'no further orders placed');
  assert.match(again.pendingToasts.at(-1).message, /full/i);
});

test('a startup gets the floor of 5, not zero', () => {
  const s = baseState({ fleet: [] });
  assert.equal(orderCount(order(s, 'b737800', 50)), 5);
});

test('pending lease orders count against the cap; purchases do not', () => {
  const s = baseState({ fleet: fleetOf(43) });
  const bought = order(s, 'a380', 20, 'owned');        // purchases untouched
  assert.equal(orderCount(bought), 20, 'buying is capital-gated only');
  const thenLeased = order(bought, 'b737800', 196);
  assert.equal(orderCount(thenLeased) - 20, 10, 'lease book still has its full 10');
});

test('BUYING a double-decker is explicitly still allowed', () => {
  const s = baseState({ fleet: fleetOf(43) });
  assert.ok(orderCount(order(s, 'a380', 5, 'owned')) > 0);
});

test('the legacy LEASE_AIRCRAFT action is not a back door', () => {
  const s = baseState({ fleet: fleetOf(43) });
  const r = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'a380' });
  assert.equal(r.fleet.length, s.fleet.length, 'no aircraft should be added');
});

test('placed orders are never retro-cancelled when the fleet shrinks', () => {
  const s = baseState({ fleet: fleetOf(43) });
  const withOrders = order(s, 'b737800', 10);
  assert.equal(orderCount(withOrders), 10);
  // Fleet collapses to 4 — the cap would now be 5, below the 10 already placed.
  const shrunk = { ...withOrders, fleet: fleetOf(4) };
  assert.equal(orderCount(shrunk), 10, 'existing order book survives untouched');
  // ...and the tightened cap simply blocks anything new.
  assert.equal(orderCount(order(shrunk, 'b737800', 1)), 10);
});

// ── 5. leaseDenial shape (UI / server share this) ────────────────────────────
console.log('\nDenial contract');

test('leaseDenial returns null for everything when the flag is off', () => {
  const off = baseState({ fleet: fleetOf(43), newWorldRestrictions: false });
  for (const id of ['a380', 'b7878', 'b747400f', 'b737800']) {
    assert.equal(leaseDenial(off, id, 196), null, `${id} should be unrestricted`);
  }
});

test('a partial overflow reports how many WOULD fit, so callers can clamp', () => {
  const s = baseState({ fleet: fleetOf(43) });
  const d = leaseDenial(s, 'b737800', 196);
  assert.equal(d.code, 'order_book_partial');
  assert.equal(d.free, 10);
  assert.equal(d.cap, 10);
});

test('blocked types and full books are distinguishable by code', () => {
  const s = baseState({ fleet: fleetOf(43) });
  assert.equal(leaseDenial(s, 'a380', 1).code, 'not_stocked');
  const full = order(s, 'b737800', 10);
  assert.equal(leaseDenial(full, 'b737800', 1).code, 'order_book_full');
});

test('every denial carries a player-readable message', () => {
  const s = baseState({ fleet: fleetOf(43) });
  for (const [id, qty] of [['a380', 1], ['b747400f', 1], ['b737800', 196]]) {
    const d = leaseDenial(s, id, qty);
    assert.ok(d && typeof d.message === 'string' && d.message.length > 20,
      `${id} denial should explain itself`);
  }
});

// ── 6. The flag is genuinely opt-in ──────────────────────────────────────────
console.log('\nClassic worlds are untouched');

test('with the flag off, 196 A380 leases behave exactly as before', () => {
  const off = baseState({ fleet: fleetOf(43), newWorldRestrictions: false });
  const r = order(off, 'a380', 196);
  assert.equal(orderCount(r), 100, 'reducer clamps to its own 100/order limit only');
});

test('an identical action sequence is state-identical with the flag absent', () => {
  const mk = () => {
    const s = gameReducer(undefined, {
      type: 'START_GAME', airlineName: 'Test Air', hub: 'JFK', enableObjectives: false,
    });
    return { ...s, cash: 5_000_000_000, fleet: fleetOf(43), pendingOrders: [] };
  };
  const run = (s0) => {
    let s = s0;
    for (const [id, qty, own] of [['a380', 30, 'lease'], ['b737800', 12, 'lease'],
      ['b747400', 5, 'lease'], ['a320ceo', 3, 'owned']]) {
      s = gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: id, quantity: qty, ownershipType: own, leaseTermWeeks: 104 });
    }
    // Order ids and tail numbers are uid()-based; compare the shape that matters.
    return (s.pendingOrders ?? []).map(o => `${o.typeId}:${o.ownershipType}`).sort();
  };
  const undefinedFlag = run(mk());
  const explicitFalse = run({ ...mk(), newWorldRestrictions: false });
  assert.deepEqual(undefinedFlag, explicitFalse,
    'an absent flag and an explicit false must behave identically');
  assert.ok(undefinedFlag.some(x => x.startsWith('a380:lease')),
    'classic worlds must still allow A380 leases');
});

// ── 6b. Unaffordable orders explain themselves ───────────────────────────────
// REGRESSION: all three of these were silent `return state` / `break`. Combined
// with the client's optimistic apply, an order the player couldn't fund appeared
// and then vanished with no message — reported in Discord as the game eating
// orders and stealing deposits. The money was never taken; nothing said so.
console.log('\nUnaffordable orders');

const poorState = (cash) => baseState({ cash, newWorldRestrictions: false, fleet: [], pendingOrders: [], pendingToasts: [] });
const lastToast = (s) => (s.pendingToasts ?? []).slice(-1)[0];

test('a lease you cannot fund says how much the deposit is', () => {
  const s = poorState(364_000);                       // Kat's actual cash
  const r = order(s, 'b767300', 2);                   // deposit is $816k
  assert.equal(orderCount(r), 0);
  assert.equal(r.cash, s.cash, 'cash must not move when nothing is placed');
  assert.match(lastToast(r).message, /deposit.*816/i);
  assert.match(lastToast(r).message, /364/);
});

test('a purchase you cannot fund says the price', () => {
  const s = poorState(364_000);
  const r = order(s, 'b767300', 1, 'owned');
  assert.equal(orderCount(r), 0);
  assert.equal(r.cash, s.cash);
  assert.match(lastToast(r).title, /not enough cash/i);
});

test('a partial fill reports how many were funded', () => {
  const s = poorState(2_000_000);                     // funds 2 of 5 deposits
  const r = order(s, 'b767300', 5);
  assert.equal(orderCount(r), 2);
  assert.match(lastToast(r).message, /Ordered 2 of 5/);
});

test('an affordable order raises no spurious toast', () => {
  const s = poorState(50_000_000);
  const r = order(s, 'b767300', 2);
  assert.equal(orderCount(r), 2);
  assert.equal((r.pendingToasts ?? []).length, 0);
});

// ── 7. HQ overhead by departure and class ────────────────────────────────────
console.log('\nHQ overhead — per departure, by class');

function tickWith(typeId, freq, n, restricted) {
  const fleet = [], routes = [];
  for (let i = 0; i < n; i++) {
    fleet.push({ id: 'a' + i, typeId, status: 'idle', ownershipType: 'owned', ageWeeks: 20, config: {} });
    routes.push({ id: 'r' + i, aircraftId: 'a' + i, origin: 'JFK', destination: 'LAX', weeklyFrequency: freq, ticketPrice: 300 });
  }
  return weeklyTick({
    fleet, routes, cargoRoutes: [], gates: { JFK: 20, LAX: 20 }, hubs: {},
    ...(restricted ? { newWorldRestrictions: true } : {}),
  });
}

test('the fee table is ordered by aircraft size', () => {
  const order = ['Turboprop', 'Regional Jet', 'Narrow Body', 'Wide Body', 'Double Deck'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(HQ_DEPARTURE_FEE[order[i]] > HQ_DEPARTURE_FEE[order[i - 1]],
      `${order[i]} should cost more per departure than ${order[i - 1]}`);
  }
});

test('classic worlds keep the size curve and charge no departure fees', () => {
  // The curve is measured in narrowbody-equivalents since the HQ gauge scale
  // landed (tools/hq-gauge-scale-test.mjs) — ten A380s are 21 of them. What this
  // pins is that a classic world never reaches the per-departure table at all:
  // changing the frequency must not change the bill by a cent.
  const r = tickWith('a380', 3, 10, false);
  assert.equal(r.totalHQCost, calcHQCost(10 * HQ_SCALE_BY_CATEGORY['Double Deck']));
  assert.equal(tickWith('a380', 9, 10, false).totalHQCost, r.totalHQCost);
  // …and a fleet at the narrowbody ANCHOR is still the literal old fleet-count
  // curve. The 737-800 is 189 seats, three above the 186-seat anchor, and the
  // scale is a seat curve now — so this pins the A320ceo, which sits on it.
  assert.equal(tickWith('a320ceo', 3, 10, false).totalHQCost, calcHQCost(10));
});

test('restricted worlds charge base + per-departure fees', () => {
  const r = tickWith('a380', 3, 10, true);
  assert.equal(r.totalHQCost, HQ_BASE_WEEKLY + 10 * 3 * 2 * HQ_DEPARTURE_FEE['Double Deck']);
});

test('the fee stays a modest share of what a departure earns', () => {
  // REGRESSION: the first table ran at ~4% of revenue per departure and took a
  // real airline's G&A from 5.3% to 10.2% of revenue — ~$98k/wk — which was
  // enough to push a healthy operation negative. Halved. This pins the ceiling
  // so a future "small" bump can't quietly double corporate overhead again.
  const fare = (dist) => Math.round((80 + dist * 0.09) * 0.87);
  const cases = [
    ['Turboprop', 39, 450], ['Regional Jet', 92, 900], ['Narrow Body', 186, 2000],
    ['Wide Body', 420, 6500], ['Double Deck', 605, 7500],
  ];
  for (const [cls, seats, dist] of cases) {
    const revPerDeparture = seats * 0.85 * fare(dist);
    const share = HQ_DEPARTURE_FEE[cls] / revPerDeparture;
    assert.ok(share < 0.035,
      `${cls} fee is ${(share * 100).toFixed(1)}% of a departure's revenue — too heavy`);
  }
});

test('bigger aircraft cost proportionally more to administer', () => {
  const tp = tickWith('atr72',   6, 10, true);
  const nb = tickWith('b737800', 6, 10, true);
  const dd = tickWith('a380',    6, 10, true);
  assert.ok(tp.totalHQCost < nb.totalHQCost, 'turboprop < narrowbody');
  assert.ok(nb.totalHQCost < dd.totalHQCost, 'narrowbody < double deck');
});

test('an airline with no flying still carries a corporate base', () => {
  // Unchanged by the HQ gauge scale on purpose: the scaled base only applies to
  // a fleet it can read a gauge from, and a fleetless airline pays in full so a
  // dying one keeps dying. See HQ_BASE_MIN in overhead.js.
  const r = weeklyTick({ fleet: [], routes: [], cargoRoutes: [], gates: {}, hubs: {}, newWorldRestrictions: true });
  assert.equal(r.totalHQCost, HQ_BASE_WEEKLY);
});

test('grounded aircraft are not billed for departures they never fly', () => {
  // REGRESSION: the first cut of this charged every route on the books. The revenue
  // loop skips out-of-service aircraft, so charging them billed an airline for a
  // schedule it wasn't operating.
  const flying  = tickWith('b767300', 5, 4, true);
  const fleet = [], routes = [];
  for (let i = 0; i < 4; i++) {
    fleet.push({ id: 'a' + i, typeId: 'b767300', status: i < 2 ? 'grounded' : 'idle', ownershipType: 'owned', ageWeeks: 20, config: {} });
    routes.push({ id: 'r' + i, aircraftId: 'a' + i, origin: 'JFK', destination: 'LHR', weeklyFrequency: 5, ticketPrice: 600 });
  }
  const half = weeklyTick({ fleet, routes, cargoRoutes: [], gates: { JFK: 30, LHR: 30 }, hubs: {}, newWorldRestrictions: true });
  assert.equal(half.totalHQCost, HQ_BASE_WEEKLY + 2 * 5 * 2 * HQ_DEPARTURE_FEE['Wide Body']);
  assert.ok(half.totalHQCost < flying.totalHQCost, 'grounding aircraft must lower the HQ bill');
});

test('dormant seasonal routes are not billed either', () => {
  // REGRESSION: same bug, other half. A summer-only route charged ops overhead in January.
  const fleet = [], routes = [];
  for (let i = 0; i < 4; i++) {
    fleet.push({ id: 'a' + i, typeId: 'b767300', status: 'idle', ownershipType: 'owned', ageWeeks: 20, config: {} });
    routes.push({
      id: 'r' + i, aircraftId: 'a' + i, origin: 'JFK', destination: 'LHR',
      weeklyFrequency: 5, ticketPrice: 600,
      ...(i < 2 ? { season: { months: [6, 7, 8] } } : {}),
    });
  }
  const january = weeklyTick({ fleet, routes, cargoRoutes: [], gates: { JFK: 30, LHR: 30 }, hubs: {}, newWorldRestrictions: true, gameDate: { month: 1 } });
  assert.equal(january.totalHQCost, HQ_BASE_WEEKLY + 2 * 5 * 2 * HQ_DEPARTURE_FEE['Wide Body'],
    'only the two year-round routes should be billed in January');
});

test('freighters are priced on airframe body class, not as double-deckers', () => {
  // 747-400F carries doubleDeck for LEASING, but pays the wide-body HQ rate:
  // no cabin, no cabin overhead.
  const r = tickWith('b747400f', 4, 5, true);
  assert.equal(r.totalHQCost, HQ_BASE_WEEKLY + 5 * 4 * 2 * HQ_DEPARTURE_FEE['Wide Body']);
});

// ── 7b. Labour seniority ─────────────────────────────────────────────────────
// Real airlines' unit labour cost climbs with age — seniority steps, pensions,
// union scale — and it is the main reason a legacy carrier cannot hold a
// startup's margins. The engine had none of it: baseWeeklyPerAircraft x fleet,
// flat forever. Measured, labour ran 9.6% of revenue at maturity against a real
// 25-35%, and FELL as a share of revenue with scale.
console.log('\nLabour seniority');

const LABOR_BASE = {
  pilots: { payMultiplier: 1, morale: 80 }, cabinCrew: { payMultiplier: 1, morale: 80 },
  groundStaff: { payMultiplier: 1, morale: 80 }, maintenanceTeam: { payMultiplier: 1, morale: 80 },
};
function tickAged(years, restricted, extra = {}) {
  const fleet = [], routes = [];
  for (let i = 0; i < 10; i++) {
    fleet.push({ id: 'a' + i, typeId: 'b737800', status: 'idle', ownershipType: 'owned', ageWeeks: 20, config: {} });
    routes.push({ id: 'r' + i, aircraftId: 'a' + i, origin: 'JFK', destination: 'LAX', weeklyFrequency: 6, ticketPrice: 400 });
  }
  const absWeek = 900;
  return weeklyTick({
    fleet, routes, cargoRoutes: [], gates: { JFK: 20, LAX: 20 }, hubs: {}, labor: LABOR_BASE,
    absWeek, foundedAbsWeek: absWeek - years * 52,
    ...(restricted ? { newWorldRestrictions: true } : {}), ...extra,
  });
}

test('the wage scale rises 5% a year and caps', () => {
  assert.equal(SENIORITY_ANNUAL_RISE, 0.05);
  assert.equal(SENIORITY_CAP, 2.5);
  assert.equal(seniorityMultiplier(0), 1);
  assert.ok(Math.abs(seniorityMultiplier(52) - 1.05) < 0.001, 'one year = +5%');
  assert.ok(Math.abs(seniorityMultiplier(10 * 52) - Math.pow(1.05, 10)) < 0.001);
  assert.equal(seniorityMultiplier(20 * 52), SENIORITY_CAP, 'capped by year 20');
  assert.equal(seniorityMultiplier(100 * 52), SENIORITY_CAP, 'and stays capped');
});

test('the cap is load-bearing — uncapped 5% would be x125 over a 100-year world', () => {
  // referencePrice carries no matching fare inflation, so uncapped this is a
  // countdown rather than a difficulty curve.
  assert.ok(Math.pow(1.05, 100) > 100, 'sanity: uncapped really is absurd');
  assert.ok(seniorityMultiplier(100 * 52) <= SENIORITY_CAP);
});

test('junk ages fall back to the starting scale', () => {
  for (const v of [NaN, undefined, null, -500, 'x']) {
    assert.equal(seniorityMultiplier(v), 1, `seniorityMultiplier(${String(v)}) should be 1`);
  }
});

test('both the standing payroll AND the per-km crew cost inflate', () => {
  const young = tickAged(0, true);
  const old   = tickAged(20, true);
  const r = SENIORITY_CAP;
  assert.ok(Math.abs(old.totalLaborCosts / young.totalLaborCosts - r) < 0.01, 'payroll should scale');
  assert.ok(Math.abs(old.totalCrew / young.totalCrew - r) < 0.01, 'crew cost should scale too');
});

test('classic worlds are untouched however old the airline is', () => {
  const young = tickAged(0, false);
  const old   = tickAged(30, false);
  assert.equal(old.totalLaborCosts, young.totalLaborCosts);
  assert.equal(old.totalCrew, young.totalCrew);
});

test('it keys off AIRLINE age, not the world calendar', () => {
  // A player joining a year-17 world founded their airline that morning. Same
  // absWeek, different foundedAbsWeek — the newcomer pays starting wages.
  const veteran  = tickAged(20, true);
  const newcomer = tickAged(0, true);
  assert.ok(veteran.totalLaborCosts > newcomer.totalLaborCosts * 2, 'veteran pays far more');
  assert.equal(newcomer.totalLaborCosts, tickAged(0, false).totalLaborCosts,
    'a brand-new airline in a restricted world pays exactly classic rates');
});

test('an old save with no foundedAbsWeek is safe, not instantly senior', () => {
  const missing = tickAged(30, true, { foundedAbsWeek: undefined });
  assert.equal(missing.totalLaborCosts, tickAged(0, false).totalLaborCosts);
});

test('the pay slider still means "relative to market"', () => {
  // The scale moves; the multiplier keeps its meaning. Doubling pay doubles the
  // bill at any age, so the UI needs no rework.
  const paid = { ...LABOR_BASE, pilots: { payMultiplier: 2, morale: 80 } };
  const a = tickAged(10, true);
  const b = tickAged(10, true, { labor: paid });
  assert.ok(b.totalLaborCosts > a.totalLaborCosts, 'a richer slider still costs more');
});

// ── 8. World fare index ──────────────────────────────────────────────────────
console.log('\nFare index');

const TEST_INDEX = 0.90;   // an explicit trim; the shipped DEFAULT is 1.0

test('the fare trim is flat and world-wide, not per-airline', () => {
  // A fare index is a MARKET price: every airline on a route faces the same
  // reference. A maturity ramp (index varying with fleet size) was built and
  // scrapped for exactly this — two airlines on one route cannot see different
  // market prices. This asserts the shipped value is a plain world constant.
  assert.equal(NWR_FARE_INDEX, 0.95);
  assert.equal(typeof NWR_FARE_INDEX, 'number', 'must be a constant, not a function of anything');
});

test('an explicit index trims the whole ladder', () => {
  setFareIndex(1);
  const base = referencePrice('JFK', 'LAX');
  setFareIndex(TEST_INDEX);
  const cut = referencePrice('JFK', 'LAX');
  assert.ok(Math.abs((1 - cut / base) - (1 - TEST_INDEX)) < 0.01,
    `expected ~${((1 - TEST_INDEX) * 100).toFixed(0)}% lower, got ${((1 - cut / base) * 100).toFixed(1)}%`);
  setFareIndex(1);
});

test('cargo yields are cut too, so freight is not a loophole', () => {
  setFareIndex(1);
  const base = cargoReferenceYield('JFK', 'LAX');
  setFareIndex(TEST_INDEX);
  const cut = cargoReferenceYield('JFK', 'LAX');
  assert.ok(Math.abs((1 - cut / base) - (1 - TEST_INDEX)) < 0.02, 'cargo yield should fall by the same index');
  setFareIndex(1);
});

test('the index scales fares on every route length, not just one', () => {
  for (const [o, d] of [['JFK', 'BOS'], ['JFK', 'LAX'], ['JFK', 'LHR'], ['LHR', 'SIN']]) {
    setFareIndex(1);          const a = referencePrice(o, d);
    setFareIndex(TEST_INDEX);  const b = referencePrice(o, d);
    assert.ok(Math.abs((1 - b / a) - (1 - TEST_INDEX)) < 0.02, `${o}-${d} should fall by the index`);
  }
  setFareIndex(1);
});

test('a junk index falls back to 1 rather than corrupting every fare', () => {
  for (const bad of [0, -1, 99, NaN, undefined, 'x']) {
    setFareIndex(bad);
    assert.equal(getFareIndex(), 1, `setFareIndex(${String(bad)}) should reject`);
  }
});

test('the index is correct on the FIRST paint, before any action', () => {
  // REGRESSION: in multiplayer the server owns state and no reducer call happens
  // on load, so the whole fare ladder rendered UNRESTRICTED until the player's
  // first action — then snapped to the real index, which read as the reference
  // price "reverting" the moment you touched a fare. RemoteGameProvider now sets
  // it during render. This asserts the underlying contract that made that fix
  // possible: the index is readable and settable without dispatching anything.
  setFareIndex(1);
  assert.equal(getFareIndex(), 1, 'a cold module defaults to unrestricted');
  setFareIndex(TEST_INDEX);
  assert.equal(getFareIndex(), TEST_INDEX, 'adopting state must move it with no action');
  setFareIndex(1);
});

test('the reducer sets the index from state on every action', () => {
  setFareIndex(1);
  const s = baseState({ fareIndex: TEST_INDEX });
  gameReducer(s, { type: 'NO_SUCH_ACTION' });
  assert.equal(getFareIndex(), TEST_INDEX, 'reducer should adopt state.fareIndex');
  gameReducer({ ...s, fareIndex: 1 }, { type: 'NO_SUCH_ACTION' });
  assert.equal(getFareIndex(), 1, 'and restore it for a classic world');
});

test('demand is unchanged when reference and player price move together', () => {
  // The whole premise of "same demand, lower prices": elasticity is priced off
  // playerPrice / referencePrice, so scaling both leaves the ratio alone.
  setFareIndex(1);
  const full = referencePrice('JFK', 'LAX');
  setFareIndex(TEST_INDEX);
  const cut = referencePrice('JFK', 'LAX');
  const ratioBefore = full / full;
  const ratioAfter  = (full * TEST_INDEX) / cut;
  assert.ok(Math.abs(ratioBefore - ratioAfter) < 0.01,
    'a player who re-prices by the same 15% sits at an identical price ratio');
  setFareIndex(1);
});

// ── Load-factor realism: spill ceiling + weekly variance ─────────────────────
//
// The flat min(demand, capacity) fill let any oversubscribed route sit at a
// permanent 100.0% load factor — the single biggest term in mature revenue
// running ~3.8x reality. In restricted worlds, weeklyTick attaches a
// deterministic per-route-per-week jitter (route.nwrLoadJitter); its presence
// switches on E[min(Normal(D, cv·D), 0.95·C)] spill inside the simulators.
// Absent (classic worlds), every path below must be bit-identical to before.

console.log('\nLoad-factor realism (spill + weekly variance):');

const LF_ROUTE = {
  id: 'r-lf', origin: 'JFK', destination: 'LAX', hub: 'JFK',
  weeklyFrequency: 7, ticketPrice: 250, weeksOpen: 52,
};
const LF_AIRCRAFT = { id: 'ac-lf', typeId: 'b737800', ageWeeks: 52 };
const LF_CAP = 189 * 7; // all-economy 737-800 — one-way seats/week
const lfSim = (demand, jitter) => simulateRoute(
  { ...LF_ROUTE, ...(jitter != null ? { nwrLoadJitter: jitter } : {}) },
  LF_AIRCRAFT, { month: 6 }, null, 1.0,
  { leisurePax: demand * 0.8, businessPax: demand * 0.2 });

test('classic worlds still fill to exactly 100% — byte-identical when off', () => {
  const r = lfSim(LF_CAP * 3, null);           // no jitter attached = model off
  assert.equal(r.loadFactor, 1, 'oversubscribed classic route must still hit 1.0');
  assert.equal(nwrDemandScale(1000, 500, undefined), 1, 'scale is exactly 1 with no jitter');
  assert.equal(nwrDemandScale(1000, 500, null), 1, 'null jitter is also off');
});

test('an oversubscribed restricted route can no longer reach 100%', () => {
  const r = lfSim(LF_CAP * 3, 1);              // neutral jitter isolates the spill model
  assert.ok(r.loadFactor <= NWR_LF_CEILING + 1e-9,
    `LF ${r.loadFactor.toFixed(4)} must sit at or under the ${NWR_LF_CEILING} ceiling`);
  assert.ok(r.loadFactor >= 0.92,
    `deep oversubscription should asymptote NEAR the ceiling, got ${r.loadFactor.toFixed(4)}`);
});

test('the model only bites full aircraft — a 60% route loses under a point', () => {
  const demand = Math.round(LF_CAP * 0.6);
  const off = lfSim(demand, null);
  const on  = lfSim(demand, 1);
  assert.ok(off.loadFactor < 0.65, 'fixture sanity: this is a ~60% route');
  assert.ok(off.loadFactor - on.loadFactor < 0.01,
    `startup-shaped route moved ${((off.loadFactor - on.loadFactor) * 100).toFixed(2)}pts — must be < 1`);
});

test('spill math: expectedCarried is a soft min with the right asymptotes', () => {
  assert.ok(expectedCarried(100, 10_000) > 99.9, 'demand << cap: carried ~ demand');
  assert.ok(expectedCarried(10_000, 100) <= 100, 'demand >> cap: carried <= cap');
  assert.ok(expectedCarried(10_000, 100) > 99, 'and approaches it from below');
  // Raw helper, no ceiling (nwrDemandScale applies that): loss at parity is
  // σ·φ(0) = cv·D·0.3989 — exactly 10% of demand at cv = 0.25.
  const atParity = expectedCarried(1000, 1000);
  assert.ok(atParity > 880 && atParity < 920,
    `demand == cap should lose ~10% to peaking, got ${atParity.toFixed(0)}`);
  assert.equal(expectedCarried(0, 100), 0);
  assert.equal(expectedCarried(100, 0), 0);
});

test('weekly jitter is bounded, deterministic, and actually varies', () => {
  const seen = new Set();
  for (let w = 0; w < 52; w++) {
    const j = weeklyLoadJitter('r-lf', w);
    assert.ok(j >= 1 - NWR_LF_JITTER - 1e-12 && j <= 1 + NWR_LF_JITTER + 1e-12,
      `week ${w}: jitter ${j} outside ±${NWR_LF_JITTER}`);
    seen.add(j.toFixed(6));
  }
  assert.ok(seen.size > 40, `52 weeks should give ~52 distinct factors, got ${seen.size}`);
  assert.equal(weeklyLoadJitter('r-lf', 7), weeklyLoadJitter('r-lf', 7),
    'same route+week must replay to the same factor (server, client, golden master)');
  assert.notEqual(weeklyLoadJitter('r-lf', 7), weeklyLoadJitter('r-other', 7),
    'different routes in the same week should not move in lockstep');
});

test('a sold-out route breathes week to week instead of pinning', () => {
  const lfs = new Set();
  for (let w = 0; w < 8; w++) {
    const r = lfSim(LF_CAP * 3, weeklyLoadJitter('r-lf', w));
    assert.ok(r.loadFactor <= 1, 'jitter must never push past physical seats');
    lfs.add(r.loadFactor.toFixed(4));
  }
  assert.ok(lfs.size >= 6, `8 weeks of a full route should show distinct LFs, got ${lfs.size}`);
});

test('passengers stay whole people — no 4,276.271 pax/wk on the route table', () => {
  // REGRESSION: the demand scale is fractional, and the involuntary-upgrade
  // block does maxFillable − totalPax arithmetic on it, so an unrounded pool
  // leaked fractional passengers into classSummary and the UI.
  for (let w = 0; w < 6; w++) {
    const r = lfSim(LF_CAP * 1.2, weeklyLoadJitter('r-lf', w));
    assert.ok(Number.isInteger(r.passengers),
      `week ${w}: ${r.passengers} passengers is not a whole number`);
  }
});

test('revenue moves with the pax the model removes — no phantom fares', () => {
  const off = lfSim(LF_CAP * 3, null);
  const on  = lfSim(LF_CAP * 3, 1);
  const paxRatio = on.passengers / off.passengers;
  const revRatio = on.revenue / off.revenue;
  assert.ok(Math.abs(paxRatio - revRatio) < 0.02,
    `pax fell to ${(paxRatio * 100).toFixed(1)}% but revenue to ${(revRatio * 100).toFixed(1)}% — must move together`);
});

// ── 100h block-hour cap (grandfathered) ──────────────────────────────────────
//
// Restricted worlds schedule against 100h/wk instead of the classic 140h —
// 14.3h/day vs 20h/day, which no real airline sustains. Enforcement is
// action-time only (ADD_ROUTE / frequency INCREASES / transfers), so an
// aircraft already scheduled above the cap keeps flying everything it has:
// nothing is retro-cancelled, exactly like the lease order book. Its frequency
// changes become a one-way ratchet down, and transfers that don't grow the
// hours stay legal.

console.log('\n100h block-hour cap (grandfathered):');

const BH_TYPE = getAircraftType('b737800');
const BH_DIST = routeDistanceKm('JFK', 'LAX');
// Highest frequency inside the classic cap — comfortably above 100h on this
// sector, so the same action splits cleanly: classic accepts, restricted blocks.
const BH_FREQ = maxFrequency(BH_DIST, BH_TYPE);
const BH_HOURS = weeklyBlockHours(BH_DIST, BH_FREQ, BH_TYPE);

function bhState(overrides = {}) {
  return baseState({
    fleet: [{ id: 'bh1', typeId: 'b737800', status: 'idle', ageWeeks: 0 }],
    routes: [], cargoRoutes: [],
    gates: { JFK: 5, LAX: 5 },
    ...overrides,
  });
}
const bhAdd = (state, weeklyFrequency) => gameReducer(state, {
  type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'bh1',
  weeklyFrequency, ticketPrice: 300,
});

test('the cap itself: 100 restricted, 140 classic', () => {
  assert.equal(maxWeeklyBlockHoursFor({ newWorldRestrictions: true }), NWR_MAX_WEEKLY_BLOCK_HOURS);
  assert.equal(maxWeeklyBlockHoursFor({}), MAX_WEEKLY_BLOCK_HOURS);
  assert.equal(maxWeeklyBlockHoursFor(null), MAX_WEEKLY_BLOCK_HOURS);
  assert.ok(BH_HOURS > 100 && BH_HOURS <= 140,
    `fixture sanity: ${BH_HOURS.toFixed(1)}h must sit between the two caps`);
});

test('a schedule the classic cap accepts is blocked at 100h', () => {
  const classic = bhAdd(bhState({ newWorldRestrictions: false }), BH_FREQ);
  assert.equal(classic.routes.length, 1, 'classic world accepts the full 140h schedule');
  const nwr = bhAdd(bhState(), BH_FREQ);
  assert.equal(nwr.routes.length, 0, 'restricted world must block it');
});

test('the same aircraft still works a full week under 100h', () => {
  const okFreq = maxFrequency(BH_DIST, BH_TYPE, NWR_MAX_WEEKLY_BLOCK_HOURS);
  assert.ok(okFreq >= 7, `100h should still fit at least daily JFK-LAX, got ${okFreq}`);
  const nwr = bhAdd(bhState(), okFreq);
  assert.equal(nwr.routes.length, 1, 'a sub-cap schedule is accepted');
});

test('GRANDFATHER: an over-cap schedule keeps flying and can ratchet DOWN', () => {
  // Build the 140h-legal schedule in a classic world, then flip the flag on —
  // exactly what deploying this cap does to a live restricted world.
  const flying = bhAdd(bhState({ newWorldRestrictions: false }), BH_FREQ);
  const inherited = { ...flying, newWorldRestrictions: true };
  const routeId = inherited.routes[0].id;

  // The tick never audits it: reductions are always allowed, even while the
  // result is STILL over the cap (the ratchet has to be steppable)...
  const down = gameReducer(inherited, { type: 'UPDATE_FREQUENCY', routeId, weeklyFrequency: BH_FREQ - 1 });
  assert.equal(down.routes[0].weeklyFrequency, BH_FREQ - 1, 'stepping down must always work');
  assert.ok(weeklyBlockHours(BH_DIST, BH_FREQ - 1, BH_TYPE) > 100,
    'fixture sanity: still over the cap after the step — the ratchet, not a fix');

  // ...but it can never grow again.
  const up = gameReducer(down, { type: 'UPDATE_FREQUENCY', routeId, weeklyFrequency: BH_FREQ });
  assert.equal(up.routes[0].weeklyFrequency, BH_FREQ - 1, 'stepping back up must be blocked');
});

test('GRANDFATHER: transfers that do not grow the hours stay legal', () => {
  const flying = bhAdd(bhState({ newWorldRestrictions: false }), BH_FREQ);
  const inherited = {
    ...flying, newWorldRestrictions: true,
    fleet: [...flying.fleet, { id: 'bh2', typeId: 'b737800', status: 'idle', ageWeeks: 0 }],
  };
  const sameType = transferCompatibility(inherited, 'bh1', 'bh2');
  assert.equal(sameType.ok, true,
    `moving an over-cap schedule onto the same type keeps the same hours: ${sameType.reason ?? ''}`);
});

// ── Yield choke: monopoly pricing has a ceiling ──────────────────────────────
//
// Headwinds has no AI encroachment (competition is humans only), so on a
// lightly-populated world every route is a monopoly, and elasticity alone lets
// the fare equilibrium sit at 1.3-3x reference on big pools with the aircraft
// still full. In restricted worlds, pricing above a quality-scaled threshold
// (1.10x ref at quality<=50, 1.25x at quality 100) takes an extra
// exp(-15·overage) demand penalty. At or below the threshold: exactly nothing.

console.log('\nYield choke (monopoly pricing ceiling):');

test('classic worlds: priceChokeFactor is bit-identical with the flag off', () => {
  setNwrYieldChoke(false);
  for (const ratio of [0.8, 1.0, 1.1, 1.5, 2.0, 2.9]) {
    const t = (ratio - 1) / (PRICE_CAP_MULTIPLE - 1);
    const expect = ratio <= 1 ? 1 : Math.max(0, 1 - t * t);
    assert.equal(priceChokeFactor(ratio * 100, 100), expect,
      `ratio ${ratio}: classic curve must be untouched`);
  }
  assert.equal(nwrYieldChokeFactor(2.5, 50), 1, 'factor is exactly 1 when off');
});

test('at or below the threshold the choke does literally nothing', () => {
  setNwrYieldChoke(true);
  assert.equal(nwrYieldChokeFactor(1.0, 50), 1);
  assert.equal(nwrYieldChokeFactor(NWR_CHOKE_THRESHOLD_BASE, 50), 1);
  assert.equal(nwrYieldChokeFactor(NWR_CHOKE_THRESHOLD_MAX, 100), 1);
  setNwrYieldChoke(false);
});

test('above the threshold demand collapses fast', () => {
  setNwrYieldChoke(true);
  const at13 = nwrYieldChokeFactor(1.3, 50);   // 20 pts over → exp(-3)
  assert.ok(Math.abs(at13 - Math.exp(-NWR_CHOKE_STEEPNESS * 0.2)) < 1e-12);
  assert.ok(at13 < 0.06, `1.3x ref at quality 50 keeps ${(at13 * 100).toFixed(1)}% of demand — gouging must not pay`);
  setNwrYieldChoke(false);
});

test('quality buys pricing headroom', () => {
  setNwrYieldChoke(true);
  const budget  = nwrYieldChokeFactor(1.2, 50);   // 10 pts over its 1.10 threshold
  const premium = nwrYieldChokeFactor(1.2, 100);  // still under its 1.25 threshold
  assert.equal(premium, 1, 'a quality-100 product prices 1.2x ref freely');
  assert.ok(budget < 0.25, `a quality-50 product at 1.2x keeps ${(budget * 100).toFixed(0)}%`);
  setNwrYieldChoke(false);
});

test('end to end: the 1.5x-ref monopoly play stops filling aircraft', () => {
  const ref = referencePrice('JFK', 'LAX');
  const gouged = { ...LF_ROUTE, ticketPrice: Math.round(ref * 1.5) };
  const sim = (on) => {
    setNwrYieldChoke(on);
    const r = simulateRoute(gouged, LF_AIRCRAFT, { month: 6 }, null, 1.0);
    setNwrYieldChoke(false);
    return r;
  };
  const off = sim(false);
  const on  = sim(true);
  assert.ok(on.passengers < off.passengers * 0.25,
    `1.5x ref: ${off.passengers} pax classic -> ${on.passengers} choked — must collapse`);
  // and the SAME route priced at reference is untouched by the choke
  const fair = { ...LF_ROUTE, ticketPrice: ref };
  setNwrYieldChoke(true);
  const fairOn = simulateRoute(fair, LF_AIRCRAFT, { month: 6 }, null, 1.0);
  setNwrYieldChoke(false);
  const fairOff = simulateRoute(fair, LF_AIRCRAFT, { month: 6 }, null, 1.0);
  assert.equal(fairOn.passengers, fairOff.passengers, 'reference pricing feels nothing');
});

// ── The yield choke reaches FREIGHT too ─────────────────────────────────────
//
// It did not, for as long as both existed. simulateCargoRoute disciplined
// pricing with a bare power law that never reaches zero, so on a lane whose
// gravity pool ran 3-7x the freighter's payload, 2.5x the going rate was free
// money — the aeroplane stayed full and the inflated rate was banked on every
// tonne. A restricted world advertising a fare ceiling quietly had none on
// cargo. See docs/cargo-yield-choke-audit-2026-08-27.md.

test('cargo gets the same restricted-world choke passengers do', () => {
  const ref = cargoReferenceYield('SIN', 'DXB');
  setNwrYieldChoke(true);
  const on  = cargoPriceChokeFactor(ref * 1.5, ref);
  setNwrYieldChoke(false);
  const off = cargoPriceChokeFactor(ref * 1.5, ref);
  assert.ok(on < off, `restricted (${on}) must bite harder than classic (${off})`);
  assert.ok(on < 0.01, `1.5x reference freight keeps ${(on * 100).toFixed(2)}% of the pool — gouging must not pay`);
});

test('freight priced at reference feels the choke exactly as much as fares do: not at all', () => {
  const ref = cargoReferenceYield('SIN', 'DXB');
  setNwrYieldChoke(true);
  assert.equal(cargoPriceChokeFactor(ref, ref), 1, 'at reference');
  assert.equal(cargoPriceChokeFactor(ref * 0.7, ref), 1, 'below reference');
  setNwrYieldChoke(false);
});

test('cargo and passengers reach zero demand at the same multiple of reference', () => {
  // One story for both markets: nobody buys at three times the going rate.
  assert.equal(CARGO_PRICE_CAP_MULTIPLE, PRICE_CAP_MULTIPLE);
  const ref = cargoReferenceYield('SIN', 'DXB');
  assert.equal(cargoPriceChokeFactor(ref * CARGO_PRICE_CAP_MULTIPLE, ref), 0);
});

test('end to end: the 2.5x-ref freight play stops filling freighters', () => {
  const ref   = cargoReferenceYield('SIN', 'DXB');
  const tail  = { id: 'nwrf', typeId: 'md11f', status: 'assigned', ageWeeks: 52, ownershipType: 'owned' };
  const route = { id: 'nwrf', origin: 'SIN', destination: 'DXB', aircraftId: 'nwrf',
                  weeklyFrequency: 6, yieldPrice: ref * 2.5, weeksOpen: null };
  const sim = (on) => {
    setNwrYieldChoke(on);
    const r = simulateCargoRoute(route, tail, { month: 6 });
    setNwrYieldChoke(false);
    return r;
  };
  const off = sim(false), on = sim(true);
  assert.ok(on.tonnes < off.tonnes * 0.1,
    `2.5x ref: ${off.tonnes}t classic -> ${on.tonnes}t choked — must collapse`);
  // ...and the same freighter at the going rate is untouched.
  const fair = { ...route, yieldPrice: ref };
  setNwrYieldChoke(true);
  const fairOn = simulateCargoRoute(fair, tail, { month: 6 });
  setNwrYieldChoke(false);
  const fairOff = simulateCargoRoute(fair, tail, { month: 6 });
  assert.equal(fairOn.tonnes, fairOff.tonnes, 'reference freight rates feel nothing');
  assert.equal(fairOn.revenue, fairOff.revenue, 'and earn exactly the same');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
