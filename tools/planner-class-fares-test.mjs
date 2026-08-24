// Route Planner: every cabin gets a fare BEFORE the route opens.
//
// Reported by ASAS (Discord, 8/18–19/26):
//
//   "also pls add the fares in the route planning screen to tailwinds ...
//    what i meant with that is i wanted to be able to make all 4 classes prices
//    in the route planners section, not just the economy price ...
//    i still request for customization of all 4 class fares before creating the route"
//
// The premium cabins were never unpriced: ADD_ROUTE derived them from the economy
// fare through defaultClassPrices (1.4× / 2.5× / 5×) and the player could reprice
// them on the Routes tab a moment later. What was missing was any say in the ratio
// at the moment that matters — the forecast on the planner screen was computed at
// the derived fares, so the numbers a player decided on were never the numbers
// they had chosen.
//
// Two halves have to hold together or the feature is cosmetic:
//
//   · the REDUCER must accept action.classPrices and seed state.routePricing from
//     it (clamped per class), instead of re-deriving everything from economy
//   · the PLANNER must render one fare field per cabin the aircraft actually has,
//     and hand those fares to ADD_ROUTE
//
// The clamp case matters on its own: fares are capped at 3× the class reference,
// and a UI that clamps while the reducer does not is a UI a crafted action walks
// straight past.
//
//   node --import ./tools/_register-loader.mjs tools/planner-class-fares-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import {
  referencePrice, maxClassPrice, defaultClassPrices, routePairKey,
} from '../src/utils/simulation.js';
import { referenceClassPrices, CLASS_ORDER } from '../src/components/FareEditor.jsx';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';

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

// ── Hook seeding (see route-planner-render-test for the full rationale) ───────
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
        seed.seen[i] = typeof initial === 'function' ? initial() : initial;
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

// RoutePlanner's leading state block, in source order. SSR runs no effects, so
// cabinConfig — which the component normally fills from the selected aircraft in
// an effect — has to be seeded here or every render is all-economy and a suite
// about FOUR cabins would silently only ever prove one.
const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId', 'frequency', 'fares',
                    'cateringLevel', 'season', 'cabinConfig', 'configSource'];
const CABIN_SLOT = SLOT_NAMES.indexOf('cabinConfig');
let lastSeed = null;
function Seed({ slots, children }) { seed = { i: 0, slots, seen: [] }; lastSeed = seed; return children; }

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

// ── Fixture ──────────────────────────────────────────────────────────────────
// A wide-body big enough to carry a real four-cabin layout on a lane it clears
// with room to spare, so nothing here can fail for a range reason.
const HUB = 'JFK', DEST = 'LHR', SPOKE = 'ORD';
for (const c of [HUB, DEST, SPOKE]) assert.ok(getAirport(c), `${c} missing from the airport data`);
const LANE = Math.round(referencePrice(HUB, DEST) > 0 ? 5570 : 5570);

const jet = AIRCRAFT_TYPES
  .filter(t => !t.freighter && t.seats >= 250 && t.range >= 7000)
  .sort((a, b) => b.range - a.range)[0];
assert.ok(jet, 'no long-range wide-body in the aircraft data to build a four-cabin fixture');

// A genuine four-cabin layout — the exact case the reporter was asking about.
const FOUR_CABIN = {
  firstClass: 8, businessClass: 40, premiumEconomy: 30,
  economy: Math.max(40, jet.seats - 8 * 4 - 40 * 3 - 30 * 2),
  seatQuality: 'standard', serviceQuality: 'standard',
};

const tail = (id, tailNumber, config) => ({
  id, tailNumber, name: `Tail ${tailNumber}`, typeId: jet.id,
  status: 'idle', ageWeeks: 52, ownershipType: 'owned', rangeMod: 1.0, config,
});

const baseSave = (config) => ({
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 20, [DEST]: 20, [SPOKE]: 20 },
  fleet: [tail('ac1', 'N1FOUR', config)],
  routes: [], cargoRoutes: [], routePricing: {}, routeCatering: {},
});

const refFares = referenceClassPrices(HUB, DEST);

console.log('\nRoute Planner — per-cabin fares before the route opens (ASAS, 8/18–19/26)\n');
console.log(`  fixture: ${jet.name} · ${HUB}–${DEST} · reference `
  + CLASS_ORDER.map(c => `${c} $${refFares[c]}`).join('  ') + '\n');

console.log('── 1. ADD_ROUTE honours the fares it is handed ──────────');

const addAction = (classPrices) => ({
  type: 'ADD_ROUTE', origin: HUB, destination: DEST, aircraftId: 'ac1',
  weeklyFrequency: 7, ticketPrice: classPrices?.economy ?? refFares.economy,
  classPrices, cateringLevel: 'full', season: null,
});

