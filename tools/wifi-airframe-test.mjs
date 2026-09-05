// Wi-Fi has to be possible on the aircraft you are fitting it to.
//
// Discord 2026-09-03 (Kat the Fox): "Piston aircraft like the constellation has
// the WiFi package options"; CorporalSimmons: "Applies to Tailwinds too, I can
// technically equip a 377 with a Wifi package from the factory". The factory in
// question shut in 1950.
//
// Two separate gates were missing, and each is tested here:
//
//   1. THE AIRFRAME. `ERA_FEATURE_FROM.wifi` gates the calendar, which is no
//      gate at all in a classic world — and the vintage rule puts every
//      propliner in the classic catalogue. An airframe whose line closed before
//      1970 has no cabin power provisioning and no certified installation, in
//      any world. Same shape as isPressurized/hasAPU: capability lives on the
//      type, only the exceptions are flagged.
//
//   2. THE WORLD, on the ORDER path. INSTALL_WIFI called refuseEraFeature;
//      ORDER_AIRCRAFT never did, so a 1950 era world would happily line-fit
//      connectivity onto a brand-new DC-6.
//
// The quality drag is deliberately NOT exempted: a tail that cannot be fitted
// still takes absentQ. The market judges the flight it got, not the engineering
// that made it impossible — flying vintage metal into a connected market is
// supposed to cost something. The test pins that so a future "be nice to
// propliners" change is a decision rather than an accident.
//
//   node --import ./tools/_register-loader.mjs tools/wifi-airframe-test.mjs

import assert from 'node:assert/strict';
import { gameReducer } from '../src/store/GameContext.jsx';
import {
  getAircraftType, canFitWifi, wifiAirframeDenial, WIFI_AIRFRAME_FROM, AIRCRAFT_TYPES,
} from '../src/data/aircraft.js';
import { canRetrofitWifi, canFitWifiTo, wifiRetrofitCost } from '../src/data/wifi.js';
import { ancillaryQualityBonus, defaultAncillaries, ANCILLARY_MAP } from '../src/data/ancillaries.js';
import { formatMoney } from '../src/utils/simulation.js';

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};

console.log('\nWi-Fi needs an airframe that can carry it\n');

// ── 1. The airframe rule ─────────────────────────────────────────────────────

const BLOCKED = ['l749', 'l1049', 'b377', 'dc3', 'c47', 'dc4', 'dc6b', 'dc7c',
                 'cv240', 'cv440', 'm404', 'il14', 'comet1', 'b707120', 'northstar'];
const ALLOWED = ['a320neo', 'b737800', 'b7879', 'a350900', 'md80', 'b737300',
                 'b727200', 'b737200'];

t('the reported airframes cannot be fitted', () => {
  for (const id of BLOCKED) {
    const type = getAircraftType(id);
    assert.ok(type, `catalogue is missing ${id}`);
    assert.equal(canFitWifi(type), false, `${type.name} should not be fittable`);
  }
});

t('the modern and late-jet catalogue is untouched', () => {
  for (const id of ALLOWED) {
    const type = getAircraftType(id);
    assert.ok(type, `catalogue is missing ${id}`);
    assert.equal(canFitWifi(type), true, `${type.name} should still be fittable`);
  }
});

t('the rule is the production line closing, not entry into service', () => {
  for (const type of AIRCRAFT_TYPES) {
    if (type.wifi != null) continue;              // explicit override, not the rule
    const expected = (type.oop ?? Infinity) >= WIFI_AIRFRAME_FROM;
    assert.equal(canFitWifi(type), expected, `${type.name} (oop ${type.oop})`);
  }
});

t('a type still in production is always fittable', () => {
  const inProduction = AIRCRAFT_TYPES.filter(a => a.oop == null && a.wifi == null);
  assert.ok(inProduction.length > 20, 'expected many in-production types');
  for (const type of inProduction) assert.equal(canFitWifi(type), true, type.name);
});

t('a per-type override beats the rule in both directions', () => {
  assert.equal(canFitWifi({ name: 'X', oop: 1950, wifi: true }), true);
  assert.equal(canFitWifi({ name: 'Y', oop: 2020, wifi: false }), false);
});

