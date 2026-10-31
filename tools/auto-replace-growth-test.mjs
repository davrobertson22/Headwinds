// "Replace leavers automatically" on a GROWING airline (2026-10-30).
//
// Ported from Tailwinds (same engine change). Discord, 2026-10-21 (VodkaOnFire): "On Tailwinds, auto-hiring staff does not
// always guarantee the staff will appear before leavers. I regularly see 1-2
// weeks where I am short and thus being negatively affected."
//
// The 2026-10-17 hire-ahead fix (crew-attrition-balance-test) held a STEADY
// fleet at its requirement. A growing one still went short, three ways:
//
//   1. Crew hired for an aircraft on order were measured against the fleet on
//      the ramp, so they read as a surplus. Auto-replace stopped replacing
//      leavers and stopped topping up its cover for the whole training wait;
//      the cover drained out of the pipeline and, weeks after the delivery,
//      the line ran short until one catch-up batch graduated.
//   2. Replacements queued BEHIND a growth hire waiting in the recruiting queue.
//   3. "Hire by week N" ignored the recruiting queue, so crew hired on the due
//      date for a delivery bigger than one week's intake landed after it.
//   (4. Cover rounded down to whole people, so a small airline sat one person
//       — past the reserve band — short.)
//
//   node --import ./tools/_register-loader.mjs tools/auto-replace-growth-test.mjs

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
const { AIRCRAFT_TYPES, getAircraftType } = await import('../src/data/aircraft.js');
const { DEFAULT_LABOR_RELATIONS } = await import('../src/data/laborRelations.js');
const labor = await import('../src/data/labor.js');
const tm = await import('../src/models/talentMarket.js');

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
const absW = (s) => (s.year - 1) * 52 + s.week;

function airline(n, pay = 1.0) {
  const fleet = Array.from({ length: n }, (_, i) => plane(i));
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Crew Air', hub: 'JFK', enableObjectives: false });
  const base = { ...s, cash: 9e9, routes: [], cargoRoutes: [], pendingToasts: [], fleet, crewPipeline: true,
    laborRelations: { ...DEFAULT_LABOR_RELATIONS, nextNegotiationAbsWeek: FAR } };
  const seeded = labor.seedCrewFor(base.labor ?? labor.DEFAULT_LABOR_STATE, fleet, typeOf);
  const lab = {};
  for (const id of GROUPS) lab[id] = { ...seeded[id], payMultiplier: pay, indexed: true, morale: labor.moraleTarget(pay), autoReplace: true };
  return { ...base, labor: lab };
}
const tick = (s) => ({ ...gameReducer(s, { type: 'ADVANCE_WEEK' }), cash: 9e9, pendingToasts: [] });
const withOrders = (s, weeksOut) => ({ ...s, pendingOrders: weeksOut.map((d, i) => (
  { id: `o${i}`, typeId: nb.id, name: `new${i}`, deliverAbsWeek: absW(s) + d, ownershipType: 'owned' })) });

/** A player who does what the Operations card says: the Hire button sized for
 *  aircraft landing inside the training window, and, once "hire now" shows for
 *  the next delivery, that delivery's crew (the card's own numbers, labor.js). */
