// Cabin floor plan: the refit modal draws the cabin inside the aircraft, and
// the picture must agree with the numbers. Every configured seat is drawn
// exactly once, each cabin's length is its share of the floor (in the engine's
// own floor units, CLASS_SPACE_MULTIPLIERS), and every type in the catalogue
// has a planform — a new type without a line in utils/planform.js fails here.
//
//   node --import ./tools/_register-loader.mjs tools/cabin-floor-plan-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { CLASS_SPACE_MULTIPLIERS, defaultConfig } from '../src/utils/simulation.js';
import { freshState } from '../packages/engine/src/reducer.mjs';
import { PLANFORMS, planformFor, planformGeometry, cabinLayout, CABIN_CLASSES, seatGroups, classAbreast } from '../src/utils/planform.js';

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

const PAX = AIRCRAFT_TYPES.filter(t => (t.seats ?? 0) > 0);

// A spread of configurations every type must draw honestly.
function configsFor(t) {
  const s = t.seats;
  const units = (c) => c.firstClass * 2 + c.businessClass * 1.5 + c.premiumEconomy * 1.25 + c.economy;
  const out = [
    { firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: s },
    { ...defaultConfig(s), firstClass: defaultConfig(s).firstClass ?? 0, businessClass: defaultConfig(s).businessClass ?? 0, premiumEconomy: defaultConfig(s).premiumEconomy ?? 0 },
    { firstClass: Math.floor(s / 2), businessClass: 0, premiumEconomy: 0, economy: 0 },
    { firstClass: 0, businessClass: Math.floor(s / 1.5), premiumEconomy: 0, economy: 0 },
    { firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: Math.floor(s * 0.6) },
  ];
  const f = Math.floor(s * 0.03), j = Math.floor(s * 0.12), w = Math.floor(s * 0.1);
  out.push({ firstClass: f, businessClass: j, premiumEconomy: w, economy: Math.max(0, Math.floor(s - f * 2 - j * 1.5 - w * 1.25)) });
  return out.filter(c => units(c) <= s + 1e-9);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Every type has a planform ─────────────────────────────');

test('the engine and the floor plan price floor space the same way', () => {
  for (const c of CABIN_CLASSES) assert.equal(c.space, CLASS_SPACE_MULTIPLIERS[c.key], c.key);
});

test('every passenger type has its own line in PLANFORMS', () => {
  const missing = PAX.filter(t => !PLANFORMS[t.id]).map(t => t.id);
  assert.deepEqual(missing, [], `add these to src/utils/planform.js: ${missing.join(', ')}`);
});

test('every freighter resolves to a known airframe', () => {
  const unknown = AIRCRAFT_TYPES.filter(t => t.category === 'Freighter' && !planformFor(t).known).map(t => t.id);
  assert.deepEqual(unknown, []);
});

test('an unknown type still draws, from its category', () => {
  const g = planformGeometry(planformFor({ id: 'not-a-plane', category: 'Regional Jet', seats: 76 }));
  assert.ok(g.fuselage.startsWith('M') && g.wing.startsWith('M'));
  assert.ok(Number.isFinite(g.extent.halfH) && g.extent.halfH > 0);
});

test('geometry is finite and the cabin sits inside the fuselage', () => {
  for (const t of AIRCRAFT_TYPES) {
    const spec = planformFor(t);
    const g = planformGeometry(spec);
    for (const v of [g.extent.xMin, g.extent.xMax, g.extent.halfH]) assert.ok(Number.isFinite(v), `${t.id} extent`);
    assert.ok(!/NaN|Infinity/.test(g.fuselage + g.wing + (g.stab ?? '') + g.fin), `${t.id} path has NaN`);
    assert.ok(g.extent.halfH >= spec.S / 2, `${t.id} wingtips clipped`);
    for (const d of g.decks) {
      assert.ok(d.x0 > 0 && d.x1 < spec.L && d.x1 > d.x0, `${t.id} ${d.id} deck outside the fuselage`);
      assert.ok(d.width > 0 && d.width < spec.D, `${t.id} ${d.id} deck wider than the fuselage`);
    }
  }
});

test('seat groups add up to the seats across', () => {
  for (let n = 1; n <= 10; n++) for (const twin of [false, true]) {
    if (twin && n < 3) continue;
    assert.equal(seatGroups(n, twin).reduce((s, g) => s + g, 0), n, `${n} ${twin}`);
  }
  assert.deepEqual(seatGroups(9, true), [3, 3, 3]);
  assert.deepEqual(seatGroups(6, false), [3, 3]);
  assert.equal(classAbreast(1.5, 9), 6, 'business on a 9-abreast cabin is 6 across (each seat 1.5 economy widths)');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── The plan agrees with the config ───────────────────────');

test('every configured seat is drawn exactly once, for every type', () => {
  for (const t of PAX) {
    const g = planformGeometry(planformFor(t));
    for (const cfg of configsFor(t)) {
      const lay = cabinLayout(cfg, t.seats, g);
      for (const c of CABIN_CLASSES) {
        const drawn = lay.seats.filter(s => s.cls === c.key).length;
        assert.equal(drawn, cfg[c.key] ?? 0, `${t.id} ${c.key}: drew ${drawn} of ${cfg[c.key]} (${JSON.stringify(cfg)})`);
      }
    }
  }
});

test('cabin length is proportional to floor units on a single deck', () => {
  for (const t of PAX) {
    const g = planformGeometry(planformFor(t));
    if (g.decks.length !== 1) continue;
    for (const cfg of configsFor(t)) {
      const lay = cabinLayout(cfg, t.seats, g);
      const rates = lay.zones.map(z => (z.x1 - z.x0) / z.units);
      for (const r of rates) assert.ok(Math.abs(r - rates[0]) < 1e-6, `${t.id}: zone lengths not ∝ units`);
      const total = lay.zones.reduce((s, z) => s + z.units, 0);
      assert.ok(Math.abs(total - t.seats) < 0.51 || lay.zones.every(z => z.cls !== 'empty'), `${t.id}: floor not accounted for`);
    }
  }
});

test('unused floor is drawn as empty, in proportion', () => {
  const t = getAircraftType('a320neo');
  const g = planformGeometry(planformFor(t));
  const lay = cabinLayout({ economy: Math.floor(t.seats * 0.75) }, t.seats, g);
  const empty = lay.zones.find(z => z.cls === 'empty');
  const y = lay.zones.find(z => z.cls === 'economy');
  assert.ok(empty, 'no empty zone');
  assert.ok(Math.abs((empty.x1 - empty.x0) / (y.x1 - y.x0) - (t.seats - y.units) / y.units) < 1e-6);
});

test('seats stay inside their cabin and inside the deck', () => {
  for (const t of PAX) {
    const g = planformGeometry(planformFor(t));
    const cfg = configsFor(t).at(-1);
    const lay = cabinLayout(cfg, t.seats, g);
    for (const s of lay.seats) {
      const d = lay.decks.find(x => x.id === s.deck);
      assert.ok(s.x >= d.ux0 - 1e-6 && s.x + s.w <= d.ux1 + 1e-6, `${t.id} seat runs past the cabin`);
      assert.ok(s.y >= -d.width / 2 - 1e-6 && s.y + s.h <= d.width / 2 + 1e-6, `${t.id} seat outside the deck`);
    }
  }
});

test('double-deckers put the front cabins upstairs', () => {
  for (const id of ['a380', 'b747400']) {
    const t = getAircraftType(id);
    const g = planformGeometry(planformFor(t));
    assert.ok(g.decks.some(d => d.id === 'upper'), `${id} has no upper deck`);
    const lay = cabinLayout({ firstClass: 12, businessClass: 40, premiumEconomy: 30, economy: 300 }, t.seats, g);
    assert.ok(lay.seats.some(s => s.deck === 'upper' && s.cls === 'firstClass'), `${id}: first not upstairs`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── The refit modal draws it (SSR of the real component) ──');

const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');
const FleetConfig = (await import('../src/components/FleetConfig.jsx')).default;
const { shade } = await import('../src/components/CabinFloorPlan.jsx');

function renderModal(typeId, config) {
  const t = getAircraftType(typeId);
  const state = {
    ...freshState(), phase: 'playing', week: 10, year: 2, hub: 'JFK', cash: 500_000_000,
    fleet: [{ id: 'p1', typeId, name: 'Plan One', tailNumber: 'N1', status: 'idle', ageWeeks: 10, ownershipType: 'owned', config: config ?? defaultConfig(t.seats) }],
  };
  return renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {} },
    React.createElement(FleetConfig, { aircraftId: 'p1', onClose() {} }))).replace(/<!-- -->/g, '');
}
const seatsIn = (html, cls) => Number((html.match(new RegExp(`data-cabin="${cls}" data-seats="(\\d+)"`)) ?? [])[1] ?? 0);

test('the modal draws the aircraft it is refitting', () => {
  for (const id of ['b7879', 'a320neo', 'atr72', 'crj900', 'a380', 'dc3']) {
    const html = renderModal(id);
    assert.match(html, new RegExp(`data-plane="${id}"`), `${id}: no floor plan in the modal`);
  }
});

test('the modal draws the current cabin, seat for seat', () => {
  const cfg = { firstClass: 8, businessClass: 42, premiumEconomy: 28, economy: 220, seatQuality: 'basic', serviceQuality: 'standard' };
  const html = renderModal('b7879', cfg);
  assert.equal(seatsIn(html, 'firstClass'), 8);
  assert.equal(seatsIn(html, 'businessClass'), 42);
  assert.equal(seatsIn(html, 'premiumEconomy'), 28);
  assert.equal(seatsIn(html, 'economy'), 220);
  assert.match(html, /data-cabin="empty"/, '787-9 at 298 seats of 420 has open floor to show');
});

test('the plan carries the airline livery', () => {
  const t = getAircraftType('a320neo');
  const state = {
    ...freshState(), phase: 'playing', cash: 1e9, livery: { fuselage: '#123456', tail: '#abcdef', engines: '#fedcba' },
    fleet: [{ id: 'p1', typeId: 'a320neo', name: 'L', status: 'idle', ageWeeks: 1, ownershipType: 'owned', config: defaultConfig(t.seats) }],
  };
  const html = renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {} },
    React.createElement(FleetConfig, { aircraftId: 'p1', onClose() {} })));
  // The fuselage is a cylinder gradient built from the skin colour: its crown
  // stop is the skin lightened by 8% (CabinFloorPlan.shade), the fin is flat.
  assert.match(html, new RegExp(`stop-color="${shade('#123456', 1.08)}"`, 'i'), 'fuselage gradient not built from the livery skin');
  assert.match(html, /fill="#abcdef"/i, 'fin not in livery');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
