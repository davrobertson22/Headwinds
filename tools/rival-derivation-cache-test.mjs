// Rival derivations are computed ONCE per competitor set.
//
//   @silv4013  "the route planner and route finder tabs are so laggy its
//               almost unbearable"                                  (9/11/26)
//   LtFrosty   "performance started taking a hit after the feature that shows
//               the best plane for each route was added"            (9/12/26)
//   ASAS       "it doesnt happen on tailwinds so maybe some problem is
//               happening due to it being in multi player"          (9/12/26)
//
// ASAS is right, and this is why. The Route Planner's aircraft ranking and the
// Route Finder's forecast pass both price a lane once PER CANDIDATE through
// projectRouteAddition — 75 aircraft types, or 150 markets. Every one of those
// calls re-derives, from scratch, three things that depend only on the rival
// set and not on the candidate at all:
//
//   competitorMarketingSpend   the whole world's per-airport ad voice, walked
//                              once per airport of the probe route (via
//                              stateBrandReach → rivalAdDragAt), then thrown
//                              away except for one code. On a 40-player world
//                              that is 1,800 route keys split and summed, twice
//                              per candidate, 75 candidates deep.
//   buildCompetitorRouteIndex  every rival's route map, re-indexed per call.
//   competitorRoutesAt         a full scan of one rival's route map per airport
//                              per hub-contest pass.
//
// A CPU profile of one planner recompute on a 40-player world put those at 32%,
// 8% and 8% of total time. In solo that same work is small and rare; in
// Headwinds the rival set is every other player in the world, so it is neither.
//
// What this suite pins is not "it got faster" — a timing assertion is a flake
// waiting to happen. It is that the derivation HAPPENS ONCE: the same rival
// array handed in twice gets the same object back, and a different rival array
// gets a freshly derived one. That is the property the speed rests on, and it
// is the property that would regress silently.
//
//   node tools/rival-derivation-cache-test.mjs

import assert from 'node:assert/strict';
import { competitorMarketingSpend } from '../packages/engine/src/models/competitorAI.js';
import { buildCompetitorRouteIndex } from '../packages/engine/src/models/network.js';
import { rivalAdDragAt } from '../packages/engine/src/utils/simulation.js';

let pass = 0;
const ok = (label) => { pass++; console.log(`  ok  ${label}`); };

const mkComp = (id, hub, spokes, tier = 'legacy') => ({
  id, human: true, name: `Rival ${id}`, homeHub: hub, tier,
  routes: Object.fromEntries(spokes.map((s) => [[hub, s].sort().join('-'), { frequency: 14 }])),
  baseQualityScore: 62,
});

const comps = [
  mkComp('human:1', 'JFK', ['LHR', 'CDG', 'LAX', 'ORD'], 'premium'),
  mkComp('human:2', 'LHR', ['JFK', 'FRA', 'DUB'], 'budget'),
  mkComp('human:3', 'LAX', ['JFK', 'SFO', 'SEA', 'LAS'], 'legacy'),
];
// Structurally identical, distinct array AND distinct objects.
const clone = JSON.parse(JSON.stringify(comps));

// ── 1. competitorMarketingSpend ─────────────────────────────────────────────
const v1 = competitorMarketingSpend(comps);
const v2 = competitorMarketingSpend(comps);
assert.equal(v1, v2,
  'competitorMarketingSpend re-derived the whole world ad-voice map for the same '
  + 'competitor array — this is the 32% the planner spends on the same answer.');
ok('competitorMarketingSpend: same array → same object');

const v3 = competitorMarketingSpend(clone);
assert.notEqual(v1, v3, 'a DIFFERENT competitor array must be re-derived, not served from cache');
assert.deepEqual(v1, v3, 'the cached map must equal a freshly derived one, key for key');
ok('competitorMarketingSpend: new array → fresh, identical result');

// The voice map is read by the tick, by rivalAdDragAt and by Operations; a
// shared cached object that a caller could write through would poison all three.
assert.throws(() => { 'use strict'; v1.JFK = 999; },
  'the cached voice map must be frozen — it is now shared across every caller');
ok('competitorMarketingSpend: cached map is frozen against caller writes');

// Known-good content, so the cache can never quietly change the numbers.
// Rival 1 hubs there (premium, 300K); rivals 2 and 3 each fly in and keep a
// station presence at their own tier (budget 8K, legacy 18K).
assert.equal(v1.JFK, 300_000 + 8_000 + 18_000, 'JFK voice: premium hub + two rivals stationed');
assert.equal(v1.DUB, 8_000, 'DUB voice: one budget rival, station presence only');
ok('competitorMarketingSpend: values unchanged');

// ── 2. buildCompetitorRouteIndex ────────────────────────────────────────────
const i1 = buildCompetitorRouteIndex(comps);
const i2 = buildCompetitorRouteIndex(comps);
assert.equal(i1, i2, 'buildCompetitorRouteIndex re-indexed every rival for the same array');
ok('buildCompetitorRouteIndex: same array → same index');

const i3 = buildCompetitorRouteIndex(clone);
assert.notEqual(i1, i3, 'a different competitor array must be re-indexed');
assert.deepEqual([...i1.keys()].sort(), [...i3.keys()].sort(), 'the cached index must cover the same O&Ds');
assert.equal(i1.get('JFK-LHR')?.length, 2, 'JFK-LHR is flown by two rivals');
ok('buildCompetitorRouteIndex: new array → fresh, identical index');

// ── 3. rivalAdDragAt reads through the cache unchanged ──────────────────────
const st = { competitors: comps, targetedMarketing: { JFK: 50_000 } };
const dragA = rivalAdDragAt(st, 'JFK');
const dragB = rivalAdDragAt({ ...st, competitors: clone }, 'JFK');
assert.equal(dragA, dragB, 'ad drag must not depend on WHICH copy of the rival set it was handed');
assert.ok(dragA > 0, 'a premium rival hubbed at JFK must exert some ad drag there');
ok('rivalAdDragAt: identical through cached and fresh rival sets');

console.log(`\n${pass} checks passed`);
