// Every departures control is − / typed number / +, like seat allocation
// (Barca, Discord 2026-10-16: "Could the +- for no. of departures be made like
// it is for seat allocation when buying a plane?").
//
// Two halves. The stepper's decision (clamp, round, run the engine's guard,
// settle a blocked typed jump on the highest value the guard allows) is pure
// and tested directly. Then the REAL screens are server-rendered to prove each
// one carries a typeable box wired to the engine's numbers — the route list's
// blocked + must quote frequencyChangeBlockReason word for word.
//
//   node --import ./tools/_register-loader.mjs tools/number-stepper-ui-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { routeSegments, routeSegmentKey, referencePrice } from '../src/utils/simulation.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
let phone = false;
globalThis.window.matchMedia = () => ({ matches: phone, addListener() {}, removeListener() {} });
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

const { resolveStep, highestAllowed } = await import('../src/components/NumberStepper.jsx');
const { GameProvider, freshState, frequencyChangeBlockReason } = await import('../src/store/GameContext.jsx');
const Routes           = (await import('../src/components/Routes.jsx')).default;
const CargoRoutesList  = (await import('../src/components/CargoRoutesList.jsx')).default;
const AircraftCheckout = (await import('../src/components/AircraftCheckout.jsx')).default;

const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
const unesc = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// The <input> whose aria-label is `label`, as an attribute map.
function inputFor(html, label) {
  for (const tag of html.match(/<input[^>]*>/g) ?? []) {
    if (unesc(tag).includes(`aria-label="${label}"`)) {
      return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], unesc(m[2])]));
    }
  }
  return null;
}
function buttonFor(html, label) {
  for (const tag of html.match(/<button[^>]*>/g) ?? []) {
    if (unesc(tag).includes(`aria-label="${label}"`)) {
      return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], unesc(m[2] ?? '')]));
    }
  }
  return null;
}

console.log('\n── 1. The stepper’s decision ─────────────────────────────');

test('a typed value is clamped to the bounds and rounded', () => {
  assert.equal(resolveStep(5, 40, { min: 1, max: 14 }).next, 14);
  assert.equal(resolveStep(5, -3, { min: 1, max: 14 }).next, 1);
  assert.equal(resolveStep(5, 7.6, { min: 1, max: 14 }).next, 8);
  assert.equal(resolveStep(0.95, 1.23456, { min: 0.01, step: 0.02, decimals: 3 }).next, 1.235);
});

test('re-typing the current value, or garbage, changes nothing', () => {
  assert.equal(resolveStep(5, 5, { min: 1, max: 14 }).next, null);
  assert.equal(resolveStep(5, NaN, { min: 1, max: 14 }).next, null);
});

test('a typed value off the step grid is kept (typing is the point of the box)', () => {
  assert.equal(resolveStep(0.95, 0.987, { min: 0.01, step: 0.02, decimals: 3 }).next, 0.987);
});

test('a blocked jump settles on the highest value the guard allows, and says why', () => {
  const guard = (n) => (n > 9 ? 'Not enough block hours' : null);
  const r = resolveStep(3, 14, { min: 1, max: 99, blockReason: guard });
  assert.deepEqual(r, { next: 9, blocked: 14, why: 'Not enough block hours' });
});

test('blocked at the very next step: nothing is applied, the reason still comes back', () => {
  const guard = (n) => (n > 9 ? 'Gate slots full at JFK' : null);
  assert.deepEqual(resolveStep(9, 12, { min: 1, max: 99, blockReason: guard }),
    { next: null, blocked: 12, why: 'Gate slots full at JFK' });
});

test('decreases never consult the guard (the engine always allows them)', () => {
  let calls = 0;
  const r = resolveStep(9, 2, { min: 1, max: 99, blockReason: () => { calls++; return 'nope'; } });
  assert.equal(r.next, 2);
  assert.equal(calls, 0);
});

test('a huge typed number costs a handful of guard calls, not one per flight', () => {
  let calls = 0;
  const best = highestAllowed(1, 9999, 1, (n) => { calls++; return n > 37 ? 'x' : null; });
  assert.equal(best, 37);
  assert.ok(calls <= 16, `${calls} guard calls`);
});