function followTheCard(s) {
  for (const id of GROUPS) {
    const g = s.labor[id];
    const now = absW(s);
    const relPay = tm.relativePay(s, id, g.payMultiplier);
    const onLine = labor.crewAvailable(s.labor, id);
    const onTheWay = labor.crewOnTheWay(s.labor, id);
    const arriving = labor.deliveriesWithinLeadTime(id, s.pendingOrders, now);
    const ahead = labor.crewHiresNeeded(id, {
      need: labor.crewRequiredAhead(id, s.fleet, s.pendingOrders, typeOf, now), onLine, inTraining: onTheWay,
      payMultiplier: relPay, morale: g.morale,
      weeksToTarget: arriving.length ? Math.max(...arriving.map(o => o.deliverAbsWeek - now)) : 0 });
    const button = Math.round(ahead * labor.CREW_PER_UNIT[id]);
    if (button > 0) { s = gameReducer(s, { type: 'HIRE_CREW', group: id, bodies: button }); continue; }
    const intake = tm.weeklyIntakeUnits(labor.crewRequired(id, s.fleet, typeOf), relPay);
    const queueWeeks = labor.nextDeliveryQueueWeeks(id, { fleet: s.fleet, pendingOrders: s.pendingOrders, typeOf,
      absWeek: now, onLine, onTheWay, recruiting: g.recruiting ?? 0, relPay, morale: g.morale, intakePerWeek: intake });
    if (labor.weeksUntilHiringDue(id, s.pendingOrders, now, queueWeeks) !== 0) continue;
    const due = Math.min(...s.pendingOrders.map(o => o.deliverAbsWeek));
    const landing = s.pendingOrders.filter(o => o.deliverAbsWeek <= due);
    const hire = labor.crewHiresNeeded(id, { need: labor.crewRequired(id, [...s.fleet, ...landing], typeOf),
      onLine, inTraining: onTheWay, payMultiplier: relPay, morale: g.morale, weeksToTarget: due - now });
    const bodies = Math.round(hire * labor.CREW_PER_UNIT[id]);
    if (bodies > 0) s = gameReducer(s, { type: 'HIRE_CREW', group: id, bodies });
  }
  return s;
}

function shortWeeks(s, weeks) {
  const out = [];
  for (let w = 1; w <= weeks; w++) {
    s = tick(followTheCard(s));
    const st = labor.crewStatus(s, typeOf);
    if (st.level !== 'ok') out.push(`wk ${w}: ` + st.groups.map(g => `${g.id} ${g.missing} short`).join(', '));
  }
  return { s, out };
}

console.log('\n── crew training for a delivery are not spare people ──\n');

await test('six aircraft land together: no week short before, at or after the delivery', () => {
  let s = airline(60);
  for (let w = 0; w < 30; w++) s = tick(s);
  const { s: end, out } = shortWeeks(withOrders(s, [14, 14, 14, 14, 14, 14]), 36);
  assert.equal(end.fleet.length, 66);
  assert.deepEqual(out, [], out.slice(0, 4).join(' · '));
});

await test('a steady stream of deliveries (one every 3 weeks) never runs short', () => {
  let s = airline(60);
  for (let w = 0; w < 30; w++) s = tick(s);
  const { s: end, out } = shortWeeks(withOrders(s, Array.from({ length: 16 }, (_, i) => 12 + 3 * i)), 72);
  assert.equal(end.fleet.length, 76);
  assert.deepEqual(out, [], out.slice(0, 4).join(' · '));
});

await test('a small airline growing one aircraft at a time is never a person short', () => {
  let s = airline(8);
  for (let w = 0; w < 30; w++) s = tick(s);
  const { out } = shortWeeks(withOrders(s, Array.from({ length: 8 }, (_, i) => 12 + 6 * i)), 64);
  assert.deepEqual(out, [], out.slice(0, 4).join(' · '));
});

await test('with crew training for incoming aircraft, auto-replace keeps replacing every week', () => {
  let s = airline(60);
  for (let w = 0; w < 30; w++) s = tick(s);
  s = withOrders(s, [9, 9, 9]);
  s = gameReducer(s, { type: 'HIRE_CREW', group: 'pilots', bodies: 27 });   // their crew, already paid for
  const blind = labor.autoReplacePlan(s.labor, s.fleet, typeOf);
  assert.equal(blind.find(x => x.group === 'pilots').bodies, 0,
    'measured against the ramp alone, the 27 read as spare (the old bug)');
  for (let w = 1; w <= 8; w++) {
    s = tick(s);
    const lead = labor.CREW_LEAD_WEEKS.pilots;
    const hiredThisWeek = (s.labor.pilots.pipeline ?? [])
      .filter(b => b.readyAbsWeek === absW(s) + lead).reduce((n, b) => n + b.count, 0);
    assert.ok(hiredThisWeek > 0, `week ${w}: no replacement hired while the new aircraft's crew trained`);
  }
});

