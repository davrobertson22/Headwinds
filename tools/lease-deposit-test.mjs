// Lease security deposits — money you put down must be money you get back.
//
// The bug this locks out: ordering a lease charges a 12-week security deposit
// up front (reducer ORDER_AIRCRAFT, LEASE_DEPOSIT_WEEKS), and NOTHING ever gave
// it back.
//
//   * CANCEL_ORDER refunded 0 for a lease, while the Fleet and Marketplace
//     screens both told the player "Lease orders are free to cancel before
//     delivery" and the button read "Cancel Order (free)". Ordering and then
//     cancelling a lease silently destroyed twelve weeks of rent.
//   * When the lease ran to term the aircraft was returned, a redelivery fee
//     was charged, and the deposit stayed with the lessor.
//   * Returning early (RETIRE_AIRCRAFT) charged the termination penalty and,
//     again, kept the deposit.
//
// The contract these tests describe: a security deposit is refundable. It is
// returned in full when the order is cancelled, and returned in full when the
// aircraft leaves the fleet. Charges levied at that moment — the redelivery
// fee, the early-termination penalty — are still charged, separately and
// unchanged; the deposit is not a fee and never was.
//
//   node tools/lease-deposit-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES, LEASE_DEPOSIT_WEEKS } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

// uid() is time-seeded. Two reducer calls that mint ids inside the same
// millisecond produce COLLIDING ids, and a colliding order id makes the
// cancel-by-id lookup pick the wrong record — a fixture that quietly tests
// nothing. Burn a millisecond between any two id-minting calls.
function tick() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

const TYPE = AIRCRAFT_TYPES.find(t => t.id === 'b737400' && !t.freighter)
          ?? AIRCRAFT_TYPES.find(t => !t.freighter);
const base = () => ({ ...freshState(), cash: 500_000_000, hub: 'JFK' });

const orderLease = (st, quantity = 1) =>
  gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId: TYPE.id, quantity, ownershipType: 'lease' });

console.log('\nLease security deposits\n');

// ── 1. The charge ────────────────────────────────────────────────────────────
section('1. Ordering a lease takes a deposit');

const ordered = orderLease(base());
const theOrder = (ordered.pendingOrders ?? []).at(-1);

test('a lease order is created and carries a deposit', () => {
  assert.ok(theOrder, 'ORDER_AIRCRAFT produced no pending order — the fixture proves nothing');
  assert.equal(theOrder.ownershipType, 'lease');
  assert.ok((theOrder.leaseDeposit ?? 0) > 0,
    'the order carries no deposit — the rest of this suite would be vacuous');
});

test('the deposit is twelve weeks of the rate this order signed at', () => {
  assert.equal(theOrder.leaseDeposit, theOrder.weeklyLease * LEASE_DEPOSIT_WEEKS);
});

test('the deposit actually leaves the bank account', () => {
  assert.equal(base().cash - ordered.cash, theOrder.leaseDeposit,
    'cash did not fall by exactly the deposit');
});

// ── 2. Cancelling ────────────────────────────────────────────────────────────
section('2. Cancelling before delivery returns it in full');

test('cancelling a lease order refunds the whole deposit', () => {
  const cancelled = gameReducer(ordered, { type: 'CANCEL_ORDER', orderId: theOrder.id });
  assert.equal(cancelled.pendingOrders.length, 0, 'the order was not removed');
  assert.equal(cancelled.cash, base().cash,
    `cancelling cost the player ${base().cash - cancelled.cash} — the UI says lease orders are free to cancel`);
});

test('a multi-unit lease order refunds each unit it cancels', () => {
  const st = orderLease(base(), 3);
  const orders = st.pendingOrders ?? [];
  assert.equal(orders.length, 3, 'fixture did not place three orders');
  let cur = st;
  for (const o of orders) cur = gameReducer(cur, { type: 'CANCEL_ORDER', orderId: o.id });
  assert.equal(cur.cash, base().cash, 'cancelling all three did not restore the balance');
});

test('an OWNED order still refunds at 95% — the cancellation fee is unchanged', () => {
  const st = gameReducer(base(), { type: 'ORDER_AIRCRAFT', typeId: TYPE.id, quantity: 1, ownershipType: 'owned' });
  const o  = (st.pendingOrders ?? []).at(-1);
  assert.ok(o, 'no owned order was placed');
  const after = gameReducer(st, { type: 'CANCEL_ORDER', orderId: o.id });
  assert.equal(after.cash, st.cash + Math.round(o.totalPrice * 0.95),
    'the owned-order refund changed — this fix must not touch it');
});

// ── 3. The delivered tail ────────────────────────────────────────────────────
section('3. The delivered aircraft remembers the deposit');

test('a delivered lease carries its leaseDeposit onto the tail', () => {
  // Deliver by hand through the same shape the tick uses, so this asserts the
  // reducer's delivery branch rather than a re-implementation of it.
  const st = orderLease(base());
  const o  = (st.pendingOrders ?? []).at(-1);
  let cur  = { ...st, pendingOrders: [{ ...o, deliverAbsWeek: 0 }] };
  for (let i = 0; i < 3 && (cur.pendingOrders ?? []).length; i++) { tick(); cur = gameReducer(cur, { type: 'ADVANCE_WEEK' }); }
  const tail = (cur.fleet ?? []).find(a => a.ownershipType === 'lease' && a.name === o.name);
  assert.ok(tail, 'the ordered lease never arrived in the fleet');
  assert.equal(tail.leaseDeposit, o.leaseDeposit,
    'the tail has no record of the deposit — nothing downstream can give it back');
});

