// Painting the cabin on the floor plan. A stroke converts the floor under it
// to the brush class; the cabin is re-sorted First → Business → Prem Eco →
// Economy → empty and rounded to whole seats, never past the floor. Dragging a
// divider is a stroke that paints the vacated side with the neighbour's class.
//
//   node --import ./tools/_register-loader.mjs tools/cabin-painter-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { CLASS_SPACE_MULTIPLIERS, defaultConfig } from '../src/utils/simulation.js';
import { freshState } from '../packages/engine/src/reducer.mjs';
import { planformFor, planformGeometry, cabinLayout, paintStroke, unitsToConfig, dividers, dragDivider, CABIN_CLASSES } from '../src/utils/planform.js';

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

const units = (cfg) => CABIN_CLASSES.reduce((s, c) => s + (cfg[c.key] ?? 0) * c.space, 0);
const lay = (type, cfg) => cabinLayout(cfg, type.seats, planformGeometry(planformFor(type)));

const B789 = getAircraftType('b7879');
const BASE = { firstClass: 8, businessClass: 42, premiumEconomy: 28, economy: 220 };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Strokes ───────────────────────────────────────────────');

test('floor units are the engine\'s', () => {
  for (const c of CABIN_CLASSES) assert.equal(c.space, CLASS_SPACE_MULTIPLIERS[c.key]);
});

test('painting economy floor with business converts it at 1.5 units a seat', () => {
  const L = lay(B789, BASE);
  const d = L.decks[0], y = L.zones.find(z => z.cls === 'economy');
  const by = paintStroke(L, 'main', y.x0, y.x0 + d.perUnit * 30, 'businessClass');
  const cfg = unitsToConfig(by, B789.seats, 'businessClass');
  assert.deepEqual(cfg, { ...BASE, businessClass: 62, economy: 190 });
});

test('the empty brush frees floor; the economy brush fills it back', () => {
  const L = lay(B789, BASE);
  const d = L.decks[0], y = L.zones.find(z => z.cls === 'economy');
  const freed = unitsToConfig(paintStroke(L, 'main', y.x1 - d.perUnit * 40, y.x1, 'empty'), B789.seats, 'empty');
  assert.deepEqual(freed, { ...BASE, economy: 180 });
  const L2 = lay(B789, freed);
  const e = L2.zones.find(z => z.cls === 'empty');
  const filled = unitsToConfig(paintStroke(L2, 'main', e.x0, e.x1, 'economy'), B789.seats, 'economy');
  assert.equal(filled.economy, 180 + Math.round(e.units), 'the whole empty tail should fill with economy');
  assert.ok(units(filled) <= B789.seats + 1e-9);
});

test('a stroke that covers the whole cabin makes it all one class', () => {
  const L = lay(B789, BASE);
  const d = L.decks[0];
  const cfg = unitsToConfig(paintStroke(L, 'main', d.ux0 - 5, d.ux1 + 5, 'firstClass'), B789.seats, 'firstClass');
  assert.deepEqual(cfg, { firstClass: Math.floor(B789.seats / 2), businessClass: 0, premiumEconomy: 0, economy: 0 });
});

test('a stroke outside the cabin changes nothing', () => {
  const L = lay(B789, BASE);
  const cfg = unitsToConfig(paintStroke(L, 'main', -10, -5, 'firstClass'), B789.seats, 'firstClass');
  assert.deepEqual(cfg, BASE);
});

test('a repeated stroke converges: the block ends at the stroke\'s far edge, then nothing changes', () => {
  // Cabins keep their order, so a block grows at its own boundary, not under
  // the cursor. A stroke that starts 2 m into economy with the prem-eco brush
  // adds that floor to the prem-eco block, which now ends short of the
  // stroke; a second pass converts the gap; a third pass is a no-op.
  const L = lay(B789, BASE);
  const y = L.zones.find(z => z.cls === 'economy');
  const a = y.x0 + 2, b = y.x0 + 9;
  const once = unitsToConfig(paintStroke(L, 'main', a, b, 'premiumEconomy'), B789.seats, 'premiumEconomy');
  const L2 = lay(B789, once);
  const twice = unitsToConfig(paintStroke(L2, 'main', a, b, 'premiumEconomy'), B789.seats, 'premiumEconomy');
  assert.ok(twice.premiumEconomy > once.premiumEconomy, 'second pass takes the gap');
  const L3 = lay(B789, twice);
  const w = L3.zones.find(z => z.cls === 'premiumEconomy');
  assert.ok(Math.abs(w.x1 - b) < L3.decks[0].perUnit * 1.5, 'prem eco now ends at the stroke\'s far edge');
  const thrice = unitsToConfig(paintStroke(L3, 'main', a, b, 'premiumEconomy'), B789.seats, 'premiumEconomy');
  assert.deepEqual(thrice, twice);
});

