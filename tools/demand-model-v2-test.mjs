// Demand model v2 — the DEFAULT for new worlds, never retro-applied.
//
// Passenger demand recalibrated against real US and Australian O&D (engine
// utils/market.js "Demand model v2"; fitted in the Tailwinds repo,
// tools/demand-audit/). Same code and parameters as Tailwinds, so the two
// engines must price v2 identically. What has to hold here:
//   1. createWorld with no field → tickConfig.demandModel 2; with 1 → classic
//   2. the create-world form sends the field explicitly
//   3. the flag is baked into every airline at join, and re-stamped by the tick
//   4. a world created before v2 (no key) prices exactly as it always has
//   5. every engine entry point (reducer, weeklyTick, rival-view pricing, the
//      finder worker) prices off the state's model, not the last one live
//
//   node tools/run-tests.mjs demand-model-v2
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, seedAirlineState } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { serializeWorld, validateWorldConfig } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import {
  baseCityPairDemand, setDemandModel, getDemandModel, DEMAND_MODEL_CLASSIC,
} from '../packages/engine/src/utils/market.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { weeklyTick } from '../packages/engine/src/utils/simulation.js';
import { AIRPORTS } from '../packages/engine/src/data/airports.js';
import { computeAirportMarkets } from '../packages/engine/src/utils/airportMarket.js';
import { AIRPORT_MARKETS as TABLE_V2, GROWTH_BUCKETS as BUCKETS_V2 } from '../packages/engine/src/data/airportMarketsV2.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const quiet = (fn) => { const p = Math.random; Math.random = () => 0.9999999; try { return fn(); } finally { Math.random = p; } };
const d = (pair) => baseCityPairDemand(...pair.split('-'));

const fakePrisma = () => {
  const calls = [];
  return { calls, world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } };
};
const BASE = { name: 'T', lengthYears: 50, weeksPerDay: 24, maxPlayers: 20 };
const tcOf = async (opts) => { const p = fakePrisma(); await createWorld(p, opts); return p.calls[0].tickConfig; };
const world = (tickConfig) => ({ id: 'w', worldSeed: 's', currentYear: 1, currentWeek: 1, lengthYears: 40, maxPlayers: 20,
  tickConfig: { startingCapital: 15_000_000, demandMultiplier: 1, ...tickConfig } });

// Classic figures captured from the engine BEFORE v2 existed, and the v2
// figures the Tailwinds engine gives (the two must agree to the passenger).
const CLASSIC = { 'JFK-LAX': 27244, 'JFK-ORF': 14313, 'SYD-MEL': 28418, 'LHR-CDG': 36766, 'MIA-MCO': 25409, 'ORD-CID': 3176, 'DEL-BOM': 69006 };
const V2_TAILWINDS = { 'JFK-LAX': 27861, 'JFK-ORF': 4248, 'SYD-MEL': 46596, 'LHR-CDG': 36766, 'MIA-MCO': 3324, 'SFO-LAX': 40853, 'DEN-ASE': 290 };

console.log('\nDemand model v2 — new worlds only\n');

await test('a new world defaults to demand model 2', async () => {
  assert.equal((await tcOf({ ...BASE })).demandModel, 2);
});
await test('demandModel 1 creates a classic world (no key stored)', async () => {
  assert.equal((await tcOf({ ...BASE, demandModel: 1 })).demandModel, undefined);
});
await test('any other demandModel is refused', async () => {
  for (const bad of [0, 3, '2', true]) {
    assert.throws(() => validateWorldConfig({ ...BASE, demandModel: bad }), /demandModel/, String(bad));
  }
});
await test('the world JSON says which model a world runs (keyless = classic)', () => {
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: { demandModel: 2 } }, { playerCount: 0 }).demandModel, 2);
  assert.equal(serializeWorld({ id: 'w', name: 'T', tickConfig: {} }, { playerCount: 0 }).demandModel, 1);
});
await test('the create-world form sends demandModel explicitly, defaulting to v2', () => {
  const src = read('../apps/headwinds-web/src/App.jsx');
  assert.ok(/demandModel: demandV2 \? 2 : 1,/.test(src), 'form does not send an explicit demandModel');
  assert.ok(/const \[demandV2, setDemandV2\] = useState\(true\)/.test(src), 'the checkbox no longer defaults to on');
});
await test('joining a v2 world bakes demandModel 2 into the airline; a classic world bakes nothing', () => {
  assert.equal(seedAirlineState(world({ demandModel: 2 }), { airlineName: 'A', hub: 'JFK' }).demandModel, 2);
  assert.equal(seedAirlineState(world({}), { airlineName: 'A', hub: 'JFK' }).demandModel, undefined);
});
await test('the tick re-stamps the flag from the world (it can never fall out of a blob)', () => {
  const src = read('../apps/headwinds-server/src/lib/tickService.mjs');
  assert.ok(/\.\.\.\(world\.tickConfig\?\.demandModel === 2 \? \{ demandModel: 2 \} : \{\}\)/.test(src));
});
await test('rival views are priced on the world\'s model', () => {
  const src = read('../apps/headwinds-server/src/lib/humanRivals.mjs');
  assert.ok(/setDemandModel\(_st\?\.demandModel\)/.test(src));
});

