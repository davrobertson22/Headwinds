// Alliance slot pool — members share the spare weekly slots on their gates;
// partners with a gate of their own at the airport draw extra frequency from
// the pool. Usage moves, holdings never do.
//
//   node tools/alliance-slot-pool-test.mjs
//
// Verified-failing note (new feature, per CLAUDE.md): the APIs under test
// (slotCapAt / poolGrantAt / computeSlotPools / state.allianceSlotPool) do not
// exist on HEAD, so the old behaviour is proved by probe instead: section 0
// reproduces the pre-pool call path — a route add past own slot capacity is
// refused even when a grant is present in state — by running the SAME states
// against the old arithmetic `gates × SLOTS_PER_GATE`. On HEAD every pool
// test here fails trivially (import error); the probe pins the actual
// behaviour delta: grants extend the ceiling, absent grants change nothing.

import assert from 'node:assert/strict';
import {
  gameReducer, freshState, frequencyChangeBlockReason, cargoFrequencyChangeBlockReason,
  slotCapAt, poolGrantAt,
} from '../packages/engine/src/reducer.mjs';
import { SLOTS_PER_GATE } from '../packages/engine/src/utils/simulation.js';
import {
  SLOT_POOL_MARKUP, SLOT_SQUEEZE_GRACE_WEEKS, GATE_FEE_BY_TIER, getAirport,
} from '../packages/engine/src/data/airports.js';
import { computeSlotPools, slotPoolPerSlotFee } from '../apps/headwinds-server/src/lib/gateService.mjs';
import { rivalOverlay, stripRivals } from '../apps/headwinds-server/src/lib/humanRivals.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AC = (id) => ({
  id, typeId: 'a320neo', name: `AC ${id}`, status: 'assigned',
  ageWeeks: 104, ownershipType: 'owned',
});
const R = (id, o, d, aircraftId, freq) => ({
  id, origin: o, destination: d, stops: [o, d], aircraftId,
  weeklyFrequency: freq, weeksOpen: 30, ticketPrice: 200,
});

// A playable MP scarcity state: hub JFK, gates at JFK/BOS/IAD, an existing
// JFK–BOS schedule that eats most of JFK's 50 own slots.
function mpState({ jfkGates = 1, existingFreq = 45, pool = undefined } = {}) {
  return {
    ...freshState(),
    airlineName: 'Pool Test', hub: 'JFK', homeCountry: 'US',
    multiplayer: true, gateScarcityWorld: true,
    competitors: [], humanRivals: {}, encroachments: {},
    cash: 50_000_000,
    fleet: [AC('a1'), AC('a2')],
    gates: { JFK: jfkGates, BOS: 1, IAD: 1 },
    routes: [R('r1', 'JFK', 'BOS', 'a1', existingFreq)],
    ...(pool !== undefined ? { allianceSlotPool: pool } : {}),
  };
}

const addIad = (s, freq) => gameReducer(s, {
  type: 'ADD_ROUTE', origin: 'JFK', destination: 'IAD', aircraftId: 'a2', weeklyFrequency: freq,
});

console.log('\n── 0. Probe: the pre-pool arithmetic (old call path) ─────');

test('old ceiling: gates × SLOTS_PER_GATE ignores any pool grant', () => {
  const s = mpState({ pool: { JFK: { grant: 20 } } });
  const oldCap = (s.gates.JFK ?? 0) * SLOTS_PER_GATE;      // the HEAD formula
  assert.equal(oldCap, 50);
  assert.ok(45 + 10 > oldCap, 'probe: +10/wk would be refused under the old arithmetic');
  assert.equal(slotCapAt(s, 'JFK'), 70, 'new arithmetic grants 20 more');
});

console.log('\n── 1. slotCapAt / poolGrantAt ────────────────────────────');

test('no pool injected → exactly the own-gates ceiling (solo identical)', () => {
  const s = mpState();
  assert.equal(poolGrantAt(s, 'JFK'), 0);
  assert.equal(slotCapAt(s, 'JFK'), 50);
});

test('grant extends the ceiling only at its airport', () => {
  const s = mpState({ pool: { JFK: { grant: 30 } } });
  assert.equal(slotCapAt(s, 'JFK'), 80);
  assert.equal(slotCapAt(s, 'BOS'), 50);
});

console.log('\n── 2. Route decisions draw from the pool ─────────────────');

test('ADD_ROUTE past own slots is refused without a grant', () => {
  const s = mpState();                       // 45 used of 50 at JFK
  const next = addIad(s, 10);                // would need 55
  assert.equal(next.routes.length, 1, 'route must not open');
});

