// The airline bot (packages/engine/src/models/airlineBot.js) — the manager that
// runs an AI airline with a player's own actions. Design:
// claude/background-competitors-plan.md (Dave, 2026-11-11).
//
// What is pinned here is what the design promises players, not the tuning:
//
//   • it only ever does what a player can do — every change goes through the
//     decision path, and it never writes to the state it is handed;
//   • it is blind to who is playing (no protection for away players and no
//     targeting of them), and it rolls no dice of its own;
//   • it grows on profit and shrinks on loss — and the rules that stop it
//     over-ordering are what keep it alive: the same bot with those rules
//     switched off is bankrupt inside half a year (the mutation check below);
//   • it starts and survives its first year in every kind of world.
//
// The worlds are run by tools/bot-lab/harness.mjs, the same harness the bot lab
// report uses (tools/bot-lab.mjs).
//
//   node --import ./tools/_register-loader.mjs tools/airline-bot-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLab, stepLab, botView, botDeps, applyDecision, LAB_WORLDS } from './bot-lab/harness.mjs';
import {
  BOT_MEMORY_VERSION, BOT_TIERS, newBotMemory, runBotTurn, rankOpenRoutes, planTailWeek,
  tailFixedCost, tailCarryCost, tailHoursUsed, gateCostOf, heavyUpkeep, botStats, startProspect,
} from '../packages/engine/src/models/airlineBot.js';
import { AIRCRAFT_TYPES, getAircraftType, eraWeeklyLease, eraPurchasePrice } from '../packages/engine/src/data/aircraft.js';
import { forecastLaunch } from '../packages/engine/src/models/routeFinder.js';
import { borrowingCapacity, totalDebtOutstanding } from '../packages/engine/src/data/credit.js';
import { C_HOURS_DUE, C_COST_PCT, C_WEEKS_DUE, D_COST_PCT, D_WEEKS_DUE } from '../packages/engine/src/data/maintenance.js';
import { maxWeeklyBlockHoursFor, weeklyGateFeeAt, calendarYear } from '../packages/engine/src/utils/simulation.js';

let passed = 0, failed = 0;
const REAL_RANDOM = Math.random;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
  finally { Math.random = REAL_RANDOM; }
};

// Everything the bot is allowed to do. A new entry here is a design decision
// (plan §4), not a convenience: each one is a button a player has.
const ALLOWED = new Set([
  'SET_LEASE_AUTO_RENEW', 'SET_LEASE_AUTO_RENEW_OPT_OUT', 'CLOSE_ROUTE', 'REMOVE_GATE', 'BULK_ADJUST_PRICING',
  'SCHEDULE_CHECK', 'HIRE_CREW', 'SET_AUTO_STAFF', 'SET_RESERVE_TARGET', 'RELEASE_CREW', 'ADD_GATE', 'ADD_ROUTE', 'RETIRE_AIRCRAFT', 'ORDER_AIRCRAFT', 'TAKE_LOAN',
]);
const P = BOT_TIERS.cautious;
const clone = (x) => JSON.parse(JSON.stringify(x));
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const seeded = (s) => { let a = s >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; };
const turn = (state, memory, extra = {}) => { Math.random = seeded(7); try { return runBotTurn(state, memory, { ...botDeps, ...extra }); } finally { Math.random = REAL_RANDOM; } };
const types = (r) => r.actions.map((a) => a.type);
const absWeek = (s) => (s.year - 1) * 52 + s.week;

// ── Fixtures: one world, three bots, most of a year ───────────────────────────
console.log('running the fixture world (3 bots, 40 weeks)…');
const lab = createLab({ world: 'modern', bots: 3, seed: 'airline-bot-test' });
const fresh = await botView(lab, lab.airlines[0]);          // week 1: cash, a hub, nothing else
for (let w = 0; w < 40; w++) await stepLab(lab);
const grown = await botView(lab, lab.airlines[0]);          // week 41: a small working airline
const grownMem = clone(lab.memory[lab.airlines[0].id]);

console.log('\nonly a player\'s actions');
await t('every decision in 40 weeks is on the allow-list', () => {
  const seen = new Set(lab.journal.map((j) => j.type));
  for (const k of seen) assert.ok(ALLOWED.has(k), `the bot issued ${k}, which is not on the allow-list`);
  for (const k of ['ORDER_AIRCRAFT', 'ADD_ROUTE', 'ADD_GATE']) assert.ok(seen.has(k), `expected the fixture to exercise ${k}`);
});
await t('it never writes to the state it is handed — every change comes back from apply()', () => {
  const view = deepFreeze(clone(grown)); const before = JSON.stringify(view);
  const r = turn(view, deepFreeze(clone(grownMem)), { apply: (s, a) => deepFreeze(applyDecision(s, a)) });
  assert.equal(JSON.stringify(view), before);
  assert.ok(r.actions.length + r.refused.length > 0, 'the turn did nothing at all — the fixture is not exercising the bot');
});
await t('with an apply() that refuses everything, the state comes back untouched', () => {
  const r = turn(grown, grownMem, { apply: () => { throw new Error('no'); } });
  assert.equal(r.state, grown);
  assert.equal(r.actions.length, 0);
});
await t('it needs the decision path: no apply(), no turn', () => {
  assert.throws(() => runBotTurn(grown, grownMem, {}), /apply/);
});
await t('a bankrupt airline takes no turn', () => {
  const r = turn({ ...grown, phase: 'bankrupt' }, grownMem);
  assert.equal(r.actions.length, 0);
});

