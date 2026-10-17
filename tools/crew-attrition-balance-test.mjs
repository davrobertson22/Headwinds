// Crew attrition balance pass (2026-10-17).
//
// An era airline 27 years in, every group at the 2.0× cap with "Replace leavers
// automatically" ticked, was STILL short-handed every single week — "2-3 staff
// leave every week at maximum wages". Three things were wrong:
//
//   1. Auto-replace rehired a leaver only AFTER they had gone, and the
//      replacement then sat a week in recruiting plus the group's training lead
//      time. So the line ran permanently (lead + 1) weeks of leavers short, at
//      every pay level: 4% of pilots at 1.0×, still 0.8% at 2.0×, and a
//      permanent on-time penalty with a "Short-handed" warning that never went
//      away. It now hires AHEAD — keeps the people who will leave during that
//      wait already in training — so the line sits at the requirement.
//   2. A gap of a handful of people in thousands still cost on-time and raised
//      the warning. The requirement already includes reserve/standby cover, so
//      a gap within CREW_RESERVE_BAND of it is absorbed by reserves.
//   3. Attrition bottomed out at ~1.88× pay; 1.88×-2.0× cost more and did
//      nothing. The curve above market now reaches its floor exactly at 2.0×.
//      The floor itself (~3.4%/yr: retirements and moves) is unchanged.
//
//   node --import ./tools/_register-loader.mjs tools/crew-attrition-balance-test.mjs

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

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const GROUPS = labor.LABOR_GROUPS.map(g => g.id);
const nb = AIRCRAFT_TYPES.find(t => !t.freighter && t.seats >= 150 && t.seats <= 190 && t.range > 3000);
const typeOf = (a) => getAircraftType(a.typeId);
const plane = (i) => ({ id: `a${i}`, typeId: nb.id, name: `a${i}`, tailNumber: `N${i}`, status: 'idle', ageWeeks: 52, ownershipType: 'owned' });
const FAR = { pilots: 99999, cabinCrew: 99999, groundStaff: 99999, maintenanceTeam: 99999 };

function started(overrides = {}) {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Crew Air', hub: 'JFK', enableObjectives: false });
  return { ...s, cash: 900_000_000, routes: [], cargoRoutes: [], pendingToasts: [], ...overrides };
}
/** `n` narrowbodies, fully staffed, every group at `pay` (locked, so no drift),
 *  morale already settled at that pay, auto-replace on. */
function airline(n, pay) {
  const fleet = Array.from({ length: n }, (_, i) => plane(i));
  const base = started({ fleet, crewPipeline: true, laborRelations: { ...DEFAULT_LABOR_RELATIONS, nextNegotiationAbsWeek: FAR } });
  const seeded = labor.seedCrewFor(base.labor ?? labor.DEFAULT_LABOR_STATE, fleet, typeOf);
  const lab = {};
  for (const id of GROUPS) lab[id] = { ...seeded[id], payMultiplier: pay, indexed: true, morale: labor.moraleTarget(pay), autoReplace: true };
  return { ...base, labor: lab };
}
const tick = (s) => { const n = gameReducer(s, { type: 'ADVANCE_WEEK' }); return { ...n, cash: 900_000_000, pendingToasts: [] }; };
const missingBodies = (s, id) => labor.crewBodies(id,
  labor.crewRequired(id, s.fleet, typeOf) - labor.crewAvailable(s.labor, id));

console.log('\n── auto-replace keeps you fully staffed ───────────────\n');

for (const pay of [1.0, 2.0]) {
  await test(`at ${pay.toFixed(1)}× pay, auto-replace holds every group at the requirement once it settles`, () => {
    let s = airline(60, pay);
    const worst = Object.fromEntries(GROUPS.map(id => [id, -Infinity]));
    let warned = 0;
    for (let w = 1; w <= 80; w++) {
      s = tick(s);
      if (w <= 20) continue;                       // pilots: 10 wks training + queue
      for (const id of GROUPS) worst[id] = Math.max(worst[id], missingBodies(s, id));
      if (labor.crewStatus(s, typeOf).level !== 'ok') warned++;
    }
    for (const id of GROUPS) {
      assert.ok(worst[id] <= 1, `${id}: up to ${worst[id]} people short in steady state at ${pay}× — auto-replace should hire ahead of leavers`);
    }
    assert.equal(warned, 0, `the short-handed warning should not fire in steady state (fired ${warned} weeks)`);
  });
}

await test('hiring ahead does not overstaff: the line stays within ~1% of the requirement', () => {
  let s = airline(60, 1.0);
  for (let w = 1; w <= 80; w++) s = tick(s);
  for (const id of GROUPS) {
    const need = labor.crewRequired(id, s.fleet, typeOf);
    const have = labor.crewAvailable(s.labor, id);
    assert.ok(have <= need * 1.01 + 1 / (labor.CREW_PER_UNIT[id] ?? 1),
      `${id}: ${labor.crewBodies(id, have)} on the line for ${labor.crewBodies(id, need)} needed`);
  }
});

await test('the cover in training is about (lead + 1) weeks of leavers, not more', () => {
  let s = airline(60, 1.0);
  for (let w = 1; w <= 40; w++) s = tick(s);
  for (const id of GROUPS) {
    const need = labor.crewRequired(id, s.fleet, typeOf);
    const g = s.labor[id];
    const weekly = need * labor.crewAttritionRate(1.0, g.morale);
    const onTheWay = labor.crewOnTheWay(s.labor, id);
    const weeks = (labor.CREW_LEAD_WEEKS[id] ?? 0) + 1;
    assert.ok(onTheWay <= weekly * (weeks + 2) + 2 / (labor.CREW_PER_UNIT[id] ?? 1),
      `${id}: ${onTheWay.toFixed(2)} units on the way vs ~${(weekly * weeks).toFixed(2)} expected`);
  }
});

