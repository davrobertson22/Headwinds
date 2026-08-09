// Route Planner: the fleet <option> labels and the confirm panel must actually RENDER.
//
// Production bug (grey screen, "ReferenceError: reserveOptionTag is not defined"):
// RoutePlanner.jsx used TWO things out of ReserveNotice.jsx — `reserveOptionTag(a)`
// in the cabin-source <option> labels and `<ReserveNotice>` in the confirm panel —
// and imported NEITHER. Both live on paths that only execute once the player has
// picked a route AND owns an aircraft of the selected type: `fleetOptions.map`
// never runs on an empty fleet-of-type list, which is exactly why the reporter
// saw it only "selecting an aircraft type in my fleet".
//
// Four suites already touched RoutePlanner and all four missed it:
//   · route-config-test        — imports the module, calls exported helpers only
//   · route-projection-test    — pure engine maths, never imports the component
//   · ui-smoke-test            — renders <RoutePlanner/> with origin/dest unset,
//                                so `ready` is false and the whole economics card
//                                (config panel + confirm panel) is never emitted
//   · reserve-deploy-warning   — renders ReserveNotice standalone, then greps
//                                RoutePlanner.jsx as TEXT for the identifier —
//                                a match a missing import cannot fail
//
// So this suite drives the planner into the state the player was in: a real
// route selected, a real aircraft type selected, and a tail of that type IN THE
// FLEET and ON RESERVE. Seeding happens through React's own hook dispatcher (SSR
// runs no effects and dispatches no events, so the useState slots are the only
// way in) and every seeded slot's real initial value is asserted, so reordering
// the state block in RoutePlanner fails here loudly instead of silently rendering
// the empty-fleet path again.
//
//   node --import ./tools/_register-loader.mjs tools/route-planner-render-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';

// Minimal browser shims for SSR (effects don't run, but init reads localStorage).
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

// ── Hook seeding ─────────────────────────────────────────────────────────────
// RoutePlanner takes no props: origin, destination and aircraft type are local
// useState. renderToString never runs effects or fires onChange, so the only way
// to render the planner as a player sees it is to substitute the initial values
// of those slots. We do that by wrapping React's current hook dispatcher rather
// than by patching the `useState` export, so the component under test is the
// real, unmodified module.
//
// `seed` is armed by the <Seed> wrapper immediately above <RoutePlanner> and
// disarms itself after RoutePlanner's own leading useState block, so no child
// component's state is touched.
const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
assert.ok(RCD, 'React 18 hook dispatcher not reachable — this harness needs updating');

let seed = null;
let rawDispatcher = RCD.current;
let liveDispatcher = null;

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
  configurable: true,
  get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;

// RoutePlanner's leading state block, in source order. Slots we override carry a
// `value`; the rest are here purely so their real initial value can be checked.
const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId'];
const EXPECTED_INITIALS = ['passenger', '', '', ''];

let lastSeed = null;
function Seed({ slots, children }) {
  seed = { i: 0, slots, seen: [] };
  lastSeed = seed;
  return children;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const jets = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range);
const jet   = jets[0];                                   // the type the player OWNS
const other = jets.find(t => t.id !== jet.id && t.range >= jet.range * 0.75);
assert.ok(jet && other, 'need two distinct long-range passenger types in the data');

const HUB = 'JFK', DEST = 'LAX', SPOKE = 'ORD';
for (const c of [HUB, DEST, SPOKE]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

const tail = (id, tailNumber, extra = {}) => ({
  id, tailNumber, name: `Tail ${tailNumber}`, typeId: jet.id,
  status: 'idle', ageWeeks: 52, ownershipType: 'owned',
  config: { economy: jet.seats }, ...extra,
});

// The reporter's save: a tail of the selected type in the fleet, stationed as a
// reserve at the hub, with a same-type sister flying a route off that hub (so the
// notice has real coverage to quote rather than the "nothing to cover" branch).
const OWNED_SAVE = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 10, [DEST]: 10, [SPOKE]: 10 },
  fleet: [
    tail('ac_res', 'N1RSV', { reserveBase: HUB }),
    tail('ac_line', 'N2LINE', { status: 'assigned' }),
  ],
  routes: [
    { id: 'r1', origin: HUB, destination: SPOKE, aircraftId: 'ac_line',
      weeklyFrequency: 4, weeksOpen: 20, hub: HUB, ticketPrice: 260, cateringLevel: 'full' },
  ],
  cargoRoutes: [],
};

// Control: same world, but the selected type is one the player owns nothing of.
const UNOWNED_SAVE = { ...OWNED_SAVE };

function renderPlanner(save, typeId) {
  store.set('bbae_save_v2', JSON.stringify(save));
  const slots = [null, { value: HUB }, { value: DEST }, { value: typeId }];
  const html = renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots },
        React.createElement(RoutePlanner))));
  return html.replace(/<!-- -->/g, '');
}

console.log('\nRoute Planner render — fleet options + confirm panel\n');