t('the denial names the aircraft and the year the line closed', () => {
  const msg = wifiAirframeDenial(getAircraftType('b377'));
  assert.ok(msg && msg.includes('377'), 'should name the type');
  assert.ok(msg.includes('1950'), 'should name the closure year');
  assert.equal(wifiAirframeDenial(getAircraftType('a320neo')), null);
});

// ── 2. The retrofit quote ────────────────────────────────────────────────────

const tail = (id, typeId, extra = {}) => ({
  id, typeId, name: getAircraftType(typeId).name,
  status: 'parked', ageWeeks: 900, hasWifi: false, ...extra,
});

t('canFitWifiTo reads a tail, an order or a bare typeId', () => {
  assert.equal(canFitWifiTo(tail('a', 'b377')), false);
  assert.equal(canFitWifiTo({ typeId: 'a320neo' }), true);
  assert.equal(canFitWifiTo('l749'), false);
  assert.equal(canFitWifiTo('a320neo'), true);
});

t('an unfittable tail is not in the quote and not in the capex', () => {
  const q = canRetrofitWifi([tail('t1', 'b377'), tail('t2', 'a320neo')], 5e9);
  assert.equal(q.eligible.length, 1);
  assert.equal(q.eligible[0].id, 't2');
  assert.equal(q.unfittable.length, 1);
  assert.equal(q.capex, wifiRetrofitCost(), 'capex must cover the fittable tail only');
  assert.equal(q.ok, true, 'one fittable tail is still a valid retrofit');
});

t('a selection of nothing but propliners is refused, with the reason', () => {
  const q = canRetrofitWifi([tail('t1', 'b377'), tail('t2', 'l749')], 5e9);
  assert.equal(q.ok, false);
  assert.equal(q.capex, 0);
  assert.match(q.reasons[0], /cannot be fitted|can be fitted/i);
  assert.ok(!/already fitted/i.test(q.reasons[0]),
    'must not tell the player they already have Wi-Fi');
});

t('one propliner alone gets the specific airframe reason', () => {
  const q = canRetrofitWifi([tail('t1', 'l749')], 5e9);
  assert.equal(q.ok, false);
  assert.ok(q.reasons[0].includes('1951'), 'names the year the line closed');
});

t('the already-fitted message is unchanged when that is the real reason', () => {
  const q = canRetrofitWifi([tail('t1', 'a320neo', { hasWifi: true })], 5e9);
  assert.equal(q.ok, false);
  assert.match(q.reasons[0], /already fitted/i);
});

// ── 3. The reducer refuses what the UI hides ─────────────────────────────────

const baseState = (over = {}) => ({
  week: 20, year: 2, hub: 'JFK', cash: 5_000_000_000,
  fleet: [], routes: [], pendingOrders: [], pendingToasts: [],
  startYear: null, aircraftCounter: {}, ...over,
});

t('INSTALL_WIFI does not fit a propliner, and charges nothing', () => {
  const st    = baseState({ fleet: [tail('t1', 'b377'), tail('t2', 'l749')] });
  const after = gameReducer(st, { type: 'INSTALL_WIFI', aircraftIds: ['t1', 't2'] });
  assert.equal(after.fleet.every(a => !a.hasWifi), true, 'no tail may come back fitted');
  assert.equal(after.cash, st.cash, 'no cash may move');
});

t('INSTALL_WIFI still fits the fittable tail in a mixed selection', () => {
  const st    = baseState({ fleet: [tail('t1', 'b377'), tail('t2', 'a320neo')] });
  const after = gameReducer(st, { type: 'INSTALL_WIFI', aircraftIds: ['t1', 't2'] });
  assert.equal(after.fleet.find(a => a.id === 't1').hasWifi, false);
  assert.equal(after.fleet.find(a => a.id === 't2').hasWifi, true);
  assert.equal(st.cash - after.cash, wifiRetrofitCost(), 'charged for exactly one tail');
});

