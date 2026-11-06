// Gate rent in demand model v4 worlds — flat by tier with a volume discount
// (docs/game-audit-2026-11-06.md R4).
//
//   node tools/gate-rent-v4-test.mjs
//
// Before v4 each extra gate at one airport cost more than the last (the 80th
// gate at O'Hare four times the 5th), punishing exactly the fortress hub real
// airlines build. v4 bills a flat tier rate with a big-tenant discount; older
// worlds keep the escalating curve unchanged.
import assert from 'node:assert/strict';
import { getAirport, gateMonthlyFee, totalGateMonthlyFee } from '../packages/engine/src/data/airports.js';
import { setDemandModel } from '../packages/engine/src/utils/market.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const ORD = getAirport('ORD');
const perGate = (n) => totalGateMonthlyFee(ORD, n) / n;

console.log('\nGate rent (v4)\n');

test('v4: per-gate rent at a mega airport falls as the holding grows', () => {
  setDemandModel(4);
  assert.ok(perGate(80) < perGate(20) && perGate(20) < perGate(10) + 1, `${perGate(10)} / ${perGate(20)} / ${perGate(80)}`);
  assert.equal(gateMonthlyFee(ORD, 1), gateMonthlyFee(ORD, 10), 'the first ten gates bill the flat tier rate');
  assert.ok(gateMonthlyFee(ORD, 30) < gateMonthlyFee(ORD, 1), 'a big tenant pays less for its marginal gate');
  setDemandModel(1);
});

test('v3 / classic: the escalating curve is unchanged', () => {
  for (const m of [3, 1]) {
    setDemandModel(m);
    assert.ok(perGate(80) > perGate(20) * 1.5, `v${m}: ${perGate(20)} vs ${perGate(80)}`);
  }
  setDemandModel(1);
});

test('the tick bills v4 gate rent (the reducer sets the knob from the save)', () => {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'G', hub: 'ORD', enableObjectives: false });
  s = { ...s, cash: 5e9, demandModel: 4, newWorldRestrictions: true };
  for (let i = 0; i < 39; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  const held = s.gates?.ORD ?? 0;
  assert.ok(held >= 30, `fixture holds ${held} ORD gates`);
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const billed = next.financialHistory.at(-1).gates;
  setDemandModel(4);
  const want = Math.round(totalGateMonthlyFee(ORD, held) / 4);
  setDemandModel(3);
  const old = Math.round(totalGateMonthlyFee(ORD, held) / 4);
  setDemandModel(1);
  assert.ok(Math.abs(billed - want) <= want * 0.25 + 1, `tick billed ${billed}, v4 rent ${want} (v3 would be ${old})`);
  assert.ok(billed < old * 0.6, `v4 bill ${billed} should be well under the v3 curve ${old}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
