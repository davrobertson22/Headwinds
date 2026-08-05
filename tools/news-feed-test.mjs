// World news feed test — no database, no network.
//
// Covers the three things players complained about, plus the privacy boundary:
//
//   1. Aircraft counts survive the public scrubber (a 12-frame order says 12).
//   2. Related moves ROLL UP — eight route openings are one item, not eight.
//   3. "Joined the world" cannot flood the page.
//   4. Nothing private crosses into a public payload.
//
//   node tools/news-feed-test.mjs

import assert from 'node:assert/strict';
import {
  PUBLIC_DECISIONS, publicPayload,
} from '../apps/headwinds-server/src/lib/publicDecisions.mjs';
import {
  buildNews, newsWindow, yearWeek, NEWS_WINDOW_WEEKS,
  worldEventNewsRows, bankruptcyNewsRows, rankChangeNewsRows,
} from '../apps/headwinds-server/src/lib/newsService.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// ── A prisma stand-in ────────────────────────────────────────────────────────
// Honours only the clauses buildNews actually uses: week.gte and the
// createdAt/soldAt range. That is enough to prove windowing and pagination.
const WORLD = {
  id: 'w1', currentWeek: 20, currentYear: 2, weeksPerDay: 6, endedAt: null,
};

// Anchor "minutes ago" to the RUN's own clock, not a hardcoded instant. The
// original fixed T0 (2026-07-27T12:00Z) rotted in real time: the news window
// and week-fold arithmetic compare row timestamps against the wall clock, so a
// week after it was written the fixture rows aged out of their buckets and two
// tests started failing on every machine, at certain hours, with no code
// change at all.
const T0 = Date.now();
const ago = (mins) => new Date(T0 - mins * 60_000);

function matches(row, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'worldId' || k === 'status' || k === 'category' || k === 'type' || k === 'role' || k === 'alliance') {
      if (k === 'type' && v?.in && !v.in.includes(row.type)) return false;
      if (k === 'category' && v?.in && !v.in.includes(row.category)) return false;
      if (k === 'role' && v?.not && row.role === v.not) return false;
      continue;
    }
    if (k === 'week' && v?.gte != null && !(row.week >= v.gte)) return false;
    if ((k === 'createdAt' || k === 'soldAt')) {
      const at = row[k];
      if (v?.gte && !(at >= v.gte)) return false;
      if (v?.lt && !(at < v.lt)) return false;
    }
  }
  return true;
}

function table(rows) {
  return {
    // Mirrors prisma: filter, then order by the requested timestamp desc, then take.
    findMany: async ({ where = {}, take = 1000, orderBy } = {}) => {
      const field = orderBy ? Object.keys(orderBy)[0] : null;
      const hit = rows.filter((r) => matches(r, where));
      if (field) hit.sort((a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0));
      return hit.slice(0, take);
    },
  };
}

function makePrisma({ decisions = [], airlines = [], alliances = [], members = [], auctions = [], listings = [], used = [], news = [] }) {
  return {
    decision: table(decisions),
    airline: table(airlines),
    alliance: table(alliances),
    allianceMember: table(members),
    gateAuction: table(auctions),
    gateListing: table(listings),
    usedAircraftListing: table(used),
    worldNews: table(news),
  };
}

const AIRLINES = [
  { id: 'a1', name: 'Sky Blue', hub: 'DEN', createdAt: ago(60 * 24 * 30), joinedWeek: 1, account: { isOG: false, email: 'a@x.com' } },
  { id: 'a2', name: 'Condor Air', hub: 'ORD', createdAt: ago(60 * 24 * 29), joinedWeek: 1, account: { isOG: false, email: 'b@x.com' } },
];

const dec = (over) => ({
  id: over.id, worldId: 'w1', airlineId: 'a1', week: 72, type: 'ADD_ROUTE',
  payload: {}, createdAt: ago(over.mins ?? 10), ...over,
});

console.log('\nWorld news feed\n');

