// Rival dedupe — one airline, one offer in the share fight.
//
// buildRivalViews publishes every other active player TWICE: once as a dossier
// row in `competitors` (with routes[pairKey] populated) and once as a per-pair
// offer spec in `humanRivals[pairKey]`. simulateRoute used to concatenate the
// two lists blind, so computeMarketShare scored one rival as two airlines —
// measured at a 33–42% traffic loss for every player on every contested pair,
// with world-wide booked passengers exceeding the demand pool.
//
// The dedupe already existed in the PREVIEW helper (pairShare.buildRivalPairOffers,
// "already counted via humanRivals"); the tick never got it, so the preview and
// the tick disagreed by the same third.
//
// Direction matters and is source-dependent:
//   • state.humanRivals — the spec IS the authoritative representation of a real
//     player on a pair (their real fares, quality, brandReach, lounge network,
//     frequency-blended seats). The dossier row is the thinner of the two, so
//     the SPEC wins and the competitor row is skipped.
//   • state.encroachments — a synthetic AI entrant ramping into a pair. If the
//     named carrier already flies the pair, its scheduled route is its real
//     capacity and the SPEC is the stand-in, so the CARRIER wins.
//
//   node tools/rival-dedupe-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { buildRivalViews, withRivals, pairKeyOf } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { rivalOffersFor } from '../packages/engine/src/utils/simulation.js';
import { buildRouteMarket } from '../packages/engine/src/models/demand.js';
import { pairMarketShare } from '../packages/engine/src/models/pairShare.js';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;

// Ask the engine which type may legally fly the fixture pair rather than
// guessing off array order — see the note in headwinds-rivals-test.mjs.
const shortHaul = AIRCRAFT_TYPES.find((t) =>
  !t.freighter && t.range > 800 && t.seats >= 50
  && !checkRouteRestrictions('JFK', 'BOS', 300, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(shortHaul, 'no aircraft type in engine data can legally fly JFK–BOS');

const KEY = pairKeyOf('JFK', 'BOS');

function makeAirline({ id, name, hub, dest, fare, tails = 1, freq = 14 }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
  // Lease every tail FIRST, one per millisecond.
  //
  // uid() is `Date.now().toString(36) + '-' + Math.random()...`, and this file
  // pins Math.random to a constant for tick determinism — so two leases inside
  // one millisecond produce the SAME aircraft id. ADD_ROUTE then refuses the
  // second tail as already assigned with a bare `return state` and no error,
  // which reads as an engine regression and isn't one.
  for (let i = 0; i < tails; i++) {
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
    const ms = Date.now();
    while (Date.now() === ms) { /* next tail gets its own id */ }
  }
  const tailIds = [...new Set(s.fleet.map((a) => a.id))];
  assert.equal(tailIds.length, tails, `${name}: expected ${tails} distinct tails, got ${tailIds.length}`);
  tailIds.forEach((aircraftId, i) => {
    s = gameReducer(s, {
      type: 'ADD_ROUTE', aircraftId, origin: hub, destination: dest, weeklyFrequency: freq,
    });
    assert.equal(s.routes.length, i + 1, `${name}: route ${i} not created (${s.error ?? 'no error'})`);
  });
  for (const r of s.routes) {
    s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: r.id, ticketPrice: fare });
  }
  return { id, worldId: 'w1', name, hub, status: 'ACTIVE', state: s };
}

// Player pax on the fixture pair after one real ADVANCE_WEEK.
//
// routeResults rows are keyed by `routeId` and carry no origin/destination, so
// the pair has to be resolved back through the state's own route list.
function paxAfterTick(state) {
  const next = gameReducer(state, { type: 'ADVANCE_WEEK' });
  const onPair = new Set((next.routes ?? state.routes ?? [])
    .filter((r) => pairKeyOf(r.origin, r.destination) === KEY)
    .map((r) => r.id));
  const rows = (next.lastReport?.routeResults ?? []).filter((r) => onPair.has(r.routeId));
  assert.ok(rows.length, 'no route result for the fixture pair');
  return rows.reduce((n, r) => n + (r.passengers ?? 0), 0);
}

function fixture({ tails = 1 } = {}) {
  const alice = makeAirline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dest: 'BOS', fare: 170, tails });
  const bob   = makeAirline({ id: 'a2', name: 'Bravo Air', hub: 'JFK', dest: 'BOS', fare: 150 });
  const views = buildRivalViews([alice, bob]);
  const view  = views.get('a1');
  assert.ok(view, 'no rival view for Alice');
  // The premise of the whole file: buildRivalViews really does publish Bob twice.
  assert.equal(view.competitors.length, 1, 'expected Bob as a competitor row');
  assert.equal(view.competitors[0].human, true, 'competitor row is not flagged human');
  assert.equal((view.humanRivals[KEY] ?? []).length, 1, 'expected Bob as a humanRivals spec');
  assert.equal(view.competitors[0].id, view.humanRivals[KEY][0].competitorId,
    'the two publications must share an id or no dedupe can key on it');
  return { alice, bob, view };
}

// ── 1. Single-aircraft path ───────────────────────────────────────────────────