console.log('\n── 2. The route list: typeable, and the + quotes the engine ──');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const [P, Q, R] = ['JFK', 'ORD', 'LAX'];
for (const c of [P, Q, R]) assert.ok(getAirport(c), `${c} missing from the airport data`);
const sp = {};
for (const g of routeSegments({ stops: [P, Q, R], origin: P, destination: R })) {
  const e = Math.round(referencePrice(g.from, g.to));
  sp[routeSegmentKey(g.from, g.to)] = { economy: e, businessClass: Math.round(e * 2.5) };
}
const tail = (id, extra = {}) => ({
  id, typeId: jet.id, name: `Tail ${id}`, tailNumber: `N${id}`, status: 'assigned',
  ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats }, ...extra,
});
function seedRotation(freq) {
  const save = {
    ...freshState(),
    phase: 'playing', week: 20, year: 1, hub: P, cash: 500_000_000,
    gates: { [P]: 8, [Q]: 8, [R]: 8 },
    fleet: [tail('ac1')],
    routes: [{ id: 'tg', origin: P, destination: R, stops: [P, Q, R], aircraftId: 'ac1',
      weeklyFrequency: freq, weeksOpen: 20, hub: P, segmentPrices: sp, cateringLevel: 'full' }],
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}
const LABEL = `flights per week, ${P} to ${R}`;

test('the frequency is an input holding the route’s frequency, with − and +', () => {
  seedRotation(5);
  const html = render(React.createElement(Routes));
  const box = inputFor(html, LABEL);
  assert.ok(box, 'no typeable frequency box on the route — still a read-only number between − and +');
  assert.equal(box.value, '5');
  assert.equal(box.inputmode ?? box.inputMode, 'numeric');
  assert.ok(buttonFor(html, `Decrease ${LABEL}`), 'no − button');
  const up = buttonFor(html, `Increase ${LABEL}`);
  assert.ok(up, 'no + button');
  assert.equal(up.title, 'One more flight per week');
});

test('at the ceiling, the + is marked blocked and its title is the engine’s own sentence', () => {
  const s1 = seedRotation(1);
  const ceiling = highestAllowed(1, 99, 1, (n) => frequencyChangeBlockReason(s1, 'tg', n));
  assert.ok(ceiling >= 1 && ceiling < 99, `no ceiling found (${ceiling})`);
  const s = seedRotation(ceiling);
  const why = frequencyChangeBlockReason(s, 'tg', ceiling + 1);
  assert.ok(why, 'engine should refuse one more flight at the ceiling');
  const html = render(React.createElement(Routes));
  const up = buttonFor(html, `Increase ${LABEL}`);
  assert.ok(up, 'no + button');
  assert.match(up.class ?? '', /is-blocked/, '+ not marked blocked');
  assert.equal(up.title, why, 'the + must explain itself with the engine’s reason');
  assert.ok(!('disabled' in up), 'a blocked + stays clickable so it can explain itself');
  assert.equal(inputFor(html, LABEL).value, String(ceiling));
});

console.log('\n── 3. Freight, the checkout, and every planner ───────────');

test('a freighter’s flights/wk and yield are typeable boxes', () => {
  const freighter = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => b.range - a.range)[0];
  const [A, B] = ['NRT', 'SZX'];
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(),
    phase: 'playing', week: 20, year: 1, hub: A, cash: 500_000_000,
    gates: { [A]: 20, [B]: 20 },
    fleet: [{ id: 'f1', typeId: freighter.id, name: 'Heavy', tailNumber: 'NF1', status: 'assigned', ageWeeks: 52, ownershipType: 'owned' }],
    routes: [],
    cargoRoutes: [{ id: 'c1', origin: A, destination: B, aircraftId: 'f1', weeklyFrequency: 4, yieldPrice: 0.95, weeksOpen: 20 }],
  }));
  phone = true;
  const html = render(React.createElement(CargoRoutesList, { onAddFreighter: () => {} }));
  phone = false;
  assert.equal(inputFor(html, `flights per week, ${A} to ${B}`)?.value, '4');
  assert.equal(inputFor(html, `yield, ${A} to ${B}`)?.value, '0.950');
});

test('the aircraft checkout quantity is typeable too', () => {
  seedRotation(5);
  const html = render(React.createElement(AircraftCheckout, { typeId: jet.id, mode: 'buy', onClose: () => {} }));
  assert.equal(inputFor(html, 'aircraft quantity')?.value, '1');
});

test('every frequency slider in the planners has a stepper beside it', () => {
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsx'));
  const sliders = files.filter(f => /type="range"[^<]{0,300}?setFrequency\(/.test(fs.readFileSync(dir + f, 'utf8').replace(/\n\s*/g, ' ')));
  assert.ok(sliders.length >= 3, `expected the passenger, freight and multi-stop planners, found ${sliders}`);
  for (const f of sliders) {
    const src = fs.readFileSync(dir + f, 'utf8');
    assert.ok(/<NumberStepper[\s\S]{0,200}onChange=\{setFrequency\}/.test(src), `${f}: frequency slider with no typeable stepper`);
  }
});

test('no departures control is left as a bare number box or a − / read-out / + trio', () => {
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsx'))) {
    const src = fs.readFileSync(dir + f, 'utf8');
    assert.ok(!/type="number"[^<]{0,200}?value=\{[\w.]*[fF]requency\}/.test(src.replace(/\n\s*/g, ' ')), `${f}: bare number box for frequency`);
    assert.ok(!/adjFreq\(/.test(src), `${f}: −/+ frequency buttons around a read-out`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
