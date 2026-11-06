// Board mandates — a fresh goal every quarter (docs/game-audit-2026-11-06.md F2).
//
//   node --import ./tools/_register-loader.mjs tools/board-mandates-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { issueMandate, mandateMet, MANDATE_KINDS, MANDATE, quarterOf } from '../packages/engine/src/models/boardMandates.js';
import { absoluteWeek } from '../packages/engine/src/utils/fuel.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const snap = (over = {}) => ({
  report: { totalPassengers: 5000, totalRevenue: 1e6, totalCost: 950_000, routeResults: [{ loadFactor: 0.7 }] },
  routes: [{ origin: 'JFK', destination: 'BOS' }], satisfaction: 70,
  getCountry: (c) => ({ JFK: 'US', BOS: 'US', LHR: 'GB' }[c] ?? null), airlineName: 'Board Air', ...over,
});

console.log('\nBoard mandates\n');

await test('nothing in the first quarter; a mandate from the second on', () => {
  assert.equal(issueMandate(snap(), 5), null);
  const m = issueMandate(snap(), 14);
  assert.ok(m && MANDATE_KINDS[m.kind], JSON.stringify(m));
  assert.equal(m.endAbsWeek, 26);
  assert.equal(m.reward, MANDATE.reward);
});

await test('a mandate is never handed out already met, and is deterministic', () => {
  for (let w = 14; w < 300; w += 13) {
    const a = issueMandate(snap(), w), b = issueMandate(snap(), w);
    assert.deepEqual(a, b);
    assert.equal(mandateMet(a, snap()), false, `week ${w}: ${a.kind} met on issue`);
  }
});

await test('meeting the target in a later week satisfies it', () => {
  const m = { kind: 'pax_growth', target: 5500, status: 'open' };
  assert.equal(mandateMet(m, snap()), false);
  assert.equal(mandateMet(m, snap({ report: { ...snap().report, totalPassengers: 5600 } })), true);
});

function airline(model) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Board Air', hub: 'JFK', enableObjectives: true, objectiveSet: 'multiplayer' });
  s = { ...s, cash: 5e8, ...(model ? { demandModel: model } : {}) };
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'BOS' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[0].id, origin: 'JFK', destination: 'BOS', weeklyFrequency: 7 });
  return s;
}

await test('v4: the reducer issues a mandate at the quarter, pays it once, and keeps the history', () => {
  let s = airline(4);
  for (let i = 0; i < 14; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(s.boardMandate, 'no mandate issued by week 15');
  assert.equal(s.boardMandate.quarter, quarterOf(absoluteWeek(s.year, s.week)));
  // Force it met next week: the easiest target to hand the reducer.
  s = { ...s, boardMandate: { ...s.boardMandate, kind: 'new_routes', target: 1, status: 'open' } };
  const cash0 = s.cash;
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(next.boardMandate.status, 'met');
  assert.ok(next.pendingToasts.some(t => /Board mandate met/.test(t.title)));
  const delta = next.cash - cash0 - (next.lastReport.cashDelta ?? 0);
  assert.ok(Math.abs(delta - s.boardMandate.reward) < 2, `bonus not paid once: ${delta}`);
  const again = gameReducer(next, { type: 'ADVANCE_WEEK' });
  assert.equal(again.pendingToasts.some(t => /Board mandate met/.test(t.title)), false, 'paid twice');
});

await test('v3: no mandates', () => {
  let s = airline(3);
  for (let i = 0; i < 15; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.boardMandate, undefined);
});

await test('the Dashboard card shows the mandate even after the starter board is done', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  const Board = (await import('../src/components/BoardObjectives.jsx')).default;
  const s = airline(4);
  const done = s.objectives.map(o => ({ ...o, completed: true }));
  store.set('bbae_save_v2', JSON.stringify({ ...s, phase: 'playing', objectives: done,
    boardMandate: { kind: 'margin', target: 0.1, quarter: 3, endAbsWeek: 39, reward: 1_500_000, status: 'open' } }));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(Board)));
  assert.match(html, /data-mandate="margin"/);
  assert.match(html, /10% operating margin/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
