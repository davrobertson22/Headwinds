// Market development in Headwinds (engine models/marketDev.js; Tailwinds
// docs/market-development-design.md). The engine half is the same model as
// Tailwinds; what is Headwinds' own:
//   - new worlds only: tickConfig.marketDev (default ON), baked into every
//     airline at join as marketDevWorld, re-stamped by the tick;
//   - D is the WORLD's: one WorldMarketDev table, advanced ONCE a week by the
//     server tick from every airline's service, in the commit with the clock;
//   - the rival overlay injects the table into every state (tick, decisions,
//     client) and stripRivals keeps it out of the blobs;
//   - no AI airlines, so a new world opens with every pair at the 70% floor.
//
//   node tools/run-tests.mjs market-dev

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MARKET_DEV_FLOOR, MARKET_DEV_CEIL, MARKET_DEV_REF_FREQ, marketDevTarget, marketDevFareTerm, stepMarketDev,
  marketDevKey, collectPairService, collectWorldService, advanceMarketDevPairs, advanceMarketDev, cleanMarketDev,
  setMarketDev, marketDevFor, marketDevForOD, marketDevActive,
} from '../packages/engine/src/models/marketDev.js';
import { buildRouteMarket, pairDemandNow, computeMarketShare, computeCompetitorRoutePnL } from '../packages/engine/src/models/demand.js';
import { baseCityPairDemand, referencePrice } from '../packages/engine/src/utils/market.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { weeklyTick } from '../packages/engine/src/utils/simulation.js';
import { createWorld, seedAirlineState } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { serializeWorld, validateWorldConfig } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { rivalOverlay, stripRivals, withRivals, buildWorldRivalViews } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { tickWorldOnce } from '../apps/headwinds-server/src/lib/tickService.mjs';

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);
const realRandom = Math.random;
function seedRandom(seed) {
  let x = seed >>> 0;
  Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
const on  = (pairs = {}) => ({ marketDevWorld: true, marketDev: { v: 1, pairs } });
const gd  = { week: 20, month: 5, absWeek: 20 };
const pool = (m) => m.leisureDemand + m.businessDemand;

console.log('\nMarket development\n');
console.log('── 1. The curve ──────────────────────────────────────────────');

await t('13 departures a week at the reference fare target exactly 1.0; no service targets the floor', () => {
  assert.equal(MARKET_DEV_REF_FREQ, 13);
  near(marketDevTarget(13, 1), 1.0, 1e-9);
  assert.equal(marketDevTarget(0), MARKET_DEV_FLOOR);
  assert.equal(MARKET_DEV_FLOOR, 0.70);
  assert.equal(marketDevTarget(1), MARKET_DEV_FLOOR, '1/wk sits on the floor');
  near(marketDevTarget(3), 0.803, 0.001, '3/wk');
  near(marketDevTarget(7), 0.911, 0.001, 'daily');
  near(marketDevTarget(14), 1.011, 0.001, '14/wk');
  near(marketDevTarget(28), 1.122, 0.001, '28/wk');
});

await t('the target is clamped to [0.70, 1.30] and the fare term to ±15%', () => {
  assert.equal(marketDevTarget(1000, 0.3), MARKET_DEV_CEIL);
  assert.ok(marketDevTarget(0.1) >= MARKET_DEV_FLOOR);
  assert.equal(marketDevFareTerm(0.2), 1.15);
  assert.equal(marketDevFareTerm(5), 0.85);
  near(marketDevFareTerm(0.9), 1.032, 0.001);
  assert.equal(marketDevFareTerm(null), 1);
});

await t('builds with a 20-week half-life and fades with a 30-week one', () => {
  let d = 0.7;
  for (let w = 0; w < 20; w++) d = stepMarketDev(d, 1.0);
  near(d, 0.85, 0.001, 'build half-life');
  let f = 1.1;
  for (let w = 0; w < 30; w++) f = stepMarketDev(f, 0.7);
  near(f, 0.90, 0.001, 'fade half-life');
});

await t('a steady reference service settles at 1.00 ± 0.01', () => {
  let d = 0.7;
  for (let w = 0; w < 200; w++) d = stepMarketDev(d, marketDevTarget(13, 1));
  near(d, 1.0, 0.01);
});

console.log('── 2. Service ────────────────────────────────────────────────');

await t('metro members share one key (JFK–LHR is EWR–LGW)', () => {
  assert.equal(marketDevKey('JFK', 'LHR'), marketDevKey('EWR', 'LGW'));
  assert.equal(marketDevKey('LHR', 'JFK'), marketDevKey('JFK', 'LHR'));
});

await t('frequency sums across carriers and member airports; a tag route adds half for its through pair', () => {
  const svc = collectPairService({
    routes: [
      { origin: 'JFK', destination: 'LHR', weeklyFrequency: 7, ticketPrice: referencePrice('JFK', 'LHR') },
      { origin: 'EWR', destination: 'LGW', weeklyFrequency: 3 },
      { origin: 'DEN', destination: 'ORD', stops: ['DEN', 'ORD', 'BOS'], weeklyFrequency: 4 },
    ],
    competitors: [{ routes: { 'JFK-LHR': { frequency: 5, priceMultiplier: 1 } } }],
  });
  assert.equal(svc.get(marketDevKey('JFK', 'LHR')).freq, 15);
  assert.equal(svc.get(marketDevKey('DEN', 'ORD')).freq, 4);
  assert.equal(svc.get(marketDevKey('ORD', 'BOS')).freq, 4);
  assert.equal(svc.get(marketDevKey('DEN', 'BOS')).freq, 2);
});

await t('a dormant seasonal route and a range-stranded one serve nothing', () => {
  const svc = collectPairService({ month: 1, routes: [
    { origin: 'JFK', destination: 'MIA', weeklyFrequency: 7, season: { months: [6, 7, 8] } },
    { origin: 'JFK', destination: 'SFO', weeklyFrequency: 7, rangeStranded: { since: 1 } },
  ] });
  assert.equal(svc.size, 0);
});

await t('advance: a served pair climbs; an abandoned pair fades and is dropped near the floor', () => {
  const k = marketDevKey('JFK', 'MIA');
  let s = { ...on({ [k]: { d: 0.9, t: 1 } }), routes: [], competitors: [] };
  s.marketDev = advanceMarketDev(s);
  assert.ok(s.marketDev.pairs[k].d < 0.9, 'fades with no service');
  assert.equal(s.marketDev.pairs[k].t, MARKET_DEV_FLOOR);
  for (let w = 0; w < 400; w++) s = { ...s, marketDev: advanceMarketDev(s) };
  assert.equal(s.marketDev.pairs[k], undefined, 'pruned once it is back at the floor');
  const r = { origin: 'JFK', destination: 'BOS', weeklyFrequency: 14 };
  let s2 = { ...on(), routes: [r], competitors: [] };
  s2.marketDev = advanceMarketDev(s2);
  const kb = marketDevKey('JFK', 'BOS');
  assert.ok(s2.marketDev.pairs[kb].d > MARKET_DEV_FLOOR);
  near(s2.marketDev.pairs[kb].t, marketDevTarget(14), 1e-4);
});

await t('a world without the flag never grows a table', () => {
  const s = { routes: [{ origin: 'JFK', destination: 'BOS', weeklyFrequency: 14 }], marketDev: null };
  assert.equal(advanceMarketDev(s), null);
});

console.log('── 3. The pool ───────────────────────────────────────────────');

await t('flag off: every pool is exactly the classic one, maturity ramp included', () => {
  setMarketDev(null);
  assert.equal(marketDevActive(), false);
  assert.equal(marketDevFor('JFK', 'LHR'), 1);
  assert.equal(marketDevForOD('JFK', 'LHR', 7), 1);
  const m = buildRouteMarket('JFK', 'LHR', gd, 0.55);
  assert.equal(m.maturityFactor, 0.55);
  assert.equal(m.marketDev, undefined);
  assert.equal(m.awareness, undefined);
});

await t('flag on: an unserved pair is 70% of its classic pool and the ramp no longer shrinks it', () => {
  setMarketDev(null);
  const classic = pool(buildRouteMarket('ORD', 'DEN', gd, 1));
  setMarketDev(on());
  const m = buildRouteMarket('ORD', 'DEN', gd, 0.55);
  near(pool(m), classic * 0.7, 2);
  assert.equal(m.maturityFactor, 1);
  assert.equal(m.awareness, 0.55);
  assert.equal(m.marketDev, 0.7);
  setMarketDev(null);
});

await t('pairDemandNow (finder lists) prints the same developed pool as buildRouteMarket', () => {
  setMarketDev(on({ [marketDevKey('ORD', 'DEN')]: { d: 1.17, t: 1.2 } }));
  near(pairDemandNow('ORD', 'DEN', gd), pool(buildRouteMarket('ORD', 'DEN', gd)), 1);
  setMarketDev(null);
});

await t('connecting-only O&D is stateless: its connecting frequency, half-weighted', () => {
  setMarketDev(on({ [marketDevKey('JFK', 'LHR')]: { d: 1.2, t: 1.2 } }));
  assert.equal(marketDevForOD('JFK', 'LHR', 2), 1.2, 'a nonstop market keeps its own D');
  near(marketDevForOD('DEN', 'BOS', 7), marketDevTarget(3.5), 1e-9);
  assert.equal(marketDevForOD('DEN', 'BOS', 0), MARKET_DEV_FLOOR);
  setMarketDev(null);
});

await t('AI route economics see the same developed market', () => {
  const cfg = { frequency: 7, priceMultiplier: 1, tails: 1 };
  const c = { id: 'x', tier: 'legacy', routes: { 'DEN-ORD': cfg } };
  setMarketDev(null);
  const classic = computeCompetitorRoutePnL(c, 'DEN-ORD', cfg, 5);
  setMarketDev(on());
  const floor = computeCompetitorRoutePnL(c, 'DEN-ORD', cfg, 5);
  setMarketDev(null);
  near(floor.demandOneWay, classic.demandOneWay * 0.7, 2, 'an unserved pair is 70% of its classic pool');
});

console.log('── 4. Awareness replaces the ramp ────────────────────────────');

const MK = { origin: 'ATL', destination: 'DFW', referencePrice: 162, distanceKm: 1160,
  leisureDemand: 7600, businessDemand: 2100 };
const YOU = { airlineId: 'player', origin: 'ATL', destination: 'DFW', economyPrice: 162, businessPrice: 567,
  weeklyFrequency: 21, economySeats: 1e9, businessSeats: 1e9, totalSeats: 2e9, qualityScore: 65 };
const RIVAL = { ...YOU, airlineId: 'rival' };

await t('contested: a new entrant wins share gradually, and nobody leaves the market', () => {
  const mature = computeMarketShare(MK, [YOU, RIVAL]);
  const fresh  = computeMarketShare({ ...MK, awareness: 0.55 }, [YOU, RIVAL]);
  assert.ok(fresh[0].totalPax < mature[0].totalPax, 'the newcomer carries less');
  near(fresh[0].totalPax + fresh[1].totalPax, mature[0].totalPax + mature[1].totalPax, 2,
    'the passengers it does not win fly the rival');
  near(fresh[0].leisureShare / fresh[1].leisureShare, 0.55, 0.01, 'weight × ramp');
});

await t('monopoly: awareness does nothing (the market itself is the ramp)', () => {
  const [a] = computeMarketShare(MK, [YOU]);
  const [b] = computeMarketShare({ ...MK, awareness: 0.55 }, [YOU]);
  assert.equal(a.totalPax, b.totalPax);
});

await t('the world service sums every airline\'s routes, and the table step is the single-player step', () => {
  const a = { routes: [{ origin: 'JFK', destination: 'BOS', weeklyFrequency: 7 }] };
  const b = { routes: [{ origin: 'LGA', destination: 'BOS', weeklyFrequency: 6 }] };
  const svc = collectWorldService([a, b, null]);
  assert.equal(svc.get(marketDevKey('JFK', 'BOS')).freq, 13, 'metro members are one market');
  const pairs = advanceMarketDevPairs({}, svc);
  const single = advanceMarketDev({ ...on(), routes: [...a.routes, ...b.routes], competitors: [] });
  assert.deepEqual(pairs, single.pairs);
});

console.log('── 5. Headwinds: new worlds only ─────────────────────────────');

const BASE = { name: 'T', lengthYears: 50, weeksPerDay: 24, maxPlayers: 20 };
const tcOf = async (opts) => {
  const calls = [];
  await createWorld({ world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } }, opts);
  return calls[0].tickConfig;
};
const worldRow = (tickConfig) => ({ id: 'w', worldSeed: 's', currentYear: 1, currentWeek: 1, lengthYears: 40, maxPlayers: 20,
  tickConfig: { startingCapital: 15_000_000, demandMultiplier: 1, ...tickConfig } });

