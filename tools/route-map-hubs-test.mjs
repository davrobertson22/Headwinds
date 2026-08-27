// Network map — every designated station wears a gold pin.
//
// Player report (Discord, Knightmare, 27 Aug 2026): "hubs not showing on route
// map, in this example MCI, SLC, HNL, and SJU are hubs" — a screenshot with one
// gold pin and four hubs drawn as ordinary blue spokes.
//
// Cause: the marker loop asked `airport.code === state.hub`. `state.hub` is the
// FOUNDING hub — stamped on every route at creation, never changed — while the
// stations a player actually designates live in `state.hubs`
// ({ code: { tier, tierSince } }, tier 0 = focus city). Everything else in the
// game reads the map (HubManagement, Fleet, the tick); only the network map
// still read the founding string, so every hub built after founding was
// invisible as a hub and, if it had no routes yet, absent from the map.
//
// Helpers are driven directly, and the REAL component is SSR-rendered on a
// four-hub save — a helper can pass on its own while the component that should
// call it quietly doesn't.
//
//   node --import ./tools/_register-loader.mjs tools/route-map-hubs-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Minimal browser shims for SSR (effects don't run; init reads localStorage).
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { mapHubs, mapAirportCodes, hubMarkerSize } =
  await import('../src/components/RouteMap.jsx');
const RouteMap = (await import('../src/components/RouteMap.jsx')).default;
const { HUB_TIERS } = await import('../src/models/demand.js');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const rd = (o, d) => ({ origin: { code: o }, dest: { code: d } });
const chain = (...codes) => ({ chain: codes.map(code => ({ code })) });

console.log('\n── 1. Which stations count as hubs ──────────────────────');

check('every designated station pins, not just the founding hub', () => {
  const hubs = mapHubs({
    hub: 'DFW',
    hubs: {
      DFW: { tier: 2 }, MCI: { tier: 1 }, SLC: { tier: 1 },
      HNL: { tier: 0 }, SJU: { tier: 0 },
    },
  });
  for (const code of ['DFW', 'MCI', 'SLC', 'HNL', 'SJU']) {
    assert.ok(hubs[code], `${code} should be pinned as a hub`);
  }
  assert.equal(Object.keys(hubs).length, 5);
});

check('focus cities pin too — tier 0 is a designation, not an absence', () => {
  const hubs = mapHubs({ hub: 'DFW', hubs: { DFW: { tier: 1 }, SJU: { tier: 0 } } });
  assert.ok(hubs.SJU, 'a focus city is a station the player paid for');
  assert.equal(hubs.SJU.tier, 0);
});

check('the pin names its tier', () => {
  const hubs = mapHubs({
    hubs: { AAA: { tier: 0 }, BBB: { tier: 1 }, CCC: { tier: 2 }, DDD: { tier: 3 } },
  });
  assert.equal(hubs.AAA.name, HUB_TIERS[0].name);
  assert.equal(hubs.BBB.name, HUB_TIERS[1].name);
  assert.equal(hubs.CCC.name, HUB_TIERS[2].name);
  assert.equal(hubs.DDD.name, HUB_TIERS[3].name);
});

check('a spoke the player has NOT designated stays a spoke', () => {
  assert.equal(mapHubs({ hub: 'DFW', hubs: { DFW: { tier: 1 } } }).LAX, undefined);
});

check('legacy save with no hubs map falls back to the founding hub', () => {
  const hubs = mapHubs({ hub: 'ORD' });
  assert.deepEqual(Object.keys(hubs), ['ORD']);
  assert.equal(hubs.ORD.tier, 1);
});

check('an EMPTY hubs map means every designation was abandoned — nothing pins', () => {
  assert.deepEqual(mapHubs({ hub: 'ORD', hubs: {} }), {});
});

check('a founding hub the player downgraded away does not come back', () => {
  const hubs = mapHubs({ hub: 'ORD', hubs: { MCI: { tier: 1 } } });
  assert.equal(hubs.ORD, undefined);
  assert.ok(hubs.MCI);
});