console.log('\nblind and deterministic');
await t('the same state and memory give the same decisions', () => {
  const a = turn(grown, grownMem); const b = turn(grown, grownMem);
  assert.deepEqual(a.actions, b.actions);
  assert.deepEqual(a.memory, b.memory);
  const c = turn(fresh, newBotMemory()); const d = turn(fresh, newBotMemory());
  assert.deepEqual(c.actions, d.actions);
});
await t('it rolls no dice of its own (Math.random is only ever called inside apply)', () => {
  let inApply = false;
  const guarded = seeded(3);
  Math.random = () => { if (!inApply) throw new Error('the bot called Math.random outside apply()'); return guarded(); };
  try {
    for (const [s, m] of [[fresh, newBotMemory()], [grown, grownMem]]) {
      runBotTurn(s, m, { ...botDeps, apply: (st, a) => { inApply = true; try { return applyDecision(st, a); } finally { inApply = false; } } });
    }
  } finally { Math.random = REAL_RANDOM; }
});
await t('who is online, away or ahead changes nothing', () => {
  // Dave, 2026-11-11: no protection for away players, and no targeting. If a
  // presence field ever reaches the bot's state, it must still not read it.
  const marked = clone(grown);
  marked.worldPresence = { online: ['x'], away: ['y'] }; marked.standings = [{ airlineId: 'x', rank: 1 }];
  for (const list of Object.values(marked.humanRivals ?? {})) for (const rv of list) Object.assign(rv, { isAway: true, lastActiveAt: 0, lastSeenWeek: 1, rank: 1, isBot: false });
  assert.deepEqual(turn(marked, grownMem).actions, turn(grown, grownMem).actions);
});
await t('the module reads no presence or ranking field at all', () => {
  const src = readFileSync(new URL('../packages/engine/src/models/airlineBot.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const hit = src.match(/lastSeen|lastActive|isAway|awayUntil|isOnline|presence|\bstandings?\b|leaderboard|\brank\b|isBot|isHuman/i);
  assert.equal(hit, null, `airlineBot.js reads "${hit?.[0]}" — the bot must not know who is playing or how they rank`);
});

console.log('\nwhat an aircraft really costs');
await t('a tail\'s fixed cost is far more than its rent', () => {
  const cy = calendarYear(fresh);
  for (const tp of AIRCRAFT_TYPES.filter((x) => !x.freighter && (x.seats ?? 0) >= 20)) {
    const fixed = tailFixedCost(fresh, tp, P);
    assert.ok(fixed > eraWeeklyLease(tp, cy) + (tp.baseMaintenancePerWk ?? 0), `${tp.id}: fixed ${fixed} does not even cover rent + line maintenance`);
  }
  // The trap the second prototype fell into: an old wide-body rents cheap and costs dear.
  const old = getAircraftType('a340300');
  assert.ok(tailFixedCost(fresh, old, P) > 4 * eraWeeklyLease(old, cy), 'an old A340 should cost several times its rent to keep');
});
await t('heavy checks are counted every week, not only when the bill lands', () => {
  // The third prototype: cheap old turboprops for a year, then every C and D check at once.
  const tp = getAircraftType(grown.fleet[0].typeId);
  const price = eraPurchasePrice(tp, calendarYear(grown) ?? undefined);
  const floor = price * (C_COST_PCT / C_WEEKS_DUE + D_COST_PCT / D_WEEKS_DUE);   // the calendar clocks alone
  assert.ok(heavyUpkeep(grown, tp, 0, P) >= floor, 'a new aircraft\'s checks are under-counted');
  assert.ok(heavyUpkeep(grown, tp, 1040, P) > heavyUpkeep(grown, tp, 0, P), 'a 20-year-old airframe should expect more repairs than a new one');
  const owned = { id: 'x', typeId: tp.id, ownershipType: 'owned', ageWeeks: 0 };
  assert.ok(tailCarryCost(grown, owned, P) >= heavyUpkeep(grown, tp, 0, P) + (tp.baseMaintenancePerWk ?? 0), 'what an aircraft costs to keep leaves its heavy checks out');
  assert.ok(tailFixedCost(grown, tp, P) >= heavyUpkeep(grown, tp, 0, P) + eraWeeklyLease(tp, calendarYear(grown)), 'what a new aircraft would cost leaves its heavy checks out');
});
await t('keeping an aircraft costs at least its rent, and more as it ages', () => {
  const a = grown.fleet[0];
  const carry = tailCarryCost(grown, a, P);
  assert.ok(carry > (a.weeklyLease ?? 0));
  assert.ok(tailCarryCost(grown, { ...a, ageWeeks: (a.ageWeeks ?? 0) + 520 }, P) > carry);
});
await t('a route to a new airport carries the gate it needs', () => {
  const served = new Set(grown.routes.flatMap((r) => [r.origin, r.destination]));
  const far = ['LHR', 'JFK', 'SYD', 'CDG', 'DXB'].find((c) => !served.has(c) && !(grown.gates ?? {})[c]);
  const used = {};
  assert.ok(gateCostOf(grown, used, far, 7) >= weeklyGateFeeAt(grown, far, 1), 'the first gate at a new airport is not in the route\'s cost');
  const have = grown.routes.find((r) => r.origin === grown.hub)?.destination;
  assert.ok(gateCostOf(grown, used, have, 1) < weeklyGateFeeAt(grown, have, 1), 'a flight that fits the gate already held should not be charged a new one');
});

console.log('\nchoosing routes');
const probe = (id) => ({ id: 'probe', typeId: id, config: { economy: getAircraftType(id).seats }, ageWeeks: 0 });
const anyType = grown.fleet[0].typeId;
await t('ranked routes are open, profitable and best-per-hour first', () => {
  const list = rankOpenRoutes(grown, probe(anyType), newBotMemory(), P, { spareHours: 140 });
  assert.ok(list.length > 0, 'nothing to fly from the hub at all');
  const served = new Set(grown.routes.map((r) => (r.origin === grown.hub ? r.destination : r.origin)));
  for (const r of list) { assert.ok(!served.has(r.code), `${r.code} is already served`); assert.ok(r.profit > 0); assert.ok(r.freq >= P.minFrequency); }
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].profit / list[i - 1].hours >= list[i].profit / list[i].hours - 1e-9);
});
await t('a destination it was told to leave alone is left alone', () => {
  const list = rankOpenRoutes(grown, probe(anyType), newBotMemory(), P, { spareHours: 140 });
  const [a, b] = list;
  const mem = { ...newBotMemory(), skip: { [a.code]: absWeek(grown) + 10 } };
  const again = rankOpenRoutes(grown, probe(anyType), mem, P, { spareHours: 140, exclude: new Set([b.code]) });
  assert.ok(!again.some((r) => r.code === a.code), 'a skipped destination came back');
  assert.ok(!again.some((r) => r.code === b.code), 'an excluded destination came back');
  const expired = { ...newBotMemory(), skip: { [a.code]: absWeek(grown) - 1 } };
  assert.ok(rankOpenRoutes(grown, probe(anyType), expired, P, { spareHours: 140 }).some((r) => r.code === a.code), 'an expired skip still hides the destination');
});
await t('a week\'s plan fits the aircraft\'s hours and repeats no destination', () => {
  const cap = maxWeeklyBlockHoursFor(grown);
  const plan = planTailWeek(grown, probe(anyType), newBotMemory(), P, { spareHours: cap });
  assert.ok(plan.routes.length >= 1 && plan.routes.length <= P.maxRoutesPerTail);
  assert.ok(plan.hours <= cap - P.hoursMargin + 1e-6, `planned ${plan.hours}h into a ${cap}h week`);
  assert.equal(new Set(plan.routes.map((r) => r.code)).size, plan.routes.length);
  assert.ok(Math.abs(plan.profit - plan.routes.reduce((s, r) => s + r.profit, 0)) < 1);
});
await t('an aircraft with no hours left is offered nothing', () => {
  assert.equal(planTailWeek(grown, probe(anyType), newBotMemory(), P, { spareHours: P.hoursMargin + 1 }).routes.length, 0);
});

