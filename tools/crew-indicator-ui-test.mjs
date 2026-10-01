// Crew shortfall must be visible OUTSIDE the Operations page.
//
// Discord 2026-09-29: "Why am I not getting the full revenue from my routes?"
// The answer was crew — past the severe line the tick parks whole aircraft, and
// nothing on the Dashboard or the Fleet page said so. This proves, against the
// REAL screens, that:
//   - the summary names exactly the tails the tick will park (prepareWeek),
//   - the Dashboard carries a crew alert that links to Operations,
//   - the Fleet row marks a parked tail "No crew",
//   - a fully crewed airline and a classic save see none of it.
//
//   node --import ./tools/_register-loader.mjs tools/crew-indicator-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import {
  DEFAULT_LABOR_STATE, seedCrewFor, crewRequired, crewStatus, crewParkedAlertText,
} from '../src/data/labor.js';
import { prepareWeek } from '../packages/engine/src/utils/tickPrep.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Dashboard = (await import('../src/components/Dashboard.jsx')).default;
const Fleet = (await import('../src/components/Fleet.jsx')).default;
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const typeOf = (a) => getAircraftType(a.typeId);
const FLEET = Array.from({ length: 6 }, (_, i) => ({
  id: `ac${i}`, typeId: NB.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
  status: 'assigned', ageWeeks: 52 + i, ownershipType: 'owned', config: { economy: NB.seats },
}));
const ROUTES = FLEET.map((a, i) => ({
  id: `r${i}`, origin: 'JFK', destination: ['ORD', 'ATL', 'BOS', 'MIA', 'DCA', 'CLT'][i],
  aircraftId: a.id, weeklyFrequency: 14, active: true,
}));

const crewed = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
// Half the pilots the fleet needs: far past the 15% severe line.
const halfPilots = { ...crewed, pilots: { ...crewed.pilots, headcount: crewRequired('pilots', FLEET, typeOf) * 0.5 } };
// A few percent short: inside the soft band.
const slightlyShort = { ...crewed, pilots: { ...crewed.pilots, headcount: crewRequired('pilots', FLEET, typeOf) * 0.93 } };

function seed(extra = {}) {
  const save = {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000,
    gates: { JFK: 12 }, fleet: FLEET, routes: ROUTES, crewPipeline: true, labor: crewed, ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

console.log('\n── Crew indicator outside Operations ───────────────────');

test('the summary parks exactly the tails the tick parks', () => {
  const st = seed({ labor: halfPilots });
  const s = crewStatus(st, typeOf);
  const prep = prepareWeek(st, { rollNewEvents: false });
  assert.ok(s.parkedIds.length > 0, 'half the pilots must park aircraft');
  assert.deepEqual([...s.parkedIds].sort(), [...prep.crewGroundedIds].sort());
  assert.equal(s.level, 'grounding');
  assert.equal(s.parkedOnRoutes, s.parkedIds.length, 'every tail here flies a route');
});

test('the dashboard says aircraft cannot fly, and links to Operations', () => {
  seed({ labor: halfPilots });
  const html = render(React.createElement(Dashboard));
  const n = crewStatus(seed({ labor: halfPilots }), typeOf).parkedIds.length;
  assert.ok(html.includes(`${n} aircraft can't fly this week`) || html.includes(`${n} aircraft can&#x27;t fly this week`),
    'parked-aircraft alert missing from the dashboard');
  assert.ok(/Pilots \d[\d,]* short/.test(html), 'the alert names the short group');
});

test('the fleet row marks a parked tail "No crew"', () => {
  seed({ labor: halfPilots });
  const html = render(React.createElement(Fleet));
  const n = crewStatus(seed({ labor: halfPilots }), typeOf).parkedIds.length;
  assert.equal((html.match(/No crew/g) ?? []).length, n, 'one badge per parked tail');
});

test('a soft-band shortfall warns without claiming anything is parked', () => {
  seed({ labor: slightlyShort });
  const s = crewStatus(seed({ labor: slightlyShort }), typeOf);
  assert.equal(s.level, 'short');
  const text = crewParkedAlertText(s);
  assert.ok(/Short-handed/.test(text) && !/can't fly/.test(text), text);
  const fleetHtml = render(React.createElement(Fleet));
  assert.ok(!fleetHtml.includes('No crew'));
});

test('a fully crewed airline and a classic save see no crew alert', () => {
  seed();
  assert.equal(crewParkedAlertText(crewStatus(seed(), typeOf)), null);
  assert.ok(!/can.{0,6}t fly this week|Short-handed/.test(render(React.createElement(Dashboard))));
  const classic = seed({ crewPipeline: false, labor: halfPilots });
  assert.equal(crewStatus(classic, typeOf), null);
  assert.ok(!render(React.createElement(Fleet)).includes('No crew'));
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
