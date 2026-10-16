// Rankings rework (2026-10-15) — standings rank on average weekly NET PROFIT
// over the last 52 weeks, and the title goes to the best average over the
// final 52 weeks. Plus the live player list (weekly profit, net assets,
// pax/flights a week, fleet) and the "net profit" / "net cash flow" naming fix.
//
// HEAD failures this suite was written against (verified on a HEAD checkout):
//   - the tick ranked on SVPS, so an airline with a huge dividend record and a
//     year of losses out-ranked one making millions a week;
//   - private airlines were not ranked at all;
//   - nothing wrote live stats to the airline row, and the world page had no
//     sortable list;
//   - the Dashboard and the Cost Bridge called the cash change "Net profit".
//
//   node --import ./tools/_register-loader.mjs tools/standings-ranking-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { tickWorldOnce } from '../apps/headwinds-server/src/lib/tickService.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
// New modules are imported defensively so a HEAD checkout (where they don't
// exist) still runs the behaviour tests and fails them on their assertions.
const tryImport = async (p) => { try { return await import(p); } catch (e) { return { __err: e }; } };
const S = await tryImport('../packages/engine/src/utils/standings.js');
const V = await tryImport('../src/utils/standingsView.js');
const need = (m, what) => assert.equal(m.__err, undefined, `${what} is missing: ${m.__err?.message}`);

// ── Browser shims (the components read and write localStorage) ───────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; },
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

// ── Fake Prisma: the surface the tick touches (after tools/headwinds-tick-test) ─
function fakePrisma({ world, airlines, standings = [] }) {
  const db = { world: { ...world }, airlines: airlines.map((a) => ({ ...a })), tickLogs: [], standings: [...standings], news: [], credits: [] };
  const p = {
    _db: db,
    world: {
      findMany: async () => [{ ...db.world }],
      findUnique: async () => ({ ...db.world }),
      updateMany: async ({ where, data }) => {
        const w = db.world;
        if (!(w.id === where.id && w.currentWeek === where.currentWeek && w.currentYear === where.currentYear && w.status === where.status)) return { count: 0 };
        Object.assign(w, data); return { count: 1 };
      },
    },
    airline: {
      findMany: async ({ where = {} }) => db.airlines
        .filter((a) => a.worldId === where.worldId && (where.status == null || a.status === where.status)).map((a) => ({ ...a })),
      update: async ({ where, data }) => { const a = db.airlines.find((x) => x.id === where.id); Object.assign(a, data); return { ...a }; },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const a of db.airlines) {
          if (a.id !== where.id) continue;
          if (where.version !== undefined && (a.version ?? 0) !== where.version) continue;
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in v) a[k] = (a[k] ?? 0) + v.increment; else a[k] = v;
          }
          count++;
        }
        return { count };
      },
      count: async () => 0,
    },
    tickLog: { create: async ({ data }) => { db.tickLogs.push(data); return { id: 't', ...data }; }, update: async () => ({}) },
    standing: {
      createMany: async ({ data }) => { db.standings.push(...data); return { count: data.length }; },
      findMany: async ({ where = {} }) => db.standings
        .filter((r) => r.week === where.week && (where.rank?.lte == null || r.rank <= where.rank.lte))
        .sort((x, y) => x.rank - y.rank),
      groupBy: async ({ where = {} }) => {
        const m = new Map();
        for (const r of db.standings) {
          if (where.rank != null && r.rank !== where.rank) continue;
          if (where.week?.gte != null && r.week < where.week.gte) continue;
          m.set(r.airlineId, (m.get(r.airlineId) ?? 0) + 1);
        }
        return [...m].map(([airlineId, n]) => ({ airlineId, _count: { _all: n }, _min: { rank: 1 } }));
      },
    },
    worldMarket: { findUnique: async () => null, upsert: async ({ create }) => ({ id: 'm', ...create }), update: async () => null, updateMany: async () => ({ count: 0 }), create: async ({ data }) => data },
    dividendCredit: { findMany: async () => [], createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }) },
    worldNews: {
      createMany: async ({ data }) => { db.news.push(...data); return { count: data.length }; },
      create: async ({ data }) => { db.news.push(data); return data; },
      deleteMany: async () => ({ count: 0 }),
    },
    alliance: { findMany: async () => [] },
    account: { findUnique: async () => null, update: async () => null },
  };
  p.$transaction = async (fn) => fn(p);
  return p;
}
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