test('the same ADD_ROUTE succeeds with a grant covering the overflow', () => {
  const s = mpState({ pool: { JFK: { grant: 10 } } });
  const next = addIad(s, 10);
  assert.equal(next.routes.length, 2, 'route opens on borrowed slots');
});

test('borrower still needs a gate of their OWN (grant is not a substitute)', () => {
  const s = mpState({ jfkGates: 0, existingFreq: 0, pool: { JFK: { grant: 100 } } });
  s.routes = [];
  const next = addIad(s, 5);
  assert.equal(next.routes.length, 0, 'no own gate at JFK → refused despite the grant');
});

test('frequencyChangeBlockReason honours the grant', () => {
  const blockedS = mpState();
  assert.match(frequencyChangeBlockReason(blockedS, 'r1', 51) ?? '', /gate slots at JFK|gate slots at BOS/);
  const granted = mpState({ pool: { JFK: { grant: 10 }, BOS: { grant: 10 } } });
  assert.equal(frequencyChangeBlockReason(granted, 'r1', 51), null);
});

console.log('\n── 3. Weekly money rides the gate-fee line ───────────────');

test('weeklyCost / weeklyEarnings are booked into totalGateFees', () => {
  const base = mpState();
  const withPool = mpState({
    pool: { JFK: { grant: 0, draw: 0, weeklyCost: 4000, shared: 0, lentOut: 8, weeklyEarnings: 10_000 } },
  });
  const a = gameReducer(base, { type: 'ADVANCE_WEEK' });
  const b = gameReducer(withPool, { type: 'ADVANCE_WEEK' });
  assert.equal(b.lastReport.totalGateFees - a.lastReport.totalGateFees, 4000 - 10_000,
    'gate fees move by cost − earnings');
  assert.equal(b.lastReport.totalSlotPoolCost, 4000);
  assert.equal(b.lastReport.totalSlotPoolEarnings, 10_000);
  assert.equal(a.lastReport.totalSlotPoolCost, undefined,
    'report keys exist only when the pool is injected (golden parity)');
});

console.log('\n── 4. The squeeze: grant shrinks under a borrower ────────');

test('over-grant usage starts the countdown, not an instant cut', () => {
  const s = mpState({ existingFreq: 60, pool: { JFK: { grant: 0 } } }); // 60 used of 50
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(next.slotSqueeze?.JFK, SLOT_SQUEEZE_GRACE_WEEKS - 1);
  assert.equal(next.routes.find(r => r.id === 'r1').weeklyFrequency, 60, 'nothing trimmed yet');
});

test('a sufficient grant means no squeeze at all', () => {
  const s = mpState({ existingFreq: 60, pool: { JFK: { grant: 10 } } });
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(next.slotSqueeze?.JFK, undefined);
});

test('the countdown reaching zero trims frequency to fit, deterministically', () => {
  let s = mpState({ existingFreq: 60, pool: { JFK: { grant: 0 } } });
  s = { ...s, slotSqueeze: { JFK: 1 } };     // last warning already given
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const r1 = next.routes.find(r => r.id === 'r1');
  assert.equal(r1.weeklyFrequency, 50, '60 → 50: trimmed exactly to the own-gate ceiling');
  assert.equal(next.slotSqueeze?.JFK, undefined, 'squeeze cleared after the cut');
});

test('recovered capacity clears an in-progress countdown', () => {
  let s = mpState({ existingFreq: 60, pool: { JFK: { grant: 10 } } });
  s = { ...s, slotSqueeze: { JFK: 2 } };
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(next.slotSqueeze?.JFK, undefined);
});

test('a route trimmed to zero closes', () => {
  let s = mpState({ existingFreq: 0, pool: { JFK: { grant: 0 } } });
  s.routes = [R('tiny', 'JFK', 'IAD', 'a1', 4)];
  s.gates = { ...s.gates, JFK: 0 };          // all own gates gone; grant gone too
  s = { ...s, slotSqueeze: { JFK: 1 } };
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(next.routes.length, 0, '4 slots over on a 0-slot airport → route closes');
});

console.log('\n── 5. Rule 5: a pooled gate is an in-use gate ────────────');

test('idle gates forfeit without the pool…', () => {
  let s = mpState({ existingFreq: 5 });
  s.gates = { ...s.gates, XYZ: 1 };
  s = { ...s, gateIdleWeeks: { XYZ: 23 } };  // one week from forfeiture
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(next.gates.XYZ, undefined, 'forfeited');
  assert.ok((next.gateLockouts?.XYZ ?? 0) > 0, 'locked out');
});