// ── The scrubber ─────────────────────────────────────────────────────────────
await test('a multi-frame order keeps its count (the reported bug)', () => {
  const p = publicPayload({ payload: { typeId: 'b738', quantity: 12 } });
  assert.equal(p.quantity, 12, 'quantity must survive the scrubber');
  assert.equal(p.typeId, 'b738');
});

await test('a single-frame order omits the count so it reads naturally', () => {
  assert.equal(publicPayload({ payload: { typeId: 'b738', quantity: 1 } }).quantity, undefined);
});

await test('an absurd quantity is clamped to the reducer range', () => {
  assert.equal(publicPayload({ payload: { quantity: 5000 } }).quantity, 100);
});

await test('nothing private crosses the boundary', () => {
  const p = publicPayload({
    payload: {
      origin: 'SFO', destination: 'JFK',
      cash: 99_000_000, loanAmount: 5_000_000, marketingBudget: 250_000,
      ticketPrice: 412, classPrices: { economy: 412 }, hedgeCoverage: 0.5,
      routeId: 'r-secret', aircraftId: 'ac-secret',
    },
  });
  assert.deepEqual(Object.keys(p).sort(), ['destination', 'origin']);
});

await test('the allowlist matches what multiplayer can actually do', () => {
  // LEASE_AIRCRAFT is not an allowed MP action, so listing it only misled.
  assert.ok(!PUBLIC_DECISIONS.has('LEASE_AIRCRAFT'));
  // Moving routes between two of YOUR OWN tails changes nothing publicly.
  assert.ok(!PUBLIC_DECISIONS.has('TRANSFER_ROUTES'));
  // Share dealings print — Headwinds runs a full public tape.
  assert.ok(PUBLIC_DECISIONS.has('BUY_STOCK') && PUBLIC_DECISIONS.has('SELL_STOCK'));
  // Tag routes are routes.
  assert.ok(PUBLIC_DECISIONS.has('ADD_TAG_ROUTE'));
});

// ── Rollup ───────────────────────────────────────────────────────────────────
await test('eight route openings in one week are ONE item', async () => {
  const pairs = [['DEN', 'BOI'], ['DEN', 'TUS'], ['DEN', 'OKC'], ['DEN', 'MSO'],
                 ['DEN', 'BIL'], ['DEN', 'FCA'], ['DEN', 'RAP'], ['DEN', 'CPR']];
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: pairs.map(([o, d], i) => dec({
      id: `d${i}`, mins: 10 + i,
      payload: { origin: o, destination: d },
    })),
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['routes'] });
  assert.equal(items.length, 1, `expected 1 rolled item, got ${items.length}`);
  assert.equal(items[0].kind, 'routes_opened');
  assert.equal(items[0].data.total, 8);
  assert.equal(items[0].data.commonOrigin, 'DEN', 'all eight share an origin');
  assert.equal(items[0].detail.length, 8, 'the individual routes stay available');
});

// The reported bug: "Otter Air opened 4 routes from JFK · JFK–LHR, JFK–LHR,
// JFK–LHR, JFK–NRT". Three tails on one pair is three route RECORDS but one
// route, so the feed must count city pairs and fold the repeats into a count.
await test('repeat openings on one pair count ONCE, with a count', async () => {
  const pairs = [['JFK', 'LHR'], ['JFK', 'LHR'], ['JFK', 'LHR'], ['JFK', 'NRT']];
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: pairs.map(([o, d], i) => dec({
      id: `d${i}`, mins: 10 + i,
      payload: { origin: o, destination: d },
    })),
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['routes'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].data.total, 2, 'two city pairs, not four decisions');
  assert.equal(items[0].data.services, 4, 'all four services stay countable');
  assert.equal(items[0].data.commonOrigin, 'JFK');
  assert.deepEqual(items[0].data.pairs, [
    { origin: 'JFK', destination: 'LHR', count: 3 },
    { origin: 'JFK', destination: 'NRT', count: 1 },
  ]);
});

