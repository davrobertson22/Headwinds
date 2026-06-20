// Reducer test for ADD_TAG_ROUTE / SET_SEGMENT_PRICE.
//
// GameContext.jsx is a React module; Node can't import JSX directly, so we
// transpile it in-memory (Babel core is a dependency) and strip JSX to `null`
// (we only need the pure reducer, not rendering). We rewrite its relative import
// specifiers to absolute file URLs so the transpiled module can live in the OS
// temp dir (keeping the repo clean), then import it and delete the temp file.
//
//   node tools/reducer-tag-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { distanceKm, routeSegmentKey } from '../src/utils/simulation.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

const SRC = 'src/store/GameContext.jsx';
const SRC_DIR = path.resolve(path.dirname(SRC));
const TMP = path.join(os.tmpdir(), `gc_transpiled_${process.pid}.mjs`);

const stripJsx = ({ types: t }) => ({
  visitor: {
    JSXElement(p)  { p.replaceWith(t.nullLiteral()); },
    JSXFragment(p) { p.replaceWith(t.nullLiteral()); },
  },
});

// Rewrite EVERY import specifier (relative AND bare like 'react') to an absolute
// file URL resolved from the original module's directory, so the transpiled copy
// runs from anywhere (incl. the OS temp dir) and still finds node_modules.
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

