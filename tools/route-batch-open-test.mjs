// Opening routes for a delivery, without the loop (Discord, 2026-10-14,
// "Tired of finding routes for the same aircraft many times"):
//   Brabus-G-Wagon  "like right now its so repetitive / basically repeating the
//                    same thing over and over again"
//   Kadicuss        "I have had times when I had like 50 aircraft arrived at the
//                    same time, and it was a pain to get them all on routes."
//
// The player still chooses every route. What goes is the per-tail loop:
//   1. the Route Finder remembers its search across the trip to the planner,
//      and the planner offers the way back (utils/finderMemory.js,
//      FinderReturnBar);
//   2. finder rows can be shortlisted and opened together, one idle tail each,
//      with every pick checked and forecast against the state the picks above
//      it leave behind (models/routeBatch.js, BatchOpenReview);
//   3. the finder forecasts at the block-hour cap the engine enforces, so an
//      NWR world's long sector is priced at a frequency it can open at;
//   4. Fleet offers "Find routes for your idle …" straight into the finder.
//
// Sections 1, 3 and 4 import only modules that exist on HEAD and fail there on
// their assertions. Section 2's API is new; on HEAD the only way to open two
// finder rows was the planner once per row, each checked against today's state
// — and a probe of that path approved JFK–BOS and JFK–ORD for the same single
// idle 737 on one launch's worth of cash (both addRouteBlockReason → null).
//
//   node --import ./tools/_register-loader.mjs tools/route-batch-open-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const optional = async (path) => { try { return await import(path); } catch { return null; } };