// A history row the way the reducer writes one (only the fields that matter).
const week = (profit, extra = {}) => ({ profit, loanPayments: 0, loanInterest: 0, depreciation: 0, ...extra });

const seedAirline = (id, name, hub, { history = [], isPublic = true, cumDivs = 0 } = {}) => {
  const state = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  state.equity = { ...state.equity, isPublic, cumDividendsPerShare: cumDivs };
  state.financialHistory = history;
  return { id, worldId: 'w1', accountId: `acct_${id}`, name, hub, state, status: 'ACTIVE', week: 1, version: 0, restarts: 0 };
};
const makeWorld = (over = {}) => ({
  id: 'w1', name: 'Test World', status: 'RUNNING', lengthYears: 50, weeksPerDay: 12,
  currentWeek: 10, currentYear: 2, tickConfig: {},
  startedAt: new Date(Date.now() - 1000 * 3600 * 1000), ...over,
});
const avgOf = (hist, window) => Math.round(hist.slice(-window).reduce((s, h) => s + h.profit + Math.max(0, (h.loanPayments ?? 0) - (h.loanInterest ?? 0)) - (h.depreciation ?? 0) - (h.leaseDepositReturned ?? 0), 0) / window);

console.log('\n── 1. Net profit: one definition ─────────────────────────────────────');

await test('net profit = cash change + loan principal − depreciation − deposits handed back', () => {
  need(S, 'utils/standings.js');
  const h = { profit: 1_000_000, loanPayments: 300_000, loanInterest: 100_000, depreciation: 50_000, leaseDepositReturned: 20_000 };
  assert.equal(S.netProfitOf(h), 1_000_000 + 200_000 - 50_000 - 20_000);
  // A row from before interest was recorded: no split, so no principal add-back.
  assert.equal(S.netProfitOf({ profit: 500, loanPayments: 900 }), 500);
});

await test('over a real week, net profit is exactly the change in net assets (Balance Sheet equity)', () => {
  need(S, 'utils/standings.js');
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 2e9 };
  for (let i = 0; i < 4; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of ['ORD', 'LAX']) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet.at(-1).id, origin: 'JFK', destination: d, weeklyFrequency: 14 });
  }
  s = { ...s, fleet: s.fleet.map((a) => ({ ...a, ownershipType: 'owned', ageWeeks: 100 })) };
  // A loan on the books (built directly: TAKE_LOAN's credit gates are not
  // what this test is about). Standard amortising schedule.
  const r = 0.08 / 52, n = 104, P = 20_000_000;
  s = { ...s, loans: [{ id: 'L1', productId: 'short', label: 'Test loan', principal: P, interestRate: 0.08,
    termWeeks: n, weeksRemaining: n, weeklyPayment: Math.round(P * r / (1 - Math.pow(1 + r, -n))) }] };
  assert.ok((s.loans ?? []).length > 0, 'fixture should carry a loan, or principal is never exercised');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const before = S.netAssetsOf(s);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const h = s.financialHistory.at(-1);
  assert.ok(h.depreciation > 0 && h.loanPayments > h.loanInterest, 'week should carry depreciation and principal');
  const delta = S.netAssetsOf(s) - before;
  // Rounding: book value and loan balance are each rounded per item.
  assert.ok(Math.abs(delta - S.netProfitOf(h)) <= 10,
    `net assets moved ${delta} but net profit says ${S.netProfitOf(h)} (cash change ${h.profit})`);
});

console.log('\n── 2. The ranking score ──────────────────────────────────────────────');

await test('average over the last 52 weeks; weeks not flown count as $0', () => {
  need(S, 'utils/standings.js');
  const year = Array.from({ length: 60 }, (_, i) => week(i < 8 ? 9e9 : 1_000_000)); // old huge weeks fall out
  assert.equal(S.rankingScore({ financialHistory: year }, 200), 1_000_000);
  const late = Array.from({ length: 10 }, () => week(4_000_000));
  assert.equal(S.rankingScore({ financialHistory: late }, 200), Math.round(40_000_000 / 52),
    'a ten-week hot streak is ten weeks over fifty-two');
  assert.equal(S.rankingScore({ financialHistory: late }, 10), 4_000_000,
    'in a world only ten weeks old, the window is ten weeks');
});

