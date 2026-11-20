// Aircraft you can pre-order belong in the Route Finder and the Route Planner.
//
// Discord (Nilla_wafer, 2026-11-16, "Route Finder should include aircraft that
// are preorderable?"): "Annoying going to look at routes for new aircraft but
// can't find it in the drop down."
//
// In an era world a type is announced two years before it enters service. In
// production-line worlds launch customers may order it in the first 26 weeks
// (data/productionLines.js launchWindow); in every era world it is then open to
// preorders until the first delivery (data/preorders.js preorderWindow). Every
// aircraft picker filtered on aircraftOrderable(), which is false until the
// type flies, so the finder could not forecast the aircraft the Market was
// asking you to commit to, and "Plan" silently swapped it for another type.
//
// This suite pins the fix:
//   1. preorderOpen() is the one answer to "can I order this before it flies";
//   2. both finders list such types under their own heading, labelled with the
//      first delivery, and say "pre-order only" instead of "lease required";
//   3. both planners keep the type the finder handed over, never pick one as
//      their default, and say plainly that it does not fly yet;
//   4. a classic game is unchanged; an era world without lines offers its
//      preorders the same way.
//
//   node --import ./tools/_register-loader.mjs tools/finder-preorder-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType, aircraftOrderable } from '../src/data/aircraft.js';
import { launchWindow } from '../src/data/productionLines.js';
import { preorderOpen } from '../src/data/preorders.js';
import { calendarYear } from '../src/utils/simulation.js';
import { rememberFinder, finderMemoryKey, clearFinderMemory } from '../src/utils/finderMemory.js';

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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteFinder       = (await import('../src/components/RouteFinder.jsx')).default;
const CargoRouteFinder  = (await import('../src/components/CargoRouteFinder.jsx')).default;
const RoutePlanner      = (await import('../src/components/RoutePlanner.jsx')).default;
const CargoRoutePlanner = (await import('../src/components/CargoRoutePlanner.jsx')).default;

const HUB = 'JFK', DEST = 'LHR';
const PAX = 'b7779x', FRT = 'a350f';   // both enter service in 2027
const PRE_GROUP = 'Pre-order — not flying yet';

const base = (over = {}) => ({
  ...freshState(), phase: 'playing', airlineName: 'Pre Air', hub: HUB, cash: 2_000_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } }, gates: { [HUB]: 10, [DEST]: 10 },
  fleet: [], routes: [], cargoRoutes: [], competitors: [], ...over,
});
// Week 5 of 2025: the 2027 types were announced in week 1 and their launch
// window runs 26 weeks.
const linesEra = (over = {}) => base({ productionLinesWorld: true, productionLineScale: 1, startYear: 2025, year: 1, week: 5, ...over });

function render(save, el) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
}
const groups = (html) => [...html.matchAll(/<optgroup label="([^"]+)"/g)].map(m => m[1]);
const groupBody = (html, label) => {
  const i = html.indexOf(`<optgroup label="${label}"`);
  if (i < 0) return '';
  return html.slice(i, html.indexOf('</optgroup>', i));
};
// The aircraft <select>: the one holding the "Not in your fleet" heading (every
// screen here has other selects — region, sort, cabin presets).
const aircraftSelect = (html) => {
  const g = html.indexOf('<optgroup label="Not in your fleet"');
  if (g < 0) return '';
  const a = html.lastIndexOf('<select', g);
  return html.slice(a, html.indexOf('</select>', g));
};
const selectedOption = (html) => (aircraftSelect(html).match(/<option[^>]*value="([^"]+)"[^>]*selected=""/) ?? [])[1] ?? null;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

console.log('\nPre-order aircraft in the Route Finder and Route Planner\n');

// ── 1. The rule ─────────────────────────────────────────────────────────────
console.log('── 1. preorderOpen ──────────────────────────────────────');

test('a type in its launch window is open for pre-order, with its first delivery', () => {
  const s = linesEra();
  for (const id of [PAX, FRT]) {
    const t = getAircraftType(id);
    assert.equal(aircraftOrderable(t, calendarYear(s)), false, `${id} should not be orderable before it flies`);
    assert.ok(launchWindow(s, t)?.open, `fixture: ${id}'s launch window is not open at 2025 W5`);
    const p = preorderOpen(s, t);
    assert.ok(p, `${id} is not open for pre-order`);
    assert.equal(p.kind, 'launch');
    assert.equal(p.label, `January ${t.eis}`);
  }
});

test('after the launch window, and without lines, it is a preorder until first delivery', () => {
  const t = getAircraftType(PAX);
  for (const s of [linesEra({ week: 40 }), linesEra({ productionLinesWorld: false })]) {
    const p = preorderOpen(s, t);
    assert.ok(p, 'not open for preorder');
    assert.equal(p.kind, 'preorder');
    assert.equal(p.label, `January ${t.eis}`);
  }
});

test('a revealed programme delay moves the first delivery on the label', () => {
  const p = preorderOpen(linesEra({ week: 40, programmeDelays: { [PAX]: { weeks: 13 } } }), getAircraftType(PAX));
  assert.equal(p?.label, 'April 2027');
});

test('closed in classic games, before the announcement, and once it delivers', () => {
  const t = getAircraftType(PAX);
  assert.equal(preorderOpen(base(), t), null, 'open in a classic game');
  assert.equal(preorderOpen(linesEra({ startYear: 2023, year: 1, week: 30 }), t), null, 'open before the announcement');
  assert.equal(preorderOpen(linesEra({ year: 3, week: 2 }), t), null, 'still open after first delivery');
});

