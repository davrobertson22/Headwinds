// A decision's answer is adopted only where it is news.
//
// A click is applied optimistically in the browser and authoritatively on the
// server, and the server's state used to REPLACE local state every time. A new
// state object is a new weekly projection, so every click ran the engine's week
// twice on the main thread — the second time to arrive at the numbers already
// on screen (measured 2026-11-10: two ~1 s freezes per click at 1,900 tails).
//
// apps/headwinds-web/src/decisionAdoption.js compares first:
//   'same'    → keep the state on screen (no new object, no projection)
//   'overlay' → only the rival view moved: apply it like a rival poll (worker)
//   'state'   → the airline itself differs: adopt the server's state, as before
//
// The comparison has to be exactly as strict as "would adopting this change
// anything": too loose and a server correction is ignored, too strict and the
// second projection is back. Both directions are held here, with the real
// reducer on both sides and the server's half sent through JSON as it is live.
//
//   node --import ./tools/_register-loader.mjs tools/decision-adoption-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const lsMem = new Map();
globalThis.localStorage = globalThis.localStorage
  ?? { getItem: (k) => (lsMem.has(k) ? lsMem.get(k) : null), setItem: (k, v) => lsMem.set(k, String(v)), removeItem: (k) => lsMem.delete(k) };
process.env.DATABASE_URL ??= 'postgresql://x:y@localhost:5432/z';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const mod = await import('../apps/headwinds-web/src/decisionAdoption.js').catch(() => null);
const { sameJson, compareDecisionResult, overlayOf, RIVAL_OVERLAY_KEYS } = mod ?? {};
const need = () => { if (!mod) throw new Error('apps/headwinds-web/src/decisionAdoption.js does not exist'); };

const { freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { defaultConfig, defaultClassPrices, referencePrice } = await import('../src/utils/simulation.js');
const { pairKeyOf } = await import('../packages/engine/src/models/pairShare.js');
const { withRivals, stripRivals, rivalOverlay } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');

const viaJson = (x) => JSON.parse(JSON.stringify(x));

section('equal as JSON carries it');

test('values, nesting and order of keys', () => {
  need();
  assert.equal(sameJson({ a: 1, b: [1, { c: 'x' }], d: null }, { d: null, b: [1, { c: 'x' }], a: 1 }), true);
  assert.equal(sameJson({ a: 1 }, { a: 2 }), false);
  assert.equal(sameJson([1, 2], [1, 2, 3]), false);
  assert.equal(sameJson({ a: [] }, { a: {} }), false);
  assert.equal(sameJson('1', 1), false);
  assert.equal(sameJson(null, {}), false);
  assert.equal(sameJson(0, false), false);
});
test('a key holding undefined is a missing key; -0 is 0', () => {
  need();
  assert.equal(sameJson({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(sameJson({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(sameJson({ a: 1 }, { a: 1, b: null }), false);
  assert.equal(sameJson({ a: -0 }, { a: 0 }), true);
});
test('what JSON cannot carry is never "the same" as its JSON form', () => {
  need();
  assert.equal(sameJson({ a: NaN }, viaJson({ a: NaN })), false);
  assert.equal(sameJson({ a: new Date(0) }, viaJson({ a: new Date(0) })), false);
  assert.equal(sameJson({ a: new Map() }, { a: {} }), false);
});
test('every state survives its own JSON round trip as "same"', () => {
  need();
  const s = { ...freshState(), phase: 'playing' };
  assert.equal(sameJson(s, viaJson(s)), true);
});

section('the overlay keys match what the server strips');

test('stripRivals removes exactly RIVAL_OVERLAY_KEYS', () => {
  need();
  const probe = Object.fromEntries([...RIVAL_OVERLAY_KEYS, 'cash', 'routes'].map((k) => [k, 1]));
  assert.deepEqual(Object.keys(stripRivals(probe)).sort(), ['cash', 'routes']);
  // …and nothing the server strips is missing from the list.
  const src = read('apps/headwinds-server/src/lib/humanRivals.mjs');
  const body = src.slice(src.indexOf('export function stripRivals'), src.indexOf('...rest', src.indexOf('export function stripRivals')));
  const stripped = body.slice(body.indexOf('const {') + 7).split(',').map((x) => x.trim()).filter((x) => /^\w+$/.test(x));
  assert.deepEqual([...stripped].sort(), [...RIVAL_OVERLAY_KEYS].sort());
});
test('everything a rival view injects is an overlay key', () => {
  need();
  const view = { competitors: [], humanRivals: {}, gateMarket: { slotPool: {} }, laborMarket: {}, lineBook: {}, marketDev: {},
    stockPool: {}, alliance: { membership: {}, def: {} }, selfStanding: {}, selfOG: true, selfSupporter: true, selfDev: true };
  for (const k of Object.keys(rivalOverlay(view))) assert.ok(RIVAL_OVERLAY_KEYS.includes(k), `${k} is injected by rivalOverlay but is not an overlay key`);
});

section('the real reducer on both sides');

// A small multiplayer airline as the browser holds it after a GET.
function airline() {
  const t = getAircraftType('a320neo');
  const dests = ['BKK', 'KUL', 'CGK', 'HKG'];
  const fleet = dests.map((d, i) => ({ id: `p${i}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `9V-T${i}`, name: t.name }));
  const routePricing = {};
  const routes = dests.map((d, i) => {
    const fare = Math.round(referencePrice('SIN', d));
    routePricing[pairKeyOf('SIN', d)] = defaultClassPrices(fare);
    return { id: `r${i}`, origin: 'SIN', destination: d, stops: ['SIN', d], aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub: 'SIN', ticketPrice: fare };
  });
  return { ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'SIN', airlineName: 'Probe Air', cash: 5e9,
    fleet, routes, routePricing, gates: { SIN: 20, BKK: 2, KUL: 2, CGK: 2, HKG: 2 }, hubs: { SIN: { tier: 3, tierSince: 0 } } };
}
const rivalFare = (fare) => ({ id: 'human:1', human: true, name: 'Rival', homeHub: 'SIN', tier: 'legacy', baseQualityScore: 60,
  routes: { [pairKeyOf('SIN', 'BKK')]: { frequency: 14, economyFare: fare, seatsPerWeek: 2520, seats: 180 } } });
const viewOf = (fare) => ({ competitors: [rivalFare(fare)], humanRivals: { [pairKeyOf('SIN', 'BKK')]: [{ competitorId: 'human:1', name: 'Rival', frequency: 14, economyFare: fare }] }, selfStanding: { rank: 3 } });
// What the server holds, what a GET hands the browser, and what a decision answers.
const stored = stripRivals(airline());
const asBrowserGot = (view) => viaJson({ ...withRivals(stored, null), ...rivalOverlay(view) });
const serverAnswer = (state, action, view) => viaJson(gameReducer(withRivals(stripRivals(state), view), action));
const FARE = { type: 'UPDATE_TICKET_PRICE', routeId: 'r1', ticketPrice: 321 };

test('the action used here really changes the airline', () => {
  const before = asBrowserGot(viewOf(200));
  const after = gameReducer(before, FARE);
  assert.notEqual(after, before);
  assert.equal(JSON.stringify(stripRivals(after)) === JSON.stringify(stripRivals(before)), false, 'UPDATE_TICKET_PRICE changed nothing — pick another action');
});
test('a fare change the server agrees with, rivals unmoved → same', () => {
  need();
  const local = gameReducer(asBrowserGot(viewOf(200)), FARE);          // optimistic
  const server = serverAnswer(asBrowserGot(viewOf(200)), FARE, viewOf(200));
  assert.equal(compareDecisionResult(local, server), 'same');
});
test('same click, but a rival moved since the last poll → overlay', () => {
  need();
  const local = gameReducer(asBrowserGot(viewOf(200)), FARE);
  const server = serverAnswer(asBrowserGot(viewOf(200)), FARE, viewOf(180));
  assert.equal(compareDecisionResult(local, server), 'overlay');
  const ov = overlayOf(server);
  assert.equal(ov.competitors[0].routes[pairKeyOf('SIN', 'BKK')].economyFare, 180);
  assert.ok(!('routes' in ov) && !('cash' in ov), 'overlayOf leaked the airline\'s own state');
  // Applying just the overlay brings the screen level with the server.
  assert.equal(compareDecisionResult({ ...local, ...ov }, server), 'same');
});
test('the server applied something the browser did not → state', () => {
  need();
  const before = asBrowserGot(viewOf(200));
  const server = serverAnswer(before, FARE, viewOf(200));
  assert.equal(compareDecisionResult(before, server), 'state', 'an un-applied click must not read as "same"');
});
test('the server refused what the browser applied → state', () => {
  need();
  const before = asBrowserGot(viewOf(200));
  const local = gameReducer(before, FARE);
  assert.equal(compareDecisionResult(local, viaJson(before)), 'state');
});
test('a one-dollar disagreement anywhere in the airline → state', () => {
  need();
  const local = gameReducer(asBrowserGot(viewOf(200)), FARE);
  const server = serverAnswer(asBrowserGot(viewOf(200)), FARE, viewOf(200));
  assert.equal(compareDecisionResult(local, { ...server, cash: server.cash - 1 }), 'state');
  const routes = server.routes.map((r, i) => (i === 3 ? { ...r, weeklyFrequency: r.weeklyFrequency + 1 } : r));
  assert.equal(compareDecisionResult(local, { ...server, routes }), 'state');
});
test('a key only one side has → state (never silently dropped or kept)', () => {
  need();
  const local = gameReducer(asBrowserGot(viewOf(200)), FARE);
  const server = serverAnswer(asBrowserGot(viewOf(200)), FARE, viewOf(200));
  assert.equal(compareDecisionResult(local, { ...server, somethingNew: 1 }), 'state');
  assert.equal(compareDecisionResult({ ...local, phantomEdit: true }, server), 'state');
  assert.equal(compareDecisionResult({ ...local, harmless: undefined }, server), 'same');
});
test('a generated id that differs between the two sides → state', () => {
  need();
  // Whatever the action, an id minted separately on each side cannot match.
  const local = gameReducer(asBrowserGot(viewOf(200)), FARE);
  const server = serverAnswer(asBrowserGot(viewOf(200)), FARE, viewOf(200));
  const withRoute = (s, id) => ({ ...s, routes: [...s.routes, { id, origin: 'SIN', destination: 'MNL' }] });
  assert.equal(compareDecisionResult(withRoute(local, 'abc-local'), withRoute(server, 'abc-server')), 'state');
});
test('an overlay key appearing or vanishing → overlay', () => {
  need();
  const local = gameReducer(asBrowserGot(viewOf(200)), FARE);
  const server = serverAnswer(asBrowserGot(viewOf(200)), FARE, viewOf(200));
  assert.equal(compareDecisionResult(local, { ...server, gateMarket: { listings: [] } }), 'overlay');
  assert.equal(compareDecisionResult({ ...local, gateMarket: { listings: [] } }, server), 'overlay');
});
test('nothing to compare → state', () => {
  need();
  assert.equal(compareDecisionResult(null, {}), 'state');
  assert.equal(compareDecisionResult({}, null), 'state');
});

section('GamePlayScreen');

const src = read('apps/headwinds-web/src/GamePlayScreen.jsx');
test('the decision response is settled through the comparison, not adopted outright', () => {
  const dispatch = src.slice(src.indexOf('const dispatch = useCallback((action) => {'));
  const ok = dispatch.slice(dispatch.indexOf('if (outcome.ok) {'), dispatch.indexOf('const e = outcome.error;'));
  assert.match(ok, /settleDecision\(res, seq\);/);
  assert.doesNotMatch(ok, /return withStatsBackfill\(res\.state\)/, 'the response is still adopted without being compared');
  assert.doesNotMatch(ok, /await settleDecision/, 'the write chain must not wait on a projection');
});
test('settleDecision keeps "same", sends "overlay" through the worker, and adopts "state" at once', () => {
  const a = src.indexOf('const settleDecision = useCallback(async (res, seq) => {');
  assert.ok(a > 0, 'settleDecision is missing');
  const fn = src.slice(a, src.indexOf('const dispatch = useCallback((action) => {'));
  assert.match(fn, /if \(seq !== decisionSeq\.current \|\| !res\?\.state\) return;/, 'a stale response must be dropped first');
  assert.match(fn, /const server = withStatsBackfill\(res\.state\);/, 'compare what would have been adopted');
  assert.match(fn, /if \(verdict === 'same'\) return;/);
  const overlay = fn.slice(fn.indexOf("if (verdict === 'overlay') {"), fn.indexOf('// The server\'s airline differs'));
  assert.match(overlay, /await projectOffThread\(next, \{ base: local, overlay: rivals \}\);/);
  assert.match(overlay, /if \(oseq < adoptedSeq\.current\) return;/, 'a newer poll\'s overlay must win');
  const rest = fn.slice(fn.indexOf('// The server\'s airline differs'));
  assert.doesNotMatch(rest, /await /, 'a server correction must not wait');
  assert.match(rest, /if \(seq !== decisionSeq\.current\) return cur;/);
  // The week must never roll backwards on any of the three paths.
  assert.ok((fn.match(/olderWeek\(/g) ?? []).length >= 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