// A pair is a pair whichever way it was entered — same rule as the Routes page
// airport filter. The first orientation seen labels the line.
await test('reverse openings fold into the same pair', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'd0', mins: 10, payload: { origin: 'JFK', destination: 'LHR' } }),
      dec({ id: 'd1', mins: 11, payload: { origin: 'LHR', destination: 'JFK' } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['routes'] });
  assert.equal(items[0].data.total, 1);
  assert.deepEqual(items[0].data.pairs, [{ origin: 'JFK', destination: 'LHR', count: 2 }]);
});

// A batched close journals `count` even when its pair list was trimmed at 20.
// Pairs we cannot see are assumed distinct — never under-report the move.
await test('a trimmed batch close still reports its declared size', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [dec({
      id: 'd0', mins: 10, type: 'CLOSE_ROUTES',
      payload: {
        count: 25,
        routes: [
          { origin: 'DEN', destination: 'BOI' },
          { origin: 'DEN', destination: 'BOI' },
          { origin: 'DEN', destination: 'TUS' },
        ],
      },
    })],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['routes'] });
  assert.equal(items[0].kind, 'routes_closed');
  assert.equal(items[0].data.services, 25);
  assert.equal(items[0].data.total, 2 + 22, 'two visible pairs plus the unseen remainder');
});

await test('the same moves in DIFFERENT weeks stay separate items', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'd1', week: 72, mins: 10, payload: { origin: 'DEN', destination: 'BOI' } }),
      dec({ id: 'd2', week: 71, mins: 400, payload: { origin: 'DEN', destination: 'TUS' } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['routes'] });
  assert.equal(items.length, 2);
});

await test('orders roll up by type and sum their frames', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'o1', type: 'ORDER_AIRCRAFT', mins: 5, payload: { typeId: 'b738', quantity: 8 } }),
      dec({ id: 'o2', type: 'ORDER_AIRCRAFT', mins: 6, payload: { typeId: 'b738', quantity: 4 } }),
      dec({ id: 'o3', type: 'ORDER_AIRCRAFT', mins: 7, payload: { typeId: 'b789', quantity: 2 } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['fleet'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].data.total, 14);
  assert.equal(items[0].data.byType.b738, 12);
  assert.equal(items[0].data.byType.b789, 2);
  assert.equal(items[0].tier, 1, 'a fourteen-frame order is headline news');
});

await test('gates roll per airport, not into one lump', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'g1', type: 'ADD_GATE', mins: 5, payload: { airportCode: 'ORD' } }),
      dec({ id: 'g2', type: 'ADD_GATE', mins: 6, payload: { airportCode: 'ORD' } }),
      dec({ id: 'g3', type: 'ADD_GATE', mins: 7, payload: { airportCode: 'DEN' } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['airports'] });
  assert.equal(items.length, 2);
  const ord = items.find((i) => i.data.airportCode === 'ORD');
  assert.equal(ord.data.total, 2);
});

await test('hub designations are never rolled away', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'h1', type: 'DESIGNATE_HUB', mins: 5, payload: { airportCode: 'ORD' } }),
      dec({ id: 'h2', type: 'UPGRADE_HUB', mins: 6, payload: { airportCode: 'DEN' } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['airports'] });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.tier === 1));
});

// ── The stock tape ───────────────────────────────────────────────────────────
await test("a week's scale-in is one tape line with the net size", async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 's1', type: 'BUY_STOCK', mins: 9, payload: { targetId: 'a2', targetName: 'Condor Air', shares: 2_000_000, value: 400_000, pricePerShare: 0.2, stakePctBefore: 0, stakePct: 2 } }),
      dec({ id: 's2', type: 'BUY_STOCK', mins: 8, payload: { targetId: 'a2', targetName: 'Condor Air', shares: 2_000_000, value: 400_000, pricePerShare: 0.2, stakePctBefore: 2, stakePct: 4 } }),
      dec({ id: 's3', type: 'BUY_STOCK', mins: 7, payload: { targetId: 'a2', targetName: 'Condor Air', shares: 2_000_000, value: 400_000, pricePerShare: 0.2, stakePctBefore: 4, stakePct: 6 } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['stocks'] });
  assert.equal(items.length, 1, 'three buys in one name in one week are one line');
  assert.equal(items[0].data.netShares, 6_000_000);
  assert.equal(items[0].data.stakePct, 6);
  assert.equal(items[0].data.crossedThreshold, true, '0% → 6% crosses the 5% disclosure line');
  assert.equal(items[0].tier, 1);
});

