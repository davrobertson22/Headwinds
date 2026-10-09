// The new-route form warns at the same fare cliff the Routes page will.
//
// Dunno23 (Discord 2026-10-05), Old Metal world: "when creating a new route, it
// says that the prices are past the demand cliff when you price more than 10%
// above reference, but then when you edit an existing route, you can raise it
// by up to 25% of the reference before it tells you it's past the cliff, which
// should we be following? And it's the same with the warning the route tab
// gives, it only happens when they're priced more than 25% above."
//
// The engine's cliff starts at 1.10x reference for a quality-50 route and rises
// to 1.25x at quality 100 (nwrChokeThreshold). The Routes page passes each
// route's real quality (cliffFaresFor); the Route Planner passed nothing, so its
// FareEditor fell back to the 1.10x floor. The per-route figure is the right
// one — this pins the planner to it: the cliff it shows for a route must be the
// cliff the Routes page shows for that route once it is open.
//
//   node --import ./tools/_register-loader.mjs tools/new-route-fare-cliff-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice, defaultClassPrices } from '../src/utils/simulation.js';
import { setNwrYieldChoke } from '../src/utils/market.js';

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
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
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

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { default: RoutePlanner } = await import('../src/components/RoutePlanner.jsx');
const { cliffFaresFor } = await import('../src/models/fareCliff.js');

// ── Fixture: a well-run route — top-tier hub, a new jet — so its real cliff
//    sits well above the 1.10x floor and the two readings can be told apart.
const HUB = 'SFO', DEST = 'SEA';
const JET = AIRCRAFT_TYPES
  .filter(t => !t.freighter && t.category === 'Narrow Body' && t.range > 3000
    && t.runwayFt <= Math.min(getAirport(HUB).runwayFt, getAirport(DEST).runwayFt))
  .sort((a, b) => (b.eis ?? 0) - (a.eis ?? 0))[0];
assert.ok(JET, 'no narrow-body for the fixture');
const CONFIG = { economy: JET.seats };

// Built ONCE: freshState() seeds random AI carriers, and a rival on SFO–SEA
// compresses the economy cliff 5% — two separate freshState() calls gave the
// planner and the Routes page different markets and a flaky $10 gap.
const BASE = freshState();
const save = () => ({
  ...BASE,
  phase: 'playing', week: 20, year: 2, hub: HUB, cash: 500_000_000,
  newWorldRestrictions: true,
  hubs: { [HUB]: { tier: 3, tierSince: 1 } },
  gates: { [HUB]: 40, [DEST]: 40 },
  fleet: [{ id: 'ac1', typeId: JET.id, name: 'A', tailNumber: 'N1', status: 'idle', ageWeeks: 0, ownershipType: 'owned', config: CONFIG }],
  routes: [], cargoRoutes: [], routePricing: {}, routeCatering: {},
});

const ref = defaultClassPrices(referencePrice(HUB, DEST));

// What the Routes page will say once this exact route is open on this tail.
setNwrYieldChoke(true);
const opened = gameReducer(save(), {
  type: 'ADD_ROUTE', origin: HUB, destination: DEST, aircraftId: 'ac1', weeklyFrequency: 7,
  ticketPrice: ref.economy, cateringLevel: freshState().defaultCateringLevel ?? 'standard', season: null,
});
assert.equal(opened.routes.length, 1, `fixture route did not open: ${opened.error ?? ''}`);
const routesPageCliff = cliffFaresFor(opened, HUB, DEST, { force: true }).economy;
const floorCliff = Math.floor(ref.economy * 1.10);

// RoutePlanner state: mode, origin, dest, selectedTypeId, frequency, fares, cateringLevel, season, cabinConfig
function renderPlanner(fares) {
  store.set('bbae_save_v2', JSON.stringify(save()));
  const slots = [null, { value: HUB }, { value: DEST }, { value: JET.id }, null, { value: fares }, null, null, { value: CONFIG }];
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(Seed, { slots }, React.createElement(RoutePlanner)))).replace(/<!-- -->/g, '');
}
const warnedAt = (html) => (html.match(/past the cliff \(\$(\d+)\)/) ?? [])[1];

console.log(`\n  fixture: ${JET.name} ${HUB}–${DEST} · economy ref $${ref.economy} · floor cliff $${floorCliff} · this route's cliff $${routesPageCliff}\n`);

test('fixture: the route\'s real cliff is clearly above the 1.10x floor', () => {
  assert.ok(routesPageCliff >= Math.floor(ref.economy * 1.15),
    `quality too low to separate the two readings ($${routesPageCliff} vs floor $${floorCliff}) — strengthen the fixture`);
});

test('a fare between the floor and the route\'s cliff is NOT flagged on the new-route form', () => {
  const fare = Math.round((floorCliff + routesPageCliff) / 2);
  const html = renderPlanner({ economy: fare });
  assert.ok(html.includes(`$${fare}`) || html.includes(`value="${fare}"`), 'seeded fare never reached the fare editor — harness broken');
  assert.equal(warnedAt(html), undefined,
    `the planner flags $${fare} as past the cliff, but the Routes page will not until $${routesPageCliff} `
    + `(planner said $${warnedAt(html)})`);
});

test('past the route\'s cliff, the planner warns at the same fare the Routes page will', () => {
  const fare = routesPageCliff + 25;
  const html = renderPlanner({ economy: fare });
  assert.equal(Number(warnedAt(html)), routesPageCliff,
    `planner cliff $${warnedAt(html)} ≠ Routes page cliff $${routesPageCliff}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
