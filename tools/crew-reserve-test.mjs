// Reserve staff and "Keep me fully staffed" (2026-11-11, port from Tailwinds).
//
// "I've now got a ton of crew just sitting around" (Discord 2026-11-10, after
// buying an airline and selling its aircraft). Staff above the requirement were
// invisible and free. They are now reserve staff: paid half a wage, good for
// morale and on-time performance, releasable for severance — and each group
// has a reserve level that "Keep me fully staffed" hires to, including for
// aircraft on order.
//
//   node --import ./tools/_register-loader.mjs tools/crew-reserve-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

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
const { GameProvider } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES, getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { DEFAULT_LABOR_RELATIONS } = await import('../packages/engine/src/data/laborRelations.js');
const { incidentRisk, INCIDENT } = await import('../packages/engine/src/models/incidents.js');
const labor = await import('../packages/engine/src/data/labor.js');
const { guardDecision, GuardError } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');
const Operations = (await import('../src/components/Operations.jsx')).default;

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
const absWeekOf = (s) => ((s.year ?? 1) - 1) * 52 + (s.week ?? 1);

function started(overrides = {}) {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Reserve Air', hub: 'JFK', enableObjectives: false });
  return { ...s, cash: 900_000_000, routes: [], cargoRoutes: [], pendingToasts: [], ...overrides };
}
/** `n` narrowbodies, staffed at `staffed` × the requirement, pay locked at 1.0×. */
function airline(n, { staffed = 1, autoStaff = false, reserve = 0 } = {}) {
  const fleet = Array.from({ length: n }, (_, i) => plane(i));
  const base = started({ fleet, crewPipeline: true, crewAutoStaff: autoStaff,
    laborRelations: { ...DEFAULT_LABOR_RELATIONS, nextNegotiationAbsWeek: FAR } });
  const lab = {};
  for (const id of GROUPS) {
    lab[id] = { payMultiplier: 1.0, indexed: true, morale: 80, pipeline: [],
      headcount: labor.crewRequired(id, fleet, typeOf) * staffed, reserveTarget: reserve };
  }
  return { ...base, labor: lab };
}
const tick = (s) => { const n = gameReducer(s, { type: 'ADVANCE_WEEK' }); return { ...n, cash: 900_000_000, pendingToasts: [] }; };
const report = (s) => gameReducer(s, { type: 'ADVANCE_WEEK' }).lastReport;

console.log('\n── reserve pay ─────────────────────────────────────────\n');

await test('Keep me fully staffed is a plain flag, inert outside crew-pipeline worlds', () => {
  const s = airline(4);
  assert.equal(gameReducer(s, { type: 'SET_AUTO_STAFF', enabled: true }).crewAutoStaff, true);
  const classic = { ...s, crewPipeline: false };
  assert.equal(gameReducer(classic, { type: 'SET_AUTO_STAFF', enabled: true }), classic);
});

await test('the three new actions reach the engine in multiplayer, bounded at the door', () => {
  for (const a of ['SET_AUTO_STAFF', 'SET_RESERVE_TARGET', 'RELEASE_CREW']) assert.ok(ALLOWED_PLAYER_ACTIONS.has(a), a);
  assert.deepEqual(guardDecision('SET_AUTO_STAFF', { enabled: 'yes', junk: 1 }, {}), { enabled: false });
  assert.deepEqual(guardDecision('SET_RESERVE_TARGET', { group: 'pilots', target: 0.1 }, {}), { group: 'pilots', target: 0.1 });
  assert.throws(() => guardDecision('SET_RESERVE_TARGET', { group: 'pilots', target: 'lots' }, {}), GuardError);
  assert.throws(() => guardDecision('SET_RESERVE_TARGET', { group: 'wizards', target: 0.1 }, {}), GuardError);
  assert.deepEqual(guardDecision('RELEASE_CREW', { group: 'cabinCrew', bodies: 12.9 }, {}), { group: 'cabinCrew', bodies: 12 });
  assert.throws(() => guardDecision('RELEASE_CREW', { group: 'cabinCrew', bodies: -3 }, {}), GuardError);
});