await t('a new world is a market-development world; false creates one without (no key)', async () => {
  assert.equal((await tcOf({ ...BASE })).marketDev, true);
  assert.equal((await tcOf({ ...BASE, marketDev: false })).marketDev, undefined);
  assert.throws(() => validateWorldConfig({ ...BASE, marketDev: 'yes' }), /marketDev/);
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: { marketDev: true } }, { playerCount: 0 }).marketDev, true);
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: {} }, { playerCount: 0 }).marketDev, false);
});

await t('joining bakes the flag (never the table); a classic world bakes nothing', () => {
  const s = seedAirlineState(worldRow({ marketDev: true }), { airlineName: 'A', hub: 'JFK' });
  assert.equal(s.marketDevWorld, true);
  assert.equal(s.marketDev, undefined);
  assert.equal(seedAirlineState(worldRow({}), { airlineName: 'B', hub: 'JFK' }).marketDevWorld, undefined);
});

await t('the overlay carries the world\'s table in, and stripRivals keeps it out of the blob', () => {
  const table = { v: 1, pairs: { 'BOS-JFK': { d: 1.1, t: 1.1 } } };
  const injected = withRivals({ ...freshState(), marketDevWorld: true }, { competitors: [], marketDev: table });
  assert.equal(injected.marketDev, table);
  assert.equal(rivalOverlay({ competitors: [] }).marketDev, undefined, 'no table, no key');
  const stored = stripRivals(injected);
  assert.equal('marketDev' in stored, false);
  assert.equal(stored.marketDevWorld, true, 'the flag is a real field and survives');
});

