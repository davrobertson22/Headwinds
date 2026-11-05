// Fleet renewal filters — narrowing both sides of "which aircraft does this
// order replace": the orders on the books (Fleet → On Order, Marketplace →
// Orders) and the tails a picker offers (order form + "Replace an aircraft…").
//
// Discord (Nov 2026): "you would be able to filter aircraft when going into the
// ones that are on order and selecting which aircraft it is to replace. you can
// do this for both sides."
//
// What this suite pins:
//   * filterTailRows / filterOrders: search (every word, any field), type,
//     owned/leased, "can replace only", replacing yes/no — and an empty filter
//     returns the very same array.
//   * Filtering only hides rows; it never changes what the form dispatches.
//   * The bars appear on long lists (FILTER_MIN_ROWS) and stay out of short ones.
//
//   node --import ./tools/_register-loader.mjs tools/renewal-filter-test.mjs

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

const F = await import('../src/utils/renewalFilters.js').catch(() => ({}));
const { GameProvider, freshState, replacementCompatibility } = await import('../src/store/GameContext.jsx');
const { getAircraftType } = await import('../src/data/aircraft.js');
const R = await import('../src/components/FleetRenewal.jsx');
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');
const need = (k) => assert.ok(F[k], `renewalFilters.js does not export ${k}`);

const tail = (id, name, typeId, extra = {}) => ({
  id, typeId, name, tailNumber: id.toUpperCase(), status: 'assigned', ageWeeks: 1400,
  ownershipType: 'owned', config: { economy: 150 }, ...extra,
});
const route = (id, aircraftId, o, d) => ({
  id, origin: o, destination: d, aircraftId, weeklyFrequency: 7, weeksOpen: 40,
  hub: 'JFK', ticketPrice: 240, cateringLevel: 'full', stops: [o, d],
});
const order = (id, typeId, extra = {}) => ({
  id, typeId, ownershipType: 'owned', name: `${typeId} ${id}`,
  deliverAbsWeek: 52 + 20 + 6, totalPrice: 1, leaseDeposit: 0, weeklyLease: 0,
  orderedWeek: 19, orderedYear: 2, fuelMod: 1, rangeMod: 1, maintMod: 1, ...extra,
});

const FLEET = [
  tail('o1', 'Old Bird 1', 'a320ceo'),
  tail('o2', 'Old Bird 2', 'a320ceo', { ageWeeks: 1600, ownershipType: 'lease', leaseRemainingWeeks: 300, weeklyLease: 1000 }),
  tail('o3', 'Island Hopper', 'atr72', { ageWeeks: 900 }),
  tail('o4', 'Long Hauler', 'b767300', { ageWeeks: 1200 }),
  tail('o5', 'Old Bird 5', 'a320ceo', { ageWeeks: 1500 }),
  tail('o6', 'Spare Prop', 'atr72', { ageWeeks: 700, status: 'idle', ownershipType: 'lease', leaseRemainingWeeks: 300, weeklyLease: 500 }),
];
const ORDERS = [
  order('n1', 'a321neo', { replacesAircraftId: 'o1', replacesName: 'Old Bird 1', replaceDisposal: 'dispose' }),
  order('n2', 'a321neo'),
  order('n3', 'a321neo', { ownershipType: 'lease' }),
  order('n4', 'atr72'),
  order('n5', 'b7879', { ownershipType: 'lease' }),
];

function seed(extra = {}) {
  const save = {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 900_000_000,
    gates: { JFK: 20, BOS: 10, LAX: 10 },
    fleet: FLEET,
    routes: [route('r1', 'o1', 'JFK', 'BOS'), route('r2', 'o2', 'JFK', 'LAX'), route('r5', 'o5', 'JFK', 'LAX')],
    pendingOrders: ORDERS,
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

function rowsFor(state, ord) {
  return state.fleet.map(a => ({ a, t: getAircraftType(a.typeId), c: replacementCompatibility(state, ord, a.id) }));
}
const names = (rows) => rows.map(r => r.a.name);

console.log('\n── Tail filter (the "replaces" pickers) ──────────────────────');

test('an empty filter returns the list untouched', () => {
  need('filterTailRows');
  const s = seed();
  const rows = rowsFor(s, ORDERS[1]);
  assert.equal(F.filterTailRows(rows, F.EMPTY_TAIL_FILTER), rows);
});

test('search matches name, tail number or type, every word', () => {
  const s = seed();
  const rows = rowsFor(s, ORDERS[1]);
  assert.deepEqual(names(F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, q: 'old bird' })), ['Old Bird 1', 'Old Bird 2', 'Old Bird 5']);
  assert.deepEqual(names(F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, q: 'O4' })), ['Long Hauler']);
  const atr = getAircraftType('atr72').name.split(' ')[0];
  assert.deepEqual(names(F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, q: atr })), ['Island Hopper', 'Spare Prop']);
  assert.deepEqual(names(F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, q: 'old 5' })), ['Old Bird 5']);
});

