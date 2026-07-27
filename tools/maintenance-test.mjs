// Heavy-maintenance (C/D check) engine test — no DB, no network.
//   node tools/maintenance-test.mjs
import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import * as M from '../packages/engine/src/data/maintenance.js';
import { absoluteWeek } from '../packages/engine/src/utils/fuel.js';
import { laborEffects } from '../packages/engine/src/data/labor.js';
import { aircraftHubMaintFactor } from '../packages/engine/src/utils/simulation.js';

// Determinism: pin RNG so wear-based failures / random events never perturb assertions.
Math.random = () => 0.9999;

const TYPE = 'crj200';
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}
function newGame() {
  return gameReducer(freshState(), { type: 'START_GAME', airlineName: 'MX', hub: 'JFK', enableObjectives: false });
}
function withJet(s) {
  const before = s.fleet.length;
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: TYPE });
  if (s.fleet.length === before) throw new Error('buy failed, cash=' + s.cash);
  const acId = s.fleet[s.fleet.length - 1].id;
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: acId, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  if (s.routes.length === 0) throw new Error('route did not attach');
  return { s, acId };
}
const find = (s, id) => s.fleet.find(a => a.id === id);

t('wear accrues in the real weekly tick', () => {
  let { s, acId } = withJet(newGame());
  assert.equal(find(s, acId).hoursSinceC ?? 0, 0);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.ok((a.hoursSinceC ?? 0) > 0, 'hours accrued');
  assert.equal(a.weeksSinceC, 1, 'one calendar week');
  assert.ok((a.hoursSinceD ?? 0) > 0, 'D hours accrue too');
});

t('SCHEDULE_CHECK startNow charges cost + sends to shop', () => {
  let { s, acId } = withJet(newGame());
  const cash0 = s.cash;
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: acId, checkType: 'C', startNow: true });
  const a = find(s, acId);
  assert.equal(a.status, 'maintenance');
  assert.equal(a.checkWeeksLeft, M.checkDurationWeeks('Regional Jet', 'C'));
  const expC = M.checkCost(getAircraftType(TYPE), 'C', { maintMod: 1, laborMult: laborEffects(s.labor).maintenanceCostMultiplier, hubFactor: aircraftHubMaintFactor(acId, s.routes, s.cargoRoutes, s.hubs) });
  assert.equal(cash0 - s.cash, expC, 'exact C cost charged (incl labor + hub factors)');
});

t('startNow refused when cash is short', () => {
  let { s, acId } = withJet(newGame());
  s = { ...s, cash: 100 };
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: acId, checkType: 'D', startNow: true });
  assert.notEqual(find(s, acId).status, 'maintenance', 'not started');
});

t('booked check auto-starts on its week', () => {
  let { s, acId } = withJet(newGame());
  const cur = absoluteWeek(s.year, s.week);
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: acId, checkType: 'C', startWeek: cur });
  assert.ok(find(s, acId).scheduledCheck, 'booked');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.equal(a.status, 'maintenance', 'auto-started');
  assert.equal(a.scheduledCheck, null, 'booking cleared');
  assert.ok(s.lastReport.maintenanceChecks.started.length === 1, 'debrief logs start');
});

