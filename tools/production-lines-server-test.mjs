// Production lines, Headwinds side: new worlds get the flag, the rival view
// carries every OTHER airline's slot bookings (never persisted), competitors
// carry the order-board fleet mix, the guard strips anything that tries to set
// a slot, and the in-transaction re-check refuses a slot a rival already took.
//
//   node --import ./tools/_register-loader.mjs tools/production-lines-server-test.mjs
import assert from 'node:assert/strict';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { seedAirlineState, createWorld } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { validateWorldConfig } from '../apps/headwinds-server/src/lib/worldConfig.mjs';

const { buildRivalViews, withRivals, stripRivals, rivalOverlay } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const svc = await import('../apps/headwinds-server/src/lib/productionLineService.mjs').catch(() => null);
const needSvc = () => assert.ok(svc, 'lib/productionLineService.mjs does not exist');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const row = (id, { lines = true, fleet = [], pending = [], status = 'ACTIVE' } = {}) => ({
  id, name: id, hub: 'JFK', status, restarts: 0,
  account: { isOG: false, isSupporter: false, email: `${id}@x.test` },
  state: {
    ...(lines ? { productionLinesWorld: true, productionLineScale: 1 } : {}),
    hub: 'JFK', routes: [], cargoRoutes: [], fleet, pendingOrders: pending,
    financialHistory: [], statsHistory: [],
  },
});
const o787 = (id, w) => ({ id, typeId: 'b7879', lineId: 'b787', deliverAbsWeek: w, ownershipType: 'owned' });
const world = (tickConfig = {}) => ({ id: 'w', currentYear: 1, currentWeek: 1, maxPlayers: 50, tickConfig });

await t('new worlds get production lines unless unticked; the flag reaches the airline', () => {
  assert.doesNotThrow(() => validateWorldConfig({ lengthYears: 50, weeksPerDay: 24, productionLines: true }));
  assert.throws(() => validateWorldConfig({ lengthYears: 50, weeksPerDay: 24, productionLines: 'yes' }));
  const s = seedAirlineState(world({ productionLines: true }), { airlineName: 'A', hub: 'JFK' });
  assert.equal(s.productionLinesWorld, true);
  assert.equal(s.productionLineScale, 1);
  const big = seedAirlineState({ ...world({ productionLines: true }), maxPlayers: 200 }, { airlineName: 'A', hub: 'JFK' });
  assert.equal(big.productionLineScale, 1.5);
  const old = seedAirlineState(world({}), { airlineName: 'A', hub: 'JFK' });
  assert.equal(old.productionLinesWorld, undefined, 'worlds without the key stay classic');
});

await t('createWorld stores productionLines ON by default, OFF only when unticked', async () => {
  const made = [];
  const prisma = { world: { create: async ({ data }) => { made.push(data); return data; } } };
  await createWorld(prisma, { lengthYears: 50, weeksPerDay: 24 });
  await createWorld(prisma, { lengthYears: 50, weeksPerDay: 24, productionLines: false });
  assert.equal(made[0].tickConfig.productionLines, true);
  assert.equal(made[0].tickConfig.productionLineScale, 1, 'scale fixed at creation (50 players)');
  const late = seedAirlineState({ ...world({ productionLines: true, productionLineScale: 0.6 }), maxPlayers: 300 }, { airlineName: 'B', hub: 'JFK' });
  assert.equal(late.productionLineScale, 0.6, 'a later player-cap edit does not change the line for new joiners');
  assert.equal('productionLines' in made[1].tickConfig, false);
});

await t("each airline's line view is everyone ELSE's bookings", () => {
  const views = buildRivalViews([
    row('me', { pending: [o787('m1', 40)] }),
    row('b', { pending: [o787('b1', 40), o787('b2', 41), { ...o787('u', 40), used: true }] }),
    row('dead', { status: 'BANKRUPT', pending: [o787('d1', 40)] }),
  ]);
  assert.deepEqual(views.get('me').lineBook.bookings, { b787: { 40: 1, 41: 1 } });
  assert.deepEqual(views.get('b').lineBook.bookings, { b787: { 40: 1 } });
  assert.equal(views.get('me').lineBook.scale, 1);
});

await t('classic worlds get no line view; it is injected for the engine and stripped before persistence', () => {
  const classic = buildRivalViews([row('me', { lines: false }), row('b', { lines: false, pending: [o787('b1', 40)] })]);
  assert.equal(classic.get('me').lineBook, null);
  assert.equal('lineBook' in rivalOverlay(classic.get('me')), false);
  const views = buildRivalViews([row('me'), row('b', { pending: [o787('b1', 40)] })]);
  const injected = withRivals(row('me').state, views.get('me'));
  assert.ok(injected.lineBook?.bookings?.b787);
  assert.equal('lineBook' in stripRivals(injected), false);
});

await t('competitors carry their fleet mix for the order board (every world)', () => {
  const views = buildRivalViews([
    row('me', { lines: false }),
    row('b', { lines: false, fleet: [{ id: 'x', typeId: 'a380', status: 'idle' }, { id: 'y', typeId: 'a380', status: 'retired' }], pending: [o787('b1', 40)] }),
  ]);
  const b = views.get('me').competitors[0];
  assert.deepEqual(b.fleetMix, { a380: [1, 0], b7879: [0, 1] });
});

await t('the guard keeps a sane slotFromWeek and strips anything that sets a slot', () => {
  const g = guardDecision('ORDER_AIRCRAFT', { typeId: 'b7879', quantity: 2, slotFromWeek: 120, deliverAbsWeek: 1, lineId: 'x', slotPremium: -9e9, launch: true, totalPrice: 1 }, {});
  assert.equal(g.slotFromWeek, 120);
  for (const k of ['deliverAbsWeek', 'lineId', 'slotPremium', 'launch', 'totalPrice']) assert.equal(k in g, false, k);
  assert.equal('slotFromWeek' in guardDecision('ORDER_AIRCRAFT', { typeId: 'b7879', slotFromWeek: 1.5 }, {}), false);
  assert.equal('slotFromWeek' in guardDecision('ORDER_AIRCRAFT', { typeId: 'b7879', slotFromWeek: -3 }, {}), false);
});

await t('the in-transaction re-check refuses a week a rival filled after our view was built', async () => {
  needSvc();
  const others = [];
  for (let i = 0; i < 5; i++) others.push(row(`r${i}`, { pending: [o787(`r${i}o`, 50)] }));
  const tx = { airline: { findMany: async ({ where }) => [row('me'), ...others].filter(r => r.status === where.status) } };
  const mine = [o787('n1', 50)];
  await assert.rejects(
    svc.assertLineSlotsTx(tx, { worldId: 'w', airlineId: 'me', pendingOrders: mine, newOrders: mine, absWeek: 10 }),
    svc.LineSlotConflict,
  );
  const ok = [o787('n2', 51)];
  await svc.assertLineSlotsTx(tx, { worldId: 'w', airlineId: 'me', pendingOrders: ok, newOrders: ok, absWeek: 10 });
});

await t('only orders this decision added are re-checked', () => {
  needSvc();
  const before = [o787('a', 40)];
  const after = [o787('a', 40), o787('b', 41), { id: 'c', typeId: 'a380', used: true, deliverAbsWeek: 3 }, { id: 'd', typeId: 'a380', deliverAbsWeek: 9 }];
  assert.deepEqual(svc.newLineOrdersOf(before, after).map(o => o.id), ['b']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