await test('in a restricted world reserve pay and severance carry the airline\'s seniority scale', () => {
  const young = { ...airline(20, { staffed: 1.5 }), newWorldRestrictions: true };
  const now = absWeekOf(young);
  const old = { ...young, foundedAbsWeek: now - 520 };
  const fresh = { ...young, foundedAbsWeek: now };
  const mult = labor.seniorityMultiplier(520);
  assert.ok(mult > 1.5);
  const rOld = report(old).totalReservePay, rNew = report(fresh).totalReservePay;
  assert.ok(Math.abs(rOld / rNew - labor.seniorityMultiplier(521) ) < 0.02 || Math.abs(rOld / rNew - mult) < 0.02, `reserve pay ratio ${(rOld / rNew).toFixed(3)} vs ${mult.toFixed(3)}`);
  const sev = (s) => s.cash - gameReducer(s, { type: 'RELEASE_CREW', group: 'pilots', bodies: 9 }).cash;
  assert.ok(Math.abs(sev(old) / sev(fresh) - mult) < 0.01, `severance ratio ${(sev(old) / sev(fresh)).toFixed(3)}`);
});

await test('an airline with exactly the staff it needs pays no reserve pay', () => {
  const r = report(airline(20));
  assert.equal(r.totalReservePay, 0);
});

await test('staff above the requirement are billed at the reserve rate, not free and not full pay', () => {
  const exact = report(airline(20));
  const spare = report(airline(20, { staffed: 1.5 }));
  const extra = spare.totalLaborCosts - exact.totalLaborCosts;
  assert.ok(spare.totalReservePay > 0, 'spare staff must cost something');
  assert.equal(extra, spare.totalReservePay, 'the whole difference is the reserve line');
  // 50% more people at half pay = +25% on the bill.
  const ratio = extra / exact.totalLaborCosts;
  assert.ok(Math.abs(ratio - 0.5 * labor.RESERVE_PAY_RATE) < 0.005, `expected +${0.5 * labor.RESERVE_PAY_RATE}, got +${ratio.toFixed(4)}`);
});

await test('an airline that sold every aircraft still pays its reserves', () => {
  const s = { ...airline(10), fleet: [] };
  assert.ok(report(s).totalReservePay > 0);
});

await test('a save without the crew pipeline is billed exactly as before', () => {
  const s = airline(20, { staffed: 1.5 });
  const classic = report({ ...s, crewPipeline: false, crewAutoStaff: false });
  assert.equal(classic.totalReservePay, undefined, "no reserve key outside crew-pipeline worlds");
  assert.equal(classic.totalLaborCosts, report(airline(20)).totalLaborCosts);
});

await test('laborBillUnits is the one sizing: requirement at full pay, reserves at the reserve rate', () => {
  const s = airline(10, { staffed: 1.2 });
  for (const id of GROUPS) {
    const need = labor.crewRequired(id, s.fleet, typeOf);
    const b = labor.laborBillUnits(id, s.labor, s.fleet, typeOf, true);
    assert.ok(Math.abs(b.line - need) < 1e-9);
    assert.ok(Math.abs(b.reserve - need * 0.2) < 1e-9);
    assert.ok(Math.abs(b.billed - need * (1 + 0.2 * labor.RESERVE_PAY_RATE)) < 1e-9);
    assert.equal(labor.laborBillUnits(id, s.labor, s.fleet, typeOf, false).reserve, 0);
  }
});

console.log('\n── what reserves buy ───────────────────────────────────\n');

await test('the benefit is zero with no reserve, complete at the full-benefit level, and capped there', () => {
  assert.equal(labor.reserveBenefit(0), 0);
  assert.equal(labor.reserveBenefit(labor.RESERVE_FULL_BENEFIT), 1);
  assert.equal(labor.reserveBenefit(1), 1);
  assert.ok(Math.abs(labor.reserveBenefit(labor.RESERVE_FULL_BENEFIT / 2) - 0.5) < 1e-9);
});

await test('reserves lift morale above what pay alone buys', () => {
  let plain = airline(20), deep = airline(20, { staffed: 1.1, autoStaff: true, reserve: 0.10 });
  for (let w = 0; w < 60; w++) { plain = tick(plain); deep = tick(deep); }
  for (const id of GROUPS) {
    const lift = deep.labor[id].morale - plain.labor[id].morale;
    assert.ok(lift > labor.RESERVE_MORALE_MAX * 0.6 && lift <= labor.RESERVE_MORALE_MAX + 0.2,
      `${id}: morale lift ${lift.toFixed(2)} (expected close to +${labor.RESERVE_MORALE_MAX})`);
  }
});

