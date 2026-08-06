// A career that outlives the world.
//
// B2. A Headwinds season runs about seven real months and then stops dead. The
//     final tick flipped `status: 'ENDED'` and that was the entire ceremony —
//     no final record, no per-account write, nothing that followed the player
//     into the next world. Four seasons, a championship, a million passengers
//     carried: invisible. The only cross-world distinction that existed was the
//     OG badge, which an admin grants by hand.
//
//     The storage was already there. `Account.careerStats Json @default("{}")`
//     has been in the schema since the first migration and, until this package,
//     appeared nowhere else in the repository at all.
//
// The rule this suite exists to protect: TOTALS ARE DERIVED, NEVER
// ACCUMULATED. Every figure is recomputed from the per-world map on each write,
// which is what makes the snapshot safe to re-run — from a retried tick, a
// manual invocation, or the backfill script visiting a world twice. An
// incrementing counter would have been shorter and impossible to repair.
//
//   node tools/career-test.mjs

import assert from 'node:assert/strict';
import {
  CAREER_VERSION, PODIUM_RANK, CAREER_BADGES,
  worldRecord, careerTotals, careerBadges, emptyCareer, normalizeCareer,
  withWorldRecord, hasWorldRecord, serializeCareer, passengersFromState,
} from '../apps/headwinds-server/src/lib/career.mjs';
import { passengerTotalsFrom, snapshotWorldCareers } from '../apps/headwinds-server/src/lib/careerService.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const season = (over = {}) => ({
  worldId: 'w1', worldName: 'Blitz One', lengthYears: 3, endedAt: '2026-01-01T00:00:00.000Z',
  airlineId: 'a1', airlineName: 'Test Air', hub: 'JFK',
  rank: 4, of: 20, bestRank: 2, svps: 12_345, marketCap: 900_000_000,
  status: 'ACTIVE', restarts: 0, passengers: 2_400_000, weeksPlayed: 156, ...over,
});

// ── The record ──────────────────────────────────────────────────────────────

console.log('\n── One season ───────────────────────────────────────────');

test('a season records the things a career is made of', () => {
  const r = worldRecord(season());
  assert.equal(r.worldId, 'w1');
  assert.equal(r.rank, 4);
  assert.equal(r.bestRank, 2, 'the best rank ever held, not just the final one');
  assert.equal(r.passengers, 2_400_000);
  assert.equal(r.weeksPlayed, 156);
  assert.equal(r.status, 'ACTIVE');
});

test('an unranked season is unranked, not last', () => {
  // A private airline never had a traded share price, so it was never in the
  // standings. Recording that as "20th of 20" would be a lie about a decision
  // the player made deliberately.
  const r = worldRecord(season({ rank: null }));
  assert.equal(r.rank, null);
  assert.equal(careerTotals({ w1: r }).bestFinish, null);
  assert.equal(careerTotals({ w1: r }).podiums, 0);
});

test('junk in a field becomes a zero, never a NaN in the hall of fame', () => {
  const r = worldRecord(season({ svps: 'lots', passengers: undefined, restarts: null }));
  for (const k of ['svps', 'passengers', 'restarts', 'marketCap']) {
    assert.ok(Number.isFinite(r[k]), `${k} came out ${r[k]}`);
  }
});

// ── Totals ──────────────────────────────────────────────────────────────────

console.log('\n── Totals ───────────────────────────────────────────────');

test('championships, podiums and best finish come out of the seasons', () => {
  const t = careerTotals({
    w1: worldRecord(season({ worldId: 'w1', rank: 1 })),
    w2: worldRecord(season({ worldId: 'w2', rank: 3 })),
    w3: worldRecord(season({ worldId: 'w3', rank: 11 })),
  });
  assert.equal(t.worldsFinished, 3);
  assert.equal(t.championships, 1);
  assert.equal(t.podiums, 2);
  assert.equal(t.bestFinish, 1);
});

test('a podium is the top three, and the boundary is the boundary', () => {
  assert.equal(careerTotals({ a: worldRecord(season({ rank: PODIUM_RANK })) }).podiums, 1);
  assert.equal(careerTotals({ a: worldRecord(season({ rank: PODIUM_RANK + 1 })) }).podiums, 0);
});

test('passengers and weeks accumulate across seasons', () => {
  const t = careerTotals({
    w1: worldRecord(season({ worldId: 'w1', passengers: 2_000_000, weeksPlayed: 156 })),
    w2: worldRecord(season({ worldId: 'w2', passengers: 3_500_000, weeksPlayed: 260 })),
  });
  assert.equal(t.lifetimePassengers, 5_500_000);
  assert.equal(t.weeksPlayed, 416);
});

