// Moving routes onto a tail that cannot use the runway.
//
// Discord, Barca 2026-10-17: "You should be blocked from transferring routes to
// an aircraft that can't fly it due to runway length." ADD_ROUTE checks runway
// length (checkRouteRestrictions runs runwayViolation first), but the
// equipment-change guards only re-ran checkRouteRestrictions when the new
// type's CATEGORY differed. An A320neo route into SNA (5,700 ft) moved happily
// onto an A321neo (needs 5,950 ft): same category, so no check at all.
//
// The fix checks every stop's runway against the new type in both
// reassignCompatibility (REASSIGN_ROUTE, the Routes ▸ move menu) and
// transferCompatibility (TRANSFER_ROUTES, the Fleet ▸ Transfer modal, and the
// fleet-renewal swap on delivery). Both pickers already sort eligible tails
// first and print compat.reason under a greyed-out one, so the refusal shows
// up there with no UI change.
//
// Grandfathering: routes opened before the runway rule exist (airportRestrictions
// says so). A tail that needs NO MORE runway than the one already flying the
// route is not refused — otherwise a like-for-like renewal of a grandfathered
// route would be blocked.
//
// Verified failing on HEAD: reassignCompatibility and transferCompatibility both
// return ok:true for the A321neo, and REASSIGN_ROUTE moves the route.
//
//   node --import ./tools/_register-loader.mjs tools/reassign-runway-test.mjs

import assert from 'node:assert/strict';

const engine = await import('../packages/engine/src/reducer.mjs');
const { gameReducer, freshState, reassignCompatibility, transferCompatibility } = engine;
const { getAirport } = await import('../packages/engine/src/data/airports.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const AC = (id, typeId, status = 'assigned') => ({ id, typeId, name: `AC ${id}`, tailNumber: `N${id}`, status, ageWeeks: 52, ownershipType: 'owned' });
const R = (id, o, d, aircraftId, weeklyFrequency = 7, stops = [o, d]) =>
  ({ id, origin: o, destination: d, stops, aircraftId, weeklyFrequency, weeksOpen: 30, ticketPrice: 250 });
function fixture() {
  return {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'DEN', cash: 5e8,
    fleet: [
      AC('n1', 'a320neo'),          // flies DEN–SNA
      AC('big', 'a321neo', 'idle'), // same category, needs more runway than SNA has
      AC('twin', 'a320neo', 'idle'),
      AC('g1', 'a321neo'),          // grandfathered: already flying into SNA
      AC('g2', 'a321neo', 'idle'),
    ],
    routes: [
      R('sna', 'DEN', 'SNA', 'n1', 7),
      R('old', 'SEA', 'SNA', 'g1', 7),
    ],
    gates: { DEN: 10, SNA: 4, SEA: 4 },
  };
}

console.log('\n── runway on an equipment change: fixture ────────────────────');

test('the fixture is the reported case: same category, SNA between the two runway needs', () => {
  const sna = getAirport('SNA').runwayFt, a = getAircraftType('a320neo'), b = getAircraftType('a321neo');
  assert.equal(a.category, b.category);
  assert.ok(a.runwayFt <= sna && b.runwayFt > sna, `SNA ${sna} ft, A320neo ${a.runwayFt}, A321neo ${b.runwayFt}`);
});

console.log('\n── runway on an equipment change: one route ──────────────────');

test('REASSIGN_ROUTE onto a tail that needs more runway than SNA has is refused, naming SNA', () => {
  const v = reassignCompatibility(fixture(), 'sna', 'big');
  assert.equal(v.ok, false, 'the A321neo was offered for a 5,700 ft runway');
  assert.match(v.reason, /runway/i);
  assert.match(v.reason, /SNA/);
});

test('the reducer does not move it', () => {
  const s = fixture();
  const next = gameReducer(s, { type: 'REASSIGN_ROUTE', routeId: 'sna', toAircraftId: 'big' });
  assert.equal(next.routes.find(r => r.id === 'sna').aircraftId, 'n1');
});

test('a tail that fits the runway still takes it', () => {
  assert.deepEqual(reassignCompatibility(fixture(), 'sna', 'twin'), { ok: true });
});

test('a multi-stop rotation is judged on its intermediate stop too', () => {
  const s = fixture();
  s.routes.push(R('via', 'DEN', 'SEA', 'twin', 3, ['DEN', 'SNA', 'SEA']));
  const v = reassignCompatibility(s, 'via', 'big');
  assert.equal(v.ok, false);
  assert.match(v.reason, /SNA/);
});

console.log('\n── runway on an equipment change: whole tail ─────────────────');

test('TRANSFER_ROUTES onto the A321neo is refused, naming SNA', () => {
  const v = transferCompatibility(fixture(), 'n1', 'big');
  assert.equal(v.ok, false);
  assert.match(v.reason, /runway/i);
  assert.match(v.reason, /SNA/);
  const s = fixture();
  const next = gameReducer(s, { type: 'TRANSFER_ROUTES', fromAircraftId: 'n1', toAircraftId: 'big' });
  assert.equal(next.routes.find(r => r.id === 'sna').aircraftId, 'n1');
});

test('…and onto another A320neo is fine', () => {
  assert.deepEqual(transferCompatibility(fixture(), 'n1', 'twin'), { ok: true });
});

console.log('\n── runway on an equipment change: grandfathered routes ───────');

test('a grandfathered route moves to a tail needing no more runway than today', () => {
  assert.deepEqual(transferCompatibility(fixture(), 'g1', 'g2'), { ok: true }, 'like-for-like renewal');
  assert.deepEqual(reassignCompatibility(fixture(), 'old', 'twin'), { ok: true }, 'down-gauge onto a type that fits');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} reassign-runway: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
