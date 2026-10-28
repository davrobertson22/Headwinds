// Bulk lease buyout from the Fleet selection bar.
//
// Discord (VodkaOnFire, 2026-10-22): "In Fleet, when using checkboxes for
// multiple aircraft, add an option to mass-buyout leases ... buy out all, or
// all the ones you can afford ... calculates the cost and lets you know how
// much is left after purchasing." Brabus-G-Wagon: "wait i swear they had that
// before". He was right. The button existed in both games, but it only
// rendered when one of the ticked tails was inside the lease-expiry warning
// window. Tick five healthy leases and the bar offered Extend and Let expire,
// and no buyout.
//
// THE CONTRACT
//   1. Any leased tail in the selection puts the buyout in the bar, expiring
//      or not.
//   2. bulkBuyoutPlan() is where the bar, the dialog and the dispatch get
//      their numbers: the total for all, the cheapest-first subset the cash
//      covers, and the cash left afterwards.
//   3. Dispatching the plan's subset leaves exactly plan.cashAfter in the bank.
//
//   node --import ./tools/_register-loader.mjs tools/bulk-lease-buyout-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';

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
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

const Ctx = await import('../src/store/GameContext.jsx');
const { GameProvider, freshState, gameReducer } = Ctx;
const { formatMoney } = await import('../src/utils/simulation.js');
const Fleet = (await import('../src/components/Fleet.jsx')).default;
const Buyout = await import('../src/models/leaseBuyout.js');
const { leaseBuyoutPrice } = Buyout;

const NARROW = AIRCRAFT_TYPES.find(t => t.id === 'b737800');
const WIDE   = AIRCRAFT_TYPES.find(t => t.id === 'a380');

const leased = (id, type = NARROW, extra = {}) => ({
  id, typeId: type.id, name: id, tailNumber: id.toUpperCase(), status: 'idle', ageWeeks: 52,
  ownershipType: 'lease', weeklyLease: 50_000, leaseDeposit: 0, leaseTermWeeks: 260,
  leaseRemainingWeeks: 200, config: { economy: type.seats }, ...extra,
});
const owned = (id) => ({ ...leased(id), ownershipType: 'owned', weeklyLease: 0,
  leaseTermWeeks: undefined, leaseRemainingWeeks: undefined });

const save = (extra) => ({
  ...freshState(),
  phase: 'playing', week: 20, year: 3, hub: 'JFK', cash: 2_000_000_000, homeCountry: 'US',
  gates: { JFK: 20 }, hubs: { JFK: { tier: 1 } }, routes: [], cargoRoutes: [],
  ...extra,
});
const strip = (h) => h.replace(/<!-- -->/g, '');
const renderFleet = (s, checked) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return strip(renderToString(React.createElement(GameProvider, null,
    React.createElement(Fleet, { initialCheckedIds: checked }))));
};
const plan = (s, list) => Buyout.bulkBuyoutPlan(s, list);

section('1. The plan');

test('cash covers everything: all of them, and the cash left is cash − total', () => {
  const s = save({ fleet: [leased('a'), leased('b'), leased('c')] });
  const p = plan(s, s.fleet);
  const total = s.fleet.reduce((x, a) => x + leaseBuyoutPrice(s, a), 0);
  assert.equal(p.quotes.length, 3);
  assert.equal(p.totalCost, total);
  assert.equal(p.canAffordAll, true);
  assert.equal(p.affordable.length, 3);
  assert.equal(p.affordableCost, total);
  assert.equal(p.cashAfter, s.cash - total);
  assert.equal(p.shortBy, 0);
});

