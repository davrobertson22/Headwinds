// Gate auction resolution — every bid must end with a recorded outcome.
//
// The bug this guards: a sealed auction resolved, nobody won, no gates were
// added, and the game said NOTHING. `results` only ever held winners, the
// auction dropped out of the open-auction view the moment it flipped to
// RESOLVED, and losing bidders got no notice at all — so "my bid was voided by
// the cash check" and "the auction never ran" looked identical from inside the
// game. Resolution now writes an outcome per bid and toasts every loser.
//
//   node tools/gate-auction-resolve-test.mjs

import assert from 'node:assert/strict';
import { resolveDueAuctions } from '../apps/headwinds-server/src/lib/gateService.mjs';
import { gateAirlineCapOf } from '../packages/engine/src/data/airports.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const WORLD = {
  id: 'w1', name: 'Test World', currentYear: 3, currentWeek: 1,
  worldSeed: 'seed', tickConfig: { gateScarcity: true },
};

// ── In-memory fake Prisma covering exactly what resolveDueAuctions touches ───
function fakePrisma({ bids, airlines, row, lots = 2, reserve = 195_000, failFirstWrite = false }) {
  const auction = {
    id: 'auc1', worldId: 'w1', airportCode: 'GRR', status: 'OPEN', year: 3,
    lots, reserve, opensWeek: 92, resolvesWeek: 104, bids: bids.map((b) => ({ auctionId: 'auc1', ...b })),
  };
  const gate = { worldId: 'w1', airportCode: 'GRR', version: 1, baseSize: 25, ...row };
  const db = { auction, gate, airlines: structuredClone(airlines), saved: null, writes: 0 };
  let failed = !failFirstWrite;
  return {
    db,
    gateAuction: {
      findMany: async () => [structuredClone(auction)],
      update: async ({ data }) => { db.saved = data; },
    },
    airline: {
      findUnique: async ({ where }) => structuredClone(db.airlines[where.id] ?? null),
      updateMany: async ({ where, data }) => {
        const a = db.airlines[where.id];
        if (!a) return { count: 0 };
        // One simulated lost CAS race, to prove the retry rescues a good bid.
        if (!failed) { failed = true; a.version += 1; return { count: 0 }; }
        if (a.version !== where.version) return { count: 0 };
        a.state = data.state;
        a.version += 1;
        db.writes++;
        return { count: 1 };
      },
    },
    worldGate: {
      findUnique: async () => structuredClone(db.gate),
      updateMany: async ({ where, data }) => {
        if (db.gate.version !== where.version) return { count: 0 };
        Object.assign(db.gate, data, { version: db.gate.version + 1 });
        return { count: 1 };
      },
    },
    allianceMember: { findMany: async () => [] },
    alliance: { findMany: async () => [] },
  };
}

const airline = (id, name, cash, gatesHere, extra = {}) => ({
  id, name, worldId: 'w1', status: 'ACTIVE', version: 5, hub: 'GRR',
  state: { cash, gates: { GRR: gatesHere }, gateLockouts: {}, pendingToasts: [], ...extra },
});
const quiet = { info: () => {}, error: () => {} };
const outcomeFor = (prisma, id) => (prisma.db.saved.outcomes ?? []).find((o) => o.airlineId === id);
const toastsFor = (prisma, id) => prisma.db.airlines[id].state.pendingToasts ?? [];

console.log('\n── Every sealed bid ends with a recorded outcome ─────────');

