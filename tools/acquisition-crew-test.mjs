// Buying an airline buys its people.
//
// Discord 2026-09-02 (four4forfore): "when you acquire an airline you end up at
// a huge staff defecit and can take 10 weeks to catch up. if you are acquiring
// an airline wouldn't you acquire the staff too?"
//
// ACQUIRE_COMPETITOR inherited the target's fleet, routes, gates and cash and
// left their workforce behind, so a deal that doubled your fleet also halved
// your staffing ratio — unstaffed aircraft, an on-time collapse and a ten-week
// pilot course to undo a deal you had just paid a premium for.
//
//   node tools/acquisition-crew-test.mjs
import assert from 'node:assert/strict';
import { gameReducer } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  LABOR_GROUPS, DEFAULT_LABOR_STATE, seedCrewFor, crewShortfall, crewInTraining, crewRequired,
} from '../packages/engine/src/data/labor.js';

Math.random = () => 0.5;

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
};

const typeOf = (a) => getAircraftType(a.typeId);
const tail = (i, typeId, routeKey) => ({ id: `x${i}`, typeId, routeKey, ageWeeks: 300 });

const PLAYER_FLEET = Array.from({ length: 4 }, (_, i) => ({
  id: `p${i}`, typeId: 'b737800', tailNumber: `N${i}P`, status: 'assigned', ageWeeks: 200,
  config: { economy: 160, premium: 0, business: 0, first: 0 },
}));

const TARGET = {
  id: 'r1', name: 'Rival Air', tier: 'budget', homeHub: 'ORD', cash: 5_000_000,
  marketCap: 40_000_000, baseQualityScore: 50,
  fleet: [
    tail(0, 'b737800', 'ORD-DEN'), tail(1, 'b737800', 'ORD-MSP'),
    tail(2, 'a320neo', 'ORD-PHX'), tail(3, 'a320neo', 'ORD-SEA'),
    tail(4, 'b7879',   'ORD-LHR'), tail(5, 'b7879',   'ORD-NRT'),
  ],
  routes: {
    'ORD-DEN': { frequency: 7, priceMultiplier: 1 }, 'ORD-MSP': { frequency: 7, priceMultiplier: 1 },
    'ORD-PHX': { frequency: 7, priceMultiplier: 1 }, 'ORD-SEA': { frequency: 5, priceMultiplier: 1 },
    'ORD-LHR': { frequency: 5, priceMultiplier: 1 }, 'ORD-NRT': { frequency: 4, priceMultiplier: 1 },
  },
};

function stateWith(labor) {
  return {
    week: 30, year: 3, hub: 'ORD', airlineName: 'Test Air',
    cash: 500_000_000, fleet: PLAYER_FLEET, routes: [], gates: { ORD: 6 },
    routePricing: {}, routeCatering: {}, competitors: [TARGET],
    codeshareAgreements: [], pendingToasts: [], labor,
  };
}

const acquire = (labor) => gameReducer(stateWith(labor), { type: 'ACQUIRE_COMPETITOR', competitorId: 'r1' });

// ── The reported bug ────────────────────────────────────────────────────────

t('the deal really does hand over the fleet (harness sanity)', () => {
  const next = acquire(seedCrewFor(DEFAULT_LABOR_STATE, PLAYER_FLEET, typeOf));
  assert.equal(next.fleet.length, PLAYER_FLEET.length + TARGET.fleet.length);
});

t('a fully staffed airline is still fully staffed the moment the deal closes', () => {
  const before = seedCrewFor(DEFAULT_LABOR_STATE, PLAYER_FLEET, typeOf);
  const next   = acquire(before);
  const sf     = crewShortfall(next.labor, next.fleet, typeOf);
  assert.equal(sf.severe, false, 'aircraft are unstaffed the week the deal closes');
  assert.ok(sf.worst <= 0.02, `still short ${(sf.worst * 100).toFixed(1)}% of crew after acquiring`);
});

t('inherited crew walk in on day one — nobody sits in a training queue', () => {
  const next = acquire(seedCrewFor(DEFAULT_LABOR_STATE, PLAYER_FLEET, typeOf));
  for (const g of LABOR_GROUPS) {
    assert.equal(crewInTraining(next.labor, g.id), 0, `${g.id} inherited crew were sent to training`);
  }
});

t('every group grows — a widebody-heavy target needs more of all of them', () => {
  const before = seedCrewFor(DEFAULT_LABOR_STATE, PLAYER_FLEET, typeOf);
  const next   = acquire(before);
  for (const g of LABOR_GROUPS) {
    assert.ok(next.labor[g.id].headcount > before[g.id].headcount,
      `${g.id} headcount did not move`);
  }
});

// ── What it must NOT do ─────────────────────────────────────────────────────

t('a shortfall you were already carrying is inherited, not forgiven', () => {
  // Measured in crew units, not as a fraction: the merged airline is much
  // bigger, so the same absolute deficit reads as a smaller percentage. What
  // must not happen is the deal quietly hiring the crew you were short of.
  const before = seedCrewFor(DEFAULT_LABOR_STATE, PLAYER_FLEET, typeOf);
  const short  = { ...before };
  for (const g of LABOR_GROUPS) short[g.id] = { ...before[g.id], headcount: Math.ceil(before[g.id].headcount * 0.6) };
  const next = acquire(short);
  for (const g of LABOR_GROUPS) {
    const deficitBefore = crewRequired(g.id, PLAYER_FLEET, typeOf) - short[g.id].headcount;
    const deficitAfter  = crewRequired(g.id, next.fleet, typeOf)   - next.labor[g.id].headcount;
    assert.ok(deficitBefore > 1, `${g.id} harness: start the airline properly short`);
    assert.ok(deficitAfter >= deficitBefore - 1,
      `${g.id}: the acquisition papered over ${(deficitBefore - deficitAfter).toFixed(1)} crew of existing shortfall`);
    assert.ok(deficitAfter <= deficitBefore + 1,
      `${g.id}: the acquisition made an existing shortfall worse`);
  }
});

t('pay and morale are the acquirer\'s, not reset by the deal', () => {
  const before = seedCrewFor({ ...DEFAULT_LABOR_STATE }, PLAYER_FLEET, typeOf);
  for (const g of LABOR_GROUPS) before[g.id] = { ...before[g.id], payMultiplier: 1.2, morale: 96 };
  const next = acquire(before);
  for (const g of LABOR_GROUPS) {
    assert.equal(next.labor[g.id].payMultiplier, 1.2, `${g.id} lost its pay setting`);
    assert.equal(next.labor[g.id].morale, 96, `${g.id} lost its morale`);
  }
});

t('an old save with no crew tracked at all is left for the seeder, not crashed', () => {
  const next = acquire(undefined);
  assert.ok(next.fleet.length > PLAYER_FLEET.length, 'the deal fell over on an unseeded save');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
