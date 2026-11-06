// The world business cycle — demand model v4 worlds (docs/game-audit-2026-11-06.md R5).
//
//   node tools/economy-cycle-test.mjs
//
// One shared multi-year cycle per world: it scales demand and new-lease rates,
// its phase is public, multiplayer replays it from the world seed, and older
// worlds carry no key and draw no random number for it.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { setDemandModel } from '../packages/engine/src/utils/market.js';
import { defaultClassPrices, referencePrice } from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { getAircraftType, eraWeeklyLease } from '../packages/engine/src/data/aircraft.js';
import { worldEconomyCycle, worldEconomyAt } from '../apps/headwinds-server/src/lib/worldEconomy.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const realRandom = Math.random;
const cyc = () => import('../packages/engine/src/models/economyCycle.js');

function airline(model, multiplayer = false, { hub = 'JFK', dest = 'BOS', typeId = 'b737800', freq = 7, nwr = true } = {}) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'C', hub, enableObjectives: false });
  s = { ...s, cash: 5e8, ...(nwr ? { newWorldRestrictions: true } : {}), ...(model ? { demandModel: model } : {}), ...(multiplayer ? { multiplayer: true, competitors: [], humanRivals: {} } : {}) };
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[0].id, origin: hub, destination: dest, weeklyFrequency: freq });
  const key = [hub, dest].sort().join('-');
  return { ...s, routePricing: { ...s.routePricing, [key]: defaultClassPrices(Math.round(referencePrice(hub, dest))) } };
}

console.log('\nWorld business cycle\n');

await test('the walk cycles over years and stays inside its bounds', async () => {
  const { newEconomyCycle, tickEconomyCycle } = await cyc();
  let seed = 99; const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let c = newEconomyCycle(); const xs = [];
  for (let w = 0; w < 1040; w++) { c = tickEconomyCycle(c, r()); xs.push(c.x); }
  let crossings = 0;
  for (let i = 1; i < xs.length; i++) if ((xs[i - 1] < 0) !== (xs[i] < 0)) crossings++;
  assert.ok(crossings >= 4 && crossings <= 40, `20 game years should hold a handful of cycles, got ${crossings} zero crossings`);
  const sd = Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
  assert.ok(sd > 0.015 && sd < 0.09, `swings of a few percent, got sd ${sd.toFixed(3)}`);
});

await test('solo v4: the cycle is walked, stored, and scales next week’s demand', async () => {
  const { cycleDemandMult } = await cyc();
  // A demand-limited route (BOI–SLC, a regional jet), so demand — not seats — decides the load.
  let s = airline(4, false, { hub: 'BOI', dest: 'SLC', typeId: 'e175', freq: 14 });
  for (let i = 0; i < 6; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(s.economyCycle && Number.isFinite(s.economyCycle.x), 'no economyCycle stored');
  assert.equal(s.economyCycle.history.length, 6);
  const boom = { ...s, economyCycle: { ...s.economyCycle, x: 0.08 } };
  const bust = { ...s, economyCycle: { ...s.economyCycle, x: -0.08 } };
  assert.ok(cycleDemandMult(boom) > 1.07 && cycleDemandMult(bust) < 0.93);
  Math.random = () => 0.9999999;
  try {
    const paxOf = (st) => gameReducer(st, { type: 'ADVANCE_WEEK' }).lastReport.routeResults[0].passengers;
    const pBoom = paxOf(boom), pBust = paxOf(bust);
    assert.ok(pBoom > pBust, `a boom should fly more passengers: ${pBoom} vs ${pBust}`);
  } finally { Math.random = realRandom; }
});

await test('the forecast prices the week on the same stored cycle the tick uses', () => {
  let s = airline(4);
  for (let i = 0; i < 4; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  s = { ...s, economyCycle: { ...s.economyCycle, x: -0.1 } };
  Math.random = () => 0.9999999;
  try {
    const proj = projectWeek(s);
    const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
    assert.equal(proj.report.routeResults[0].passengers, next.lastReport.routeResults[0].passengers);
  } finally { Math.random = realRandom; }
});

await test('a new lease signs at the cycle’s rate; the Market quotes the same number', () => {
  // (No restricted-world lease rules here: those cap a one-tail airline's order book.)
  let s = airline(4, false, { nwr: false });
  s = { ...s, economyCycle: { x: 0.1, prev: 0.09, history: [0.09, 0.1] } };
  // Restricted worlds lease through ORDER_AIRCRAFT; the rate is locked on the order.
  const after = gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', quantity: 1, ownershipType: 'lease', leaseTermWeeks: 104 });
  const order = (after.pendingOrders ?? []).at(-1);
  assert.ok(order, `no order placed: ${after.error ?? ''}`);
  const quoted = eraWeeklyLease(getAircraftType('a320neo'));   // knob set by the reducer from this state
  assert.ok(Math.abs(order.weeklyLease - quoted) <= quoted * 0.05, `locked ${order.weeklyLease} vs quoted ${quoted}`);
  const atTrend = gameReducer({ ...s, economyCycle: { x: 0, prev: 0, history: [0] } },
    { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', quantity: 1, ownershipType: 'lease', leaseTermWeeks: 104 }).pendingOrders.at(-1);
  assert.ok(order.weeklyLease > atTrend.weeklyLease * 1.05, `boom lease ${order.weeklyLease} vs trend ${atTrend.weeklyLease}`);
});

await test('multiplayer: every airline stores the world’s seeded value; a late joiner lands on it', () => {
  let s = airline(4, true);
  const c5 = worldEconomyCycle('seed-x', 5);
  const next = gameReducer(s, { type: 'ADVANCE_WEEK', economyCycle: c5 });
  assert.deepEqual(next.economyCycle, c5);
  assert.deepEqual(worldEconomyAt('seed-x', 6).economyCycle, c5, 'join backfill at week 6 = the cycle after week 5');
  assert.deepEqual(worldEconomyCycle('seed-x', 5), c5, 'replay is deterministic');
});

await test('v3 and classic saves get no key and draw no extra random number', () => {
  for (const m of [3, null]) {
    let draws = 0;
    const base = airline(m);
    Math.random = () => { draws++; return 0.37; };
    let s = gameReducer(base, { type: 'ADVANCE_WEEK' });
    const d1 = draws; draws = 0;
    Math.random = realRandom;
    assert.equal(s.economyCycle, undefined, `v${m ?? 1} stored a cycle`);
    // Same state, v4: exactly one more draw (the cycle step).
    Math.random = () => { draws++; return 0.37; };
    gameReducer({ ...base, demandModel: 4 }, { type: 'ADVANCE_WEEK' });
    Math.random = realRandom;
    assert.equal(draws, d1 + 1, `v4 should draw once more than v${m ?? 1}: ${draws} vs ${d1}`);
  }
});

await test('the Dashboard shows the phase in a v4 world and nothing elsewhere', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  const Econ = (await import('../src/components/EconomyIndicator.jsx')).default;
  const render = (save) => { store.set('bbae_save_v2', JSON.stringify({ ...save, phase: 'playing' }));
    return renderToString(React.createElement(GameProvider, null, React.createElement(Econ))); };
  const s = airline(4);
  const html = render({ ...s, economyCycle: { x: -0.06, prev: -0.05, history: [-0.02, -0.03, -0.04, -0.05, -0.06] } });
  assert.match(html, /data-economy-phase="contracting"/);
  assert.match(html, /World economy/);
  assert.equal(render({ ...s, demandModel: 3, economyCycle: undefined }).includes('World economy'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
setDemandModel(1);
if (failed > 0) process.exit(1);
