// Restart-after-bankruptcy test — no database, no network.
//
// Runs the REAL restartService against an in-memory fake Prisma. The feature's
// risk is almost entirely in the DEMOLITION, not the seeding: an airline row is
// reused, so roughly fifteen tables and two JSON ledgers still point at it after
// it dies. Every purge below has a matching test because leaving that one item
// behind is an exploit, a permanent leak, or a visible lie about who did what.
//
//   node tools/restart-test.mjs

import assert from 'node:assert/strict';
import {
  restartAirline, purgeAirlineFootprint, restartsLeft, MAX_RESTARTS, RESTARTABLE,
} from '../apps/headwinds-server/src/lib/restartService.mjs';
import { poolKeyOf, holdersOf } from '../apps/headwinds-server/src/lib/marketService.mjs';
import { rivalIdOf } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { seedAirlineState } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

// ── In-memory fake Prisma (only the surface restartService touches) ──────────
function fakePrisma({ world, airlines, gates = [], bids = [], auctions = [], listings = [],
                      members = [], alliances = [], market = null, credits = [], cursors = [] }) {
  const db = {
    world: { ...world },
    airlines: airlines.map((a) => ({ ...a })),
    gates: gates.map((g) => ({ ...g })),
    bids: bids.map((b) => ({ ...b })),
    auctions: auctions.map((a) => ({ ...a })),
    listings: listings.map((l) => ({ ...l })),
    members: members.map((m) => ({ ...m })),
    alliances: alliances.map((a) => ({ ...a })),
    market: market ? { ...market } : null,
    credits: credits.map((c) => ({ ...c })),
    cursors: cursors.map((c) => ({ ...c })),
  };
  const applyData = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
  };
  return {
    _db: db,
    airline: {
      findUnique: async ({ where }) => {
        const a = where.id
          ? db.airlines.find((x) => x.id === where.id)
          : db.airlines.find((x) => x.worldId === where.worldId_accountId.worldId
              && x.accountId === where.worldId_accountId.accountId);
        return a ? { ...a } : null;
      },
      update: async ({ where, data }) => {
        const a = db.airlines.find((x) => x.id === where.id);
        applyData(a, data);
        return { ...a };
      },
    },
    worldGate: {
      findMany: async ({ where }) => db.gates.filter((g) => g.worldId === where.worldId).map((g) => ({ ...g })),
      findUnique: async ({ where }) => {
        const k = where.worldId_airportCode ?? where;
        const g = db.gates.find((x) => x.worldId === k.worldId && x.airportCode === k.airportCode);
        return g ? { ...g } : null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const g of db.gates) {
          if (g.worldId !== where.worldId || g.airportCode !== where.airportCode) continue;
          if (where.version !== undefined && (g.version ?? 0) !== where.version) continue;
          applyData(g, data); count++;
        }
        return { count };
      },
      upsert: async ({ where, create, update }) => {
        const k = where.worldId_airportCode ?? where;
        const g = db.gates.find((x) => x.worldId === k.worldId && x.airportCode === k.airportCode);
        if (g) { applyData(g, update); return { ...g }; }
        const row = { version: 0, taken: 0, holdings: {}, ...create };
        db.gates.push(row);
        return { ...row };
      },
      create: async ({ data }) => { const row = { version: 0, taken: 0, holdings: {}, ...data }; db.gates.push(row); return { ...row }; },
    },
    gateListing: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const l of db.listings) {
          if (l.worldId !== where.worldId || l.sellerId !== where.sellerId) continue;
          if (where.status && l.status !== where.status) continue;
          applyData(l, data); count++;
        }
        return { count };
      },
    },
    gateBid: {
      deleteMany: async ({ where }) => {
        const open = new Set(db.auctions
          .filter((a) => a.worldId === where.auction?.worldId && a.status === where.auction?.status)
          .map((a) => a.id));
        const before = db.bids.length;
        db.bids = db.bids.filter((b) => !(b.airlineId === where.airlineId && open.has(b.auctionId)));
        return { count: before - db.bids.length };
      },
    },
    allianceMember: {
      findUnique: async ({ where }) => {
        const m = db.members.find((x) => x.airlineId === where.airlineId);
        return m ? { ...m } : null;
      },
      findMany: async ({ where }) => db.members
        .filter((m) => m.allianceId === where.allianceId && (!where.status || m.status === where.status))
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map((m) => ({ ...m })),
      delete: async ({ where }) => { db.members = db.members.filter((m) => m.id !== where.id); return {}; },
      update: async ({ where, data }) => {
        const m = db.members.find((x) => x.id === where.id);
        applyData(m, data);
        return { ...m };
      },
    },
    alliance: {
      delete: async ({ where }) => { db.alliances = db.alliances.filter((a) => a.id !== where.id); return {}; },
    },
    worldMarket: {
      findUnique: async ({ where }) => (db.market && db.market.worldId === where.worldId ? { ...db.market } : null),
      updateMany: async ({ where, data }) => {
        if (!db.market || db.market.id !== where.id) return { count: 0 };
        if (where.version !== undefined && db.market.version !== where.version) return { count: 0 };
        applyData(db.market, data);
        return { count: 1 };
      },
    },
    dividendCredit: {
      deleteMany: async ({ where }) => {
        const before = db.credits.length;
        db.credits = db.credits.filter((c) => !(c.worldId === where.worldId
          && c.airlineId === where.airlineId && c.consumed === where.consumed));
        return { count: before - db.credits.length };
      },
    },
    messageCursor: {
      deleteMany: async ({ where }) => {
        const before = db.cursors.length;
        db.cursors = db.cursors.filter((c) => c.airlineId !== where.airlineId);
        return { count: before - db.cursors.length };
      },
    },
  };
}

