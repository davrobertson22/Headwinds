// Season awards — the end-of-world honours roll.
//   node tools/season-awards-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeSeasonAwards } from '../apps/headwinds-server/src/lib/seasonAwards.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

// A small world: 3 public finishers + 1 private (unranked). Alpha wins SVPS but
// Bravo held #1 longest and carried the most pax; Charlie has the biggest
// network and is the only re-founder.
const ranked = [
  { airlineId: 'a', name: 'Alpha Air', svpsScore: 500_000, isPublic: true },   // $50.00
  { airlineId: 'b', name: 'Bravo Jet',  svpsScore: 300_000, isPublic: true },   // $30.00
  { airlineId: 'c', name: 'Charlie Sky', svpsScore: 100_000, isPublic: true },  // $10.00
];
const computed = [
  { airline: { id: 'a', name: 'Alpha Air', accountId: 'acctA', restarts: 0 }, next: { routes: [1, 2], fleet: [1, 2] } },
  { airline: { id: 'b', name: 'Bravo Jet', accountId: 'acctB', restarts: 0 }, next: { routes: [1, 2, 3], fleet: [1] } },
  { airline: { id: 'c', name: 'Charlie Sky', accountId: 'acctC', restarts: 2 }, next: { routes: [1, 2, 3, 4, 5], fleet: [1, 2, 3] } },
  { airline: { id: 'p', name: 'Private Co', accountId: 'acctP', restarts: 0 }, next: { routes: [1], fleet: [1] } },
];
const passengersById = new Map([['a', 1000], ['b', 9000], ['c', 500]]);
const tenureById = new Map([['a', 5], ['b', 40], ['c', 1]]);

const awards = computeSeasonAwards({ ranked, computed, passengersById, tenureById, lengthYears: 3 });
const byKind = Object.fromEntries((awards?.awards ?? []).map((x) => [x.id, x]));

console.log('\nSeason awards\n');

test('champion + podium follow the final SVPS order', () => {
  assert.equal(awards.championId, 'a');
  assert.equal(awards.championName, 'Alpha Air');
  assert.deepEqual(awards.podium.map((p) => p.airlineId), ['a', 'b', 'c']);
  assert.equal(awards.podium[0].svps, 50);           // score / 10_000
  assert.equal(awards.podium[0].accountId, 'acctA'); // profile link target
  assert.equal(awards.finishers, 3);
});

test('Iron Throne goes to the longest #1 tenure, not the champion', () => {
  assert.equal(byKind.iron_throne.airlineId, 'b');
  assert.match(byKind.iron_throne.detail, /40 weeks/);
});

test('Busiest Airline is most passengers all-time', () => {
  assert.equal(byKind.busiest.airlineId, 'b');
  assert.match(byKind.busiest.detail, /9,000 passengers/);
});

test('Biggest Network is most routes', () => {
  assert.equal(byKind.biggest_network.airlineId, 'c');
  assert.match(byKind.biggest_network.detail, /5 routes, 3 aircraft/);
});

test('Best Comeback is the highest-finishing re-founder', () => {
  assert.equal(byKind.best_comeback.airlineId, 'c');
  assert.match(byKind.best_comeback.detail, /#3 of 3/);
});

test('no comeback award when nobody re-founded', () => {
  const noRestart = computed.map((c) => ({ ...c, airline: { ...c.airline, restarts: 0 } }));
  const a2 = computeSeasonAwards({ ranked, computed: noRestart, passengersById, tenureById });
  assert.equal(a2.awards.find((x) => x.id === 'best_comeback'), undefined);
});

test('an award with a zero metric is not handed out', () => {
  const a3 = computeSeasonAwards({
    ranked, computed,
    passengersById: new Map(), // nobody carried anyone
    tenureById: new Map(),     // nobody held #1 (data lost)
  });
  assert.equal(a3.awards.find((x) => x.id === 'busiest'), undefined);
  assert.equal(a3.awards.find((x) => x.id === 'iron_throne'), undefined);
  // network is still real, so that award survives
  assert.ok(a3.awards.find((x) => x.id === 'biggest_network'));
});

test('an empty world yields no ceremony', () => {
  assert.equal(computeSeasonAwards({ ranked: [], computed }), null);
});

test('private (unranked) airlines never appear', () => {
  const withPrivate = [...ranked, { airlineId: 'p', name: 'Private Co', svpsScore: 999_999, isPublic: false }];
  const a4 = computeSeasonAwards({ ranked: withPrivate, computed, passengersById, tenureById });
  assert.equal(a4.championId, 'a', 'a private airline must not steal the crown');
  assert.equal(a4.podium.find((p) => p.airlineId === 'p'), undefined);
});

console.log('\n── The tick writes the ceremony, at the right cadence ──');

test('the tick writes a tier-1 world_ended news row under category world', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  assert.ok(/kind: 'world_ended'/.test(src), 'no world_ended row written');
  assert.ok(/computeSeasonAwards\(/.test(src), 'awards never computed at tick end');
  // Both ceremony rows must be category 'world' or buildNews never reads them.
  assert.ok(!/kind: 'world_ended',[\s\S]{0,120}category: '(?!world)/.test(src));
});

test('year-in-review fires on a new game year, never on the final tick', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  assert.ok(/kind: 'year_in_review'/.test(src), 'no year_in_review row written');
  assert.ok(/newWeek === 1 && toIndex > 1 && !ended/.test(src),
    'year-in-review must guard on a new year AND not the final tick');
});

test('both ceremony kinds are tier-1 headlines in baseTier', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/newsService.mjs', import.meta.url), 'utf8');
  assert.ok(/case 'world_ended': case 'year_in_review':/.test(src));
});

test('the world detail serves seasonAwards; the list stamps a champion', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/routes/worlds.mjs', import.meta.url), 'utf8');
  assert.ok(/seasonAwards/.test(src), 'world detail no longer serves the honours roll');
  assert.ok(/champion: championByWorld/.test(src), 'concluded-worlds list no longer stamps a champion');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