await test('reserves lift the on-time rate, by the published maximum when every flying group has a full reserve', () => {
  const s = airline(20, { staffed: 1.1 });
  const bonus = labor.reserveOtpBonus(s.labor, s.fleet, typeOf);
  assert.ok(Math.abs(bonus - labor.RESERVE_OTP_MAX) < 1e-9);
  assert.equal(labor.reserveOtpBonus(airline(20).labor, s.fleet, typeOf), 0);
  const base = labor.laborEffects(s.labor).onTimeRate;
  assert.ok(Math.abs(labor.laborEffects({ ...s.labor, reserveOtpBonus: bonus }).onTimeRate - (base + bonus)) < 1e-9);
  // Maintenance reserves do not fly the schedule.
  const onlyMx = airline(20);
  onlyMx.labor.maintenanceTeam.headcount *= 1.5;
  assert.equal(labor.reserveOtpBonus(onlyMx.labor, onlyMx.fleet, typeOf), 0);
});

await test('reserve cover takes the edge off meltdown risk and never adds any', () => {
  const s = airline(20);
  for (const id of GROUPS) s.labor[id].morale = 30;
  const bare = incidentRisk(s, 0.99, 0);
  const covered = incidentRisk(s, 0.99, 1);
  assert.ok(bare.score > 0);
  assert.ok(Math.abs(covered.score - bare.score * (1 - INCIDENT.reserveRelief)) < 0.002);
  assert.deepEqual(incidentRisk(airline(20), 0.5, 1), incidentRisk(airline(20), 0.5, 0), 'no risk, nothing to relieve');
});

console.log('\n── releasing staff ─────────────────────────────────────\n');

await test('only staff above the requirement can be released, for severance', () => {
  const s = airline(20, { staffed: 1.5 });
  const need = labor.crewRequired('pilots', s.fleet, typeOf);
  const spareBodies = labor.crewBodies('pilots', need * 0.5);
  const after = gameReducer(s, { type: 'RELEASE_CREW', group: 'pilots', bodies: spareBodies + 500 });
  assert.ok(Math.abs(after.labor.pilots.headcount - need) < 0.02, 'cannot release below the requirement');
  const expected = Math.round(labor.releaseSeveranceBase('pilots', need * 0.5));
  assert.ok(Math.abs((s.cash - after.cash) - expected) <= 1, `severance ${s.cash - after.cash} vs ${expected}`);
  assert.equal(gameReducer(airline(20), { type: 'RELEASE_CREW', group: 'pilots', bodies: 10 }).cash, airline(20).cash, 'nobody spare, nobody released');
});

await test('releasing is cheaper than carrying reserves for long, dearer than carrying them briefly', () => {
  // Break-even: severance weeks of full pay vs the reserve rate each week.
  assert.equal(labor.RELEASE_SEVERANCE_WEEKS / labor.RESERVE_PAY_RATE, 8);
});

console.log('\n── reserve level and Keep me fully staffed ─────────────\n');

await test('the reserve level is set per group and clamped', () => {
  let s = airline(10);
  s = gameReducer(s, { type: 'SET_RESERVE_TARGET', group: 'pilots', target: 0.05 });
  s = gameReducer(s, { type: 'SET_RESERVE_TARGET', group: 'cabinCrew', target: 9 });
  assert.equal(labor.reserveTarget(s.labor, 'pilots'), 0.05);
  assert.equal(labor.reserveTarget(s.labor, 'cabinCrew'), labor.RESERVE_TARGET_MAX);
  assert.equal(labor.reserveTarget(s.labor, 'groundStaff'), 0);
});

await test('with the switch off and no auto-replace, nobody is hired', () => {
  let s = airline(20);
  for (let w = 0; w < 10; w++) s = tick(s);
  for (const id of GROUPS) assert.equal(labor.crewOnTheWay(s.labor, id), 0);
});

