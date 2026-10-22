// Route Finder: saved figures between visits, and pricing on worker threads.
//
// Discord, 2026-10-21 (VodkaOnFire): "Can we keep a single file in cache of the
// latest route calculation done for pax? It takes 4-8 seconds at this point every
// time you load up the route finder and change the filter."
//
//   1. utils/finderFigures.js — the last forecasts per airline × panel × airframe
//      in localStorage: round trip, row and airframe caps (oldest out first),
//      a full storage evicts and still saves, no storage is a quiet no-op.
//   2. The finder OPENS on saved figures: a cold page (no in-memory cache) under
//      a profit sort is ranked at once — "updating forecasts", not "ranked …
//      once all are in" — and a dimmed row names the week its figure is from.
//   3. utils/finderWorkerPool.js, driven by in-process fake workers that copy
//      every message with structuredClone (as postMessage does): the pool's
//      figures equal forecastCandidate's on the main thread for every row; the
//      hydrated state survives the copy; a new submit replaces the owner's
//      queue; a lane always goes to the same worker, so pricing it for another
//      airframe runs no network tick; a worker that will not start or that
//      errors breaks the pool and hands every row back (onFail).
//   4. With a pool, rendering the finder prices nothing on the main thread.
//
// Verified failing on HEAD by rendering HEAD's RouteFinder.jsx (a throwaway copy,
// FINDER_UNDER_TEST=...) through this suite: 2 ("ranked by best est. profit once
// all are in" over the same saved figures) and 4 (HEAD prices in the render).
// 1 and 3 have no API on HEAD.
//
//   node --import ./tools/_register-loader.mjs tools/finder-figures-and-workers-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };
globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const { RemoteGameProvider, hydrateState } = await import('../src/store/GameContext.jsx');
const RouteFinder = (await import(process.env.FINDER_UNDER_TEST ?? '../src/components/RouteFinder.jsx')).default;
const { clearFinderMemory, rememberFinder, finderMemoryKey } = await import('../src/utils/finderMemory.js');
const FF = await import('../src/utils/finderFigures.js');
const { createForecastPool, getForecastPool, setForecastPoolForTests } = await import('../src/utils/finderWorkerPool.js');
const { createForecastWorkerCore } = await import('../src/utils/finderForecastWorkerCore.js');
const F = await import('../packages/engine/src/models/routeFinder.js');
const { networkTickRunCount } = await import('../packages/engine/src/models/pairShare.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { currentGameDate } = await import('../packages/engine/src/utils/simulation.js');
const { buildWorld } = await import('./routes-gates-finder-perf-probe.mjs');

// The probe module installs its own localStorage on import; use ours.
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };

const clean = (h) => h.replaceAll('<!-- -->', '');
const remoteApi = { setGateSlotShare: async () => {}, placeGateBid: async () => {} };
const render = (state, chrome = null) =>
  clean(renderToString(React.createElement(RemoteGameProvider, { state, dispatch: () => {}, remoteApi, remoteChrome: chrome },
    React.createElement(RouteFinder, { standalone: true }))));
const proj = (n) => ({ weeklyFrequency: 7, passengers: 900 + n, loadFactor: 0.8, revenue: 1e5 + n, netProfit: n,
  connectingRevenue: 10, lanePooled: false, siblingPairs: [], rivalCount: 1 });