const WORLD = {
  id: 'w1', name: 'Test World', status: 'RUNNING',
  currentYear: 3, currentWeek: 12, worldSeed: 'seed-abc', lengthYears: 50, weeksPerDay: 12,
  maxPlayers: 50, tickConfig: { startingCapital: 15_000_000, demandMultiplier: 1 },
};

// A dead airline with a rich, obviously-not-fresh blob.
function deadAirline(over = {}) {
  return {
    id: 'a1', worldId: 'w1', accountId: 'acc1', name: 'Fallen Air', hub: 'JFK',
    status: 'BANKRUPT', restarts: 0, restartedWeek: null, joinedWeek: 1,
    version: 9, week: 100, cash: -44_000_000n, marketCap: 1n, shares: 100_000_000n, svps: 5n,
    state: {
      phase: 'bankrupt', bankruptcyReason: 'missed_loans', airlineName: 'Fallen Air', hub: 'JFK',
      cash: -44_000_000, fleet: [{ id: 'f1', typeId: 'a320ceo' }], routes: [{ origin: 'JFK', destination: 'LAX' }],
      loans: [{ id: 'l1', principal: 50_000_000 }], missedLoanPayments: 3,
      financialHistory: [{ week: 1, profit: -1 }], fareIndex: 0.85,
    },
    ...over,
  };
}
const ACCOUNT = { id: 'acc1' };

console.log('\n── Guards ─────────────────────────────────────────────────────');

