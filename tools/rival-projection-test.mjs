// Rival-view projection test — no database, no network.
//
// Context: buildWorldRivalViews derives every player's rival view from every
// ACTIVE airline's save blob. Production measurement (2026-08-04) showed the
// average blob is 523 kB — 56% of it `lastReport`, a per-route weekly debrief
// the rival path reads exactly TWO fields of — and that shipping those blobs
// was ~90% of the Supabase egress bill and 89% of all DB execution time. The
// fix trims the blob IN POSTGRES (loadRivalRows) down to ~80 kB.
//
// That is only safe if trimming is INVISIBLE to the derived views. This file
// makes that a checked property rather than a claim:
//
//   • buildRivalViews(full rows) deep-equals buildRivalViews(projected rows)
//   • each assertion has TEETH — over-trimming any of the trimmed keys is a
//     red test, not a silent bug
//   • projectRivalState touches ONLY the four named keys (deny-list); every
//     other key passes through untouched, and survives missing / null / short
//     / wrong-typed values exactly like the SQL's jsonb_typeof guards
//   • the SQL in humanRivals.mjs and its JS twin trim the SAME keys to the
//     SAME depth — editing one without the other fails here
//
//   node tools/rival-projection-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  buildRivalViews,
  projectRivalState,
  RIVAL_FIN_KEEP,
  RIVAL_STATS_KEEP,
  RIVAL_FLEET_FIELDS,
  RIVAL_FIN_FIELDS,
  RIVAL_STATS_FIELDS,
  RIVAL_DROPPED_KEYS,
} from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const realRandom = Math.random;
Math.random = () => 0.5;

// ── Fixture: two airlines with DEEP history and the production fat ───────────
// History longer than both KEEP depths, a real engine-built lastReport (the
// production heavyweight), and — because the engine sim never creates one — a
// hand-added customLogo, so the drop-safety assertions actually exercise it.
const shortHaul = AIRCRAFT_TYPES.find((t) =>
  !t.freighter && t.range > 800 && t.seats >= 50
  && !checkRouteRestrictions('JFK', 'BOS', 300, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(shortHaul, 'no aircraft type in engine data can legally fly JFK–BOS');

const WEEKS = 60; // > 2×RIVAL_STATS_KEEP and past the 52-week financialHistory cap

function makeAirline({ id, name, hub, dest, fare }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
  const aircraftId = s.fleet[0]?.id;
  assert.ok(aircraftId, `${name}: lease failed`);
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId, origin: hub, destination: dest, weeklyFrequency: 14 });
  assert.equal(s.routes.length, 1, `${name}: route not created (${s.error ?? 'no error'})`);
  s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: s.routes[0].id, ticketPrice: fare });
  for (let w = 0; w < WEEKS; w++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  // Production blobs carry a customLogo (avg 4.5 kB, max 55 kB) the sim never
  // creates. Plant one so the drop assertions below are exercised for real.
  s = { ...s, customLogo: `<svg>${'x'.repeat(4000)}</svg>` };
  // Fatten the array entries the deep projection strips, standing in for the
  // maintenance/mods/valuation bulk real fleet entries carry and the
  // routeRevenues maps real history entries carry — so "stripping them changes
  // nothing" is proven against entries that actually have something to strip.
  s = {
    ...s,
    fleet: s.fleet.map((a) => ({ ...a, maintenance: { log: 'x'.repeat(500) }, valuation: 12345 })),
    financialHistory: s.financialHistory.map((h) => ({ ...h, routeRevenues: { r1: 999 }, junk: 'y'.repeat(200) })),
    // sharePrice too: the sim airlines never IPO, so without planting numbers
    // the sharePrice teeth check would pass vacuously (null either way).
    statsHistory: s.statsHistory.map((e, i) => ({ ...e, sharePrice: 10 + i * 0.25, junk: 'z'.repeat(50) })),
  };
  // Plant a production-shaped lastReport. The sim's can be null by week 60, the
  // current engine writes `reputationScore` (not the legacy `reputation` object
  // qualityOf prefers), and BOTH shapes must survive the projection — so the
  // fixture carries both, plus per-route bulk standing in for the 291 kB the
  // projection exists to remove.
  s = {
    ...s,
    lastReport: {
      ...(s.lastReport ?? {}),
      reputation: { overall: 71 },
      reputationScore: 68,
      totalPassengers: s.lastReport?.totalPassengers ?? 12345,
      totalRevenue: 1_000_000,
      profit: 50_000,
      routeResults: Array.from({ length: 40 }, (_, i) => ({
        routeId: `r${i}`, revenue: 1000 + i, pax: 100 + i, loadFactor: 0.8,
      })),
    },
  };
  return { id, worldId: 'w1', name, hub, status: 'ACTIVE', restarts: 0, state: s,
           account: { isOG: false, email: 'x@example.com' } };
}

