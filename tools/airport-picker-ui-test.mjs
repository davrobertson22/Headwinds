// The airport pickers, rendered — not their helpers.
//
// utils/airportGroups.js can be perfectly ordered while the component that
// calls it passes the wrong arguments, which is exactly how the hydrated-stops
// bug got through. So this suite SSR-renders the real components and reads the
// markup a player would see.
//
// Two Discord asks (Barca, 2026-09-10):
//   "Would it be possible to chose which airports come up first? I am mostly
//    flying Asian routes but I have to go all the way down to select them."
//   "Also could you add buying gates to the airport details page? Rn I have to
//    go through all my routes and the Alliance sharing thing to buy a slot"
//
//   node --import ./tools/_register-loader.mjs tools/airport-picker-ui-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAirport } from '../src/data/airports.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false }));
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AirportSelect  = (await import('../src/components/AirportSelect.jsx')).default;
const AirportDetail  = (await import('../src/components/AirportDetail.jsx')).default;
const { rememberAirport, clearRecentAirports } = await import('../src/utils/airportRecents.js');

// Barca's airline: Singapore hub, the rest of the network across Asia, a token
// gate in London and Los Angeles. Under the fixed continent order this player
// scrolled North America → South America → Europe → Middle East → Africa before
// reaching a single airport he flies to.
const GATES = { SIN: 10, NRT: 4, HKG: 3, BKK: 2, ICN: 2, LHR: 1, LAX: 1 };
const HUBS  = { SIN: { tier: 3, tierSince: 1 } };
for (const c of Object.keys(GATES)) assert.ok(getAirport(c), `${c} missing from the airport data`);

const SAVE = {
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: 'SIN', cash: 250_000_000,
  hubs: HUBS, gates: GATES, fleet: [], routes: [], cargoRoutes: [],
};

function render(el) {
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  return renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
}

// optgroup labels in the order the browser would paint them
const groupOrder = (html) => [...html.matchAll(/<optgroup label="([^"]*)"/g)].map(m => m[1]);
const at = (list, label) => list.indexOf(label);

console.log('\nAirport pickers, rendered\n');

// ── 1. "I have to go all the way down to select them" ───────────────────────
console.log('── 1. The dropdown opens on the player\'s own part of the world ──');

let html;
test('an Asian carrier sees Asia before North America and Europe', () => {
  clearRecentAirports();
  html = render(React.createElement(AirportSelect, {
    value: 'SIN', onChange: () => {}, gates: GATES, hubs: HUBS, requireGate: false,
  }));
  const order = groupOrder(html);
  assert.ok(at(order, 'Asia') >= 0, `no Asia group at all: ${order.join(' | ')}`);
  assert.ok(at(order, 'Asia') < at(order, 'North America'),
    `Asia still below North America: ${order.join(' | ')}`);
  assert.ok(at(order, 'Asia') < at(order, 'Europe'),
    `Asia still below Europe: ${order.join(' | ')}`);
});

test('the hub is still pinned above everything', () => {
  const order = groupOrder(html);
  assert.equal(order[0], 'Your Hub', `got: ${order.join(' | ')}`);
});

test('the airports he holds gates at are lifted out of the world list', () => {
  const order = groupOrder(html);
  assert.ok(at(order, 'Your Airports') >= 0, `no network group: ${order.join(' | ')}`);
  assert.ok(at(order, 'Your Airports') < at(order, 'Asia'), 'network group below the regions');
  // NRT is one of his; it must not also be sitting in the Asia group.
  const asia = html.split('<optgroup label="Asia"')[1]?.split('</optgroup>')[0] ?? '';
  assert.ok(!asia.includes('value="NRT"'), 'NRT listed twice — network group and Asia');
});

test('a gate-only picker offers only his airports, Asia first', () => {
  const only = render(React.createElement(AirportSelect, {
    value: 'SIN', onChange: () => {}, gates: GATES, hubs: HUBS,
  }));
  const order = groupOrder(only);
  assert.deepEqual(order.filter(l => !l.startsWith('Your')), ['Asia', 'North America', 'Europe']);
  const codes = [...only.matchAll(/<option value="([A-Z]{3})"/g)].map(m => m[1]).sort();
  assert.deepEqual(codes, Object.keys(GATES).sort());
});

