// Shared world calendar test — no database, no network.
//
// Proves the "one world, one date" rule: an airline rebased onto its world's
// clock shows the world's date AND simulates the world's season, while nothing
// already in flight is fast-forwarded or delayed.
//
//   node tools/world-calendar-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { currentGameDate, weekToGameDate } from '../packages/engine/src/utils/simulation.js';
import {
  rebaseStateCalendar, absWeekOf, yearWeekOf, historyLabel,
} from '../apps/headwinds-server/src/lib/calendar.mjs';
import { joinWorld, createWorld } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// A mid-game blob with one of every absolute-week schedule the reducer stores.
function midGameState() {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Test Air', hub: 'SFO' });
  return {
    ...s,
    year: 1,
    week: 20,                                   // abs week 20
    fleet: [
      {
        id: 'ac1', typeId: 'a320', status: 'idle',
        ageWeeks: 60, leaseRemainingWeeks: 44, weeksSinceC: 30, weeksSinceD: 30,
        cDueAtWeek: 18, dDueAtWeek: null,
        scheduledCheck: { type: 'C', startWeek: 26 },   // 6 weeks out
      },
    ],
    pendingOrders: [
      { id: 'o1', typeId: 'b738', deliverAbsWeek: 23, totalPrice: 1 },  // 3 weeks out
      { id: 'o2', typeId: 'b738', deliverAbsWeek: 31, totalPrice: 1 },  // 11 weeks out
    ],
    hubs: { SFO: { tier: 2, tierSince: 12 } },
    hedgeContracts: [
      { id: 'h1', startAbsWeek: 14, expiryAbsWeek: 40, weeksTotal: 26 }, // 20 weeks left
    ],
    laborRelations: {
      unrest: { pilots: 10 },
      strike: null,
      negotiation: null,
      nextNegotiationAbsWeek: { pilots: 45, cabinCrew: 60 },
      strikeCooldownUntilAbsWeek: 33,
    },
    financialHistory: [
      { label: historyLabel(1, 18), week: 18, year: 1, cash: 1 },
      { label: historyLabel(1, 19), week: 19, year: 1, cash: 2 },
    ],
    statsHistory: [
      { label: historyLabel(1, 18), week: 18, year: 1, absWeek: 18, routes: 1 },
      { label: historyLabel(1, 19), week: 19, year: 1, absWeek: 19, routes: 2 },
    ],
  };
}

console.log('\nShared world calendar\n');

// ── Index helpers ─────────────────────────────────────────────────────────────
await test('absWeekOf / yearWeekOf round-trip', () => {
  assert.equal(absWeekOf(1, 1), 1);
  assert.equal(absWeekOf(3, 12), 2 * 52 + 12);
  for (const abs of [1, 52, 53, 104, 137, 519]) {
    const { year, week } = yearWeekOf(abs);
    assert.equal(absWeekOf(year, week), abs, `round-trip failed at ${abs}`);
  }
});

// ── The headline fix ──────────────────────────────────────────────────────────
await test('a mid-season joiner starts on the world date, not Y1W1', () => {
  const world = createWorld({ name: 'Gates' });
  world.week = 48; world.year = 2;             // world is deep in November, year 2
  const state = joinWorld(world, { accountId: 'acc1', airlineName: 'Late Air', hub: 'LAX' });
  assert.equal(state.year, 2);
  assert.equal(state.week, 48);
});

await test('two players who joined weeks apart read the same date', () => {
  const world = createWorld({ name: 'Gates' });
  world.week = 4; world.year = 1;
  const early = joinWorld(world, { accountId: 'a', airlineName: 'Early Air', hub: 'SFO' });
  world.week = 50;                              // ...46 weeks pass...
  const late = joinWorld(world, { accountId: 'b', airlineName: 'Late Air', hub: 'JFK' });
  // The early player has been ticked forward by the world; simulate that.
  const earlyNow = { ...early, week: 50 };
  assert.equal(earlyNow.week, late.week);
  assert.equal(earlyNow.year, late.year);
});

await test('rebase puts the airline in the world season, not its private one', () => {
  const s = midGameState();                     // week 20 -> May-ish
  const before = currentGameDate(s).month;
  const { state } = rebaseStateCalendar(s, { year: 1, week: 50 });   // -> December
  const after = currentGameDate(state).month;
  assert.equal(after, weekToGameDate(50).monthIndex);
  assert.notEqual(before, after, 'the test fixture must actually change season');
  assert.equal(state.week, 50);
  assert.equal(state.year, 1);
});