await test('auto-replace still does not hire for GROWTH — new aircraft are the player\'s call', () => {
  let s = airline(40, 1.0);
  for (let w = 1; w <= 30; w++) s = tick(s);
  const grown = { ...s, fleet: [...s.fleet, ...Array.from({ length: 20 }, (_, i) => plane(100 + i))] };
  const plan = labor.autoReplacePlan(grown.labor, grown.fleet, typeOf);
  for (const p of plan) {
    const leaversBodies = labor.crewBodies(p.group, (grown.labor[p.group].lastLeavers ?? 0) + (grown.labor[p.group].replaceOwed ?? 0)) + 1;
    assert.ok(p.bodies <= leaversBodies,
      `${p.group}: auto-replace hired ${p.bodies} into a 20-aircraft growth gap (leavers only: ≤${leaversBodies})`);
  }
});

await test('a shrinking airline is not made to hire', () => {
  let s = airline(60, 1.0);
  for (let w = 1; w <= 30; w++) s = tick(s);
  const shrunk = { ...s, fleet: s.fleet.slice(0, 40) };
  for (const p of labor.autoReplacePlan(shrunk.labor, shrunk.fleet, typeOf)) {
    assert.equal(p.bodies, 0, `${p.group}: hired ${p.bodies} with a third of the fleet gone`);
  }
});

console.log('\n── reserve cover absorbs a tiny gap ───────────────────\n');

const FLEET = Array.from({ length: 200 }, (_, i) => plane(i));
const full = labor.seedCrewFor(labor.DEFAULT_LABOR_STATE, FLEET, typeOf);
const shortBy = (id, frac) => ({ ...full, [id]: { ...full[id], headcount: labor.crewRequired(id, FLEET, typeOf) * (1 - frac) } });

await test('cabin crew 0.8% short (≈29 of 3,600) costs nothing and raises no warning', () => {
  const lab = shortBy('cabinCrew', 0.008);
  assert.ok(labor.crewBodies('cabinCrew', labor.crewRequired('cabinCrew', FLEET, typeOf) * 0.008) > 1);
  const sf = labor.crewShortfall(lab, FLEET, typeOf);
  assert.equal(sf.byGroup.cabinCrew, 0);
  assert.equal(labor.crewOtpPenalty(sf), 0);
  assert.equal(labor.crewStatus({ crewPipeline: true, labor: lab, fleet: FLEET }, typeOf).level, 'ok');
});

await test('past the reserve band it is a real shortfall again', () => {
  const sf = labor.crewShortfall(shortBy('pilots', 0.02), FLEET, typeOf);
  assert.ok(sf.byGroup.pilots > 0.019);
  assert.ok(labor.crewOtpPenalty(sf) > 0);
});

await test('a small airline missing ONE whole person of twenty is still short (the band is a fraction, not a free pass)', () => {
  const two = [plane(0)];
  const s = labor.seedCrewFor(labor.DEFAULT_LABOR_STATE, two, typeOf);
  const need = labor.crewRequired('cabinCrew', two, typeOf);
  const lab = { ...s, cabinCrew: { ...s.cabinCrew, headcount: need - 1.5 / labor.CREW_PER_UNIT.cabinCrew } };
  assert.ok(labor.crewShortfall(lab, two, typeOf).byGroup.cabinCrew > 0);
});

console.log('\n── top pay buys something all the way to 2.0× ──────────\n');

await test('attrition keeps falling between 1.0× and 2.0× — no dead zone at the top of the slider', () => {
  let prev = Infinity;
  for (let p = 1.0; p <= 2.0001; p += 0.05) {
    const r = labor.crewAttritionRate(p, 100);
    assert.ok(r < prev - 1e-9, `rate at ${p.toFixed(2)}× (${r}) should be below the step before (${prev})`);
    prev = r;
  }
});

await test('the floor at 2.0× is unchanged (~3.4%/yr at full morale)', () => {
  const r = labor.crewAttritionRate(2.0, 100);
  assert.ok(Math.abs(r - labor.CREW_ATTRITION_BASE * 0.25 * (1 + (80 - 100) / 60)) < 1e-12);
  const yr = 1 - Math.pow(1 - r, 52);
  assert.ok(yr > 0.03 && yr < 0.04, `${(yr * 100).toFixed(2)}%/yr`);
});

await test('below market nothing moved', () => {
  for (const [p, m] of [[0.5, 40], [0.7, 56], [0.8, 64], [0.95, 76]]) {
    const old = labor.CREW_ATTRITION_BASE
      * Math.max(0.25, Math.min(4, Math.pow(1 / p, 2.2)))
      * Math.max(0.5, Math.min(2.5, 1 + (80 - m) / 60));
    assert.ok(Math.abs(labor.crewAttritionRate(p, m) - old) < 1e-12, `${p}×`);
  }
  assert.equal(labor.crewAttritionRate(1.0, 80), labor.CREW_ATTRITION_BASE);
});

console.log('\n── multiplayer: cover follows the going rate ───────────\n');

await test('out-paid by rivals (going rate 1.4×), auto-replace still holds the line — cover is sized at RELATIVE pay', () => {
  const MARKET = { pilots: 1.4, cabinCrew: 1.4, groundStaff: 1.4, maintenanceTeam: 1.4 };
  let s = { ...airline(60, 1.0), laborMarket: MARKET };
  let worst = 0;
  for (let w = 1; w <= 80; w++) {
    s = { ...tick(s), laborMarket: MARKET };
    if (w > 20) worst = Math.max(worst, ...GROUPS.map(id => missingBodies(s, id)));
  }
  assert.ok(worst <= 1, `up to ${worst} people short — cover sized at own pay misses the poaching`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