// ── 1. saved figures ────────────────────────────────────────────────────────
console.log('\n── 1. utils/finderFigures.js ───────────────────────────────────');
await test('round trip, including a lane with no forecast', () => {
  store.clear(); FF.clearFinderFigureCache();
  const m = new Map([['JFK|LHR|7|500', proj(42)], ['JFK|BOS|7|90', null]]);
  assert.equal(FF.saveFigures('s', 'ctx', m, { year: 2031, week: 12 }), true);
  FF.clearFinderFigureCache();
  const back = FF.loadFigures('s', 'ctx');
  assert.deepEqual(back.asOf, { year: 2031, week: 12 });
  assert.deepEqual(back.map.get('JFK|LHR|7|500'), proj(42));
  assert.equal(back.map.get('JFK|BOS|7|90'), null);
  assert.equal(back.map.size, 2);
});
await test(`new rows first, older searches kept behind them, at most ${FF.MAX_ROWS}`, () => {
  store.clear(); FF.clearFinderFigureCache();
  FF.saveFigures('s', 'ctx', new Map(Array.from({ length: 50 }, (_, i) => [`old${i}`, proj(i)])));
  FF.saveFigures('s', 'ctx', new Map(Array.from({ length: FF.MAX_ROWS - 10 }, (_, i) => [`new${i}`, proj(i)])));
  const back = FF.loadFigures('s', 'ctx');
  assert.equal(back.map.size, FF.MAX_ROWS);
  assert.ok(back.map.has('new0') && back.map.has('old0') && !back.map.has('old10'));
});
await test(`at most ${FF.MAX_CONTEXTS} airframes; the oldest goes first`, () => {
  store.clear(); FF.clearFinderFigureCache();
  for (let i = 0; i <= FF.MAX_CONTEXTS; i++) FF.saveFigures('s', `ctx${i}`, new Map([['k', proj(i)]]));
  assert.equal(FF.loadFigures('s', 'ctx0'), null);
  assert.ok(FF.loadFigures('s', `ctx${FF.MAX_CONTEXTS}`));
  assert.ok(FF.loadFigures('s', 'ctx1'));
});
await test('a full storage evicts the oldest airframe and still saves', () => {
  store.clear(); FF.clearFinderFigureCache();
  FF.saveFigures('s', 'a', new Map([['k', proj(1)]]));
  FF.saveFigures('s', 'b', new Map([['k', proj(2)]]));
  const real = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (k, v) => {
    if (k.startsWith('finderFigures.v1:') && store.has(FF.figuresId('s', 'a'))) throw new Error('QuotaExceededError');
    return real(k, v);
  };
  try { assert.equal(FF.saveFigures('s', 'c', new Map([['k', proj(3)]])), true); }
  finally { globalThis.localStorage.setItem = real; }
  FF.clearFinderFigureCache();
  assert.equal(FF.loadFigures('s', 'a'), null);
  assert.ok(FF.loadFigures('s', 'c'));
});
await test('no storage: nothing saved, nothing loaded, nothing thrown', () => {
  const ls = globalThis.localStorage;
  globalThis.localStorage = undefined;
  try {
    FF.clearFinderFigureCache();
    assert.equal(FF.saveFigures('s', 'z', new Map([['k', proj(1)]])), false);
    assert.equal(FF.loadFigures('s', 'z'), null);
  } finally { globalThis.localStorage = ls; }
});

