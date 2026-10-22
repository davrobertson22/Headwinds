// Fleet ▸ change the flights on an aircraft's routes without the Routes list.
//
// Discord, VodkaOnFire 2026-10-21: "Suggestion to add an option in the fleet
// menu to add flights [to] planes that already have routes. Just so [our]
// brains can increase routes to the same amount for each route a plane flies
// rather than having to look through the routes list."
//
// Three doors, one rule. The aircraft card gets a stepper on every route and an
// "Adjust flights on all routes" row; the fleet table's selection bar gets a
// Flights/wk row for every route the ticked aircraft fly. All of them go
// through planBulkFrequency / BULK_ADJUST_FREQUENCY (Routes ▸ Bulk Frequency's
// engine) — which now takes FREIGHT routes too, through the freight stepper's
// own guard, because a freighter's card has nowhere else to send them.
//
// Headwinds: the server's BULK_ADJUST_FREQUENCY guard and the batch splitter
// both kept passenger route ids only, so section 4 pins that a freighter's
// routes survive both — otherwise the card would preview a change the server
// then threw away as "Unknown routes". Ported from Tailwinds.
//
// Verified failing on HEAD: planBulkFrequency silently dropped freight route
// ids (the plan was empty, the reducer a no-op), the guard refused them, and the
// aircraft card printed "N× / wk" with no control.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-flights-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };
globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };

const engine = await import('../src/store/GameContext.jsx');
const { gameReducer, freshState, planBulkFrequency, planBulkFrequencyBatched, bulkFrequencyBatches, cargoFrequencyChangeBlockReason, GameProvider } = engine;
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const { AircraftDetail } = await import('../src/components/Fleet.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const F = AIRCRAFT_TYPES.find(t => t.id === 'b777f');
assert.ok(F?.freighter && F.range >= 7000, 'fixture needs the 777F');
const AC = (id, typeId) => ({ id, typeId, name: `AC ${id}`, tailNumber: `N${id}`, status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: typeId === 'a320neo' ? { economy: 180 } : undefined });
const R  = (id, o, d, aircraftId, weeklyFrequency) => ({ id, origin: o, destination: d, stops: [o, d], aircraftId, weeklyFrequency, weeksOpen: 30, ticketPrice: 250 });
const C  = (id, o, d, aircraftId, weeklyFrequency) => ({ id, origin: o, destination: d, aircraftId, weeklyFrequency, weeksOpen: 30, cargo: true, hub: 'JFK', yieldPrice: 0.4 });
function fixture() {
  return {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 5e8, competitors: [],
    fleet: [AC('a1', 'a320neo'), AC('f1', F.id), AC('f2', F.id)],
    routes: [R('s1', 'JFK', 'DCA', 'a1', 3), R('s2', 'JFK', 'BOS', 'a1', 5)],
    cargoRoutes: [C('c1', 'JFK', 'ORD', 'f1', 2), C('c2', 'JFK', 'ATL', 'f1', 2), C('c3', 'JFK', 'FRA', 'f2', 2)],
    gates: { JFK: 10, DCA: 4, BOS: 4, ORD: 4, ATL: 4, FRA: 4 },
  };
}
const freqOf = (s, id) => [...s.routes, ...s.cargoRoutes].find(r => r.id === id).weeklyFrequency;

console.log('\nFleet ▸ flights on an aircraft\'s routes\n');
console.log('── 1. Freight routes go through the same plan ──');

test("set 'each route to 6' on a freighter's two routes", () => {
  const s = fixture();
  const plan = planBulkFrequency(s, ['c1', 'c2'], { mode: 'set', value: 6 });
  assert.equal(plan.changed, 2, 'freight route ids were dropped from the plan');
  assert.deepEqual(plan.plan.map(e => [e.routeId, e.from, e.to]), [['c1', 2, 6], ['c2', 2, 6]]);
  const next = gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ['c1', 'c2'], mode: 'set', value: 6 });
  assert.equal(freqOf(next, 'c1'), 6);
  assert.equal(freqOf(next, 'c2'), 6);
  assert.equal(next.routes, s.routes, 'passenger routes were touched');
});

