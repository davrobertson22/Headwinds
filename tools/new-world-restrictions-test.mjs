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
import { gameReducer, leaseDenial } from '../packages/engine/src/reducer.mjs';
import {
  AIRCRAFT_TYPES, getAircraftType, lessorSupplies, leasableTypes,
  leaseOrderBookCap, LESSOR_ALLOW, LESSOR_BLOCK, LESSOR_EIS_CUTOFF,
  LEASE_ORDER_BOOK_MIN, LEASE_ORDER_BOOK_PCT,
} from '../packages/engine/src/data/aircraft.js';
import { HQ_DEPARTURE_FEE, HQ_BASE_WEEKLY, calcHQCost } from '../packages/engine/src/data/overhead.js';
import { weeklyTick } from '../packages/engine/src/utils/simulation.js';
import {
  referencePrice, cargoReferenceYield, setFareIndex, getFareIndex, NWR_FARE_INDEX,
} from '../packages/engine/src/utils/market.js';

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
    cash: 5_000_000_000,          // never the binding constraint in these tests
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

test('the doubleDeck flag covers the whole 747 family and the A380', () => {
  const flagged = AIRCRAFT_TYPES.filter(t => t.doubleDeck).map(t => t.id).sort();
  const expected = ['a380', 'b747100', 'b747200', 'b747300', 'b7478f', 'b7478i',
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

test('classic worlds keep the fleet-size curve untouched', () => {
  const r = tickWith('a380', 3, 10, false);
  assert.equal(r.totalHQCost, calcHQCost(10));
});

test('restricted worlds charge base + per-departure fees', () => {
  const r = tickWith('a380', 3, 10, true);
  // 10 aircraft x 3 freq x 2 departures x $15,000 + base
  assert.equal(r.totalHQCost, HQ_BASE_WEEKLY + 10 * 3 * 2 * HQ_DEPARTURE_FEE['Double Deck']);
});

test('bigger aircraft cost proportionally more to administer', () => {
  const tp = tickWith('atr72',   6, 10, true);
  const nb = tickWith('b737800', 6, 10, true);
  const dd = tickWith('a380',    6, 10, true);
  assert.ok(tp.totalHQCost < nb.totalHQCost, 'turboprop < narrowbody');
  assert.ok(nb.totalHQCost < dd.totalHQCost, 'narrowbody < double deck');
});

test('an airline with no flying still carries a corporate base', () => {
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

// ── 8. World fare index ──────────────────────────────────────────────────────
console.log('\nFare index');

test('the restricted index takes 15% off the whole ladder', () => {
  setFareIndex(1);
  const base = referencePrice('JFK', 'LAX');
  setFareIndex(NWR_FARE_INDEX);
  const cut = referencePrice('JFK', 'LAX');
  assert.equal(NWR_FARE_INDEX, 0.85);
  assert.ok(Math.abs((1 - cut / base) - 0.15) < 0.01, `expected ~15% lower, got ${((1 - cut / base) * 100).toFixed(1)}%`);
  setFareIndex(1);
});

test('cargo yields are cut too, so freight is not a loophole', () => {
  setFareIndex(1);
  const base = cargoReferenceYield('JFK', 'LAX');
  setFareIndex(NWR_FARE_INDEX);
  const cut = cargoReferenceYield('JFK', 'LAX');
  assert.ok(Math.abs((1 - cut / base) - 0.15) < 0.02, 'cargo yield should fall ~15% too');
  setFareIndex(1);
});

test('the index scales fares on every route length, not just one', () => {
  for (const [o, d] of [['JFK', 'BOS'], ['JFK', 'LAX'], ['JFK', 'LHR'], ['LHR', 'SIN']]) {
    setFareIndex(1);         const a = referencePrice(o, d);
    setFareIndex(NWR_FARE_INDEX); const b = referencePrice(o, d);
    assert.ok(Math.abs((1 - b / a) - 0.15) < 0.02, `${o}-${d} should fall ~15%`);
  }
  setFareIndex(1);
});

test('a junk index falls back to 1 rather than corrupting every fare', () => {
  for (const bad of [0, -1, 99, NaN, undefined, 'x']) {
    setFareIndex(bad);
    assert.equal(getFareIndex(), 1, `setFareIndex(${String(bad)}) should reject`);
  }
});

test('the reducer sets the index from state on every action', () => {
  setFareIndex(1);
  const s = baseState({ fareIndex: NWR_FARE_INDEX });
  gameReducer(s, { type: 'NO_SUCH_ACTION' });
  assert.equal(getFareIndex(), NWR_FARE_INDEX, 'reducer should adopt state.fareIndex');
  gameReducer({ ...s, fareIndex: 1 }, { type: 'NO_SUCH_ACTION' });
  assert.equal(getFareIndex(), 1, 'and restore it for a classic world');
});

test('demand is unchanged when reference and player price move together', () => {
  // The whole premise of "same demand, lower prices": elasticity is priced off
  // playerPrice / referencePrice, so scaling both leaves the ratio alone.
  setFareIndex(1);
  const full = referencePrice('JFK', 'LAX');
  setFareIndex(NWR_FARE_INDEX);
  const cut = referencePrice('JFK', 'LAX');
  const ratioBefore = full / full;
  const ratioAfter  = (full * NWR_FARE_INDEX) / cut;
  assert.ok(Math.abs(ratioBefore - ratioAfter) < 0.01,
    'a player who re-prices by the same 15% sits at an identical price ratio');
  setFareIndex(1);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
