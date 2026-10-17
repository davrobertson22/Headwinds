// Crew attrition balance pass (2026-10-17) — what the Operations crew card says.
// SSR-renders the real page. Engine side: tools/crew-attrition-balance-test.mjs.
//
//   node --import ./tools/_register-loader.mjs tools/crew-attrition-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import { DEFAULT_LABOR_STATE, seedCrewFor, crewRequired, crewBodies, moraleTarget } from '../src/data/labor.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations = (await import('../src/components/Operations.jsx')).default;
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const typeOf = (a) => getAircraftType(a.typeId);
const FLEET = Array.from({ length: 180 }, (_, i) => ({
  id: `ac${i}`, typeId: NB.id, name: `Tail ${i}`, tailNumber: `N${i}T`,
  status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats },
}));

function page({ pay = 2.0, autoReplace = false, cabinShort = 0 } = {}) {
  const seeded = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const labor = Object.fromEntries(Object.entries(seeded).map(([id, g]) => [id, {
    ...g, payMultiplier: pay, indexed: true, morale: moraleTarget(pay), autoReplace,
  }]));
  labor.cabinCrew.headcount = crewRequired('cabinCrew', FLEET, typeOf) * (1 - cabinShort);
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 27, hub: 'JFK', cash: 900_000_000,
    gates: { JFK: 40 }, fleet: FLEET, routes: [], crewPipeline: true, labor,
  }));
  return render(React.createElement(Operations));
}

console.log('\n── Operations: crew card after the attrition pass ───────');

test('a gap inside the reserve band reads as covered, not as a short-handed warning', () => {
  const html = page({ cabinShort: 0.006, autoReplace: true });
  const missing = crewBodies('cabinCrew', crewRequired('cabinCrew', FLEET, typeOf) * 0.006);
  assert.ok(missing >= 2, `fixture should be a few people short (${missing})`);
  assert.ok(/short, covered by reserves/.test(html), 'should say the gap is covered by reserves');
  assert.ok(!/Short-handed|Severely short/.test(html), 'no understaffing warning inside the reserve band');
});

test('auto-replace says it hires ahead', () => {
  const html = page({ autoReplace: true });
  assert.ok(/hires ahead of leavers so you stay fully staffed/.test(html));
  assert.ok(/replaced automatically; their cover is already in training/.test(html));
});

test('at top pay without auto-replace, the leavers line says this is the floor — not "pay above market"', () => {
  const html = page({ pay: 2.0, autoReplace: false });
  assert.ok(/as low as it goes/.test(html), 'top pay should be explained as the floor');
  assert.ok(!/pay above market to slow it/.test(html), 'must not tell a 2.0× airline to pay above market');
});

test('below top pay without auto-replace, it still points at both levers', () => {
  const html = page({ pay: 1.0, autoReplace: false });
  assert.ok(/pay more to slow it, or tick/.test(html));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
