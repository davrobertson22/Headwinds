// Route Finder: the network-tick memo holds every lane a finder pass prices.
//
// Discord, 2026-10-21 (VodkaOnFire): "It takes 4-8 seconds at this point every
// time you load up the route finder and change the filter." 86% of each finder
// forecast is one network tick (the connecting feed, projectConnectingFeed),
// and that tick never sees the aircraft — so pricing the same lanes for a
// second aircraft should cost almost nothing. It cost the full price: the memo
// held 64 ticks per state and a profit sort prices 150 lanes, so it cleared
// itself twice a pass and the second aircraft re-ran every tick.
//
//   1. A second pass over the same 150 lanes on the same state, for another
//      airframe at the same frequency, runs ZERO network ticks; for another
//      type it runs one only where the frequency differs.
//   2. Warm answers equal cold ones (a fresh state object, so a cold memo), to
//      the dollar — the memo keeps a slice of the tick, and the slice must be
//      the tick.
//
// Verified failing on HEAD by a throwaway probe: HEAD's pairShare.js with a
// counter in memoNetworkTick's compute ran 142 of 150 ticks again on the second pass (1).
//
//   node --import ./tools/_register-loader.mjs tools/finder-network-memo-test.mjs
import assert from 'node:assert/strict';

const { buildWorld } = await import('./routes-gates-finder-perf-probe.mjs');
const F = await import('../packages/engine/src/models/routeFinder.js');
const { networkTickRunCount } = await import('../packages/engine/src/models/pairShare.js');
const { currentGameDate } = await import('../packages/engine/src/utils/simulation.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const st = buildWorld({ routes: 120 });
const gameDate = currentGameDate(st);
const rows = F.findCandidates(st, { origin: 'JFK', aircraftTypeId: 'a320neo' });
const idx = F.rowsToScore(rows, { limit: F.DEFAULT_SCORE_LIMIT }).filter(i => !rows[i].block);
const ctxFor = (typeId, aircraft = null) => F.finderForecastContext({ aircraftTypeId: typeId, aircraft, weeklyFrequency: 7, gameDate });
const price = (state, ctx) => {
  const before = networkTickRunCount();
  const out = idx.map(i => F.forecastCandidate(state, rows[i], ctx));
  return { out, runs: networkTickRunCount() - before };
};

console.log('\nRoute Finder network-tick memo');
const synthetic = ctxFor('a320neo');
const first = price(st, synthetic);

test(`first pass prices ${idx.length} lanes (>64, the old cap)`, () => {
  assert.ok(idx.length > 64, `only ${idx.length} lanes — the fixture no longer exercises the cap`);
  assert.ok(first.runs > 64, `first pass ran ${first.runs} ticks`);
});

test('same lanes, another airframe of the type: no network tick re-runs', () => {
  const owned = st.fleet.find(a => a.typeId === 'a320neo');
  const again = price(st, ctxFor('a320neo', { ...owned, ownershipType: 'leased', weeklyLease: 99999 }));
  assert.equal(again.runs, 0);
});

test('same lanes, another type: re-runs only lanes whose frequency differs', () => {
  const a = ctxFor('a320neo'), b = ctxFor('b7879');
  const differs = idx.filter(i => F.candidateFrequency(rows[i], a) !== F.candidateFrequency(rows[i], b)).length;
  const again = price(st, b);
  assert.ok(again.runs <= differs, `${again.runs} ticks for ${differs} lanes with a new frequency`);
});

test('warm answers equal cold ones on a fresh state object', () => {
  const warm = price(st, synthetic);
  assert.equal(warm.runs, 0);
  const cold = price({ ...st }, synthetic);
  assert.ok(cold.runs > 64, 'a new state object must not be answered from the old one');
  assert.deepEqual(warm.out, cold.out);
  assert.deepEqual(warm.out, first.out);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
