// Route Finder presets — a named search, saved in the browser, one click to bring back.
//
// Discord, 2026-11-05 (Barca): "It would be handy to be able to create presets
// in route finder. So like I could have a preset for Embraer-195 with range 0 to
// 1500 and sorting by largest market, and another with 350-1000 with range more
// than 13000 sorting by most profitable and no competitors etc"
//
//   1. the store (utils/finderPresets.js): what a preset holds, and what it doesn't
//   2. applying one in a world that can't fly its aircraft yet
//   3. the real finders, SSR-rendered: the preset row is there, lights up the
//      preset that matches the search, and a preset's search renders as that search
//
// Section 3 fails on HEAD: there is no preset row to render.
//
//   node --import ./tools/_register-loader.mjs tools/finder-presets-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.window.matchMedia = globalThis.window.matchMedia ?? ((q) => ({
  matches: false, media: q, onchange: null, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
}));
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { store.clear(); fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

const P = await import('../src/utils/finderPresets.js');
const KEY = 'finder_presets_v1';

const e195Search = {
  typeId: 'e195', minDist: '', maxDist: '1500', region: '', sortBy: 'demand',
  soloOnly: false, showUnflyable: false, showServed: false, splitMetros: false,
};
const longHaul = {
  typeId: 'a350-1000', minDist: '13000', maxDist: '', region: '', sortBy: 'profit',
  soloOnly: true, showUnflyable: false, showServed: false, splitMetros: false,
};

console.log('\nRoute Finder presets\n');
console.log('── 1. The store ─────────────────────────────────────────');

test('a saved preset comes back as saved, origin and paging left out', () => {
  P.savePreset('passenger', 'E195 short', { ...e195Search, origin: 'JFK', limit: 75, picks: ['x'] });
  const [p] = P.loadPresets('passenger');
  assert.equal(p.name, 'E195 short');
  assert.deepEqual(p.search, e195Search);
  assert.ok(!('origin' in p.search) && !('limit' in p.search) && !('picks' in p.search));
});

test('both of the examples in the ask save side by side, in order', () => {
  P.savePreset('passenger', 'E195 · 0–1,500 km', e195Search);
  P.savePreset('passenger', 'A350 long haul', longHaul);
  assert.deepEqual(P.loadPresets('passenger').map(p => p.name), ['E195 · 0–1,500 km', 'A350 long haul']);
});

test('the same name, any case, updates in place rather than adding a second', () => {
  P.savePreset('passenger', 'Short', e195Search);
  P.savePreset('passenger', 'Other', longHaul);
  P.savePreset('passenger', '  short ', { ...e195Search, sortBy: 'profit' });
  const list = P.loadPresets('passenger');
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'short');
  assert.equal(list[0].search.sortBy, 'profit');
});

test('distance boxes compare as the finder reads them', () => {
  assert.ok(P.sameSearch('passenger', e195Search, { ...e195Search, maxDist: 1500, minDist: '0' }));
  assert.ok(P.sameSearch('passenger', e195Search, { ...e195Search, maxDist: '01500', origin: 'LHR' }));
  assert.ok(!P.sameSearch('passenger', e195Search, { ...e195Search, maxDist: '1501' }));
  assert.ok(!P.sameSearch('passenger', e195Search, { ...e195Search, soloOnly: true }));
});

test('passenger and freight presets are kept apart', () => {
  P.savePreset('passenger', 'Pax', e195Search);
  P.savePreset('freight', 'Box', { rangeTypeId: '777f', minDist: '5000', maxDist: '', sortBy: 'revenue', showServed: true });
  assert.deepEqual(P.loadPresets('passenger').map(p => p.name), ['Pax']);
  const [f] = P.loadPresets('freight');
  assert.deepEqual(f.search, { rangeTypeId: '777f', minDist: '5000', maxDist: '', sortBy: 'revenue', showServed: true });
});

