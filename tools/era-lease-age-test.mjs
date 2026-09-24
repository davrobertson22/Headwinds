// era-lease-age-test.mjs — era lessors only carry a type 10+ years after EIS.
//
// Dave, 2026-09-24: "make the leasing restrictions make it so a plane has to be
// 10+ years after EIS to be leased". Era worlds only — classic keeps its fixed
// 2000 cutoff, which is already stricter. War-surplus types (`surplus: true` —
// C-46, C-47, DC-4) are exempt: the postwar lease market WAS surplus metal.
//
// HEAD failure proof: on HEAD a 1950 lessor carries the brand-new CV-240
// (eis 1948), and a 1960 lessor carries the CV-580 in its first year.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType, lessorSupplies } from '../packages/engine/src/data/aircraft.js';
import { leaseDenial } from '../packages/engine/src/reducer.mjs';

const t = (id) => getAircraftType(id);
const eraState = (calYear, extra = {}) => ({
  newWorldRestrictions: true, startYear: 1950, year: calYear - 1949, week: 1,
  fleet: [], pendingOrders: [], ...extra,
});

test('a type is off era lessor books until 10 years after entry into service', () => {
  assert.equal(lessorSupplies(t('cv240'), 1950), false, 'CV-240 (1948) leasable in 1950');
  assert.equal(lessorSupplies(t('cv240'), 1957), false, 'CV-240 leasable a year early');
  assert.equal(lessorSupplies(t('cv240'), 1958), true, 'CV-240 not leasable at EIS+10');
  assert.equal(lessorSupplies(t('b707120'), 1967), false, '707 leasable in 1967');
  assert.equal(lessorSupplies(t('b707120'), 1968), true, '707 not leasable in 1968');
  assert.equal(lessorSupplies(t('dc3'), 1950), true, 'DC-3 (1936) should be on the 1950 books');
});

test('war-surplus types are leasable from the day they are available', () => {
  for (const id of ['c47', 'dc4', 'c46']) {
    assert.ok(t(id).surplus, `${id} lost its surplus flag`);
    assert.equal(lessorSupplies(t(id), 1950), true, `${id} should be leasable in 1950`);
  }
});

test('the 1950 lease market is exactly the old and the surplus', () => {
  const { AIRCRAFT_TYPES } = { AIRCRAFT_TYPES: [
    'c46', 'dc3', 'c47', 'dc4', 'northstar', 'l749', 'cv240'].map(t) };
  const leasable = AIRCRAFT_TYPES.filter(x => lessorSupplies(x, 1950)).map(x => x.id).sort();
  assert.deepEqual(leasable, ['c46', 'c47', 'dc3', 'dc4']);
});

test('classic worlds are unchanged', () => {
  assert.equal(lessorSupplies(t('a320ceo')), true, 'classic A320 lease vanished');
  assert.equal(lessorSupplies(t('b737800')), true, 'classic 737-800 lease vanished');
  assert.equal(lessorSupplies(t('a320neo')), false, 'classic cutoff moved');
});

test('leaseDenial names the year lessors take the type', () => {
  const d = leaseDenial(eraState(1950), 'cv240');
  assert.equal(d?.code, 'not_stocked');
  assert.match(d.message, /1958/, `message should give the first lease year: ${d?.message}`);
  assert.equal(leaseDenial(eraState(1958), 'cv240'), null, 'CV-240 lease refused in 1958');
  assert.equal(leaseDenial(eraState(1950), 'c47'), null, 'surplus C-47 lease refused in 1950');
});

test('the Marketplace blocks the lease with the same year (SSR, 1950 world)', async () => {
  const store = new Map();
  globalThis.window = globalThis.window ?? {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), clear: () => store.clear(),
  };
  store.set('bbae_save_v2', JSON.stringify({
    phase: 'playing', week: 1, year: 1, startYear: 1950, cash: 4_000_000, hub: 'JFK', airlineName: 'Test',
    newWorldRestrictions: true, routes: [], cargoRoutes: [], competitors: [], fleet: [], pendingOrders: [],
  }));
  store.set('market_layout', 'table');
  const { GameProvider } = await import('../src/store/GameContext.jsx');
  const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(Marketplace)))
    .replace(/<!-- -->/g, '');
  const i = html.indexOf('Convair CV-240');
  assert.notEqual(i, -1, 'CV-240 never rendered — this test proves nothing');
  const row = html.slice(i, html.indexOf('</tr>', i));
  assert.match(row, /Lessors take it from 1958/, 'CV-240 row does not state the 1958 lease year');
  const j = html.indexOf('Douglas C-47');
  assert.notEqual(j, -1, 'C-47 never rendered');
  assert.doesNotMatch(html.slice(j, html.indexOf('</tr>', j)), /Lessors take it from/, 'surplus C-47 shows a lease block');
});
