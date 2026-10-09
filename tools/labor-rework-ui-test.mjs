// The Labor screen for the labor rework (Discord, 2026-10-04): SSR-renders the
// real Operations page — the recruiting queue with its refund, the weekly
// recruiting rate, what rivals pay, and the wage lock.
//
//   node --import ./tools/_register-loader.mjs tools/labor-rework-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations = (await import('../src/components/Operations.jsx')).default;
const labor = await import('../src/data/labor.js');
const { getAircraftType } = await import('../src/data/aircraft.js');
const render = () => renderToString(React.createElement(GameProvider, null, React.createElement(Operations))).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const typeOf = (a) => getAircraftType(a.typeId);
const fleet = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, typeId: NB.id, status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats } }));
function seed({ cabin = {}, laborMarket } = {}) {
  const seeded = labor.seedCrewFor(labor.DEFAULT_LABOR_STATE, fleet, typeOf);
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 4e8, gates: { JFK: 8 },
    crewPipeline: true, fleet, routes: [],
    labor: { ...seeded, cabinCrew: { ...seeded.cabinCrew, ...cabin } },
    ...(laborMarket ? { laborMarket } : {}),
  }));
}

console.log('\n── Labor screen: talent market + wage lock ─────────────');

test('a recruiting queue shows how many wait, how fast it fills, and a refund', () => {
  seed({ cabin: { recruiting: 6 } });
  const html = render();
  const bodies = labor.crewBodies('cabinCrew', 6);
  assert.ok(html.includes(`${bodies.toLocaleString()} still being recruited`), `expected "${bodies} still being recruited"`);
  assert.ok(html.includes(`Cancel · refund ${'$'}`), 'cancel + refund button');
  assert.ok(/about \d+ wks? to fill/.test(html), 'weeks to fill');
});

test('with nothing queued, the card says how many it can recruit a week', () => {
  seed();
  const html = render();
  assert.ok(/Can recruit ≈[\d,]+ cabin crew a week at 1\.00×/.test(html));
  assert.ok(!html.includes('still being recruited'));
});

test('what rivals pay is shown when it differs from 1.0×, and the under-paid warning follows', () => {
  seed({ laborMarket: { pilots: 1.4, cabinCrew: 1.4, groundStaff: 1.4, maintenanceTeam: 1.4 } });
  const html = render();
  assert.ok(html.includes('rivals pay 1.40×'));
  assert.ok(html.includes('under the going rate, so recruits are scarce'));
});

test('solo (no laborMarket) shows no rival pay line', () => {
  seed();
  assert.ok(!render().includes('rivals pay'));
});

test('every group card offers the wage lock', () => {
  seed();
  const html = render();
  assert.equal(html.split('🔒 Hold this rate').length - 1, 4);
});

test('no contract-talks banner anywhere', () => {
  seed();
  assert.ok(!render().includes('Contract talks'));
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