console.log('── 0. The harness is seeding the slots it thinks it is ──');
let ownedHtml;
test('seeded state slots are RoutePlanner\'s mode/origin/dest/selectedTypeId', () => {
  ownedHtml = renderPlanner(OWNED_SAVE, jet.id);
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, SLOT_NAMES.length), EXPECTED_INITIALS,
    `RoutePlanner's leading useState block changed — expected [${SLOT_NAMES}] to start as ` +
    `${JSON.stringify(EXPECTED_INITIALS)} but saw ${JSON.stringify(lastSeed.seen.slice(0, 4))}. ` +
    'Re-point the slot indices or this suite silently renders the empty-fleet path again.');
});

test('the seeded route actually reaches the economics card', () => {
  // Without this the rest is vacuous: everything below lives inside `ready &&
  // routeData &&`, and an unseeded planner renders only the empty state.
  assert.ok(!ownedHtml.includes('Select two airports to analyse a route'),
    'planner still on the empty state — seeding did not take');
  assert.ok(ownedHtml.includes('Your estimated economics'), 'economics card rendered');
  assert.ok(ownedHtml.includes('Cabin configuration'), 'cabin config panel rendered');
});

console.log('\n── 1. reserveOptionTag inside fleetOptions.map ──────────');
test('the owned tail is offered as a cabin-config source', () => {
  assert.ok(ownedHtml.includes('Your aircraft of this type'),
    'the fleet optgroup is missing — fleetOptions was empty, so the crashing map never ran');
  assert.ok(ownedHtml.includes('N1RSV'), 'the reserve tail is listed as an option');
});

test('the reserve tag TEXT is present in the option label', () => {
  // Hard-coded, not recomputed through reserveOptionTag(): asserting against the
  // helper would keep passing if the helper were stubbed to ''. This is the exact
  // string the crashing call produces.
  assert.match(ownedHtml, /ON RESERVE @ JFK/,
    'reserveOptionTag output missing from the rendered <option> labels');
});

test('the tag is attached to the reserve tail, not floating somewhere else', () => {
  const options = ownedHtml.match(/<option[^>]*>[\s\S]*?<\/option>/g) ?? [];
  const withTag = options.filter(o => o.includes('ON RESERVE @ JFK'));
  assert.equal(withTag.length, 1, `expected exactly one tagged <option>, got ${withTag.length}`);
  assert.ok(withTag[0].includes('N1RSV'), 'the tagged option is the reserve tail');
});

test('a non-reserve tail of the same type is offered WITHOUT the tag', () => {
  const options = ownedHtml.match(/<option[^>]*>[\s\S]*?<\/option>/g) ?? [];
  const line = options.find(o => o.includes('N2LINE'));
  assert.ok(line, 'the second owned tail is missing from the source list');
  assert.ok(!line.includes('ON RESERVE'), 'a line aircraft must not be tagged as a reserve');
});

console.log('\n── 2. <ReserveNotice> in the confirm panel ──────────────');
// The SECOND undefined identifier in the same file, on a different branch: it
// only renders when the tail the Open Route button would reach for is a reserve.
const RESERVE_ONLY_SAVE = {
  ...OWNED_SAVE,
  fleet: [tail('ac_res', 'N1RSV', { reserveBase: HUB }), tail('ac_line', 'N2LINE', { status: 'assigned' })],
  routes: [
    // The line tail is pinned to a lane that does NOT touch JFK–LAX, so it is
    // ineligible here and the reserve becomes the preferred aircraft.
    { id: 'r1', origin: SPOKE, destination: 'DFW', aircraftId: 'ac_line',
      weeklyFrequency: 4, weeksOpen: 20, hub: HUB, ticketPrice: 260, cateringLevel: 'full' },
  ],
};

let reserveHtml;
test('the confirm panel renders the reserve callout', () => {
  reserveHtml = renderPlanner(RESERVE_ONLY_SAVE, jet.id);
  assert.ok(reserveHtml.includes('One-time launch cost'), 'the confirm panel rendered at all');
  assert.match(reserveHtml, /N1RSV<\/strong> is on reserve at JFK/,
    'ReserveNotice output missing — the confirm panel never rendered the callout');
  assert.match(reserveHtml, /takes it off standby/, 'the callout names the consequence');
});

console.log('\n── 3. Control: a type the player owns NONE of ───────────');
// The reporter: "the error doesn't occur selecting an aircraft type NOT in my
// fleet." That is the path every existing suite already covered, so it must keep
// rendering — and it must NOT show the tag, or case 1 would be trivially true.
test('a type with no owned tails still renders the planner', () => {
  const html = renderPlanner(UNOWNED_SAVE, other.id);
  assert.ok(html.includes('Your estimated economics'), 'economics card rendered');
  assert.ok(html.includes('Cabin configuration'), 'cabin config panel rendered');
  assert.ok(!html.includes('Your aircraft of this type'),
    'no fleet optgroup expected for a type the player owns none of');
  assert.ok(!html.includes('ON RESERVE @'),
    'the reserve tag must be absent here — case 1 would otherwise prove nothing');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