const { GameProvider, RemoteGameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const RouteFinder       = (await import('../src/components/RouteFinder.jsx')).default;
const RouteFinderScreen = (await import('../src/components/RouteFinderScreen.jsx')).default;
const { getAircraftType } = await import('../src/data/aircraft.js');
const { findCandidates, scoreCandidates } = await import('../src/models/routeFinder.js');
const { maxFrequency, maxWeeklyBlockHoursFor, routeDistanceKm, currentGameDate } = await import('../src/utils/simulation.js');
const { requestNav, clearNavIntent } = await import('../src/utils/navIntent.js');

const memory = await optional('../src/utils/finderMemory.js');
const batch  = await optional('../packages/engine/src/models/routeBatch.js');
const need = (m, what) => { if (!m) throw new Error(`${what} is missing`); return m; };

const NB = getAircraftType('b737800');
const A320 = getAircraftType('a320ceo');
const WB = getAircraftType('b777200er');
const tail = (id, type = NB, over = {}) => ({
  id, tailNumber: id.toUpperCase(), name: id, typeId: type.id, status: 'idle', ageWeeks: 52,
  ownershipType: 'owned', config: { economy: type.seats }, ...over,
});
const base = (over = {}) => ({
  ...freshState(), airlineName: 'Batch Air', phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 4e8,
  gates: { JFK: 2, BOS: 1, ORD: 1, ATL: 1, MIA: 1, EWR: 1, LHR: 1 },
  fleet: [tail('a1'), tail('a2')], routes: [], cargoRoutes: [], ...over,
});
const strip = (h) => h.replaceAll('<!-- -->', '');
function renderSolo(state, el) {
  store.set('bbae_save_v2', JSON.stringify(state));
  return strip(renderToString(React.createElement(GameProvider, null, el)));
}
const renderRemote = (state, el) => strip(renderToString(
  React.createElement(RemoteGameProvider, { state, dispatch: () => {} }, el)));

// ── 1. The finder keeps its search, and the planner has a way back ─────────
console.log('\n── 1. The finder remembers; the planner leads back ────────');

await test('a Fleet deep link opens the finder on that aircraft, not the most-owned one', () => {
  const state = base({ fleet: [tail('a1'), tail('a2'), tail('c1', A320)] });
  memory?.clearFinderMemory();
  clearNavIntent();
  requestNav('finder', { filter: { typeId: A320.id } });
  const html = renderRemote(state, React.createElement(RouteFinderScreen));
  assert.match(html, new RegExp(`<option value="${A320.id}" selected="">`),
    'the finder ignored the aircraft it was sent for and defaulted to the 737');
});

await test('…and still has it after leaving and coming back with no link', () => {
  const state = base({ fleet: [tail('a1'), tail('a2'), tail('c1', A320)] });
  clearNavIntent();
  const html = renderRemote(state, React.createElement(RouteFinderScreen));
  assert.match(html, new RegExp(`<option value="${A320.id}" selected="">`),
    'the search reset on remount — every tail starts with re-picking the aircraft');
});

await test('origin, sort and filters are remembered per airline', () => {
  const m = need(memory, 'utils/finderMemory.js');
  m.clearFinderMemory();
  const state = base();
  m.rememberFinder(m.finderMemoryKey(state, 'passenger'), { origin: 'BOS', sortBy: 'fare', soloOnly: true });
  const html = renderRemote(state, React.createElement(RouteFinder, { standalone: true }));
  assert.ok(html.includes('markets from BOS') || html.includes('market from BOS'), 'origin was not restored');
  assert.match(html, /<option value="fare" selected="">/, 'sort was not restored');
  // Another airline (or a re-founded one) starts clean.
  const other = renderRemote({ ...state, airlineName: 'Other Air' }, React.createElement(RouteFinder, { standalone: true }));
  assert.ok(other.includes('from JFK'), 'memory leaked across airlines');
});

await test('a remembered value that no longer exists falls back instead of stranding the screen', () => {
  const m = need(memory, 'utils/finderMemory.js');
  m.clearFinderMemory();
  const state = base();
  m.rememberFinder(m.finderMemoryKey(state, 'passenger'), { origin: 'ZZZ', typeId: 'no_such_type', sortBy: 'bogus' });
  const html = renderRemote(state, React.createElement(RouteFinder, { standalone: true }));
  assert.ok(html.includes('from JFK'), 'bad origin was kept');
  assert.match(html, new RegExp(`<option value="${NB.id}" selected="">`));
});

await test('both planners mount the way back, and Plan → marks the trip as from the finder', () => {
  assert.match(src('src/components/RouteFinderScreen.jsx'), /from: 'finder'/, 'Plan → does not say where it came from');
  for (const f of ['src/components/RoutePlanner.jsx', 'src/components/CargoRoutePlanner.jsx']) {
    const s = src(f);
    assert.match(s, /<FinderReturnBar /, `${f} has no way back to the finder`);
    assert.match(s, /nav\.from === 'finder'/, `${f} never learns it was opened from the finder`);
  }
});

await test('after a route opens the bar says how many of that type are still idle', async () => {
  const Bar = (await optional('../src/components/FinderReturnBar.jsx'))?.default;
  assert.ok(Bar, 'FinderReturnBar.jsx is missing');
  const state = base({ fleet: [tail('a1', NB, { status: 'assigned' }), tail('a2'), tail('a3'),
    tail('r1', NB, { reserveBase: 'JFK' })] });
  const html = renderRemote(state, React.createElement(Bar, { opened: { origin: 'JFK', dest: 'BOS', typeId: NB.id } }));
  assert.ok(html.includes('Opened JFK → BOS'));
  assert.ok(html.includes('<strong style="color:var(--text)">2</strong> idle Boeing 737-800s still waiting'),
    'the reserve was counted as idle, or the count is wrong');
  assert.ok(html.includes('Find the next route'));
  const none = renderRemote(state, React.createElement(Bar, { fromFinder: false, opened: null }));
  assert.equal(none, '', 'a planner reached any other way shows no bar until something opens');
});

// ── 2. The shortlist ────────────────────────────────────────────────────────
console.log('\n── 2. Shortlist and batch open ──────────────────────────');

await test('the finder offers a pick column only for an owned type with idle tails', () => {
  memory?.clearFinderMemory();
  let html = renderRemote(base(), React.createElement(RouteFinder, { standalone: true }));
  assert.ok(html.includes('data-pick="'), 'no shortlist checkboxes for two idle 737s');
  assert.ok(html.includes('2 idle Boeing 737-800s</span> — tick rows'), 'the idle count is not on the screen');
  assert.ok(!html.includes('data-shortlist-tray'), 'the tray shows before anything is picked');
  memory?.clearFinderMemory();
  html = renderRemote(base({ fleet: [tail('a1', NB, { status: 'assigned' })] }), React.createElement(RouteFinder, { standalone: true }));
  assert.ok(!html.includes('data-pick="'), 'checkboxes offered with no idle aircraft to fill them');
});

await test('picks survive a remount and drive the tray', () => {
  const m = need(memory, 'utils/finderMemory.js');
  m.clearFinderMemory();
  const state = base();
  m.rememberFinder(m.finderMemoryKey(state, 'passenger'), { picks: [
    { origin: 'JFK', destination: 'BOS', typeId: NB.id },
    { origin: 'JFK', destination: 'ORD', typeId: NB.id },
  ] });
  const html = renderRemote(state, React.createElement(RouteFinder, { standalone: true }));
  assert.ok(html.includes('data-shortlist-tray'));
  assert.ok(html.includes('<strong>2</strong> routes shortlisted'));
  assert.ok(html.includes('0 idle Boeing 737-800s not yet picked'));
  assert.ok(html.includes('Review &amp; open'));
  // With every idle tail spoken for, the unpicked boxes are disabled.
  assert.match(html, /data-pick="BOS"[^>]*checked=""/, 'a picked row is not ticked');
  assert.match(html, /data-pick="MCO" disabled=""/, 'an unpicked row stays tickable with no idle tail left for it');
});

await test('each pick gets its own idle tail; the rest say why not', () => {
  const b = need(batch, 'models/routeBatch.js');
  const plan = b.planRouteBatch(base(), [
    { origin: 'JFK', destination: 'BOS', typeId: NB.id },
    { origin: 'JFK', destination: 'ORD', typeId: NB.id },
    { origin: 'JFK', destination: 'ATL', typeId: NB.id },
  ]);
  const [p1, p2, p3] = plan.items;
  assert.equal(p1.reason, null); assert.equal(p2.reason, null);
  assert.notEqual(p1.aircraft.id, p2.aircraft.id, 'two picks were given the same plane');
  assert.match(p3.reason, /No idle Boeing 737-800 left — the picks above take all 2/);
  assert.equal(plan.openable.length, 2);
});

await test('cash and gate slots are spent by the picks above', () => {
  const b = need(batch, 'models/routeBatch.js');
  const one = b.planRouteBatch(base(), [{ origin: 'JFK', destination: 'BOS', typeId: NB.id }]).items[0];
  const poor = base({ cash: one.launchCost + 1000 });
  const cashPlan = b.planRouteBatch(poor, [
    { origin: 'JFK', destination: 'BOS', typeId: NB.id },
    { origin: 'JFK', destination: 'ORD', typeId: NB.id },
  ]);
  assert.equal(cashPlan.items[0].reason, null);
  assert.match(cashPlan.items[1].reason ?? '', /Not enough cash/, 'the second launch was approved on cash already spent');

  // JFK: one gate (50 slots), 40 already flown. 40 + 7 fits, 47 + 7 does not.
  const busy = { id: 'rb', origin: 'JFK', destination: 'BOS', aircraftId: 'b1', weeklyFrequency: 40, ticketPrice: 200, stops: ['JFK', 'BOS'] };
  const slotted = base({ gates: { JFK: 1, BOS: 1, ORD: 1, ATL: 1 },
    fleet: [tail('b1', NB, { status: 'assigned' }), tail('a1'), tail('a2')], routes: [busy] });
  const slotPlan = b.planRouteBatch(slotted, [
    { origin: 'JFK', destination: 'ORD', typeId: NB.id },
    { origin: 'JFK', destination: 'ATL', typeId: NB.id },
  ]);
  assert.equal(slotPlan.items[0].reason, null);
  assert.match(slotPlan.items[1].reason ?? '', /Not enough gate slots at JFK — 47\/50/);
});

await test('a pick into a market the pick above already serves is forecast against it', () => {
  const b = need(batch, 'models/routeBatch.js');
  // Belfast is one market across BFS and BHD. Opened alone, BOS–BHD is a fresh
  // lane; after BOS–BFS it is a second offer in a lane you already fly, and the
  // engine pools the two (projectRouteAddition's lanePooled). A batch that
  // forecast each pick against today's state would quote the fresh-lane number.
  const state = base({ hub: 'BOS', gates: { BOS: 2, BFS: 1, BHD: 1 } });
  const alone = b.planRouteBatch(state, [{ origin: 'BOS', destination: 'BHD', typeId: NB.id }]).items[0];
  const after = b.planRouteBatch(state, [
    { origin: 'BOS', destination: 'BFS', typeId: NB.id },
    { origin: 'BOS', destination: 'BHD', typeId: NB.id },
  ]).items[1];
  assert.equal(alone.reason, null); assert.equal(after.reason, null);
  assert.equal(alone.projection.lanePooled, false);
  assert.equal(after.projection.lanePooled, true, 'BOS–BHD was forecast as if BOS–BFS above it did not exist');
  assert.notEqual(after.projection.passengers, alone.projection.passengers);
});

await test('a single pick quotes exactly what its finder row quoted', () => {
  const b = need(batch, 'models/routeBatch.js');
  const state = base({ fleet: [tail('a1')] });
  const gameDate = currentGameDate(state);
  const rows = findCandidates(state, { origin: 'JFK', aircraftTypeId: NB.id, aircraft: state.fleet[0], groupMetros: false });
  const scored = scoreCandidates(state, rows, { aircraftTypeId: NB.id, aircraft: state.fleet[0], gameDate,
    limit: 500, capHours: maxWeeklyBlockHoursFor(state) });
  const row = scored.find(r => r.code === 'ORD');
  assert.ok(row?.projection, 'fixture: JFK–ORD row was not scored');
  const item = b.planRouteBatch(state, [{ origin: 'JFK', destination: 'ORD', typeId: NB.id }], { gameDate }).items[0];
  assert.equal(item.projection.netProfit, row.projection.netProfit);
  assert.equal(item.projection.loadFactor, row.projection.loadFactor);
  assert.equal(item.weeklyFrequency, row.projection.weeklyFrequency);
});

await test('the batch keeps a long-range tail back and never deploys a reserve', () => {
  const b = need(batch, 'models/routeBatch.js');
  const state = base({ fleet: [tail('long', NB, { rangeMod: 1.3 }), tail('stock'), tail('res', NB, { reserveBase: 'JFK' })] });
  const plan = b.planRouteBatch(state, [
    { origin: 'JFK', destination: 'BOS', typeId: NB.id },
    { origin: 'JFK', destination: 'ORD', typeId: NB.id },
    { origin: 'JFK', destination: 'ATL', typeId: NB.id },
  ]);
  assert.equal(plan.items[0].aircraft.id, 'stock', 'the modded jet was spent on a short hop');
  assert.equal(plan.items[1].aircraft.id, 'long');
  assert.match(plan.items[2].reason ?? '', /No idle/, 'the stationed reserve was deployed');
});

await test('opening the plan lands exactly the state it previewed', () => {
  const b = need(batch, 'models/routeBatch.js');
  const state = base({ fleet: [tail('a1'), tail('a2'), tail('a3')] });
  const plan = b.planRouteBatch(state, [
    { origin: 'JFK', destination: 'BOS', typeId: NB.id, weeklyFrequency: 3 },
    { origin: 'JFK', destination: 'MIA', typeId: NB.id },
    { origin: 'JFK', destination: 'ZZZ', typeId: NB.id },
  ]);
  const landed = plan.openable.reduce((s, a) => gameReducer(s, a), state);
  assert.equal(landed.routes.length, plan.finalState.routes.length);
  assert.equal(landed.cash, plan.totals.cashAfter);
  assert.equal(landed.routes.find(r => r.destination === 'BOS').weeklyFrequency, 3, 'the edited frequency was not what opened');
});

await test('a batch stops at MAX_BATCH and says so', () => {
  const b = need(batch, 'models/routeBatch.js');
  const picks = Array.from({ length: b.MAX_BATCH + 1 }, () => ({ origin: 'JFK', destination: 'BOS', typeId: NB.id }));
  const plan = b.planRouteBatch(base(), picks);
  assert.match(plan.items[b.MAX_BATCH].reason, new RegExp(`up to ${b.MAX_BATCH}`));
});

await test('the review table renders each pick with its tail, its reason and the totals', async () => {
  const Review = (await optional('../src/components/BatchOpenReview.jsx'))?.default;
  assert.ok(Review, 'BatchOpenReview.jsx is missing');
  const picks = [
    { origin: 'JFK', destination: 'BOS', typeId: NB.id },
    { origin: 'JFK', destination: 'ORD', typeId: NB.id },
    { origin: 'JFK', destination: 'ATL', typeId: NB.id },
  ];
  const html = renderRemote(base(), React.createElement(Review, { picks, setPicks: () => {}, onClose: () => {} }));
  assert.ok(html.includes('data-batch-row="JFK&gt;BOS"') && html.includes('data-batch-row="JFK&gt;ATL"'));
  assert.ok(html.includes('A1') && html.includes('A2'), 'assigned tails are not named');
  assert.ok(html.includes('No idle Boeing 737-800 left'));
  assert.ok(html.includes('Open 2 routes'));
  assert.ok(html.includes('1 can&#x27;t open and will stay on your list'));
});

// ── 3. NWR block-hour cap ───────────────────────────────────────────────────
console.log('\n── 3. Finder forecasts at the cap the engine enforces ─────');

await test('in an NWR world a long sector is forecast at a frequency it could open at', () => {
  const state = base({ newWorldRestrictions: true, fleet: [tail('w1', WB)] });
  const dist = routeDistanceKm('JFK', 'LHR');
  const cap = maxFrequency(dist, WB, maxWeeklyBlockHoursFor(state));
  assert.ok(cap < 7, `fixture: JFK–LHR on a 777 should be capped below 7/wk in NWR (got ${cap})`);
  // The finder component's own call — read off the source so the test fails if
  // the component stops passing the cap, not just the helper.
  assert.match(src('src/components/RouteFinder.jsx'), /capHours: maxWeeklyBlockHoursFor\(state\)/,
    'the finder forecasts at the 140h physical cap, not the world\'s scheduling cap');
});

// ── 4. Fleet entry point ────────────────────────────────────────────────────
console.log('\n── 4. Fleet leads into the finder ───────────────────────');

await test('Fleet offers "Find routes for your idle …" into the finder on that type', () => {
  const s = src('src/components/Fleet.jsx');
  assert.match(s, /requestNav\('finder', \{ filter: \{ typeId: type\.id \} \}\)/, 'the idle aircraft panel has no way into the finder');
  assert.match(s, /Find routes for \{sel\.idle\} idle/, 'the type filter has no "find routes" for its idle tails');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
