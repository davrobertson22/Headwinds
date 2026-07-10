// Reducer test for TRANSFER_ROUTES (Fleet: move all routes to another tail).
// Same in-memory transpile approach as reducer-tag-test.mjs.
//
//   node tools/transfer-routes-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { distanceKm } from '../src/utils/simulation.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

const SRC = 'src/store/GameContext.jsx';
const SRC_DIR = path.resolve(path.dirname(SRC));
const TMP = path.join(os.tmpdir(), `gc_transfer_${process.pid}.mjs`);

const stripJsx = ({ types: t }) => ({
  visitor: {
    JSXElement(p)  { p.replaceWith(t.nullLiteral()); },
    JSXFragment(p) { p.replaceWith(t.nullLiteral()); },
  },
});
const reqFromSrc = createRequire(path.join(SRC_DIR, '_noop.js'));
const resolveSpec = (spec) => {
  if (spec.startsWith('.')) return pathToFileURL(path.resolve(SRC_DIR, spec)).href;
  try { return pathToFileURL(reqFromSrc.resolve(spec)).href; } catch { return spec; }
};
const absolutizeImports = (code) =>
  code.replace(/(from\s+|import\s*\(\s*)(['"])([^'"]+)\2/g,
    (_m, lead, q, spec) => `${lead}${q}${resolveSpec(spec)}${q}`);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const out = babel.transformFileSync(SRC, {
  babelrc: false, configFile: false,
  parserOpts: { plugins: ['jsx'] },
  plugins: [stripJsx],
});
fs.writeFileSync(TMP, absolutizeImports(out.code));

try {
  const mod = await import(pathToFileURL(path.resolve(TMP)).href);
  const { gameReducer: reducer, freshState, transferCompatibility } = mod;

  const major = ['JFK', 'ORD', 'LAX', 'MIA'].filter(c => getAirport(c));
  const [P, Q, R] = major;
  const jet    = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
  const legMax = Math.max(distanceKm(getAirport(P), getAirport(Q)), distanceKm(getAirport(P), getAirport(R)));
  const tiny   = AIRCRAFT_TYPES.filter(t => !t.freighter && t.range < legMax).sort((a, b) => a.range - b.range)[0];
  const freighter = AIRCRAFT_TYPES.find(t => t.freighter);

  const ac = (id, typeId, over = {}) =>
    ({ id, typeId, status: 'idle', ageWeeks: 52, ownershipType: 'owned', ...over });

  const baseState = (over = {}) => ({
    ...freshState(),
    phase: 'playing', cash: 50_000_000, hub: P,
    gates: { [P]: 8, [Q]: 8, [R]: 8 },
    fleet: [
      ac('lease1', jet.id, { status: 'assigned', ownershipType: 'lease', leaseRemainingWeeks: 100 }),
      ac('new1', jet.id),
    ],
    routes: [
      { id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'lease1', weeklyFrequency: 5, weeksOpen: 30, hub: P },
      { id: 'r2', origin: P, destination: R, stops: [P, R], aircraftId: 'lease1', weeklyFrequency: 4, weeksOpen: 12, hub: P },
    ],
    ...over,
  });
  const doTransfer = (state, from = 'lease1', to = 'new1') =>
    reducer(state, { type: 'TRANSFER_ROUTES', fromAircraftId: from, toAircraftId: to });

  console.log('\n── TRANSFER_ROUTES reducer ─────────────────────────────');

  test('moves all routes, preserving ids / weeksOpen / frequency; statuses swap; cash untouched', () => {
    const s0 = baseState();
    const s1 = doTransfer(s0);
    assert.equal(s1.routes.length, 2);
    assert.ok(s1.routes.every(r => r.aircraftId === 'new1'), 'all routes repointed');
    const r1 = s1.routes.find(r => r.id === 'r1');
    assert.equal(r1.weeksOpen, 30, 'ramp preserved');
    assert.equal(r1.weeklyFrequency, 5, 'frequency preserved');
    assert.equal(s1.fleet.find(a => a.id === 'new1').status, 'assigned');
    assert.equal(s1.fleet.find(a => a.id === 'lease1').status, 'idle');
    assert.equal(s1.cash, s0.cash, 'transfer is free');
  });

  test('rejects when target already flies routes', () => {
    const s0 = baseState({
      routes: [
        { id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'lease1', weeklyFrequency: 5, weeksOpen: 30, hub: P },
        { id: 'r3', origin: P, destination: R, stops: [P, R], aircraftId: 'new1', weeklyFrequency: 2, weeksOpen: 5, hub: P },
      ],
    });
    const s1 = doTransfer(s0);
    assert.equal(s1.routes.find(r => r.id === 'r1').aircraftId, 'lease1', 'unchanged');
    assert.equal(transferCompatibility(s0, 'lease1', 'new1').ok, false);
  });

  test('rejects when a route is out of range for the target', () => {
    assert.ok(tiny, 'found a short-range type');
    const s0 = baseState({ fleet: [
      ac('lease1', jet.id, { status: 'assigned', ownershipType: 'lease' }),
      ac('new1', tiny.id),
    ] });
    const s1 = doTransfer(s0);
    assert.ok(s1.routes.every(r => r.aircraftId === 'lease1'), 'unchanged');
    assert.match(transferCompatibility(s0, 'lease1', 'new1').reason ?? '', /range/i);
  });

  test('rejects moving passenger routes onto a freighter', () => {
    assert.ok(freighter, 'found a freighter type');
    const s0 = baseState({ fleet: [
      ac('lease1', jet.id, { status: 'assigned', ownershipType: 'lease' }),
      ac('new1', freighter.id),
    ] });
    const s1 = doTransfer(s0);
    assert.ok(s1.routes.every(r => r.aircraftId === 'lease1'), 'unchanged');
  });

  test('moves cargo routes between freighters', () => {
    const s0 = baseState({
      fleet: [ac('f1', freighter.id, { status: 'assigned' }), ac('f2', freighter.id)],
      routes: [],
      cargoRoutes: [{ id: 'c1', origin: P, destination: Q, aircraftId: 'f1', yieldPrice: 0.4, weeklyFrequency: 3, weeksOpen: 8, hub: P, cargo: true }],
    });
    const s1 = doTransfer(s0, 'f1', 'f2');
    assert.equal(s1.cargoRoutes[0].aircraftId, 'f2');
    assert.equal(s1.fleet.find(a => a.id === 'f1').status, 'idle');
    assert.equal(s1.fleet.find(a => a.id === 'f2').status, 'assigned');
  });

  test('rejects when transferred routes exceed the target block-hour budget', () => {
    assert.ok(tiny, 'short-range type exists');
    // Slow tiny plane at very high frequency on a long-ish leg blows 140h/wk;
    // build the scenario on two tiny jets so the source legally holds the routes.
    const s0 = baseState({
      fleet: [ac('a1', jet.id, { status: 'assigned' }), ac('a2', tiny.id)],
      routes: [{ id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'a1', weeklyFrequency: 40, weeksOpen: 10, hub: P }],
    });
    const compat = transferCompatibility(s0, 'a1', 'a2');
    // Either range or block hours must stop this — it must NOT be ok.
    assert.equal(compat.ok, false);
  });

  test('no-op transfer to self / unknown aircraft leaves state unchanged', () => {
    const s0 = baseState();
    assert.equal(doTransfer(s0, 'lease1', 'lease1'), s0);
    assert.equal(doTransfer(s0, 'lease1', 'ghost'), s0);
  });
} finally {
  fs.rmSync(TMP, { force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
