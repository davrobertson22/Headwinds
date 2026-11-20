// Freighters cannot be fitted with Wi-Fi (Tailwinds Discord, 2026-11-18: "The game let
// me fit Wifi to my 777-8Fs").
//
// A freighter has no passengers to sell connectivity to. Before: canFitWifi
// only checked the airframe's era, so every modern freighter took the retrofit
// ($1.05M) and then paid the $1,500/wk running cost forever for nothing.
//
//   node --import ./tools/_register-loader.mjs tools/wifi-freighter-test.mjs

import assert from 'node:assert/strict';
import { gameReducer } from '../src/store/GameContext.jsx';
import { getAircraftType, canFitWifi, wifiAirframeDenial, AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import {
  canRetrofitWifi, canFitWifiTo, isWifiEquipped, fleetWifiWeeklyCost, wifiEquippedCount, WIFI_WEEKLY_OPEX,
} from '../src/data/wifi.js';

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const tail = (id, typeId, extra = {}) => ({
  id, typeId, name: getAircraftType(typeId).name, status: 'parked', ageWeeks: 52, hasWifi: false, ...extra,
});

console.log('\nNo Wi-Fi on freighters\n');

t('no freighter in the catalogue can be fitted, and each says why', () => {
  const freighters = AIRCRAFT_TYPES.filter(x => x.freighter);
  assert.ok(freighters.length > 20);
  for (const f of freighters) {
    assert.equal(canFitWifi(f), false, `${f.name} should not be fittable`);
    assert.match(wifiAirframeDenial(f), /freighter: it carries no passengers/);
  }
  assert.equal(canFitWifi(getAircraftType('b7879')), true, 'the passenger 787-9 still can');
});

t('INSTALL_WIFI refuses a 777-8F and charges nothing', () => {
  const st = { week: 20, year: 2, hub: 'JFK', cash: 50_000_000, fleet: [tail('f1', 'b7778f')],
               routes: [], pendingOrders: [], pendingToasts: [], startYear: null, aircraftCounter: {} };
  const after = gameReducer(st, { type: 'INSTALL_WIFI', aircraftIds: ['f1'] });
  assert.equal(after.fleet[0].hasWifi, false);
  assert.equal(after.cash, st.cash);
  assert.match(after.pendingToasts.at(-1).message, /freighter/);
});

t('a bulk selection of freighters says freighters, not "left production decades before"', () => {
  const q = canRetrofitWifi([tail('f1', 'b7778f'), tail('f2', 'b777f')], 1e9);
  assert.equal(q.ok, false);
  assert.match(q.reasons[0], /freighters carry no passengers/);
});

t('a freighter a save already fitted stops counting and stops paying', () => {
  const fleet = [tail('f1', 'b7778f', { hasWifi: true }), tail('p1', 'a320neo', { hasWifi: true })];
  assert.equal(isWifiEquipped(fleet[0]), false);
  assert.equal(isWifiEquipped(fleet[1]), true);
  assert.equal(wifiEquippedCount(fleet), 1);
  assert.equal(fleetWifiWeeklyCost(fleet), WIFI_WEEKLY_OPEX, 'only the passenger jet pays');
  assert.equal(canFitWifiTo(fleet[0]), false);
});

// ── The screens agree ────────────────────────────────────────────────────────
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;
const { AircraftDetail } = await import('../src/components/Fleet.jsx');

const save = {
  ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000, gates: { JFK: 8 },
  fleet: [{ ...tail('f1', 'b7778f', { hasWifi: true }), tailNumber: 'NUSA23', ownershipType: 'owned', config: {} },
          { ...tail('f2', 'b777f'), tailNumber: 'NUSA24', ownershipType: 'owned', config: {} }],
  routes: [],
};
store.set('bbae_save_v2', JSON.stringify(save));
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

t('the order form does not offer the Wi-Fi package on a freighter', () => {
  const html = render(React.createElement(AircraftCheckout, { typeId: 'b7778f', onClose() {} }));
  assert.ok(!html.includes('Wi-Fi &amp; streaming package<'), 'no buyable option');
});

t('the aircraft page shows no Wi-Fi badge or retrofit on a freighter, fitted or not', () => {
  for (const ac of save.fleet) {
    const html = render(React.createElement(AircraftDetail, { aircraft: ac, onClose() {} }));
    assert.ok(!html.includes('Fit Wi-Fi'), `${ac.id}: no retrofit button`);
    assert.ok(!/📶[^<]*<\/span>\s*Wi-Fi|> Wi-Fi</.test(html), `${ac.id}: no Wi-Fi badge`);
    assert.ok(!html.includes('No Wi-Fi possible'), `${ac.id}: no "penalty" badge either — freighters have no passengers`);
  }
});

console.log(`\nwifi-freighter-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
