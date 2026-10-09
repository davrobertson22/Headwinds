// Labor rework (Discord, 2026-10-03/04): no more union pay demands, a per-group
// wage lock, and a talent market where pay sets how fast you can recruit and
// rivals out-paying you take your people.
//
//   Dunno23:     pay demands that land overnight lapse into a refusal.
//   VodkaOnFire: "Or remove the negotiations altogether" / "being able to lock
//                it at x% would be nice" / "wages should determine how quickly
//                you are able to fill up your staff needs and be part of a
//                market where you compete with other airlines for talent".
//
//   node tools/labor-rework-test.mjs

import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
Math.random = () => 0.5;

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { AIRCRAFT_TYPES, getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { DEFAULT_LABOR_RELATIONS } = await import('../packages/engine/src/data/laborRelations.js');
const labor = await import('../packages/engine/src/data/labor.js');
const tm = await import('../packages/engine/src/models/talentMarket.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const nb = AIRCRAFT_TYPES.find(t => !t.freighter && t.seats >= 150 && t.seats <= 190 && t.range > 3000);
const typeOf = (a) => getAircraftType(a.typeId);
const plane = (i) => ({ id: `a${i}`, typeId: nb.id, name: `a${i}`, tailNumber: `N${i}`, status: 'idle', ageWeeks: 52, ownershipType: 'owned' });
const FAR = { pilots: 99999, cabinCrew: 99999, groundStaff: 99999, maintenanceTeam: 99999 };

function started(overrides = {}) {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Crew Air', hub: 'JFK', enableObjectives: false });
  return { ...s, cash: 900_000_000, routes: [], cargoRoutes: [], pendingToasts: [], ...overrides };
}
/** A crew-pipeline airline of `n` narrowbodies, fully staffed. */
function crewed(n = 40, over = {}) {
  const fleet = Array.from({ length: n }, (_, i) => plane(i));
  const base = started({ fleet, crewPipeline: true, laborRelations: { ...DEFAULT_LABOR_RELATIONS, nextNegotiationAbsWeek: FAR }, ...over });
  return { ...base, labor: labor.seedCrewFor(base.labor ?? labor.DEFAULT_LABOR_STATE, fleet, typeOf) };
}
const tick = (s) => gameReducer(s, { type: 'ADVANCE_WEEK' });
const queued = (s, g) => Number(s.labor[g].recruiting) || 0;
const training = (s, g) => labor.crewInTraining(s.labor, g);

console.log('\n── union pay demands are gone ─────────────────────────\n');

await test('a union that is due to table a demand tables nothing', () => {
  const s0 = started({ week: 10, year: 3, laborRelations: { ...DEFAULT_LABOR_RELATIONS, nextNegotiationAbsWeek: { pilots: 1, cabinCrew: 1, groundStaff: 1, maintenanceTeam: 1 } } });
  const s1 = tick(s0);
  assert.equal(s1.laborRelations.negotiation, null);
  assert.ok(!s1.pendingToasts.some(t => /Contract talks/.test(t.title ?? '')), 'no contract-talks toast');
});

await test('a demand left open on an old save closes quietly — no refusal penalty', () => {
  const s0 = started({ laborRelations: { ...DEFAULT_LABOR_RELATIONS, nextNegotiationAbsWeek: FAR,
    negotiation: { group: 'groundStaff', demandMultiplier: 1.15, weeksLeft: 1, totalWeeks: 4 } } });
  const before = s0.labor.groundStaff.morale;
  const s1 = tick(s0);
  assert.equal(s1.laborRelations.negotiation, null);
  assert.ok(s1.labor.groundStaff.morale >= before - 0.01, `morale must not take the refusal hit (was ${before}, now ${s1.labor.groundStaff.morale})`);
  assert.ok((s1.laborRelations.unrest.groundStaff ?? 0) < 10, 'no refusal unrest');
  assert.ok(!s1.pendingToasts.some(t => /ignored/.test(t.title ?? '')), 'no "demand ignored" toast');
});

console.log('\n── wage lock ──────────────────────────────────────────\n');

await test('SET_PAY_INDEXED holds a premium: no ~6%/yr drift', () => {
  let s = started();
  s = gameReducer(s, { type: 'SET_LABOR_PAY', group: 'pilots', payMultiplier: 1.5 });
  s = gameReducer(s, { type: 'SET_LABOR_PAY', group: 'cabinCrew', payMultiplier: 1.5 });
  s = gameReducer(s, { type: 'SET_PAY_INDEXED', group: 'pilots', indexed: true });
  assert.equal(s.labor.pilots.indexed, true);
  for (let i = 0; i < 26; i++) s = tick(s);
  assert.equal(s.labor.pilots.payMultiplier, 1.5, 'locked group keeps its rate');
  assert.ok(s.labor.cabinCrew.payMultiplier < 1.47, 'unlocked group still drifts toward market');
});

await test('unlocking resumes the drift; a bogus group is ignored', () => {
  let s = started();
  s = gameReducer(s, { type: 'SET_LABOR_PAY', group: 'pilots', payMultiplier: 1.5 });
  s = gameReducer(s, { type: 'SET_PAY_INDEXED', group: 'pilots', indexed: true });
  s = gameReducer(s, { type: 'SET_PAY_INDEXED', group: 'pilots', indexed: false });
  s = tick(s);
  assert.ok(s.labor.pilots.payMultiplier < 1.5);
  assert.equal(gameReducer(s, { type: 'SET_PAY_INDEXED', group: 'wizards', indexed: true }), s);
});

console.log('\n── talent market: the going rate ──────────────────────\n');

await test('the going rate is 1.0× with no rivals, and damped by the rest of the industry', () => {
  const none = tm.goingRateFromRivals([]);
  for (const g of tm.TALENT_GROUP_IDS) assert.equal(none[g], 1);
  const small = tm.goingRateFromRivals([{ fleetSize: 5, labor: { pilots: { payMultiplier: 2.0 } } }]);
  assert.ok(small.pilots > 1 && small.pilots < 1.05, `one 5-tail rival barely moves it (${small.pilots})`);
  const big = tm.goingRateFromRivals([
    { fleetSize: 300, labor: { pilots: { payMultiplier: 1.5 } } },
    { fleetSize: 300, labor: { pilots: { payMultiplier: 1.5 } } },
  ]);
  assert.ok(big.pilots > 1.35 && big.pilots <= 1.5, `big carriers set the market (${big.pilots})`);
  assert.equal(big.cabinCrew, 1, 'a group nobody recorded stays at market');
});

await test('a solo save (no laborMarket) reads 1.0×', () => {
  assert.equal(tm.goingRate({}, 'pilots'), 1);
  assert.equal(tm.relativePay({ laborMarket: { pilots: 1.25 } }, 'pilots', 1.25), 1);
});

console.log('\n── talent market: recruiting speed ────────────────────\n');

await test('a big hire at market pay is NOT all in training at once — the rest queues', () => {
  const s0 = crewed(40);
  const s1 = gameReducer(s0, { type: 'HIRE_CREW', group: 'cabinCrew', count: 40 });
  assert.ok(s1.cash < s0.cash, 'the whole hire is paid for up front');
  const need = labor.crewRequired('cabinCrew', s0.fleet, typeOf);
  const cap = tm.weeklyIntakeUnits(need, 1.0);
  assert.ok(Math.abs(training(s1, 'cabinCrew') - cap) < 1e-6, `this week's intake goes to training (${training(s1, 'cabinCrew')} vs ${cap})`);
  assert.ok(Math.abs(queued(s1, 'cabinCrew') - (40 - cap)) < 1e-6, 'the rest waits in the recruiting queue');
});

await test('higher pay recruits faster', () => {
  const lo = gameReducer(crewed(40), { type: 'HIRE_CREW', group: 'cabinCrew', count: 40 });
  let hi0 = crewed(40);
  hi0 = gameReducer(hi0, { type: 'SET_LABOR_PAY', group: 'cabinCrew', payMultiplier: 1.4 });
  const hi = gameReducer(hi0, { type: 'HIRE_CREW', group: 'cabinCrew', count: 40 });
  assert.ok(training(hi, 'cabinCrew') > training(lo, 'cabinCrew') * 2, 'a 1.4× offer more than doubles the weekly intake');
});

await test('paying the same as rivals who pay 1.4× recruits like paying 1.0× alone', () => {
  let s0 = crewed(40, { laborMarket: { pilots: 1.4, cabinCrew: 1.4, groundStaff: 1.4, maintenanceTeam: 1.4 } });
  s0 = gameReducer(s0, { type: 'SET_LABOR_PAY', group: 'cabinCrew', payMultiplier: 1.4 });
  const s1 = gameReducer(s0, { type: 'HIRE_CREW', group: 'cabinCrew', count: 40 });
  const solo = gameReducer(crewed(40), { type: 'HIRE_CREW', group: 'cabinCrew', count: 40 });
  assert.ok(Math.abs(training(s1, 'cabinCrew') - training(solo, 'cabinCrew')) < 1e-6);
});

await test('two hires in one week share one week of intake (no splitting to dodge it)', () => {
  let s = crewed(40);
  const need = labor.crewRequired('cabinCrew', s.fleet, typeOf);
  const cap = tm.weeklyIntakeUnits(need, 1.0);
  for (let i = 0; i < 10; i++) s = gameReducer(s, { type: 'HIRE_CREW', group: 'cabinCrew', count: 4 });
  assert.ok(Math.abs(training(s, 'cabinCrew') - cap) < 1e-6);
  assert.ok(Math.abs(queued(s, 'cabinCrew') - (40 - cap)) < 1e-6);
});

await test('the tick moves the queue into training at the weekly intake until it is empty', () => {
  let s = gameReducer(crewed(40), { type: 'HIRE_CREW', group: 'cabinCrew', count: 40 });
  const start = queued(s, 'cabinCrew');
  s = tick(s);
  assert.ok(queued(s, 'cabinCrew') < start, 'queue shrinks each week');
  for (let i = 0; i < 30 && queued(s, 'cabinCrew') > 0; i++) s = tick(s);
  assert.equal(queued(s, 'cabinCrew'), 0, 'queue clears');
});

await test('a small hire inside the intake behaves exactly as before', () => {
  const s1 = gameReducer(crewed(40), { type: 'HIRE_CREW', group: 'pilots', count: 1 });
  assert.equal(training(s1, 'pilots'), 1);
  assert.equal(queued(s1, 'pilots'), 0);
});

await test('CANCEL_RECRUITING refunds the unrecruited part and keeps who is training', () => {
  const s1 = gameReducer(crewed(40), { type: 'HIRE_CREW', group: 'cabinCrew', count: 40 });
  const q = queued(s1, 'cabinCrew');
  const s2 = gameReducer(s1, { type: 'CANCEL_RECRUITING', group: 'cabinCrew' });
  assert.equal(queued(s2, 'cabinCrew'), 0);
  assert.equal(s2.cash, s1.cash + labor.crewHireCost('cabinCrew', q));
  assert.equal(training(s2, 'cabinCrew'), training(s1, 'cabinCrew'));
  assert.equal(gameReducer(s2, { type: 'CANCEL_RECRUITING', group: 'cabinCrew' }), s2, 'nothing queued → no-op');
});

await test('the recruiting queue counts as on the way: auto-replace does not hire it twice', () => {
  const s0 = crewed(40);
  const need = labor.crewRequired('cabinCrew', s0.fleet, typeOf);
  const st = { ...s0.labor, cabinCrew: { ...s0.labor.cabinCrew, headcount: need - 10, recruiting: 10, autoReplace: true, lastLeavers: 3 } };
  const plan = labor.autoReplacePlan(st, s0.fleet, typeOf).find(p => p.group === 'cabinCrew');
  assert.equal(plan.bodies, 0, 'nothing to replace when the gap is already being recruited');
});

console.log('\n── talent market: poaching ────────────────────────────\n');

await test('rivals paying more than you take more of your people', () => {
  const solo = tick(crewed(40));
  const hot  = tick(crewed(40, { laborMarket: { pilots: 1.4, cabinCrew: 1.4, groundStaff: 1.4, maintenanceTeam: 1.4 } }));
  assert.ok(hot.labor.pilots.lastLeavers > solo.labor.pilots.lastLeavers * 1.5,
    `out-paid airline loses more (${hot.labor.pilots.lastLeavers} vs ${solo.labor.pilots.lastLeavers})`);
});

await test('solo attrition is unchanged by the market (going rate 1.0×)', () => {
  const s0 = crewed(40);
  const s = tick(s0);
  const g = s.labor.pilots;
  const onLine = s0.labor.pilots.headcount;
  const expect = onLine * labor.crewAttritionRate(1.0, g.morale);
  assert.ok(Math.abs(g.lastLeavers - expect) < 1e-6);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
