// The player's own click is projected in the worker, not on the page.
//
// After rival polls and new weeks moved to the projection worker (Nov 5) and
// a decision stopped projecting twice (Nov 10), one projection per click still
// ran on the main thread: the optimistic state is a new object, and the first
// screen to render asks projectWeek for it. At 4,000 routes that is 0.7 s of
// frozen page per click.
//
// Now an edit that leaves the airline the same shape goes on screen borrowing
// the projection already there; the worker projects it and the same state is
// put up again with its own (GamePlayScreen's reprojection runner).
//
// What this holds:
//   • only same-shape edits borrow, and only when there is something to borrow
//   • a borrowed projection is the previous one, untouched, and is marked
//   • what crosses to the worker for an edit is the keys the edit changed
//   • the worker's answer for "held state + those keys" is the main thread's
//     answer for the new state, exactly — including a key that disappeared
//   • GamePlayScreen never leaves a borrowed projection on screen
//
//   node --import ./tools/_register-loader.mjs tools/own-projection-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const lsMem = new Map();
globalThis.localStorage = globalThis.localStorage
  ?? { getItem: (k) => (lsMem.has(k) ? lsMem.get(k) : null), setItem: (k, v) => lsMem.set(k, String(v)), removeItem: (k) => lsMem.delete(k) };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const own = await import('../apps/headwinds-web/src/ownProjection.js').catch(() => null);
const need = () => { if (!own) throw new Error('apps/headwinds-web/src/ownProjection.js does not exist'); };
const client = await import('../apps/headwinds-web/src/projectionOffThread.js');
const { createProjectionWorkerCore, prepareWorldKnobs } = await import('../apps/headwinds-web/src/projectionWorkerCore.js');
const { freshState, hydrateState, gameReducer } = await import('../src/store/GameContext.jsx');
const { projectWeek } = await import('../src/utils/financeProjection.js');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { getAirport } = await import('../src/data/airports.js');
const { defaultConfig, defaultClassPrices, distanceKm, referencePrice } = await import('../src/utils/simulation.js');
const { pairKeyOf } = await import('../packages/engine/src/models/pairShare.js');

