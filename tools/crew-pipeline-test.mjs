// A7 — crew pipeline model (pure functions; no state wiring, no DB).
//
// Crew used to be infinitely elastic and instantaneous: the wage bill scaled
// with the fleet and every delivered aircraft flew at full capability the same
// week. These pin the model that makes crew a resource you plan for.
//
//   node tools/crew-pipeline-test.mjs
import assert from 'node:assert/strict';
import {
  LABOR_GROUPS, DEFAULT_LABOR_STATE, laborEffects, fleetCrewScale,
  CREW_LEAD_WEEKS, CREW_TRAINING_COST, CREW_SEVERE_SHORTFALL, CREW_MAX_OTP_PENALTY,
  CREW_ATTRITION_BASE, crewRequired, crewAvailable, crewInTraining, crewShortfall,
  crewOtpPenalty, crewAttritionRate, crewHireCost, seedCrewFor, unstaffedCrewScale,
  ensureCrewSeeded, starterCrewFloor, splitStarterHire, CREW_INSTANT_AIRCRAFT,
} from '../packages/engine/src/data/labor.js';

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const TYPES = { nb: { category: 'Narrow Body' }, wb: { category: 'Wide Body' }, tp: { category: 'Turboprop' } };
const typeOf = (a) => TYPES[a.t];
const FLEET = [{ t: 'nb' }, { t: 'nb' }, { t: 'wb' }];
// Past the founding-crew grace, so shortfall maths is actually exercised.
const BIG = Array.from({ length: 10 }, () => ({ t: 'nb' }));

// ── Requirement reuses the wage-bill sizing, so it needs no new calibration ──
t('crew requirement is the same narrowbody-equivalent scale the wage bill uses', () => {
  for (const g of LABOR_GROUPS) {
    assert.equal(crewRequired(g.id, FLEET, typeOf), fleetCrewScale(g.id, FLEET, typeOf));
  }
  assert.ok(crewRequired('cabinCrew', FLEET, typeOf) > crewRequired('cabinCrew', [{ t: 'nb' }], typeOf),
    'a bigger fleet needs more crew');
  assert.ok(crewRequired('pilots', [{ t: 'wb' }], typeOf) > crewRequired('pilots', [{ t: 'tp' }], typeOf),
    'a widebody needs more pilots than a turboprop');
});

// ── Lead times: hiring is not instantaneous, and pilots are the slowest ──────
t('every group has a lead time, and pilots take longest', () => {
  for (const g of LABOR_GROUPS) assert.ok(CREW_LEAD_WEEKS[g.id] >= 1, `${g.id} has no lead time`);
  assert.ok(CREW_LEAD_WEEKS.pilots > CREW_LEAD_WEEKS.cabinCrew, 'pilots must outlast cabin crew');
  assert.ok(CREW_LEAD_WEEKS.cabinCrew > CREW_LEAD_WEEKS.groundStaff, 'cabin crew must outlast ground staff');
});

t('hiring costs money, scaled per head, and pilots cost most', () => {
  assert.equal(crewHireCost('pilots', 10), 10 * CREW_TRAINING_COST.pilots);
  assert.equal(crewHireCost('pilots', 0), 0);
  assert.ok(CREW_TRAINING_COST.pilots > CREW_TRAINING_COST.groundStaff);
});

// ── Shortfall: graduated, not a cliff ────────────────────────────────────────
t('a fully staffed airline has no shortfall and no penalty', () => {
  const full = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const sf = crewShortfall(full, FLEET, typeOf);
  assert.equal(sf.worst, 0);
  assert.equal(sf.severe, false);
  assert.equal(crewOtpPenalty(sf), 0);
  assert.equal(unstaffedCrewScale(full, FLEET, typeOf), 0, 'nothing is grounded when fully staffed');
});

