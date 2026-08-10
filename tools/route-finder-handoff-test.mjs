// The Route Finder is a screen you can leave empty-handed.
//
// Reported in Discord (gravgor, on the planner's finder panel):
//   "what's the point with preselecting something user don't have? i don't
//    think so its good idea, its way more confusing"
//   "maybe you can just separate these two things? Explicitly planning the
//    route and just investigating what will be better"
//
// Two defects, one cause. The finder lived INSIDE the Route Planner, so looking
// up where the demand was put you inside the flow that commits an aircraft to a
// lane — and the planner underneath had already answered the question you had
// not asked, preselecting the first type in the CATALOGUE that could reach the
// route. That is almost never a plane the player owns, so the forecast read as
// a recommendation and the Open Route button under it could not fire.
//
// This suite pins both halves of the fix:
//   1. the two screens are actually separate — neither planner imports its
//      finder any more, and the finder screen renders no commit UI at all;
//   2. the handoff between them is opt-in and one-shot (utils/navIntent.js);
//   3. the planner's default aircraft is one you OWN and can fly today, with
//      the rest of the catalogue kept in the picker under its own heading.
//
// Test 3 is the one that fails on the old code: seeded with no aircraft type,
// the old planner picked reachableTypes[0] and rendered "No <type> in your
// fleet — lease one from the Market first" where the Open Route button belongs.
//
//   node --import ./tools/_register-loader.mjs tools/route-finder-handoff-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { distanceKm } from '../src/utils/simulation.js';
import {
  requestNav, peekNavFilter, consumeNavFilter, clearNavIntent,
} from '../src/utils/navIntent.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, 'src', p), 'utf8');

// Minimal browser shims for SSR (effects don't run, but init reads localStorage
// and requestNav dispatches a window event).
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
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

console.log('\nRoute Finder — a screen you can leave empty-handed\n');

// ── 1. The two screens are separate ─────────────────────────────────────────
console.log('── 1. Searching a market is not the start of a form ─────');

test('the passenger planner no longer mounts the finder', () => {
  const s = src('components/RoutePlanner.jsx');
  assert.ok(!/from '\.\/RouteFinder\.jsx'/.test(s),
    'RoutePlanner still imports RouteFinder — the search panel is back inside the commit flow');
  assert.ok(!s.includes('<RouteFinder'), 'RoutePlanner still renders <RouteFinder>');
});

test('the freight planner no longer mounts the cargo finder', () => {
  const s = src('components/CargoRoutePlanner.jsx');
  assert.ok(!/from '\.\/CargoRouteFinder\.jsx'/.test(s),
    'CargoRoutePlanner still imports CargoRouteFinder');
  assert.ok(!s.includes('<CargoRouteFinder'), 'CargoRoutePlanner still renders <CargoRouteFinder>');
});

test('the finder screen owns both finders', () => {
  const s = src('components/RouteFinderScreen.jsx');
  assert.ok(s.includes("from './RouteFinder.jsx'"), 'passenger finder missing from the screen');
  assert.ok(s.includes("from './CargoRouteFinder.jsx'"), 'cargo finder missing from the screen');
});

test('the shell renders it as its own tab', () => {
  const s = src('App.jsx');
  assert.match(s, /finder:\s*<RouteFinderScreen \/>/, 'no finder tab in App.jsx tabContent');
  assert.match(s, /id: 'finder'/, "no 'finder' entry in TABS");
  // nav-hints-test pins the label/group; here we only care that it is reachable.
});

// ── 2. The handoff is opt-in and one-shot ───────────────────────────────────
console.log('\n── 2. "Plan" hands over a pair, and only when clicked ───');

test('nothing is parked until Plan is clicked', () => {
  clearNavIntent();
  assert.equal(peekNavFilter('planner'), null, 'an intent existed before anything was clicked');
});