test('…but not while partners are drawing on their slots', () => {
  let s = mpState({ existingFreq: 5, pool: { XYZ: { grant: 0, lentOut: 12 } } });
  s.gates = { ...s.gates, XYZ: 1 };
  s = { ...s, gateIdleWeeks: { XYZ: 23 } };
  const next = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(next.gates.XYZ, 1, 'pooled = in use by the owner');
  assert.equal(next.gateIdleWeeks?.XYZ, undefined, 'idle clock resets while lent');
});

console.log('\n── 6. computeSlotPools (server) ──────────────────────────');

const rowFor = (id, { hub = 'ORD', routes = [], cargoRoutes = [], gateLockouts = {} } = {}) => ({
  id, name: id.toUpperCase(), hub, status: 'ACTIVE',
  state: { hub, routes, cargoRoutes, gateLockouts },
});
const alliance2 = new Map([
  ['b1', { membership: { allianceId: 'al1' } }],
  ['o1', { membership: { allianceId: 'al1' } }],
]);
// AAA: owner o1 holds 4 gates and uses 100 slots; borrower b1 holds 1 gate and
// flies 80 (30 past its own 50).
const baseAAA = (surcharge = false) => ({
  AAA: {
    capacity: 25, taken: 5, surcharge,
    holdings: { o1: { count: 4 }, b1: { count: 1 } },
  },
});
const airlinesAAA = () => [
  rowFor('o1', { routes: [R('x', 'AAA', 'BBB', 'a1', 50), R('y', 'AAA', 'CCC', 'a2', 50)] }),
  rowFor('b1', { routes: [R('z', 'AAA', 'DDD', 'a1', 80)] }),
];
const share = (airlineId, airportCode, sharing = true, reservedSlots = 0) =>
  ({ airlineId, airportCode, sharing, reservedSlots });

test('spare, draw, grant, attribution and money all line up', () => {
  const pools = computeSlotPools({
    base: baseAAA(), airlines: airlinesAAA(), allianceMap: alliance2,
    shares: [share('o1', 'AAA')], weekIdx: 10,
  });
  const o1 = pools.get('o1').AAA;
  const b1 = pools.get('b1').AAA;
  assert.equal(o1.shared, 4 * 50 - 100, 'owner spare = cap − usage');
  assert.equal(b1.draw, 30, 'borrower draw = usage past own capacity');
  assert.equal(b1.grant, 50, 'grant caps at the borrower\'s own slot capacity');
  assert.equal(o1.lentOut, 30);
  // 'AAA' is not a real airport — the service prices unknown tiers at the
  // $50k/month default; match its exact arithmetic.
  const perSlot = slotPoolPerSlotFee(getAirport('AAA'), false);
  assert.equal(b1.weeklyCost, Math.round(30 * perSlot));
  assert.equal(o1.weeklyEarnings, Math.round(30 * perSlot));
  assert.equal(b1.lenders[0].airlineId, 'o1');
  assert.equal(o1.borrowers[0].airlineId, 'b1');
});

test('per-slot price = base weekly fee ÷ slots × markup (surcharge included)', () => {
  const ap = { tier: 'major' };
  const plain = slotPoolPerSlotFee(ap, false);
  assert.ok(Math.abs(plain - ((GATE_FEE_BY_TIER.major / 4) / SLOTS_PER_GATE) * SLOT_POOL_MARKUP) < 1e-9);
  assert.ok(slotPoolPerSlotFee(ap, true) > plain, 'congested airports price higher');
});

test('the owner\'s reserve is honoured', () => {
  const pools = computeSlotPools({
    base: baseAAA(), airlines: airlinesAAA(), allianceMap: alliance2,
    shares: [share('o1', 'AAA', true, 80)], weekIdx: 10,
  });
  assert.equal(pools.get('o1').AAA.shared, 20, '100 spare − 80 reserved');
  assert.equal(pools.get('b1').AAA.draw, 20, 'pool only covers 20 of the 30 needed');
});

test('sharing off (or no row) shares nothing', () => {
  const pools = computeSlotPools({
    base: baseAAA(), airlines: airlinesAAA(), allianceMap: alliance2,
    shares: [share('o1', 'AAA', false)], weekIdx: 10,
  });
  assert.equal(pools.get('b1')?.AAA?.grant ?? 0, 0);
});