console.log('\ngrowing only when it is safe');
await t('a new airline leases exactly one aircraft in its first week', () => {
  const r = turn(fresh, newBotMemory());
  assert.equal(types(r).filter((k) => k === 'ORDER_AIRCRAFT').length, 1);
  assert.equal(r.actions.find((a) => a.type === 'ORDER_AIRCRAFT').ownershipType, 'lease');
});
await t('a hub\'s prospect is the aircraft the bot would start with there, and what it would clear', () => {
  // For choosing hubs before AI airlines are founded (phase 3).
  const p = startProspect(fresh, { canLease: botDeps.canLease });
  assert.ok(p && p.weekly > 0 && p.score > 0);
  assert.equal(p.typeId, turn(fresh, newBotMemory()).actions.find((a) => a.type === 'ORDER_AIRCRAFT').typeId);
  assert.equal(startProspect(fresh, { canLease: () => false }), null);
  assert.equal(startProspect({ ...fresh, cash: 0 }, { canLease: botDeps.canLease }), null);
});
await t('it will not order with cash below the reserve', () => {
  // The type is already chosen (memory), so the only thing between this airline
  // and an order is the reserve: a fifth of its founding capital stays in the bank.
  const chosen = turn(fresh, newBotMemory()).actions.find((a) => a.type === 'ORDER_AIRCRAFT').typeId;
  const mem = { ...newBotMemory(), started: true, types: [chosen], typesAt: absWeek(fresh) };
  const reserve = fresh.paidInCapital * P.reserveShare;
  const r = turn({ ...fresh, cash: reserve + 100_000 }, mem);
  assert.ok(!types(r).includes('ORDER_AIRCRAFT'), 'ordered with only $100K above the reserve');
  assert.ok(r.refused.some((x) => /reserve/.test(x.why)), `refusals were: ${r.refused.map((x) => x.why).join(' | ')}`);
  assert.ok(types(turn({ ...fresh, cash: reserve + 5_000_000 }, mem)).includes('ORDER_AIRCRAFT'), 'did not order with $5M above the reserve');
});
await t('it will not order while an aircraft it has is parked', () => {
  // An airline that WOULD order: every aircraft flying, every route proven and paying, cash to spare.
  const inUse = grown.fleet.filter((a) => grown.routes.some((r) => r.aircraftId === a.id));
  const ready = { ...grown, cash: 1e9, pendingOrders: [], fleet: inUse, routes: grown.routes.map((r) => ({ ...r, weeksOpen: 30 })),
    lastReport: { ...grown.lastReport, routeResults: grown.lastReport.routeResults.map((rr) => ({ ...rr, profit: 400_000 })) } };
  const mem = { ...grownMem, full: Object.fromEntries(grown.fleet.map((a) => [a.id, absWeek(grown) + 9])) };
  assert.ok(types(turn(ready, mem)).includes('ORDER_AIRCRAFT'), 'fixture: this airline should be ordering');
  // … unless it is at the size its world allows an AI airline (the preset's maxFleet, lib/aiAirlines.mjs).
  assert.ok(!types(turn(ready, mem, { params: { maxFleet: inUse.length } })).includes('ORDER_AIRCRAFT'), 'ordered past its fleet limit');
  assert.ok(types(turn(ready, mem, { params: { maxFleet: inUse.length + 1 } })).includes('ORDER_AIRCRAFT'), 'one under the limit should still order');
  // The same airline with one aircraft off its routes and not yet placed.
  const st = { ...ready, routes: ready.routes.filter((r) => r.aircraftId !== inUse[0].id) };
  const r = turn(st, mem, { params: { maxAssignPerTurn: 0 } });
  assert.ok(!types(r).includes('ORDER_AIRCRAFT'), 'ordered another aircraft with one sitting idle');
});
await t('past the start-up it waits for its newest routes to prove themselves', () => {
  // (Only the aircraft that are flying: a parked one stops all ordering — the test above.)
  const flyingFleet = grown.fleet.filter((a) => grown.routes.some((r) => r.aircraftId === a.id));
  const st = { ...grown, cash: 1e9, pendingOrders: [], fleet: flyingFleet, routes: grown.routes.map((r) => ({ ...r, weeksOpen: 2 })) };
  const r = turn(st, { ...grownMem, full: Object.fromEntries(grown.fleet.map((a) => [a.id, absWeek(grown) + 9])) });
  assert.ok(!types(r).includes('ORDER_AIRCRAFT'));
  assert.ok(r.refused.some((x) => /newest routes/.test(x.why)), `refusals were: ${r.refused.map((x) => x.why).join(' | ')}`);
  // … and the same airline, its routes proven and paying, does order.
  const proven = { ...grown, cash: 1e9, pendingOrders: [], fleet: flyingFleet, routes: grown.routes.map((r) => ({ ...r, weeksOpen: 30 })),
    lastReport: { ...grown.lastReport, routeResults: grown.lastReport.routeResults.map((rr) => ({ ...rr, profit: 400_000 })) } };
  const r2 = turn(proven, { ...grownMem, full: Object.fromEntries(grown.fleet.map((a) => [a.id, absWeek(grown) + 9])) });
  assert.ok(types(r2).includes('ORDER_AIRCRAFT'), `it did not order: ${r2.refused.map((x) => x.why).join(' | ')}`);
  // … but not if those proven routes are not covering what the aircraft cost.
  const poor = { ...proven, lastReport: { ...grown.lastReport, routeResults: grown.lastReport.routeResults.map((rr) => ({ ...rr, profit: 1_000 })) } };
  const r3 = turn(poor, { ...grownMem, full: Object.fromEntries(grown.fleet.map((a) => [a.id, absWeek(grown) + 9])) });
  assert.ok(!types(r3).includes('ORDER_AIRCRAFT'));
  assert.ok(r3.refused.some((x) => /paying for itself/.test(x.why)), `refusals were: ${r3.refused.map((x) => x.why).join(' | ')}`);
});
await t('it never has more on order than its limit', () => {
  for (const wk of lab.series) for (const v of Object.values(wk.airlines)) {
    assert.ok(v.pending <= Math.max(P.maxPending, Math.ceil(v.fleet * P.pendingPerFleet)) + 1, `${v.name} had ${v.pending} on order with a fleet of ${v.fleet}`);
  }
});

