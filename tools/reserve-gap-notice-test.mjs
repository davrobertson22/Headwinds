// The "uncovered" notice has to agree with the "dispatched" notice above it.
//
// Discord (Nilla_wafer, 2026-11-17), "Aircraft goes out of service with
// coverage but get notification of no coverage": the Weekly Debrief said
//
//   Fokker F27 Friendship #12 dispatched — covering 3 routes for The Bee #2
//   The Bee #2  1 route uncovered (~$255.5K/wk) — no same-type reserve based there
//
// Both lines were true. A reserve only takes routes that touch the airport it is
// based at (utils/simulation.js planCovers), and The Bee's fourth route, BUF → IAD,
// touches neither end. But the second line says there is no reserve, right under
// one that was just dispatched. Now the gap carries the route and where the
// reserves are, and every screen words it from one place (utils/coverGapText.js).
// Ported from Tailwinds.
//
//   node --import ./tools/_register-loader.mjs tools/reserve-gap-notice-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { applyReserveCovers, formatMoney } from '../src/utils/simulation.js';
import { coverGapLine, coverGapReason, coverGapSubject } from '../src/utils/coverGapText.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const TYPE = 'f27';
const bee = { id: 'bee2', typeId: TYPE, name: 'The Bee #2', tailNumber: 'NBUA11', status: 'grounded', groundedWeeksLeft: 1 };
const res = { id: 'r12', typeId: TYPE, name: 'Fokker F27 Friendship #12', tailNumber: 'NBUA20', status: 'idle', reserveBase: 'PIT' };
const route = (id, o, d, f = 3) => ({ id, aircraftId: bee.id, origin: o, destination: d, weeklyFrequency: f });
// Three routes from the reserve's base, and one that never touches it.
const routes = [route('r1', 'PIT', 'CLE'), route('r2', 'PIT', 'DTW'), route('r3', 'PIT', 'CMH'), route('r4', 'BUF', 'IAD', 14)];
const hubs = { PIT: { tier: 1 } };
const routeRevenues = { r1: 40_000, r2: 30_000, r3: 20_000, r4: 255_500 };

const pass = applyReserveCovers({ fleet: [bee, res], routes, hubs, absWeek: 10, routeRevenues });
const gap = pass.coverGaps[0];

console.log('\nReserve gap notices\n');

test('fixture: the reserve takes the three PIT routes and leaves BUF → IAD', () => {
  assert.equal(pass.coversStarted.length, 1);
  assert.equal(pass.coversStarted[0].routes, 3);
  assert.equal(pass.coverGaps.length, 1);
  assert.equal(gap.routes, 1);
  assert.equal(gap.reason, 'no-reserve');
});

test('the gap says which route and where the reserve is', () => {
  assert.deepEqual(gap.routeLabels, ['BUF → IAD']);
  assert.deepEqual(gap.bases, ['PIT']);
  assert.deepEqual(gap.coveredBy, ['Fokker F27 Friendship #12']);
});

test('the notice names the route and the covering reserve’s base, not "no reserve"', () => {
  const line = coverGapLine(gap, formatMoney);
  assert.match(line, /^BUF → IAD uncovered/);
  assert.match(line, /Fokker F27 Friendship #12 is based at PIT, and a reserve only takes routes that touch its base/);
  assert.ok(!/no same-type reserve/.test(line), `still says there is no reserve: ${line}`);
});

test('with no reserve of the type anywhere, it says so plainly', () => {
  const p = applyReserveCovers({ fleet: [bee], routes, hubs, absWeek: 10, routeRevenues });
  const g = p.coverGaps[0];
  assert.equal(g.routes, 4);
  assert.equal(coverGapSubject(g), '4 routes');
  assert.match(coverGapReason(g), /^no Fokker F27 Friendship reserve is on standby at an airport they touch$/);
});

test('a reserve at its block-hour cap is named', () => {
  const busy = route('r5', 'PIT', 'BUF', 60);
  const p = applyReserveCovers({ fleet: [bee, res], routes: [busy, route('r6', 'PIT', 'ORD', 60)], hubs, absWeek: 10,
    routeRevenues: { r5: 2, r6: 1 } });
  const g = p.coverGaps[0];
  assert.ok(g, 'fixture: expected the second route to exceed the reserve’s hours');
  assert.equal(g.reason, 'hours-full');
  assert.match(coverGapReason(g), /^Fokker F27 Friendship #12 is already at the weekly block-hour cap$/);
});

test('a gap saved before the detail fields keeps the old wording', () => {
  const old = { original: { name: 'X' }, routes: 2, revenueAtRisk: 1000, reason: 'no-reserve' };
  assert.match(coverGapLine(old, formatMoney), /^2 routes uncovered .* no same-type reserve is based at an airport these routes touch$/);
});

// ── The Weekly Debrief, rendered ───────────────────────────────────────────
const { GameProvider, gameReducer, freshState } = await import('../src/store/GameContext.jsx');
const WeeklyDebrief = (await import('../src/components/WeeklyDebrief.jsx')).default;

test('the Weekly Debrief shows the new line under the dispatch line', () => {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Bee Air', hub: 'PIT', enableObjectives: false });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(s.lastReport, 'fixture: no report after a week');
  const save = { ...s, showDebrief: true, lastReport: { ...s.lastReport,
    coverage: { started: pass.coversStarted, ended: [], permanent: [], gaps: pass.coverGaps } } };
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(WeeklyDebrief)))
    .replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(html, /BUF → IAD uncovered/, 'the debrief does not name the route');
  assert.match(html, /is based at PIT, and a reserve only takes routes that touch its base/);
  assert.ok(!/no same-type reserve based there/.test(html), 'the debrief still prints the old line');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
