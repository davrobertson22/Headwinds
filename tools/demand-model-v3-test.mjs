// Demand model v3 — the DEFAULT for new worlds, never retro-applied.
//
// Same engine change and data as Tailwinds (utils/market.js "Demand model v3";
// fitted in the Tailwinds repo, tools/demand-audit/v3/), so the two engines
// must price v3 identically. What has to hold here:
//   1. createWorld with no field → tickConfig.demandModel 3; 2 → a v2 world; 1 → classic
//   2. the create-world form sends 3 explicitly
//   3. the flag (2 or 3) is baked into every airline at join and re-stamped by the tick
//   4. a v2 world prices exactly as before v3; a classic one as before v2
//   5. the generated tables and seasons are Tailwinds' to the byte
//
//   node tools/run-tests.mjs demand-model-v3
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, seedAirlineState } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { serializeWorld, validateWorldConfig } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { baseCityPairDemand, setDemandModel, getDemandModel, DEMAND_MODEL_CLASSIC, DEMAND_MODEL_LATEST } from '../packages/engine/src/utils/market.js';
import { getSeasonalProfile } from '../packages/engine/src/models/demand.js';
import { gameReducer } from '../packages/engine/src/reducer.mjs';
import { AIRPORTS } from '../packages/engine/src/data/airports.js';
import { computeAirportMarkets } from '../packages/engine/src/utils/airportMarket.js';
import { AIRPORT_MARKETS as TABLE_V3, GROWTH_BUCKETS as BUCKETS_V3 } from '../packages/engine/src/data/airportMarketsV3.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const quiet = (fn) => { const p = Math.random; Math.random = () => 0.9999999; try { return fn(); } finally { Math.random = p; } };
const d = (pair) => baseCityPairDemand(...pair.split('-'));
const BASE = { name: 'T', lengthYears: 50, weeksPerDay: 24, maxPlayers: 20 };
const tcOf = async (opts) => { const calls = []; await createWorld({ world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } }, opts); return calls[0].tickConfig; };
const world = (tickConfig) => ({ id: 'w', worldSeed: 's', currentYear: 1, currentWeek: 1, lengthYears: 40, maxPlayers: 20,
  tickConfig: { startingCapital: 15_000_000, demandMultiplier: 1, ...tickConfig } });

// The Tailwinds engine's figures (tools/demand-model-v3-test.mjs there).
const V2 = { 'JFK-LHR': 26200, 'LHR-CDG': 36766, 'LHR-PMI': 5816, 'DEL-BOM': 69006, 'BOI-YVR': 633 };
const V3 = { 'JFK-LAX': 27861, 'JFK-LHR': 18351, 'SYD-MEL': 46596, 'LHR-CDG': 19810, 'MIA-MCO': 3324, 'BOI-YVR': 824,
  'MCO-LHR': 7138, 'DEL-BOM': 56579, 'LHR-PMI': 13083, 'HND-CTS': 88380, 'GRU-GIG': 46819, 'JFK-ORF': 4248, 'MAD-BCN': 15103, 'SYD-AKL': 10493 };

console.log('\nDemand model v3 — new worlds only\n');

await test('a new world defaults to v3; 2 makes a v2 world; 1 a classic one (no key)', async () => {
  assert.equal(DEMAND_MODEL_LATEST, 3);
  assert.equal((await tcOf({ ...BASE })).demandModel, 3);
  assert.equal((await tcOf({ ...BASE, demandModel: 2 })).demandModel, 2);
  assert.equal((await tcOf({ ...BASE, demandModel: 1 })).demandModel, undefined);
  assert.throws(() => validateWorldConfig({ ...BASE, demandModel: 4 }), /demandModel/);
});
await test('the world JSON says which model a world runs', () => {
  for (const v of [2, 3]) assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: { demandModel: v } }, { playerCount: 0 }).demandModel, v);
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: {} }, { playerCount: 0 }).demandModel, 1);
});
await test('the create-world form sends 3 (or 1) explicitly', () => {
  assert.ok(/demandModel: demandV2 \? 3 : 1,/.test(read('../apps/headwinds-web/src/App.jsx')));
});
await test('joining bakes the world\'s model — 3, 2, or nothing — and the reducer prices on it', () => {
  for (const v of [2, 3]) {
    const s = seedAirlineState(world({ demandModel: v }), { airlineName: 'A', hub: 'JFK' });
    assert.equal(s.demandModel, v);
    setDemandModel(DEMAND_MODEL_CLASSIC);
    quiet(() => gameReducer(s, { type: 'NOOP_FOR_TEST' }));
    assert.equal(getDemandModel(), v);
  }
  assert.equal(seedAirlineState(world({}), { airlineName: 'B', hub: 'JFK' }).demandModel, undefined);
});
await test('the tick re-stamps whichever model the world runs', () => {
  assert.ok(/isDemandModel\(world\.tickConfig\?\.demandModel\) \? \{ demandModel: world\.tickConfig\.demandModel \}/.test(read('../apps/headwinds-server/src/lib/tickService.mjs')));
});
await test('v3 prices match the Tailwinds engine to the passenger; v2 is untouched', () => {
  setDemandModel(3);
  for (const [p, v] of Object.entries(V3)) assert.equal(d(p), v, p);
  setDemandModel(2);
  for (const [p, v] of Object.entries(V2)) assert.equal(d(p), v, p);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});
await test('v3 seasons: Frankfurt–Heraklion is summer-only; the blend memo is per model', () => {
  setDemandModel(3); const s3 = getSeasonalProfile('FRA', 'HER');
  setDemandModel(2); const s2 = getSeasonalProfile('FRA', 'HER');
  assert.ok(s3[1] < 0.25 && s3[8] > 1.8);
  assert.ok(s2[1] > 0.5);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});
await test('the v3 data files and Airports table are Tailwinds\' to the byte (generated, not stale)', () => {
  setDemandModel(3);
  const sample = AIRPORTS.filter((a, i) => i % 15 === 0).map((a) => a.code);
  const fresh = computeAirportMarkets(sample, BUCKETS_V3);
  for (const c of sample) assert.deepEqual(fresh[c], TABLE_V3[c], `${c} — run node tools/generate-airport-markets.mjs`);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});

setDemandModel(DEMAND_MODEL_CLASSIC);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
