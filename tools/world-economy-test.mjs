// World-shared economy walk + join-time backfill test — no database, no network.
//
// Proves: the seeded fuel/market walks are deterministic and bounded; and —
// the contract that makes late joining fair — worldEconomyAt(seed, W) produces
// EXACTLY the fuelPrice { index, history } and marketIndex that a founding
// member's blob carries after ticking through the real reducer with the same
// injected walk. Regression for the "no fuel history in a 2-month world" /
// hedge-at-1.0× late-joiner bug.
//
//   node tools/world-economy-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { FUEL_MIN_INDEX, FUEL_MAX_INDEX, FUEL_BASE_INDEX } from '../packages/engine/src/utils/fuel.js';
import { eraFuelMean, ERA_FUEL_MIN_INDEX } from '../packages/engine/src/data/era.js';
import { MARKET_BASE_INDEX } from '../packages/engine/src/utils/market.js';
import {
  seededRand, worldFuelIndex, worldMarketIndex, worldEconomyAt, FUEL_HISTORY_CAP,
} from '../apps/headwinds-server/src/lib/worldEconomy.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const SEED = 'test-world-seed-1';

console.log('world-economy-test');

await test('walks are deterministic and seed-sensitive', () => {
  assert.equal(worldFuelIndex(SEED, 20), worldFuelIndex(SEED, 20));
  assert.equal(worldMarketIndex(SEED, 20), worldMarketIndex(SEED, 20));
  assert.deepEqual(worldEconomyAt(SEED, 20), worldEconomyAt(SEED, 20));
  // A different seed must produce a different walk somewhere in 20 weeks.
  const a = Array.from({ length: 20 }, (_, i) => worldFuelIndex(SEED, i + 1));
  const b = Array.from({ length: 20 }, (_, i) => worldFuelIndex('other-seed', i + 1));
  assert.notDeepEqual(a, b);
  // seededRand is uniform-ish and stable
  assert.equal(seededRand(SEED, 'fuel:1'), seededRand(SEED, 'fuel:1'));
  assert.notEqual(seededRand(SEED, 'fuel:1'), seededRand(SEED, 'fuel:2'));
});

await test('walk stays within the fuel band and actually moves', () => {
  const { fuelPrice } = worldEconomyAt(SEED, 40);
  for (const v of fuelPrice.history) {
    assert.ok(v >= FUEL_MIN_INDEX && v <= FUEL_MAX_INDEX, `out of band: ${v}`);
  }
  // 39 weeks of OU shocks can't all print the same value — the chart is a line,
  // not a flatline (this is the symptom the bug showed: a single 1.000 point).
  assert.ok(new Set(fuelPrice.history).size > 1, 'walk never moved');
});

await test('week 1 (lobby / first joiner) is the untouched fresh-blob economy', () => {
  const eco = worldEconomyAt(SEED, 1);
  assert.deepEqual(eco.fuelPrice, { index: FUEL_BASE_INDEX, history: [] });
  assert.equal(eco.marketIndex, MARKET_BASE_INDEX);
});

await test('worldEconomyAt(seed, W) === walk at W-1, history = weeks 1..W-1', () => {
  for (const W of [2, 9, 30]) {
    const eco = worldEconomyAt(SEED, W);
    assert.equal(eco.fuelPrice.index, worldFuelIndex(SEED, W - 1));
    assert.equal(eco.marketIndex, worldMarketIndex(SEED, W - 1));
    assert.equal(eco.fuelPrice.history.length, W - 1);
    for (const k of [1, Math.floor(W / 2), W - 1]) {
      assert.equal(eco.fuelPrice.history[k - 1], worldFuelIndex(SEED, k), `week ${k} of W=${W}`);
    }
  }
});

await test('history honours the reducer 52-week cap', () => {
  const eco = worldEconomyAt(SEED, 60);
  assert.equal(eco.fuelPrice.history.length, FUEL_HISTORY_CAP);
  // capped from the FRONT: last entry is week 59, first is week 8
  assert.equal(eco.fuelPrice.history[FUEL_HISTORY_CAP - 1], worldFuelIndex(SEED, 59));
  assert.equal(eco.fuelPrice.history[0], worldFuelIndex(SEED, 8));
  assert.equal(eco.fuelPrice.index, worldFuelIndex(SEED, 59));
});

