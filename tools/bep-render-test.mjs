// Kat's screenshot, rendered.
//
// 2026-08-11: ten rows of Finance ▸ Unit Economics, every one grade A with RASK
// above CASK, every one badged "✗ Below BEP" at break-even load factors of
// 130–412%. This suite builds that fleet — a cheap economy cabin filling the
// aeroplane with the front cabins priced where they belong — renders the REAL
// component through SSR, and reads the badge, the spread and the BEP straight
// out of the HTML. No row may claim a positive spread and a below-break-even
// status at the same time.
//
// The arithmetic itself is guarded by tools/bep-consistency-test.mjs; this is
// the screen.
//
//   node --import ./tools/_register-loader.mjs tools/bep-render-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAirport } from '../src/data/airports.js';

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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Finance = (await import('../src/components/Finance.jsx')).default;

console.log('\nFinance ▸ Unit Economics: the BEP badge agrees with the spread\n');

// ── Fixture: Kat's fleet ──────────────────────────────────────────────────────
// DXB hub. Widebodies with a real premium cabin, economy sold cheap to fill the
// aeroplane, front cabins priced properly. `route.ticketPrice` is the economy
// fare — which is exactly what the old break-even formula priced all 853 A380
// seats off, hence 412%.
const HUB = 'DXB';
const SPECS = [
  { dest: 'LHR', typeId: 'a380',      freq: 8, config: { firstClass: 14, businessClass: 76, premiumEconomy: 60, economy: 577 } },
  { dest: 'SIN', typeId: 'b777300er', freq: 6, config: { firstClass: 8,  businessClass: 42, premiumEconomy: 32, economy: 380 } },
  { dest: 'AMS', typeId: 'b747400',   freq: 7, config: { firstClass: 12, businessClass: 60, premiumEconomy: 40, economy: 420 } },
];
const PRICES = { economy: 60, premiumEconomy: 900, businessClass: 2600, firstClass: 6000 };

assert.ok(getAirport(HUB), 'hub exists');
for (const s of SPECS) assert.ok(getAirport(s.dest), `${s.dest} exists`);

const routes = SPECS.map((s, i) => ({
  id: `r${i}`, origin: HUB, destination: s.dest, aircraftId: `ac${i}`,
  weeklyFrequency: s.freq, weeksOpen: 60, hub: HUB,
  ticketPrice: PRICES.economy, classPrices: { ...PRICES },
  cateringLevel: 'full',
}));

const fleet = SPECS.map((s, i) => ({
  id: `ac${i}`, typeId: s.typeId, name: `Test ${i}`, tailNumber: `N${i}KAT`,
  status: 'assigned', ageWeeks: 60, ownershipType: 'owned',
  config: { ...s.config, seatQuality: 'standard', serviceQuality: 'standard' },
}));

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: HUB, cash: 200_000_000,
  scheduleTrimVersion: 1,
  gates: { [HUB]: 20, ...Object.fromEntries(SPECS.map(s => [s.dest, 10])) },
  fleet, routes,
};
store.set('bbae_save_v2', JSON.stringify(save));

const html = renderToString(
  React.createElement(GameProvider, null,
    React.createElement(Finance, { initialView: 'uniteco' })),
).replaceAll('<!-- -->', '');

/** One entry per rendered data row: the pair, its spread, BEP text and badge. */
function rows() {
  const out = [];
  for (const row of html.split('<tr').slice(1)) {
    const pair = row.match(/<strong>([A-Z]{3})→([A-Z]{3})<\/strong>/);
    if (!pair) continue;
    const spread = row.match(/>([+-])\$(\d+\.\d+)</);
    const bep    = row.match(/>(never|—|\d+\.\d+%)<\/td>/);
    const above  = /Above BEP/.test(row);
    const below  = /Below BEP/.test(row);
    out.push({
      pair: `${pair[1]}→${pair[2]}`,
      spread: spread ? Number(`${spread[1] === '-' ? '-' : ''}${spread[2]}`) : null,
      bep: bep?.[1] ?? null,
      above, below,
    });
  }
  return out;
}

const shown = rows();

test('the Unit Economics table rendered every fixture route', () => {
  assert.ok(html.includes('Break-even Load Factor'), 'BEP legend rendered');
  assert.equal(shown.length, SPECS.length,
    `expected ${SPECS.length} rows, parsed ${shown.length}`);
});

test('the fixture is the screenshot: profitable premium-cabin widebodies', () => {
  for (const r of shown) {
    assert.ok(r.spread != null, `${r.pair}: no spread cell parsed`);
    assert.ok(r.spread > 0, `${r.pair}: fixture should be profitable, spread $${r.spread}`);
  }
});

test('no row shows a positive spread and "Below BEP"', () => {
  const bad = shown.filter(r => r.spread > 0 && r.below);
  assert.equal(bad.length, 0,
    bad.map(r => `${r.pair}: spread +$${r.spread} but BEP ${r.bep} → Below BEP`).join('; '));
});

test('every row carries exactly one status badge, and it matches the spread', () => {
  for (const r of shown) {
    assert.ok(r.above !== r.below, `${r.pair}: badge is ${r.above && r.below ? 'both' : 'neither'}`);
    assert.equal(r.above, r.spread >= 0, `${r.pair}: badge disagrees with spread $${r.spread}`);
  }
});

test('break-even prints as a load factor a player can act on', () => {
  for (const r of shown) {
    assert.ok(r.bep, `${r.pair}: no BEP cell`);
    assert.ok(!/Infinity|NaN/.test(r.bep), `${r.pair}: BEP printed "${r.bep}"`);
    if (r.bep !== 'never' && r.bep !== '—') {
      const pct = Number(r.bep.replace('%', ''));
      assert.ok(pct > 0 && pct < 100,
        `${r.pair}: a profitable route cannot break even at ${r.bep}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