await test('a BANKRUPT airline can be re-founded', async () => {
  const prisma = fakePrisma({ world: WORLD, airlines: [deadAirline()] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: deadAirline(),
    airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  assert.equal(out.status, 'ACTIVE');
  assert.equal(out.name, 'Phoenix Air');
  assert.equal(out.hub, 'ORD');
  assert.equal(out.restarts, 1);
});

await test('an ABANDONED airline can be re-founded too', async () => {
  const a = deadAirline({ status: 'ABANDONED' });
  const prisma = fakePrisma({ world: WORLD, airlines: [a] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: a, airlineName: 'Second Wind', hub: 'DFW', log: silent,
  });
  assert.equal(out.status, 'ACTIVE');
  assert.equal(RESTARTABLE.has('ABANDONED'), true);
});

await test('an ACTIVE airline is refused — restart must never be reachable while flying', async () => {
  const a = deadAirline({ status: 'ACTIVE' });
  const prisma = fakePrisma({ world: WORLD, airlines: [a] });
  await assert.rejects(
    () => restartAirline(prisma, { account: ACCOUNT, world: WORLD, airline: a, airlineName: 'X', hub: 'JFK', log: silent }),
    (e) => e.statusCode === 409 && /still flying/.test(e.message),
  );
});

await test(`the ${MAX_RESTARTS}rd restart is allowed and the next one is refused`, async () => {
  const last = deadAirline({ restarts: MAX_RESTARTS - 1 });
  assert.equal(restartsLeft(last), 1);
  const prisma = fakePrisma({ world: WORLD, airlines: [last] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: last, airlineName: 'Last Chance', hub: 'JFK', log: silent,
  });
  assert.equal(out.restarts, MAX_RESTARTS);
  assert.equal(restartsLeft(out), 0);

  const spent = deadAirline({ restarts: MAX_RESTARTS });
  await assert.rejects(
    () => restartAirline(fakePrisma({ world: WORLD, airlines: [spent] }), {
      account: ACCOUNT, world: WORLD, airline: spent, airlineName: 'Nope', hub: 'JFK', log: silent }),
    (e) => e.statusCode === 409 && e.message.includes(String(MAX_RESTARTS)),
  );
});

await test("another account's airline cannot be restarted", async () => {
  const a = deadAirline();
  await assert.rejects(
    () => restartAirline(fakePrisma({ world: WORLD, airlines: [a] }), {
      account: { id: 'someone-else' }, world: WORLD, airline: a, airlineName: 'X', hub: 'JFK', log: silent }),
    (e) => e.statusCode === 403,
  );
});

await test('an ENDED world refuses a restart', async () => {
  const a = deadAirline();
  await assert.rejects(
    () => restartAirline(fakePrisma({ world: WORLD, airlines: [a] }), {
      account: ACCOUNT, world: { ...WORLD, status: 'ENDED' }, airline: a, airlineName: 'X', hub: 'JFK', log: silent }),
    (e) => e.statusCode === 409 && /ended/i.test(e.message),
  );
});

await test('reserved OG/DEV tags are rejected in the new name', async () => {
  const a = deadAirline();
  await assert.rejects(
    () => restartAirline(fakePrisma({ world: WORLD, airlines: [a] }), {
      account: ACCOUNT, world: WORLD, airline: a, airlineName: '[OG] Phoenix', hub: 'JFK', log: silent }),
    (e) => e.statusCode === 400,
  );
});

console.log('\n── The new company is genuinely new ───────────────────────────');

await test('the blob is a fresh opening, not the wreck', async () => {
  const prisma = fakePrisma({ world: WORLD, airlines: [deadAirline()] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: deadAirline(), airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  const s = out.state;
  assert.equal(s.phase, 'playing');
  assert.equal(s.cash, 15_000_000);
  assert.deepEqual(s.fleet, []);
  assert.deepEqual(s.routes, []);
  assert.deepEqual(s.loans, []);
  assert.equal(s.missedLoanPayments, 0);
  assert.equal(s.consecutiveNegativeWeeks, 0);
  assert.equal(s.bankruptcyReason, null);
  assert.deepEqual(s.financialHistory, []);
});

await test('it starts on the world clock and economy, not year 1 week 1', async () => {
  const prisma = fakePrisma({ world: WORLD, airlines: [deadAirline()] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: deadAirline(), airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  const linear = (WORLD.currentYear - 1) * 52 + WORLD.currentWeek;
  assert.equal(out.state.year, WORLD.currentYear);
  assert.equal(out.state.week, WORLD.currentWeek);
  assert.equal(out.week, linear);
  assert.equal(out.restartedWeek, linear);
  // Founding week drives the labour seniority scale — a re-founded airline pays
  // starting wages, it does not inherit its predecessor's seniority.
  assert.equal(out.state.foundedAbsWeek, linear);
  // The world's fuel walk, replayed — never a fresh 1.0x index (which would be
  // a free hedge against wherever world fuel actually is).
  assert.ok(out.state.fuelPrice.history.length > 0, 'fuel history should be backfilled');
});

await test('joinedWeek is preserved so the original join is still answerable', async () => {
  const prisma = fakePrisma({ world: WORLD, airlines: [deadAirline()] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: deadAirline(), airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  assert.equal(out.joinedWeek, 1);
  assert.notEqual(out.restartedWeek, out.joinedWeek);
});

await test("the denormalised standings columns are rewritten, not left on the corpse's numbers", async () => {
  const prisma = fakePrisma({ world: WORLD, airlines: [deadAirline()] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: deadAirline(), airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  // The tick maintains these and will not touch this row until next week lands.
  assert.equal(out.cash, BigInt(15_000_000));
  assert.equal(out.shares, BigInt(100_000_000));
  assert.notEqual(out.svps, 5n);
  assert.equal(out.version, 10, 'version must move so in-flight decisions lose their CAS');
});

await test('the world fare ladder is carried forward, not re-seeded from tickConfig', async () => {
  // A world retuned after creation reads its index off a live blob. Re-seeding
  // from tickConfig would put the new airline on a ladder 15% from everyone else.
  const a = deadAirline();
  a.state.fareIndex = 0.72;
  const world = { ...WORLD, tickConfig: { ...WORLD.tickConfig, newWorldRestrictions: true, fareIndex: 0.85 } };
  const prisma = fakePrisma({ world, airlines: [a] });
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world, airline: a, airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  assert.equal(out.state.fareIndex, 0.72);
});

console.log('\n── Demolition: each of these is an exploit if skipped ──────────');

await test('stale float-pool inventory is deleted (both id spellings)', async () => {
  // poolSharesFor PREFERS the recorded number over the blob-derived free float,
  // so a leftover entry means the pool believes it holds millions of shares in a
  // company that has just been re-founded private with zero real float — and the
  // moment it IPOs, the issue is added on top and the pool oversells.
  const prisma = fakePrisma({
    world: WORLD, airlines: [deadAirline()],
    market: { id: 'm1', worldId: 'w1', version: 4, poolCash: 1n, holdings: { a1: 30_000_000, 'human:a1': 7, a2: 5 } },
  });
  await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  assert.deepEqual(prisma._db.market.holdings, { a2: 5 });
  assert.equal(prisma._db.market.version, 5, 'the pool write must be version-guarded like every other');
});

await test('unconsumed dividends are deleted — no free cash on the first tick back', async () => {
  // Credits are consumed only when the recipient's own tick write lands, and the
  // tick reads only ACTIVE airlines, so a dead airline's backlog never expires.
  // Flip it ACTIVE with the backlog intact and the next tick pays out the lot.
  const prisma = fakePrisma({
    world: WORLD, airlines: [deadAirline()],
    credits: [
      { id: 'c1', worldId: 'w1', airlineId: 'a1', amount: 900_000, consumed: false },
      { id: 'c2', worldId: 'w1', airlineId: 'a1', amount: 100_000, consumed: true },
      { id: 'c3', worldId: 'w1', airlineId: 'a2', amount: 500_000, consumed: false },
    ],
  });
  await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  const left = prisma._db.credits.map((c) => c.id).sort();
  assert.deepEqual(left, ['c2', 'c3'], 'only the unconsumed credits owed to a1 should go');
});

await test('gates are released before the new hub is seeded — no double count', async () => {
  const world = { ...WORLD, tickConfig: { ...WORLD.tickConfig, gateScarcity: true } };
  const a = deadAirline();
  const prisma = fakePrisma({
    world, airlines: [a],
    gates: [
      { worldId: 'w1', airportCode: 'JFK', version: 1, capacity: 100, taken: 9, holdings: { a1: { count: 4 }, a2: { count: 5 } } },
      { worldId: 'w1', airportCode: 'ORD', version: 1, capacity: 100, taken: 2, holdings: { a2: { count: 2 } } },
    ],
  });
  await restartAirline(prisma, {
    account: ACCOUNT, world, airline: a, airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  const jfk = prisma._db.gates.find((g) => g.airportCode === 'JFK');
  const ord = prisma._db.gates.find((g) => g.airportCode === 'ORD');
  assert.equal(jfk.holdings.a1, undefined, 'the old hub must not keep a phantom holding');
  assert.equal(jfk.taken, 5, 'taken must drop by exactly what was released');
  assert.equal(ord.holdings.a1?.count, 1, 'the new hub gate is seeded');
  assert.equal(ord.taken, 3);
});

await test('open gate listings are withdrawn', async () => {
  const prisma = fakePrisma({
    world: WORLD, airlines: [deadAirline()],
    gates: [{ worldId: 'w1', airportCode: 'JFK', version: 1, capacity: 10, taken: 1, holdings: { a1: { count: 1 } } }],
    listings: [
      { id: 'gl1', worldId: 'w1', sellerId: 'a1', status: 'OPEN' },
      { id: 'gl2', worldId: 'w1', sellerId: 'a1', status: 'SOLD' },
    ],
  });
  await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  assert.equal(prisma._db.listings.find((l) => l.id === 'gl1').status, 'WITHDRAWN');
  assert.equal(prisma._db.listings.find((l) => l.id === 'gl2').status, 'SOLD', 'settled history is left alone');
});

await test('sealed bids on OPEN auctions are deleted — the new company must not be charged', async () => {
  // Bankruptcy does not clear bids; resolution merely records AIRLINE_INACTIVE.
  // Restart before resolution makes the row ACTIVE again and resolveDueAuctions
  // re-reads it fresh — charging the new company for gates it never bid on.
  const prisma = fakePrisma({
    world: WORLD, airlines: [deadAirline()],
    auctions: [
      { id: 'au1', worldId: 'w1', status: 'OPEN' },
      { id: 'au2', worldId: 'w1', status: 'RESOLVED' },
    ],
    bids: [
      { id: 'b1', auctionId: 'au1', airlineId: 'a1', amount: 9_000_000 },
      { id: 'b2', auctionId: 'au2', airlineId: 'a1', amount: 1_000_000 },
      { id: 'b3', auctionId: 'au1', airlineId: 'a2', amount: 2_000_000 },
    ],
  });
  await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  assert.deepEqual(prisma._db.bids.map((b) => b.id).sort(), ['b2', 'b3'],
    'only a1\'s bid on the still-open auction should go');
});

await test('the alliance seat is freed and a departing founder is succeeded', async () => {
  // A non-ACTIVE airline cannot call the leave route, so the seat outlived the
  // airline: it kept consuming a slot against the member cap and the gate cap,
  // and a dead FOUNDER meant nobody could ever approve a join request again.
  const prisma = fakePrisma({
    world: WORLD, airlines: [deadAirline()],
    alliances: [{ id: 'al1', worldId: 'w1', name: 'Skyward' }],
    members: [
      { id: 'm1', allianceId: 'al1', airlineId: 'a1', role: 'FOUNDER', status: 'ACTIVE', createdAt: '2026-01-01' },
      { id: 'm2', allianceId: 'al1', airlineId: 'a2', role: 'MEMBER', status: 'ACTIVE', createdAt: '2026-02-01' },
      { id: 'm3', allianceId: 'al1', airlineId: 'a3', role: 'MEMBER', status: 'ACTIVE', createdAt: '2026-03-01' },
    ],
  });
  await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  assert.equal(prisma._db.members.find((m) => m.airlineId === 'a1'), undefined);
  assert.equal(prisma._db.members.find((m) => m.id === 'm2').role, 'FOUNDER',
    'the longest-standing active member inherits, as in the leave route');
  assert.equal(prisma._db.alliances.length, 1);
});

await test('an alliance with nobody left disbands', async () => {
  const prisma = fakePrisma({
    world: WORLD, airlines: [deadAirline()],
    alliances: [{ id: 'al1', worldId: 'w1', name: 'Solo Club' }],
    members: [{ id: 'm1', allianceId: 'al1', airlineId: 'a1', role: 'FOUNDER', status: 'ACTIVE', createdAt: '2026-01-01' }],
  });
  await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  assert.deepEqual(prisma._db.alliances, []);
});

await test('the alliance-chat read cursor is cleared', async () => {
  const prisma = fakePrisma({
    world: WORLD, airlines: [deadAirline()],
    cursors: [{ id: 'mc1', airlineId: 'a1' }, { id: 'mc2', airlineId: 'a2' }],
  });
  await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  assert.deepEqual(prisma._db.cursors.map((c) => c.id), ['mc2']);
});

await test('a purge failure is reported but never strands the player', async () => {
  const prisma = fakePrisma({ world: WORLD, airlines: [deadAirline()] });
  prisma.dividendCredit.deleteMany = async () => { throw new Error('boom'); };
  const res = await purgeAirlineFootprint(prisma, 'w1', 'a1', { log: silent });
  assert.equal(res.ok, false);
  assert.ok(res.problems.includes('unconsumed dividends'));
  // …and the restart itself still completes.
  const out = await restartAirline(prisma, {
    account: ACCOUNT, world: WORLD, airline: deadAirline(), airlineName: 'Phoenix Air', hub: 'ORD', log: silent,
  });
  assert.equal(out.status, 'ACTIVE');
});

console.log('\n── Rival-side identity: the generation suffix ─────────────────');

await test('generation 0 keeps the exact legacy id — nothing stored needs migrating', async () => {
  assert.equal(rivalIdOf({ id: 'a1', restarts: 0 }), 'human:a1');
  assert.equal(rivalIdOf({ id: 'a1' }), 'human:a1');
});

await test('a re-founded airline is a NEW competitor id, so the engine delists the old one', async () => {
  // The engine force-liquidates any holding whose competitor id leaves the rival
  // set (reducer's delisting sweep, paid at DELIST_HAIRCUT). Changing the id is
  // what makes the dead company delist — and it closes the race where a player
  // who restarts before their rivals tick would never delist at all.
  const before = rivalIdOf({ id: 'a1', restarts: 0 });
  const after = rivalIdOf({ id: 'a1', restarts: 1 });
  assert.notEqual(before, after);
  assert.equal(after, 'human:a1~g1');
});

await test('poolKeyOf collapses every generation onto the raw database id', async () => {
  for (const id of ['a1', 'human:a1', 'human:a1~g1', 'human:a1~g12']) {
    assert.equal(poolKeyOf(id), 'a1', `${id} should normalise to a1`);
  }
});

await test('dividends still reach a holder whose position predates the restart', async () => {
  // holdersOf used to probe two fixed spellings; a generation-suffixed key would
  // have found no holders at all and silently sent the whole rival slice out of
  // the world — the exact bug its own comment records.
  const holders = holdersOf([
    { id: 'a2', state: { portfolio: { holdings: { 'human:a1': { shares: 100 } } } } },
    { id: 'a3', state: { portfolio: { holdings: { 'human:a1~g1': { shares: 50 } } } } },
    { id: 'a4', state: { portfolio: { holdings: { 'human:a1': { shares: 7 }, 'human:a1~g1': { shares: 3 } } } } },
    { id: 'a5', state: { portfolio: { holdings: { 'human:zz': { shares: 999 } } } } },
  ], 'a1');
  assert.deepEqual(holders, [
    { airlineId: 'a2', shares: 100 },
    { airlineId: 'a3', shares: 50 },
    { airlineId: 'a4', shares: 10 },
  ]);
});

await test('a codeshare does not outlive its partner', async () => {
  // The 52-week countdown never checked the partner still existed, so a deal
  // with a bankrupt or re-founded carrier kept charging its weekly fee and kept
  // granting connectivity for the rest of its term.
  const base = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Holder', hub: 'JFK' });
  const withDeal = {
    ...base,
    multiplayer: true,
    codeshareAgreements: [
      { id: 'cs1', competitorId: 'human:a1', competitorName: 'Fallen Air', weeklyFee: 50_000, weeksRemaining: 40 },
      { id: 'cs2', competitorId: 'human:a9', competitorName: 'Still Flying', weeklyFee: 50_000, weeksRemaining: 40 },
    ],
    // a1 has re-founded, so it now presents as human:a1~g1 — a different carrier.
    competitors: [
      { id: 'human:a1~g1', human: true, name: 'Phoenix Air', tier: 'legacy' },
      { id: 'human:a9', human: true, name: 'Still Flying', tier: 'legacy' },
    ],
  };
  const next = gameReducer(withDeal, { type: 'ADVANCE_WEEK' });
  const ids = (next.codeshareAgreements ?? []).map((a) => a.id);
  assert.deepEqual(ids, ['cs2'], 'the deal with the vanished partner must be terminated');
});

console.log('\n── Seeding helper is shared verbatim with join ─────────────────');

await test('seedAirlineState is pure and does not depend on the airline existing', async () => {
  const s1 = seedAirlineState(WORLD, { airlineName: 'A', hub: 'JFK' });
  const s2 = seedAirlineState(WORLD, { airlineName: 'A', hub: 'JFK' });
  assert.equal(s1.cash, s2.cash);
  assert.equal(s1.fuelPrice.index, s2.fuelPrice.index, 'the economy replay must be deterministic');
  assert.equal(s1.multiplayer, true);
  assert.deepEqual(s1.competitors, []);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} restart: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
