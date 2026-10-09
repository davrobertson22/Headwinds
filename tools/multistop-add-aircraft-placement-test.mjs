// "+ Add Aircraft" on a multi-stop rotation opens its planner where the player
// is looking: directly under the card they pressed.
//
// Barca (Discord 2026-10-05): "Add planes button doesnt work for multi stop
// routes … I mean on the routes page. Doesnt work for me atleast."
// TheCookiesGuy: "it does".
//
// Both were right. The planner rendered at the TOP of the multi-stop section,
// above every rotation card — and that section sits below the whole passenger
// list. Press the button on any card but the first and the browser's scroll
// anchoring keeps the pressed card where it was while the planner appears
// off-screen above it: nothing seems to happen. With one rotation, or the
// section header in view, it visibly worked. The planner now renders right
// after the card that asked for it (and scrolls itself into view on mount —
// not observable in SSR, so this pins the placement).
//
//   node --import ./tools/_register-loader.mjs tools/multistop-add-aircraft-placement-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
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

// ── Hook seeding (see planner-class-fares-test for the rationale) ─────────────
const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
assert.ok(RCD, 'React 18 hook dispatcher not reachable — this harness needs updating');
let seed = null, rawDispatcher = RCD.current, liveDispatcher = null;
function wrapDispatcher(d) {
  if (!d) return d;
  const w = Object.create(Object.getPrototypeOf(d));
  Object.assign(w, d);
  w.useState = function (initial) {
    if (seed) {
      const i = seed.i++;
      if (i < seed.slots.length) {
        const slot = seed.slots[i];
        if (slot) return d.useState(slot.value);
      }
      if (seed.i >= seed.slots.length) seed = null;
    }
    return d.useState(initial);
  };
  return w;
}
Object.defineProperty(RCD, 'current', {
  configurable: true, get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;
function Seed({ slots, children }) { seed = { i: 0, slots }; return children; }

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Routes = (await import('../src/components/Routes.jsx')).default;

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.runwayFt && t.runwayFt <= 9000).sort((a, b) => b.range - a.range)[0];
const CHAINS = { t1: ['JFK', 'ORD', 'LAX'], t2: ['JFK', 'DEN', 'SFO'], t3: ['JFK', 'ATL', 'MIA'] };
for (const c of Object.values(CHAINS).flat()) assert.ok(getAirport(c), `${c} missing`);

const tail = (id, name, extra = {}) => ({
  id, typeId: jet.id, name, tailNumber: `N${id}`, status: 'assigned',
  ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats }, ...extra,
});
const codes = [...new Set(Object.values(CHAINS).flat())];
const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: 'JFK', cash: 500_000_000,
  gates: Object.fromEntries(codes.map(c => [c, 20])),
  fleet: [tail('a1', 'Rotation One'), tail('a2', 'Rotation Two'), tail('a3', 'Rotation Three'),
          tail('a4', 'Spare Metal', { status: 'idle' })],
  routes: Object.entries(CHAINS).map(([id, stops], i) => ({
    id, origin: stops[0], destination: stops[2], stops, aircraftId: `a${i + 1}`,
    weeklyFrequency: 3, weeksOpen: 20, hub: 'JFK', cateringLevel: 'full', segmentPrices: {},
  })),
  cargoRoutes: [],
};

// Routes' useState block, in source order — tagAddStops is slot 15:
// selectedKeys, showBulkModal, detailPair, formMode, search, sortBy, profitBasis,
// filterTab, regionFilter, acTypeFilter, haulFilter, airportFilter, typeFilter,
// showCargoForm, cargoAddLane, tagAddStops
const TAG_ADD_SLOT = 15;
function render(tagAdd) {
  store.set('bbae_save_v2', JSON.stringify(save));
  const slots = new Array(TAG_ADD_SLOT + 1).fill(null);
  slots[TAG_ADD_SLOT] = { value: tagAdd };
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(Seed, { slots }, React.createElement(Routes)))).replace(/<!-- -->/g, '');
}
const PLANNER = 'Add an aircraft to this rotation';
const CARD_BUTTON = 'title="Put another aircraft on this rotation"';
const allIdx = (h, s) => { const out = []; let i = -1; while ((i = h.indexOf(s, i + 1)) >= 0) out.push(i); return out; };

console.log('\n── + Add Aircraft on the third of three rotations ───────────');
const html = render({ routeId: 't3', chain: CHAINS.t3, fares: {} });

test('harness: the seeded planner renders (slot order still right)', () => {
  assert.equal(allIdx(html, PLANNER).length, 1, 'planner not rendered exactly once — has Routes\' useState order changed?');
  assert.equal(allIdx(html, CARD_BUTTON).length, 3, 'expected three rotation cards');
});

test('the planner opens under the card that was pressed, not above the first', () => {
  const cards = allIdx(html, CARD_BUTTON);
  const p = html.indexOf(PLANNER);
  assert.ok(p > cards[2],
    `planner renders before card ${cards.filter(c => c < p).length + 1} of 3 — off-screen above the pressed card`);
});

test('pressing the first card opens it between the first and second', () => {
  const h = render({ routeId: 't1', chain: CHAINS.t1, fares: {} });
  const cards = allIdx(h, CARD_BUTTON);
  const p = h.indexOf(PLANNER);
  assert.ok(p > cards[0] && p < cards[1], 'planner not directly under the first card');
});

test('a rotation filtered out of view since the click still shows its planner (top of section)', () => {
  const h = render({ routeId: 'gone', chain: CHAINS.t2, fares: {} });
  assert.equal(allIdx(h, PLANNER).length, 1, 'planner vanished when its card is not in the list');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