let reducer, freshState, reconcileState;
try {
  const mod = await import(pathToFileURL(path.resolve(TMP)).href);
  reducer = mod.gameReducer; freshState = mod.freshState; reconcileState = mod.reconcileState;

  const major = ['JFK', 'ORD', 'LAX', 'DFW', 'ATL', 'MIA'].filter(c => getAirport(c));
  const [P, Q, R] = major;
  const jet     = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
  const maxLeg  = Math.max(distanceKm(getAirport(P), getAirport(Q)), distanceKm(getAirport(Q), getAirport(R)));
  const tinyJet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.range < maxLeg).sort((a, b) => a.range - b.range)[0];

  const baseState = (over = {}) => ({
    ...freshState(),
    phase: 'playing', cash: 5_000_000, hub: P,
    gates: { [P]: 8, [Q]: 8, [R]: 8 },
    fleet: [{ id: 'ac1', typeId: jet.id, status: 'idle', ageWeeks: 52, ownershipType: 'owned' }],
    routes: [],
    ...over,
  });
  const addTag = (state, extra = {}) =>
    reducer(state, { type: 'ADD_TAG_ROUTE', aircraftId: 'ac1', stops: [P, Q, R], weeklyFrequency: 7, ...extra });

  console.log('\n── ADD_TAG_ROUTE reducer ────────────────────────────────');

  test('creates a tag route with stops, segment prices, cash + status updated', () => {
    const s0 = baseState();
    const s1 = addTag(s0);
    assert.equal(s1.routes.length, 1, 'route added');
    const r = s1.routes[0];
    assert.deepEqual(r.stops, [P, Q, R]);
    assert.equal(r.origin, P);
    assert.equal(r.destination, R);
    assert.equal(Object.keys(r.segmentPrices).length, 3, '3 segment fares');
    assert.ok(r.segmentPrices[routeSegmentKey(P, R)], 'through fare present');
    assert.ok(s1.cash < s0.cash, 'launch cost charged');
    assert.equal(s1.fleet[0].status, 'assigned', 'aircraft assigned');
  });

  test('rejects fewer than 3 stops (single-leg belongs to ADD_ROUTE)', () => {
    const s = addTag(baseState(), { stops: [P, R] });
    assert.equal(s.routes.length, 0);
  });

  test('rejects a repeated airport in the stop list', () => {
    const s = addTag(baseState(), { stops: [P, Q, P] });
    assert.equal(s.routes.length, 0);
  });

  test('rejects when a leg exceeds aircraft range', () => {
    assert.ok(tinyJet, 'found a short-range type for the test');
    const s = baseState({ fleet: [{ id: 'ac1', typeId: tinyJet.id, status: 'idle', ageWeeks: 12, ownershipType: 'owned' }] });
    assert.equal(addTag(s).routes.length, 0);
  });

  test('rejects when an intermediate stop has no gate', () => {
    const s = baseState({ gates: { [P]: 8, [R]: 8 } });   // no gate at Q
    assert.equal(addTag(s).routes.length, 0);
  });

  test('rejects when cash cannot cover the launch cost', () => {
    const s = baseState({ cash: 0 });
    assert.equal(addTag(s).routes.length, 0);
  });

  test('rejects when weekly frequency blows the block-hour cap', () => {
    const s = addTag(baseState(), { weeklyFrequency: 60 });   // way over 140h/wk
    assert.equal(s.routes.length, 0);
  });

  test('rejects when the aircraft can’t connect from a served airport', () => {
    const E = major[4], F = major[5];
    assert.ok(E && F, 'need two more airports');
    const s = baseState({
      gates: { [P]: 8, [Q]: 8, [R]: 8, [E]: 8, [F]: 8 },
      routes: [{ id: 'x', origin: E, destination: F, stops: [E, F], aircraftId: 'ac1', weeklyFrequency: 7 }],
      fleet: [{ id: 'ac1', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' }],
    });
    // Aircraft already flies E–F; a tag at P/Q/R touches none of those → rejected.
    assert.equal(addTag(s).routes.length, 1);   // only the pre-existing E–F route remains
  });

  test('creates a 4-stop tag route with 6 segment fares (at the 2-stop cap)', () => {
    const D = major[3];
    assert.ok(D, 'need a 4th airport');
    // freq 3 keeps 3 long legs within the 140h/wk block-hour cap.
    const s = addTag(baseState({ gates: { [P]: 8, [Q]: 8, [R]: 8, [D]: 8 } }), { stops: [P, Q, R, D], weeklyFrequency: 3 });
    assert.equal(s.routes.length, 1);
    assert.deepEqual(s.routes[0].stops, [P, Q, R, D]);
    assert.equal(Object.keys(s.routes[0].segmentPrices).length, 6);
  });

  test('rejects more than 2 intermediate stops (5 airports)', () => {
    const D = major[3], E = major[4];
    assert.ok(D && E, 'need 5 airports');
    const s = addTag(baseState({ gates: { [P]: 8, [Q]: 8, [R]: 8, [D]: 8, [E]: 8 } }), { stops: [P, Q, R, D, E], weeklyFrequency: 1 });
    assert.equal(s.routes.length, 0);
  });

  console.log('\n── SET_SEGMENT_PRICE reducer ────────────────────────────');

  test('updates one directional segment fare on a tag route', () => {
    const s1 = addTag(baseState());
    const id = s1.routes[0].id;
    const s2 = reducer(s1, { type: 'SET_SEGMENT_PRICE', routeId: id, from: P, to: R, classPrices: { economy: 777 } });
    assert.equal(s2.routes[0].segmentPrices[routeSegmentKey(P, R)].economy, 777);
    // other segments untouched
    assert.equal(
      s2.routes[0].segmentPrices[routeSegmentKey(P, Q)].economy,
      s1.routes[0].segmentPrices[routeSegmentKey(P, Q)].economy);
  });

  test('clamps a non-positive economy fare to ≥ 1', () => {
    const s1 = addTag(baseState());
    const id = s1.routes[0].id;
    const s2 = reducer(s1, { type: 'SET_SEGMENT_PRICE', routeId: id, from: P, to: R, classPrices: { economy: 0 } });
    assert.ok(s2.routes[0].segmentPrices[routeSegmentKey(P, R)].economy >= 1);
  });

  console.log('\n── reconcileState (save/reload) ─────────────────────────');

  test('a saved tag route survives reload with stops, segmentPrices & catering', () => {
    assert.ok(reconcileState, 'reconcileState exported');
    const segmentPrices = {
      [routeSegmentKey(P, Q)]: { economy: 100 },
      [routeSegmentKey(P, R)]: { economy: 200 },
      [routeSegmentKey(Q, R)]: { economy: 150 },
    };
    const parsed = {
      ...freshState(),
      fleet: [{ id: 'ac1', typeId: jet.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' }],
      routes: [
        { id: 'tg', origin: P, destination: R, stops: [P, Q, R], aircraftId: 'ac1', weeklyFrequency: 5, weeksOpen: 10, segmentPrices, cateringLevel: 'full' },
        { id: 'lg', origin: P, destination: R, aircraftId: 'ac1', weeklyFrequency: 7 }, // legacy single-leg, no stops
      ],
      routePricing: {}, routeCatering: {},
    };
    const rc = reconcileState(parsed);
    const tg = rc.routes.find(r => r.id === 'tg');
    const lg = rc.routes.find(r => r.id === 'lg');
    assert.ok(tg, 'tag route retained');
    assert.deepEqual(tg.stops, [P, Q, R], 'stops preserved');
    assert.equal(tg.segmentPrices[routeSegmentKey(P, R)].economy, 200, 'through fare preserved');
    assert.equal(tg.cateringLevel, 'full', 'per-route catering preserved');
    assert.equal(tg.origin, P);
    assert.equal(tg.destination, R);
    assert.ok(lg, 'legacy route retained');
    assert.deepEqual(lg.stops, [P, R], 'legacy route gains derived stops');
  });
} finally {
  try { fs.unlinkSync(TMP); } catch (_) { /* ignore */ }
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