await test('it still does not hire FOR the incoming aircraft when the player has not', () => {
  let s = airline(40);
  for (let w = 0; w < 30; w++) s = tick(s);
  s = withOrders(s, Array(10).fill(6));
  const plan = labor.autoReplacePlan(s.labor, s.fleet, typeOf, null, { pendingOrders: s.pendingOrders, absWeek: absW(s) });
  for (const p of plan) {
    const g = s.labor[p.group];
    const leavers = labor.crewBodies(p.group, (g.lastLeavers ?? 0) + (g.replaceOwed ?? 0)) + 1;
    assert.ok(p.bodies <= leavers, `${p.group}: hired ${p.bodies} into a 10-aircraft gap (leavers only: ≤${leavers})`);
  }
});

console.log('\n── replacements do not wait behind a growth hire ──────\n');

await test('a replacement starts training even with a big growth hire in the recruiting queue', () => {
  let s = airline(60);
  for (let w = 0; w < 30; w++) s = tick(s);
  s = gameReducer(s, { type: 'HIRE_CREW', group: 'pilots', bodies: 300 });
  assert.ok((s.labor.pilots.recruiting ?? 0) > 0, 'the growth hire overflows into the queue');
  const queued = s.labor.pilots.recruiting;
  const growth = gameReducer(s, { type: 'HIRE_CREW', group: 'pilots', bodies: 3 });
  assert.ok(growth.labor.pilots.recruiting > queued, 'an ordinary hire still joins the back of the queue');
  const repl = gameReducer(s, { type: 'HIRE_CREW', group: 'pilots', bodies: 3, replace: true });
  assert.equal(repl.labor.pilots.recruiting, queued, 'a replacement does not');
  assert.equal(repl.labor.pilots.pipeline.length, s.labor.pilots.pipeline.length + 1, 'it goes straight into training');
});

await test('replacements still have a weekly speed limit', () => {
  let s = airline(60, 0.6);
  const cap = tm.weeklyIntakeUnits(labor.crewRequired('pilots', s.fleet, typeOf), tm.relativePay(s, 'pilots', 0.6));
  const many = Math.ceil(cap * labor.CREW_PER_UNIT.pilots * 3);
  s = gameReducer(s, { type: 'HIRE_CREW', group: 'pilots', bodies: many, replace: true });
  assert.ok((s.labor.pilots.recruiting ?? 0) > 0, 'beyond one week\'s intake the rest is queued');
});

console.log('\n── "hire by week N" leaves room for the recruiting queue ──\n');

await test('the due date moves earlier by the weeks the hire will wait in the queue', () => {
  const orders = [{ deliverAbsWeek: 40 }];
  assert.equal(labor.weeksUntilHiringDue('pilots', orders, 20), 10);
  assert.equal(labor.weeksUntilHiringDue('pilots', orders, 20, 2), 8);
  assert.equal(labor.weeksUntilHiringDue('pilots', orders, 39, 2), 0);
});

await test('a delivery whose crew fits in one week\'s intake needs no extra weeks', () => {
  // Ten weeks out, on an airline whose auto-replace cover is already training
  // (so the hire is the new aircraft's crew, not the line's leavers again).
  const id = 'pilots';
  const at = (orders) => {
    const s = withOrders(airline(60), orders);
    const onLine = labor.crewAvailable(s.labor, id);
    return labor.nextDeliveryQueueWeeks(id, { fleet: s.fleet, pendingOrders: s.pendingOrders, typeOf, absWeek: absW(s),
      onLine, onTheWay: labor.crewReplaceCover(id, onLine, 1, 80), recruiting: 0, relPay: 1, morale: 80 });
  };
  assert.equal(at([10]), 0);
  const q8 = at(Array(8).fill(10));
  assert.ok(q8 >= 2, `eight aircraft of pilots is ~4 weeks of intake (got ${q8})`);
});

// Headwinds: the queue-jump is for the engine's own auto-replace hire only. A
// player's HIRE_CREW goes through the decision guard, which forwards just the
// group and size — a forged `replace: true` must never reach the reducer, or
// anyone could double their weekly intake by asking.
await test('a player cannot send replace: true — the decision guard strips it', async () => {
  const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
  const out = guardDecision('HIRE_CREW', { group: 'pilots', bodies: 6, replace: true }, freshState());
  assert.equal(out.replace, undefined);
  assert.deepEqual(Object.keys(out).sort(), ['bodies', 'group']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