await t('every engine entry point prices off the state\'s table: reducer entry and weeklyTick', () => {
  const k = marketDevKey('JFK', 'BOS');
  const s = { ...freshState(), marketDevWorld: true, marketDev: { v: 1, pairs: { [k]: { d: 1.2, t: 1.2 } } } };
  setMarketDev(null);
  gameReducer(s, { type: 'NOOP_FOR_TEST' });
  assert.equal(marketDevFor('JFK', 'BOS'), 1.2);
  gameReducer(freshState(), { type: 'NOOP_FOR_TEST' });
  assert.equal(marketDevActive(), false, 'a classic state switches it off again');
  seedRandom(5);
  weeklyTick({ ...s, phase: 'playing', hub: 'JFK', airlineName: 'W' });
  Math.random = realRandom;
  assert.equal(marketDevFor('JFK', 'BOS'), 1.2);
  setMarketDev(null);
});

const AC = (id) => ({ id, typeId: 'a320neo', name: `AC ${id}`, status: 'assigned', ageWeeks: 104, ownershipType: 'owned', config: { economy: 180 } });
const flying = (name, freq, extra = {}) => {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub: 'JFK', enableObjectives: false });
  return { ...s, competitors: [], encroachments: {}, cash: 5e8, fleet: [AC('a1')], gates: { JFK: 2, BOS: 2 },
    routes: [{ id: 'r1', origin: 'JFK', destination: 'BOS', stops: ['JFK', 'BOS'], aircraftId: 'a1',
      weeklyFrequency: freq, weeksOpen: 60, ticketPrice: Math.round(referencePrice('JFK', 'BOS')) }], ...extra };
};

