// The fare editor has to answer the question it is asked.
//
// projectRouteAddition takes the draft fares the player is dragging and hands
// them to simulateRoute as `route.classPrices`. But the POOLED offer that
// decides how many passengers the pair wins is built by buildPlayerPairOffer,
// which read `state.routePricing[key]` first — the fare the pair is flying
// TODAY. routePricing is the declared single source of truth for fares (it is
// written on every ADD_ROUTE and routes are hydrated from it), so that read
// never fell through to the preview route's own prices.
//
// On a pair with one tail it did not matter: simulateRoute runs its own demand
// path and prices off the route. On a pair with TWO OR MORE tails the projection
// slices a demandOverride out of the pooled result, so the passenger count was
// frozen at the stored fare and simulateRoute simply multiplied it by the draft
// one. Dragging economy from $120 to $700 left pax at 460 and load at 17.4%
// while revenue rose exactly linearly — the panel promised unbounded profit from
// raising fares, on the one screen whose entire job is "what does this fare do?".
//
// Fares in this game belong to the PAIR, not the route (ADD_ROUTE writes
// routePricing[pairKey], and every tail on the pair flies that price). So a
// draft fare has to be previewed as the pair's fare — for the pooled offer, for
// every other tail on the lane, and for the route being edited.
//
//   node tools/pair-fare-preview-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { projectRouteAddition, pairKeyOf } from '../packages/engine/src/models/pairShare.js';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;

const O = 'JFK', D = 'LAX';
const KEY = pairKeyOf(O, D);

const STORED = 300;

const type = AIRCRAFT_TYPES.find((t) =>
  !t.freighter && t.range > 800 && t.seats >= 50
  && t.range > 4500
  && !checkRouteRestrictions(O, D, 3980, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(type, 'no aircraft type can legally fly the fixture pair');

// `tails` routes on one pair, all priced at STORED.
function airline(tails) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Fare Air', hub: O, enableObjectives: false });
  // Keep freshState()'s carrier bank: an uncontested monopoly takes a different
  // branch through computeMarketShare, and the fare editor's job is hardest on a
  // pair somebody else is already flying.
  s = { ...s, multiplayer: true, humanRivals: {}, encroachments: {} };
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: D });
  // One reducer id per millisecond, for BOTH aircraft and routes.
  //
  // uid() is `Date.now().toString(36) + '-' + Math.random()...` and this file
  // pins Math.random for determinism, so anything created inside one
  // millisecond shares an id. Two colliding aircraft ids make ADD_ROUTE refuse
  // the second tail outright; two colliding ROUTE ids are nastier, because the
  // routes are created fine and only projectRouteAddition notices — its
  // `r.id !== replacesRouteId` filter then drops BOTH tails, `others` comes back
  // empty, the pooled path never runs, and this whole file passes against the
  // bug it exists to catch.
  const tick = () => { const ms = Date.now(); while (Date.now() === ms) { /* wait */ } };
  for (let i = 0; i < tails; i++) {
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: type.id });
    tick();
  }
  const ids = [...new Set(s.fleet.map((a) => a.id))];
  assert.equal(ids.length, tails, `expected ${tails} distinct tails, got ${ids.length}`);
  ids.forEach((aircraftId, i) => {
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId, origin: O, destination: D, weeklyFrequency: 14 });
    assert.equal(s.routes.length, i + 1, `route ${i} not created (${s.error ?? 'no error'})`);
    tick();
  });
  assert.equal(new Set(s.routes.map((r) => r.id)).size, tails, 'route ids collided');
  for (const r of s.routes) {
    s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: r.id, ticketPrice: STORED });
  }
  // The reducer clamps a fare to a band around the reference price, so read back
  // what it actually stored rather than asserting the number we asked for.
  const stored = s.routePricing?.[KEY]?.economy;
  assert.ok(stored > 0, 'fixture did not store a pair fare');
  return { state: s, stored };
}

// Preview the route at `draft` while the pair is stored at STORED.
function preview(state, draft) {
  const route = state.routes[0];
  const aircraft = state.fleet.find((a) => a.id === route.aircraftId);
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft,
    weeklyFrequency: route.weeklyFrequency,
    classPrices: { economy: draft },
    ticketPrice: draft,
    cateringLevel: route.cateringLevel,
    season: route.season,
    replacesRouteId: route.id,
  });
  assert.ok(proj?.mature, `no projection at draft ${draft}`);
  return { ...proj.mature, _shared: proj.shared, _pairRouteCount: proj.pairRouteCount };
}

// ── 1. The draft fare moves demand ────────────────────────────────────────────

