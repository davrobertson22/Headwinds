// Route → Move: the aircraft picker must escape the table's scroll box.
//
// Player report (Knightmare, 2026-08-31): "if an aircraft is the bottom or only
// one on a route, clicking Move hides it under the list for the next route
// down." Every per-aircraft table on the Routes page — the card view AND the
// expanded table row — wraps its <table> in `<div style={{ overflowX: 'auto' }}>`
// so the wide table can scroll sideways on a phone. CSS will not give you
// overflow-x: auto with overflow-y: visible: the used overflow-y computes to
// auto too, so that wrapper clips vertically as well. The picker was a
// `position: absolute` box inside the row, so on any row but the last there was
// enough table below to hide the clip, and on the bottom (or only) aircraft it
// was sliced off at the wrapper's edge — the black smear in the report, sitting
// under the next route's card.
//
// The fix portals the menu to document.body and positions it `fixed` against
// the trigger's viewport rect, which escapes both the clip and any stacking
// context the card sets up. This suite pins both halves:
//
//   1. `reassignMenuPosition` — the pure placement rules (right-aligned to the
//      trigger, clamped inside the viewport, flipped ABOVE when the space below
//      is cramped, height capped to the space actually available).
//   2. The component really portals into document.body with position: fixed,
//      rather than rendering the menu inside the row again.
//
// VERIFIED FAILING ON HEAD (bc24ef6) via tools/_probe/reassign-clip-probe.mjs,
// which runs these same assertions against the pre-fix component (git show
// HEAD:src/components/ReassignRouteButton.jsx): 10 of 11 fail — no exported
// placement helper, zero createPortal calls, and a menu that comes back inline
// with position:absolute. The probe is throwaway; this suite is the standing
// check.
//
//   node --import ./tools/_register-loader.mjs tools/reassign-menu-anchor-test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { freshState } from '../packages/engine/src/reducer.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

// ── Browser shims ────────────────────────────────────────────────────────────
// SSR runs no effects, but the render path reads `document.body` for the portal
// container and the store's init reads localStorage.
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const BODY = { __tag: 'document.body' };
globalThis.document = globalThis.document ?? { body: BODY };

// ── Portal stub ──────────────────────────────────────────────────────────────
// react-dom/server throws on a real portal, so swap createPortal for a recorder
// BEFORE the component module is imported (its named import binds to whatever
// the CJS exports object holds at that moment). The menu then renders inline,
// where renderToString can see it, and every container it was aimed at is kept.
const require = createRequire(import.meta.url);
const reactDom = require('react-dom');
const realPortal = reactDom.createPortal;
const portalCalls = [];
reactDom.createPortal = function recordPortal(children, container) {
  portalCalls.push({ children, container });
  return children;
};

// ── Hook seeding ─────────────────────────────────────────────────────────────
// The picker's open/position state is local useState set from a click handler.
// renderToString fires no events, so the only way to render the menu OPEN is to
// substitute those slots' initial values — done by wrapping React's current
// dispatcher, so the component under test stays the real, unmodified module.
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
        if (seed.i >= seed.slots.length) seed = null;
        if (slot) return d.useState(slot.value);
        return d.useState(initial);
      }
      seed = null;
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

let lastSeed = null;
function Seed({ slots, children }) {
  seed = { i: 0, slots, seen: [] };
  lastSeed = seed;
  return children;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const jets = AIRCRAFT_TYPES.filter(t => !t.freighter && t.range > 3000).sort((a, b) => b.range - a.range);
const jet = jets[0];
assert.ok(jet, 'need a long-range passenger type in the data');

const HUB = 'JFK', DEST = 'LAX';
for (const c of [HUB, DEST]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const tail = (id, tailNumber, extra = {}) => ({
  id, tailNumber, name: `Tail ${tailNumber}`, typeId: jet.id,
  status: 'idle', ageWeeks: 52, ownershipType: 'owned',
  config: { economy: jet.seats }, ...extra,
});

const ROUTE = {
  id: 'r1', origin: HUB, destination: DEST, aircraftId: 'ac_on',
  weeklyFrequency: 3, weeksOpen: 20, hub: HUB, ticketPrice: 420, cateringLevel: 'full',
};

const SAVE = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 10, [DEST]: 10 },
  fleet: [tail('ac_on', 'N1ON', { status: 'assigned' }), tail('ac_spare', 'N2SPARE')],
  routes: [ROUTE],
  cargoRoutes: [],
};

const { GameProvider } = await import('../src/store/GameContext.jsx');
const mod = await import('../src/components/ReassignRouteButton.jsx');
const ReassignRouteButton = mod.default;
const { reassignMenuPosition } = mod;

console.log('\nReassign menu — anchoring and clip escape\n');

// ── 1. Placement rules ───────────────────────────────────────────────────────
console.log('── 1. reassignMenuPosition ───────────────────────────────');

const VIEW = { width: 1280, height: 800 };
const rectAt = (top, right, h = 22, w = 62) =>
  ({ top, bottom: top + h, right, left: right - w, width: w, height: h });

