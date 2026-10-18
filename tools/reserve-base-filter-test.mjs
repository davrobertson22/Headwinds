// Fleet → Reserve filter: the "Reserves by base" breakdown (how many of each
// type stand by at each airport) and the base filter it drives. The helper is
// checked directly and the breakdown + the real Fleet screen are SSR-rendered.
//
//   node --import ./tools/_register-loader.mjs tools/reserve-base-filter-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

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
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const F = await import('../src/components/Fleet.jsx');
const { getAircraftType } = await import('../src/data/aircraft.js');
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const tail = (id, typeId, extra = {}) => ({
  id, typeId, name: id, tailNumber: id.toUpperCase(), status: 'idle', ageWeeks: 100,
  ownershipType: 'owned', config: { economy: 150 }, ...extra,
});
const FLEET = [
  tail('a', 'a320ceo', { reserveBase: 'JFK' }),
  tail('b', 'a320ceo', { reserveBase: 'JFK' }),
  tail('c', 'a321neo', { reserveBase: 'JFK' }),
  tail('d', 'a320ceo', { reserveBase: 'LAX' }),
  tail('e', 'a321neo', { reserveBase: 'BOS' }),
  tail('f', 'a321neo', { reserveBase: 'BOS' }),
  tail('g', 'a320ceo'),                                         // idle, not a reserve
  tail('h', 'a320ceo', { status: 'assigned' }),                 // flying
  tail('i', 'a320ceo', { reserveBase: 'LAX', status: 'retired' }), // retired: not counted
];
const n320 = getAircraftType('a320ceo').name;
const n321 = getAircraftType('a321neo').name;

console.log('\n── Reserves by base ─────────────────────────────────');

test('reserveBaseSummary groups stationed reserves by base, then by type', () => {
  assert.equal(typeof F.reserveBaseSummary, 'function', 'Fleet.jsx does not export reserveBaseSummary');
  const s = F.reserveBaseSummary(FLEET);
  assert.deepEqual(s.map(b => [b.base, b.total]), [['JFK', 3], ['BOS', 2], ['LAX', 1]]);
  assert.deepEqual(s[0].types.map(t => [t.typeId, t.count]), [['a320ceo', 2], ['a321neo', 1]]);
  assert.equal(s[0].types[0].name, n320);
  assert.deepEqual(s[1].types.map(t => [t.typeId, t.count]), [['a321neo', 2]]);
});

test('non-reserves and retired tails are left out; an empty fleet gives an empty list', () => {
  const s = F.reserveBaseSummary(FLEET);
  assert.equal(s.reduce((n, b) => n + b.total, 0), 6);
  assert.deepEqual(F.reserveBaseSummary([]), []);
  assert.deepEqual(F.reserveBaseSummary(undefined), []);
});

test('the breakdown lists every base with its city, total and per-type counts', () => {
  assert.equal(typeof F.ReserveBaseBreakdown, 'function', 'Fleet.jsx does not export ReserveBaseBreakdown');
  const t = text(render(React.createElement(F.ReserveBaseBreakdown, { summary: F.reserveBaseSummary(FLEET) })));
  assert.match(t, /Reserves by base/);
  assert.match(t, /All bases 6/);
  assert.match(t, /JFK New York 3/);
  assert.ok(t.includes(`2× ${n320}`) && t.includes(`1× ${n321}`), t);
  assert.ok(t.indexOf('JFK') < t.indexOf('BOS') && t.indexOf('BOS') < t.indexOf('LAX'), 'busiest base first');
});

test('the picked base (and type) is highlighted', () => {
  const summary = F.reserveBaseSummary(FLEET);
  const html = render(React.createElement(F.ReserveBaseBreakdown, { summary, base: 'BOS' }));
  assert.match(html, /data-reserve-base="BOS"[^]*?class="btn btn-primary"/);
  assert.doesNotMatch(html, /class="btn btn-primary"[^>]*>All bases/);
  const typed = render(React.createElement(F.ReserveBaseBreakdown, { summary, base: 'JFK', typeId: 'a321neo' }));
  assert.ok(new RegExp(`btn-primary"[^>]*>1× ${n321.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(typed), 'type chip active');
});

test('no reserves → no breakdown', () => {
  assert.equal(render(React.createElement(F.ReserveBaseBreakdown, { summary: [] })), '');
});

test('the Fleet screen still renders with reserves at several bases', () => {
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 1e8,
    hubs: { JFK: { type: 'hub' }, LAX: { type: 'focus' }, BOS: { type: 'focus' } },
    gates: { JFK: 20, BOS: 10, LAX: 10 }, fleet: FLEET.filter(a => a.status !== 'retired'), routes: [],
  }));
  const t = text(render(React.createElement(F.default)));
  assert.match(t, /Reserve @ JFK/);
  assert.match(t, /Reserve @ BOS/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
