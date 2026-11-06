// Rival polls and new weeks are projected in a Web Worker before the page
// adopts them (Headwinds), so no screen runs a full weekly tick on the main
// thread for a state it didn't change itself.
//
//   node --import ./tools/_register-loader.mjs tools/projection-worker-test.mjs
//
// Before (2026-11-05): GamePlayScreen adopted every rival overlay and every
// new week straight into React state, and the first screen to render called
// projectWeek(state) — a full weekly tick (0.2–0.6 s for a 600-route airline,
// measured in headless Chromium) on the main thread, every time a rival moved,
// which in a busy world is most 25-second polls.
//
// The checks run the real worker core in a real worker thread (its own module
// world, like a browser worker) and compare against the main thread.

import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const mem = new Map();
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

const { freshState, hydrateState } = await import('../src/store/GameContext.jsx');
const { projectWeek } = await import('../src/utils/financeProjection.js');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { getAirport } = await import('../src/data/airports.js');
const { defaultConfig, defaultClassPrices, distanceKm, referencePrice } = await import('../src/utils/simulation.js');
const { pairKeyOf } = await import('../packages/engine/src/models/pairShare.js');
const { prepareWorldKnobs, createProjectionWorkerCore } = await import('../apps/headwinds-web/src/projectionWorkerCore.js');
const client = await import('../apps/headwinds-web/src/projectionOffThread.js');

