// Bankruptcy stops being a rounding error.
//
// B8. A failed airline used to leave the world exactly as it found it. The
//     fleet froze inside a state blob nobody would ever read again, the
//     orderbook stopped existing, and the gates went back to the pool in
//     silence — on gate-scarcity worlds only, because that was the one branch
//     anybody had written. A carrier could go under with forty aeroplanes and a
//     dozen slots at a fortress hub and none of it reached anyone still flying.
//
//     The estate is now sold. Owned aircraft go to the used market at a
//     distressed price; gates are listed as administrator's sales. The listing
//     still names the airline that failed, because the gate ledger has to debit
//     somebody when it finally sells — what differs is that nobody is paid.
//
//   node tools/firesale-test.mjs

import assert from 'node:assert/strict';
import {
  AIRCRAFT_DISTRESS_FACTOR, GATE_DISTRESS_FACTOR, GATE_MIN_ASK,
  distressedNav, fireSaleFleet, fireSaleGates, fireSaleAirline,
} from '../apps/headwinds-server/src/lib/fireSaleService.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { valueRemaining } from '../packages/engine/src/data/overhead.js';

let passed = 0, failed = 0;
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const test = (name, fn) => atest(name, async () => fn());

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const owned = (typeId, ageWeeks = 100, over = {}) => ({
  id: `t-${typeId}-${ageWeeks}`, typeId, ownershipType: 'owned', ageWeeks, status: 'idle', ...over,
});

/** Stand-in prisma: used listings, gate listings, the gate ledger. */
function fakeDb({ gates = [] } = {}) {
  const used = [];
  const gateListings = [];
  const api = {
    _used: used, _gateListings: gateListings,
    $transaction: async (fn) => fn(api),
    usedAircraftListing: {
      create: async ({ data }) => { used.push({ id: `u${used.length + 1}`, ...data }); return used.at(-1); },
    },
    gateListing: {
      create: async ({ data }) => { gateListings.push({ id: `g${gateListings.length + 1}`, ...data }); return gateListings.at(-1); },
    },
    worldGate: { findMany: async () => gates },
  };
  return api;
}

const SCARCE = { id: 'w1', tickConfig: { gateScarcity: true } };
const OPEN_WORLD = { id: 'w2', tickConfig: {} };

// ── Pricing ─────────────────────────────────────────────────────────────────

console.log('\n── What an estate fetches ───────────────────────────────');

test('a forced sale is priced below book, by a stated factor', () => {
  const a = owned('a320ceo', 260);
  const type = getAircraftType('a320ceo');
  const book = (type.purchasePrice ?? 0) * valueRemaining(260, type);
  assert.ok(distressedNav(a) < book, 'an administrator does not get book value');
  assert.equal(distressedNav(a), Math.round(book * AIRCRAFT_DISTRESS_FACTOR));
  assert.ok(AIRCRAFT_DISTRESS_FACTOR < 1 && AIRCRAFT_DISTRESS_FACTOR > 0.4,
    'a discount steep enough to be worth buying, shallow enough to be worth listing');
});

test('an older frame is worth less, exactly as it is when sold normally', () => {
  assert.ok(distressedNav(owned('a320ceo', 1000)) < distressedNav(owned('a320ceo', 100)));
});

test('an unknown type prices at nothing rather than NaN', () => {
  // And an aircraft priced at nothing is not listed at all — an estate cannot
  // sell a frame the game has no record of. (This caught a bad type id in this
  // very suite before it caught anything else.)
  assert.equal(distressedNav({ typeId: 'nope', ageWeeks: 10 }), 0);
  assert.equal(distressedNav(null), 0);
});

// ── The fleet ───────────────────────────────────────────────────────────────

console.log('\n── The fleet reaches the market ─────────────────────────');

await atest('every owned aircraft is listed, flagged as distressed', () => {
  const db = fakeDb();
  return fireSaleFleet(db, {
    world: OPEN_WORLD, airlineName: 'Nordic Air', weekIndex: 90, log: quiet,
    fleet: [owned('a320ceo'), owned('b7878', 200)],
  }).then((n) => {
    assert.equal(n, 2);
    assert.equal(db._used.length, 2);
    for (const l of db._used) {
      assert.equal(l.distressed, true, 'a bargain nobody can explain looks like a bug');
      assert.equal(l.origin, 'Nordic Air', 'the feed should be able to name the ex-operator');
      assert.equal(l.listedWeek, 90);
      assert.ok(l.navPrice > 0);
    }
  });
});

await atest('leased tails are the lessor\'s and are not part of the estate', () => {
  const db = fakeDb();
  return fireSaleFleet(db, {
    world: OPEN_WORLD, airlineName: 'X', weekIndex: 90, log: quiet,
    fleet: [
      owned('a320ceo'),
      { id: 'l1', typeId: 'a320ceo', ownershipType: 'leased', ageWeeks: 100 },
      { ...owned('b7878'), status: 'retired' },
    ],
  }).then((n) => {
    assert.equal(n, 1, 'only the owned, unretired aircraft');
    assert.equal(db._used.length, 1);
  });
});

await atest('an airline that owned nothing lists nothing', () => {
  const db = fakeDb();
  return fireSaleFleet(db, { world: OPEN_WORLD, airlineName: 'X', weekIndex: 1, fleet: [], log: quiet })
    .then((n) => { assert.equal(n, 0); assert.equal(db._used.length, 0); });
});

