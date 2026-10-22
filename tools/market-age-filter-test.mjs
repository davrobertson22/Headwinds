// Market: hide aircraft older than X years (Headwinds only).
//
// Discord, 2026-10-21 (VodkaOnFire): "Add slider/box/similar to filter out
// aircraft older than X years in market — Easy!"
//
// The age each list already shows:
//   * Fleet ▸ Market (new aircraft): an "Up to N yrs old" box next to the
//     Show-only chips, on the table's Age column — how old the frame is on
//     delivery. In-production types arrive new; out-of-production ones arrive
//     second-hand, and those older than N go. Blank = any age.
//   * Fleet ▸ Used Market: the same box on each AIRFRAME's own age, beside a
//     "Your families" chip (the same families as the Market's chip).
// Both are remembered per browser, and junk in either box means "no limit"
// rather than an empty market.
//
// Verified failing on HEAD: deliveredAgeYears / normalizeMaxAge /
// usedListingPasses do not exist in utils/marketFilters.js, no
// data-market-max-age box renders, and a remembered { maxAge: 10 } leaves the
// second-hand-only types on the page.
//
//   node --import ./tools/_register-loader.mjs tools/market-age-filter-test.mjs

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

const { GameProvider, RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
const UsedMarket  = (await import('../src/components/UsedMarket.jsx')).default;
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const { aircraftFamily } = await import('../src/data/families.js');
const F = await import('../src/utils/marketFilters.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const clean = (html) => html.replace(/<!-- -->/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const base = (over = {}) => ({
  ...freshState(), phase: 'playing', week: 1, year: 1, cash: 40_000_000, hub: 'JFK', airlineName: 'Test',
  routes: [], cargoRoutes: [], competitors: [], fleet: [], pendingOrders: [], objectives: [],
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

console.log('\nMarket — hide aircraft older than X years\n');
console.log('── 1. The rules ──');

test('age is the age on delivery: in production arrives new, out of production arrives used', () => {
  const inProd = AIRCRAFT_TYPES.find(t => t.oop == null);
  const closed = AIRCRAFT_TYPES.find(t => t.oop != null && t.oop < 2010 && (t.deliveredAgeWeeks ?? 0) > 52);
  assert.equal(F.deliveredAgeYears(inProd, null), 0);
  assert.ok(F.deliveredAgeYears(closed, null) > 0, `${closed.name} (line closed ${closed.oop}) arrives new`);
  assert.equal(F.deliveredAgeYears(closed, closed.oop - 1), 0, 'still in production in its own era, it arrives new');
});

test('junk in the box means no limit, never an empty market', () => {
  for (const junk of ['', null, undefined, 'abc', -3]) assert.equal(F.normalizeMaxAge(junk), null, `${junk}`);
  assert.equal(F.normalizeMaxAge('12'), 12);
  assert.equal(F.normalizeMaxAge(7.9), 7);
});

console.log('\n── 2. Fleet ▸ Market ──');

const off = render(base());
const on  = render(base(), { maxAge: 10 });
test('the box is offered, and remembers its value', () => {
  assert.match(off, /data-market-max-age=""/);
  assert.match(on, /data-market-max-age=""[^>]*value="10"|value="10"[^>]*data-market-max-age=""/);
});
test('on: aircraft that would arrive older than 10 years go, the rest stay', () => {
  const old = AIRCRAFT_TYPES.filter(t => listed(off, t) && F.deliveredAgeYears(t, null) > 10);
  const young = AIRCRAFT_TYPES.filter(t => listed(off, t) && F.deliveredAgeYears(t, null) <= 10);
  assert.ok(old.length > 3 && young.length > 10, `fixture: ${old.length} old, ${young.length} young`);
  const stayed = old.filter(t => listed(on, t)).map(t => t.name);
  assert.deepEqual(stayed, [], `older aircraft still listed: ${stayed.slice(0, 4).join(', ')}`);
  for (const t of young) assert.ok(listed(on, t), `${t.name} (${F.deliveredAgeYears(t, null)} yrs) was hidden`);
});
test('an era world measures age in its own calendar', () => {
  const plain = render(base({ startYear: 1990 }));
  const era = render(base({ startYear: 1990 }), { maxAge: 0 });
  const t = AIRCRAFT_TYPES.find(x => x.oop != null && x.oop > 1995 && x.oop < 2026 && listed(plain, x));
  assert.ok(t, 'fixture: a type in production in 1990 that has closed by 2026');
  assert.ok(listed(era, t), `${t.name} is factory-new in 1990 but "0 yrs" hid it`);
});

console.log('\n── 3. Fleet ▸ Used Market ──');

const L = (id, typeId, years) => ({ id, typeId, ageWeeks: Math.round(years * 52) });
test('airframe age: older than the box goes', () => {
  assert.equal(F.usedListingPasses(L('a', 'a320neo', 12), { maxAge: 10 }), false);
  assert.equal(F.usedListingPasses(L('b', 'a320neo', 9.5), { maxAge: 10 }), true);
  assert.equal(F.usedListingPasses(L('c', 'a320neo', 40), { maxAge: '' }), true);
});
test('"Your families" keeps your families, and does nothing for an airline with none', () => {
  const owned = F.ownedFamilyIds([{ typeId: 'a320neo', status: 'idle' }], []);
  const other = AIRCRAFT_TYPES.find(t => aircraftFamily(t.id) && aircraftFamily(t.id) !== aircraftFamily('a320neo'));
  assert.equal(F.usedListingPasses(L('a', 'a321neo', 3), { yourFamilies: true }, owned), aircraftFamily('a321neo') === aircraftFamily('a320neo'));
  assert.equal(F.usedListingPasses(L('b', other.id, 3), { yourFamilies: true }, owned), false);
  assert.equal(F.usedListingPasses(L('c', other.id, 3), { yourFamilies: true }, new Set()), true);
});
test('the Used Market shows both controls', () => {
  store.clear();
  const state = base({ fleet: [{ id: 'x', typeId: 'a320neo', status: 'idle', ownershipType: 'owned', ageWeeks: 5 }] });
  const html = clean(renderToString(React.createElement(RemoteGameProvider, {
    state, dispatch() {}, remoteApi: { fetchUsedAircraft: async () => ({ listings: [] }) },
  }, React.createElement(UsedMarket))));
  assert.match(html, /data-used-max-age=""/);
  assert.match(html, /data-used-filter="yourFamilies"/);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
