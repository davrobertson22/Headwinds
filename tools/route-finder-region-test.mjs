// Route Finder: regions.
//
//   ASAS  "can we pls add regions to the route finder"   (Discord, 9/11/26)
//
// With ~2,100 airports in the table a distance band is a poor stand-in for
// "show me Europe": 5,000 km from JFK is most of western Europe AND most of
// South America, and a player who wants one of those does not want the other.
//
// The trap this suite guards is not the filter — it is where the geography
// comes from. The engine has had a region for every country since border
// friction shipped (utils/market.js, COUNTRY_REGION), and that table is what
// prices these very markets: same-region international traffic is scored at
// INTL_SAME_REGION, cross-region at a fraction of it. A finder that invented
// its own continent list would sooner or later put a country in one region for
// the filter and another for the fare — a preview disagreeing with the tick,
// which is the bug class this codebase keeps paying for. So:
//
//   1. every row's region IS COUNTRY_REGION's answer, not a second opinion
//   2. every airport in the table has one (the gap this change closed)
//   3. the filter narrows to exactly that region, and to nothing else
//   4. the dropdown is built from REGION_ORDER, so it cannot drift from (1)
//
//   node --import ./tools/_register-loader.mjs tools/route-finder-region-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { referencePrice } from '../src/utils/simulation.js';
import {
  COUNTRY_REGION, REGION_LABELS, REGION_ORDER, regionOf, regionLabel,
} from '../src/utils/market.js';
import { findCandidates } from '../src/models/routeFinder.js';

// Minimal browser shims for SSR (effects don't run, but init reads localStorage).
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nRoute Finder — regions come from the table that prices the market\n');

const HUB = 'JFK';
assert.ok(getAirport(HUB), 'fixture airport missing');

const jet = AIRCRAFT_TYPES
  .filter((t) => !t.freighter && t.range >= 12_000)
  .sort((a, b) => b.range - a.range)[0];
assert.ok(jet, 'fixture needs an ultra-long-haul passenger type');

const mkAc = (id, typeId) => ({
  id, typeId, tailNumber: id.toUpperCase(), status: 'idle', ownershipType: 'owned',
  ageWeeks: 40, config: { economy: getAircraftType(typeId).seats },
});

function world() {
  const gates = {};
  for (const a of AIRPORTS) gates[a.code] = 20;
  return {
    week: 60, absWeek: 60, hub: HUB, hubs: {}, cash: 5e8,
    fleet: [mkAc('spare', jet.id)], routes: [], cargoRoutes: [],
    competitors: [], humanRivals: {}, encroachments: {},
    gates, routePricing: {}, gameDate: { week: 60, month: 6, absWeek: 60 },
  };
}
const state = world();

// ── 1. One geography, not two ────────────────────────────────────────────────
console.log('── 1. The finder reads the engine\'s own region table ─────');

test('regionOf() is COUNTRY_REGION, for every country in the airport table', () => {
  for (const a of AIRPORTS) {
    assert.equal(regionOf(a), COUNTRY_REGION[a.country] ?? null,
      `${a.code} (${a.country}) — the finder and border friction disagree on its region`);
  }
});

test('every region code REGION_ORDER offers has a label, and vice versa', () => {
  assert.deepEqual([...REGION_ORDER].sort(), Object.keys(REGION_LABELS).sort(),
    'REGION_ORDER and REGION_LABELS have drifted apart');
  for (const code of REGION_ORDER) {
    assert.ok(regionLabel(code) && regionLabel(code) !== code,
      `${code} has no player-facing name`);
  }
});

test('every region a country is actually assigned to is offered in the filter', () => {
  const used = new Set(Object.values(COUNTRY_REGION));
  for (const code of used) {
    assert.ok(REGION_ORDER.includes(code),
      `COUNTRY_REGION puts countries in ${code}, but the filter never offers it`);
  }
});

// This is the gap the change closed. Before it, Equatorial Guinea and French
// Guiana had no region at all: borderFactor fell through to the propensity
// fallback for every one of their markets, and a region filter would have had
// nowhere to file their three airports.
test('no airport in the table is left without a region', () => {
  const orphans = AIRPORTS.filter((a) => !regionOf(a));
  assert.equal(orphans.length, 0,
    `unregioned: ${orphans.map((a) => `${a.code} (${a.country})`).join(', ')}`);
});

// ── 2. The filter narrows to exactly one region ──────────────────────────────
console.log('\n── 2. "add regions to the route finder" ──────────────────');