await test('the final stretch: the last 52 weeks of a world are flagged, with weeks left', () => {
  need(S, 'utils/standings.js');
  assert.deepEqual(
    { ...S.finalStretchOf({ totalWeeks: 520, weeksFlown: 467 }) },
    { inFinalStretch: false, weeksLeft: 53, weeksUntilFinalStretch: 1, ended: false });
  const f = S.finalStretchOf({ totalWeeks: 520, weeksFlown: 468 });
  assert.equal(f.inFinalStretch, true); assert.equal(f.weeksLeft, 52);
  assert.equal(S.finalStretchOf({ totalWeeks: 520, weeksFlown: 520 }).ended, true);
});

console.log('\n── 3. The tick ranks on it ───────────────────────────────────────────');

// A: a year of losses, but an enormous dividend record (so its SVPS towers).
// B: a full year at +$1M a week.  C: joined ten weeks ago at +$4M a week.
// D: private, a full year at +$2M a week.
const histA = Array.from({ length: 51 }, () => week(-500_000));
const histB = Array.from({ length: 51 }, () => week(1_000_000));
const histC = Array.from({ length: 9 }, () => week(4_000_000));
const histD = Array.from({ length: 51 }, () => week(2_000_000));
const fourAirlines = () => [
  seedAirline('a', 'Alpha', 'JFK', { history: histA, cumDivs: 5000 }),
  seedAirline('b', 'Bravo', 'LAX', { history: histB }),
  seedAirline('c', 'Charlie', 'ORD', { history: histC, cumDivs: 2500 }),
  seedAirline('d', 'Delta Private', 'MIA', { history: histD, isPublic: false }),
];

const p1 = fakePrisma({ world: makeWorld(), airlines: fourAirlines() });
const r1 = await tickWorldOnce(p1, makeWorld(), { log: quiet });

await test('the tick committed', () => { assert.equal(r1.ok, true, JSON.stringify(r1)); });

await test('standings order is average weekly net profit — not SVPS', () => {
  const order = p1._db.standings.filter((r) => r.week === 63).sort((x, y) => x.rank - y.rank).map((r) => r.airlineId);
  assert.deepEqual(order, ['d', 'b', 'c', 'a'],
    'D (+$2M/wk, private) then B (+$1M/wk) then C (10 weeks at +$4M, padded to 52) then A (losses, huge SVPS)');
});

await test('private airlines are ranked (profit needs no share price)', () => {
  assert.ok(p1._db.standings.some((r) => r.airlineId === 'd' && r.week === 63), 'the private airline has no standing row');
});

await test('Standing.score and the airline row carry the 52-week average, in dollars', () => {
  for (const id of ['a', 'b', 'c', 'd']) {
    const a = p1._db.airlines.find((x) => x.id === id);
    const expected = avgOf(a.state.financialHistory, 52);
    assert.equal(typeof a.rankScore, 'bigint', `${id}: rankScore column not written`);
    assert.equal(Number(a.rankScore), expected, `${id}: rankScore`);
    const row = p1._db.standings.find((r) => r.airlineId === id && r.week === 63);
    assert.equal(Number(row.score), expected, `${id}: Standing.score`);
  }
});

await test('the live stat columns are written from the blob every tick', () => {
  const b = p1._db.airlines.find((x) => x.id === 'b');
  const last = b.state.financialHistory.at(-1);
  const stat = b.state.statsHistory.at(-1);
  assert.equal(Number(b.weeklyProfit), last.profit + Math.max(0, last.loanPayments - last.loanInterest) - last.depreciation - (last.leaseDepositReturned ?? 0));
  assert.equal(typeof b.netAssets, 'bigint');
  assert.equal(b.paxWeek, Math.round((stat.paxOrganic ?? 0) + (stat.paxConnecting ?? 0) + (stat.paxInterline ?? 0)));
  assert.equal(b.flightsWeek, Math.round(stat.flights ?? 0));
  assert.equal(b.fleetSize, b.state.fleet.filter((f) => f.status !== 'retired').length);
});

await test('a running world switching rules: stamped, announced once, no fake top-5 reshuffle', () => {
  assert.equal(p1._db.world.tickConfig.rankingSince, 63);
  const kinds = p1._db.news.map((n) => n.kind);
  assert.ok(kinds.includes('ranking_changed'), 'no announcement of the new ranking');
  assert.ok(!kinds.includes('rank_change'), 'diffing an SVPS top 5 against a profit top 5 announces moves nobody made');
});

await test('the announcement reads as a sentence in the news feed', async () => {
  const { compose } = await import('../src/components/News.jsx');
  const row = p1._db.news.find((n) => n.kind === 'ranking_changed');
  const c = compose({ kind: row?.kind, data: row?.payload ?? {} });
  assert.match(c.headline, /average weekly net profit/);
  assert.match(c.sub, /final 52 weeks wins/);
});