test('type and ownership narrow together', () => {
  const s = seed();
  const rows = rowsFor(s, ORDERS[1]);
  assert.deepEqual(names(F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, typeId: 'a320ceo' })), ['Old Bird 1', 'Old Bird 2', 'Old Bird 5']);
  assert.deepEqual(names(F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, typeId: 'a320ceo', own: 'lease' })), ['Old Bird 2']);
  assert.deepEqual(names(F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, own: 'owned' })), ['Old Bird 1', 'Island Hopper', 'Long Hauler', 'Old Bird 5']);
});

test('"can replace only" agrees with replacementCompatibility', () => {
  const s = seed();
  const rows = rowsFor(s, ORDERS[1]);
  const ok = F.filterTailRows(rows, { ...F.EMPTY_TAIL_FILTER, okOnly: true });
  assert.deepEqual(names(ok), names(rows.filter(r => r.c.ok)));
  assert.ok(!names(ok).includes('Old Bird 1'), 'Old Bird 1 is already being replaced by another order');
  assert.ok(ok.length > 0 && ok.length < rows.length);
});

console.log('\n── Order filter (On Order / Orders tab) ──────────────────────');

test('an empty filter returns the list untouched', () => {
  need('filterOrders');
  assert.equal(F.filterOrders(ORDERS, F.EMPTY_ORDER_FILTER, getAircraftType), ORDERS);
});

test('replacing yes / no splits the book', () => {
  const yes = F.filterOrders(ORDERS, { ...F.EMPTY_ORDER_FILTER, replacing: 'yes' }, getAircraftType);
  const no  = F.filterOrders(ORDERS, { ...F.EMPTY_ORDER_FILTER, replacing: 'no' }, getAircraftType);
  assert.deepEqual(yes.map(o => o.id), ['n1']);
  assert.deepEqual(no.map(o => o.id), ['n2', 'n3', 'n4', 'n5']);
});

test('type, purchase/lease and search', () => {
  const f = (x) => F.filterOrders(ORDERS, { ...F.EMPTY_ORDER_FILTER, ...x }, getAircraftType).map(o => o.id);
  assert.deepEqual(f({ typeId: 'a321neo' }), ['n1', 'n2', 'n3']);
  assert.deepEqual(f({ typeId: 'a321neo', own: 'lease' }), ['n3']);
  assert.deepEqual(f({ own: 'owned', replacing: 'no' }), ['n2', 'n4']);
  assert.deepEqual(f({ q: 'old bird' }), ['n1'], 'search reaches the tail an order replaces');
  assert.deepEqual(f({ q: getAircraftType('b7879').name }), ['n5']);
});

test('type options list what is present, most common first', () => {
  need('typeOptions');
  const opts = F.typeOptions(ORDERS, o => o.typeId, getAircraftType);
  assert.deepEqual(opts.map(o => [o.id, o.count]), [['a321neo', 3], ...[['atr72', 1], ['b7879', 1]].sort((x, y) => getAircraftType(x[0]).name.localeCompare(getAircraftType(y[0]).name))]);
});

console.log('\n── Screens ───────────────────────────────────────────────────');

test('the "Replace an aircraft" picker shows the filter on a long fleet', () => {
  const s = seed();
  const html = render(React.createElement(R.ReplacementPickerModal, { order: s.pendingOrders[1], onClose() {} }));
  assert.match(html, /Search name, tail, type/);
  assert.match(html, /6 total/);
  assert.match(html, /Can replace only/);
});

test('…and stays out of the way on a short one', () => {
  const s = seed({ fleet: FLEET.slice(0, 2), pendingOrders: [ORDERS[1]], routes: [] });
  const html = render(React.createElement(R.ReplacementPickerModal, { order: s.pendingOrders[0], onClose() {} }));
  assert.doesNotMatch(html, /Search name, tail, type/);
});

test('the order form gets the filter and select-all-shown', () => {
  seed({ pendingOrders: [] });
  const html = render(React.createElement(AircraftCheckout, {
    typeId: 'a321neo', mode: 'buy', replaceIds: ['o1'], onClose() {},
  }));
  assert.match(html, /Search name, tail, type/);
  assert.match(html, /Select all shown/);
});

test('the order filter bar renders for five or more orders, not fewer', () => {
  seed();
  const set = () => {};
  const html = render(React.createElement(R.OrderFilterBar, { orders: ORDERS, filter: F.EMPTY_ORDER_FILTER, setFilter: set }));
  assert.match(html, /Search orders/);
  assert.match(html, /Not replacing yet \(4\)/);
  assert.match(html, /Replacing a tail \(1\)/);
  const short = render(React.createElement(R.OrderFilterBar, { orders: ORDERS.slice(0, 3), filter: F.EMPTY_ORDER_FILTER, setFilter: set }));
  assert.doesNotMatch(short, /Search orders/);
});

test('filtering never changes what the order form dispatches', () => {
  const s = seed({ pendingOrders: [] });
  const draft = { id: 'd', typeId: 'a321neo', ownershipType: 'owned', name: 'x', rangeMod: 1 };
  const all = R.replacesForDispatch(s, ['o1', 'o2', 'o5'], draft, 3);
  assert.deepEqual(all, ['o2', 'o5', 'o1']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