await test('the winner is awarded, and the ledger grows with the award', async () => {
  const prisma = fakePrisma({
    bids: [{ airlineId: 'a1', amount: 500_000, quantity: 2 }],
    airlines: { a1: airline('a1', 'Austro', 40_000_000, 10) },
    row: { capacity: 25, taken: 25, holdings: { a1: { count: 10 }, a2: { count: 15 } } },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.equal(prisma.db.saved.status, 'RESOLVED');
  assert.equal(prisma.db.saved.results.length, 1);
  assert.equal(prisma.db.saved.results[0].gates, 2);
  assert.equal(prisma.db.gate.capacity, 27, 'won gates grow the airport');
  assert.equal(prisma.db.gate.taken, 27);
  assert.equal(outcomeFor(prisma, 'a1').reason, 'WON');
});

await test('an auction with no bids records nothing sold rather than nothing at all', async () => {
  const prisma = fakePrisma({
    bids: [],
    airlines: {},
    row: { capacity: 25, taken: 25, holdings: {} },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.deepEqual(prisma.db.saved.results, []);
  assert.deepEqual(prisma.db.saved.outcomes, []);
  assert.equal(prisma.db.gate.capacity, 25, 'nothing sold, nothing added');
});

await test('a bid voided by the cash check says so, and the bidder is told', async () => {
  const prisma = fakePrisma({
    bids: [{ airlineId: 'a1', amount: 5_000_000, quantity: 2 }],
    airlines: { a1: airline('a1', 'Austro', 1_000_000, 10) },
    row: { capacity: 25, taken: 25, holdings: { a1: { count: 10 } } },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  const o = outcomeFor(prisma, 'a1');
  assert.equal(o.reason, 'INSUFFICIENT_CASH');
  assert.match(o.detail, /\$10,000,000/, 'the detail names what it would have cost');
  assert.deepEqual(prisma.db.saved.results, []);
  assert.equal(prisma.db.gate.capacity, 25, 'a voided win adds no gates');
  const toast = toastsFor(prisma, 'a1').at(-1);
  assert.match(toast.title, /Auction lost/);
  assert.match(toast.message, /not escrowed/);
});

await test('the ownership cap voids a bid with the cap in the message', async () => {
  // 15 of 25 is already 60%; one more gate can never be legal here.
  const prisma = fakePrisma({
    bids: [{ airlineId: 'a2', amount: 500_000, quantity: 2 }],
    airlines: { a2: airline('a2', 'Asteria Air', 90_000_000, 15) },
    row: { capacity: 25, taken: 25, holdings: { a2: { count: 15 } } },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.equal(gateAirlineCapOf(26), 15, 'sanity: the cap really does bite at 15/26');
  const o = outcomeFor(prisma, 'a2');
  assert.equal(o.reason, 'OWNERSHIP_CAP');
  assert.equal(prisma.db.gate.capacity, 25);
  assert.match(toastsFor(prisma, 'a2').at(-1).message, /ownership cap/);
});

await test('a lockout voids the bid instead of silently skipping it', async () => {
  const prisma = fakePrisma({
    bids: [{ airlineId: 'a1', amount: 500_000, quantity: 1 }],
    airlines: { a1: airline('a1', 'Austro', 40_000_000, 2, { gateLockouts: { GRR: 200 } }) },
    row: { capacity: 25, taken: 25, holdings: { a1: { count: 2 } } },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.equal(outcomeFor(prisma, 'a1').reason, 'LOCKED_OUT');
  assert.match(toastsFor(prisma, 'a1').at(-1).message, /locked out/);
});

await test('a bankrupt bidder is recorded, not dropped', async () => {
  const dead = airline('a3', 'Gone Air', 40_000_000, 0);
  dead.status = 'BANKRUPT';
  const prisma = fakePrisma({
    bids: [{ airlineId: 'a3', amount: 500_000, quantity: 1 }],
    airlines: { a3: dead },
    row: { capacity: 25, taken: 25, holdings: {} },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.equal(outcomeFor(prisma, 'a3').reason, 'AIRLINE_INACTIVE');
  assert.equal(toastsFor(prisma, 'a3').length, 0, 'no toast for an airline that is gone');
});

await test('the lots run out, and the low bidder is told it was outbid', async () => {
  const prisma = fakePrisma({
    lots: 2,
    bids: [
      { airlineId: 'a1', amount: 900_000, quantity: 2 },
      { airlineId: 'a4', amount: 400_000, quantity: 1 },
    ],
    airlines: {
      a1: airline('a1', 'Austro', 40_000_000, 5),
      a4: airline('a4', 'Late Air', 40_000_000, 0),
    },
    row: { capacity: 25, taken: 25, holdings: { a1: { count: 5 } } },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.equal(outcomeFor(prisma, 'a1').reason, 'WON');
  assert.equal(outcomeFor(prisma, 'a4').reason, 'OUTBID');
  assert.equal(prisma.db.saved.results.length, 1);
  assert.match(toastsFor(prisma, 'a4').at(-1).message, /outbid/);
  assert.equal(toastsFor(prisma, 'a1').at(-1).title, '🔨 Auction won');
});

await test('pay-as-bid: each winner pays their own number', async () => {
  const prisma = fakePrisma({
    lots: 2,
    bids: [
      { airlineId: 'a1', amount: 900_000, quantity: 1 },
      { airlineId: 'a4', amount: 400_000, quantity: 1 },
    ],
    airlines: {
      a1: airline('a1', 'Austro', 40_000_000, 5),
      a4: airline('a4', 'Late Air', 40_000_000, 0),
    },
    row: { capacity: 25, taken: 25, holdings: { a1: { count: 5 } } },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.equal(prisma.db.airlines.a1.state.cash, 40_000_000 - 900_000);
  assert.equal(prisma.db.airlines.a4.state.cash, 40_000_000 - 400_000);
  assert.equal(prisma.db.gate.capacity, 27);
});

await test('a lost CAS race is retried rather than silently voiding a good bid', async () => {
  const prisma = fakePrisma({
    failFirstWrite: true,
    bids: [{ airlineId: 'a1', amount: 500_000, quantity: 1 }],
    airlines: { a1: airline('a1', 'Austro', 40_000_000, 5) },
    row: { capacity: 25, taken: 25, holdings: { a1: { count: 5 } } },
  });
  await resolveDueAuctions(prisma, WORLD, { log: quiet });
  assert.equal(outcomeFor(prisma, 'a1').reason, 'WON');
  assert.equal(prisma.db.gate.capacity, 26);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