await test('a classic world prices every reference pair exactly as before v2', () => {
  setDemandModel(DEMAND_MODEL_CLASSIC);
  for (const [p, v] of Object.entries(CLASSIC)) assert.equal(d(p), v, p);
});
await test('v2 prices match the Tailwinds engine to the passenger', () => {
  setDemandModel(2);
  for (const [p, v] of Object.entries(V2_TAILWINDS)) assert.equal(d(p), v, p);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});
await test('the reducer entry sets the model from the airline\'s state, both ways', () => {
  const v2 = seedAirlineState(world({ demandModel: 2 }), { airlineName: 'A', hub: 'JFK' });
  const classic = seedAirlineState(world({}), { airlineName: 'B', hub: 'JFK' });
  setDemandModel(DEMAND_MODEL_CLASSIC);
  quiet(() => gameReducer(v2, { type: 'NOOP_FOR_TEST' }));
  assert.equal(getDemandModel(), 2);
  assert.equal(d('JFK-ORF'), V2_TAILWINDS['JFK-ORF']);
  quiet(() => gameReducer(classic, { type: 'NOOP_FOR_TEST' }));
  assert.equal(getDemandModel(), DEMAND_MODEL_CLASSIC);
  assert.equal(d('JFK-ORF'), CLASSIC['JFK-ORF'], 'the pair memo must not carry the v2 figure across worlds');
});
await test('weeklyTick pins the model from ITS state (server ticks many worlds in one process)', () => {
  const classic = { ...freshState(), phase: 'playing', hub: 'JFK', airlineName: 'C' };
  setDemandModel(2);
  quiet(() => weeklyTick(classic));
  assert.equal(getDemandModel(), DEMAND_MODEL_CLASSIC);
});
await test('the Route Finder worker prices off the held state\'s model', async () => {
  const { createForecastWorkerCore } = await import('../src/utils/finderForecastWorkerCore.js');
  const core = createForecastWorkerCore();
  setDemandModel(DEMAND_MODEL_CLASSIC);
  core({ type: 'state', id: 1, state: { ...freshState(), demandModel: 2 } });
  core({ type: 'price', jobId: 1, stateId: 1, ctx: {}, rows: [] });
  assert.equal(getDemandModel(), 2);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});
await test('v2 worlds fly the fitted seasons; classic worlds keep the archetype curve', async () => {
  const { getSeasonalProfile } = await import('../packages/engine/src/models/demand.js');
  const q1 = (p) => (p[1] + p[2] + p[3]) / p.slice(1).reduce((s, x) => s + x, 0);
  setDemandModel(DEMAND_MODEL_CLASSIC);
  assert.ok(q1(getSeasonalProfile('MIA', 'JFK')) < 0.24, 'classic MIA–JFK is the summer-peak curve');
  setDemandModel(2);
  assert.ok(q1(getSeasonalProfile('MIA', 'JFK')) > 0.27, 'v2 MIA–JFK peaks in winter');
  setDemandModel(DEMAND_MODEL_CLASSIC);
});
await test('the v2 data files are the Tailwinds ones (the engines must agree)', () => {
  for (const f of ['demandV2Factors.js', 'demandV2Roads.js', 'demandV2Seasons.js']) {
    const here = read(`../packages/engine/src/data/${f}`);
    let tw = null;
    try { tw = read(`../../Airline Management Game/src/data/${f}`); } catch { continue; }   // Tailwinds not checked out alongside: skip
    assert.equal(here, tw, `${f} differs from Tailwinds — copy it across`);
  }
});
await test('fares: classic untouched; v2 domestic on the real curve (same as Tailwinds), international unchanged', async () => {
  const { referencePrice } = await import('../packages/engine/src/utils/market.js');
  setDemandModel(DEMAND_MODEL_CLASSIC);
  assert.deepEqual([referencePrice('BOS', 'LGA'), referencePrice('JFK', 'LAX'), referencePrice('JFK', 'LHR')], [93, 381, 503]);
  setDemandModel(2);
  assert.deepEqual([referencePrice('BOS', 'LGA'), referencePrice('JFK', 'LAX'), referencePrice('JFK', 'LHR')], [117, 301, 503]);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});
await test('flight costs: v2 bills a take-off chunk per sector and adds taxi time; classic is the flown km', async () => {
  const { sectorCostKm } = await import('../packages/engine/src/utils/market.js');
  const { blockTimeHours, maxFrequency } = await import('../packages/engine/src/utils/simulation.js');
  const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
  const nb = getAircraftType('a320neo');
  setDemandModel(DEMAND_MODEL_CLASSIC);
  assert.deepEqual([300, 1200, 4000].map((k) => Math.round(sectorCostKm(nb, k))), [300, 1200, 4000]);
  assert.equal(maxFrequency(300, nb), 58);
  setDemandModel(2);
  assert.deepEqual([300, 1200, 4000].map((k) => Math.round(sectorCostKm(nb, k))), [548, 1200, 3230]);
  assert.equal(maxFrequency(300, nb), 44);
  assert.ok(Math.abs(blockTimeHours(300, nb) - 1.59) < 0.01);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});
await test('the v2 Airports table is the v2 model (generated, not stale)', () => {
  setDemandModel(2);
  const sample = AIRPORTS.filter((a, i) => i % 15 === 0).map((a) => a.code);
  const fresh = computeAirportMarkets(sample, BUCKETS_V2);
  for (const c of sample) assert.deepEqual(fresh[c], TABLE_V2[c], `${c} — run node tools/generate-airport-markets.mjs`);
  setDemandModel(DEMAND_MODEL_CLASSIC);
});

setDemandModel(DEMAND_MODEL_CLASSIC);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