console.log('\nborrowing');
// A working airline: every aircraft flying, every route proven and earning well.
// Taken from whichever bot the bank rates best after 40 weeks, not from the
// first one: these tests are about what a creditworthy airline does with
// credit, and which bot that is moves whenever the engine's economics do (it
// moved when reserve staff became a cost, 2026-11-11).
const views = [];
for (const a of lab.airlines) views.push({ view: await botView(lab, a), mem: clone(lab.memory[a.id]) });
const best = views.reduce((m, v) => (borrowingCapacity(v.view, 'long') > borrowingCapacity(m.view, 'long') ? v : m));
const credit = best.view, creditMem = best.mem;
const flying = credit.fleet.filter((a) => credit.routes.some((r) => r.aircraftId === a.id));
const healthy = { ...credit, pendingOrders: [], fleet: flying, routes: credit.routes.map((r) => ({ ...r, weeksOpen: 30 })),
  lastReport: { ...credit.lastReport, routeResults: credit.lastReport.routeResults.map((rr) => ({ ...rr, profit: 400_000, loadFactor: 0.8 })) } };
const settled = { ...creditMem, full: Object.fromEntries(credit.fleet.map((a) => [a.id, absWeek(credit) + 9])) };
await t('out of cash with a fleet that pays for itself, it borrows to get through — once', () => {
  const broke = { ...healthy, cash: 10_000 };
  const r = turn(broke, settled);
  const loan = r.actions.find((a) => a.type === 'TAKE_LOAN');
  assert.ok(loan, `no loan was taken: ${r.refused.map((x) => x.why).join(' | ')}`);
  assert.ok(loan.principal > 0 && loan.principal <= borrowingCapacity(broke, loan.productId));
  assert.ok(loan.principal <= healthy.lastReport.totalCostAll * P.bridgeToWeeks, 'borrowed more than the cushion it is allowed to rebuild');
  assert.ok(totalDebtOutstanding(r.state) > 0 && r.state.cash > broke.cash);
  assert.ok(!types(r).includes('ORDER_AIRCRAFT'), 'ordered an aircraft on borrowed money');
  // Still short the next week (the loan was spent): it does not borrow again straight away.
  const again = turn({ ...r.state, cash: 10_000, year: r.state.year, week: r.state.week }, r.memory);
  assert.ok(!types(again).includes('TAKE_LOAN'), 'took a second loan the week after the first');
});
await t('it does not borrow to prop up a fleet that is not paying for itself', () => {
  const failing = { ...healthy, cash: 10_000, lastReport: { ...healthy.lastReport, routeResults: healthy.lastReport.routeResults.map((rr) => ({ ...rr, profit: 1_000 })) } };
  assert.ok(!types(turn(failing, settled)).includes('TAKE_LOAN'));
  // … nor when it simply has cash.
  assert.ok(!types(turn({ ...healthy, cash: 5e8 }, settled)).includes('TAKE_LOAN'));
});
await t('borrowed money is not growth money: what it owes is set aside before it orders', () => {
  const fh = (healthy.financialHistory ?? []).slice(-P.earnWindow);
  const avg = fh.length ? fh.reduce((s, h) => s + (Number(h?.profit) || 0), 0) / fh.length : 0;
  const reserve = Math.max(healthy.paidInCapital * P.reserveShare, healthy.lastReport.totalCostAll * P.reserveCostWeeks) + P.reserveLossWeeks * Math.max(0, -avg);
  const cash = reserve + 10_000_000;
  const free = { ...healthy, cash };
  assert.ok(types(turn(free, settled)).includes('ORDER_AIRCRAFT'), 'fixture: an airline $10M over its reserve should order');
  const principal = Math.min(20_000_000, borrowingCapacity(free, 'long'));
  assert.ok(principal >= 15_000_000, 'fixture: expected at least $15M of long-term capacity');
  const owing = { ...applyDecision(free, { type: 'TAKE_LOAN', productId: 'long', principal }), cash };   // borrowed and spent
  assert.ok(totalDebtOutstanding(owing) >= 15_000_000);
  const r = turn(owing, settled);
  assert.ok(!types(r).includes('ORDER_AIRCRAFT'), 'ordered an aircraft while owing more than its spare cash');
  assert.ok(r.refused.some((x) => /reserve/.test(x.why)), `refusals were: ${r.refused.map((x) => x.why).join(' | ')}`);
});