// ── 2. The finders ──────────────────────────────────────────────────────────
console.log('\n── 2. The finders list them ─────────────────────────────');

test('the passenger finder lists a pre-order type under its own heading', () => {
  const html = render(linesEra(), React.createElement(RouteFinder, { standalone: true }));
  assert.ok(groups(html).includes(PRE_GROUP), `no "${PRE_GROUP}" group (saw ${groups(html).join(', ')})`);
  const body = text(groupBody(html, PRE_GROUP));
  assert.ok(body.includes(getAircraftType(PAX).name), `${PAX} missing from the pre-order group: ${body}`);
  assert.match(body, /from January 2027/, 'the first delivery is not shown on the row');
  assert.ok(!body.includes(getAircraftType(FRT).name), 'a freighter leaked into the passenger finder');
});

test('the freight finder lists a pre-order freighter under its own heading', () => {
  const html = render(linesEra(), React.createElement(CargoRouteFinder, { standalone: true }));
  const body = text(groupBody(html, PRE_GROUP));
  assert.ok(body.includes(getAircraftType(FRT).name), `${FRT} missing from the freight finder: ${body || '(no group)'}`);
  assert.match(body, /from January 2027/);
});

test('picking it says "pre-order only", not "lease required"', () => {
  // Arrive with it selected, the way a returning player does: the finder keeps
  // its last search per airline and hub (utils/finderMemory.js).
  const s = linesEra();
  clearFinderMemory();
  rememberFinder(finderMemoryKey(s, 'passenger'), { typeId: PAX });
  const html = render(s, React.createElement(RouteFinder, { standalone: true }));
  clearFinderMemory();
  assert.equal(selectedOption(html), PAX, 'the remembered pre-order type was not selected');
  const t = text(html);
  assert.match(t, /pre-order only, first deliveries January 2027/, 'the hint under the picker does not say it is a pre-order');
  assert.ok(!/lease required/.test(t.slice(t.indexOf(getAircraftType(PAX).runwayFt.toLocaleString()))),
    'the hint still says "lease required" for an aircraft no lessor carries');
});

test('a classic game is unchanged: no pre-order heading', () => {
  const html = render(base(), React.createElement(RouteFinder, { standalone: true }));
  assert.ok(!groups(html).includes(PRE_GROUP), 'a classic game grew a pre-order group');
  assert.ok(text(groupBody(html, 'Not in your fleet')).includes(getAircraftType(PAX).name),
    'the classic catalogue lost a type');
});

test('an era world without production lines offers its preorders the same way', () => {
  const html = render(linesEra({ productionLinesWorld: false }), React.createElement(RouteFinder, { standalone: true }));
  assert.match(text(groupBody(html, PRE_GROUP)), new RegExp(`${getAircraftType(PAX).name}.*from January 2027`));
});

test('before the announcement it is not offered at all', () => {
  const html = render(linesEra({ startYear: 2023, week: 30 }), React.createElement(RouteFinder, { standalone: true }));
  assert.ok(!text(html).includes(getAircraftType(PAX).name), `${PAX} offered before it was announced`);
});

// ── 3. The planners ─────────────────────────────────────────────────────────
console.log('\n── 3. The planners keep it ──────────────────────────────');

// RoutePlanner's mode/origin/dest/type are local useState and SSR runs no
// effects, so seed those slots (same harness as route-finder-handoff-test).
const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
let seed = null, rawDispatcher = RCD.current, liveDispatcher = null;
function wrapDispatcher(d) {
  if (!d) return d;
  const w = Object.create(Object.getPrototypeOf(d));
  Object.assign(w, d);
  w.useState = function (initial) {
    if (seed) {
      const i = seed.i++;
      if (i < seed.slots.length) { const slot = seed.slots[i]; if (slot) return d.useState(slot.value); }
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
function Seed({ slots, children }) { seed = { i: 0, slots }; return children; }
function renderSeeded(save, Comp, slots) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(Seed, { slots }, React.createElement(Comp)))).replace(/<!-- -->/g, '');
}

test('the passenger planner keeps a pre-order type handed over from the finder', () => {
  const html = renderSeeded(linesEra(), RoutePlanner,
    [null, { value: HUB }, { value: DEST }, { value: PAX }]);
  assert.ok(html.includes('Your estimated economics'), 'the planner did not reach its economics card');
  assert.equal(selectedOption(html), PAX, 'the planner swapped the pre-order type for another');
  assert.ok(groups(html).includes(PRE_GROUP), 'the planner has no pre-order heading');
  assert.match(text(html), /does not fly yet/, 'the planner does not say the type is not flying yet');
  assert.ok(!/lease one from the Market first/.test(html), 'it tells the player to lease an aircraft no lessor carries');
});

test('the passenger planner never defaults to a pre-order type', () => {
  const html = renderSeeded(linesEra(), RoutePlanner, [null, { value: HUB }, { value: DEST }, null]);
  const sel = selectedOption(html);
  assert.ok(sel, 'nothing selected');
  assert.ok(!preorderOpen(linesEra(), getAircraftType(sel)), `the default pick ${sel} is a pre-order type`);
});

test('the freight planner keeps a pre-order freighter and labels it', () => {
  const html = renderSeeded(linesEra(), CargoRoutePlanner, [{ value: HUB }, { value: DEST }, { value: FRT }]);
  if (!html.includes(getAircraftType(FRT).name)) throw new Error('freight planner did not render the freighter picker (slot order changed?)');
  assert.ok(groups(html).includes(PRE_GROUP), 'the freight planner has no pre-order heading');
  assert.match(text(groupBody(html, PRE_GROUP)), /pre-order, from January 2027/);
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
