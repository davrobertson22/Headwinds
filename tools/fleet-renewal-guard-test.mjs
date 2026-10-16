// Fleet renewal on the server: the two new actions are on the allow-list, the
// decision guard keeps their payloads to shape, ORDER_AIRCRAFT's `replaces`
// list is sanitized, and the tick lists renewal sales in the used market
// without ever saving the transient `renewalSales` key into a blob.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-renewal-guard-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nFleet renewal — server guard\n');

test('both actions are allowed', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_ORDER_REPLACEMENT'));
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('CLEAR_FLEET_REPLACEMENT'));
});

test('SET_ORDER_REPLACEMENT is whitelisted to order, tail and disposal', () => {
  assert.deepEqual(
    guardDecision('SET_ORDER_REPLACEMENT', { orderId: 'o1', aircraftId: 'a1', disposal: 'keep', cash: 9e9 }, {}),
    { orderId: 'o1', aircraftId: 'a1', disposal: 'keep' });
  assert.deepEqual(
    guardDecision('SET_ORDER_REPLACEMENT', { orderId: 'o1', aircraftId: null, disposal: 'bogus' }, {}),
    { orderId: 'o1', aircraftId: null, disposal: 'dispose' });
  assert.throws(() => guardDecision('SET_ORDER_REPLACEMENT', { orderId: 7, aircraftId: 'a1' }, {}), GuardError);
  assert.throws(() => guardDecision('SET_ORDER_REPLACEMENT', { orderId: 'o1', aircraftId: { $ne: 1 } }, {}), GuardError);
});

test('CLEAR_FLEET_REPLACEMENT carries only an aircraft id', () => {
  assert.deepEqual(guardDecision('CLEAR_FLEET_REPLACEMENT', { aircraftId: 'a1', extra: 1 }, {}), { aircraftId: 'a1' });
  assert.throws(() => guardDecision('CLEAR_FLEET_REPLACEMENT', {}, {}), GuardError);
});

test('ORDER_AIRCRAFT `replaces` is cleaned to short string ids; tags cannot be forged', () => {
  const p = guardDecision('ORDER_AIRCRAFT', {
    typeId: 'a321neo', quantity: 2, ownershipType: 'owned',
    replaces: ['a1', 5, '', 'x'.repeat(200), 'a2'], replaceDisposal: 'sell-for-a-billion',
    replacesAircraftId: 'a9', replacing: { aircraftId: 'a9' },
  }, {});
  assert.deepEqual(p.replaces, ['a1', 'a2']);
  assert.equal(p.replaceDisposal, 'dispose');
  assert.ok(!('replacesAircraftId' in p) && !('replacing' in p));
  const q = guardDecision('ORDER_AIRCRAFT', { typeId: 'a321neo', quantity: 1, ownershipType: 'owned', replaces: 'a1' }, {});
  assert.ok(!('replaces' in q), 'a non-array is dropped');
});

test('the tick lifts renewalSales off the blob and lists them after the commit', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  assert.match(src, /delete next\.renewalSales/, 'stripped before the airline row is written');
  assert.match(src, /listSoldAircraftTx\(tx,[^]*?sale\.nav/, 'listed at the NAV the sale was valued at');
  assert.match(src, /renewedIds\.has\(c\.airline\.id\)/, 'only for airlines whose write landed');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