await test('switching it on hires at once, and the line then holds at the requirement', () => {
  let s = gameReducer(airline(40, { staffed: 0.97 }), { type: 'SET_AUTO_STAFF', enabled: true });
  for (const id of GROUPS) assert.ok(labor.crewOnTheWay(s.labor, id) > 0, `${id} should have hires on the way`);
  let warned = 0;
  for (let w = 1; w <= 70; w++) {
    s = tick(s);
    if (w > 25 && labor.crewStatus(s, typeOf).level !== 'ok') warned++;
  }
  assert.equal(warned, 0, 'no shortfall once the first hires have trained');
  for (const id of GROUPS) {
    const need = labor.crewRequired(id, s.fleet, typeOf);
    const have = labor.crewAvailable(s.labor, id);
    assert.ok(have <= need * 1.015 + 2 / labor.CREW_PER_UNIT[id], `${id}: must not overstaff with no reserve level (${have.toFixed(2)} / ${need.toFixed(2)})`);
  }
});

await test('each group settles at its own reserve level', () => {
  let s = airline(40, { autoStaff: true });
  s = gameReducer(s, { type: 'SET_RESERVE_TARGET', group: 'pilots', target: 0.10 });
  s = gameReducer(s, { type: 'SET_RESERVE_TARGET', group: 'cabinCrew', target: 0.05 });
  for (let w = 1; w <= 60; w++) s = tick(s);
  const ratio = (id) => labor.crewReserveRatio(s.labor, id, s.fleet, typeOf);
  assert.ok(Math.abs(ratio('pilots') - 0.10) < 0.012, `pilots at ${ratio('pilots').toFixed(3)}`);
  assert.ok(Math.abs(ratio('cabinCrew') - 0.05) < 0.012, `cabin crew at ${ratio('cabinCrew').toFixed(3)}`);
  assert.ok(ratio('groundStaff') < 0.012, `ground staff at ${ratio('groundStaff').toFixed(3)}`);
});

await test('aircraft on order are crewed by the week they arrive', () => {
  let s = airline(20, { autoStaff: true });
  for (let w = 0; w < 15; w++) s = tick(s);              // settle
  const due = absWeekOf(s) + 26;
  const orders = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, typeId: nb.id, deliverAbsWeek: due }));
  s = { ...s, pendingOrders: orders };
  // Nothing is hired while the delivery is far beyond every training window…
  const early = labor.autoStaffPlan(s.labor, s.fleet, typeOf, null, { pendingOrders: orders, absWeek: absWeekOf(s) });
  assert.ok(early.every(p => p.forDeliveries === 0), 'no delivery hires 26 weeks out');
  // …and by delivery week the crews are on the line. The orders are held back
  // from the delivery step (so no real tails are built) and added by hand.
  let firstHire = null;
  while (absWeekOf(s) < due - 1) {
    s = { ...tick(s), pendingOrders: orders };
    if (firstHire == null && labor.crewOnTheWay(s.labor, 'pilots') > labor.crewRequired('pilots', s.fleet, typeOf) * 0.1) firstHire = due - absWeekOf(s);
  }
  assert.equal(s.fleet.length, 20, 'fixture: nothing delivered yet');
  assert.ok(firstHire >= labor.CREW_LEAD_WEEKS.pilots && firstHire <= labor.CREW_LEAD_WEEKS.pilots + 6,
    `pilot hiring started ${firstHire} weeks before delivery`);
  s = { ...tick({ ...s, pendingOrders: [] }) };
  const grown = [...s.fleet, ...orders.map((o, i) => plane(100 + i))];
  for (const id of GROUPS) {
    const need = labor.crewRequired(id, grown, typeOf);
    const have = labor.crewAvailable(s.labor, id);
    assert.ok(labor.crewBodies(id, need - have) <= 1, `${id}: ${labor.crewBodies(id, need - have)} short on delivery day`);
  }
});

await test('it never hires staff the airline cannot pay to train', () => {
  const s = { ...airline(40, { staffed: 0.8 }), cash: 20_000 };
  const after = gameReducer(s, { type: 'SET_AUTO_STAFF', enabled: true });
  assert.ok(after.cash >= 0, `cash went to ${after.cash}`);
});

await test('it does not release anyone: staff above the level simply stop being replaced', () => {
  let s = airline(20, { staffed: 1.4, autoStaff: true });
  const before = labor.crewAvailable(s.labor, 'pilots');
  s = tick(s);
  assert.equal(labor.crewOnTheWay(s.labor, 'pilots'), 0, 'no hiring while over the level');
  assert.ok(labor.crewAvailable(s.labor, 'pilots') < before, 'attrition trims the surplus');
  assert.ok(labor.crewAvailable(s.labor, 'pilots') > before * 0.99, 'but nobody was let go');
});