for (const tails of [1, 2, 3]) {
  test(`draft fares move passengers on a ${tails}-tail pair`, () => {
    const { state: s } = airline(tails);
    const rows = [120, 200, 300, 450, 700].map((f) => ({ f, ...preview(s, f) }));
    // Guard the fixture itself: if the pair stopped reading as shared, the
    // pooled path this test exists to cover never ran and a pass means nothing.
    assert.equal(rows[0]._pairRouteCount, tails,
      `fixture degenerated: projection sees ${rows[0]._pairRouteCount} routes on a ${tails}-tail pair`);
    assert.equal(rows[0]._shared, tails > 1);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].passengers <= rows[i - 1].passengers,
        `pax rose with fare: $${rows[i - 1].f}→${rows[i - 1].passengers}, $${rows[i].f}→${rows[i].passengers}`);
    }
    assert.ok(rows[0].passengers > rows[rows.length - 1].passengers,
      `pax did not move at all across a 5.8x fare range (${rows.map(r => r.passengers).join(', ')})`);
  });
}

test('revenue is not exactly linear in the draft fare on a shared pair', () => {
  const { state: s, stored } = airline(2);
  const a = preview(s, 150);
  const b = preview(s, 600);
  // Linear revenue is the signature of a frozen passenger count.
  assert.notEqual(Math.round(b.revenue / a.revenue), 4,
    `revenue scaled exactly 4x with a 4x fare — the pax count is frozen (${a.revenue} → ${b.revenue})`);
});

// ── 2. The preview responds to the DRAFT, not to what is stored ───────────────

test('the preview tracks the draft fare, not the stored one', () => {
  const { state: s, stored } = airline(2);
  const atDraft = preview(s, 150);
  // Same draft, but the pair stored at a different fare: the projection must not
  // move, because the player is asking about $150 either way.
  const s2 = { ...s, routePricing: { ...s.routePricing, [KEY]: { ...s.routePricing[KEY], economy: 450 } } };
  const atOtherStored = preview(s2, 150);
  assert.equal(atDraft.passengers, atOtherStored.passengers,
    `the preview moved with the STORED fare (${atDraft.passengers} vs ${atOtherStored.passengers})`);
});

// ── 3. Agreement with the tick ────────────────────────────────────────────────

test('the previewed fare change is what the tick then books', () => {
  const { state: s, stored } = airline(2);
  const DRAFT = 480;
  const projected = preview(s, DRAFT);

  // Apply the same fare for real and run the week. Fares are per-pair, so one
  // UPDATE_TICKET_PRICE reprices every tail on the lane.
  let after = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: s.routes[0].id, ticketPrice: DRAFT });
  assert.equal(after.routePricing[KEY].economy, DRAFT);
  const ticked = gameReducer({ ...after, routes: after.routes.map(r => ({ ...r, weeksOpen: 26 })) },
    { type: 'ADVANCE_WEEK' });
  const row = (ticked.lastReport?.routeResults ?? []).find((r) => r.routeId === s.routes[0].id);
  assert.ok(row, 'no route result for the edited route');

  const drift = Math.abs(row.passengers - projected.passengers) / Math.max(1, row.passengers);
  assert.ok(drift < 0.05,
    `preview and tick disagree by ${(drift * 100).toFixed(1)}%: preview ${projected.passengers} pax, tick ${row.passengers}`);
});

// ── 4. Nothing changes when there is no draft to honour ───────────────────────

test('omitting classPrices still prices off the pair', () => {
  const { state: s, stored } = airline(2);
  const route = s.routes[0];
  const aircraft = s.fleet.find((a) => a.id === route.aircraftId);
  const bare = projectRouteAddition(s, {
    origin: O, destination: D, aircraft,
    weeklyFrequency: route.weeklyFrequency,
    replacesRouteId: route.id,
  });
  const atStored = preview(s, stored);
  assert.ok(bare?.mature, 'no projection without classPrices');
  assert.equal(bare.mature.passengers, atStored.passengers,
    'previewing the stored fare must equal previewing nothing at all');
});

test('a brand-new pair is unaffected (no stored fare to override)', () => {
  const { state: s } = airline(1);
  const aircraft = s.fleet[0];
  const cheap = projectRouteAddition(s, {
    origin: O, destination: 'ORD', aircraft, weeklyFrequency: 7,
    classPrices: { economy: 120 }, ticketPrice: 120,
  });
  const dear = projectRouteAddition(s, {
    origin: O, destination: 'ORD', aircraft, weeklyFrequency: 7,
    classPrices: { economy: 480 }, ticketPrice: 480,
  });
  assert.ok(cheap?.mature && dear?.mature, 'no projection on an unserved pair');
  assert.ok(cheap.mature.passengers > dear.mature.passengers,
    'an unserved pair must still respond to fare');
});

Math.random = realRandom;
console.log(`\npair fare preview: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