await test('an ordinary trade below a threshold is not headline news', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 's1', type: 'BUY_STOCK', mins: 9, payload: { targetId: 'a2', shares: 100_000, value: 20_000, stakePctBefore: 1, stakePct: 1.1 } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['stocks'] });
  assert.equal(items[0].tier, 2);
  assert.equal(items[0].data.crossedThreshold, false);
});

await test('a rejected trade prints nothing at all', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [dec({ id: 's1', type: 'BUY_STOCK', mins: 9, payload: { targetId: 'a2', shares: 0 } })],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['stocks'] });
  assert.equal(items.length, 0, 'a no-op must not appear as a trade');
});

// ── Joins can no longer flood ────────────────────────────────────────────────
await test('a full world does not fill the page with old joins', async () => {
  // 40 airlines that joined a month ago, plus this week's actual news.
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `p${i}`, name: `Airline ${i}`, hub: 'LAX',
    createdAt: ago(60 * 24 * 40), joinedWeek: 1,
    account: { isOG: false, email: `p${i}@x.com` },
  }));
  const prisma = makePrisma({
    airlines: [...AIRLINES, ...many],
    decisions: [dec({ id: 'd1', mins: 5, payload: { origin: 'DEN', destination: 'BOI' } })],
  });
  const { items } = await buildNews(prisma, { world: WORLD, limit: 40 });
  const joins = items.filter((i) => i.kind === 'joined');
  assert.equal(joins.length, 0, 'joins from before the news window must not appear');
  assert.ok(items.some((i) => i.kind === 'routes_opened'), 'this week\'s news is present');
});

await test('a recent join IS news, and sits at background tier', async () => {
  const prisma = makePrisma({
    airlines: [...AIRLINES, {
      id: 'p1', name: 'New Co', hub: 'LAX', createdAt: ago(30), joinedWeek: 72,
      account: { isOG: false, email: 'n@x.com' },
    }],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['players'] });
  const join = items.find((i) => i.kind === 'joined');
  assert.ok(join, 'a fresh join appears');
  assert.equal(join.tier, 3);
  assert.equal(join.airline, 'New Co');
});

// ── Window, tiering and paging ───────────────────────────────────────────────
await test('news older than the window is unreachable', async () => {
  const { minWeek } = newsWindow(WORLD);
  assert.equal(minWeek, (2 - 1) * 52 + 20 - NEWS_WINDOW_WEEKS);
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'old', week: minWeek - 1, mins: 11, payload: { origin: 'AAA', destination: 'BBB' } }),
      dec({ id: 'new', week: minWeek + 1, mins: 10, payload: { origin: 'CCC', destination: 'DDD' } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['routes'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].detail[0].origin, 'CCC');
});

await test('an ended world keeps its final year readable', () => {
  const live = newsWindow({ ...WORLD, endedAt: null });
  const ended = newsWindow({ ...WORLD, endedAt: new Date(T0 - 90 * 86_400_000) });
  assert.ok(ended.minAt < live.minAt, 'an ended world anchors its window on when it ended');
});

await test('tier=1 returns only headlines', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'r1', mins: 5, payload: { origin: 'DEN', destination: 'BOI' } }),           // tier 2
      dec({ id: 'h1', type: 'DESIGNATE_HUB', mins: 6, payload: { airportCode: 'ORD' } }),   // tier 1
    ],
  });
  const all = await buildNews(prisma, { world: WORLD });
  const big = await buildNews(prisma, { world: WORLD, tier: 1 });
  assert.equal(all.items.length, 2);
  assert.equal(big.items.length, 1);
  assert.equal(big.items[0].kind, 'hub_designated');
});