// A hub airline (SIN) with rivals on some of its pairs.
function buildState() {
  const narrow = getAircraftType('a320neo'), wide = getAircraftType('b7879');
  const dests = ['BKK', 'KUL', 'CGK', 'HKG', 'MNL', 'SGN', 'NRT', 'SYD', 'DEL', 'DXB', 'LHR', 'PER', 'ICN', 'TPE', 'BOM'];
  const fleet = [], routes = [], routePricing = {}, gates = { SIN: 40 };
  dests.forEach((d, i) => {
    const km = distanceKm(getAirport('SIN'), getAirport(d));
    const t = km > 4500 ? wide : narrow;
    fleet.push({ id: `p${i}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `9V-T${i}`, name: t.name });
    const fare = Math.round(referencePrice('SIN', d));
    routes.push({ id: `r${i}`, origin: 'SIN', destination: d, stops: ['SIN', d], aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub: 'SIN', ticketPrice: fare, cateringLevel: 'full' });
    routePricing[pairKeyOf('SIN', d)] = defaultClassPrices(fare);
    gates[d] = 2;
  });
  const competitors = [0, 1, 2].map((p) => {
    const rr = {};
    for (const d of dests.slice(p * 4, p * 4 + 6)) {
      const fare = Math.round(referencePrice('SIN', d));
      rr[pairKeyOf('SIN', d)] = { frequency: 14, priceMultiplier: 1, economyFare: fare, seatsPerWeek: 2520, seats: 180, businessSeatsPerWeek: 280, businessFare: fare * 2.5, aircraftTypes: ['a320neo'], aircraftType: 'a320neo' };
    }
    return { id: `human:${p}`, human: true, name: `Rival ${p}`, homeHub: 'SIN', hubs: { SIN: { tier: 1 } }, tier: 'legacy', routes: rr, baseQualityScore: 62, marketShare: 0.05, cash: 5e8 };
  });
  const humanRivals = {};
  competitors.forEach((c) => {
    for (const [key, r] of Object.entries(c.routes)) {
      (humanRivals[key] ??= []).push({ competitorId: c.id, name: c.name, frequency: 14, economyFare: r.economyFare, seatsPerFlight: 180,
        businessSeatsPerWeek: 280, businessFare: r.businessFare, qualityScore: 62, tier: 'legacy' });
    }
  });
  return { ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'SIN', airlineName: 'Probe Air', cash: 5e9, multiplayer: true,
    fleet, routes, routePricing, gates, competitors, humanRivals, encroachments: {}, hubs: { SIN: { tier: 3, tierSince: 0 } } };
}
function onMain(raw) { prepareWorldKnobs(raw); return projectWeek(hydrateState(raw)); }
// A rival overlay that moves the numbers: rival `drop` pulls off every pair.
function rivalMove(state, drop = 0) {
  const competitors = structuredClone(state.competitors).filter((c, i) => i !== drop);
  const humanRivals = {};
  for (const [k, specs] of Object.entries(state.humanRivals)) {
    const kept = specs.filter((s) => s.competitorId !== `human:${drop}`);
    if (kept.length) humanRivals[k] = structuredClone(kept);
  }
  return { competitors, humanRivals, selfStanding: { rank: 2 } };
}

// A browser-shaped Worker over worker_threads, counting what crosses.
const sent = [];
function nodeWorkerFactory() {
  const w = new Worker(new URL('./_projection-worker-node.mjs', import.meta.url), { execArgv: process.execArgv });
  const shim = { onmessage: null, onerror: null, ready: null };
  const queue = [];
  let ready = false;
  w.on('message', (m) => {
    if (m?.ready) { ready = true; for (const q of queue.splice(0)) w.postMessage(q); return; }
    shim.onmessage?.({ data: m });
  });
  w.on('error', (e) => shim.onerror?.(e));
  shim.postMessage = (m) => { sent.push({ op: m.op, bytes: JSON.stringify(m).length }); if (ready) w.postMessage(m); else queue.push(m); };
  shim.terminate = () => w.terminate();
  return shim;
}

console.log('\nProjection worker\n');

await test('the worker core projects the same week the main thread does', async () => {
  const raw = buildState();
  const handle = createProjectionWorkerCore();
  const inProc = handle({ id: 1, op: 'project', state: structuredClone(raw) });
  assert.ok(inProc.proj, inProc.error);
  const main = onMain(structuredClone(raw));
  assert.ok(isDeepStrictEqual(structuredClone(inProc.proj), main), 'in-process core vs main thread');
});

await test('an overlay is applied to the held state; an unknown base is refused', async () => {
  const raw = buildState();
  const handle = createProjectionWorkerCore();
  handle({ id: 1, op: 'project', state: structuredClone(raw) });
  const ov = rivalMove(raw, 0);
  const r = handle({ id: 2, op: 'overlay', baseId: 1, overlay: ov });
  assert.ok(isDeepStrictEqual(r.proj, onMain({ ...structuredClone(raw), ...structuredClone(ov) })));
  assert.deepEqual(handle({ id: 3, op: 'overlay', baseId: 1, overlay: ov }), { id: 3, missing: true });
});

await test('a rival move really changes the projection (the test is not vacuous)', () => {
  const raw = buildState();
  const a = onMain(structuredClone(raw)), b = onMain({ ...structuredClone(raw), ...rivalMove(raw, 0) });
  assert.notEqual(a.netCash, b.netCash);
});

client.setProjectionWorkerForTests(nodeWorkerFactory);

await test('projectOffThread (a real worker thread) primes projectWeek for the exact object the screens will use', async () => {
  const next = buildState();
  const ok = await client.projectOffThread(next);
  assert.equal(ok, true);
  const primed = projectWeek(hydrateState(next));                 // a cache hit, not a recompute
  const fresh = onMain(structuredClone(next));
  assert.ok(isDeepStrictEqual(primed, fresh), 'worker result equals a main-thread projection');
  assert.equal(projectWeek(hydrateState(next)), primed, 'same object on every ask');
});

await test('between ticks only the rival overlay crosses to the worker, not the save', async () => {
  sent.length = 0;
  const base = buildState();
  await client.projectOffThread(base);
  const ov = rivalMove(base, 1);
  const next = { ...base, ...ov };
  assert.equal(await client.projectOffThread(next, { base, overlay: ov }), true);
  assert.deepEqual(sent.map(s => s.op), ['project', 'overlay']);
  assert.ok(sent[1].bytes < sent[0].bytes * 0.6, `overlay ${sent[1].bytes} B vs save ${sent[0].bytes} B`);
  assert.ok(!('fleet' in JSON.parse(JSON.stringify(ov))), 'the overlay carries no save fields');
  assert.ok(isDeepStrictEqual(projectWeek(hydrateState(next)), onMain(structuredClone(next))));
});

await test('an overlay on a state the worker no longer holds sends the whole state', async () => {
  sent.length = 0;
  const base = buildState(), other = buildState();
  await client.projectOffThread(base);
  await client.projectOffThread(other);                // the worker now holds `other`
  const ov = rivalMove(base, 2);
  assert.equal(await client.projectOffThread({ ...base, ...ov }, { base, overlay: ov }), true);
  assert.deepEqual(sent.map(s => s.op), ['project', 'project', 'project']);
});

await test('a result already on the main thread is never replaced', async () => {
  const next = buildState();
  const mine = projectWeek(hydrateState(next));
  assert.equal(await client.projectOffThread(next), false);
  assert.equal(projectWeek(hydrateState(next)), mine);
});

client.setProjectionWorkerForTests(() => { throw new Error('no workers here'); });
await test('no worker → resolves false at once and the screens compute as before', async () => {
  assert.equal(await client.projectOffThread(buildState()), false);
});
client.setProjectionWorkerForTests(null);

const gps = readFileSync(new URL('../apps/headwinds-web/src/GamePlayScreen.jsx', import.meta.url), 'utf8');
await test('GamePlayScreen projects before it adopts — for a new week and for a rival overlay', () => {
  assert.match(gps, /const next = withStatsBackfill\(incoming\);\s*\n\s*await projectOffThread\(next\);/);
  assert.match(gps, /await projectOffThread\(next, \{ base: local, overlay: d\.rivals \}\);/);
  assert.doesNotMatch(gps, /if \(d\.rivals\) setState\(\(cur\) => \(cur \? \{ \.\.\.cur, \.\.\.d\.rivals \} : cur\)\);\n\n\s*if \(!d\.state\) return;/);
});

console.log(`\nprojection-worker-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