const alice = makeAirline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dest: 'BOS', fare: 170 });
const bob   = makeAirline({ id: 'a2', name: 'Bob Airways', hub: 'BOS', dest: 'JFK', fare: 150 });
const rows  = [alice, bob];

console.log('\n── fixture ───────────────────────────────────────────────');

await test('fixture exercises every trimmed key harder than the trim', () => {
  for (const r of rows) {
    assert.ok((r.state.financialHistory ?? []).length > RIVAL_FIN_KEEP,
      `${r.name}: financialHistory too short to prove the fin trim`);
    assert.ok((r.state.statsHistory ?? []).length > RIVAL_STATS_KEEP,
      `${r.name}: statsHistory too short to prove the stats trim`);
    assert.ok(r.state.lastReport && typeof r.state.lastReport === 'object',
      `${r.name}: no lastReport — the production heavyweight is untested`);
    assert.ok(Object.keys(r.state.lastReport).length > 3,
      `${r.name}: lastReport has ≤3 keys, so reducing it to 3 proves nothing`);
    assert.ok(r.state.lastReport.reputation?.overall != null,
      `${r.name}: lastReport.reputation.overall missing — qualityOf would fall back and mask a bad trim`);
    assert.ok(typeof r.state.customLogo === 'string' && r.state.customLogo.length > 1000,
      `${r.name}: no customLogo planted — the drop is untested`);
    assert.ok(r.state.fleet.length > 0
      && Object.keys(r.state.fleet[0]).length > RIVAL_FLEET_FIELDS.length,
      `${r.name}: fleet entries carry nothing beyond the projected fields — the entry trim is untested`);
    assert.ok(Object.keys(r.state.financialHistory.at(-1)).length > RIVAL_FIN_FIELDS.length,
      `${r.name}: financialHistory entries carry nothing beyond the projected fields`);
    assert.ok(Object.keys(r.state.statsHistory.at(-1)).length > RIVAL_STATS_FIELDS.length,
      `${r.name}: statsHistory entries carry nothing beyond the projected fields`);
  }
});

console.log('\n── projection is invisible to the derived views ───────────');

await test('buildRivalViews is byte-identical on full vs projected rows', () => {
  const full = buildRivalViews(rows);
  const proj = buildRivalViews(rows.map((r) => ({ ...r, state: projectRivalState(r.state) })));
  assert.deepStrictEqual([...proj.entries()], [...full.entries()]);
});

// Helpers for the teeth checks: reapply one trim MORE aggressively than the
// real projection and require the views to CHANGE — otherwise the equality
// above could be passing vacuously.
const withState = (mutate) => rows.map((r) => ({ ...r, state: mutate({ ...r.state }) }));
const mustDiffer = (label, mutate) => {
  const full = buildRivalViews(rows);
  const cut = buildRivalViews(withState(mutate));
  assert.notDeepStrictEqual([...cut.entries()], [...full.entries()],
    `${label} changed nothing — the equality check cannot catch a real over-trim of it`);
};

await test('teeth: financialHistory below 12 changes the views', () => {
  mustDiffer('trimming financialHistory to 3', (s) => ({ ...s, financialHistory: (s.financialHistory ?? []).slice(-3) }));
});

await test('teeth: statsHistory below 26 changes the views', () => {
  mustDiffer('trimming statsHistory to 5', (s) => ({ ...s, statsHistory: (s.statsHistory ?? []).slice(-5) }));
});

