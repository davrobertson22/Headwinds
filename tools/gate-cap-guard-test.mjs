// The ownership caps, enforced where the monopoly is actually created.
//
// Real case that motivated this: two airlines at GRR, one holding 15 of 25
// gates (exactly the 60% single-airline cap) and one holding 10. Both legal.
// They then formed an alliance — a transaction nothing checked — and became a
// 100% holder of the airport. The 80% combined cap was still enforced on every
// path that ACQUIRES a gate, so the pair kept all 25 and could never win
// another: their auction bids were accepted, held for twelve weeks, and voided
// at resolution without a word. Both halves of that are covered here.
//
//   node tools/gate-cap-guard-test.mjs

import assert from 'node:assert/strict';
import {
  gateAuctionEligibility, allianceGateCapBreaches, describeGateCapBreaches, placeBid,
} from '../apps/headwinds-server/src/lib/gateService.mjs';
import { gateAirlineCapOf, gateAllianceCapOf } from '../packages/engine/src/data/airports.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// GRR as it actually stood: full, and shared by exactly two airlines.
const GRR = {
  worldId: 'w1', airportCode: 'GRR', capacity: 25, taken: 25, baseSize: 25, version: 1,
  holdings: { austro: { count: 10 }, asteria: { count: 15 } },
};
const allied = new Map([
  ['austro', { membership: { allianceId: 'al1' } }],
  ['asteria', { membership: { allianceId: 'al1' } }],
]);
const solo = new Map();

console.log('\n── Eligibility is knowable before you bid ────────────────');

await test('an airline at exactly 60% cannot win another gate', () => {
  const e = gateAuctionEligibility(GRR, 'asteria', solo, 2);
  assert.equal(gateAirlineCapOf(26), 15, 'sanity: 60% of 26 is still 15');
  assert.equal(e.maxWinnable, 0);
  assert.equal(e.reason, 'OWNERSHIP_CAP');
  assert.match(e.detail, /15 of 25/);
});

await test('an alliance holding the whole airport cannot win either', () => {
  const e = gateAuctionEligibility(GRR, 'austro', allied, 2);
  assert.equal(gateAllianceCapOf(27), 21, 'sanity: even at 27 gates the cap is 21');
  assert.equal(e.maxWinnable, 0);
  assert.equal(e.reason, 'ALLIANCE_CAP');
  assert.match(e.detail, /alliance already holds 25 of 25/);
});

await test('the same airline unallied is perfectly eligible', () => {
  const e = gateAuctionEligibility(GRR, 'austro', solo, 2);
  assert.equal(e.maxWinnable, 2, '10 of 27 is well under 60%');
  assert.equal(e.reason, null);
});

await test('eligibility is clamped by the lots on offer, not just the caps', () => {
  const roomy = { capacity: 100, taken: 40, holdings: { austro: { count: 4 } } };
  assert.equal(gateAuctionEligibility(roomy, 'austro', solo, 1).maxWinnable, 1);
  assert.equal(gateAuctionEligibility(roomy, 'austro', solo, 9).maxWinnable, 3, 'GATE_BID_MAX_QTY');
});

console.log('\n── A bid that could never be awarded is refused now ──────');

function bidPrisma(row) {
  const written = [];
  return {
    _bids: written,
    gateAuction: {
      findFirst: async () => ({ id: 'auc1', worldId: 'w1', airportCode: 'GRR', status: 'OPEN', lots: 2, reserve: 195_000 }),
    },
    worldGate: { findUnique: async () => row },
    gateBid: { upsert: async ({ create }) => { written.push(create); } },
  };
}

await test('the allied bidder is turned away, with the cap named', async () => {
  const prisma = bidPrisma(GRR);
  await assert.rejects(
    () => placeBid(prisma, {
      world: { id: 'w1', currentYear: 3, currentWeek: 41 },
      airline: { id: 'austro', state: { cash: 9e9, gateLockouts: {} } },
      airportCode: 'GRR', amount: 5_000_000, quantity: 3, allianceMap: allied,
    }),
    /cannot win a gate at GRR.*alliance already holds 25 of 25/s,
  );
  assert.equal((prisma._bids ?? []).length, 0, 'nothing was written');
});

