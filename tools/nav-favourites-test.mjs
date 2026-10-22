// The shortcuts bar under the nav menus.
//
// "Requesting we have a configurable favourites-menu under the current
//  drop-down menus, where we can add a handful of buttons to get to certain
//  areas quicker. Just to save some clicks" (VodkaOnFire, Discord 2026-10-21)
//
// Pins:
//   1. the store — pin order kept, a second click unpins, a full bar refuses
//      rather than silently dropping the oldest, a corrupt or throwing storage
//      costs nothing, and the list lives under its own per-browser key (not
//      in the save);
//   2. rendered — no bar until something is pinned; pinned pages appear as
//      buttons in pin order; a pin for a page that no longer exists (or one
//      that is already one click away) is not drawn;
//   3. every page inside a dropdown carries a pin star, and the four one-click
//      pages do not.
//
// Ported from Tailwinds (per-browser key hw_nav_favourites_v1).
//
// Verified failing on HEAD: utils/navFavourites.js does not exist, and App.jsx
// renders no shortcuts bar and no star in its menus.
//
//   node --import ./tools/_register-loader.mjs tools/nav-favourites-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, body: {} };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const F = await import('../src/utils/navFavourites.js');
const { GameProvider, GameContext, freshState } = await import('../src/store/GameContext.jsx');
// Headwinds' App paints straight from the provider (Tailwinds' holds its first
// paint for a hydration flag), so there is nothing to lift here.
function Hydrated({ children }) { return children; }
void GameContext;
const App = (await import('../src/App.jsx')).default;

console.log('\nShortcuts bar\n');
console.log('── 1. The store ──');

const mem = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('pins keep their order; a second click unpins', () => {
  const s = mem(); F.clearNavFavourites(s);
  assert.equal(F.toggleNavFavourite('fleet', s), true);
  assert.equal(F.toggleNavFavourite('finder', s), true);
  assert.equal(F.toggleNavFavourite('market', s), true);
  assert.deepEqual([...F.navFavourites(s)], ['fleet', 'finder', 'market']);
  assert.equal(F.toggleNavFavourite('finder', s), false);
  assert.deepEqual([...F.navFavourites(s)], ['fleet', 'market']);
  F.clearNavFavourites(s);
});

test('a full bar refuses a new pin instead of dropping the oldest', () => {
  const s = mem(); F.clearNavFavourites(s);
  for (let i = 0; i < F.NAV_FAVOURITES_LIMIT; i++) F.toggleNavFavourite(`p${i}`, s);
  assert.equal(F.toggleNavFavourite('one-too-many', s), null);
  assert.equal(F.navFavourites(s).length, F.NAV_FAVOURITES_LIMIT);
  assert.equal(F.navFavourites(s)[0], 'p0');
  F.clearNavFavourites(s);
});

test('it lives under its own per-browser key, not in the save', () => {
  const s = mem(); F.clearNavFavourites(s);
  F.toggleNavFavourite('routes', s);
  assert.deepEqual(JSON.parse(s.m.get('hw_nav_favourites_v1')), ['routes']);
  F.clearNavFavourites(s);
});

test('corrupt or throwing storage costs nothing', () => {
  const bad = mem(); bad.m.set('hw_nav_favourites_v1', '{nope'); F.clearNavFavourites(mem());
  assert.deepEqual([...F.navFavourites(bad)], []);
  const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  F.clearNavFavourites(throwing);
  assert.doesNotThrow(() => F.toggleNavFavourite('fleet', throwing));
  F.clearNavFavourites(mem());
});

console.log('\n── 2. Rendered ──');

const SAVE = { ...freshState(), phase: 'playing', week: 5, year: 1, hub: 'JFK', airlineName: 'Pin Air', cash: 5e7 };
function render(pins) {
  store.clear();
  F.clearNavFavourites();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  for (const p of pins) F.toggleNavFavourite(p);
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(Hydrated, null, React.createElement(App)))).replace(/<!-- -->/g, '');
}

test('no bar until something is pinned', () => {
  const html = render([]);
  assert.ok(html.includes('nav-tabs'), 'the app did not render its nav at all');
  assert.ok(!html.includes('class="nav-favs"'), 'an empty shortcuts bar was drawn');
});

test('pinned pages appear as buttons, in pin order', () => {
  const html = render(['market', 'finder', 'operations']);
  assert.ok(html.includes('class="nav-favs"'), 'no shortcuts bar');
  const order = [...html.matchAll(/data-nav-fav="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['market', 'finder', 'operations']);
  assert.ok(html.indexOf('class="nav-favs"') > html.indexOf('nav-tabs'), 'the bar is not under the menus');
});

test('a stale or one-click pin is not drawn', () => {
  const html = render(['dashboard', 'no-such-page', 'fleet']);
  const order = [...html.matchAll(/data-nav-fav="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['fleet']);
});

console.log('\n── 3. The stars ──');

test('every page inside a dropdown carries a pin star', () => {
  const s = readFileSync(join(ROOT, 'src', 'App.jsx'), 'utf8');
  assert.ok(s.includes('data-nav-pin={cid}'), 'menu items have no pin control');
  assert.ok(s.includes('toggleNavFavourite(cid)'), 'the star does not toggle the pin');
  assert.ok(/const PINNABLE = new Set\(NAV_GROUPS\.flatMap\(g => g\.children \?\? \[\]\)\)/.test(s),
    'pinnable pages are not exactly the dropdown pages');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
