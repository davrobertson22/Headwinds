// A decision reuses the rival views already derived from the cached rows.
//
// Every POST /decisions needs the rival view. The view cache is keyed on the
// world stamp, and the previous decision has always just moved it, so the
// decision path (which reuses the cached ROWS — rival-row-cache-test) re-ran
// the whole derivation over those same rows every time: every airline's view of
// every other airline, for one request. Measured 2026-11-10 on live-sized
// worlds: 0.4 s (Lunar Gateway) and 1.0–1.2 s (Scarce Assets) of synchronous
// work per decision, in the one API process that serves every world.
//
// The derivation is now remembered against the rows it was built from
// (humanRivals.mjs pricedViewsFor). What this pins:
//   • the second decision over the same rows does not derive again
//   • what it is handed is equal to a fresh derivation
//   • each call still gets its OWN view and competitor objects, because the
//     callers write the float pool / gate market onto them from fresh reads
//   • an alliance change, and a new row load, each derive again
//   • nothing in the engine writes on the shared (deeper) part of a view
//
//   node tools/rival-view-reuse-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import * as rivals from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';

const { buildWorldRivalViews, buildRivalViews, withRivals, stripRivals, rivalOverlay } = rivals;
const MAX = rivals.RIVAL_ROWS_MAX_STALE_MS ?? 60_000;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;

const shortHaul = AIRCRAFT_TYPES.find((t) =>
  !t.freighter && t.range > 800 && t.seats >= 50
  && !checkRouteRestrictions('JFK', 'BOS', 300, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(shortHaul, 'no aircraft type in engine data can legally fly JFK–BOS');

function airline({ id, name, hub, dest, fare }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[0].id, origin: hub, destination: dest, weeklyFrequency: 14 });
  assert.equal(s.routes.length, 1, `${name}: route not created (${s.error ?? 'no error'})`);
  s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: s.routes[0].id, ticketPrice: fare });
  return { id, worldId: 'w', name, hub, status: 'ACTIVE', restarts: 0, version: 1, shares: 1_000_000,
           account: { isOG: false, isSupporter: false, email: null }, state: stripRivals(s) };
}
const alice = airline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dest: 'BOS', fare: 170 });
const bob = airline({ id: 'a2', name: 'Bob Airways', hub: 'BOS', dest: 'JFK', fare: 150 });
const carol = airline({ id: 'a3', name: 'Carol Connect', hub: 'JFK', dest: 'BOS', fare: 160 });

function fakeDb(worldId, roster) {
  const db = {
    reads: 0, alliances: [], market: null,
    airline: { findMany: async () => { db.reads++; return roster(); } },
    alliance: { findMany: async () => db.alliances },
    world: { findUnique: async () => ({ id: worldId, tickConfig: {} }) },
    worldMarket: { findUnique: async () => db.market },
  };
  return db;
}
const decision = (stamp, id = 'a1') => ({ stamp, rowsMaxStaleMs: MAX, forAirlineId: id });
const overlayJson = (views) => JSON.stringify([...views].map(([id, v]) => [id, rivalOverlay(v)]));
// Has the derivation run again? Readable on any build: a re-derived view is
// made of new objects all the way down, a remembered one shares its depths.
const sharesDepths = (a, b) => a.get('a1').competitors[0].routes === b.get('a1').competitors[0].routes
  && a.get('a1').humanRivals === b.get('a1').humanRivals;

console.log('\n── rival views are derived once per row load ────────────');

await test('a second decision over the same rows does not derive the views again', async () => {
  const db = fakeDb('wReuse1', () => [alice, bob, carol]);
  const first = await buildWorldRivalViews(db, 'wReuse1', decision('7.3'));
  const second = await buildWorldRivalViews(db, 'wReuse1', decision('8.3'));
  const third = await buildWorldRivalViews(db, 'wReuse1', decision('9.3', 'a2'));
  assert.equal(db.reads, 1, 'precondition: the rows themselves are reused');
  assert.equal(second.fromCachedRows, true);
  assert.ok(sharesDepths(first, second) && sharesDepths(second, third), 'the views were derived again from the same rows');
});