check('a garbage tier is ignored rather than pinned', () => {
  const hubs = mapHubs({ hubs: { MCI: { tier: 9 }, SLC: { tier: 1 } } });
  assert.equal(hubs.MCI, undefined);
  assert.ok(hubs.SLC);
});

check('no airline yet — no hub, no hubs, no crash', () => {
  assert.deepEqual(mapHubs({}), {});
  assert.deepEqual(mapHubs(), {});
});

console.log('\n── 2. Which airports the map pins ───────────────────────');

check('a hub with no routes yet still appears on the map', () => {
  const codes = mapAirportCodes(['DFW', 'MCI'], [chain('DFW', 'LAX')], []);
  assert.ok(codes.includes('MCI'), 'a freshly built hub should be visible');
  assert.deepEqual([...codes].sort(), ['DFW', 'LAX', 'MCI']);
});

check('every stop of a rotation is pinned, not just its endpoints', () => {
  const codes = mapAirportCodes([], [chain('MCI', 'JFK', 'ORY')], []);
  assert.ok(codes.includes('JFK'), 'the aeroplane lands at JFK every rotation');
  assert.equal(codes.length, 3);
});

check('cargo-only airports are pinned as well', () => {
  assert.ok(mapAirportCodes(['DFW'], [], [rd('DFW', 'ANC')]).includes('ANC'));
});

check('an airport is pinned once, however many routes touch it', () => {
  const codes = mapAirportCodes(['DFW'], [chain('DFW', 'LAX'), chain('LAX', 'DFW')], []);
  assert.equal(codes.filter(c => c === 'LAX').length, 1);
  assert.equal(codes.filter(c => c === 'DFW').length, 1);
});

check('pins grow with tier, and the ring always clears the core', () => {
  const sizes = [0, 1, 2, 3].map(hubMarkerSize);
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i].core > sizes[i - 1].core, `tier ${i} should out-size tier ${i - 1}`);
  }
  for (const s of sizes) assert.ok(s.ring > s.core);
  // The tier-1 hub keeps the size the map has always drawn.
  assert.equal(sizes[1].core, 11);
  assert.equal(sizes[1].ring, 14);
});

console.log('\n── 3. The component itself reads the hub map ────────────');

// Knightmare's shape: a founding hub plus three stations designated later, one
// of them (SJU) with no route flown from it yet.
const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 140).sort((a, b) => b.range - a.range)[0];
const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: 'DFW', cash: 20_000_000,
  scheduleTrimVersion: 1,
  hubs: {
    DFW: { tier: 2, tierSince: 0 }, MCI: { tier: 1, tierSince: 40 },
    SLC: { tier: 1, tierSince: 44 }, SJU: { tier: 0, tierSince: 60 },
  },
  gates: { DFW: 16, MCI: 10, SLC: 10, SJU: 5, LAX: 6 },
  fleet: [{
    id: 'ac0', typeId: jet.id, name: 'Test 0', tailNumber: 'N0TEST',
    status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
    config: { economy: jet.seats },
  }],
  routes: [{
    id: 'r0', origin: 'DFW', destination: 'LAX', stops: ['DFW', 'LAX'],
    aircraftId: 'ac0', weeklyFrequency: 14, weeksOpen: 40, hub: 'DFW',
    cateringLevel: 'full',
  }],
};
store.set('bbae_save_v2', JSON.stringify(save));

const html = renderToString(React.createElement(GameProvider, null,
  React.createElement(RouteMap))).replaceAll('<!-- -->', '');

check('the map header counts hub-only airports', () => {
  const m = html.match(/(\d+) airports/);
  assert.ok(m, 'header prints an airport count');
  // DFW + LAX from the one route, plus MCI, SLC and SJU with no routes yet.
  assert.equal(Number(m[1]), 5, `expected 5 airports, header says ${m[1]}`);
});

check('the legend goes plural once more than one station is designated', () => {
  assert.ok(/>Hubs</.test(html), 'legend should read "Hubs" on a four-hub network');
});

console.log(failures === 0
  ? '\nAll hub-pin checks passed.\n'
  : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