console.log('\nforecasts: the player\'s own, asked for once');
await t('a route is worth what the Route Finder says, less its gates and its weeks in the hangar', () => {
  const mem = newBotMemory();
  const [top] = rankOpenRoutes(grown, probe(anyType), mem, P);
  const row = forecastLaunch(grown, { origin: grown.hub, destination: top.code, aircraft: probe(anyType), frameLease: 0, weeklyFrequency: top.freq, ticketPrice: top.ticketPrice });
  const used = {}; for (const r of grown.routes) for (const c of [r.origin, r.destination]) used[c] = (used[c] ?? 0) + r.weeklyFrequency;
  const expected = row.netProfit * P.availability - gateCostOf(grown, used, top.code, top.freq);
  assert.ok(Math.abs(top.profit - expected) <= 2, `the bot values ${top.code} at ${top.profit}; the Route Finder's row comes to ${Math.round(expected)}`);
  assert.ok(row.connectingRevenue >= 0);
});
await t('a type\'s ranking is worked out once and reused, by every question about that type', () => {
  const mem = newBotMemory(); const before = botStats.forecasts;
  const first = rankOpenRoutes(grown, probe(anyType), mem, P);
  const cost = botStats.forecasts - before;
  assert.ok(cost > 0 && mem.ranks[anyType]?.rows.length === first.length);
  assert.deepEqual(rankOpenRoutes(grown, probe(anyType), mem, P), first);
  planTailWeek(grown, probe(anyType), mem, P, { quick: true, spareHours: maxWeeklyBlockHoursFor(grown) });
  assert.equal(botStats.forecasts - before, cost, 'asking again cost more forecasts');
  // A market opened since is dropped on the way out, without a re-forecast …
  const opened = { ...grown, routes: [...grown.routes, { id: 'x', origin: grown.hub, destination: first[0].code, aircraftId: 'none', weeklyFrequency: 7, weeksOpen: 1 }] };
  assert.ok(!rankOpenRoutes(opened, probe(anyType), mem, P).some((r) => r.code === first[0].code));
  assert.equal(botStats.forecasts - before, cost);
  // … and after `rankWeeks` it is worked out afresh.
  const later = { ...grown, week: grown.week + P.rankWeeks > 52 ? grown.week + P.rankWeeks - 52 : grown.week + P.rankWeeks, year: grown.week + P.rankWeeks > 52 ? grown.year + 1 : grown.year };
  rankOpenRoutes(later, probe(anyType), mem, P);
  assert.ok(botStats.forecasts - before > cost, 'a ranking older than rankWeeks was reused');
});
await t('comparing every type is a short look that is not kept', () => {
  const mem = newBotMemory(); const before = botStats.forecasts;
  planTailWeek(grown, probe(anyType), mem, P, { quick: true, sweep: true, spareHours: maxWeeklyBlockHoursFor(grown) });
  assert.ok(botStats.forecasts - before <= P.sweepMarkets * P.fareGrid.length);
  assert.equal(mem.ranks[anyType], undefined);
});
await t('a big airline looks at fewer markets, at its usual fare, per question', () => {
  // One forecast re-works the hub's connections, so it costs more the bigger the
  // network: at 135 aircraft the un-scaled bot took seconds a turn.
  const count = (params) => { const before = botStats.forecasts; const rows = rankOpenRoutes(grown, probe(anyType), newBotMemory(), { ...P, ...params }); return { cost: botStats.forecasts - before, rows }; };
  const small = count({});
  const big = count({ effortRoutes: 0.001, houseFareRoutes: 1 });      // as if the network were enormous
  assert.ok(small.cost > P.rankKeep * P.fareGrid.length, 'fixture: the small airline should look at more than the minimum');
  assert.ok(big.cost <= P.rankKeep, `a big airline spent ${big.cost} forecasts on one ranking`);
  assert.ok(big.rows.length > 0, 'it found nothing at all');
  const usual = grown.routes.map((r) => grown.routePricing[Object.keys(grown.routePricing).find((k) => k.includes(r.origin) && k.includes(r.destination))]?.economy).filter(Boolean).length;
  assert.ok(usual > 0);
});
await t('a normal week for a settled airline costs few forecasts', () => {
  // The first lab runs asked for 240 a turn. Kept rankings bring a week with one order to well under that.
  const r1 = turn(grown, grownMem); const before = botStats.forecasts;
  turn({ ...grown }, r1.memory);
  assert.ok(botStats.forecasts - before <= 120, `a second turn on the same week's state asked for ${botStats.forecasts - before} forecasts`);
});