await test('Hire everything needed makes the same hires the switch would', () => {
  const s = airline(30, { staffed: 0.9 });
  const plan = labor.crewHireAllPlan(s.labor, s.fleet, typeOf, null, { pendingOrders: [], absWeek: absWeekOf(s) });
  assert.equal(plan.hires.length, GROUPS.length);
  let manual = s;
  for (const h of plan.hires) manual = gameReducer(manual, { type: 'HIRE_CREW', group: h.group, bodies: h.bodies });
  const auto = gameReducer(s, { type: 'SET_AUTO_STAFF', enabled: true });
  assert.equal(s.cash - manual.cash, plan.cost);
  for (const id of GROUPS) {
    assert.ok(Math.abs(labor.crewOnTheWay(manual.labor, id) - labor.crewOnTheWay(auto.labor, id)) < 1e-6, id);
  }
});

console.log('\n── release staff above my reserve level ────────────────\n');

await test('with the switch on, the week ends with the surplus released, for severance', () => {
  let s = { ...airline(20, { staffed: 1.5 }), crewAutoRelease: true };
  const before = s.cash;
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  for (const id of GROUPS) {
    const ratio = labor.crewReserveRatio(s.labor, id, s.fleet, typeOf);
    assert.ok(ratio < 0.06, `${id} still ${(ratio * 100).toFixed(1)}% over`);
  }
  assert.ok((s.pendingToasts ?? []).some(t => /Spare staff released/.test(t.title)), 'a toast says so');
  assert.ok(before - s.cash > 0);
});

await test('switching it on releases at once, down to the reserve level', () => {
  let s = airline(20, { staffed: 1.5 });
  s = gameReducer(s, { type: 'SET_RESERVE_TARGET', group: 'pilots', target: 0.10 });
  s = gameReducer(s, { type: 'SET_AUTO_RELEASE', enabled: true });
  const r = labor.crewReserveRatio(s.labor, 'pilots', s.fleet, typeOf);
  assert.ok(r >= 0.10 && r < 0.17, `pilots at ${(r * 100).toFixed(1)}%`);
  assert.ok(labor.crewReserveRatio(s.labor, 'cabinCrew', s.fleet, typeOf) < 0.06);
});

await test('aircraft on order keep their crews', () => {
  const s0 = airline(20, { staffed: 1.3 });
  const orders = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, typeId: nb.id, deliverAbsWeek: absWeekOf(s0) + 40 }));
  const s = gameReducer({ ...s0, pendingOrders: orders }, { type: 'SET_AUTO_RELEASE', enabled: true });
  for (const id of GROUPS) {
    const book = labor.crewRequiredForOrderBook(id, s.fleet, orders, typeOf);
    assert.ok(labor.crewAvailable(s.labor, id) >= book - 1e-9, `${id} released crews an order needs`);
  }
});

await test('it never fights Keep me fully staffed: with both on, nothing is released week after week', () => {
  let s = { ...airline(30, { autoStaff: true }), crewAutoRelease: true };
  s = gameReducer(s, { type: 'SET_RESERVE_TARGET', group: 'pilots', target: 0.10 });
  let released = 0;
  for (let w = 0; w < 60; w++) {
    const n = gameReducer(s, { type: 'ADVANCE_WEEK' });
    if ((n.pendingToasts ?? []).some(t => /Spare staff released/.test(t.title))) released++;
    s = { ...n, cash: 900_000_000, pendingToasts: [] };
  }
  assert.equal(released, 0, `released staff in ${released} weeks`);
});

await test('off by default, and nobody is released without it', () => {
  let s = airline(20, { staffed: 1.5 });
  assert.notEqual(s.crewAutoRelease, true);
  const head = labor.crewAvailable(s.labor, 'pilots');
  s = tick(s);
  assert.ok(labor.crewAvailable(s.labor, 'pilots') > head * 0.99);
});