t('a small shortfall degrades the operation without grounding anything', () => {
  const full = seedCrewFor(DEFAULT_LABOR_STATE, BIG, typeOf);
  const need = crewRequired('pilots', BIG, typeOf);
  const mild = { ...full, pilots: { ...full.pilots, headcount: need * 0.95 } }; // 5% short
  const sf = crewShortfall(mild, BIG, typeOf);
  assert.ok(sf.worst > 0 && sf.worst < CREW_SEVERE_SHORTFALL, 'should sit inside the soft band');
  assert.equal(sf.severe, false);
  assert.ok(crewOtpPenalty(sf) > 0, 'a soft shortfall still costs on-time performance');
  assert.equal(unstaffedCrewScale(mild, BIG, typeOf), 0, 'the soft band must not ground aircraft');
});

t('past the severe line aircraft go unstaffed, and the OTP penalty is capped', () => {
  const full = seedCrewFor(DEFAULT_LABOR_STATE, BIG, typeOf);
  const bad = { ...full, pilots: { ...full.pilots, headcount: 0 } };
  const sf = crewShortfall(bad, BIG, typeOf);
  assert.equal(sf.severe, true);
  assert.ok(unstaffedCrewScale(bad, BIG, typeOf) > 0, 'severe understaffing must ground capacity');
  assert.ok(crewOtpPenalty(sf) <= CREW_MAX_OTP_PENALTY + 1e-9, 'penalty must not exceed its cap');
});

// ── Starter crew: the counterpart of the instant-delivery Starter Fleet perk ─
t('the starter allowance covers two aircraft, whatever they are', () => {
  const f2nb = [{ t: 'nb' }, { t: 'nb' }], f2wb = [{ t: 'wb' }, { t: 'wb' }];
  for (const fleet of [f2nb, f2wb]) {
    assert.ok(Math.abs(starterCrewFloor('pilots', fleet, typeOf) - crewRequired('pilots', fleet, typeOf)) < 1e-9,
      'two aircraft must sit entirely inside the starter allowance');
  }
  const f10 = starterCrewFloor('pilots', BIG, typeOf);
  assert.ok(Math.abs(f10 - crewRequired('pilots', BIG, typeOf) * 0.2) < 1e-9,
    'ten aircraft get two aircraft worth of allowance, not more');
});

t('hiring inside the allowance is instant; beyond it, it trains', () => {
  const two = [{ t: 'nb' }, { t: 'nb' }];
  const floor = starterCrewFloor('pilots', two, typeOf);
  // Crewing up the first two aircraft from nothing: all instant.
  const a = splitStarterHire('pilots', Math.floor(floor), 0, two, typeOf);
  assert.equal(a.trained, 0, 'the opening hire must not sit in training');
  assert.ok(a.instant > 0);
  // Already at the floor: everything trains.
  const b = splitStarterHire('pilots', 5, floor, two, typeOf);
  assert.equal(b.instant, 0, 'past the allowance nothing is instant');
  assert.equal(b.trained, 5);
  // Straddling the line: split, never double-counted.
  const c = splitStarterHire('pilots', 10, Math.max(0, floor - 1), two, typeOf);
  assert.equal(c.instant + c.trained, 10, 'a straddling hire must not lose or invent crew');
});

t('crew are genuinely required for every aircraft — the allowance is about WAITING', () => {
  const bare = Object.fromEntries(LABOR_GROUPS.map(g => [g.id, { payMultiplier: 1, morale: 80, headcount: 0 }]));
  const two = [{ t: 'nb' }, { t: 'nb' }];
  assert.ok(crewShortfall(bare, two, typeOf).worst > 0,
    'an airline that has hired nobody is short even inside the allowance');
});

t('a short RAMP does not ground a jet; short PILOTS do', () => {
  const full = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const ramp = { ...full, groundStaff: { ...full.groundStaff, headcount: 0 } };
  assert.equal(unstaffedCrewScale(ramp, FLEET, typeOf), 0, 'ground staff are not flight-critical');
  assert.ok(crewOtpPenalty(crewShortfall(ramp, FLEET, typeOf)) > 0, '...but they still hurt on-time');
  const pilots = { ...full, pilots: { ...full.pilots, headcount: 0 } };
  assert.ok(unstaffedCrewScale(pilots, FLEET, typeOf) > 0);
});

