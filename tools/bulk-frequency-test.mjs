// Routes ▸ Bulk Frequency: change flights/wk on many routes in one action.
//
// Discord, Barca 2026-10-16: "Bulk pricing but instead it adjusts route
// frequency." planBulkFrequency is the whole rule — the Routes preview and the
// BULK_ADJUST_FREQUENCY reducer case both call it — and every step goes through
// frequencyChangeBlockReason, the guard behind the per-route stepper. This
// suite pins:
//
//   · the action exists end to end: reducer case, server allow-list, guard
//   · each route moves by the asked amount when it fits, and by the most that
//     fits when it doesn't — saying which guard stopped it
//   · routes sharing a tail / an airport are checked against each other, in
//     order, so a batch can never land a schedule the stepper would refuse
//   · 'max' shares a tail's spare hours round-robin instead of the first route
//     taking all of them
//   · nothing goes below 1/wk; reductions are never refused
//   · the plan the preview shows is exactly the state the reducer lands
//   · SSR: the Routes screen offers it (header button + selection bar)
//
// Verified failing on HEAD: there BULK_ADJUST_FREQUENCY is not a reducer case
// (the reducer hands back the same state object, so every "moved" assertion
// fails), planBulkFrequency is not exported, and the server rejects the type as
// "action not allowed".
//
//   node --import ./tools/_register-loader.mjs tools/bulk-frequency-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };
globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };

const engine = await import('../packages/engine/src/reducer.mjs');
const { gameReducer, freshState, frequencyChangeBlockReason, slotCapAt, slotsUsedAt } = engine;
const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { committedPeakBlockHours, maxWeeklyBlockHoursFor } = await import('../packages/engine/src/utils/simulation.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const planBulkFrequency = engine.planBulkFrequency ?? (() => { throw new Error('planBulkFrequency is not exported'); });

// ── Fixture ──────────────────────────────────────────────────────────────────
// a1 flies two short routes (lots of spare hours, shared between them); a2 a
// long-haul near its cap; a3 a route into BOS where gate slots are tight.
const AC = (id, typeId) => ({ id, typeId, name: `AC ${id}`, tailNumber: `N${id}`, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' });
const R = (id, o, d, aircraftId, weeklyFrequency) => ({ id, origin: o, destination: d, stops: [o, d], aircraftId, weeklyFrequency, weeksOpen: 30, ticketPrice: 250 });
function fixture() {
  return {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 5e8,
    fleet: [AC('a1', 'a320neo'), AC('a2', 'b7879'), AC('a3', 'a320neo')],
    routes: [
      R('s1', 'JFK', 'DCA', 'a1', 4),
      R('s2', 'JFK', 'PHL', 'a1', 4),
      R('l1', 'JFK', 'NRT', 'a2', 3),
      R('b1', 'JFK', 'BOS', 'a3', 10),
    ],
    gates: { JFK: 10, DCA: 4, PHL: 4, NRT: 4, BOS: 1 },   // BOS: 50 slots, 10 used
  };
}
const freqs = (s) => Object.fromEntries(s.routes.map(r => [r.id, r.weeklyFrequency]));

console.log('\n── bulk frequency: the action ────────────────────────────────');

test('the server allows BULK_ADJUST_FREQUENCY', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('BULK_ADJUST_FREQUENCY'), 'not on ALLOWED_PLAYER_ACTIONS — the client drops it');
});

test('the guard keeps own route ids, a known mode and a bounded value', () => {
  const s = fixture();
  const g = guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: ['s1', 's1', 'nope', 'b1'], mode: 'delta', value: 500 }, s);
  assert.deepEqual(g, { routeIds: ['s1', 'b1'], mode: 'delta', value: 99 });
  assert.throws(() => guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: ['s1'], mode: 'warp', value: 1 }, s), /Unknown frequency change/);
  assert.throws(() => guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: [], mode: 'delta', value: 1 }, s), /No routes/);
  assert.throws(() => guardDecision('BULK_ADJUST_FREQUENCY', { routeIds: ['zzz'], mode: 'delta', value: 1 }, s), /Unknown routes/);
});

test('+2 on everything: each route moves by 2 where it fits', () => {
  const s = fixture();
  const next = gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ['s1', 's2', 'b1'], mode: 'delta', value: 2 });
  assert.notEqual(next, s, 'the reducer handed back the same state — BULK_ADJUST_FREQUENCY did nothing');
  assert.deepEqual(freqs(next), { s1: 6, s2: 6, l1: 3, b1: 12 });
});

test('a route that cannot take the whole step takes the most that fits, and says why', () => {
  const s = fixture();
  const cap = maxWeeklyBlockHoursFor(s);
  const plan = planBulkFrequency(s, ['l1'], { mode: 'delta', value: 20 });
  const e = plan.plan[0];
  assert.ok(e.to > 3 && e.to < 23, `expected a partial step on the long-haul, got ${e.from} → ${e.to}`);
  assert.equal(e.reason, "Aircraft's weekly block-hour limit");
  assert.equal(frequencyChangeBlockReason(plan.state, 'l1', e.to + 1), "Aircraft's weekly block-hour limit",
    'one more flight than planned should be refused by the stepper');
  assert.ok(committedPeakBlockHours('a2', getAircraftType('b7879'), plan.state.routes, []) <= cap);
  assert.equal(plan.capped, 1);
});