test('a picked pair reaches the planner exactly once', () => {
  clearNavIntent();
  requestNav('planner', { filter: { mode: 'passenger', origin: 'JFK', dest: 'LAX' } });
  const taken = consumeNavFilter('planner');
  assert.deepEqual(taken, { mode: 'passenger', origin: 'JFK', dest: 'LAX' });
  assert.equal(consumeNavFilter('planner'), null,
    're-reading returned the pair again — a later manual visit would reload an old search');
});

test('peeking leaves the pair for whoever consumes it', () => {
  // The planner peeks first: a freight pick only tells it which MODE to switch
  // into, and CargoRoutePlanner — which does not exist yet at that moment — is
  // the component that must actually take the airports.
  clearNavIntent();
  requestNav('planner', { filter: { mode: 'freight', origin: 'JFK', dest: 'FRA' } });
  const peeked = peekNavFilter('planner');
  assert.equal(peeked.mode, 'freight');
  assert.deepEqual(consumeNavFilter('planner'), peeked,
    'the peek swallowed the intent — the freight planner would arrive with no airports');
  assert.equal(peekNavFilter('planner'), null, 'consume did not clear it');
});

test('a pair parked for the planner is invisible to other tabs', () => {
  clearNavIntent();
  requestNav('planner', { filter: { mode: 'passenger', origin: 'JFK', dest: 'LAX' } });
  assert.equal(peekNavFilter('routes'), null);
  assert.equal(consumeNavFilter('fleet'), null);
});

test('both planners are wired to that mechanism', () => {
  // SSR runs no effects, so the mount-time read itself can't be rendered here.
  const p = src('components/RoutePlanner.jsx');
  const c = src('components/CargoRoutePlanner.jsx');
  assert.ok(p.includes("peekNavFilter('planner')"), 'RoutePlanner does not peek at the parked pair');
  assert.ok(p.includes("consumeNavFilter('planner')"), 'RoutePlanner never consumes the parked pair');
  assert.ok(c.includes("consumeNavFilter('planner')"), 'CargoRoutePlanner never consumes the parked pair');
});

// ── 3. The finder screen renders as a browser, not a form ───────────────────
console.log('\n── 3. The finder screen commits nothing ─────────────────');

const HUB = 'JFK', DEST = 'LAX';
for (const c of [HUB, DEST]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteFinderScreen = (await import('../src/components/RouteFinderScreen.jsx')).default;
const RoutePlanner      = (await import('../src/components/RoutePlanner.jsx')).default;

const dist = Math.round(distanceKm(getAirport(HUB), getAirport(DEST)));
const reachable = AIRCRAFT_TYPES.filter(t => t.range >= dist);
const ownedType = [...reachable].reverse().find(t => !t.freighter);
assert.ok(reachable.length >= 2 && ownedType, 'need at least two types able to reach JFK–LAX');
assert.notEqual(reachable[0].id, ownedType.id,
  'fixture is vacuous: the owned type is already the catalogue default, so the old bug ' +
  'would pass this suite. Pick a different pair or type.');

const SAVE = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 10, [DEST]: 10 },
  fleet: [{
    id: 'ac_free', tailNumber: 'N3FREE', name: 'Tail N3FREE', typeId: ownedType.id,
    status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: ownedType.seats },
  }],
  routes: [],
  cargoRoutes: [],
};

function render(el) {
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  return renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
}

let finderHtml;
test('the finder opens expanded on its own screen', () => {
  finderHtml = render(React.createElement(RouteFinderScreen));
  assert.ok(finderHtml.includes('Where is the demand?'), 'the screen intro is missing');
  assert.ok(finderHtml.includes('Sort by'), 'the finder rendered collapsed — its controls are absent');
  assert.match(finderHtml, /unserved route/, 'no results table: the scan never ran');
  assert.ok(!finderHtml.includes('▾ Show'),
    'the show/hide toggle is still there — on its own tab there is nothing to unfold');
});

test('it renders no part of the commit flow', () => {
  // The whole point: searching by demand must not hand you an aircraft, a
  // frequency and a fare you never asked for.
  for (const forbidden of ['Your estimated economics', 'Aircraft type', 'Flights / week', 'Open Route']) {
    assert.ok(!finderHtml.includes(forbidden),
      `the finder screen still renders "${forbidden}" — the planner leaked back in`);
  }
});