await t('the tick flies the developed market: a bigger D carries more on a capacity-rich route', () => {
  const k = marketDevKey('JFK', 'BOS');
  const rev = (d) => {
    seedRandom(7);
    // Priced well over reference so neither run is capacity-bound.
    const base = flying('P', 14);
    const routes = base.routes.map((r) => ({ ...r, ticketPrice: Math.round(referencePrice('JFK', 'BOS') * 1.8) }));
    const r = gameReducer({ ...base, routes, marketDevWorld: true, marketDev: { v: 1, pairs: { [k]: { d, t: d } } } },
      { type: 'ADVANCE_WEEK' });
    Math.random = realRandom;
    return r.lastReport.routeResults.find((x) => x.routeId === 'r1').revenue;
  };
  const lo = rev(0.7), hi = rev(1.3);
  assert.ok(hi > lo * 1.3, `${lo} → ${hi}`);
  setMarketDev(null);
});

// ── The server tick, on an in-memory Prisma (the surface tickWorldOnce uses) ──
function fakePrisma({ world, airlines, marketDev = null }) {
  const db = { world: { ...world }, airlines: airlines.map((a) => ({ ...a })), md: marketDev ? { ...marketDev } : null,
    tickLogs: [], standings: [], news: [], market: null, credits: [] };
  const p = {
    _db: db,
    world: {
      findMany: async () => [{ ...db.world }],
      findUnique: async () => ({ ...db.world }),
      updateMany: async ({ where, data }) => {
        const w = db.world;
        if (!(w.id === where.id && w.currentWeek === where.currentWeek && w.currentYear === where.currentYear
          && w.status === where.status)) return { count: 0 };
        Object.assign(w, data); return { count: 1 };
      },
    },
    airline: {
      findMany: async ({ where }) => db.airlines.filter((a) => a.worldId === where.worldId && a.status === where.status).map((a) => ({ ...a })),
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
    },
    worldMarketDev: {
      findUnique: async ({ where }) => (db.md && db.md.worldId === where.worldId ? { ...db.md } : null),
      upsert: async ({ where, create, update }) => {
        db.md = db.md && db.md.worldId === where.worldId ? { ...db.md, ...update } : { id: 'md1', ...create };
        db.mdWrites = (db.mdWrites ?? 0) + 1;
        return { ...db.md };
      },
    },
    tickLog: { create: async ({ data }) => { db.tickLogs.push(data); return data; }, update: async () => ({}) },
    standing: {
      createMany: async ({ data }) => { db.standings.push(...data); return { count: data.length }; },
      findMany: async () => [],
    },
    worldMarket: {
      findUnique: async () => null, update: async () => null, updateMany: async () => ({ count: 0 }),
      create: async ({ data }) => { db.market = { id: 'mkt1', version: 0, ...data }; return { ...db.market }; },
      upsert: async ({ create }) => { db.market ??= { id: 'mkt1', version: 0, ...create }; return { ...db.market }; },
    },
    dividendCredit: { findMany: async () => [], createMany: async ({ data }) => ({ count: data.length }), updateMany: async () => ({ count: 0 }) },
    worldNews: { createMany: async ({ data }) => { db.news.push(...data); return { count: data.length }; }, deleteMany: async () => ({ count: 0 }) },
    alliance: { findMany: async () => [] },
  };
  p.$transaction = async (fn) => fn(p);
  return p;
}
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const tickWorld = (tickConfig = {}) => ({ id: 'w1', name: 'MD', status: 'RUNNING', lengthYears: 50, weeksPerDay: 12,
  currentWeek: 1, currentYear: 1, worldSeed: 'md', startedAt: new Date(Date.now() - 3 * 3600 * 1000), tickConfig });
