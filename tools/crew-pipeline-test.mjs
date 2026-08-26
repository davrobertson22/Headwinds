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
} from '../packages/engine/src/data/labor.js';

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const TYPES = { nb: { category: 'Narrow Body' }, wb: { category: 'Wide Body' }, tp: { category: 'Turboprop' } };
const typeOf = (a) => TYPES[a.t];
const FLEET = [{ t: 'nb' }, { t: 'nb' }, { t: 'wb' }];

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
  const full = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const need = crewRequired('pilots', FLEET, typeOf);
  const mild = { ...full, pilots: { ...full.pilots, headcount: need * 0.95 } }; // 5% short
  const sf = crewShortfall(mild, FLEET, typeOf);
  assert.ok(sf.worst > 0 && sf.worst < CREW_SEVERE_SHORTFALL, 'should sit inside the soft band');
  assert.equal(sf.severe, false);
  assert.ok(crewOtpPenalty(sf) > 0, 'a soft shortfall still costs on-time performance');
  assert.equal(unstaffedCrewScale(mild, FLEET, typeOf), 0, 'the soft band must not ground aircraft');
});

t('past the severe line aircraft go unstaffed, and the OTP penalty is capped', () => {
  const full = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const need = crewRequired('pilots', FLEET, typeOf);
  const bad = { ...full, pilots: { ...full.pilots, headcount: need * 0.5 } };  // 50% short
  const sf = crewShortfall(bad, FLEET, typeOf);
  assert.equal(sf.severe, true);
  assert.ok(unstaffedCrewScale(bad, FLEET, typeOf) > 0, 'severe understaffing must ground capacity');
  assert.ok(crewOtpPenalty(sf) <= CREW_MAX_OTP_PENALTY + 1e-9, 'penalty must not exceed its cap');
  const worse = { ...full, pilots: { ...full.pilots, headcount: 0 } };
  assert.ok(crewOtpPenalty(crewShortfall(worse, FLEET, typeOf)) <= CREW_MAX_OTP_PENALTY + 1e-9);
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

console.log(`\ncrew-pipeline: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
