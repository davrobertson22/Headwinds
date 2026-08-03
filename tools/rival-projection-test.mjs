// Rival-view projection test — no database, no network.
//
// Context (2026-08-02): Supabase egress hit 593 GB against a 250 GB Pro
// allowance. The cause was buildWorldRivalViews loading EVERY active airline's
// FULL save blob on every rebuild, and a rebuild being triggered by ANY player's
// action — cost quadratic in world population. The fix trims the two history
// series IN POSTGRES, because nothing in the rival path reads more than their
// tails while they are ~90% of the stored blob.
//
// That fix is only safe if trimming is INVISIBLE to the derived views. This file
// is what makes that a checked property rather than a claim:
//
//   • buildRivalViews(full rows) deep-equals buildRivalViews(projected rows)
//   • the assertion above has TEETH — over-trimming is caught, so a future
//     "let's keep 4 entries, it's cheaper" is a red test, not a silent bug
//   • projectRivalState passes every other key through untouched (deny-list),
//     and survives missing / null / short / wrong-typed series
//   • the SQL in humanRivals.mjs and its JS twin trim the SAME keys to the SAME
//     depth — the one way these can drift is editing one and not the other
//
//   node tools/rival-projection-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  buildRivalViews,
  projectRivalState,
  RIVAL_HISTORY_KEEP,
  RIVAL_TRIMMED_KEYS,
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

// ── Fixture: two airlines with DEEP history ──────────────────────────────────
// The whole point is history longer than RIVAL_HISTORY_KEEP, so a trim that went
// too far would actually lose data. Same aircraft-selection care as
// headwinds-rivals-test: ask the engine what can legally fly the pair rather
// than depending on AIRCRAFT_TYPES order.
const shortHaul = AIRCRAFT_TYPES.find((t) =>
  !t.freighter && t.range > 800 && t.seats >= 50
  && !checkRouteRestrictions('JFK', 'BOS', 300, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(shortHaul, 'no aircraft type in engine data can legally fly JFK–BOS');

const WEEKS = 60; // > 2 × RIVAL_HISTORY_KEEP, and past the 52-week financialHistory cap

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
  return { id, worldId: 'w1', name, hub, status: 'ACTIVE', restarts: 0, state: s,
           account: { isOG: false, email: 'x@example.com' } };
}

const alice = makeAirline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dest: 'BOS', fare: 170 });
const bob   = makeAirline({ id: 'a2', name: 'Bob Airways', hub: 'BOS', dest: 'JFK', fare: 150 });
const rows  = [alice, bob];

console.log('\n── fixture ───────────────────────────────────────────────');

await test('fixture actually has history deeper than the trim depth', () => {
  for (const r of rows) {
    assert.ok((r.state.financialHistory ?? []).length > RIVAL_HISTORY_KEEP,
      `${r.name}: financialHistory is ${(r.state.financialHistory ?? []).length}, ` +
      `needs > ${RIVAL_HISTORY_KEEP} or this whole file proves nothing`);
    assert.ok((r.state.statsHistory ?? []).length > RIVAL_HISTORY_KEEP,
      `${r.name}: statsHistory is ${(r.state.statsHistory ?? []).length}, needs > ${RIVAL_HISTORY_KEEP}`);
  }
});

console.log('\n── projection is invisible to the derived views ───────────');

// Deep-equal that also fails on undefined-vs-missing, which is the exact shape a
// dropped key would take. JSON.stringify would hide it (both serialise away).
const trimTo = (n) => rows.map((r) => ({
  ...r,
  state: {
    ...r.state,
    financialHistory: (r.state.financialHistory ?? []).slice(-n),
    statsHistory: (r.state.statsHistory ?? []).slice(-n),
  },
}));

await test('buildRivalViews is byte-identical on full vs projected rows', () => {
  const full = buildRivalViews(rows);
  const proj = buildRivalViews(rows.map((r) => ({ ...r, state: projectRivalState(r.state) })));
  assert.deepStrictEqual([...proj.entries()], [...full.entries()]);
});