const row = (id, state) => ({ id, worldId: 'w1', accountId: `acct_${id}`, name: id, hub: 'JFK', status: 'ACTIVE', week: 1, version: 0,
  state: { ...state, equity: { ...state.equity, isPublic: true } } });

await t('one step a week from EVERY airline\'s service, written with the clock; blobs never store it', async () => {
  const w = tickWorld({ marketDev: true });
  const prisma = fakePrisma({ world: w, airlines: [
    row('a1', { ...flying('A', 7), marketDevWorld: true }),
    row('a2', { ...flying('B', 7), marketDevWorld: true }),
  ] });
  const res = await tickWorldOnce(prisma, w, { log: quiet });
  assert.equal(res.ok, true);
  const md = prisma._db.md;
  assert.equal(md.week, 2, 'the table is for the week the clock moved to');
  const e = md.pairs[marketDevKey('JFK', 'BOS')];
  near(e.t, marketDevTarget(14, 1), 1e-3, 'both airlines\' 7/wk count: 14 a week');
  near(e.d, stepMarketDev(MARKET_DEV_FLOOR, e.t), 1e-3, 'one step up from the floor (no pre-warm)');
  for (const a of prisma._db.airlines) {
    assert.equal(a.state.marketDevWorld, true);
    assert.equal('marketDev' in a.state, false, 'the table never lands in a blob');
  }
  // Week two steps from week one's table.
  const res2 = await tickWorldOnce(prisma, { ...prisma._db.world }, { log: quiet });
  assert.equal(res2.ok, true);
  assert.ok(prisma._db.md.pairs[marketDevKey('JFK', 'BOS')].d > e.d);
  assert.equal(prisma._db.md.week, 3);
});

