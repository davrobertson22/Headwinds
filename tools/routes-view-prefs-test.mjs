// Routes ▸ the player's sort and view choice must survive the page being rebuilt.
//
// Discord, 2026-10-13: "In the routes section, when you filter by distance,
// profit, or load… if you advance to the next week, it reverts to profit instead
// of sticking to your preferred setting, so you have to change it every week."
//
// Advancing the week sends the player to the Dashboard (App.jsx advanceWeek →
// setActiveTab('dashboard')), which unmounts Routes; coming back mounted a fresh
// one with useState('profit'). A phone that discards a backgrounded tab loses it
// the same way. The fix stores the choice (localStorage, like the profit basis).
//
// A fresh renderToString is a fresh mount — exactly what the player gets when
// they come back to the tab — so each render below is "next week".
//
//   node --import ./tools/_register-loader.mjs tools/routes-view-prefs-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
let phone = false;
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = (q) => ({
  matches: phone && /max-width/.test(q),
  media: q, onchange: null,
  addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? {
  addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { store.clear(); fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

const { RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RoutesMod = await import('../src/components/Routes.jsx');
const Routes = RoutesMod.default;
const { loadRoutesViewPrefs, saveRoutesViewPrefs } = RoutesMod;
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { defaultConfig, defaultClassPrices, referencePrice } =
  await import('../packages/engine/src/utils/simulation.js');

function buildState() {
  const t = getAircraftType('a320neo');
  const pairs = [['JFK', 'BOS'], ['JFK', 'MIA'], ['JFK', 'LAX']];
  const fleet = [], routes = [], routePricing = {}, gates = {};
  pairs.forEach(([h, s], i) => {
    fleet.push({ id: `p${i}`, typeId: t.id, status: 'assigned', ageWeeks: 52,
      config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `N${i}HW`, name: t.name });
    routes.push({ id: `r${i}`, origin: h, destination: s, stops: [h, s], aircraftId: `p${i}`,
      weeklyFrequency: 7, weeksOpen: 30, hub: h,
      ticketPrice: Math.round(referencePrice(h, s)), cateringLevel: 'full' });
    routePricing[[h, s].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(h, s)));
    gates[h] = (gates[h] ?? 0) + 1; gates[s] = (gates[s] ?? 0) + 1;
  });
  return { ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'JFK', cash: 5e9,
    fleet, routes, routePricing, gates, hubs: { JFK: { tier: 2, tierSince: 0 } }, multiplayer: true };
}
const state = buildState();
const render = () => renderToString(
  React.createElement(RemoteGameProvider, { state, dispatch: () => {} },
    React.createElement(Routes))).replaceAll('<!-- -->', '');

const selectedSort = (html) => html.match(/<option value="(\w+)" selected="">Sort:/)?.[1] ?? null;
// The table marks its sort column with ▾/▴ right after the header label.
const tableSort = (html) => {
  const m = html.match(/title="Click to sort">([^<]+)<span[^>]*>([▾▴])<\/span>/);
  return m ? { label: m[1], dir: m[2] === '▾' ? 'desc' : 'asc' } : null;
};

console.log('\n── Routes view settings survive a remount ─────────────');

test('defaults are unchanged for a player who never picked', () => {
  phone = true;
  assert.equal(selectedSort(render()), 'profit');
  phone = false;
  assert.equal(tableSort(render())?.dir, 'desc');
});

test('card sort sticks across a remount (the reported bug)', () => {
  phone = true;
  saveRoutesViewPrefs({ sortBy: 'distance' });
  assert.equal(selectedSort(render()), 'distance', 'next week came back on Profit');
  saveRoutesViewPrefs({ sortBy: 'load' });
  assert.equal(selectedSort(render()), 'load');
});

test('table sort column and direction stick across a remount', () => {
  phone = false;
  saveRoutesViewPrefs({ tableCol: 'dist', tableDir: 'asc' });
  assert.deepEqual(tableSort(render()), { label: 'Dist', dir: 'asc' });
});

test('an explicit Table/Cards choice beats the screen-size default', () => {
  phone = true;
  saveRoutesViewPrefs({ viewMode: 'table' });
  const html = render();
  assert.ok(tableSort(html), 'phone with a saved Table choice should get the table');
  phone = false;
  saveRoutesViewPrefs({ viewMode: 'cards' });
  assert.ok(selectedSort(render()), 'desktop with a saved Cards choice should get cards');
});

test('saving one setting keeps the others', () => {
  saveRoutesViewPrefs({ sortBy: 'revenue' });
  saveRoutesViewPrefs({ tableCol: 'load', tableDir: 'asc' });
  assert.deepEqual(loadRoutesViewPrefs(),
    { sortBy: 'revenue', tableCol: 'load', tableDir: 'asc', viewMode: null });
});

test('junk or stale stored values fall back to defaults instead of breaking the page', () => {
  store.set('routes_view_prefs_v1', '{not json');
  assert.deepEqual(loadRoutesViewPrefs(),
    { sortBy: 'profit', tableCol: 'profit', tableDir: 'desc', viewMode: null });
  store.set('routes_view_prefs_v1', JSON.stringify({ sortBy: 'vibes', tableCol: 'x', tableDir: 'sideways', viewMode: 'grid' }));
  assert.deepEqual(loadRoutesViewPrefs(),
    { sortBy: 'profit', tableCol: 'profit', tableDir: 'desc', viewMode: null });
  phone = true;
  assert.equal(selectedSort(render()), 'profit');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} routes-view-prefs: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