await atest('one bad frame does not stop the rest of the estate', () => {
  // Forty aeroplanes, one of which trips something. The other thirty-nine are
  // still worth putting on the market.
  const db = fakeDb();
  let calls = 0;
  db.usedAircraftListing.create = async ({ data }) => {
    if (++calls === 2) throw new Error('boom');
    db._used.push({ id: `u${calls}`, ...data });
    return db._used.at(-1);
  };
  return fireSaleFleet(db, {
    world: OPEN_WORLD, airlineName: 'X', weekIndex: 5, log: quiet,
    fleet: [owned('a320ceo'), owned('b7878'), owned('a321neo')],
  }).then((n) => {
    assert.equal(n, 2, 'the two that could be listed were');
  });
});

// ── The gates ───────────────────────────────────────────────────────────────

console.log('\n── The gates reach the market ───────────────────────────');

const ledger = (holdings) => ([
  { id: 'wg1', airportCode: 'LHR', capacity: 40, taken: 20, holdings },
  { id: 'wg2', airportCode: 'ORD', capacity: 60, taken: 10, holdings: {} },
]);

await atest('a failed airline\'s gates are listed, one per gate held', () => {
  const db = fakeDb({ gates: ledger({ dead: { count: 3 } }) });
  return fireSaleGates(db, { world: SCARCE, airlineId: 'dead', weekIndex: 50, log: quiet })
    .then((n) => {
      assert.equal(n, 3, 'three gates held, three listings');
      assert.equal(db._gateListings.length, 3);
      for (const l of db._gateListings) {
        assert.equal(l.airportCode, 'LHR');
        assert.equal(l.distressed, true);
        assert.equal(l.sellerId, 'dead',
          'the listing must still name the holder — the ledger debits it on sale');
        assert.ok(l.askPrice >= GATE_MIN_ASK);
      }
    });
});

await atest('a gate is priced off its own airport, not a flat number', () => {
  // A slot at a fortress hub is not worth what a regional one is.
  const big = fakeDb({ gates: [{ id: 'a', airportCode: 'LHR', capacity: 40, holdings: { d: { count: 1 } } }] });
  const small = fakeDb({ gates: [{ id: 'b', airportCode: 'BOI', capacity: 40, holdings: { d: { count: 1 } } }] });
  return Promise.all([
    fireSaleGates(big, { world: SCARCE, airlineId: 'd', weekIndex: 1, log: quiet }),
    fireSaleGates(small, { world: SCARCE, airlineId: 'd', weekIndex: 1, log: quiet }),
  ]).then(() => {
    const lhr = big._gateListings[0].askPrice;
    const boi = small._gateListings[0].askPrice;
    assert.ok(lhr >= boi, `LHR (${lhr}) should not be cheaper than BOI (${boi})`);
    assert.ok(GATE_DISTRESS_FACTOR < 1, 'and both are below the auction reserve');
  });
});

await atest('a world without gate scarcity lists no gates at all', () => {
  // There, gates are bought freely from the airport — a second-hand one is
  // worth nothing to anybody.
  const db = fakeDb({ gates: ledger({ dead: { count: 5 } }) });
  return fireSaleGates(db, { world: OPEN_WORLD, airlineId: 'dead', weekIndex: 50, log: quiet })
    .then((n) => { assert.equal(n, 0); assert.equal(db._gateListings.length, 0); });
});

await atest('an airline that held no gates leaves no listings', () => {
  const db = fakeDb({ gates: ledger({ someone_else: { count: 4 } }) });
  return fireSaleGates(db, { world: SCARCE, airlineId: 'dead', weekIndex: 50, log: quiet })
    .then((n) => { assert.equal(n, 0); });
});

// ── The whole estate ────────────────────────────────────────────────────────

console.log('\n── Winding up ───────────────────────────────────────────');

await atest('winding up sells both halves and reports what it did', () => {
  const db = fakeDb({ gates: ledger({ dead: { count: 2 } }) });
  return fireSaleAirline(db, {
    world: SCARCE, weekIndex: 60, log: quiet,
    airline: { id: 'dead', name: 'Nordic Air', fleet: [owned('a320ceo'), owned('b7878')] },
  }).then((res) => {
    assert.deepEqual(res, { aircraft: 2, gates: 2 });
  });
});

await atest('a failure in one half does not cost the other', () => {
  // This runs after the week has already committed. Anything that goes wrong
  // here must leave a bankruptcy merely as uneventful as it used to be.
  const db = fakeDb({ gates: ledger({ dead: { count: 2 } }) });
  db.worldGate.findMany = async () => { throw new Error('ledger unavailable'); };
  return fireSaleAirline(db, {
    world: SCARCE, weekIndex: 60, log: quiet,
    airline: { id: 'dead', name: 'X', fleet: [owned('a320ceo')] },
  }).then((res) => {
    assert.equal(res.aircraft, 1, 'the fleet still went to market');
    assert.equal(res.gates, 0);
  });
});

await atest('an airline with nothing left winds up quietly', () => {
  const db = fakeDb({ gates: [] });
  return fireSaleAirline(db, {
    world: SCARCE, weekIndex: 60, log: quiet,
    airline: { id: 'dead', name: 'X', fleet: [] },
  }).then((res) => { assert.deepEqual(res, { aircraft: 0, gates: 0 }); });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