await test('...and that assertion has teeth: over-trimming IS caught', () => {
  const full = buildRivalViews(rows);
  const tooFar = buildRivalViews(trimTo(1));
  assert.notDeepStrictEqual([...tooFar.entries()], [...full.entries()],
    'trimming to a single history entry changed nothing — the comparison above is vacuous, ' +
    'so it would not catch a real over-trim either');
});

await test('the deepest tail any consumer reads is still 12 (financialHistory)', () => {
  // toHumanCompetitor takes slice(-12); calcReputation slice(-4); loyaltyPaxBase
  // slice(-8). If a future change reads deeper than RIVAL_HISTORY_KEEP this
  // starts failing, which is the point.
  const full = buildRivalViews(rows);
  const atKeep = buildRivalViews(trimTo(RIVAL_HISTORY_KEEP));
  assert.deepStrictEqual([...atKeep.entries()], [...full.entries()]);
  const oneShort = buildRivalViews(trimTo(11));
  assert.notDeepStrictEqual([...oneShort.entries()], [...full.entries()],
    'trimming below 12 must change profitHistory — if it does not, the fixture has no profit history');
});

console.log('\n── projectRivalState: deny-list semantics ────────────────');

await test('every key except the two series survives untouched', () => {
  const p = projectRivalState(alice.state);
  for (const k of Object.keys(alice.state)) {
    assert.ok(k in p, `projection dropped key ${k}`);
    if (!RIVAL_TRIMMED_KEYS.includes(k)) {
      assert.deepStrictEqual(p[k], alice.state[k], `projection altered key ${k}`);
    }
  }
  assert.deepStrictEqual(Object.keys(p).sort(), Object.keys(alice.state).sort());
});

await test('the two series are trimmed to the tail, not the head', () => {
  const p = projectRivalState(alice.state);
  for (const k of RIVAL_TRIMMED_KEYS) {
    assert.equal(p[k].length, RIVAL_HISTORY_KEEP);
    assert.deepStrictEqual(p[k], alice.state[k].slice(-RIVAL_HISTORY_KEEP));
  }
});

await test('missing / null / short / wrong-typed series match the SQL guard', () => {
  // These mirror the CASE WHEN jsonb_typeof(...) = 'array' branch: anything that
  // is not an array becomes [], which is what `?? []` in the engine expects.
  assert.deepStrictEqual(projectRivalState({ a: 1 }).financialHistory, []);
  assert.deepStrictEqual(projectRivalState({ statsHistory: null }).statsHistory, []);
  assert.deepStrictEqual(projectRivalState({ statsHistory: 'nope' }).statsHistory, []);
  assert.deepStrictEqual(projectRivalState({ financialHistory: [1, 2, 3] }).financialHistory, [1, 2, 3]);
  // Non-objects pass straight through rather than becoming {}.
  assert.equal(projectRivalState(null), null);
  assert.equal(projectRivalState(undefined), undefined);
});

console.log('\n── SQL and its JS twin cannot drift ──────────────────────');

await test('the SQL trims exactly RIVAL_TRIMMED_KEYS to exactly RIVAL_HISTORY_KEEP', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../apps/headwinds-server/src/lib/humanRivals.mjs', import.meta.url)),
    'utf8');
  // The subtraction list and the JS twin's key list must be the same set.
  const subtracted = [...src.matchAll(/- '([A-Za-z]+History)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(subtracted.sort(), [...RIVAL_TRIMMED_KEYS].sort(),
    'the SQL subtracts a different set of keys than RIVAL_TRIMMED_KEYS');
  // The jsonpath tail is built from the constant; if someone inlines a literal
  // depth instead, this catches it.
  assert.ok(src.includes('`[last-${RIVAL_HISTORY_KEEP - 1} to last]`'),
    'the jsonpath tail is no longer derived from RIVAL_HISTORY_KEEP');
  for (const k of RIVAL_TRIMMED_KEYS) {
    assert.ok(src.includes(`'$.${k}' + tail`), `the SQL no longer builds a bounded path for ${k}`);
  }
});

Math.random = realRandom;
console.log(`\n${failed ? '✗' : '✓'} rival-projection: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