// ── The transient field: absent → nothing moves (classic worlds, previews) ───
t('laborEffects is unchanged when no shortfall is attached', () => {
  const base = laborEffects(DEFAULT_LABOR_STATE).onTimeRate;
  const withEmpty = laborEffects({ ...DEFAULT_LABOR_STATE, crewShortfall: null }).onTimeRate;
  assert.equal(base, withEmpty, 'a null shortfall must be a no-op');
  assert.equal(laborEffects({ ...DEFAULT_LABOR_STATE }).onTimeRate, base);
});

t('an attached shortfall lowers the on-time rate', () => {
  const full = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const bad = { ...full, pilots: { ...full.pilots, headcount: 0 } };
  const sf = crewShortfall(bad, FLEET, typeOf);
  const before = laborEffects(full).onTimeRate;
  const after = laborEffects({ ...bad, crewShortfall: sf }).onTimeRate;
  assert.ok(after < before, `understaffing must cost on-time (${after} !< ${before})`);
});

// ── Attrition gives the pay slider a second meaning ─────────────────────────
t('underpaying bleeds crew faster; paying up retains them', () => {
  const market = crewAttritionRate(1.0, 80);
  assert.ok(Math.abs(market - CREW_ATTRITION_BASE) < 1e-9, 'market pay is the base rate');
  assert.ok(crewAttritionRate(0.7, 56) > market * 2, 'underpaying should bleed clearly faster');
  assert.ok(crewAttritionRate(1.3, 100) < market, 'paying above market should retain');
  assert.ok(crewAttritionRate(0.1, 10) < 1, 'attrition stays a rate, never the whole workforce');
});

// ── Bookkeeping helpers ─────────────────────────────────────────────────────
t('available excludes anyone still in training', () => {
  const st = { pilots: { headcount: 12, pipeline: [{ count: 5, readyAbsWeek: 99 }, { count: 3, readyAbsWeek: 120 }] } };
  assert.equal(crewAvailable(st, 'pilots'), 12);
  assert.equal(crewInTraining(st, 'pilots'), 8);
  assert.equal(crewAvailable({}, 'pilots'), 0);
  assert.equal(crewInTraining({}, 'pilots'), 0);
});

t('seeding staffs a fleet exactly, with an empty pipeline', () => {
  const seeded = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  for (const g of LABOR_GROUPS) {
    assert.ok(seeded[g.id].headcount >= crewRequired(g.id, FLEET, typeOf), `${g.id} understaffed at seed`);
    assert.deepEqual(seeded[g.id].pipeline, []);
    assert.equal(seeded[g.id].payMultiplier, 1.0, 'seeding must preserve pay');
  }
  assert.equal(crewShortfall(seeded, FLEET, typeOf).worst, 0);
});

// ── Reducer integration: hiring, training, maturation, attrition ────────────
const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const NB = 'b737800';
const acType = getAircraftType(NB);
const baseState = (over = {}) => ({
  ...freshState(), phase: 'playing', week: 10, year: 1, hub: 'JFK', cash: 500_000_000,
  fleet: [], routes: [], cargoRoutes: [], labor: { ...DEFAULT_LABOR_STATE }, ...over,
});
const withCrew = (over = {}) => {
  const fleet = [{ id: 'a1', typeId: NB, status: 'idle', ownershipType: 'owned', ageWeeks: 20 }];
  return baseState({
    crewPipeline: true, fleet,
    labor: seedCrewFor(DEFAULT_LABOR_STATE, fleet, (a) => getAircraftType(a.typeId)),
    ...over,
  });
};

t('HIRE_CREW is inert without the world/save flag', () => {
  const s0 = baseState({ crewPipeline: false });
  assert.equal(gameReducer(s0, { type: 'HIRE_CREW', group: 'pilots', count: 5 }), s0);
});

t('HIRE_CREW charges training up front and adds to the pipeline, NOT to headcount', () => {
  const s0 = withCrew();
  const before = s0.labor.pilots.headcount;
  const s1 = gameReducer(s0, { type: 'HIRE_CREW', group: 'pilots', count: 4 });
  assert.equal(s0.cash - s1.cash, crewHireCost('pilots', 4), 'training must be paid at hire');
  assert.equal(s1.labor.pilots.headcount, before, 'headcount must NOT jump on hire');
  assert.equal(crewInTraining(s1.labor, 'pilots'), 4, 'the batch must be in training');
  assert.equal(s1.labor.pilots.pipeline[0].readyAbsWeek, 10 + CREW_LEAD_WEEKS.pilots);
});