console.log('\ntrusting its own forecasts');
const setResult = (st, routeId, patch) => ({ ...st, lastReport: { ...st.lastReport, routeResults: st.lastReport.routeResults.map((rr) => (rr.routeId === routeId ? { ...rr, ...patch } : rr)) } });
await t('where its forecasts have over-promised, a new aircraft has to look that much better', () => {
  const cash = 1e9;
  const kept = Object.fromEntries(healthy.routes.map((r) => [r.id, 400_000]));           // promised what they earn
  const broken = Object.fromEntries(healthy.routes.map((r) => [r.id, 4e9]));             // promised ten thousand times as much
  const ok = turn({ ...healthy, cash }, { ...settled, promised: kept }, { params: { trustMin: 0.0001 } });
  assert.ok(types(ok).includes('ORDER_AIRCRAFT'), `fixture: a trusted airline with cash should order: ${ok.refused.map((x) => x.why).join(' | ')}`);
  const no = turn({ ...healthy, cash }, { ...settled, promised: broken }, { params: { trustMin: 0.0001 } });
  assert.ok(!types(no).includes('ORDER_AIRCRAFT'), 'ordered on forecasts that have been wrong ten-thousand-fold');
  assert.ok(no.refused.some((x) => /would pay|room to spare/.test(x.why)), `refusals were: ${no.refused.map((x) => x.why).join(' | ')}`);
});
await t('it remembers what each route it opens was forecast to earn', async () => {
  const lab2 = createLab({ world: 'modern', bots: 1, seed: 'airline-bot-test-promise' });
  for (let w = 0; w < 6; w++) await stepLab(lab2);
  const a = lab2.airlines[0]; const m2 = lab2.memory[a.id];
  assert.ok(a.state.routes.length > 0, 'fixture: no routes after six weeks');
  for (const rt of a.state.routes) assert.ok(m2.promised[rt.id] > 0, `no forecast kept for the route to ${rt.destination}`);
});
await t('the gates its routes use count against "the fleet pays for itself"', () => {
  // Every aircraft earns a little more than it costs to keep — before gates.
  let st = { ...healthy, cash: 1e9 };
  for (const a of st.fleet) { const mine = st.routes.filter((r) => r.aircraftId === a.id); const each = (tailCarryCost(st, a, P) + 20_000) / mine.length; for (const r of mine) st = setResult(st, r.id, { profit: each }); }
  const free = turn({ ...st, lastReport: { ...st.lastReport, totalGateFees: 0 } }, settled);
  assert.ok(!free.refused.some((x) => /paying for itself/.test(x.why)), 'fixture: with no gate bill this fleet pays for itself');
  const billed = turn({ ...st, lastReport: { ...st.lastReport, totalGateFees: 50_000 * st.fleet.length } }, settled);
  assert.ok(!types(billed).includes('ORDER_AIRCRAFT'));
  assert.ok(billed.refused.some((x) => /paying for itself/.test(x.why)), `refusals were: ${billed.refused.map((x) => x.why).join(' | ')}`);
});

