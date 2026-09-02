// A grounding must survive every route edit.
//
// Discord (Marcasia, 2026-08-17): "Removing all flights from a grounded plane
// seems that it may have removed the technical issue on it."  It did. The
// grounding countdown in tickPrep only runs while `status === 'grounded'`:
//
//     if (a.status === 'grounded') { ...groundedWeeksLeft - 1... }
//
// but seven reducer paths rewrote `status` from the route table alone —
// CLOSE_ROUTE, CLOSE_ROUTES, CLOSE_CARGO_ROUTE, ADD_ROUTE, ADD_TAG_ROUTE,
// ADD_CARGO_ROUTE and the TRANSFER_ROUTES donor. Closing a broken tail's last
// flight flipped it to 'idle', which is not a status the countdown watches, so
// the AOG simply ceased to exist and the aircraft could be re-crewed the same
// week. TRANSFER_ROUTES made it worse: moving a grounded jet's flights onto a
// spare — the obvious, correct response to a breakdown — cancelled the repair
// as a side effect.
//
// RETIRE_AIRCRAFT and SELL_AIRCRAFT already guarded this ("a retirement
// elsewhere in the fleet must not yank another tail out of its repair bay"),
// so the invariant was understood; the route actions just never applied it.
//
// This locks in both halves: the status guard, and the tickPrep self-heal that
// puts already-broken saves (groundedWeeksLeft > 0 while flying) back in the shop.
//
//   node tools/grounding-persistence-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { idleFleetAlertText } from '../src/utils/leaseAlerts.js';

// Determinism: pin RNG so random failures / events never perturb assertions.
const realRandom = Math.random;
const pinRandom  = () => { Math.random = () => 0.9999; };
pinRandom();
/**
 * Buy with the real RNG restored for the length of the call: aircraft ids come
 * from uid(), which mixes Math.random in, so two purchases under a pinned RNG
 * land on the SAME id and every id lookup after that silently matches both.
 */
function buy(s, typeId) {
  Math.random = realRandom;
  try { return gameReducer(s, { type: 'BUY_AIRCRAFT', typeId }); }
  finally { pinRandom(); }
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}

const TYPE = 'crj200';
const find = (s, id) => s.fleet.find(a => a.id === id);

function newGame() {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'MX', hub: 'JFK', enableObjectives: false });
  // Two CRJs bought outright is more than the $10M founders' equity covers.
  return { ...s, cash: 50_000_000 };
}
function withJet(s, dest = 'ORD') {
  const before = s.fleet.length;
  s = buy(s, TYPE);
  if (s.fleet.length === before) throw new Error('buy failed, cash=' + s.cash);
  const acId = s.fleet[s.fleet.length - 1].id;
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: acId, origin: 'JFK', destination: dest, weeklyFrequency: 7 });
  if (s.routes.length === 0) throw new Error('route did not attach');
  return { s, acId };
}
/** Break a tail the way a random technical failure does. */
function ground(s, acId, weeks = 3) {
  return {
    ...s,
    fleet: s.fleet.map(a => a.id === acId ? { ...a, status: 'grounded', groundedWeeksLeft: weeks } : a),
  };
}

// ── The reported bug: closing flights must not end the grounding ─────────────

t('CLOSE_ROUTE on a grounded tail keeps it grounded', () => {
  let { s, acId } = withJet(newGame());
  s = ground(s, acId);
  const routeId = s.routes.find(r => r.aircraftId === acId).id;
  s = gameReducer(s, { type: 'CLOSE_ROUTE', routeId });
  const a = find(s, acId);
  assert.equal(s.routes.length, 0, 'route still closed');
  assert.equal(a.status, 'grounded', 'still in the shop');
  assert.equal(a.groundedWeeksLeft, 3, 'countdown untouched');
});

t('CLOSE_ROUTES (batch) on a grounded tail keeps it grounded', () => {
  let { s, acId } = withJet(newGame());
  s = ground(s, acId);
  const routeIds = s.routes.filter(r => r.aircraftId === acId).map(r => r.id);
  s = gameReducer(s, { type: 'CLOSE_ROUTES', routeIds });
  assert.equal(s.routes.length, 0);
  assert.equal(find(s, acId).status, 'grounded');
});

t('CLOSE_CARGO_ROUTE on a grounded freighter keeps it grounded', () => {
  let s = newGame();
  const ac = { id: 'frt', name: 'Freighter', typeId: TYPE, status: 'grounded', groundedWeeksLeft: 2, ownershipType: 'owned' };
  s = { ...s, fleet: [...s.fleet, ac], cargoRoutes: [{ id: 'c1', origin: 'JFK', destination: 'ORD', aircraftId: 'frt', weeklyFrequency: 3 }] };
  s = gameReducer(s, { type: 'CLOSE_CARGO_ROUTE', routeId: 'c1' });
  assert.equal(s.cargoRoutes.length, 0);
  assert.equal(find(s, 'frt').status, 'grounded');
  assert.equal(find(s, 'frt').groundedWeeksLeft, 2);
});