await test('teeth: dropping lastReport.reputation changes the views', () => {
  // qualityOf prefers lastReport.reputation.overall (with a state.reputation
  // fallback); the fixture plants 71, well away from DEFAULT_QUALITY. If this
  // ever stops differing, qualityOf stopped reading the planted shape and the
  // lastReport projection needs re-checking against its new reads.
  mustDiffer('removing lastReport.reputation', (s) => ({
    ...s,
    lastReport: { ...s.lastReport, reputation: undefined },
    reputation: undefined,
  }));
});

await test('teeth: stripping config from fleet entries changes the views', () => {
  mustDiffer('fleet entries without config', (s) => ({
    ...s, fleet: s.fleet.map(({ config, ...rest }) => rest),
  }));
});

await test('teeth: stripping ageWeeks from fleet entries changes the views', () => {
  // ageWeeks feeds calcReputation's fleet-freshness score, which reaches the
  // views through stateBrandReach → spec.brandReach.
  mustDiffer('fleet entries without ageWeeks', (s) => ({
    ...s, fleet: s.fleet.map(({ ageWeeks, ...rest }) => rest),
  }));
});

await test('teeth: stripping profit from financialHistory entries changes the views', () => {
  mustDiffer('history entries without profit', (s) => ({
    ...s, financialHistory: s.financialHistory.map(({ profit, ...rest }) => rest),
  }));
});

await test('teeth: stripping sharePrice from statsHistory entries changes the views', () => {
  mustDiffer('stats entries without sharePrice', (s) => ({
    ...s, statsHistory: s.statsHistory.map(({ sharePrice, ...rest }) => rest),
  }));
});

await test("exact-depth check: the real trims sit at the consumers’ deepest reads", () => {
  const full = buildRivalViews(rows);
  const atKeep = buildRivalViews(withState((s) => projectRivalState(s)));
  assert.deepStrictEqual([...atKeep.entries()], [...full.entries()]);
  // One entry shy of RIVAL_FIN_KEEP must differ: slice(-12) is the deepest read.
  mustDiffer('financialHistory at 11', (s) => ({ ...s, financialHistory: (s.financialHistory ?? []).slice(-(RIVAL_FIN_KEEP - 1)) }));
  mustDiffer('statsHistory at 25', (s) => ({ ...s, statsHistory: (s.statsHistory ?? []).slice(-(RIVAL_STATS_KEEP - 1)) }));
});

console.log('\n── projectRivalState: deny-list semantics ────────────────');

await test('only the four named keys are touched; everything else survives', () => {
  const p = projectRivalState(alice.state);
  const touched = new Set(['financialHistory', 'statsHistory', 'fleet', 'lastReport', ...RIVAL_DROPPED_KEYS]);
  for (const k of Object.keys(alice.state)) {
    if (RIVAL_DROPPED_KEYS.includes(k)) { assert.ok(!(k in p), `${k} should be dropped`); continue; }
    assert.ok(k in p, `projection dropped key ${k}`);
    if (!touched.has(k)) assert.deepStrictEqual(p[k], alice.state[k], `projection altered key ${k}`);
  }
});

await test('lastReport is reduced to exactly its three read fields', () => {
  const p = projectRivalState(alice.state);
  assert.deepStrictEqual(Object.keys(p.lastReport).sort(),
    ['reputation', 'reputationScore', 'totalPassengers']);
  assert.deepStrictEqual(p.lastReport.reputation, alice.state.lastReport.reputation);
  assert.equal(p.lastReport.reputationScore, alice.state.lastReport.reputationScore);
  // Missing subkeys become explicit null — matching jsonb_build_object.
  assert.deepStrictEqual(projectRivalState({ lastReport: {} }).lastReport,
    { reputation: null, reputationScore: null, totalPassengers: null });
});

await test('histories are trimmed to the tail, entries to their field sets', () => {
  const p = projectRivalState(alice.state);
  assert.equal(p.financialHistory.length, RIVAL_FIN_KEEP);
  assert.equal(p.statsHistory.length, RIVAL_STATS_KEEP);
  // Tail, not head: last projected entry mirrors the last full entry.
  assert.equal(p.financialHistory.at(-1).profit, alice.state.financialHistory.at(-1).profit);
  assert.equal(p.statsHistory.at(-1).sharePrice, alice.state.statsHistory.at(-1).sharePrice ?? null);
  for (const e of p.financialHistory) assert.deepStrictEqual(Object.keys(e).sort(), [...RIVAL_FIN_FIELDS].sort());
  for (const e of p.statsHistory) assert.deepStrictEqual(Object.keys(e).sort(), [...RIVAL_STATS_FIELDS].sort());
  for (const e of p.fleet) assert.deepStrictEqual(Object.keys(e).sort(), [...RIVAL_FLEET_FIELDS].sort());
  assert.equal(p.fleet.length, alice.state.fleet.length, 'fleet must not be shortened, only slimmed');
});