t('an unknown group, a zero hire, or an unaffordable one are refused', () => {
  const s0 = withCrew();
  assert.equal(gameReducer(s0, { type: 'HIRE_CREW', group: 'wizards', count: 5 }), s0);
  assert.equal(gameReducer(s0, { type: 'HIRE_CREW', group: 'pilots', count: 0 }), s0);
  const broke = withCrew({ cash: 10 });
  assert.equal(gameReducer(broke, { type: 'HIRE_CREW', group: 'pilots', count: 50 }), broke);
});

t('a batch joins the line only after its lead time, then counts as available', () => {
  let s = withCrew();
  const start = s.labor.pilots.headcount;
  s = gameReducer(s, { type: 'HIRE_CREW', group: 'pilots', count: 4 });
  for (let i = 0; i < CREW_LEAD_WEEKS.pilots - 1; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(crewInTraining(s.labor, 'pilots'), 4, 'still training just before the lead time');
  assert.ok(crewAvailable(s.labor, 'pilots') < start + 4, 'must not have joined early');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(crewInTraining(s.labor, 'pilots'), 0, 'batch should have graduated');
  assert.ok(crewAvailable(s.labor, 'pilots') > start, 'graduates must reach the line');
});

t('crew leave over time, and underpaying bleeds them faster', () => {
  const run = (payMultiplier) => {
    let s = withCrew();
    s = { ...s, labor: { ...s.labor, pilots: { ...s.labor.pilots, headcount: 100, payMultiplier } } };
    for (let i = 0; i < 12; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    return crewAvailable(s.labor, 'pilots');
  };
  const paidWell = run(1.3), paidBadly = run(0.7);
  assert.ok(paidBadly < 100, 'underpaid crew must leave');
  assert.ok(paidWell > paidBadly, `paying up must retain (${paidWell} !> ${paidBadly})`);
});

t('a classic save never grows a headcount field', () => {
  let s = baseState({ crewPipeline: false });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  for (const g of LABOR_GROUPS) {
    assert.equal(s.labor[g.id].headcount, undefined, `${g.id} gained a headcount in a classic save`);
  }
});

t('a brand-new airline can crew its starter fleet and fly the SAME week', () => {
  // The Starter Fleet perk hands over the first two aircraft instantly; crewing
  // them must not re-introduce the ten-week wait that perk exists to remove.
  const twoJets = [
    { id: 's1', typeId: NB, status: 'idle', ownershipType: 'owned', ageWeeks: 0 },
    { id: 's2', typeId: NB, status: 'idle', ownershipType: 'owned', ageWeeks: 0 },
  ];
  let s = baseState({ crewPipeline: true, fleet: twoJets,
    labor: Object.fromEntries(LABOR_GROUPS.map(g => [g.id, { payMultiplier: 1.0, morale: 80, headcount: 0, pipeline: [] }])) });
  for (const g of LABOR_GROUPS) {
    const need = Math.ceil(crewRequired(g.id, twoJets, (a) => getAircraftType(a.typeId)));
    s = gameReducer(s, { type: 'HIRE_CREW', group: g.id, count: need });
  }
  for (const g of LABOR_GROUPS) {
    assert.equal(crewInTraining(s.labor, g.id), 0, `${g.id} should not be waiting in training`);
  }
  assert.equal(crewShortfall(s.labor, twoJets, (a) => getAircraftType(a.typeId)).worst, 0,
    'the starter fleet must be fully crewed the moment it is hired');
});

t('the THIRD aircraft has to be trained for — the allowance is spent', () => {
  const three = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, typeId: NB, status: 'idle', ownershipType: 'owned', ageWeeks: 0 }));
  const typeOfA = (a) => getAircraftType(a.typeId);
  const floor = starterCrewFloor('pilots', three, typeOfA);
  let s = baseState({ crewPipeline: true, fleet: three,
    labor: { ...DEFAULT_LABOR_STATE, pilots: { payMultiplier: 1.0, morale: 80, headcount: Math.ceil(floor), pipeline: [] } } });
  const need = Math.ceil(crewRequired('pilots', three, typeOfA) - floor);
  s = gameReducer(s, { type: 'HIRE_CREW', group: 'pilots', count: need });
  assert.ok(crewInTraining(s.labor, 'pilots') > 0, 'growth beyond the starter fleet must go through training');
});