test('a season you lost still counts as one you played', () => {
  const t = careerTotals({
    w1: worldRecord(season({ worldId: 'w1', status: 'BANKRUPT', rank: 19, restarts: 2 })),
  });
  assert.equal(t.worldsFinished, 1);
  assert.equal(t.bankruptcies, 1);
  assert.equal(t.refoundings, 2);
});

test('an empty career is zeroes, not undefined', () => {
  const t = careerTotals({});
  assert.equal(t.worldsFinished, 0);
  assert.equal(t.bestFinish, null);
  assert.equal(t.lifetimePassengers, 0);
  assert.deepEqual(careerTotals(null), t);
});

// ── Idempotency: THE rule ───────────────────────────────────────────────────

console.log('\n── Written twice, counted once ──────────────────────────');

test('banking the same season twice does not double it', () => {
  // The snapshot runs post-commit and best-effort, and the backfill script can
  // be pointed at a world that already has a record. If either double-counted,
  // a championship would multiply every time anything was retried.
  let career = emptyCareer();
  career = withWorldRecord(career, season({ rank: 1, passengers: 2_000_000 }));
  const once = JSON.parse(JSON.stringify(career));
  career = withWorldRecord(career, season({ rank: 1, passengers: 2_000_000 }));
  assert.deepEqual(career, once, 'a second write changed the record');
  assert.equal(career.totals.championships, 1);
  assert.equal(career.totals.lifetimePassengers, 2_000_000);
});

test('re-banking a season with a corrected figure replaces it', () => {
  let career = withWorldRecord(emptyCareer(), season({ passengers: 0 }));
  assert.equal(career.totals.lifetimePassengers, 0);
  career = withWorldRecord(career, season({ passengers: 4_000_000 }));
  assert.equal(career.totals.lifetimePassengers, 4_000_000, 'the correction should replace, not add');
  assert.equal(career.totals.worldsFinished, 1);
});

test('different seasons are different entries', () => {
  let career = emptyCareer();
  career = withWorldRecord(career, season({ worldId: 'w1', rank: 1 }));
  career = withWorldRecord(career, season({ worldId: 'w2', rank: 1 }));
  assert.equal(career.totals.worldsFinished, 2);
  assert.equal(career.totals.championships, 2);
});

test('a record with no world id is refused rather than filed under undefined', () => {
  const career = withWorldRecord(emptyCareer(), season({ worldId: null }));
  assert.equal(career.totals.worldsFinished, 0);
});

test('a career written by an older build is read, not discarded', () => {
  const legacy = { v: 0, worlds: { w1: worldRecord(season({ rank: 1 })) }, totals: { nonsense: true } };
  const career = normalizeCareer(legacy);
  assert.equal(career.v, CAREER_VERSION);
  assert.equal(career.totals.championships, 1, 'totals should be recomputed, not trusted');
});

test('a corrupt column never crashes the account', () => {
  for (const junk of [null, undefined, 0, 'nope', [], { worlds: 'no' }]) {
    const c = normalizeCareer(junk);
    assert.equal(c.totals.worldsFinished, 0, `normalizeCareer(${JSON.stringify(junk)})`);
  }
});

test('a stale totals block cannot outvote the seasons', () => {
  // The whole reason totals are derived: a hand-edited or half-written blob
  // must not be able to claim a championship that no season backs up.
  const forged = { v: 1, worlds: {}, totals: { championships: 99, worldsFinished: 99 } };
  assert.equal(normalizeCareer(forged).totals.championships, 0);
});

// ── Badges ──────────────────────────────────────────────────────────────────

console.log('\n── Badges ───────────────────────────────────────────────');

test('nothing is earned by turning up', () => {
  assert.deepEqual(careerBadges(careerTotals({})), []);
  assert.deepEqual(careerBadges(null), []);
});

test('winning a season earns the champion badge', () => {
  const b = careerBadges(careerTotals({ w1: worldRecord(season({ rank: 1 })) })).map(x => x.id);
  assert.ok(b.includes('champion'));
  assert.ok(b.includes('podium'), 'a win is also a podium');
});

test('a third season makes a veteran', () => {
  const two = careerTotals(Object.fromEntries(['w1', 'w2'].map(id => [id, worldRecord(season({ worldId: id, rank: 9 }))])));
  const three = careerTotals(Object.fromEntries(['w1', 'w2', 'w3'].map(id => [id, worldRecord(season({ worldId: id, rank: 9 }))])));
  assert.ok(!careerBadges(two).some(b => b.id === 'veteran'));
  assert.ok(careerBadges(three).some(b => b.id === 'veteran'));
});

test('coming back from bankruptcy and finishing is a Phoenix', () => {
  // The best story a persistent world produces, and nothing has ever marked it.
  const t = careerTotals({ w1: worldRecord(season({ status: 'BANKRUPT', restarts: 1, rank: 12 })) });
  assert.ok(careerBadges(t).some(b => b.id === 'phoenix'));
});

