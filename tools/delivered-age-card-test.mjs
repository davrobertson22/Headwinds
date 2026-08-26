// The store card must quote the aircraft the player actually receives.
//
// Reported in Discord 2026-08-26 (Kat the Fox): the 737-400 costs MORE than the
// 737-700 while the card showed it as the more efficient aircraft — 94/100 vs
// 92/100 seat efficiency, $51.0K/wk maintenance vs $45.0K. Both halves of that
// card were misleading:
//
//   * A CFM56-3 Classic cannot out-efficiency a CFM56-7B NG. The -400 was
//     entered at 406.25 L/100km against the -700's 341, which over 189 seats vs
//     149 made the older, thirstier airframe read as 2.15 L/seat against 2.29 —
//     backwards. Real per-hour burn is ~10% the other way.
//   * `baseMaintenancePerWk` is the FACTORY-FRESH rate. An out-of-production
//     type arrives `deliveredAgeWeeks` old and therefore bills
//     maintenanceMultiplier(deliveredAgeWeeks) x base from its first week — 1.5x
//     for the 10y-old -400 against 1.18x for the 6y-old -700. The card printed
//     the base for both, hiding the single largest running-cost difference
//     between the two aircraft it was inviting the player to compare.
//
// The contract: seat efficiency ranks generations correctly, and every screen
// that quotes a weekly maintenance figure for a type the player has not bought
// yet quotes the DELIVERED figure, with the delivered age stated next to it.
//
//   node --import ./tools/_register-loader.mjs tools/delivered-age-card-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES, seatEfficiency } from '../src/data/aircraft.js';
import { formatMoney, maintenanceMultiplier } from '../src/utils/simulation.js';

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
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      throw new Error('test bodies must be synchronous — an async body is never awaited here');
    }
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`);
    failed++;
  }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }

const { GameProvider } = await import('../src/store/GameContext.jsx');
const Marketplace = (await import('../src/components/Marketplace.jsx')).default;

const get = (id) => AIRCRAFT_TYPES.find(t => t.id === id);
const deliveredMaint = (t) =>
  Math.round((t.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(t.deliveredAgeWeeks ?? 0));

/** The slice of markup belonging to one aircraft's card. */
function cardFor(html, name) {
  const i = html.indexOf(name);
  assert.notEqual(i, -1, `${name} never rendered — this suite would prove nothing`);
  return html.slice(i, i + 6000);
}

console.log('\nStore cards quote the delivered aircraft, not a factory-fresh fiction\n');

// ── 1. The data ──────────────────────────────────────────────────────────────
section('1. Seat efficiency ranks generations the right way round');

test('the CFM56-3 Classic burns more per aircraft than the CFM56-7B NG', () => {
  // Compare LIKE FOR LIKE. The -400 and the -800 are the same fuselage at the same
  // 189-seat exit limit, so the generation gap shows up cleanly: published block
  // fuel is ~2,600 kg/h against ~2,500, i.e. the Classic burns about 4% more.
  //
  // Do NOT compare the -400 to the -700 here. That is a SIZE comparison wearing a
  // generation costume: 189 seats against 149. In real life the bigger Classic
  // genuinely does beat the smaller NG per seat (13.76 vs 15.44 kg/seat/h) because
  // bigger aircraft always carry seats more cheaply. Asserting otherwise is what
  // pushed this entry to 440 L/100km on 2026-08-26 — 14% above the real figure and
  // the worst outlier in the 737 table, when every other Classic sits within 1%.
  const classic = get('b737400'), ng = get('b737800');
  assert.equal(classic.seats, ng.seats, 'the like-for-like premise of this test');
  assert.ok(classic.fuelBurnPer100km > ng.fuelBurnPer100km,
    `the Classic must burn more: -400 ${classic.fuelBurnPer100km} vs -800 ${ng.fuelBurnPer100km}`);
  const gap = classic.fuelBurnPer100km / ng.fuelBurnPer100km - 1;
  assert.ok(gap > 0.02 && gap < 0.08,
    `-400 burns ${(gap * 100).toFixed(1)}% more than the -800; the real gap is ~4%, and a `
    + 'number outside 2-8% is either flattering the Classic or punishing it to force a ranking');
});

test('the -800 out-efficiencies the Classic it replaced, seat for seat', () => {
  assert.ok(seatEfficiency(get('b737800')) < seatEfficiency(get('b737400')));
});

test('no 737 Classic is described to the player as Next-Generation metal, or vice versa', () => {
  const wrong = [];
  for (const [id, want] of [['b737300', 'classic'], ['b737400', 'classic'], ['b737500', 'classic'],
                            ['b737700', 'next-generation'], ['b737900er', 'next-generation']]) {
    const d = (get(id).description || '').toLowerCase();
    const other = want === 'classic' ? 'next-generation' : 'classic';
    if (d.includes(other)) wrong.push(`${get(id).name} calls itself ${other}`);
  }
  assert.deepEqual(wrong, []);
});

section('2. A used delivery bills more than base from its first week');

test('the 737-400 arrives 10y old and therefore bills 1.5x base', () => {
  const t = get('b737400');
  assert.equal(t.deliveredAgeWeeks, 520);
  assert.equal(maintenanceMultiplier(520), 1.5);
  assert.ok(deliveredMaint(t) > t.baseMaintenancePerWk);
});

test('every out-of-production passenger type bills above its base on delivery', () => {
  const flat = AIRCRAFT_TYPES
    .filter(t => !t.freighter && (t.deliveredAgeWeeks ?? 0) > 0)
    .filter(t => deliveredMaint(t) <= t.baseMaintenancePerWk)
    .map(t => t.name);
  assert.deepEqual(flat, []);
});

// ── 3. The screen ────────────────────────────────────────────────────────────
section('3. The card the player actually reads');

store.set('market_layout', 'cards');
const cards = renderToString(React.createElement(GameProvider, null, React.createElement(Marketplace)));

test('the 737-400 card quotes maintenance as delivered, not factory-fresh', () => {
  const card = cardFor(cards, 'Boeing 737-400');
  const t = get('b737400');
  assert.ok(card.includes(formatMoney(deliveredMaint(t))),
    `the card must quote ${formatMoney(deliveredMaint(t))}/wk — what a fresh delivery bills`);
  assert.ok(!card.includes(`>${formatMoney(t.baseMaintenancePerWk)}<`),
    `the card still prints the factory-fresh ${formatMoney(t.baseMaintenancePerWk)}, `
    + 'which no player will ever be charged for this type');
});

test('the card says out loud how old the airframe arrives', () => {
  const card = cardFor(cards, 'Boeing 737-400');
  assert.ok(/out of production/i.test(card), 'no out-of-production notice');
  assert.ok(/10 years old/.test(card), 'the delivered age is not stated in years');
});

test('an in-production type carries no used-airframe notice', () => {
  const card = cardFor(cards, 'Boeing 737 MAX 8');
  assert.equal(get('b737max8').deliveredAgeWeeks ?? 0, 0);
  assert.ok(!/out of production/i.test(card),
    'a factory-fresh MAX 8 is being sold to the player as used metal');
});

test('the two aircraft the report compared now disclose their age gap', () => {
  assert.ok(/10 years old/.test(cardFor(cards, 'Boeing 737-400')));
  assert.ok(/6 years old/.test(cardFor(cards, 'Boeing 737-700')));
});

section('4. The comparison table agrees with the cards');

store.set('market_layout', 'table');
const table = renderToString(React.createElement(GameProvider, null, React.createElement(Marketplace)));

test('the table has an age column and fills it in', () => {
  assert.ok(table.includes('>Age<') || />Age(<|\s)/.test(table), 'no Age column header');
  assert.ok(table.includes('10y used'), 'the 737-400 row does not report its delivered age');
  assert.ok(table.includes('new'), 'in-production types are not marked new');
});

test('the table quotes the same delivered maintenance the card does', () => {
  const t = get('b737400');
  assert.ok(table.includes(formatMoney(deliveredMaint(t))),
    'the table and the card disagree about what this aircraft costs to maintain');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