test('every cabin lands in routePricing exactly as set', () => {
  const chosen = {
    economy:        refFares.economy + 40,
    premiumEconomy: refFares.premiumEconomy + 90,
    businessClass:  refFares.businessClass - 150,
    firstClass:     refFares.firstClass + 300,
  };
  const next = gameReducer(baseSave(FOUR_CABIN), addAction(chosen));
  assert.equal(next.routes.length, 1, 'the route did not open at all');
  const priced = next.routePricing[routePairKey(HUB, DEST)];
  assert.ok(priced, 'no pricing was seeded for the pair');
  for (const cls of CLASS_ORDER) {
    assert.equal(priced[cls], chosen[cls],
      `${cls} was not stored as chosen — ADD_ROUTE is still re-deriving the premium cabins `
      + `from the economy fare (got ${priced[cls]}, expected ${chosen[cls]})`);
  }
});

test('the premium cabins are NOT just multiples of economy', () => {
  // Guards the case above against a false pass: if the fixture happened to pick
  // fares that equal defaultClassPrices, storing the derived set would look right.
  const chosen = {
    economy:        refFares.economy + 40,
    premiumEconomy: refFares.premiumEconomy + 90,
    businessClass:  refFares.businessClass - 150,
    firstClass:     refFares.firstClass + 300,
  };
  const derived = defaultClassPrices(chosen.economy);
  assert.notDeepEqual(
    CLASS_ORDER.map(c => chosen[c]), CLASS_ORDER.map(c => derived[c]),
    'the fixture fares coincide with the derived ones — pick different figures');
});

test('a caller that sends no classPrices behaves exactly as before', () => {
  const next = gameReducer(baseSave(FOUR_CABIN), addAction(undefined));
  const priced = next.routePricing[routePairKey(HUB, DEST)];
  assert.deepEqual(priced, defaultClassPrices(refFares.economy),
    'the economy-only path must still derive the premium cabins — old saves and any '
    + 'caller that has not been updated depend on it');
});

test('an over-cap fare is clamped by the REDUCER, not just the input box', () => {
  const cap = maxClassPrice(referencePrice(HUB, DEST), 'businessClass');
  const next = gameReducer(baseSave(FOUR_CABIN), addAction({
    ...refFares, businessClass: cap * 10,
  }));
  const priced = next.routePricing[routePairKey(HUB, DEST)];
  assert.equal(priced.businessClass, cap,
    'a fare past the 3× class ceiling was stored raw — the UI clamp is not a guard');
});

console.log('\n── 2. The planner renders a fare field per cabin ─────────');

function renderPlanner(save, config) {
  store.set('bbae_save_v2', JSON.stringify(save));
  const slots = new Array(SLOT_NAMES.length).fill(null);
  slots[1] = { value: HUB };
  slots[2] = { value: DEST };
  slots[3] = { value: jet.id };
  slots[CABIN_SLOT] = { value: config };
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots },
        React.createElement(RoutePlanner)))).replace(/<!-- -->/g, '');
}

// The fare fields are the only inputs on the screen carrying a class fare cap in
// their title. Matching on that rather than on type="number" keeps the cabin
// LAYOUT panel — which lists every class, including ones with zero seats — from
// being mistaken for the fare editor.
const fareInputsIn = (h) => h.match(/<input[^>]*title="Max \$[^"]*"[^>]*>/g) ?? [];

let html;
test("the harness is seeding RoutePlanner's own state slots", () => {
  html = renderPlanner(baseSave(FOUR_CABIN), FOUR_CABIN);
  assert.ok(lastSeed, 'seed wrapper never ran');
  const seen = lastSeed.seen;
  assert.equal(seen[0], 'passenger', 'slot 0 is not `mode`');
  assert.deepEqual(seen[5], {}, 'slot 5 is not the `fares` override map — re-point the slot indices');
  assert.equal(seen[CABIN_SLOT], null, 'slot 8 is not `cabinConfig` — re-point the slot indices');
  assert.ok(html.includes('Your estimated economics'), 'the economics card never rendered');
});

test('all four cabins get their own fare input', () => {
  for (const [cls, label] of [['firstClass', 'First'], ['businessClass', 'Business'],
                              ['premiumEconomy', 'Premium Eco'], ['economy', 'Economy']]) {
    assert.ok(html.includes(label),
      `${label} has no fare field in the planner — only the economy fare is settable before the route opens`);
    assert.ok(html.includes(`(${FOUR_CABIN[cls]} seats)`),
      `${label}'s seat count is missing, so the field is not bound to the real cabin`);
  }
  assert.equal(fareInputsIn(html).length, 4,
    `expected exactly four fare inputs, found ${fareInputsIn(html).length}`);
});