console.log('\ncutting back');
const matureRoute = grown.routes.find((r) => (r.weeksOpen ?? 0) >= P.rampWeeks) ?? grown.routes[0];
const withResult = (st, routeId, patch) => ({ ...st, lastReport: { ...st.lastReport, routeResults: st.lastReport.routeResults.map((rr) => (rr.routeId === routeId ? { ...rr, ...patch } : rr)) } });
// Every other route on the same aircraft earning plenty, so the aircraft as a
// whole is fine and only the route rule can be what closes the loser.
const siblingsRich = (st, route) => st.routes.filter((r) => r.aircraftId === route.aircraftId && r.id !== route.id).reduce((acc, r) => withResult(acc, r.id, { profit: 5_000_000 }), st);
await t('a mature route that keeps losing money is closed, and not walked straight back into', () => {
  const st = siblingsRich(withResult({ ...grown, routes: grown.routes.map((r) => (r.id === matureRoute.id ? { ...r, weeksOpen: 30 } : r)) }, matureRoute.id, { profit: -80_000, loadFactor: 0.7 }), matureRoute);
  let mem = grownMem; let closedAt = null;
  for (let i = 1; i <= 3; i++) {
    const r = turn(st, mem, { params: { lossWeeks: 3 } }); mem = r.memory;
    if (r.actions.some((a) => a.type === 'CLOSE_ROUTE' && a.routeId === matureRoute.id)) { closedAt = i; break; }
  }
  assert.equal(closedAt, 3, 'expected the route to close on the third losing week, not before and not later');
  const far = matureRoute.origin === grown.hub ? matureRoute.destination : matureRoute.origin;
  assert.ok(mem.skip[far] > absWeek(grown), 'the destination was not put on the leave-alone list');
});
await t('an aircraft whose routes do not cover what it costs has them closed', () => {
  // Each route makes a little on its own flying (so the route rule is silent),
  // but together they are nowhere near the aircraft's rent, upkeep and crew.
  const tail = grown.fleet.find((a) => grown.routes.some((r) => r.aircraftId === a.id));
  const mine = grown.routes.filter((r) => r.aircraftId === tail.id);
  assert.ok(tailCarryCost(grown, tail, P) > 2_000 * mine.length);
  let st = { ...grown, routes: grown.routes.map((r) => (r.aircraftId === tail.id ? { ...r, weeksOpen: 30 } : r)) };
  for (const r of mine) st = withResult(st, r.id, { profit: 1_000_000, loadFactor: 0.7 });
  let mem = grownMem;
  for (let i = 0; i < 3; i++) { const r = turn(st, mem, { params: { lossWeeks: 3 } }); mem = r.memory; assert.ok(!r.actions.some((a) => a.type === 'CLOSE_ROUTE' && mine.some((m) => m.id === a.routeId)), 'closed the routes of an aircraft that is earning its keep'); }
  // Enough to pay for each route's own gates, so it is the AIRCRAFT that fails.
  const farOf = (r) => (r.origin === grown.hub ? r.destination : r.origin);
  const thin = (r) => weeklyGateFeeAt(grown, farOf(r), (grown.gates ?? {})[farOf(r)] ?? 1) + 2_000;
  assert.ok(mine.reduce((sum, r) => sum + thin(r), 0) < tailCarryCost(grown, tail, P), 'fixture: these routes would cover the aircraft after all');
  for (const r of mine) st = withResult(st, r.id, { profit: thin(r), loadFactor: 0.7 });
  mem = grownMem; let closed = new Set();
  for (let i = 1; i <= 3; i++) {
    const r = turn(st, mem, { params: { lossWeeks: 3 } }); mem = r.memory;
    for (const a of r.actions) if (a.type === 'CLOSE_ROUTE') closed.add(a.routeId);
    if (i < 3) assert.equal(closed.size, 0, 'closed before the aircraft had its three weeks');
  }
  for (const r of mine) assert.ok(closed.has(r.id), 'a route of the loss-making aircraft was left open');
});
await t('a route still on its ramp is never judged', () => {
  const st = withResult({ ...grown, routes: grown.routes.map((r) => (r.id === matureRoute.id ? { ...r, weeksOpen: 3 } : r)) }, matureRoute.id, { profit: -80_000, loadFactor: 0.7 });
  let mem = grownMem;
  for (let i = 0; i < 4; i++) { const r = turn(st, mem, { params: { lossWeeks: 2 } }); mem = r.memory; assert.ok(!r.actions.some((a) => a.type === 'CLOSE_ROUTE' && a.routeId === matureRoute.id)); }
});
await t('an aircraft with nothing worth flying goes back to the lessor', () => {
  const tail = grown.fleet.find((a) => a.ownershipType === 'lease' && grown.routes.some((r) => r.aircraftId === a.id));
  const st = { ...grown, cash: 5e7, routes: grown.routes.filter((r) => r.aircraftId !== tail.id) };
  let mem = grownMem; let returned = null;
  for (let i = 1; i <= 3; i++) {
    const r = turn(st, mem, { params: { minDemand: 1e12, idleWeeksToReturn: 3 } }); mem = r.memory;
    if (r.actions.some((a) => a.type === 'RETIRE_AIRCRAFT' && a.aircraftId === tail.id)) { returned = i; break; }
    assert.ok(!types(r).includes('ORDER_AIRCRAFT'));
  }
  assert.equal(returned, 3, 'expected the parked aircraft to be handed back after three idle weeks');
});
await t('a heavy check that has come due is started', () => {
  const tail = grown.fleet.find((a) => a.status !== 'maintenance' && a.status !== 'grounded');
  const st = { ...grown, cash: 5e7, fleet: grown.fleet.map((a) => (a.id === tail.id ? { ...a, hoursSinceC: C_HOURS_DUE + 10, scheduledCheck: null } : a)) };
  const r = turn(st, grownMem);
  const act = r.actions.find((a) => a.type === 'SCHEDULE_CHECK' && a.aircraftId === tail.id);
  assert.ok(act, 'no check was started');
  assert.equal(act.startNow, true);
  assert.ok(['maintenance', 'grounded'].includes(r.state.fleet.find((a) => a.id === tail.id).status), 'the aircraft did not go into the hangar');
});