test('delete removes just that one', () => {
  P.savePreset('passenger', 'A', e195Search);
  P.savePreset('passenger', 'B', longHaul);
  P.deletePreset('passenger', 'a');
  assert.deepEqual(P.loadPresets('passenger').map(p => p.name), ['B']);
});

test(`at most ${P.MAX_PRESETS}, but a full list can still update one`, () => {
  for (let i = 0; i < P.MAX_PRESETS; i++) assert.ok(P.savePreset('passenger', `P${i}`, e195Search));
  assert.equal(P.savePreset('passenger', 'one too many', e195Search), null);
  assert.ok(P.savePreset('passenger', 'P3', longHaul));
  assert.equal(P.loadPresets('passenger').length, P.MAX_PRESETS);
});

test('no name, no preset', () => {
  assert.equal(P.savePreset('passenger', '   ', e195Search), null);
  assert.equal(P.loadPresets('passenger').length, 0);
});

test('junk in storage is ignored, not shown', () => {
  store.set(KEY, '{not json');
  assert.deepEqual(P.loadPresets('passenger'), []);
  store.set(KEY, JSON.stringify({ passenger: [null, { name: '' }, { name: 'ok', search: e195Search }, { name: 'OK', search: longHaul }, 7] }));
  const list = P.loadPresets('passenger');
  assert.deepEqual(list.map(p => p.name), ['ok']);
  store.set(KEY, JSON.stringify([1, 2]));
  assert.deepEqual(P.loadPresets('passenger'), []);
});

test('suggested names read like the ask and fit the box', () => {
  assert.equal(P.shortTypeName('Embraer E195'), 'E195');
  assert.equal(P.shortTypeName('Airbus A350-1000'), 'A350-1000');
  assert.equal(P.shortTypeName('ATR 72-600'), 'ATR 72-600');
  assert.equal(P.shortTypeName('Boeing 737-800'), 'Boeing 737-800');
  assert.equal(P.distPart('', '1500'), '0–1,500 km');
  assert.equal(P.distPart('13000', ''), '13,000+ km');
  assert.equal(P.distPart('', ''), null);
  assert.equal(P.presetName(['E195', '0–1,500 km', null, 'Biggest market']), 'E195 · 0–1,500 km · Biggest market');
  const long = P.presetName(['Boeing 747-400ER', '13,000–15,000 km', 'Central America & Caribbean', 'Best est. profit']);
  assert.ok(long.length <= P.MAX_NAME && long.startsWith('Boeing 747-400ER · 13,000–15,000 km'), long);
});

console.log('\n── 2. Applying a preset ─────────────────────────────────');

test('an aircraft this world lacks keeps the current one and says which', () => {
  const r = P.resolvePreset('passenger', { search: longHaul }, {
    current: { typeId: 'e195' }, typeOk: id => id === 'e195', sortOk: () => true });
  assert.equal(r.missingType, 'a350-1000');
  assert.equal(r.search.typeId, 'e195');
  assert.equal(r.search.minDist, '13000');
});

test('a forecast sort with no aircraft to forecast on falls back to the default', () => {
  const r = P.resolvePreset('passenger', { search: longHaul }, {
    current: { typeId: '' }, typeOk: () => false, sortOk: (s, t) => s !== 'profit' || !!t });
  assert.equal(r.search.typeId, '');
  assert.equal(r.search.sortBy, 'demand');
});

test('the freight panel resolves its own aircraft field', () => {
  const r = P.resolvePreset('freight', { search: { rangeTypeId: 'nope', sortBy: 'revenue' } }, {
    current: { rangeTypeId: '' }, typeOk: () => false });
  assert.equal(r.missingType, 'nope');
  assert.equal(r.search.rangeTypeId, '');
  assert.equal(r.search.sortBy, 'revenue');
});