await test('paging never repeats an item id', async () => {
  const decisions = Array.from({ length: 12 }, (_, i) => dec({
    id: `d${i}`, week: 72 - i, mins: 10 + i * 60,
    payload: { origin: 'DEN', destination: `X${i}` },
  }));
  const prisma = makePrisma({ airlines: AIRLINES, decisions });
  const p1 = await buildNews(prisma, { world: WORLD, categories: ['routes'], limit: 5 });
  assert.equal(p1.items.length, 5);
  assert.ok(p1.nextBefore, 'a full page offers another');
  const p2 = await buildNews(prisma, { world: WORLD, categories: ['routes'], limit: 5, before: p1.nextBefore });
  const ids = new Set(p1.items.map((i) => i.id));
  assert.ok(p2.items.every((i) => !ids.has(i.id)), 'no id appears on both pages');
});

await test('the last page reports itself as the end', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [dec({ id: 'd1', mins: 5, payload: { origin: 'DEN', destination: 'BOI' } })],
  });
  const { nextBefore } = await buildNews(prisma, { world: WORLD, limit: 40 });
  assert.equal(nextBefore, null);
});

await test('category filters are honoured', async () => {
  const prisma = makePrisma({
    airlines: AIRLINES,
    decisions: [
      dec({ id: 'r1', mins: 5, payload: { origin: 'DEN', destination: 'BOI' } }),
      dec({ id: 'f1', type: 'BUY_AIRCRAFT', mins: 6, payload: { typeId: 'b738' } }),
    ],
  });
  const { items } = await buildNews(prisma, { world: WORLD, categories: ['fleet'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'fleet');
});

// ── Rows the tick writes ─────────────────────────────────────────────────────
await test('world events produce start and end news exactly once', () => {
  const prev = [{ id: 'e1', name: 'Fuel Price Spike', icon: '⛽' }];
  const next = [{ id: 'e2', name: 'Regional Recession', icon: '📉' }];
  const rows = worldEventNewsRows({ worldId: 'w1', week: 72, prevEvents: prev, nextEvents: next });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.kind === 'event_started').length, 1);
  assert.equal(rows.filter((r) => r.kind === 'event_ended').length, 1);
  // A surviving event is neither started nor ended.
  const same = worldEventNewsRows({ worldId: 'w1', week: 72, prevEvents: prev, nextEvents: prev });
  assert.equal(same.length, 0);
});

await test('only top-5 movement is newsworthy', () => {
  // A shuffle deep in the field produces nothing.
  const deep = rankChangeNewsRows({
    worldId: 'w1', week: 72,
    prevTop5: ['a', 'b', 'c', 'd', 'e'],
    nextTop5: ['b', 'a', 'c', 'e', 'd'],
    nameOf: new Map(),
  });
  assert.equal(deep.length, 0, 'reordering INSIDE the top 5 is not news');

  const swap = rankChangeNewsRows({
    worldId: 'w1', week: 72,
    prevTop5: ['a', 'b', 'c', 'd', 'e'],
    nextTop5: ['a', 'b', 'c', 'd', 'f'],
    nameOf: new Map([['f', 'Newcomer']]),
  });
  assert.equal(swap.length, 2);
  assert.equal(swap.find((r) => r.payload.direction === 'in').airlineId, 'f');
  assert.equal(swap.find((r) => r.payload.direction === 'out').airlineId, 'e');
});

await test('a bankruptcy is one headline row', () => {
  const rows = bankruptcyNewsRows({
    worldId: 'w1', week: 72,
    bankrupt: [{ airlineId: 'a9', name: 'Meridian', routes: 22, fleet: 14 }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 1);
  assert.equal(rows[0].payload.routes, 22);
});

await test('week labels map back to year and week', () => {
  assert.deepEqual(yearWeek(1), { year: 1, week: 1 });
  assert.deepEqual(yearWeek(52), { year: 1, week: 52 });
  assert.deepEqual(yearWeek(53), { year: 2, week: 1 });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
