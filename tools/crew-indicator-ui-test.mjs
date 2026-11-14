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
const FleetMod = await import('../src/components/Fleet.jsx');
const Fleet = FleetMod.default;
const { AircraftDetail } = FleetMod;
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

// Discord, Nilla_wafer 2026-11-13 ("Not enough crew but airline still flying"):
// the row said "No crew" while the open panel beside it showed 3 routes, 138h of
// flying and +$1.49M/wk. The tick earns nothing from a parked tail, so the panel
// must say what the week will actually book: no revenue, no flying, the fixed
// bill only — with the crewed figure offered as what it earns once staffed.
const netBox = (html) => {
  const i = html.indexOf('Net / wk (incl. fixed)');
  assert.ok(i >= 0, 'net box missing');
  return html.slice(i, i + 900);
};
const utilBox = (html) => {
  const i = html.indexOf('Utilisation (');
  assert.ok(i >= 0, 'utilisation box missing');
  return html.slice(i, i + 1200);
};

test('the open panel of a parked tail books no revenue and no flying this week', () => {
  const st = seed({ labor: halfPilots });
  const parkedId = crewStatus(st, typeOf).parkedIds[0];
  const ac = st.fleet.find((a) => a.id === parkedId);
  const html = render(React.createElement(AircraftDetail, { aircraft: ac, onClose: () => {} }));
  const net = netBox(html);
  assert.ok(!/>\+\$/.test(net), `a parked tail must not show a profit: ${net.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
  assert.ok(/rev \$0\b/.test(net), 'parked: revenue this week is $0');
  assert.ok(/no crew/i.test(net), 'the net box says why');
  const util = utilBox(html).replace(/<[^>]+>/g, ' ');
  assert.ok(/\b0\.0h\b/.test(util), `parked: no block hours this week (${util.replace(/\s+/g, ' ').slice(0, 160)})`);
});

test('…while a crewed tail on the same screen still shows its earnings', () => {
  const st = seed({ labor: halfPilots });
  const parked = new Set(crewStatus(st, typeOf).parkedIds);
  const ac = st.fleet.find((a) => !parked.has(a.id));
  assert.ok(ac, 'half the pilots must leave some tails flying');
  const html = render(React.createElement(AircraftDetail, { aircraft: ac, onClose: () => {} }));
  assert.ok(!/no crew/i.test(netBox(html)));
  assert.ok(!/rev \$0\b/.test(netBox(html)));
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
