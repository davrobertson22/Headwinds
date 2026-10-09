// Talent market, Headwinds side: the going rate is built from every OTHER
// airline's payroll in the world, injected with the rival view, never persisted,
// and the two new labor actions reach the engine through the guard.
//
//   node --import ./tools/_register-loader.mjs tools/talent-market-server-test.mjs
import assert from 'node:assert/strict';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';

const { buildRivalViews, withRivals, stripRivals, rivalOverlay } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const fleetOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, typeId: 'a320', status: 'idle' }));
const row = (id, { pipeline = true, n = 10, pilots = 1.0 } = {}) => ({
  id, name: id, hub: 'JFK', status: 'ACTIVE', restarts: 0,
  account: { isOG: false, isSupporter: false, email: `${id}@x.test` },
  state: {
    crewPipeline: pipeline, hub: 'JFK', routes: [], cargoRoutes: [], fleet: fleetOf(n),
    labor: { pilots: { payMultiplier: pilots, morale: 80 }, cabinCrew: { payMultiplier: 1.0, morale: 80 },
             groundStaff: { payMultiplier: 1.0, morale: 80 }, maintenanceTeam: { payMultiplier: 1.0, morale: 80 } },
    financialHistory: [], statsHistory: [],
  },
});

t('each airline sees the going rate from everyone ELSE', () => {
  const views = buildRivalViews([row('me', { n: 10, pilots: 2.0 }), row('big', { n: 300, pilots: 1.5 })]);
  const mine = views.get('me').laborMarket;
  const theirs = views.get('big').laborMarket;
  assert.ok(mine.pilots > 1.3, `a 300-tail rival at 1.5× sets my market (${mine.pilots})`);
  assert.ok(theirs.pilots < 1.1, `my 10 tails barely move theirs (${theirs.pilots})`);
  assert.equal(mine.cabinCrew, 1);
});

t('a world without the crew pipeline gets no laborMarket at all', () => {
  const views = buildRivalViews([row('me', { pipeline: false }), row('b', { pipeline: false, pilots: 2.0 })]);
  assert.equal(views.get('me').laborMarket, null);
  assert.equal('laborMarket' in rivalOverlay(views.get('me')), false);
});

t('laborMarket is injected for the engine and stripped before persistence', () => {
  const views = buildRivalViews([row('me'), row('b', { n: 200, pilots: 1.6 })]);
  const injected = withRivals(row('me').state, views.get('me'));
  assert.ok(injected.laborMarket?.pilots > 1);
  assert.equal('laborMarket' in stripRivals(injected), false);
});

t('the new labor actions are allowed and guarded', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_PAY_INDEXED'));
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('CANCEL_RECRUITING'));
  assert.deepEqual(guardDecision('SET_PAY_INDEXED', { group: 'pilots', indexed: true }, {}), { group: 'pilots', indexed: true });
  assert.equal(guardDecision('SET_PAY_INDEXED', { group: 'pilots', indexed: 'yes' }, {}).indexed, false);
  assert.deepEqual(guardDecision('CANCEL_RECRUITING', { group: 'cabinCrew', refund: 9e9 }, {}), { group: 'cabinCrew' });
  assert.throws(() => guardDecision('SET_PAY_INDEXED', { group: 'wizards', indexed: true }, {}), GuardError);
  assert.throws(() => guardDecision('CANCEL_RECRUITING', { group: 'wizards' }, {}), GuardError);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