await test('backfill matches a founding member ticked through the REAL reducer', () => {
  // A blob that has lived in the world since week 1, ticked exactly the way
  // tickService does it: one injected world fuel + market value per week.
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Founder', hub: 'JFK', enableObjectives: false });
  s = { ...s, multiplayer: true };
  const W = 9; // the world from the bug report: Week 1 Mar Year 1
  for (let k = 1; k <= W - 1; k++) {
    s = gameReducer(s, {
      type: 'ADVANCE_WEEK',
      worldFuelIndex: worldFuelIndex(SEED, k),
      marketIndex: worldMarketIndex(SEED, k),
      worldEvents: [],
    });
  }
  const eco = worldEconomyAt(SEED, W);
  // The late joiner's seeded economy must be indistinguishable from the founder's.
  assert.deepEqual(s.fuelPrice, eco.fuelPrice);
  assert.equal(s.marketIndex, eco.marketIndex);
  // And the hedge exploit is closed: the joiner prices hedges off the world
  // index, not the fresh-blob 1.0 (guard against the walk landing exactly on
  // 1.0 by checking the history moved — see the flatline test above).
  assert.equal(eco.fuelPrice.index, s.fuelPrice.index);
});

await test('joinWorld actually seeds the blob from worldEconomyAt', () => {
  // Wiring check, same style as the tick test's allow-list assertion: the join
  // path must consume the shared walk before the airline row is created.
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/worldService.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("from './worldEconomy.mjs'"), 'worldService must import worldEconomy');
  const call = src.indexOf('worldEconomyAt(');
  const create = src.indexOf('prisma.airline.create');
  assert.ok(call !== -1, 'joinWorld must call worldEconomyAt');
  assert.ok(create === -1 || call < create, 'backfill must happen before the airline row is created');
});

await test('tickService and the backfill share ONE walk implementation', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("from './worldEconomy.mjs'"), 'tickService must import the shared walks');
  assert.ok(!/function worldFuelIndex/.test(src), 'no private copy of the fuel walk in tickService');
  assert.ok(!/function worldMarketIndex/.test(src), 'no private copy of the market walk in tickService');
});

await test('era worlds open on the period fuel price, not the 2026 base', () => {
  // HEAD failure: the walk started at 1.0 whatever the era, so a 1950 world
  // ran 1.00 → 0.70 (W5) → 0.54 (W10) against a 0.45 mean — founders paid
  // double the era's fuel through their most fragile two months and could
  // lock a week-1 hedge at 1.0x.
  for (const sy of [1950, 1978, 2000]) {
    const mean = eraFuelMean(sy);
    const open = worldEconomyAt(SEED, 1, { startYear: sy });
    assert.equal(open.fuelPrice.index, mean, `${sy}: week-1 index is the era mean`);
    assert.equal(open.fuelPrice.history.length, 0);
    // The first weeks wobble around the mean, they do not decay towards it.
    for (const w of [1, 5, 10]) {
      const idx = worldFuelIndex(`${SEED}-${sy}`, w, sy);
      assert.ok(Math.abs(idx - mean) < 0.25, `${sy} W${w}: ${idx} vs mean ${mean}`);
      assert.ok(idx >= ERA_FUEL_MIN_INDEX, 'era floor');
    }
    // Backfill and live walk agree on the seeded start.
    assert.equal(worldEconomyAt(SEED, 11, { startYear: sy }).fuelPrice.index, worldFuelIndex(SEED, 10, sy));
  }
  // Classic worlds are byte-identical: base seed, base index.
  assert.equal(worldEconomyAt(SEED, 1).fuelPrice.index, FUEL_BASE_INDEX);
  assert.equal(worldEconomyAt(SEED, 1, { startYear: null }).fuelPrice.index, FUEL_BASE_INDEX);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
