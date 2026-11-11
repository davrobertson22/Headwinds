// Production lines, UI side: the market shows the world order board (every
// world) and the shared line (production-line worlds), announced types show
// launch terms, and the checkout's delivery weeks and prices are exactly what
// ORDER_AIRCRAFT books — SSR-rendering the real components.
//
//   node --import ./tools/_register-loader.mjs tools/production-lines-ui-test.mjs
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
Math.random = () => 0.5;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;
const { gameReducer } = await import('../packages/engine/src/reducer.mjs');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');

const seedSave = (save) => store.set('bbae_save_v2', JSON.stringify(save));
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const cardOf = (html, name) => {
  const i = html.indexOf(`>${name}<`);
  assert.ok(i > 0, `${name} card rendered`);
  const end = html.indexOf('aircraft-market-card', i);
  return text(html.slice(i, end > i ? end : undefined));
};

const base = (over = {}) => ({
  ...freshState(), hub: 'JFK', airlineName: 'Mine', cash: 5_000_000_000, ...over,
});
const lines = (over = {}) => base({ productionLinesWorld: true, productionLineScale: 1, ...over });
const era = (over = {}) => lines({ startYear: 2025, year: 1, week: 5, ...over });
const rival = { id: 'human:x', name: 'Rival Air', fleetMix: { a380: [10, 4] } };

console.log('\n── market');

test('every world: the card shows world totals and the customer list', () => {
  seedSave(base({ competitors: [rival], fleet: [{ id: 'f1', typeId: 'a380', status: 'idle', ownershipType: 'owned' }] }));
  const card = cardOf(render(React.createElement(Marketplace)), 'Airbus A380');
  assert.match(card, /World: 11 flying · 4 on order · 2 airlines/);
  assert.match(card, /Rival Air 10 flying · 4 on order/);
  assert.doesNotMatch(card, /line ·/, 'no production line in a classic world');
});

test('production-line world: the card shows the shared line and the list-price slot', () => {
  seedSave(lines());
  const card = cardOf(render(React.createElement(Marketplace)), 'Boeing 737-800');
  assert.match(card, /Boeing 737NG line · 8\/wk/);
  assert.match(card, /Delivery in 6 weeks at list price/);
  assert.match(card, /priority 3w at \+25%/);
});

test("rivals' bookings push the list-price slot back", () => {
  const s = lines();
  const std = absoluteWeek(s.year, s.week) + 6;
  seedSave({ ...s, lineBook: { scale: 1, bookings: { b737ng: { [std]: 8 } } } });
  const card = cardOf(render(React.createElement(Marketplace)), 'Boeing 737-800');
  assert.match(card, /Delivery in 7 weeks at list price/);
});

test('an announced type is offered to launch customers, buy only', () => {
  seedSave(era());
  const card = cardOf(render(React.createElement(Marketplace)), 'Boeing 777X-9');
  assert.match(card, /Launch customers wanted/);
  assert.match(card, /at least 20/);
  assert.match(card, /Launch order →/);
  assert.match(card, /Launch customers buy outright/);
});

console.log('\n── checkout agrees with the reducer');

function checkoutAndOrder(save, typeId, mode = 'buy', quantity = 1, priority = false) {
  seedSave(save);
  const html = text(render(React.createElement(AircraftCheckout, { typeId, mode, onClose: () => {}, defaultPriority: priority })));
  const after = gameReducer(save, { type: 'ORDER_AIRCRAFT', typeId, quantity, ownershipType: mode === 'buy' ? 'owned' : 'lease', ...(priority ? { priority: true } : {}) });
  return { html, placed: after.pendingOrders.slice(save.pendingOrders.length), paid: save.cash - after.cash };
}

test('standard slot: the quoted first delivery is the week the reducer books', () => {
  const s = lines();
  const { html, placed } = checkoutAndOrder(s, 'b737800');
  const weeks = placed[0].deliverAbsWeek - absoluteWeek(s.year, s.week);
  assert.match(html, new RegExp(`First delivery in ${weeks}w`));
  assert.match(html, /737NG line · 8 frames a week across every airline, 2 held back for priority orders/);
  assert.match(html, /Standard · list price First in 6w · 3w apart/);
  assert.match(html, /Priority First in 3w · 2w apart · \+\$/);
  assert.match(html, /6w list/);
  assert.doesNotMatch(html, / 3w list/, 'the standard calendar starts at the standard week');
});

test('priority checkout: the quoted weeks and fee are what the reducer books and charges', () => {
  const s = lines();
  const { html, placed } = checkoutAndOrder(s, 'b737800', 'buy', 1, true);
  const weeks = placed[0].deliverAbsWeek - absoluteWeek(s.year, s.week);
  assert.equal(weeks, 3);
  assert.equal(placed[0].priority, true);
  assert.match(html, new RegExp(`First delivery in ${weeks}w`));
  const fee = html.match(/Priority fee \+\$([\d.,]+)([KMB])/);
  assert.ok(fee, 'priority fee line shown');
  const shown = Number(fee[1].replace(/,/g, '')) * { K: 1e3, M: 1e6, B: 1e9 }[fee[2]];
  assert.ok(Math.abs(shown - placed[0].slotPremium) / placed[0].slotPremium < 0.01, `checkout says ${shown}, reducer charged ${placed[0].slotPremium}`);
});

test('launch checkout: 20 frames, from January of the EIS year, at the reducer price', () => {
  const s = era();
  const { html, placed, paid } = checkoutAndOrder(s, 'b7779x', 'buy', 20);
  assert.equal(placed.length, 20);
  assert.match(html, /Launch order\./);
  assert.match(html, /Launch orders are firm/);
  const first = placed[0].deliverAbsWeek - absoluteWeek(s.year, s.week);
  assert.match(html, new RegExp(`first in ${first}w`));
  const total = html.match(/Total \(20 aircraft\) \$([\d.,]+)([KMB])/);
  assert.ok(total, 'order total shown');
  const unit = { K: 1e3, M: 1e6, B: 1e9 }[total[2]];
  const shown = Number(total[1].replace(/,/g, '')) * unit;
  assert.ok(Math.abs(shown - paid) / paid < 0.01, `checkout says ${shown}, reducer charged ${paid}`);
});

test('An-225 launch checkout: one frame, scaled to the one ever built, at the reducer price', () => {
  const s = era({ startYear: 1986 });
  const { html, placed, paid } = checkoutAndOrder(s, 'an225', 'buy', 1);
  assert.equal(placed.length, 1, 'a one-frame launch order is accepted');
  assert.match(html, /Minimum 1 frame \(scaled to the 1 ever built\)/);
  assert.doesNotMatch(html, /bulk \+ launch/, 'no bulk discount on one frame');
  assert.match(html, /Total \(1 aircraft\)|Total \$/);
  assert.ok(paid > 0);
  seedSave(s);
  assert.match(cardOf(render(React.createElement(Marketplace)), 'Antonov An-225 Mriya'), /at least 1 \(1 ever built\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
