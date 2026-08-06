// The world you come back to.
//
// C3. The weekly debrief is built entirely from `state.lastReport`, which the
//     tick overwrites wholesale — week N-1's report is gone the moment week N
//     lands. The multiplayer client adopts ONE blob per poll, so returning after
//     twelve weeks shows you the twelfth and silently discards the other eleven.
//     Since the most common way to play is to leave and come back, the player's
//     own account of what happened was "my cash is different now".
//
// B12. An alliance was a list of names and a benefits sentence. Every member's
//     full route map has been arriving on the client inside `state.competitors`
//     since human rivals shipped — nobody was adding it up. You could not see
//     the bloc's combined network, which airports it reached that you did not,
//     or where two members were flying the same pair against each other.
//
// Also: the Alliances tab quoted interline revenue from the legacy flat
// per-adjacent-route model. The tick stopped using that when partnership
// revenue moved to O&D proration, so the KPI and the P&L have disagreed on the
// same screen ever since.
//
//   node tools/away-alliance-test.mjs

import assert from 'node:assert/strict';

// A localStorage stand-in — the away digest remembers where you were, and the
// suite must be able to drive that.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
globalThis.localStorage = globalThis.window.localStorage;

const {
  AWAY_MIN_WEEKS, AWAY_MAX_WEEKS, absWeekOf, seenKeyFor, loadLastSeen,
  saveLastSeen, weeksAway, buildAwayDigest,
  subscribeAwayDigest, setPendingAwayWeeks, pendingAwayWeeks, resetAwayDigest,
} = await import('../src/utils/awayDigest.js');
const {
  pairKey, servedAirportsOf, servedPairsOf, memberProfile,
  buildAllianceStats, partnershipActuals,
} = await import('../src/utils/allianceStats.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const week = (i, over = {}) => ({
  label: `W${i}`, week: ((i - 1) % 52) + 1, year: Math.floor((i - 1) / 52) + 1,
  revenue: 1_000_000, cargoRevenue: 0, totalCost: 900_000, profit: 100_000,
  passengers: 5_000, fuel: 200_000, labor: 300_000, leases: 150_000,
  cash: 10_000_000, ...over,
});

const stat = (absWeek, over = {}) => ({
  label: `W${absWeek}`, absWeek,
  week: ((absWeek - 1) % 52) + 1, year: Math.floor((absWeek - 1) / 52) + 1,
  fleet: 5, routes: 8, destinations: 6, sharePrice: 10, svps: 12,
  loadFactor: 0.8, ...over,
});

/** An airline 30 weeks in, with matching history in both buffers. */
const saveAt = (absWeek, over = {}) => ({
  phase: 'playing',
  week: ((absWeek - 1) % 52) + 1,
  year: Math.floor((absWeek - 1) / 52) + 1,
  cash: 12_000_000,
  financialHistory: Array.from({ length: absWeek }, (_, i) => week(i + 1)),
  statsHistory: Array.from({ length: absWeek }, (_, i) => stat(i + 1)),
  ...over,
});

// ── C3: knowing how long you were gone ──────────────────────────────────────

console.log('\n── Away detection ───────────────────────────────────────');

test('the linear week index survives a New Year', () => {
  // week 52 → week 1 reads as going BACKWARDS on the raw field. The multiplayer
  // poll guard exists for this exact reason; the digest must not reintroduce it.
  assert.equal(absWeekOf({ year: 1, week: 52 }), 52);
  assert.equal(absWeekOf({ year: 2, week: 1 }), 53);
  assert.ok(absWeekOf({ year: 2, week: 1 }) > absWeekOf({ year: 1, week: 52 }));
  assert.equal(absWeekOf(null), 0);
});

test('a first sighting is not an absence', () => {
  store.clear();
  assert.equal(loadLastSeen('a1'), null);
  assert.equal(weeksAway(saveAt(30), null), 0);
});

test('the gap is measured, and one week is not a gap', () => {
  assert.equal(weeksAway(saveAt(30), 18), 12);
  assert.equal(weeksAway(saveAt(30), 29), 1);
  assert.ok(weeksAway(saveAt(30), 29) < AWAY_MIN_WEEKS);
  assert.equal(weeksAway(saveAt(30), 30), 0);
});

test('a clock that ran backwards is not a negative absence', () => {
  assert.equal(weeksAway(saveAt(30), 40), 0);
});

