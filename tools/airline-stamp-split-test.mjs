// Split-stamp airline read — the Supabase egress fix.
//
// Background. GET /worlds/:id/airline gates its response on a change stamp the
// client echoes back. That stamp used to be a single value combining TWO
// unrelated facts:
//
//   self  — this airline's `version`, which moves when WE act or a tick lands
//   world — the sum of every active airline's `version`, which moves when
//           ANYBODY in the world acts
//
// Because one stamp gated the whole response, any rival adjusting a fare
// invalidated every other player's cache and forced each of them to re-download
// their entire multi-megabyte save blob — to pick up a few kilobytes of rival
// deltas they may not even have been looking at. The optimisation therefore
// worked on an idle or single-player world and switched itself off precisely
// when a world got busy, which is the only time it mattered.
//
// The fix splits the halves. `state` (megabytes) ships only when SELF moved;
// `rivals` (kilobytes) ships when WORLD moved. This file locks the comparison
// logic, the overlay/base split, and the merge invariant the client relies on.

import assert from 'node:assert/strict';
import { splitStamp, stampDelta } from '../apps/headwinds-server/src/lib/stamp.mjs';
import { withRivals, rivalOverlay, stripRivals } from '../apps/headwinds-server/src/lib/humanRivals.mjs';

let passed = 0;
const check = (name, fn) => {
  try { fn(); passed += 1; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

// ── 1. stamp parsing ────────────────────────────────────────────────────────
// Stamps look like `<selfVersion>:<worldSum>.<worldCount>`. The world half
// contains a dot but never a colon, so the split must be on the FIRST colon.
check('a well-formed stamp splits into self and world halves', () => {
  assert.deepEqual(splitStamp('7:412.5'), ['7', '412.5']);
});
check('the world half keeps its dot', () => {
  const [, world] = splitStamp('0:0.1');
  assert.equal(world, '0.1');
});
check('a missing stamp compares unequal to everything', () => {
  // Both halves null => both "changed" => full load. A first poll must never be
  // mistaken for an up-to-date one.
  assert.deepEqual(splitStamp(undefined), [null, null]);
  assert.deepEqual(splitStamp(null), [null, null]);
  assert.deepEqual(splitStamp(''), [null, null]);
});
check('a malformed stamp forces a full load rather than a silent stale read', () => {
  assert.deepEqual(splitStamp('garbage'), [null, null]);
  const [self, world] = splitStamp('garbage');
  assert.notEqual(self, String(3));
  assert.notEqual(world, '412.5');
});

// ── 2. the decision the handler makes ───────────────────────────────────────
// Uses the SAME stampDelta the handler uses, so the branch table below is a
// contract on real behaviour rather than a restatement of it.
const decide = (echoed, version, worldStamp) => {
  const { selfChanged, worldChanged } = stampDelta(echoed, version, worldStamp);
  if (!selfChanged && !worldChanged) return 'unchanged';
  if (!selfChanged && worldChanged) return 'rivals-only';
  return 'state+rivals';
};

check('nothing moved: no blob, no overlay', () => {
  assert.equal(decide('7:412.5', 7, '412.5'), 'unchanged');
});
check('a RIVAL moved: overlay only, blob untouched', () => {
  // The case that dominates between hourly ticks, and the entire point of the
  // change: this response must not contain a state blob.
  assert.equal(decide('7:412.5', 7, '413.5'), 'rivals-only');
});
check('WE moved: blob ships', () => {
  assert.equal(decide('7:412.5', 8, '413.5'), 'state+rivals');
});
check('first poll with no stamp ships everything', () => {
  assert.equal(decide(undefined, 7, '412.5'), 'state+rivals');
});
check('a player joining changes the count, so the overlay refreshes', () => {
  // world half is `<sum>.<count>` — a join moves the count even at equal sum.
  assert.equal(decide('7:412.5', 7, '412.6'), 'rivals-only');
});
check('the memoised-world-stamp window still ships the overlay with the blob', () => {
  // Bumping our own version also moves the world sum, but the world stamp is
  // memoised for a couple of seconds, so a poll landing inside that window can
  // see self-changed with world-unchanged. The handler must still send
  // `rivals`, because `state` is sent stripped — omitting the overlay would
  // blank the client's Rivals tab.
  assert.equal(decide('7:412.5', 8, '412.5'), 'state+rivals');
});

// ── 3. base + overlay must reconstruct the whole state ──────────────────────
const STATE = { cash: 1_000, fleet: [{ id: 'a' }], pendingOrders: [], routes: [{ o: 'LHR' }] };
const VIEW = {
  stockPool: { free: 10 }, gateMarket: { LHR: { taken: 3 } },
  competitors: [{ id: 'r1' }], humanRivals: { r1: { name: 'Rival' } },
  alliance: { membership: 'star', def: { id: 'star' } }, selfOG: true, selfDev: false,
};

check('base + overlay is byte-for-byte the old whole-blob response', () => {
  // The client merges `{...state, ...rivals}`. That merge must equal exactly
  // what the legacy single-payload path returned, or split and legacy clients
  // would see different games.
  assert.deepEqual({ ...withRivals(STATE, null), ...rivalOverlay(VIEW) }, withRivals(STATE, VIEW));
});
check('the split holds when there is no rival view at all', () => {
  assert.deepEqual({ ...withRivals(STATE, null), ...rivalOverlay(null) }, withRivals(STATE, null));
});
check('a legacy blob carrying a stale gateMarket keeps it when the view has none', () => {
  const legacy = { ...STATE, gateMarket: { stale: true } };
  assert.deepEqual({ ...withRivals(legacy, null), ...rivalOverlay({}) }, withRivals(legacy, {}));
});

// ── 4. the overlay is exactly the non-persisted half ────────────────────────
check('every overlay key is stripped before persistence', () => {
  // rivalOverlay and stripRivals must stay in lockstep: anything the overlay
  // ships is rebuilt per read, so it must never be written into the blob.
  // A key drifting out of stripRivals would reintroduce the O(P^2) blob growth
  // that stripRivals exists to prevent.
  const persisted = stripRivals(withRivals(STATE, VIEW));
  const leaked = Object.keys(rivalOverlay(VIEW)).filter((k) => k in persisted);
  assert.deepEqual(leaked, [], `overlay keys leaked into the persisted blob: ${leaked}`);
});
check('the overlay carries no gameplay state of our own', () => {
  // If a real save field ever slipped into the overlay, an overlay-only poll
  // would silently overwrite it with a server-derived value.
  const overlayKeys = new Set(Object.keys(rivalOverlay(VIEW)));
  for (const own of ['cash', 'fleet', 'routes', 'pendingOrders', 'starterDeliveriesUsed', 'multiplayer']) {
    assert.equal(overlayKeys.has(own), false, `${own} must not ride in the rival overlay`);
  }
});
check('the overlay stays small — it is what an idle poll now pays for', () => {
  const overlayBytes = JSON.stringify(rivalOverlay(VIEW)).length;
  const blobBytes = JSON.stringify(withRivals(STATE, VIEW)).length;
  assert.ok(overlayBytes < blobBytes, 'overlay should be a strict subset of the whole payload');
});

console.log(`\nairline-stamp-split-test: ${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
