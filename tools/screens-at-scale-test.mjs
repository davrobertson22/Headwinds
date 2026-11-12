// Dashboard, Fleet and Market at the size airlines really reach (round 4).
//
// Measured on the largest live airline (4,869 aircraft, 4,027 routes,
// 6,631 orders), Chromium, 2026-11-12:
//
//   Dashboard  every render searched the fleet once per route to pair routes
//              with aircraft (20 million comparisons, ~140 ms), and did it
//              again for any change at all, a pop-up dismissed included
//   Fleet      0.66 s to open, most of it block hours: every leg's distance
//              worked out from coordinates, 12 months × every route × every
//              tail, three or more times a render
//   Market     every one of ~200 types scanned the whole order book for its
//              next delivery slot
//   Clicks     after a pop-up or the debrief was dismissed on the screen,
//              the screen never matched the server again, so every later
//              click was adopted and projected on the main thread (1 s)
//
// None of the fixes may change a figure. This file holds each against the code
// it replaced, and that the screens use it.
//
//   node --import ./tools/_register-loader.mjs tools/screens-at-scale-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const mem = new Map();
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const { AIRCRAFT_TYPES, getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { AIRPORTS, getAirport } = await import('../packages/engine/src/data/airports.js');
const { distanceKm } = await import('../packages/engine/src/utils/market.js');
const sim = await import('../packages/engine/src/utils/simulation.js');
const delivery = await import('../packages/engine/src/data/delivery.js');
const { freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { projectWeek } = await import('../src/utils/financeProjection.js');
const alerts = await import('../src/utils/airlineAlerts.js');
const screen = await import('../apps/headwinds-web/src/screenMemory.js');

// ── engine lookups ──────────────────────────────────────────────────────────
section('engine lookups: indexed, same answers');

test('getAircraftType: the first type with the id, for every id, and undefined for an unknown one', () => {
  for (const t of AIRCRAFT_TYPES) assert.equal(getAircraftType(t.id), AIRCRAFT_TYPES.find(a => a.id === t.id), t.id);
  assert.equal(getAircraftType('no-such-type'), undefined);
  assert.equal(getAircraftType(undefined), undefined);
});
test('routeDistanceKm: the rounded great-circle distance, worked out once per pair', () => {
  const codes = AIRPORTS.map(a => a.code);
  for (let i = 0; i < 4000; i++) {
    const a = codes[(i * 7919) % codes.length], b = codes[(i * 104729 + 13) % codes.length];
    const want = Math.round(distanceKm(getAirport(a), getAirport(b)));
    assert.equal(sim.routeDistanceKm(a, b), want, `${a}-${b}`);
    assert.equal(sim.routeDistanceKm(a, b), want, `${a}-${b} (second ask)`);
  }
  assert.equal(sim.routeDistanceKm('JFK', 'NOPE'), 0);
  assert.equal(sim.routeDistanceKm(undefined, 'JFK'), 0);
  assert.match(read('packages/engine/src/utils/simulation.js'), /const ROUTE_KM = new WeakMap\(\);/, 'routeDistanceKm is not memoised');
});
test('the next delivery slot: what scanning the order book gave, for any book', () => {
  const reference = (type, orders, absWeek, quantity = 1) => {
    const lead = delivery.deliveryLead(type);
    const queued = (orders ?? []).filter(o => o?.typeId === type?.id);
    let last = queued.length > 0 ? Math.max(...queued.map(o => o.deliverAbsWeek)) : null;
    const weeks = [];
    for (let i = 0; i < Math.max(0, quantity); i++) { last = last === null ? absWeek + 2 * lead : last + lead; weeks.push(last); }
    return weeks;
  };
  const types = AIRCRAFT_TYPES.slice(0, 60);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (const n of [0, 1, 5, 300, 6631]) {
    const book = Array.from({ length: n }, (_, i) => ({ id: `o${i}`, typeId: types[Math.floor(rnd() * types.length)].id, deliverAbsWeek: 100 + Math.floor(rnd() * 400) }));
    for (const t of types) for (const q of [1, 3]) assert.deepEqual(delivery.deliverySchedule(t, book, 120, q), reference(t, book, 120, q), `${t.id} ×${q}, book of ${n}`);
    // An order pushed onto the same array in place is seen.
    book.push({ id: 'late', typeId: types[0].id, deliverAbsWeek: 9999 });
    assert.deepEqual(delivery.deliverySchedule(types[0], book, 120), reference(types[0], book, 120));
  }
  assert.deepEqual(delivery.deliverySchedule(types[0], null, 50), reference(types[0], null, 50));
  assert.match(read('packages/engine/src/data/delivery.js'), /let last = lastQueuedWeek\(pendingOrders, type\?\.id\);/, 'deliverySchedule still scans the book');
});

// ── Dashboard ───────────────────────────────────────────────────────────────
section('Dashboard: route results kept per projection');

function airline(n) {
  const hub = 'SIN', t = getAircraftType('a320neo');
  const dests = AIRPORTS.map(a => a.code).filter(c => c !== hub && sim.routeDistanceKm(hub, c) > 300 && sim.routeDistanceKm(hub, c) < 4200).slice(0, n);
  const fleet = dests.map((d, i) => ({ id: `p${i}`, typeId: t.id, status: i % 11 === 10 ? 'grounded' : 'assigned', groundedWeeksLeft: 2, ageWeeks: 30 + i, config: sim.defaultConfig(t.seats), ownershipType: 'owned', purchasePrice: 50e6, tailNumber: `9V-${i}`, name: `P${i}` }));
  const routes = dests.map((d, i) => ({ id: `r${i}`, origin: hub, destination: d, stops: [hub, d], aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub, ticketPrice: 300 }));
  routes.push({ id: 'orphan', origin: hub, destination: dests[0], stops: [hub, dests[0]], aircraftId: 'gone', weeklyFrequency: 3, weeksOpen: 3, hub, ticketPrice: 300 });
  return { ...freshState(), phase: 'playing', week: 20, year: 3, hub, airlineName: 'Probe Air', cash: 5e9,
    competitors: [], encroachments: {}, hubs: { [hub]: { tier: 3, tierSince: 0 } }, fleet, routes, cargoRoutes: [], gates: Object.fromEntries([[hub, 400], ...dests.map(d => [d, 2])]) };
}
const state = airline(80);
const proj = projectWeek(state);
const referenceResults = (s, p) => {
  // projectedRouteResults as it was: a search of the fleet per route.
  const out = alerts.projectedRouteResults({ ...s, routes: [...s.routes] }, p);   // fresh tables: no memo hit
  return out.map(({ route, result }) => [route.id, result ? JSON.stringify(result) : null, s.fleet.find(a => a.id === route.aircraftId)?.id ?? null]);
};
test('the results are each route with its aircraft\'s result, as before', () => {
  const got = alerts.projectedRouteResults(state, proj);
  assert.equal(got.length, state.routes.length);
  for (const { route, result } of got) {
    const aircraft = state.fleet.find(a => a.id === route.aircraftId);
    if (!aircraft) assert.equal(result, null, `${route.id} has no aircraft and must have no result`);
    else assert.ok(result, `${route.id} has no result`);
  }
  assert.deepEqual(got.map(({ route, result }) => [route.id, result ? JSON.stringify(result) : null]), referenceResults(state, proj).map(([a, b]) => [a, b]));
});
test('same projection and tables: the same list, so nothing downstream is worked out again', () => {
  const a = alerts.projectedRouteResults(state, proj);
  const afterPopups = { ...state, pendingToasts: [], showDebrief: false };
  assert.equal(alerts.projectedRouteResults(afterPopups, proj), a, 'a screen-only change built the list again');
});
test('a new projection, a changed route table or a new week builds it again', () => {
  const a = alerts.projectedRouteResults(state, proj);
  assert.notEqual(alerts.projectedRouteResults(state, projectWeek({ ...state })), a);
  const edited = { ...state, routes: state.routes.map((r, i) => (i === 3 ? { ...r, ticketPrice: 333 } : r)) };
  const b = alerts.projectedRouteResults(edited, proj);
  assert.notEqual(b, a);
  assert.equal(b[3].route.ticketPrice, 333);
  assert.notEqual(alerts.projectedRouteResults({ ...state, week: 21 }, proj), a);
});

// ── Fleet ───────────────────────────────────────────────────────────────────
section('Fleet: a tail\'s utilisation kept until its inputs change');
test('utilFor keeps one answer per aircraft record, route lists, month and cap', () => {
  const src = read('src/components/Fleet.jsx');
  assert.match(src, /const UTIL_MEMO = new WeakMap\(\);/);
  assert.match(src, /if \(kept && kept\.pax === mine\.pax && kept\.cargo === mine\.cargo && kept\.month === month && kept\.cap === cap\) return kept\.value;/);
  assert.match(src, /UTIL_MEMO\.set\(aircraft, \{ pax: mine\.pax, cargo: mine\.cargo, month, cap, value \}\);/);
});

// ── after a dismissal ───────────────────────────────────────────────────────
section('a dismissed pop-up does not make every later click a mismatch');
test('the server\'s copy of the screen-only fields gives way to the browser\'s', () => {
  assert.ok(screen.withScreenFields, 'screenMemory.js has no withScreenFields');
  const server = { week: 3, routes: [1], pendingToasts: [{ id: 't1' }], showDebrief: true };
  const local = { week: 3, routes: [1], pendingToasts: [], showDebrief: false };
  const out = screen.withScreenFields(server, local);
  assert.deepEqual(out, { week: 3, routes: [1], pendingToasts: [], showDebrief: false });
  assert.equal(out.routes, server.routes, 'everything else is the server\'s');
  assert.equal(screen.withScreenFields(server, { ...server }), server, 'nothing to change: the same object');
  const noDebrief = screen.withScreenFields(server, { pendingToasts: [] });
  assert.ok(!('showDebrief' in noDebrief));
  assert.deepEqual(screen.SCREEN_ONLY_FIELDS, ['pendingToasts', 'showDebrief']);
});
test('every field a screen-only action writes is one of them', () => {
  const base = { ...freshState(), phase: 'playing', pendingToasts: [{ id: 'x', title: 't', message: 'm' }], showDebrief: true };
  for (const type of screen.SCREEN_ONLY_ACTIONS) {
    const next = gameReducer(base, { type });
    const changed = Object.keys(next).filter(k => next[k] !== base[k]);
    for (const k of changed) assert.ok(screen.SCREEN_ONLY_FIELDS.includes(k), `${type} writes ${k}, which the comparison would still count`);
  }
});
test('decision replies are compared with the screen-only fields as the browser has them', () => {
  const src = read('apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(src, /const server = withScreenFields\(serverState, local\);/);
  assert.match(src, /import \{ createScreenMemory, SCREEN_ONLY_ACTIONS, withScreenFields \} from '\.\/screenMemory\.js';/);
});

console.log(`\nscreens-at-scale-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