test('a very long absence is capped, not unbounded', () => {
  assert.equal(weeksAway(saveAt(400), 1), AWAY_MAX_WEEKS);
});

test('last-seen round-trips, per save', () => {
  store.clear();
  saveLastSeen('a1', 30);
  saveLastSeen('a2', 7);
  assert.equal(loadLastSeen('a1'), 30);
  assert.equal(loadLastSeen('a2'), 7);
  assert.notEqual(seenKeyFor('a1'), seenKeyFor('a2'));
  // Two worlds on one device must not overwrite each other's place.
  assert.equal(loadLastSeen('a3'), null);
});

test('a corrupt stored value is ignored, not crashed on', () => {
  store.clear();
  store.set(seenKeyFor('a1'), 'yesterday');
  assert.equal(loadLastSeen('a1'), null);
});

// ── C3: the digest itself ───────────────────────────────────────────────────

console.log('\n── The digest ───────────────────────────────────────────');

test('a one-week gap produces no digest at all', () => {
  assert.equal(buildAwayDigest(saveAt(30), 1), null);
  assert.equal(buildAwayDigest(saveAt(30), 0), null);
});

test('the span aggregates the weeks that were missed, and only those', () => {
  const d = buildAwayDigest(saveAt(30), 12);
  assert.equal(d.weeks, 12);
  assert.equal(d.cashDelta, 12 * 100_000);
  assert.equal(d.revenue, 12 * 1_000_000);
  assert.equal(d.cost, 12 * 900_000);
  assert.equal(d.passengers, 12 * 5_000);
  assert.equal(d.series.length, 12);
  assert.equal(d.fromLabel, 'W19');
  assert.equal(d.toLabel, 'W30');
});

test('a losing span reads as one', () => {
  const s = saveAt(30);
  s.financialHistory = s.financialHistory.map((h, i) =>
    i >= 24 ? { ...h, profit: -400_000 } : h);
  const d = buildAwayDigest(s, 6);
  assert.ok(d.cashDelta < 0, `expected a loss, got ${d.cashDelta}`);
  assert.equal(d.losingWeeks, 6);
  assert.equal(d.profitableWeeks, 0);
});

test('the best and worst weeks are named', () => {
  const s = saveAt(30);
  s.financialHistory[25] = week(26, { profit: -2_000_000, label: 'DISASTER' });
  s.financialHistory[28] = week(29, { profit: 3_000_000, label: 'BUMPER' });
  const d = buildAwayDigest(s, 10);
  assert.equal(d.worst.label, 'DISASTER');
  assert.equal(d.best.label, 'BUMPER');
});

test('the cost line that dominated the span is identified', () => {
  const s = saveAt(30);
  s.financialHistory = s.financialHistory.map(h => ({ ...h, fuel: 5_000_000 }));
  const d = buildAwayDigest(s, 8);
  assert.equal(d.biggestCost.label, 'Fuel');
  assert.equal(d.biggestCost.amount, 8 * 5_000_000);
});

test('network and market movement come from the stats series', () => {
  const s = saveAt(30);
  s.statsHistory = s.statsHistory.map((x, i) =>
    i >= 18 ? { ...x, fleet: 9, routes: 15, destinations: 11, sharePrice: 14, svps: 20 } : x);
  const d = buildAwayDigest(s, 12);
  assert.equal(d.fleetChange, 4);
  assert.equal(d.routeChange, 7);
  assert.equal(d.destinationChange, 5);
  assert.equal(d.sharePriceFrom, 10);
  assert.equal(d.sharePriceNow, 14);
});

test('a save with no stats series reports dashes, not confident zeros', () => {
  // Old saves and freshly-restarted airlines genuinely cannot answer this. A
  // zero would read as "you built nothing", which is a different claim.
  const d = buildAwayDigest(saveAt(30, { statsHistory: [] }), 12);
  assert.equal(d.fleetChange, null);
  assert.equal(d.routeChange, null);
  assert.equal(d.sharePriceNow, null);
  assert.equal(d.avgLoadFactor, null);
  // …while the financial half still works.
  assert.equal(d.cashDelta, 12 * 100_000);
});

test('a span longer than the stored history uses what there is', () => {
  const s = saveAt(6);
  const d = buildAwayDigest(s, 20);
  assert.equal(d.series.length, 6);
  assert.equal(d.cashDelta, 6 * 100_000);
});