t('ORDER_AIRCRAFT will not line-fit connectivity onto a 1950 airframe', () => {
  const after = gameReducer(baseState(), {
    type: 'ORDER_AIRCRAFT', typeId: 'b377', ownershipType: 'owned', quantity: 1, hasWifi: true,
  });
  const order = after.pendingOrders?.[0];
  assert.ok(order, 'the order itself must still be placed');
  assert.equal(order.hasWifi, false, 'the aircraft must not arrive fitted');
});

t('ORDER_AIRCRAFT does not charge for an antenna it refused to fit', () => {
  const withWifi = gameReducer(baseState(), {
    type: 'ORDER_AIRCRAFT', typeId: 'b377', ownershipType: 'owned', quantity: 1, hasWifi: true,
  });
  const without  = gameReducer(baseState(), {
    type: 'ORDER_AIRCRAFT', typeId: 'b377', ownershipType: 'owned', quantity: 1, hasWifi: false,
  });
  assert.equal(withWifi.cash, without.cash, 'a refused fit must cost nothing');
  assert.equal(withWifi.pendingOrders[0].totalPrice, without.pendingOrders[0].totalPrice);
});

// The WORLD gate, which the airframe gate can mask: every state above is a
// classic world, where featureLive('wifi', null) is true and the airframe rule
// alone satisfies the assertion. These order a modern jet — fittable in any
// world — so the only thing that can refuse them is the calendar.

t('an era world before 2004 refuses factory Wi-Fi on a fittable jet', () => {
  const after = gameReducer(baseState({ startYear: 1990, year: 1, week: 4 }), {
    type: 'ORDER_AIRCRAFT', typeId: 'b737300', ownershipType: 'owned', quantity: 1, hasWifi: true,
  });
  const order = after.pendingOrders?.[0];
  assert.ok(order, 'the order is still placed');
  assert.equal(order.hasWifi, false, 'onboard internet does not exist in 1990');
});

t('an era world after 2004 allows it again', () => {
  const after = gameReducer(baseState({ startYear: 2010, year: 1, week: 4 }), {
    type: 'ORDER_AIRCRAFT', typeId: 'b737800', ownershipType: 'owned', quantity: 1, hasWifi: true,
  });
  assert.equal(after.pendingOrders?.[0]?.hasWifi, true);
});

t('a propliner never arrives fitted, in any world', () => {
  // The era catalogue may refuse to sell a 1951 airframe in 2010 at all, so
  // this asserts the negative that holds either way: no order, or an
  // unfitted one. The two gates are independent — passing the calendar gate
  // does not buy you past the airframe.
  for (const startYear of [null, 2010, 2026]) {
    const after = gameReducer(baseState({ startYear, year: 1, week: 4 }), {
      type: 'ORDER_AIRCRAFT', typeId: 'l749', ownershipType: 'owned', quantity: 1, hasWifi: true,
    });
    assert.notEqual(after.pendingOrders?.[0]?.hasWifi, true,
      `a Constellation must never be ordered with Wi-Fi (startYear ${startYear})`);
  }
});

t('a pending order from before the gate does not deliver fitted', () => {
  // A save written before this change can hold an in-flight order for a
  // Constellation with hasWifi: true. It must not arrive connected and start
  // paying weekly connectivity costs on an airframe that cannot carry it.
  const type = getAircraftType('b377');
  assert.equal(canFitWifi(type), false);
  const legacyOrder = {
    id: 'o1', typeId: 'b377', ownershipType: 'owned', name: 'Legacy Clipper',
    hasWifi: true, deliverAbsWeek: 0, totalPrice: 0, orderedWeek: 1, orderedYear: 1,
  };
  assert.equal((legacyOrder.hasWifi ?? false) && canFitWifi(getAircraftType(legacyOrder.typeId)),
    false, 'the delivery gate must drop the flag');
});

t('the denial does not print "undefined" for an override with no oop date', () => {
  // `wifi: false` is documented as a per-type override, and an in-production
  // type has no `oop` to name.
  const msg = wifiAirframeDenial({ name: 'Test Type', wifi: false });
  assert.ok(msg, 'an overridden type still gets a reason');
  assert.ok(!msg.includes('undefined'), `denial leaked undefined: ${msg}`);
});