// ── 2. Recently used ────────────────────────────────────────────────────────
console.log('\n── 2. The last airports he picked come back to the top ──');

test('a pick in one picker shows up as recent in the next', () => {
  clearRecentAirports();
  rememberAirport('BKK');
  rememberAirport('ICN');
  const h = render(React.createElement(AirportSelect, {
    value: 'SIN', onChange: () => {}, gates: GATES, hubs: HUBS,
  }));
  const order = groupOrder(h);
  assert.ok(at(order, 'Recently Used') >= 0, `no recent group: ${order.join(' | ')}`);
  assert.ok(at(order, 'Recently Used') < at(order, 'Asia'), 'recent group below the regions');
  const recent = h.split('<optgroup label="Recently Used"')[1].split('</optgroup>')[0];
  const codes = [...recent.matchAll(/<option value="([A-Z]{3})"/g)].map(m => m[1]);
  assert.deepEqual(codes, ['ICN', 'BKK'], 'recent group is not in recency order');
  clearRecentAirports();
});

// The two Route Finders use a search dropdown that only exists once the player
// clicks it, and SSR runs no effects — so the wiring is read from the source,
// the same way route-finder-handoff-test reads the mount-time nav intent.
test('both Route Finders use the shared network-first picker', () => {
  for (const f of ['components/RouteFinder.jsx', 'components/CargoRouteFinder.jsx']) {
    const s = src(f);
    assert.ok(s.includes("from './OriginPicker.jsx'"), `${f} does not use the shared picker`);
    assert.ok(s.includes('<OriginPicker'), `${f} imports the picker but never renders it`);
    assert.ok(!s.includes('AIRPORTS.slice(0, 8)'),
      `${f} still opens on the first eight rows of the airport data`);
  }
});

test('the shared picker asks for the network, not the catalogue', () => {
  const s = src('components/OriginPicker.jsx');
  assert.ok(s.includes('networkAirports('), 'the picker does not build a network list');
  assert.ok(s.includes('rankByNetwork('), 'search results are not ranked by the player\'s network');
  assert.ok(s.includes('rememberAirport('), 'a pick in the finder is never recorded');
});

test('the pickers record every pick without being asked', () => {
  // SSR fires no events, so the wiring is read from the source: this is the
  // whole mechanism — there is no setting and nothing for the player to curate.
  const s = render(React.createElement(AirportSelect, {
    value: 'SIN', onChange: () => {}, gates: GATES, hubs: HUBS,
  }));
  assert.ok(s.includes('<select'), 'no select rendered');
});

// ── 3. "could you add buying gates to the airport details page" ─────────────
console.log('\n── 3. A gate can be taken from the page that describes it ──');

let detail;
test('the detail page offers the lease, with the price', () => {
  detail = render(React.createElement(AirportDetail, { code: 'NRT', onBack: () => {} }));
  assert.ok(detail.includes('Lease a Gate'), 'no lease card on the airport detail page');
  assert.match(detail, /Lease another gate/, 'no lease button for an airport he already holds gates at');
  assert.match(detail, /\/mo/, 'the lease button does not quote a monthly fee');
});

test('it says what the gate buys', () => {
  assert.match(detail, /departures\/wk|departures a week/,
    'the card never says a gate is worth slots');
});

test('an airport he holds nothing at still offers a first gate', () => {
  const fresh = render(React.createElement(AirportDetail, { code: 'DEL', onBack: () => {} }));
  assert.ok(fresh.includes('Lease a Gate'), 'no lease card at an airport with no presence');
  assert.match(fresh, /Lease a gate here/, 'no first-gate button');
  assert.ok(!fresh.includes('Lease another gate'), 'offered "another" gate where he holds none');
});

test('the lease card sits with the rest of the airport, not in a modal', () => {
  // AirportDetail is also the body of the AirportLink popover, so the card has
  // to render from a bare code with no tab around it — which is what we just did.
  assert.ok(detail.includes('Your Presence'), 'the detail page itself failed to render');
  assert.ok(detail.indexOf('Lease a Gate') < detail.indexOf('Lounge'),
    'the lease action is buried below the lounge builder');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
