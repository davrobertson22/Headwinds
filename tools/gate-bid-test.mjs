// Sealed gate-auction bid validation — no database, no network.
//
// Guards the rule that surfaced as a UI bug: the bid form once offered ×3 at an
// airport with only 2 gates on offer. You can never win more lots than exist,
// so placeBid caps the quantity at min(GATE_BID_MAX_QTY, auction.lots) and the
// dropdown in Airports.jsx is built from the same number.
//
//   node tools/gate-bid-test.mjs

import assert from 'node:assert/strict';
import { placeBid, withdrawBid } from '../apps/headwinds-server/src/lib/gateService.mjs';
import { GATE_BID_MAX_QTY } from '../packages/engine/src/data/airports.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// ── In-memory fake Prisma (only the surface placeBid/withdrawBid touch) ──────
function fakePrisma({ auction, gate }) {
  const bids = [];
  return {
    bids,
    // The ledger row placeBid now reads to apply the ownership caps before
    // accepting a bid. Roomy by default so these cases test what they say.
    worldGate: {
      findUnique: async () => ({
        worldId: 'w1', airportCode: 'GRR', capacity: 100, taken: 40, baseSize: 100,
        holdings: { a1: { count: 4 } }, version: 1, ...(gate ?? {}),
      }),
    },
    gateAuction: {
      findFirst: async ({ where }) =>
        (auction && auction.airportCode === where.airportCode && auction.status === where.status
          ? { ...auction }
          : null),
    },
    gateBid: {
      upsert: async ({ where, create, update }) => {
        const key = where.auctionId_airlineId;
        const found = bids.find((b) => b.auctionId === key.auctionId && b.airlineId === key.airlineId);
        if (found) Object.assign(found, update);
        else bids.push({ ...create });
      },
      deleteMany: async ({ where }) => {
        for (let i = bids.length - 1; i >= 0; i--) {
          if (bids[i].auctionId === where.auctionId && bids[i].airlineId === where.airlineId) bids.splice(i, 1);
        }
      },
    },
  };
}

const world = { id: 'w1', currentYear: 2, currentWeek: 41, worldSeed: 'seed' };
const airline = { id: 'a1', name: 'Test Air', state: { cash: 50_000_000, gates: {}, gateLockouts: {} } };
const openAuction = (lots) => ({
  id: `auc-${lots}`, worldId: 'w1', airportCode: 'GRR', status: 'OPEN',
  lots, reserve: 195_000, resolvesWeek: 53,
});

const bid = (prisma, { amount = 500_000, quantity = 1 } = {}) =>
  placeBid(prisma, { world, airline, airportCode: 'GRR', amount, quantity });

console.log('\n── Sealed bid quantity is capped by the lots on offer ────');

await test('bidding for more gates than are on offer is rejected', async () => {
  const prisma = fakePrisma({ auction: openAuction(2) });
  await assert.rejects(() => bid(prisma, { quantity: 3 }), /1–2 gates|2 on offer/);
  assert.equal(prisma.bids.length, 0, 'nothing should have been written');
});

await test('bidding for exactly the lots on offer is accepted', async () => {
  const prisma = fakePrisma({ auction: openAuction(2) });
  await bid(prisma, { quantity: 2 });
  assert.equal(prisma.bids.length, 1);
  assert.equal(prisma.bids[0].quantity, 2);
});

await test('a single-lot auction accepts 1 and refuses 2', async () => {
  const prisma = fakePrisma({ auction: openAuction(1) });
  await assert.rejects(() => bid(prisma, { quantity: 2 }), /Only 1 gate/);
  await bid(prisma, { quantity: 1 });
  assert.equal(prisma.bids[0].quantity, 1);
});

await test('the anti-monopoly cap still bites when lots exceed it', async () => {
  const prisma = fakePrisma({ auction: openAuction(15) });   // a 500-size airport
  await assert.rejects(() => bid(prisma, { quantity: GATE_BID_MAX_QTY + 1 }), /You may bid for 1–3 gates/);
  await bid(prisma, { quantity: GATE_BID_MAX_QTY });
  assert.equal(prisma.bids[0].quantity, GATE_BID_MAX_QTY);
});

console.log('\n── The rest of the bid guard rails still hold ───────────');

await test('a bid below the reserve is rejected', async () => {
  const prisma = fakePrisma({ auction: openAuction(2) });
  await assert.rejects(() => bid(prisma, { amount: 100_000 }), /start at/);
});

await test('a fractional quantity rounds, and still cannot exceed the lots', async () => {
  const prisma = fakePrisma({ auction: openAuction(2) });
  await bid(prisma, { quantity: 1.4 });
  assert.equal(prisma.bids[0].quantity, 1, 'rounds down to a whole gate');
  await assert.rejects(() => bid(prisma, { quantity: 2.6 }), /1–2 gates|2 on offer/);
});

await test('an airport locked out to you refuses the bid', async () => {
  const prisma = fakePrisma({ auction: openAuction(2) });
  const locked = { ...airline, state: { ...airline.state, gateLockouts: { GRR: 999 } } };
  await assert.rejects(
    () => placeBid(prisma, { world, airline: locked, airportCode: 'GRR', amount: 500_000, quantity: 1 }),
    /locked out/,
  );
});

await test('there is nothing to bid on when no auction is open', async () => {
  const prisma = fakePrisma({ auction: null });
  await assert.rejects(() => bid(prisma, { quantity: 1 }), /No open gate auction/);
});

await test('updating then withdrawing leaves no bid behind', async () => {
  const prisma = fakePrisma({ auction: openAuction(2) });
  await bid(prisma, { quantity: 1 });
  await bid(prisma, { amount: 900_000, quantity: 2 });
  assert.equal(prisma.bids.length, 1, 'an update must not create a second bid');
  assert.equal(prisma.bids[0].amount, 900_000);
  assert.equal(prisma.bids[0].quantity, 2);
  await withdrawBid(prisma, { world, airline, airportCode: 'GRR' });
  assert.equal(prisma.bids.length, 0);
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
