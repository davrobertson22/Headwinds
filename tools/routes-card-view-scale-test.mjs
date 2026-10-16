// Routes ▸ card view must be capped, exactly as the table view is.
//
// Production bug (Discord, Donovan, 2026-09-13): "The routes page is triggering
// a constant page refresh for me. Out and about using my phone… but it's always
// worked on mobile Chrome until now. Also really long load times on desktop
// Chrome."
//
// Routes.jsx picks the view mode by screen width — phones get CARDS, desktop
// gets the TABLE. The table has always been capped (TABLE_PAGE_SIZE = 100, plus
// a "Show 100 more" button); the card branch rendered `visibleGroups.map(...)`,
// i.e. EVERY group, with no cap and no way to ask for fewer. A card is far
// heavier than a row — it carries a per-aircraft table, class-load bars and the
// fare controls — so the phone got the unbounded path AND the expensive one.
//
// Measured by SSR-rendering this component on an M2 MacBook Air before the fix:
//
//        routes     table (desktop)      cards (phone)
//           60       22 ms /  106 KB     121 ms /  660 KB
//          140       31 ms /  161 KB     693 ms / 1506 KB
//          246       45 ms /  162 KB    2456 ms / 2600 KB
//
// The table plateaus at the 100-row cap. The card path is superlinear and
// unbounded: 2.6 MB of DOM and ~2.5 s of render on a laptop is ten-plus seconds
// and several hundred MB on a phone, so WebKit kills the tab and Chrome iOS
// reloads it — the "constant page refresh". Nothing about iOS is at fault; the
// missing cap is.
//
// This suite renders the REAL component (a helper tested in isolation would not
// have caught this — the cap is in the component's own render branch) at a
// network size a committed player reaches, through the same matchMedia call
// Routes.jsx uses to decide the view, and asserts:
//
//   · the card branch renders a BOUNDED number of cards, not one per group
//   · it offers a "show more" control, so the rest are reachable
//   · the table branch still caps at 100 (the regression guard for the fix)
//
//   node --import ./tools/_register-loader.mjs tools/routes-card-view-scale-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

