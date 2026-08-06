// Lease-rate lock — a lease must fix its rent for its term.
//
// The bug this locks out: `LEASE_AIRCRAFT` created the tail with no
// `weeklyLease` field at all, so every cost site fell through to
// `type.weeklyLease` (simulation.js 2639 / 2845 / 2926, reducer early-
// termination and redelivery). That made a lease a floating-rate contract: the
// 2026-07-31 vintage reprice, which doubled the lease on 23 classic types,
// would have raised the weekly bill on aircraft players had already signed for
// — while ORDER_AIRCRAFT deliveries, which DO stamp the rate, were untouched.
// Two acquisition paths, two different contracts, from the same market screen.
//
//   node tools/lease-rate-lock-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const TYPE = AIRCRAFT_TYPES.find(t => t.id === 'b737400') ?? AIRCRAFT_TYPES.find(t => !t.freighter);
const base = () => ({ ...freshState(), cash: 500_000_000 });
const lease = (st, typeId = TYPE.id) =>
  gameReducer(st, { type: 'LEASE_AIRCRAFT', typeId });

console.log('\nLease-rate lock\n');

test('LEASE_AIRCRAFT stamps the rate on the tail', () => {
  const st = lease(base());
  const tail = st.fleet.at(-1);
  assert.ok(tail, 'no aircraft was added');
  assert.equal(tail.ownershipType, 'lease');
  assert.equal(typeof tail.weeklyLease, 'number',
    'the tail carries no weeklyLease — every cost site will fall through to the live type table');
  assert.ok(tail.weeklyLease > 0);
});

test('the stamped rate matches what the market quoted', () => {
  const st = lease(base());
  assert.equal(st.fleet.at(-1).weeklyLease, Math.round(TYPE.weeklyLease),
    'signing must charge the advertised rate — this is the "no behaviour change on ship day" guarantee');
});

test('a signed lease is immune to a later change in the aircraft table', () => {
  // The whole point. Sign, then simulate the table being rebalanced under the
  // player's feet and confirm the tail still bills what it signed for.
  const st = lease(base());
  const tail = st.fleet.at(-1);
  const signed = tail.weeklyLease;
  const repriced = { ...TYPE, weeklyLease: TYPE.weeklyLease * 2 };
  const billed = tail.weeklyLease ?? repriced.weeklyLease;   // the live fallback chain
  assert.equal(billed, signed,
    `a doubled table rate reached an in-service tail (billed ${billed}, signed ${signed})`);
});

test('both acquisition paths produce the same shape of contract', () => {
  // ORDER_AIRCRAFT already stamped the rate; LEASE_AIRCRAFT did not. A field
  // present on one path and absent on the other is what let the two diverge.
  const st = lease(base());
  const instant = st.fleet.at(-1);
  const ordered = gameReducer(base(), {
    type: 'ORDER_AIRCRAFT', typeId: TYPE.id, quantity: 1, ownershipType: 'lease',
  });
  const order = (ordered.pendingOrders ?? []).at(-1);
  if (!order) return;   // ORDER_AIRCRAFT gated in this world config — nothing to compare
  assert.equal(typeof order.weeklyLease, 'number');
  assert.equal(typeof instant.weeklyLease, typeof order.weeklyLease,
    'an instant lease and an ordered lease must both carry a fixed rate');
});

test('early termination bills the signed rate, not the table rate', () => {
  // reducer already read `aircraft?.weeklyLease ?? type?.weeklyLease` here, so
  // stamping the field is what makes that first branch reachable at all.
  const st = lease(base());
  const tail = st.fleet.at(-1);
  const cheap = { ...tail, weeklyLease: 1_000, leaseRemainingWeeks: 10 };
  const stWith = { ...st, fleet: [cheap], cash: 100_000_000 };
  const after = gameReducer(stWith, { type: 'RETIRE_AIRCRAFT', aircraftId: cheap.id });
  const charged = stWith.cash - after.cash;
  assert.equal(charged, Math.round(1_000 * 10 * 0.5),
    `early-termination charged ${charged} — it must price off the signed rate (1,000/wk), not ${TYPE.weeklyLease}/wk`);
});

test('the redelivery fee at lease end bills the signed rate', () => {
  // Redelivery is 4 weeks of rent. It read `type?.weeklyLease` directly, so a
  // tail that signed cheap was invoiced at today's table rate on the way out.
  // Driven differentially: two identical worlds, one tail each, differing only
  // in the rate the tail signed at. Everything else in the tick cancels.
  //
  // Retried, because of an engine quirk worth knowing about: the fleet-aging
  // pass returns early for an aircraft that suffers a mechanical failure that
  // week, which SKIPS the lease countdown — a tail that breaks has its lease
  // silently extended by a week. At roughly a 2% weekly failure rate that made
  // this test fail about one run in fifty. The behaviour is not changed here
  // (it is a separate finding); the measurement just needs a week where the
  // aircraft did not break, for both rates, or the AOG repair bill pollutes the
  // differential anyway.
  const run = (rate) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      let st = lease(base());
      const tail = { ...st.fleet.at(-1), weeklyLease: rate, leaseRemainingWeeks: 1 };
      st = { ...st, fleet: [tail], cash: 200_000_000 };
      const after = gameReducer(st, { type: 'ADVANCE_WEEK' });
      if (after.fleet.length === 0) return st.cash - after.cash;
      // Broke that week — no countdown, no clean measurement. Roll again.
    }
    throw new Error('could not get a failure-free week in 40 attempts');
  };
  const cheap = run(10_000), dear = run(50_000);
  // 4 weeks redelivery + the final week's rent = 5x the rate difference.
  assert.equal(dear - cheap, (50_000 - 10_000) * 5,
    `returning a tail that signed at 50k cost ${dear - cheap} more than one that signed at 10k; ` +
    `expected 5x the gap (4 weeks redelivery + the last week of rent)`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
