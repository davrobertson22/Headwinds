// era-lease-age-open-world-test.mjs — the 10-years-after-EIS lessor rule holds
// in EVERY era world, not only New World Restrictions ones.
//
// Discord (Dunno23, 2026-10-30): in Timely Takeoff (1950 era, NWR off) the
// brand-new 727-100 was leasable in 1965, "and it's the same with all other
// aircraft". The era lessor rule lived behind the NWR gate in both leaseDenial
// and the Marketplace, so an open era world leased every type from its first
// day in service. The rule is a property of the calendar (like the classic
// vintage rule, which already applies restrictions or not); the order-book cap
// and the double-deck exclusion stay NWR-only.
//
// HEAD failure proof: on HEAD leaseDenial returns null for the 727-100 in an
// open 1965 world and the Marketplace row shows a live Lease button.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { leaseDenial } from '../packages/engine/src/reducer.mjs';

const openEra = (calYear, extra = {}) => ({
  startYear: 1950, year: calYear - 1949, week: 1,
  fleet: [], pendingOrders: [], ...extra,
});

test('an open era world refuses a lease on a type in its first ten years', () => {
  const d = leaseDenial(openEra(1965), 'b727100');
  assert.equal(d?.code, 'not_stocked', `727-100 leasable in an open 1965 world: ${JSON.stringify(d)}`);
  assert.match(d.message, /1974/, `message should name 1974: ${d?.message}`);
  assert.equal(leaseDenial(openEra(1974), 'b727100'), null, '727-100 still refused at EIS+10');
  assert.equal(leaseDenial(openEra(1965), 'dc3'), null, 'old DC-3 refused in an open world');
  assert.equal(leaseDenial(openEra(1950), 'c47'), null, 'surplus C-47 refused in an open world');
});

test('NWR-only rules stay NWR-only in an open era world', () => {
  const big = { fleet: [], pendingOrders: Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, ownershipType: 'lease', quantity: 1 })) };
  assert.equal(leaseDenial(openEra(1965, big), 'dc3', 1), null, 'open world got an order-book cap');
  assert.equal(leaseDenial(openEra(1990), 'b747100'), null, 'open world got the double-deck exclusion');
});

test('classic open worlds are unchanged', () => {
  const classic = { week: 1, year: 1, fleet: [], pendingOrders: [] };
  assert.equal(leaseDenial(classic, 'a320neo'), null, 'classic open world lost the A320neo lease');
  assert.equal(leaseDenial(classic, 'b737800'), null);
});

test('the Marketplace blocks the 727-100 lease in an open 1965 world (SSR)', async () => {
  const store = new Map();
  globalThis.window = globalThis.window ?? {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), clear: () => store.clear(),
  };
  store.set('bbae_save_v2', JSON.stringify({
    phase: 'playing', week: 1, year: 16, startYear: 1950, cash: 4_000_000, hub: 'JFK', airlineName: 'Test',
    routes: [], cargoRoutes: [], competitors: [], fleet: [], pendingOrders: [],
  }));
  store.set('market_layout', 'table');
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(Marketplace)))
    .replace(/<!-- -->/g, '');
  const i = html.indexOf('Boeing 727-100');
  assert.notEqual(i, -1, '727-100 never rendered — this test proves nothing');
  const row = html.slice(i, html.indexOf('</tr>', i));
  assert.match(row, /Lessors take it from 1974/, 'open-world 727-100 row does not block the lease');
  const j = html.indexOf('Douglas DC-3');
  assert.notEqual(j, -1, 'DC-3 never rendered');
  assert.doesNotMatch(html.slice(j, html.indexOf('</tr>', j)), /Lessors take it from/, 'old DC-3 shows a lease block');
});