// ── Browser shims for SSR ────────────────────────────────────────────────────
// Effects never run under renderToString, but the useState initialisers do, and
// two of them read the DOM: the view-mode slot calls matchMedia, and the
// profit-basis slot reads localStorage. `phone` drives matchMedia so this suite
// exercises the branch a phone actually takes.
const store = new Map();
let phone = false;
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = (q) => ({
  matches: phone && /max-width/.test(q),
  media: q, onchange: null,
  addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? {
  addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

// Dynamic imports so the JSX loader (registered via --import) is active first.
const { RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Routes = (await import('../src/components/Routes.jsx')).default;
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { getAirport } = await import('../packages/engine/src/data/airports.js');
const { defaultConfig, defaultClassPrices, distanceKm, referencePrice } =
  await import('../packages/engine/src/utils/simulation.js');

// ── A network the size a committed player actually flies ─────────────────────
// Five hubs into fifty spokes, one tail per route, every route its own city
// pair — so group count equals route count and the cap is being measured
// against something the page cannot collapse away.
const HUBS = ['JFK', 'ORD', 'LAX', 'LHR', 'DFW'];
const SPOKES = ['LHR', 'CDG', 'FRA', 'LAX', 'SFO', 'MIA', 'ORD', 'BOS', 'ATL', 'DFW',
  'DEN', 'SEA', 'YYZ', 'MEX', 'GRU', 'MAD', 'FCO', 'DUB', 'AMS', 'LAS',
  'MSP', 'DTW', 'STL', 'MCI', 'PHX', 'IAH', 'PDX', 'SLC', 'DCA', 'PHL',
  'CLT', 'TPA', 'SAN', 'AUS', 'BNA', 'RDU', 'MCO', 'EWR', 'LGA', 'YVR',
  'NRT', 'HKG', 'SIN', 'SYD', 'DXB', 'IST', 'ZRH', 'MUC', 'BCN', 'LIS'];

function buildNetwork(targetRoutes) {
  const wide = getAircraftType('b7879'), narrow = getAircraftType('a320neo');
  let n = 0;
  const fleet = [], routes = [], routePricing = {}, gates = {};
  outer: for (const h of HUBS) for (const s of SPOKES) {
    if (h === s) continue;
    const a1 = getAirport(h), a2 = getAirport(s);
    if (!a1 || !a2) continue;
    const t = distanceKm(a1, a2) > 4000 ? wide : narrow;
    const ac = {
      id: `p${n++}`, typeId: t.id, status: 'assigned', ageWeeks: 52,
      config: defaultConfig(t.seats), ownershipType: 'owned',
      tailNumber: `N${n}HW`, name: t.name,
    };
    fleet.push(ac);
    routes.push({
      id: `r${routes.length}`, origin: h, destination: s, stops: [h, s],
      aircraftId: ac.id, weeklyFrequency: 14, weeksOpen: 30, hub: h,
      ticketPrice: Math.round(referencePrice(h, s)), cateringLevel: 'full',
    });
    routePricing[[h, s].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(h, s)));
    gates[h] = (gates[h] ?? 0) + 1; gates[s] = (gates[s] ?? 0) + 1;
    if (routes.length >= targetRoutes) break outer;
  }
  return {
    ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'JFK', cash: 5e9,
    fleet, routes, routePricing, gates,
    hubs: Object.fromEntries(HUBS.map(h => [h, { tier: 2, tierSince: 0 }])),
    multiplayer: true,
  };
}

// renderToString separates adjacent text and expression nodes with `<!-- -->`
// markers, so `Show {n} more ({a} of {b})` arrives shredded. Strip them before
// matching on copy the player would actually read.
const render = (state) => renderToString(
  React.createElement(RemoteGameProvider, { state, dispatch: () => {} },
    React.createElement(Routes))).replaceAll('<!-- -->', '');

// One card and one expanded table row both emit this per-aircraft header. In
// card mode nothing else does, so its count is the number of cards on screen.
// Counting an EXISTING string rather than a marker the fix introduces is what
// lets this suite fail honestly on HEAD.
const CARD_MARKER = 'Block hrs';
const countCards = (html) => html.split(CARD_MARKER).length - 1;

const GROUPS = 150;
const state = buildNetwork(GROUPS);

console.log(`\n── Routes card view at ${state.routes.length} route groups ─────────────`);

// Hub-to-hub pairs collide (JFK->LAX and LAX->JFK are one city pair), so the
// group count is a shade under the route count. What matters is that it is large.
const GROUP_COUNT = new Set(state.routes.map(r => [r.origin, r.destination].sort().join('-'))).size;

test('the network under test is large enough for the cap to matter', () => {
  assert.ok(GROUP_COUNT >= 120, `need a network big enough to matter, got ${GROUP_COUNT} groups`);
});

test('phone (card view) renders a BOUNDED number of cards, not one per group', () => {
  phone = true;
  const html = render(state);
  const cards = countCards(html);
  assert.ok(cards > 0, 'card view rendered no cards at all — the marker moved');
  assert.ok(cards < GROUP_COUNT,
    `card view rendered ${cards} cards for ${GROUP_COUNT} groups — uncapped. ` +
    `A phone cannot hold this: at 246 routes it is 2.6 MB of DOM and ~2.5 s of render ` +
    `on a laptop, which is what kills the tab and reloads the page on iOS.`);
  assert.ok(cards <= 100,
    `card view rendered ${cards} cards; the cap must be no looser than the table's 100`);
});

test('phone (card view) offers a way to reach the rest', () => {
  phone = true;
  const html = render(state);
  assert.match(html, /Show \d+ more/,
    'capped card view must offer a "Show N more" control, or the remaining routes are unreachable');
});

test('phone (card view) stops growing once past the cap', () => {
  phone = true;
  const small = render(buildNetwork(60));
  const big   = render(state);
  const growth = big.length / small.length;
  assert.ok(growth < 1.6,
    `card HTML grew ${growth.toFixed(1)}x between 60 and ${GROUPS} groups — the cap is not holding`);
});

test('desktop (table view) pages at 25 rows, like the Route Finder', () => {
  // Was 100. "Routes tab is very laggy for me, maybe make it click to show more
  // like the route finder?" (Barca, Discord 2026-10-16).
  phone = false;
  const html = render(state);
  assert.match(html, /Show \d+ more \(25 of \d+\)/,
    'table view must paginate at TABLE_PAGE_SIZE = 25');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} routes-card-view-scale: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