// Control: the SAME world, with the rival's dossier row left in place (so every
// other effect of the competitor bank is identical) but its route on the pair
// removed, so only the spec can produce an offer. Zeroing `competitors` instead
// would also move alliance/positioning terms and muddy the comparison.
function specOnlyView(view, key) {
  return {
    ...view,
    competitors: view.competitors.map((c) => {
      if (!c.human || !c.routes?.[key]) return c;
      const routes = { ...c.routes };
      delete routes[key];
      return { ...c, routes };
    }),
  };
}

test('a human rival published in both lists is scored ONCE (single aircraft)', () => {
  const { alice, view } = fixture();
  const both = paxAfterTick(withRivals(alice.state, view));
  const specOnly = paxAfterTick(withRivals(alice.state, specOnlyView(view, KEY)));
  assert.equal(both, specOnly,
    `rival counted twice: ${both} pax with both publications vs ${specOnly} with the spec alone`);
});

test('the dedupe keeps the rival — it does not drop them entirely', () => {
  const { alice, view } = fixture();
  const contested = paxAfterTick(withRivals(alice.state, view));
  const alone = paxAfterTick(withRivals(alice.state, { competitors: [], humanRivals: {} }));
  assert.ok(contested < alone * 0.95,
    `a contested pair must carry materially fewer pax than a monopoly (${contested} vs ${alone})`);
});

// ── 2. Pooled multi-aircraft path ─────────────────────────────────────────────

test('a human rival is scored ONCE on the pooled multi-aircraft path', () => {
  const { alice, view } = fixture({ tails: 2 });
  assert.equal(alice.state.routes.length, 2, 'fixture should have two tails on the pair');
  const both = paxAfterTick(withRivals(alice.state, view));
  const specOnly = paxAfterTick(withRivals(alice.state, specOnlyView(view, KEY)));
  assert.equal(both, specOnly,
    `pooled path counted the rival twice: ${both} vs ${specOnly}`);
});

// ── 3. No coverage is lost when a spec is missing ─────────────────────────────

test('a human competitor with no spec on the pair is still counted', () => {
  const { alice, view } = fixture();
  const rowOnly = paxAfterTick(withRivals(alice.state, { ...view, humanRivals: {} }));
  const alone = paxAfterTick(withRivals(alice.state, { competitors: [], humanRivals: {} }));
  assert.ok(rowOnly < alone * 0.95,
    `dropping the dossier row must not exempt a rival with no spec (${rowOnly} vs monopoly ${alone})`);
});

// ── 4. The preview and the tick agree ─────────────────────────────────────────

test('pairMarketShare agrees with the tick on how many rivals contest the pair', () => {
  const { alice, view } = fixture();
  const state = withRivals(alice.state, view);
  const share = pairMarketShare(state, 'JFK', 'BOS');
  const rivals = (share?.results ?? share?.shares ?? []).filter((r) => r.airlineId !== 'player');
  assert.equal(rivals.length, 1,
    `the share preview sees ${rivals.length} rivals where the world holds 1`);
});

// ── 5. Solo encroachment keeps the opposite precedence ────────────────────────

test('an encroachment spec naming a carrier already flying the pair is dropped', () => {
  const market = buildRouteMarket('JFK', 'BOS', { year: 2026, month: 6, week: 1 });
  const carrier = {
    id: 'ai7', name: 'Sample Air', tier: 'legacy', qualityScore: 60,
    routes: { [KEY]: { frequency: 21, priceMultiplier: 0.95, seatsPerFlight: 180, seatsPerWeek: 3780 } },
  };
  const spec = {
    competitorId: 'ai7', name: 'Sample Air', tier: 'legacy', qualityScore: 60,
    frequency: 7, priceMultiplier: 0.9, seatsPerFlight: 180,
  };
  const offers = rivalOffersFor([carrier], [spec], market);
  assert.equal(offers.length, 1,
    `a carrier and the synthetic entrant naming it must publish one offer, got ${offers.length}`);
});

test('an encroachment spec naming a carrier NOT on the pair still contests it', () => {
  const market = buildRouteMarket('JFK', 'BOS', { year: 2026, month: 6, week: 1 });
  const carrier = { id: 'ai7', name: 'Sample Air', tier: 'legacy', qualityScore: 60, routes: {} };
  const spec = {
    competitorId: 'ai7', name: 'Sample Air', tier: 'legacy', qualityScore: 60,
    frequency: 7, priceMultiplier: 0.9, seatsPerFlight: 180,
  };
  assert.equal(rivalOffersFor([carrier], [spec], market).length, 1);
});

test('two distinct rivals still produce two offers', () => {
  const market = buildRouteMarket('JFK', 'BOS', { year: 2026, month: 6, week: 1 });
  const a = {
    id: 'ai7', name: 'Sample Air', tier: 'legacy', qualityScore: 60,
    routes: { [KEY]: { frequency: 21, priceMultiplier: 0.95, seatsPerFlight: 180, seatsPerWeek: 3780 } },
  };
  const spec = {
    competitorId: 'ai9', name: 'Other Air', tier: 'budget', qualityScore: 50,
    frequency: 7, priceMultiplier: 0.9, seatsPerFlight: 180,
  };
  assert.equal(rivalOffersFor([a], [spec], market).length, 2);
});

Math.random = realRandom;
console.log(`\nrival dedupe: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