await t('a lost race writes no table (the clock CAS guards the step)', async () => {
  const prisma = fakePrisma({ world: tickWorld({ marketDev: true }), airlines: [row('a1', { ...flying('A', 7), marketDevWorld: true })] });
  prisma._db.world.currentWeek = 5;
  const res = await tickWorldOnce(prisma, tickWorld({ marketDev: true }), { log: quiet });
  assert.equal(res.ok, false);
  assert.equal(prisma._db.md, null);
});

await t('a classic world never grows a table, and its airlines never get the flag', async () => {
  const w = tickWorld({});
  const prisma = fakePrisma({ world: w, airlines: [row('a1', flying('A', 7))] });
  const res = await tickWorldOnce(prisma, w, { log: quiet });
  assert.equal(res.ok, true);
  assert.equal(prisma._db.md, null);
  assert.equal(prisma._db.airlines[0].state.marketDevWorld, undefined);
});

await t('the rival views carry the stored table to every airline (and nothing in a classic world)', async () => {
  const k = marketDevKey('JFK', 'BOS');
  const airlines = [row('a1', flying('A', 7)), row('a2', flying('B', 7))];
  const flagged = fakePrisma({ world: tickWorld({ marketDev: true }), airlines,
    marketDev: { id: 'md1', worldId: 'w1', week: 4, pairs: { [k]: { d: 0.9, t: 1 } } } });
  const views = await buildWorldRivalViews(flagged, 'w1', { airlines: flagged._db.airlines, world: flagged._db.world });
  for (const v of views.values()) assert.equal(v.marketDev.pairs[k].d, 0.9);
  const classic = fakePrisma({ world: tickWorld({}), airlines });
  const cv = await buildWorldRivalViews(classic, 'w1', { airlines: classic._db.airlines, world: classic._db.world });
  for (const v of cv.values()) assert.equal(v.marketDev, undefined);
});

await t('client: the page and the Route Finder worker set the world\'s table from the state they hold', async () => {
  const { createForecastWorkerCore } = await import('../src/utils/finderForecastWorkerCore.js');
  const k = marketDevKey('JFK', 'BOS');
  const held = { ...freshState(), marketDevWorld: true, marketDev: { v: 1, pairs: { [k]: { d: 1.25, t: 1.25 } } } };
  setMarketDev(null);
  const core = createForecastWorkerCore();
  core({ type: 'state', id: 1, state: held });
  core({ type: 'price', jobId: 1, stateId: 1, ctx: {}, rows: [] });
  assert.equal(marketDevFor('JFK', 'BOS'), 1.25);
  setMarketDev(null);
  const gc = readFileSync(new URL('../src/store/GameContext.jsx', import.meta.url), 'utf8');
  assert.ok(/export function syncEngineWorldState[\s\S]{0,900}setMarketDev\(state\)/.test(gc), 'syncEngineWorldState must publish it');
});

await t('the create-world form sends marketDev explicitly, defaulting to on', () => {
  const app = readFileSync(new URL('../apps/headwinds-web/src/App.jsx', import.meta.url), 'utf8');
  assert.ok(/const \[marketDev, setMarketDev\] = useState\(true\)/.test(app));
  assert.ok(/\n\s+marketDev,\n/.test(app), 'the request body names marketDev');
});

setMarketDev(null);
console.log(`\n${failed ? '✗' : '✓'} ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