test('no stroke on any type ever exceeds the floor (fuzz)', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const types = AIRCRAFT_TYPES.filter(t => t.seats > 0);
  for (const t of types) {
    let cfg = defaultConfig(t.seats);
    const geom = planformGeometry(planformFor(t));
    for (let i = 0; i < 12; i++) {
      const L = cabinLayout(cfg, t.seats, geom);
      const deck = L.decks[Math.floor(rnd() * L.decks.length)];
      const a = deck.ux0 + rnd() * (deck.ux1 - deck.ux0), b = deck.ux0 + rnd() * (deck.ux1 - deck.ux0);
      const brush = ['firstClass', 'businessClass', 'premiumEconomy', 'economy', 'empty'][Math.floor(rnd() * 5)];
      cfg = unitsToConfig(paintStroke(L, deck.id, a, b, brush), t.seats, brush);
      assert.ok(units(cfg) <= t.seats + 1e-9, `${t.id}: ${JSON.stringify(cfg)} over ${t.seats}`);
      for (const c of CABIN_CLASSES) assert.ok(Number.isInteger(cfg[c.key]) && cfg[c.key] >= 0, `${t.id} ${c.key}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Dividers ──────────────────────────────────────────────');

test('one divider per boundary, in cabin order', () => {
  const L = lay(B789, BASE);
  const ds = dividers(L, 'main');
  assert.deepEqual(ds.map(d => `${d.left.cls}|${d.right.cls}`),
    ['firstClass|businessClass', 'businessClass|premiumEconomy', 'premiumEconomy|economy', 'economy|empty']);
});

test('dragging the business/prem-eco divider back moves floor from business to prem eco', () => {
  const L = lay(B789, BASE);
  const div = dividers(L, 'main').find(d => d.left.cls === 'businessClass');
  const d = L.decks[0];
  const cfg = unitsToConfig(dragDivider(L, 'main', div, div.x + d.perUnit * 15), B789.seats, 'businessClass');
  assert.equal(cfg.businessClass, 52);
  assert.equal(cfg.premiumEconomy, 16);
  assert.equal(cfg.economy, 220);
});

test('a divider cannot be dragged past its neighbours', () => {
  const L = lay(B789, BASE);
  const div = dividers(L, 'main').find(d => d.left.cls === 'firstClass');
  const cfg = unitsToConfig(dragDivider(L, 'main', div, 1000), B789.seats, 'firstClass');
  assert.equal(cfg.businessClass, 0, 'business is used up');
  assert.equal(cfg.premiumEconomy, 28, 'prem eco untouched');
  assert.equal(cfg.economy, 220, 'economy untouched');
});

test('a zero-seat class has no divider, so it cannot be dragged into existence by accident', () => {
  const L = lay(B789, { ...BASE, firstClass: 0 });
  assert.ok(!dividers(L, 'main').some(d => d.left.cls === 'firstClass' || d.right.cls === 'firstClass'));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── The refit modal paints (SSR of the real component) ────');

const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');
const FleetConfig = (await import('../src/components/FleetConfig.jsx')).default;
const CFP = await import('../src/components/CabinFloorPlan.jsx');

function renderModal(typeId, config) {
  const t = getAircraftType(typeId);
  const state = {
    ...freshState(), phase: 'playing', week: 10, year: 2, hub: 'JFK', cash: 500_000_000,
    fleet: [{ id: 'p1', typeId, name: 'Plan One', tailNumber: 'N1', status: 'idle', ageWeeks: 10, ownershipType: 'owned', config: config ?? defaultConfig(t.seats) }],
  };
  return renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {} },
    React.createElement(FleetConfig, { aircraftId: 'p1', onClose() {} }))).replace(/<!-- -->/g, '');
}

test('the modal offers the five brushes, business selected', () => {
  const html = renderModal('b7879', BASE);
  for (const k of ['firstClass', 'businessClass', 'premiumEconomy', 'economy', 'empty']) {
    assert.match(html, new RegExp(`data-brush="${k}"`), `no ${k} brush`);
  }
  assert.match(html, /data-brush="businessClass"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-brush="businessClass"/, 'business is not the default brush');
});

test('the plan is editable, with a divider at every cabin boundary', () => {
  const html = renderModal('b7879', BASE);
  assert.match(html, /data-editable="true"/);
  assert.match(html, /data-paint-layer="main"/);
  for (const b of ['firstClass|businessClass', 'businessClass|premiumEconomy', 'premiumEconomy|economy', 'economy|empty']) {
    assert.match(html, new RegExp(`data-divider="${b.replace('|', '\\|')}"`), `no divider ${b}`);
  }
});

test('a double-decker paints on both decks', () => {
  const html = renderModal('a380', { firstClass: 14, businessClass: 76, premiumEconomy: 60, economy: 400 });
  assert.match(html, /data-paint-layer="main"/);
  assert.match(html, /data-paint-layer="upper"/);
});

test('vertical orientation swaps the viewBox and keeps every seat', () => {
  const CabinFloorPlan = CFP.default;
  const t = getAircraftType('a320neo');
  const h = renderToString(React.createElement(CabinFloorPlan, { type: t, config: { economy: 150 }, orientation: 'horizontal' }));
  const v = renderToString(React.createElement(CabinFloorPlan, { type: t, config: { economy: 150 }, orientation: 'vertical' }));
  const vb = (s) => s.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  const [, , hw, hh] = vb(h), [, , vw, vh] = vb(v);
  assert.ok(Math.abs(hw - vh) < 1e-6 && Math.abs(hh - vw) < 1e-6, 'vertical viewBox is the horizontal one with axes swapped');
  assert.match(v, /data-cabin="economy" data-seats="150"/);
  assert.match(v, /data-orientation="vertical"/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
