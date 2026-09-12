// The Route Finder rebuilds on a CHANGE, not on a timer.
//
//   @silv4013  "the route planner and route finder tabs are so laggy its
//               almost unbearable"                                  (9/11/26)
//   ASAS       "it doesnt happen on tailwinds so maybe some problem is
//               happening due to it being in multi player"          (9/12/26)
//
// Headwinds polls a rival OVERLAY every few seconds and applies it with
// `{ ...cur, ...d.rivals }`, so `competitors`, `humanRivals` and `encroachments`
// are replaced by fresh objects whenever ANY player in the world moves. The
// finder's candidate memo listed all three, so it re-walked ~2,000 markets and
// re-priced up to 150 of them because a stranger nudged a fare on a lane the
// player will never fly. Tailwinds has no poll; that is the whole of ASAS's
// observation.
//
// What this pins is the distinguishing property, not a timing:
//
//   a rival RE-PRICING must leave the key alone   (the poll that used to churn)
//   a rival ENTERING or LEAVING a pair must move it (the change that matters)
//
// The first assertion is the regression guard. The second is what stops the
// "fix" from being a stale screen — a key that never changes would also pass
// the first one, and would quietly show the player a competitive map from an
// hour ago.
//
//   node tools/rival-topology-key-test.mjs

import assert from 'node:assert/strict';
import { rivalTopologyKey, rivalPairIndex } from '../packages/engine/src/models/routeFinder.js';

let pass = 0;
const ok = (l) => { pass++; console.log(`  ok  ${l}`); };

const spec = (id, o, d, fare) => ({ competitorId: id, origin: o, destination: d,
  frequency: 14, weeklyFrequency: 14, economyFare: fare, seats: 180, seatsPerWeek: 2520,
  qualityScore: 62 });
const comp = (id, hub, spokes, fare) => ({ id, human: true, name: id, homeHub: hub,
  routes: Object.fromEntries(spokes.map((s) => [[hub, s].sort().join('-'),
    { frequency: 14, economyFare: fare, seats: 180 }])) });

// One world, served twice — as two independent overlay payloads, exactly as the
// client receives them (fresh objects every poll, never mutated in place).
const world = (fare) => ({
  competitors: [comp('human:1', 'JFK', ['LHR', 'CDG'], fare), comp('human:2', 'LAX', ['SFO'], fare)],
  humanRivals: {
    'JFK-LHR': [spec('human:1', 'JFK', 'LHR', fare)],
    'CDG-JFK': [spec('human:1', 'JFK', 'CDG', fare)],
    'LAX-SFO': [spec('human:2', 'LAX', 'SFO', fare)],
  },
  encroachments: {},
  routes: [],
});

const pollA = world(499);
const pollB = world(429);          // same carriers, same pairs — just cheaper

// ── The old dependency, reproduced ──────────────────────────────────────────
// This is what the memo used to watch. Proving it churns here is what makes the
// new key's stability meaningful rather than tautological.
const oldDeps = (s) => [s.competitors, s.humanRivals, s.encroachments];
const churned = oldDeps(pollA).some((o, i) => o !== oldDeps(pollB)[i]);
assert.ok(churned,
  'the old memo dependencies must be shown to change identity on a re-price poll — '
  + 'otherwise this suite proves nothing');
ok('old dependency (raw rival objects) churns on a fare-only poll');

// ── 1. Re-pricing must not move the key ─────────────────────────────────────
assert.equal(rivalTopologyKey(pollA), rivalTopologyKey(pollB),
  'a rival re-pricing changed the finder\'s rival key — this is the poll-driven '
  + 'rebuild that made the tab unusable in a busy world');
ok('fare-only poll → key unchanged');

// Idempotent and cheap to call every render.
assert.equal(rivalTopologyKey(pollA), rivalTopologyKey(pollA), 'key must be stable per state');
ok('key is stable across repeat calls');

// ── 2. A real change must move it ───────────────────────────────────────────
const entered = world(499);
entered.humanRivals['ATL-JFK'] = [spec('human:2', 'ATL', 'JFK', 480)];
entered.competitors[1].routes['ATL-JFK'] = { frequency: 7, economyFare: 480, seats: 180 };
assert.notEqual(rivalTopologyKey(pollA), rivalTopologyKey(entered),
  'a rival OPENING a new pair must move the key, or the finder shows a stale map');
ok('rival enters a pair → key changes');

const left = world(499);
delete left.humanRivals['LAX-SFO'];
delete left.competitors[1].routes['LAX-SFO'];
assert.notEqual(rivalTopologyKey(pollA), rivalTopologyKey(left),
  'a rival LEAVING a pair must move the key');
ok('rival leaves a pair → key changes');

const joined = world(499);
joined.humanRivals['JFK-LHR'].push(spec('human:2', 'JFK', 'LHR', 505));
assert.notEqual(rivalTopologyKey(pollA), rivalTopologyKey(joined),
  'a SECOND carrier joining a contested pair must move the key — laneRivalCount changes');
ok('second rival joins an existing pair → key changes');

// ── 3. The key must agree with what the finder actually consumes ────────────
// rivalPairIndex is the only thing findCandidates reads the rival set through,
// so equal keys must mean an identical index, and that is what makes reusing the
// memoised rows correct rather than merely fast.
const sameKeyIndexes = [pollA, pollB].map((s) => rivalPairIndex(s));
const asPlain = (m) => [...m.entries()].map(([k, v]) => [k, [...v].sort()]).sort();
assert.deepEqual(asPlain(sameKeyIndexes[0]), asPlain(sameKeyIndexes[1]),
  'equal keys must mean an identical rival pair index');
ok('equal key ⇒ identical rivalPairIndex');

assert.notDeepEqual(asPlain(rivalPairIndex(pollA)), asPlain(rivalPairIndex(joined)),
  'a moved key must correspond to a genuinely different index');
ok('changed key ⇒ genuinely different index');

console.log(`\n${pass} checks passed`);