t('check completes and resets its clocks', () => {
  let { s, acId } = withJet(newGame());
  s = { ...s, fleet: s.fleet.map(a => a.id === acId
    ? { ...a, status: 'maintenance', checkType: 'C', checkWeeksLeft: 1, hoursSinceC: 4000, weeksSinceC: 90 } : a) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.notEqual(a.status, 'maintenance', 'back in service');
  // Reset at week-start, then it flew a week — so ~1 week of fresh wear, not the injected 4000/90.
  assert.ok(a.hoursSinceC < 100, 'C hours reset (then 1wk flown): ' + a.hoursSinceC);
  assert.ok(a.weeksSinceC <= 1, 'C weeks reset: ' + a.weeksSinceC);
});

t('D check resets both clocks + credits effective age', () => {
  let { s, acId } = withJet(newGame());
  s = { ...s, fleet: s.fleet.map(a => a.id === acId
    ? { ...a, status: 'maintenance', checkType: 'D', checkWeeksLeft: 1, ageWeeks: 1040,
        hoursSinceC: 3000, hoursSinceD: 20000, weeksSinceC: 80, weeksSinceD: 300, maintAgeCredit: 0 } : a) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.ok(a.hoursSinceD < 100, 'D hours reset (then 1wk): ' + a.hoursSinceD);
  assert.ok(a.hoursSinceC < 100, 'C also reset by D: ' + a.hoursSinceC);
  assert.equal(a.maintAgeCredit, M.D_AGE_CREDIT_MAX_WEEKS, 'age credit applied');
});

t('forced grounding past grace window', () => {
  let { s, acId } = withJet(newGame());
  const cur = absoluteWeek(s.year, s.week);
  s = { ...s, fleet: s.fleet.map(a => a.id === acId
    ? { ...a, hoursSinceC: 6000, weeksSinceC: 50, cDueAtWeek: cur - 20 } : a) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.equal(a.status, 'maintenance', 'force-grounded');
  assert.equal(a.checkForced, true, 'marked forced');
  const dur = M.checkDurationWeeks('Regional Jet', 'C');
  assert.equal(a.checkWeeksLeft, dur + M.FORCED_EXTRA_WEEKS, 'extra downtime');
  assert.equal(s.lastReport.maintenanceChecks.forced.length, 1, 'debrief logs forced');
  assert.equal(s.lastReport.maintenanceChecks.repHit, M.FORCED_REP_HIT, 'rep hit recorded');
  assert.equal(s.reputationPenalty, M.FORCED_REP_HIT, 'reputation penalty applied to state');
});

t('reputation penalty decays over time and lowers reputation', () => {
  let { s, acId } = withJet(newGame());
  const cur = absoluteWeek(s.year, s.week);
  s = { ...s, fleet: s.fleet.map(a => a.id === acId ? { ...a, hoursSinceC: 6000, weeksSinceC: 50, cDueAtWeek: cur - 20 } : a) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });         // forced -> penalty = 2
  const p1 = s.reputationPenalty;
  assert.ok(p1 > 0, 'penalty present after forced grounding');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });         // decays (0.92x)
  assert.ok(s.reputationPenalty < p1, 'penalty decays: ' + s.reputationPenalty + ' < ' + p1);
});

t('a due airframe sells for less (NAV penalty)', () => {
  // due
  let g = withJet(newGame());
  let s = { ...g.s, fleet: g.s.fleet.map(a => a.id === g.acId ? { ...a, hoursSinceC: 6000 } : a) };
  const c0 = s.cash;
  s = gameReducer(s, { type: 'SELL_AIRCRAFT', aircraftId: g.acId });
  const dueProceeds = s.cash - c0;
  // clean
  let g2 = withJet(newGame());
  const c2 = g2.s.cash;
  const s2 = gameReducer(g2.s, { type: 'SELL_AIRCRAFT', aircraftId: g2.acId });
  const cleanProceeds = s2.cash - c2;
  assert.ok(dueProceeds < cleanProceeds, 'due ' + dueProceeds + ' < clean ' + cleanProceeds);
});

t('CANCEL_SCHEDULED_CHECK clears the booking', () => {
  let { s, acId } = withJet(newGame());
  const cur = absoluteWeek(s.year, s.week);
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: acId, checkType: 'D', startWeek: cur + 5 });
  s = gameReducer(s, { type: 'CANCEL_SCHEDULED_CHECK', aircraftId: acId });
  assert.equal(find(s, acId).scheduledCheck, null);
});

// ─── Auto-scheduling (pay ≥1.3× + budget ≥1.3×) ──────────────────────────────

function withAutoMaint(s, pay = 1.3, budget = 1.3) {
  s = gameReducer(s, { type: 'SET_LABOR_PAY', group: 'maintenanceTeam', payMultiplier: pay });
  s = gameReducer(s, { type: 'SET_MAINTENANCE_BUDGET', multiplier: budget });
  return s;
}
function makeDue(s, acId, cur) {
  // C check due (hours trigger), still inside the grace window → not yet forced.
  return { ...s, fleet: s.fleet.map(a => a.id === acId
    ? { ...a, hoursSinceC: 5000, weeksSinceC: 50, cDueAtWeek: cur } : a) };
}

t('autoSchedulingActive helper thresholds', () => {
  const lab = (p) => ({ maintenanceTeam: { payMultiplier: p, morale: 80 } });
  assert.equal(M.autoSchedulingActive(lab(1.3), 1.3),  true,  'both at 1.30');
  assert.equal(M.autoSchedulingActive(lab(2.0), 2.0),  true,  'both above');
  assert.equal(M.autoSchedulingActive(lab(1.25), 1.3), false, 'pay below');
  assert.equal(M.autoSchedulingActive(lab(1.3), 1.25), false, 'budget below');
  assert.equal(M.autoSchedulingActive(undefined, undefined), false, 'defaults off');
});