test('exists as a pure exported helper', () => {
  assert.equal(typeof reassignMenuPosition, 'function',
    'ReassignRouteButton must export reassignMenuPosition — the placement rules are not testable through the DOM here');
});

test('mid-page: drops below the trigger, right-aligned to it', () => {
  const p = reassignMenuPosition(rectAt(300, 900), VIEW);
  assert.equal(p.placement, 'below');
  assert.equal(p.top, 300 + 22 + 6, 'sits just under the button');
  assert.equal(p.left + p.width, 900, 'right edge lines up with the trigger');
});

test('bottom row: flips ABOVE instead of being cut off — the reported bug', () => {
  // The trigger is 40px off the bottom of the screen: below there is room for a
  // sliver, above there is 700px. The old absolute menu opened downward into
  // the clip; this one must go up.
  const p = reassignMenuPosition(rectAt(738, 900), VIEW);
  assert.equal(p.placement, 'above', 'menu opened downward off the bottom of the viewport');
  assert.ok(p.top + p.maxHeight <= 738 - 6 + 1, 'menu must clear the trigger it hangs off');
  assert.ok(p.top >= 8, 'menu must stay inside the viewport');
});

test('a mere 10px of extra room above does not make it flip', () => {
  // Flipping for a trivial gain is worse than scrolling in place.
  const p = reassignMenuPosition(rectAt(360, 900), VIEW);
  assert.equal(p.placement, 'below');
});

test('height is capped to the space the chosen side actually has', () => {
  const roomy = reassignMenuPosition(rectAt(100, 900), VIEW);
  assert.equal(roomy.maxHeight, 320, 'plenty of room — full 320px cap');
  const tight = reassignMenuPosition(rectAt(738, 900), VIEW);
  assert.ok(tight.maxHeight <= 738 - 6 - 8, `above-space cap not applied (${tight.maxHeight})`);
  assert.ok(tight.maxHeight >= 120, 'menu must not collapse to nothing');
});

test('narrow screens: clamped inside both edges rather than off-screen', () => {
  const phone = { width: 380, height: 720 };
  const p = reassignMenuPosition(rectAt(300, 372), phone);
  assert.ok(p.left >= 8, `left edge off-screen (${p.left})`);
  assert.ok(p.left + p.width <= phone.width - 8, 'right edge off-screen');
  const hugLeft = reassignMenuPosition(rectAt(300, 70), phone);
  assert.ok(hugLeft.left >= 8, `a left-hugging trigger pushed the menu off-screen (${hugLeft.left})`);
});

// ── 2. The component really portals ──────────────────────────────────────────
console.log('\n── 2. The rendered menu escapes the scroll box ───────────');

store.set('bbae_save_v2', JSON.stringify(SAVE));
portalCalls.length = 0;
const POS = { top: 412, left: 620, width: 280, maxHeight: 320, placement: 'below' };
const html = renderToString(
  React.createElement(GameProvider, null,
    React.createElement(Seed, { slots: [{ value: true }, { value: POS }] },
      React.createElement(ReassignRouteButton, { route: ROUTE })))
).replace(/<!-- -->/g, '');

test('the harness seeded the picker\'s own [open, pos] slots', () => {
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, 2), [false, null],
    `ReassignRouteButton's leading useState block changed — expected [open=false, pos=null] but saw ` +
    `${JSON.stringify(lastSeed.seen.slice(0, 2))}. Re-point the slot indices or this suite silently ` +
    'renders the closed button and asserts nothing.');
});

test('the menu actually rendered (seeding took)', () => {
  assert.ok(html.includes(`Move ${HUB}–${DEST} to`), 'menu header missing — the picker rendered closed');
  assert.ok(html.includes('N2SPARE') || html.includes('Tail N2SPARE'), 'the spare tail is offered');
});

test('it goes through a portal into document.body, not into the row', () => {
  assert.equal(portalCalls.length, 1, `expected exactly one createPortal call, got ${portalCalls.length} — ` +
    'an in-row menu is clipped by the table wrapper\'s overflowX:auto');
  assert.equal(portalCalls[0].container, BODY, 'portal must target document.body');
});

test('the menu box is position: fixed at the measured coordinates', () => {
  const menu = html.match(/<div[^>]*role="menu"[^>]*>/);
  assert.ok(menu, 'no role="menu" box in the output');
  const style = menu[0];
  assert.match(style, /position:\s*fixed/, 'an absolute menu is still clipped by the scroll box');
  assert.match(style, /top:\s*412px/, 'menu ignored the measured top');
  assert.match(style, /left:\s*620px/, 'menu ignored the measured left');
  assert.match(style, /max-height:\s*320px/, 'menu ignored the measured height cap');
});

test('nothing in the picker is absolutely positioned any more', () => {
  // The old markup was a position:relative span in the <td> holding a
  // position:absolute menu — exactly the shape the scroll box clips.
  assert.ok(!/position:\s*absolute/.test(html),
    'an absolutely-positioned box is still rendered by the picker — that is the shape that got clipped');
});

// ── Teardown ─────────────────────────────────────────────────────────────────
reactDom.createPortal = realPortal;

console.log(`\n${failed === 0 ? '✅' : '❌'} reassign menu: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
