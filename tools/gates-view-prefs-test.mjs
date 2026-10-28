// Airports → Your Gates remembers its sort and its Table/Cards choice
// (Discord, VodkaOnFire 2026-10-23: "I'd like to have my airports/gates sorted
// by whatever I previously selected. Currently it seems to default to
// something based on region with NA first").
//
// Renders the REAL Airports screen twice — a fresh render is a fresh mount,
// which is exactly what leaving the tab and coming back looks like.
//
//   node --import ./tools/_register-loader.mjs tools/gates-view-prefs-test.mjs

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

console.log('\nAirports → Your Gates remembers its sort\n');

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AirportsMod = await import('../src/components/Airports.jsx');
const Airports = AirportsMod.default;
const { loadGatesViewPrefs, saveGatesViewPrefs } = AirportsMod;

// Gate counts deliberately out of region order: JFK (North America) leads the
// default order but holds the FEWEST gates.
const GATES = { JFK: 2, LHR: 9, NRT: 5, SYD: 7 };
const save = {
  ...freshState(), phase: 'playing', week: 10, year: 1, hub: 'JFK', cash: 500_000_000,
  gates: GATES,
};
const PREFS = 'gates_view_prefs_v1';
function reset(prefs) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  if (prefs !== undefined) store.set(PREFS, typeof prefs === 'string' ? prefs : JSON.stringify(prefs));
}
const render = () => renderToString(React.createElement(GameProvider, null, React.createElement(Airports))).replace(/<!--.*?-->/g, '');
// Codes in the gate table, top to bottom.
function tableOrder(html) {
  const i = html.indexOf('<table');
  assert.ok(i >= 0, 'the gate table rendered');
  const t = html.slice(i, html.indexOf('</table>', i));
  return [...t.matchAll(/font-family:monospace;font-weight:700;font-size:13px">([A-Z]{3})</g)].map(m => m[1])
    .filter(c => c in GATES);
}

test('no saved prefs: the default order is unchanged (region first, North America on top)', () => {
  reset();
  const order = tableOrder(render());
  assert.equal(order.length, 4);
  assert.equal(order[0], 'JFK');
});

test('a saved sort comes back on the next visit: Gates ▾ puts LHR (9) first, JFK (2) last', () => {
  reset({ sortCol: 'gates', sortDir: 'desc' });
  const html = render();
  assert.deepEqual(tableOrder(html), ['LHR', 'SYD', 'NRT', 'JFK']);
  assert.match(html, /Gates ▾/, 'and the header shows it');
  assert.deepEqual(tableOrder(render()), ['LHR', 'SYD', 'NRT', 'JFK'], 'still there after another remount');
});

test('direction is remembered too: Gates ▴', () => {
  reset({ sortCol: 'gates', sortDir: 'asc' });
  assert.deepEqual(tableOrder(render()), ['JFK', 'NRT', 'SYD', 'LHR']);
});

test('saveGatesViewPrefs merges, so saving the column keeps the direction and view', () => {
  reset({ sortCol: 'cost', sortDir: 'asc', view: 'table' });
  saveGatesViewPrefs({ sortCol: 'util' });
  assert.deepEqual(loadGatesViewPrefs(), { sortCol: 'util', sortDir: 'asc', view: 'table' });
});

test('a saved Cards choice comes back (no table rendered)', () => {
  reset({ view: 'cards' });
  const html = render();
  assert.ok(!html.includes('<table'), 'card view, not the table');
});

test('junk or stale prefs fall back to the defaults', () => {
  reset('{not json');
  assert.deepEqual(loadGatesViewPrefs(), { sortCol: null, sortDir: 'desc', view: null });
  reset({ sortCol: 'gone', sortDir: 'sideways', view: 'grid' });
  assert.deepEqual(loadGatesViewPrefs(), { sortCol: null, sortDir: 'desc', view: null });
  assert.equal(tableOrder(render())[0], 'JFK');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