test("the freight stepper's guard caps it, and says why", () => {
  const s = fixture();
  const plan = planBulkFrequency(s, ['c3'], { mode: 'delta', value: 40 });
  const e = plan.plan[0];
  assert.ok(e.to > 2 && e.to < 42, `expected a partial step on the long-haul freighter, got ${e.from} → ${e.to}`);
  assert.match(e.reason ?? '', /Freighter's weekly block-hour limit/);
  assert.ok(cargoFrequencyChangeBlockReason(plan.state, 'c3', e.to + 1), 'one more than planned should be refused');
});

test("'fill spare hours' shares a freighter's hours between its routes", () => {
  const s = fixture();
  const plan = planBulkFrequency(s, ['c1', 'c2'], { mode: 'max' });
  const [a, b] = plan.plan;
  assert.ok(a.to > 2 && b.to > 2, 'one route took everything');
  assert.ok(Math.abs(a.to - b.to) <= Math.max(2, Math.ceil(a.to * 0.5)), `lopsided: ${a.to} vs ${b.to}`);
});

test('passenger and freight together, in one action', () => {
  const s = fixture();
  const next = gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ['s1', 'c1'], mode: 'delta', value: 1 });
  assert.equal(freqOf(next, 's1'), 4);
  assert.equal(freqOf(next, 'c1'), 3);
});

test('reductions and the 1/wk floor hold for freight too', () => {
  const s = fixture();
  const next = gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ['c1', 'c3'], mode: 'delta', value: -9 });
  assert.equal(freqOf(next, 'c1'), 1);
  assert.equal(freqOf(next, 'c3'), 1);
});

console.log('\n── 2. The aircraft card ──');

function renderCard(id) {
  const save = fixture();
  store.set('bbae_save_v2', JSON.stringify(save));
  const ac = save.fleet.find(a => a.id === id);
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(AircraftDetail, { aircraft: ac, onClose() {}, onConfigure() {}, onRetire() {}, onSell() {} })))
    .replace(/<!-- -->/g, '');
}

test('every route on a passenger aircraft has its own stepper', () => {
  const html = renderCard('a1');
  assert.match(html, /aria-label="flights per week, JFK to DCA"/);
  assert.match(html, /aria-label="flights per week, JFK to BOS"/);
  assert.match(html, /data-adjust-flights="a1"/);
  assert.match(html, /Adjust flights on all routes/);
});

test("a freighter's card has them too", () => {
  const html = renderCard('f1');
  assert.match(html, /aria-label="flights per week, JFK to ORD"/);
  assert.match(html, /aria-label="flights per week, JFK to ATL"/);
});

console.log('\n── 3. The fleet table\'s selection bar ──');

test('a Flights/wk row for every route the ticked aircraft fly', () => {
  const s = readFileSync(join(ROOT, 'src', 'components', 'Fleet.jsx'), 'utf8');
  assert.ok(s.includes('data-bulk-flights=""'), 'no Flights/wk button on the selection bar');
  assert.ok(/<RouteFrequencyControls routeIds=\{checkedRouteIds\}/.test(s), 'the bar does not plan the ticked aircraft\'s routes');
  assert.ok(/\[\.\.\.\(state\.routes \?\? \[\]\), \.\.\.\(state\.cargoRoutes \?\? \[\]\)\]\s*\.filter\(r => checkedIds\.includes\(r\.aircraftId\)\)/.test(s),
    'the selection does not cover passenger AND freight routes');
});

console.log('\n── 4. The server and the batches keep freight ids ──');

test('the server guard accepts a freighter\'s routes', () => {
  const s = fixture();
  const g = guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: ['c1', 'c2', 's1', 'nope'], mode: 'set', value: 4 }, s);
  assert.deepEqual(g, { routeIds: ['c1', 'c2', 's1'], mode: 'set', value: 4 });
});

test('the batch splitter keeps them, and the batched plan is the plain one', () => {
  const s = fixture();
  assert.deepEqual(bulkFrequencyBatches(s, ['c1', 'c2']), [['c1', 'c2']]);
  const a = planBulkFrequencyBatched(s, ['c1', 'c2'], { mode: 'set', value: 5 });
  const b = planBulkFrequency(s, ['c1', 'c2'], { mode: 'set', value: 5 });
  assert.deepEqual(a.plan, b.plan);
  assert.deepEqual(a.batches, [['c1', 'c2']]);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
