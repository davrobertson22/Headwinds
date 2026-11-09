// Airline Advisor + briefing (engine models/advisor.js, models/briefing.js).
//
// PRD (Discord, 2026-11-07): "an AI manager that looks at your airline's
// current situation and gives you tips". Dave's build (2026-11-09): a FREE
// rule-based Advisor in the game plus a "Copy airline briefing" text any AI can
// read. What these tests hold it to:
//
//   - Route figures are READ from a tick report (projectWeek in the client, the
//     stored lastReport on the server), never re-simulated — CLAUDE.md's
//     "previews must agree with the tick". The advisor's pair figures equal the
//     report's, to the dollar, and the module imports no simulateRoute.
//   - Each rule fires on the situation it names and stays quiet otherwise —
//     including the cases that would be BAD advice: a route still on its
//     16-week ramp is never told to cut, a reserve is not "idle", an airline
//     with heavy-check auto-scheduling on is not nagged to book checks.
//   - Every action points at a tab that exists (src/navPath.js), and the idle
//     deep link uses the Route Finder's own { typeId } contract.
//   - The briefing is capped for big airlines, and carries the advice.
//
// Verified failing on HEAD (2026-11-09): neither module existed. The behaviour
// they replace is "nothing" — there was no adviser — so the failing proof is
// the mutation check run while writing this suite: dropping the ramp guard
// fails "a route on its ramp is never told to cut", and dropping the
// auto-scheduling guard fails "auto-scheduling on: no check nag".
//
//   node tools/advisor-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let x = 4242;
Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { projectWeek } = await import('../packages/engine/src/utils/financeProjection.js');
const { defaultClassPrices, MAX_WEEKLY_BLOCK_HOURS } = await import('../packages/engine/src/utils/simulation.js');
const { referencePrice } = await import('../packages/engine/src/utils/market.js');
const { C_HOURS_DUE, AUTO_SCHEDULE_PAY_MIN, AUTO_SCHEDULE_BUDGET_MIN } = await import('../packages/engine/src/data/maintenance.js');
const { airlineAdvice, pairRollup, ADVISOR, routeLabel } = await import('../packages/engine/src/models/advisor.js');
const { airlineBriefing, routeRows, fleetRows, BRIEFING_LIMITS } = await import('../packages/engine/src/models/briefing.js');
const { TAB_LABELS } = await import('../src/navPath.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const srcOf = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ids = (list) => list.map(a => a.id);

// ── Fixtures ─────────────────────────────────────────────────────────────────
function airline({ priced = true, dests = ['ORD', 'MIA', 'BOS'], freq = 14, idle = 1 } = {}) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e9 };
  for (let i = 0; i < 6; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of dests) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: d, weeklyFrequency: freq });
  }
  for (let i = 0; i < idle; i++) s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
  if (priced) {
    const routePricing = { ...s.routePricing };
    for (const d of dests) routePricing[['JFK', d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice('JFK', d) * 1.1));
    s = { ...s, routePricing };
  }
  return s;
}
const tick = (s, n = 1) => { for (let i = 0; i < n; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' }); return s; };

// A hand-built report, for rules that need a specific load/profit picture.
const fakeReport = (state, byRoute) => ({
  routeResults: state.routes.map(r => ({ routeId: r.id, ...byRoute(r) })),
  totalFuel: 0, totalCost: 1,
});

const BASE = tick(airline(), 20);

console.log('\nAirline Advisor + briefing\n');

// ── Agreement with the tick ──────────────────────────────────────────────────

test('pair figures are the report\'s own figures, to the dollar', () => {
  const report = projectWeek(BASE).report;
  const pairs = pairRollup(BASE, report);
  assert.equal(pairs.length, 3);
  const rr = new Map(report.routeResults.map(r => [r.routeId, r]));
  for (const p of pairs) {
    const want = p.routeIds.reduce((s, id) => s + rr.get(id).trueProfit, 0);
    assert.equal(p.trueProfit, want, p.label);
    assert.ok(Math.abs(p.loadFactor - rr.get(p.routeIds[0]).loadFactor) < 1e-9, p.label);
  }
});

test('the advisor never re-simulates a route (no simulateRoute, no bare forecasts)', () => {
  const src = srcOf('packages/engine/src/models/advisor.js');
  assert.ok(!/simulateRoute|projectRouteAddition|pairMarketShare/.test(src.replace(/\/\/.*$/gm, '')),
    'advisor.js must read route figures from a report, not forecast them');
});

test('routeRows in the briefing / API agree with the report too', () => {
  const rows = routeRows(BASE, BASE.lastReport);
  const rr = new Map(BASE.lastReport.routeResults.map(r => [r.routeId, r]));
  for (const row of rows) assert.equal(row.profit, Math.round(rr.get(row.routeId).trueProfit));
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('idle aircraft: one piece per type, deep-linked into the Route Finder with { typeId }', () => {
  const adv = airlineAdvice(BASE, projectWeek(BASE).report);
  const idle = adv.find(a => a.id === 'idle-b737800');
  assert.ok(idle, ids(adv).join(','));
  assert.equal(idle.priority, 1);
  assert.deepEqual(idle.action, { label: idle.action.label, to: 'finder', filter: { typeId: 'b737800' } });
  // RouteFinderScreen reads exactly nav.typeId
  assert.match(srcOf('src/components/RouteFinderScreen.jsx'), /nav\?\.typeId/);
});

test('a reserve is not idle', () => {
  const s = { ...BASE, fleet: BASE.fleet.map(a => a.status === 'idle' ? { ...a, reserveBase: 'JFK' } : a) };
  assert.ok(!ids(airlineAdvice(s, s.lastReport)).some(id => id.startsWith('idle-')));
});

test('full but losing money: flagged at near-zero fares, quiet once priced', () => {
  const cheap = tick(airline({ priced: false }), 20);
  const adv = airlineAdvice(cheap, projectWeek(cheap).report);
  const hit = adv.find(a => a.id === 'full-but-losing');
  assert.ok(hit, ids(adv).join(','));
  assert.ok(hit.impact < 0);
  assert.deepEqual(hit.action.filter, { filterTab: 'unprofitable' });
  const report = fakeReport(BASE, () => ({ loadFactor: 0.9, trueProfit: 5000, revenue: 9e4, configuredSeatsOneWay: 100 }));
  assert.ok(!ids(airlineAdvice(BASE, report)).includes('full-but-losing'));
});

test('empty and losing: flagged for a mature route', () => {
  const s = { ...BASE, routes: BASE.routes.map(r => ({ ...r, weeksOpen: 30 })) };
  const report = fakeReport(s, () => ({ loadFactor: 0.3, trueProfit: -20000, revenue: 1e4, configuredSeatsOneWay: 100 }));
  const hit = airlineAdvice(s, report).find(a => a.id === 'empty-and-losing');
  assert.ok(hit);
  assert.equal(hit.items.length, 3);
  assert.deepEqual(hit.action.filter, { filterTab: 'lowload' });
});

test('a route on its ramp is never told to cut', () => {
  const s = { ...BASE, routes: BASE.routes.map(r => ({ ...r, weeksOpen: ADVISOR.rampWeeks - 1 })) };
  const report = fakeReport(s, () => ({ loadFactor: 0.3, trueProfit: -20000, revenue: 1e4, configuredSeatsOneWay: 100 }));
  const adv = airlineAdvice(s, report);
  assert.ok(!ids(adv).includes('empty-and-losing'), ids(adv).join(','));
  assert.ok(!ids(adv).includes('full-but-losing'));
});

test('sold out: only when the demand model capped it, and only for profitable pairs', () => {
  const capped = fakeReport(BASE, () => ({ loadFactor: 0.99, capacityCapped: true, trueProfit: 1e4, revenue: 1e5, configuredSeatsOneWay: 100 }));
  assert.ok(ids(airlineAdvice(BASE, capped)).includes('sold-out'));
  const notCapped = fakeReport(BASE, () => ({ loadFactor: 0.99, capacityCapped: false, trueProfit: 1e4, revenue: 1e5, configuredSeatsOneWay: 100 }));
  assert.ok(!ids(airlineAdvice(BASE, notCapped)).includes('sold-out'));
});

test('several tails on one pair are ONE line, not three', () => {
  const s = tick(airline({ dests: ['ORD', 'ORD', 'ORD'], idle: 0 }), 2);
  const pairs = pairRollup(s, s.lastReport);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].routeIds.length, 3);
  assert.equal(pairs[0].label, routeLabel(s.routes[0]));
});

test('spare block hours: a lightly flown tail is flagged with its hours', () => {
  const s = tick(airline({ dests: ['BOS'], freq: 3, idle: 0 }), 2);
  const hit = airlineAdvice(s, s.lastReport).find(a => a.id === 'spare-hours');
  assert.ok(hit);
  assert.match(hit.items[0].value, /h free/);
  assert.match(hit.detail, new RegExp(`${MAX_WEEKLY_BLOCK_HOURS}h`));
});

test('heavy checks due: flagged; scheduled ones are not; overdue is priority 1', () => {
  const due = { ...BASE, fleet: BASE.fleet.map((a, i) => i === 0 ? { ...a, hoursSinceC: C_HOURS_DUE + 10 } : a) };
  const hit = airlineAdvice(due, due.lastReport).find(a => a.id === 'checks-due');
  assert.ok(hit);
  assert.match(hit.items[0].value, /C check due/);
  assert.match(hit.detail, new RegExp(`${AUTO_SCHEDULE_PAY_MIN}×`));
  const booked = { ...due, fleet: due.fleet.map((a, i) => i === 0 ? { ...a, scheduledCheck: { type: 'C', atWeek: 99 } } : a) };
  assert.ok(!ids(airlineAdvice(booked, booked.lastReport)).includes('checks-due'));
  const absNow = (BASE.year - 1) * 52 + BASE.week;
  const overdue = { ...BASE, fleet: BASE.fleet.map((a, i) => i === 0 ? { ...a, hoursSinceC: C_HOURS_DUE + 10, cDueAtWeek: absNow - 30 } : a) };
  assert.equal(airlineAdvice(overdue, overdue.lastReport).find(a => a.id === 'checks-due').priority, 1);
});

test('auto-scheduling on: no check nag', () => {
  const due = {
    ...BASE,
    fleet: BASE.fleet.map((a, i) => i === 0 ? { ...a, hoursSinceC: C_HOURS_DUE + 10 } : a),
    maintenanceBudget: AUTO_SCHEDULE_BUDGET_MIN,
    labor: { ...BASE.labor, maintenanceTeam: { ...BASE.labor.maintenanceTeam, payMultiplier: AUTO_SCHEDULE_PAY_MIN } },
  };
  assert.ok(!ids(airlineAdvice(due, due.lastReport)).includes('checks-due'));
});

test('slots: an airport at 90%+ of its slots is flagged', () => {
  const s = { ...BASE, gates: { ...BASE.gates, ORD: 1 }, routes: BASE.routes.map(r => r.destination === 'ORD' ? { ...r, weeklyFrequency: 48 } : r) };
  const hit = airlineAdvice(s, s.lastReport).find(a => a.id === 'slots-tight');
  assert.ok(hit);
  assert.ok(hit.items.some(i => i.label.startsWith('ORD') && i.value === '48/50 slots'));
});

test('marketing: flagged when unfunded and unknown, quiet once funded (fixed or % of revenue)', () => {
  const low = { ...BASE, awareness: 10, marketingBudget: 0 };
  assert.ok(ids(airlineAdvice(low, low.lastReport)).includes('marketing'));
  assert.ok(!ids(airlineAdvice({ ...low, marketingBudget: 1000 }, low.lastReport)).includes('marketing'));
  assert.ok(!ids(airlineAdvice({ ...low, marketingPctOfRevenue: 0.03 }, low.lastReport)).includes('marketing'));
});

test('fuel exposure: shows what +10% costs; quiet with a live hedge', () => {
  const report = { ...BASE.lastReport, totalFuel: 400_000, totalCost: 1_000_000 };
  const hit = airlineAdvice(BASE, report).find(a => a.id === 'fuel-exposure');
  assert.ok(hit);
  assert.equal(hit.impact, -40_000);
  const absNow = (BASE.year - 1) * 52 + BASE.week;
  const hedged = { ...BASE, hedgeContracts: [{ expiryAbsWeek: absNow + 10 }] };
  assert.ok(!ids(airlineAdvice(hedged, report)).includes('fuel-exposure'));
  const expired = { ...BASE, hedgeContracts: [{ expiryAbsWeek: absNow - 1 }] };
  assert.ok(ids(airlineAdvice(expired, report)).includes('fuel-exposure'));
});

test('debt: suggested only when profitable for 4 weeks with cash to spare', () => {
  const loan = { id: 'l1', principal: 1e6, interestRate: 0.08, termWeeks: 104, weeklyPayment: 11_000, weeksRemaining: 100 };
  const good = { ...BASE, loans: [loan], cash: 1e8, financialHistory: [1, 2, 3, 4].map(() => ({ profit: 1000 })) };
  assert.ok(ids(airlineAdvice(good, good.lastReport)).includes('repay-debt'));
  const losing = { ...good, financialHistory: [{ profit: 1 }, { profit: 1 }, { profit: -1 }, { profit: 1 }] };
  assert.ok(!ids(airlineAdvice(losing, losing.lastReport)).includes('repay-debt'));
});

test('ordering: priority first; every action names a real tab', () => {
  const adv = airlineAdvice({ ...BASE, awareness: 5 }, projectWeek(BASE).report);
  assert.ok(adv.length >= 3);
  for (let i = 1; i < adv.length; i++) assert.ok(adv[i - 1].priority <= adv[i].priority);
  for (const a of adv) {
    assert.ok(a.priorityLabel);
    if (a.action) assert.ok(TAB_LABELS[a.action.to], `${a.id} → unknown tab ${a.action.to}`);
  }
});

test('not playing, no state, no report: no advice and no throw', () => {
  assert.deepEqual(airlineAdvice(null), []);
  assert.deepEqual(airlineAdvice(freshState()), []);
  assert.ok(Array.isArray(airlineAdvice(BASE, null)));
});

// ── Briefing ─────────────────────────────────────────────────────────────────

test('briefing: header, advice, routes, fleet, settings — and the same text twice', () => {
  const b = airlineBriefing(BASE);
  for (const h of ['# Airline briefing: Probe Air', '## Snapshot', '## Advisor', '## Passenger routes', '## Fleet by type', '## Settings']) {
    assert.ok(b.includes(h), h);
  }
  const adv = airlineAdvice(BASE, BASE.lastReport);
  for (const a of adv) assert.ok(b.includes(a.title), a.title);
  assert.equal(b, airlineBriefing(BASE));
});

test('briefing: a big network is capped with a "left out" line', () => {
  const dests = ['ORD', 'MIA', 'BOS', 'ATL', 'DCA', 'PHL', 'CLT', 'DTW', 'MSP', 'BNA', 'RDU', 'PIT', 'CLE', 'IND', 'CMH', 'MCO', 'TPA', 'FLL', 'BWI', 'SDF', 'RIC', 'BUF', 'ROC', 'SYR', 'ALB'];
  const s = tick(airline({ dests, idle: 0 }), 1);
  const flew = s.lastReport.routeResults.length;
  assert.ok(flew > BRIEFING_LIMITS.topRoutes + BRIEFING_LIMITS.bottomRoutes, `only ${flew} routes flew`);
  const b = airlineBriefing(s);
  assert.match(b, /routes in between left out/);
  const routeLines = b.split('\n').filter(l => /^\| JFK–/.test(l)).length;
  assert.equal(routeLines, BRIEFING_LIMITS.topRoutes + BRIEFING_LIMITS.bottomRoutes);
  assert.ok(b.length < 20_000, `briefing is ${b.length} chars`);
});

test('fleetRows: block hours used against the cap, idle tails visible', () => {
  const rows = fleetRows(BASE);
  assert.equal(rows.length, BASE.fleet.length);
  assert.ok(rows.some(r => r.status === 'idle' && r.routes === 0));
  assert.ok(rows.every(r => r.blockHoursCap === MAX_WEEKLY_BLOCK_HOURS));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
