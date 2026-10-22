// Fleet → Market "Your families" filter.
//
// Discord, 2026-10-21 (VodkaOnFire): "Add 'Owned by you' filter to airliner
// market — Easier than to scroll through everything when looking to order more
// of your aircraft families."
//
// The chip narrows the market to the families you fly or have on order — by
// aircraftFamily(), the same grouping the MRO base cost and the fleet-complexity
// surcharge charge by — so the A321neo next to your A320neos is in it and a 737
// is not. It only exists once you own something: a new airline has no families,
// and a remembered "on" must not empty the market.
//
// Verified failing on HEAD: no data-market-filter="yourFamilies" chip renders,
// and a remembered { yourFamilies: true } leaves other families on the page.
//
// Ported from Tailwinds.
//
//   node --import ./tools/_register-loader.mjs tools/market-your-families-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ??= { localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1200 };
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;
globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
const { AIRCRAFT_TYPES, getAircraftType } = await import('../src/data/aircraft.js');
const { aircraftFamily } = await import('../src/data/families.js');
const { ownedFamilyIds } = await import('../src/utils/marketFilters.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const clean = (html) => html.replace(/<!-- -->/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const FIXED_RIVAL = { id: 'fixed', name: 'Fixed Air', homeHub: 'ORD', tier: 'legacy', cash: 1e8, routes: {}, fleet: [] };
const base = (over = {}) => ({
  ...freshState(), phase: 'playing', week: 1, year: 1, cash: 40_000_000, hub: 'JFK', airlineName: 'Test',
  routes: [], cargoRoutes: [], competitors: [FIXED_RIVAL], fleet: [], pendingOrders: [], objectives: [],
  objectivesEnabled: false, ...over,
});
function render(save, filters = null) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  store.set('market_layout', 'table');
  if (filters) store.set('market_filters', JSON.stringify(filters));
  return clean(renderToString(React.createElement(GameProvider, null, React.createElement(Marketplace))));
}
const listed = (html, t) => html.includes(`${t.name}<`);

const OWN = getAircraftType('a320neo');
assert.ok(OWN, 'fixture type a320neo missing');
const FAM = aircraftFamily(OWN.id);
const ac = (id, typeId, extra = {}) => ({ id, typeId, name: id, status: 'idle', ownershipType: 'owned', ageWeeks: 10, ...extra });

console.log('\nFleet → Market "Your families"\n');

const none = render(base());
test('a new airline gets no chip, and a remembered "on" changes nothing', () => {
  assert.doesNotMatch(none, /data-market-filter="yourFamilies"/);
  assert.equal(render(base(), { yourFamilies: true }), none);
});

const save = base({ fleet: [ac('a1', OWN.id)] });
const off = render(save);
const on  = render(save, { yourFamilies: true });
const siblings = AIRCRAFT_TYPES.filter(t => aircraftFamily(t.id) === FAM && t.id !== OWN.id && listed(off, t));
const others   = AIRCRAFT_TYPES.filter(t => aircraftFamily(t.id) !== FAM && listed(off, t));

test('the chip is offered once you own an aircraft', () => {
  assert.match(off, /data-market-filter="yourFamilies"/);
  assert.match(on, /aria-pressed="true"[^>]*data-market-filter="yourFamilies"/);
});
test('on: your type and the rest of its family stay', () => {
  assert.ok(siblings.length > 0, 'fixture: the A320neo family should list other members');
  assert.ok(listed(on, OWN), 'your own type was filtered out');
  for (const t of siblings) assert.ok(listed(on, t), `${t.name} (same family) was hidden`);
});
test('on: every other family goes', () => {
  assert.ok(others.length > 10, 'fixture: the unfiltered market should list other families');
  const left = others.filter(t => listed(on, t)).map(t => t.name);
  assert.deepEqual(left, [], `other families still listed: ${left.slice(0, 5).join(', ')}`);
});
test('a family you only have on order counts', () => {
  const B = AIRCRAFT_TYPES.find(t => aircraftFamily(t.id) && aircraftFamily(t.id) !== FAM && listed(off, t));
  const withOrder = render(base({ fleet: [ac('a1', OWN.id)], pendingOrders: [{ id: 'o1', typeId: B.id, deliverAbsWeek: 30, ownershipType: 'owned' }] }), { yourFamilies: true });
  assert.ok(listed(withOrder, B), `${B.name} is on order but its family was hidden`);
});
test('retired tails do not keep a family on the list', () => {
  // Read off the rule rather than the page: a retired tail can still appear by
  // name elsewhere on the Market screen.
  const B = others.find(t => aircraftFamily(t.id));
  const fams = ownedFamilyIds([ac('a1', OWN.id), ac('a2', B.id, { status: 'retired' })], []);
  assert.ok(fams.has(FAM));
  assert.ok(!fams.has(aircraftFamily(B.id)), `${B.name}'s family kept by a retired tail`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
