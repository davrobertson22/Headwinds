// Multi-stop (tag) routes: raising weekly frequency is guarded on EVERY stop.
//
//   node tools/tag-frequency-test.mjs
//
// Verified-failing on HEAD (2026-08-27): frequencyChangeBlockReason measured a
// tag route as if it were the bare origin→destination pair — routeDistanceKm on
// the endpoints, gate slots counted only where `r.origin === code ||
// r.destination === code`. So MCI→JFK→ORY could be stepped up until JFK's slots
// were metres deep underwater, and the leg regulations on MCI–JFK were never
// consulted at all. ADD_TAG_ROUTE already counted every stop with a
// movement-per-cycle incident count; this test pins the frequency guard (and
// the ADD_ROUTE slot count) to the same arithmetic.
//
// Sections 3b and 3c cover behaviour whose new APIs do not exist on HEAD, so
// per CLAUDE.md the old behaviour is proved by probe rather than claimed from
// an import error. HEAD's own guards, run against these exact fixtures, printed:
//
//   JFK exactly full (46 nonstop departures + a 2x/wk rotation's 4 movements = 50/50)
//     HEAD addCargoRouteBlockReason(JFK->BOS, 1x)     = null   <- launches at 51/50
//   LAS-SNA at the 10/wk SNA carrier cap, flown by a rotation
//     HEAD addRouteBlockReason(LAS->SNA nonstop, 5x)  = null   <- 15/wk on a 10/wk cap
//     HEAD frequencyChangeBlockReason(nonstop 3 -> 4) = null   <- 11/wk on the same cap
//
// All three are refused now.

import assert from 'node:assert/strict';
import {
  gameReducer, freshState, frequencyChangeBlockReason, addRouteBlockReason, slotCapAt,
  peakSlotsUsedAt, addCargoRouteBlockReason, slotsUsedAt, addTagRouteBlockReason,
} from '../packages/engine/src/reducer.mjs';
import { SLOTS_PER_GATE } from '../packages/engine/src/utils/simulation.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AC = (id, typeId = 'b7879') => ({
  id, typeId, name: `AC ${id}`, tailNumber: `N${id}`, status: 'assigned',
  ageWeeks: 104, ownershipType: 'owned',
});

// A tag rotation MCI → JFK → ORY. Interior JFK sees two movements per cycle.
const TAG = (id, aircraftId, freq, stops = ['MCI', 'JFK', 'ORY']) => ({
  id, stops: [...stops], origin: stops[0], destination: stops[stops.length - 1],
  aircraftId, weeklyFrequency: freq, weeksOpen: 30, ticketPrice: 600,
});

const FLAT = (id, o, d, aircraftId, freq) => ({
  id, origin: o, destination: d, stops: [o, d], aircraftId,
  weeklyFrequency: freq, weeksOpen: 30, ticketPrice: 300,
});

function tagState({ jfkGates = 1, jfkFlatFreq = 0, tagFreq = 3 } = {}) {
  const routes = [TAG('tag1', 'a1', tagFreq)];
  if (jfkFlatFreq > 0) routes.push(FLAT('r2', 'JFK', 'BOS', 'a2', jfkFlatFreq));
  return {
    ...freshState(),
    airlineName: 'Tag Test', hub: 'MCI', homeCountry: 'US',
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 500_000_000,
    fleet: [AC('a1'), AC('a2', 'a320neo'), AC('a3', 'a320neo')],
    gates: { MCI: 2, JFK: jfkGates, ORY: 2, BOS: 2 },
    routes,
  };
}

// ── 1. Slots at an INTERIOR stop gate the step-up ────────────────────────────
//
// JFK holds one gate = 50 slots. The rotation itself burns 2 slots per cycle at
// JFK, and a JFK–BOS service eats 44 more. At 3×/wk the tag route uses 6, for
// 50 total — exactly full. One more cycle needs two more JFK movements.

test('interior stop out of slots blocks the increase', () => {
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 44, tagFreq: 3 });
  assert.equal(slotCapAt(s, 'JFK'), SLOTS_PER_GATE);
  const reason = frequencyChangeBlockReason(s, 'tag1', 4);
  assert.ok(reason, 'expected a refusal — JFK is full');
  assert.match(reason, /JFK/);
});