await test('a brand-new world starts on the new rules silently', async () => {
  const w = makeWorld({ currentWeek: 1, currentYear: 1 });
  const p = fakePrisma({ world: w, airlines: [seedAirline('b', 'Bravo', 'LAX')] });
  await tickWorldOnce(p, w, { log: quiet });
  assert.equal(p._db.world.tickConfig.rankingSince, 0);
  assert.ok(!p._db.news.some((n) => n.kind === 'ranking_changed'));
});

await test('the final tick crowns the best average over the final 52 weeks', async () => {
  const w = makeWorld({ lengthYears: 2, currentYear: 2, currentWeek: 52, tickConfig: { rankingSince: 0 } });
  const airlines = fourAirlines();
  for (const a of airlines) a.state = { ...a.state, year: 2, week: 52 };
  const p = fakePrisma({ world: w, airlines });
  const res = await tickWorldOnce(p, w, { log: quiet });
  assert.equal(res.ended, true);
  const ended = p._db.news.find((n) => n.kind === 'world_ended');
  assert.ok(ended, 'no world_ended row');
  assert.equal(ended.payload.championId, 'd');
  assert.equal(ended.payload.podium[0].avgProfit, avgOf(p._db.airlines.find((x) => x.id === 'd').state.financialHistory, 52));
});

console.log('\n── 4. Rivals carry the same numbers into the game ────────────────────');

await test('a rival competitor carries its standing row and a net-profit series', async () => {
  const { toHumanCompetitor, withRivals, stripRivals } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
  const row = { ...seedAirline('b', 'Bravo', 'LAX', { history: [week(100, { loanPayments: 50, loanInterest: 10, depreciation: 30 })] }),
    rankScore: 123n, weeklyProfit: 120n, netAssets: 9_000_000n, paxWeek: 4000, flightsWeek: 70, fleetSize: 6,
    account: { isOG: false, isSupporter: false, email: null } };
  const c = toHumanCompetitor(row);
  assert.deepEqual(c.standing, { rankScore: 123, weeklyProfit: 120, netAssets: 9_000_000, paxWeek: 4000, flightsWeek: 70, fleetSize: 6 });
  assert.deepEqual(c.netProfitHistory, [100 + 40 - 30]);
  assert.deepEqual(c.profitHistory, [100], 'profitHistory (an engine input) must stay the cash series');
  const injected = withRivals(row.state, { competitors: [], selfStanding: c.standing });
  assert.deepEqual(injected.selfStanding, c.standing);
  assert.ok(!('selfStanding' in stripRivals(injected)), 'selfStanding must never be persisted into the blob');
});

console.log('\n── 5. The screens ────────────────────────────────────────────────────');

const rows = [
  { id: 'b', rank: 1, name: 'Bravo', hub: 'LAX', status: 'ACTIVE', avgProfit: 2_000_000, weeklyProfit: -50_000, netAssets: 10e6, paxWeek: 900, flightsWeek: 40, fleetSize: 3 },
  { id: 'a', rank: 2, name: 'Alpha', hub: 'JFK', status: 'ACTIVE', avgProfit: 1_000_000, weeklyProfit: 3_000_000, netAssets: 90e6, paxWeek: 50_000, flightsWeek: 400, fleetSize: 30 },
  { id: 'c', rank: 3, name: 'Charlie', hub: 'ORD', status: 'ACTIVE', avgProfit: -10_000, weeklyProfit: null, netAssets: null, paxWeek: null, flightsWeek: null, fleetSize: 1 },
];