test('junk in the history never produces NaN on screen', () => {
  const s = saveAt(30);
  s.financialHistory[27] = { label: 'BAD', profit: 'lots', revenue: null, totalCost: undefined };
  const d = buildAwayDigest(s, 6);
  for (const k of ['cashDelta', 'revenue', 'cost', 'passengers']) {
    assert.ok(Number.isFinite(d[k]), `${k} came out ${d[k]}`);
  }
});

test('an empty save produces nothing rather than an empty modal', () => {
  assert.equal(buildAwayDigest({ financialHistory: [] }, 12), null);
  assert.equal(buildAwayDigest({}, 12), null);
  assert.equal(buildAwayDigest(null, 12), null);
});

// ── C3: exactly one modal ───────────────────────────────────────────────────

console.log('\n── One modal at a time ──────────────────────────────────');

test('the debrief is told to stand aside, and told when to come back', () => {
  // Both are position:fixed and full-screen. Two at once is the failure mode
  // this store exists to prevent.
  resetAwayDigest();
  const seen = [];
  const unsub = subscribeAwayDigest(w => seen.push(w));
  assert.equal(pendingAwayWeeks(), 0);
  setPendingAwayWeeks(12);
  assert.equal(pendingAwayWeeks(), 12);
  setPendingAwayWeeks(12);          // no-op — must not re-notify
  setPendingAwayWeeks(0);
  unsub();
  setPendingAwayWeeks(5);           // after unsubscribe — must not reach us
  assert.deepEqual(seen, [12, 0]);
  resetAwayDigest();
});

// ── B12: the bloc ───────────────────────────────────────────────────────────

console.log('\n── Alliance dashboard ───────────────────────────────────');

const rival = (id, name, hub, pairs, over = {}) => ({
  id, name, homeHub: hub, human: true, tier: 'legacy',
  marketCap: 50_000_000, cash: 20_000_000, baseQualityScore: 68,
  weeklyStats: { weeklyRevenue: 4_000_000, weeklyProfit: 500_000 },
  profitHistory: [400_000, 500_000],
  routes: Object.fromEntries(pairs.map(p => [p, { frequency: 7 }])),
  cargoRoutes: {},
  ...over,
});

const you = {
  routes: [
    { origin: 'JFK', destination: 'LAX' },
    { origin: 'JFK', destination: 'ORD' },
  ],
  cargoRoutes: [],
  marketCap: 30_000_000, cash: 10_000_000, weeklyRevenue: 3_000_000,
};

test('a pair key is order-independent, matching the engine', () => {
  assert.equal(pairKey('LAX', 'JFK'), pairKey('JFK', 'LAX'));
  assert.equal(pairKey('JFK', 'LAX'), 'JFK-LAX');
});

test('served sets cover multi-stop rotations, not just the endpoints', () => {
  const set = servedAirportsOf([{ origin: 'JFK', destination: 'SFO', stops: ['JFK', 'ORD', 'SFO'] }]);
  assert.ok(set.has('ORD'), 'a stop is a station you serve');
  assert.equal(set.size, 3);
  assert.equal(servedPairsOf([{ origin: 'A', destination: 'B' }]).size, 1);
});

test('a member profile folds passenger and freight into one network', () => {
  const p = memberProfile(rival('r1', 'Rival', 'LHR', ['LHR-CDG'], {
    cargoRoutes: { 'FRA-HKG': { frequency: 3 } },
  }));
  assert.equal(p.pairs.size, 2);
  assert.equal(p.airports.size, 4);
  assert.equal(p.departures, 10);
  assert.equal(p.profitTrend, 100_000);
});

test('the bloc is the union of every member network, you included', () => {
  const s = buildAllianceStats([
    rival('r1', 'Alpha', 'LHR', ['LHR-CDG', 'LHR-FRA']),
    rival('r2', 'Beta',  'NRT', ['NRT-SIN']),
  ], you);
  assert.equal(s.memberCount, 3);
  assert.equal(s.blocPairs, 5);                      // 2 yours + 3 theirs
  assert.equal(s.blocAirports, 8);                   // JFK LAX ORD LHR CDG FRA NRT SIN
  assert.equal(s.blocMarketCap, 30_000_000 + 100_000_000);
  assert.equal(s.blocWeeklyRevenue, 3_000_000 + 8_000_000);
  assert.equal(s.blocDepartures, 21);
});