test('a million passengers is a million passengers', () => {
  const under = careerTotals({ w1: worldRecord(season({ passengers: 999_999 })) });
  const over  = careerTotals({ w1: worldRecord(season({ passengers: 1_000_000 })) });
  assert.ok(!careerBadges(under).some(b => b.id === 'million-pax'));
  const badge = careerBadges(over).find(b => b.id === 'million-pax');
  assert.ok(badge);
  assert.match(badge.description, /1M passengers/);
});

test('every badge has a description that survives its own totals', () => {
  // A `describe` that throws would take the whole /me response with it.
  for (const b of CAREER_BADGES) {
    for (const t of [careerTotals({}), careerTotals({ w1: worldRecord(season({ rank: 1, restarts: 3 })) })]) {
      assert.equal(typeof b.describe(t), 'string', `${b.id} description`);
    }
  }
});

// ── The read shape ──────────────────────────────────────────────────────────

console.log('\n── What /me sends ───────────────────────────────────────');

test('seasons come back newest first', () => {
  let career = emptyCareer();
  career = withWorldRecord(career, season({ worldId: 'old', endedAt: '2025-01-01T00:00:00.000Z' }));
  career = withWorldRecord(career, season({ worldId: 'new', endedAt: '2026-06-01T00:00:00.000Z' }));
  const out = serializeCareer(career);
  assert.deepEqual(out.worlds.map(w => w.worldId), ['new', 'old']);
  assert.equal(out.totals.worldsFinished, 2);
  assert.ok(Array.isArray(out.badges));
});

test('an account that has finished nothing sends an honest nothing', () => {
  const out = serializeCareer({});
  assert.deepEqual(out.worlds, []);
  assert.deepEqual(out.badges, []);
  assert.equal(out.totals.worldsFinished, 0);
});

test('hasWorldRecord answers what the backfill asks it', () => {
  const career = withWorldRecord(emptyCareer(), season({ worldId: 'w7' }));
  assert.equal(hasWorldRecord(career, 'w7'), true);
  assert.equal(hasWorldRecord(career, 'w8'), false);
  assert.equal(hasWorldRecord(null, 'w7'), false);
});

// ── Lifetime passengers ─────────────────────────────────────────────────────

console.log('\n── Passengers carried ───────────────────────────────────');

test('the KPI series is summed across every travelling passenger', () => {
  const state = {
    statsHistory: [
      { paxOrganic: 1000, paxConnecting: 200, paxInterline: 50 },
      { paxOrganic: 1100, paxConnecting: 250, paxInterline: 60 },
    ],
  };
  assert.equal(passengersFromState(state), 2660);
});

test('a save from before statsHistory falls back rather than reporting none', () => {
  const state = { financialHistory: [{ passengers: 900 }, { passengers: 1100 }] };
  assert.equal(passengersFromState(state), 2000);
});

test('an airline that never flew carries nobody', () => {
  assert.equal(passengersFromState({}), 0);
  assert.equal(passengersFromState(null), 0);
  assert.equal(passengersFromState({ statsHistory: 'no' }), 0);
});

test('the tick hands over totals for every airline it has in hand', () => {
  const map = passengerTotalsFrom([
    { airline: { id: 'a1' }, next: { statsHistory: [{ paxOrganic: 500 }] } },
    { airline: { id: 'a2' }, next: { statsHistory: [{ paxOrganic: 700 }] } },
    { next: { statsHistory: [{ paxOrganic: 999 }] } },      // no airline — skipped
  ]);
  assert.equal(map.get('a1'), 500);
  assert.equal(map.get('a2'), 700);
  assert.equal(map.size, 2);
  assert.equal(passengerTotalsFrom().size, 0);
});

// ── The snapshot itself, against a stand-in database ────────────────────────

console.log('\n── The world-end snapshot ───────────────────────────────');

/** Minimal prisma stand-in: enough surface for snapshotWorldCareers, no more. */
function fakePrisma({ airlines, standings = [], accounts }) {
  const store = new Map(Object.entries(accounts));
  return {
    _accounts: store,
    airline: { findMany: async () => airlines },
    standing: {
      groupBy: async () => {
        const best = new Map();
        for (const st of standings) {
          const cur = best.get(st.airlineId);
          if (cur == null || st.rank < cur) best.set(st.airlineId, st.rank);
        }
        return [...best.entries()].map(([airlineId, rank]) => ({ airlineId, _min: { rank } }));
      },
    },
    account: {
      findUnique: async ({ where }) => (store.has(where.id) ? { careerStats: store.get(where.id) } : null),
      update: async ({ where, data }) => { store.set(where.id, data.careerStats); return {}; },
    },
  };
}