// ── 2. the finder opens on saved figures ────────────────────────────────────
console.log('\n── 2. a cold finder opens ranked on saved figures ──────────────');
const st = buildWorld({ routes: 120 });
const gameDate = currentGameDate(st);
const TYPE = 'a321neo';            // not in the fixture's fleet: priced on a synthetic airframe
const ctx = F.finderForecastContext({ aircraftTypeId: TYPE, weeklyFrequency: 7, gameDate });
const ctxId = `${TYPE}|__finder__|${getAircraftType(TYPE).weeklyLease ?? 0}|7`;
const rows = F.findCandidates(st, { origin: 'JFK', aircraftTypeId: TYPE });
const targets = F.rowsToScore(rows, { limit: F.DEFAULT_SCORE_LIMIT }).map(i => rows[i]).filter(r => !r.block);
const keyOf = (r) => `${r.origin}|${r.code}|${F.candidateFrequency(r, ctx)}|${r.refPrice}`;
// The smallest market of the 150 is priced LAST, so the first paint still shows
// its saved figure — boosted so the ranking visibly comes from the save.
const star = targets.at(-1);
await test('first paint under a profit sort is ranked from the save', () => {
  store.clear(); clearFinderMemory();
  const mem = finderMemoryKey(st, 'passenger');
  const saved = new Map(targets.map((r, i) => [keyOf(r), proj(r === star ? 9e9 : i)]));
  FF.saveFigures(`|${mem}`, ctxId, saved, { year: 2031, week: 12 });
  FF.clearFinderFigureCache();
  rememberFinder(mem, { typeId: TYPE, sortBy: 'profit', origin: 'JFK' });
  const html = render(st);
  assert.ok(!html.includes('once all are in'), 'still waiting for the whole field before ranking');
  assert.match(html, /updating forecasts \d+ of \d+/);
  const firstRow = html.indexOf(`>${star.code}<`);
  assert.ok(firstRow > 0, `${star.code} is not on the first page`);
  for (const r of targets.slice(0, 10)) {
    const at = html.indexOf(`>${r.code}<`);
    if (r !== star && at > 0) assert.ok(firstRow < at, `${star.code} should rank above ${r.code}`);
  }
  assert.ok(html.includes('this is your last forecast for this route (week 12, 2031)'));
});
await test("saved figures belong to one airline: another airline id starts from nothing", () => {
  clearFinderMemory();
  rememberFinder(finderMemoryKey(st, 'passenger'), { typeId: TYPE, sortBy: 'profit', origin: 'JFK' });
  const html = render(st, { airlineId: 'someone-else' });
  assert.ok(html.includes('once all are in'));
});

// ── 3. the worker pool ──────────────────────────────────────────────────────
console.log('\n── 3. utils/finderWorkerPool.js (in-process fake workers) ─────');
function fakeSpawn(log = []) {
  let n = 0;
  return () => {
    const id = n++;
    const handle = createForecastWorkerCore();
    const w = {
      id, onmessage: null, onerror: null, terminated: false,
      postMessage(msg) {
        const copy = structuredClone(msg);          // what postMessage does — throws on functions
        log.push({ worker: id, type: copy.type, keys: copy.rows?.map(r => r.key) });
        setImmediate(() => {
          if (w.terminated) return;
          const reply = handle(copy);
          if (reply) w.onmessage?.({ data: structuredClone(reply) });
        });
      },
      terminate() { w.terminated = true; },
    };
    return w;
  };
}
const hydrated = hydrateState(st);
const tasksFor = (c, list = targets) => list.map(r => ({ key: `${r.origin}|${r.code}|${F.candidateFrequency(r, c)}|${r.refPrice}`, row: { origin: r.origin, code: r.code, distKm: r.distKm, refPrice: r.refPrice, block: r.block } }));
const ctxIn = (c) => ({ aircraftTypeId: c.type.id, aircraft: c.frame.id === '__finder__' ? null : c.frame, weeklyFrequency: c.weeklyFrequency, gameDate: c.gameDate, capHours: c.capHours });
function priceAll(pool, owner, c, state = hydrated, list = targets) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    const tasks = tasksFor(c, list);
    const job = { state, ctx: ctxIn(c), token: {}, onResult: (k, p) => { out.set(k, p); if (out.size === tasks.length) resolve(out); }, onFail: (k) => reject(new Error(`failed ${k}`)) };
    pool.submit(owner, job, tasks);
  });
}