// ── Nothing in flight is fast-forwarded ───────────────────────────────────────
await test('pending deliveries stay the same number of weeks out', () => {
  const s = midGameState();
  const fromAbs = absWeekOf(s.year, s.week);
  const { state, delta } = rebaseStateCalendar(s, { year: 3, week: 12 });
  const toAbs = absWeekOf(3, 12);
  assert.equal(delta, toAbs - fromAbs);
  const outBefore = s.pendingOrders.map((o) => o.deliverAbsWeek - fromAbs);
  const outAfter = state.pendingOrders.map((o) => o.deliverAbsWeek - toAbs);
  assert.deepEqual(outAfter, outBefore);
  assert.ok(state.pendingOrders.every((o) => o.deliverAbsWeek > toAbs), 'nothing delivers instantly');
});

await test('booked heavy check + due markers move with the calendar', () => {
  const s = midGameState();
  const fromAbs = absWeekOf(s.year, s.week);
  const { state } = rebaseStateCalendar(s, { year: 3, week: 12 });
  const toAbs = absWeekOf(3, 12);
  assert.equal(state.fleet[0].scheduledCheck.startWeek - toAbs, s.fleet[0].scheduledCheck.startWeek - fromAbs);
  assert.equal(state.fleet[0].cDueAtWeek - toAbs, s.fleet[0].cDueAtWeek - fromAbs);
  assert.equal(state.fleet[0].dDueAtWeek, null, 'a null marker stays null');
});

await test('hub tierSince, hedges and labor dates all shift by the same delta', () => {
  const s = midGameState();
  const { state, delta } = rebaseStateCalendar(s, { year: 3, week: 12 });
  assert.equal(state.hubs.SFO.tierSince, s.hubs.SFO.tierSince + delta);
  assert.equal(state.hedgeContracts[0].startAbsWeek, s.hedgeContracts[0].startAbsWeek + delta);
  assert.equal(state.hedgeContracts[0].expiryAbsWeek, s.hedgeContracts[0].expiryAbsWeek + delta);
  assert.equal(state.laborRelations.nextNegotiationAbsWeek.pilots, 45 + delta);
  assert.equal(state.laborRelations.nextNegotiationAbsWeek.cabinCrew, 60 + delta);
  assert.equal(state.laborRelations.strikeCooldownUntilAbsWeek, 33 + delta);
});

await test('relative counters are NOT shifted', () => {
  const s = midGameState();
  const { state } = rebaseStateCalendar(s, { year: 3, week: 12 });
  const a0 = s.fleet[0], a1 = state.fleet[0];
  assert.equal(a1.ageWeeks, a0.ageWeeks);
  assert.equal(a1.leaseRemainingWeeks, a0.leaseRemainingWeeks);
  assert.equal(a1.weeksSinceC, a0.weeksSinceC);
  assert.equal(a1.weeksSinceD, a0.weeksSinceD);
  assert.equal(state.hedgeContracts[0].weeksTotal, s.hedgeContracts[0].weeksTotal);
  assert.equal(state.cash, s.cash);
  assert.equal(state.hubs.SFO.tier, s.hubs.SFO.tier);
});

await test('history series is re-stamped and stays monotonic', () => {
  const s = midGameState();
  const { state, delta } = rebaseStateCalendar(s, { year: 3, week: 12 });
  const stats = state.statsHistory;
  assert.equal(stats[0].absWeek, 18 + delta);
  assert.equal(stats[1].absWeek, 19 + delta);
  assert.ok(stats[1].absWeek < absWeekOf(3, 12), 'history stays in the past');
  for (const r of [...state.financialHistory, ...stats]) {
    assert.equal(r.label, historyLabel(r.year, r.week), 'label matches its re-stamped date');
    assert.equal(absWeekOf(r.year, r.week), (r.absWeek ?? absWeekOf(r.year, r.week)));
  }
});

await test('rebasing to the same date is a no-op', () => {
  const s = midGameState();
  const { state, delta } = rebaseStateCalendar(s, { year: s.year, week: s.week });
  assert.equal(delta, 0);
  assert.equal(state, s, 'returns the identical object when nothing to do');
});

await test('rebase is idempotent', () => {
  const s = midGameState();
  const once = rebaseStateCalendar(s, { year: 3, week: 12 }).state;
  const twice = rebaseStateCalendar(once, { year: 3, week: 12 }).state;
  assert.deepEqual(twice, once);
});

await test('a rebased blob still ticks', () => {
  const s = midGameState();
  const { state } = rebaseStateCalendar(s, { year: 3, week: 12 });
  const next = gameReducer(state, { type: 'ADVANCE_WEEK' });
  assert.equal(next.year, 3);
  assert.equal(next.week, 13);
  assert.ok(!next.advanceWeekError, next.advanceWeekError);
});

await test('a rebase across a year boundary rolls the year correctly', () => {
  const s = { ...midGameState(), year: 1, week: 50 };
  const { state, delta } = rebaseStateCalendar(s, { year: 2, week: 3 });
  assert.equal(delta, absWeekOf(2, 3) - absWeekOf(1, 50));
  assert.equal(delta, 5);
  assert.equal(state.year, 2);
  assert.equal(state.week, 3);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