t('auto-scheduling starts a due check at planned cost (no regulator)', () => {
  let { s, acId } = withJet(newGame());
  s = withAutoMaint(s);
  const cur = absoluteWeek(s.year, s.week);
  s = makeDue(s, acId, cur);
  const cash0 = s.cash;
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.equal(a.status, 'maintenance', 'in the shop');
  assert.equal(a.checkForced, false, 'NOT forced');
  assert.equal(a.checkWeeksLeft, M.checkDurationWeeks('Regional Jet', 'C'), 'planned downtime, no forced extra');
  assert.equal(s.lastReport.maintenanceChecks.started.length, 1, 'debrief logs a started check');
  assert.equal(s.lastReport.maintenanceChecks.started[0].auto, true, 'flagged auto');
  assert.equal(s.lastReport.maintenanceChecks.forced.length, 0, 'no forced checks');
  assert.equal(s.lastReport.maintenanceChecks.repHit, 0, 'no reputation hit');
  assert.ok(cash0 - s.cash < cash0, 'cost charged');
  assert.ok((s.pendingToasts ?? []).some(x => x.title.includes('auto-scheduled')), 'auto toast shown');
});

t('auto-scheduling stays off below the thresholds', () => {
  let { s, acId } = withJet(newGame());
  s = withAutoMaint(s, 1.25, 2.0); // pay below the bar
  const cur = absoluteWeek(s.year, s.week);
  s = makeDue(s, acId, cur);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.notEqual(find(s, acId).status, 'maintenance', 'pay 1.25×: not auto-started');
  let { s: s2, acId: ac2 } = withJet(newGame());
  s2 = withAutoMaint(s2, 2.0, 1.25); // budget below the bar
  const cur2 = absoluteWeek(s2.year, s2.week);
  s2 = makeDue(s2, ac2, cur2);
  s2 = gameReducer(s2, { type: 'ADVANCE_WEEK' });
  assert.notEqual(find(s2, ac2).status, 'maintenance', 'budget 1.25×: not auto-started');
});

t('auto-scheduling waits when cash is short (then regulator still applies past grace)', () => {
  let { s, acId } = withJet(newGame());
  s = withAutoMaint(s);
  const cur = absoluteWeek(s.year, s.week);
  s = makeDue(s, acId, cur);
  s = { ...s, cash: 100 };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.notEqual(find(s, acId).status, 'maintenance', 'cash-short: not auto-started');
});

t('auto-scheduling respects a player booking for a future week', () => {
  let { s, acId } = withJet(newGame());
  s = withAutoMaint(s);
  const cur = absoluteWeek(s.year, s.week);
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: acId, checkType: 'C', startWeek: cur + 3 });
  s = makeDue(s, acId, cur);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.notEqual(a.status, 'maintenance', 'booking not preempted');
  assert.ok(a.scheduledCheck, 'booking intact');
});

t('auto-scheduling prevents the forced grounding that would otherwise happen', () => {
  // Past-grace setup: without auto this force-grounds (see earlier test).
  let { s, acId } = withJet(newGame());
  s = withAutoMaint(s);
  const cur = absoluteWeek(s.year, s.week);
  s = { ...s, fleet: s.fleet.map(a => a.id === acId
    ? { ...a, hoursSinceC: 6000, weeksSinceC: 50, cDueAtWeek: cur - 20 } : a) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const a = find(s, acId);
  assert.equal(a.status, 'maintenance', 'in the shop');
  assert.equal(a.checkForced, false, 'auto beat the regulator — planned check, not forced');
  assert.equal(s.reputationPenalty ?? 0, 0, 'no reputation penalty');
});

t('migration seeding never yields an already-due airframe', () => {
  for (let i = 0; i < 300; i++) {
    const a = M.seedMaintenance({ id: 'seed-' + i, ageWeeks: (i * 37) % 1600, status: 'idle' }, getAircraftType(TYPE));
    const di = M.dueInfo(a, getAircraftType(TYPE), 0);
    assert.ok(!di.cDue && !di.dDue, 'seed ' + i + ' not due');
  }
});

console.log(fail ? ('\n' + fail + ' FAILED, ' + pass + ' passed') : ('\nALL PASS (' + pass + ')'));
process.exit(fail ? 1 : 0);