test('interior stop with room allows the increase', () => {
  const s = tagState({ jfkGates: 2, jfkFlatFreq: 44, tagFreq: 3 });
  assert.equal(frequencyChangeBlockReason(s, 'tag1', 4), null);
});

test('an interior stop counts TWO movements per cycle, not one', () => {
  // 46 flat + 2 tag cycles (4 movements) = 50, exactly full. One more flat
  // departure must be refused; if the interior stop were counted once per
  // cycle the arithmetic would read 48 and wave it through.
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 46, tagFreq: 2 });
  const reason = frequencyChangeBlockReason(s, 'r2', 47);
  assert.ok(reason, 'expected a refusal — the tag rotation occupies 4 JFK slots');
  assert.match(reason, /JFK/);
});

test('ADD_ROUTE sees the tag rotation on the slots it occupies', () => {
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 46, tagFreq: 2 });
  const reason = addRouteBlockReason(s, {
    origin: 'JFK', destination: 'BOS', aircraftId: 'a3', weeklyFrequency: 1,
  });
  assert.ok(reason, 'expected a refusal — JFK is full once the tag route is counted');
  assert.match(reason, /JFK/);
});

// ── 2. The reducer enforces what the guard says ──────────────────────────────

test('UPDATE_FREQUENCY refuses the blocked step-up', () => {
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 44, tagFreq: 3 });
  const next = gameReducer(s, { type: 'UPDATE_FREQUENCY', routeId: 'tag1', weeklyFrequency: 4 });
  assert.equal(next.routes.find(r => r.id === 'tag1').weeklyFrequency, 3);
});

test('UPDATE_FREQUENCY applies an allowed step-up on a tag route', () => {
  const s = tagState({ jfkGates: 2, jfkFlatFreq: 44, tagFreq: 3 });
  const next = gameReducer(s, { type: 'UPDATE_FREQUENCY', routeId: 'tag1', weeklyFrequency: 4 });
  assert.equal(next.routes.find(r => r.id === 'tag1').weeklyFrequency, 4);
});

test('reductions on a tag route are always allowed', () => {
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 48, tagFreq: 3 });
  assert.equal(frequencyChangeBlockReason(s, 'tag1', 2), null);
  const next = gameReducer(s, { type: 'UPDATE_FREQUENCY', routeId: 'tag1', weeklyFrequency: 2 });
  assert.equal(next.routes.find(r => r.id === 'tag1').weeklyFrequency, 2);
});

// ── 3. Block hours are measured across the whole rotation ────────────────────

test('block hours count every leg of the rotation', () => {
  // Two gates everywhere, so slots cannot be what refuses this. A 787 flying
  // MCI–JFK–ORY at 20×/wk is far past any weekly block-hour ceiling.
  const s = { ...tagState({ jfkGates: 4, tagFreq: 3 }), gates: { MCI: 9, JFK: 9, ORY: 9, BOS: 9 } };
  const reason = frequencyChangeBlockReason(s, 'tag1', 20);
  assert.ok(reason, 'expected a refusal on flying hours');
  assert.match(reason, /block-hour/i);
});

// ── 3b. Freight reads the same airport the same way ──────────────────────────
//
// The cargo guards counted `r.origin === code || r.destination === code` over
// passenger AND cargo ops, so a rotation's two movements at the stop in the
// middle were invisible to them: the passenger guard refused a flight at a full
// JFK while the freight guard launched a lane onto the same slots.

test('a cargo lane cannot launch onto slots a rotation occupies', () => {
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 46, tagFreq: 2 });   // JFK exactly 50/50
  const st = { ...s, fleet: [...s.fleet, { id: 'f1', typeId: 'b767300f', name: 'Freighter',
    tailNumber: 'NF1', status: 'idle', ageWeeks: 52, ownershipType: 'owned' }] };
  const reason = addCargoRouteBlockReason(st, {
    origin: 'JFK', destination: 'BOS', aircraftId: 'f1', weeklyFrequency: 1, yieldPrice: 0.5,
  });
  assert.ok(reason, 'freight was offered slots the passenger guard refuses');
  assert.match(reason, /JFK/);
});