await test('the 60%-capped bidder is turned away too', async () => {
  const prisma = bidPrisma(GRR);
  await assert.rejects(
    () => placeBid(prisma, {
      world: { id: 'w1', currentYear: 3, currentWeek: 41 },
      airline: { id: 'asteria', state: { cash: 9e9, gateLockouts: {} } },
      airportCode: 'GRR', amount: 500_000, quantity: 2, allianceMap: solo,
    }),
    /cannot win a gate at GRR.*no airline may hold more than 60%/s,
  );
});

await test('an eligible bidder still gets through untouched', async () => {
  const prisma = bidPrisma(GRR);
  await placeBid(prisma, {
    world: { id: 'w1', currentYear: 3, currentWeek: 41 },
    airline: { id: 'austro', state: { cash: 9e9, gateLockouts: {} } },
    airportCode: 'GRR', amount: 500_000, quantity: 2, allianceMap: solo,
  });
  assert.equal(prisma._bids.length, 1);
  assert.equal(prisma._bids[0].quantity, 2);
});

console.log('\n── Allying is no longer a way around the cap ─────────────');

const world = { id: 'w1', tickConfig: { gateScarcity: true } };
const gatePrisma = (rows) => ({ worldGate: { findMany: async () => rows } });

await test('the alliance that created the monopoly is refused', async () => {
  const breaches = await allianceGateCapBreaches(gatePrisma([GRR]), {
    world, memberIds: ['austro', 'asteria'],
  });
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].airportCode, 'GRR');
  assert.equal(breaches[0].combined, 25);
  assert.equal(breaches[0].cap, 20);
  assert.match(describeGateCapBreaches(breaches), /GRR \(25 of 25 gates, cap 20\)/);
});

await test('an alliance comfortably under the cap is allowed', async () => {
  const breaches = await allianceGateCapBreaches(gatePrisma([{
    ...GRR, holdings: { austro: { count: 10 }, asteria: { count: 5 } },
  }]), { world, memberIds: ['austro', 'asteria'] });
  assert.deepEqual(breaches, []);
});

await test('exactly at the cap is allowed — only over it is refused', async () => {
  const at = await allianceGateCapBreaches(gatePrisma([{
    ...GRR, holdings: { austro: { count: 10 }, asteria: { count: 10 } },
  }]), { world, memberIds: ['austro', 'asteria'] });
  assert.deepEqual(at, [], '20 of 25 is exactly 80%');
  const over = await allianceGateCapBreaches(gatePrisma([{
    ...GRR, holdings: { austro: { count: 11 }, asteria: { count: 10 } },
  }]), { world, memberIds: ['austro', 'asteria'] });
  assert.equal(over.length, 1);
});

await test('non-members are not counted toward the alliance total', async () => {
  const breaches = await allianceGateCapBreaches(gatePrisma([GRR]), {
    world, memberIds: ['austro', 'someone-else'],
  });
  assert.deepEqual(breaches, [], "asteria's 15 gates are not this alliance's problem");
});

await test('worlds without gate scarcity are untouched', async () => {
  const breaches = await allianceGateCapBreaches(gatePrisma([GRR]), {
    world: { id: 'w1', tickConfig: {} }, memberIds: ['austro', 'asteria'],
  });
  assert.deepEqual(breaches, []);
});

await test('the worst breach is reported first', async () => {
  const breaches = await allianceGateCapBreaches(gatePrisma([
    { ...GRR, airportCode: 'MILD', holdings: { austro: { count: 21 } }, capacity: 25 },
    { ...GRR, airportCode: 'BAD', holdings: { austro: { count: 25 } }, capacity: 25 },
  ]), { world, memberIds: ['austro', 'asteria'] });
  assert.deepEqual(breaches.map((b) => b.airportCode), ['BAD', 'MILD']);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