console.log('\nfares');
await t('a route that sells out goes up a step; a mature one flying empty comes down', () => {
  const [hi, lo] = grown.routes.filter((r) => grown.lastReport.routeResults.some((rr) => rr.routeId === r.id));
  let st = { ...grown, routes: grown.routes.map((r) => (r.id === lo.id ? { ...r, weeksOpen: 40 } : r)) };
  st = withResult(withResult(st, hi.id, { loadFactor: 0.97 }), lo.id, { loadFactor: 0.3 });
  const key = (r) => Object.keys(st.routePricing).find((k) => k.includes(r.origin) && k.includes(r.destination));
  const r = turn(st, grownMem);
  const up = r.actions.find((a) => a.type === 'BULK_ADJUST_PRICING' && a.pct.economy > 0);
  const down = r.actions.find((a) => a.type === 'BULK_ADJUST_PRICING' && a.pct.economy < 0);
  assert.ok(up?.routeIds.includes(hi.id), 'the full route was not repriced upward');
  assert.ok(down?.routeIds.includes(lo.id), 'the empty mature route was not repriced downward');
  assert.ok(r.state.routePricing[key(hi)].economy > st.routePricing[key(hi)].economy);
  assert.ok(r.state.routePricing[key(lo)].economy < st.routePricing[key(lo)].economy);
});

console.log('\nmemory');
await t('the memory is plain JSON and carries its version', () => {
  const m = turn(grown, grownMem).memory;
  assert.deepEqual(clone(m), m);
  assert.equal(m.v, BOT_MEMORY_VERSION);
});
await t('an older or empty memory is taken up, not tripped over', () => {
  for (const old of [null, {}, { v: 1, started: true, loss: {}, idle: {}, skip: {}, optedOut: {}, types: ['nope'], typesAt: 1 }]) {
    const r = turn(grown, old);
    assert.equal(r.memory.v, BOT_MEMORY_VERSION);
    for (const k of ['loss', 'tailLoss', 'idle', 'full', 'skip', 'optedOut']) assert.equal(typeof r.memory[k], 'object');
  }
});

console.log('\nit survives — and the rules are why');
await t('all three airlines in the fixture world are still flying after 40 weeks, with aircraft and routes', () => {
  for (const a of lab.airlines) {
    assert.equal(a.status, 'ACTIVE', `${a.name} went bankrupt in week ${a.bankruptWeek}`);
    assert.ok(a.state.fleet.length >= 2 && a.state.routes.length >= 2, `${a.name}: ${a.state.fleet.length} aircraft, ${a.state.routes.length} routes`);
    assert.ok(a.state.cash > 0);
  }
});
// The lab, 16 airlines a side in "modern" worlds: with these rules, none failed
// in two years; with them switched off, 8 failed inside one year (5 even when
// allowed the bridge loan). The survivors of the reckless run end the year about
// twice the size — a personality for the Fierce preset, not the cautious tier.
await t('MUTATION CHECK: the same world with the cash rules switched off loses an airline the cautious bot keeps', async () => {
  const reckless = { reserveShare: 0, reserveCostWeeks: 0, reserveLossWeeks: 0, earnFromFleet: 999, minNetShare: -10, maxRentShare: 1, maxFixedShare: 1,
                     maxPending: 8, pendingPerFleet: 1, ordersPerFleet: 1, startupShare: 0, depositWeeks: 0, bridgeBelowWeeks: -1 };
  const bad = createLab({ world: 'modern', bots: 3, seed: 'airline-bot-test', params: reckless });
  for (let w = 0; w < 30; w++) await stepLab(bad);
  const dead = bad.airlines.filter((a) => a.status !== 'ACTIVE').length;
  assert.equal(lab.airlines.filter((a) => a.status !== 'ACTIVE').length, 0, 'the cautious fixture lost an airline');
  assert.ok(dead >= 1, 'no reckless airline failed in 30 weeks — the cash rules are not what is keeping the bot alive');
});
for (const world of Object.keys(LAB_WORLDS)) {
  await t(`it gets an airline off the ground in a "${world}" world`, async () => {
    const l = createLab({ world, bots: 2, seed: `airline-bot-test-${world}` });
    for (let w = 0; w < 14; w++) await stepLab(l);
    for (const k of new Set(l.journal.map((j) => j.type))) assert.ok(ALLOWED.has(k), `${k} is not on the allow-list`);
    for (const a of l.airlines) {
      assert.equal(a.status, 'ACTIVE', `${a.name} is bankrupt`);
      assert.ok(a.state.fleet.length >= 1, `${a.name} has no aircraft after 14 weeks`);
      assert.ok(a.state.routes.length >= 1, `${a.name} has no routes after 14 weeks`);
      assert.ok(tailHoursUsed(a.state, a.state.fleet[0]) <= maxWeeklyBlockHoursFor(a.state) + 1e-6);
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
