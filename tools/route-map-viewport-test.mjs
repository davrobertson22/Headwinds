// Network map — who is allowed to move the camera.
//
// Player report (Discord, 2 Aug 2026, BobConstructeur): "When you zoom in and
// pass your mouse over a route, it resets your zoom, could you disable that?"
//
// Cause: hovering a line sets React state, and the map's derived data was
// rebuilt from scratch on every render — currentGameDate() returns a FRESH
// object each call and sat in routeData's dependency list, so routeData →
// routeGroups → airportSet were new identities every render. The layer effect
// therefore re-ran on a mere hover, tore down every Leaflet layer and called
// fitBounds() again, snapping the player back out to their whole network.
//
// The same trap sat on the focus path: flyToBounds() depended on routeGroups,
// so the weekly tick re-flew to an already-focused route.
//
// The fix gives the viewport two owners and nobody else: extent changed, or
// focus changed. This suite drives those two decisions directly — they are
// exported from the component precisely so they can be tested without a DOM.
//
//   node --import ./tools/_register-loader.mjs tools/route-map-viewport-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Minimal browser shims — importing the component pulls the game store, which
// reads localStorage at module scope.
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { viewportExtent, claimViewportFit, claimRouteFly } =
  await import('../src/components/RouteMap.jsx');
const { currentGameDate } = await import('../src/utils/simulation.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const ap = (...codes) => codes.map((code) => ({ code }));

console.log('\nMap extent signature');

test('the same airports in a different order are the same extent', () => {
  // The airport set is rebuilt from route data on every render; nothing
  // guarantees insertion order survives adding a second aircraft to a pair.
  assert.equal(viewportExtent(ap('JFK', 'LHR', 'ORD')), viewportExtent(ap('ORD', 'JFK', 'LHR')));
});

test('opening or closing a route changes the extent', () => {
  assert.notEqual(viewportExtent(ap('JFK', 'LHR')), viewportExtent(ap('JFK', 'LHR', 'CDG')));
  assert.notEqual(viewportExtent(ap('JFK', 'LHR', 'CDG')), viewportExtent(ap('JFK', 'LHR')));
});

console.log('\nViewport fit — the reported bug');

test('the first draw frames the network', () => {
  const ref = { current: null };
  assert.equal(claimViewportFit(ref, ap('JFK', 'LHR')), true);
});

test('hovering a route does NOT re-frame the network', () => {
  const ref = { current: null };
  claimViewportFit(ref, ap('JFK', 'LHR', 'ORD'));
  // Hover → re-render → the airport set is rebuilt: equal contents, new objects.
  for (let i = 0; i < 5; i++) {
    assert.equal(claimViewportFit(ref, ap('JFK', 'LHR', 'ORD')), false,
      'a redraw with an unchanged network must not move the camera');
  }
});

test('a weekly tick redraw does NOT re-frame the network', () => {
  const ref = { current: null };
  claimViewportFit(ref, ap('JFK', 'LHR'));
  // Profit, load factor and every tooltip number change; the extent does not.
  assert.equal(claimViewportFit(ref, ap('LHR', 'JFK')), false);
});

test('opening a route re-frames, once', () => {
  const ref = { current: null };
  claimViewportFit(ref, ap('JFK', 'LHR'));
  assert.equal(claimViewportFit(ref, ap('JFK', 'LHR', 'NRT')), true);
  assert.equal(claimViewportFit(ref, ap('JFK', 'LHR', 'NRT')), false);
});

test('a map filter re-frames on the narrowed network', () => {
  const ref = { current: null };
  claimViewportFit(ref, ap('JFK', 'LHR', 'NRT', 'SYD'));
  assert.equal(claimViewportFit(ref, ap('JFK', 'LHR')), true, 'filtering narrows the extent');
  assert.equal(claimViewportFit(ref, ap('JFK', 'LHR', 'NRT', 'SYD')), true, 'clearing it restores');
});

test('an empty network never moves the camera', () => {
  const ref = { current: null };
  assert.equal(claimViewportFit(ref, []), false);
  assert.equal(ref.current, null);
});

test('a remounted map (ref cleared on teardown) frames again', () => {
  const ref = { current: null };
  claimViewportFit(ref, ap('JFK', 'LHR'));
  ref.current = null;                       // what the map's cleanup does
  assert.equal(claimViewportFit(ref, ap('JFK', 'LHR')), true);
});

console.log('\nRoute focus fly-to');

test('focusing a route flies to it', () => {
  const ref = { current: null };
  assert.equal(claimRouteFly(ref, 'JFK~LHR'), true);
});

test('redraws of an already-focused route do not fly again', () => {
  const ref = { current: null };
  claimRouteFly(ref, 'JFK~LHR');
  assert.equal(claimRouteFly(ref, 'JFK~LHR'), false);
  assert.equal(claimRouteFly(ref, 'JFK~LHR'), false);
});

test('changing focus flies to the new route', () => {
  const ref = { current: null };
  claimRouteFly(ref, 'JFK~LHR');
  assert.equal(claimRouteFly(ref, 'JFK~ORD'), true);
});

test('clearing focus resets, so re-focusing the same route flies again', () => {
  const ref = { current: null };
  claimRouteFly(ref, 'JFK~LHR');
  assert.equal(claimRouteFly(ref, null), false);
  assert.equal(ref.current, null);
  assert.equal(claimRouteFly(ref, 'JFK~LHR'), true);
});

console.log('\nRoot cause');

test('currentGameDate() returns a fresh object every call', () => {
  // This is WHY the map has to memoise it: as a raw dependency it invalidates
  // every downstream useMemo on every render, which is what made a hover redraw
  // the whole map. If this ever starts returning a stable value the memo is
  // harmless, but the guards above still have to hold.
  const state = { week: 42 };
  assert.notEqual(currentGameDate(state), currentGameDate(state));
  assert.deepEqual(currentGameDate(state), currentGameDate(state));
});

test('the component memoises the game date and guards its fit call', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/components/RouteMap.jsx', import.meta.url)), 'utf8',
  );
  assert.ok(/useMemo\(\(\) => currentGameDate\(state\)/.test(src),
    'currentGameDate must be memoised, not derived inline every render');
  assert.ok(/claimViewportFit\(fittedExtentRef, airportSet\)/.test(src),
    'fitBounds must sit behind the extent guard');
  assert.ok(!/^\s*if \(airportSet\.length > 0\) \{$/m.test(src),
    'the old unguarded fitBounds branch must be gone');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