// A hub airline with a rival on some of its pairs (as projection-worker-test builds it).
function airline() {
  const narrow = getAircraftType('a320neo'), wide = getAircraftType('b7879');
  const dests = ['BKK', 'KUL', 'CGK', 'HKG', 'MNL', 'SGN', 'NRT', 'SYD', 'DEL', 'DXB', 'LHR', 'PER'];
  const fleet = [], routes = [], routePricing = {}, gates = { SIN: 40 };
  dests.forEach((d, i) => {
    const km = distanceKm(getAirport('SIN'), getAirport(d));
    const t = km > 4500 ? wide : narrow;
    fleet.push({ id: `p${i}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `9V-T${i}`, name: t.name });
    const fare = Math.round(referencePrice('SIN', d));
    routes.push({ id: `r${i}`, origin: 'SIN', destination: d, stops: ['SIN', d], aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub: 'SIN', ticketPrice: fare });
    routePricing[pairKeyOf('SIN', d)] = defaultClassPrices(fare);
    gates[d] = 2;
  });
  const rr = {};
  for (const d of dests.slice(0, 5)) rr[pairKeyOf('SIN', d)] = { frequency: 14, priceMultiplier: 1, economyFare: Math.round(referencePrice('SIN', d)), seatsPerWeek: 2520, seats: 180 };
  const competitors = [{ id: 'human:1', human: true, name: 'Rival', homeHub: 'SIN', hubs: { SIN: { tier: 1 } }, tier: 'legacy', routes: rr, baseQualityScore: 62 }];
  const humanRivals = {};
  for (const [key, r] of Object.entries(rr)) humanRivals[key] = [{ competitorId: 'human:1', name: 'Rival', frequency: 14, economyFare: r.economyFare, seatsPerFlight: 180, qualityScore: 62, tier: 'legacy' }];
  return { ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'SIN', airlineName: 'Probe Air', cash: 5e9, multiplayer: true,
    fleet, routes, routePricing, gates, competitors, humanRivals, encroachments: {}, hubs: { SIN: { tier: 3, tierSince: 0 } } };
}
const onMain = (raw) => { prepareWorldKnobs(raw); return projectWeek(hydrateState(raw)); };
const FARE = { type: 'UPDATE_TICKET_PRICE', routeId: 'r3', ticketPrice: 99 };
const FREQ = { type: 'UPDATE_FREQUENCY', routeId: 'r4', weeklyFrequency: 3 };

section('which edits may borrow');

await test('a fare change and a frequency change keep the shape', () => {
  need();
  const s = airline();
  const fare = gameReducer(s, FARE), freq = gameReducer(s, FREQ);
  assert.notEqual(fare, s); assert.notEqual(freq, s);
  assert.equal(own.sameShape(s, fare), true);
  assert.equal(own.sameShape(s, freq), true);
  assert.notEqual(freq.routes, s.routes, 'precondition: the frequency change rebuilt the routes array');
});
await test('a route or an aircraft more, fewer or in another order does not', () => {
  need();
  const s = airline();
  assert.equal(own.sameShape(s, { ...s, routes: s.routes.slice(1) }), false);
  assert.equal(own.sameShape(s, { ...s, routes: [...s.routes, { id: 'new' }] }), false);
  assert.equal(own.sameShape(s, { ...s, routes: [s.routes[1], s.routes[0], ...s.routes.slice(2)] }), false);
  assert.equal(own.sameShape(s, { ...s, fleet: s.fleet.slice(0, -1) }), false);
  assert.equal(own.sameShape(s, { ...s, fleet: [...s.fleet, { id: 'new' }] }), false);
  assert.equal(own.sameShape(s, { ...s, cargoRoutes: [{ id: 'c1' }] }), false);
  assert.equal(own.sameShape(s, { ...s, routes: s.routes.map((r, i) => (i === 2 ? { ...r, id: 'swapped' } : r)) }), false);
});
await test('another week is another shape; nothing is not a shape', () => {
  need();
  const s = airline();
  assert.equal(own.sameShape(s, { ...s, week: 21 }), false);
  assert.equal(own.sameShape(s, { ...s, year: 4 }), false);
  assert.equal(own.sameShape(null, s), false);
  assert.equal(own.sameShape(s, null), false);
});
await test('closing a route through the real reducer changes the shape', () => {
  need();
  const s = airline();
  const closed = gameReducer(s, { type: 'CLOSE_ROUTE', routeId: 'r2' });
  if (closed.routes.length === s.routes.length) throw new Error('CLOSE_ROUTE did not close the route — pick the right action');
  assert.equal(own.sameShape(s, closed), false);
});

section('borrowing');

await test('nothing to borrow until the previous state has been projected', () => {
  need();
  const s = airline(), next = gameReducer(s, FARE);
  assert.equal(own.borrowProjection(s, next), false);
  assert.equal(own.hasBorrowedProjection(next), false);
});
await test('a same-shape edit goes up with the previous projection, untouched, and is marked', () => {
  need();
  const s = airline();
  const before = onMain(s);
  const next = gameReducer(s, FARE);
  assert.equal(own.borrowProjection(s, next), true);
  assert.equal(own.hasBorrowedProjection(next), true);
  assert.equal(own.hasBorrowedProjection(s), false);
  assert.equal(projectWeek(hydrateState(next)), before, 'the screens must read the previous projection, not compute one');
  // …and it IS stale: the honest answer differs, which is why it must be replaced.
  assert.notEqual(onMain(structuredClone(next)).netCash, before.netCash);
});
await test('an edit that changes the shape, or changes nothing, borrows nothing', () => {
  need();
  const s = airline(); onMain(s);
  const closed = gameReducer(s, { type: 'CLOSE_ROUTE', routeId: 'r2' });
  assert.equal(own.borrowProjection(s, closed), false);
  assert.equal(own.hasBorrowedProjection(closed), false);
  assert.equal(own.borrowProjection(s, s), false);
  assert.equal(own.borrowProjection(null, s), false);
});
await test('a state that already has its own projection keeps it', () => {
  need();
  const s = airline(); onMain(s);
  const next = gameReducer(s, FARE);
  const mine = onMain(next);
  assert.equal(own.borrowProjection(s, next), false);
  assert.equal(own.hasBorrowedProjection(next), false);
  assert.equal(projectWeek(hydrateState(next)), mine);
});
await test('a second edit on top of a borrowed one borrows the same projection; settling clears the mark', () => {
  need();
  const s = airline(); const p = onMain(s);
  const a = gameReducer(s, FARE); own.borrowProjection(s, a);
  const b = gameReducer(a, FREQ);
  assert.equal(own.borrowProjection(a, b), true);
  assert.equal(projectWeek(hydrateState(b)), p);
  own.settleBorrowed(a);
  assert.equal(own.hasBorrowedProjection(a), false);
  assert.equal(own.hasBorrowedProjection(b), true);
  const copy = { ...b };
  own.inheritBorrowed(b, copy);
  assert.equal(own.hasBorrowedProjection(copy), true, 'a screen-only copy of a borrowed state is borrowed too');
  const clean = { ...s };
  own.inheritBorrowed(s, clean);
  assert.equal(own.hasBorrowedProjection(clean), false);
});

section('what crosses to the worker');

await test('topLevelDiff: the keys an edit changed, and the keys that went', () => {
  if (typeof client.topLevelDiff !== 'function') throw new Error('topLevelDiff is not exported');
  const s = airline();
  const fare = gameReducer(s, FARE);
  const d = client.topLevelDiff(s, fare);
  assert.ok('routePricing' in d.overlay, 'the fare lives in routePricing');
  assert.ok(!('fleet' in d.overlay) && !('competitors' in d.overlay) && !('humanRivals' in d.overlay), 'unchanged keys must not cross');
  assert.deepEqual(d.drop, []);
  const gone = { ...fare }; delete gone.error; delete gone.gates;
  const d2 = client.topLevelDiff(fare, gone);
  assert.deepEqual(d2.overlay, {});
  assert.deepEqual(d2.drop.sort(), ['error', 'gates'].filter((k) => k in fare).sort());
  assert.deepEqual(client.topLevelDiff(s, { ...s }), { overlay: {}, drop: [] });
});

await test('the worker core: held state + changed keys === the new state, dropped keys included', () => {
  const s = airline();
  const handle = createProjectionWorkerCore();
  handle({ id: 1, op: 'project', state: structuredClone(s) });
  const next = gameReducer(s, FARE);
  const d = client.topLevelDiff(s, next);
  const r = handle({ id: 2, op: 'overlay', baseId: 1, overlay: structuredClone(d.overlay), drop: d.drop });
  assert.ok(r.proj, r.error);
  assert.ok(isDeepStrictEqual(r.proj, onMain(structuredClone(next))), 'edit: worker vs main thread');
  // A key that disappears must disappear in the worker too.
  const without = { ...next }; delete without.hubs;
  const d2 = client.topLevelDiff(next, without);
  assert.deepEqual(d2.drop, ['hubs']);
  const r2 = handle({ id: 3, op: 'overlay', baseId: 2, overlay: d2.overlay, drop: d2.drop });
  assert.ok(isDeepStrictEqual(r2.proj, onMain(structuredClone(without))), 'dropped key: worker vs main thread');
  assert.notEqual(r2.proj.netCash, r.proj.netCash, 'dropping the hub was expected to move the numbers');
});

// A browser-shaped Worker over worker_threads, recording what crosses.
const sent = [];
function nodeWorkerFactory() {
  const w = new Worker(new URL('./_projection-worker-node.mjs', import.meta.url), { execArgv: process.execArgv });
  const shim = { onmessage: null, onerror: null };
  const queue = []; let ready = false;
  w.on('message', (m) => { if (m?.ready) { ready = true; for (const q of queue.splice(0)) w.postMessage(q); return; } shim.onmessage?.({ data: m }); });
  w.on('error', (e) => shim.onerror?.(e));
  shim.postMessage = (m) => { sent.push({ op: m.op, bytes: JSON.stringify(m).length, keys: m.overlay ? Object.keys(m.overlay) : null }); if (ready) w.postMessage(m); else queue.push(m); };
  shim.terminate = () => w.terminate();
  return shim;
}
client.setProjectionWorkerForTests(nodeWorkerFactory);

await test('a real worker: an edit of the held state crosses as its changed keys and comes back exact', async () => {
  sent.length = 0;
  const s = airline();
  assert.equal(await client.projectOffThread(s), true);
  const next = gameReducer(s, FARE);
  const fresh = { ...next };                         // what the runner proposes
  assert.equal(await client.projectOffThread(fresh, { fromHeld: true }), true);
  assert.deepEqual(sent.map((m) => m.op), ['project', 'overlay']);
  assert.ok(sent[1].bytes < sent[0].bytes * 0.5, `the edit crossed as ${sent[1].bytes} B against ${sent[0].bytes} B for the save`);
  assert.ok(!sent[1].keys.includes('fleet') && !sent[1].keys.includes('competitors'));
  assert.ok(isDeepStrictEqual(projectWeek(hydrateState(fresh)), onMain(structuredClone(next))), 'worker result equals a main-thread projection');
});

await test('a chain of edits and copies stays on small messages', async () => {
  sent.length = 0;
  let s = airline();
  await client.projectOffThread(s);
  for (const action of [FARE, FREQ, { type: 'UPDATE_TICKET_PRICE', routeId: 'r7', ticketPrice: 640 }]) {
    const next = gameReducer(s, action);
    const fresh = { ...next };
    assert.equal(await client.projectOffThread(fresh, { fromHeld: true }), true);
    assert.ok(isDeepStrictEqual(projectWeek(hydrateState(fresh)), onMain(structuredClone(next))));
    s = fresh;                                       // the screen now holds the copy
  }
  // The same state with a new rival view (a decision came back with one).
  const rivals = { competitors: [], humanRivals: {} };
  const withRivals = { ...s, ...rivals };
  assert.equal(await client.projectOffThread(withRivals, { fromHeld: true }), true);
  assert.ok(isDeepStrictEqual(projectWeek(hydrateState(withRivals)), onMain(structuredClone(withRivals))));
  assert.deepEqual(sent.map((m) => m.op), ['project', 'overlay', 'overlay', 'overlay', 'overlay']);
  assert.deepEqual(sent[4].keys.sort(), ['competitors', 'humanRivals']);
});

await test('nothing held yet, or the very state that is held: the plain paths still apply', async () => {
  client.setProjectionWorkerForTests(nodeWorkerFactory);   // a clean client: nothing held
  sent.length = 0;
  const s = airline();
  assert.equal(await client.projectOffThread(s, { fromHeld: true }), true);
  assert.deepEqual(sent.map((m) => m.op), ['project']);
  assert.equal(await client.projectOffThread(s, { fromHeld: true }), false, 'already projected: nothing to prime');
});

await test('no worker: offThreadReady is false and nothing is borrowed on its account', async () => {
  client.setProjectionWorkerForTests(() => { throw new Error('no workers here'); });
  assert.equal(client.offThreadReady(), false);
  assert.equal(await client.projectOffThread(airline(), { fromHeld: true }), false);
  client.setProjectionWorkerForTests(null);
});

section('GamePlayScreen');

const src = read('apps/headwinds-web/src/GamePlayScreen.jsx');
await test('the optimistic apply borrows only when there is a worker to pay it back', () => {
  const dispatch = src.slice(src.indexOf('const dispatch = useCallback((action) => {'));
  assert.match(dispatch, /const next = gameReducer\(s, seeded\);\s*\n\s*if \(next !== s && offThreadReady\(\)\) borrowProjection\(s, next\);\s*\n\s*return next;/);
});
await test('the runner projects from the held state, proposes only for the state still on screen, and never blocks a click', () => {
  const a = src.indexOf('const reproject = useCallback(async () => {');
  assert.ok(a > 0, 'the reprojection runner is missing');
  const fn = src.slice(a, src.indexOf('const figuresPending'));
  assert.match(fn, /if \(job\.running \|\| job\.proposal\) return;/, 'one job at a time');
  assert.match(fn, /if \(!owed && !hasBorrowedProjection\(target\)\) return;/, 'nothing owed, nothing done');
  assert.match(fn, /const fresh = owed \? \{ \.\.\.target, \.\.\.owed\.rivals \} : \{ \.\.\.target \};/);
  assert.match(fn, /await projectOffThread\(fresh, \{ fromHeld: true \}\);/);
  assert.match(fn, /if \(stateRef\.current !== target\) \{ reproject\(\); return; \}/, 'a superseded job must start again, not propose');
  assert.match(fn, /startTransition\(\(\) => setState\(\(cur\) => \(cur === target \? fresh : cur\)\)\);/);
});
await test('a proposal is confirmed or dropped when the state changes, and anything still owed starts again', () => {
  const a = src.indexOf('const reproject = useCallback(async () => {');
  const fn = src.slice(a, src.indexOf('const figuresPending'));
  const effect = fn.slice(fn.indexOf('useEffect(() => {'));
  assert.match(effect, /if \(state === p\.fresh\) \{\s*\n\s*settleBorrowed\(p\.target\);/);
  assert.match(effect, /\} else if \(state !== p\.target\) \{\s*\n\s*job\.proposal = null;/);
  assert.match(effect, /if \(!job\.proposal\) reproject\(\);/);
  assert.match(effect, /\}, \[state, reproject\]\);/);
  // A rival view owed from a decision obeys the same newest-wins rule as a poll's.
  assert.match(fn, /owed\.oseq < adoptedSeq\.current/);
  assert.match(effect, /if \(p\.owed\.oseq >= adoptedSeq\.current\) \{ adoptedSeq\.current = p\.owed\.oseq; latestRivals\.current = p\.owed\.rivals; \}/);
});
await test('the screen says so while figures are one edit old', () => {
  assert.match(src, /const figuresPending = hasBorrowedProjection\(state\);/);
  assert.match(src, /className="hw-figures-pending"/);
  assert.match(src, /opacity: figuresPending \? 0\.9 : 0/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
