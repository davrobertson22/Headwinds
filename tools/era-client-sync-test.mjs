// era-client-sync-test.mjs — the client must put the engine into the adopted
// world's era before the first paint, and must never undo the reducer.
//
// HEAD failure proof: RemoteGameProvider set the fare index from the STORED
// state.fareIndex (1 in a plain era world) on every render and never called
// setEraStartYear / setEraCostScale. In a 1950 world the planners quoted 18.5x
// the demand the tick would fly and the modern fare ladder against a tick
// pricing at 1.55x; after the first optimistic action composed 1.55 the very
// next render snapped it back to 1.0.
//
//   node --import ./tools/_register-loader.mjs tools/era-client-sync-test.mjs
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

const { RemoteGameProvider, GameProvider, syncEngineWorldState, effectiveFareIndex, gameReducer, freshState } =
  await import('../src/store/GameContext.jsx');
const { getFareIndex, setFareIndex, getEraStartYear, setEraStartYear, pairDemandGrowth } =
  await import('../packages/engine/src/utils/market.js');
const { getEraCostScale, setEraCostScale } = await import('../packages/engine/src/data/overhead.js');
const { eraFareIndex, eraOverheadScale } = await import('../packages/engine/src/data/era.js');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
};
const resetEngine = () => { setFareIndex(1); setEraStartYear(null); setEraCostScale(1); };
const eraBlob = (startYear, year, extra = {}) =>
  ({ ...freshState(), phase: 'playing', multiplayer: true, competitors: [], startYear, year, week: 1, ...extra });

// A child that snapshots the engine knobs DURING render — what a planner sees.
let seen = null;
const Probe = () => { seen = { fi: getFareIndex(), era: getEraStartYear(), cost: getEraCostScale() }; return null; };

console.log('era-client-sync-test');

test('effectiveFareIndex composes the era curve with the stored index, like the reducer entry', () => {
  assert.equal(effectiveFareIndex(eraBlob(1950, 1)), eraFareIndex(1950));
  assert.equal(effectiveFareIndex(eraBlob(1950, 1, { fareIndex: 0.85, newWorldRestrictions: true })), eraFareIndex(1950) * 0.85);
  assert.equal(effectiveFareIndex({ ...freshState(), fareIndex: 0.85 }), 0.85, 'classic NWR unchanged');
  assert.equal(effectiveFareIndex(freshState()), 1, 'classic unchanged');
});

test('the first paint of an era world already runs on the era economy', () => {
  resetEngine();
  const st = eraBlob(1950, 1);
  renderToString(React.createElement(RemoteGameProvider, { state: st, dispatch: () => {} }, React.createElement(Probe)));
  assert.equal(seen.fi, eraFareIndex(1950), 'fare ladder is 1950\'s');
  assert.equal(seen.era, 1950, 'era start year set');
  assert.equal(seen.cost, eraOverheadScale(1950), 'overhead scale set');
  // And the demand the planners quote is the tick's demand, not 2026's.
  assert.ok(pairDemandGrowth('JFK', 'LAX', 1) < 0.1, `1950 demand factor ${pairDemandGrowth('JFK', 'LAX', 1)}`);
});

test('a render never undoes what the reducer just set', () => {
  resetEngine();
  const st = eraBlob(1950, 1);
  // The reducer runs for an optimistic apply and composes 1.55 at its entry.
  const after = gameReducer(st, { type: 'CLEAR_TOASTS' });
  assert.equal(getFareIndex(), eraFareIndex(1950));
  renderToString(React.createElement(RemoteGameProvider, { state: after, dispatch: () => {} }, React.createElement(Probe)));
  assert.equal(seen.fi, eraFareIndex(1950), 'still 1.55 after the re-render');
});

test('the knobs follow the calendar: a 1975 blob prices on the 1975 curve', () => {
  resetEngine();
  renderToString(React.createElement(RemoteGameProvider, { state: eraBlob(1950, 26), dispatch: () => {} }, React.createElement(Probe)));
  assert.equal(seen.fi, eraFareIndex(1975));
  assert.equal(seen.cost, eraOverheadScale(1975));
});

test('a classic world is untouched: base index, no era, unit cost scale', () => {
  setFareIndex(1.55); setEraStartYear(1950); setEraCostScale(0.5);   // leftovers from an era tab
  renderToString(React.createElement(RemoteGameProvider, { state: freshState(), dispatch: () => {} }, React.createElement(Probe)));
  assert.deepEqual(seen, { fi: 1, era: null, cost: 1 });
});

test('the solo provider seeds the same knobs from the autosave on first render', () => {
  resetEngine();
  store.set('bbae_save_v2', JSON.stringify(eraBlob(1978, 3)));
  renderToString(React.createElement(GameProvider, null, React.createElement(Probe)));
  store.delete('bbae_save_v2');
  assert.equal(seen.era, 1978);
  assert.equal(seen.fi, eraFareIndex(1980));
});

test('syncEngineWorldState is idempotent', () => {
  resetEngine();
  const st = eraBlob(2000, 5);
  syncEngineWorldState(st); const a = [getFareIndex(), getEraStartYear(), getEraCostScale()];
  syncEngineWorldState(st); const b = [getFareIndex(), getEraStartYear(), getEraCostScale()];
  assert.deepEqual(a, b);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