test('cash runs short: cheapest first, the expensive tail is the one left out', () => {
  const base = save({ fleet: [leased('wide', WIDE), leased('n1'), leased('n2')] });
  const pw = leaseBuyoutPrice(base, base.fleet[0]);
  const pn = leaseBuyoutPrice(base, base.fleet[1]) + leaseBuyoutPrice(base, base.fleet[2]);
  assert.ok(pw > pn, `fixture: the widebody (${pw}) should cost more than both narrowbodies (${pn})`);
  const s = { ...base, cash: pn + 1_000 };
  const p = plan(s, s.fleet);
  assert.equal(p.canAffordAll, false);
  assert.deepEqual(p.affordable.map(q => q.aircraft.id).sort(), ['n1', 'n2']);
  assert.equal(p.affordableCost, pn);
  assert.equal(p.cashAfter, 1_000);
  assert.equal(p.shortBy, pn + pw - s.cash);
});

test('cash covers none: nothing affordable, cash untouched', () => {
  const s = save({ cash: 1_000, fleet: [leased('a'), leased('b')] });
  const p = plan(s, s.fleet);
  assert.equal(p.affordable.length, 0);
  assert.equal(p.cashAfter, 1_000);
  assert.equal(p.canAffordAll, false);
});

test('owned tails and repeated ids in the selection are not quoted', () => {
  const s = save({ fleet: [leased('a'), owned('o')] });
  const p = plan(s, [s.fleet[0], s.fleet[0], s.fleet[1]]);
  assert.equal(p.quotes.length, 1);
  assert.equal(p.totalCost, leaseBuyoutPrice(s, s.fleet[0]));
});

test('dispatching the plan leaves exactly plan.cashAfter, every planned tail owned', () => {
  const base = save({ fleet: [leased('wide', WIDE), leased('n1'), leased('n2'), owned('o')] });
  const cheap = leaseBuyoutPrice(base, base.fleet[1]) + leaseBuyoutPrice(base, base.fleet[2]);
  const s = { ...base, cash: cheap + 5_000 };
  const p = plan(s, s.fleet);
  const after = gameReducer(s, { type: 'BUY_OUT_LEASES', aircraftIds: p.affordable.map(q => q.aircraft.id) });
  assert.equal(after.cash, p.cashAfter, 'the dialog promised one cash balance and the reducer left another');
  for (const q of p.affordable) assert.equal(after.fleet.find(a => a.id === q.aircraft.id).ownershipType, 'owned');
  assert.equal(after.fleet.find(a => a.id === 'wide').ownershipType, 'lease');
});

section('2. The Fleet selection bar (SSR, the real component)');

test('healthy leases ticked, none expiring: the buyout is in the bar with cost and cash left', () => {
  const s = save({ fleet: [leased('a'), leased('b'), leased('c')] });
  const html = renderFleet(s, ['a', 'b', 'c']);
  const p = plan(s, s.fleet);
  assert.ok(html.includes('Extend leases (3)'), 'fixture: the selection bar did not render');
  assert.ok(html.includes('Buy out (3)'), 'no buyout button for three ticked leases that are not expiring');
  assert.ok(html.includes(formatMoney(p.totalCost)), 'the button does not show what the buyout costs');
  assert.ok(html.includes(`${formatMoney(p.cashAfter)} left`), 'the button does not say how much cash is left afterwards');
});

test('cash short: the bar says how many of the ticked leases the cash covers', () => {
  const base = save({ fleet: [leased('wide', WIDE), leased('n1'), leased('n2')] });
  const cheap = leaseBuyoutPrice(base, base.fleet[1]) + leaseBuyoutPrice(base, base.fleet[2]);
  const s = { ...base, cash: cheap + 1_000 };
  const html = renderFleet(s, ['wide', 'n1', 'n2']);
  assert.ok(html.includes('Buy out 2 of 3'), 'the bar quotes all three when the cash covers two');
  assert.ok(html.includes(formatMoney(cheap)), 'the bar shows a cost other than the two it can buy');
});

test('only owned tails ticked: no buyout button', () => {
  const s = save({ fleet: [owned('o1'), owned('o2')] });
  const html = renderFleet(s, ['o1', 'o2']);
  assert.ok(!html.includes('Buy out'), 'a buyout was offered with no leases in the selection');
});

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