test('ADD_CARGO_ROUTE refuses it too', () => {
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 46, tagFreq: 2 });
  const st = { ...s, fleet: [...s.fleet, { id: 'f1', typeId: 'b767300f', name: 'Freighter',
    tailNumber: 'NF1', status: 'idle', ageWeeks: 52, ownershipType: 'owned' }] };
  const next = gameReducer(st, { type: 'ADD_CARGO_ROUTE',
    origin: 'JFK', destination: 'BOS', aircraftId: 'f1', weeklyFrequency: 1, yieldPrice: 0.5 });
  assert.equal((next.cargoRoutes ?? []).length, 0, 'the lane opened on slots that do not exist');
});

// ── 3c. A regulatory leg cap governs the LEG, not the route shape ────────────
//
// SNA limits one carrier to 10 departures/wk on any one route. A rotation
// calling at SNA was capped correctly; a nonstop on the same leg was then
// allowed on top of it, because the nonstop's check counted only routes whose
// ENDPOINTS were that pair. Twenty departures on a ten-departure cap.

const SNA_CAP = 10;
function snaState(tagFreq = SNA_CAP) {
  return {
    ...freshState(),
    airlineName: 'Leg Cap', hub: 'LAS', homeCountry: 'US',
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 500_000_000,
    fleet: [AC('a1', 'a320neo'), AC('a2', 'a320neo'), AC('a3', 'a320neo')],
    gates: { LAS: 9, SNA: 9, PHX: 9 },
    routes: [TAG('tag1', 'a1', tagFreq, ['LAS', 'SNA', 'PHX'])],
  };
}

test('the rotation itself is capped on the LAS–SNA leg', () => {
  const reason = frequencyChangeBlockReason(snaState(SNA_CAP), 'tag1', SNA_CAP + 1);
  assert.ok(reason, 'expected the leg cap to bite');
  // Names the leg AND the rule, so the player knows which sector to change.
  assert.match(reason, /^LAS–SNA: /);
  assert.match(reason, /SNA/);
});

test('a nonstop cannot be opened on a leg the rotation has already filled', () => {
  const reason = addRouteBlockReason(snaState(SNA_CAP), {
    origin: 'LAS', destination: 'SNA', aircraftId: 'a2', weeklyFrequency: 5,
  });
  assert.ok(reason, 'the capped leg was flown at 15/wk against a 10/wk limit');
  assert.match(reason, /SNA/, 'the refusal should name the rule that refused it');
});

test('and cannot be stepped up onto it either', () => {
  const s = snaState(SNA_CAP - 3);
  s.routes.push(FLAT('r2', 'LAS', 'SNA', 'a2', 3));   // 7 + 3 = 10, exactly the cap
  assert.ok(frequencyChangeBlockReason(s, 'r2', 4), 'the nonstop stepped past the shared leg cap');
});

test('under the cap, both shapes are still allowed', () => {
  const s = snaState(4);
  assert.equal(addRouteBlockReason(s, {
    origin: 'LAS', destination: 'SNA', aircraftId: 'a2', weeklyFrequency: 5,
  }), null, '4 + 5 is under the 10/wk cap and must be allowed');
});

// ── 3d. Perimeter rules still bite on a rotation's frequency ─────────────────
//
// Checking the LEGS of a rotation and nothing else would have made a one-stop
// the way to fly a capped market at any frequency: DCA–LAX is beyond DCA's
// perimeter and capped, DCA–ORD and ORD–LAX are both inside it, so a
// DCA–ORD–LAX rotation passed every leg check and was never measured on the
// market it actually sells. The route's own O&D is checked for every shape.

// A narrowbody: DCA also has a runway-length rule, and a widebody fixture would
// have every assertion below passing for the wrong reason.
function dcaState(stops, freq) {
  const multi = stops.length > 2;
  const gates = {};
  for (const c of ['DCA', 'ORD', 'LAX', 'SEA', 'PDX', 'SFO', 'LAS', 'PHX']) gates[c] = 9;
  return {
    ...freshState(),
    airlineName: 'Perimeter', hub: 'DCA', homeCountry: 'US',
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 500_000_000,
    // a320neo: DCA's runway limit turns a bigger narrowbody's every leg into a
    // refusal, which would make every assertion below pass for the wrong reason.
    fleet: [AC('a1', 'a320neo'), AC('a2', 'a320neo')],
    gates,
    routes: [multi ? TAG('r1', 'a1', freq, stops) : FLAT('r1', stops[0], stops[1], 'a1', freq)],
  };
}