await test('the derivation count says the same thing', async () => {
  if (typeof rivals.rivalViewDerivations !== 'function') throw new Error('rivalViewDerivations is not exported');
  const db = fakeDb('wReuse2', () => [alice, bob, carol]);
  const before = rivals.rivalViewDerivations();
  for (let v = 7; v < 27; v++) await buildWorldRivalViews(db, 'wReuse2', decision(`${v}.3`, v % 2 ? 'a1' : 'a2'));
  assert.equal(rivals.rivalViewDerivations() - before, 1, '20 decisions inside the row window must derive once');
});

await test('a remembered view equals a fresh derivation, for every airline', async () => {
  const roster = [alice, bob, carol];
  const db = fakeDb('wReuse3', () => roster);
  await buildWorldRivalViews(db, 'wReuse3', decision('7.3'));
  const remembered = await buildWorldRivalViews(db, 'wReuse3', decision('8.3'));
  // The same rows in a NEW array: a row set never seen before, so derived fresh.
  const fresh = await buildWorldRivalViews(db, 'wReuse3', { airlines: [...roster] });
  assert.equal(overlayJson(remembered), overlayJson(fresh));
  assert.equal(JSON.stringify([...remembered.keys()]), JSON.stringify([...fresh.keys()]));
  // …and equal to the bare derivation, before anything is attached.
  const bare = buildRivalViews([...roster], new Map());
  assert.equal(JSON.stringify(remembered.get('a1').humanRivals), JSON.stringify(bare.get('a1').humanRivals));
});

await test('each call gets its own view and competitor objects', async () => {
  const db = fakeDb('wReuse4', () => [alice, bob, carol]);
  await buildWorldRivalViews(db, 'wReuse4', decision('7.3'));
  const a = await buildWorldRivalViews(db, 'wReuse4', decision('8.3'));
  const b = await buildWorldRivalViews(db, 'wReuse4', decision('9.3'));
  assert.notEqual(a.get('a1'), b.get('a1'), 'the view object itself must not be shared between calls');
  assert.notEqual(a.get('a1').competitors, b.get('a1').competitors);
  assert.notEqual(a.get('a1').competitors[0], b.get('a1').competitors[0], 'competitor entries are written on (poolShares) and must be per-call');
  // Within one call a rival is still ONE object in every view that lists it.
  const bobInAlice = a.get('a1').competitors.find((c) => c.name === 'Bob Airways');
  const bobInCarol = a.get('a3').competitors.find((c) => c.name === 'Bob Airways');
  assert.equal(bobInAlice, bobInCarol);
});

await test('what one call attaches (float pool) never shows up in another call', async () => {
  const db = fakeDb('wReuse5', () => [alice, bob, carol]);
  await buildWorldRivalViews(db, 'wReuse5', decision('7.3'));
  const before = await buildWorldRivalViews(db, 'wReuse5', decision('8.3'));
  const poolBefore = before.get('a1').competitors.map((c) => c.poolShares);
  const summaryBefore = JSON.stringify(before.get('a1').stockPool);
  db.market = { worldId: 'wReuse5', investorCash: 123456, pool: { 'human:a2': 5 }, holdings: {}, state: {} };
  const after = await buildWorldRivalViews(db, 'wReuse5', decision('9.3'));
  assert.deepEqual(before.get('a1').competitors.map((c) => c.poolShares), poolBefore, 'a later call rewrote an earlier call\'s competitor entries');
  assert.equal(JSON.stringify(before.get('a1').stockPool), summaryBefore, 'a later call rewrote an earlier call\'s view');
  assert.ok(sharesDepths(before, after), 'a float-pool change must not force the derivation again');
});