// ── 4. Giving the aircraft back ──────────────────────────────────────────────
section('4. Returning the aircraft returns the deposit');

function leasedTail(extra = {}) {
  // Build a state holding one in-service leased tail with a known deposit.
  const st = { ...base(), fleet: [], routes: [], cargoRoutes: [] };
  const weekly = Math.round(TYPE.weeklyLease ?? 0);
  return {
    ...st,
    fleet: [{
      id: 'tail-under-test',
      typeId: TYPE.id,
      name: 'Deposit Test',
      tailNumber: 'N1DEP',
      status: 'idle',
      ageWeeks: 0,
      ownershipType: 'lease',
      weeklyLease: weekly,
      leaseDeposit: weekly * LEASE_DEPOSIT_WEEKS,
      leaseTermWeeks: 104,
      leaseRemainingWeeks: 104,
      ...extra,
    }],
  };
}

test('returning early refunds the deposit alongside the termination penalty', () => {
  const st = leasedTail({ leaseRemainingWeeks: 40 });
  const tail = st.fleet[0];
  const penalty = Math.round(tail.weeklyLease * 40 * 0.5);
  const after = gameReducer(st, { type: 'RETIRE_AIRCRAFT', aircraftId: tail.id });
  assert.equal(after.fleet.length, 0, 'the aircraft was not returned');
  assert.equal(after.cash, st.cash - penalty + tail.leaseDeposit,
    `expected the penalty charged and the deposit returned; cash moved by ${after.cash - st.cash}`);
});

test('an early return still costs the player money on balance', () => {
  // Guard against "fixing" this by making early termination free. With 40 weeks
  // left the penalty (20 weeks of rent) exceeds the deposit (12), so the net
  // must still be a charge.
  const st = leasedTail({ leaseRemainingWeeks: 40 });
  const after = gameReducer(st, { type: 'RETIRE_AIRCRAFT', aircraftId: st.fleet[0].id });
  assert.ok(after.cash < st.cash,
    'returning a lease 40 weeks early came out cash-positive — the penalty has been neutered');
});

test('retiring an OWNED aircraft is unaffected', () => {
  const st = leasedTail();
  st.fleet[0] = { ...st.fleet[0], ownershipType: 'owned', weeklyLease: 0, leaseDeposit: 0,
                  leaseTermWeeks: undefined, leaseRemainingWeeks: undefined };
  const after = gameReducer(st, { type: 'RETIRE_AIRCRAFT', aircraftId: st.fleet[0].id });
  assert.equal(after.cash, st.cash, 'retiring an owned aircraft moved cash');
});

test('a lease that runs to term returns the deposit when the tail goes back', () => {
  const st = leasedTail({ leaseRemainingWeeks: 1 });
  const tail = st.fleet[0];
  const before = st.cash;
  const after = gameReducer(st, { type: 'ADVANCE_WEEK' });
  assert.equal((after.fleet ?? []).length, 0, 'the expired lease was not returned');
  const moved = after.cash - before;
  // The week also books route P&L, but this airline flies nothing, so the only
  // large movements are the redelivery fee and the deposit.
  const redelivery = tail.weeklyLease * 4;
  assert.ok(moved > -redelivery,
    `cash moved ${moved}; a returned deposit of ${tail.leaseDeposit} should have offset the ${redelivery} redelivery fee and then some`);
});

test('the returned deposit is reported, and is not taxed', () => {
  // The report is what the P&L card and the cost bridge read. A deposit that
  // moves cash without a row of its own shows up as an unexplained residual.
  const st = leasedTail({ leaseRemainingWeeks: 1 });
  const tail = st.fleet[0];
  const after = gameReducer(st, { type: 'ADVANCE_WEEK' });
  const rep = after.lastReport ?? {};
  assert.equal(rep.leaseDepositReturned, tail.leaseDeposit,
    'the week the tail went back, the report did not name the deposit it handed over');
  // A return of capital is not income. This airline flies nothing, so any tax at
  // all would have to have come from counting the deposit as profit.
  assert.equal(rep.corporateTax ?? 0, 0,
    'the returned deposit was taxed — it is a return of capital, not income');
});

// ── 5. The instant-lease path ────────────────────────────────────────────────
section('5. LEASE_AIRCRAFT takes no deposit, so it returns none');

test('an instantly-leased tail carries a zero deposit, not an absent one', () => {
  tick();
  const st = gameReducer(base(), { type: 'LEASE_AIRCRAFT', typeId: TYPE.id });
  const tail = (st.fleet ?? []).at(-1);
  assert.ok(tail, 'LEASE_AIRCRAFT added nothing');
  assert.equal(tail.leaseDeposit ?? 0, 0,
    'the instant-lease path charges no deposit, so the tail must not claim one — it would refund money never paid');
});

test('returning an instantly-leased tail refunds nothing', () => {
  tick();
  const st = gameReducer(base(), { type: 'LEASE_AIRCRAFT', typeId: TYPE.id });
  const tail = (st.fleet ?? []).at(-1);
  const after = gameReducer(st, { type: 'RETIRE_AIRCRAFT', aircraftId: tail.id });
  const penalty = Math.round((tail.weeklyLease ?? 0) * (tail.leaseRemainingWeeks ?? 0) * 0.5);
  assert.equal(after.cash, st.cash - penalty,
    'a tail that never paid a deposit was refunded one');
});

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