await test('sorting reorders by the stat, best first, missing values last; rank never renumbers', () => {
  need(V, 'utils/standingsView.js');
  assert.deepEqual(V.sortStandings(rows, 'rank').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(V.sortStandings(rows, 'netAssets').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(V.sortStandings(rows, 'weeklyProfit').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(V.sortStandings(rows, 'paxWeek', 'asc').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(V.sortStandings(rows, 'netAssets').map((r) => r.rank), [2, 1, 3]);
});

const tableMod = await tryImport('../apps/headwinds-web/src/StandingsTable.jsx');
const renderTable = (props) => renderToString(React.createElement(tableMod.default, {
  world: { id: 'w1', status: 'RUNNING' }, standings: rows,
  ranking: { metric: 'avgWeeklyNetProfit', inFinalStretch: true, weeksLeft: 12, weeksUntilFinalStretch: 0, ended: false },
  ...props,
}));
const rowOrder = (html) => [...html.matchAll(/data-airline-id="([^"]+)"/g)].map((m) => m[1]);

await test('world page: the player list shows every stat column and the rule', () => {
  need(tableMod, 'StandingsTable.jsx');
  const html = renderTable({});
  for (const label of ['Avg profit', 'Weekly profit', 'Net assets', 'Pax / wk', 'Flights / wk', 'Fleet']) {
    assert.ok(html.includes(label), `missing column ${label}`);
  }
  assert.ok(html.includes('best average over the final 52 weeks wins'), 'the win rule is not stated');
  assert.ok(html.includes('Final stretch: 12 weeks left'), 'the final stretch is not flagged');
  assert.ok(html.includes('−$50k'), 'a loss should print with a minus sign');
});

await test('world page: sorting by net assets reorders the rendered rows', () => {
  need(tableMod, 'StandingsTable.jsx');
  assert.deepEqual(rowOrder(renderTable({ sort: { key: 'rank', dir: 'desc' } })), ['b', 'a', 'c']);
  const html = renderTable({ sort: { key: 'netAssets', dir: 'desc' } });
  assert.deepEqual(rowOrder(html), ['a', 'b', 'c']);
  assert.match(html, /data-sort-key="netAssets"[^>]*>|aria-sort="descending"/);
});

await test('world page: a season decided on SVPS still says so and keeps its column', () => {
  need(tableMod, 'StandingsTable.jsx');
  const html = renderTable({ world: { id: 'w1', status: 'ENDED' }, ranking: { metric: 'svps' } });
  assert.ok(html.includes('decided on shareholder value per share'));
  assert.ok(html.includes('>SVPS<'));
});

await test('in game: the Rivals standings rank on the server numbers, not market cap', async () => {
  const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');
  const Competition = (await import('../src/components/Competition.jsx')).default;
  const me = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Me Air', hub: 'SEA', enableObjectives: false });
  const rival = (id, name, rankScore, marketCap) => ({
    id, name, human: true, homeHub: 'BOS', tier: 'legacy', logoId: 'compass', baseQualityScore: 60,
    cash: 1e6, marketCap, routes: {}, profitHistory: [], netProfitHistory: [],
    standing: { rankScore, weeklyProfit: rankScore, netAssets: 5e6, paxWeek: 10, flightsWeek: 2, fleetSize: 1 },
  });
  const state = {
    ...me, multiplayer: true,
    selfStanding: { rankScore: 500_000, weeklyProfit: 1, netAssets: 1, paxWeek: 1, flightsWeek: 1, fleetSize: 1 },
    competitors: [rival('r1', 'Rich But Losing', -100_000, 9e12), rival('r2', 'Small Earner', 900_000, 1e6)],
  };
  const html = renderToString(React.createElement(RemoteGameProvider, { state, dispatch: () => {} }, React.createElement(Competition)));
  assert.ok(html.includes('Average weekly profit (52 wks)'), 'still the market-cap board');
  const at = (s) => html.indexOf(s);
  assert.ok(at('Small Earner') < at('Me Air') && at('Me Air') < at('Rich But Losing'),
    'order should be Small Earner, Me Air, Rich But Losing');
});

await test('the Dashboard calls the cash change "Net cash flow" and shows net profit below it', async () => {
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  const Dashboard = (await import('../src/components/Dashboard.jsx')).default;
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 1e9 };
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet.at(-1).id, origin: 'JFK', destination: 'ORD', weeklyFrequency: 14 });
  s = { ...s, fleet: s.fleet.map((a) => ({ ...a, ownershipType: 'owned', ageWeeks: 50 })) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  store.set('bbae_save_v2', JSON.stringify(s));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(Dashboard))).replace(/&amp;/g, '&');
  const net = html.match(/data-pnl-row="net" data-pnl-kind="total"[^>]*>([^<]*)/);
  assert.ok(net, 'no net row'); assert.equal(net[1].trim(), 'Net cash flow');
  const np = html.match(/data-pnl-col="lw" data-pnl-row="netProfit" data-pnl-kind="result" data-pnl-exact="(-?\d+)"/);
  assert.ok(np, 'no Net profit (accrual) row under the cash line');
  if (S.netProfitOf) assert.equal(Number(np[1]), S.netProfitOf(s.financialHistory.at(-1)));
  assert.ok(html.includes('Projected Net Profit / wk'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