test('the nonstop is capped (control — if this stops failing the fixture is stale)', () => {
  const reason = frequencyChangeBlockReason(dcaState(['DCA', 'LAX'], 7), 'r1', 8);
  assert.ok(reason, 'DCA–LAX should be perimeter-capped at 7/wk');
  assert.match(reason, /DCA Perimeter Rule/);
});

test('a one-stop rotation on the same market is capped too', () => {
  const reason = frequencyChangeBlockReason(dcaState(['DCA', 'ORD', 'LAX'], 7), 'r1', 8);
  assert.ok(reason, 'the rotation flew a capped market at any frequency it liked');
  // The MARKET, not a leg: DCA–ORD and ORD–LAX are both inside the perimeter, so
  // this can only have come from the O&D check — a leg refusal is prefixed with
  // the leg, and neither leg is beyond the perimeter anyway.
  assert.match(reason, /^DCA Perimeter Rule/);
});

test('a rotation does not count itself out of its own exemption slot', () => {
  // Four OTHER beyond-perimeter DCA routes + this one = 5 of 5 slots, with the
  // rotation holding the fifth. Keying the exclusion on the leg made it count
  // itself as a sixth and refuse its own frequency for ever.
  const s = dcaState(['DCA', 'SEA', 'PDX'], 3);
  ['LAX', 'SFO', 'LAS', 'PHX'].forEach((c, i) => s.routes.push(FLAT(`f${i}`, 'DCA', c, 'a2', 2)));
  assert.equal(frequencyChangeBlockReason(s, 'r1', 4), null,
    'the rotation was refused a slot it is itself occupying');
});

test('but a FIFTH other beyond-perimeter route does fill the last slot', () => {
  const s = dcaState(['DCA', 'SEA', 'PDX'], 3);
  ['LAX', 'SFO', 'LAS', 'PHX', 'DEN'].forEach((c, i) => {
    s.gates[c] = 9;
    s.routes.push(FLAT(`f${i}`, 'DCA', c, 'a2', 2));
  });
  assert.ok(frequencyChangeBlockReason(s, 'r1', 4),
    'the exemption-slot count is no longer enforced at all');
});

test('the rotation cannot be OPENED past the market cap either', () => {
  // The stepper refusing what the planner just opened leaves the airline parked
  // in a state its own guard calls illegal.
  const s = dcaState(['DCA', 'LAX'], 1);
  s.routes = [];
  const reason = addTagRouteBlockReason(s, {
    aircraftId: 'a1', stops: ['DCA', 'ORD', 'LAX'], weeklyFrequency: 10,
  });
  assert.ok(reason, 'a one-stop opened at 10/wk on a market capped at 7');
  assert.match(reason, /DCA Perimeter Rule/,
    'refused, but not by the market rule — this test would pass on any refusal');
  const next = gameReducer(s, { type: 'ADD_TAG_ROUTE',
    aircraftId: 'a1', stops: ['DCA', 'ORD', 'LAX'], weeklyFrequency: 10 });
  assert.equal((next.routes ?? []).length, 0, 'the reducer opened it anyway');
});

test('two services cannot each take the full allowance on one exemption market', () => {
  // DCA–LAX is one exemption slot at 7/wk. A nonstop and a one-stop selling the
  // same market share that slot; giving each its own let them stack to 14.
  const s = dcaState(['DCA', 'LAX'], 4);
  s.gates.DFW = 9;
  const reason = addTagRouteBlockReason(s, {
    aircraftId: 'a2', stops: ['DCA', 'DFW', 'LAX'], weeklyFrequency: 5,
  });
  assert.ok(reason, '4 + 5 = 9 opened on a market capped at 7');
  assert.match(reason, /DCA Perimeter Rule/);
  // ...but 4 + 3 fits.
  assert.equal(addTagRouteBlockReason(s, {
    aircraftId: 'a2', stops: ['DCA', 'DFW', 'LAX'], weeklyFrequency: 3,
  }), null, 'a rotation that fits inside the shared allowance was refused');
});