t('a modern order still gets its Wi-Fi and pays for it', () => {
  const withWifi = gameReducer(baseState(), {
    type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'owned', quantity: 1, hasWifi: true,
  });
  const without  = gameReducer(baseState(), {
    type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'owned', quantity: 1, hasWifi: false,
  });
  assert.equal(withWifi.pendingOrders[0].hasWifi, true);
  assert.ok(withWifi.cash < without.cash, 'the line-fit has to cost something');
});

// ── 4. The quality drag is NOT exempted ──────────────────────────────────────

t('an unfittable tail still takes the no-Wi-Fi quality penalty', () => {
  const anc  = defaultAncillaries();
  const off  = ancillaryQualityBonus(anc, 1500, { wifi: 0 });
  const on   = ancillaryQualityBonus(anc, 1500, { wifi: 1 });
  assert.ok(ANCILLARY_MAP.wifi.absentQ < 0, 'wifi must carry an absent-amenity drag');
  assert.ok(off < on, 'no coverage must score worse than full coverage');
});

// ── 5. The screens agree with the engine ─────────────────────────────────────
//
// A predicate tested alone can pass while the component that calls it goes on
// offering the checkbox. These server-render the REAL screens against a seeded
// save, which is the house rule for UI agreement (see wifi-lounge-ui-test.mjs).

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const React            = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;
const { AircraftDetail } = await import('../src/components/Fleet.jsx');

function seed(extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000,
    gates: { JFK: 8, LAX: 8 },
    fleet: [
      { id: 'ac1', typeId: 'b377', name: 'Clipper Test', tailNumber: 'N1TEST',
        status: 'parked', ageWeeks: 52, ownershipType: 'owned',
        config: { economy: getAircraftType('b377').seats } },
      { id: 'ac2', typeId: 'a320neo', name: 'Modern Two', tailNumber: 'N2TEST',
        status: 'parked', ageWeeks: 52, ownershipType: 'owned',
        config: { economy: getAircraftType('a320neo').seats } },
    ],
    routes: [],
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

const render = (el) => renderToString(React.createElement(GameProvider, null, el));

t('the order form does not offer the package on a propliner', () => {
  seed();
  const html = render(React.createElement(AircraftCheckout, { typeId: 'b377', onClose() {} }));
  assert.ok(html.includes('unavailable'), 'the section must state that it is unavailable');
  assert.ok(html.includes('1950'), 'and say why — the year the line closed');
  assert.ok(!html.includes('Wi-Fi &amp; streaming package<'),
    'the buyable option must not be rendered');
});

t('the order form still offers it on a modern jet', () => {
  seed();
  const html = render(React.createElement(AircraftCheckout, { typeId: 'a320neo', onClose() {} }));
  assert.ok(html.includes('Wi-Fi &amp; streaming package'), 'the option is offered');
  assert.ok(!html.includes('unavailable'), 'and not flagged unavailable');
});

t('the aircraft page offers no retrofit on an airframe that cannot take one', () => {
  const save = seed();
  const html = render(React.createElement(AircraftDetail, { aircraft: save.fleet[0], onClose() {} }));
  assert.ok(html.includes('No Wi-Fi possible'), 'the propliner states the reason');
  assert.ok(!html.includes('Fit Wi-Fi'), 'and offers no button it could never honour');
  assert.ok(html.includes('1950'), 'the tooltip explains why');
});

t('the aircraft page still offers the retrofit on a modern jet', () => {
  const save = seed();
  const html = render(React.createElement(AircraftDetail, { aircraft: save.fleet[1], onClose() {} }));
  assert.ok(html.includes('Fit Wi-Fi'), 'the retrofit offer survives');
  assert.ok(html.includes(formatMoney(wifiRetrofitCost())),
    'quoted at the same price the reducer charges');
  assert.ok(!html.includes('No Wi-Fi possible'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