// ── Migration: an established airline must not wake up with no staff ────────
const bigFleet = Array.from({ length: 20 }, (_, i) => ({
  id: `big${i}`, typeId: NB, status: 'assigned', ownershipType: 'owned', ageWeeks: 200,
}));

t('ensureCrewSeeded staffs an untracked airline to its CURRENT fleet', () => {
  const seeded = ensureCrewSeeded(DEFAULT_LABOR_STATE, bigFleet, (a) => getAircraftType(a.typeId));
  for (const g of LABOR_GROUPS) {
    assert.ok(seeded[g.id].headcount >= crewRequired(g.id, bigFleet, (a) => getAircraftType(a.typeId)),
      `${g.id} came onto the pipeline understaffed`);
  }
  assert.equal(crewShortfall(seeded, bigFleet, (a) => getAircraftType(a.typeId)).worst, 0,
    'a migrated airline must start fully staffed, not short');
});

t('ensureCrewSeeded is idempotent and never overwrites a tracked group', () => {
  const typeOf = (a) => getAircraftType(a.typeId);
  const once = ensureCrewSeeded(DEFAULT_LABOR_STATE, bigFleet, typeOf);
  const twice = ensureCrewSeeded(once, bigFleet, typeOf);
  assert.equal(twice, once, 'a second pass must be a no-op (same object)');
  const deliberatelyShort = { ...once, pilots: { ...once.pilots, headcount: 1 } };
  const after = ensureCrewSeeded(deliberatelyShort, bigFleet, typeOf);
  assert.equal(after.pilots.headcount, 1, 'an existing headcount must be left alone');
});

t('a 20-aircraft airline adopting the pipeline is staffed by the tick, not fired', () => {
  // The save/world has the flag but predates any headcount tracking.
  const s0 = baseState({ crewPipeline: true, fleet: bigFleet, labor: { ...DEFAULT_LABOR_STATE } });
  for (const g of LABOR_GROUPS) assert.equal(s0.labor[g.id].headcount, undefined, 'fixture must start untracked');
  const s1 = gameReducer(s0, { type: 'ADVANCE_WEEK' });
  for (const g of LABOR_GROUPS) {
    assert.ok((s1.labor[g.id].headcount ?? 0) > 0, `${g.id} was left with no staff after migration`);
  }
  assert.ok(crewShortfall(s1.labor, bigFleet, (a) => getAircraftType(a.typeId)).worst < CREW_SEVERE_SHORTFALL,
    'a migrated airline must not land in the severe band');
});

t('hiring onto an untracked airline does NOT book it down to zero staff', () => {
  const s0 = baseState({ crewPipeline: true, fleet: bigFleet, labor: { ...DEFAULT_LABOR_STATE } });
  const s1 = gameReducer(s0, { type: 'HIRE_CREW', group: 'pilots', count: 2 });
  const need = crewRequired('pilots', bigFleet, (a) => getAircraftType(a.typeId));
  assert.ok(crewAvailable(s1.labor, 'pilots') >= need,
    `hiring must seed first, not zero the workforce (got ${crewAvailable(s1.labor, 'pilots')}, need ${need})`);
  assert.equal(crewInTraining(s1.labor, 'pilots'), 2, 'the new batch is on top of the seeded workforce');
});

t('a classic save is never seeded, even with a big fleet', () => {
  const s0 = baseState({ crewPipeline: false, fleet: bigFleet, labor: { ...DEFAULT_LABOR_STATE } });
  const s1 = gameReducer(s0, { type: 'ADVANCE_WEEK' });
  for (const g of LABOR_GROUPS) {
    assert.equal(s1.labor[g.id].headcount, undefined, `${g.id} gained a headcount in a classic save`);
  }
});

console.log(`\ncrew-pipeline: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