t('a heavy check survives a route close too (same guard)', () => {
  let { s, acId } = withJet(newGame());
  s = { ...s, fleet: s.fleet.map(a => a.id === acId ? { ...a, status: 'maintenance', checkWeeksLeft: 2 } : a) };
  const routeId = s.routes.find(r => r.aircraftId === acId).id;
  s = gameReducer(s, { type: 'CLOSE_ROUTE', routeId });
  assert.equal(find(s, acId).status, 'maintenance');
  assert.equal(find(s, acId).checkWeeksLeft, 2);
});

// ── The other direction: scheduling flights must not un-ground it either ─────

t('ADD_ROUTE to a grounded tail attaches the route without ending the AOG', () => {
  let { s, acId } = withJet(newGame());
  s = ground(s, acId);
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'BOS' });
  const before = s.routes.length;
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: acId, origin: 'JFK', destination: 'BOS', weeklyFrequency: 3 });
  assert.equal(s.routes.length, before + 1, 'route still attaches (it flies when the tail returns)');
  assert.equal(find(s, acId).status, 'grounded');
});

t('TRANSFER_ROUTES off a grounded tail leaves the donor grounded', () => {
  let { s, acId } = withJet(newGame());
  const beforeFleet = s.fleet.length;
  s = buy(s, TYPE);
  assert.equal(s.fleet.length, beforeFleet + 1, 'spare bought');
  const spareId = s.fleet[s.fleet.length - 1].id;
  s = ground(s, acId);
  s = gameReducer(s, { type: 'TRANSFER_ROUTES', fromAircraftId: acId, toAircraftId: spareId });
  assert.ok(s.routes.every(r => r.aircraftId !== acId), 'routes moved to the spare');
  assert.equal(find(s, spareId).status, 'assigned');
  assert.equal(find(s, acId).status, 'grounded', 'the broken jet is still broken');
  assert.equal(find(s, acId).groundedWeeksLeft, 3);
});

// ── The countdown still runs, and still ends ────────────────────────────────

t('grounding ticks down and releases after a route close', () => {
  let { s, acId } = withJet(newGame());
  s = ground(s, acId, 2);
  const routeId = s.routes.find(r => r.aircraftId === acId).id;
  s = gameReducer(s, { type: 'CLOSE_ROUTE', routeId });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(find(s, acId).status, 'grounded', 'one more week to go');
  assert.equal(find(s, acId).groundedWeeksLeft, 1);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.equal(a.status, 'idle', 'released — routeless, so idle');
  assert.equal(a.groundedWeeksLeft, 0);
});

// ── Self-heal: saves already broken by the old reducer ──────────────────────

t('a flying tail carrying groundedWeeksLeft goes back in the shop on the next tick', () => {
  let { s, acId } = withJet(newGame());
  // Exactly the corrupt shape the old CLOSE_ROUTE left behind: countdown intact,
  // status flyable.
  s = { ...s, fleet: s.fleet.map(a => a.id === acId ? { ...a, status: 'assigned', groundedWeeksLeft: 2 } : a) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.equal(a.status, 'grounded', 'healed');
  assert.equal(a.groundedWeeksLeft, 1, 'and the week it just served counts');
});

t('the heal never touches a tail that finished its grounding', () => {
  let { s, acId } = withJet(newGame());
  s = { ...s, fleet: s.fleet.map(a => a.id === acId ? { ...a, status: 'assigned', groundedWeeksLeft: 0 } : a) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(find(s, acId).status, 'assigned');
});

// ── The other report: "i have to pay lease fee on idle aircraft i own?" ──────
// ASAS, 2026-08-18, screenshot of an OWNED A330-900neo under a Dashboard alert
// reading "1 idle aircraft, paying lease with no revenue". The count was right;
// the reason was invented. An owned idle tail costs ownership + parking, not rent.

t('idle alert says "lease" only when every idle tail is leased', () => {
  const leased = { id: 'l1', ownershipType: 'lease' };
  const owned  = { id: 'o1', ownershipType: 'owned' };
  assert.match(idleFleetAlertText([leased]), /paying lease/);
  assert.match(idleFleetAlertText([leased, { ...leased, id: 'l2' }]), /^2 idle aircraft, paying lease/);
});

t('an owned idle tail is never described as paying lease', () => {
  const owned = { id: 'o1', ownershipType: 'owned' };
  const text  = idleFleetAlertText([owned]);
  assert.doesNotMatch(text, /lease/i, 'no invented rent on an owned aircraft');
  assert.match(text, /^1 idle aircraft, /);
});

t('a mixed idle set falls back to fixed costs', () => {
  const text = idleFleetAlertText([{ id: 'l1', ownershipType: 'lease' }, { id: 'o1', ownershipType: 'owned' }]);
  assert.doesNotMatch(text, /paying lease/);
  assert.match(text, /^2 idle aircraft, /);
});

t('no idle aircraft, no alert', () => {
  assert.equal(idleFleetAlertText([]), null);
  assert.equal(idleFleetAlertText(null), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