await test('an alliance change derives again, and shows', async () => {
  const db = fakeDb('wReuse6', () => [alice, bob, carol]);
  await buildWorldRivalViews(db, 'wReuse6', decision('7.3'));
  const before = await buildWorldRivalViews(db, 'wReuse6', decision('8.3'));
  db.alliances = [{ id: 'al1', name: 'Skyband', members: [
    { airlineId: 'a1', status: 'ACTIVE', role: 'FOUNDER' }, { airlineId: 'a2', status: 'ACTIVE', role: 'MEMBER' },
  ] }];
  const after = await buildWorldRivalViews(db, 'wReuse6', decision('9.3'));
  assert.equal(db.reads, 1);
  assert.equal(after.get('a1').alliance?.def?.name, 'Skyband');
  assert.equal(sharesDepths(before, after), false, 'the views must be derived again when the alliance graph changes');
  const again = await buildWorldRivalViews(db, 'wReuse6', decision('10.3'));
  assert.ok(sharesDepths(after, again), 'and remembered again once it has settled');
  // Fresh derivation with the same graph, for equality.
  const fresh = await buildWorldRivalViews(db, 'wReuse6', { airlines: [alice, bob, carol] });
  assert.equal(overlayJson(again), overlayJson(fresh));
});

await test('a new row load derives again from the new rows', async () => {
  let roster = [alice, bob, carol];
  const db = fakeDb('wReuse7', () => roster);
  const first = await buildWorldRivalViews(db, 'wReuse7', decision('7.3'));
  const cheaper = { ...bob, version: 2, state: gameReducer(withRivals(bob.state, null), { type: 'UPDATE_TICKET_PRICE', routeId: bob.state.routes[0].id, ticketPrice: 99 }) };
  roster = [alice, cheaper, carol];
  const strict = await buildWorldRivalViews(db, 'wReuse7', { stamp: '8.3' });   // a poll: loads rows
  assert.equal(db.reads, 2);
  assert.equal(sharesDepths(first, strict), false);
  const fareOf = (views) => Object.values(views.get('a1').competitors.find((c) => c.name === 'Bob Airways').routes)[0].economyFare;
  assert.equal(fareOf(strict), 99);
  const next = await buildWorldRivalViews(db, 'wReuse7', decision('9.3'));
  assert.equal(fareOf(next), 99, 'a decision after the reload must see the reloaded rows');
  assert.ok(sharesDepths(strict, next));
});

console.log('\n── the shared part of a view is never written on ────────');

function deepFreeze(x, seen = new Set()) {
  if (x === null || typeof x !== 'object' || seen.has(x)) return x;
  seen.add(x);
  for (const v of Object.values(x)) deepFreeze(v, seen);
  return Object.freeze(x);
}

await test('decisions and a weekly tick run against a deep-frozen rival view', async () => {
  const db = fakeDb('wReuse8', () => [alice, bob, carol]);
  await buildWorldRivalViews(db, 'wReuse8', decision('7.3'));
  const views = await buildWorldRivalViews(db, 'wReuse8', decision('8.3'));
  const view = views.get('a1');
  deepFreeze(view);
  const frozenJson = JSON.stringify(rivalOverlay(view));
  let s = withRivals(alice.state, view);
  const routeId = s.routes[0].id;
  const actions = [
    { type: 'UPDATE_TICKET_PRICE', routeId, ticketPrice: 140 },
    { type: 'UPDATE_FREQUENCY', routeId, weeklyFrequency: 10 },
    { type: 'UPDATE_CLASS_PRICES', routeId, prices: { economy: 150, business: 400 } },
    { type: 'SET_MARKETING_BUDGET', budget: 50_000 },
    { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id },
    { type: 'ADVANCE_WEEK' },
    { type: 'ADVANCE_WEEK' },
  ];
  for (const action of actions) {
    // Re-inject before each, as the server does (the stored blob never carries the overlay).
    s = gameReducer(withRivals(stripRivals(s), view), action);
  }
  assert.ok(s.week !== alice.state.week || s.year !== alice.state.year, 'the weeks did not advance');
  assert.equal(JSON.stringify(rivalOverlay(view)), frozenJson);
});

Math.random = realRandom;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
