// Freighter conversions, Headwinds side (claude/p2f-conversion.md): the action
// is on the allow-list, the guard passes only the airline's own ids and a
// strict boolean, and in production-line worlds a conversion's slot is counted
// everywhere an order's is — the rival view, the in-transaction re-check, and
// an ORDER that would land on a week rivals' conversions already filled.
//
// Verified failing on HEAD (2026-11-05): CONVERT_TO_FREIGHTER was not in
// ALLOWED_PLAYER_ACTIONS, the guard had no case for it, and
// productionLineService had no newConversionLineOrdersOf.
//
//   node --import ./tools/_register-loader.mjs tools/p2f-conversion-server-test.mjs
import assert from 'node:assert/strict';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';
import { buildRivalViews } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import * as svc from '../apps/headwinds-server/src/lib/productionLineService.mjs';
import { capacityFor, lineOrdersOf } from '../packages/engine/src/data/productionLines.js';

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const row = (id, { fleet = [], pending = [], status = 'ACTIVE' } = {}) => ({
  id, name: id, hub: 'JFK', status, restarts: 0,
  account: { isOG: false, isSupporter: false, email: `${id}@x.test` },
  state: { productionLinesWorld: true, productionLineScale: 1, hub: 'JFK', routes: [], cargoRoutes: [],
           fleet, pendingOrders: pending, financialHistory: [], statsHistory: [] },
});
const converting = (id, week) => ({
  id, typeId: 'a321ceo', status: 'maintenance', checkType: 'P2F', ownershipType: 'owned',
  pendingConversion: { toTypeId: 'a321p2f', lineId: 'conv_a320', capex: 1, doneAbsWeek: week, startedAbsWeek: week - 12 },
});

await t('CONVERT_TO_FREIGHTER is a player action; the guard keeps own ids and a strict flag', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('CONVERT_TO_FREIGHTER'));
  const state = { fleet: [{ id: 'a' }, { id: 'b' }] };
  const g = guardDecision('CONVERT_TO_FREIGHTER', { aircraftIds: ['a', 'zzz', 'a'], closeRoutes: 'yes', capex: 1, doneAbsWeek: 2 }, state);
  assert.deepEqual(g, { aircraftIds: ['a'], closeRoutes: false });
  assert.equal(guardDecision('CONVERT_TO_FREIGHTER', { aircraftIds: ['b'], closeRoutes: true }, state).closeRoutes, true);
  assert.throws(() => guardDecision('CONVERT_TO_FREIGHTER', { aircraftIds: ['zzz'] }, state));
});

await t("rivals' conversions are in each airline's line view", () => {
  const views = buildRivalViews([row('me'), row('b', { fleet: [converting('x', 60), { id: 'y', typeId: 'a321ceo' }] })]);
  assert.deepEqual(views.get('me').lineBook.bookings, { conv_a320: { 60: 1 } });
  assert.deepEqual(views.get('b').lineBook.bookings, {});
});

await t('only conversions this decision started are re-checked', () => {
  const before = [converting('old', 50), { id: 'idle', typeId: 'a321ceo' }];
  const after = [converting('old', 50), converting('idle', 55)];
  assert.deepEqual(svc.newConversionLineOrdersOf(before, after).map(o => o.id), ['conv:idle']);
});

await t("the re-check refuses a conversion on a week rivals' conversions filled", async () => {
  const cap = capacityFor({ lineBook: { scale: 1, bookings: {} } }, 'conv_a320', 10);
  const rivals = Array.from({ length: cap }, (_, i) => row(`r${i}`, { fleet: [converting(`r${i}c`, 50)] }));
  const tx = { airline: { findMany: async ({ where }) => [row('me'), ...rivals].filter(r => r.status === where.status) } };
  const mine = { fleet: [converting('n1', 50)], pendingOrders: [] };
  const fresh = svc.newConversionLineOrdersOf([], mine.fleet);
  await assert.rejects(
    svc.assertLineSlotsTx(tx, { worldId: 'w', airlineId: 'me', pendingOrders: lineOrdersOf(mine), newOrders: fresh, absWeek: 10 }),
    svc.LineSlotConflict,
  );
  const ok = { fleet: [converting('n2', 51)], pendingOrders: [] };
  await svc.assertLineSlotsTx(tx, { worldId: 'w', airlineId: 'me', pendingOrders: lineOrdersOf(ok),
                                    newOrders: svc.newConversionLineOrdersOf([], ok.fleet), absWeek: 10 });
});

await t("an ORDER for an A321P2F cannot take a week rivals' conversions filled", async () => {
  const cap = capacityFor({ lineBook: { scale: 1, bookings: {} } }, 'conv_a320', 10);
  const rivals = Array.from({ length: cap }, (_, i) => row(`r${i}`, { fleet: [converting(`r${i}c`, 70)] }));
  const tx = { airline: { findMany: async ({ where }) => [row('me'), ...rivals].filter(r => r.status === where.status) } };
  const order = [{ id: 'o1', typeId: 'a321p2f', lineId: 'conv_a320', deliverAbsWeek: 70, ownershipType: 'owned' }];
  await assert.rejects(
    svc.assertLineSlotsTx(tx, { worldId: 'w', airlineId: 'me', pendingOrders: order, newOrders: order, absWeek: 10 }),
    svc.LineSlotConflict,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