console.log('\n── 3. The finders the player sees ───────────────────────');

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteFinderScreen = (await import('../src/components/RouteFinderScreen.jsx')).default;
const { rememberFinder, finderMemoryKey, clearFinderMemory } = await import('../src/utils/finderMemory.js');
const { getAircraftType } = await import('../src/data/aircraft.js');

const jet = getAircraftType('e195');
assert.ok(jet, 'fixture: no e195 in the catalogue');
const SAVE = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: 'JFK', cash: 500_000_000,
  hubs: { JFK: { tier: 2, tierSince: 1 } }, gates: { JFK: 10 },
  fleet: [{ id: 'ac1', tailNumber: 'N1E', name: 'Tail N1E', typeId: jet.id, status: 'idle',
            ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
  routes: [], cargoRoutes: [],
};

function renderFinder({ presets, passenger, freight, mode = 'passenger' } = {}) {
  store.clear();
  clearFinderMemory();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  if (presets) store.set(KEY, JSON.stringify(presets));
  if (passenger) rememberFinder(finderMemoryKey(SAVE, 'passenger'), passenger);
  if (freight) rememberFinder(finderMemoryKey(SAVE, 'freight'), freight);
  rememberFinder(finderMemoryKey(SAVE, 'screen'), { mode });
  return renderToString(React.createElement(GameProvider, null, React.createElement(RouteFinderScreen)))
    .replace(/<!-- -->/g, '');
}
const chips = (html) => [...html.matchAll(/data-finder-preset="([^"]+)"/g)].map(m => m[1]);
const activeChip = (html) => html.match(/data-finder-preset="([^"]+)" data-active=""/)?.[1] ?? null;
const selected = (html, value) => new RegExp(`<option value="${value}" selected=""`).test(html);

test('the passenger finder has a preset row with a save button, even before any exist', () => {
  const html = renderFinder();
  assert.ok(html.includes('data-finder-presets="passenger"'), 'no preset row on the passenger finder');
  assert.ok(html.includes('data-save-preset'), 'no way to save the search');
  assert.deepEqual(chips(html), []);
});

test('saved presets show as chips, and the one matching the search is lit', () => {
  const presets = { passenger: [{ name: 'E195 short', search: e195Search }, { name: 'A350 long', search: longHaul }] };
  let html = renderFinder({ presets, passenger: { ...e195Search, origin: 'JFK' } });
  assert.deepEqual(chips(html), ['E195 short', 'A350 long']);
  assert.equal(activeChip(html), 'E195 short');
  html = renderFinder({ presets, passenger: { ...e195Search, maxDist: '2000' } });
  assert.equal(activeChip(html), null, 'a preset stayed lit after the search moved off it');
});

test('a preset applied the way the finder applies it renders as that search', () => {
  const resolved = P.resolvePreset('passenger', { search: { ...e195Search, region: 'EUR', soloOnly: true } }, {
    current: { typeId: '' }, typeOk: id => !!getAircraftType(id) });
  const html = renderFinder({ passenger: resolved.search });
  assert.ok(selected(html, 'e195'), 'the preset aircraft is not selected');
  assert.ok(selected(html, 'EUR'), 'the preset region is not selected');
  assert.ok(selected(html, 'demand'), 'the preset sort is not selected');
  assert.ok(/placeholder="max"[^>]*value="1500"/.test(html), 'the preset distance band is not in the box');
});

test('the freight finder has its own preset row', () => {
  const presets = { freight: [{ name: 'Box haul', search: { rangeTypeId: '', minDist: '5000', maxDist: '', sortBy: 'revenue', showServed: false } }] };
  const html = renderFinder({ presets, mode: 'freight', freight: { minDist: '5000', sortBy: 'revenue' } });
  assert.ok(html.includes('data-finder-presets="freight"'), 'no preset row on the freight finder');
  assert.deepEqual(chips(html), ['Box haul']);
  assert.equal(activeChip(html), 'Box haul');
});

console.log('\n────────────────────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