await test('getForecastPool() is null without browser workers (Node, server render)', () => {
  assert.equal(getForecastPool(), null);
});
await test('the hydrated state survives the copy to a worker', () => {
  structuredClone(hydrated);
});
await test('pool figures equal the main thread, row for row', async () => {
  const pool = createForecastPool({ size: 3, spawn: fakeSpawn() });
  const got = await priceAll(pool, 'p', ctx);
  for (const r of targets) assert.deepEqual(got.get(keyOf(r)), F.forecastCandidate(hydrated, r, ctx), r.code);
  pool.terminate();
});
await test('a lane goes to the same worker every time: another airframe runs no network tick', async () => {
  const log = [];
  const pool = createForecastPool({ size: 3, spawn: fakeSpawn(log) });
  await priceAll(pool, 'p', ctx);
  const firstWorker = new Map();
  for (const e of log) for (const k of e.keys ?? []) firstWorker.set(k, e.worker);
  log.length = 0;
  const before = networkTickRunCount();
  const leased = F.finderForecastContext({ aircraftTypeId: TYPE, aircraft: { id: 'tail9', typeId: TYPE, ageWeeks: 3, ownershipType: 'leased', weeklyLease: 77777, config: ctx.frame.config }, weeklyFrequency: 7, gameDate });
  await priceAll(pool, 'p', leased);
  for (const e of log) for (const k of e.keys ?? []) assert.equal(e.worker, firstWorker.get(k), k);
  assert.equal(networkTickRunCount() - before, 0);
  pool.terminate();
});
await test("a new submit replaces the owner's queue (rows in flight still finish)", async () => {
  const log = [];
  const pool = createForecastPool({ size: 2, spawn: fakeSpawn(log), chunk: 4 });
  const seen = new Set();
  pool.submit('p', { state: hydrated, ctx: ctxIn(ctx), token: {}, onResult: (k) => seen.add(k) }, tasksFor(ctx));
  const few = targets.slice(0, 6);
  await priceAll(pool, 'p', ctx, hydrated, few);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(seen.size <= 2 * 4 + 6, `${seen.size} rows priced from the replaced search`);
  assert.equal(pool.pending('p'), 0);
  pool.terminate();
});
await test('a worker that will not start breaks the pool', () => {
  const pool = createForecastPool({ size: 2, spawn: () => { throw new Error('no workers here'); } });
  assert.equal(pool.submit('p', { state: hydrated, ctx: ctxIn(ctx), token: {} }, tasksFor(ctx, targets.slice(0, 3))), false);
  assert.equal(pool.broken, true);
});
await test('a worker error hands every row back (onFail) and breaks the pool', async () => {
  let worker;
  const pool = createForecastPool({ size: 1, spawn: () => (worker = { postMessage() {}, terminate() {} }) });
  const failed = [];
  pool.submit('p', { state: hydrated, ctx: ctxIn(ctx), token: {}, onFail: (k) => failed.push(k) }, tasksFor(ctx, targets.slice(0, 9)));
  worker.onerror(new Error('boom'));
  assert.equal(failed.length, 9);
  assert.equal(pool.broken, true);
});
await test('a state that cannot be copied breaks the pool instead of throwing', () => {
  const pool = createForecastPool({ size: 1, spawn: fakeSpawn() });
  const failed = [];
  pool.submit('p', { state: { ...hydrated, oops: () => 1 }, ctx: ctxIn(ctx), token: {}, onFail: (k) => failed.push(k) }, tasksFor(ctx, targets.slice(0, 3)));
  assert.equal(pool.broken, true);
  assert.equal(failed.length, 3);
});

// ── 4. with a pool, the render prices nothing itself ────────────────────────
console.log('\n── 4. the finder hands pricing to the pool ─────────────────────');
await test('rendering under a profit sort runs no network tick on the main thread', () => {
  store.clear(); clearFinderMemory();
  setForecastPoolForTests(createForecastPool({ size: 2, spawn: fakeSpawn() }));
  try {
    rememberFinder(finderMemoryKey(st, 'passenger'), { typeId: TYPE, sortBy: 'profit', origin: 'JFK' });
    const before = networkTickRunCount();
    const html = render({ ...st });
    assert.equal(networkTickRunCount() - before, 0);
    assert.match(html, /forecasting 0 of \d+/);
  } finally { setForecastPoolForTests(undefined); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