test('a market cap does NOT charge a rotation to a pair it flies no departures on', () => {
  // SNA caps a carrier at 10 departures/wk on any one route. A SNA–LAS–PHX
  // rotation at 6 flies 6 SNA–LAS departures and ZERO SNA–PHX ones; a SNA–PHX
  // nonstop at 5 flies 5. Counting the rotation's 6 against both pairs froze
  // two routes that are each well under the cap.
  const gates = {}; for (const c of ['SNA', 'LAS', 'PHX']) gates[c] = 9;
  const s = {
    ...freshState(),
    airlineName: 'Units', hub: 'SNA', homeCountry: 'US',
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 500_000_000,
    fleet: [AC('a1', 'a320neo'), AC('a2', 'a320neo')],
    gates,
    routes: [TAG('tag1', 'a1', 6, ['SNA', 'LAS', 'PHX']), FLAT('r2', 'SNA', 'PHX', 'a2', 5)],
  };
  assert.equal(frequencyChangeBlockReason(s, 'tag1', 7), null,
    'the rotation was charged its own departures twice');
});

// ── 3e. Counter-seasonal routes are a PEAK, not a sum ────────────────────────

test('two routes that never coexist do not both charge a freighter', () => {
  const winter = { ...FLAT('w', 'JFK', 'BOS', 'a2', 25), season: { months: [1, 2, 3, 11, 12] } };
  const summer = { ...FLAT('s', 'JFK', 'MCI', 'a3', 25), season: { months: [6, 7, 8] } };
  const s = {
    ...freshState(),
    airlineName: 'Seasons', hub: 'JFK', homeCountry: 'US',
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 500_000_000,
    fleet: [AC('a2', 'a320neo'), AC('a3', 'a320neo')],
    gates: { JFK: 1, BOS: 2, MCI: 2 },
    routes: [winter, summer],
  };
  // 25 in the busiest month, not 50 across two seasons that never meet.
  assert.equal(slotsUsedAt(s.routes, 'JFK'), 25);
});

// ── 3f. Passenger and freight share one gate ─────────────────────────────────

test('a passenger route cannot open on slots a freighter is using', () => {
  const s = {
    ...freshState(),
    airlineName: 'Mixed', hub: 'JFK', homeCountry: 'US',
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 500_000_000,
    fleet: [AC('a2', 'a320neo'),
      { id: 'f1', typeId: 'b767300f', name: 'F', tailNumber: 'NF1', status: 'assigned', ageWeeks: 52, ownershipType: 'owned' }],
    gates: { JFK: 1, BOS: 2 },
    routes: [],
    cargoRoutes: [{ id: 'c1', origin: 'JFK', destination: 'BOS', aircraftId: 'f1',
      weeklyFrequency: 50, yieldPrice: 0.4, weeksOpen: 20 }],
  };
  const reason = addRouteBlockReason(s, {
    origin: 'JFK', destination: 'BOS', aircraftId: 'a2', weeklyFrequency: 5,
  });
  assert.ok(reason, 'passenger flights were opened on top of freight already holding every slot');
  assert.match(reason, /JFK/);
});

// ── 4. The planners count slots the way the guard does ───────────────────────
//
// Both planners quoted "used / cap" from their own endpoint-only arithmetic. Now
// that the guards charge a rotation two movements at the airport it stops at,
// a preview that didn't would offer slots the engine then refuses — the exact
// disagreement this repo keeps getting bitten by.

test('peakSlotsUsedAt is what both the guard and the previews call', () => {
  const s = tagState({ jfkGates: 1, jfkFlatFreq: 44, tagFreq: 3 });
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  // 44 flat departures + 3 cycles x 2 movements = 50.
  assert.equal(peakSlotsUsedAt(s.routes, 'JFK', months), 50);
  // Endpoints of the rotation see one movement per cycle.
  assert.equal(peakSlotsUsedAt(s.routes, 'MCI', months), 3);
  assert.equal(peakSlotsUsedAt(s.routes, 'ORY', months), 3);
});

// ── 5. Single-leg routes are unchanged ───────────────────────────────────────

test('a plain route with room still steps up', () => {
  const s = {
    ...freshState(),
    airlineName: 'Flat', hub: 'JFK', homeCountry: 'US',
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 100_000_000,
    fleet: [AC('a1', 'a320neo')],
    gates: { JFK: 2, BOS: 2 },
    routes: [FLAT('r1', 'JFK', 'BOS', 'a1', 5)],
  };
  assert.equal(frequencyChangeBlockReason(s, 'r1', 6), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