const all = findCandidates(state, {
  origin: HUB, aircraftTypeId: jet.id, aircraft: state.fleet[0], hideUnflyable: false,
});

test('every candidate row carries its destination region', () => {
  assert.ok(all.length > 0, 'no candidates at all — fixture is broken');
  for (const r of all) {
    assert.equal(r.region, regionOf(r.airport),
      `${r.code} row region disagrees with the table`);
  }
});

for (const code of REGION_ORDER) {
  test(`region "${code}" (${regionLabel(code)}) returns that region and only that region`, () => {
    const rows = findCandidates(state, {
      origin: HUB, aircraftTypeId: jet.id, aircraft: state.fleet[0],
      hideUnflyable: false, region: code,
    });
    assert.ok(rows.length > 0, `no markets at all in ${code} — the filter is over-narrow`);
    for (const r of rows) {
      assert.equal(r.region, code, `${r.code} (${r.airport.country}) leaked into ${code}`);
    }
  });
}

test('the region slices partition the unfiltered list exactly', () => {
  // No row lost, none double-counted: a filter that quietly dropped markets
  // would read as "there is nothing there", which is the worst kind of wrong.
  let total = 0;
  const seen = new Set();
  for (const code of REGION_ORDER) {
    const rows = findCandidates(state, {
      origin: HUB, aircraftTypeId: jet.id, aircraft: state.fleet[0],
      hideUnflyable: false, region: code,
    });
    total += rows.length;
    for (const r of rows) {
      assert.ok(!seen.has(r.code), `${r.code} appears under two regions`);
      seen.add(r.code);
    }
  }
  assert.equal(total, all.length,
    `${all.length} markets unfiltered but ${total} across all regions — the slices do not add up`);
});

test('an empty region is still every region', () => {
  const rows = findCandidates(state, {
    origin: HUB, aircraftTypeId: jet.id, aircraft: state.fleet[0],
    hideUnflyable: false, region: '',
  });
  assert.equal(rows.length, all.length, 'passing region: "" narrowed the search');
});

test('the region filter composes with the others rather than replacing them', () => {
  const band = { minDistKm: 5_000, maxDistKm: 7_000 };
  const rows = findCandidates(state, {
    origin: HUB, aircraftTypeId: jet.id, aircraft: state.fleet[0],
    hideUnflyable: false, region: 'EUR', ...band,
  });
  assert.ok(rows.length > 0, 'no European markets in the 5,000–7,000 km band from JFK');
  for (const r of rows) {
    assert.equal(r.region, 'EUR');
    assert.ok(r.distKm >= band.minDistKm && r.distKm <= band.maxDistKm,
      `${r.code} at ${r.distKm} km is outside the band the region filter was added to`);
  }
});

// ── 3. The control the player actually sees ─────────────────────────────────
console.log('\n── 3. The dropdown is built from the same list ───────────');

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteFinderScreen = (await import('../src/components/RouteFinderScreen.jsx')).default;

const SAVE = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 10 },
  fleet: [{
    id: 'ac_free', tailNumber: 'N3FREE', name: 'Tail N3FREE', typeId: jet.id,
    status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats },
  }],
  routes: [], cargoRoutes: [],
};

store.set('bbae_save_v2', JSON.stringify(SAVE));
const html = renderToString(
  React.createElement(GameProvider, null, React.createElement(RouteFinderScreen)),
).replace(/<!-- -->/g, '');

test('the finder renders a Region control', () => {
  assert.ok(html.includes('Region'), 'no Region label on the finder');
  assert.ok(/Any region/i.test(html), 'the filter offers no way back to the whole world');
});

// React escapes text nodes, so "Central America & Caribbean" reaches the markup
// as "Central America &amp; Caribbean". Comparing raw labels against SSR output
// without this passes for eleven regions and fails for the twelfth.
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('every region in REGION_ORDER is an option, by its player-facing name', () => {
  for (const code of REGION_ORDER) {
    assert.ok(html.includes(esc(REGION_LABELS[code])),
      `"${REGION_LABELS[code]}" is missing from the dropdown — the UI list has drifted from the engine's`);
  }
});

test('rows name their region, so a filtered list says what it is filtered to', () => {
  assert.ok(REGION_ORDER.some((code) => html.includes(esc(REGION_LABELS[code]))),
    'no region named anywhere in the rendered results');
});

console.log('\n────────────────────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