test('the reach a partner adds is the point of the alliance', () => {
  const s = buildAllianceStats([rival('r1', 'Alpha', 'LHR', ['LHR-CDG'])], you);
  const codes = s.reachAdded.map(r => r.code).sort();
  assert.deepEqual(codes, ['CDG', 'LHR']);
  assert.deepEqual(s.reachAdded[0].names, ['Alpha']);
  // …and an airport you already serve is not "added".
  assert.ok(!codes.includes('JFK'));
});

test('a bloc of lookalikes adds nothing, and says so', () => {
  const s = buildAllianceStats([rival('r1', 'Clone', 'JFK', ['JFK-LAX'])], you);
  assert.equal(s.reachAdded.length, 0);
  assert.equal(s.overlap.length, 1, 'and it is competing with you instead');
});

test('members flying your pairs are surfaced as overlap', () => {
  const s = buildAllianceStats([
    rival('r1', 'Alpha', 'LHR', ['JFK-LAX', 'LHR-CDG']),
    rival('r2', 'Beta',  'ORD', ['JFK-LAX']),
  ], you);
  assert.equal(s.overlap.length, 1);
  assert.equal(s.overlap[0].pair, 'JFK-LAX');
  assert.deepEqual(s.overlap[0].names.sort(), ['Alpha', 'Beta']);
  assert.deepEqual(s.boostedPairs, ['JFK-LAX']);
});

test('members are ordered by size so the bloc has a shape', () => {
  const s = buildAllianceStats([
    rival('r1', 'Small', 'LHR', ['LHR-CDG'], { marketCap: 10_000_000 }),
    rival('r2', 'Big',   'NRT', ['NRT-SIN'], { marketCap: 90_000_000 }),
  ], you);
  assert.deepEqual(s.members.map(m => m.name), ['Big', 'Small']);
});

test('an alliance of one is your own network, not a crash', () => {
  const s = buildAllianceStats([], you);
  assert.equal(s.memberCount, 1);
  assert.equal(s.blocPairs, 2);
  assert.equal(s.reachAdded.length, 0);
  assert.equal(s.overlap.length, 0);
  const empty = buildAllianceStats(undefined, {});
  assert.equal(empty.memberCount, 1);
  assert.equal(empty.blocPairs, 0);
});

test('a malformed member is dropped, not counted and not fatal', () => {
  // Null entries come from a rival that left the world mid-poll. They must not
  // inflate the roster — a bloc that claims four carriers and lists one is
  // worse than one that quietly lists what it has.
  const s = buildAllianceStats([null, undefined, {}], you);
  assert.equal(s.memberCount, 2, 'nulls should be dropped; the empty object is a member');
  assert.ok(Number.isFinite(s.blocMarketCap));
  assert.equal(s.members[0].name, 'Unknown');
});

// ── The KPI that disagreed with the P&L ─────────────────────────────────────

console.log('\n── Partnership revenue ──────────────────────────────────');

test('the screen quotes the engine\'s figure once a week has been played', () => {
  // THE defect: the flat per-adjacent-route estimate is not what the tick books.
  const state = { lastReport: { totalPartnerRevenue: 812_345, totalPartnerFees: 95_000 } };
  const p = partnershipActuals(state, 4_000_000, 60_000);
  assert.equal(p.revenue, 812_345, 'the estimate was used over the booked figure');
  assert.equal(p.fees, 95_000);
  assert.equal(p.net, 717_345);
  assert.equal(p.estimated, false);
});

test('before the first week the estimate is used, and flagged as one', () => {
  const p = partnershipActuals({ lastReport: null }, 4_000_000, 60_000);
  assert.equal(p.revenue, 4_000_000);
  assert.equal(p.net, 3_940_000);
  assert.equal(p.estimated, true, 'an estimate presented as fact is the bug');
});

test('a report without the field falls back rather than showing zero', () => {
  const p = partnershipActuals({ lastReport: { totalRevenue: 5 } }, 1_000, 100);
  assert.equal(p.revenue, 1_000);
  assert.equal(p.estimated, true);
});

test('a booked zero is a real zero, not a missing value', () => {
  const p = partnershipActuals({ lastReport: { totalPartnerRevenue: 0, totalPartnerFees: 60_000 } }, 4_000_000, 60_000);
  assert.equal(p.revenue, 0);
  assert.equal(p.net, -60_000);
  assert.equal(p.estimated, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
