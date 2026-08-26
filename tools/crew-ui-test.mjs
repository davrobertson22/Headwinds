// SSR-renders the REAL Operations page against a seeded save, so the crew panel
// is proven to quote the same numbers the engine will act on — a helper tested
// alone can pass while the screen calling it is wrong.
//
//   node --import ./tools/_register-loader.mjs tools/crew-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import { formatMoney } from '../src/utils/simulation.js';
import {
  DEFAULT_LABOR_STATE, seedCrewFor, crewRequired, crewHireCost, CREW_LEAD_WEEKS,
} from '../src/data/labor.js';

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
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('test bodies must be synchronous');
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations = (await import('../src/components/Operations.jsx')).default;
// React SSR splits adjacent text nodes with <!-- --> markers; strip them so
// assertions match what a reader actually sees on the page.
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const typeOf = (a) => getAircraftType(a.typeId);
const FLEET = Array.from({ length: 4 }, (_, i) => ({
  id: `ac${i}`, typeId: NB.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
  status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats },
}));

function seed(extra = {}) {
  const save = {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000,
    gates: { JFK: 8 }, fleet: FLEET, routes: [], ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

console.log('\n── Operations: crew pipeline panel ─────────────────────');

test('a classic save shows no crew panel at all', () => {
  seed({ crewPipeline: false });
  const html = render(React.createElement(Operations));
  assert.ok(!/crewed/.test(html), 'classic save must not render staffing');
  assert.ok(!/in training/.test(html), 'classic save must not render a training line');
  assert.ok(!/Hire \d/.test(html), 'classic save must not offer hiring');
});

test('a fully staffed pipeline airline renders staffing and no warning', () => {
  seed({ crewPipeline: true, labor: seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf) });
  const html = render(React.createElement(Operations));
  assert.ok(/crewed/.test(html), 'staffing line missing');
  assert.ok(/fully staffed/.test(html), 'should say fully staffed');
  assert.ok(!/Short-handed/.test(html), 'must not warn when fully staffed');
});

test('an understaffed airline warns, and quotes the real hire cost + lead time', () => {
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const short = { ...labor, pilots: { ...labor.pilots, headcount: 1 } };
  seed({ crewPipeline: true, labor: short });
  const html = render(React.createElement(Operations));
  assert.ok(/Short-handed|Severely understaffed/.test(html), 'no shortfall warning rendered');
  assert.ok(/% short/.test(html), 'no shortfall percentage rendered');
  // The button must quote the SAME cost the reducer will charge.
  const gap = Math.ceil(crewRequired('pilots', FLEET, typeOf) - 1);
  assert.ok(html.includes(`${CREW_LEAD_WEEKS.pilots}-week training`), 'lead time not shown');
  // Quote the SAME number the reducer charges, formatted the way the app does.
  const cost = crewHireCost('pilots', gap);
  assert.ok(html.includes(formatMoney(cost)),
    `hire button should quote the engine cost for ${gap} (${formatMoney(cost)})`);
});

test('crew in training are surfaced with a ready-in countdown', () => {
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const training = {
    ...labor,
    pilots: { ...labor.pilots, pipeline: [{ count: 3, readyAbsWeek: (2 - 1) * 52 + 20 + 6 }] },
  };
  seed({ crewPipeline: true, labor: training });
  const html = render(React.createElement(Operations));
  assert.ok(/3 in training/.test(html), 'training count not shown');
  assert.ok(/next ready in 6 wks/.test(html), 'ready-in countdown not shown');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