test('the planner offers the finder rather than assuming it', () => {
  const empty = render(React.createElement(RoutePlanner));
  assert.ok(empty.includes('Select two airports to analyse a route'), 'planner not on its empty state');
  assert.ok(empty.includes('Browse the Route Finder'),
    'the empty planner gives no route back to the finder');
});

// ── 4. The default aircraft is one you own ──────────────────────────────────
console.log('\n── 4. The picker starts on a plane you actually have ────');

// RoutePlanner's origin/dest/type are local useState and SSR fires no onChange,
// so the only way to render a chosen route is to substitute those slots' initial
// values. Same harness as route-planner-render-test.mjs: wrap React's hook
// dispatcher, seed RoutePlanner's leading useState block, disarm after it.
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
  configurable: true,
  get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;

const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId'];
const EXPECTED_INITIALS = ['passenger', '', '', ''];
let lastSeed = null;
function Seed({ slots, children }) {
  seed = { i: 0, slots, seen: [] };
  lastSeed = seed;
  return children;
}

// selectedTypeId left at '' — exactly what a player has when they arrive on a
// route, and the moment the planner picks a type FOR them.
function renderPlannerOnRoute() {
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  const slots = [null, { value: HUB }, { value: DEST }, null];
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots },
        React.createElement(RoutePlanner)))).replace(/<!-- -->/g, '');
}

let plannerHtml;
test('the harness is seeding the slots it thinks it is', () => {
  plannerHtml = renderPlannerOnRoute();
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, SLOT_NAMES.length), EXPECTED_INITIALS,
    `RoutePlanner's leading useState block changed — expected [${SLOT_NAMES}] to start as ` +
    `${JSON.stringify(EXPECTED_INITIALS)} but saw ${JSON.stringify(lastSeed.seen.slice(0, 4))}`);
  assert.ok(plannerHtml.includes('Your estimated economics'), 'the economics card never rendered');
});

test('the preselected type is the one in the fleet, not the catalogue default', () => {
  assert.ok(plannerHtml.includes('Open Route with N3FREE'),
    'the planner did not default to the owned aircraft — it preselected a type the player ' +
    `does not have (the catalogue's first reachable type is ${reachable[0].name}, the fleet ` +
    `holds a ${ownedType.name})`);
  assert.ok(!/lease one from the Market first/.test(plannerHtml),
    'the confirm panel is telling the player to go leasing on a route they can already fly');
});

// Matched on the <optgroup> markup, not on the words: the picker's own tooltip
// quotes both headings, so a substring search would pass on the tooltip alone.
const OPTGROUPS = () => [...plannerHtml.matchAll(/<optgroup label="([^"]+)"/g)].map(m => m[1]);

test('the rest of the catalogue is still offered, under its own heading', () => {
  // Separating the two questions is not the same as hiding the answer to one:
  // "what should I order for this lane?" is a real reason to be here.
  const groups = OPTGROUPS();
  assert.ok(groups.includes('In your fleet'), `no owned-aircraft group in the picker (saw ${groups.join(', ')})`);
  assert.ok(groups.includes('Not in your fleet'), `the catalogue was dropped from the picker (saw ${groups.join(', ')})`);
  assert.match(plannerHtml, /lease required/,
    'unowned types are listed without saying what flying one would take');
});

test('an unowned type is a choice, not the starting point', () => {
  const groups = OPTGROUPS();
  assert.equal(groups[0], 'In your fleet',
    'the catalogue group is rendered above your own aircraft');
  const inFleetAt   = plannerHtml.indexOf('<optgroup label="In your fleet"');
  const catalogueAt = plannerHtml.indexOf('<optgroup label="Not in your fleet"');
  const ownedAt     = plannerHtml.indexOf(ownedType.name);
  assert.ok(ownedAt > inFleetAt && ownedAt < catalogueAt,
    `the owned ${ownedType.name} is not listed under "In your fleet"`);
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
