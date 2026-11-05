// Freight connections on the player's screens: a freighter route that carries
// freight connecting through your network says so, and the freight table's
// summary splits out the connecting revenue. SSR-renders the real components.
// (Headwinds' freight table shows one row per LANE, so chips are lane totals.)
//
//   node --import ./tools/_register-loader.mjs tools/cargo-connections-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { cargoReferenceYield as cy } from '../src/utils/market.js';
import { simulateCargoNetwork, currentGameDate } from '../src/utils/simulation.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
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
const { default: CargoRoutesList } = await import('../src/components/CargoRoutesList.jsx');

const tail = (id, name) => ({ id, typeId: 'b777f', name, tailNumber: id.toUpperCase(), status: 'assigned', ageWeeks: 60, ownershipType: 'owned', config: {} });
const cRoute = (id, o, d, ac, freq) => ({ id, origin: o, destination: d, aircraftId: ac, weeklyFrequency: freq,
  yieldPrice: cy(o, d), weeksOpen: 60, hub: 'ANC', cargo: true });

const hubSave = {
  ...freshState(),
  phase: 'playing', week: 30, year: 3, hub: 'ANC', cash: 300_000_000,
  gates: { ANC: 20, HKG: 10, ORD: 10 }, hubs: { ANC: { tier: 1 } },
  // Frequencies each 777F can actually fly (the save loader clamps to block
  // hours): three tails on HKG–ANC, two on ANC–ORD — payload to spare once the
  // lanes' own freight is loaded.
  fleet: ['f1', 'f2', 'f3', 'f4', 'f5'].map(id => tail(id, `Freighter ${id}`)),
  routes: [],
  cargoRoutes: [
    cRoute('c1', 'HKG', 'ANC', 'f1', 6), cRoute('c2', 'HKG', 'ANC', 'f2', 6), cRoute('c3', 'HKG', 'ANC', 'f3', 6),
    cRoute('c4', 'ANC', 'ORD', 'f4', 10), cRoute('c5', 'ANC', 'ORD', 'f5', 10),
  ],
  competitors: [],
};
const render = (save, el) => {
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
};

console.log('\nFreight connections on your screens\n');

const html = render(hubSave, React.createElement(CargoRoutesList));
const net  = simulateCargoNetwork(hubSave.cargoRoutes, hubSave.fleet,
  { gameDate: currentGameDate(hubSave), competitors: [] });

test('each lane through Anchorage shows its connecting freight (summed over its freighters)', () => {
  for (const ids of [['c1', 'c2', 'c3'], ['c4', 'c5']]) {
    const t = ids.reduce((s, id) => s + (net.results.get(id).connectingTonnes ?? 0), 0);
    assert.ok(t > 0, `${ids} carry connecting freight in the engine`);
    assert.ok(html.includes(`+${t.toLocaleString()} t connecting`), `lane chip missing (+${t} t connecting)`);
  }
});

test('the chip names the market and where it connects', () => {
  assert.match(html, /HKG–ORD via ANC/);
});

test('the summary splits out the connecting revenue', () => {
  assert.match(html, /of which connecting/i);
});

test('the table’s tonnes are the engine’s, connecting freight included', () => {
  const total = [...net.results.values()].reduce((s, r) => s + r.tonnes, 0);
  assert.ok(html.includes(total.toLocaleString()), `summary tonnes ${total} not on the page`);
});

test('a lone freighter route shows no connecting chip', () => {
  const lone = { ...hubSave, fleet: [tail('f1', 'Freighter One')], cargoRoutes: [cRoute('c1', 'HKG', 'ANC', 'f1', 6)] };
  const h = render(lone, React.createElement(CargoRoutesList));
  assert.doesNotMatch(h, /t connecting/);
  assert.doesNotMatch(h, /of which connecting/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