test('guarantee hub gates never feed the pool', () => {
  // o1's hub IS AAA and they hold exactly the guaranteed 5 gates, all idle.
  const base = { AAA: { capacity: 25, taken: 6, surcharge: false, holdings: { o1: { count: 5 }, b1: { count: 1 } } } };
  const airlines = [
    rowFor('o1', { hub: 'AAA', routes: [] }),
    rowFor('b1', { routes: [R('z', 'AAA', 'DDD', 'a1', 80)] }),
  ];
  const pools = computeSlotPools({
    base, airlines, allianceMap: alliance2, shares: [share('o1', 'AAA')], weekIdx: 10,
  });
  assert.equal(pools.get('o1')?.AAA?.shared ?? 0, 0, 'all five gates are the personal guarantee');
  assert.equal(pools.get('b1')?.AAA?.grant ?? 0, 0);
});

test('a rule-5 lockout bars borrowing', () => {
  const airlines = [
    airlinesAAA()[0],
    rowFor('b1', { routes: [R('z', 'AAA', 'DDD', 'a1', 80)], gateLockouts: { AAA: 99 } }),
  ];
  const pools = computeSlotPools({
    base: baseAAA(), airlines, allianceMap: alliance2,
    shares: [share('o1', 'AAA')], weekIdx: 10,
  });
  assert.equal(pools.get('b1')?.AAA?.grant ?? 0, 0);
});

test('no alliance → no pool; a lone member → no pool', () => {
  assert.equal(computeSlotPools({
    base: baseAAA(), airlines: airlinesAAA(), allianceMap: new Map(),
    shares: [share('o1', 'AAA')], weekIdx: 10,
  }).size, 0);
  const lone = new Map([['o1', { membership: { allianceId: 'al1' } }]]);
  assert.equal(computeSlotPools({
    base: baseAAA(), airlines: airlinesAAA(), allianceMap: lone,
    shares: [share('o1', 'AAA')], weekIdx: 10,
  }).size, 0);
});

test('over-subscription is deterministic: airlineId order, run-to-run identical', () => {
  const alliance3 = new Map([
    ['a9', { membership: { allianceId: 'al1' } }],
    ['b1', { membership: { allianceId: 'al1' } }],
    ['o1', { membership: { allianceId: 'al1' } }],
  ]);
  const base = { AAA: { capacity: 25, taken: 6, surcharge: false, holdings: { o1: { count: 4 }, b1: { count: 1 }, a9: { count: 1 } } } };
  const airlines = [
    airlinesAAA()[0],                                                      // o1: 100 spare
    rowFor('b1', { routes: [R('z', 'AAA', 'DDD', 'a1', 110) ] }),          // needs 60, capped at 50
    rowFor('a9', { routes: [R('w', 'AAA', 'EEE', 'a1', 120) ] }),          // needs 70, capped at 50
  ];
  const args = () => ({
    base: JSON.parse(JSON.stringify(base)), airlines, allianceMap: alliance3,
    shares: [share('o1', 'AAA')], weekIdx: 10,
  });
  const p1 = computeSlotPools(args());
  const p2 = computeSlotPools(args());
  assert.equal(p1.get('a9').AAA.draw, 50, '"a9" sorts first and draws its full cap');
  assert.equal(p1.get('b1').AAA.draw, 50, '100-slot pool covers both draws');
  assert.equal(p1.get('a9').AAA.grant - p1.get('a9').AAA.draw, 0, 'nothing left over (grant = draw)');
  assert.deepEqual(p1.get('a9').AAA, p2.get('a9').AAA, 'byte-identical re-run');
  assert.deepEqual(p1.get('b1').AAA, p2.get('b1').AAA, 'byte-identical re-run');
  const cost = p1.get('a9').AAA.weeklyCost + p1.get('b1').AAA.weeklyCost;
  assert.ok(Math.abs(cost - p1.get('o1').AAA.weeklyEarnings) <= 2, 'money conserved to rounding');
});

console.log('\n── 7. Injection plumbing ─────────────────────────────────');

test('rivalOverlay injects allianceSlotPool; stripRivals removes it', () => {
  const overlay = rivalOverlay({ gateMarket: { week: 1, airports: {}, slotPool: { AAA: { grant: 9 } } } });
  assert.equal(overlay.allianceSlotPool.AAA.grant, 9);
  const emptied = rivalOverlay({ gateMarket: { week: 1, airports: {} } });
  assert.deepEqual(emptied.allianceSlotPool, {}, 'gate view without a pool injects {} — the wind-down signal');
  const stripped = stripRivals({ cash: 1, allianceSlotPool: { AAA: {} }, gateMarket: {} });
  assert.equal(stripped.allianceSlotPool, undefined);
  assert.equal(stripped.gateMarket, undefined);
  assert.equal(stripped.cash, 1);
});

console.log(`\n${'─'.repeat(56)}\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
