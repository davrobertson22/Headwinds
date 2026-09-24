// Pre-start setup in scheduled worlds — no database, no network, no browser.
//
// A world created with tickConfig.scheduledStartAt sits in LOBBY until the
// worker flips it to RUNNING at the announced time. Players may join during
// that window, but every decision used to 409 ("This world is LOBBY"), so a
// joiner could look at their airline and do nothing with it until the gun.
// Now the airline is fully playable before the start — open routes, lease
// aircraft, set fares — and only the clock waits: week 1 flies at the first
// tick, one interval after the scheduled start.
//
// Covered:
//   · worldConfig.isPreStart / decisionDenialFor — who may act, and what waits
//   · share trading & capital actions stay closed until the start (the float
//     pool is seeded from the ACTIVE count on first touch; seeding it from the
//     handful of early joiners would starve the season of liquidity)
//   · nextTickAt counts down to the FIRST week in a scheduled lobby, and is
//     still null for a classic lobby and for ticksDue (the clock stays parked)
//   · decisions.mjs and codeshares.mjs gate through the helper, not a bare
//     `status !== 'RUNNING'`
//   · the TickCountdown component (SSR) labels the pre-start countdown
//
//   node --import ./tools/_register-loader.mjs tools/scheduled-prestart-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

import {
  isPreStart, decisionDenialFor, PRE_START_BLOCKED_ACTIONS, tickIntervalMs,
} from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { nextTickAt, ticksDue } from '../apps/headwinds-server/src/lib/tickService.mjs';
import TickCountdown from '../apps/headwinds-web/src/TickCountdown.jsx';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const START = '2026-10-01T17:00:00.000Z';
const world = (over = {}) => ({
  id: 'w1', name: 'Launch Day', status: 'LOBBY', lengthYears: 10, weeksPerDay: 24,
  currentYear: 1, currentWeek: 1, startedAt: null, endsAt: null,
  tickConfig: { scheduledStartAt: START }, ...over,
});
const classicLobby = world({ tickConfig: {} });
const running = world({ status: 'RUNNING', startedAt: new Date(START) });

console.log('\n── 1. who may act ───────────────────────────────────────');

await test('a scheduled world in LOBBY is pre-start', () => {
  assert.equal(isPreStart(world()), true);
});

await test('a classic lobby, a running world and an ended one are not', () => {
  assert.equal(isPreStart(classicLobby), false);
  assert.equal(isPreStart(running), false);
  assert.equal(isPreStart(world({ status: 'ENDED' })), false);
});

await test('ordinary decisions are allowed before the start', () => {
  for (const type of ['OPEN_ROUTE', 'LEASE_AIRCRAFT', 'BUY_AIRCRAFT', 'SET_FARE', 'UPDATE_ROUTE']) {
    assert.equal(decisionDenialFor(world(), type), null, type);
  }
});

await test('and still allowed once running', () => {
  assert.equal(decisionDenialFor(running, 'OPEN_ROUTE'), null);
});

await test('share trading and capital actions wait for the start', () => {
  assert.deepEqual([...PRE_START_BLOCKED_ACTIONS].sort(),
    ['BUY_BACK_SHARES', 'BUY_STOCK', 'GO_PUBLIC', 'ISSUE_SHARES', 'SELL_STOCK']);
  for (const type of PRE_START_BLOCKED_ACTIONS) {
    const d = decisionDenialFor(world(), type);
    assert.ok(d && /opens when the world starts/i.test(d), `${type}: ${d}`);
    assert.equal(decisionDenialFor(running, type), null, `${type} once running`);
  }
});

await test('ENDED / ARCHIVED / classic-LOBBY worlds still refuse everything', () => {
  for (const w of [world({ status: 'ENDED' }), world({ status: 'ARCHIVED' }), classicLobby]) {
    assert.match(decisionDenialFor(w, 'OPEN_ROUTE'), new RegExp(`This world is ${w.status}`));
  }
});

console.log('\n── 2. the clock stays parked ────────────────────────────');

await test('no ticks are owed before the start, even long after the schedule passes', () => {
  assert.equal(ticksDue(world(), new Date('2027-01-01T00:00:00Z')), 0);
});

await test('nextTickAt counts down to week 1 — one interval after the start', () => {
  const at = nextTickAt(world());
  assert.ok(at, 'expected a countdown target for a scheduled lobby');
  assert.equal(at.getTime(), new Date(START).getTime() + tickIntervalMs(24));
});

await test('and agrees with the running world the worker will flip it into', () => {
  assert.equal(nextTickAt(world()).getTime(), nextTickAt(running).getTime());
});

await test('a classic lobby has no countdown', () => {
  assert.equal(nextTickAt(classicLobby), null);
});

await test('garbage in the schedule yields no countdown, not NaN', () => {
  assert.equal(nextTickAt(world({ tickConfig: { scheduledStartAt: 'soon' } })), null);
});

console.log('\n── 3. the routes use the helper ─────────────────────────');

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

await test('POST /decisions gates on decisionDenialFor, not RUNNING', () => {
  const s = src('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.ok(!/world\.status !== 'RUNNING'/.test(s), 'bare RUNNING gate still present');
  assert.ok(/decisionDenialFor\(airline\.world, type\)/.test(s), 'helper not called');
});

await test('codeshares open before the start too', () => {
  const s = src('../apps/headwinds-server/src/routes/codeshares.mjs');
  const gate = s.split('\n').find((l) => /world\.status !== 'RUNNING'/.test(l));
  assert.ok(gate, 'codeshare gate not found');
  assert.match(gate, /isPreStart\(world\)/, 'gate does not admit pre-start worlds');
});

await test('the state poll tells the client when the world starts', () => {
  const s = src('../apps/headwinds-server/src/routes/decisions.mjs');
  assert.ok(/startsAt:/.test(s), 'worldClock.startsAt missing');
});

console.log('\n── 4. TickCountdown (SSR) ───────────────────────────────');

const inMs = (ms) => new Date(Date.now() + ms).toISOString();

await test('running: "next week in"', () => {
  const html = renderToString(React.createElement(TickCountdown, { nextTickAt: inMs(90 * 60_000) }));
  assert.match(html, /next week in/);
});

await test('pre-start: "first week in", with the start time in the tooltip', () => {
  const html = renderToString(React.createElement(TickCountdown, {
    nextTickAt: inMs(3 * 3600_000), startsAt: inMs(2 * 3600_000), preStart: true,
  }));
  assert.match(html, /first week in/);
  assert.doesNotMatch(html, /next week in/);
  assert.match(html, /title="[^"]*starts/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