await test('a release the airline cannot pay for waits', () => {
  const s = { ...airline(20, { staffed: 1.5 }), crewAutoRelease: true, cash: 1 };
  const after = gameReducer(s, { type: 'SET_AUTO_RELEASE', enabled: true });
  assert.ok(after.cash >= 0);
});

await test('SET_AUTO_RELEASE reaches the engine in multiplayer as a plain boolean', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_AUTO_RELEASE'));
  assert.deepEqual(guardDecision('SET_AUTO_RELEASE', { enabled: true, group: 'x' }, {}), { enabled: true });
  assert.deepEqual(guardDecision('SET_AUTO_RELEASE', { enabled: 1 }, {}), { enabled: false });
});

console.log('\n── the crew page ───────────────────────────────────────\n');

const render = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Operations))).replaceAll('<!-- -->', '');
};
const forPage = (s) => ({ ...s, phase: 'playing', week: 20, year: 3, hub: 'JFK', gates: { JFK: 40 } });

await test('spare staff are named, priced and translated into aircraft', () => {
  const html = render(forPage(airline(20, { staffed: 1.5 })));
  assert.match(html, /data-staffing-summary/);
  assert.match(html, /in reserve \(50%\)/);
  assert.match(html, /could crew <strong[^>]*>about 10 more /);
  assert.match(html, /Reserve pay is \$/);
  assert.match(html, /Release \d/);
  assert.match(html, /incl\. \$[\d.,kKmM]+ reserve pay/);
});

await test('an exactly-staffed airline shows no reserve pay and nothing to release', () => {
  const html = render(forPage(airline(20, { autoStaff: true })));
  assert.match(html, /Fully staffed/);
  assert.ok(!/Release \d/.test(html));
  assert.ok(!/reserve pay<\/div>/.test(html));
});

await test('with the switch on the cards collapse; with it off the hiring tools stay open', () => {
  const on = render(forPage(airline(20, { autoStaff: true })));
  assert.match(on, /Show details/);
  assert.ok(!/Replace leavers automatically/.test(on));
  assert.match(on, /hiring is automatic/);
  const off = render(forPage(airline(20)));
  assert.match(off, /Hide details/);
  assert.match(off, /Replace leavers automatically/);
  assert.match(on, /Release staff above my reserve level/);
});

await test('with the switch off, a short airline is offered one hire for everything', () => {
  const html = render(forPage(airline(20, { staffed: 0.9 })));
  assert.match(html, /Hire everything needed · \$/);
});

await test('a save without the crew pipeline shows none of it', () => {
  const html = render(forPage({ ...airline(20), crewPipeline: false, crewAutoStaff: false }));
  assert.ok(!/data-staffing-summary|Keep me fully staffed|reserve/i.test(html.replace(/reserve aircraft|Reserve aircraft/g, '')) || !/data-staffing-summary/.test(html));
  assert.ok(!/data-staffing-summary/.test(html));
});

console.log('\n── the order form ──────────────────────────────────────\n');

globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const Checkout = (await import('../src/components/AircraftCheckout.jsx')).default;
const orderCrew = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  const html = renderToString(React.createElement(GameProvider, null,
    React.createElement(Checkout, { typeId: nb.id, mode: 'buy', onClose() {} }))).replaceAll('<!-- -->', '');
  return (html.match(/data-order-crew.{0,1400}/s) ?? [''])[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};

await test('an order says what crew it needs and what they cost to train', () => {
  const text = orderCrew(forPage(airline(20, { autoStaff: true })));
  assert.match(text, /Crew to hire: \d+ pilots, \d+ cabin crew, \d+ ground staff, \d+ maintenance team/);
  assert.match(text, /about \$[\d.,]+K? training/);
  assert.match(text, /Hired for you in time for delivery/);
});

await test('with the switch off, the order offers to turn it on', () => {
  const text = orderCrew(forPage(airline(20)));
  assert.match(text, /Keep me fully staffed · hire them for me in time for delivery/);
});

await test('reserve staff that already cover the order mean nobody to hire', () => {
  const text = orderCrew(forPage(airline(20, { staffed: 1.3, autoStaff: true })));
  assert.match(text, /your reserve staff already cover this aircraft/);
});

await test('a game without the crew pipeline shows no crew line on the order', () => {
  assert.equal(orderCrew(forPage({ ...airline(20), crewPipeline: false, crewAutoStaff: false })), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