await test('missing / null / short / wrong-typed values match the SQL guards', () => {
  assert.deepStrictEqual(projectRivalState({ a: 1 }).financialHistory, []);
  assert.deepStrictEqual(projectRivalState({ statsHistory: null }).statsHistory, []);
  assert.deepStrictEqual(projectRivalState({ statsHistory: 'nope' }).statsHistory, []);
  // Non-object array entries become the field set with nulls — exactly what
  // jsonb_build_object over e->'field' (SQL NULL on scalars) produces.
  assert.deepStrictEqual(projectRivalState({ financialHistory: [7] }).financialHistory,
    [{ profit: null, revenue: null, passengers: null }]);
  assert.deepStrictEqual(projectRivalState({ fleet: ['x'] }).fleet,
    [{ id: null, typeId: null, config: null, ageWeeks: null, status: null }]);
  // lastReport: only a plain object is reduced; arrays and scalars become null,
  // mirroring jsonb_typeof(...) = 'object' (arrays are 'array' in jsonb).
  assert.equal(projectRivalState({ lastReport: [1] }).lastReport, null);
  assert.equal(projectRivalState({ lastReport: 'x' }).lastReport, null);
  assert.equal(projectRivalState({ a: 1 }).lastReport, null);
  assert.equal(projectRivalState(null), null);
  assert.equal(projectRivalState(undefined), undefined);
});

console.log('\n── SQL and its JS twin cannot drift ──────────────────────');

await test('the SQL subtracts, rebuilds and bounds exactly what the twin does', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../apps/headwinds-server/src/lib/humanRivals.mjs', import.meta.url)),
    'utf8');
  assert.ok(src.includes("- 'financialHistory' - 'statsHistory' - 'fleet' - 'lastReport' - 'customLogo'"),
    'the SQL no longer subtracts the same five keys the twin touches');
  for (const f of RIVAL_FLEET_FIELDS) {
    assert.ok(src.includes(`'${f}', e->'${f}'`), `the SQL fleet projection dropped field ${f}`);
  }
  for (const f of RIVAL_FIN_FIELDS) {
    assert.ok(src.includes(`'${f}', e->'${f}'`), `the SQL financialHistory projection dropped field ${f}`);
  }
  for (const f of RIVAL_STATS_FIELDS) {
    assert.ok(src.includes(`'${f}', e->'${f}'`), `the SQL statsHistory projection dropped field ${f}`);
  }
  assert.ok((src.match(/WITH ORDINALITY/g) ?? []).length >= 3 && (src.match(/ORDER BY ord/g) ?? []).length >= 3,
    'an array projection lost its ORDER BY ord — jsonb_agg over SRF output does not guarantee element order');
  assert.ok(src.includes('`[last-${RIVAL_FIN_KEEP - 1} to last]`'),
    'the financialHistory tail is no longer derived from RIVAL_FIN_KEEP');
  assert.ok(src.includes('`[last-${RIVAL_STATS_KEEP - 1} to last]`'),
    'the statsHistory tail is no longer derived from RIVAL_STATS_KEEP');
  assert.ok(src.includes("'$.financialHistory' + finTail") && src.includes("'$.statsHistory' + statsTail"),
    'a bounded jsonpath is no longer built for one of the history series');
  assert.ok(src.includes(`a.state#>'{lastReport,reputation}'`)
         && src.includes(`a.state#>'{lastReport,reputationScore}'`)
         && src.includes(`a.state#>'{lastReport,totalPassengers}'`),
    'the SQL no longer preserves the three lastReport fields the rival path reads');
  assert.deepStrictEqual(RIVAL_DROPPED_KEYS, ['customLogo'],
    'RIVAL_DROPPED_KEYS changed — update the SQL subtraction AND this test together');
});

Math.random = realRandom;
console.log(`\n${failed ? '✗' : '✓'} rival-projection: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
