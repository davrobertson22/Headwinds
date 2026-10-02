// Lease auto-renewal, bulk extension of any lease, and a warning window that
// means something in real time.
//
// Discord (LtFrosty, 2026-10-01): 182 leases, one +1yr click each, and the
// 8-week warning is 8 real hours in a 24-weeks-a-day world — "if you sleep for
// 8 hours you're almost guaranteed to lose some leased planes".
//
//   node tools/lease-auto-renew-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { AIRCRAFT_TYPES } = await import('../packages/engine/src/data/aircraft.js');
const lr = await import('../packages/engine/src/models/leaseRenewal.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const type = AIRCRAFT_TYPES.find(t => !t.freighter && t.range > 4000 && t.seats > 100 && t.seats < 200);
const leased = (id, remaining, extra = {}) => ({
  id, typeId: type.id, name: id, tailNumber: id.toUpperCase(), status: 'idle', ageWeeks: 52,
  ownershipType: 'lease', weeklyLease: 50_000, leaseDeposit: 0,
  leaseTermWeeks: 104, leaseRemainingWeeks: remaining, ...extra,
});

function started(overrides = {}) {
  const s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Lease Air', hub: 'JFK', enableObjectives: false });
  return { ...s, cash: 500_000_000, fleet: [], routes: [], cargoRoutes: [], pendingToasts: [], ...overrides };
}
const tick = (s) => gameReducer(s, { type: 'ADVANCE_WEEK' });
const byId = (s, id) => s.fleet.find(a => a.id === id);

console.log('\n── auto-renew in the tick ─────────────────────────────\n');

await test('off by default: a lease with one week left goes back, as before', () => {
  const s1 = tick(started({ fleet: [leased('l1', 1)] }));
  assert.equal(byId(s1, 'l1'), undefined);
});

await test('on: a lease reaching 4 weeks is extended by the chosen term, not returned', () => {
  let s = started({ fleet: [leased('l1', 5)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true, addWeeks: 104 });
  s = tick(s);
  assert.equal(byId(s, 'l1').leaseRemainingWeeks, 4 + 104);
  assert.ok(byId(s, 'l1').leaseTermWeeks >= 108, 'the term grows so the bar never overflows');
});

await test('on: a lease already inside the window when the rule is turned on renews next tick', () => {
  let s = started({ fleet: [leased('l1', 1)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true });
  s = tick(s);
  assert.ok(byId(s, 'l1'), 'the aircraft must not go back');
  assert.equal(byId(s, 'l1').leaseRemainingWeeks, 0 + 52);
});

await test('on: a lease with plenty left is not touched', () => {
  let s = started({ fleet: [leased('l1', 40)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true });
  s = tick(s);
  assert.equal(byId(s, 'l1').leaseRemainingWeeks, 39);
});

await test('a tail opted out still goes back; the rest renew', () => {
  let s = started({ fleet: [leased('keep', 1), leased('drop', 1)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW_OPT_OUT', aircraftIds: ['drop'], optOut: true });
  s = tick(s);
  assert.ok(byId(s, 'keep'));
  assert.equal(byId(s, 'drop'), undefined);
});

await test('opt-out can be cleared again', () => {
  let s = started({ fleet: [leased('l1', 1)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW_OPT_OUT', aircraftIds: ['l1'], optOut: true });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW_OPT_OUT', aircraftIds: ['l1'], optOut: false });
  assert.equal(byId(s, 'l1').leaseAutoRenewOff, undefined);
  assert.ok(byId(tick(s), 'l1'));
});

await test('renewals are free and keep the signed rate', () => {
  let s = started({ fleet: [leased('l1', 3)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true });
  const s1 = tick(s);
  assert.equal(byId(s1, 'l1').weeklyLease, 50_000);
});

await test('one summary toast for the week, not one per tail', () => {
  let s = started({ fleet: [leased('a', 2), leased('b', 3), leased('c', 4)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true });
  const s1 = tick(s);
  const renewed = (s1.pendingToasts ?? []).filter(t => /auto-renewed/i.test(t.title));
  assert.equal(renewed.length, 1);
  assert.match(renewed[0].title, /3 leases/);
});

await test('no "lease expiring" toast for a tail auto-renew will cover', () => {
  let s = started({ fleet: [leased('l1', 9)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true });
  const s1 = tick(s);
  assert.equal((s1.pendingToasts ?? []).filter(t => /Lease expiring/.test(t.title)).length, 0);
});

await test('a forged term falls back to a year; a non-boolean opt-out list is ignored', () => {
  let s = started({ fleet: [leased('l1', 1)] });
  s = gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW', enabled: true, addWeeks: 1_000_000 });
  assert.equal(lr.leaseAutoRenewSetting(s).addWeeks, 52);
  assert.equal(gameReducer(s, { type: 'SET_LEASE_AUTO_RENEW_OPT_OUT', aircraftIds: 'x', optOut: true }), s);
});

console.log('\n── warning window ─────────────────────────────────────\n');

await test('solo keeps the 8-week window', () => {
  assert.equal(lr.leaseWarnWeeks({}), 8);
});

await test('multiplayer warns one real day ahead, floored at 8 and capped at a year', () => {
  assert.equal(lr.leaseWarnWeeks({ weeksPerDay: 1 }), 8);
  assert.equal(lr.leaseWarnWeeks({ weeksPerDay: 24 }), 24);
  assert.equal(lr.leaseWarnWeeks({ weeksPerDay: 96 }), 52);
});

await test('the tick toasts when a lease enters the real-time window', () => {
  const s1 = tick(started({ weeksPerDay: 24, fleet: [leased('l1', 25)] }));
  assert.equal((s1.pendingToasts ?? []).filter(t => /Lease expiring/.test(t.title)).length, 1);
  const s2 = tick(started({ weeksPerDay: 24, fleet: [leased('l1', 9)] }));
  assert.equal((s2.pendingToasts ?? []).filter(t => /Lease expiring/.test(t.title)).length, 0,
    'the old 8-week toast is replaced by the window toast, not added to it');
});

await test('the client predicate reads the same window', async () => {
  const la = await import('../src/utils/leaseAlerts.js');
  const st = { weeksPerDay: 24 };
  assert.equal(la.isLeaseExpiring(leased('x', 20), la.leaseWarnWeeks(st)), true);
  assert.equal(la.isLeaseExpiring(leased('x', 20)), false);
});

console.log('\n── multiplayer wiring and UI ──────────────────────────\n');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

await test('the server allows and sanitizes the new actions', async () => {
  const world = read('../apps/headwinds-server/src/world.mjs');
  for (const t of ['SET_LEASE_AUTO_RENEW', 'SET_LEASE_AUTO_RENEW_OPT_OUT']) assert.ok(world.includes(`'${t}'`), `${t} not allow-listed`);
  const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
  const s = started({ fleet: [leased('l1', 10)] });
  assert.deepEqual(guardDecision('SET_LEASE_AUTO_RENEW', { enabled: 'yes', addWeeks: 99999 }, s), { enabled: true, addWeeks: 52 });
  const g = guardDecision('SET_LEASE_AUTO_RENEW_OPT_OUT', { aircraftIds: ['l1', 'nope'], optOut: 1 }, s);
  assert.deepEqual(g.aircraftIds, ['l1']);
  assert.equal(g.optOut, true);
});

await test('the tick injects the world pace', () => {
  assert.match(read('../apps/headwinds-server/src/lib/tickService.mjs'), /weeksPerDay:\s*world\.weeksPerDay/);
});

await test('Fleet offers the rule, the opt-out, and extend-all on the expiring chip', () => {
  const src = read('../src/components/Fleet.jsx');
  assert.ok(/SET_LEASE_AUTO_RENEW'/.test(src), 'no auto-renew control');
  assert.ok(/SET_LEASE_AUTO_RENEW_OPT_OUT/.test(src), 'no per-tail opt-out');
  assert.ok(/Extend all/.test(src), 'no extend-all button');
  assert.ok(/handleBulkExtend\(checkedLeased\)/.test(src), 'bulk extend still limited to expiring tails');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