test('each field is seeded with that cabin\'s reference fare', () => {
  for (const cls of CLASS_ORDER) {
    assert.ok(html.includes(`value="${refFares[cls]}"`),
      `${cls} does not open at its reference fare ($${refFares[cls]}) — the editor and `
      + 'defaultClassPrices disagree about what "reference" means');
  }
});

console.log('\n── 3. Only cabins that exist are priced ─────────────────');

test('an all-economy layout shows one fare, not four', () => {
  const ECON = { firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: jet.seats,
                 seatQuality: 'standard', serviceQuality: 'standard' };
  const econHtml = renderPlanner(baseSave(ECON), ECON);
  const inputs = fareInputsIn(econHtml);
  assert.equal(inputs.length, 1,
    `a cabin with no seats was given a fare field (${inputs.length} fare inputs on an `
    + 'all-economy layout) — the editor is not reading the cabin');
  assert.ok(inputs[0].includes(`max="${maxClassPrice(referencePrice(HUB, DEST), 'economy')}"`),
    'the one surviving field is not the economy fare');
});

console.log('\n── 4. A pair already flown shows its shared fares ───────');

test('the second aircraft on a pair inherits, and cannot re-set, the fares', () => {
  const pairKey = routePairKey(HUB, DEST);
  const flown = {
    ...baseSave(FOUR_CABIN),
    fleet: [tail('ac1', 'N1FOUR', FOUR_CABIN), tail('ac2', 'N2FOUR', FOUR_CABIN)],
    routes: [{ id: 'r1', origin: HUB, destination: DEST, stops: [HUB, DEST], aircraftId: 'ac1',
               weeklyFrequency: 7, weeksOpen: 20, hub: HUB, cateringLevel: 'full' }],
    routePricing: { [pairKey]: { ...refFares, businessClass: refFares.businessClass + 275 } },
    routeCatering: { [pairKey]: 'full' },
  };
  const sharedHtml = renderPlanner(flown, FOUR_CABIN);
  assert.match(sharedHtml, /this pair is already flown/,
    'the planner must say the fares are shared, not silently offer an editor whose values are ignored');
  assert.ok(sharedHtml.includes(`$${refFares.businessClass + 275}`),
    "the pair's live business fare is not shown — the player is repricing blind");
});

console.log('\n── 5. The fare panel forecast follows the draft ────────');

// The Routes-tab fare panel prints "At these fares — projected load … break-even …
// → +$X/wk" off projectRouteAddition. Fares belong to the PAIR
// (state.routePricing), and the projection's own offer builder reads that map
// first — correctly, it is the single source of truth — so a draft fare has to be
// layered onto the state handed to the projection or it never reaches the pooled
// demand at all. When it doesn't, the panel is a constant: dragging economy from
// half to two-and-a-half times reference moves load, passengers and profit by
// exactly nothing, under a caption claiming otherwise.
test('halving and multiplying the draft fares moves the projection', () => {
  const key = routePairKey(HUB, DEST);
  const flying = { ...tail('ac1', 'N1FOUR', FOUR_CABIN), status: 'assigned' };
  const state = {
    ...baseSave(FOUR_CABIN),
    fleet: [flying],
    routes: [{ id: 'r1', origin: HUB, destination: DEST, stops: [HUB, DEST], aircraftId: 'ac1',
               weeklyFrequency: 7, weeksOpen: 20, hub: HUB, cateringLevel: 'full' }],
    routePricing: { [key]: { ...refFares } },
    routeCatering: { [key]: 'full' },
  };
  const at = (fares) => {
    const proj = projectRouteAddition(state, {
      origin: HUB, destination: DEST, aircraft: flying, weeklyFrequency: 7,
      classPrices: fares, ticketPrice: fares.economy,
      cateringLevel: 'full', season: null, replacesRouteId: 'r1',
    });
    assert.ok(proj?.mature, 'the projection returned nothing');
    return proj.mature;
  };
  const scale = (f) => Object.fromEntries(
    Object.entries(refFares).map(([k, v]) => [k, Math.max(1, Math.round(v * f))]));

  const cheap = at(scale(0.5));
  const dear  = at(scale(2.5));

  assert.notEqual(cheap.revenue, dear.revenue,
    'revenue is identical at half fares and at 2.5x — the draft never reached the projection, '
    + 'so the fare editor is forecasting the fares the route already flies');
  assert.ok(dear.passengers < cheap.passengers,
    `raising every fare 5x did not cost a single passenger (${cheap.passengers} -> ${dear.passengers}) `
    + '— demand is not seeing the draft price');
  assert.ok(dear.loadFactor < cheap.loadFactor - 0.01,
    `load factor barely moved (${cheap.loadFactor.toFixed(4)} -> ${dear.loadFactor.toFixed(4)}) `
    + 'across a 5x fare swing');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