test('gate slots are shared across the batch: the later route gets what is left', () => {
  // BOS has 50 slots; b1 uses 10. Two BOS routes asking +30 each cannot both get it.
  const s = fixture();
  s.fleet.push(AC('a4', 'a320neo'));
  s.routes.push(R('b2', 'PHL', 'BOS', 'a4', 5));
  const plan = planBulkFrequency(s, ['b1', 'b2'], { mode: 'delta', value: 30 });
  const used = slotsUsedAt(plan.state.routes, 'BOS');
  assert.ok(used <= slotCapAt(plan.state, 'BOS'), `BOS over its slots: ${used}/${slotCapAt(plan.state, 'BOS')}`);
  const [b1, b2] = plan.plan;
  assert.equal(b1.to, 40, 'b1 asked first and fits whole');
  assert.ok(b2.to < 35 && /No free gate slots at BOS/.test(b2.reason ?? ''), `b2 should be capped at BOS, got ${b2.to} (${b2.reason})`);
});

test('set to N: up where it fits, down always', () => {
  const s = fixture();
  const plan = planBulkFrequency(s, ['s1', 'b1'], { mode: 'set', value: 7 });
  assert.deepEqual(plan.plan.map(e => [e.routeId, e.from, e.to]), [['s1', 4, 7], ['b1', 10, 7]]);
  assert.equal(plan.added, 3); assert.equal(plan.removed, 3);
});

test('never below 1/wk, and reductions are never refused', () => {
  const s = fixture();
  const next = gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ['s1', 'l1', 'b1'], mode: 'delta', value: -50 });
  assert.deepEqual(freqs(next), { s1: 1, s2: 4, l1: 1, b1: 1 });
});

test("'max' fills spare hours round-robin: two routes on one tail share them", () => {
  const s = fixture();
  const plan = planBulkFrequency(s, ['s1', 's2'], { mode: 'max' });
  const [s1, s2] = plan.plan;
  assert.ok(s1.to > 4 && s2.to > 4, 'both routes should grow');
  assert.ok(Math.abs(s1.to - s2.to) <= 1, `spare hours were not shared: s1 ${s1.to}, s2 ${s2.to}`);
  // …and the tail is full: neither can take one more.
  assert.ok(frequencyChangeBlockReason(plan.state, 's1', s1.to + 1));
  assert.ok(frequencyChangeBlockReason(plan.state, 's2', s2.to + 1));
  assert.equal(plan.capped, 0, "'max' got everything it asked for");
  assert.ok(s1.stoppedBy, 'what stopped it is reported');
});

test('the reducer lands exactly the state the plan previewed', () => {
  const s = fixture();
  for (const spec of [{ mode: 'delta', value: 3 }, { mode: 'set', value: 9 }, { mode: 'max', value: 0 }]) {
    const ids = ['s1', 's2', 'l1', 'b1'];
    const plan = planBulkFrequency(s, ids, spec);
    const next = gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ids, ...spec });
    assert.deepEqual(freqs(next), freqs(plan.state), `${spec.mode}: reducer and preview disagree`);
  }
});

test('every frequency the batch lands is one the stepper accepts, in the same order', () => {
  // Walk the same changes one UPDATE_FREQUENCY at a time, in plan order: the
  // reducer's own single-route guard must accept every one of them.
  const s = fixture();
  s.fleet.push(AC('a4', 'a320neo'));
  s.routes.push(R('b2', 'PHL', 'BOS', 'a4', 5));
  for (const spec of [{ mode: 'delta', value: 25 }, { mode: 'set', value: 30 }]) {
    const plan = planBulkFrequency(s, ['s1', 's2', 'l1', 'b1', 'b2'], spec);
    let walk = s;
    for (const e of plan.plan) {
      walk = gameReducer(walk, { type: 'UPDATE_FREQUENCY', routeId: e.routeId, weeklyFrequency: e.to });
    }
    assert.deepEqual(freqs(walk), freqs(plan.state), `${spec.mode}: a step the stepper would refuse`);
  }
});

test('nothing to change → same state object (no empty server write)', () => {
  const s = fixture();
  assert.equal(gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: ['s1'], mode: 'set', value: 4 }), s);
  assert.equal(gameReducer(s, { type: 'BULK_ADJUST_FREQUENCY', routeIds: [], mode: 'delta', value: 2 }), s);
});

console.log('\n── bulk frequency: the Routes screen ─────────────────────────');

const { GameProvider } = await import('../src/store/GameContext.jsx');
const Routes = (await import('../src/components/Routes.jsx')).default;
const html = (() => {
  store.set('bbae_save_v2', JSON.stringify(fixture()));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Routes))).replaceAll('<!-- -->', '');
})();

test('the header offers Bulk Frequency next to Bulk Pricing', () => {
  assert.ok(html.includes('Bulk Pricing'), 'fixture broke: no Bulk Pricing button');
  assert.ok(html.includes('Bulk Frequency'), 'no Bulk Frequency button on the Routes screen');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} bulk-frequency: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