const WORLD = { id: 'w1', name: 'Blitz One', lengthYears: 3, endedAt: new Date('2026-01-01') };
const AIRLINES = [
  { id: 'a1', accountId: 'acc1', name: 'Winner Air', hub: 'JFK', status: 'ACTIVE',
    svps: 50_000n, marketCap: 900_000_000n, restarts: 0, joinedWeek: 1, restartedWeek: null, week: 156 },
  { id: 'a2', accountId: 'acc2', name: 'Runner Up', hub: 'LHR', status: 'ACTIVE',
    svps: 30_000n, marketCap: 500_000_000n, restarts: 0, joinedWeek: 20, restartedWeek: null, week: 156 },
  // Bankrupt: never ticked, so it appears in no `computed` array — but it played.
  { id: 'a3', accountId: 'acc3', name: 'Gone Bust', hub: 'ORD', status: 'BANKRUPT',
    svps: 0n, marketCap: 0n, restarts: 2, joinedWeek: 1, restartedWeek: 40, week: 90 },
];
const RANKED = [{ airlineId: 'a1' }, { airlineId: 'a2' }];
const STANDINGS = [
  { airlineId: 'a1', rank: 3 }, { airlineId: 'a1', rank: 1 },
  { airlineId: 'a2', rank: 2 },
];
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function runSnapshot(accounts = { acc1: {}, acc2: {}, acc3: {} }, opts = {}) {
  const db = fakePrisma({ airlines: AIRLINES, standings: STANDINGS, accounts });
  await snapshotWorldCareers(db, WORLD, {
    weekIndex: 156, ranked: RANKED,
    passengersById: new Map([['a1', 5_000_000], ['a2', 2_000_000]]),
    log: quiet, ...opts,
  });
  return db._accounts;
}

await (async () => {
  const accounts = await runSnapshot();

  test('the winner is recorded as the winner', () => {
    const c = serializeCareer(accounts.get('acc1'));
    assert.equal(c.totals.championships, 1);
    assert.equal(c.worlds[0].rank, 1);
    assert.equal(c.worlds[0].of, 2);
    assert.equal(c.worlds[0].passengers, 5_000_000);
    assert.ok(c.badges.some(b => b.id === 'champion'));
  });

  test('the best rank ever held is kept, not just the final one', () => {
    const c = serializeCareer(accounts.get('acc1'));
    assert.equal(c.worlds[0].bestRank, 1);
    assert.equal(serializeCareer(accounts.get('acc2')).worlds[0].bestRank, 2);
  });

  test('a bankrupt airline gets a record too — it still played the season', () => {
    // It is never ticked, so it appears in no `computed` array and in no
    // standing. Skipping it would erase the season AND the Phoenix badge.
    const c = serializeCareer(accounts.get('acc3'));
    assert.equal(c.totals.worldsFinished, 1);
    assert.equal(c.worlds[0].status, 'BANKRUPT');
    assert.equal(c.worlds[0].rank, null, 'it was not in the final standings');
    assert.equal(c.totals.refoundings, 2);
    assert.ok(c.badges.some(b => b.id === 'phoenix'));
  });

  test('weeks played counts from when the ACCOUNT joined', () => {
    assert.equal(serializeCareer(accounts.get('acc1')).worlds[0].weeksPlayed, 156);
    assert.equal(serializeCareer(accounts.get('acc2')).worlds[0].weeksPlayed, 137); // joined W20
  });

  test('running the snapshot again changes nothing', () => {
    // The backfill script and a retried tick can both land on a world that
    // already has a record.
    const before = JSON.parse(JSON.stringify([...accounts.entries()]));
    return runSnapshot(Object.fromEntries(accounts)).then((after) => {
      assert.deepEqual([...after.entries()], before);
    });
  });

  test('a missing account is skipped, not fatal to the rest of the world', () => {
    return runSnapshot({ acc1: {}, acc3: {} }).then((after) => {
      assert.equal(after.size, 2);
      assert.equal(serializeCareer(after.get('acc1')).totals.championships, 1);
    });
  });

  test('a second season stacks onto the first', () => {
    return runSnapshot(Object.fromEntries(accounts)).then(async (after) => {
      const db = fakePrisma({ airlines: AIRLINES, standings: STANDINGS, accounts: Object.fromEntries(after) });
      await snapshotWorldCareers(db, { ...WORLD, id: 'w2', name: 'Blitz Two' },
        { weekIndex: 156, ranked: RANKED, log: quiet });
      const c = serializeCareer(db._accounts.get('acc1'));
      assert.equal(c.totals.worldsFinished, 2);
      assert.equal(c.totals.championships, 2);
      assert.equal(c.worlds.length, 2);
    });
  });
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
